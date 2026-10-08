// Port of models.py + game_logic.py + the local action/bot adapters in client.py.

import {
  CLAIM_COST, PEACE_PAYOUT_PER_COUNTRY, PALETTE, STARTING_MONEY, TROOP_COST,
  continentValue, randInt, shortlog, type GameMode, type MapScope,
} from './constants';
import { adjOf, countries as mapCountries, scopeCountryIds } from './mapdata';
import { decide, type BotGameState } from './bot';

export interface SnapPlayer {
  name: string;
  money: number;
  is_bot: boolean;
  color: string;
  vulnerable: boolean;
  was_attacked: boolean;
  is_host: boolean;
  is_spectator: boolean;
  eliminated: boolean;
  time_used?: number;
}

export interface SnapCountry {
  owner: string | null;
  troops: number;
  continent: string;
}

export interface Snapshot {
  players: SnapPlayer[];
  countries: Map<number, SnapCountry>;
  turn_idx: number;
  turn_number: number;
  logs: string[];
  started: boolean;
  status: string;
  host: string;
  winner: string | null;
  host_disbanded: boolean;
  game_mode: GameMode;
  map_scope: MapScope;
}

export class Player {
  name: string;
  is_bot: boolean;
  color: string;
  money = STARTING_MONEY;
  vulnerable = false;
  was_attacked = false;
  owned = new Set<number>();
  troop_buy_limit = 20;
  last_gather_turn = 0;
  is_host: boolean;
  is_spectator = false;
  eliminated = false;
  had_territory = false;

  constructor(name: string, opts: { is_bot?: boolean; color?: string; is_host?: boolean } = {}) {
    this.name = name;
    this.is_bot = !!opts.is_bot;
    this.color = opts.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)];
    this.is_host = !!opts.is_host;
  }

  countryCount(): number {
    return this.owned.size;
  }

  toSnapshot(): SnapPlayer {
    return {
      name: this.name, money: this.money, is_bot: this.is_bot, color: this.color,
      vulnerable: this.vulnerable, was_attacked: this.was_attacked, is_host: this.is_host,
      is_spectator: this.is_spectator, eliminated: this.eliminated,
    };
  }
}

export interface CState {
  id: number;
  owner: string | null;
  troops: number;
  continent: string;
}

export type ActionResult = { ok: boolean; message?: string; endTurn: boolean };

export class Game {
  players: Player[];
  countries = new Map<number, CState>();
  allowed: Set<number>;
  turn_idx: number;
  turn_number = 1;
  logs: string[] = [];
  started = false;
  host_name: string | null;
  player_limit = 0;
  game_id = '';
  winner: string | null = null;
  host_disbanded = false;
  map_scope: MapScope;
  /** Countries changed hands this turn: used by the view for troop-move animations. */
  lastMove: { src: number; tgt: number; count: number; color: string } | null = null;

  constructor(players: Player[], scope: MapScope = 'world') {
    this.players = players;
    this.map_scope = scope;
    this.allowed = scopeCountryIds(scope);
    for (const id of this.allowed) {
      const mc = mapCountries.get(id)!;
      this.countries.set(id, { id, owner: null, troops: 0, continent: mc.continent });
    }
    this.turn_idx = players.length ? Math.floor(Math.random() * players.length) : 0;
    this.host_name = players[0]?.name ?? null;
  }

  log(msg: string): void {
    this.logs.push(shortlog(msg));
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
  }

  current(): Player | null {
    return this.players[this.turn_idx] ?? null;
  }

  player(name: string | null): Player | undefined {
    return name ? this.players.find((p) => p.name === name) : undefined;
  }

  activePlayers(): Player[] {
    return this.players.filter((p) => !p.eliminated && !p.is_spectator);
  }

  checkElimination(): string[] {
    const out: string[] = [];
    // Humans first, then bots (mirrors game_logic.check_elimination ordering)
    for (const wantBot of [false, true]) {
      for (const p of this.players) {
        if (p.eliminated || p.is_spectator || p.is_bot !== wantBot) continue;
        if (p.had_territory && p.countryCount() === 0) {
          p.eliminated = true;
          out.push(p.name);
          this.log(`${p.name} has been eliminated!`);
        }
      }
    }
    const active = this.activePlayers();
    if (active.length === 1 && this.started && !this.winner) {
      this.winner = active[0].name;
      this.log(`${this.winner} wins the game!`);
    }
    return out;
  }

