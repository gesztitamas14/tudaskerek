#!/usr/bin/env node
// Open Trivia Database importáló – OPCIONÁLIS, ALAPBÓL NEM FUT.
//
// ⚠ JOGI FIGYELMEZTETÉS
// Az OpenTDB minden adata **CC BY-SA 4.0** licencű. A ShareAlike záradék a
// származékos *adatbázisra* is kiterjed: ha ezeket a kérdéseket beemeljük, a
// bank érintett részét ugyanilyen licenc alatt kellene elérhetővé tenni.
// Egy később monetizált, zárt appnál ez nemkívánatos.
//
// Ezért:
//   * a szkriptet kézzel kell elindítani, és meg kell erősíteni (--i-accept-cc-by-sa),
//   * minden importált sor `license = 'CC-BY-SA-4.0'` és `provenance = 'opentdb'`
//     jelölést kap, tehát SQL-lel bármikor pontosan leválasztható,
//   * az appban az `attributions()` RPC automatikusan feltünteti őket.
//
// A kérdések angolul érkeznek: gépi fordítás NEM történik (a specifikáció
// kifejezetten tiltja a fordított kérdéseket). Az importált sorok
// `language = 'en'` értékkel kerülnek be, a magyar játék ezért nem szolgálja ki
// őket – kiindulási anyagként használhatók emberi átdolgozáshoz.
//
// Használat:
//   node tools/src/import-opentdb.mjs --amount 50 --category 23 --i-accept-cc-by-sa
//   node tools/src/import-opentdb.mjs --amount 50 --out content/generated/opentdb.json

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalize } from './seed-lib.mjs';
import { SupabaseAdmin, loadEnv } from './supabase-client.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

/** OpenTDB kategória → a mi kategóriánk. Amit nem tudunk leképezni, kihagyjuk. */
const CATEGORY_MAP = {
  9: 'erdekessegek',        // General Knowledge
  11: 'film-sorozat',       // Film
  12: 'zene',               // Music
  14: 'film-sorozat',       // Television
  17: 'tudomany',           // Science & Nature
  18: 'technologia',        // Computers
  19: 'tudomany',           // Mathematics
  21: 'sport',              // Sports
  22: 'foldrajz',           // Geography
  23: 'vilagtortenelem',    // History
  25: 'muveszet',           // Art
  27: 'allatvilag'          // Animals
};

/** Az OpenTDB HTML-entitásokkal küldi a szöveget. */
function decodeHtml(text) {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&eacute;/g, 'é')
    .replace(/&uuml;/g, 'ü')
    .replace(/&ouml;/g, 'ö')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

const DIFFICULTY_MAP = { easy: 'easy', medium: 'medium', hard: 'hard' };

async function main() {
  const amount = Math.min(Number(arg('amount', '50')), 50); // az API max 50/kérés
  const otdbCategory = arg('category');
  const out = arg('out');
  const accepted = flag('i-accept-cc-by-sa');

  if (!out && !accepted) {
    console.error(
      'Az adatbázisba írás előtt tudomásul kell venni a licencfeltételt.\n' +
      'Add meg a --i-accept-cc-by-sa jelzőt, vagy írj fájlba a --out paraméterrel.\n' +
      'Részletek: docs/04-kerdesforrasok.md'
    );
    process.exit(1);
  }

  const params = new URLSearchParams({ amount: String(amount), type: 'multiple' });
  if (otdbCategory) params.set('category', otdbCategory);

  console.log('── OpenTDB import (CC BY-SA 4.0) ──────────────');
  const response = await fetch(`https://opentdb.com/api.php?${params}`);
  if (!response.ok) throw new Error(`OpenTDB HTTP ${response.status}`);
  const data = await response.json();

  // response_code: 0 = ok, 1 = nincs elég kérdés, 2 = hibás paraméter
  if (data.response_code !== 0) {
    throw new Error(`OpenTDB response_code = ${data.response_code}`);
  }

  const questions = [];
  let skipped = 0;

  for (const item of data.results) {
    // A kategórianév helyett az API-tól kapott id-t nem kapjuk vissza,
    // ezért a kérésben megadott kategóriát használjuk, ha volt.
    const slug = otdbCategory ? CATEGORY_MAP[Number(otdbCategory)] : 'erdekessegek';
    if (!slug) { skipped++; continue; }

    const question = decodeHtml(item.question);
    const correct = decodeHtml(item.correct_answer);
    const incorrect = item.incorrect_answers.map(decodeHtml);
    if (incorrect.length !== 3) { skipped++; continue; }

    const answers = [correct, ...incorrect];
    // A normalizált alakok legyenek különbözőek (a DB CHECK ezt megköveteli)
    if (new Set(answers.map(normalize)).size !== 4) { skipped++; continue; }
    if (question.length < 8 || question.length > 400) { skipped++; continue; }

    questions.push({
      category: slug,
      question,
      answers,
      correct_index: 0,   // a keverést a review/import végzi
      difficulty: DIFFICULTY_MAP[item.difficulty] ?? 'medium',
      explanation: null,
      source: 'https://opentdb.com/ (CC BY-SA 4.0)',
      topic: decodeHtml(item.category),
      provenance: 'opentdb',
      license: 'CC-BY-SA-4.0',
      language: 'en'
    });
  }

  console.log(`Letöltve: ${data.results.length}, elfogadva: ${questions.length}, kihagyva: ${skipped}`);

  if (questions.length === 0) return;

  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({
      generated_at: new Date().toISOString(),
      model: 'opentdb-import',
      license: 'CC-BY-SA-4.0',
      questions
    }, null, 2));
    console.log(`✓ Kiírva: ${out}`);
    console.log('  Ezek angol nyelvű kérdések – emberi átdolgozás nélkül ne kerüljenek a magyar bankba.');
    return;
  }

  const db = SupabaseAdmin.fromEnv(loadEnv());
  const { uploadCandidates } = await import('./generate-questions.mjs');
  await uploadCandidates(db, questions, {
    model: 'opentdb-import',
    tasks: [{ categorySlug: questions[0].category, topic: 'OpenTDB import' }]
  });
  console.log('\n⚠ Ne felejtsd: ezek CC BY-SA 4.0 licencű, angol nyelvű kérdések.');
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}`);
  process.exit(1);
});
