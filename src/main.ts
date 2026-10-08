import './style.css';
import {
  GAME_MODES,
  MAP_SCOPES,
  TROOP_COST,
  VERSION,
  type Difficulty,
  type GameMode,
  type MapScope,
} from './constants';
import { AuthManager, FirebaseController, type Doc, type FriendEntry } from './firebase';
import { createLocalGame, type Snapshot } from './game';
import { loadMap, countries, type MapCountry } from './mapdata';
import { MapRenderer } from './renderer';
import { LocalSession, OnlineSession, buildCountriesUpload, type Session } from './session';
import { RULES_TEXT } from './rules';
import { saveSettings, settings } from './settings';
import { playSfx } from './audio';

type Page =
  | 'home' | 'auth' | 'local-setup' | 'spectate-setup' | 'online'
  | 'browser' | 'joined' | 'stats' | 'leaderboard' | 'friends'
  | 'notifications' | 'rules' | 'learning' | 'settings' | 'play';

const LEARNING_TOPICS = [
  {
    title: 'World geography',
    tag: 'GEOGRAPHY',
    color: 'blue',
    description: 'Read the world map as a network: compare regions, identify neighboring countries, and see how coastlines and crossings shape access.',
    prompt: 'Which nearby countries give you the most useful routes into a continent?',
  },
  {
    title: 'Economic choices',
    tag: 'ECONOMICS',
    color: 'green',
    description: 'Work with a limited treasury. Weigh the guaranteed cost of expansion against troop purchases, peace income, and one-time continent rewards.',
    prompt: 'Would spending now create more value than saving for a continent bonus?',
  },
  {
    title: 'Probability and risk',
    tag: 'PROBABILITY',
    color: 'gold',
    description: 'Combat compares one d20 for the attacker with the higher of two defender rolls. Observe how the extra defensive roll changes the risk of an attack.',
    prompt: 'How often would you expect an attack to succeed before choosing to commit troops?',
  },
  {
    title: 'Strategic planning',
    tag: 'SYSTEMS THINKING',
    color: 'violet',
    description: 'Plan several turns ahead: protect borders, concentrate on reachable objectives, and adapt when opponents change the balance of power.',
    prompt: 'If you take this country, which border becomes harder to defend?',
  },
  {
    title: 'Information and perspective',
    tag: 'DECISION-MAKING',
    color: 'red',
    description: 'Classic, Tournament, and Challenge modes reveal different amounts of information. Make decisions with full visibility, limited visibility, or hidden troop counts.',
    prompt: 'What can you conclude from the map—and what remains uncertain?',
  },
  {
    title: 'Peace and incentives',
    tag: 'CIVIC REASONING',
    color: 'cyan',
    description: 'Peace trades a safe turn for potential income while making your territory vulnerable. Consider how incentives can change what opponents choose next.',
    prompt: 'When might an opponent benefit from breaking your peace?',
  },
];

function getAppRoot(): HTMLElement {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('Could not find the application root.');
  return root;
}

const app = getAppRoot();

const auth = new AuthManager();
let cloud: FirebaseController | null = null;
let session: Session | null = null;
let renderer: MapRenderer | null = null;
let frameHandle = 0;
let previousFrame = 0;
let lastHudUpdate = 0;
let lastMapRender = 0;
let currentPage: Page = 'home';
let selectedCountry: number | null = null;
let expandSource: number | null = null;
let activeAction: 'expand' | null = null;
let hudSignature = '';
const recordedGames = new Set<string>();

const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char] ?? char));
const safeColor = (value: string): string => /^#[\da-f]{3}(?:[\da-f]{3}|[\da-f]{5})?$/i.test(value) ? value : '#718096';
const optionList = <T extends string>(values: Record<T, string>, chosen: T): string =>
  Object.entries(values).map(([value, label]) =>
    `<option value="${esc(value)}"${value === chosen ? ' selected' : ''}>${esc(label)}</option>`,
  ).join('');
const modeOptions = (chosen: GameMode = 'classic'): string =>
  Object.entries(GAME_MODES).map(([value, info]) =>
    `<option value="${value}"${value === chosen ? ' selected' : ''}>${esc(info.label)}</option>`,
  ).join('');

function button(label: string, action: string, variant = ''): string {
  return `<button type="button" class="button ${variant}" data-action="${esc(action)}">${esc(label)}</button>`;
}

function shell(title: string, subtitle: string, content: string, back = true): string {
  return `
    <div class="site-shell">
      <header class="topbar">
        <a class="brand" href="#" data-action="home"><span class="brand-mark">G</span><span>GeoPolitical<br><b>Domination</b></span></a>
        <div class="topbar-right">
          <span class="account-tag">${auth.username ? `Signed in as <b>${esc(auth.username)}</b>` : 'Playing as guest'}</span>
          ${auth.isLoggedIn ? button('Sign out', 'signout', 'quiet') : button('Sign in', 'signin', 'quiet')}
        </div>
      </header>
      <main class="page">
        <div class="page-heading">
          <div><p class="eyebrow">${VERSION} · WEB EDITION</p><h1>${esc(title)}</h1><p class="page-subtitle">${esc(subtitle)}</p></div>
          ${back ? button('← Home', 'home', 'quiet') : ''}
        </div>
        <div id="notice" class="notice" role="status" aria-live="polite"></div>
        ${content}
      </main>
      <footer class="footer">GeoPolitical Domination <span>·</span> Plan carefully. Expand boldly.</footer>
    </div>`;
}

function announce(message: string, kind: 'error' | 'success' | 'info' = 'info'): void {
  const notice = document.querySelector<HTMLElement>('#notice');
  if (!notice) return;
  notice.textContent = message;
  notice.className = `notice visible ${kind}`;
}

function currentFirebase(): FirebaseController {
  if (!auth.isLoggedIn) throw new Error('Sign in to use online features.');
  if (!cloud) cloud = new FirebaseController(auth);
  return cloud;
}

function attachCommon(): void {
  document.querySelectorAll<HTMLElement>('[data-action="home"]').forEach((node) => {
    node.addEventListener('click', (event) => { event.preventDefault(); goHome(); });
  });
  document.querySelectorAll<HTMLElement>('[data-action="signin"]').forEach((node) => {
    node.addEventListener('click', () => renderAuth());
  });
  document.querySelectorAll<HTMLElement>('[data-action="signout"]').forEach((node) => {
    node.addEventListener('click', () => {
      auth.logout();
      cloud = null;
      renderHome();
    });
  });
}

function renderHome(): void {
  currentPage = 'home';
  app.innerHTML = `
    <div class="site-shell main-menu-shell">
      <header class="main-menu-account">
        <span class="account-tag">${auth.username ? `Signed in as <b>${esc(auth.username)}</b>` : 'Not signed in'}</span>
        ${auth.isLoggedIn ? button('Log out', 'signout', 'menu-danger') : button('Log in', 'signin', 'menu-secondary')}
      </header>
      <main class="main-menu">
        <p class="menu-version">GPD · VERSION ${VERSION}</p>
        <h1>GeoPolitical Domination</h1>
        <p class="menu-subtitle">A Strategy Game of World Conquest</p>
        <div id="notice" class="notice menu-notice" role="status" aria-live="polite"></div>
        <section class="main-menu-grid" aria-label="Main menu">
          <div class="main-menu-column primary-menu">
            <button class="menu-button menu-green" data-action="play">Play</button>
            <button class="menu-button menu-purple" data-action="joined">My Games</button>
            <button class="menu-button menu-blue" data-action="stats">Stats</button>
            <button class="menu-button menu-olive" data-action="rules">Rules</button>
            <button class="menu-button menu-olive" data-action="learning">Learning Guide</button>
            <button class="menu-button menu-gray" data-action="settings">Settings</button>
          </div>
          <div class="main-menu-column social-menu">
            <button class="menu-button menu-gold" data-action="leaderboard">Leaderboard</button>
            <button class="menu-button menu-cyan" data-action="friends">Friends</button>
            <button class="menu-button menu-pink" data-action="notifications">Notifications</button>
            <button class="menu-button menu-blue" data-action="online">Online Game</button>
          </div>
        </section>
        <aside class="learning-preview">
          <span class="learning-preview-icon">◎</span>
          <div><b>Learn while you play</b><p>Explore world geography, resource trade-offs, probability, and strategic decision-making.</p></div>
          <button class="text-link" data-action="learning">Explore learning goals →</button>
        </aside>
        <p class="menu-controls">F11 fullscreen <span>·</span> Right-drag pan <span>·</span> Scroll zoom <span>·</span> 1–4 actions <span>·</span> Esc cancel</p>
      </main>
      <footer class="footer">GeoPolitical Domination <span>·</span> ${auth.isLoggedIn ? 'Online play enabled' : 'Local games work without an account'}</footer>
    </div>`;
  attachCommon();
  for (const page of ['play', 'online', 'joined', 'stats', 'leaderboard', 'friends', 'notifications', 'rules', 'learning', 'settings'] as const) {
    document.querySelectorAll<HTMLElement>(`[data-action="${page}"]`).forEach((node) =>
      node.addEventListener('click', () => void openPage(page)),
    );
  }
}

