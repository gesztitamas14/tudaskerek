#!/usr/bin/env node
// A bundle-be épített kérdésbank előállítása.
//
// Bemenet:  content/categories.json + content/seed/*.json
// Kimenet:  web/seed-questions.json
//
// A `version` a tartalom hash-éből származik: ha a kérdésbank változik, a
// verzió is változik. Ha nem változott, a verzió sem – így a kliens tudja,
// hogy nincs mit újratölteni.
//
// Használat: node tools/src/build-seed.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { loadSeedQuestions, loadCategories } from './seed-lib.mjs';

// A kérdésbank egyetlen kimenete a PWA. A service worker ezt a fájlt cache-eli,
// ezért offline is elérhető.
const OUTPUTS = ['web/seed-questions.json'];

const categories = loadCategories();
const { questions, files } = loadSeedQuestions({ shuffle: true });

// Csak a valóban feltöltött kategóriák kerülnek a bundle-be – a kerék így nem
// tud üres cikkre megállni.
const usedSlugs = new Set(questions.map((q) => q.category));
const bundledCategories = categories
  .filter((c) => usedSlugs.has(c.slug))
  .map((c) => ({
    slug: c.slug,
    name: c.name,
    description: c.description,
    icon: c.icon,
    color: c.color,
    is_hungarian: c.is_hungarian,
    sort_order: c.sort_order
  }));

// A PWA `QuestionBank.load()` ezt a kompakt alakot várja.
const bundledQuestions = questions.map((q) => ({
  category: q.category,
  question: q.question,
  answers: q.answers,
  correct: q.correct,
  difficulty: q.difficulty,
  explanation: q.explanation,
  source: q.source,
  topic: q.topic
}));

const contentHash = createHash('sha256')
  .update(JSON.stringify({ bundledCategories, bundledQuestions }))
  .digest('hex');

// A verzió egy monoton növő szám lenne ideális, de a tartalomból származtatott
// stabil egész is megteszi: az app csak azt figyeli, hogy MÁS-e, mint a
// legutóbb importált. A 24 bit elég ahhoz, hogy ütközés gyakorlatilag ne
// legyen, és a szám olvasható maradjon.
const version = parseInt(contentHash.slice(0, 6), 16);

const bundle = {
  version,
  generated_at: new Date().toISOString(),
  content_hash: contentHash,
  categories: bundledCategories,
  questions: bundledQuestions
};

for (const target of OUTPUTS) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(bundle, null, 1) + '\n', 'utf8');
}

const sizeKB = (Buffer.byteLength(JSON.stringify(bundle)) / 1024).toFixed(0);

console.log('── Seed bundle ────────────────────────────────');
console.log(`Kimenet:     ${OUTPUTS.join('\n             ')}`);
console.log(`Verzió:      ${version}`);
console.log(`Kategória:   ${bundledCategories.length}`);
console.log(`Kérdés:      ${bundledQuestions.length}`);
console.log(`Méret:       ${sizeKB} kB`);
console.log('');
console.log('Forrásfájlok:');
for (const { file, count } of files) {
  console.log(`  ${file.padEnd(26)} ${String(count).padStart(4)}`);
}
