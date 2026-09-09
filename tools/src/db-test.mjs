#!/usr/bin/env node
// A migrációk és a kieséses multiplayer logika tesztje IGAZI PostgreSQL-en.
//
// A PGlite a Postgrest fordítja WebAssemblyre, tehát ugyanaz a PL/pgSQL
// értelmező és ugyanaz a lekérdezéstervező fut, mint a Supabase-ben. Így a
// `supabase db push` ELŐTT kiderül, ha egy migrációban hiba van – anélkül,
// hogy Dockert vagy Postgrest kellene telepíteni. Windowson is megy.
//
// Amit NEM fed le: a Supabase saját szolgáltatásai (GoTrue, PostgREST,
// Realtime). Ezeket az `auth.uid()` és a szerepek utánzásával pótoljuk. Az RLS
// és a `security definer` viszont valódi, mert az tiszta Postgres.
//
// Futtatás:      node tools/src/db-test.mjs
// Előkészítés:   cd tools && npm install

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

let PGlite, pg_trgm, unaccent, pgcrypto;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm'));
  ({ unaccent } = await import('@electric-sql/pglite/contrib/unaccent'));
  ({ pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto'));
} catch {
  console.error(
    'Ehhez a teszthez a PGlite kell:\n' +
      '  cd tools && npm install\n' +
      '(A seed- és importeszközök továbbra sem igényelnek npm install-t.)'
  );
  process.exit(2);
}

// ─────────────────── Supabase-utánzat ───────────────────
// Csak annyi, amennyi a migrációk lefutásához kell. Az `auth.uid()` egy
// session-változóból olvas, így a tesztben bármelyik játékos bőrébe bújhatunk –
// pontosan úgy, ahogy a PostgREST tenné a JWT-ből.

const BOOTSTRAP = `
create role anon;
create role authenticated;
create role service_role;

create schema if not exists extensions;
create schema if not exists auth;

create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  is_anonymous       boolean not null default false,
  created_at         timestamptz not null default now()
);

create or replace function auth.uid() returns uuid
language sql stable as $fn$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$fn$;

create or replace function auth.role() returns text
language sql stable as $fn$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
$fn$;

create publication supabase_realtime;
`;

// ─────────────────── segédek ───────────────────

let failures = 0;
let checks = 0;

function ok(condition, label) {
  checks++;
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}`);
  }
}

function fail(label, error) {
  failures++;
  console.log(`  ✗ ${label}\n      ${String(error?.message ?? error).split('\n')[0]}`);
}

/** SQL sztringliterál. A tesztadatokban nincs kötőjeles UUID-n kívül semmi. */
const q = (value) => (value === null || value === undefined ? 'null' : `'${String(value).replace(/'/g, "''")}'`);

const db = await PGlite.create({ extensions: { pg_trgm, unaccent, pgcrypto } });

// A PGlite hibaobjektuma a teljes WASM modult viszi a stackben – ha ez kijut a
// konzolra, 200 kB olvashatatlan kód lesz belőle.
const bail = (error) => {
  console.error(`\nVÁRATLAN HIBA: ${error?.message ?? error}`);
  if (error?.query) console.error(`  a lekérdezés: ${String(error.query).slice(0, 400)}`);
  process.exit(1);
};
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);

/** Egy RPC lefuttatása adott játékos nevében – ahogy a PostgREST tenné. */
async function asPlayer(playerId, sql) {
  await db.exec(`select set_config('request.jwt.claim.sub', ${q(playerId ?? '')}, false)`);
  const result = await db.query(sql);
  return result.rows[0] ? Object.values(result.rows[0])[0] : null;
}

/**
 * Lekérdezés a KLIENS szerepében. Superuserként az RLS nem érvényesül, tehát
 * enélkül a jogosultsági tesztek hamis zöldet adnának.
 */
async function asClient(playerId, sql) {
  await db.exec(`select set_config('request.jwt.claim.sub', ${q(playerId ?? '')}, false)`);
  await db.exec('set role authenticated');
  try {
    return (await db.query(sql)).rows;
  } finally {
    await db.exec('reset role');
  }
}

async function one(sql) {
  const result = await db.query(sql);
  return result.rows[0];
}

// ─────────────────── 1. migrációk ───────────────────

console.log('\n1. Migrációk lefuttatása igazi Postgresen');

await db.exec(BOOTSTRAP);

for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
  try {
    await db.exec(readFileSync(join(MIGRATIONS, name), 'utf8'));
    checks++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail(name, error);
    console.error('\nA migráció nem futott le, a további tesztek értelmetlenek.');
    process.exit(1);
  }
}

// ─────────────────── 2. játékosok és kérdésbank ───────────────────

console.log('\n2. Négy játékos és egy kis kérdésbank');

const ids = [];
for (const name of ['Anna', 'Bela', 'Cili', 'Dora']) {
  const row = await one(
    `insert into auth.users (email, raw_user_meta_data)
     values (${q(name.toLowerCase() + '@example.test')},
             jsonb_build_object('nickname', ${q(name)}))
     returning id`
  );
  ids.push(row.id);
}
const [ANNA, BELA, CILI, DORA] = ids;

ok((await one('select count(*)::int as n from public.profiles')).n === 4, 'a trigger mind a négy profilt létrehozta');

const cats = (await db.query('select id, slug from public.categories order by sort_order limit 5')).rows;
ok(cats.length === 5, 'a seedből vannak kategóriák');

let qn = 0;
for (const cat of cats) {
  for (let i = 0; i < 14; i++) {
    qn++;
    await db.exec(
      `insert into public.questions
         (category_id, difficulty, question_text, answer_a, answer_b, answer_c, answer_d,
          correct_answer, explanation, source)
       values (${q(cat.id)}, 'easy',
               ${q(`Teszt kérdés ${qn} a ${cat.slug} kategóriában?`)},
               ${q(`valasz ${qn} alfa`)}, ${q(`valasz ${qn} beta`)},
               ${q(`valasz ${qn} gamma`)}, ${q(`valasz ${qn} delta`)},
               ${qn % 4}, ${q(`Magyarázat ${qn}.`)}, 'teszt')`
    );
  }
}
ok(qn === 70, `${qn} teszt kérdés betöltve`);

// ─────────────────── 3. szoba életciklus ───────────────────

console.log('\n3. Szoba létrehozása, csatlakozás, indítás');

const PIN = '407';

