#!/usr/bin/env node
// A seed kérdésbank feltöltése a Supabase adatbázisba.
//
// Idempotens: a kérdéseket a (category_id, norm_question) egyedi index alapján
// upsertáljuk, tehát a szkript többször is futtatható anélkül, hogy
// duplikátumokat hozna létre.
//
// Használat:
//   node tools/src/import-seed.mjs                 # kategóriák + kérdések
//   node tools/src/import-seed.mjs --dry-run       # csak kiírja, mit tenne
//   node tools/src/import-seed.mjs --only-categories
//   node tools/src/import-seed.mjs --category magyar-tortenelem

import { loadSeedQuestions, loadCategories } from './seed-lib.mjs';
import { SupabaseAdmin, loadEnv, chunk } from './supabase-client.mjs';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ONLY_CATEGORIES = args.includes('--only-categories');
const categoryFilter = (() => {
  const index = args.indexOf('--category');
  return index >= 0 ? args[index + 1] : null;
})();

const BATCH_SIZE = 200;

async function main() {
  const env = loadEnv();
  const categories = loadCategories();
  const { questions } = loadSeedQuestions({ shuffle: true });

  const selected = categoryFilter
    ? questions.filter((q) => q.category === categoryFilter)
    : questions;

  if (categoryFilter && selected.length === 0) {
    throw new Error(`Nincs kérdés ebben a kategóriában: ${categoryFilter}`);
  }

  console.log('── Seed import ────────────────────────────────');
  console.log(`Kategória: ${categories.length}`);
  console.log(`Kérdés:    ${selected.length}${categoryFilter ? ` (szűrve: ${categoryFilter})` : ''}`);
  console.log(`Mód:       ${DRY_RUN ? 'DRY RUN (nem írunk)' : 'írás'}`);
  console.log('');

  if (DRY_RUN) {
    for (const q of selected.slice(0, 5)) {
      console.log(`  [${q.category}] ${q.question}`);
      console.log(`      → ${q.answers[q.correct]} (${q.difficulty})`);
    }
    if (selected.length > 5) console.log(`  … és további ${selected.length - 5} kérdés`);
    return;
  }

  const db = SupabaseAdmin.fromEnv(env);

  // ── 1. Kategóriák ──
  const categoryRows = categories.map((c) => ({
    slug: c.slug,
    name: c.name,
    description: c.description,
    icon: c.icon,
    color: c.color,
    is_hungarian: c.is_hungarian,
    sort_order: c.sort_order,
    is_active: true
  }));

  await db.upsert('categories', categoryRows, { onConflict: 'slug', returning: 'minimal' });
  console.log(`✓ ${categoryRows.length} kategória upsertálva`);

  if (ONLY_CATEGORIES) return;

  // ── 2. Kategória-azonosítók lekérése ──
  const stored = await db.select('categories', 'select=id,slug');
  const idBySlug = new Map(stored.map((row) => [row.slug, row.id]));

  const missing = [...new Set(selected.map((q) => q.category))].filter((s) => !idBySlug.has(s));
  if (missing.length) {
    throw new Error(`Hiányzó kategóriák az adatbázisban: ${missing.join(', ')}`);
  }

  // ── 3. Kérdések ──
  const questionRows = selected.map((q) => ({
    category_id: idBySlug.get(q.category),
    question_text: q.question,
    answer_a: q.answers[0],
    answer_b: q.answers[1],
    answer_c: q.answers[2],
    answer_d: q.answers[3],
    correct_answer: q.correct,
    difficulty: q.difficulty,
    explanation: q.explanation,
    source: q.source,
    language: 'hu',
    license: q.license,
    provenance: q.provenance,
    topic: q.topic,
    is_active: true
  }));

  let inserted = 0;
  let failed = 0;
  const batches = chunk(questionRows, BATCH_SIZE);

  for (const [index, batch] of batches.entries()) {
    try {
      await db.upsert('questions', batch, {
        // A (category_id, norm_question) egyedi index a duplikátumszűrő.
        // A norm_question generált oszlop, ezért az on_conflict a rá épülő
        // indexet célozza.
        onConflict: 'category_id,norm_question',
        returning: 'minimal'
      });
      inserted += batch.length;
      console.log(`  batch ${index + 1}/${batches.length}: ${batch.length} sor`);
    } catch (error) {
      // Egy batch elhasalása ne állítsa meg az egészet: soronként újrapróbáljuk,
      // hogy kiderüljön, pontosan melyik kérdés hibás (pl. CHECK sértés).
      console.warn(`  batch ${index + 1} hibás, soronkénti újrapróbálás…`);
      for (const row of batch) {
        try {
          await db.upsert('questions', [row], {
            onConflict: 'category_id,norm_question',
            returning: 'minimal'
          });
          inserted++;
        } catch (rowError) {
          failed++;
          console.error(`    ✗ „${row.question_text.slice(0, 70)}”`);
          console.error(`      ${String(rowError.message).split('\n')[0].slice(0, 200)}`);
        }
      }
    }
  }

  console.log('');
  console.log(`✓ ${inserted} kérdés feltöltve, ${failed} hibás.`);

  // ── 4. Ellenőrzés ──
  const stats = await db.select('category_stats', 'select=slug,question_count&order=slug');
  console.log('\nAdatbázis állapota:');
  for (const row of stats) {
    console.log(`  ${row.slug.padEnd(20)} ${String(row.question_count).padStart(5)}`);
  }

  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}`);
  process.exit(1);
});