function renderPlayMenu(): void {
  currentPage = 'play';
  app.innerHTML = shell('Play.', 'Choose your game mode.', `
    <section class="mode-select">
      <button class="mode-choice mode-offline" data-mode="local"><span>♙</span><b>Offline Play</b><small>Play a local game against AI rivals.</small></button>
      <button class="mode-choice mode-online" data-mode="online"><span>◎</span><b>Online Game</b><small>Create a room or join players online.</small></button>
      <button class="mode-choice mode-spectate" data-mode="spectate"><span>◉</span><b>Spectate Bots</b><small>Watch AI nations battle for control.</small></button>
    </section>
  `);
  attachCommon();
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((node) => {
    node.addEventListener('click', () => {
      const mode = node.dataset.mode;
      if (mode === 'local') renderSetup('local');
      else if (mode === 'spectate') renderSetup('spectate');
      else renderOnline();
    });
  });
}

function renderAuth(message = ''): void {
  currentPage = 'auth';
  app.innerHTML = shell('Enter the arena.', 'Sign in or create an account to play online.', `
    <div class="auth-layout">
      <section class="form-card">
        <p class="eyebrow">YOUR GPD ACCOUNT</p><h2>Welcome back</h2>
        <p class="muted">Use the same account you use in the desktop game.</p>
        <form id="auth-form" class="stack-form">
          <label>Username<input name="username" maxlength="20" autocomplete="username" required value="${esc(settings.player_name)}" placeholder="Your player name"></label>
          <label>Password<input name="password" type="password" autocomplete="current-password" required placeholder="Your password"></label>
          <div class="form-actions"><button class="button primary" name="intent" value="login">Sign in</button><button class="button secondary" name="intent" value="register">Create account</button></div>
        </form>
        ${message ? `<p class="inline-error">${esc(message)}</p>` : ''}
        <p class="fine-print">Local games are available without signing in. Online accounts are shared with GPD desktop.</p>
      </section>
      <aside class="info-card"><span class="feature-icon">♙</span><h3>Play together</h3><p>Browse public matches, invite friends, and take turns at your own pace. Classic games include live chat.</p></aside>
    </div>
  `);
  attachCommon();
  document.querySelector<HTMLFormElement>('#auth-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const username = String(form.get('username') ?? '').trim();
    const password = String(form.get('password') ?? '');
    const intent = (event as SubmitEvent).submitter?.getAttribute('value') === 'register' ? 'register' : 'login';
    try {
      if (intent === 'register') await auth.register(username, password);
      else await auth.login(username, password);
      settings.player_name = username;
      saveSettings();
      cloud = new FirebaseController(auth);
      renderHome();
      announce(`Welcome, ${username}.`, 'success');
    } catch (error) {
      renderAuth((error as Error).message);
    }
  });
}

function renderSetup(kind: 'local' | 'spectate'): void {
  currentPage = kind === 'local' ? 'local-setup' : 'spectate-setup';
  const spectator = kind === 'spectate';
  app.innerHTML = shell(spectator ? 'Set the stage.' : 'Prepare your campaign.', spectator
    ? 'Choose the map and match settings, then let the bots take over.'
    : 'Choose your rivals and a region. Your first territory is yours to choose.', `
    <section class="form-card wide-card">
      <form id="setup-form" class="setup-grid">
        ${spectator ? '' : `<label>Your name<input name="name" maxlength="20" required value="${esc(settings.player_name)}"></label>`}
        <label>AI opponents<select name="bots">${Array.from({ length: spectator ? 6 : 5 }, (_, i) =>
          `<option value="${i + 1}"${(i + 1) === settings.default_bot_count ? ' selected' : ''}>${i + 1} rival${i ? 's' : ''}</option>`,
        ).join('')}</select></label>
        <label>Bot difficulty<select name="difficulty">
          <option value="easy"${settings.bot_difficulty === 'easy' ? ' selected' : ''}>Easy</option>
          <option value="normal"${settings.bot_difficulty === 'normal' ? ' selected' : ''}>Normal</option>
          <option value="hard"${settings.bot_difficulty === 'hard' ? ' selected' : ''}>Hard</option>
        </select></label>
        <label>Map region<select name="scope">${optionList(MAP_SCOPES, 'world')}</select></label>
        <div class="form-span setup-summary"><span class="summary-mark">◎</span><div><b>${spectator ? 'A living world' : 'Choose your starting country'}</b><p>${spectator ? 'AI players start with a territory and play automatically.' : 'Once the match begins, select any unclaimed territory to claim it for free.'}</p></div></div>
        <button class="button primary form-span" type="submit">${spectator ? 'Start spectating' : 'Start local game'} <span>→</span></button>
      </form>
    </section>
  `);
  attachCommon();
  document.querySelector<HTMLFormElement>('#setup-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const name = spectator ? null : String(form.get('name') ?? '').trim() || 'Player';
    const botCount = Number(form.get('bots'));
    const scope = String(form.get('scope')) as MapScope;
    settings.player_name = name ?? settings.player_name;
    settings.default_bot_count = botCount;
    settings.bot_difficulty = String(form.get('difficulty')) as Difficulty;
    saveSettings();
    const game = createLocalGame(name, botCount, scope);
    beginGame(new LocalSession(spectator ? 'spectate' : 'local', game));
  });
}

function renderOnline(): void {
  currentPage = 'online';
  if (!auth.isLoggedIn) {
    renderAuth('Sign in to browse and join online games.');
    return;
  }
  app.innerHTML = shell('Online games.', 'Join the world-wide lobby, or create a private room for your group.', `
    <section class="online-grid">
      <article class="form-card">
        <p class="eyebrow">CREATE A ROOM</p><h2>Host a new game</h2>
        <form id="create-online-form" class="stack-form">
          <label>Game mode<select name="mode">${modeOptions()}</select></label>
          <label>Map region<select name="scope">${optionList(MAP_SCOPES, 'world')}</select></label>
          <label class="check-label"><input type="checkbox" name="private"> Private room (share a join code)</label>
          <button class="button primary" type="submit">Create game</button>
        </form>
      </article>
      <article class="form-card">
        <p class="eyebrow">JOIN A ROOM</p><h2>Have an invite?</h2>
        <form id="join-code-form" class="stack-form">
          <label>Game ID or private join code<input name="code" required autocomplete="off" placeholder="Enter game ID / code"></label>
              <label>Room player password <span class="muted">(if the host requires one)</span><input name="password" type="password" autocomplete="off" placeholder="Optional"></label>
              <button class="button secondary" type="submit">Join game</button>
            </form>
        <div class="inline-divider"><span>OR FIND A MATCH</span></div>
        ${button('Browse public games', 'browser', 'utility-button full-width')}
        ${button('My active games', 'joined', 'utility-button full-width')}
      </article>
    </section>
  `);
  attachCommon();
  document.querySelector<HTMLElement>('[data-action="browser"]')?.addEventListener('click', () => void renderBrowser());
  document.querySelector<HTMLElement>('[data-action="joined"]')?.addEventListener('click', () => void renderJoined());
  document.querySelector<HTMLFormElement>('#create-online-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    void createOnline(String(form.get('mode')), String(form.get('scope')) as MapScope, form.has('private'));
  });
  document.querySelector<HTMLFormElement>('#join-code-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    void joinOnline(String(form.get('code') ?? '').trim(), String(form.get('password') ?? ''));
  });
}

