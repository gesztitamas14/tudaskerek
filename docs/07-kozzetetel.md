# Közzététel: hosting és adatbázis

Két különböző dolog kell, és **nem ugyanott futnak**:

| | Mit tartalmaz | Hol fut | Költség |
|---|---|---|---|
| **Statikus fájlok** (`web/`) | HTML, CSS, JS, ikonok, 1157 kérdés | GitHub Pages | 0 Ft |
| **Adatbázis + auth** | ranglista, multiplayer, központi kérdésbank | Supabase (felhő) | 0 Ft (free tier) |

Miért kettő? A GitHub Pages **csak fájlokat tud kiszolgálni** – nincs benne
szerveroldali kód és nincs adatbázis. Ezért az adatbázis egy külön szolgáltatásban
él, és a böngésző közvetlenül beszél vele HTTPS-en.

```
   telefon böngészője
        │
        ├──── HTTPS ────►  felhasznalo.github.io/tudaskerek/   (statikus fájlok)
        │                  index.html, js/*, seed-questions.json
        │
        └──── HTTPS ────►  xxxx.supabase.co                    (adatbázis + auth)
                           /rest/v1/rpc/next_question, leaderboard, room_state …
```

**Fontos:** a játék az adatbázis nélkül is teljesen működik (offline mód, 1157
beépített kérdés, statisztika). Az adatbázis a ranglistához és a
többjátékos módhoz kell.

---

## 1. Hosting GitHub Pages-en

### 1.1 Egyszeri beállítás

1. **Repó létrehozása** és a projekt feltöltése:

   ```bash
   cd e:/fun/kvízkerék
   git init
   git add .
   git commit -m "TudásKerék – első verzió"
   git branch -M main
   git remote add origin https://github.com/<felhasznalo>/tudaskerek.git
   git push -u origin main
   ```

2. **GitHub Pages bekapcsolása:** a repó oldalán
   **Settings → Pages → Build and deployment → Source: `GitHub Actions`**.

3. Ennyi. A `.github/workflows/deploy.yml` már a repóban van, és minden `main`-re
   küldött push után automatikusan:
   - validálja a kérdésbankot,
   - lefuttatja a játéklogika tesztjeit,
   - összeállítja a `seed-questions.json`-t,
   - legenerálja az ikonokat,
   - kirakja a `web/` mappát.

   Ha bármelyik teszt elhasal, **nem publikál** – így nem tud elromlott
   kérdésbank kimenni.

4. Az elkészült cím: `https://<felhasznalo>.github.io/tudaskerek/`
   (a repó nevétől függ; az Actions futás végén ki is írja).

### 1.2 Miért működik aloldalon is?

A GitHub Pages projekt-oldal nem a gyökérben van, hanem `/<repónév>/` alatt.
Minden hivatkozás ezért **relatív** (`./js/app.js`, `./seed-questions.json`), a
manifestben a `start_url` és a `scope` is `./`. Ezt le is teszteltük: a PWA
aloldalról kiszolgálva ugyanúgy betölti mind az 1157 kérdést.

A `web/.nojekyll` fájl azért kell, hogy a GitHub ne próbálja Jekyllel
feldolgozni a mappát.

### 1.3 Repó láthatósága

- **Publikus repó:** minden ingyenes, korlátlan.
- **Privát repó:** a GitHub Pages ingyenes csomagon **csak publikus** repóból
  publikál. Ha privát repót akarsz, két lehetőség: fizetős GitHub csomag, vagy
  **Cloudflare Pages** (privát repóból is ingyen publikál).

A kódban nincs titok: a Supabase `anon` kulcs kifejezetten publikus adat (a
hozzáférést a Row Level Security szabályozza), a `service_role` kulcs pedig
csak a `tools/.env`-ben van, ami nincs verziókövetve.

### 1.4 Alternatívák (mind ingyenes)

| Szolgáltatás | Előny | Beállítás |
|---|---|---|
| **GitHub Pages** | ott van, ahol a kód | Settings → Pages → GitHub Actions |
| **Cloudflare Pages** | privát repóból is, nagyon gyors | repó összekötése, build parancs: nincs, kimeneti mappa: `web` |
| **Netlify** | „drag & drop” is működik | húzd be a `web` mappát |
| **Vercel** | egyszerű import | output directory: `web` |

