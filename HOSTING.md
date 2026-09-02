# Hosztolás és backend – rövid útmutató

Két különálló dolog kell. A weboldal a GitHubon lakik, az adatbázis a
Supabase-ben. **Egyik sem kerül pénzbe.**

```
telefon böngészője
   ├── HTTPS →  <felhasznalonev>.github.io/tudaskerek/   ← statikus fájlok (GitHub Pages)
   └── HTTPS →  <ref>.supabase.co                        ← Postgres + bejelentkezés (Supabase)
```

Az egyjátékos mód adatbázis **nélkül is** teljesen működik (1157 beépített
kérdés, offline is). A Supabase a ranglistához és a multiplayerhez kell.

---

## 1. Weboldal – GitHub Pages (5 perc)

```bash
cd e:/fun/kvízkerék
git init
git add .
git commit -m "TudásKerék"
git branch -M main
git remote add origin https://github.com/<felhasznalonev>/tudaskerek.git
git push -u origin main
```

### ⚠️ Ezt a lépést nem lehet kihagyni

A GitHubon: **Settings → Pages → Build and deployment → Source: `GitHub Actions`**

Enélkül a deploy elhasal, mert a repóhoz még nem tartozik Pages-oldal:

```
Get Pages site failed. Please verify that the repository has Pages
enabled and configured to build using GitHub Actions
Error: Not Found
```

**Ha a „GitHub Actions” nem választható** a legördülőben, akkor a repó privát
egy olyan csomagon, ahol a Pages nem elérhető. Két kiút:

- **Settings → General → Danger Zone → Change visibility → Public**, vagy
- Cloudflare Pages, ami privát repóból is ingyen publikál (ugyanez a `web/`
  mappa, build parancs nélkül).

Miután beállítottad, indítsd újra a futást: **Actions → Közzététel → a legutóbbi
futás → Re-run all jobs**. (Új push nem kell.)

Kész. Az oldal itt lesz: `https://<felhasznalonev>.github.io/tudaskerek/`

Innentől minden `git push` automatikusan újrapublikál – de csak ha a tesztek
átmennek (validáció, játéklogika, migrációk).

---

## 2. Adatbázis – Supabase (15 perc)

### 2.1 Projekt

1. [supabase.com](https://supabase.com) → *Start your project* (GitHub-fiókkal).
2. *New project* → régió: **Frankfurt** (a legközelebbi).
3. Add meg a DB jelszót, és **mentsd el** – később nem látható újra.

A **Settings → API** lapon két dolog kell:

| Név | Hova kerül | Titkos? |
|---|---|---|
| Project URL | `web/js/config.js` | nem |
| `anon` `public` kulcs | `web/js/config.js` | **nem** – ezt szánják kliensbe |
| `service_role` kulcs | `tools/.env` | **IGEN** – soha ne kerüljön a web/ mappába |

### 2.2 Séma feltöltése

**Három lépés, és a sorrend számít.** A `db push` önmagában
`Cannot find project ref. Have you run supabase link?` hibát ad.

```bash
npx supabase login
```

Megnyit egy böngészőlapot, ahol jóváhagyod – utána a tokent a
`~/.supabase/` mappába menti. (Ha ez nem járható, lásd a lenti B) utat.)

```bash
npx supabase link --project-ref <a-projekt-ref>
```

**A projekt-ref a Project URL aldomainje**: ha a `web/js/config.js`-ben
`https://abcdefghijklm.supabase.co` áll, akkor a ref `abcdefghijklm`. A
dashboardon is megtalálod: *Settings → General → Reference ID*.

A `link` elkéri az **adatbázis jelszót** – azt, amit a projekt létrehozásakor
megadtál. Ha elveszett: *Settings → Database → Reset database password*.

```bash
npx supabase db push          # lefuttatja mind a 14 migrációt
```

Ellenőrzés: `npx supabase migration list` – kiírja, melyik migráció futott le
helyben és a szerveren.

> A `link` figyelmeztethet, hogy a `supabase/config.toml` Postgres-verziója nem
> egyezik a projektéddel. Ez ártalmatlan: az a beállítás csak a helyi
> fejlesztői adatbázishoz kell (`supabase start`), a `db push`-t nem érinti.
> A CLI fel is ajánlja a javítást.

