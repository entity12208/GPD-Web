// Port of firebase_sync.py — Firebase Auth + Firestore REST backend.
// Talks to the same public Firebase project as the Python desktop client, using
// the same document layout, so web and desktop players share accounts, rooms,
// leaderboard, friends and notifications.

import { CLAIM_COST, HEX_PALETTE, TROOP_COST, continentValue, randInt, shortlog } from './constants';

// Public Firebase web config (NOT a secret — same value the desktop client ships with).
const FIREBASE_API_KEY = 'AIzaSyA0QGbUDzgp3a3XkP1WGTXsW-JM0r2S36s';
const FIREBASE_PROJECT_ID = 'geopoliticaldomination';
const DB_PATH = `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/${DB_PATH}`;
const SIGN_UP_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`;
const SIGN_IN_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
const REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;
const EMAIL_DOMAIN = 'gpd.local';
const TOKEN_KEY = 'gpd.auth';

// ------------------------------------------------------------------
// Firestore typed-value converters
// ------------------------------------------------------------------

type FsValue = Record<string, unknown>;

export function toFs(v: unknown): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return v.length ? { arrayValue: { values: v.map(toFs) } } : { arrayValue: {} };
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length) return { mapValue: {} };
    return { mapValue: { fields: Object.fromEntries(entries.map(([k, x]) => [k, toFs(x)])) } };
  }
  return { stringValue: String(v) };
}

export function fromFs(v: FsValue): unknown {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (((v.arrayValue as { values?: FsValue[] }).values) ?? []).map(fromFs);
  if ('mapValue' in v) {
    const f = (v.mapValue as { fields?: Record<string, FsValue> }).fields ?? {};
    return Object.fromEntries(Object.entries(f).map(([k, x]) => [k, fromFs(x)]));
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Doc = Record<string, any>;

function docToDict(doc: { fields?: Record<string, FsValue> } | null | undefined): Doc {
  return Object.fromEntries(Object.entries(doc?.fields ?? {}).map(([k, v]) => [k, fromFs(v)]));
}
function dictToFields(d: Doc): Record<string, FsValue> {
  return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, toFs(v)]));
}

export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Online play requires a secure browser context. Open GPD over HTTPS or on localhost, then try again.');
  }
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class AuthError extends Error {}

// ------------------------------------------------------------------
// Auth (username/password via fake emails, like _AuthManager)
// ------------------------------------------------------------------

export class AuthManager {
  idToken: string | null = null;
  refreshToken: string | null = null;
  expiresAt = 0;
  uid: string | null = null;
  username: string | null = null;

  get isLoggedIn(): boolean {
    return !!(this.idToken && this.uid);
  }

  private static email(username: string): string {
    return `${username.trim().toLowerCase()}@${EMAIL_DOMAIN}`;
  }

  async register(username: string, password: string): Promise<void> {
    username = username.trim();
    if (!username) throw new AuthError('Username cannot be empty.');
    if (username.length < 3) throw new AuthError('Username must be at least 3 characters.');
    if (username.length > 20) throw new AuthError('Username must be 20 characters or fewer.');
    if (!password || password.length < 4) throw new AuthError('Password must be at least 4 characters.');
    const data = await this.post(SIGN_UP_URL, { email: AuthManager.email(username), password, returnSecureToken: true }, (msg) => {
      if (msg.includes('EMAIL_EXISTS')) return 'That username is already taken.';
      if (msg.includes('WEAK_PASSWORD')) return 'Password is too weak (min 6 chars for Firebase).';
      return `Registration failed: ${msg}`;
    });
    this.apply(data, username);
  }

  async login(username: string, password: string): Promise<void> {
    username = username.trim();
    if (!username) throw new AuthError('Username cannot be empty.');
    if (!password) throw new AuthError('Password cannot be empty.');
    const data = await this.post(SIGN_IN_URL, { email: AuthManager.email(username), password, returnSecureToken: true }, (msg) => {
      if (msg.includes('EMAIL_NOT_FOUND')) return 'Account not found. Check your username.';
      if (msg.includes('INVALID_PASSWORD') || msg.includes('INVALID_LOGIN_CREDENTIALS')) return 'Incorrect password.';
      if (msg.includes('TOO_MANY_ATTEMPTS')) return 'Too many failed attempts. Try again later.';
      return `Login failed: ${msg}`;
    });
    this.apply(data, username);
  }

  private async post(url: string, body: Doc, mapErr: (m: string) => string): Promise<Doc> {
    let resp: Response;
    try {
      resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      throw new AuthError(`Network error: ${(e as Error).message}`);
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new AuthError(mapErr(String(data?.error?.message ?? resp.status)));
    return data;
  }

  logout(): void {
    this.idToken = this.refreshToken = this.uid = this.username = null;
    this.expiresAt = 0;
    localStorage.removeItem(TOKEN_KEY);
  }

  private apply(data: Doc, username: string | null): void {
    this.idToken = data.idToken ?? data.id_token;
    this.refreshToken = data.refreshToken ?? data.refresh_token;
    this.uid = data.localId ?? data.user_id ?? '';
    this.expiresAt = Date.now() + (Number(data.expiresIn ?? data.expires_in ?? 3600) - 60) * 1000;
    if (username) this.username = username;
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ refresh_token: this.refreshToken, uid: this.uid, username: this.username }));
  }

  /** Restore a previous session from the saved refresh token. */
  async restore(): Promise<boolean> {
    try {
      const saved = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
      if (!saved?.refresh_token) return false;
      this.refreshToken = saved.refresh_token;
      this.uid = saved.uid;
      this.username = saved.username;
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  private async refresh(): Promise<void> {
    const resp = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: this.refreshToken }),
    });
    if (!resp.ok) throw new AuthError('Session expired. Please log in again.');
    const data = await resp.json();
    if (!data.id_token || !data.refresh_token) throw new AuthError('Token refresh returned incomplete data');
    this.apply(data, null);
  }

  async getToken(): Promise<string> {
    if (!this.idToken || Date.now() >= this.expiresAt) {
      if (!this.refreshToken) throw new AuthError('Not logged in');
      await this.refresh();
    }
    return this.idToken!;
  }

  async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.getToken()}`, 'Content-Type': 'application/json' };
  }
}