Mindegyik ad HTTPS-t – ez **kötelező**, mert a service worker (offline működés)
csak HTTPS-en (vagy `localhost`-on) fut.

### 1.5 Telepítés iPhone-ra

Ezt küldd a barátaidnak a linkkel együtt:

> 1. Nyisd meg a linket **Safariban**.
> 2. Alul koppints a **Megosztás** ikonra.
> 3. Válaszd a **„Főképernyőhöz adás”** lehetőséget.
> 4. Innen saját ikonnal, teljes képernyőn indul, és internet nélkül is működik.

Érdemes telepíteni, mert így a Safari nem törli az adatokat (a nem telepített
oldalak scriptből írt tárolóját 7 nap inaktivitás után törölheti), és nincs
címsor.

---

## 2. Az adatbázis: hol fut és hogyan tölthető fel?

### 2.1 Hol fut?

A **Supabase** felhőben – ez egy menedzselt PostgreSQL adatbázis auth-tal és
REST API-val. Az ingyenes csomag ehhez a projekthez bőven elég:

| Erőforrás | Free tier | Amire nekünk kell |
|---|---|---|
| Adatbázis | 500 MB | 50 000 kérdés is kb. 40–60 MB |
| Auth | 50 000 aktív felhasználó / hó | vendég + Apple bejelentkezés |
| Egress | 5 GB / hó | egy kérdés kb. 300 bájt |
| Projekt | 2 db | dev + éles |

**Egy megkötés, amit tudni kell:** a Supabase ingyenes projektet hosszabb
inaktivitás után felfüggeszthetik (a dashboardról egy kattintással
visszaindítható). Ha a barátaid rendszeresen játszanak, ez nem fordul elő.

Nem kell szervert üzemeltetni: nincs saját backend kód, a logika
`SECURITY DEFINER` SQL függvényekben van, az adat mellett.

### 2.2 Séma létrehozása

Regisztráció után (<https://supabase.com>, region: EU – Frankfurt), a projekt
elkészülésekor:

**A) Supabase CLI-vel (ajánlott)**

```bash
npx supabase link --project-ref <projekt-ref>
npx supabase db push
```

**B) Kézzel, az SQL Editorban**

A `supabase/migrations/` fájljait **fájlnév szerinti sorrendben** másold be és
futtasd le (a sorrend kötelező, mert egymásra épülnek):

```
20260901090000_extensions.sql
20260901090100_core_schema.sql
20260901090200_profiles.sql
20260901090300_game.sql
20260901090400_api_functions.sql
20260901090500_candidates.sql
20260901090600_multiplayer.sql
20260901090700_rls_and_grants.sql
20260901090800_seed_categories.sql
20260901091000_elimination_multiplayer.sql
```

### 2.3 A kérdések feltöltése

```bash
cp tools/.env.example tools/.env
# töltsd ki: SUPABASE_URL és SUPABASE_SERVICE_ROLE_KEY
#   (Supabase → Project Settings → API)

node tools/src/import-seed.mjs --dry-run   # próbafutás: mit tenne
node tools/src/import-seed.mjs             # 22 kategória + 1157 kérdés
```

Az import **idempotens**: a `(category_id, norm_question)` egyedi index miatt
akárhányszor lefuttathatod, nem lesz duplikátum. A futás végén kiírja, hogy
melyik kategóriában hány kérdés van az adatbázisban.

### 2.4 A PWA összekötése az adatbázissal

Írd át a `web/js/config.js` két értékét:

```js
const DEFAULTS = {
  supabaseUrl: 'https://xxxx.supabase.co',
  supabaseAnonKey: 'eyJhbGciOi...',
  ...
};
```

Commitolhatod: az `anon` kulcs publikus adat. Push után a GitHub Actions
automatikusan újrapublikál, és a ranglista + multiplayer élesedik.

### 2.5 Auth beállítások a Supabase dashboardon

**Authentication → Providers:**

