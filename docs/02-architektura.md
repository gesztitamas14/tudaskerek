# Architektúra

## 1. A rendszer egésze

```
                        ┌───────────────────────────┐
                        │        Supabase           │
   ┌────────────┐       │  Postgres + RLS + RPC     │
   │  PWA       │◄─────►│  Auth (vendég/Google/mail)│
   │  web/      │  REST │  15 migráció, 37 RPC      │
   └────────────┘       └─────────────┬─────────────┘
         ▲                            ▲
         │                            │
         │              ┌─────────────┴─────────────┐
         │              │  admin/  – kérdéskezelés  │
         │              │  tools/  – AI pipeline    │
         │              └─────────────┬─────────────┘
         │                            │
         └──────── content/seed/*.json (a kérdésbank forrása) ───┘
                                  │
                      tools/src/build-seed.mjs
                                  │
                        web/seed-questions.json
```

**A közös igazság a `content/seed/*.json`.** Ebből épül a PWA-ba csomagolt
kérdésbank, és ugyanez kerül a Supabase adatbázisba. Nincs két külön
kérdéslista, ami elcsúszhatna.

## 2. Rétegek

```
app.js        – bootstrap, hash-router, shell, service worker frissítés
screens.js    – home, statisztika, ranglista, profil, beállítások, névjegy
game-screen.js– a kör vezénylése (kerék → kérdés → válasz → döntés → vége)
multiplayer.js– szobalista, PIN-es belépés, kieséses szoba
picker.js     – görgetős számjegyválasztó (szoba-PIN)
sound.js      – szintetizált játékhangok (nincs hangfájl)
─────────────────────────────────────────────────────────────
rules.js      – GameEngine, ScoringRules, kerékmatematika (30 egységteszt)
wheel.js      – canvas rajzolás + pörgetés
ui.js         – DOM-segédek, formázás, közös komponensek
─────────────────────────────────────────────────────────────
api.js        – Supabase kliens, OnlineDriver, OfflineDriver,
                SyncService, QuestionBank
store.js      – localStorage: beállítás, eredmény, előtörténet, kimenő sor
config.js     – a Supabase URL és anon kulcs (publikus adat)
```

Nincs keretrendszer és nincs build lépés. Ennek két konkrét haszna van:

1. **Windowson, toolchain nélkül fejleszthető** (`node tools/src/serve.mjs web`).
2. **Bármely statikus hostra kirakható**, és a GitHub Actions deploy nem tud
   „build hibával” elhasalni – csak a tesztek buktathatják meg.

## 3. A legfontosabb absztrakció: a session driver

Egyetlen felület, két implementáció:

```
start()                            → érvényes pontozási szabály
nextQuestion(category, difficulty) → kiszolgált kérdés
submit(questionId, answerIndex)    → értékelés
finish(localSummary)               → lezárt kör
```

| | OnlineDriver | OfflineDriver |
|---|---|---|
| Kérdés forrása | `rpc/next_question` | helyi bank |
| Ki tudja a helyes választ | csak a szerver | a kliens is (szükségszerűen) |
| Ki pontoz | a szerver | a kliens |
| Eredmény | `is_trusted = true` | `is_trusted = false` |
| Ranglista | beleszámít | nem számít |

A játékképernyő **nem tudja, melyikkel dolgozik**. Ezért:

- ugyanaz a UI és ugyanaz a szabálylogika fut mindkét módban,
- a kör közben megszakadó hálózat nem szakítja meg a játékot: a képernyő
  offline driverre vált és folytatja (jelzéssel),
- a repülőgép módban lejátszott kör később feltöltődik a kimenő sorból.

## 4. Offline-first működés

```
indítás
  ├─ beépített kérdésbank betöltése   (mindig sikerül, service worker cache)
  ├─ mentett session visszaállítása   (ha van backend)
  ├─ csendes anonim bejelentkezés     (ha van hálózat)
  └─ szinkronizálás a háttérben
       ├─ kimenő sor: offline eredmények feltöltése (idempotens, client_id)
       └─ offline_pack: friss kérdések letöltése (naponta egyszer)
```

Amit ez ad:

- **Az első indítás internet nélkül is játszható.** 2236 kérdés a csomagban.
- **Nem veszik el eredmény.** Minden kör azonnal lokálisan mentődik; a feltöltés
  kliens-generált UUID-vel idempotens.
- **Nem duplázódik eredmény.** A `submit_offline_result(p_client_id)` ugyanazzal
  az azonosítóval másodszor is `duplicate: true`-t ad, nem új sort.
- **Nem ragad be a kimenő sor.** Nem újrapróbálható hibánál (érvénytelen adat)
  az elem eldobódik; 8 kudarc után szintén.