let room = await asPlayer(
  ANNA,
  `select public.create_room(4::smallint, 2::smallint, null, 1::smallint, 20::smallint, ${q(PIN)})`
);
ok(room.status === 'lobby', 'a szoba lobby állapotban jött létre');
ok(room.has_pin === true, 'a szoba PIN-nel védett');
ok(room.my_pin === PIN, 'a szoba készítője látja a saját PIN-jét');

// ── a nyitott szobák listája: itt találják meg a többiek ──
const openRooms = await asPlayer(BELA, `select public.list_open_rooms(30::int)`);
ok(Array.isArray(openRooms) && openRooms.length === 1, `egy nyitott szoba látszik (${openRooms?.length})`);
ok(openRooms[0]?.id === room.id, 'a lista a most készült szobát adja');
ok(openRooms[0]?.host_nickname === 'Anna', 'a listán látszik a szoba készítője');
ok(openRooms[0]?.needs_pin === true, 'a listán látszik, hogy PIN kell');
ok(
  !('join_pin' in openRooms[0]) && !('code' in openRooms[0]),
  'a listában NINCS benne se a PIN, se a belső kód'
);
ok(openRooms[0]?.player_count === 1, `a listán látszik a létszám (${openRooms[0]?.player_count})`);

// ── hibás PIN ──
//
// A `join_room` burkolót ad vissza és NEM dob kivételt: a hibás tippek
// számlálóját egy kivétel visszapörgetné a tranzakcióval együtt.
let attempt = await asPlayer(BELA, `select public.join_room(${q(room.id)}, '123')`);
ok(attempt.ok === false && attempt.error === 'bad_pin', 'hibás PIN-nel nem lehet belépni');
ok(attempt.attempts_left === 4, `visszajelzi, hány próbálkozás maradt (${attempt.attempts_left})`);

attempt = await asPlayer(BELA, `select public.join_room(${q(room.id)}, null)`);
ok(
  attempt.ok === false && attempt.error === 'bad_pin',
  'PIN nélkül sem lehet belépni a védett szobába'
);

// ── próbálkozás-korlát: 3 jegy csak akkor zár, ha nem lehet végigpróbálni ──
for (let i = 0; i < 3; i++) {
  await asPlayer(BELA, `select public.join_room(${q(room.id)}, '999')`);
}
attempt = await asPlayer(BELA, `select public.join_room(${q(room.id)}, '888')`);
ok(attempt.error === 'locked', 'öt hibás tipp után zárolás jön');

// A helyes PIN sem segít, amíg a zárolás áll.
attempt = await asPlayer(BELA, `select public.join_room(${q(room.id)}, ${q(PIN)})`);
ok(attempt.error === 'locked', 'zárolás alatt a helyes PIN sem engedi be');

ok(
  (
    await one(
      `select failures from public.room_join_attempts
       where room_id = ${q(room.id)} and player_id = ${q(BELA)}`
    )
  ).failures === 5,
  'a hibás próbálkozások tényleg elmentődtek (a kivétel visszapörgette volna)'
);

// A zárolás játékosonként külön áll: Cili nem sínyli meg Béla tippelgetését.
const ciliTry = await asPlayer(CILI, `select public.join_room(${q(room.id)}, ${q(PIN)})`);
ok(ciliTry.ok === true, 'másik játékost nem érint Béla zárolása');

// Béla zárolását feloldjuk (mintha eltelt volna 10 perc), és jó PIN-nel belép.
await db.exec(
  `update public.room_join_attempts set last_failure_at = now() - interval '20 minutes'
   where room_id = ${q(room.id)} and player_id = ${q(BELA)}`
);

for (const player of [BELA, DORA]) {
  const joined = await asPlayer(player, `select public.join_room(${q(room.id)}, ${q(PIN)})`);
  ok(joined.ok === true, `belépés helyes PIN-nel (${player === BELA ? 'Béla' : 'Dóra'})`);
  room = joined.room;
}
ok(room.players?.length === 4, `mind a négy játékos a szobában van (${room.players?.length})`);
ok(
  (
    await one(
      `select count(*)::int as n from public.room_join_attempts where room_id = ${q(room.id)}`
    )
  ).n === 0,
  'sikeres belépés után a próbálkozás-számláló törlődik'
);

const EXTRA = (
  await one(
    `insert into auth.users (email, raw_user_meta_data)
     values ('edit@example.test', jsonb_build_object('nickname', 'Edit')) returning id`
  )
).id;

try {
  const fullTry = await asPlayer(EXTRA, `select public.join_room(${q(room.id)}, ${q(PIN)})`);
  ok(fullTry.error === 'full', 'a tele szoba visszautasítja az ötödik játékost');
} catch (error) {
  fail('a tele szoba visszautasítja az ötödik játékost', error);
}

try {
  await asPlayer(BELA, `select public.start_room(${q(room.id)})`);
  ok(false, 'nem host nem indíthatja el a játékot');
} catch (error) {
  ok(/létrehozója/i.test(error.message), 'nem host nem indíthatja el a játékot');
}

room = await asPlayer(ANNA, `select public.start_room(${q(room.id)})`);
ok(room.status === 'playing', 'a host elindította a játékot');
ok(room.block_no === 1, 'az első körben vagyunk');
ok(Boolean(room.current_question), 'az indítás után azonnal van kérdés');

// ─────────────────── 4. a helyes válasz nem szivárog ki ───────────────────

console.log('\n4. A helyes válasz nem szivárog ki lezárás előtt');

const q1 = room.current_question;
ok(q1.correct_answer === null, 'a szobaállapotban NINCS benne a helyes válasz');
ok(q1.explanation === null, 'a magyarázat sincs benne');
ok(Array.isArray(q1.answers) && q1.answers.length === 4, 'a négy válaszlehetőség viszont ott van');
ok(q1.resolved === false, 'a kérdés még nyitott');
ok(q1.alive_count === 4, `mind a négy játékos versenyben van (${q1.alive_count})`);

let leaked = false;
for (const player of ids) {
  const state = await asPlayer(player, `select public.room_state(${q(room.id)})`);
  if (state.current_question?.correct_answer !== null) leaked = true;
}
ok(!leaked, 'egyik játékos sem látja előre a helyes választ');

// A questions táblán VAN table-szintű grant (az admin felület miatt), de az RLS
// moderátorra szűkíti. Ezért nem a grantot, hanem a tényleges hozzáférést
// mérjük – kliens szerepben, ahol az RLS valóban érvényesül.
const rowsSeen = await asClient(ANNA, 'select id from public.questions limit 5');
ok(
  rowsSeen.length === 0,
  `sima játékos egyetlen sort sem olvashat a questions táblából (${rowsSeen.length})`
);

