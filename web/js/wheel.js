// A szerencsekerék rajzolása és pörgetése `<canvas>`-on.
//
// A cikk kiválasztása előre megtörténik (`solveSpin`), az animáció csak
// megjeleníti – így az eredmény determinisztikus, és nem a képkockasebességtől
// vagy a böngésző teljesítményétől függ.

import { solveSpin, wedgeAngle } from './rules.js';

/** requestAnimationFrame-alapú easing: erős lassulás a végén. */
function easeOutQuint(t) {
  return 1 - Math.pow(1 - t, 5);
}

export class Wheel {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.categories = [];
    this.rotation = 0;
    this.highlightIndex = null;
    this.isSpinning = false;
    this.animationHandle = null;

    this.resize();
    this.#observeResize();
  }

  #observeResize() {
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', () => this.resize());
      return;
    }
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.canvas);
  }

  resize() {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const size = Math.max(1, Math.floor(Math.min(rect.width, rect.height)));
    this.canvas.width = size * ratio;
    this.canvas.height = size * ratio;
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.size = size;
    this.draw();
  }

  setCategories(categories) {
    this.categories = categories ?? [];
    this.highlightIndex = null;
    this.draw();
  }

  // ─────────────────────────── rajzolás ───────────────────────────

  draw() {
    const { ctx } = this;
    const size = this.size ?? 0;
    if (!ctx || size <= 0) return;

    ctx.clearRect(0, 0, size, size);

    const center = size / 2;
    // A peremszélesség nem lehet nagyobb, mint a fél átmérő harmada – kis
    // canvas-nál (pl. layout közbeni átmeneti 0-8 px) különben negatív rádiusz
    // jönne ki, és a `ctx.arc()` IndexSizeError-t dob.
    const rimWidth = Math.min(Math.max(2, size * 0.035), center / 3);
    const radius = center - rimWidth - size * 0.04;
    const count = this.categories.length;

    // Túl kicsi canvas: nincs mit rajzolni, és a negatív rádiusz hibát okozna.
    if (radius <= 1) return;

    if (count === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.arc(center, center, radius, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    const wedge = (Math.PI * 2) / count;
    const rotationRad = (this.rotation * Math.PI) / 180;

    // ── cikkek ──
    for (let index = 0; index < count; index++) {
      const category = this.categories[index];
      // A 0. cikk a 12 óránál kezdődik → -90° eltolás
      const start = rotationRad + wedge * index - Math.PI / 2;
      const end = start + wedge;

      ctx.beginPath();
      ctx.moveTo(center, center);
      ctx.arc(center, center, radius, start, end);
      ctx.closePath();

      const mid = (start + end) / 2;
      const gradient = ctx.createLinearGradient(
        center,
        center,
        center + Math.cos(mid) * radius,
        center + Math.sin(mid) * radius
      );
      const base = category.color || '#7C5CFF';
      const isHighlighted = this.highlightIndex === index && !this.isSpinning;
      gradient.addColorStop(0, base);
      gradient.addColorStop(1, shade(base, isHighlighted ? -0.15 : -0.4));
      ctx.fillStyle = gradient;
      ctx.fill();

      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();

      if (isHighlighted) {
        ctx.strokeStyle = '#F5D07A';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }

    // ── feliratok (pörgés közben olvashatatlan lenne, ezért kihagyjuk) ──
    if (!this.isSpinning && count <= 24) {
      const fontSize = count > 16 ? Math.max(8, size * 0.026) : Math.max(9, size * 0.032);
      ctx.font = `700 ${fontSize}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 3;

      for (let index = 0; index < count; index++) {
        const mid = rotationRad + wedge * (index + 0.5) - Math.PI / 2;
        ctx.save();
        ctx.translate(center, center);
        ctx.rotate(mid);
        // A szöveg a kerék pereme felé fut, a külső élnél végződik.
        ctx.fillText(shortName(this.categories[index].name), radius - size * 0.045, 0);
        ctx.restore();
      }
      ctx.shadowBlur = 0;
    }

    // ── perem ──
    const rimGradient = ctx.createLinearGradient(0, 0, size, size);
    rimGradient.addColorStop(0, '#F5D07A');
    rimGradient.addColorStop(1, '#B8862C');
    ctx.strokeStyle = rimGradient;
    ctx.lineWidth = rimWidth;
    ctx.beginPath();
    ctx.arc(center, center, radius + rimWidth / 2, 0, Math.PI * 2);
    ctx.stroke();

    // ── tengely ──
    const hubRadius = size * 0.085;
    const hubGradient = ctx.createRadialGradient(center, center, 0, center, center, hubRadius);
    hubGradient.addColorStop(0, '#ffffff');
    hubGradient.addColorStop(1, '#E6E0F5');
    ctx.fillStyle = hubGradient;
    ctx.beginPath();
    ctx.arc(center, center, hubRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#B8862C';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.fillStyle = '#5B3FD1';
    ctx.font = `900 ${hubRadius * 1.1}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', center, center + hubRadius * 0.06);

    // ── mutató (12 óránál, nem forog) ──
    const pointerHeight = size * 0.075;
    const pointerWidth = size * 0.05;
    ctx.beginPath();
    ctx.moveTo(center, center - radius + pointerHeight * 0.55);
    ctx.lineTo(center - pointerWidth, center - radius - pointerHeight * 0.45);
    ctx.lineTo(center + pointerWidth, center - radius - pointerHeight * 0.45);
    ctx.closePath();
    ctx.fillStyle = '#FFD76A';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // ─────────────────────────── pörgetés ───────────────────────────

  /**
   * @param {{targetIndex:number, turns?:number, duration?:number, jitter?:number,
   *          onTick?:(intensity:number)=>void}} options
   * @returns {Promise<number>} a megállított cikk indexe
   */
  spinTo({ targetIndex, turns = 5, duration = 3.4, jitter = 0, onTick }) {
    const count = this.categories.length;
    if (count === 0) return Promise.resolve(0);

    const solution = solveSpin({
      targetIndex,
      count,
      currentRotation: this.rotation,
      jitter,
      turns,
      duration
    });

    const startRotation = this.rotation;
    const totalDelta = solution.finalRotation - startRotation;
    const wedgeDeg = wedgeAngle(count);

    this.isSpinning = true;
    this.highlightIndex = null;
    cancelAnimationFrame(this.animationHandle);

    return new Promise((resolve) => {
      const startTime = performance.now();
      let lastWedge = -1;
      let settled = false;

      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(safetyTimer);
        cancelAnimationFrame(this.animationHandle);
        this.rotation = solution.finalRotation;
        this.isSpinning = false;
        this.highlightIndex = solution.targetIndex;
        this.draw();
        resolve(solution.targetIndex);
      };

      // Biztonsági háló: rejtett fülön (vagy energiatakarékos módban) a
      // requestAnimationFrame nem fut, ezért az animáció – és vele a kör –
      // beragadhatna. Ilyenkor egy timer viszi végig.
      const safetyTimer = setTimeout(settle, solution.duration * 1000 + 1200);

      const step = (now) => {
        if (settled) return;
        const elapsed = (now - startTime) / 1000;
        const progress = Math.min(1, elapsed / solution.duration);
        this.rotation = startRotation + totalDelta * easeOutQuint(progress);
        this.draw();

        // „Kattogás”: minden cikkátlépésnél egy rövid impulzus, a végén ritkul.
        if (onTick) {
          const currentWedge = Math.floor(this.rotation / wedgeDeg);
          if (currentWedge !== lastWedge) {
            lastWedge = currentWedge;
            onTick(1 - progress * 0.7);
          }
        }

        if (progress < 1) {
          this.animationHandle = requestAnimationFrame(step);
          return;
        }
        settle();
      };

      this.animationHandle = requestAnimationFrame(step);
    });
  }

  /** Lassú, folyamatos forgás a főoldali dekoratív kerékhez. */
  startIdleSpin(degreesPerSecond = 6) {
    cancelAnimationFrame(this.animationHandle);
    let last = performance.now();
    const step = (now) => {
      const delta = (now - last) / 1000;
      last = now;
      this.rotation += degreesPerSecond * delta;
      this.draw();
      this.animationHandle = requestAnimationFrame(step);
    };
    this.animationHandle = requestAnimationFrame(step);
  }

  stop() {
    cancelAnimationFrame(this.animationHandle);
    this.animationHandle = null;
  }
}

// ─────────────────────────── segédek ───────────────────────────

/** Hex szín világosítása/sötétítése. `amount`: -1…1 */
function shade(hex, amount) {
  const value = String(hex).replace('#', '');
  if (value.length !== 6) return hex;
  const num = parseInt(value, 16);
  const clamp = (channel) => Math.max(0, Math.min(255, Math.round(channel)));
  const r = clamp(((num >> 16) & 0xff) * (1 + amount));
  const g = clamp(((num >> 8) & 0xff) * (1 + amount));
  const b = clamp((num & 0xff) * (1 + amount));
  return `rgb(${r}, ${g}, ${b})`;
}

/** A hosszú kategórianevek rövidítése, hogy elférjenek a cikken. */
const SHORT_NAMES = {
  'Magyar történelem': 'M. történelem',
  'Magyar irodalom': 'M. irodalom',
  'Magyar földrajz': 'M. földrajz',
  'Magyar kultúra': 'M. kultúra',
  'Magyar közélet': 'M. közélet',
  'Magyar sport': 'M. sport',
  'Magyar zene és film': 'M. zene/film',
  'Magyar nyelv': 'M. nyelv',
  'Filmek és sorozatok': 'Film',
  'Logika és fejtörők': 'Logika',
  Világtörténelem: 'Világtört.',
  'Étel és ital': 'Étel/ital'
};

function shortName(name) {
  return SHORT_NAMES[name] ?? name;
}
