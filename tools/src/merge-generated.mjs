#!/usr/bin/env node
// Generált kérdések beolvasztása a seed fájlokba, duplikátumszűréssel.
//
// Miért kell külön eszköz? Mert a generátorok (`generate-from-wikidata.mjs`,
// `generate-questions.mjs`) a `content/generated/` mappába írnak, a játék
// viszont a `content/seed/<kategoria>.json` fájlokból épül. A kettő között
// szűrni kell:
//
//   1. NE kerüljön be, ami már bent van (normalizált szöveg egyezése) –
//      ugyanaz a szabály, mint az adatbázis `unique (category_id,
//      norm_question)` indexe. Enélkül a `db push` utáni import elhasalna.
//   2. NE kerüljön be, aminek ugyanaz a VÁLASZHALMAZA egy másik kérdésnél –
//      ezek jellemzően ugyanannak a kérdésnek az átfogalmazásai.
//   3. NE kerüljön be, ami nem megy át a szerkezeti szabályokon (négy
//      különböző válasz ékezet nélkül is, hosszkorlátok, a kérdés nem
//      tartalmazza a helyes választ).
//   4. Egy kategória ne nőjön a megadott plafon fölé (`--cap`), hogy a
//      Wikidata-sablonok ne mossák el a kézzel írt kérdéseket.
//
// A szűrés MIÉRT itt van és nem a validátorban? Mert a validátor hibát jelez,
// ez pedig csendben eldob – beolvasztásnál az utóbbi kell, különben egyetlen
// ütköző kérdés megbuktatná a teljes köteget.
//
// Használat:
//   node tools/src/merge-generated.mjs content/generated/*.json
//   node tools/src/merge-generated.mjs content/generated/wd-batch1.json --cap 300
//   node tools/src/merge-generated.mjs content/generated/*.json --dry-run

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SEED_DIR, normalize, loadCategories } from './seed-lib.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const capIndex = args.indexOf('--cap');
const CAP = capIndex >= 0 ? Number(args[capIndex + 1]) : 400;

// EGY TÉMA legfeljebb ennyi részét foglalhatja el a kategóriának.
//
// Ez a legfontosabb szabály, és mérés hozta ki: az első beolvasztás után a
// `film-sorozat` kategória 66%-a „Ki rendezte a…?” kérdés volt, a
// `magyar-zene-film` 80%-a „Ki rendezte ezt a magyar filmet?”. Technikailag
// mind helyes, de a játék így egyhangú. Plafon nélkül egyetlen bőven termő
// sablon elnyomja az összes többit.
const shareIndex = args.indexOf('--topic-share');
const TOPIC_SHARE = shareIndex >= 0 ? Number(args[shareIndex + 1]) : 0.25;

// A kapcsolók ÉRTÉKÉT pozíció szerint zárjuk ki, nem szövegegyezéssel:
// a `--topic-share 0.30` értéke `String(0.3)`-ként „0.3”, tehát a „0.30”
// bemenetnek látszott volna, és a szkript fájlként próbálta megnyitni.
const consumedIndexes = new Set();
for (const index of [capIndex, shareIndex]) {
  if (index >= 0) consumedIndexes.add(index + 1);
}
const inputs = args.filter((a, i) => !a.startsWith('--') && !consumedIndexes.has(i));

if (inputs.length === 0) {
  console.error(
    'Adj meg legalább egy generált JSON fájlt.\n' +
      '  node tools/src/merge-generated.mjs content/generated/wd-batch1.json'
  );
  process.exit(1);
}

// ─────────────────── szerkezeti szabályok ───────────────────
//
// Ugyanazok, amiket a `validate-seed.mjs` és az adatbázis CHECK feltételei
// kényszerítenek ki. Ha ezek közül bármelyik sérül, az import elhasalna.

function structuralProblem(q) {
  const text = q.q ?? '';
  const answers = q.a ?? [];

  if (answers.length !== 4) return 'nem négy válasz';
  if (text.length < 8 || text.length > 400) return 'a kérdés hossza nem 8–400';
  if (answers.some((a) => !a || !String(a).trim())) return 'üres válasz';
  if (answers.some((a) => String(a).length > 120)) return 'túl hosszú válasz';
  if (typeof q.c !== 'number' || q.c < 0 || q.c > 3) return 'érvénytelen helyes index';

  // A négy válasznak ékezet és írásjel nélkül IS különbözőnek kell lennie –
  // különben az adatbázis `questions_answers_distinct` feltétele elhasal.
  const norm = answers.map((a) => normalize(String(a)));
  if (new Set(norm).size !== 4) return 'két válasz normalizálva egyezik';

  // A kérdés ne tartalmazza a helyes választ.
  const normQuestion = normalize(text);
  const normCorrect = norm[q.c];
  if (normCorrect && normCorrect.length >= 4 && normQuestion.includes(normCorrect)) {
    return 'a kérdés tartalmazza a helyes választ';
  }
  return null;
}