// ------------------------------------------------------------------
// Firestore REST helpers
// ------------------------------------------------------------------

class PreconditionFailed extends Error {}

export interface JoinedGameInfo {
  player_name: string;
  player_password?: string;
}

export interface LobbyGame {
  id: string;
  host: string;
  players: number;
  max_players: number;
  mode: string;
  map: string;
  status: string;
}

export interface FriendEntry {
  uid: string;
  username: string;
  status: 'accepted' | 'pending_sent' | 'pending_received';
}

export interface NotificationEntry {
  id: string;
  type: string;
  from_username: string;
  game_id: string;
  message: string;
  timestamp: number;
  read: boolean;
}

export interface LeaderboardEntry {
  username: string;
  elo: number;
  wins: number;
  losses: number;
  games_played: number;
}

const enc = encodeURIComponent;

export class FirebaseController {
  auth: AuthManager;

  constructor(auth: AuthManager) {
    this.auth = auth;
    void this.registerUsername();
  }

  private async req(method: string, url: string, body?: unknown): Promise<Response> {
    return fetch(url, { method, headers: await this.auth.headers(), body: body === undefined ? undefined : JSON.stringify(body) });
  }

  async getAt(path: string): Promise<{ data: Doc; exists: boolean; updateTime?: string }> {
    const resp = await this.req('GET', `${FIRESTORE_BASE}/${path}`);
    if (resp.status === 404) return { data: {}, exists: false };
    if (!resp.ok) throw new Error(await errText(resp));
    const j = await resp.json();
    return { data: docToDict(j), exists: true, updateTime: j.updateTime };
  }

  async patchAt(path: string, data: Doc, mask?: string[], updateTime?: string): Promise<Doc> {
    const params = new URLSearchParams();
    for (const m of mask ?? []) params.append('updateMask.fieldPaths', m);
    if (updateTime) params.append('currentDocument.updateTime', updateTime);
    const qs = params.toString();
    const resp = await this.req('PATCH', `${FIRESTORE_BASE}/${path}${qs ? '?' + qs : ''}`, { fields: dictToFields(data) });
    if (resp.status === 400 || resp.status === 409) {
      const t = await resp.text();
      if (t.includes('FAILED_PRECONDITION') || t.includes('ABORTED')) throw new PreconditionFailed(t);
      throw new Error(t);
    }
    if (!resp.ok) throw new Error(await errText(resp));
    return docToDict(await resp.json());
  }

  async deleteAt(path: string): Promise<void> {
    const resp = await this.req('DELETE', `${FIRESTORE_BASE}/${path}`);
    if (!resp.ok && resp.status !== 404) throw new Error(await errText(resp));
  }

