#!/usr/bin/env node
// Seed validátor.
//
// A kérdésbank első védelmi vonala: néhány másodperc alatt lefut, és ugyanazokat
// a minőségi kapukat ellenőrzi, amiket a GitHub Actions is a publikálás előtt.
// Ha ez piros, nem érdemes továbbmenni.
//
// Használat: node tools/src/validate-seed.mjs [--strict]

import { loadSeedQuestions, loadCategories, normalize } from './seed-lib.mjs';

const STRICT = process.argv.includes('--strict');

/** A specifikáció szerinti MVP-kategóriák, legalább 50 kérdéssel. */
const MVP_CATEGORIES = [
  'magyar-tortenelem', 'magyar-irodalom', 'magyar-foldrajz', 'magyar-kultura',
  'magyar-sport', 'vilagtortenelem', 'foldrajz', 'tudomany', 'technologia',
  'allatvilag', 'sport', 'film-sorozat', 'zene', 'irodalom', 'muveszet',
  'etel-ital', 'erdekessegek', 'logika'
];
const MIN_PER_MVP_CATEGORY = 50;

const errors = [];
const warnings = [];

function error(message) { errors.push(message); }
function warn(message) { warnings.push(message); }

// A keverés nélküli alakot is betöltjük: a „helyes válasz pozíciója” ellenőrzés
// a végleges (kevert) sorrendre vonatkozik, a duplikátumszűrés viszont nem.
const { questions } = loadSeedQuestions({ shuffle: true });
const categories = loadCategories();
const knownSlugs = new Set(categories.map((c) => c.slug));

// ─────────────────────── 1. Alapszámok ───────────────────────

if (questions.length < 900) {
  error(`Összesen csak ${questions.length} kérdés van, az MVP-hez legalább 900 kell.`);
}

const byCategory = new Map();
for (const q of questions) {
  if (!byCategory.has(q.category)) byCategory.set(q.category, []);
  byCategory.get(q.category).push(q);
}

for (const slug of MVP_CATEGORIES) {
  const count = byCategory.get(slug)?.length ?? 0;
  if (count < MIN_PER_MVP_CATEGORY) {
    error(`${slug}: ${count} kérdés, legalább ${MIN_PER_MVP_CATEGORY} kell.`);
  }
}

for (const [slug, items] of byCategory) {
  if (!knownSlugs.has(slug)) {
    error(`Ismeretlen kategória a seedben: ${slug} (${items.length} kérdés)`);
  }
}

for (const category of categories) {
  if (!byCategory.has(category.slug)) {
    warn(`${category.slug}: nincs egyetlen kérdés sem – a keréken nem fog megjelenni.`);
  }
}

// ─────────────────────── 2. Kérdésenkénti szabályok ───────────────────────

const seenPerCategory = new Map();      // "kategória|normalizált" -> kérdés
const seenIDs = new Map();
const answerSetsPerCategory = new Map(); // "kategória|válaszhash" -> [kérdés]