#### B) Ha a CLI nem járható út

Bejelentkezés vagy elveszett jelszó nélkül a migrációk kézzel is lefuttathatók.
Tizenkét fájlt egyenként bemásolni sorrend-érzékeny munka, ezért van rá eszköz:

```bash
node tools/src/bundle-migrations.mjs      # → supabase/all-migrations.sql
```

A kapott fájlt illeszd be a **Dashboard → SQL Editor → New query** ablakba, és
futtasd le egyszerre. (Ez a fájl generált és nincs verziókövetve – bármikor
újragenerálható.)

Ennek az a hátránya, hogy a Supabase nem tartja nyilván, mi futott már le:
később kézzel kell tudnod, melyik migráció új.

### 2.3 Kérdések feltöltése

```bash
cp tools/.env.example tools/.env      # ide a service_role kulcs
node tools/src/import-seed.mjs        # 1157 kérdés
```

### 2.4 A kliens összekötése

A `web/js/config.js` fájlban a `DEFAULTS` két üres értékét töltsd ki:

```js
const DEFAULTS = {
  supabaseUrl: 'https://<ref>.supabase.co',
  supabaseAnonKey: 'eyJ...',
  // a többi mező maradhat
```

Commit, push – a Pages újrapublikál, és él a ranglista meg a multiplayer.

### 2.5 Névtelen bejelentkezés bekapcsolása (kötelező)

**Authentication → Providers → Anonymous sign-ins: ON**

Enélkül a multiplayer nem indul: a szobákhoz kell egy játékosazonosító, és nem
akarjuk regisztrációra kényszeríteni a barátaidat.

Ez adja a **vendégjátékot**: aki nem jelentkezik be, az is csinálhat szobát és
csatlakozhat, csak a pontja nem kerül a nyilvános ranglistára (a vendégnév
generált, és a fiók bármikor eldobható). A saját statisztikája megmarad.

### 2.6 Bejelentkezés e-maillel (ingyen, semmi teendő)

**Authentication → Providers → Email: BE** (alapból az).

Egy dolgot érdemes átállítani: **Confirm email → KI**. Az ingyenes Supabase
beépített levelezője óránként csak néhány levelet küld, és a saját
dokumentációja szerint sem éles használatra való. Megerősítés nélkül a
regisztráció azonnal működik, e-mail-küldés nélkül.

> Ennek az az ára, hogy valaki más e-mail címével is regisztrálhat. Egy
> kvíz-ranglistánál ez elfogadható; ha zavar, kapcsold be a megerősítést, és
> állíts be saját SMTP-t (a Supabase támogatja, pl. Resend vagy Brevo ingyenes
> csomagjával).

### 2.7 Google bejelentkezés (opcionális, ingyen)

