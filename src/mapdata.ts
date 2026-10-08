// Port of geometry.py lookups. Polygon/adjacency data is pre-generated from the
// Python game's own geometry code by scripts/build_map_data.py, so country IDs
// match the desktop client exactly (required for online cross-play).

import { SCOPE_CONTINENTS, type MapScope } from './constants';

export interface Adj {
  to: number;
  cost: number;
}

export interface MapCountry {
  id: number;
  name: string;
  iso: string;
  continent: string;
  centroid: [number, number];
  bbox: [number, number, number, number];
  adj: Adj[];
  rings: Float32Array[];
  ringBoxes: [number, number, number, number][];
  path: Path2D;
}

interface RawCountry {
  id: number;
  n: string;
  iso: string;
  c: string;
  ce: [number, number];
  b: [number, number, number, number];
  a: [number, number][];
  p: number[][];
}

export const countries = new Map<number, MapCountry>();
export let countryList: MapCountry[] = [];

export async function loadMap(): Promise<void> {
  if (countryList.length) return;
  const res = await fetch('/data/countries.json');
  if (!res.ok) throw new Error('Could not load map data');
  const raw = (await res.json()) as { countries: RawCountry[] };
  for (const rc of raw.countries) {
    const path = new Path2D();
    const rings: Float32Array[] = [];
    const ringBoxes: [number, number, number, number][] = [];
    for (const flat of rc.p) {
      const ring = new Float32Array(flat);
      rings.push(ring);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < ring.length; i += 2) {
        const x = ring[i], y = ring[i + 1];
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      path.closePath();
      ringBoxes.push([x0, y0, x1, y1]);
    }
    const c: MapCountry = {
      id: rc.id,
      name: rc.n,
      iso: rc.iso,
      continent: rc.c,
      centroid: rc.ce,
      bbox: rc.b,
      adj: rc.a.map(([to, cost]) => ({ to, cost })),
      rings,
      ringBoxes,
      path,
    };
    countries.set(c.id, c);
  }
  countryList = [...countries.values()];
}

function pointInRing(x: number, y: number, ring: Float32Array): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], yi = ring[i * 2 + 1];
    const xj = ring[j * 2], yj = ring[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

export function countryAtWorldPoint(wx: number, wy: number, allowed?: Set<number> | null): MapCountry | null {
  for (const c of countryList) {
    if (allowed && !allowed.has(c.id)) continue;
    const b = c.bbox;
    if (wx < b[0] || wx > b[2] || wy < b[1] || wy > b[3]) continue;
    for (let r = 0; r < c.rings.length; r++) {
      const rb = c.ringBoxes[r];
      if (wx < rb[0] || wx > rb[2] || wy < rb[1] || wy > rb[3]) continue;
      if (pointInRing(wx, wy, c.rings[r])) return c;
    }
  }
  return null;
}

export function findCountryByName(name: string, allowed?: Set<number> | null): MapCountry | null {
  const q = (name || '').trim().toLocaleLowerCase();
  if (!q) return null;
  for (const c of countryList) {
    if (allowed && !allowed.has(c.id)) continue;
    if (c.name.trim().toLocaleLowerCase() === q) return c;
  }
  return null;
}

/** IDs of countries that are playable for a given map scope. */
export function scopeCountryIds(scope: MapScope): Set<number> {
  const conts = SCOPE_CONTINENTS[scope] ?? null;
  return new Set(countryList.filter((c) => !conts || conts.includes(c.continent)).map((c) => c.id));
}

/** Adjacency restricted to a set of playable countries. */
export function adjOf(id: number, allowed?: Set<number> | null): Adj[] {
  const c = countries.get(id);
  if (!c) return [];
  return allowed ? c.adj.filter((a) => allowed.has(a.to)) : c.adj;
}