  removePlayer(name: string): void {
    const idx = this.players.findIndex((p) => p.name === name);
    if (idx < 0) return;
    for (const c of this.countries.values()) {
      if (c.owner === name) {
        c.owner = null;
        c.troops = 0;
      }
    }
    const isHost = name === this.host_name;
    this.players.splice(idx, 1);
    if (this.players.length) {
      if (idx < this.turn_idx) this.turn_idx -= 1;
      else if (idx === this.turn_idx) this.turn_idx = this.turn_idx % this.players.length;
      this.turn_idx = Math.min(this.turn_idx, this.players.length - 1);
    }
    if (isHost) {
      this.host_disbanded = true;
      this.log(`Host ${name} has left. Game disbanded.`);
    } else this.log(`${name} has left the game.`);
  }

  makeSpectator(name: string): void {
    const p = this.player(name);
    if (p) {
      p.is_spectator = true;
      this.log(`${name} is now spectating.`);
    }
  }

  kickPlayer(host: string, target: string): boolean {
    if (this.host_name !== host || target === host) return false;
    if (!this.player(target)) return false;
    this.removePlayer(target);
    this.log(`${target} was kicked by the host.`);
    return true;
  }

  snapshot(mode: GameMode = 'classic'): Snapshot {
    const cs = new Map<number, SnapCountry>();
    for (const [id, c] of this.countries) cs.set(id, { owner: c.owner, troops: c.troops, continent: c.continent });
    return {
      players: this.players.map((p) => p.toSnapshot()),
      countries: cs,
      turn_idx: this.turn_idx,
      turn_number: this.turn_number,
      logs: this.logs,
      started: this.started,
      status: this.started ? 'playing' : 'waiting',
      host: this.host_name ?? '',
      winner: this.winner,
      host_disbanded: this.host_disbanded,
      game_mode: mode,
      map_scope: this.map_scope,
    };
  }

  // ------------------------------------------------------------------
  // Rules (game_logic.py)
  // ------------------------------------------------------------------

  private setOwner(c: CState, owner: Player | null, troops: number): void {
    const prev = this.player(c.owner);
    if (prev) prev.owned.delete(c.id);
    c.owner = owner ? owner.name : null;
    c.troops = troops;
    if (owner) {
      owner.owned.add(c.id);
      owner.had_territory = true;
    }
  }

  checkAndPayContinentBonus(player: Player, continent: string): void {
    if (!continent) return;
    const cont = [...this.countries.values()].filter((c) => c.continent === continent);
    if (!cont.length) return;
    if (cont.every((c) => c.owner === player.name)) {
      const bonus = continentValue(continent);
      player.money += bonus;
      this.log(`${player.name} captured a continent (${continent}) and received $${bonus}.`);
    }
  }

  claimCountry(player: Player, c: CState, troops: number): boolean {
    if (player.money < CLAIM_COST) {
      this.log(`${player.name} cannot afford to claim that country (need $${CLAIM_COST}).`);
      return false;
    }
    player.money -= CLAIM_COST;
    this.setOwner(c, player, troops);
    this.log(`${player.name} claimed a country in ${c.continent || 'unknown'} with ${troops} troops (paid $${CLAIM_COST}).`);
    this.checkAndPayContinentBonus(player, c.continent);
    return true;
  }

