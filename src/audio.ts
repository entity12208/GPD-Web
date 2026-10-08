// Port of audio_manager.py — procedurally generated SFX via Web Audio.

import { settings } from './settings';

export type Sfx = 'click' | 'attack' | 'capture' | 'turn' | 'victory' | 'defeat' | 'chat' | 'error';

let ctx: AudioContext | null = null;
function ac(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freqStart: number, freqEnd: number, dur: number, at = 0, type: OscillatorType = 'sine', gain = 0.5): void {
  const a = ac();
  if (!a) return;
  const vol = settings.sfx_volume * gain;
  if (vol <= 0) return;
  const t0 = a.currentTime + at;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freqStart, t0);
  osc.frequency.linearRampToValueAtTime(freqEnd, t0 + dur);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(dur: number, gain = 0.4): void {
  const a = ac();
  if (!a) return;
  const vol = settings.sfx_volume * gain;
  if (vol <= 0) return;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
  const src = a.createBufferSource();
  const g = a.createGain();
  g.gain.value = vol;
  src.buffer = buf;
  src.connect(g).connect(a.destination);
  src.start();
}

export function playSfx(name: Sfx): void {
  switch (name) {
    case 'click': tone(1200, 1200, 0.05, 0, 'sine', 0.25); break;
    case 'attack': noise(0.25, 0.35); tone(220, 90, 0.25, 0, 'sawtooth', 0.2); break;
    case 'capture': tone(600, 1000, 0.3, 0, 'sine', 0.4); break;
    case 'turn': tone(1000, 1000, 0.35, 0, 'sine', 0.25); tone(1500, 1500, 0.35, 0, 'sine', 0.2); break;
    case 'victory': tone(523, 523, 0.15, 0, 'triangle'); tone(659, 659, 0.15, 0.15, 'triangle'); tone(784, 784, 0.4, 0.3, 'triangle'); break;
    case 'defeat': tone(800, 300, 0.6, 0, 'triangle', 0.45); break;
    case 'chat': tone(800, 800, 0.08, 0, 'sine', 0.3); break;
    case 'error': tone(320, 260, 0.25, 0, 'square', 0.15); break;
  }
}
