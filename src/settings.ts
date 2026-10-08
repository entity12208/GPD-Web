// Port of config.txt handling (load_config/save_config) — persisted in localStorage.

import type { Difficulty } from './constants';

export interface Settings {
  player_name: string;
  default_bot_count: number;
  bot_difficulty: Difficulty;
  render_fps: number;
  music_volume: number;
  sfx_volume: number;
  show_chat: boolean;
  show_logs: boolean;
  edge_scroll: boolean;
}

const KEY = 'gpd.config';
const DEFAULTS: Settings = {
  player_name: 'Player',
  default_bot_count: 3,
  bot_difficulty: 'normal',
  render_fps: 60,
  music_volume: 0.3,
  sfx_volume: 0.5,
  show_chat: true,
  show_logs: true,
  edge_scroll: false,
};

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings: Settings = load();

export function saveSettings(): void {
  localStorage.setItem(KEY, JSON.stringify(settings));
}