for (const q of questions) {
  const label = `${q.category}: „${q.question.slice(0, 70)}”`;

  if (q.answers.length !== 4) {
    error(`${label} – nem 4 válasz (${q.answers.length}).`);
  }
  if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct > 3) {
    error(`${label} – érvénytelen helyes index: ${q.correct}`);
  }
  if (q.question.length < 8 || q.question.length > 400) {
    error(`${label} – a kérdés hossza ${q.question.length} karakter (8–400 kell).`);
  }
  if (!['easy', 'medium', 'hard'].includes(q.difficulty)) {
    error(`${label} – érvénytelen nehézség: ${q.difficulty}`);
  }
  for (const answer of q.answers) {
    if (!answer || !answer.trim()) error(`${label} – üres válasz.`);
  }

  // Válaszok páronként különbözőek
  const normalizedAnswers = q.answers.map(normalize);
  if (new Set(normalizedAnswers).size !== normalizedAnswers.length) {
    error(`${label} – ismétlődő válasz: ${JSON.stringify(q.answers)}`);
  }

  // Duplikátum a kategórián belül
  const dupeKey = `${q.category}|${normalize(q.question)}`;
  if (seenPerCategory.has(dupeKey)) {
    error(`${label} – duplikált kérdés (már szerepel: „${seenPerCategory.get(dupeKey)}”)`);
  } else {
    seenPerCategory.set(dupeKey, q.question);
  }

  // Azonosító-ütközés (ez sose fordulhat elő, de ha mégis, elveszne egy kérdés)
  if (seenIDs.has(q.id)) {
    error(`${label} – azonosító-ütközés: ${q.id}`);
  } else {
    seenIDs.set(q.id, q.question);
  }

  // Azonos válaszhalmaz + hasonló kérdés = valószínűleg ugyanaz a tény
  const answerHash = [...normalizedAnswers].sort().join('|');
  const answerKey = `${q.category}|${answerHash}`;
  if (!answerSetsPerCategory.has(answerKey)) answerSetsPerCategory.set(answerKey, []);
  answerSetsPerCategory.get(answerKey).push(q);

  // A kérdés ne tartalmazza szó szerint a helyes választ.
  //
  // Kivétel a „kakukktojás” típus: ott a kérdés műfajilag felsorolja az összes
  // elemet, tehát szükségszerűen tartalmazza a helyes választ is. Ez nem hiba,
  // mert nem ad ingyen pontot – épp a felsorolásból kell kiválasztani.
  const correctNorm = normalizedAnswers[q.correct] ?? '';
  if (
    q.topic !== 'kakukktojás' &&
    correctNorm.length >= 8 &&
    normalize(q.question).includes(correctNorm)
  ) {
    error(`${label} – a kérdés tartalmazza a helyes választ: „${q.answers[q.correct]}”`);
  }

  // Magyarázat
  if (!q.explanation || !q.explanation.trim()) {
    warn(`${label} – nincs magyarázat.`);
  } else if (q.explanation.length > 400) {
    warn(`${label} – a magyarázat túl hosszú (${q.explanation.length}).`);
  }

  // Gyanús válaszlehetőségek: meta-szöveg a válaszban
  const suspicious = /(nincs ilyen|mindkett[őo] helyes|egyik sem|a fenti|lásd|helyett)/i;
  for (const answer of q.answers) {
    if (suspicious.test(answer) && answer.length > 18) {
      warn(`${label} – gyanús válaszlehetőség: „${answer}”`);
    }
  }
}

/**
 * Jaccard-hasonlóság a normalizált szóhalmazokon.
 * Az azonos válaszhalmaz önmagában nem jelent duplikátumot (pl. „Hány játékos
 * van egy röplabda-/kézilabdacsapatban?” ugyanazokat a számokat kínálja), ezért
 * csak akkor jelzünk, ha a kérdés szövege is hasonlít.
 */
function similarity(a, b) {
  const setA = new Set(normalize(a).split(' ').filter(Boolean));
  const setB = new Set(normalize(b).split(' ').filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

const SIMILARITY_WARN_THRESHOLD = 0.55;

for (const [key, group] of answerSetsPerCategory) {
  if (group.length < 2) continue;
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const score = similarity(group[i].question, group[j].question);
      if (score >= SIMILARITY_WARN_THRESHOLD) {
        warn(
          `Azonos válaszhalmaz és hasonló kérdés (${key.split('|')[0]}, ` +
          `hasonlóság ${score.toFixed(2)}):\n` +
          `    - ${group[i].question}\n    - ${group[j].question}`
        );
      }
    }
  }
}

// Kategórián belüli közel-duplikátumok.
//
// A puszta szöveghasonlóság itt félrevezet: a sablonból generált kérdések
// mind ugyanazzal a tővel kezdődnek („Melyik évtizedben lett független X?”),
// tehát a trigram-hasonlóságuk magas, pedig teljesen más kérdések – Szudán és
// Dél-Szudán nem ugyanaz. Ha csak a szöveget nézzük, 45 hamis figyelmeztetés
// keletkezik, ami elnyomja az igaziakat.
//
// Ezért a hasonlóság MELLETT azt is megköveteljük, hogy a HELYES VÁLASZ is
// egyezzen. Két kérdés akkor duplikátum, ha ugyanazt kérdezi ÉS ugyanaz a
// megoldása; ha a válasz más, akkor a játékosnak más tudás kell hozzá.
for (const [slug, items] of byCategory) {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const score = similarity(items[i].question, items[j].question);
      if (score < 0.8) continue;

      const correctI = normalize(String(items[i].answers?.[items[i].correct] ?? ''));
      const correctJ = normalize(String(items[j].answers?.[items[j].correct] ?? ''));
      if (correctI && correctI !== correctJ) continue;

      warn(
        `Közel-duplikátum (${slug}, hasonlóság ${score.toFixed(2)}, ugyanaz a válasz):\n` +
        `    - ${items[i].question}\n    - ${items[j].question}`
      );
    }
  }
}