  /** Attack with troops that have already been removed from the source. */
  attackCountry(attacker: Player, src: CState, tgt: CState, send: number): boolean {
    const defender = this.player(tgt.owner);
    if (defender && defender.vulnerable) {
      if (attacker.money < CLAIM_COST) {
        this.log(`${attacker.name} cannot afford the claim cost ($${CLAIM_COST}); attack aborted.`);
        src.troops += send;
        return false;
      }
      attacker.money -= CLAIM_COST;
      this.setOwner(tgt, attacker, send);
      this.log(`${attacker.name} swept vulnerable territory in ${tgt.continent || 'unknown'} and took it with ${send} troops (paid $${CLAIM_COST}).`);
      defender.was_attacked = true;
      this.checkAndPayContinentBonus(attacker, tgt.continent);
      this.checkElimination();
      return true;
    }
    const atk = randInt(1, 20);
    const d1 = randInt(1, 20);
    const d2 = randInt(1, 20);
    const best = Math.max(d1, d2);
    this.log(`${attacker.name} (atk ${atk}) attacks territory in ${tgt.continent || 'unknown'} owned by ${tgt.owner || 'nobody'} (def [${d1},${d2}] -> ${best})`);
    if (atk > best) {
      if (attacker.money < CLAIM_COST) {
        this.log(`${attacker.name} won the fight but couldn't pay the claim ($${CLAIM_COST}); troops returned to source.`);
        src.troops += send;
        return false;
      }
      attacker.money -= CLAIM_COST;
      this.setOwner(tgt, attacker, send);
      this.log(`${attacker.name} won and captured territory in ${tgt.continent || 'unknown'} with ${send} troops (paid $${CLAIM_COST}).`);
      if (defender) defender.was_attacked = true;
      this.checkAndPayContinentBonus(attacker, tgt.continent);
      this.checkElimination();
      return true;
    }
    this.log(`${attacker.name} attacked but lost; ${send} attacking troops were destroyed.`);
    if (defender) defender.was_attacked = true;
    return false;
  }

  resolvePeace(p: Player): void {
    if (!p.vulnerable) return;
    if (!p.was_attacked) {
      const payout = PEACE_PAYOUT_PER_COUNTRY * Math.max(0, p.countryCount());
      p.money += payout;
      this.log(`${p.name} was peaceful and earned $${payout} ($${PEACE_PAYOUT_PER_COUNTRY} x ${p.countryCount()} countries).`);
    } else {
      this.log(`${p.name} was attacked while vulnerable — no PEACE payout.`);
    }
    p.vulnerable = false;
    p.was_attacked = false;
  }

  endTurn(): void {
    this.turn_number += 1;
    if (!this.players.length) return;
    let attempts = 0;
    while (attempts < this.players.length) {
      this.turn_idx = (this.turn_idx + 1) % this.players.length;
      const n = this.players[this.turn_idx];
      if (!n.eliminated && !n.is_spectator) break;
      attempts++;
    }
    const next = this.players[this.turn_idx];
    if (!next.eliminated && !next.is_spectator) this.resolvePeace(next);
  }

  // ------------------------------------------------------------------
  // Actions (client.do_action / _bot_worker)
  // ------------------------------------------------------------------

  /** Owned countries that border an enemy (gather targets), or all owned if none. */
  private gatherTargets(p: Player): CState[] {
    const owned = [...this.countries.values()].filter((c) => c.owner === p.name);
    const border = owned.filter((c) =>
      adjOf(c.id, this.allowed).some((a) => {
        const nb = this.countries.get(a.to);
        return nb && nb.owner && nb.owner !== p.name;
      }),
    );
    return border.length ? border : owned;
  }

  /** Roll the d20 buy limit once per turn (client.py gather button). */
  rollBuyLimit(p: Player): number {
    if (p.last_gather_turn !== this.turn_number) {
      p.troop_buy_limit = randInt(1, 20);
      p.last_gather_turn = this.turn_number;
      this.log(`${p.name} can buy up to ${p.troop_buy_limit} troops (d20).`);
    }
    return Math.min(p.troop_buy_limit, Math.floor(p.money / TROOP_COST));
  }

  peace(p: Player): void {
    p.vulnerable = true;
    p.was_attacked = false;
    this.log(`${p.name} ${p.is_bot ? 'chooses' : 'chose'} PEACE`);
    this.endTurn();
  }

  nothing(p: Player): void {
    this.log(`${p.name} ${p.is_bot ? 'does' : 'did'} NOTHING`);
    this.endTurn();
  }

  gather(p: Player, buy: number): void {
    const cost = buy * TROOP_COST;
    if (buy > 0 && p.money >= cost) {
      p.money -= cost;
      const targets = this.gatherTargets(p);
      for (let i = 0; i < buy && targets.length; i++) targets[i % targets.length].troops += 1;
      this.log(`${p.name} bought troops for $${cost}`);
    } else {
      this.log(`${p.name} bought 0 troops`);
    }
    this.endTurn();
  }