for (const table of ['room_questions', 'room_answers']) {
  try {
    await asClient(ANNA, `select * from public.${table} limit 1`);
    ok(false, `a kliens nem olvashatja a ${table} táblát`);
  } catch (error) {
    ok(
      /permission denied/i.test(error.message),
      `a kliens nem olvashatja a ${table} táblát`
    );
  }
}

// A publikus nézet viszont működik, és nincs benne a helyes válasz.
const publicRows = await asClient(ANNA, 'select * from public.questions_public limit 1');
ok(publicRows.length === 1, 'a questions_public nézet olvasható a kliensnek');
ok(
  publicRows[0] !== undefined && !('correct_answer' in publicRows[0]) &&
    !('explanation' in publicRows[0]),
  'a questions_public nézetben nincs correct_answer és explanation'
);

// A szobaállapot RPC kliens szerepből is működik – a grantok tehát megvannak.
const viaClient = await asClient(
  ANNA,
  `select public.room_state(${q(room.id)}) as state`
);
ok(
  viaClient[0]?.state?.current_question?.correct_answer === null,
  'a room_state RPC kliens szerepből is elrejti a helyes választ'
);

// ─────────────────── 5. kiesés ───────────────────

console.log('\n5. Rossz válasz = kiesés, jó válasz = pont');

/** A helyes index kiváltságos kiolvasása – a kliens ezt nem tudná megtenni. */
async function correctIndexOf(roomQuestionId) {
  return (
    await one(
      `select q.correct_answer as c from public.room_questions rq
       join public.questions q on q.id = rq.question_id
       where rq.id = ${q(roomQuestionId)}`
    )
  ).c;
}

// Az első kérdés előtt a kerék pörög (spin_seconds), addig zárva a válaszadás.
// A teszt ezt előretekeri; magát a tiltást a 6. szakasz ellenőrzi.
await db.exec(
  `update public.room_questions set answer_open_at = now() where id = ${q(q1.id)}`
);

const c1 = await correctIndexOf(q1.id);
const w1 = (c1 + 1) % 4;

const answer = (player, rq, index, ms = 1000) =>
  asPlayer(
    player,
    `select public.answer_room_question(${q(room.id)}, ${q(rq)}, ${index}::smallint, ${ms})`
  );

await answer(ANNA, q1.id, c1, 1200);
await answer(BELA, q1.id, c1, 2400);
await answer(CILI, q1.id, w1, 900);
// Dóra szándékosan nem válaszol.

try {
  await answer(ANNA, q1.id, c1, 100);
  ok(false, 'ugyanarra a kérdésre nem lehet kétszer válaszolni');
} catch (error) {
  ok(/már válaszoltál/i.test(error.message), 'ugyanarra a kérdésre nem lehet kétszer válaszolni');
}

const mid = await asPlayer(ANNA, `select public.room_state(${q(room.id)})`);
ok(
  mid.current_question.correct_answer === null,
  'a válasz beküldése SEM árulja el a helyes megoldást (amíg nem zárult le)'
);
ok(mid.current_question.i_answered === true, 'a saját válaszom viszont látszik');
ok(mid.current_question.answered_count === 3, `látszik, hányan válaszoltak (${mid.current_question.answered_count})`);

// A pontsáv NE árulja el a kiértékelést a lezárás előtt. Anna és Béla már
// helyesen válaszolt, de amíg a kérdés nyitva van (Dóra még nem válaszolt),
// a pontjuknak NULLÁNAK kell látszania mindenki számára – különben a
// pontsávból ki lehetne következtetni, ki válaszolt helyesen, mielőtt a
// kiértékelés hivatalosan megjelenne.
const midPlayers = new Map((mid.players ?? []).map((p) => [p.player_id, p]));
ok(
  midPlayers.get(ANNA).block_score === 0,
  `Anna helyes válasza a lezárás ELŐTT még nem látszik a pontsávon (${midPlayers.get(ANNA).block_score})`
);
ok(
  midPlayers.get(BELA).block_score === 0,
  `Béla helyes válasza a lezárás ELŐTT még nem látszik a pontsávon (${midPlayers.get(BELA).block_score})`
);
// Ugyanez MÁSIK JÁTÉKOS szemszögéből is – nem csak a sajátunkból.
const midFromCili = await asPlayer(CILI, `select public.room_state(${q(room.id)})`);
const midPlayersFromCili = new Map((midFromCili.players ?? []).map((p) => [p.player_id, p]));
ok(
  midPlayersFromCili.get(ANNA).block_score === 0,
  'Cili sem látja Anna pontnövekedését a lezárás előtt'
);

// Dóra ideje lejár: a határidőt visszatekerjük, majd tickelünk.
await db.exec(
  `update public.room_questions set deadline_at = now() - interval '1 second' where id = ${q(q1.id)}`
);
room = await asPlayer(ANNA, `select public.room_tick(${q(room.id)})`);

ok(
  (await one(`select resolved_at from public.room_questions where id = ${q(q1.id)}`)).resolved_at !== null,
  'a lejárt kérdés lezárult'
);

const p1 = new Map((room.players ?? []).map((p) => [p.player_id, p]));
ok(p1.get(ANNA).is_eliminated === false, 'Anna (helyes válasz) játékban maradt');
ok(p1.get(BELA).is_eliminated === false, 'Béla (helyes válasz) játékban maradt');
ok(p1.get(CILI).is_eliminated === true, 'Cili (rossz válasz) KIESETT');
ok(p1.get(DORA).is_eliminated === true, 'Dóra (nem válaszolt időben) KIESETT');
ok(p1.get(ANNA).block_score === 1000, `Anna 1000 pontot kapott (${p1.get(ANNA).block_score})`);
ok(p1.get(CILI).block_score === 0, 'Cili nem kapott pontot');

// Lezárás után MINDENKI látja a helyes választ és a kiértékelést.
const revealed = await asPlayer(CILI, `select public.room_state(${q(room.id)})`);
const rq1 = revealed.current_question;
ok(rq1?.id === q1.id && rq1.correct_answer === c1, 'lezárás után a helyes válasz kiderül');
ok(Boolean(rq1?.explanation), 'a magyarázat is előkerül');
ok(Array.isArray(rq1?.results) && rq1.results.length === 4, `mind a négy játékos eredménye megvan (${rq1?.results?.length})`);

// ─────────────────── 6. a kiesett nem játszik tovább ───────────────────

console.log('\n6. A kiesett játékos nézővé válik');

// A `reveal_seconds` letelését szimuláljuk.
await db.exec(
  `update public.room_questions set resolved_at = now() - interval '30 seconds' where id = ${q(q1.id)}`
);
room = await asPlayer(ANNA, `select public.room_tick(${q(room.id)})`);

