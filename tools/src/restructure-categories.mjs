#!/usr/bin/env node
// Egyszeri átalakítás: kategóriák törlése, hozzáadása, átnevezése.
//
// Miért szkript és nem kézi szerkesztés? Mert négy helyen kell egyszerre
// egyeznie: `content/categories.json`, `content/seed/*.json` (fájlnevek),
// a Wikidata-sablonok `category` mezői és a Supabase seed-migráció. Kézzel
// biztosan elcsúszna valamelyik, és a `validate-seed.mjs` csak utólag szólna.
//
// A törölt kategóriák kérdései NEM tűnnek el: átkerülnek a megadott helyre.
//
// Futtatás:  node tools/src/restructure-categories.mjs [--dry-run]

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const DRY = process.argv.includes('--dry-run');
const CATEGORIES_FILE = 'content/categories.json';
const SEED_DIR = 'content/seed';

// ─────────────────── mit törlünk és hova költözik ───────────────────
//
// `magyar-zene-film`: a felhasználó szerint nem indokolt külön kategória –
//   a magyar film és zene belefér a magyar kultúrába.
// `magyar-nyelv`: magyar anyanyelvűeknek túl könnyű. A kérdései közül csak a
//   `hard` nehézségűek maradnak meg (a `medium`/`easy` triviális lenne).

const REMOVE = [
  { slug: 'magyar-zene-film', moveTo: 'magyar-kultura', keepDifficulties: null },
  { slug: 'magyar-nyelv', moveTo: 'magyar-kultura', keepDifficulties: ['medium', 'hard'] }
];

// ─────────────────── új kategóriák ───────────────────
//
// A meglévők közül azok maradtak, amiknek van közeli párja a kért listában
// (pl. „Film, színház” → a meglévő `film-sorozat`). Csak az valóban új, amire
// nincs meglévő kategória.

const ADD = [
  {
    slug: 'cegek-markak',
    name: 'Cégek, márkák',
    description: 'Vállalatok, logók, alapítók és a mögöttük lévő történetek.',
    icon: '🏢',
    color: '#4A6FA5',
    is_hungarian: false,
    sort_order: 230
  },
  {
    slug: 'hires-ember',
    name: 'Híres emberek',
    description: 'Feltalálók, uralkodók, sztárok – ki kicsoda a világtörténelemben.',
    icon: '🌟',
    color: '#C9A227',
    is_hungarian: false,
    sort_order: 235
  },
  {
    slug: 'fizika',
    name: 'Fizika',
    description: 'Erők, energia, fény és a világ működésének szabályai.',
    icon: '⚛️',
    color: '#3C6E71',
    is_hungarian: false,
    sort_order: 240
  },
  {
    slug: 'kemia',
    name: 'Kémia',
    description: 'Elemek, vegyületek, reakciók és a periódusos rendszer.',
    icon: '🧪',
    color: '#6A8E7F',
    is_hungarian: false,
    sort_order: 245
  },
  {
    slug: 'mitologia-vallas',
    name: 'Mitológia, vallás',
    description: 'Istenek, hősök, szent könyvek és világvallások.',
    icon: '🏺',
    color: '#8E6C88',
    is_hungarian: false,
    sort_order: 250
  },
  {
    slug: 'unnepek',
    name: 'Ünnepek, jeles napok',
    description: 'Szokások, hagyományok és a naptár nevezetes napjai.',
    icon: '🎉',
    color: '#D96C6C',
    is_hungarian: false,
    sort_order: 255
  },
  {
    slug: 'jatekok',
    name: 'Játékok',
    description: 'Társasjátékok, kártya, sakk és videojátékok.',
    icon: '🎲',
    color: '#5C7AEA',
    is_hungarian: false,
    sort_order: 260
  },
  {
    slug: 'divat',
    name: 'Divat, öltözködés',
    description: 'Márkák, tervezők, stílusok és a ruhák története.',
    icon: '👗',
    color: '#B5838D',
    is_hungarian: false,
    sort_order: 265
  }
];

