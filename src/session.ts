// Session abstraction: the play view drives local/spectate games (in-browser
// engine + bots) and online games (Firebase room) through one interface.

import { GAME_MODES, SCOPE_CONTINENTS, TPS, TROOP_COST, normColor, randInt, type GameMode, type MapScope } from './constants';
import { Game, Player, type Snapshot, type SnapCountry } from './game';
import { FirebaseController, type Doc } from './firebase';
import { adjOf, countries as mapCountries, countryList } from './mapdata';
import { resetBotMemory } from './bot';
import { settings } from './settings';

export type SessionKind = 'local' | 'spectate' | 'online';

export interface MoveAnim {
  src: number;
  tgt: number;
  count: number;
  color: string;
}

export interface Session {
  kind: SessionKind;
  myName: string | null;
  gameId: string;
  allowed: Set<number>;
  busy: boolean;
  snapshot(): Snapshot;
  mode(): GameMode;
  isMyTurn(): boolean;
  isHost(): boolean;
  /** Ticks the simulation (bot turns) — local only. */
  tick(dt: number, speedTps: number): void;
  peace(): Promise<string | void>;
  nothing(): Promise<string | void>;
  gatherLimit(): number;
  gather(buy: number): Promise<string | void>;
  expand(src: number, tgt: number, send: number): Promise<string | void>;
  claimStart(cid: number): Promise<string | true>;
  start(): Promise<string | void>;
  leave(): Promise<void>;
  spectate(): void;
  takeMove(): MoveAnim | null;
  stop(): void;
  onChange?: () => void;
}

// ------------------------------------------------------------------
// Local / spectate
// ------------------------------------------------------------------

export class LocalSession implements Session {
  kind: SessionKind;
  game: Game;
  myName: string | null;
  gameId = 'Local';
  busy = false;
  private acc = 0;
  onChange?: () => void;

  constructor(kind: 'local' | 'spectate', game: Game) {
    this.kind = kind;
    this.game = game;
    this.myName = kind === 'local' ? game.players[0]?.name ?? null : null;
    resetBotMemory();
  }

  get allowed(): Set<number> {
    return this.game.allowed;
  }
  snapshot(): Snapshot {
    return this.game.snapshot('classic');
  }
  mode(): GameMode {
    return 'classic';
  }
  private me(): Player | undefined {
    return this.game.player(this.myName);
  }
  isMyTurn(): boolean {
    const cur = this.game.current();
    return !!cur && this.kind === 'local' && cur.name === this.myName && !cur.is_bot && !cur.eliminated && !cur.is_spectator;
  }
  isHost(): boolean {
    return this.kind === 'local';
  }

  tick(dt: number, speedTps: number): void {
    const g = this.game;
    if (!g.started || g.winner || g.host_disbanded) return;
    // Human hasn't placed a starting country yet: bots wait.
    const me = this.me();
    if (me && !me.had_territory && !me.is_spectator) return;
    this.acc += dt;
    const interval = 1 / Math.max(1, speedTps);
    let steps = 0;
    while (this.acc >= interval && steps < 8) {
      this.acc -= interval;
      steps++;
      const cur = g.current();
      if (!cur) return;
      if (cur.eliminated || cur.is_spectator) g.endTurn();
      else if (cur.is_bot) g.botTurn(cur, settings.bot_difficulty);
      else break;
      if (g.winner) break;
    }
    if (this.acc > interval * 8) this.acc = 0;
  }

  async peace(): Promise<void> {
    const me = this.me();
    if (me) this.game.peace(me);
  }
  async nothing(): Promise<void> {
    const me = this.me();
    if (me) this.game.nothing(me);
  }
  gatherLimit(): number {
    const me = this.me();
    return me ? this.game.rollBuyLimit(me) : 0;
  }
  async gather(buy: number): Promise<void> {
    const me = this.me();
    if (me) this.game.gather(me, buy);
  }
  async expand(src: number, tgt: number, send: number): Promise<string | void> {
    const me = this.me();
    if (!me) return 'No player';
    const res = this.game.expand(me, src, tgt, send);
    if (!res.endTurn) return res.message;
  }
  async claimStart(cid: number): Promise<string | true> {
    const g = this.game;
    const c = g.countries.get(cid);
    const me = this.me();
    if (!c || !me) return 'Invalid country.';
    if (c.owner) return 'That country is already owned.';
    c.owner = me.name;
    c.troops = 1;
    me.owned.add(cid);
    me.had_territory = true;
    g.log(`${me.name} claimed a country in ${c.continent || 'unknown'} with 1 troops.`);
    g.started = true;
    return true;
  }
  async start(): Promise<void> {
    this.game.started = true;
  }
  async leave(): Promise<void> {
    if (this.myName) this.game.removePlayer(this.myName);
  }
  spectate(): void {
    if (this.myName) this.game.makeSpectator(this.myName);
  }
  takeMove(): MoveAnim | null {
    const m = this.game.lastMove;
    this.game.lastMove = null;
    return m;
  }
  stop(): void {}
}

