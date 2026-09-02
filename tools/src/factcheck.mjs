#!/usr/bin/env node
// Kérdésjelöltek automatikus ellenőrzése három szinten.
//
// 1. FORMAI (mindig fut, nincs hálózat): 4 különböző válasz, érvényes index,
//    nincs metaszöveg, a kérdés nem tartalmazza a választ, nincs elavuló
//    megfogalmazás. Ez nem tényellenőrzés, csak szűrő.
//
// 2. WIKIDATA (ha a `source` egy Q-azonosító vagy Wikidata URI): lekérjük az
//    entitást, és megnézzük, hogy a helyes válasz szerepel-e a címkéi,
//    aliasai vagy a hivatkozott property értékei között.
//    Eredmény: verified / contradicted / inconclusive.
//
// 3. LLM CROSS-CHECK (opcionális, --llm): egy második modellhívás megpróbálja
//    megválaszolni a kérdést. Ez NEM bizonyíték – csak prioritási jel: ha a
//    modell mást válaszol, a kérdés a review sor elejére kerül.
//
// Használat:
//   node tools/src/factcheck.mjs --status pending_review --limit 100
//   node tools/src/factcheck.mjs --file content/generated/wd.json
//   node tools/src/factcheck.mjs --status pending_review --llm

import { readFileSync } from 'node:fs';
import { normalize } from './seed-lib.mjs';
import { SupabaseAdmin, loadEnv } from './supabase-client.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const USER_AGENT = 'TudasKerek-FactChecker/1.0 (quiz question verification)';

// ───────────────────────── 1. formai ellenőrzés ─────────────────────────

export function formalCheck(q) {
  const problems = [];
  const answers = q.answers ?? [q.answer_a, q.answer_b, q.answer_c, q.answer_d];
  const correctIndex = q.correct_index ?? q.correct_answer;
  const text = q.question ?? q.question_text ?? '';

  if (!Array.isArray(answers) || answers.length !== 4) {
    problems.push('nem 4 válasz');
    return problems;
  }
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) {
    problems.push('érvénytelen helyes index');
  }
  if (text.length < 8 || text.length > 400) problems.push('a kérdés hossza nem megfelelő');

  const normalized = answers.map(normalize);
  if (new Set(normalized).size !== 4) {
    problems.push('a válaszok normalizálva nem különböznek');
  }
  for (const answer of answers) {
    if (!answer || !String(answer).trim()) problems.push('üres válasz');
    if (/(mindkett|egyik sem|a fenti|az összes|mindegyik helyes)/i.test(String(answer))) {
      problems.push(`metaszöveg a válaszban: „${answer}”`);
    }
  }

  const correct = normalized[correctIndex] ?? '';
  if (correct.length >= 8 && normalize(text).includes(correct)) {
    problems.push('a kérdés tartalmazza a helyes választ');
  }

  const lengths = answers.map((a) => String(a).length);
  const max = Math.max(...lengths);
  const min = Math.min(...lengths);
  if (lengths[correctIndex] === max && max > min * 2.2) {
    problems.push('a helyes válasz feltűnően a leghosszabb');
  }

  if (/(jelenleg|napjainkban|manapság)/i.test(text)) {
    problems.push('elavuló megfogalmazás');
  }
  // Kettős tagadás nehezen érthető
  if (/\bnem\b[^.?]*\bnem\b/i.test(text)) {
    problems.push('kettős tagadás a kérdésben');
  }

  return problems;
}

// ───────────────────────── 2. Wikidata ellenőrzés ─────────────────────────

/** Kinyeri a Q-azonosítót a `source` mezőből, ha van benne. */
export function extractQid(source) {
  if (!source) return null;
  const match = String(source).match(/\b(Q\d{1,12})\b/);
  return match ? match[1] : null;
}

const entityCache = new Map();

async function fetchEntity(qid) {
  if (entityCache.has(qid)) return entityCache.get(qid);

  const url = `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`;
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`Wikidata ${qid}: HTTP ${response.status}`);
  const data = await response.json();
  const entity = data.entities?.[qid];
  entityCache.set(qid, entity);
  return entity;
}

