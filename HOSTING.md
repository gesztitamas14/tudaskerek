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

```bash
npx supabase login
npx supabase link --project-ref <a-projekt-ref>
npx supabase db push          # lefuttatja mind a 10 migrációt
```

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

### 2.5 Névtelen bejelentkezés bekapcsolása

**Authentication → Providers → Anonymous sign-ins: ON**

Enélkül a multiplayer nem indul: a szobákhoz kell egy játékosazonosító, és nem
akarjuk regisztrációra kényszeríteni a barátaidat.

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
| `Get Pages site failed … Not Found` | a Pages nincs bekapcsolva: Settings → Pages → Source **GitHub Actions**, majd Re-run all jobs (lásd az 1. pontot) |
| a Pages-nél nincs „GitHub Actions” opció | a repó privát, és a csomagban nincs Pages → tedd publikussá, vagy Cloudflare Pages |
| 404 a Pages linken | a deploy lefutott, de a Source még nem GitHub Actions |
| `Node.js 20 is deprecated` figyelmeztetés | régi action-verziók – a mostani workflow már `@v7` / `@v5`-öt használ |
| „Backend szükséges” a multiplayernél | `web/js/config.js` nincs kitöltve |
| A multiplayer nem indul | nincs bekapcsolva a névtelen bejelentkezés (2.5) |
| Régi verzió jön push után | várj ~1 percet, vagy zárd be és nyisd újra az appot |
| `db push` hibát ad | `node tools/src/db-test.mjs` – lefuttatja a migrációkat helyben |

Helyi kipróbálás feltöltés nélkül:

```bash
node tools/src/serve.mjs web        # http://localhost:5173
```

Részletes változat: [docs/05-beallitas.md](docs/05-beallitas.md) és
[docs/07-kozzetetel.md](docs/07-kozzetetel.md).
