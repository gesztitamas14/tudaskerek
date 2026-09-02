# Kérdésforrások és jogi megfelelés

Cél: 10 000 → 50 000 kérdés úgy, hogy egyik se legyen jogilag terhelt, és a
magyar kategóriák valóban magyar tartalmúak legyenek.

## Összefoglaló táblázat

| Forrás | Licenc | Kereskedelmi | Származékos mű megkötése | Használatunk |
|---|---|---|---|---|
| **Wikidata** | CC0 1.0 | szabad | nincs | **fő automatizált forrás** – `tools/src/generate-from-wikidata.ts` |
| **Wikipédia / Wikimedia** | CC BY-SA 4.0 (szöveg) | szabad | ShareAlike a szövegre | csak **tényellenőrzés** és forrás-URL; szövegátvétel nincs |
| **Wikidata Query Service (SPARQL)** | CC0 (adat) | szabad | nincs | tömeges generálás |
| **OpenTDB** | CC BY-SA 4.0 | szabad | **igen** – a származékos adatbázisra is | opcionális, elkülönítve (lásd lent) |
| **OpenTriviaQA** (uberspot) | CC BY-SA / GPL-változatok | szabad | igen | nem használjuk |
| **The Trivia API** | saját ToS | korlátozott | – | nem használjuk |
| **jService / Jeopardy dump** | scrape-elt TV-tartalom | kétséges | – | **nem használjuk** |
| **Saját AI-generálás** | mi vagyunk a szerző | szabad | nincs | magyar kategóriák gerince |
| **KSH, Magyar Nemzeti Múzeum, MNB nyílt adat** | egyedi, jellemzően szabad | ellenőrizendő | – | tényellenőrzési háttér |

## Miért nem az OpenTDB az alap?

Az OpenTDB minden adata **CC BY-SA 4.0** alatt áll. A ShareAlike záradék a
származékos *adatbázisra* is kiterjed: ha a kérdésbankunk OpenTDB-alapú
kérdéseket tartalmaz és azok adaptációi, a bank érintett része is CC BY-SA
alatt kellene, hogy elérhető legyen. Ez egy zárt, később monetizált appnál
nemkívánatos.

**Megoldás:** az `import-opentdb.ts` szkript létezik és működik, de

- alapból nem fut le a seedelés során,
- az általa importált sorok `license = 'CC-BY-SA-4.0'` és
  `provenance = 'opentdb'` értéket kapnak,
- így SQL-lel bármikor pontosan leválaszthatók, és az attribúciós lista
  (`GET /rpc/attributions`) automatikusan generálható belőlük.

Ez tudatos döntés: a jogilag „ragadós” tartalom **jelölve és izolálva** van.

## Wikidata pipeline (a fő automatizált forrás)

A `tools/src/generate-from-wikidata.ts` sablon-alapú: minden sablon egy SPARQL
kérdés + egy kérdésszöveg-minta + a hamis válaszok generálási szabálya.

Példa sablon (magyar földrajz):

```
SPARQL: ?telepules wdt:P31 wd:Q3266850 ; wdt:P131 ?megye .
Kérdés: "Melyik megyében található {telepules}?"
Helyes: {megye}
Hamis:  3 véletlen másik magyar megye (azonos típusú entitások!)
```

Miért jó ez:

- **CC0** → nincs attribúciós vagy ShareAlike kötelezettség.
- A hamis válaszok is valódi, azonos típusú entitások → nem lehet kizárással
  megoldani a kérdést.
- A tény ellenőrizhető: minden generált kérdés `source` mezőjébe bekerül a
  Wikidata entitás URI-ja (`http://www.wikidata.org/entity/Q…`), így a
  fact-checker újra le tudja futtatni.
- Skálázható: néhány tucat sablonból tízezres nagyságrend jön ki.

Beépített sablonok (`tools/src/wikidata-templates.ts`):

1. magyar település → megye
2. magyar megye → megyeszékhely
3. magyar folyó → hossz-kategória
4. magyar író/költő → mű (és fordítva)
5. magyar zeneszerző → születési év
6. ország → főváros
7. ország → valuta
8. kémiai elem → vegyjel / rendszám
9. film → rendező
10. festmény → festő
11. állat → osztály/rend
12. hegycsúcs → ország

## AI-generálás (magyar fókusz)

A `tools/src/generate-questions.ts` a Claude API-t használja
(`claude-opus-5` a nehéz, ellenőrzésigényes témákra, `claude-sonnet-5` a
tömeges generálásra), és minden kérdéshez kötelezően kér:

- kérdésszöveg, 4 válasz, helyes index,
- `difficulty` (easy/medium/hard),
- `explanation` (1–2 mondat),
- `source` (ellenőrizhető hivatkozás: Wikipédia-cikk címe vagy Wikidata Q-id),
- `topic` (a témakör, amiből generáltuk).

A prompt kifejezetten tiltja:

- angolból fordított, magyar szempontból értelmetlen kérdéseket,
- „melyik NEM” típusú, félreérthető kérdéseket (kivéve ha explicit kérjük),
- dátum nélküli „jelenleg…” típusú kérdéseket (elavulás),
- túl niche tartalmat (a nyilvános magyar középiskolai/általános műveltségi
  szint a felső korlát a `hard` kategóriában is).

Minden generált kérdés `status = 'pending_review'` állapotban kerül a
`question_candidates` táblába. **Sosem** kerül közvetlenül a `questions`
táblába – ezt DB szinten is kikényszerítjük (külön tábla, külön RLS).

## Fact-checking

`tools/src/factcheck.ts` három szintje:

1. **Formai** (mindig fut): 4 különböző válasz, nem üres mezők, a helyes index
   0–3, a válaszok hossza összemérhető (nem árulkodik a leghosszabb válasz),
   nincs a kérdésben a válasz szó szerint, nincs kettős tagadás.
2. **Wikidata-alapú** (ha a `source` Q-id): a szkript lekéri az entitást és
   ellenőrzi, hogy a helyes válasz szerepel-e a hivatkozott property értékei
   között. Eredmény: `verified` / `contradicted` / `inconclusive`.
3. **LLM cross-check** (opcionális): egy második modellhívás, ami a kérdést
   *csak* a kérdésszöveg alapján próbálja megválaszolni, a válaszlehetőségek
   ismeretében. Ha nem a jelölt helyes választ adja, a kérdés `flagged` lesz.
   Ez nem bizonyíték, csak prioritási jel a review sorban.

## Deduplikáció

Lásd `03-api-es-adatbazis.md` → `check_question_duplicates()`.

Négy szint:

1. **exact** – normalizált (kisbetűs, ékezet nélküli, írásjel nélküli)
   kérdésszöveg hash egyezés.
2. **near-duplicate szöveg** – `similarity()` trigram > 0.72 azonos kategóriában.
3. **azonos válaszhalmaz** – a négy válasz normalizált, rendezett hash-e egyezik,
   és a kérdés hasonlósága > 0.45.
4. **azonos tény** – ugyanaz a `source` entitás + ugyanaz a helyes válasz
   (a Wikidata pipeline-nál ez a leggyakoribb ütközés).
