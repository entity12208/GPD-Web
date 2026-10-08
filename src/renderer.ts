import {
  COUNTRY_BORDER_COLOR,
  MAP_H,
  SEA_COLOR,
  WIDTH,
  darken,
  type GameMode,
} from './constants';
import { countryAtWorldPoint, countryList, type MapCountry } from './mapdata';
import type { MoveAnim, Session } from './session';
import type { Snapshot } from './game';

function safeColor(value: string): string {
  return /^#[\da-f]{3}(?:[\da-f]{3}|[\da-f]{5})?$/i.test(value) ? value : '#718096';
}

export interface RendererOptions {
  onCountryClick(country: MapCountry): void;
  getSelected(): number | null;
  getExpandSource(): number | null;
  onHover?(country: MapCountry | null, x: number, y: number): void;
  edgeScroll?(): boolean;
}

export class MapRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly session: Session;
  private readonly options: RendererOptions;
  private resizeObserver: ResizeObserver;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private drag: { pointerId: number; x: number; y: number; moved: boolean; pans: boolean } | null = null;
  private hovered: MapCountry | null = null;
  private moveEffect: { move: MoveAnim; startedAt: number } | null = null;

  constructor(canvas: HTMLCanvasElement, session: Session, options: RendererOptions) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas rendering is not available in this browser.');
    this.canvas = canvas;
    this.ctx = ctx;
    this.session = session;
    this.options = options;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    canvas.addEventListener('pointerdown', this.pointerDown);
    canvas.addEventListener('pointermove', this.pointerMove);
    canvas.addEventListener('pointerup', this.pointerUp);
    canvas.addEventListener('pointercancel', this.pointerCancel);
    canvas.addEventListener('pointerleave', this.pointerLeave);
    canvas.addEventListener('wheel', this.wheel, { passive: false });
    canvas.addEventListener('contextmenu', this.preventContextMenu);
    this.resize();
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.pointerDown);
    this.canvas.removeEventListener('pointermove', this.pointerMove);
    this.canvas.removeEventListener('pointerup', this.pointerUp);
    this.canvas.removeEventListener('pointercancel', this.pointerCancel);
    this.canvas.removeEventListener('pointerleave', this.pointerLeave);
    this.canvas.removeEventListener('wheel', this.wheel);
    this.canvas.removeEventListener('contextmenu', this.preventContextMenu);
  }

  resetCamera(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
  }

  panBy(dx: number, dy: number): void {
    this.panX += dx;
    this.panY += dy;
  }

  showMove(move: MoveAnim): void {
    this.moveEffect = { move, startedAt: performance.now() };
  }

  draw(snapshot: Snapshot, mode: GameMode, allowed: Set<number>): void {
    const { ctx, width, height, dpr } = this;
    if (!width || !height) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = SEA_COLOR;
    ctx.fillRect(0, 0, width, height);

    const fit = Math.min(width / WIDTH, height / MAP_H);
    const scale = fit * this.zoom;
    const left = (width - WIDTH * scale) / 2 + this.panX;
    const top = (height - MAP_H * scale) / 2 + this.panY;
    ctx.save();
    ctx.translate(left, top);
    ctx.scale(scale, scale);

    const ownedByMe = new Set<number>();
    for (const [id, country] of snapshot.countries) {
      if (country.owner === this.session.myName) ownedByMe.add(id);
    }
    const visible = new Set<number>();
    if (mode === 'tournament') {
      for (const id of ownedByMe) {
        visible.add(id);
        const c = countryList.find((item) => item.id === id);
        for (const adj of c?.adj ?? []) visible.add(adj.to);
      }
    }

    const fillByName = new Map(snapshot.players.map((p) => [p.name, safeColor(p.color)]));
    const selected = this.options.getSelected();
    const source = this.options.getExpandSource();
    const targets = new Set<number>();
    if (source !== null) {
      for (const adj of countryList.find((c) => c.id === source)?.adj ?? []) {
        if (allowed.has(adj.to)) targets.add(adj.to);
      }
    }

    for (const country of countryList) {
      if (!allowed.has(country.id)) continue;
      const state = snapshot.countries.get(country.id);
      const obscured = mode === 'tournament' && this.session.kind !== 'spectate'
        && !visible.has(country.id);
      const blind = mode === 'challenge' && this.session.kind !== 'spectate';
      let color = SEA_COLOR;
      if (obscured) color = '#1a2942';
      else if (blind || !state?.owner) color = '#374b67';
      else color = fillByName.get(state.owner) ?? '#65758b';
      ctx.fillStyle = color;
      ctx.strokeStyle = COUNTRY_BORDER_COLOR;
      ctx.lineWidth = Math.max(0.65, 1.15 / scale);
      ctx.fill(country.path, 'evenodd');
      ctx.stroke(country.path);

      if (!obscured && !blind && state?.owner) {
        const [cx, cy] = country.centroid;
        const radius = 8.5 / scale;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fillStyle = darken(color, 28);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.7)';
        ctx.lineWidth = Math.max(0.5, 0.8 / scale);
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = `700 ${Math.max(8, 10 / scale)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(state.troops), cx, cy + 0.4 / scale);
      }
      if (country.id === selected || targets.has(country.id)) {
        ctx.strokeStyle = country.id === selected ? '#ffe07a' : 'rgba(255,220,115,.8)';
        ctx.lineWidth = (country.id === selected ? 3 : 1.8) / scale;
        ctx.stroke(country.path);
      }
    }

    if (this.moveEffect) {
      const elapsed = (performance.now() - this.moveEffect.startedAt) / 620;
      if (elapsed >= 1) {
        this.moveEffect = null;
      } else {
        const { move } = this.moveEffect;
        const from = countryList.find((country) => country.id === move.src)?.centroid;
        const to = countryList.find((country) => country.id === move.tgt)?.centroid;
        if (from && to) {
          const progress = Math.max(0, elapsed);
          const controlX = (from[0] + to[0]) / 2;
          const controlY = (from[1] + to[1]) / 2 - 40;
          const inv = 1 - progress;
          const x = inv * inv * from[0] + 2 * inv * progress * controlX + progress * progress * to[0];
          const y = inv * inv * from[1] + 2 * inv * progress * controlY + progress * progress * to[1];
          const color = safeColor(move.color);
          ctx.beginPath();
          ctx.moveTo(from[0], from[1]);
          ctx.quadraticCurveTo(controlX, controlY, to[0], to[1]);
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.38 * (1 - progress);
          ctx.lineWidth = 3 / scale;
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.arc(x, y, 5 / scale, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.shadowColor = color;
          ctx.shadowBlur = 12 / scale;
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.fillStyle = '#fff';
          ctx.font = `700 ${Math.max(8, 10 / scale)}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(move.count), x, y);
        }
      }
    }

    if (snapshot.winner) {
      ctx.fillStyle = 'rgba(255,220,115,.18)';
      for (const [id, state] of snapshot.countries) {
        if (state.owner === snapshot.winner) {
          const country = countryList.find((c) => c.id === id);
          if (country) ctx.fill(country.path, 'evenodd');
        }
      }
    }
    ctx.restore();
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(this.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(this.height * this.dpr));
  }

  private transformPoint(clientX: number, clientY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const fit = Math.min(rect.width / WIDTH, rect.height / MAP_H);
    const scale = fit * this.zoom;
    const left = (rect.width - WIDTH * scale) / 2 + this.panX;
    const top = (rect.height - MAP_H * scale) / 2 + this.panY;
    return [(clientX - rect.left - left) / scale, (clientY - rect.top - top) / scale];
  }

  private pointerDown = (event: PointerEvent): void => {
    const touch = event.pointerType === 'touch';
    if (event.button !== 0 && event.button !== 2) return;
    this.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, pans: event.button === 2 || touch };
    this.canvas.setPointerCapture(event.pointerId);
  };

  private pointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (drag?.pointerId === event.pointerId) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved && drag.pans) {
        this.panX += dx;
        this.panY += dy;
        drag.x = event.clientX;
        drag.y = event.clientY;
      }
      return;
    }
    if (this.options.edgeScroll?.()) {
      const rect = this.canvas.getBoundingClientRect();
      const margin = 24;
      if (event.clientX < rect.left + margin) this.panX += 7;
      else if (event.clientX > rect.right - margin) this.panX -= 7;
      if (event.clientY < rect.top + margin) this.panY += 7;
      else if (event.clientY > rect.bottom - margin) this.panY -= 7;
    }
    const [wx, wy] = this.transformPoint(event.clientX, event.clientY);
    this.hovered = countryAtWorldPoint(wx, wy, this.session.allowed);
    this.canvas.style.cursor = this.hovered ? 'pointer' : 'grab';
    this.options.onHover?.(this.hovered, event.clientX, event.clientY);
  };

  private pointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.drag = null;
    if (drag.pans && drag.moved) return;
    if (event.button !== 0 && event.pointerType !== 'touch') return;
    const [wx, wy] = this.transformPoint(event.clientX, event.clientY);
    const country = countryAtWorldPoint(wx, wy, this.session.allowed);
    if (country) this.options.onCountryClick(country);
  };

  private pointerCancel = (): void => {
    this.drag = null;
  };

  private pointerLeave = (): void => {
    this.hovered = null;
    this.canvas.style.cursor = 'grab';
    this.options.onHover?.(null, 0, 0);
  };

  private preventContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private wheel = (event: WheelEvent): void => {
    event.preventDefault();
    const oldZoom = this.zoom;
    this.zoom = Math.max(0.65, Math.min(5, this.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const fit = Math.min(rect.width / WIDTH, rect.height / MAP_H);
    const oldScale = fit * oldZoom;
    const newScale = fit * this.zoom;
    const centerX = (rect.width - WIDTH * oldScale) / 2 + this.panX;
    const centerY = (rect.height - MAP_H * oldScale) / 2 + this.panY;
    const worldX = (x - centerX) / oldScale;
    const worldY = (y - centerY) / oldScale;
    this.panX += (x - ((rect.width - WIDTH * newScale) / 2 + this.panX + worldX * newScale));
    this.panY += (y - ((rect.height - MAP_H * newScale) / 2 + this.panY + worldY * newScale));
  };
}
