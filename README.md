# TudásKerék

Magyar nyelvű kvízjáték szerencsekerékkel, **webalkalmazásként (PWA)**. Pörgetsz,
kapsz egy kategóriát, válaszolsz – majd eldöntöd: **megállsz és megtartod a
pontokat, vagy továbbmész és kockáztatod, hogy feleződjön.**

Önálló megvalósítás: saját UI, saját kérdésbank, saját backend. Nem használ fel
más kvízjáték tartalmát – a kutatás és a jogi keret a
[`docs/06-kvizkerek-kutatas.md`](docs/06-kvizkerek-kutatas.md)-ben.

---

## Két perc alatt kipróbálható

```bash
node tools/src/build-seed.mjs      # kérdésbank összeállítása
node tools/src/make-icon.mjs       # ikonok
node tools/src/serve.mjs web 5173  # helyi szerver
```

Nyisd meg: <http://localhost:5173/>

Ez **backend nélkül** fut: 1157 kérdés, offline mód, statisztika, minden
képernyő. Nincs `npm install` – a Node 20 beépített moduljai elegendők.

---

## Mi van készen

| Rész | Állapot |
|---|---|
| **PWA** (`web/`) – teljes játék, offline is | ✅ böngészőben tesztelve |
| **Kérdésbank** – **1157 kérdés, 22 kategória** | ✅ validált |
| **Backend** (`supabase/`) – 13 migráció, RLS, 37 RPC | ✅ kész |
| **Multiplayer** – kieséses, szobalista + 3 jegyű PIN, 2–5 fő | ✅ |
| **Ranglista** – örök / havi / heti / napi | ✅ |
| **Bejelentkezés** – vendég, Google, e-mail + jelszó | ✅ |
| **Admin felület** (`admin/`) | ✅ kész |
| **AI pipeline** (`tools/`) – generálás, dedup, fact-check | ✅ élőben tesztelve |
| **Automatikus közzététel** GitHub Pages-re | ✅ workflow kész |

---

## Hogyan lesz belőle megosztható link?

Röviden: **GitHub Pages a fájloknak, Supabase az adatbázisnak.** Ez a kettő
külön fut, és a böngésző mindkettővel közvetlenül beszél.

```
telefon böngészője
   ├── HTTPS → felhasznalo.github.io/tudaskerek/   statikus fájlok (ingyen)
   └── HTTPS → xxxx.supabase.co                    adatbázis + auth (ingyen)
```

1. Töltsd fel a repót GitHubra (publikusan – ingyenes csomagon a Pages csak
   publikus repóból publikál).
2. **Settings → Pages → Build and deployment → Source: `GitHub Actions`**.
   Enélkül a deploy `Not Found` hibával elhasal.
3. Kész – a `.github/workflows/deploy.yml` minden push után validál, tesztel és
   publikál. Ha egy teszt elhasal, nem publikál.
4. A linket Safariban megnyitva: **Megosztás → Főképernyőhöz adás** – innen saját
   ikonnal, teljes képernyőn, offline is fut.

Az adatbázis (ranglista, multiplayer) opcionális: a játék nélküle is teljesen
működik. Beállítás lépésről lépésre:
[`docs/07-kozzetetel.md`](docs/07-kozzetetel.md).

---

## A játék szabályai

- Egy körben legfeljebb **10 kérdés**.
- Minden helyes válasz pontot ad; **az 5. kérdés 2000, a 10. 5000**, a többi 1000.
- Helyes válasz után döntesz: **megállok** (a pont a tiéd) vagy **tovább**.
- Hibás válasznál a kör pontja **feleződik**, és a kör véget ér.
- Teljes kör: 8 × 1000 + 2000 + 5000 = **15 000 pont**.

A szabály **nem hardkódolt**: a `scoring_rules` táblából jön, verziózva. Új
pontozás bevezetéséhez nem kell új verziót kiadni.

---

## Multiplayer

**Kieséses mód.** Egy szobában 2–5 játékos, mindenki a saját telefonján. A kerék
kategóriát választ, és **mindenki ugyanarra a kérdésre válaszol, egyszerre,
időre**. Aki hibázik vagy lekési az időt, kiesik a körből és nézővé válik – a
pontjait megtartja. A kör addig megy, amíg elfogy a 10 kérdés, vagy mindenki
kiesik; utána jön a következő kategória. Az állás végig látszik felül.

