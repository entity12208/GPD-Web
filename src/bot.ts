// Port of bot_playstyles.py — adaptive bot AI.
// The bot analyses the game state each turn and computes situational weights
// (expansionist / opportunist / continent-focused / defensive / economic / aggressive).

import { BOT_DIFFICULTY_PRESETS, CLAIM_COST, TROOP_COST, continentValue, type Difficulty } from './constants';
import type { Adj } from './mapdata';

export interface BotPin {
  id: number;
  owner: string | null;
  troops: number;
  continent: string;
  adj: Adj[];
}
export interface BotPlayer {
  name: string;
  money: number;
  vulnerable: boolean;
}
export interface BotGameState {
  players: BotPlayer[];
  pins: BotPin[];
}
export type BotAction = ['PEACE' | 'GATHER' | 'EXPAND' | 'NOTHING', [number, number, number] | null];

type Weights = {
  attack_willingness: number;
  continent_weight: number;
  vuln_bonus: number;
  free_claim_bonus: number;
  crossing_penalty: number;
  peace_preference: number;
  gather_preference: number;
  gather_threshold: number;
  _stalemate_target?: number | null;
};

interface ContInfo { total: number; mine: number; enemy: number; free: number }

const targetContinents = new Map<string, string | null>();

/** Reset multi-turn planning memory (new game). */
export function resetBotMemory(): void {
  targetContinents.clear();
}

class Ctx {
  gs: BotGameState;
  me: string;
  byId = new Map<number, BotPin>();
  private threatsCache: Map<number, number> | null = null;
  constructor(gs: BotGameState, me: string) {
    this.gs = gs;
    this.me = me;
    for (const p of gs.pins) this.byId.set(p.id, p);
  }
  pinsOf(owner: string): BotPin[] {
    return this.gs.pins.filter((p) => p.owner === owner);
  }
  neighbors(pin: BotPin): [BotPin, number][] {
    const out: [BotPin, number][] = [];
    for (const a of pin.adj) {
      const nb = this.byId.get(a.to);
      if (nb) out.push([nb, a.cost || 0]);
    }
    return out;
  }
  totalTroops(name: string): number {
    let t = 0;
    for (const p of this.gs.pins) if (p.owner === name) t += p.troops || 0;
    return t;
  }
  continentState(): Map<string, ContInfo> {
    const m = new Map<string, ContInfo>();
    for (const p of this.gs.pins) {
      const cont = p.continent || '';
      if (!cont) continue;
      let ci = m.get(cont);
      if (!ci) m.set(cont, (ci = { total: 0, mine: 0, enemy: 0, free: 0 }));
      ci.total++;
      if (p.owner === this.me) ci.mine++;
      else if (p.owner) ci.enemy++;
      else ci.free++;
    }
    return m;
  }
  vulnerable(): Set<string> {
    return new Set(this.gs.players.filter((p) => p.vulnerable && p.name !== this.me).map((p) => p.name));
  }
  borderThreats(): Map<number, number> {
    if (this.threatsCache) return this.threatsCache;
    const threats = new Map<number, number>();
    for (const pin of this.pinsOf(this.me)) {
      let maxT = 0;
      for (const [nb] of this.neighbors(pin)) {
        if (nb.owner && nb.owner !== this.me) maxT = Math.max(maxT, nb.troops || 0);
      }
      if (maxT > 0) threats.set(pin.id, maxT);
    }
    return (this.threatsCache = threats);
  }
}

const P_WIN = 0.2467; // P(1d20 > max(2d20))

function strongestPlayer(ctx: Ctx): [string | null, number] {
  let best: string | null = null;
  let bestT = 0;
  for (const p of ctx.gs.players) {
    if (p.name === ctx.me) continue;
    const t = ctx.totalTroops(p.name);
    if (t > bestT) {
      bestT = t;
      best = p.name;
    }
  }
  return [best, bestT];
}

function weakestBorder(ctx: Ctx): number | null {
  const threats = ctx.borderThreats();
  let minId: number | null = null;
  let minV = Infinity;
  for (const [id, v] of threats) if (v < minV) {
    minV = v;
    minId = id;
  }
  return minId;
}

function postAttackSafe(ctx: Ctx, src: BotPin, send: number): boolean {
  const remaining = (src.troops || 0) - send;
  if (remaining <= 1) {
    for (const [nb] of ctx.neighbors(src)) {
      if (nb.owner && nb.owner !== ctx.me && (nb.troops || 0) >= 3) return false;
    }
  }
  return true;
}

