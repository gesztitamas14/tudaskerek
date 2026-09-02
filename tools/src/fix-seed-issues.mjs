#!/usr/bin/env node
// Egyszeri javítókészlet a seed fájlokhoz.
//
// Miért szkript és nem kézi szerkesztés? Mert így nyoma van annak, MIT és MIÉRT
// javítottunk, és a csere ellenőrizhető: ha egy keresett szöveg nem található,
// a szkript hibával leáll, nem csendben nem csinál semmit.
//
// Használat: node tools/src/fix-seed-issues.mjs

import { readFileSync, writeFileSync } from 'node:fs';

/** @type {Record<string, Array<[string, string, string]>>} [file] -> [ok, keresett, csere] */
const FIXES = {
  'vilagtortenelem.json': [
    [
      'nyelvhelyesség',
      '{"q": "Mikor épült a berlini falat?"',
      '{"q": "Mikor épült a berlini fal?"'
    ],
    [
      'az ékírás nem rovásírás',
      '{"q": "Melyik ókori nép használta a rovásszerű ékírást?"',
      '{"q": "Melyik ókori nép írásrendszere volt az ékírás?"'
    ]
  ],

  'foldrajz.json': [
    [
      'a főváros neve Brasília, a kérdés így félreérthető volt',
      '{"q": "Melyik ország fővárosa Brazília városa?", "a": ["Brazília", "Argentína", "Peru", "Kolumbia"], "c": 0, "d": "easy", "e": "Brasília 1960 óta az ország fővárosa, Rio de Janeiro helyett.", "t": "fővárosok"}',
      '{"q": "Melyik ország fővárosa Brasília?", "a": ["Brazília", "Argentína", "Peru", "Kolumbia"], "c": 0, "d": "easy", "e": "Brasília 1960 óta a főváros, Rio de Janeiro helyett.", "t": "fővárosok"}'
    ],
    [
      'nyelvhelyesség (a Északi-sziget)',
      'e": "Wellington a Északi-sziget déli csúcsán fekszik."',
      'e": "Wellington az Északi-sziget déli csúcsán fekszik."'
    ]
  ],

  'tudomany.json': [
    [
      'a kérdés kétszer használta a "szervezet" szót',
      '{"q": "Melyik szervezet szállítja a szervezetben az oxigént?"',
      '{"q": "Mi szállítja a vérben az oxigént?"'
    ],
    [
      'értelmetlen válaszlehetőség ("az atom között")',
      '"a": ["Az atommagban", "Az elektronhéjban", "Az atom felszínén", "Az atom között"]',
      '"a": ["Az atommagban", "Az elektronhéjban", "Az elektronpályákon", "Az atom külső burkában"]'
    ],
    [
      'kevert válaszlehetőség (Ceres és Merkúr)',
      '{"q": "Melyik égitestet minősítették 2006-ban törpebolygóvá?", "a": ["Plútó", "Merkúr", "Ceres és Merkúr", "Neptunusz"], "c": 0',
      '{"q": "Melyik égitestet minősítették 2006-ban törpebolygóvá?", "a": ["Plútó", "Merkúr", "Vénusz", "Neptunusz"], "c": 0'
    ]
  ],

  'allatvilag.json': [
    ['elírás', '"Struccz"', '"Strucc"'],
    [
      'elírás (kengurusfélék)',
      'e": "A kenguru kengurusfélékhez, azaz a tasakos emlősökhöz tartozik."',
      'e": "A kenguru a kengurufélékhez, azaz a tasakos emlősökhöz tartozik."'
    ],
    [
      'a válaszlehetőség magyarázatot tartalmazott',
      '{"q": "Melyik állat képes hónapokig víz nélkül élni a sivatagban?", "a": ["Deve (kétpúpú és egypúpú teve)", "Ló", "Kutya", "Tehén"], "c": 0',
      '{"q": "Melyik állat képes napokig víz nélkül élni a sivatagban?", "a": ["Teve", "Ló", "Kutya", "Tehén"], "c": 0'
    ],
    [
      'zavaros kérdés és magyarázat',
      '{"q": "Melyik állat a Magyarországon élő legnagyobb ragadozó emlős?", "a": ["Barnamedve (elvétve)", "Farkas", "Hiúz", "Vörös róka"], "c": 0, "d": "hard", "e": "Barnamedve csak alkalmi kóborlóként jelenik meg; állandó nagyragadozónk a farkas és a hiúz.", "t": "magyar fauna"}',
      '{"q": "Melyik nagyragadozó él állandó állományban Magyarországon?", "a": ["Hiúz", "Tigris", "Jaguár", "Barnamedve"], "c": 0, "d": "hard", "e": "A hiúz és a farkas állandó, kisebb állománnyal jelen van; barnamedve csak alkalmi kóborlóként.", "t": "magyar fauna"}'
    ],
    [
      'a magyarázat helytelenül fogalmazott',
      'e": "A kerecsensólyom Magyarország nemzeti madara, egyben a Természetvédelmi jelkép."',
      'e": "A kerecsensólyom 2012 óta Magyarország nemzeti madara."'
    ]
  ],

  'sport.json': [
    [
      'két egyenértékű helyes válasz volt',
      '{"q": "Melyik sportágban van „home run”?", "a": ["Baseball", "Krikett", "Amerikai futball", "Softball és baseball"], "c": 0, "d": "medium", "e": "A home run a baseball (és a softball) ütőjátékának legértékesebb találata.", "t": "baseball"}',
      '{"q": "Melyik sportágban van „home run”?", "a": ["Baseball", "Krikett", "Amerikai futball", "Jégkorong"], "c": 0, "d": "medium", "e": "A home run az ütőjáték legértékesebb találata.", "t": "baseball"}'
    ],
    [
      'értelmetlen kérdésmegfogalmazás',
      '{"q": "Melyik sportágban van „csuklyás rúgás” helyett „ollós rúgás”?", "a": ["Labdarúgás", "Kosárlabda", "Röplabda", "Kézilabda"], "c": 0, "d": "hard", "e": "Az ollós (kapásból hátra) rúgás a labdarúgás látványos technikája.", "t": "labdarúgás"}',
      '{"q": "Melyik sportág látványos technikája az „ollós rúgás”?", "a": ["Labdarúgás", "Kosárlabda", "Röplabda", "Kézilabda"], "c": 0, "d": "hard", "e": "A hátraszaltós, levegőben végzett rúgás a labdarúgás emblematikus mozdulata.", "t": "labdarúgás"}'
    ],
    [
      'nyelvhelyesség',
      '{"q": "Milyen magas a röplabdahálót tartó szabályos magasság a férfiaknál?"',
      '{"q": "Milyen magasan van a röplabdaháló felső széle a férfiaknál?"'
    ]
  ],

  'film-sorozat.json': [
    [
      'zavaros, kettős idézetre épülő kérdés',
      '{"q": "Melyik filmben hangzik el a „Nézd, mi lett a szemem fénye” helyett a legendás „Nekem te vagy az ajánlat, amit nem lehet visszautasítani” gondolat?", "a": ["A Keresztapa", "Sicario", "Casino", "Nagyfiúk"], "c": 0, "d": "hard", "e": "A „visszautasíthatatlan ajánlat” A Keresztapa ikonikus motívuma.", "t": "klasszikusok"}',
      '{"q": "Melyik filmhez kötődik a „visszautasíthatatlan ajánlat” szállóige?", "a": ["A Keresztapa", "Casino", "Sicario", "A tégla"], "c": 0, "d": "medium", "e": "Don Corleone ajánlata a film legismertebb motívuma.", "t": "klasszikusok"}'
    ],
    [
      'téves állítás: a Sicario és a Blade Runner 2049 operatőre Roger Deakins',
      '{"q": "Melyik magyar operatőr kapott Oscar-díjat a Sicario és a Blade Runner 2049 után?", "a": ["Zsigmond Vilmos", "Kovács László", "Deák Kristóf", "Nemes Jeles László"], "c": 0, "d": "hard", "e": "Zsigmond Vilmos 1978-ban a Harmadik típusú találkozásokért kapott Oscart.", "t": "magyar film"}',
      '{"q": "Melyik magyar operatőr kapott Oscar-díjat a Harmadik típusú találkozásokért?", "a": ["Zsigmond Vilmos", "Kovács László", "Koltai Lajos", "Ragályi Elemér"], "c": 0, "d": "hard", "e": "Zsigmond Vilmos 1978-ban kapta az elismerést Steven Spielberg filmjéért.", "t": "magyar film"}'
    ],
    [
      'kitalált utalás ("Hatos szoba")',
      '{"q": "Melyik sorozatban szerepel a Hatos szoba és a hat New York-i barát?", "a": ["Jóbarátok", "Seinfeld", "How I Met Your Mother", "Az ifjú Sheldon"], "c": 0, "d": "easy", "e": "A Jóbarátok tíz évadon át futott 1994 és 2004 között.", "t": "sorozatok"}',
      '{"q": "Melyik sorozat hat New York-i barát életéről szól, a Central Perk kávézóval?", "a": ["Jóbarátok", "Seinfeld", "How I Met Your Mother", "Will és Grace"], "c": 0, "d": "easy", "e": "A Jóbarátok tíz évadon át futott 1994 és 2004 között.", "t": "sorozatok"}'
    ]
  ],

  'zene.json': [
    [
      'két helyes választ tartalmazó lehetőség',
      '{"q": "Melyik magyar könnyűzenei együttes ismert az Illés-korszakból?", "a": ["Illés", "Omega és Illés is", "Neoton", "Republic"], "c": 0, "d": "hard", "e": "Az Illés zenekar a hatvanas évek magyar beatzenéjének meghatározó együttese volt.", "t": "magyar zene"}',
      '{"q": "Melyik magyar zenekar a hatvanas évek beatzenéjének meghatározó együttese, Szörényi Leventével?", "a": ["Illés", "Neoton", "Republic", "Bikini"], "c": 0, "d": "hard", "e": "Az Illés zenekar 1960-ban alakult, 1973-ban szűnt meg.", "t": "magyar zene"}'
    ],
    [
      'Presser Gábor elsősorban zeneszerző és klaviatúrás',
      '{"q": "Melyik magyar zenekar énekese volt Presser Gábor?", "a": ["Locomotiv GT", "Omega", "Illés", "Bergendy"], "c": 0, "d": "hard", "e": "Presser Gábor az Omega után az LGT alapítója volt.", "t": "magyar zene"}',
      '{"q": "Melyik zenekart alapította Presser Gábor az Omegából kilépve?", "a": ["Locomotiv GT", "Illés", "Bergendy", "Piramis"], "c": 0, "d": "hard", "e": "Az LGT 1971-ben alakult, Presser Gábor zeneszerzőként és klaviatúrásként.", "t": "magyar zene"}'
    ]
  ],

  'irodalom.json': [
    [
      'zavaros zárójeles kérdés',
      '{"q": "Ki írta az Érik a gyümölcs (Édentől keletre szerzőjétől) című regényt a nagy válságról?", "a": ["John Steinbeck", "Ernest Hemingway", "Upton Sinclair", "Theodore Dreiser"], "c": 0, "d": "hard", "e": "Steinbeck 1962-ben irodalmi Nobel-díjat kapott.", "t": "amerikai irodalom"}',
      '{"q": "Ki írta az Érik a gyümölcs című regényt a nagy gazdasági válságról?", "a": ["John Steinbeck", "Ernest Hemingway", "Upton Sinclair", "Theodore Dreiser"], "c": 0, "d": "hard", "e": "Steinbeck 1939-es regénye az oklahomai farmerek vándorlásáról szól.", "t": "amerikai irodalom"}'
    ],
    [
      'nyelvtanilag zavaros kérdés',
      '{"q": "Ki írta a Homokkönyv és A Bábeli könyvtár szerzőjeként ismert novellákat?", "a": ["Jorge Luis Borges", "Julio Cortázar", "Adolfo Bioy Casares", "Ernesto Sabato"], "c": 0, "d": "hard", "e": "Borges argentin író, a labirintus és a végtelen könyvtár motívumaival.", "t": "latin-amerikai irodalom"}',
      '{"q": "Ki írta A Bábeli könyvtár című novellát?", "a": ["Jorge Luis Borges", "Julio Cortázar", "Adolfo Bioy Casares", "Ernesto Sabato"], "c": 0, "d": "hard", "e": "Borges argentin író, a labirintus és a végtelen könyvtár motívumainak mestere.", "t": "latin-amerikai irodalom"}'
    ]
  ],

  'muveszet.json': [
    [
      'pontosabb szakszó (vasalás nélküli beton)',
      'e": "A Pantheon kupolája ma is a legnagyobb megerősítés nélküli betonkupola."',
      'e": "A Pantheon kupolája ma is a világ legnagyobb vasalás nélküli betonkupolája."'
    ],
    [
      'a „stílus jelmondata” megfogalmazás pontatlan',
      '{"q": "Melyik stílus jelmondata volt: „ez nem pipa”?", "a": ["Szürrealizmus", "Kubizmus", "Dada", "Pop-art"], "c": 0, "d": "hard", "e": "René Magritte képe a szó és a kép viszonyát kérdőjelezi meg.", "t": "szürrealizmus"}',
      '{"q": "Melyik stílushoz tartozik Magritte „Ez nem pipa” feliratú festménye?", "a": ["Szürrealizmus", "Kubizmus", "Dada", "Pop-art"], "c": 0, "d": "hard", "e": "A kép a szó és a kép viszonyát kérdőjelezi meg.", "t": "szürrealizmus"}'
    ]
  ],

  'etel-ital.json': [
    [
      'pontatlan leírás',
      '{"q": "Melyik magyar desszert kakaós, csokoládés öntettel és tejszínhabbal készül, kockákra vágva?", "a": ["Somlói galuska", "Rákóczi túrós", "Krémes", "Flódni"], "c": 0, "d": "medium", "e": "A somlói galuska piskótából, mazsolából és csokoládéöntetből áll.", "t": "magyar konyha"}',
      '{"q": "Melyik magyar desszert piskótából, mazsolából, csokoládéöntetből és tejszínhabból áll?", "a": ["Somlói galuska", "Rákóczi túrós", "Krémes", "Flódni"], "c": 0, "d": "medium", "e": "A somlói galuska háromféle piskótából és rumos-mazsolás rétegekből épül fel.", "t": "magyar konyha"}'
    ]
  ],

  'erdekessegek.json': [
    [
      'a helyes válasz és a magyarázat ellentmondott egymásnak',
      '{"q": "Melyik ország zászlaján szerepel a legtöbb csillag?", "a": ["Egyesült Államok", "Brazília", "Kína", "Ausztrália"], "c": 1, "d": "hard", "e": "Brazília zászlaján 27 csillag van, az amerikai zászlón 50 – tehát az USA vezet; a brazil zászló viszont valódi csillagképet ábrázol.", "t": "zászlók"}',
      '{"q": "Hány csillag van az Amerikai Egyesült Államok zászlaján?", "a": ["50", "13", "48", "52"], "c": 0, "d": "medium", "e": "Az 50 csillag az 50 szövetségi államot, a 13 sáv az alapító államokat jelöli.", "t": "zászlók"}'
    ],
    [
      'a válaszlehetőség maga tartalmazta a magyarázatot',
      '{"q": "Melyik ország használ jelenleg is nem tízes alapú pénzérme-hagyományt?", "a": ["Mauritánia (khoums, ötös alapú)", "Japán", "Kanada", "Norvégia"], "c": 0, "d": "hard", "e": "A mauritániai ouguiya öt khoumsra oszlik.", "t": "érdekes tények"}',
      '{"q": "Melyik ország pénzneme oszlik öt kisebb egységre a szokásos száz helyett?", "a": ["Mauritánia", "Japán", "Kanada", "Norvégia"], "c": 0, "d": "hard", "e": "A mauritániai ouguiya öt khoumsra oszlik.", "t": "érdekes tények"}'
    ],
    [
      'zavaros kérdés',
      '{"q": "Melyik hangszer szerepel a Guinness-rekordok között a világ legnagyobbként épített hangszerei közt, orgonaként?", "a": ["Orgona", "Zongora", "Hárfa", "Dob"], "c": 0, "d": "hard", "e": "Az orgonákat a világ legnagyobb hangszereinek tartják.", "t": "érdekes tények"}',
      '{"q": "Melyik a világ legnagyobb méretű hangszere?", "a": ["Orgona", "Zongora", "Hárfa", "Nagybőgő"], "c": 0, "d": "medium", "e": "A nagy templomi orgonák több emelet magasak és több ezer sípból állnak.", "t": "érdekes tények"}'
    ],
    [
      'a kérdés nem volt egyértelmű',
      '{"q": "Melyik szó jelentése a „szia” eredete szerint?", "a": ["Szervusz (szolgád)", "Egészség", "Béke", "Öröm"], "c": 0, "d": "hard", "e": "A szervusz a latin servus humilis („alázatos szolgád”) rövidülése."'.replace(/\s+$/, '') + ', "t": "érdekes tények"}',
      '{"q": "Miből rövidült a magyar „szervusz” köszönés?", "a": ["A latin servus humilis kifejezésből", "Egy német jókívánságból", "Egy szláv köszönésből", "Egy török szóból"], "c": 0, "d": "hard", "e": "A servus humilis jelentése „alázatos szolgád”.", "t": "érdekes tények"}'
    ]
  ],

  'logika.json': [
    [
      'a helyes válasz nem egyezett a magyarázattal',
      '{"q": "Ha ma péntek van, milyen nap volt 100 nappal korábban?", "a": ["Szombat", "Péntek", "Csütörtök", "Vasárnap"], "c": 0, "d": "hard", "e": "100 / 7 = 14 hét és 2 nap, tehát két nappal korábban: szerda… pontosan: péntek mínusz 2 nap = szerda; 100 nap visszafelé 2 napot jelent hetek után, így szerda. A helyes válasz ellenőrzése: 98 nap = 14 hét (péntek), további 2 nap vissza = szerda.", "t": "számolás"}',
      '{"q": "Ha ma péntek van, milyen nap volt 100 nappal korábban?", "a": ["Szerda", "Péntek", "Csütörtök", "Vasárnap"], "c": 0, "d": "hard", "e": "98 nap pontosan 14 hét (péntek), további 2 nap visszafelé: szerda.", "t": "számolás"}'
    ],
    [
      'kétszeres százalék-utalás a kérdésben',
      '{"q": "Mennyi 15% százaléka 200-nak?"',
      '{"q": "Mennyi 200-nak a 15 százaléka?"'
    ]
  ],

  'magyar-nyelv.json': [
    [
      'értelmetlen válaszlehetőség',
      '{"q": "Melyik szóban van hosszú ú?", "a": ["húsz", "husz", "hus", "húz csak"], "c": 0, "d": "medium", "e": "A húsz számnév hosszú ú-val írandó.", "t": "helyesírás"}',
      '{"q": "Melyik írásmód helyes?", "a": ["húsz", "husz", "hűsz", "hútz"], "c": 0, "d": "medium", "e": "A húsz számnév hosszú ú-val írandó.", "t": "helyesírás"}'
    ]
  ],

  'magyar-zene-film.json': [
    [
      'a válaszlehetőség állítást tartalmazott',
      '{"q": "Melyik magyar zenekar énekesnője volt Zorán helyett a Metro együttesben ismert énekes?", "a": ["Zorán volt a Metro énekese", "Koncz Zsuzsa", "Kovács Kati", "Cserháti Zsuzsa"], "c": 0, "d": "hard", "e": "Sztevanovity Zorán a Metro együttes énekese volt a hatvanas években.", "t": "könnyűzene"}',
      '{"q": "Melyik zenekar énekese volt Sztevanovity Zorán a hatvanas években?", "a": ["Metro", "Illés", "Omega", "Bergendy"], "c": 0, "d": "hard", "e": "A Metro az Illés és az Omega mellett a magyar beatzene harmadik nagy együttese volt.", "t": "könnyűzene"}'
    ],
    [
      'a válaszlehetőség tagadó állítás volt',
      '{"q": "Melyik magyar előadó nyerte a 2019-es A Dal című műsort?", "a": ["Nem A Dal döntött az eurovíziós indulásról 2019-ben", "Pápai Joci", "AWS", "Kállay Saunders"], "c": 1, "d": "hard", "e": "Pápai Joci a 2019-es A Dal győztese lett.", "t": "könnyűzene"}',
      '{"q": "Melyik magyar előadó nyerte a 2019-es A Dal című műsort?", "a": ["Pápai Joci", "AWS", "Kállay Saunders", "ByeAlex"], "c": 0, "d": "hard", "e": "Pápai Joci a Az én apám című dallal győzött.", "t": "könnyűzene"}'
    ],
    [
      'a válaszlehetőségek között személynév szerepelt film helyett',
      '{"q": "Melyik magyar filmvígjáték főszereplője Pelikán József gátőr?", "a": ["A tanú", "Bacsó Péter", "Régi idők focija", "Megáll az idő"], "c": 0, "d": "medium", "e": "Bacsó Péter 1969-es szatírája a magyar filmtörténet kultuszdarabja.", "t": "film"}',
      '{"q": "Melyik magyar film főszereplője Pelikán József gátőr?", "a": ["A tanú", "Régi idők focija", "Megáll az idő", "Szindbád"], "c": 0, "d": "medium", "e": "Bacsó Péter 1969-es szatírája a magyar filmtörténet kultuszdarabja.", "t": "film"}'
    ],
    [
      'a kérdés túl körülményes volt',
      '{"q": "Melyik magyar opera nyitánya a legismertebb magyar operanyitány, Erkel művéből?", "a": ["Bánk bán", "Hunyadi László", "Brankovics György", "Dózsa György"], "c": 1, "d": "hard", "e": "A Hunyadi László nyitánya Erkel legtöbbet játszott zenekari darabja.", "t": "klasszikus"}',
      '{"q": "Melyik Erkel-opera nyitánya a legtöbbet játszott magyar operanyitány?", "a": ["Hunyadi László", "Bánk bán", "Brankovics György", "Dózsa György"], "c": 0, "d": "hard", "e": "A Hunyadi László nyitánya Erkel legnépszerűbb zenekari darabja.", "t": "klasszikus"}'
    ],
    [
      'a kérdés két állítást kapcsolt össze',
      '{"q": "Melyik magyar énekesnő pályája az Illés-korszakhoz kötődik, és a Kis virág című dal is az ő nevéhez fűződik?", "a": ["Koncz Zsuzsa", "Kovács Kati", "Zalatnay Sarolta", "Cserháti Zsuzsa"], "c": 0, "d": "hard", "e": "Koncz Zsuzsa az Illés zenekarral is együtt dolgozott.", "t": "könnyűzene"}',
      '{"q": "Melyik magyar énekesnő pályája kötődik szorosan az Illés zenekarhoz?", "a": ["Koncz Zsuzsa", "Kovács Kati", "Zalatnay Sarolta", "Cserháti Zsuzsa"], "c": 0, "d": "hard", "e": "Koncz Zsuzsa több lemezén az Illés tagjai kísérték.", "t": "könnyűzene"}'
    ]
  ]
};

let applied = 0;
let failures = 0;

for (const [file, fixes] of Object.entries(FIXES)) {
  const path = `content/seed/${file}`;
  let text = readFileSync(path, 'utf8');

  for (const [reason, from, to] of fixes) {
    if (!text.includes(from)) {
      console.error(`✗ ${file}: nem található a javítandó rész (${reason})`);
      console.error(`  keresett: ${from.slice(0, 90)}…`);
      failures++;
      continue;
    }
    text = text.replace(from, to);
    console.log(`✓ ${file}: ${reason}`);
    applied++;
  }

  // Parse-olhatóság ellenőrzése minden fájl után
  try {
    JSON.parse(text);
  } catch (error) {
    console.error(`✗ ${file}: a javítás után érvénytelen JSON – nem írjuk ki. ${error.message}`);
    failures++;
    continue;
  }
  writeFileSync(path, text);
}

console.log(`\n${applied} javítás alkalmazva, ${failures} hiba.`);
process.exit(failures > 0 ? 1 : 0);