const q2 = room.current_question;
ok(Boolean(q2) && q2.id !== q1.id, 'jött a következő kérdés');
ok(q2?.ordinal === 2, `a második kérdésnél vagyunk (${q2?.ordinal})`);
ok(q2?.alive_count === 2, `már csak két játékos van versenyben (${q2?.alive_count})`);

await db.exec(`update public.room_questions set answer_open_at = now() where id = ${q(q2.id)}`);

try {
  await answer(CILI, q2.id, 0, 500);
  ok(false, 'a kiesett játékos nem válaszolhat');
} catch (error) {
  ok(/nem vagy játékban/i.test(error.message), 'a kiesett játékos nem válaszolhat');
}

try {
  await asPlayer(EXTRA, `select public.room_state(${q(room.id)})`);
  ok(false, 'nem tag nem kérdezheti a szobaállapotot');
} catch (error) {
  ok(/nem vagy a szoba tagja/i.test(error.message), 'nem tag nem kérdezheti a szobaállapotot');
}

// A pörgetés alatt sem lehet válaszolni – így a válaszidő mindenkinek ugyanannyi.
await db.exec(
  `update public.room_questions set answer_open_at = now() + interval '5 seconds' where id = ${q(q2.id)}`
);
try {
  await answer(ANNA, q2.id, 0, 100);
  ok(false, 'a kerék pörgése alatt nem lehet válaszolni');
} catch (error) {
  ok(/pörög/i.test(error.message), 'a kerék pörgése alatt nem lehet válaszolni');
}
await db.exec(`update public.room_questions set answer_open_at = now() where id = ${q(q2.id)}`);

// ─────────────────── 7. ha mindenki hibázik, vége a körnek ───────────────────

console.log('\n7. Ha mindenki hibázik, véget ér a kör');

const c2 = await correctIndexOf(q2.id);
await answer(ANNA, q2.id, (c2 + 1) % 4, 800);
await answer(BELA, q2.id, (c2 + 1) % 4, 900);

// A tick először csak lezárja a kérdést. A kör vége szándékosan várja a
// reveal_seconds letelését, hogy a játékosok lássák az eredményt – a tesztben
// ezt előretekerjük.
room = await asPlayer(ANNA, `select public.room_tick(${q(room.id)})`);
await db.exec(
  `update public.room_questions set resolved_at = now() - interval '30 seconds'
   where id = ${q(q2.id)}`
);
room = await asPlayer(ANNA, `select public.room_tick(${q(room.id)})`);

ok(
  Array.isArray(room.last_block_scores) && room.last_block_scores.length === 4,
  'a kör lezárult, és megvan a köri pontösszesítő'
);
ok(room.block_no === 2, `a második körben vagyunk (${room.block_no})`);

const p2 = new Map((room.players ?? []).map((p) => [p.player_id, p]));
ok(p2.get(ANNA).score === 1000, `Anna köri pontja beolvadt az összesítettbe (${p2.get(ANNA).score})`);
ok(p2.get(ANNA).block_score === 0, 'a köri pont nullázódott');
ok([...p2.values()].every((p) => p.is_eliminated === false), 'új körben mindenki visszatér a játékba');

// ─────────────────── 8. a játék vége ───────────────────

console.log('\n8. A játék vége eredményt ír a ranglistához');

for (let guard = 0; guard < 40 && room.status === 'playing'; guard++) {
  room = await asPlayer(ANNA, `select public.room_tick(${q(room.id)})`);
  const current = room.current_question;
  if (!current) continue;

  if (current.resolved) {
    await db.exec(
      `update public.room_questions set resolved_at = now() - interval '30 seconds'
       where id = ${q(current.id)}`
    );
    continue;
  }

  await db.exec(`update public.room_questions set answer_open_at = now() where id = ${q(current.id)}`);
  const correct = await correctIndexOf(current.id);
  for (const player of ids) {
    try {
      await answer(player, current.id, (correct + 1) % 4, 700);
    } catch {
      /* aki már kiesett, nem válaszolhat – itt ez a helyes viselkedés */
    }
  }
}

ok(room.status === 'finished', `a játék véget ért (${room.status})`);

const results = await one(
  `select count(*)::int as n, bool_and(is_trusted) as trusted,
          bool_and(correct <= questions) as counts_ok
   from public.game_results where mode = 'multiplayer'`
);
ok(results.n === 4, `mind a négy játékosnak van eredménye (${results.n})`);
ok(results.trusted === true, 'a multiplayer eredmények szerver-hitelesítettek');
ok(results.counts_ok === true, 'a helyes/összes kérdés számok konzisztensek');

// A leaderboard SETOF-ot ad vissza, nem JSON-t – soronként olvassuk.
const board = (await db.query(`select * from public.leaderboard('all_time', 10::int)`)).rows;
ok(board.length > 0, `a ranglista tartalmazza a szobás eredményeket (${board.length} sor)`);
ok(
  board.some((row) => Number(row.total_score) > 0),
  'a ranglistán van pozitív pontszám'
);

// ─────────────────── 9. kérdés- és kategóriaszórás ───────────────────

console.log('\n9. Egy kérdés egy szobában csak egyszer jön elő');

ok(
  (
    await one(
      `select count(*)::int as n from (
         select question_id from public.room_questions where room_id = ${q(room.id)}
         group by question_id having count(*) > 1
       ) t`
    )
  ).n === 0,
  'nincs megismételt kérdés a szobában'
);

const spread = await one(
  `select count(distinct category_id)::int as n, count(*)::int as total
   from public.room_questions where room_id = ${q(room.id)}`
);
ok(spread.n > 1, `a kerék több kategóriát is kiadott (${spread.n} kategória / ${spread.total} kérdés)`);

// ─────────────────── 10. végig kibírt kör ───────────────────
//
// Ez a jutalomtáblát hitelesíti: az 5. kérdés 2000, a 10. pedig 5000 pont.
// Ha az indexelés elcsúszna (0-alapú vs 1-alapú tömb), itt kiderül.

console.log('\n10. Aki mind a 10 kérdést eltalálja, a teljes pontot kapja');

let solo = await asPlayer(
  ANNA,
  `select public.create_room(2::smallint, 1::smallint, null, null, 20::smallint, null)`
);
solo = (await asPlayer(BELA, `select public.join_room(${q(solo.id)}, null)`)).room;
solo = await asPlayer(ANNA, `select public.start_room(${q(solo.id)})`);

