# Kutatás: a Kvízkerék nyilvánosan elérhető információi

Cél: a **játékmechanika** megértése, hogy a TudásKerék önálló, de hasonló műfajú
játék legyen. Semmilyen tartalom (kérdés, grafika, szöveg, ikon) nem kerül átvételre.

## Források

- App Store (HU): <https://apps.apple.com/hu/app/kvízkerék/id1493907189>
- Google Play: <https://play.google.com/store/apps/details?id=jbdev.kvizkerek>
- Fejlesztő (JBdev): <https://jbdev.hu/category/kvizjatekok/> (a
  `jbdev.hu/jatekok/kvizkerek-androidios/` aloldal a kutatás idején nem volt elérhető)
- Gyerek változat: <https://play.google.com/store/apps/details?id=jbdev.kvizkerekgyerek>

## Megállapítások

### Játékmenet

1. A játékos megpörget egy szerencsekereket, ami kisorsol egy **kategóriát**.
2. A kategóriából feleletválasztós kérdést kap.
3. Helyes válasz után **döntés**: megáll és megtartja a pontokat, vagy továbbmegy.
4. Hibás válasz esetén az addig összegyűjtött pont **feleződik**.
5. Egy körben **legfeljebb 10** kérdés.

Ez pontosan az a „bank or risk” (press-your-luck) mechanika, amit a specifikáció
is leír. Nem az egyes kérdések, hanem ez a döntési ciklus adja a játék magját –
ezért ezt vesszük át, és ezt tesszük konfigurálhatóvá.

### Pontozás

A nyilvános leírás szerint: helyes válaszonként 1000 pont, kivéve az 5. kérdést
(2000) és a 10. kérdést (5000). Ez megfelel a specifikáció jutalomtáblájának:

```
[1000, 1000, 1000, 1000, 2000, 1000, 1000, 1000, 1000, 5000]
```

A TudásKerékben ez **nem hardkódolt**: a `scoring_rules` táblából jön, verziózva.

### Kategóriák

A leírások **22 kategóriát** és **6000+ kérdést** említenek (a többjátékos módnál
18 kategória szerepel). Beazonosítható példák a nyilvános szövegekből:
művészet/építészet, üzlet és pénz, étel és ital, földrajz/csillagászat,
történelem, tudomány, szórakozás.

A mi kategóriastruktúránk ettől szándékosan eltér: **erős magyar fókusz** (8
magyar tematikus kategória a 22-ből), ami a specifikáció szerinti fő
differenciáló.

### Többjátékos mód

A Kvízkerék elsősorban **egy eszközön, körben váltakozó** („társasjáték”) módot
kínál 2–4 játékosnak, illetve említ online játékot és ranglistát.

A TudásKerék ehelyett **valódi online szobás multiplayert** valósít meg: 6
karakteres szobakód, 2–5 játékos, külön eszközökön, Supabase Realtime
(a megvalósításban a kód helyett nyitott szobák listája + 3 jegyű PIN lett)
broadcasttel, szerveroldali válaszvalidációval. Ez tudatos továbbfejlesztés.

### Képernyőstruktúra (nyilvános képernyőképek alapján)

Felismerhető: főmenü, kerék képernyő, kérdés képernyő 4 válaszgombbal,
kör-eredmény összegzés, ranglista, beállítások. A mi 11 képernyőnk ezt a
szokásos szerkezetet követi, saját dizájnnal (lásd `02-architektura.md`).

## Amit ötletként érdemes átvenni

| Ötlet | Átvéve? | Megjegyzés |
|---|---|---|
| Kerék mint kategóriaválasztó | igen | ez a műfaj lényege |
| Press-your-luck döntés minden kérdés után | igen | konfigurálható szabályként |
| Kiemelt jutalom az 5. és 10. kérdésnél | igen | `scoring_rules`-ból |
| Egy eszközön váltakozó „társas” mód | későbbre | MVP-ben online szoba van helyette |
| Gyerek változat külön appként | későbbre | `questions.min_age` mező már a sémában |
| Kérdésenkénti magyarázat | igen (fejlesztés) | tanulási érték, `explanation` mező |
| Napi kihívás / streak | későbbre | `daily_challenges` tábla előkészítve nincs, de a séma bővíthető |

## Jogi keret

- **Játékmechanika és szabály**: nem szerzői jogvédett kifejezés, önállóan
  megvalósítható. (A press-your-luck kvíz évtizedes műfaj.)
- **Nem használjuk fel**: kérdésszövegeket, magyarázatokat, grafikát, ikont,
  színvilágot, hangokat, marketingszöveget, appnevet.
- **Névválasztás**: „TudásKerék” – összetéveszthetőség elkerülése végett a
  megjelenés előtt védjegy-előkeresés javasolt (SZTNH online adatbázis).