/** A válaszhalmaz sorrendtől független ujjlenyomata. */
function answerSetKey(answers) {
  return answers.map((a) => normalize(String(a))).sort().join('|');
}

// ─────────────────── betöltés ───────────────────

const categories = new Set(loadCategories().map((c) => c.slug));

/** A generátorok formátuma → a seed fájlok tömör formátuma. */
function toSeedShape(raw) {
  return {
    q: raw.question ?? raw.q,
    a: raw.answers ?? raw.a,
    c: raw.correct_index ?? raw.correct ?? raw.c,
    d: raw.difficulty ?? raw.d ?? 'medium',
    e: raw.explanation ?? raw.e ?? null,
    t: raw.topic ?? raw.t ?? null,
    s: raw.source ?? raw.s ?? null
  };
}

const incoming = new Map();   // kategória → kérdések
let readCount = 0;

for (const file of inputs) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`Nem olvasható: ${file} – ${error.message}`);
    process.exit(1);
  }
  const list = parsed.questions ?? parsed;
  for (const raw of list) {
    readCount++;
    const slug = raw.category ?? raw.category_slug;
    if (!categories.has(slug)) continue;
    if (!incoming.has(slug)) incoming.set(slug, []);
    incoming.get(slug).push(toSeedShape(raw));
  }
}

console.log(`\n── Beolvasztás ─────────────────────────────────`);
console.log(`Beolvasva: ${readCount} generált kérdés, ${incoming.size} kategóriában`);
console.log(
  `Kategóriánkénti plafon: ${CAP}, egy téma max ${Math.round(TOPIC_SHARE * 100)}%` +
    `${DRY ? '   (PRÓBAFUTÁS, nem írunk fájlt)' : ''}\n`
);

// ─────────────────── beolvasztás kategóriánként ───────────────────

const stats = [];
let totalAdded = 0;
const reasons = new Map();

function countReason(reason) {
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
}