const seenOrdinals = [];
// A pörgetési ablakot MÉG a saját előretekerés előtt kell rögzíteni,
// különben a teszt a maga módosítását mérné.
const spinWindows = [];
for (let guard = 0; guard < 40 && solo.status === 'playing'; guard++) {
  solo = await asPlayer(ANNA, `select public.room_tick(${q(solo.id)})`);
  const current = solo.current_question;
  if (!current) continue;

  if (current.resolved) {
    await db.exec(
      `update public.room_questions set resolved_at = now() - interval '30 seconds'
       where id = ${q(current.id)}`
    );
    continue;
  }

  spinWindows.push({
    ordinal: current.ordinal,
    spin: Math.round(
      (Date.parse(current.answer_open_at) - Date.parse(solo.server_time)) / 1000
    )
  });

  await db.exec(
    `update public.room_questions set answer_open_at = now() where id = ${q(current.id)}`
  );
  seenOrdinals.push(current.ordinal);
  const correct = await correctIndexOf(current.id);

  // Anna mindent eltalál, Béla mindent elvét – de Béla kiesése ne zárja le a kört.
  await asPlayer(
    ANNA,
    `select public.answer_room_question(${q(solo.id)}, ${q(current.id)}, ${correct}::smallint, 900)`
  );
  try {
    await asPlayer(
      BELA,
      `select public.answer_room_question(${q(solo.id)}, ${q(current.id)}, ${(correct + 1) % 4}::smallint, 900)`
    );
  } catch {
    /* Béla már kiesett */
  }
}

ok(solo.status === 'finished', `a kör lefutott (${solo.status})`);
ok(
  JSON.stringify(seenOrdinals) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  `mind a tíz kérdés sorban jött (${seenOrdinals.join(',')})`
);

// EGY KÖR = EGY KATEGÓRIA. Ez az alapértelmezés, tehát a 10 kérdés mind
// ugyanabból a kategóriából jött.
const soloCats = await one(
  `select count(distinct category_id)::int as n, count(*)::int as total
   from public.room_questions where room_id = ${q(solo.id)}`
);
ok(
  soloCats.n === 1,
  `a kör mind a ${soloCats.total} kérdése EGY kategóriából jött (${soloCats.n} kategória)`
);
ok(soloCats.total === 10, `tíz kérdés volt a körben (${soloCats.total})`);

// A pörgetés (és az utána következő olvasási szünet) CSAK a kör első kérdése
// előtt van – a többinél nulla, különben minden kérdés előtt várni kellene.
ok(
  spinWindows[0]?.spin >= 5,
  `a kör ELSŐ kérdése előtt van pörgetési szünet (${spinWindows[0]?.spin} mp)`
);
ok(
  spinWindows.slice(1).every((row) => row.spin <= 0),
  'a kör további kérdései előtt NINCS pörgetés – a kategória ugyanaz marad'
);

// A szobaállapot a kérdések KÖZÖTT is tudja, melyik kategóriában vagyunk –
// erre épül a felső sáv, ami a kiértékelés közben sem üresedik ki.
const roundInfo = (
  await one(
    `select c.name from public.room_questions rq
     join public.categories c on c.id = rq.category_id
     where rq.room_id = ${q(solo.id)} order by rq.ordinal limit 1`
  )
).name;
ok(Boolean(roundInfo), `a kör kategóriája megnevezhető (${roundInfo})`);

const soloPlayers = new Map((solo.players ?? []).map((p) => [p.player_id, p]));
// 1–4. és 6–9. kérdés 1000, az 5. kérdés 2000, a 10. pedig 5000 pont.
ok(
  soloPlayers.get(ANNA).score === 15000,
  `a hibátlan kör 15 000 pont (kapott: ${soloPlayers.get(ANNA).score})`
);
ok(soloPlayers.get(BELA).score === 0, 'aki az első kérdést elvétette, nulla pontot kapott');

// ─────────────────── 11. vendégjáték ───────────────────
//
// Vendég (névtelen) játékos ugyanúgy játszhat és szobát is csinálhat, de a
// pontja nem kerül a NYILVÁNOS ranglistára – a neve automatikusan generált,
// és a fiók bármikor eldobható. A saját statisztikáját viszont látja.

console.log('\n11. Vendég játszhat, de nem kerül a ranglistára');

const GUEST = (
  await one(
    `insert into auth.users (email, raw_user_meta_data, is_anonymous)
     values (null, jsonb_build_object('nickname', 'Vendeg', 'is_anonymous', true), true)
     returning id`
  )
).id;

ok(
  (await one(`select is_anonymous from public.profiles where id = ${q(GUEST)}`)).is_anonymous === true,
  'a vendég profilja vendégként jött létre'
);

// Nagyon magas pontszám: ha bekerülne, biztosan az élen lenne.
await db.exec(
  `insert into public.game_results (player_id, mode, score, questions, correct, is_trusted)
   values (${q(GUEST)}, 'multiplayer', 999999, 10::smallint, 10::smallint, true)`
);

const boardWithGuest = (
  await db.query(`select * from public.leaderboard('all_time', 50::int)`)
).rows;
ok(
  !boardWithGuest.some((row) => row.player_id === GUEST),
  'a vendég 999 999 pontja NEM jelenik meg a ranglistán'
);
ok(boardWithGuest.length > 0, 'a bejelentkezett játékosok viszont ott vannak');

// A saját statisztikájában viszont látszik.
const guestStats = await asPlayer(GUEST, 'select public.my_stats()');
ok(
  Number(guestStats?.profile?.total_score ?? 0) > 0,
  `a vendég a SAJÁT statisztikájában látja a pontját (${guestStats?.profile?.total_score})`
);

// Vendég is csinálhat szobát.
const guestRoom = await asPlayer(
  GUEST,
  `select public.create_room(2::smallint, 1::smallint, null, 1::smallint, 15::smallint, '111')`
);
ok(guestRoom.status === 'lobby', 'a vendég is tud szobát létrehozni');
ok(guestRoom.i_am_guest === true, 'a szobaállapot jelzi, hogy vendég vagyok');
ok(
  guestRoom.players?.[0]?.is_guest === true,
  'a játékoslistán is meg van jelölve a vendég'
);

// ─────────────────── 12. vendégfiók átalakítása igazi fiókká ───────────────────
//
// Ez a korábbi hibát fedi le: a `profiles.is_anonymous` mezőt csak a BESZÚRÁS
// triggere állította, tehát ha egy vendég e-mailt adott meg, a profilja
// vendégként maradt jelölve – és a ranglistából örökre kimaradt volna.

