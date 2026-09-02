#!/usr/bin/env node
// Kérdésgenerálás Wikidata SPARQL sablonokból.
//
// Miért ez a fő automatizált forrás? Mert a Wikidata **CC0** licencű: nincs
// attribúciós és nincs ShareAlike kötelezettség, tehát a származékos
// kérdésbankunk szabadon használható. (Az OpenTDB CC BY-SA 4.0 – lásd
// docs/04-kerdesforrasok.md.)
//
// A generálás sablonalapú és determinisztikus: nincs benne LLM, ezért nem
// hallucinálhat. A hamis válaszok mindig ugyanabból az entitáshalmazból jönnek,
// mint a helyes – így nem lehet kizárással megoldani a kérdést.
//
// Használat:
//   node tools/src/generate-from-wikidata.mjs --list
//   node tools/src/generate-from-wikidata.mjs --template magyar-telepules-megye --limit 200
//   node tools/src/generate-from-wikidata.mjs --all --limit 100 --out content/generated/wd.json
//   node tools/src/generate-from-wikidata.mjs --all --upload      # egyenesen review-ra

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TEMPLATES } from './wikidata-templates.mjs';
import { normalize, rng, hash32 } from './seed-lib.mjs';
import { SupabaseAdmin, loadEnv } from './supabase-client.mjs';

const ENDPOINT = 'https://query.wikidata.org/sparql';
// A HTTP fejlécek csak ASCII-t (ByteString) fogadnak – ékezetes karakter itt
// futásidejű hibát okoz, ezért a User-Agent szándékosan ékezet nélküli.
const USER_AGENT =
  'TudasKerek-QuizBuilder/1.0 (general-knowledge quiz question generation)';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

// ─────────────────────────── SPARQL ───────────────────────────

async function sparql(query) {
  const url = `${ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
  const response = await fetch(url, {
    headers: { Accept: 'application/sparql-results+json', 'User-Agent': USER_AGENT }
  });
  if (!response.ok) {
    throw new Error(`Wikidata ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const data = await response.json();
  return data.results.bindings.map((row) => {
    const out = {};
    for (const [key, cell] of Object.entries(row)) out[key] = cell.value;
    return out;
  });
}

// ─────────────────────────── generálás ───────────────────────────

/**
 * Egy sablon feldolgozása.
 *
 * A hamis válaszokat a *saját eredményhalmazból* vesszük: minden „answer”
 * érték, ami nem a helyes. Így garantáltan ugyanolyan típusú entitások.
 */