// ------------------------------------------------------------------
// Online (Firebase)
// ------------------------------------------------------------------

export class OnlineSession implements Session {
  kind: SessionKind = 'online';
  fc: FirebaseController;
  gameId: string;
  myName: string;
  doc: Doc;
  busy = false;
  error: string | null = null;
  chat: { sender: string; message: string; timestamp: string }[] = [];
  private pollTimer: number | undefined;
  private chatTimer: number | undefined;
  private lastJson = '';
  private snap: Snapshot | null = null;
  private allowedCache: Set<number> | null = null;
  private pendingMove: MoveAnim | null = null;
  private gatherRoll: { turn: number; limit: number } | null = null;
  /** When my current turn started (ms) — used for the tournament timer. */
  turnStartedAt = 0;
  private lastTurnKey = '';
  onChange?: () => void;
  onChat?: () => void;

  constructor(fc: FirebaseController, gameId: string, myName: string, doc: Doc) {
    this.fc = fc;
    this.gameId = gameId;
    this.myName = myName;
    this.doc = doc;
    this.ingest(doc);
    this.pollTimer = window.setInterval(() => void this.poll(), 1500);
    if (GAME_MODES[this.mode()].chat_enabled) {
      void this.pollChat();
      this.chatTimer = window.setInterval(() => void this.pollChat(), 4000);
    }
  }

  private ingest(doc: Doc): void {
    const json = JSON.stringify(doc);
    if (json === this.lastJson) return;
    this.lastJson = json;
    this.doc = doc;
    this.snap = null;
    this.allowedCache = null;
    const s = this.snapshot();
    const key = `${s.turn_idx}:${s.turn_number}`;
    if (key !== this.lastTurnKey) {
      this.lastTurnKey = key;
      this.turnStartedAt = Date.now();
    }
    this.onChange?.();
  }