console.log('\n12. A vendég igazi fiókká alakulva felkerül a ranglistára');

ok(
  (await one(`select is_anonymous from public.profiles where id = ${q(GUEST)}`)).is_anonymous === true,
  'kiinduláskor a profil vendégként van jelölve'
);

// Ezt teszi a GoTrue, amikor a vendég e-mailt és jelszót ad meg
// (PUT /auth/v1/user): ugyanaz a felhasználó, csak már nem névtelen.
await db.exec(
  `update auth.users
   set email = 'vendeg@example.test', is_anonymous = false
   where id = ${q(GUEST)}`
);

ok(
  (await one(`select is_anonymous from public.profiles where id = ${q(GUEST)}`)).is_anonymous === false,
  'a trigger átállította a profilt igazi fiókra'
);

const boardAfterUpgrade = (
  await db.query(`select * from public.leaderboard('all_time', 50::int)`)
).rows;
ok(
  boardAfterUpgrade.some((row) => row.player_id === GUEST),
  'az átalakított fiók MOSTMÁR szerepel a ranglistán'
);
ok(
  Number(boardAfterUpgrade.find((row) => row.player_id === GUEST)?.total_score) === 999999,
  'a vendégként gyűjtött pontja megmaradt'
);

// Védekező ág: ha a GoTrue nem állítaná az `is_anonymous` jelzőt, az e-mail
// jelenléte is elég ahhoz, hogy ne vendégnek számítson.
const GUEST2 = (
  await one(
    `insert into auth.users (email, raw_user_meta_data, is_anonymous)
     values (null, jsonb_build_object('nickname', 'Vendeg2', 'is_anonymous', true), true)
     returning id`
  )
).id;
await db.exec(`update auth.users set email = 'v2@example.test' where id = ${q(GUEST2)}`);
ok(
  (await one(`select is_anonymous from public.profiles where id = ${q(GUEST2)}`)).is_anonymous === false,
  'ha csak az e-mail jelenik meg (is_anonymous marad), az is igazi fióknak számít'
);

// ─────────────────── 13. szoba bezárása ───────────────────

console.log('\n13. A készítő bezárhatja a szobát, más nem');

let closable = await asPlayer(
  ANNA,
  `select public.create_room(3::smallint, 1::smallint, null, 1::smallint, 15::smallint, '222')`
);
const joined13 = await asPlayer(BELA, `select public.join_room(${q(closable.id)}, '222')`);
ok(joined13.ok === true, 'egy másik játékos belépett a szobába');

// A lista megmondja, kinek a szobája – enélkül a felület nem tudná, hol
// mutasson törlés-gombot.
const listAnna = await asPlayer(ANNA, `select public.list_open_rooms(30::int)`);
const listBela = await asPlayer(BELA, `select public.list_open_rooms(30::int)`);
ok(
  listAnna.find((r) => r.id === closable.id)?.i_am_host === true,
  'a készítőnél i_am_host = true'
);
ok(
  listBela.find((r) => r.id === closable.id)?.i_am_host === false,
  'a belépőnél i_am_host = false'
);

// Nem a készítő nem zárhatja be – a gomb elrejtése nem védelem.
try {
  await asPlayer(BELA, `select public.close_room(${q(closable.id)})`);
  ok(false, 'nem a készítő NEM zárhatja be a szobát');
} catch (error) {
  ok(/csak a szoba létrehozója/i.test(error.message), 'nem a készítő NEM zárhatja be a szobát');
}

const closed = await asPlayer(ANNA, `select public.close_room(${q(closable.id)})`);
ok(closed.ok === true && closed.already_closed === false, 'a készítő bezárta a szobát');
ok(
  (await one(`select status from public.rooms where id = ${q(closable.id)}`)).status === 'cancelled',
  'a szoba állapota cancelled lett'
);
ok(
  !(await asPlayer(ANNA, `select public.list_open_rooms(30::int)`)).some(
    (r) => r.id === closable.id
  ),
  'a bezárt szoba eltűnt a nyitott szobák listájáról'
);

// Idempotens: kétszeri bezárás nem hiba.
const again = await asPlayer(ANNA, `select public.close_room(${q(closable.id)})`);
ok(again.already_closed === true, 'a kétszeri bezárás nem hiba, csak jelzi');

// A többiek kliense a szobaállapotból látja, hogy vége.
const seenByBela = await asPlayer(BELA, `select public.room_state(${q(closable.id)})`);
ok(seenByBela.status === 'cancelled', 'a benne lévő játékos is látja, hogy a szoba bezárt');

// ─────────────────── 14. beszólások ───────────────────

console.log('\n14. Beszólások: csak katalógusból, csak a szobából, visszafogva');

let reactRoom = await asPlayer(
  ANNA,
  `select public.create_room(3::smallint, 1::smallint, null, 1::smallint, 15::smallint, null)`
);
const joined14 = await asPlayer(BELA, `select public.join_room(${q(reactRoom.id)}, null)`);
ok(joined14.ok === true, 'BELA belépett a beszólás-tesztszobába');

// A VÁRÓBAN még nem lehet beszólni: az üzenet a játék tetején villan fel.
const inLobby = await asPlayer(ANNA, `select public.send_room_reaction(${q(reactRoom.id)}, 'gg')`);
ok(inLobby.ok === false && inLobby.error === 'not_playing', 'a váróban nem lehet beszólni');

reactRoom = await asPlayer(ANNA, `select public.start_room(${q(reactRoom.id)})`);
ok(reactRoom.status === 'playing', 'a szoba elindult');

// A KATALÓGUSON KÍVÜLI azonosítót a szerver elutasítja. Ez a lényegi
// védelem: a kliens szabad szöveget nem tud átjuttatni.
const bogus = await asPlayer(
  ANNA,
  `select public.send_room_reaction(${q(reactRoom.id)}, 'A helyes válasz a B!')`
);
ok(
  bogus.ok === false && bogus.error === 'unknown_reaction',
  'a katalóguson kívüli szöveget a szerver elutasítja'
);

const sent = await asPlayer(ANNA, `select public.send_room_reaction(${q(reactRoom.id)}, 'gg')`);
ok(sent.ok === true, 'a katalógusból választott beszólás elmegy');

// Visszafogás: 3 másodpercen belül nem jöhet a következő ugyanattól.
const tooFast = await asPlayer(ANNA, `select public.send_room_reaction(${q(reactRoom.id)}, 'hurry')`);
ok(
  tooFast.ok === false && tooFast.error === 'too_fast',
  'ugyanaz a játékos 3 másodpercen belül nem szólhat be újra'
);

