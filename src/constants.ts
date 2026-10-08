// Port of constants.py — all tunable values live here.

export const WIDTH = 2560;
export const MAP_H = 1160;
export const TPS = 10;

export const CLAIM_COST = 200;
export const TROOP_COST = 50;
export const STARTING_MONEY = 500;
export const PEACE_PAYOUT_PER_COUNTRY = 100;

export const MIN_CAMERA_SCALE = 1.0;
export const MAX_CAMERA_SCALE = 4.0;
export const CAMERA_ZOOM_FACTOR = 1.18;
export const CAMERA_INERTIA_DECAY = 0.92;
export const CAMERA_WASD_SPEED = 800.0;
export const CAMERA_EDGE_SCROLL_MARGIN = 30;
export const CAMERA_EDGE_SCROLL_SPEED = 600.0;

export const TROOP_BONUS_MAX = 4;
export const TURN_FLASH_DURATION = 0.4;
export const VFX_CAPTURE_DURATION = 0.6;
export const VFX_FLOAT_TEXT_DURATION = 1.0;
export const TROOP_ANIM_DURATION = 0.6;
export const FLASH_MESSAGE_DEFAULT_SECS = 2.5;

export const HEX_PALETTE = ['#C85050', '#64C864', '#3C78C8', '#F5F5F5', '#D0C248', '#A050C8', '#50A0A0', '#C87A50'];
// COLOR_PALETTE from constants.py (local games)
export const PALETTE = ['#DC4646', '#3CBE6E', '#3778DC', '#E69632', '#D2C83C', '#9650C8'];

export const SEA_COLOR = '#1e3050';
export const SEA_COLOR_LIGHT = '#263a5f';
export const COUNTRY_BORDER_COLOR = '#141e32';
export const DEFAULT_COUNTRY_FILL: [number, number, number] = [55, 75, 105];
export const ACCENT_GOLD = '#ffc83c';
export const ACCENT_GREEN = '#50d282';
export const ACCENT_RED = '#e65050';

export const CONT_VALUES: Record<string, number> = {
  Europe: 1000,
  Asia: 1000,
  'North America': 800,
  Africa: 400,
  'South America': 350,
  'Central America': 200,
};
export const DEFAULT_CONT_VALUE = 150;
export function continentValue(name: string): number {
  return CONT_VALUES[name] ?? DEFAULT_CONT_VALUE;
}

export type Difficulty = 'easy' | 'normal' | 'hard';
export interface DifficultyPreset {
  attack_willingness_mult: number;
  peace_preference_mult: number;
  gather_preference_mult: number;
  continent_weight_mult: number;
  stalemate_aggression: number;
  description: string;
}
export const BOT_DIFFICULTY_PRESETS: Record<Difficulty, DifficultyPreset> = {
  easy: {
    attack_willingness_mult: 0.6, peace_preference_mult: 1.5, gather_preference_mult: 0.8,
    continent_weight_mult: 0.7, stalemate_aggression: 1.5,
    description: 'Bots prefer peace and are less aggressive',
  },
  normal: {
    attack_willingness_mult: 1.0, peace_preference_mult: 1.0, gather_preference_mult: 1.0,
    continent_weight_mult: 1.0, stalemate_aggression: 2.5,
    description: 'Balanced adaptive AI (default)',
  },
  hard: {
    attack_willingness_mult: 1.4, peace_preference_mult: 0.6, gather_preference_mult: 1.3,
    continent_weight_mult: 1.5, stalemate_aggression: 3.5,
    description: 'Bots are aggressive, strategic, and exploit weaknesses',
  },
};

export type GameMode = 'classic' | 'tournament' | 'challenge';
export interface GameModeInfo {
  label: string;
  description: string;
  fog_of_war: boolean;
  chat_enabled: boolean;
  logs_enabled: boolean;
  blind_mode: boolean;
  turn_timer: number;
}
export const GAME_MODES: Record<GameMode, GameModeInfo> = {
  classic: {
    label: 'Classic',
    description: 'Standard gameplay — full visibility, chat enabled, no time limit.',
    fog_of_war: false, chat_enabled: true, logs_enabled: true, blind_mode: false, turn_timer: 0,
  },
  tournament: {
    label: 'Tournament',
    description: 'Competitive mode — fog of war, no chat, no logs, 10-minute total timer.',
    fog_of_war: true, chat_enabled: false, logs_enabled: false, blind_mode: false, turn_timer: 600,
  },
  challenge: {
    label: 'Challenge',
    description: 'Blindfolded mode — cannot see claims or troop counts on any country.',
    fog_of_war: false, chat_enabled: true, logs_enabled: true, blind_mode: true, turn_timer: 0,
  },
};

export type MapScope = 'world' | 'europe' | 'asia' | 'africa' | 'north_america' | 'south_america';
export const MAP_SCOPES: Record<MapScope, string> = {
  world: 'Whole World',
  europe: 'Europe',
  asia: 'Asia',
  africa: 'Africa',
  north_america: 'North America',
  south_america: 'South America',
};
/** Continents included in each map scope. */
export const SCOPE_CONTINENTS: Record<MapScope, string[] | null> = {
  world: null,
  europe: ['Europe'],
  asia: ['Asia'],
  africa: ['Africa'],
  north_america: ['North America', 'Central America'],
  south_america: ['South America'],
};

export const VERSION = '3.0.0';

export function hexToRgb(hex: string): [number, number, number] {
  let s = (hex || '#888888').replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s.slice(0, 6), 16);
  if (Number.isNaN(n)) return [120, 120, 120];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}
export function lighten(hex: string, amt = 25): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + amt, g + amt, b + amt);
}
export function darken(hex: string, amt = 25): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r - amt, g - amt, b - amt);
}
/** Normalise any colour shape stored by the Python client (hex string or [r,g,b]). */
export function normColor(c: unknown): string {
  if (typeof c === 'string' && c.startsWith('#')) return c;
  if (Array.isArray(c) && c.length >= 3) return rgbToHex(Number(c[0]), Number(c[1]), Number(c[2]));
  return '#787878';
}
export function randInt(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
export function shortlog(msg: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}] ${msg}`;
}