**Authentication → Providers → Google: BE**, majd két érték kell hozzá a
[Google Cloud Console](https://console.cloud.google.com/apis/credentials)-ból:

1. *APIs & Services → Credentials → Create credentials → OAuth client ID*
2. Application type: **Web application**
3. *Authorized redirect URIs* közé: `https://<ref>.supabase.co/auth/v1/callback`
4. A kapott **Client ID** és **Client Secret** mehet a Supabase mezőibe.

Ez ingyenes, és nem jár le.

> **Az Apple bejelentkezés kimaradt a projektből.** Fizetős Apple Developer
> tagságot (99 USD/év) és egy félévente cserélendő, `.p8` kulccsal aláírt
> titkot igényel – ez adta a `Unsupported provider: missing OAuth secret`
> hibát. A Google ugyanazt nyújtja ingyen, és iPhone-on is működik.

### 2.8 Vendégből igazi fiók

Aki vendégként kezdett, a Profil lapon megadhat e-mailt és jelszót.
**Ugyanaz a fiók marad**, tehát a pontjai és a statisztikája megmaradnak – csak
onnantól felkerül a nyilvános ranglistára is.

### 2.9 Site URL és Redirect URLs — ⚠️ ezt könnyű elfelejteni

**Authentication → URL Configuration**

| Mező | Mit írj be | Miért |
|---|---|---|
| **Site URL** | `https://<felhasznalonev>.github.io/tudaskerek/` | ez a **levelekben lévő linkek** célja |
| **Redirect URLs** | ugyanez + `http://localhost:5173/` | csak az itt felsorolt címekre engedi a visszatérést |

A **Site URL** gyári értéke `http://localhost:3000` — ezért visz a megerősítő
e-mail egy nem létező helyi szerverre, ha nem írod át. Ez a leggyakoribb
buktató.

Az alkalmazás minden e-mailes műveletnél megadja, hogy hova térjen vissza
(`redirect_to`), tehát fejlesztéskor a localhostra, élesben a Pages-címre visz.
Ez viszont **csak akkor működik, ha a cím szerepel a Redirect URLs listán** —
különben a Supabase a Site URL-re esik vissza.

A localhost portja `5173`, mert a `node tools/src/serve.mjs web` ezen indul.
A záró `/` számít; ha bizonytalan vagy, vedd fel a joker alakot is:
`http://localhost:5173/**`.

---

## 3. Telepítés a telefonra

Nincs App Store, nincs Mac, nincs 99 dolláros fejlesztői fiók.

- **iPhone:** Safariban megnyitni a linket → *Megosztás* → *Főképernyőhöz adás*.
- **Android:** Chrome → *Alkalmazás telepítése*.

Utána saját ikonként indul, böngészősáv nélkül, és offline is működik.

> iPhone-on **Safariból** kell hozzáadni – Chrome-ból nem megy. Ez iOS-megkötés.

---

## 4. Ingyenes keretek

| | Limit | Mire elég |
|---|---|---|
| GitHub Pages | 100 GB / hó forgalom | gyakorlatilag korlátlan ehhez |
| Supabase DB | 500 MB | ~50 000 kérdés (most 1157 ≈ 2 MB) |
| Supabase forgalom | 5 GB / hó | több ezer játék |
| Supabase felhasználók | 50 000 MAU | bőven |

**Egy dologra figyelj:** a Supabase ingyenes projektet **7 nap teljes
inaktivitás után szünetelteti**. A vezérlőpultból egy kattintással visszaindul,
de ha hetekre elfelejtitek, ébresztés kell.

---

## 5. Ha valami nem megy

| Tünet | Ok és megoldás |
|---|---|
| `Cannot find project ref. Have you run supabase link?` | kimaradt a `supabase login` + `supabase link` (2.2) |
| `NotFound: FileSystem.readFile (….supabaseprofile)` | nem futott le a `supabase login` (2.2) |
| `Get Pages site failed … Not Found` | a Pages nincs bekapcsolva: Settings → Pages → Source **GitHub Actions**, majd Re-run all jobs (lásd az 1. pontot) |
| a Pages-nél nincs „GitHub Actions” opció | a repó privát, és a csomagban nincs Pages → tedd publikussá, vagy Cloudflare Pages |
| 404 a Pages linken | a deploy lefutott, de a Source még nem GitHub Actions |
| `Node.js 20 is deprecated` figyelmeztetés | régi action-verziók – a mostani workflow már `@v7` / `@v5`-öt használ |
| „Backend szükséges” a multiplayernél | `web/js/config.js` nincs kitöltve |
| A multiplayer nem indul | nincs bekapcsolva a névtelen bejelentkezés (2.5) |
| A megerősítő e-mail `localhost:3000`-re visz | a **Site URL** gyári értéke maradt (2.9) |
| `Unsupported provider: missing OAuth secret` | a szolgáltatónál nincs kitöltve a Client Secret (Google: 2.7). Az Apple ki is került a projektből. |
| Nem hallok hangot | Beállítások → Hang; iPhone-on a **néma kapcsoló** a böngésző hangját is elhallgattatja |
| Régi verzió jön push után | várj ~1 percet, vagy zárd be és nyisd újra az appot |
| `db push` hibát ad | `node tools/src/db-test.mjs` – lefuttatja a migrációkat helyben |

Helyi kipróbálás feltöltés nélkül:

```bash
node tools/src/serve.mjs web        # http://localhost:5173
```

Részletes változat: [docs/05-beallitas.md](docs/05-beallitas.md) és
[docs/07-kozzetetel.md](docs/07-kozzetetel.md).