async function createOnline(mode: string, scope: MapScope, isPrivate: boolean): Promise<void> {
  try {
    const fc = currentFirebase();
    const id = `web_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const doc = await fc.createOrOpenGame(id, auth.username ?? settings.player_name, {
      createOnly: true,
      mode,
      mapScope: scope,
      isPrivate,
      countries: buildCountriesUpload(scope),
    });
    const joined = await fc.loadJoinedGames();
    joined[id] = { player_name: auth.username ?? settings.player_name };
    await fc.saveJoinedGames(joined);
    const online = new OnlineSession(fc, id, auth.username ?? settings.player_name, doc);
    beginGame(online);
    if (doc.join_code) announce(`Room created. Share join code ${doc.join_code} with your friends.`, 'success');
  } catch (error) {
    announce((error as Error).message, 'error');
  }
}

async function joinOnline(codeOrId: string, playerPassword = ''): Promise<void> {
  if (!codeOrId) return;
  try {
    const fc = currentFirebase();
    let id = codeOrId;
    let doc = await fc.getGame(id);
    if (!doc) {
      const found = await fc.findGameByJoinCode(codeOrId.toUpperCase());
      if (!found) throw new Error('No game matches that ID or join code.');
      id = found;
      doc = await fc.getGame(id);
    }
    if (!doc) throw new Error('That game no longer exists.');
    const existingPlayer = (doc.players ?? []).some((player: Doc) => player.name === (auth.username ?? settings.player_name));
    if (doc.status !== 'waiting' && !existingPlayer) {
      throw new Error('That match is already in progress. New players can join waiting rooms only.');
    }
    if (doc.status === 'waiting' && (doc.players ?? []).length >= Number(doc.max_players ?? 6)) {
      throw new Error('That waiting room is full.');
    }
    const updated = await fc.createOrOpenGame(id, auth.username ?? settings.player_name, { createOnly: false, playerPassword });
    const joined = await fc.loadJoinedGames();
    joined[id] = { player_name: auth.username ?? settings.player_name };
    await fc.saveJoinedGames(joined);
    beginGame(new OnlineSession(fc, id, auth.username ?? settings.player_name, updated));
  } catch (error) {
    announce((error as Error).message, 'error');
  }
}

async function renderBrowser(): Promise<void> {
  currentPage = 'browser';
  app.innerHTML = shell('Find a match.', 'Public rooms waiting for players.', `<div id="browser-content" class="form-card"><p class="muted">Loading public rooms…</p></div>`);
  attachCommon();
  try {
    const games = await currentFirebase().listPublicGames();
    const content = document.querySelector<HTMLElement>('#browser-content');
    if (!content || currentPage !== 'browser') return;
    content.innerHTML = games.length ? `
      <div class="table-wrap"><table><thead><tr><th>Host</th><th>Players</th><th>Mode</th><th>Map</th><th></th></tr></thead><tbody>
      ${games.map((game) => `<tr><td>${esc(game.host)}</td><td>${game.players} / ${game.max_players}</td><td>${esc(GAME_MODES[game.mode as GameMode]?.label ?? game.mode)}</td><td>${esc(MAP_SCOPES[game.map as MapScope] ?? game.map)}</td><td><button class="button small primary" data-join-id="${esc(game.id)}">Join</button></td></tr>`).join('')}
      </tbody></table></div>
      <div class="inline-actions">${button('Refresh list', 'refresh-browser', 'quiet')}</div>
    ` : `<div class="empty-state"><span>◎</span><h3>No public rooms right now</h3><p>Create a room and invite your friends, or check back soon.</p>${button('Refresh', 'refresh-browser', 'secondary')}</div>`;
    content.querySelectorAll<HTMLButtonElement>('[data-join-id]').forEach((node) =>
      node.addEventListener('click', () => void joinOnline(node.dataset.joinId ?? '')),
    );
    content.querySelectorAll<HTMLElement>('[data-action="refresh-browser"]').forEach((node) =>
      node.addEventListener('click', () => void renderBrowser()),
    );
  } catch (error) {
    const content = document.querySelector<HTMLElement>('#browser-content');
    if (content) content.innerHTML = `<div class="inline-error">${esc((error as Error).message)}</div>${button('Retry', 'refresh-browser', 'secondary')}`;
    content?.querySelector('[data-action="refresh-browser"]')?.addEventListener('click', () => void renderBrowser());
  }
}

async function renderJoined(): Promise<void> {
  currentPage = 'joined';
  if (!auth.isLoggedIn) {
    renderAuth('Sign in to see online games linked to your account.');
    return;
  }
  app.innerHTML = shell('Your active games.', 'Return to games you have joined.', `<div id="joined-content" class="form-card"><p class="muted">Loading your games…</p></div>`);
  attachCommon();
  try {
    const fc = currentFirebase();
    const saved = await fc.loadJoinedGames();
    const entries = await Promise.all(Object.keys(saved).map(async (id) => ({ id, doc: await fc.getGame(id) })));
    const active = entries.filter((entry) => entry.doc);
    const content = document.querySelector<HTMLElement>('#joined-content');
    if (!content || currentPage !== 'joined') return;
    content.innerHTML = active.length ? `<div class="table-wrap"><table><thead><tr><th>Game</th><th>Status</th><th>Players</th><th>Mode</th><th></th></tr></thead><tbody>${active.map(({ id, doc }) => {
      const data = doc as Doc;
      return `<tr><td>${esc(id)}</td><td>${esc(data.status ?? 'waiting')}</td><td>${(data.players ?? []).length}</td><td>${esc(data.game_mode ?? 'classic')}</td><td><button class="button small primary" data-resume-id="${esc(id)}">Resume</button></td></tr>`;
    }).join('')}</tbody></table></div>` : `<div class="empty-state"><span>⌂</span><h3>No saved games</h3><p>Join a public room or create a new online match to see it here.</p></div>`;
    content.querySelectorAll<HTMLButtonElement>('[data-resume-id]').forEach((node) =>
      node.addEventListener('click', () => void joinOnline(node.dataset.resumeId ?? '')),
    );
  } catch (error) {
    const content = document.querySelector<HTMLElement>('#joined-content');
    if (content) content.innerHTML = `<p class="inline-error">${esc((error as Error).message)}</p>`;
  }
}

async function renderStats(): Promise<void> {
  currentPage = 'stats';
  app.innerHTML = shell('Your record.', 'A summary of your campaigns and competitive play.', `<div id="stats-content" class="form-card"><p class="muted">Loading statistics…</p></div>`);
  attachCommon();
  try {
    const stats = auth.isLoggedIn ? await currentFirebase().getPlayerStats() : JSON.parse(localStorage.getItem('gpd.local.stats') || '{}') as Doc;
    const entries = Object.entries(stats).filter(([, value]) => value && typeof value === 'object');
    const content = document.querySelector<HTMLElement>('#stats-content');
    if (!content || currentPage !== 'stats') return;
    content.innerHTML = entries.length ? `<div class="stats-grid">${entries.map(([mode, raw]) => {
      const row = raw as Doc;
      const played = Number(row.games_played ?? 0);
      const wins = Number(row.wins ?? 0);
      return `<article class="stat-card"><span class="eyebrow">${esc(GAME_MODES[mode as GameMode]?.label ?? mode)}</span><strong>${played}</strong><span>games played</span><div class="stat-row"><span>Wins <b>${wins}</b></span><span>Win rate <b>${played ? Math.round(wins / played * 100) : 0}%</b></span></div><div class="stat-row"><span>Territories taken <b>${Number(row.territories_conquered ?? 0)}</b></span><span>Turns played <b>${Number(row.turns_played ?? 0)}</b></span></div></article>`;
    }).join('')}</div>` : `<div class="empty-state"><span>◌</span><h3>No games recorded yet</h3><p>Finish a local campaign to build your record${auth.isLoggedIn ? ' across your GPD account' : ' on this device'}.</p></div>`;
  } catch (error) {
    const content = document.querySelector<HTMLElement>('#stats-content');
    if (content) content.innerHTML = `<p class="inline-error">${esc((error as Error).message)}</p>`;
  }
}

async function renderLeaderboard(): Promise<void> {
  currentPage = 'leaderboard';
  if (!auth.isLoggedIn) {
    renderAuth('Sign in to view the online leaderboard.');
    return;
  }
  app.innerHTML = shell('The leaderboard.', 'The top competitors across GPD.', `<div id="leaderboard-content" class="form-card"><p class="muted">Loading standings…</p></div>`);
  attachCommon();
  try {
    const standings = await currentFirebase().getLeaderboard();
    const content = document.querySelector<HTMLElement>('#leaderboard-content');
    if (!content || currentPage !== 'leaderboard') return;
    content.innerHTML = standings.length ? `<div class="table-wrap"><table><thead><tr><th>Rank</th><th>Player</th><th>ELO</th><th>W / L</th><th>Games</th></tr></thead><tbody>${standings.map((player, i) =>
      `<tr><td class="rank">#${i + 1}</td><td>${esc(player.username)}</td><td class="elo">${player.elo}</td><td>${player.wins} / ${player.losses}</td><td>${player.games_played}</td></tr>`,
    ).join('')}</tbody></table></div>` : `<div class="empty-state"><h3>No standings yet</h3><p>Check back when players have recorded matches.</p></div>`;
  } catch (error) {
    const content = document.querySelector<HTMLElement>('#leaderboard-content');
    if (content) content.innerHTML = `<p class="inline-error">${esc((error as Error).message)}</p>`;
  }
}

async function renderFriends(): Promise<void> {
  currentPage = 'friends';
  if (!auth.isLoggedIn) {
    renderAuth('Sign in to manage friends.');
    return;
  }
  app.innerHTML = shell('Your network.', 'Add friends and manage incoming invitations.', `
    <section class="form-card"><form id="friend-form" class="inline-form"><label class="grow">Add a player<input name="username" required maxlength="20" placeholder="Their GPD username"></label><button class="button primary" type="submit">Send request</button></form><div id="friend-feedback"></div></section>
    <div id="friends-content" class="form-card"><p class="muted">Loading friends…</p></div>
  `);
  attachCommon();
  const feedback = (message: string, ok: boolean) => {
    const el = document.querySelector<HTMLElement>('#friend-feedback');
    if (el) el.innerHTML = `<p class="${ok ? 'success-text' : 'inline-error'}">${esc(message)}</p>`;
  };
  document.querySelector<HTMLFormElement>('#friend-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget as HTMLFormElement).get('username') ?? '').trim();
    try {
      const [ok, message] = await currentFirebase().sendFriendRequest(name);
      feedback(message, ok);
      if (ok) await refreshFriends();
    } catch (error) { feedback((error as Error).message, false); }
  });
  const refreshFriends = async (): Promise<void> => {
    try {
      const friends = await currentFirebase().getFriends();
      const content = document.querySelector<HTMLElement>('#friends-content');
      if (!content || currentPage !== 'friends') return;
      content.innerHTML = friends.length ? `<div class="list-stack">${friends.map((friend) => friendRow(friend)).join('')}</div>` : `<div class="empty-state"><span>♧</span><h3>Your network is quiet</h3><p>Send a friend request using their GPD username.</p></div>`;
      content.querySelectorAll<HTMLButtonElement>('[data-friend-accept]').forEach((node) =>
        node.addEventListener('click', () => void updateFriend(node.dataset.friendAccept ?? '', 'accept')),
      );
      content.querySelectorAll<HTMLButtonElement>('[data-friend-remove]').forEach((node) =>
        node.addEventListener('click', () => void updateFriend(node.dataset.friendRemove ?? '', 'remove')),
      );
    } catch (error) {
      const content = document.querySelector<HTMLElement>('#friends-content');
      if (content) content.innerHTML = `<p class="inline-error">${esc((error as Error).message)}</p>`;
    }
  };
  const updateFriend = async (uid: string, action: 'accept' | 'remove'): Promise<void> => {
    const [ok, message] = action === 'accept'
      ? await currentFirebase().acceptFriendRequest(uid)
      : await currentFirebase().removeFriend(uid);
    feedback(message, ok);
    await refreshFriends();
  };
  await refreshFriends();
}

function friendRow(friend: FriendEntry): string {
  const action = friend.status === 'pending_received'
    ? `<button class="button small primary" data-friend-accept="${esc(friend.uid)}">Accept</button>`
    : `<span class="muted small-text">${friend.status === 'pending_sent' ? 'Request sent' : 'Friend'}</span>`;
  return `<div class="list-row"><span class="avatar">${esc(friend.username.slice(0, 1).toUpperCase())}</span><div class="list-main"><b>${esc(friend.username)}</b><span>${esc(friend.status.replace('_', ' '))}</span></div>${action}<button class="button small quiet" data-friend-remove="${esc(friend.uid)}">Remove</button></div>`;
}

async function renderNotifications(): Promise<void> {
  currentPage = 'notifications';
  if (!auth.isLoggedIn) {
    renderAuth('Sign in to view your notifications.');
    return;
  }
  app.innerHTML = shell('Messages from the world.', 'Invitations, friend requests, and turn updates.', `<div id="notifications-content" class="form-card"><p class="muted">Loading notifications…</p></div>`);
  attachCommon();
  try {
    const notifications = await currentFirebase().getNotifications();
    const content = document.querySelector<HTMLElement>('#notifications-content');
    if (!content || currentPage !== 'notifications') return;
    content.innerHTML = notifications.length ? `<div class="list-stack">${notifications.map((notice) =>
      `<div class="list-row notification-row${notice.read ? '' : ' unread'}"><span class="feature-icon">${notice.type === 'friend_request' ? '♧' : '◷'}</span><div class="list-main"><b>${esc(notice.from_username || 'GPD')}</b><span>${esc(notice.message || notice.type)} · ${esc(new Date(notice.timestamp).toLocaleString())}</span></div>${notice.game_id ? `<button class="button small primary" data-notice-join="${esc(notice.game_id)}" data-notice-id="${esc(notice.id)}">Join</button>` : `<button class="button small quiet" data-notice-read="${esc(notice.id)}">Mark read</button>`}</div>`,
    ).join('')}</div>` : `<div class="empty-state"><span>◷</span><h3>All caught up</h3><p>There are no new notifications.</p></div>`;
    content.querySelectorAll<HTMLButtonElement>('[data-notice-read]').forEach((node) =>
      node.addEventListener('click', () => void markRead(node.dataset.noticeRead ?? '')),
    );
    content.querySelectorAll<HTMLButtonElement>('[data-notice-join]').forEach((node) =>
      node.addEventListener('click', () => void joinOnline(node.dataset.noticeJoin ?? '')),
    );
    async function markRead(id: string): Promise<void> {
      try {
        await currentFirebase().markNotificationRead(id);
        await renderNotifications();
      } catch (error) {
        announce((error as Error).message, 'error');
      }
    }
  } catch (error) {
    const content = document.querySelector<HTMLElement>('#notifications-content');
    if (content) content.innerHTML = `<p class="inline-error">${esc((error as Error).message)}</p>`;
  }
}

function renderRules(): void {
  currentPage = 'rules';
  const names = [...Object.keys(RULES_TEXT), 'learning'];
  app.innerHTML = shell('How to play.', 'The rules, economy, and tactics of GeoPolitical Domination.', `
    <section class="rules-layout"><nav class="rules-nav">${names.map((name, i) => `<button class="rules-tab${i === 0 ? ' active' : ''}" data-rule="${esc(name)}">${esc(name === 'learning' ? 'Learning guide' : name.replaceAll('_', ' '))}</button>`).join('')}</nav><article id="rules-content" class="rules-content"></article></section>
  `);
  attachCommon();
  const show = (name: string) => {
    const content = document.querySelector<HTMLElement>('#rules-content');
    if (!content) return;
    content.innerHTML = name === 'learning'
      ? learningGuideMarkup()
      : (RULES_TEXT[name] ?? []).map((paragraph) => `<p>${esc(paragraph)}</p>`).join('');
    document.querySelectorAll('.rules-tab').forEach((tab) => tab.classList.toggle('active', (tab as HTMLElement).dataset.rule === name));
  };
  show(names[0] ?? 'general');
  document.querySelectorAll<HTMLButtonElement>('.rules-tab').forEach((tab) =>
    tab.addEventListener('click', () => show(tab.dataset.rule ?? 'general')),
  );
}

function learningGuideMarkup(): string {
  return `
    <div class="learning-heading">
      <p class="eyebrow">LEARNING THROUGH PLAY</p>
      <h2>More than a map to conquer.</h2>
      <p>GPD is a strategy game—not a simulation or a substitute for studying real-world history or politics. Its rules offer a hands-on way to explore these ideas:</p>
    </div>
    <div class="learning-curriculum">
      ${LEARNING_TOPICS.map((topic, index) => `
        <section class="learning-card learning-${topic.color}">
          <div class="learning-card-top"><span class="learning-number">${String(index + 1).padStart(2, '0')}</span><span class="learning-tag">${esc(topic.tag)}</span></div>
          <h3>${esc(topic.title)}</h3>
          <p>${esc(topic.description)}</p>
          <div class="reflection-prompt"><b>Think about it</b><span>${esc(topic.prompt)}</span></div>
        </section>
      `).join('')}
    </div>
    <p class="learning-note">Territory names and map relationships are based on the game's geographic data. Outcomes are shaped by game rules, random rolls, and player choices; they do not predict real events.</p>
  `;
}

function renderLearning(): void {
  currentPage = 'learning';
  app.innerHTML = shell('Learning guide.', 'Use each turn to explore geography, probability, resources, and strategy.', learningGuideMarkup());
  attachCommon();
}

function renderSettings(): void {
  currentPage = 'settings';
  app.innerHTML = shell('Set your preferences.', 'Tune your local campaign and interface.', `
    <section class="form-card wide-card"><form id="settings-form" class="setup-grid">
      <label>Default player name<input name="name" maxlength="20" value="${esc(settings.player_name)}" required></label>
      <label>Default bot count<select name="bots">${Array.from({ length: 5 }, (_, i) => `<option value="${i + 1}"${settings.default_bot_count === i + 1 ? ' selected' : ''}>${i + 1} rivals</option>`).join('')}</select></label>
      <label>Bot difficulty<select name="difficulty"><option value="easy"${settings.bot_difficulty === 'easy' ? ' selected' : ''}>Easy</option><option value="normal"${settings.bot_difficulty === 'normal' ? ' selected' : ''}>Normal</option><option value="hard"${settings.bot_difficulty === 'hard' ? ' selected' : ''}>Hard</option></select></label>
      <label>Sound effects <output id="volume-value">${Math.round(settings.sfx_volume * 100)}%</output><input name="volume" type="range" min="0" max="100" value="${Math.round(settings.sfx_volume * 100)}"></label>
      <label>Map rendering<select name="fps"><option value="30"${settings.render_fps === 30 ? ' selected' : ''}>30 FPS · quieter</option><option value="60"${settings.render_fps !== 30 ? ' selected' : ''}>60 FPS · smooth</option></select></label>
      <label class="check-label"><input name="edge-scroll" type="checkbox"${settings.edge_scroll ? ' checked' : ''}> Scroll map near the screen edge</label>
      <label class="check-label"><input name="show-logs" type="checkbox"${settings.show_logs ? ' checked' : ''}> Show game log</label>
      <label class="check-label"><input name="show-chat" type="checkbox"${settings.show_chat ? ' checked' : ''}> Show online chat</label>
      <button class="button primary form-span" type="submit">Save preferences</button>
    </form></section>
  `);
  attachCommon();
  const volume = document.querySelector<HTMLInputElement>('[name="volume"]');
  volume?.addEventListener('input', () => {
    const output = document.querySelector<HTMLOutputElement>('#volume-value');
    if (output) output.value = `${volume.value}%`;
  });
  document.querySelector<HTMLFormElement>('#settings-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    settings.player_name = String(form.get('name') ?? '').trim() || 'Player';
    settings.default_bot_count = Number(form.get('bots'));
    settings.bot_difficulty = String(form.get('difficulty')) as Difficulty;
    settings.sfx_volume = Number(form.get('volume')) / 100;
    settings.render_fps = Number(form.get('fps'));
    settings.edge_scroll = form.has('edge-scroll');
    settings.show_logs = form.has('show-logs');
    settings.show_chat = form.has('show-chat');
    saveSettings();
    playSfx('capture');
    announce('Preferences saved.', 'success');
  });
}

function beginGame(nextSession: Session): void {
  closeGame();
  session = nextSession;
  selectedCountry = null;
  expandSource = null;
  activeAction = null;
  hudSignature = '';
  renderPlay();
  if (nextSession instanceof OnlineSession) {
    nextSession.onChange = refreshPlay;
    nextSession.onChat = refreshChat;
  }
  previousFrame = 0;
  lastMapRender = 0;
  frameHandle = requestAnimationFrame(gameFrame);
}

function gameFrame(timestamp: number): void {
  const active = session;
  if (!active || currentPage !== 'play') return;
  const dt = previousFrame ? Math.min((timestamp - previousFrame) / 1000, 0.2) : 0;
  previousFrame = timestamp;
  if (active instanceof LocalSession) active.tick(dt, 10);
  else if (active instanceof OnlineSession) active.tick();
  if (timestamp - lastMapRender >= 1000 / Math.max(15, Math.min(settings.render_fps, 60))) {
    renderer?.draw(active.snapshot(), active.mode(), active.allowed);
    lastMapRender = timestamp;
  }
  if (timestamp - lastHudUpdate > 220) {
    refreshPlay();
    lastHudUpdate = timestamp;
  }
  frameHandle = requestAnimationFrame(gameFrame);
}

function renderPlay(): void {
  if (!session) return;
  currentPage = 'play';
  const snapshot = session.snapshot();
  const players = snapshot.players;
  const current = players[snapshot.turn_idx];
  const localPlayer = players.find((player) => player.name === session?.myName);
  const setup = !snapshot.started && session.kind !== 'spectate';
  const controls = snapshot.started && !snapshot.winner && session.kind !== 'spectate' ? `
    <div class="action-toolbar" id="action-toolbar">
      <button class="action-card peace" data-game-action="peace"><kbd>1</kbd><b>Peace</b></button>
      <button class="action-card expand" data-game-action="expand"><kbd>2</kbd><b>Expand</b></button>
      <button class="action-card gather" data-game-action="gather"><kbd>3</kbd><b>Gather</b></button>
      <button class="action-card nothing" data-game-action="nothing"><kbd>4</kbd><b>Nothing</b></button>
    </div>` : '';
  app.innerHTML = `
    <div class="game-shell">
      <main class="game-layout">
        <section class="map-column">
          <div class="map-frame">
            <canvas id="world-map" aria-label="Interactive game map"></canvas>
            <div class="map-vignette"></div>
            <div class="map-brand"><button data-action="leave-game" title="Leave game">GPD</button><span class="game-mode">${esc(GAME_MODES[snapshot.game_mode]?.label ?? 'Classic')} · ${esc(MAP_SCOPES[snapshot.map_scope] ?? snapshot.map_scope)}</span><span>TURN ${snapshot.turn_number}</span></div>
            <div class="map-turn-panel"><div class="panel-kicker">CURRENT TURN</div><div class="turn-player" id="current-player"></div><div class="turn-meta" id="turn-meta"></div></div>
            <div class="map-top-status" id="turn-banner"></div>
            <div id="notice" class="notice game-notice" role="status" aria-live="polite"></div>
            <section class="map-logs" id="logs-panel"><div class="logs-heading">RECENT EVENTS</div><div class="log-list" id="game-logs"></div></section>
            <div class="map-bottom-left" id="map-tip">Right-drag to pan · Scroll to zoom · WASD</div>
            <div class="map-tooltip" id="map-tooltip"></div>
            <button type="button" class="map-reset" data-action="map-reset" title="Reset map view">⌖</button>
            ${setup ? `<div class="claim-banner"><span class="claim-icon">◎</span><div><b>Choose your starting country</b><span>Click any unclaimed territory to claim it for free.</span></div></div>` : ''}
            ${session.kind === 'online' && !snapshot.started && session.isHost() ? `<div class="lobby-start-row"><span>Waiting for each player to claim a country.</span><button class="button primary" data-action="start-online">Start Game</button></div>` : ''}
            <section class="game-result hidden" id="result-card">
              <span class="result-medal">♛</span>
              <div><p class="eyebrow">GAME OVER</p><h2 id="result-title"></h2><p id="result-summary"></p></div>
              <button class="button primary" data-action="leave-game">Leave Game</button>
            </section>
          </div>
        </section>
        <section class="game-dock">
          <div class="player-strip"><div id="player-list" class="player-list"></div></div>
          <div class="action-dock">
            ${controls}
            <div class="setup-controls">${setup ? '<span class="setup-hint">Select an unclaimed country to claim your starting territory.</span>' : ''}${session.kind === 'spectate' ? '<span class="setup-hint">SPECTATING · The nations are making their moves.</span>' : ''}</div>
            <div class="learning-lens" id="learning-lens"><span class="lens-badge">LEARNING LENS</span><span id="learning-tip"></span></div>
            <div class="selection-hint" id="selection-hint"></div>
          </div>
          <section class="side-panel chat-panel" id="chat-panel"><div class="panel-header"><div><span class="panel-kicker">GAME CHAT</span></div></div><div class="chat-list" id="chat-list"></div><form id="chat-form" class="chat-form"><input name="message" maxlength="500" placeholder="Send a message…" autocomplete="off"><button aria-label="Send chat">↗</button></form></section>
        </section>
      </main>
    </div>`;
  attachPlayHandlers();
  const canvas = document.querySelector<HTMLCanvasElement>('#world-map');
  if (!canvas) throw new Error('Could not create the game map.');
  renderer = new MapRenderer(canvas, session, {
    onCountryClick: (country) => void handleCountry(country),
    getSelected: () => selectedCountry,
    getExpandSource: () => expandSource,
    edgeScroll: () => settings.edge_scroll,
    onHover: (country, x, y) => {
      const tip = document.querySelector<HTMLElement>('#map-tooltip');
      if (!tip) return;
      if (!country) {
        tip.classList.remove('visible');
        return;
      }
      const state = session?.snapshot().countries.get(country.id);
      const blind = session?.mode() === 'challenge' && session.kind !== 'spectate';
      const fogged = session ? isTournamentFogged(country, session.snapshot()) : false;
      const owner = blind || fogged ? 'Status unknown' : state?.owner ? `Controlled by ${state.owner}` : 'Unclaimed';
      const troops = blind ? 'Hidden in Challenge mode' : fogged ? 'Unknown' : `${state?.troops ?? 0} troops`;
      tip.innerHTML = `<b>${esc(country.name)}</b><span>Continent: ${esc(country.continent)}</span><span>Owner: ${esc(owner)}</span><span>Troops: ${esc(troops)}</span>`;
      const rect = canvas.getBoundingClientRect();
      tip.style.left = `${Math.min(Math.max(12, x - rect.left + 14), rect.width - 210)}px`;
      tip.style.top = `${Math.max(10, y - rect.top - 58)}px`;
      tip.classList.add('visible');
    },
  });
  refreshPlay();
  if (localPlayer?.name) settings.player_name = localPlayer.name;
}

function attachPlayHandlers(): void {
  if (!session) return;
  attachCommon();
  document.querySelectorAll<HTMLElement>('[data-action="leave-game"]').forEach((node) =>
    node.addEventListener('click', () => void leaveGame()),
  );
  document.querySelector<HTMLElement>('[data-action="map-reset"]')?.addEventListener('click', () => renderer?.resetCamera());
  document.querySelector<HTMLElement>('[data-action="start-online"]')?.addEventListener('click', () => void startOnlineGame());
  document.querySelectorAll<HTMLButtonElement>('[data-game-action]').forEach((node) =>
    node.addEventListener('click', () => void chooseAction(node.dataset.gameAction ?? '')),
  );
  document.addEventListener('keydown', handleGameKey);
  document.querySelector<HTMLFormElement>('#chat-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!(session instanceof OnlineSession)) return;
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem('message') as HTMLInputElement;
    const message = input.value.trim();
    if (!message) return;
    try {
      await session.sendChat(message);
      input.value = '';
      refreshChat();
    } catch (error) {
      announce((error as Error).message, 'error');
    }
  });
}

function handleGameKey(event: KeyboardEvent): void {
  if (currentPage !== 'play' || event.repeat || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.key === 'Escape') {
    activeAction = null;
    expandSource = null;
    refreshPlay();
    return;
  }
  if (['w', 'ArrowUp'].includes(event.key)) { event.preventDefault(); renderer?.panBy(0, 45); }
  if (['s', 'ArrowDown'].includes(event.key)) { event.preventDefault(); renderer?.panBy(0, -45); }
  if (['a', 'ArrowLeft'].includes(event.key)) { event.preventDefault(); renderer?.panBy(45, 0); }
  if (['d', 'ArrowRight'].includes(event.key)) { event.preventDefault(); renderer?.panBy(-45, 0); }
  if (event.key === '1') void chooseAction('peace');
  if (event.key === '2') void chooseAction('expand');
  if (event.key === '3') void chooseAction('gather');
  if (event.key === '4') void chooseAction('nothing');
  if (event.key.toLowerCase() === 'f') renderer?.resetCamera();
}

async function handleCountry(country: MapCountry): Promise<void> {
  if (!session) return;
  selectedCountry = country.id;
  const snapshot = session.snapshot();
  if (!snapshot.started && session.kind !== 'spectate') {
    const state = snapshot.countries.get(country.id);
    const alreadyClaimed = session.myName && [...snapshot.countries.values()].some((item) => item.owner === session?.myName);
    if (alreadyClaimed) {
      announce('You already have a starting country. Wait for the host to begin.', 'info');
      refreshPlay();
      return;
    }
    if (state?.owner) {
      announce('That country is already claimed. Choose an unclaimed territory.', 'info');
      refreshPlay();
      return;
    }
    const result = await session.claimStart(country.id);
    if (result !== true) announce(result, 'error');
    else {
      playSfx('capture');
      announce(`${country.name} is your starting territory.`, 'success');
    }
    refreshPlay();
    return;
  }
  if (activeAction === 'expand' && session.isMyTurn()) {
    const state = snapshot.countries.get(country.id);
    if (expandSource === null) {
      if (state?.owner !== session.myName) {
        announce('Choose one of your countries as the source.', 'info');
        refreshPlay();
        return;
      }
      expandSource = country.id;
      refreshPlay();
      return;
    }
    if (country.id === expandSource) {
      expandSource = null;
      refreshPlay();
      return;
    }
    const source = snapshot.countries.get(expandSource);
    if (state?.owner === session.myName) {
      expandSource = country.id;
      refreshPlay();
      return;
    }
    const adjacency = countries.get(expandSource)?.adj.find((item) => item.to === country.id);
    if (!adjacency) {
      announce('That territory is not adjacent. Choose a highlighted neighbor.', 'error');
      return;
    }
    const player = snapshot.players.find((item) => item.name === session?.myName);
    if ((player?.money ?? 0) < adjacency.cost + 200) {
      announce(`You need $${adjacency.cost + 200} for the capture and crossing fees.`, 'error');
      return;
    }
    if (!source || source.troops < 2) {
      announce('You need at least 2 troops in the source country, and must leave 1 behind.', 'error');
      return;
    }
    openExpandDialog(country, source.troops - 1, adjacency.cost);
    return;
  }
  refreshPlay();
}

function chooseAction(action: string): void {
  if (!session || !session.isMyTurn() || session.busy) return;
  if (action === 'expand') {
    activeAction = 'expand';
    expandSource = null;
    announce('Choose one of your countries, then a highlighted neighboring territory.', 'info');
    refreshPlay();
  } else if (action === 'gather') {
    activeAction = null;
    expandSource = null;
    openGatherDialog();
  }
  else if (action === 'peace') void runAction(session.peace(), 'peace');
  else if (action === 'nothing') void runAction(session.nothing(), 'turn');
}

async function runAction(action: Promise<string | void>, sound: 'peace' | 'turn' | 'capture' = 'turn'): Promise<void> {
  if (!session) return;
  const result = await action;
  if (typeof result === 'string') announce(result, 'error');
  else {
    playSfx(sound === 'peace' ? 'turn' : sound);
    activeAction = null;
    expandSource = null;
    announce('Action complete.', 'success');
  }
  refreshPlay();
}

function showDialog(title: string, inner: string, submit: (form: FormData) => Promise<void> | void): void {
  const old = document.querySelector<HTMLDialogElement>('#game-dialog');
  old?.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'game-dialog';
  dialog.className = 'game-dialog';
  dialog.innerHTML = `<form method="dialog" class="dialog-close-form"><button class="dialog-close" aria-label="Close">×</button></form><form id="dialog-form" class="dialog-inner"><p class="eyebrow">YOUR NEXT MOVE</p><h2>${esc(title)}</h2>${inner}<div class="form-actions"><button type="button" class="button quiet" data-dialog-cancel>Cancel</button><button class="button primary" type="submit">Confirm action</button></div></form>`;
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector('[data-dialog-cancel]')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.querySelector<HTMLFormElement>('#dialog-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const submitButton = (event.currentTarget as HTMLFormElement).querySelector<HTMLButtonElement>('[type="submit"]');
    if (submitButton) submitButton.disabled = true;
    try {
      await submit(form);
      if (dialog.open) dialog.close();
    } catch (error) {
      announce((error as Error).message, 'error');
      if (submitButton) submitButton.disabled = false;
    }
  });
}

function openGatherDialog(): void {
  if (!session) return;
  const max = session.gatherLimit();
  const affordable = Math.min(max, Math.floor((session.snapshot().players.find((p) => p.name === session?.myName)?.money ?? 0) / TROOP_COST));
  showDialog('Gather your forces.', `<p class="dialog-copy">Recruit troops at <b>$${TROOP_COST}</b> each. Your roll allows up to <b>${max}</b> this turn; the treasury allows <b>${affordable}</b>.</p><label>Troops to recruit <output id="gather-value">${affordable}</output><input name="buy" type="range" min="0" max="${affordable}" value="${affordable}"></label><p class="dialog-cost">Total cost <b id="gather-cost">$${affordable * TROOP_COST}</b></p>`, async (form) => {
    const buy = Number(form.get('buy'));
    const error = await session?.gather(buy);
    if (error) throw new Error(error);
    playSfx('turn');
    activeAction = null;
    refreshPlay();
  });
  const slider = document.querySelector<HTMLInputElement>('#game-dialog [name="buy"]');
  slider?.addEventListener('input', () => {
    const value = Number(slider.value);
    const output = document.querySelector<HTMLOutputElement>('#gather-value');
    const cost = document.querySelector<HTMLElement>('#gather-cost');
    if (output) output.value = String(value);
    if (cost) cost.textContent = `$${value * TROOP_COST}`;
  });
}

function openExpandDialog(target: MapCountry, max: number, crossingCost: number): void {
  if (!session || expandSource === null) return;
  const source = session.snapshot().countries.get(expandSource);
  if (!source) return;
  showDialog(`Expand into ${target.name}.`, `<p class="dialog-copy">Send troops from <b>${esc(countries.get(expandSource)?.name)}</b>. You must leave at least one troop behind. ${crossingCost ? `Crossing fee: $${crossingCost}.` : 'No crossing fee.'}</p><label>Troops to send <output id="send-value">${max}</output><input name="send" type="range" min="1" max="${max}" value="${max}"></label><p class="dialog-cost">Capture cost <b>$200</b> <span>plus any crossing fee</span></p>`, async (form) => {
    const error = await session?.expand(expandSource!, target.id, Number(form.get('send')));
    if (error) throw new Error(error);
    playSfx('attack');
    activeAction = null;
    expandSource = null;
    refreshPlay();
  });
  const slider = document.querySelector<HTMLInputElement>('#game-dialog [name="send"]');
  slider?.addEventListener('input', () => {
    const output = document.querySelector<HTMLOutputElement>('#send-value');
    if (output) output.value = slider.value;
  });
}

async function startOnlineGame(): Promise<void> {
  if (!session || !(session instanceof OnlineSession)) return;
  const snapshot = session.snapshot();
  const unclaimedPlayers = snapshot.players.filter((player) => !player.is_spectator && !snapshot.players.some((p) => p.name === player.name && [...snapshot.countries.values()].some((c) => c.owner === p.name)));
  if (unclaimedPlayers.length) {
    announce(`Every player must claim a starting country first. Waiting for ${unclaimedPlayers.map((p) => p.name).join(', ')}.`, 'error');
    return;
  }
  const error = await session.start();
  if (error) announce(error, 'error');
  else announce('The game has begun. Good luck.', 'success');
}

function refreshPlay(): void {
  if (!session || currentPage !== 'play') return;
  const snapshot = session.snapshot();
  const move = session.takeMove();
  if (move) renderer?.showMove(move);
  renderer?.draw(snapshot, session.mode(), session.allowed);
  const current = snapshot.players[snapshot.turn_idx];
  const mine = session.myName ? snapshot.players.find((p) => p.name === session?.myName) : undefined;
  const isMyTurn = session.isMyTurn();
  const isSetup = !snapshot.started && session.kind !== 'spectate';
  const banner = document.querySelector<HTMLElement>('#turn-banner');
  if (banner) {
    if (snapshot.winner) {
      banner.innerHTML = `<span class="turn-light"></span><b>${esc(snapshot.winner)} wins the world</b>`;
      banner.classList.add('winner-banner');
    } else if (isSetup) {
      banner.innerHTML = `<span class="turn-light"></span><b>Choose your starting country</b>`;
      banner.classList.remove('winner-banner');
    } else {
      banner.innerHTML = `<span class="turn-light${isMyTurn ? ' mine' : ''}"></span><b>${isMyTurn ? 'Your turn' : `${esc(current?.name ?? 'Waiting')} is playing`}</b>`;
      banner.classList.remove('winner-banner');
    }
  }
  const playerNode = document.querySelector<HTMLElement>('#current-player');
  if (playerNode) playerNode.innerHTML = current ? `<span class="player-swatch" style="--player:${safeColor(current.color)}"></span><strong>${esc(current.name)}</strong><span class="turn-badge">${isMyTurn ? 'YOU' : current.is_bot ? 'BOT' : 'WAITING'}</span>` : '<span class="muted">Waiting for players</span>';
  const turnMeta = document.querySelector<HTMLElement>('#turn-meta');
  if (turnMeta) {
    if (session instanceof OnlineSession && session.mode() === 'tournament') {
      const seconds = session.timeLeft();
      turnMeta.textContent = isMyTurn ? `${Math.ceil(seconds)}s remaining on your match clock` : 'Tournament clock';
    } else turnMeta.textContent = `Turn ${snapshot.turn_number} · ${snapshot.players.filter((p) => !p.eliminated && !p.is_spectator).length} nations active`;
  }
  const list = document.querySelector<HTMLElement>('#player-list');
  const nextSignature = JSON.stringify([snapshot.players, snapshot.countries.size, snapshot.turn_idx, snapshot.turn_number, snapshot.logs.length, isMyTurn, session.busy, snapshot.started, snapshot.winner, session instanceof OnlineSession ? session.timeLeft() : null]);
  if (list && nextSignature !== hudSignature) {
    hudSignature = nextSignature;
    list.innerHTML = snapshot.players.map((player) => {
      const ownedCountries = [...snapshot.countries.values()].filter((country) => country.owner === player.name);
      const owned = ownedCountries.length;
      const troops = ownedCountries.reduce((total, country) => total + country.troops, 0);
      const isCurrent = player.name === current?.name;
      const isMe = player.name === session?.myName;
      const role = player.eliminated ? 'ELIMINATED' : player.is_spectator ? 'SPECTATING' : player.is_bot ? 'BOT' : isMe ? 'YOU' : '';
      return `<article class="player-card${player.eliminated ? ' eliminated' : ''}${player.is_spectator ? ' spectator' : ''}${isCurrent ? ' current' : ''}" style="--player:${safeColor(player.color)}"><div class="player-card-name"><span class="player-swatch"></span><b>${esc(player.name)}</b>${role ? `<small>${role}</small>` : ''}</div>${role === 'ELIMINATED' || role === 'SPECTATING' ? `<span class="player-card-status">${role}</span>` : `<div class="player-card-money">$${player.money}</div><div class="player-card-stats"><span>${troops} troops</span><span>${owned} land</span></div>`}${player.is_host ? '<span class="host-star" title="Host">★</span>' : ''}</article>`;
    }).join('');
    const logList = document.querySelector<HTMLElement>('#game-logs');
    if (logList) {
      logList.innerHTML = snapshot.logs.slice(-8).map((line) => `<div class="log-entry">${esc(line)}</div>`).join('');
      logList.scrollTop = logList.scrollHeight;
    }
  }
  const toolbar = document.querySelector<HTMLElement>('#action-toolbar');
  if (toolbar) {
    toolbar.querySelectorAll<HTMLButtonElement>('[data-game-action]').forEach((node) => {
      node.disabled = !isMyTurn || session!.busy;
      node.classList.toggle('selected', node.dataset.gameAction === activeAction);
    });
  }
  const hint = document.querySelector<HTMLElement>('#selection-hint');
  if (hint) {
    hint.textContent = activeAction === 'expand'
      ? expandSource === null ? 'EXPAND · Select one of your territories to move troops from.' : `EXPAND · Select an adjacent country next to ${countries.get(expandSource)?.name}.`
      : selectedCountry !== null ? countryDescription(snapshot, selectedCountry, session.mode()) : '';
    hint.classList.toggle('visible', !!hint.textContent);
  }
  const lesson = document.querySelector<HTMLElement>('#learning-tip');
  if (lesson) lesson.textContent = learningPrompt(snapshot, isSetup);
  const resultCard = document.querySelector<HTMLElement>('#result-card');
  if (resultCard && snapshot.winner) {
    const won = snapshot.winner === session.myName;
    resultCard.classList.remove('hidden');
    const title = document.querySelector<HTMLElement>('#result-title');
    const summary = document.querySelector<HTMLElement>('#result-summary');
    if (title) title.textContent = won ? 'Victory is yours.' : `${snapshot.winner} dominates the map.`;
    if (summary) summary.textContent = `${snapshot.winner} is the last nation standing after ${snapshot.turn_number} turns.`;
  } else resultCard?.classList.add('hidden');
  document.querySelector<HTMLElement>('#logs-panel')?.classList.toggle('hidden', !settings.show_logs);
  const showChat = session instanceof OnlineSession && GAME_MODES[session.mode()].chat_enabled && settings.show_chat;
  document.querySelector<HTMLElement>('#chat-panel')?.classList.toggle('hidden', !showChat);
  const startButton = document.querySelector<HTMLButtonElement>('[data-action="start-online"]');
  if (startButton) startButton.disabled = !session.isHost() || snapshot.started || snapshot.players.some((player) =>
    !player.is_spectator && ![...snapshot.countries.values()].some((country) => country.owner === player.name),
  );
  const title = document.querySelector<HTMLElement>('.game-mode');
  if (title) title.title = current ? `Current player: ${current.name}` : '';
  if (snapshot.winner) void recordResult(snapshot, session);
  if (session instanceof OnlineSession && session.error) announce(session.error, 'error');
  void mine;
}

function countryDescription(snapshot: Snapshot, id: number, mode: GameMode): string {
  const country = countries.get(id);
  const state = snapshot.countries.get(id);
  if (!country || !state) return '';
  if (mode === 'challenge') return `${country.name} · ${country.continent} · Details hidden in challenge mode.`;
  if (isTournamentFogged(country, snapshot)) return `${country.name} · ${country.continent} · Details hidden by fog of war.`;
  return `${country.name} · ${country.continent} · ${state.owner ? `${state.owner}, ${state.troops} troops` : 'Unclaimed'}`;
}

function isTournamentFogged(country: MapCountry, snapshot: Snapshot): boolean {
  if (!session || session.mode() !== 'tournament' || session.kind === 'spectate') return false;
  const myName = session.myName;
  return snapshot.countries.get(country.id)?.owner !== myName
    && !country.adj.some((adj) => snapshot.countries.get(adj.to)?.owner === myName);
}

function learningPrompt(snapshot: Snapshot, setup: boolean): string {
  if (setup) return 'GEOGRAPHY · Choose a starting country with useful neighbors and routes into nearby regions.';
  if (activeAction === 'expand') return 'GEOGRAPHY + ECONOMICS · Check adjacency and crossing fees before you commit.';
  if (activeAction) return 'PLANNING · Compare the immediate benefit of your action with what it costs you next turn.';
  const topic = LEARNING_TOPICS[snapshot.turn_number % LEARNING_TOPICS.length];
  return `${topic.tag} · ${topic.prompt}`;
}

function refreshChat(): void {
  if (!(session instanceof OnlineSession) || currentPage !== 'play') return;
  const list = document.querySelector<HTMLElement>('#chat-list');
  if (!list) return;
  list.innerHTML = session.chat.map((message) => `<div class="chat-message"><b>${esc(message.sender)}</b><span>${esc(message.message)}</span></div>`).join('') || '<p class="muted chat-empty">No messages yet. Say hello.</p>';
  list.scrollTop = list.scrollHeight;
}

async function recordResult(snapshot: Snapshot, active: Session): Promise<void> {
  const winner = snapshot.winner;
  if (!winner || !active.myName || recordedGames.has(active.gameId)) return;
  recordedGames.add(active.gameId);
  const owned = [...snapshot.countries.values()].filter((country) => country.owner === active.myName).length;
  const won = winner === active.myName;
  if (active instanceof OnlineSession) {
    try {
      await active.fc.updatePlayerStats(active.mode(), won, owned, snapshot.turn_number);
      await active.fc.updateElo(won);
    } catch (error) {
      announce(`The game ended, but your profile could not be updated: ${(error as Error).message}`, 'error');
    }
  } else {
    const stats = JSON.parse(localStorage.getItem('gpd.local.stats') || '{}') as Doc;
    const key = active.mode();
    const entry = (stats[key] ??= { games_played: 0, wins: 0, losses: 0, territories_conquered: 0, turns_played: 0 }) as Doc;
    entry.games_played = Number(entry.games_played) + 1;
    entry.wins = Number(entry.wins) + Number(won);
    entry.losses = Number(entry.losses) + Number(!won);
    entry.territories_conquered = Number(entry.territories_conquered) + owned;
    entry.turns_played = Number(entry.turns_played) + snapshot.turn_number;
    localStorage.setItem('gpd.local.stats', JSON.stringify(stats));
  }
}

async function leaveGame(): Promise<void> {
  const active = session;
  if (!active) return;
  if (active.kind === 'online' && !window.confirm('Leave this online game?')) return;
  closeGame();
  try {
    await active.leave();
  } catch (error) {
    console.error('Unable to leave game cleanly:', error);
  }
  renderHome();
}

function closeGame(): void {
  cancelAnimationFrame(frameHandle);
  document.removeEventListener('keydown', handleGameKey);
  renderer?.destroy();
  renderer = null;
  session?.stop();
  session = null;
}

function goHome(): void {
  if (session && currentPage === 'play') {
    void leaveGame();
    return;
  }
  closeGame();
  renderHome();
}

function openPage(page: Page): void {
  if (page === 'home') renderHome();
  else if (page === 'auth') renderAuth();
  else if (page === 'play') renderPlayMenu();
  else if (page === 'local-setup') renderSetup('local');
  else if (page === 'spectate-setup') renderSetup('spectate');
  else if (page === 'online') renderOnline();
  else if (page === 'browser') void renderBrowser();
  else if (page === 'joined') void renderJoined();
  else if (page === 'stats') void renderStats();
  else if (page === 'leaderboard') void renderLeaderboard();
  else if (page === 'friends') void renderFriends();
  else if (page === 'notifications') void renderNotifications();
  else if (page === 'rules') renderRules();
  else if (page === 'learning') renderLearning();
  else if (page === 'settings') renderSettings();
}

async function start(): Promise<void> {
  try {
    await loadMap();
    if (await auth.restore()) cloud = new FirebaseController(auth);
    app.setAttribute('aria-busy', 'false');
    renderHome();
  } catch (error) {
    app.setAttribute('aria-busy', 'false');
    app.innerHTML = `<main class="fatal-error"><h1>GPD could not start.</h1><p>${esc((error as Error).message)}</p><button class="button secondary" onclick="location.reload()">Reload</button></main>`;
  }
}

void start();
