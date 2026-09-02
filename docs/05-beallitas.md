# Beállítás és üzembe helyezés

Három komponens van, és **egymástól függetlenül** üzembe helyezhetők. A játék
backend nélkül is teljesen működik (offline mód, 2125 beépített kérdés).

| Komponens | Kell hozzá | Mit ad |
|---|---|---|
| `web/` – a PWA | webszerver (helyben: Node) | maga a játék, offline is |
| `supabase/` – backend | Supabase fiók (free tier) | ranglista, multiplayer, központi kérdésbank |
| `admin/` + `tools/` | backend + Node 20 | kérdéskezelés, AI generálás |

Közzététel (GitHub Pages + Supabase): [`07-kozzetetel.md`](07-kozzetetel.md).

---

## 0. Előfeltételek

- **Node 20 vagy újabb** (az eszközökhöz és a helyi szerverhez)
- opcionálisan **Supabase** fiók (ingyenes)
- opcionálisan **Anthropic API kulcs** az AI kérdésgeneráláshoz

Semmilyen `npm install` nem kell, kivéve az AI generálást (4. pont).

---

## 1. A PWA elindítása helyben

```bash
# 1. kérdésbank ellenőrzése és összeállítása
node tools/src/validate-seed.mjs
node tools/src/build-seed.mjs

# 2. ikonok (egyszer elég)
node tools/src/make-icon.mjs

# 3. helyi szerver
node tools/src/serve.mjs web 5173
```

Nyisd meg: <http://localhost:5173/>

> `file://` protokollon **nem működik**: a böngésző ott nem engedi az ES modulok
> és a service worker betöltését. Ezért kell a helyi szerver.

Ez a változat **backend nélkül** fut: offline mód, 2125 kérdés, statisztika,
minden képernyő. A ranglista és a többjátékos mód ilyenkor nem elérhető.

### Tesztek

```bash
node --test web/tests/rules.test.mjs   # 30 teszt: pontozás, kerék, állapotgép
node tools/src/browser-test.mjs        # 31 ellenőrzés valódi böngészőben
node tools/src/browser-test.mjs --screenshot   # + képernyőképek
```

A böngészős teszt Edge-et vagy Chrome-ot keres. Ha máshol van:

```bash
BROWSER_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" \
  node tools/src/browser-test.mjs
```

---

## 2. Supabase backend

### 2.1 Projekt létrehozása

1. <https://supabase.com> → új projekt (region: EU, pl. Frankfurt).
2. Jegyezd fel: **Project URL**, **anon public key**, **service_role key**
   (Project Settings → API).

### 2.2 Séma futtatása

**A) Supabase CLI (ajánlott)**

```bash
npx supabase link --project-ref <projekt-ref>
npx supabase db push
```

**B) SQL Editor kézzel**

A `supabase/migrations/` fájljait **fájlnév szerinti sorrendben** másold be és
futtasd le:

1. `20260901090000_extensions.sql`
2. `20260901090100_core_schema.sql`
3. `20260901090200_profiles.sql`
4. `20260901090300_game.sql`
5. `20260901090400_api_functions.sql`
6. `20260901090500_candidates.sql`
7. `20260901090600_multiplayer.sql`
8. `20260901090700_rls_and_grants.sql`
9. `20260901090800_seed_categories.sql`
10. `20260901091000_elimination_multiplayer.sql`
11. `20260901091100_room_list_and_pin.sql`
12. `20260901091200_google_and_email_auth.sql`
13. `20260901091300_close_room.sql`
14. `20260901091400_one_category_per_round.sql`
15. `20260901091500_category_restructure.sql`

> A sorrend kötelező: a későbbi fájlok az előzők típusaira és függvényeire
> építenek.

### 2.3 Auth beállítások

Authentication → Providers:

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

Authentication → URL Configuration – **két** mezőt kell kitölteni:

- **Site URL**: a publikált cím (pl. `https://<felhasznalo>.github.io/tudaskerek/`).
  A levelekben (e-mail megerősítés, jelszó-visszaállítás) lévő linkek ide
  mutatnak. A gyári `http://localhost:3000` értéket mindenképp írd át.
- **Redirect URLs**: ugyanez, plusz a helyi `http://localhost:5173/`. Csak az
  itt felsorolt címekre engedi a visszatérést.

### 2.4 Kérdésbank feltöltése

```bash
cp tools/.env.example tools/.env
# töltsd ki: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

node tools/src/import-seed.mjs --dry-run   # előbb próbafutás
node tools/src/import-seed.mjs
```