// ─────────────────── névpontosítások ───────────────────
// A kért lista bővebb megnevezéseket használ; a slug marad, hogy a meglévő
// kérdések és az adatbázis ne csúszzon el.

const RENAME = {
  allatvilag: 'Állatok, biológia',
  'film-sorozat': 'Film, színház',
  foldrajz: 'Földrajz, csillagászat',
  muveszet: 'Művészet, építészet',
  technologia: 'Technika, találmányok',
  zene: 'Zene, tánc',
  erdekessegek: 'Egyéb tudomány, kultúra'
};

// ─────────────────── végrehajtás ───────────────────

const categories = JSON.parse(readFileSync(CATEGORIES_FILE, 'utf8'));
const bySlug = new Map(categories.map((c) => [c.slug, c]));

console.log('\n── Kategória-átalakítás ────────────────────────');
if (DRY) console.log('(PRÓBAFUTÁS – nem írunk fájlt)\n');

// 1. Kérdések átköltöztetése, majd a fájl törlése.
for (const { slug, moveTo, keepDifficulties } of REMOVE) {
  const from = join(SEED_DIR, `${slug}.json`);
  const to = join(SEED_DIR, `${moveTo}.json`);
  if (!existsSync(from)) {
    console.log(`  ${slug}: nincs seed fájl, kihagyva`);
    continue;
  }
  if (!existsSync(to)) {
    console.error(`  HIBA: a céltárgy nem létezik: ${moveTo}`);
    process.exit(1);
  }

  const source = JSON.parse(readFileSync(from, 'utf8'));
  const target = JSON.parse(readFileSync(to, 'utf8'));

  const moved = source.questions.filter(
    (q) => !keepDifficulties || keepDifficulties.includes(q.d)
  );
  const dropped = source.questions.length - moved.length;

  // A téma megjelölése, hogy a plafonszámítás külön csoportnak lássa őket.
  for (const q of moved) {
    if (!q.t) q.t = slug === 'magyar-nyelv' ? 'nyelvi érdekességek' : 'magyar film és zene';
  }

  target.questions.push(...moved);

  if (!DRY) {
    writeFileSync(to, `${JSON.stringify(target, null, 2)}\n`, 'utf8');
    unlinkSync(from);
  }

  bySlug.delete(slug);
  console.log(
    `  ✗ ${slug.padEnd(18)} → ${moveTo}: ${moved.length} kérdés átköltözött` +
      (dropped > 0 ? `, ${dropped} eldobva (túl könnyű)` : '')
  );
}

// 2. Névpontosítások.
for (const [slug, name] of Object.entries(RENAME)) {
  const cat = bySlug.get(slug);
  if (!cat) continue;
  if (cat.name !== name) {
    console.log(`  ~ ${slug.padEnd(18)} „${cat.name}” → „${name}”`);
    cat.name = name;
  }
}

// 3. Új kategóriák + üres seed fájl mindegyikhez.
for (const cat of ADD) {
  if (bySlug.has(cat.slug)) {
    console.log(`  = ${cat.slug}: már létezik, kihagyva`);
    continue;
  }
  bySlug.set(cat.slug, cat);

  const path = join(SEED_DIR, `${cat.slug}.json`);
  if (!existsSync(path) && !DRY) {
    writeFileSync(
      path,
      `${JSON.stringify({ category: cat.slug, default_source: null, questions: [] }, null, 2)}\n`,
      'utf8'
    );
  }
  console.log(`  + ${cat.slug.padEnd(18)} „${cat.name}”`);
}

// 4. categories.json újraírása, sort_order szerint.
const next = [...bySlug.values()].sort((a, b) => a.sort_order - b.sort_order);
if (!DRY) {
  writeFileSync(CATEGORIES_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

console.log(`\nKategória: ${categories.length} → ${next.length}`);
console.log(`  magyar fókuszú: ${next.filter((c) => c.is_hungarian).length}`);
if (!DRY) {
  console.log('\nKövetkező lépés:');
  console.log('  node tools/src/validate-seed.mjs');
  console.log('  node tools/src/build-seed.mjs');
  console.log('  (majd új Supabase migráció a kategóriákhoz)');
}