/** Egy entitás összes emberi olvasható „értéke”: címkék, aliasok, állítások címkéi. */
async function collectEntityStrings(entity, depth = 1) {
  const strings = new Set();
  if (!entity) return strings;

  for (const label of Object.values(entity.labels ?? {})) strings.add(label.value);
  for (const aliasList of Object.values(entity.aliases ?? {})) {
    for (const alias of aliasList) strings.add(alias.value);
  }

  // Az állítások értékei: számok/dátumok közvetlenül, entitások egy szinttel mélyebben.
  const linked = [];
  for (const claims of Object.values(entity.claims ?? {})) {
    for (const claim of claims) {
      const value = claim.mainsnak?.datavalue?.value;
      if (value === undefined) continue;
      if (typeof value === 'string') strings.add(value);
      else if (value.amount) strings.add(String(Number(value.amount)));
      else if (value.time) {
        // "+1526-08-29T00:00:00Z" → 1526 és 1526-08-29
        const match = String(value.time).match(/^\+?(-?\d{1,4})-(\d{2})-(\d{2})/);
        if (match) {
          strings.add(match[1].replace(/^0+/, ''));
          strings.add(`${match[1]}-${match[2]}-${match[3]}`);
        }
      } else if (value.id && depth > 0) {
        linked.push(value.id);
      }
    }
  }

  // A hivatkozott entitások címkéit is behúzzuk (egy szint) – ettől lesz
  // ellenőrizhető a „Ki írta X-et?” típusú kérdés.
  //
  // Egyetlen `wbgetentities` hívással akár 50 entitás címkéjét megkapjuk.
  // (Egyenként kérve egy ország-entitás ellenőrzése is percekig tartana.)
  if (depth > 0 && linked.length) {
    // Nem vághatjuk le vaktában az első 50-nél: egy ország-entitásnak több száz
    // állítása van, és a keresett property (pl. P36 főváros) simán lehet a
    // százas tartományban. Ezért dedupe + több batch.
    const unique = [...new Set(linked)].slice(0, 150);
    for (let start = 0; start < unique.length; start += 50) {
      const labels = await fetchLabels(unique.slice(start, start + 50));
      for (const label of labels) strings.add(label);
    }
  }

  return strings;
}

/** Több entitás címkéje és aliasa egyetlen kérésben (max 50 azonosító). */
const labelCache = new Map();

async function fetchLabels(qids) {
  const missing = qids.filter((qid) => !labelCache.has(qid));
  if (missing.length) {
    const url =
      'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*' +
      `&props=labels|aliases&languages=hu|en&ids=${missing.slice(0, 50).join('|')}`;
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (response.ok) {
        const data = await response.json();
        for (const [qid, entity] of Object.entries(data.entities ?? {})) {
          const values = new Set();
          for (const label of Object.values(entity.labels ?? {})) values.add(label.value);
          for (const aliasList of Object.values(entity.aliases ?? {})) {
            for (const alias of aliasList) values.add(alias.value);
          }
          labelCache.set(qid, values);
        }
      }
    } catch {
      // hálózati hiba: a hiányzó címkék nélkül is tudunk dönteni (inconclusive)
    }
    for (const qid of missing) if (!labelCache.has(qid)) labelCache.set(qid, new Set());
  }

  const out = [];
  for (const qid of qids) {
    for (const value of labelCache.get(qid) ?? []) out.push(value);
  }
  return out;
}

/**
 * @returns {Promise<{verdict: 'verified'|'contradicted'|'inconclusive', detail: string}>}
 */
