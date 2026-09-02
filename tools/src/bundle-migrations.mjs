#!/usr/bin/env node
// A migrációk egyetlen SQL fájlba fűzése – a Supabase SQL Editorához.
//
// Mikor kell ez? Ha a `supabase db push` nem járható út (nincs CLI-bejelentkezés,
// elfelejtett adatbázis-jelszó, céges gép), akkor a migrációkat kézzel kell
// lefuttatni az SQL Editorban. Tizenkét fájlt egyenként bemásolni tévedésre
// hívó, sorrend-érzékeny munka – ez a szkript egy fájlt ad, helyes sorrendben.
//
// A kimenet NINCS verziókövetve (lásd .gitignore): mindig újragenerálható, és
// nem szabad, hogy elcsússzon a migrációktól.
//
// Futtatás:  node tools/src/bundle-migrations.mjs

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const OUTPUT = join(ROOT, 'supabase', 'all-migrations.sql');

const files = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error('Nincs migrációs fájl a supabase/migrations/ mappában.');
  process.exit(1);
}

const parts = [
  '-- TudásKerék – az összes migráció egy fájlban, helyes sorrendben.',
  '--',
  '-- GENERÁLT FÁJL, ne szerkeszd. Újragenerálás:',
  '--   node tools/src/bundle-migrations.mjs',
  '--',
  '-- Használat: másold be a Supabase SQL Editorába és futtasd le egyszerre.',
  '-- (Ha a `supabase db push` működik, azt használd inkább – az nyilvántartja,',
  '--  mi futott már le.)',
  '--',
  `-- ${files.length} migráció, generálva: ${new Date().toISOString()}`,
  ''
];

for (const name of files) {
  parts.push(
    '',
    `-- ${'═'.repeat(70)}`,
    `-- ${name}`,
    `-- ${'═'.repeat(70)}`,
    '',
    readFileSync(join(MIGRATIONS, name), 'utf8').replace(/\s+$/, ''),
    ''
  );
}

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, parts.join('\n') + '\n', 'utf8');

const kb = (Buffer.byteLength(parts.join('\n')) / 1024).toFixed(0);
console.log(`✓ ${files.length} migráció összefűzve → supabase/all-migrations.sql (${kb} kB)`);
for (const name of files) console.log(`    ${name}`);
console.log(
  '\nMásold be a Supabase SQL Editorába (Dashboard → SQL Editor → New query) és futtasd.'
);
