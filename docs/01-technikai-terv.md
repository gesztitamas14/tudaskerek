# TudásKerék – technikai terv

> Munkanév: **TudásKerék**. Önálló megvalósítás, saját UI, saját kérdésbank.
> A Kvízkerék semmilyen tartalma (kérdés, grafika, szöveg) nem kerül
> felhasználásra – lásd `06-kvizkerek-kutatas.md`.

## 1. Platformdöntés: PWA

A projekt natív iOS appként indult, majd **webalkalmazásra (PWA) váltott**.
Az indoklás:

| | PWA | Natív iOS |
|---|---|---|
| Fejlesztés Windowson | igen | nem: macOS + Xcode kell |
| Megosztás másokkal | egy link | Apple Developer Program, 99 USD/év |
| Költség | 0 Ft | 99 USD/év (TestFlight/App Store) |
| Frissítés | azonnal, mindenkinél | app-review, letöltés |
| Offline működés | igen (service worker) | igen |
| Android + desktop | igen, ugyanaz a kód | nem |
| Haptikus visszajelzés | iOS Safariban nincs | van |
| App Store jelenlét | nincs | van |

A döntő szempont: **natív iOS appot ingyen nem lehet más ember telefonjára
juttatni.** A fordítás Mac nélkül is megoldható (felhő-CI), de minden
terjesztési mód – TestFlight, Ad Hoc, App Store – fizetős fejlesztői tagságot
igényel. A PWA ma megosztható, holnap már játszható vele.

Amit ezzel elveszítünk és tudatosan vállalunk: a rezgés iOS-en, az App Store
jelenlét és a natív rendszerintegráció.

## 2. Technológiai döntések

| Terület | Döntés | Indoklás |
|---|---|---|
| Kliens | PWA: HTML + CSS + ES modulok | **nincs build lépés** – a `web/` mappa önmagában a kész alkalmazás; Windowson azonnal futtatható, bármely statikus hostra kirakható |
| Keretrendszer | nincs | 2236 kérdés és 8 képernyő nem igényel virtuális DOM-ot; a nulla függőség egyben nulla supply-chain kockázat |
| Offline | service worker: precache + stale-while-revalidate | az app első indításnál is játszható internet nélkül |
| Lokális tároló | `localStorage` a `store.js` absztrakció mögött | az adat kicsi (néhány száz eredmény) és szinkron, tehát nincs versenyhelyzet a játékmenet közben; IndexedDB-re cserélhető, ha egyszer tízezres lesz a helyi bank |
| Kerék | `<canvas>` + `requestAnimationFrame` | 22 cikk és felirat egyetlen rétegben; a végszög előre kiszámolt, az animáció csak megjeleníti |
| Backend | **Supabase** (menedzselt Postgres) | lásd 3. pont |
| Hálózat | sima `fetch`, saját vékony kliens | nincs `@supabase/supabase-js` függőség; a REST-szerződés azonos, az SDK bármikor becserélhető |
| Auth | anonim (vendég) + Google OAuth + e-mail/jelszó | regisztráció nélkül is legyen szerveroldali pontszám és ranglista-hely |
| Hosting | GitHub Pages, GitHub Actions deployjal | ingyenes, HTTPS-t ad (a service worker megköveteli), a kód mellett van |
| Admin | build nélküli statikus web app (sima `fetch` + PostgREST) | „nem kell szépnek lennie”, nulla toolchain |
| Pipeline | Node 20+, sima ESM szkriptek | seed import, AI generálás, dedup, fact-check – függőség nélkül (kivéve az AI generálás: hivatalos `@anthropic-ai/sdk`) |

### Miért Supabase?

1. **Postgres.** A kérdésbank relációs adat, és a legfontosabb nem funkcionális
   követelmény – a **deduplikáció** – Postgresben triviális (`pg_trgm` trigram
   hasonlóság + `unaccent`). Firestore/D1 esetén ezt kézzel kellene megírni.
2. **Kérdéskiválasztás szerveroldalon.** Egy SQL függvény (`rpc/next_question`)
   egyszerre kezeli a kategória/nehézség szűrést, a session-en belüli és a
   játékos élettörténetén átnyúló kizárást, valamint a népszerűség és a találati
   arány szerinti súlyozást. Firestore-ban ez egy körben nem megoldható.
3. **RLS.** A „helyes válasz ne szivárogjon ki” követelmény deklaratívan
   megoldható: a kliens egy `questions_public` nézetet lát `correct_answer`
   nélkül, a validáció `security definer` SQL függvényben fut.
4. **Illeszkedik a statikus hostinghoz.** A GitHub Pages csak fájlokat szolgál
   ki; adatbázis-hozzáférés csak úgy lehetséges, ha a böngésző közvetlenül beszél
   egy külső API-val. A Supabase pontosan ezt adja (PostgREST + RLS), saját
   backend szerver nélkül.
5. **Free tier bőven elég.** 500 MB DB – 50 000 kérdés kb. 40–60 MB. 50k MAU
   auth, 5 GB egress.

**Ellenérv, amit vállalunk:** a free tier projekt hosszabb inaktivitás után
felfüggeszthető (a dashboardról visszaindítható). A séma bármikor átvihető
self-hosted Postgresre.

## 3. Rétegek