function nearestContinentToComplete(ctx: Ctx): [string | null, number] {
  let best: string | null = null;
  let minRem = Infinity;
  for (const [cont, ci] of ctx.continentState()) {
    if (ci.mine > 0) {
      const rem = ci.total - ci.mine;
      if (rem > 0 && rem < minRem) {
        minRem = rem;
        best = cont;
      }
    }
  }
  return [best, best ? minRem : Infinity];
}

function computeWeights(ctx: Ctx, myPins: BotPin[], myMoney: number, difficulty: Difficulty): Weights {
  const preset = BOT_DIFFICULTY_PRESETS[difficulty] ?? BOT_DIFFICULTY_PRESETS.normal;
  const me = ctx.me;
  const territoryCount = myPins.length;
  const myTroopTotal = ctx.totalTroops(me);
  const totalPins = ctx.gs.pins.length;
  const vulnerable = ctx.vulnerable();

  let maxBorderTroops = 0;
  for (const pin of myPins) {
    for (const a of pin.adj) {
      const nb = ctx.byId.get(a.to);
      if (nb && nb.owner && nb.owner !== me) {
        maxBorderTroops = Math.max(maxBorderTroops, pin.troops || 0);
        break;
      }
    }
  }

  let freeAdjacent = 0;
  let vulnAdjacent = 0;
  let adjacentEnemyTroops = 0;
  for (const pin of myPins) {
    for (const [nb] of ctx.neighbors(pin)) {
      if (!nb.owner) freeAdjacent++;
      if (nb.owner && vulnerable.has(nb.owner)) vulnAdjacent++;
      if (nb.owner && nb.owner !== me && !vulnerable.has(nb.owner)) adjacentEnemyTroops += nb.troops || 0;
    }
  }
  const threatRatio = adjacentEnemyTroops / Math.max(1, myTroopTotal);

  let nearContinent = false;
  const [targetCont, contRemaining] = nearestContinentToComplete(ctx);
  if (targetCont && contRemaining <= 2) {
    nearContinent = true;
    targetContinents.set(me, targetCont);
  }
  const buildingForContinent = !!targetCont && contRemaining <= 3 && contRemaining > 0;

  const allOwned = ctx.gs.pins.every((p) => p.owner);
  const stalemate = allOwned && vulnAdjacent === 0 && freeAdjacent === 0;

  const [strongest, strongestTroops] = strongestPlayer(ctx);
  const imWeak = myTroopTotal < strongestTroops * 0.5;
  let strongestIsNeighbor = false;
  if (strongest) {
    outer: for (const pin of myPins) {
      for (const [nb] of ctx.neighbors(pin)) {
        if (nb.owner === strongest) {
          strongestIsNeighbor = true;
          break outer;
        }
      }
    }
  }

  const w: Weights = {
    attack_willingness: 0.5,
    continent_weight: 1.0,
    vuln_bonus: 200,
    free_claim_bonus: 150,
    crossing_penalty: 1.0,
    peace_preference: 1.0,
    gather_preference: 1.0,
    gather_threshold: 3,
  };

  const canAttack = myPins.some(
    (p) => (p.troops || 0) >= 3 && p.adj.some((a) => {
      const nb = ctx.byId.get(a.to);
      return nb && nb.owner !== me;
    }),
  );

  if (stalemate) {
    w.peace_preference = 0.01;
    w.crossing_penalty = 0.3;
    w.continent_weight = 2.5;
    if (canAttack) {
      w.attack_willingness = preset.stalemate_aggression ?? 2.5;
      w.gather_preference = 0.3;
      w._stalemate_target = weakestBorder(ctx);
    } else {
      w.attack_willingness = 0.1;
      w.gather_preference = 5.0;
      w.gather_threshold = 8;
    }
  }

  if (territoryCount <= 2 || (freeAdjacent > 0 && territoryCount < totalPins * 0.15)) {
    w.free_claim_bonus = 250;
    w.peace_preference = 0.3;
    w.crossing_penalty = 0.6;
    w.gather_preference = 0.5;
  }

  if (vulnAdjacent > 0) {
    w.vuln_bonus = 400;
    w.attack_willingness = Math.max(w.attack_willingness, 0.8);
    w.peace_preference *= 0.5;
  }

  if (nearContinent) {
    w.continent_weight = 2.5;
    w.attack_willingness = Math.max(w.attack_willingness, 0.7);
    w.crossing_penalty = Math.min(w.crossing_penalty, 0.5);
  } else if (buildingForContinent) {
    w.gather_preference = Math.max(w.gather_preference, 1.8);
    w.continent_weight = 1.8;
  }

  if (imWeak && strongestIsNeighbor) {
    w.attack_willingness = Math.min(w.attack_willingness, 0.2);
    w.gather_preference = Math.max(w.gather_preference, 2.0);
    w.vuln_bonus = Math.min(w.vuln_bonus, 150);
  } else if (imWeak) {
    w.attack_willingness = Math.min(w.attack_willingness, 0.35);
  }

  if (threatRatio > 1.5) {
    w.peace_preference *= 0.3;
    w.gather_preference = 2.0;
    w.gather_threshold = 6;
    w.attack_willingness = Math.min(w.attack_willingness, 0.3);
  } else if (threatRatio > 0.8) {
    w.peace_preference *= 0.6;
    w.gather_preference = 1.4;
    w.gather_threshold = 4;
  }

  if (!stalemate && territoryCount >= 5 && freeAdjacent === 0 && vulnAdjacent === 0) {
    w.peace_preference = Math.max(w.peace_preference, 1.5);
    if (myMoney > 1000) w.peace_preference = Math.max(w.peace_preference, 1.8);
  }

  if (myMoney > 800 && maxBorderTroops > 4) {
    w.attack_willingness = Math.max(w.attack_willingness, 0.8);
    w.crossing_penalty = Math.min(w.crossing_penalty, 0.7);
  }

  if (!stalemate && maxBorderTroops < 2 && territoryCount > 0) {
    w.gather_preference = Math.max(w.gather_preference, 1.5);
    w.attack_willingness = Math.min(w.attack_willingness, 0.3);
  }

  w.attack_willingness *= preset.attack_willingness_mult;
  w.peace_preference *= preset.peace_preference_mult;
  w.gather_preference *= preset.gather_preference_mult;
  w.continent_weight *= preset.continent_weight_mult;
  return w;
}

