#!/usr/bin/env node
// Témaarány kikényszerítése a teljes kérdésbankon.
//
// A szabály: egy témacsoport ne foglalja el a kategória több mint X részét.
// Enélkül a játék egyhangú – mérve előfordult, hogy a `film-sorozat` 66%-a
// „Ki rendezte a…?” kérdés volt, a `magyar-zene-film` 80%-a pedig ugyanaz
// magyar filmekkel. Technikailag mind helyes, de játszani rossz.
//
// Miért külön eszköz, és miért nem elég a `merge-generated.mjs` nyesése?
// Mert a merge csak a most beolvasztott kategóriákat látja. Ez itt a KÉSZ
// bankot ellenőrzi, tehát akkor is fogja a problémát, ha kézzel írt kérdés
// került ugyanabba a témába, mint egy generált (pl. „videojátékok”).
//
// KÉT SZABÁLY ÜTKÖZIK, ÉS TUDNI KELL, MELYIK NYER:
//
//   * Az arányszabály azt kívánja, hogy nyessünk.
//   * A játszhatóság azt, hogy egy kategóriában legyen legalább 40 kérdés,
//     mert egy kör 10 kérdés UGYANABBÓL a kategóriából, és 40 alatt gyorsan
//     ismétlődne.
//
// Ütközésnél a JÁTSZHATÓSÁG nyer, és a kategória a jelentésben megjelölve
// marad: oda kézzel írt kérdés kell, nem több generálás.
//
// Csak GENERÁLT kérdést dobunk (van forrás-URL-je). A kézzel írtak a
// kategória gerince, azokhoz nem nyúlunk.
//
// Futtatás:
//   node tools/src/balance-topics.mjs --dry-run
//   node tools/src/balance-topics.mjs --share 0.3

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SEED_DIR } from './seed-lib.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const shareIndex = args.indexOf('--share');
const SHARE = shareIndex >= 0 ? Number(args[shareIndex + 1]) : 0.3;
const MIN_PLAYABLE = 40;

const isGenerated = (q) => Boolean(q.s && /wikidata|opentdb/i.test(String(q.s)));
const topicOf = (q) => q.t ?? '(nincs téma)';

console.log('\n── Témaarány kiegyensúlyozása ──────────────────');
console.log(`Egy téma legfeljebb ${Math.round(SHARE * 100)}%, játszhatósági alsó korlát ${MIN_PLAYABLE} kérdés`);
console.log(`${DRY ? '(PRÓBAFUTÁS – nem írunk fájlt)\n' : ''}`);

const rows = [];

for (const file of readdirSync(SEED_DIR).filter((f) => f.endsWith('.json')).sort()) {
  const path = join(SEED_DIR, file);
  const seed = JSON.parse(readFileSync(path, 'utf8'));
  const questions = seed.questions ?? [];
  const before = questions.length;

  let removed = 0;
  for (let pass = 0; pass < 500; pass++) {
    if (questions.length <= MIN_PLAYABLE) break;

    const counts = new Map();
    for (const q of questions) {
      counts.set(topicOf(q), (counts.get(topicOf(q)) ?? 0) + 1);
    }
    const allowed = Math.max(6, Math.floor(questions.length * SHARE));
    const over = [...counts.entries()]
      .filter(([, n]) => n > allowed)
      .sort((a, b) => b[1] - a[1])[0];
    if (!over) break;

    const excess = Math.min(over[1] - allowed, questions.length - MIN_PLAYABLE);
    let cut = 0;
    // A végéről vágunk: a később bekerült (generált) kérdéseket dobjuk előbb.
    for (let i = questions.length - 1; i >= 0 && cut < excess; i--) {
      if (topicOf(questions[i]) !== over[0]) continue;
      if (!isGenerated(questions[i])) continue;
      questions.splice(i, 1);
      cut++;
    }
    if (cut === 0) break;   // már csak kézzel írt van ebben a témában
    removed += cut;
  }

  const counts = new Map();
  for (const q of questions) counts.set(topicOf(q), (counts.get(topicOf(q)) ?? 0) + 1);
  const top = [...counts.values()].sort((a, b) => b - a)[0] ?? 0;
  const share = questions.length ? top / questions.length : 0;

  if (removed > 0 && !DRY) {
    seed.questions = questions;
    writeFileSync(path, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
  }

  rows.push({
    slug: file.replace(/\.json$/, ''),
    before,
    after: questions.length,
    removed,
    topics: counts.size,
    share
  });
}

console.log('  kategória              előtte  utána  nyesve  témák  legnagyobb');
console.log('  ' + '─'.repeat(66));
let totalRemoved = 0;
const stuck = [];
for (const r of rows.sort((a, b) => b.share - a.share)) {
  totalRemoved += r.removed;
  const flag = r.share > SHARE + 0.05 ? '  ⚠' : '';
  if (flag) stuck.push(r);
  console.log(
    '  ' +
      r.slug.padEnd(22) +
      String(r.before).padStart(6) +
      String(r.after).padStart(7) +
      String(r.removed).padStart(8) +
      String(r.topics).padStart(7) +
      `${(r.share * 100).toFixed(0)}%`.padStart(11) +
      flag
  );
}

console.log(`\nÖsszesen ${totalRemoved} generált kérdés nyesve.`);

if (stuck.length > 0) {
  console.log('\n⚠ Ezekben a kategóriákban a nyesés nem elég – KÉZZEL ÍRT kérdés kell,');
  console.log('  mert a játszhatósági alsó korlát miatt nem vághatunk tovább:');
  for (const r of stuck) {
    console.log(`    ${r.slug.padEnd(22)} ${r.after} kérdés, ${r.topics} téma, legnagyobb ${(r.share * 100).toFixed(0)}%`);
  }
}

if (!DRY && totalRemoved > 0) {
  console.log('\nKövetkező lépés: node tools/src/validate-seed.mjs && node tools/src/build-seed.mjs');
}