Az import **idempotens**: a `(category_id, norm_question)` egyedi index miatt
többször is futtathatod, nem lesz duplikátum.

### 2.5 A PWA összekötése a backenddel

`web/js/config.js`:

```js
const DEFAULTS = {
  supabaseUrl: 'https://xxxx.supabase.co',
  supabaseAnonKey: 'eyJ...',
  ...
};
```

Az `anon` kulcs **publikus adat** – bátran commitolható, a hozzáférést a Row
Level Security szabályozza. A `service_role` kulcs soha nem kerülhet ide.

---

## 3. Admin felület

```bash
node tools/src/serve.mjs admin 5174
# majd: http://localhost:5174/
```

A belépéshez **e-mail + jelszó** kell, és a profilnak `moderator` vagy `admin`
szerepkör. A Supabase URL-t és anon kulcsot a belépő űrlapon adod meg (a
böngésző elmenti).

### Az első admin létrehozása

1. Authentication → Users → **Add user** (e-mail + jelszó, „Auto Confirm User”).
2. A trigger automatikusan létrehoz egy `profiles` sort `player` szerepkörrel.
3. SQL Editorban emeld adminra:

```sql
update public.profiles
set role = 'admin'
where id = (select id from auth.users where email = 'te@pelda.hu');
```

Ezt szándékosan nem lehet a felületről megtenni: a `profiles_update_own` RLS
szabály és a mezőszintű GRANT is tiltja a szerepkör-emelést.

### Az admin felület tudása

- kérdések listázása, keresés, szűrés (kategória, nehézség, aktív állapot)
- kérdés szerkesztése, deaktiválása, törlése, létrehozása
- **duplikátum-ellenőrzés** mentés előtt (négy szint: pontos, hasonló szöveg,
  azonos válaszhalmaz, azonos tény)
- AI-generált jelöltek review-ja: jóváhagyás / elutasítás / tömeges jóváhagyás
- kategóriák kezelése (aktiválás, kérdésszám)
- import/export JSON és CSV formátumban
- statisztika: kérdésszám kategóriánként, legrosszabb találati arányú kérdések

---

## 4. AI kérdésgenerálás

Ez az egyetlen rész, amihez `npm install` kell (hivatalos Anthropic SDK + zod):

```bash
cd tools
npm install
cd ..

# tools/.env: ANTHROPIC_API_KEY=...
node tools/src/generate-questions.mjs \
  --category magyar-tortenelem \
  --topic "1848-49-es szabadságharc" \
  --count 40
```

A generált kérdések a `question_candidates` táblába kerülnek `pending_review`
állapotban. **Sosem** a `questions` táblába – ezt az adatbázis szerkezete is
kikényszeríti.

Ellenőrzés:

```bash
node tools/src/factcheck.mjs --status pending_review --limit 100
node tools/src/factcheck.mjs --status pending_review --llm   # + LLM cross-check
```

Majd az admin felület **Review** fülén hagyd jóvá őket.

Wikidata-alapú (CC0) generálás, LLM nélkül:

```bash
node tools/src/generate-from-wikidata.mjs --list
node tools/src/generate-from-wikidata.mjs --all --limit 100 --out content/generated/wd.json
node tools/src/factcheck.mjs --file content/generated/wd.json
node tools/src/upload-candidates.mjs content/generated/wd.json
```

---

## 5. Napi munkamenet

```bash
# kérdés hozzáadása kézzel: content/seed/<kategoria>.json szerkesztése
node tools/src/validate-seed.mjs      # hibák, duplikátumok, statisztikák
node tools/src/build-seed.mjs         # a PWA kérdésbankjának újraépítése
node tools/src/browser-test.mjs       # végponttól végpontig
node tools/src/import-seed.mjs        # backend frissítése (ha van)

git add . && git commit -m "új kérdések" && git push   # → automatikus deploy
```

A `validate-seed.mjs` hibával leáll, ha:

- kevesebb mint 900 kérdés van összesen,
- bármelyik MVP-kategóriában 50 alatt van a kérdésszám,
- duplikátum van egy kategórián belül,
- a négy válasz normalizálva nem különbözik (ezt a szerver is elutasítaná),
- a kérdés tartalmazza a helyes választ (a „kakukktojás” típus kivételével),
- a helyes válasz pozíciója nem egyenletesen szórt (15–35% pozíciónként),
- a helyes válasz az esetek több mint 45%-ában a leghosszabb,
- a magyarázatok aránya 90% alatt van.

Ugyanezek futnak a GitHub Actionsben is, tehát elromlott kérdésbank nem tud
publikálásra kerülni.
