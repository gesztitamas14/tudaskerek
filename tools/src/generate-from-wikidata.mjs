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

// Hány Wikipédia-nyelven kell szócikknek lennie az alanyról, hogy kvízbe
// kerüljön. A sablon felülírhatja (`minSitelinks`), a parancssor is
// (`--min-sitelinks`). 0 = nincs szűrés.
const MIN_SITELINKS = Number(arg('min-sitelinks', '12'));

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
/**
 * Egy Wikidata-címke akkor használhatatlan, ha maga a Q-azonosító.
 *
 * A `SERVICE wikibase:label` blokk magyar, majd angol címkét kér – ha egyik
 * sincs, az azonosítót adja vissza. Az ilyen kérdés („Ki komponálta a
 * Goldfinger-t? → Q41076”) értelmezhetetlen, ezért kidobjuk.
 */
function isQid(label) {
  return typeof label === 'string' && /^Q[0-9]+$/.test(label.trim());
}

async function runTemplate(template, limit) {
  process.stdout.write(`  ${template.id} … `);

  // ISMERTSÉGI SZŰRŐ – ez dönti el, hogy játszható-e a kérdés.
  //
  // A nyers Wikidata tele van olyan entitással, ami technikailag helyes, de
  // kvízben értelmetlen („Melyik sportágban jeleskedett Nagy Tamás?”). A
  // `wikibase:sitelinks` megmutatja, hány Wikipédia-nyelv írt róla szócikket –
  // ez jó közelítés az ismertségre. A magyar témák külön, alacsonyabb
  // küszöböt kapnak, mert róluk jellemzően csak pár nyelven van szócikk.
  const minSitelinks = template.minSitelinks ?? MIN_SITELINKS;
  const clauses = [];

  if (minSitelinks > 0) {
    clauses.push(`?subject wikibase:sitelinks ?_sl . FILTER(?_sl >= ${minSitelinks})`);
  }

  // MAGYAR CÍMKE KÉNYSZERÍTÉSE.
  //
  // A `SERVICE wikibase:label` angolra esik vissza, ha nincs magyar címke –
  // így lett „Ki írta a következő művet: The Proof?” egy magyar regényből.
  // Magyar kategóriáknál ez elfogadhatatlan, ezért ott megköveteljük a magyar
  // címkét (a szűrő szándékosan kevesebb, de helyes kérdést ad).
  if (template.requireHungarianSubject) {
    clauses.push('?subject rdfs:label ?_hu . FILTER(LANG(?_hu) = "hu")');
  }

  // A VÁLASZ is legyen ismert, ha személy.
  //
  // Az alany ismertsége nem elég: „Ki fedezte fel a kadmiumot?” alanya
  // (kadmium) közismert, a helyes válasz viszont egy senki által nem ismert
  // vegyész volt. Ilyenkor a válasz oldalára is kell küszöb.
  if (template.minAnswerSitelinks) {
    clauses.push(
      `?answer wikibase:sitelinks ?_asl . FILTER(?_asl >= ${template.minAnswerSitelinks})`
    );
  }

  const notable = clauses.join('\n        ');

  const query = template.sparql
    .replace('{{NOTABLE}}', notable)
    .replace('{{LIMIT}}', String(limit * 3));

  const rows = (await sparql(query)).filter(
    (r) => !isQid(r.subjectLabel) && !isQid(r.answerLabel)
  );
  console.log(`${rows.length} sor`);

  // Az összes lehetséges válasz (a distractor-készlet)
  const answerPool = [...new Set(rows.map((r) => r.answerLabel).filter(Boolean))];
  if (answerPool.length < 4) {
    console.warn(`    ⚠ Túl kevés különböző válasz (${answerPool.length}), kihagyva.`);
    return [];
  }

  const questions = [];
  const seen = new Set();

  // A HELYES VÁLASZOK KIEGYENSÚLYOZÁSA – ez nem szépítés, hanem játékszabály.
  //
  // Mérés nélkül nem látszik: a „Melyik településen született X?” kérdések 63%-a
  // Budapest volt, a „Melyik országban található X hegy?” 63%-a Svájc. Az ilyen
  // kérdéssorozat megoldható tudás nélkül: mindig a leggyakoribb választ
  // tippeled, és többségében nyersz.
  //
  // Ezért egyetlen helyes válasz sem szerepelhet a sablon kérdéseinek több mint
  // ~18%-ában. A szűrés itt van, és nem sablononként javítva, mert így minden
  // JÖVŐBELI sablon is védve van.
  const answerCap = Math.max(3, Math.ceil(limit * 0.18));
  const answerUse = new Map();

  for (const row of rows) {
    if (questions.length >= limit) break;
    if (!row.subjectLabel || !row.answerLabel) continue;

    const answerKey = normalize(row.answerLabel);
    if ((answerUse.get(answerKey) ?? 0) >= answerCap) continue;

    // Egy alany csak egyszer szerepeljen
    const subjectKey = normalize(row.subjectLabel);
    if (seen.has(subjectKey)) continue;

    // Latin írásmódot nem használó vagy hiányos címkék kiszűrése
    if (/^Q\d+$/.test(row.subjectLabel) || /^Q\d+$/.test(row.answerLabel)) continue;

    const correct = row.answerLabel;
    const others = answerPool.filter((value) => normalize(value) !== normalize(correct));

    // HOSSZRA ÉRZÉKENY RONTÓVÁLASZTÁS.
    //
    // Ha a rontókat vaktában húzzuk a készletből, a helyes válasz gyakran a
    // leghosszabb lesz (mérve: az esetek 43%-ában, a véletlen 25% helyett).
    // Ilyenkor tudás nélkül is nyerni lehet: mindig a leghosszabbat választod.
    //
    // Ezért előnyben részesítjük azokat a rontókat, amelyek hossza közel van a
    // helyes válaszéhoz. Ha nincs elég ilyen, visszaesünk a teljes készletre –
    // jobb egy kevésbé kiegyensúlyozott kérdés, mint semmi.
    const targetLength = correct.length;
    const similarLength = others.filter(
      (value) => Math.abs(value.length - targetLength) <= Math.max(4, targetLength * 0.4)
    );
    const distractorPool = similarLength.length >= 3 ? similarLength : others;
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

    // „VÁLASZD A LEGHOSSZABBAT” HEURISZTIKA KIÜTÉSE.
    //
    // A hosszra érzékeny merítés önmagában 43%-ról 39%-ra vitte le azt, hogy a
    // helyes válasz a leghosszabb – a véletlen 25% helyett. A maradék torzítást
    // közvetlenül kell megcélozni: ha egyetlen rontó sem hosszabb a helyesnél,
    // kicserélünk egyet egy hosszabbra. Így a „mindig a leghosszabbat
    // választom” stratégia nem működik.
    // SZIMMETRIKUSAN. Ha csak azt biztosítjuk, hogy legyen hosszabb rontó, a
    // torzítás átfordul: mérve 14% „leghosszabb”, de 38% „legrövidebb” – a
    // „válaszd a legrövidebbet” stratégia lett nyerő. Ezért a maggal vezérelt
    // véletlen dönti el, melyik irányba igazítunk, így egyik szélső pozíció
    // sem kap előnyt.
    const wantLonger = random() < 0.5;
    const needsFix = wantLonger
      ? !distractors.some((d) => d.length > correct.length)
      : !distractors.some((d) => d.length < correct.length);

    if (needsFix) {
      const candidates = others
        .filter((value) => !used.has(normalize(value)))
        .filter((value) =>
          wantLonger ? value.length > correct.length : value.length < correct.length
        )
        // A legkisebb elmozdulást választjuk: a rontó maradjon hihető.
        .sort((a, b) => Math.abs(a.length - correct.length) - Math.abs(b.length - correct.length));

      if (candidates.length > 0) {
        // Azt a rontót cseréljük, ami a legmesszebb van a kívánt iránytól.
        let worstIndex = 0;
        for (let i = 1; i < distractors.length; i++) {
          const better = wantLonger
            ? distractors[i].length < distractors[worstIndex].length
            : distractors[i].length > distractors[worstIndex].length;
          if (better) worstIndex = i;
        }
        distractors[worstIndex] = candidates[0];
      }
    }

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
    answerUse.set(answerKey, (answerUse.get(answerKey) ?? 0) + 1);
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
  let selected = only
    ? TEMPLATES.filter((t) => t.id === only)
    : (flag('all') ? TEMPLATES : []);

  if (selected.length === 0) {
    console.error(
      'Add meg a --template <id> vagy az --all paramétert.\n' +
      'A sablonok listája: node tools/src/generate-from-wikidata.mjs --list'
    );
    process.exit(1);
  }

  // Kategóriaszűrő – hogy csomagokban lehessen futtatni (a publikus végpont
  // terhelése és az időkorlát miatt egy körben nem fut le minden sablon).
  const onlyCats = arg('categories', null);
  if (onlyCats) {
    const wanted = new Set(onlyCats.split(',').map((x) => x.trim()));
    selected = selected.filter((t) => wanted.has(t.category));
  }

  console.log('── Wikidata kérdésgenerálás (CC0) ─────────────');
  console.log(`Sablon: ${selected.length}, kérdés/sablon: max ${limit}`);
  console.log('');

  // INKREMENTÁLIS KIÍRÁS.
  //
  // A Wikidata publikus végpontja lassú, és időnként 502/504-et ad. Ötven
  // sablon egy körben nem fut le a rendelkezésre álló időben; ha csak a végén
  // írnánk ki, egy megszakadás az egész munkát eldobná. Ezért minden sablon
  // után mentünk – a félbeszakadt futás is használható eredményt hagy.
  const out = flag('upload')
    ? null
    : arg('out', `content/generated/wikidata-${Date.now()}.json`);
  if (out) mkdirSync(dirname(out), { recursive: true });

  const save = (questions) => {
    if (!out) return;
    writeFileSync(
      out,
      JSON.stringify(
        { generated_at: new Date().toISOString(), model: 'wikidata-sparql', questions },
        null,
        2
      )
    );
  };

  const all = [];
  for (const template of selected) {
    try {
      all.push(...(await runTemplate(template, limit)));
      save(all);
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

  save(all);
  console.log(`✓ Kiírva: ${out}`);
  console.log('  Feltöltés review-ra: node tools/src/upload-candidates.mjs ' + out);
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}`);
  process.exit(1);
});
