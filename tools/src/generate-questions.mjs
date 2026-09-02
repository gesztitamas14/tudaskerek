#!/usr/bin/env node
// AI-alapú kérdésgenerálás a Claude API-val.
//
// FONTOS SZABÁLY: a generált kérdés SOHA nem kerül közvetlenül a `questions`
// táblába. A `question_candidates` táblába írunk `pending_review` állapotban,
// és csak az `approve_candidate()` SQL függvény (moderátori jogosultsággal)
// emeli át a production bankba.
//
// Használat:
//   node tools/src/generate-questions.mjs --category magyar-tortenelem \
//        --topic "1848-49-es szabadságharc" --count 40
//
//   node tools/src/generate-questions.mjs --plan content/generation-plan.json
//   node tools/src/generate-questions.mjs ... --out content/generated/xyz.json
//        (fájlba ír a Supabase helyett – így backend nélkül is kipróbálható)
//
// Előfeltétel: npm install (a @anthropic-ai/sdk és a zod miatt) és
// ANTHROPIC_API_KEY a tools/.env fájlban.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import { loadEnv, SupabaseAdmin } from './supabase-client.mjs';
import { loadCategories, loadSeedQuestions, normalize } from './seed-lib.mjs';

// ─────────────────────────── paraméterek ───────────────────────────

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const MODEL = arg('model', 'claude-opus-5');
/** Egy kérésben ennyi kérdést kérünk. Kisebb batch = jobb minőség, több hívás. */
const BATCH = Number(arg('batch', '12'));

// ─────────────────────────── séma ───────────────────────────
//
// A strukturált kimenet garantálja, hogy a modell pontosan ezt a formát adja –
// nem kell JSON-t „kihalászni” a szövegből.

const QuestionSchema = z.object({
  question: z.string().describe('A kérdés szövege magyarul, kérdőjellel.'),
  answers: z.array(z.string()).describe('Pontosan 4 válaszlehetőség.'),
  correct_index: z.number().describe('A helyes válasz indexe: 0, 1, 2 vagy 3.'),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  explanation: z.string().describe('1-2 mondatos magyarázat, ami megerősíti a helyes választ.'),
  source: z.string().describe('Ellenőrizhető hivatkozás: magyar Wikipédia-cikk címe vagy Wikidata Q-azonosító.'),
  topic: z.string().describe('A konkrét témakör a kategórián belül.')
});

const BatchSchema = z.object({
  questions: z.array(QuestionSchema)
});

// ─────────────────────────── prompt ───────────────────────────

const SYSTEM_PROMPT = `Magyar kvízkérdéseket írsz egy általános műveltségi mobiljátékhoz.

MINŐSÉGI KÖVETELMÉNYEK

1. Tényszerűség. Csak olyan tényt írj le, amiben biztos vagy, és amit meg lehet
   nézni a magyar Wikipédián vagy a Wikidatában. Ha egy adatban nem vagy biztos,
   ne írd meg a kérdést – írj helyette másikat.

2. Egyértelműség. Pontosan egy válasz lehet helyes. A másik három legyen
   világosan hibás, de hihető: ugyanabból a kategóriából, hasonló típusú és
   hasonló hosszúságú.

3. Ne legyen kitalálható. A helyes válasz ne legyen feltűnően a leghosszabb,
   és a kérdés ne tartalmazza szó szerint a helyes választ.

4. Természetes magyar nyelv. Ne fordítás hatását keltse. Használj magyar
   névsorrendet (Petőfi Sándor), magyar helyesírást és magyar számformátumot.

5. Ne legyen elavuló. Kerüld a „jelenleg”, „napjainkban”, „a világ legjobbja”
   típusú megfogalmazásokat, ha az idővel változhat. Ha aktuális tényre
   kérdezsz, tedd bele az évet a kérdésbe.

6. Ne legyen túl niche. A nehéz kérdés is olyan legyen, amit egy művelt, sokat
   olvasó ember ismerhet – ne szakdolgozat-szintű részlet.

7. Kerüld a tagadó („Melyik NEM…”) kérdéseket, kivéve ha kifejezetten kérik.

8. A válaszlehetőségek soha ne tartalmazzanak metaszöveget: nincs „mindkettő
   helyes”, „egyik sem”, „a fenti közül”, és nincs magyarázat a válaszban.

9. A négy válasz normalizált alakja (kisbetű, ékezet nélkül, írásjel nélkül) is
   legyen különböző. Ezért ne állíts szembe olyan válaszokat, amelyek csak
   ékezetben vagy szóközben térnek el – ilyen helyesírási kérdést ne is írj.

10. A magyarázat legyen rövid, tárgyilagos, és erősítse meg, MIÉRT az a helyes
    válasz. Ne ismételje meg a kérdést.

NEHÉZSÉG
- easy: az általános iskolát befejező többség tudja.
- medium: érettségizett, olvasott ember jó eséllyel tudja.
- hard: érdeklődő, tájékozott ember tudja, de gondolkodni kell rajta.

A kért mennyiség kb. 30% easy, 50% medium, 20% hard legyen.`;