function peaceValue(ctx: Ctx): number {
  const mine = ctx.pinsOf(ctx.me);
  if (!mine.length) return 0;
  const base = 100 * mine.length;
  let threat = 0;
  for (const pin of mine) {
    for (const [nb] of ctx.neighbors(pin)) if (nb.owner && nb.owner !== ctx.me) threat += nb.troops || 0;
  }
  const myTotal = ctx.totalTroops(ctx.me);
  if (myTotal > 0 && threat > myTotal * 2) return base * 0.15;
  if (threat > myTotal) return base * 0.4;
  if (threat > myTotal * 0.5) return base * 0.7;
  return base * 0.9;
}

type Candidate = [number, number, number, number]; // score, src, tgt, send

function scoreCandidates(ctx: Ctx, myPins: BotPin[], myMoney: number, vulnerable: Set<string>, w: Weights): Candidate[] {
  const out: Candidate[] = [];
  const contState = ctx.continentState();
  const me = ctx.me;
  for (const src of myPins) {
    const srcTroops = src.troops || 0;
    if (srcTroops < 3) continue;
    for (const [nb, crossing] of ctx.neighbors(src)) {
      if (nb.owner === me) continue;
      const totalCost = crossing + CLAIM_COST;
      if (myMoney < totalCost) continue;
      const tgtOwner = nb.owner;
      const tgtTroops = nb.troops || 0;
      const tgtCont = nb.continent || '';
      const isFree = !tgtOwner;
      const isVuln = !!tgtOwner && vulnerable.has(tgtOwner);
      const maxSend = srcTroops - 1;

      let send: number;
      if (isFree) send = Math.min(maxSend, Math.max(1, Math.floor(srcTroops / 4)));
      else if (isVuln) send = Math.min(maxSend, Math.max(2, Math.floor(srcTroops / 2)));
      else {
        const adv = srcTroops / Math.max(1, tgtTroops + 1);
        if (adv >= 5) send = Math.min(maxSend, Math.max(3, Math.trunc(srcTroops * 0.7)));
        else if (adv >= 3) send = Math.min(maxSend, Math.max(3, Math.trunc(srcTroops * 0.5)));
        else if (adv >= 2) send = Math.min(maxSend, Math.max(3, tgtTroops + 2));
        else send = Math.min(maxSend, Math.max(2, tgtTroops + 1));
        if (send < 2) continue;
      }

      if (!isFree && !isVuln && !postAttackSafe(ctx, src, send)) continue;

      let score = 0;
      const will = w.attack_willingness;
      if (isFree) score += 200 + w.free_claim_bonus;
      else if (isVuln) {
        score += 300 + w.vuln_bonus;
        score += Math.max(0, 100 - tgtTroops * 20);
      } else {
        const advRatio = srcTroops / Math.max(1, tgtTroops);
        const troopValue = send * TROOP_COST;
        const evWin = 100 * 3 + 50;
        const evAttack = P_WIN * evWin - (1 - P_WIN) * (troopValue + totalCost * 0.5);
        score += evAttack * will;
        if (tgtTroops <= 1) score += 200 * will;
        else if (tgtTroops <= 3) score += 120 * will;
        else if (tgtTroops <= 5) score += 50 * will;
        if (advRatio >= 5) score += 150 * will;
        else if (advRatio >= 3) score += 80 * will;
        else if (advRatio >= 2) score += 30 * will;
        if (will > 1.0) score += 120 * (will - 1.0);
      }

      const ci = tgtCont ? contState.get(tgtCont) : undefined;
      if (ci && ci.total > 0) {
        const remaining = ci.total - ci.mine;
        if (remaining <= 1) {
          const bonus = continentValue(tgtCont) * w.continent_weight;
          score += isFree || isVuln ? bonus : bonus * 0.5;
          score = Math.max(score, bonus * 0.4);
        } else if (remaining <= 3 && ci.mine > 0) {
          const progress = ci.mine / ci.total;
          const factor = tgtCont === targetContinents.get(me) ? 0.5 : 0.3;
          score += continentValue(tgtCont) * progress * factor * w.continent_weight;
        }
      }

      if (!isFree && !isVuln) {
        const threatAtSrc = ctx.borderThreats().get(src.id) ?? 0;
        if (threatAtSrc > tgtTroops) score += threatAtSrc * 2;
      }

      if (!isFree && !isVuln && score < 0) continue;
      score -= crossing * w.crossing_penalty;

      if (w._stalemate_target && src.id === w._stalemate_target) score += 100;

      let friendly = 0;
      let enemy = 0;
      for (const [nb2] of ctx.neighbors(nb)) {
        if (nb2.owner === me) friendly++;
        else if (nb2.owner && nb2.owner !== me) enemy++;
      }
      score += friendly * 15 - enemy * 5;
      out.push([score, src.id, nb.id, send]);
    }
  }
  out.sort((a, b) => b[0] - a[0]);
  return out;
}