export async function wikidataCheck(q) {
  const source = q.source;
  const qid = extractQid(source);
  if (!qid) {
    return { verdict: 'inconclusive', detail: 'nincs Wikidata azonosító a forrásban' };
  }

  let entity;
  try {
    entity = await fetchEntity(qid);
  } catch (error) {
    return { verdict: 'inconclusive', detail: error.message };
  }
  if (!entity) {
    return { verdict: 'inconclusive', detail: `${qid} nem található` };
  }

  const strings = await collectEntityStrings(entity);
  const haystack = new Set([...strings].map(normalize).filter(Boolean));

  const answers = q.answers ?? [q.answer_a, q.answer_b, q.answer_c, q.answer_d];
  const correctIndex = q.correct_index ?? q.correct_answer;
  const correct = normalize(answers[correctIndex]);

  const contains = (needle) =>
    haystack.has(needle) || [...haystack].some((value) => value.includes(needle) && needle.length >= 4);

  const correctFound = contains(correct);
  const wrongFound = answers
    .map((a, i) => ({ value: normalize(a), index: i }))
    .filter(({ index }) => index !== correctIndex)
    .filter(({ value }) => contains(value));

  if (correctFound && wrongFound.length === 0) {
    return { verdict: 'verified', detail: `${qid} megerősíti a helyes választ` };
  }
  if (!correctFound && wrongFound.length > 0) {
    return {
      verdict: 'contradicted',
      detail: `${qid} nem tartalmazza a helyes választ, de tartalmaz hibásat: ` +
        wrongFound.map((w) => answers[w.index]).join(', ')
    };
  }
  if (correctFound && wrongFound.length > 0) {
    return {
      verdict: 'inconclusive',
      detail: `${qid} a helyes és a hibás választ is tartalmazza (nem eldönthető)`
    };
  }
  return { verdict: 'inconclusive', detail: `${qid} egyik választ sem tartalmazza` };
}

// ───────────────────────── 3. LLM cross-check ─────────────────────────

async function llmCrossCheck(questions) {
  const env = loadEnv();
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) {
    console.warn('⚠ Nincs ANTHROPIC_API_KEY – az LLM cross-check kimarad.');
    return new Map();
  }
  if (env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  if (env.ANTHROPIC_AUTH_TOKEN) process.env.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN;

  const [{ default: Anthropic }, { z }, { zodOutputFormat }] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('zod'),
    import('@anthropic-ai/sdk/helpers/zod')
  ]);

  const client = new Anthropic();
  const Schema = z.object({
    answers: z.array(
      z.object({
        index: z.number().describe('A kérdés sorszáma a listában, 1-től.'),
        chosen: z.number().describe('A választott válasz indexe: 0, 1, 2 vagy 3.'),
        confidence: z.enum(['low', 'medium', 'high'])
      })
    )
  });

  const results = new Map();
  const CHUNK = 15;

  for (let start = 0; start < questions.length; start += CHUNK) {
    const slice = questions.slice(start, start + CHUNK);
    const listing = slice
      .map((q, i) => {
        const answers = q.answers ?? [q.answer_a, q.answer_b, q.answer_c, q.answer_d];
        return `${i + 1}. ${q.question ?? q.question_text}\n` +
          answers.map((a, j) => `   [${j}] ${a}`).join('\n');
      })
      .join('\n\n');

    const response = await client.messages.parse({
      model: 'claude-opus-5',
      max_tokens: 8000,
      system:
        'Kvízkérdéseket ellenőrzöl. Minden kérdésnél válaszd ki azt a lehetőséget, ' +
        'amelyet tényszerűen helyesnek tartasz. Ne találgass magabiztosan: ha nem vagy ' +
        'biztos, jelöld low confidence-szel. Csak a megadott indexek közül válassz.',
      thinking: { type: 'adaptive' },
      output_config: { format: zodOutputFormat(Schema) },
      messages: [{ role: 'user', content: listing }]
    });

    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      console.warn('⚠ Az LLM cross-check egy csoportnál nem adott választ.');
      continue;
    }

    for (const item of response.parsed_output.answers) {
      const question = slice[item.index - 1];
      if (question) {
        results.set(question, { chosen: item.chosen, confidence: item.confidence });
      }
    }
    console.log(`  LLM cross-check: ${Math.min(start + CHUNK, questions.length)}/${questions.length}`);
  }

  return results;
}

// ───────────────────────── fő folyamat ─────────────────────────