// MÁS játékost ez nem érint – a korlát játékosonként van.
const otherPlayer = await asPlayer(BELA, `select public.send_room_reaction(${q(reactRoom.id)}, 'hurry')`);
ok(otherPlayer.ok === true, 'a visszafogás játékosonként külön számol');

// Kívülálló nem szólhat be egy szobába, amiben nincs benne.
const outsider = await asPlayer(CILI, `select public.send_room_reaction(${q(reactRoom.id)}, 'gg')`);
ok(
  outsider.ok === false && outsider.error === 'not_in_room',
  'aki nincs a szobában, nem tud beszólni'
);

// A szobaállapot visszaadja a friss üzeneteket, SZÖVEGGEL – a szöveg
// a szerveren van, a kliens csak megjeleníti.
const stateWithReactions = await asPlayer(BELA, `select public.room_state(${q(reactRoom.id)})`);
const reactions = stateWithReactions.reactions ?? [];
ok(reactions.length === 2, `a szobaállapot mindkét friss beszólást visszaadja (${reactions.length})`);
ok(
  reactions.some((r) => r.body === 'Ez nagyon jó volt!'),
  'a beszólás SZÖVEGE a szerverről érkezik'
);
ok(
  reactions.every((r) => typeof r.nickname === 'string' && r.nickname.length > 0),
  'minden beszóláshoz tartozik feladó'
);

// A 8 másodpercnél régebbi üzenet kiesik: ez nem üzenetfal.
await db.exec(
  `update public.room_reactions set created_at = now() - interval '20 seconds'
   where room_id = ${q(reactRoom.id)}`
);
const afterExpiry = await asPlayer(BELA, `select public.room_state(${q(reactRoom.id)})`);
ok(
  (afterExpiry.reactions ?? []).length === 0,
  'a régi beszólások kiesnek – nincs visszaolvasható üzenetfal'
);

// A tábla közvetlenül NEM olvasható és NEM írható a kliens szerepében:
// csak a függvényeken keresztül, ahol a szűrés nem kerülhető ki.
try {
  const rows = await asClient(BELA, `select * from public.room_reactions`);
  ok(false, `a room_reactions táblát nem lehet közvetlenül olvasni (${rows.length} sor jött)`);
} catch {
  ok(true, 'a room_reactions táblát a kliens közvetlenül nem olvashatja');
}
try {
  await asClient(
    BELA,
    `insert into public.room_reactions (room_id, player_id, reaction_id)
     values (${q(reactRoom.id)}, ${q(BELA)}, 'gg')`
  );
  ok(false, 'a room_reactions táblába nem lehet közvetlenül írni');
} catch {
  ok(true, 'a room_reactions táblába a kliens közvetlenül nem írhat');
}

// A katalógus viszont olvasható: a kliensnek meg kell tudnia jeleníteni.
const catalogRows = await asClient(
  BELA,
  `select id, body from public.reaction_catalog order by sort_order`
);
ok(catalogRows.length >= 10, `a katalógus olvasható a kliensnek (${catalogRows.length} tétel)`);

// ─────────────────── 15. ismétlődés elleni védelem (host-történet) ───────────────────

console.log('\n15. X napig ne jöjjön ugyanaz a kérdés a szobát INDÍTÓ profilnak');

// Csak EGY kategóriát hagyunk aktívan, hogy a kérdésválasztás determinisztikus
// legyen (ne ugorjon másik, "tiszta" kategóriára).
const historyCategory = cats[0];
await db.exec(`update public.categories set is_active = false where id <> ${q(historyCategory.id)}`);

const catQuestionIds = (
  await db.query(
    `select id from public.questions where category_id = ${q(historyCategory.id)} order by question_text`
  )
).rows.map((r) => r.id);
ok(catQuestionIds.length === 14, `a teszt-kategóriában 14 kérdés van (${catQuestionIds.length})`);

// FRISS profilokkal dolgozunk (nem ANNA/BELA/CILI/DORA-val): a korábbi
// szakaszok (pl. a 10.) az ANNA-t hostoló "solo" szobában VÉLETLENSZERŰEN
// választott kategóriát az öt teszt-kategória közül – ha ez a véletlen épp
// a `historyCategory`-ra esett volna, ANNA host-történetében már eleve
// "látott" lenne néhány kérdés ebből a kategóriából, ami ezt a tesztet
// ritkán (kb. 1/5 eséllyel) hibásan buktatta volna (a 14. kérdés helyett a
// preferencia-elengedés miatt véletlenszerű kérdés jönne ki). Ezt zárja ki
// a vadonatúj GIZELLA/HUBA/ILDIKO/JANOS négyes.
const GIZELLA = (
  await one(
    `insert into auth.users (email, raw_user_meta_data)
     values ('gizella@example.test', jsonb_build_object('nickname', 'Gizella'))
     returning id`
  )
).id;
const HUBA = (
  await one(
    `insert into auth.users (email, raw_user_meta_data)
     values ('huba@example.test', jsonb_build_object('nickname', 'Huba'))
     returning id`
  )
).id;
const ILDIKO = (
  await one(
    `insert into auth.users (email, raw_user_meta_data)
     values ('ildiko@example.test', jsonb_build_object('nickname', 'Ildiko'))
     returning id`
  )
).id;
const JANOS = (
  await one(
    `insert into auth.users (email, raw_user_meta_data)
     values ('janos@example.test', jsonb_build_object('nickname', 'Janos'))
     returning id`
  )
).id;

// GIZELLA egy KORÁBBI (tegnapi) szobájában már "látta" a kérdések 13-át.
const historyRoom = await asPlayer(
  GIZELLA,
  `select public.create_room(2::smallint, 1::smallint, null, 1::smallint, 15::smallint, null)`
);
for (let i = 0; i < 13; i++) {
  await db.exec(
    `insert into public.room_questions
       (room_id, block_no, ordinal, question_id, category_id, started_at, answer_open_at, deadline_at)
     values (${q(historyRoom.id)}, 1, ${i + 1}, ${q(catQuestionIds[i])}, ${q(historyCategory.id)},
             now() - interval '1 day', now() - interval '1 day',
             now() - interval '1 day' + interval '15 seconds')`
  );
}

// Új szoba, UGYANAZ a host (Gizella) – az egyetlen aktív kategóriában a 13
// "látott" kérdés helyett a MARADÉK (14.) kérdésnek kell kijönnie.
let repeatRoom = await asPlayer(
  GIZELLA,
  `select public.create_room(2::smallint, 1::smallint, null, 1::smallint, 15::smallint, null)`
);
await asPlayer(HUBA, `select public.join_room(${q(repeatRoom.id)}, null)`);
repeatRoom = await asPlayer(GIZELLA, `select public.start_room(${q(repeatRoom.id)})`);