- **Anonymous sign-ins: BE.** Ez adja a vendég módot: a játékos regisztráció
  nélkül kap szerveroldali fiókot, pontszámot és ranglista-helyet. **A
  multiplayerhez ez kell**, mert szobához csak bejelentkezett felhasználó tud
  csatlakozni.
- **Apple: opcionális.** Weben Apple Service ID kell hozzá.

**Authentication → URL Configuration → Redirect URLs:** add hozzá a Pages
címedet (`https://<felhasznalo>.github.io/tudaskerek/`), különben az Apple
bejelentkezés visszatérése elutasításra kerül.

---

## 3. Multiplayer: hogyan látják a többiek a kérdést?

### 3.1 A játékmenet

**Kieséses mód.** Egy szobában 2–5 játékos van, mindenki a saját telefonján, és
**mindenki ugyanarra a kérdésre válaszol, egyszerre**.

```
1. kör
   ├─ a kerék kategóriát pörget – ugyanazt MINDENKINEK
   ├─ 1. kérdés → mind a 4 játékos válaszol (20 mp)
   │     Cili rontott  → KIESETT, nézővé vált
   ├─ 2. kérdés → már csak 3 játékos válaszol
   │     Dóra lekéste az időt → KIESETT
   ├─ 3. kérdés → 2 játékos …
   └─ a kör véget ér, ha elfogy a 10 kérdés, VAGY mindenki kiesik
        → a köri pontok beolvadnak az összesítettbe
        → mindenki visszatér a játékba, jön a következő kategória
2. kör … (a `rounds_per_player` szerint, 1–5)
Vége: a legtöbb összegyűjtött pont nyer.
```

Aki kiesik, **megtartja** az addig szerzett pontjait – csak többet nem gyűjthet
abban a körben. A pontskála ugyanaz, mint egyjátékosban: az 1–4. és 6–9. kérdés
1000, az 5. kérdés 2000, a 10. pedig 5000 pont. Egy végig kibírt kör tehát
15 000 pont.

Az **állás végig látszik felül**: mindenki neve, összpontja, a körben szerzett
pluszpontja, és hogy kiesett-e.

### 3.2 Mit lát az ember a kérdés közben?

| Ki | Mit lát |
|---|---|
| aki még játékban van | kérdés + 4 kattintható válasz + visszaszámláló |
| aki már válaszolt | a saját választása kiemelve, „Várunk a többiekre (2/4)” |
| aki kiesett | ugyanaz a kérdés, de a válaszok nem kattinthatók |

Lezárás után **mindenki ugyanazt látja**: melyik volt a helyes válasz, ki mit
választott (avatárral a válaszok mellett), ki esett ki, és a magyarázatot.

### 3.3 A biztonsági kulcspont

**A helyes válasz addig SENKINEK nem derül ki, amíg a kérdés le nem zárult** –
annak sem, aki már válaszolt. Ez szerveroldalon van kikényszerítve, nem a
felületen:

```sql
'correct_answer', case when v_rq.resolved_at is not null then q.correct_answer end,
'explanation',    case when v_rq.resolved_at is not null then q.explanation end,
'results',        case when v_rq.resolved_at is not null then ( … ) end
```

(`supabase/migrations/20260901091000_elimination_multiplayer.sql`)

Ezért nem adja vissza a válaszbeküldés sem, hogy jó volt-e: csak
`{"accepted": true}`. Az eredmény mindenkinek egyszerre jön.

Miért fontos? Kétféle csalást zár ki:

1. **Megsúgás.** Aki gyorsan válaszol, nem tudná bekiabálni a helyes választ a
   még gondolkodóknak. Egy szobában ülő barátoknál ez nem elméleti kockázat.
2. **Többség-leolvasás.** A `results` sem jön ki előre, tehát abból sem lehet
   visszafejteni, mit tippeltek a többiek.

A kliens nem tudja megkerülni: a `questions`, `room_questions` és `room_answers`
táblákhoz **nincs olvasási joga**, a kérdést a `security definer` RPC-k adják ki,
és azok döntik el, mit küldenek. A `node tools/src/db-test.mjs` ezt kliens
szerepben futtatva ellenőrzi.

### 3.4 Hogyan lesz „élő”?