for (const slug of [...incoming.keys()].sort()) {
  const path = join(SEED_DIR, `${slug}.json`);
  let seed;
  try {
    seed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    console.log(`  ${slug.padEnd(22)} nincs seed fájl, kihagyva`);
    continue;
  }

  const existing = seed.questions ?? [];
  const seenText = new Set(existing.map((q) => normalize(q.q)));
  const seenAnswers = new Set(existing.map((q) => answerSetKey(q.a)));

  // A már bent lévő kérdések témái is beleszámítanak a plafonba – a kézzel
  // írtak ugyanúgy, mint a generáltak.
  const topicCount = new Map();
  for (const q of existing) {
    const key = q.t ?? '(nincs téma)';
    topicCount.set(key, (topicCount.get(key) ?? 0) + 1);
  }

  // A plafon a VÉGSŐ kategóriaméretre vonatkozik, nem a jelenlegire – különben
  // egy kis kategóriában az első téma azonnal betelítené magát.
  const topicCap = Math.max(6, Math.round(CAP * TOPIC_SHARE));

  const before = existing.length;
  let added = 0;
  let skippedDuplicate = 0;
  let skippedInvalid = 0;
  let skippedCap = 0;
  let skippedTopic = 0;

  // TÉMÁK KÖRBEJÁRÁSA (round-robin).
  //
  // Ha a beérkező kérdéseket fájlsorrendben dolgozzuk fel, az első téma
  // betölti a saját plafonját, és csak utána jut szóhoz a második – így egy
  // félig telt kategóriában az első téma adja a kérdések felét. Mérve: 48–50%
  // maradt egyetlen témából, pedig volt más is.
  //
  // Témánként egyet-egyet kiszedve az eloszlás automatikusan olyan egyenletes
  // lesz, amilyen a kínálat engedi – plafonszámítás nélkül is.
  const buckets = new Map();
  for (const q of incoming.get(slug)) {
    const key = q.t ?? '(nincs téma)';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(q);
  }
  const interleaved = [];
  for (let round = 0; interleaved.length < incoming.get(slug).length; round++) {
    let progressed = false;
    for (const list of buckets.values()) {
      if (round < list.length) {
        interleaved.push(list[round]);
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  for (const q of interleaved) {
    if (existing.length >= CAP) {
      skippedCap++;
      continue;
    }

    const problem = structuralProblem(q);
    if (problem) {
      skippedInvalid++;
      countReason(problem);
      continue;
    }

    const topicKey = q.t ?? '(nincs téma)';
    if ((topicCount.get(topicKey) ?? 0) >= topicCap) {
      skippedTopic++;
      continue;
    }

    const textKey = normalize(q.q);
    const answerKey = answerSetKey(q.a);
    if (seenText.has(textKey) || seenAnswers.has(answerKey)) {
      skippedDuplicate++;
      continue;
    }

    seenText.add(textKey);
    seenAnswers.add(answerKey);
    topicCount.set(topicKey, (topicCount.get(topicKey) ?? 0) + 1);
    existing.push(q);
    added++;
  }

  // NYESÉS: a plafon a TÉNYLEGES kategóriaméretre is érvényes legyen.
  //
  // A beolvasztás közben a plafont a célmérethez (`--cap`) mérjük, mert a
  // végső méretet előre nem tudjuk. Ha viszont a kategória nem tölti meg a
  // célt – mert a Wikidata csak egy-két sablont adott hozzá –, akkor az arány
  // elcsúszik: mérve 55–60% maradt egyetlen témából.
  //
  // Ezért a végén visszavágunk. Csak GENERÁLT kérdést dobunk (van forrás-URL);
  // a kézzel írtakhoz nem nyúlunk, azok a kategória gerince.
  // FONTOS ÜTKÖZÉS: egy játékkör 10 kérdés ugyanabból a kategóriából, tehát
  // egy kategória 40 kérdés alatt gyakorlatilag játszhatatlan (azonnal
  // ismétlődne). Ha egy kategóriához a Wikidata csak EGY sablont adott, akkor
  // az arányszabály és a játszhatóság ütközik – ilyenkor a játszhatóság nyer,
  // és a kategória `1 téma` jelöléssel kerül a jelentésbe: oda kézzel írt
  // kérdés kell, nem több generálás.
  const MIN_PLAYABLE = 40;

  let trimmed = 0;
  for (let pass = 0; pass < 200; pass++) {
    if (existing.length <= MIN_PLAYABLE) break;

    const counts = new Map();
    for (const q of existing) {
      const key = q.t ?? '(nincs téma)';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const allowed = Math.max(6, Math.floor(existing.length * TOPIC_SHARE));
    const over = [...counts.entries()]
      .filter(([, n]) => n > allowed)
      .sort((a, b) => b[1] - a[1])[0];
    if (!over) break;

    // Tömegesen vágunk: egyenként a ciklus soha nem érne a végére nagy
    // kategóriákban (mérve: 20 kör kevés volt 28 szükséges törléshez).
    const excess = Math.min(over[1] - allowed, existing.length - MIN_PLAYABLE);
    let removed = 0;
    for (let i = existing.length - 1; i >= 0 && removed < excess; i--) {
      const q = existing[i];
      // Csak GENERÁLT kérdést dobunk; a kézzel írtak a kategória gerince.
      if ((q.t ?? '(nincs téma)') !== over[0]) continue;
      if (!(q.s && String(q.s).includes('wikidata'))) continue;
      existing.splice(i, 1);
      removed++;
    }
    if (removed === 0) break;   // csak kézzel írt maradt ebben a témában
    trimmed += removed;
    added -= removed;
  }

  seed.questions = existing;
  if (!DRY && (added > 0 || trimmed > 0)) {
    writeFileSync(path, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
  }

  totalAdded += added;
  stats.push({
    slug, before, added, after: existing.length,
    skippedDuplicate, skippedInvalid, skippedCap, skippedTopic,
    topics: topicCount.size
  });
}

// ─────────────────── jelentés ───────────────────

console.log('  kategória              előtte  +új   utána  téma   dup  hibás  plafon  téma-p');
console.log('  ' + '─'.repeat(82));
for (const s of stats) {
  console.log(
    '  ' +
      s.slug.padEnd(22) +
      String(s.before).padStart(6) +
      String(s.added).padStart(6) +
      String(s.after).padStart(7) +
      String(s.topics).padStart(6) +
      String(s.skippedDuplicate).padStart(6) +
      String(s.skippedInvalid).padStart(7) +
      String(s.skippedCap).padStart(8) +
      String(s.skippedTopic).padStart(8)
  );
}

console.log(`\nÖsszesen ${totalAdded} új kérdés került be.`);

if (reasons.size > 0) {
  console.log('\nEldobott kérdések okai (szerkezeti szabályok):');
  for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)} × ${reason}`);
  }
}

if (!DRY && totalAdded > 0) {
  console.log('\nKövetkező lépés:');
  console.log('  node tools/src/validate-seed.mjs');
  console.log('  node tools/src/build-seed.mjs');
}