**Szobakód nincs.** A nyitott szobák fel vannak sorolva: látszik, kinek a
szobája, hányan vannak benne, kell-e PIN. A készítő egy **3 jegyű PIN-t** görget
be, és azt kell megadni a belépéshez. Ez nem titok, hanem zár – ezért a szerver
játékosonként 5 hibás tipp után 10 percre zárol.

**Vendégként is játszható:** bejelentkezés nélkül is lehet szobát csinálni és
csatlakozni, csak a pont nem kerül a nyilvános ranglistára. Erre a felület
figyelmeztet is.

A biztonsági kulcspont: a **helyes válasz addig senkinek nem derül ki, amíg a
kérdés le nem zárult** – akkor sem, aki már válaszolt. Így egy gyors játékos nem
tudja megsúgni a többieknek. Ezt SQL kényszeríti ki, nem a felület, és a kliens
nem kerülheti meg: a kérdéstáblákhoz nincs olvasási joga.

A játékot egyetlen idempotens RPC (`room_tick`) hajtja, amit a kliensek
pollozzák. Nincs „gazda” kliens és nincs háttérfolyamat: a szoba magát lépteti.
Részletek: [`docs/02-architektura.md`](docs/02-architektura.md) 5. pont.

---

## Projektszerkezet

```
content/
  categories.json         22 kategória definíciója (egy igazság)
  seed/*.json             1157 kérdés, kategóriánként egy fájl
web/                      a PWA – build nélkül futó teljes játék
  index.html, styles.css, sw.js, manifest.webmanifest
  js/rules.js             pontozás + állapotgép (tesztelt)
  js/api.js               Supabase kliens + online/offline driver
  js/wheel.js             canvas kerék
  js/game-screen.js       a kör vezénylése
  js/multiplayer.js       szobalista, PIN-es belépés, kieséses szoba
  js/picker.js            görgetős számjegyválasztó (szoba-PIN)
  js/sound.js             szintetizált játékhangok (nincs hangfájl)
  js/screens.js           home, statisztika, ranglista, profil, beállítás, névjegy
  tests/                  node --test + böngészős integrációs teszt
supabase/migrations/      13 migráció: séma, RLS, RPC, multiplayer, auth
admin/                    kérdéskezelés, review, import/export (statikus)
tools/src/                seed build/validáció, import, AI generálás,
                          Wikidata, fact-check, ikon, szerver, böngészőteszt
.github/workflows/        automatikus közzététel GitHub Pages-re
docs/                     terv, architektúra, API, beállítás, forrás, kutatás,
                          közzététel
```

---

## Kérdésbank

| Mutató | Érték |
|---|---|
| Kérdés összesen | **1157** |
| Kategória | 22 (8 magyar fókuszú) |
| Nehézség | 384 könnyű / 605 közepes / 168 nehéz |
| Magyarázat aránya | 100% |
| Helyes válasz pozíciójának szórása | 25,0% / 25,1% / 25,6% / 24,4% |
| „A helyes a leghosszabb” | 31,5% (véletlen: 25%, hibahatár: 45%) |

A helyes válasz pozíciója **determinisztikus keveréssel** egyenletes: a
`build-seed.mjs` a kérdés szövegéből vett maggal keveri a válaszokat, tehát a
kézzel írt „az első a helyes” sorrend nem szivárog ki, és a build reprodukálható.

Minőségi kapuk (a `validate-seed.mjs` hibával leáll, ha sérülnek):

- nincs duplikátum kategórián belül (normalizált szöveg + válaszhalmaz + trigram)
- a négy válasz ékezet és írásjel nélkül is különbözik
- a kérdés nem tartalmazza a helyes választ (kivéve a „kakukktojás” típust)
- a helyes válasz pozíciója 15–35% között minden pozíción
- minden MVP-kategóriában legalább 50 kérdés

```bash
node tools/src/validate-seed.mjs
```

---

## Tesztek

```bash
node --test web/tests/rules.test.mjs   # 30 teszt: pontozás, kerék, állapotgép
node tools/src/browser-test.mjs        # 109 ellenőrzés valódi böngészőben
node tools/src/db-test.mjs             # 111 ellenőrzés igazi PostgreSQL-en
node tools/src/validate-seed.mjs       # kérdésbank minőségi kapui
```

