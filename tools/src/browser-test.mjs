#!/usr/bin/env node
// A PWA integrációs tesztjének futtatása fejnélküli böngészőben.
//
// Elindítja a statikus szervert, megnyitja a `web/tests/smoke.html` oldalt egy
// fejnélküli Chromium-alapú böngészőben (Edge vagy Chrome), majd a DOM-ból
// kiolvassa az eredményt. Nulla npm-függőség: nem kell Playwright/Puppeteer.
//
// Használat:
//   node tools/src/browser-test.mjs
//   node tools/src/browser-test.mjs --screenshot   # képernyőképek is készülnek
//
// Miért nem `node --test`? Mert a játékképernyő valódi DOM-ot, canvas-t és
// requestAnimationFrame-et használ – ezt csak igazi böngésző tudja futtatni.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const PORT = 5199;
const ROOT = resolve('web');
const SHOTS = process.argv.includes('--screenshot');
const SHOT_DIR = resolve('docs/screenshots');

// Friss böngészőprofil minden futásnál. Ha újrahasználnánk, a KORÁBBI futás
// service workere szolgálná ki a régi JS-t (stale-while-revalidate), és a teszt
// nem azt mérné, amit épp megírtunk. Ez egyszer már megtévesztett minket.
const PROFILE_DIR = join(tmpdir(), `tudaskerek-browser-test-${process.pid}-${Date.now()}`);

// ─────────────────── böngésző keresése ───────────────────

const CANDIDATES = [
  // Windows
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  // macOS
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Linux
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
];

function findBrowser() {
  if (process.env.BROWSER_PATH && existsSync(process.env.BROWSER_PATH)) {
    return process.env.BROWSER_PATH;
  }
  return CANDIDATES.find((path) => existsSync(path)) ?? null;
}

// ─────────────────── statikus szerver ───────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png'
};

function startServer() {
  const server = createServer((request, response) => {
    let pathname = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const target = join(ROOT, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));

    if (!target.startsWith(ROOT) || !existsSync(target) || !statSync(target).isFile()) {
      response.writeHead(404).end('404');
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    createReadStream(target).pipe(response);
  });

  return new Promise((resolveServer) => {
    server.listen(PORT, () => resolveServer(server));
  });
}

// ─────────────────── böngésző futtatása ───────────────────

function runBrowser(browser, url, { screenshot = null, budget = 60000, windowSize = '390,844' } = {}) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    // Enélkül a fejnélküli böngésző nem indítja el az AudioContextet gesztus
    // nélkül, és a hangteszt mindig 'suspended'-et látna.
    '--autoplay-policy=no-user-gesture-required',
    '--force-device-scale-factor=1',
    `--window-size=${windowSize}`,
    `--virtual-time-budget=${budget}`,
    `--user-data-dir=${PROFILE_DIR}`,
    screenshot ? `--screenshot=${screenshot}` : '--dump-dom',
    url
  ];

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', rejectRun);
    child.on('close', () => resolveRun(stdout));
  });
}

// ─────────────────── eredmény kiolvasása ───────────────────