function buildUserPrompt({ categoryName, topic, count, avoid }) {
  const avoidBlock = avoid.length
    ? `\n\nMÁR LÉTEZŐ KÉRDÉSEK – ezekhez hasonlót NE írj (sem ugyanarra a tényre kérdezve más szavakkal):\n` +
      avoid.map((text) => `- ${text}`).join('\n')
    : '';

  return `Kategória: ${categoryName}
Témakör: ${topic}
Kért kérdésszám: ${count}

Írj ${count} különböző kvízkérdést. Mindegyik más tényre kérdezzen rá – a témakörön belül
terítsd szét őket (különböző évszámok, személyek, események, fogalmak).${avoidBlock}`;
}

// ─────────────────────────── generálás ───────────────────────────

async function generateBatch(client, { categoryName, topic, count, avoid }) {
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    // Kvízkérdés-írásnál a tényellenőrzés a lényeg – hagyjuk gondolkodni.
    thinking: { type: 'adaptive' },
    output_config: {
      format: zodOutputFormat(BatchSchema)
    },
    messages: [
      { role: 'user', content: buildUserPrompt({ categoryName, topic, count, avoid }) }
    ]
  });

  // Biztonsági osztályozó elutasíthatja a kérést (HTTP 200, stop_reason=refusal).
  // Kvízkérdésnél ez gyakorlatilag nem fordul elő, de nem olvasunk tartalmat
  // ellenőrzés nélkül. Ha szükséges, a szerveroldali `fallbacks` paraméterrel
  // automatikus modellváltás is beállítható (lásd docs/04-kerdesforrasok.md).
  if (response.stop_reason === 'refusal') {
    throw new Error(
      `A modell elutasította a kérést (${response.stop_details?.category ?? 'ismeretlen'}). ` +
      'Fogalmazd át a témakört.'
    );
  }

  if (!response.parsed_output) {
    throw new Error('A strukturált kimenet nem értelmezhető.');
  }

  return {
    questions: response.parsed_output.questions,
    usage: response.usage
  };
}

// ─────────────────────────── formai szűrés ───────────────────────────
//
// Amit a szkript maga ki tud szűrni, azt ne terheljük a review sorra.

function screen(question, { seenNormalized }) {
  const problems = [];

  if (!Array.isArray(question.answers) || question.answers.length !== 4) {
    problems.push('nem 4 válasz');
  }
  if (!Number.isInteger(question.correct_index) || question.correct_index < 0 || question.correct_index > 3) {
    problems.push('érvénytelen helyes index');
  }
  if (!question.question || question.question.length < 8 || question.question.length > 400) {
    problems.push('a kérdés hossza nem megfelelő');
  }

  if (Array.isArray(question.answers) && question.answers.length === 4) {
    const normalized = question.answers.map(normalize);
    if (new Set(normalized).size !== 4) {
      problems.push('a válaszok normalizálva nem különböznek');
    }
    for (const answer of question.answers) {
      if (!answer || !answer.trim()) problems.push('üres válasz');
      if (/(mindkett|egyik sem|a fenti|az összes|mindegyik helyes)/i.test(answer)) {
        problems.push(`metaszöveg a válaszban: „${answer}”`);
      }
    }

    const correct = normalized[question.correct_index] ?? '';
    if (correct.length >= 8 && normalize(question.question).includes(correct)) {
      problems.push('a kérdés tartalmazza a helyes választ');
    }

    const lengths = question.answers.map((a) => a.length);
    const max = Math.max(...lengths);
    if (lengths[question.correct_index] === max && max > Math.min(...lengths) * 2.2) {
      problems.push('a helyes válasz feltűnően a leghosszabb');
    }
  }

  if (!question.explanation || question.explanation.length < 10) {
    problems.push('nincs érdemi magyarázat');
  }
  if (/(jelenleg|napjainkban|manapság|most a legjobb)/i.test(question.question)) {
    problems.push('elavuló megfogalmazás („jelenleg”, „napjainkban”)');
  }

  const key = normalize(question.question);
  if (seenNormalized.has(key)) {
    problems.push('duplikátum a mostani generálásban');
  } else {
    seenNormalized.add(key);
  }

  return problems;
}