ok(
  repeatRoom.current_question?.category_slug === historyCategory.slug,
  'az egyetlen aktív kategóriát választotta (a teszt előfeltétele)'
);
const pickedQuestionId = (
  await one(
    `select question_id as id from public.room_questions
     where room_id = ${q(repeatRoom.id)} order by ordinal limit 1`
  )
).id;
ok(
  pickedQuestionId === catQuestionIds[13],
  'Gizella 13, korábban látott kérdését elkerülve a maradék (14.) kérdés jött ki'
);

// MÁSIK host (Ildikó) ugyanabban a kategóriában viszont SZABADON kaphatja
// meg bármelyik kérdést – a védelem a HOSTHOZ kötött, nem a kategóriához.
let otherHostRoom = await asPlayer(
  ILDIKO,
  `select public.create_room(2::smallint, 1::smallint, null, 1::smallint, 15::smallint, null)`
);
await asPlayer(JANOS, `select public.join_room(${q(otherHostRoom.id)}, null)`);
otherHostRoom = await asPlayer(ILDIKO, `select public.start_room(${q(otherHostRoom.id)})`);
ok(
  Boolean(otherHostRoom.current_question),
  'más hostnál (Ildikó) Gizella előzménye nem akadályozza a kérdésválasztást'
);

// A VÉGSŐ FALLBACK: ha a hostnak MÁR AZ ÖSSZES kérdést kiadtuk ebben a
// kategóriában, a preferencia elengedhető – a játék nem szakadhat meg emiatt.
await db.exec(
  `insert into public.room_questions
     (room_id, block_no, ordinal, question_id, category_id, started_at, answer_open_at, deadline_at)
   values (${q(historyRoom.id)}, 1, 14, ${q(catQuestionIds[13])}, ${q(historyCategory.id)},
           now() - interval '1 day', now() - interval '1 day',
           now() - interval '1 day' + interval '15 seconds')`
);
let exhaustedRoom = await asPlayer(
  GIZELLA,
  `select public.create_room(2::smallint, 1::smallint, null, 1::smallint, 15::smallint, null)`
);
await asPlayer(HUBA, `select public.join_room(${q(exhaustedRoom.id)}, null)`);
exhaustedRoom = await asPlayer(GIZELLA, `select public.start_room(${q(exhaustedRoom.id)})`);
ok(
  Boolean(exhaustedRoom.current_question),
  'ha a hostnak MÁR MINDENT kiadtunk, a preferencia elengedve is folytatódik a játék'
);

// Kategóriák visszaállítása, hogy a fájl végén futó egyéb ellenőrzések (ha
// bővülne a teszt) ne lássanak csonka kategórialistát.
await db.exec(`update public.categories set is_active = true`);

// ─────────────────── 16. teljes játékban ismétlődésmentes kategóriák ───────────────────

console.log('\n16. Egy teljes játékban nem ismétlődik kategória, amíg van elég másik');

// questions_per_category = 1, tehát MINDEN kérdés előtt újra választunk
// kategóriát – ez az 5 teszt-kategóriánkat gyorsan, egy blokkon belül végig
// futtatja, és jól méri, hogy az összes eddig ELŐFORDULT (nem csak az
// utóbbi három) kategóriát kerüli-e a választás.
//
// FRISS, még sosem hostolt profilokkal indítjuk – ANNA (és a többi eddig
// használt teszt-játékos) host-történetében a korábbi szakaszok (10., 15.)
// már felhasználták a kis, 14 kérdéses teszt-kategóriák nagy részét, ami a
// 30 napos host-preferencián keresztül (jogosan) fallback-be kényszerítené
// ezt a tesztet is – ez itt a kategória-változatosságot vizsgálja, nem a
// host-előzményt, ezért azt a változót nullázzuk egy vadonatúj hosttal.
const EMOKE = (
  await one(
    `insert into auth.users (email, raw_user_meta_data)
     values ('emoke@example.test', jsonb_build_object('nickname', 'Emoke'))
     returning id`
  )
).id;
const FERENC = (
  await one(
    `insert into auth.users (email, raw_user_meta_data)
     values ('ferenc@example.test', jsonb_build_object('nickname', 'Ferenc'))
     returning id`
  )
).id;

let varietyRoom = await asPlayer(
  EMOKE,
  `select public.create_room(2::smallint, 1::smallint, null, 1::smallint, 15::smallint, null)`
);
await asPlayer(FERENC, `select public.join_room(${q(varietyRoom.id)}, null)`);
varietyRoom = await asPlayer(EMOKE, `select public.start_room(${q(varietyRoom.id)})`);

const varietySlugs = [];
for (let guard = 0; guard < 20 && varietySlugs.length < 5; guard++) {
  varietyRoom = await asPlayer(EMOKE, `select public.room_tick(${q(varietyRoom.id)})`);
  const current = varietyRoom.current_question;
  if (!current) continue;

  if (current.resolved) {
    await db.exec(
      `update public.room_questions set resolved_at = now() - interval '30 seconds'
       where id = ${q(current.id)}`
    );
    continue;
  }

  varietySlugs.push(current.category_slug);
  await db.exec(
    `update public.room_questions set answer_open_at = now() where id = ${q(current.id)}`
  );
  const correct = await correctIndexOf(current.id);
  await asPlayer(
    EMOKE,
    `select public.answer_room_question(${q(varietyRoom.id)}, ${q(current.id)}, ${correct}::smallint, 900)`
  );
  await asPlayer(
    FERENC,
    `select public.answer_room_question(${q(varietyRoom.id)}, ${q(current.id)}, ${correct}::smallint, 900)`
  );
}

ok(
  new Set(varietySlugs).size === varietySlugs.length,
  `az első ${varietySlugs.length} kérdés mind KÜLÖNBÖZŐ kategóriából jött (${varietySlugs.join(', ')})`
);
ok(varietySlugs.length === 5, `mind az 5 elérhető kategória sorra került, mielőtt ismétlésre kerülne (${varietySlugs.length})`);

// ─────────────────── összegzés ───────────────────

console.log(
  failures === 0
    ? `\nADATBÁZIS-TESZT: MINDEN RENDBEN (${checks} ellenőrzés)\n`
    : `\nADATBÁZIS-TESZT: ${failures} HIBA / ${checks} ellenőrzés\n`
);

await db.close();
process.exit(failures === 0 ? 0 : 1);