  async listAt(path: string): Promise<{ id: string; data: Doc }[]> {
    const out: { id: string; data: Doc }[] = [];
    let pageToken = '';
    for (let page = 0; page < 10; page++) {
      const qs = `pageSize=300${pageToken ? '&pageToken=' + enc(pageToken) : ''}`;
      const resp = await this.req('GET', `${FIRESTORE_BASE}/${path}?${qs}`);
      if (resp.status === 404) return out;
      if (!resp.ok) throw new Error(await errText(resp));
      const j = await resp.json();
      for (const d of j.documents ?? []) out.push({ id: String(d.name).split('/').pop()!, data: docToDict(d) });
      if (!j.nextPageToken) break;
      pageToken = j.nextPageToken;
    }
    return out;
  }

  /** Read-modify-write a game doc with optimistic concurrency (retries on conflicts). */
  private async mutateGame<T>(gameId: string, fn: (data: Doc) => { patch: Doc; result: T } | null): Promise<T | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, exists, updateTime } = await this.getAt(`games/${enc(gameId)}`);
      if (!exists) throw new Error('Game not found');
      const out = fn(data);
      if (!out) return null;
      try {
        await this.patchAt(`games/${enc(gameId)}`, out.patch, Object.keys(out.patch), updateTime);
        return out.result;
      } catch (e) {
        if (e instanceof PreconditionFailed) continue;
        throw e;
      }
    }
    throw new Error('The game was busy — please try again.');
  }

  // ------------------------------------------------------------------
  // Rooms
  // ------------------------------------------------------------------

  private chooseColor(taken: string[] = []): string {
    const free = HEX_PALETTE.filter((c) => !taken.includes(c));
    const pool = free.length ? free : HEX_PALETTE;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  async getGame(gameId: string): Promise<Doc | null> {
    const { data, exists } = await this.getAt(`games/${enc(gameId)}`);
    return exists ? data : null;
  }

  async createOrOpenGame(
    gameId: string,
    playerName: string,
    opts: { playerPassword?: string; mode?: string; mapScope?: string; isPrivate?: boolean; countries?: Doc; createOnly?: boolean } = {},
  ): Promise<Doc> {
    const passHash = await sha256Hex(opts.playerPassword ?? '');
    const existing = await this.getAt(`games/${enc(gameId)}`);
    if (!existing.exists) {
      if (opts.createOnly === false) throw new Error(`No game found with ID '${gameId}'.`);
      const mode = opts.mode ?? 'classic';
      const scope = opts.mapScope ?? 'world';
      const doc: Doc = {
        players: [{
          name: playerName, is_bot: false, color: this.chooseColor(), money: 500, vulnerable: false,
          was_attacked: false, password_hash: passHash, troop_buy_limit: 20, is_host: true,
        }],
        countries: opts.countries ?? {},
        turn_idx: 0,
        turn_number: 1,
        logs: [shortlog(`${playerName} created the game.`)],
        status: 'waiting',
        created_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        game_mode: mode,
        map_scope: scope,
        is_private: !!opts.isPrivate,
        host: playerName,
      };
      if (opts.isPrivate) doc.join_code = generateJoinCode();
      await this.patchAt(`games/${enc(gameId)}`, doc);
      if (!opts.isPrivate) await this.publishGame(gameId, playerName, mode, scope);
      return doc;
    }
    if (opts.createOnly) throw new Error(`A game with ID '${gameId}' already exists.`);
    const result = await this.mutateGame(gameId, (data) => {
      const players: Doc[] = [...(data.players ?? [])];
      const me = players.find((p) => p.name === playerName);
      if (me) {
        if ((me.password_hash ?? '') !== passHash) throw new Error('Incorrect player password');
        return null;
      }
      players.push({
        name: playerName, is_bot: false, color: this.chooseColor(players.map((p) => p.color)), money: 500,
        vulnerable: false, was_attacked: false, password_hash: passHash, troop_buy_limit: 20,
        is_spectator: false,
      });
      const logs = [...(data.logs ?? [])].slice(-50);
      logs.push(shortlog(`${playerName} joined the game.`));
      return { patch: { players, logs }, result: players.length };
    });
    const doc = (await this.getGame(gameId))!;
    if (result !== null && !doc.is_private) void this.updateLobbyPlayerCount(gameId, (doc.players ?? []).length);
    return doc;
  }

  async uploadInitialCountries(gameId: string, countries: Doc): Promise<void> {
    await this.patchAt(`games/${enc(gameId)}`, { countries }, ['countries']);
  }

  async startGame(gameId: string): Promise<void> {
    await this.mutateGame(gameId, (data) => {
      const logs = [...(data.logs ?? [])].slice(-50);
      logs.push(shortlog('The host started the game.'));
      return { patch: { status: 'playing', logs }, result: true };
    });
    try {
      await this.patchAt(`game_lobby/${enc(gameId)}`, { status: 'playing' }, ['status']);
    } catch { /* lobby entry is optional */ }
  }

  async leaveGame(gameId: string, playerName: string): Promise<void> {
    await this.mutateGame(gameId, (data) => {
      const players: Doc[] = [...(data.players ?? [])];
      const idx = players.findIndex((p) => p.name === playerName);
      if (idx < 0) return null;
      const status = data.status ?? 'waiting';
      const logs = [...(data.logs ?? [])].slice(-50);
      const countries: Doc = { ...(data.countries ?? {}) };
      if (status === 'waiting') {
        players.splice(idx, 1);
        logs.push(shortlog(`${playerName} has left the game.`));
        let turn = Number(data.turn_idx ?? 0);
        if (idx < turn) turn -= 1;
        turn = players.length ? Math.min(turn, players.length - 1) : 0;
        return { patch: { players, logs, turn_idx: turn }, result: true };
      }
      for (const [k, v] of Object.entries(countries)) {
        if ((v as Doc)?.owner === playerName) countries[k] = { ...(v as Doc), owner: null, troops: 0 };
      }
      players[idx] = { ...players[idx], eliminated: true, is_spectator: true };
      logs.push(shortlog(`${playerName} has left the game.`));
      const patch: Doc = { players, logs, countries };
      const turn = Number(data.turn_idx ?? 0);
      if (turn === idx) Object.assign(patch, advanceTurn(players, countries, turn, Number(data.turn_number ?? 1), logs));
      checkWinner(players, patch, data);
      return { patch, result: true };
    });
  }

  async claimStartingCountry(gameId: string, playerName: string, cid: number): Promise<boolean> {
    const key = String(cid);
    const res = await this.mutateGame(gameId, (data) => {
      const countries: Doc = { ...(data.countries ?? {}) };
      const logs = [...(data.logs ?? [])].slice(-50);
      const target = countries[key];
      if (!target) {
        logs.push(shortlog(`${playerName} attempted to claim an invalid territory.`));
        return { patch: { logs }, result: false };
      }
      if (target.owner) {
        logs.push(shortlog(`${playerName} attempted to claim an already-owned territory.`));
        return { patch: { logs }, result: false };
      }
      countries[key] = { ...target, owner: playerName, troops: 1 };
      logs.push(shortlog(`${playerName} claimed a territory (continent:${target.continent ?? ''}) with 1 troop.`));
      const players: Doc[] = (data.players ?? []).map((p: Doc) => (p.name === playerName ? { ...p, had_territory: true } : p));
      return { patch: { countries, logs, players }, result: true };
    });
    return !!res;
  }

  /**
   * Apply a turn action (firebase_sync.submit_action). Returns the next
   * player's name so the caller can send them a turn notification.
   */
  async submitAction(gameId: string, playerName: string, action: string, params: Doc, timeUsed = 0): Promise<{ ok: boolean; next: string | null }> {
    const res = await this.mutateGame(gameId, (data) => {
      const players: Doc[] = (data.players ?? []).map((p: Doc) => ({ ...p }));
      if (!players.length) throw new Error('No players in game');
      const turnIdx = Number(data.turn_idx ?? 0);
      if (turnIdx < 0 || turnIdx >= players.length) throw new Error('Invalid turn index');
      const cur = players[turnIdx];
      if (cur.name !== playerName) throw new Error("Not player's turn");
      const countries: Doc = Object.fromEntries(Object.entries(data.countries ?? {}).map(([k, v]) => [k, { ...(v as Doc) }]));
      const logs: string[] = [...(data.logs ?? [])].slice(-50);
      const turnNumber = Number(data.turn_number ?? 1);
      const log = (m: string) => logs.push(shortlog(m));
      if (timeUsed > 0) cur.time_used = Number(cur.time_used ?? 0) + timeUsed;

      const awardBonus = (pd: Doc, key: string) => {
        const cont = countries[key]?.continent ?? '';
        if (!cont) return;
        const keys = Object.keys(countries).filter((k) => (countries[k]?.continent ?? '') === cont);
        if (keys.length && keys.every((k) => countries[k]?.owner === pd.name)) {
          const bonus = continentValue(cont);
          pd.money = Number(pd.money ?? 0) + bonus;
          log(`${pd.name} captured all of ${cont} and got $${bonus}`);
        }
      };

      let ok = true;
      if (action === 'PEACE') {
        cur.vulnerable = true;
        cur.was_attacked = false;
        log(`${playerName} chose PEACE`);
      } else if (action === 'NOTHING') {
        log(`${playerName} did NOTHING`);
      } else if (action === 'GATHER') {
        const buy = Math.trunc(Number(params.buy ?? 0));
        if (Number(cur.last_gather_turn ?? 0) !== turnNumber) {
          cur.troop_buy_limit = params.limit ? Math.max(1, Math.min(20, Number(params.limit))) : randInt(1, 20);
          cur.last_gather_turn = turnNumber;
        }
        const limit = Number(cur.troop_buy_limit ?? 20);
        const cost = buy * TROOP_COST;
        if (buy > limit) {
          log(`${playerName} attempted to buy ${buy} troops but limit is ${limit}`);
          ok = false;
        } else if (Number(cur.money ?? 0) < cost) {
          log(`${playerName} can't afford ${buy} troops ($${cost})`);
          ok = false;
        } else {
          cur.money = Number(cur.money ?? 0) - cost;
          const owned = Object.keys(countries).filter((k) => countries[k]?.owner === playerName);
          for (let i = 0; i < buy && owned.length; i++) {
            const c = countries[owned[i % owned.length]];
            c.troops = Number(c.troops ?? 0) + 1;
          }
          log(`${playerName} bought ${buy} troops for $${cost}`);
        }
      } else if (action === 'EXPAND') {
        const src = String(params.src);
        const tgt = String(params.tgt);
        const send = Math.trunc(Number(params.send ?? 0));
        const cross = Math.trunc(Number(params.cross_cost ?? 0));
        const s = countries[src];
        const t = countries[tgt];
        const sTroops = Number(s?.troops ?? 0);
        if (!s || !t) {
          log(`${playerName} invalid expand.`);
          ok = false;
        } else if (s.owner !== playerName) {
          log(`${playerName} doesn't own source territory.`);
          ok = false;
        } else if (send <= 0 || send >= sTroops) {
          log(`${playerName} invalid troop count.`);
          ok = false;
        } else if (Number(cur.money ?? 0) < cross + CLAIM_COST) {
          log(`${playerName} can't afford expansion ($${cross + CLAIM_COST}).`);
          ok = false;
        } else {
          cur.money = Number(cur.money ?? 0) - cross - CLAIM_COST;
          s.troops = sTroops - send;
          const defName = t.owner;
          const def = players.find((p) => p.name === defName);
          if (!t.owner) {
            t.owner = playerName;
            t.troops = send;
            log(`${playerName} claimed a territory (continent:${t.continent ?? ''}) with ${send} troops.`);
            awardBonus(cur, tgt);
          } else if (def && def.vulnerable) {
            t.owner = playerName;
            t.troops = send;
            log(`${playerName} swept vulnerable territory with ${send} troops.`);
            def.was_attacked = true;
            awardBonus(cur, tgt);
          } else {
            const atk = randInt(1, 20);
            const d1 = randInt(1, 20);
            const d2 = randInt(1, 20);
            const best = Math.max(d1, d2);
            log(`${playerName} (atk ${atk}) attacked ${defName} (def [${d1},${d2}]->${best})`);
            if (def) def.was_attacked = true;
            if (atk > best) {
              t.owner = playerName;
              t.troops = send;
              log(`${playerName} won and captured the territory (${send} troops).`);
              awardBonus(cur, tgt);
            } else {
              log(`${playerName} lost the attack; ${send} troops destroyed.`);
              ok = false;
            }
          }
        }
      }

      const patch: Doc = { players, countries, logs };
      // Elimination: players who held land and now hold none are out.
      for (const p of players) {
        if (p.eliminated || p.is_spectator) continue;
        const owned = Object.values(countries).some((c) => (c as Doc)?.owner === p.name);
        if (owned) p.had_territory = true;
        else if (p.had_territory) {
          p.eliminated = true;
          log(`${p.name} has been eliminated!`);
        }
      }
      Object.assign(patch, advanceTurn(players, countries, turnIdx, turnNumber, logs));
      checkWinner(players, patch, data);
      const next = players[patch.turn_idx]?.name ?? null;
      return { patch, result: { ok, next } };
    });
    return res ?? { ok: false, next: null };
  }

  // ------------------------------------------------------------------
  // Lobby / browser
  // ------------------------------------------------------------------

  async listPublicGames(): Promise<LobbyGame[]> {
    const docs = await this.listAt('game_lobby');
    return docs
      .filter((d) => d.data.status === 'waiting')
      .map((d) => ({
        id: d.id,
        host: d.data.host_name ?? '',
        players: Number(d.data.player_count ?? 0),
        max_players: Number(d.data.max_players ?? 6),
        mode: d.data.mode ?? 'classic',
        map: d.data.map_scope ?? 'world',
        status: d.data.status ?? 'waiting',
      }));
  }

  async publishGame(gameId: string, host: string, mode: string, scope: string, maxPlayers = 6): Promise<void> {
    try {
      await this.patchAt(`game_lobby/${enc(gameId)}`, {
        game_id: gameId, host_name: host, player_count: 1, max_players: maxPlayers, mode, map_scope: scope,
        status: 'waiting', created_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      });
    } catch (e) {
      console.warn('publish_game error', e);
    }
  }

  async updateLobbyPlayerCount(gameId: string, count: number): Promise<void> {
    try {
      await this.patchAt(`game_lobby/${enc(gameId)}`, { player_count: count }, ['player_count']);
    } catch { /* ignore */ }
  }

  async removeFromLobby(gameId: string): Promise<void> {
    try {
      await this.deleteAt(`game_lobby/${enc(gameId)}`);
    } catch { /* ignore */ }
  }

  async findGameByJoinCode(code: string): Promise<string | null> {
    const body = {
      structuredQuery: {
        from: [{ collectionId: 'games' }],
        where: { fieldFilter: { field: { fieldPath: 'join_code' }, op: 'EQUAL', value: { stringValue: code } } },
        limit: 1,
      },
    };
    try {
      const resp = await this.req('POST', `${FIRESTORE_BASE}:runQuery`, body);
      if (resp.ok) {
        const rows = await resp.json();
        for (const r of rows) if (r.document) return String(r.document.name).split('/').pop()!;
        return null;
      }
    } catch { /* fall through to list scan */ }
    const docs = await this.listAt('games');
    return docs.find((d) => d.data.join_code === code)?.id ?? null;
  }

  // ------------------------------------------------------------------
  // Chat
  // ------------------------------------------------------------------

  async sendChat(gameId: string, username: string, message: string): Promise<void> {
    const resp = await this.req('POST', `${FIRESTORE_BASE}/games/${enc(gameId)}/chat`, {
      fields: dictToFields({ sender: username, message, timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z') }),
    });
    if (!resp.ok) throw new Error(await errText(resp));
  }

  async getChat(gameId: string, limit = 50): Promise<{ sender: string; message: string; timestamp: string }[]> {
    const docs = await this.listAt(`games/${enc(gameId)}/chat`);
    return docs
      .map((d) => ({ sender: d.data.sender ?? '', message: d.data.message ?? '', timestamp: d.data.timestamp ?? '' }))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(-limit);
  }

  // ------------------------------------------------------------------
  // Joined games (player_sessions/{uid})
  // ------------------------------------------------------------------

  async saveJoinedGames(games: Record<string, JoinedGameInfo>): Promise<void> {
    if (!this.auth.uid) return;
    const safe: Doc = {};
    for (const [gid, info] of Object.entries(games)) {
      safe[gid] = { player_name: info.player_name, pp_hash: await sha256Hex(info.player_password ?? ''), rp_hash: await sha256Hex('') };
    }
    await this.patchAt(`player_sessions/${enc(this.auth.uid)}`, { joined_games: safe });
  }

  async loadJoinedGames(): Promise<Record<string, JoinedGameInfo>> {
    if (!this.auth.uid) return {};
    const { data } = await this.getAt(`player_sessions/${enc(this.auth.uid)}`);
    const out: Record<string, JoinedGameInfo> = {};
    for (const [gid, info] of Object.entries((data.joined_games ?? {}) as Doc)) {
      if (info && typeof info === 'object') out[gid] = { player_name: (info as Doc).player_name ?? '' };
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Stats + leaderboard
  // ------------------------------------------------------------------

  async updatePlayerStats(mode: string, won: boolean, territories: number, turns: number): Promise<void> {
    if (!this.auth.uid) return;
    const path = `player_stats/${enc(this.auth.uid)}`;
    const { data } = await this.getAt(path);
    const m = data[mode] ?? { games_played: 0, wins: 0, losses: 0, territories_conquered: 0, turns_played: 0 };
    m.games_played = Number(m.games_played ?? 0) + 1;
    if (won) m.wins = Number(m.wins ?? 0) + 1;
    else m.losses = Number(m.losses ?? 0) + 1;
    m.territories_conquered = Number(m.territories_conquered ?? 0) + territories;
    m.turns_played = Number(m.turns_played ?? 0) + turns;
    data[mode] = m;
    await this.patchAt(path, data);
  }

  async getPlayerStats(): Promise<Doc> {
    if (!this.auth.uid) return {};
    return (await this.getAt(`player_stats/${enc(this.auth.uid)}`)).data;
  }

  async getLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
    const docs = await this.listAt('leaderboard');
    return docs
      .map((d) => ({
        username: d.data.username ?? '?',
        elo: Number(d.data.elo ?? 1000),
        wins: Number(d.data.wins ?? 0),
        losses: Number(d.data.losses ?? 0),
        games_played: Number(d.data.games_played ?? 0),
      }))
      .sort((a, b) => b.elo - a.elo)
      .slice(0, limit);
  }

  async updateElo(won: boolean, opponentElo = 1000): Promise<number | null> {
    const { uid, username } = this.auth;
    if (!uid || !username) return null;
    const { data, exists } = await this.getAt(`leaderboard/${enc(uid)}`);
    const cur = exists ? data : { username, elo: 1000, wins: 0, losses: 0, games_played: 0 };
    const myElo = Number(cur.elo ?? 1000);
    const expected = 1 / (1 + 10 ** ((opponentElo - myElo) / 400));
    const newElo = Math.max(100, Math.trunc(myElo + 32 * ((won ? 1 : 0) - expected)));
    await this.patchAt(`leaderboard/${enc(uid)}`, {
      username, elo: newElo,
      wins: Number(cur.wins ?? 0) + (won ? 1 : 0),
      losses: Number(cur.losses ?? 0) + (won ? 0 : 1),
      games_played: Number(cur.games_played ?? 0) + 1,
    });
    return newElo;
  }

  // ------------------------------------------------------------------
  // Friends
  // ------------------------------------------------------------------

  private async registerUsername(): Promise<void> {
    const { uid, username } = this.auth;
    if (!uid || !username) return;
    try {
      await this.patchAt(`usernames/${enc(username.trim().toLowerCase())}`, { uid, username });
    } catch { /* ignore */ }
  }

  async findUidByUsername(username: string): Promise<string | null> {
    const target = username.trim().toLowerCase();
    try {
      const { data, exists } = await this.getAt(`usernames/${enc(target)}`);
      if (exists && data.uid) return data.uid;
    } catch { /* fall back */ }
    try {
      const docs = await this.listAt('leaderboard');
      return docs.find((d) => String(d.data.username ?? '').toLowerCase() === target)?.id ?? null;
    } catch {
      return null;
    }
  }

  private async friendsMap(uid: string): Promise<Doc> {
    return (await this.getAt(`friends/${enc(uid)}`)).data.friends ?? {};
  }

  async getFriends(): Promise<FriendEntry[]> {
    if (!this.auth.uid) return [];
    const m = await this.friendsMap(this.auth.uid);
    return Object.entries(m)
      .filter(([, v]) => v && typeof v === 'object')
      .map(([uid, v]) => ({ uid, username: (v as Doc).username ?? '?', status: (v as Doc).status ?? 'accepted' }));
  }

  async sendFriendRequest(target: string): Promise<[boolean, string]> {
    const { uid, username } = this.auth;
    if (!uid || !username) return [false, 'Not logged in'];
    const tuid = await this.findUidByUsername(target);
    if (!tuid) return [false, `Player '${target}' not found`];
    if (tuid === uid) return [false, 'Cannot add yourself'];
    try {
      const mine = await this.friendsMap(uid);
      const st = mine[tuid]?.status;
      if (st === 'accepted') return [false, `Already friends with ${target}`];
      if (st === 'pending_sent') return [false, 'Friend request already sent'];
      mine[tuid] = { username: target, status: 'pending_sent' };
      await this.patchAt(`friends/${enc(uid)}`, { friends: mine });
      const theirs = await this.friendsMap(tuid);
      theirs[uid] = { username, status: 'pending_received' };
      await this.patchAt(`friends/${enc(tuid)}`, { friends: theirs });
      return [true, `Friend request sent to ${target}`];
    } catch (e) {
      return [false, `Error: ${(e as Error).message}`];
    }
  }

  async acceptFriendRequest(fuid: string): Promise<[boolean, string]> {
    const uid = this.auth.uid;
    if (!uid) return [false, 'Not logged in'];
    try {
      const mine = await this.friendsMap(uid);
      if (!mine[fuid]) return [false, 'No pending request from this user'];
      mine[fuid].status = 'accepted';
      await this.patchAt(`friends/${enc(uid)}`, { friends: mine });
      const theirs = await this.friendsMap(fuid);
      if (theirs[uid]) {
        theirs[uid].status = 'accepted';
        await this.patchAt(`friends/${enc(fuid)}`, { friends: theirs });
      }
      return [true, `Now friends with ${mine[fuid].username ?? '?'}`];
    } catch (e) {
      return [false, `Error: ${(e as Error).message}`];
    }
  }

  async removeFriend(fuid: string): Promise<[boolean, string]> {
    const uid = this.auth.uid;
    if (!uid) return [false, 'Not logged in'];
    try {
      const mine = await this.friendsMap(uid);
      delete mine[fuid];
      await this.patchAt(`friends/${enc(uid)}`, { friends: mine });
      const theirs = await this.friendsMap(fuid);
      delete theirs[uid];
      await this.patchAt(`friends/${enc(fuid)}`, { friends: theirs });
      return [true, 'Removed'];
    } catch (e) {
      return [false, `Error: ${(e as Error).message}`];
    }
  }

  async inviteFriendToGame(fuid: string, gameId: string): Promise<boolean> {
    const { uid, username } = this.auth;
    if (!uid || !username) return false;
    try {
      const nid = `invite_${uid}_${Math.floor(Date.now() / 1000)}`;
      await this.patchAt(`notifications/${enc(fuid)}/items/${enc(nid)}`, {
        type: 'game_invite', from_uid: uid, from_username: username, game_id: gameId,
        timestamp: Math.floor(Date.now() / 1000), read: false,
      });
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Notifications
  // ------------------------------------------------------------------

  async getNotifications(limit = 20): Promise<NotificationEntry[]> {
    if (!this.auth.uid) return [];
    const docs = await this.listAt(`notifications/${enc(this.auth.uid)}/items`);
    return docs
      .map((d) => ({
        id: d.id,
        type: d.data.type ?? '',
        from_username: d.data.from_username ?? '',
        game_id: d.data.game_id ?? '',
        message: d.data.message ?? '',
        timestamp: Number(d.data.timestamp ?? 0) || 0,
        read: !!d.data.read,
      }))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async markNotificationRead(id: string): Promise<void> {
    if (!this.auth.uid) return;
    try {
      await this.patchAt(`notifications/${enc(this.auth.uid)}/items/${enc(id)}`, { read: true }, ['read']);
    } catch { /* ignore */ }
  }

  async sendTurnNotification(gameId: string, targetUsername: string): Promise<void> {
    try {
      const tuid = await this.findUidByUsername(targetUsername);
      if (!tuid || tuid === this.auth.uid) return;
      const nid = `turn_${gameId}_${Math.floor(Date.now() / 1000)}`;
      await this.patchAt(`notifications/${enc(tuid)}/items/${enc(nid)}`, {
        type: 'your_turn', from_username: this.auth.username ?? 'Game', game_id: gameId,
        message: `It's your turn in game ${gameId}!`, timestamp: Math.floor(Date.now() / 1000), read: false,
      });
    } catch { /* best effort */ }
  }
}

// ------------------------------------------------------------------
// Shared online turn helpers
// ------------------------------------------------------------------

/** Advance to the next active player and resolve their PEACE payout. */
function advanceTurn(players: Doc[], countries: Doc, turnIdx: number, turnNumber: number, logs: string[]): Doc {
  let next = turnIdx;
  for (let i = 0; i < players.length; i++) {
    next = (next + 1) % players.length;
    if (!players[next].eliminated && !players[next].is_spectator) break;
  }
  const nxt = players[next];
  if (nxt?.vulnerable) {
    if (!nxt.was_attacked) {
      const owned = Object.values(countries).filter((c) => (c as Doc)?.owner === nxt.name).length;
      const payout = 100 * owned;
      nxt.money = Number(nxt.money ?? 0) + payout;
      logs.push(shortlog(`${nxt.name} was peaceful and earned $${payout} ($100 x ${owned} territories).`));
    } else {
      logs.push(shortlog(`${nxt.name} was attacked while vulnerable -- no PEACE payout.`));
    }
    nxt.vulnerable = false;
    nxt.was_attacked = false;
  }
  return { turn_idx: next, turn_number: turnNumber + 1, turn_started_at: Date.now() };
}

function checkWinner(players: Doc[], patch: Doc, data: Doc): void {
  if (data.winner || (data.status ?? 'waiting') !== 'playing') return;
  // Players who never claimed a starting country don't block the win.
  const contenders = players.filter((p) => p.had_territory && !p.eliminated && !p.is_spectator);
  const someoneLost = players.some((p) => p.eliminated);
  if (contenders.length === 1 && someoneLost) {
    patch.winner = contenders[0].name;
    patch.status = 'finished';
    (patch.logs as string[]).push(shortlog(`${contenders[0].name} wins the game!`));
  }
}

function generateJoinCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function errText(resp: Response): Promise<string> {
  try {
    const j = await resp.json();
    return j?.error?.message ?? `HTTP ${resp.status}`;
  } catch {
    return `HTTP ${resp.status}`;
  }
}