## 5. Multiplayer

**Kieséses, egyidejű modell.** Egy szobában 2–5 játékos. A kerék **körönként
egyszer** pörög, és a kipörgetett kategóriából jön a kör **mind a 10 kérdése**.
A szoba minden még játékban lévő tagja **ugyanarra a kérdésre válaszol,
egyszerre, időre**. Aki hibázik vagy nem válaszol időben, kiesik a körből és
nézővé válik – a megszerzett pontjait megtartja. A kör akkor ér véget, ha elfogy
a 10 kérdés, vagy mindenki kiesett; ekkor a köri pontok beolvadnak az
összesítettbe, és **új pörgetés** hozza a következő kategóriát.

Egy játék alapból **10 kör = 10 kategória**.

Ez nem ugyanaz a mechanika, mint az egyjátékos press-your-luck kör: itt nincs
„megállok vagy továbbmegyek” döntés, mert azt nem lehet közösen meghozni. A
tét helyette a kiesés. A pontskála viszont ugyanaz (`scoring_rules`), tehát egy
hibátlan 10 kérdéses kör itt is 15 000 pont.

### A tick: egy RPC hajtja a játékot

A menetet a `room_tick(room)` vezeti, amit a kliensek pollozzák (1 s):

1. lezárja az aktuális kérdést, ha mindenki válaszolt vagy lejárt a határidő,
2. kiesteti a hibázókat és a nem válaszolókat,
3. a `reveal_seconds` letelte után továbblép a következő kérdésre,
4. a kör vagy a játék végén összesíti a pontokat,
5. visszaadja a teljes szobaállapotot.

**Miért így?** A tick `for update` zárolással dolgozik és idempotens, tehát
mindegy, hogy négy kliens hívja-e egyszerre: a lezárás és a továbbléptetés
pontosan egyszer történik meg. Nincs „gazda” kliens, akinek a kiesésével vagy
hálózatvesztésével megállna a játék, és nincs szükség külön háttérfolyamatra
(cron, Edge Function) sem – a szoba magát lépteti, amíg valaki nézi.

### Három fázis

| Fázis | Meddig | Mi látszik |
|---|---|---|
| pörgetés | `answer_open_at`-ig (6 mp, körönként egyszer) | a kerék kifut a kategóriára, **majd szünet elolvasni**; válaszok zárva |
| válasz | `deadline_at`-ig | kérdés + 4 lehetőség + visszaszámláló |
| kiértékelés | `reveal_seconds` | a helyes válasz zölden, a sajátom pirosan, és hogy kiestem-e |

A kiértékelés **szándékosan szűkszavú**: nincs magyarázat, és nincs
játékosonkénti „ki mit válaszolt” lista. Két okból: a képernyő pár másodpercig
látszik, tehát nincs idő elolvasni, a helyükre viszont kell a hely, hogy a
kérdés és mind a négy válasz **egy képernyőre kiférjen**.

**A kérdésképernyő fix magasságú és nem görgethető.** Időzített kérdésnél
elfogadhatatlan, hogy a negyedik válaszhoz görgetni kelljen. Ezért:

- a pontsáv **vízszintesen** görgethető, nem tördelődik több sorba – így a
  magassága akárhány játékosnál állandó,
- a válaszok a maradék helyet egyenlően osztják el (min. 44 px érintőfelület),
- hosszú kérdésnél a kérdés szövege kap saját, korlátozott görgetést,
- **játék közben nincs kilépés gomb** – helyet foglalna, és egy félrekattintás
  kiszakítana a körből. Aki mégis ki akar lépni, a vissza gombot használja: erre
  megjelenik a gomb (a `popstate` elkapása egy őrszem history-bejegyzéssel megy,
  a hash nem változik, ezért a router nem navigál el).

Ezt a `tools/src/browser-test.mjs` méri valódi telefonméretű keretben, több
látható magasságon (844, 700, 560, 520 px), 3 és 5 játékossal.

A pörgetés azért kap külön időablakot, mert különben az animáció ideje elvenne a
válaszidőből – és annak mindenkinél ugyanannyinak kell lennie. A szerver ezért
`answer_open_at`-ot is számol, nem csak határidőt, és a válasz beküldését is
elutasítja, amíg a kerék „pörög”.

Ez az ablak két részre oszlik: a kerék animációja (~2,5 mp), majd **idő
elolvasni, milyen kategória jött ki**. Ez azért nem lassítja a játékot, mert
körönként csak egyszer fordul elő – nem minden kérdés előtt. A kliens ezért
rövidebbet pörget, mint amennyi idő van, és a maradékban a kategória nevét
mutatja.