A böngészős teszt valódi Chromium-alapú böngészőt hajt (Edge vagy Chrome),
Playwright/Puppeteer nélkül: lejátszik egy teljes kört, majd végigveszi a
kieséses multiplayer összes fázisát – beleértve azt, hogy **lezárás előtt
egyetlen lehetőség sincs helyesként megjelölve**, sem a válaszolónál, sem a
nézőnél. Ellenőrzi a szobalistát, a görgetős PIN-választót, és azt is, hogy a
hangmotor AudioContextje tényleg elindul (a néma hiba különben nem látszik), és
a bejelentkezési űrlapot (vendég átalakítása, hibás adat, magyar hibaüzenetek).

Az adatbázis-teszt lefuttatja mind a 13 migrációt és lejátszik két teljes
szobás játékot **igazi Postgresen** (PGlite = Postgres WebAssemblyre fordítva),
Docker és Postgres-telepítés nélkül. Ellenőrzi a kiesést, az időtúllépést, a
körvégi összesítést, a jutalomtáblát (hibátlan kör = 15 000 pont), a PIN
próbálkozás-korlátját, a vendég ranglistából való kizárását és későbbi
felvételét (ha igazi fiókká alakul), és kliens
szerepben azt is, hogy a játékos **nem tudja kiolvasni a helyes választ** a
táblákból. Ehhez egyszer kell `cd tools && npm install`.

Képernyőképek generálása: `node tools/src/browser-test.mjs --screenshot`
→ `docs/screenshots/`.

---

## AI kérdésgenerálás

```bash
cd tools && npm install && cd ..     # csak ehhez kell csomag

node tools/src/generate-questions.mjs \
  --category magyar-tortenelem --topic "Mohács" --count 30

node tools/src/factcheck.mjs --status pending_review --llm
```

Kulcsszabály: **AI-generált kérdés soha nem kerül közvetlenül a játékba.**
Külön táblába (`question_candidates`) írunk `pending_review` állapotban, és csak
a moderátori jóváhagyás emeli át – ami újra lefuttatja a duplikátum-ellenőrzést.

Wikidata-alapú generálás (CC0, LLM nélkül, tényellenőrizhető):

```bash
node tools/src/generate-from-wikidata.mjs --list
node tools/src/generate-from-wikidata.mjs --all --limit 100
```

---

## Dokumentáció

| Fájl | Miről szól |
|---|---|
| [`HOSTING.md`](HOSTING.md) | **hosztolás és backend – a rövid változat** |
| [`docs/01-technikai-terv.md`](docs/01-technikai-terv.md) | technológiai döntések és indoklásuk |
| [`docs/02-architektura.md`](docs/02-architektura.md) | rétegek, a session driver absztrakció, offline-first, biztonság |
| [`docs/03-api-es-adatbazis.md`](docs/03-api-es-adatbazis.md) | táblák, nézetek, 37 RPC, RLS, duplikátumszűrés |
| [`docs/04-kerdesforrasok.md`](docs/04-kerdesforrasok.md) | licencek, Wikidata pipeline, miért nem OpenTDB az alap |
| [`docs/05-beallitas.md`](docs/05-beallitas.md) | üzembe helyezés lépésről lépésre |
| [`docs/06-kvizkerek-kutatas.md`](docs/06-kvizkerek-kutatas.md) | a műfaj kutatása és a jogi keret |
| [`docs/07-kozzetetel.md`](docs/07-kozzetetel.md) | **hosting, adatbázis, multiplayer működése** |

---

## Licenc és jogi keret

- A kérdésbank saját szerkesztésű, illetve **CC0** (Wikidata) forrásokból
  generált tartalom. Ha egyszer licenc-megkötéses forrás is bekerül, a
  `questions.license` mező jelöli, és az `attributions()` RPC automatikusan
  előállítja a feltüntetést.
- Az OpenTDB (CC BY-SA 4.0) importáló létezik, de **alapból nem fut** és
  megerősítést kér – a ShareAlike a származékos adatbázisra is kiterjed
  ([`docs/04-kerdesforrasok.md`](docs/04-kerdesforrasok.md)).
- A projekt nem áll kapcsolatban más kvízjátékok fejlesztőivel, és nem használ
  fel harmadik féltől származó kérdést, grafikát vagy szöveget.
- A „TudásKerék” név megjelenés előtt védjegy-előkeresést igényel (SZTNH).
