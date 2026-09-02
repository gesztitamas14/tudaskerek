# Közzététel: hosting és adatbázis

Két különböző dolog kell, és **nem ugyanott futnak**:

| | Mit tartalmaz | Hol fut | Költség |
|---|---|---|---|
| **Statikus fájlok** (`web/`) | HTML, CSS, JS, ikonok, 1783 kérdés | GitHub Pages | 0 Ft |
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

**Fontos:** a játék az adatbázis nélkül is teljesen működik (offline mód, 1783
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

   Ez a lépés **nem hagyható ki**, és a push előtt vagy után is megtehető – de
   amíg nincs meg, a deploy `Not Found` hibával elhasal, mert a repóhoz még nem
   tartozik Pages-oldal. Ha beállítás után hasalt el, nem kell új push: **Actions
   → a legutóbbi futás → Re-run all jobs**.

   Ha a legördülőben **nincs „GitHub Actions” opció**, a repó privát egy olyan
   csomagon, ahol a Pages nem elérhető. Tedd publikussá (Settings → General →
   Change visibility), vagy használj Cloudflare Pages-t – az privát repóból is
   ingyen publikál, ugyanezt a `web/` mappát, build parancs nélkül.

3. Ennyi. A `.github/workflows/deploy.yml` már a repóban van, és minden `main`-re
   küldött push után automatikusan:
   - validálja a kérdésbankot,
   - lefuttatja a játéklogika tesztjeit,
   - lefuttatja a migrációkat és a szobalogikát igazi Postgresen,
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
aloldalról kiszolgálva ugyanúgy betölti mind a 1783 kérdést.

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
| Auth | 50 000 aktív felhasználó / hó | vendég + Google / e-mail bejelentkezés |
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

Egy fájlba fűzve a legkényelmesebb – a sorrendet így nem lehet elrontani:

```bash
node tools/src/bundle-migrations.mjs      # → supabase/all-migrations.sql
```

Ezt illeszd be a **SQL Editor → New query** ablakba, és futtasd egyszerre.
(A fájl generált, nincs verziókövetve.) A benne lévő migrációk sorrendje:

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
20260901091100_room_list_and_pin.sql
20260901091200_google_and_email_auth.sql
20260901091300_close_room.sql
20260901091400_one_category_per_round.sql
20260901091500_category_restructure.sql
```

### 2.3 A kérdések feltöltése

```bash
cp tools/.env.example tools/.env
# töltsd ki: SUPABASE_URL és SUPABASE_SERVICE_ROLE_KEY
#   (Supabase → Project Settings → API)

node tools/src/import-seed.mjs --dry-run   # próbafutás: mit tenne
node tools/src/import-seed.mjs             # 26 kategória + 1783 kérdés
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
  nélkül kap szerveroldali fiókot és statisztikát. **A multiplayerhez ez
  kötelező**, mert szobához csak bejelentkezett felhasználó tud csatlakozni.
  A vendég pontja szándékosan NEM kerül a nyilvános ranglistára.
- **Email: BE** (alapból az). Ha kikapcsolod a *Confirm email*-t, e-mail-küldés
  nélkül is működik a regisztráció – az ingyenes Supabase beépített levelezője
  óránként csak néhány levelet küld, tehát valódi használatra amúgy sem elég.
- **Google: opcionális, ingyenes.** Kell hozzá egy Google Cloud OAuth kliens
  (Client ID + Client Secret), a Return URL pedig:
  `https://<projekt>.supabase.co/auth/v1/callback`.

Az **Apple bejelentkezés kimaradt a projektből**: fizetős Apple Developer
tagságot (99 USD/év) és egy félévente cserélendő, `.p8` kulccsal aláírt titkot
igényel. A Google ugyanazt adja ingyen.

Aki vendégként kezdett, később megadhat e-mailt és jelszót: **ugyanaz a fiók
marad**, tehát a pontjai és a statisztikája megmaradnak, és felkerül a
ranglistára.

**Authentication → URL Configuration** – két külön mező, mindkettő kell:

- **Site URL:** a Pages-címed (`https://<felhasznalo>.github.io/tudaskerek/`).
  Ez a **levelekben lévő linkek** célja. A gyári érték `http://localhost:3000`,
  ezért visz a megerősítő e-mail egy nem létező helyi szerverre, ha nem írod át.
- **Redirect URLs:** ugyanez a cím, plusz fejlesztéshez
  `http://localhost:5173/`. Csak az itt felsoroltakra engedi a visszatérést.

Az alkalmazás minden e-mailes műveletnél megadja a visszatérési címet
(`redirect_to`), de ez csak akkor érvényesül, ha a cím szerepel a Redirect URLs
listán – különben a Supabase a Site URL-re esik vissza.

---

## 3. Multiplayer: hogyan látják a többiek a kérdést?

### 3.1 A játékmenet

**Kieséses mód.** Egy szobában 2–5 játékos van, mindenki a saját telefonján, és
**mindenki ugyanarra a kérdésre válaszol, egyszerre**.

```
1. kör  ── a kerék EGYSZER pörög → „Magyar történelem”
   │        (~2,5 mp animáció + idő elolvasni, mi jött ki)
   ├─ 1. kérdés  Magyar történelem → mind a 4 játékos válaszol (15 mp)
   │      Cili rontott → KIESETT, nézővé vált
   ├─ 2. kérdés  Magyar történelem → már csak 3 játékos válaszol
   │      Dóra lekéste az időt → KIESETT
   ├─ 3. kérdés  Magyar történelem → 2 játékos …
   └─ a kör véget ér, ha elfogy a 10 kérdés, VAGY mindenki kiesik
        → a köri pontok beolvadnak az összesítettbe
        → mindenki visszatér a játékba
2. kör  ── új pörgetés → „Film” → 10 kérdés a Filmből …
…
10. kör
Vége: a legtöbb összegyűjtött pont nyer.
```

**Egy körben csak egy kategória van**, tehát egy játék alapból
**10 kör = 10 kategória**. A kerék nem minden kérdés előtt pörög – így a
pörgetés esemény marad, nem zaj.

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
| pörgetés | a kerék kifut a kategóriára, **majd van idő elolvasni** | `rooms.spin_seconds` (6 mp, körönként egyszer) |
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

Nincs kód, amit be kellene diktálni: a nyitott szobák **fel vannak sorolva**.

1. Egy játékos létrehoz szobát: létszám 2–5, körök száma 1–10 (alap: 10),
   válaszidő (alap: 15 mp), nehézség.
2. Megad egy **3 jegyű PIN-t** egy görgetős választón. (Ki is kapcsolható –
   akkor bárki beléphet a listáról.)
3. A többiek a „Nyitott szobák” listában látják a szobát: kinek a szobája,
   hányan vannak benne, kell-e PIN. Rákoppintanak, begörgetik a PIN-t, és bent
   vannak.
4. A szoba létrehozója indítja a játékot – innentől automatikusan megy.
5. Kiesésnél a telefon rezeg, hangot ad, és kiírja, hogy mostantól néző vagy.

**Miért 3 jegy, és miért elég?** Mert nem titok, hanem zár: azt akadályozza
meg, hogy idegen beessen a szobába. Három jegy 1000 lehetőség, ami kézzel
végigpróbálható lenne, ezért a szerver **játékosonként és szobánként 5 hibás
tipp után 10 percre zárol**. Ez nem kriptográfiai védelem, és nem is akar az
lenni – barátok közti szobához pont elég, viszont szóban bemondható.

**Vendégjáték:** aki nem jelentkezett be, az is csinálhat szobát és
csatlakozhat. A pontja viszont nem kerül a nyilvános ranglistára, mert a
vendégnév generált és a fiók eldobható. Erre a felület figyelmeztet is. A saját
statisztikája megmarad.

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