async function runTemplate(template, limit) {
  process.stdout.write(`  ${template.id} … `);
  const rows = await sparql(template.sparql.replace('{{LIMIT}}', String(limit * 3)));
  console.log(`${rows.length} sor`);

  // Az összes lehetséges válasz (a distractor-készlet)
  const answerPool = [...new Set(rows.map((r) => r.answerLabel).filter(Boolean))];
  if (answerPool.length < 4) {
    console.warn(`    ⚠ Túl kevés különböző válasz (${answerPool.length}), kihagyva.`);
    return [];
  }

  const questions = [];
  const seen = new Set();

  for (const row of rows) {
    if (questions.length >= limit) break;
    if (!row.subjectLabel || !row.answerLabel) continue;

    // Egy alany csak egyszer szerepeljen
    const subjectKey = normalize(row.subjectLabel);
    if (seen.has(subjectKey)) continue;

    // Latin írásmódot nem használó vagy hiányos címkék kiszűrése
    if (/^Q\d+$/.test(row.subjectLabel) || /^Q\d+$/.test(row.answerLabel)) continue;

    const correct = row.answerLabel;
    const distractorPool = answerPool.filter(
      (value) => normalize(value) !== normalize(correct)
    );
    if (distractorPool.length < 3) continue;

    // Determinisztikus választás: ugyanaz a bemenet ugyanazt a kérdést adja.
    const random = rng(hash32(`${template.id}|${subjectKey}`));
    const distractors = [];
    const used = new Set();
    let guard = 0;
    while (distractors.length < 3 && guard < 200) {
      guard++;
      const candidate = distractorPool[Math.floor(random() * distractorPool.length)];
      const key = normalize(candidate);
      if (used.has(key)) continue;
      used.add(key);
      distractors.push(candidate);
    }
    if (distractors.length < 3) continue;

    const answers = [correct, ...distractors];
    // Determinisztikus keverés
    for (let i = answers.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [answers[i], answers[j]] = [answers[j], answers[i]];
    }
    const correctIndex = answers.findIndex((a) => normalize(a) === normalize(correct));

    // A normalizált válaszok legyenek különbözőek (a DB is ezt követeli meg)
    if (new Set(answers.map(normalize)).size !== 4) continue;

    const questionText = template.question.replace('{{subject}}', row.subjectLabel);
    if (questionText.length < 8 || questionText.length > 400) continue;
    // A kérdés ne tartalmazza a választ
    if (normalize(questionText).includes(normalize(correct)) && normalize(correct).length >= 8) {
      continue;
    }

    seen.add(subjectKey);
    questions.push({
      category: template.category,
      question: questionText,
      answers,
      correct_index: correctIndex,
      difficulty: template.difficulty,
      explanation: template.explanation
        .replace('{{subject}}', row.subjectLabel)
        .replace('{{answer}}', correct),
      source: row.subject ?? `https://www.wikidata.org/wiki/${template.id}`,
      topic: template.topic,
      provenance: 'wikidata',
      license: 'CC0-1.0'
    });
  }

  console.log(`    → ${questions.length} kérdés`);
  return questions;
}

// ─────────────────────────── fő folyamat ───────────────────────────

async function main() {
  if (flag('list')) {
    console.log('Elérhető sablonok:\n');
    for (const template of TEMPLATES) {
      console.log(`  ${template.id.padEnd(30)} ${template.category.padEnd(20)} ${template.topic}`);
      console.log(`    ${template.question}`);
    }
    return;
  }

  const limit = Number(arg('limit', '100'));
  const only = arg('template');
  const selected = only
    ? TEMPLATES.filter((t) => t.id === only)
    : (flag('all') ? TEMPLATES : []);

  if (selected.length === 0) {
    console.error(
      'Add meg a --template <id> vagy az --all paramétert.\n' +
      'A sablonok listája: node tools/src/generate-from-wikidata.mjs --list'
    );
    process.exit(1);
  }

  console.log('── Wikidata kérdésgenerálás (CC0) ─────────────');
  console.log(`Sablon: ${selected.length}, kérdés/sablon: max ${limit}`);
  console.log('');

  const all = [];
  for (const template of selected) {
    try {
      all.push(...(await runTemplate(template, limit)));
    } catch (error) {
      console.error(`  ✗ ${template.id}: ${error.message.split('\n')[0]}`);
    }
    // A Wikidata Query Service korlátozott – ne terheljük.
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  console.log('');
  console.log(`Összesen ${all.length} kérdés.`);

  if (all.length === 0) return;

  if (flag('upload')) {
    const db = SupabaseAdmin.fromEnv(loadEnv());
    const { uploadCandidates } = await import('./generate-questions.mjs');
    await uploadCandidates(db, all, {
      model: 'wikidata-sparql',
      tasks: selected.map((t) => ({ categorySlug: t.category, topic: t.topic }))
    });
    return;
  }

  const out = arg('out', `content/generated/wikidata-${Date.now()}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      { generated_at: new Date().toISOString(), model: 'wikidata-sparql', questions: all },
      null,
      2
    )
  );
  console.log(`✓ Kiírva: ${out}`);
  console.log('  Feltöltés review-ra: node tools/src/upload-candidates.mjs ' + out);
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}`);
  process.exit(1);
});