### Amit a szerver nem küld el

**A helyes válasz és a magyarázat addig SENKINEK nem megy ki, amíg a kérdés le
nem zárult** – akkor sem, aki már válaszolt. Ez SQL-ben van kikényszerítve
(`20260901091000_elimination_multiplayer.sql`), nem a felületen:

```sql
'correct_answer', case when v_rq.resolved_at is not null then q.correct_answer end
```

Két csalást zár ki. Egy: egy gyorsan válaszoló játékos nem tudja megsúgni a
többieknek, akik még gondolkodnak. Kettő: a `room_answers` sorok sem kerülnek ki
lezárás előtt, tehát abból sem lehet visszafejteni, mit tippelt a többség.

A kliens nem kerülheti meg: sem a `questions`, sem a `room_questions`, sem a
`room_answers` táblához nincs olvasási joga (nincs grant, RLS-szel), és a
kérdést csak a `security definer` RPC-k adhatják ki.

### Élő frissítés

Pollozás, nem WebSocket: játék közben 1 s, várakozó szobában 3 s. A felület csak
akkor épül újra, ha az állapot **érdemben** változott (aláírás-összehasonlítás) –
különben villogna és elveszne a görgetés. A visszaszámlálót egy külön, 200 ms-os
helyi óra rajzolja, DOM-csere nélkül, és az veszi észre a fázisváltást is.

A Supabase Realtime elő van készítve (publikáció + RLS a `rooms` és
`room_players` táblákra), de egy szobaállapot néhány száz bájt, mobilhálón a
WebSocket rendszeresen elszakad, és a pollozás nem tud beragadni: ha egy kérés
elveszik, a következő pótolja. Ráadásul a tick amúgy is szerveroldali hívást
igényel, tehát a WebSocket nem takarítana meg kört.

Az órák eltérését a kliens korrigálja: a szobaállapotban jön `server_time`, ebből
számol egy eltolást, és minden határidőt azzal értelmez.

## 6. Biztonsági modell

| Kockázat | Válasz |
|---|---|
| Helyes válasz kiszivárgása | `questions_public` nézet válasz nélkül; a helyes index csak a beküldés válaszában |
| Megsúgás multiplayerben | a helyes válasz csak a játékos válasza után kerül a szobaállapotba |
| Pontszám-hamisítás | online módban a szerver vezeti a sessiont és számol; offline eredmény `is_trusted = false`, és nem kerül a globális ranglistára |
| Szerepkör-emelés | mezőszintű `GRANT UPDATE (nickname, avatar_id, country)` + RLS `with check` |
| Admin API | `profiles.role` alapú RLS; a moderátori RPC-k maguk ellenőrzik a szerepkört |
| Secretek | kliensbe csak `SUPABASE_URL` + `anon` kulcs (nyilvános adat); `service_role` és `ANTHROPIC_API_KEY` csak `tools/.env`-ben |
| AI-tartalom a játékban | külön tábla, kötelező emberi jóváhagyás, jóváhagyáskor újra futó duplikátum-ellenőrzés |

## 7. Frissítés és gyorsítótár

A service worker stratégia **stale-while-revalidate**: azonnal a cache-ből
szolgál ki (ezért gyors és offline is működik), és a háttérben frissít. Ennek egy
következménye van, amit kezelni kell: **közvetlenül egy deploy után a felhasználó
még a régi verziót látja.**

Ezért a `web/js/app.js` figyeli a `controllerchange` eseményt: ha ÚJ service
worker vette át a lapot (tehát nem az első telepítés), egyszer újratölti az
oldalt. Így a felhasználónak nem kell semmit tennie, és nem keletkezik
„félig régi, félig új” állapot.

> Ez a jelenség egyszer a tesztet is megtévesztette: a fejnélküli böngésző a
> korábbi futás service workeréből szolgálta ki a régi JS-t. Ezért a
> `browser-test.mjs` minden futásnál **friss böngészőprofilt** használ.

## 8. Amit szándékosan NEM tettünk meg

- **Nincs saját backend szerver.** Nincs Node/Deno API réteg, amit üzemeltetni
  kellene. A logika `SECURITY DEFINER` SQL függvényekben van, az adat mellett.
- **Nincs npm-függőség a PWA-ban** és a legtöbb eszközben. Csak az AI generálás
  használ csomagot (a hivatalos Anthropic SDK-t és a zod sémákat).
- **Nincs build lépés.** Se bundler, se transpiler, se CSS-preprocesszor.
- **Nincs Edge Function.** Indoklás: `supabase/functions/README.md`.