```
+---------------------- PWA (web/) --------------------------+
| app.js          bootstrap, hash-router, shell              |
| screens.js      home, statisztika, ranglista, profil,      |
|                 beállítások, névjegy                        |
| game-screen.js  a kör vezénylése                            |
| multiplayer.js  lobby, szoba, nézői kérdéspanel             |
+------------------------------------------------------------+
| rules.js        GameEngine, ScoringRules, kerékmatematika   |
|                 (tiszta logika, 30 egységteszt)             |
| wheel.js        canvas rajzolás + pörgetés                  |
+------------------------------------------------------------+
| api.js          Supabase kliens, OnlineDriver,              |
|                 OfflineDriver, SyncService, QuestionBank    |
| store.js        localStorage: beállítás, eredmény,          |
|                 előtörténet, kimenő sor                     |
+------------------------------------------------------------+
                          |  HTTPS
+----------------------- Supabase ---------------------------+
| Postgres: categories . questions . question_stats           |
|           profiles . game_sessions . session_questions      |
|           game_results . rooms . room_players                |
|           room_questions . room_answers (kieséses multiplayer) |
|           question_candidates (AI review) . scoring_rules    |
| RLS + SECURITY DEFINER RPC (25 db)                           |
| Edge Function NINCS: a logika SQL-ben van, az adat mellett    |
+------------------------------------------------------------+
                          |
+-- admin/ (statikus) -----+   +-- tools/ (Node CLI) --------+
| kérdés CRUD, review,     |   | seed build/import           |
| import/export, kategória |   | AI generálás, Wikidata      |
+--------------------------+   | dedup, fact-check           |
                               +------------------------------+
```

## 4. Játéklogika

`GameEngine` egy tiszta állapotgép, nincs benne I/O:

```
idle -> spinning -> question -> revealed
                                 |-> (folytat) spinning
                                 +-> finished (banked | busted | completed)
```

- Kör: legfeljebb 10 kérdés.
- Helyes válasz: `score += reward(ordinal)`.
- Hibás válasz: `score = floor(score * 0.5)`, és a kör véget ér.
- „Megállok”: a `score` végleges lesz.
- Jutalomtábla (backendről felülírható, lokális fallbackkel):
  `[1000, 1000, 1000, 1000, 2000, 1000, 1000, 1000, 1000, 5000]`

A `resolve()` **nem dönti el, mi a helyes válasz** – azt kívülről kapja (online:
a szerver, offline: a lokális összehasonlítás). Ezért ugyanez a kód hajtja
mindkét módot, és nem kell ismernie a helyes választ.

## 5. Biztonsági modell

| Kockázat | Megoldás |
|---|---|
| Helyes válasz kiszivárgása | A kliens a `questions_public` nézetet olvassa (`correct_answer` nincs benne). A helyes index csak a válasz beküldése után, a szerver válaszában jön vissza. |
| Megsúgás multiplayerben | Kieséses módban mindenki ugyanarra a kérdésre válaszol. A helyes válasz, a magyarázat és a többiek választásai **csak a kérdés lezárása után** kerülnek a szobaállapotba – annak sem előbb, aki már válaszolt. Így egy gyors játékos nem tudja bekiabálni a megoldást. |
| Pontszám-hamisítás | Online módban a szerver vezeti a session állapotát és számolja a végpontszámot. A kliens által számolt score csak offline módban elfogadott, `is_trusted = false` jelöléssel, és nem kerül a globális ranglistára. |
| Szerepkör-emelés | Mezőszintű `GRANT UPDATE (nickname, avatar_id, country)` a `profiles`-on, plusz RLS `with check` a `role` változatlanságára. |
| Secretek | A kliensbe csak a `SUPABASE_URL` és az `anon` kulcs kerül (nyilvános adat, RLS védi). A `service_role` kulcs és az `ANTHROPIC_API_KEY` kizárólag a `tools/.env` fájlban él, ami nincs verziókövetve. |
| AI-tartalom | Külön tábla (`question_candidates`), kötelező emberi jóváhagyás, a jóváhagyáskor újra futó duplikátum-ellenőrzés. |

## 6. Kérdésforrások (részletesen: `04-kerdesforrasok.md`)

- **Wikidata (CC0)** – gépi generálás strukturált tényekből. Attribúció nem
  kötelező, kereskedelmi használat szabad, ezért ez a fő automatizált forrás.
- **Wikipédia (CC BY-SA 4.0)** – csak tényellenőrzésre és forráshivatkozásra,
  szövegátvétel nélkül (a puszta tény nem szerzői jogvédett).
- **OpenTDB (CC BY-SA 4.0)** – opcionális, `license` mezővel elkülönítve,
  alapból kikapcsolva (a ShareAlike a származékos adatbázisra is kiterjed).
- **Saját AI-generálás** – a magyar kategóriák gerince, kötelező review-val.

## 7. Fázisok és leadás

| Fázis | Tartalom | Állapot |
|---|---|---|
| 1 | Projektszerkezet, design system, navigáció | ✅ |
| 2 | Kerék UI és fizikai lassulású pörgetés | ✅ |
| 3 | Kérdés UI, `GameEngine`, kör lezárás | ✅ |
| 4 | Lokális kérdésbank (2236 kérdés, 28 kategória) | ✅ |
| 5 | Supabase séma, RLS, 37 RPC | ✅ |
| 6 | Auth: vendég mód, Google OAuth, e-mail/jelszó | ✅ |
| 7 | Admin felület, AI pipeline, dedup, fact-check | ✅ |
| 8 | Offline cache, kimenő sor, szinkronizálás | ✅ |
| 9 | Statisztika, ranglista (örök/havi/heti/napi) | ✅ |
| 10 | Multiplayer szobák és nézői kérdéslátás | ✅ |
| 11 | Automatikus közzététel GitHub Pages-re | ✅ |

## 8. Monetizáció-előkészítés (nem implementált)

- `CONFIG.adsEnabled` – a UI már kérdezi, de mindig `false`.
- `question_packs` tábla és `questions.pack_id` a sémában; `NULL` = ingyenes.
  A `next_question` már szűr rá (`pack_id is null`), tehát egy fizetős csomag
  bevezetése nem nyit meg véletlenül tartalmat.