// ─────────────────────── 3. Statisztikai szabályok ───────────────────────

const positionHistogram = [0, 0, 0, 0];
for (const q of questions) {
  if (q.correct >= 0 && q.correct <= 3) positionHistogram[q.correct]++;
}
positionHistogram.forEach((count, index) => {
  const ratio = count / questions.length;
  if (ratio < 0.15 || ratio > 0.35) {
    error(
      `A helyes válasz pozíciójának szórása egyenetlen: ${index}. pozíció ${(ratio * 100).toFixed(1)}%`
    );
  }
});

let longestIsCorrect = 0;
let comparable = 0;
for (const q of questions) {
  if (q.answers.length !== 4) continue;
  comparable++;
  const lengths = q.answers.map((a) => a.length);
  const max = Math.max(...lengths);
  if (lengths[q.correct] === max && lengths.filter((l) => l === max).length === 1) {
    longestIsCorrect++;
  }
}
const longestRatio = longestIsCorrect / Math.max(comparable, 1);
if (longestRatio > 0.45) {
  error(`A helyes válasz túl gyakran a leghosszabb: ${(longestRatio * 100).toFixed(1)}%`);
} else if (longestRatio > 0.38) {
  warn(`A helyes válasz gyakran a leghosszabb: ${(longestRatio * 100).toFixed(1)}%`);
}

const difficultyHistogram = { easy: 0, medium: 0, hard: 0 };
for (const q of questions) {
  if (q.difficulty in difficultyHistogram) difficultyHistogram[q.difficulty]++;
}
for (const [level, count] of Object.entries(difficultyHistogram)) {
  if (count < 30) error(`Túl kevés „${level}” nehézségű kérdés: ${count}`);
}

const withExplanation = questions.filter((q) => q.explanation && q.explanation.trim()).length;
const explanationRatio = withExplanation / questions.length;
if (explanationRatio < 0.9) {
  error(`Csak a kérdések ${(explanationRatio * 100).toFixed(1)}%-ánál van magyarázat (90% kell).`);
}

// ─────────────────────── Összegzés ───────────────────────

console.log('── Seed validáció ─────────────────────────────');
console.log(`Kérdés összesen:      ${questions.length}`);
console.log(`Kategória (feltöltve): ${byCategory.size} / ${categories.length}`);
console.log(
  `Nehézség:             easy ${difficultyHistogram.easy}, ` +
  `medium ${difficultyHistogram.medium}, hard ${difficultyHistogram.hard}`
);
console.log(
  `Helyes index szórása: ` +
  positionHistogram.map((c, i) => `${i}: ${((c / questions.length) * 100).toFixed(1)}%`).join('  ')
);
console.log(`Magyarázat:           ${(explanationRatio * 100).toFixed(1)}%`);
console.log(`„Leghosszabb a jó”:   ${(longestRatio * 100).toFixed(1)}%`);
console.log('');

console.log('Kategóriánként:');
for (const category of categories) {
  const count = byCategory.get(category.slug)?.length ?? 0;
  const flag = MVP_CATEGORIES.includes(category.slug)
    ? (count >= MIN_PER_MVP_CATEGORY ? 'ok' : 'HIÁNYOS')
    : 'extra';
  console.log(`  ${category.slug.padEnd(20)} ${String(count).padStart(4)}  ${flag}`);
}
console.log('');

if (warnings.length) {
  console.log(`⚠ ${warnings.length} figyelmeztetés:`);
  for (const message of warnings) console.log(`  - ${message}`);
  console.log('');
}

if (errors.length) {
  console.error(`✗ ${errors.length} hiba:`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}

if (STRICT && warnings.length) {
  console.error('✗ --strict mód: a figyelmeztetések is hibának számítanak.');
  process.exit(1);
}

console.log('✓ A seed érvényes.');