function parseResults(html) {
  // A záró horgony NE követelje meg, hogy a `host` divnek ne legyen attribútuma:
  // a játék futás közben osztályt tesz rá (a görgetés kikapcsolásához), és ettől
  // a korábbi `<div id="host">` minta csendben nem illeszkedett – a futtató
  // „nem találom az eredményt” hibát adott, pedig a teszt lefutott.
  const block = html.match(/<div id="results">([\s\S]*?)<\/div>\s*<div id="host"[\s>]/);
  if (!block) return { ok: false, summary: 'Nem találom a teszt eredményét a DOM-ban.', lines: [] };

  const text = block[1]
    .replace(/<div id="summary" class="\w+">/g, '\n@@SUMMARY@@')
    .replace(/<div class="\w+">/g, '\n')
    .replace(/<\/div>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const summaryLine = lines.find((line) => line.startsWith('@@SUMMARY@@')) ?? '';
  const summary = summaryLine.replace('@@SUMMARY@@', '');

  return {
    ok: summary.includes('MINDEN RENDBEN'),
    summary,
    lines: lines.filter((line) => !line.startsWith('@@SUMMARY@@'))
  };
}

// ─────────────────── fő folyamat ───────────────────

const browser = findBrowser();
if (!browser) {
  console.error(
    'Nem találtam fejnélküli böngészőt (Edge vagy Chrome).\n' +
    'Add meg a BROWSER_PATH környezeti változóval:\n' +
    '  BROWSER_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" node tools/src/browser-test.mjs'
  );
  process.exit(1);
}

console.log(`Böngésző: ${browser}`);
const server = await startServer();
console.log(`Szerver:  http://localhost:${PORT}/ (${ROOT})`);

try {
  const html = await runBrowser(browser, `http://localhost:${PORT}/tests/smoke.html`);
  const result = parseResults(html);

  console.log('\n── PWA integrációs teszt ──────────────────────');
  for (const line of result.lines) console.log(line);
  console.log(`\n${result.summary}`);


  // ─────────────── elrendezés-ellenőrzés több telefonmagasságon ───────────
  //
  // A `layout-check.html` telefonméretű iframe-be tölti az alkalmazást, és
  // megmondja, lóg-e ki valami vízszintesen, illetve van-e olyan gomb egy
  // FIX rétegben (párbeszéd), amit nem lehet elérni. Ez utóbbi valódi hiba
  // volt: a szoba létrehozásánál a „Mégsem” gomb lecsúszott a képernyőről.
  //
  // Több magasságot mérünk, mert telefonon a látható magasság a címsávtól
  // függ: egy 844px-es készülék böngészőben ~700px-et mutat, fekvőben ~330-at.
  const layoutCases = [
    ['szobalista', 'lobby-shot.html', 844],
    ['szoba létrehozása', 'lobby-shot.html%23create', 844],
    ['szoba létrehozása (címsávval)', 'lobby-shot.html%23create', 700],
    ['szoba létrehozása (fekvő)', 'lobby-shot.html%23create', 360],
    ['PIN-párbeszéd', 'lobby-shot.html%23pin', 700],
    // A kérdésfázis: a kérdésnek, a pontsávnak és mind a négy válasznak
    // egy képernyőre kell kiférnie, görgetés nélkül.
    ['kérdés + 4 válasz', 'lobby-shot.html%23answer', 844],
    ['kérdés (címsávval)', 'lobby-shot.html%23answer', 700],
    ['kérdés, 5 játékos, hosszú szöveg', 'lobby-shot.html%23answer5', 700],
    ['kérdés, szűk képernyő', 'lobby-shot.html%23answer5', 560],
    ['kérdés, nagyon szűk képernyő', 'lobby-shot.html%23answer5', 520]
  ];

  console.log('\n── elrendezés telefonon ───────────────────────');
  let layoutOk = true;
  for (const [label, page, height] of layoutCases) {
    const dom = await runBrowser(
      browser,
      `http://localhost:${PORT}/tests/layout-check.html?page=${page}&h=${height}`,
      { budget: 9000, windowSize: '460,1200' }
    );
    // CSAK a mérés kimenetét vizsgáljuk, ne a lap forrását: a keresett
    // szövegek szó szerint benne vannak a layout-check.html szkriptjében is,
    // ezért a teljes DOM-on illesztve MINDEN eset hamisan hibás lett.
    const out = dom.match(/<div id="out">([\s\S]*?)<\/div>\s*<iframe/);
    const report = out ? out[1] : '';
    const problems = [];
    if (!out) problems.push('nem találom a mérés kimenetét');
    const horizontal = report.match(/VÍZSZINTES TÚLLÓGÁS: (\d+)px/);
    if (horizontal) problems.push(`${horizontal[1]}px vízszintes túllógás`);
    const unreachable = report.match(/ELÉRHETETLEN ELEMEK: (\d+)</);
    if (unreachable) problems.push(`${unreachable[1]} elérhetetlen elem fix rétegben`);
    // A kérdésfázis kiférése.
    const cut = report.match(/A NEGYEDIK VÁLASZ KILÓG: (\d+)px/);
    if (cut) problems.push(`a negyedik válasz ${cut[1]}px-szel kilóg`);
    const scrolls = report.match(/A KÉRDÉSKÉPERNYŐ GÖRGETHETŐ: (\d+)px/);
    if (scrolls) problems.push(`a kérdésképernyő görgethető (${scrolls[1]}px)`);
    const wrapped = report.match(/A PONTSÁV (\d+) SORBA TÖRDELŐDÖTT/);
    if (wrapped) problems.push(`a pontsáv ${wrapped[1]} sorba tördelődött`);
    if (/A BESZÓLÁS-BUBORÉK NEM LÁTSZIK/.test(report)) problems.push('a beszólás-buborék nem látszik');

    if (problems.length === 0) {
      console.log(`  ✓ ${label} (${height}px)`);
    } else {
      layoutOk = false;
      console.log(`  ✗ ${label} (${height}px): ${problems.join(', ')}`);
    }
  }
  console.log(layoutOk ? '\nELRENDEZÉS: MINDEN RENDBEN' : '\nELRENDEZÉS: HIBA');
  if (!layoutOk) result.ok = false;

  if (SHOTS) {
    mkdirSync(SHOT_DIR, { recursive: true });
    const shots = [
      ['pwa-home.png', ''],
      ['pwa-game.png', '%23/game'],
      ['pwa-stats.png', '%23/stats'],
      ['pwa-profile.png', '%23/profile'],
      ['pwa-settings.png', '%23/settings']
    ];
    // A szobalista és a PIN-választó nem a fő navigációból érhető el (backend
    // kell hozzá), ezért saját, adatokkal feltöltött lapról készül a kép.
    const lobbyShots = [
      ['pwa-lobby.png', ''],
      ['pwa-pin.png', '%23pin'],
      ['pwa-create.png', '%23create'],
      ['pwa-answer.png', '%23answer'],
      ['pwa-answer5.png', '%23answer5'],
      ['pwa-spin.png', '%23spin']
    ];
    console.log('\nKépernyőképek:');
    for (const [name, hash] of shots) {
      const target = join(SHOT_DIR, name);
      await runBrowser(
        browser,
        `http://localhost:${PORT}/tests/layout-check.html?src=${hash}`,
        { screenshot: target, budget: 12000, windowSize: '460,1000' }
      );
      console.log(`  ${target}`);
    }
    for (const [name, hash] of lobbyShots) {
      const target = join(SHOT_DIR, name);
      // A layout-check keretén át: a fejnélküli böngésző `--window-size`-a nem
      // hat (innerWidth mindig ~492), az iframe viszont pontosan 390px.
      await runBrowser(
        browser,
        `http://localhost:${PORT}/tests/layout-check.html?page=lobby-shot.html${hash}&shot=1`,
        { screenshot: target, budget: 14000, windowSize: '460,1000' }
      );
      console.log(`  ${target}`);
    }
  }

  process.exitCode = result.ok ? 0 : 1;
} finally {
  server.close();
  try {
    rmSync(PROFILE_DIR, { recursive: true, force: true });
  } catch {
    /* Windowson a profil néha zárolt marad – nem kritikus */
  }
}