  async poll(): Promise<void> {
    try {
      const d = await this.fc.getGame(this.gameId);
      if (d) this.ingest(d);
      else this.error = 'This game no longer exists.';
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  async pollChat(): Promise<void> {
    try {
      const before = this.chat.length;
      this.chat = await this.fc.getChat(this.gameId);
      if (this.chat.length !== before) this.onChat?.();
    } catch { /* chat is best effort */ }
  }

  async sendChat(msg: string): Promise<void> {
    await this.fc.sendChat(this.gameId, this.myName, msg);
    await this.pollChat();
  }

  get allowed(): Set<number> {
    if (!this.allowedCache) {
      const keys = Object.keys(this.doc.countries ?? {}).map(Number).filter((n) => mapCountries.has(n));
      this.allowedCache = new Set(keys.length ? keys : countryList.map((c) => c.id));
    }
    return this.allowedCache;
  }

  mode(): GameMode {
    const m = this.doc.game_mode;
    return m === 'tournament' || m === 'challenge' ? m : 'classic';
  }

  snapshot(): Snapshot {
    if (this.snap) return this.snap;
    const d = this.doc;
    const players = (d.players ?? []).map((p: Doc, i: number) => ({
      name: String(p.name ?? '?'),
      money: Number(p.money ?? 0) || 0,
      is_bot: !!p.is_bot,
      color: normColor(p.color),
      vulnerable: !!p.vulnerable,
      was_attacked: !!p.was_attacked,
      is_host: !!p.is_host || i === 0,
      is_spectator: !!p.is_spectator,
      eliminated: !!p.eliminated,
      time_used: Number(p.time_used ?? 0) || 0,
    }));
    const cs = new Map<number, SnapCountry>();
    for (const [k, v] of Object.entries((d.countries ?? {}) as Doc)) {
      const id = Number(k);
      if (!Number.isFinite(id)) continue;
      cs.set(id, { owner: v?.owner ?? null, troops: Number(v?.troops ?? 0) || 0, continent: v?.continent ?? mapCountries.get(id)?.continent ?? '' });
    }
    const status = String(d.status ?? 'waiting');
    this.snap = {
      players,
      countries: cs,
      turn_idx: Number(d.turn_idx ?? 0) || 0,
      turn_number: Number(d.turn_number ?? 1) || 1,
      logs: Array.isArray(d.logs) ? d.logs : [],
      started: status !== 'waiting',
      status,
      host: players[0]?.name ?? '',
      winner: d.winner ?? null,
      host_disbanded: false,
      game_mode: this.mode(),
      map_scope: (d.map_scope ?? 'world') as MapScope,
    };
    return this.snap;
  }

  isMyTurn(): boolean {
    const s = this.snapshot();
    const cur = s.players[s.turn_idx];
    return !!cur && cur.name === this.myName && !cur.eliminated && !cur.is_spectator && s.status === 'playing';
  }
  isHost(): boolean {
    return this.snapshot().players[0]?.name === this.myName;
  }

  /** Seconds left on my tournament clock (Infinity when the mode has no timer). */
  timeLeft(): number {
    const limit = GAME_MODES[this.mode()].turn_timer;
    if (!limit) return Infinity;
    const me = this.snapshot().players.find((p) => p.name === this.myName);
    const used = me?.time_used ?? 0;
    const live = this.isMyTurn() ? (Date.now() - this.turnStartedAt) / 1000 : 0;
    return Math.max(0, limit - used - live);
  }

  tick(): void {
    if (this.isMyTurn() && !this.busy && this.timeLeft() <= 0) void this.submit('NOTHING', {});
  }

  private async submit(action: string, params: Doc): Promise<string | void> {
    if (this.busy) return 'Please wait…';
    this.busy = true;
    try {
      const used = GAME_MODES[this.mode()].turn_timer ? Math.round((Date.now() - this.turnStartedAt) / 1000) : 0;
      const res = await this.fc.submitAction(this.gameId, this.myName, action, params, used);
      await this.poll();
      if (res.next && res.next !== this.myName) {
        const np = this.snapshot().players.find((p) => p.name === res.next);
        if (np && !np.is_bot) void this.fc.sendTurnNotification(this.gameId, res.next);
      }
    } catch (e) {
      return `${action} failed: ${(e as Error).message}`;
    } finally {
      this.busy = false;
    }
  }

  peace(): Promise<string | void> {
    return this.submit('PEACE', {});
  }
  nothing(): Promise<string | void> {
    return this.submit('NOTHING', {});
  }
  gatherLimit(): number {
    const s = this.snapshot();
    if (!this.gatherRoll || this.gatherRoll.turn !== s.turn_number) this.gatherRoll = { turn: s.turn_number, limit: randInt(1, 20) };
    const me = s.players.find((p) => p.name === this.myName);
    return Math.min(this.gatherRoll.limit, Math.floor((me?.money ?? 0) / TROOP_COST));
  }
  gather(buy: number): Promise<string | void> {
    return this.submit('GATHER', { buy, limit: this.gatherRoll?.limit ?? 20 });
  }
  async expand(src: number, tgt: number, send: number): Promise<string | void> {
    const adj = adjOf(src, this.allowed).find((a) => a.to === tgt);
    if (!adj) return 'Not adjacent';
    const me = this.snapshot().players.find((p) => p.name === this.myName);
    this.pendingMove = { src, tgt, count: send, color: me?.color ?? '#c8c8c8' };
    return this.submit('EXPAND', { src, tgt, send, cross_cost: adj.cost });
  }
  async claimStart(cid: number): Promise<string | true> {
    try {
      const ok = await this.fc.claimStartingCountry(this.gameId, this.myName, cid);
      await this.poll();
      return ok ? true : 'That country was just taken.';
    } catch (e) {
      return `Claim failed: ${(e as Error).message}`;
    }
  }
  async start(): Promise<string | void> {
    try {
      if (!Object.keys(this.doc.countries ?? {}).length) await this.fc.uploadInitialCountries(this.gameId, buildCountriesUpload('world'));
      await this.fc.startGame(this.gameId);
      await this.poll();
    } catch (e) {
      return `Failed to start: ${(e as Error).message}`;
    }
  }
  async leave(): Promise<void> {
    try {
      await this.fc.leaveGame(this.gameId, this.myName);
      if (this.isHost() && this.snapshot().status === 'waiting') await this.fc.removeFromLobby(this.gameId);
    } catch { /* leaving is best effort */ }
  }
  spectate(): void {}
  takeMove(): MoveAnim | null {
    const m = this.pendingMove;
    this.pendingMove = null;
    return m;
  }
  stop(): void {
    window.clearInterval(this.pollTimer);
    window.clearInterval(this.chatTimer);
  }
}

/** build_minimal_countries_for_upload — restricted to the map scope. */
export function buildCountriesUpload(scope: MapScope): Doc {
  const out: Doc = {};
  const conts = SCOPE_CONTINENTS[scope];
  for (const c of countryList) {
    if (conts && !conts.includes(c.continent)) continue;
    out[String(c.id)] = { owner: null, troops: 0, continent: c.continent };
  }
  return out;
}

export const DEFAULT_TPS = TPS;