async function main() {
  const file = arg('file');
  const status = arg('status', 'pending_review');
  const limit = Number(arg('limit', '100'));

  let questions;
  let db = null;

  if (file) {
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    questions = (payload.questions ?? payload).slice(0, limit);
  } else {
    db = SupabaseAdmin.fromEnv(loadEnv());
    questions = await db.select(
      'question_candidates',
      `select=id,question_text,answer_a,answer_b,answer_c,answer_d,correct_answer,` +
      `difficulty,explanation,source,topic,status&status=eq.${status}&limit=${limit}`
    );
  }

  console.log('── Fact-check ─────────────────────────────────');
  console.log(`Kérdés: ${questions.length}${file ? ` (fájl: ${file})` : ` (status=${status})`}`);
  console.log('');

  const report = [];

  for (const [index, q] of questions.entries()) {
    const problems = formalCheck(q);
    const wikidata = await wikidataCheck(q);

    let verdict = 'ok';
    if (problems.length > 0) verdict = 'formal_error';
    else if (wikidata.verdict === 'contradicted') verdict = 'contradicted';
    else if (wikidata.verdict === 'verified') verdict = 'verified';

    report.push({ q, problems, wikidata, verdict });

    if ((index + 1) % 20 === 0) {
      console.log(`  ${index + 1}/${questions.length} feldolgozva`);
    }
    // A Wikidata API-t ne terheljük
    if (extractQid(q.source)) await new Promise((r) => setTimeout(r, 200));
  }

  // Opcionális LLM cross-check csak azokra, ahol nincs formai hiba
  if (flag('llm')) {
    const candidates = report.filter((r) => r.problems.length === 0).map((r) => r.q);
    console.log(`\nLLM cross-check ${candidates.length} kérdésre…`);
    const crossCheck = await llmCrossCheck(candidates);
    for (const entry of report) {
      const result = crossCheck.get(entry.q);
      if (!result) continue;
      const correctIndex = entry.q.correct_index ?? entry.q.correct_answer;
      entry.llm = result;
      if (result.chosen !== correctIndex && result.confidence !== 'low') {
        entry.verdict = 'flagged';
      }
    }
  }

  // ── összegzés ──
  const counts = {};
  for (const entry of report) counts[entry.verdict] = (counts[entry.verdict] ?? 0) + 1;

  console.log('\nEredmény:');
  for (const [verdict, count] of Object.entries(counts)) {
    console.log(`  ${verdict.padEnd(16)} ${count}`);
  }

  const problematic = report.filter((r) => r.verdict !== 'ok' && r.verdict !== 'verified');
  if (problematic.length) {
    console.log('\nEllenőrzésre javasolt:');
    for (const entry of problematic.slice(0, 25)) {
      const text = entry.q.question ?? entry.q.question_text;
      console.log(`\n  [${entry.verdict}] ${text}`);
      if (entry.problems.length) console.log(`    formai: ${entry.problems.join(', ')}`);
      if (entry.wikidata.verdict !== 'inconclusive' || entry.wikidata.detail) {
        console.log(`    wikidata: ${entry.wikidata.verdict} – ${entry.wikidata.detail}`);
      }
      if (entry.llm) {
        const answers = entry.q.answers ?? [entry.q.answer_a, entry.q.answer_b, entry.q.answer_c, entry.q.answer_d];
        console.log(
          `    llm: „${answers[entry.llm.chosen]}” (${entry.llm.confidence}) ` +
          `– a jelölt szerint: „${answers[entry.q.correct_index ?? entry.q.correct_answer]}”`
        );
      }
    }
  }

  // ── visszaírás az adatbázisba ──
  if (db) {
    console.log('\nValidációs eredmény mentése…');
    for (const entry of report) {
      const validation = {
        verdict: entry.verdict === 'contradicted' || entry.verdict === 'formal_error' ? 'error'
          : entry.verdict === 'flagged' ? 'flagged'
          : 'ok',
        formal: entry.problems,
        wikidata: entry.wikidata,
        llm: entry.llm ?? null,
        checked_at: new Date().toISOString()
      };
      const quality =
        entry.verdict === 'verified' ? 0.95
        : entry.verdict === 'ok' ? 0.75
        : entry.verdict === 'flagged' ? 0.4
        : 0.1;

      const patch = { validation, quality_score: quality };
      if (entry.verdict === 'flagged' || entry.verdict === 'contradicted') {
        patch.status = 'flagged';
      }
      await db.update('question_candidates', `id=eq.${entry.q.id}`, patch);
    }
    console.log('✓ Mentve.');
  }
}

// Csak közvetlen futtatáskor
if (process.argv[1]?.endsWith('factcheck.mjs')) {
  main().catch((error) => {
    console.error(`\n✗ ${error.message}`);
    process.exit(1);
  });
}