  /**
   * EXPAND: move troops from src into tgt. Unclaimed targets are claimed,
   * enemy targets are attacked. Returns endTurn=false for user errors that
   * should not cost the human their turn.
   */
  expand(p: Player, srcId: number, tgtId: number, send: number): ActionResult {
    const src = this.countries.get(srcId);
    const tgt = this.countries.get(tgtId);
    if (!src || !tgt || src.owner !== p.name) return { ok: false, message: 'Invalid source or target.', endTurn: false };
    if (tgt.owner === p.name) return { ok: false, message: 'You already own that country.', endTurn: false };
    const adj = adjOf(srcId, this.allowed).find((a) => a.to === tgtId);
    if (!adj) return { ok: false, message: 'Target not adjacent.', endTurn: false };
    const available = src.troops;
    if (available < 2) return { ok: false, message: 'Not enough troops (must leave 1 behind).', endTurn: false };
    if (adj.cost > 0) {
      if (p.money < adj.cost) {
        this.log(`${p.name} cannot pay crossing; cancelled`);
        return { ok: false, message: `Cannot pay the $${adj.cost} crossing fee.`, endTurn: false };
      }
      p.money -= adj.cost;
      this.log(`${p.name} paid crossing $${adj.cost}`);
    }
    send = Math.max(1, Math.min(send, available - 1));
    src.troops -= send;
    this.lastMove = { src: srcId, tgt: tgtId, count: send, color: p.color };
    let ok: boolean;
    if (!tgt.owner) {
      ok = this.claimCountry(p, tgt, send);
      if (!ok) src.troops += send;
    } else {
      ok = this.attackCountry(p, src, tgt, send);
    }
    this.checkElimination();
    this.endTurn();
    return { ok, endTurn: true };
  }

  /** Bot adapter: snapshot -> bot_playstyles.decide -> apply (client._bot_worker). */
  botTurn(bp: Player, difficulty: string): void {
    if (bp.eliminated || bp.is_spectator) {
      this.endTurn();
      return;
    }
    const gs: BotGameState = {
      players: this.players.map((p) => p.toSnapshot()),
      pins: [...this.countries.values()].map((c) => ({
        id: c.id, owner: c.owner, troops: c.troops, continent: c.continent,
        adj: adjOf(c.id, this.allowed),
      })),
    };
    const [cmd, params] = decide(gs, bp.name, difficulty);
    if (cmd === 'PEACE') this.peace(bp);
    else if (cmd === 'GATHER') {
      const roll = randInt(1, 20);
      const buy = Math.min(roll, Math.floor(bp.money / TROOP_COST));
      const cost = buy * TROOP_COST;
      bp.money -= cost;
      const targets = this.gatherTargets(bp);
      for (let i = 0; i < buy && targets.length; i++) targets[i % targets.length].troops += 1;
      this.log(`${bp.name} bought troops for $${cost}`);
      this.endTurn();
    } else if (cmd === 'EXPAND' && params) {
      const [s, t, send] = params;
      const res = this.expand(bp, s, t, send);
      if (!res.endTurn) {
        this.log(`${bp.name} invalid expand -> skip`);
        this.endTurn();
      }
    } else this.nothing(bp);
  }
}

/** client.start_local_game / start_spectate_game */
export function createLocalGame(humanName: string | null, botCount: number, scope: MapScope): Game {
  const palette = [...PALETTE].sort(() => Math.random() - 0.5);
  const pick = () => palette.pop() ?? PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const players: Player[] = [];
  if (humanName) players.push(new Player(humanName, { color: pick(), is_host: true }));
  for (let i = 0; i < botCount; i++) players.push(new Player(`bot${i + 1}`, { is_bot: true, color: pick() }));
  const game = new Game(players, scope);
  for (const pl of players) {
    if (!pl.is_bot) continue;
    const empty = [...game.countries.values()].filter((c) => !c.owner);
    if (!empty.length) break;
    const c = empty[Math.floor(Math.random() * empty.length)];
    c.owner = pl.name;
    c.troops = 1;
    pl.owned.add(c.id);
    pl.had_territory = true;
  }
  if (humanName) game.host_name = humanName;
  else game.started = true;
  return game;
}