A szoba képernyő a **`room_tick()`** RPC-t pollozza, ami egyszerre lépteti és
visszaadja a játékot: lezárja az esedékes kérdést, kiesteti a hibázókat,
továbblép, összesít.

- játék közben **1 másodpercenként**, várakozó szobában 3 másodpercenként,
- a felület csak akkor épül újra, ha az állapot érdemben változott (különben
  villogna és elveszne a görgetés),
- a visszaszámlálót egy külön, 200 ms-os helyi óra rajzolja, DOM-csere nélkül.

**A tick idempotens** és `for update` zárral dolgozik: mindegy, hogy négy kliens
hívja egyszerre, a lezárás és a továbbléptetés pontosan egyszer történik meg.
Ennek két gyakorlati haszna van: nincs „gazda” kliens, akinek a hálózatvesztése
megállítaná a játékot, és nem kell háttérfolyamat (cron, Edge Function) sem – a
szoba magát lépteti, amíg valaki nézi.

Miért nem WebSocket? A Supabase Realtime elő van készítve (publikáció + RLS a
`rooms` és `room_players` táblákra), de:

- egy szobaállapot néhány száz bájt, tehát a pollozás forgalma elhanyagolható,
- mobilhálózaton a WebSocket rendszeresen elszakad, és újra kell építeni,
- a pollozás nem tud „beragadni”: ha egy kérés elveszik, a következő pótolja,
- a léptetéshez amúgy is szerverhívás kell, tehát a WebSocket nem takarítana meg
  egy kört sem.

### 3.5 Az időzítés

| Fázis | Meddig | Beállítás |
|---|---|---|
| pörgetés | a kerék kifut a kategóriára | `rooms.spin_seconds` (3 mp) |
| válasz | visszaszámláló | `rooms.answer_seconds` (a szoba készítésekor, 5–60 mp) |
| kiértékelés | eredmény + magyarázat | `rooms.reveal_seconds` (5 mp) |

A pörgetés azért kap külön időablakot, mert különben az animáció elvenne a
válaszidőből – annak viszont mindenkinél ugyanannyinak kell lennie. A szerver
`answer_open_at`-ot is számol, és a válaszbeküldést elutasítja, amíg a kerék
pörög.

Az órák eltérését a kliens korrigálja: az állapotban jön `server_time`, ebből
számol egy eltolást, és minden határidőt azzal értelmez.

### 3.6 Amit ehhez be kell állítani

A multiplayer **csak akkor jelenik meg**, ha:

1. a `web/js/config.js`-ben be van írva a Supabase URL és anon kulcs,
2. a Supabase-en engedélyezve van az **anonymous sign-in**,
3. van internetkapcsolat.

Ha bármelyik hiányzik, a felület elmondja, mi hiányzik.

### 3.7 Szoba használata

1. Egy játékos létrehoz szobát: létszám 2–5, körök száma 1–5, válaszidő,
   nehézség, és hogy minden kérdés előtt pörögjön-e a kerék vagy körönként
   egyszer.
2. Megkapja a **6 karakteres kódot** (pl. `K7MQ2X`) – ezt megosztja.
   A kódban nincs `I`, `O`, `S`, `0`, `1`, `5`, mert ezeket szóban és írásban
   gyakran összekeverik.
3. A többiek beírják a kódot, és jelzik, hogy készen állnak.
4. A szoba létrehozója indítja a játékot – innentől automatikusan megy.
5. Kiesésnél a telefon rezeg, és kiírja, hogy mostantól néző vagy.

---

## 4. Napi munkamenet közzététel után

```bash
# kérdés hozzáadása vagy javítása
#   → content/seed/<kategoria>.json szerkesztése

node tools/src/validate-seed.mjs      # minőségi kapuk
node tools/src/browser-test.mjs       # végponttól végpontig teszt
node tools/src/import-seed.mjs        # adatbázis frissítése (ha van backend)

git add . && git commit -m "új kérdések" && git push
# → a GitHub Actions automatikusan publikál
```

A böngésző a régi verziót tartja a cache-ben, ezért a service worker
frissítéskor újratölti a lapot (`controllerchange` figyelés a `web/js/app.js`
végén). A felhasználónak nem kell semmit tennie.
