#!/usr/bin/env node
// Apró statikus webszerver a PWA helyi futtatásához – nulla függőséggel.
//
// Miért kell? A böngésző `file://` protokollon nem engedi az ES modulok és a
// service worker betöltését, ezért a PWA-t HTTP-n kell kiszolgálni.
//
// Használat:
//   node tools/src/serve.mjs            # web/ a 5173-as porton
//   node tools/src/serve.mjs admin 5174 # admin/ a 5174-es porton
//   node tools/src/serve.mjs --check    # csak ellenőrzi, elérhető-e minden fájl

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const CHECK_ONLY = process.argv.includes('--check');
const ROOT = resolve(args[0] ?? 'web');
const PORT = Number(args[1] ?? 5173);

if (!existsSync(ROOT)) {
  console.error(`Nincs ilyen könyvtár: ${ROOT}`);
  process.exit(1);
}

// ─────────────────── ellenőrző mód: minden hivatkozás megvan? ───────────────────

if (CHECK_ONLY) {
  const problems = [];

  const requireFile = (relative, reason) => {
    const path = join(ROOT, relative.replace(/^\.\//, ''));
    if (!existsSync(path)) problems.push(`${relative} – ${reason}`);
  };

  // A service worker precache listája
  const swPath = join(ROOT, 'sw.js');
  if (existsSync(swPath)) {
    const sw = readFileSync(swPath, 'utf8');
    const block = sw.match(/const PRECACHE = \[([\s\S]*?)\];/);
    if (block) {
      for (const match of block[1].matchAll(/'([^']+)'/g)) {
        if (match[1] === './') continue;
        requireFile(match[1], 'a service worker precache listájában szerepel');
      }
    }
  }

  // Az index.html hivatkozásai
  const indexPath = join(ROOT, 'index.html');
  if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, 'utf8');
    for (const match of html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)) {
      requireFile(match[1], 'az index.html hivatkozik rá');
    }
  }

  // A manifest ikonjai
  const manifestPath = join(ROOT, 'manifest.webmanifest');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const icon of manifest.icons ?? []) {
      requireFile(icon.src, 'a manifest ikonja');
    }
  }

  if (problems.length) {
    console.error(`✗ ${problems.length} hiányzó fájl:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('✓ Minden hivatkozott fájl megvan.');
  process.exit(0);
}

// ─────────────────────────── szerver ───────────────────────────

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Könyvtár-kitörés elleni védelem
  const target = join(ROOT, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(ROOT)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  if (!existsSync(target) || !statSync(target).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`404 – nincs ilyen fájl: ${pathname}`);
    console.log(`404 ${pathname}`);
    return;
  }

  response.writeHead(200, {
    'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    // Fejlesztés közben ne cache-eljen a böngésző – a service workert amúgy is
    // nehéz frissíteni, ha a HTTP cache közbeszól.
    'Cache-Control': 'no-cache',
    'Service-Worker-Allowed': '/'
  });
  createReadStream(target).pipe(response);
});

server.listen(PORT, () => {
  console.log(`Kiszolgálás: ${ROOT}`);
  console.log(`Megnyitás:   http://localhost:${PORT}/`);
  console.log('Leállítás:   Ctrl+C');
});