// ─────────────────────────── fő folyamat ───────────────────────────

async function runTask(client, task, context) {
  const { categorySlug, topic, count } = task;
  const category = context.categories.find((c) => c.slug === categorySlug);
  if (!category) throw new Error(`Ismeretlen kategória: ${categorySlug}`);

  // A már létező kérdésekből mintát adunk a promptba, hogy ne írja meg újra
  // ugyanazt. Nem az összeset: az fölöslegesen nagy prompt lenne.
  const existing = context.existingByCategory.get(categorySlug) ?? [];
  const avoidPool = existing.filter((text) =>
    !topic || normalize(text).includes(normalize(topic).split(' ')[0] ?? '')
  );
  const avoid = (avoidPool.length >= 10 ? avoidPool : existing).slice(0, 40);

  const accepted = [];
  const rejected = [];
  const seenNormalized = new Set(existing.map(normalize));
  let totalInput = 0;
  let totalOutput = 0;

  let remaining = count;
  let round = 0;
  while (remaining > 0 && round < Math.ceil(count / BATCH) + 2) {
    round++;
    const ask = Math.min(BATCH, remaining + 2);
    process.stdout.write(`  [${categorySlug} / ${topic}] ${round}. kör – ${ask} kérdés kérése… `);

    const { questions, usage } = await generateBatch(client, {
      categoryName: category.name,
      topic,
      count: ask,
      avoid: [...avoid, ...accepted.map((q) => q.question)].slice(0, 60)
    });

    totalInput += usage?.input_tokens ?? 0;
    totalOutput += usage?.output_tokens ?? 0;

    let ok = 0;
    for (const question of questions) {
      const problems = screen(question, { seenNormalized });
      if (problems.length === 0) {
        accepted.push({ ...question, category: categorySlug });
        ok++;
        remaining--;
        if (remaining <= 0) break;
      } else {
        rejected.push({ question: question.question, problems });
      }
    }
    console.log(`${ok} elfogadva, ${questions.length - ok} elvetve`);
  }

  return { accepted: accepted.slice(0, count), rejected, usage: { totalInput, totalOutput } };
}

async function main() {
  const env = loadEnv();
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error(
      'Nincs ANTHROPIC_API_KEY a környezetben vagy a tools/.env fájlban.\n' +
      'Alternatíva: `ant auth login` – az SDK a profilt is elfogadja.'
    );
  }
  // Az SDK magától felolvassa a környezeti változót; a .env értékeit átadjuk neki.
  if (env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  if (env.ANTHROPIC_AUTH_TOKEN) process.env.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN;

  const client = new Anthropic();

  // ── feladatlista ──
  const planFile = arg('plan');
  let tasks;
  if (planFile) {
    tasks = JSON.parse(readFileSync(planFile, 'utf8'));
  } else {
    const categorySlug = arg('category');
    const topic = arg('topic');
    const count = Number(arg('count', '20'));
    if (!categorySlug || !topic) {
      throw new Error(
        'Add meg a --category és --topic paramétert, vagy használj --plan fájlt.\n' +
        'Példa: node tools/src/generate-questions.mjs --category magyar-tortenelem --topic "Mohács" --count 20'
      );
    }
    tasks = [{ categorySlug, topic, count }];
  }

  // ── kontextus: már létező kérdések (seed + adatbázis) ──
  const categories = loadCategories();
  const { questions: seedQuestions } = loadSeedQuestions({ shuffle: false });
  const existingByCategory = new Map();
  for (const q of seedQuestions) {
    if (!existingByCategory.has(q.category)) existingByCategory.set(q.category, []);
    existingByCategory.get(q.category).push(q.question);
  }

  const outFile = arg('out');
  let db = null;
  if (!outFile) {
    try {
      db = SupabaseAdmin.fromEnv(env);
      // A már adatbázisban lévő kérdéseket is kerüljük.
      for (const task of tasks) {
        const rows = await db.select(
          'questions',
          `select=question_text,categories!inner(slug)&categories.slug=eq.${task.categorySlug}&limit=500`
        );
        const texts = rows.map((r) => r.question_text);
        const list = existingByCategory.get(task.categorySlug) ?? [];
        existingByCategory.set(task.categorySlug, [...new Set([...list, ...texts])]);
      }
    } catch (error) {
      console.warn(`⚠ Supabase nem elérhető (${error.message.split('\n')[0]}).`);
      console.warn('  A generált kérdéseket fájlba írjuk: content/generated/');
      db = null;
    }
  }

  const context = { categories, existingByCategory };

  console.log('── AI kérdésgenerálás ─────────────────────────');
  console.log(`Modell: ${MODEL}`);
  console.log(`Feladat: ${tasks.length}`);
  console.log('');

  const allAccepted = [];
  const allRejected = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (const task of tasks) {
    const result = await runTask(client, task, context);
    allAccepted.push(...result.accepted);
    allRejected.push(...result.rejected);
    inputTokens += result.usage.totalInput;
    outputTokens += result.usage.totalOutput;
  }

  console.log('');
  console.log(`Elfogadva: ${allAccepted.length}, formai szűrőn elvérzett: ${allRejected.length}`);
  // Az árazás a claude-opus-5 listaárán: 5 USD / 1M input, 25 USD / 1M output.
  const cost = (inputTokens / 1e6) * 5 + (outputTokens / 1e6) * 25;
  console.log(
    `Token: ${inputTokens} input, ${outputTokens} output ` +
    `(kb. ${cost.toFixed(2)} USD listaáron)`
  );

  if (allRejected.length) {
    console.log('\nElvetett kérdések (formai szűrő):');
    for (const item of allRejected.slice(0, 20)) {
      console.log(`  - ${item.question.slice(0, 80)}`);
      console.log(`    ${item.problems.join(', ')}`);
    }
  }

  // ── mentés ──
  if (!allAccepted.length) {
    console.log('\nNincs mit mentetni.');
    return;
  }

  const target = outFile ?? (db ? null : `content/generated/${Date.now()}.json`);

  if (target) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ generated_at: new Date().toISOString(), model: MODEL, questions: allAccepted }, null, 2));
    console.log(`\n✓ ${allAccepted.length} kérdés kiírva: ${target}`);
    console.log('  Feltöltés review-ra: node tools/src/upload-candidates.mjs ' + target);
    return;
  }

  await uploadCandidates(db, allAccepted, { model: MODEL, tasks });
}