function baseDecide(ctx: Ctx, myPins: BotPin[], myMoney: number, w: Weights): BotAction {
  const me = ctx.me;
  const vulnerable = ctx.vulnerable();
  const cands = scoreCandidates(ctx, myPins, myMoney, vulnerable, w);
  const best = cands[0];
  const bestScore = best ? best[0] : -9999;
  const pv = peaceValue(ctx) * w.peace_preference;
  const territoryCount = myPins.length;

  let maxBorderTroops = 0;
  for (const pin of myPins) {
    for (const a of pin.adj) {
      const nb = ctx.byId.get(a.to);
      if (nb && nb.owner && nb.owner !== me) {
        maxBorderTroops = Math.max(maxBorderTroops, pin.troops || 0);
        break;
      }
    }
  }

  let gatherValue = 0;
  const threshold = w.gather_threshold;
  if (myMoney >= TROOP_COST * 3 && territoryCount > 0) {
    if (maxBorderTroops < threshold) gatherValue = 150 * w.gather_preference;
    else if (maxBorderTroops < 6) gatherValue = 80 * w.gather_preference;
    else gatherValue = 30;
  }

  const target = targetContinents.get(me);
  const cs = ctx.continentState();
  if (target && cs.has(target)) {
    const ci = cs.get(target)!;
    const rem = ci.total - ci.mine;
    if (rem > 0 && rem <= 3) gatherValue = Math.max(gatherValue, 120 * w.gather_preference);
  }

  const expand = (): BotAction => ['EXPAND', [best[1], best[2], best[3]]];
  if (best && bestScore > 150) return expand();
  if (pv > bestScore && pv > gatherValue) return ['PEACE', null];
  if (best && bestScore > gatherValue && bestScore > 0) return expand();
  if (gatherValue > 0 && myMoney >= TROOP_COST * 2) return ['GATHER', null];
  if (best && w.peace_preference < 0.3 && bestScore > -200) return expand();
  if (pv > 0) return ['PEACE', null];
  return ['NOTHING', null];
}

export function decide(gs: BotGameState, playerName: string, difficulty: string = 'normal'): BotAction {
  try {
    const me = gs.players.find((p) => p.name === playerName);
    if (!me) return ['PEACE', null];
    const ctx = new Ctx(gs, playerName);
    const myMoney = me.money || 0;
    const myPins = ctx.pinsOf(playerName);
    if (!myPins.length) return myMoney >= TROOP_COST ? ['GATHER', null] : ['NOTHING', null];
    const diff = (['easy', 'normal', 'hard'].includes(difficulty) ? difficulty : 'normal') as Difficulty;
    const w = computeWeights(ctx, myPins, myMoney, diff);
    return baseDecide(ctx, myPins, myMoney, w);
  } catch (e) {
    console.error('bot decision error', e);
    return ['PEACE', null];
  }
}
