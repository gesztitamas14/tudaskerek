#!/usr/bin/env node
// Ikongenerátor – függőségmentes PNG írás (Node beépített zlib).
//
// Egy stilizált kvízkereket rajzol: színes cikkek, arany perem, mutató.
// Nem művészi alkotás, de rendes ikont ad a PWA-nak – a főképernyőre telepített
// webalkalmazás ezt kapja.
//
// Kimenetek (web/icons/):
//   icon-192.png, icon-512.png, icon-maskable-512.png,
//   apple-touch-icon.png (180×180), favicon-32.png
//
// A „maskable” változatnál a kerék kisebb: az Android bármilyen alakra
// levághatja az ikont, ezért a lényeg a középső 80%-os körben kell legyen.
//
// Használat: node tools/src/make-icon.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync } from 'node:zlib';

// A kerék cikkeinek színei (a DesignSystem palettájából)
const WEDGES = [
  [0xb2, 0x3a, 0x48], [0x8e, 0x55, 0x72], [0xc7, 0x7d, 0x3a], [0x3e, 0x7c, 0x59],
  [0x5a, 0x6b, 0x8c], [0x2e, 0x7d, 0x9a], [0x9b, 0x4d, 0xca], [0xa8, 0x70, 0x3a],
  [0x2f, 0x7f, 0x8c], [0x3c, 0x6e, 0xbf], [0x6b, 0x8e, 0x23], [0xd9, 0x77, 0x06]
];

const BG_TOP = [0x14, 0x10, 0x2a];
const BG_BOTTOM = [0x27, 0x16, 0x4b];

function mix(c1, c2, t) {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t)
  ];
}

/**
 * @param {number} size - képpont
 * @param {number} scale - a kerék átmérője a képméret arányában (0…1)
 */
function renderIcon(size, scale = 0.85) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b) => {
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  };

  const cx = size / 2;
  const cy = size / 2;
  const rRim = (size * scale) / 2;
  const rOuter = rRim * 0.94;
  const rHub = rRim * 0.21;
  const wedgeAngle = (2 * Math.PI) / WEDGES.length;
  const edgeWidth = Math.max(1.2, size * 0.003);

  // A mutató a kerék fölött, a peremhez illesztve
  const pointerTop = cy - rRim - size * 0.045;
  const pointerHeight = size * 0.085;
  const pointerHalfWidth = size * 0.045;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let [r, g, b] = mix(BG_TOP, BG_BOTTOM, y / (size - 1));

      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.hypot(dx, dy);

      if (dist <= rRim) {
        if (dist > rOuter) {
          // arany perem
          const t = (dist - rOuter) / (rRim - rOuter);
          [r, g, b] = mix([0xf5, 0xd0, 0x7a], [0xb8, 0x86, 0x2c], t);
        } else if (dist <= rHub) {
          // középső korong
          const t = dist / rHub;
          [r, g, b] = mix([0xff, 0xff, 0xff], [0xe6, 0xe0, 0xf5], t);
        } else {
          // cikkek
          const angle = Math.atan2(dy, dx) + Math.PI;   // 0…2pi
          const index = Math.floor((angle / (2 * Math.PI)) * WEDGES.length) % WEDGES.length;
          const base = WEDGES[index];
          // sugárirányú árnyalás, hogy legyen mélysége
          const shade = 0.82 + 0.18 * (1 - dist / rOuter);
          r = Math.round(base[0] * shade);
          g = Math.round(base[1] * shade);
          b = Math.round(base[2] * shade);

          // cikkek közti sötét vonal
          const local = angle % wedgeAngle;
          const edge = Math.min(local, wedgeAngle - local) * dist;
          if (edge < edgeWidth) {
            r = Math.round(r * 0.55); g = Math.round(g * 0.55); b = Math.round(b * 0.55);
          }
        }
      }

      // mutató (felül, lefelé néző háromszög)
      const py = y - pointerTop;
      if (py >= 0 && py <= pointerHeight) {
        const halfWidth = pointerHalfWidth * (1 - py / pointerHeight);
        if (Math.abs(dx) <= halfWidth) { r = 0xff; g = 0xd7; b = 0x6a; }
      }

      set(x, y, r, g, b);
    }
  }

  return encodePng(px, size);
}

// ─────────────────────────── PNG kódolás ───────────────────────────

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Minden sor elé filter-bájt (0 = None)
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ─────────────────────────── kimenetek ───────────────────────────

const TARGETS = [
  { path: 'web/icons/icon-192.png', size: 192, scale: 0.85 },
  { path: 'web/icons/icon-512.png', size: 512, scale: 0.85 },
  // Maskable: a lényeg a középső 80%-ban legyen, mert levágható a széle.
  { path: 'web/icons/icon-maskable-512.png', size: 512, scale: 0.66 },
  { path: 'web/icons/apple-touch-icon.png', size: 180, scale: 0.85 },
  { path: 'web/icons/favicon-32.png', size: 32, scale: 0.9 }
];

for (const target of TARGETS) {
  const png = renderIcon(target.size, target.scale);
  mkdirSync(dirname(target.path), { recursive: true });
  writeFileSync(target.path, png);
  console.log(`${target.path.padEnd(72)} ${target.size}×${target.size}  ${(png.length / 1024).toFixed(0)} kB`);
}

console.log('\n✓ Ikonok elkészültek.');