/** Jelöltek feltöltése a `question_candidates` táblába, review-ra várva. */
export async function uploadCandidates(db, questions, { model, tasks }) {
  const stored = await db.select('categories', 'select=id,slug');
  const idBySlug = new Map(stored.map((row) => [row.slug, row.id]));

  const [batch] = await db.insert('generation_batches', [{
    category_id: idBySlug.get(tasks?.[0]?.categorySlug) ?? null,
    topic: tasks?.map((t) => t.topic).join(', ') ?? null,
    requested: questions.length,
    model,
    notes: 'tools/src/generate-questions.mjs'
  }]);

  const rows = [];
  for (const q of questions) {
    const categoryID = idBySlug.get(q.category);
    if (!categoryID) {
      console.warn(`⚠ Ismeretlen kategória, kihagyva: ${q.category}`);
      continue;
    }

    // Duplikátum-ellenőrzés a szerveren (trigram + válaszhalmaz + forrás).
    const duplicates = await db.rpc('check_question_duplicates', {
      p_category_slug: q.category,
      p_question_text: q.question,
      p_answers: q.answers,
      p_source: q.source ?? null
    });

    rows.push({
      batch_id: batch.id,
      category_id: categoryID,
      question_text: q.question,
      answer_a: q.answers[0],
      answer_b: q.answers[1],
      answer_c: q.answers[2],
      answer_d: q.answers[3],
      correct_answer: q.correct_index,
      difficulty: q.difficulty,
      explanation: q.explanation,
      source: q.source,
      topic: q.topic,
      provenance: 'ai_generated',
      status: 'pending_review',
      duplicates: duplicates ?? [],
      validation: { verdict: 'pending', checked_by: 'generate-questions.mjs' },
      quality_score: (duplicates?.length ?? 0) === 0 ? 0.8 : 0.4
    });
  }

  await db.insert('question_candidates', rows, { returning: 'minimal' });
  console.log(`\n✓ ${rows.length} jelölt feltöltve review-ra (question_candidates).`);
  console.log('  Nyisd meg az admin felületet a jóváhagyáshoz.');
}

// Csak akkor futtatjuk, ha közvetlenül hívták (import esetén nem).
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
    process.argv[1]?.endsWith('generate-questions.mjs')) {
  main().catch((error) => {
    console.error(`\n✗ ${error.message}`);
    process.exit(1);
  });
}
