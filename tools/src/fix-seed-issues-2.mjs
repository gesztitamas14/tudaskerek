#!/usr/bin/env node
// Második javítókör: a `validate-seed.mjs` által feltárt hibák.
//
// Két csoport:
//
// 1. A kérdés szó szerint tartalmazta a helyes választ (ingyen pont).
//
// 2. A helyesírási kérdések válaszlehetőségei csak ékezetben vagy szóközben
//    tértek el. Ez nem csak esztétikai gond: a szerveroldali
//    `questions_answers_distinct` CHECK a normalizált (ékezet nélküli) alakot
//    hasonlítja össze, ezért az adatbázis EL IS UTASÍTANÁ ezeket a sorokat.
//    Ahol lehetett, olyan párokra írtuk át, amelyek normalizálás után is
//    különböznek (pl. „egyelőre” / „egyenlőre”), ahol nem, ott kicseréltük a
//    kérdést.

import { readFileSync, writeFileSync } from 'node:fs';

const FIXES = {
  'allatvilag.json': [
    [
      'a kérdés tartalmazta a választ',
      '{"q": "Melyik magyar vizslafajta rövid szőrű, arany-rozsdás színű?", "a": ["Magyar vizsla", "Drótszőrű vizsla", "Erdélyi kopó", "Magyar agár"], "c": 0, "d": "medium", "e": "A rövid szőrű magyar vizsla vadászkutya-fajta.", "t": "magyar fauna"}',
      '{"q": "Melyik magyar vadászkutya-fajta rövid szőrű és arany-rozsdás színű?", "a": ["Magyar vizsla", "Erdélyi kopó", "Magyar agár", "Komondor"], "c": 0, "d": "medium", "e": "A rövid szőrű magyar vizsla a legismertebb hazai vadászkutya.", "t": "magyar fauna"}'
    ]
  ],

  'etel-ital.json': [
    [
      'a kérdés tartalmazta a választ',
      '{"q": "Melyik magyar étel készül töltött káposztalevélből?", "a": ["Töltött káposzta", "Rakott káposzta", "Káposztasaláta", "Székelykáposzta"], "c": 0, "d": "easy", "e": "A töltelék jellemzően darált hús és rizs.", "t": "magyar konyha"}',
      '{"q": "Melyik magyar ételhez tekerik darált húsos-rizses tölteléket savanyú levelekbe?", "a": ["Töltött káposzta", "Rakott káposzta", "Székelykáposzta", "Lecsó"], "c": 0, "d": "easy", "e": "A töltelék darált húsból és rizsből készül, a levél savanyú káposzta.", "t": "magyar konyha"}'
    ]
  ],

  'film-sorozat.json': [
    [
      'a kérdés tartalmazta a választ',
      '{"q": "Melyik film nyerte a legjobb film Oscar-díját 1994-ben, Forrest Gump főszereplésével?", "a": ["Forrest Gump", "Ponyvaregény", "A remény rabjai", "Négy esküvő és egy temetés"], "c": 0, "d": "medium", "e": "A Forrest Gump hat Oscart kapott.", "t": "Oscar"}',
      '{"q": "Melyik film nyerte a legjobb film Oscar-díját a Ponyvaregény és A remény rabjai évében?", "a": ["Forrest Gump", "Ponyvaregény", "A remény rabjai", "Négy esküvő és egy temetés"], "c": 0, "d": "medium", "e": "Az 1995-ös díjátadón, az 1994-es filmekért, a Forrest Gump hat Oscart kapott.", "t": "Oscar"}'
    ],
    [
      'a kérdés tartalmazta a választ',
      '{"q": "Melyik sorozat a HBO történelmi drámája a csernobili katasztrófáról?", "a": ["Csernobil", "Az elveszettek", "The Terror", "Band of Brothers"], "c": 0, "d": "medium", "e": "Az ötrészes minisorozat 2019-ben jelent meg.", "t": "sorozatok"}',
      '{"q": "Melyik HBO-minisorozat szól az 1986-os atomerőmű-katasztrófáról?", "a": ["Csernobil", "Az elveszettek", "The Terror", "Band of Brothers"], "c": 0, "d": "medium", "e": "Az ötrészes minisorozat 2019-ben jelent meg.", "t": "sorozatok"}'
    ]
  ],

  'magyar-irodalom.json': [
    [
      'a kérdés tartalmazta a választ',
      '{"q": "Melyik Mikszáth-regény címe utal egy „különös” házasságra?", "a": ["A Noszty fiú esete Tóth Marival", "Szent Péter esernyője", "Különös házasság", "Beszterce ostroma"], "c": 2, "d": "medium", "e": "A Különös házasság 1900-ban jelent meg, egyházi jogi konfliktus a témája.", "t": "Mikszáth"}',
      '{"q": "Melyik Mikszáth-regény témája egy érvénytelenné tett egyházi esküvő?", "a": ["Különös házasság", "Szent Péter esernyője", "A Noszty fiú esete Tóth Marival", "Beszterce ostroma"], "c": 0, "d": "medium", "e": "A Különös házasság 1900-ban jelent meg, Buttler János gróf esete alapján.", "t": "Mikszáth"}'
    ]
  ],

  'magyar-nyelv.json': [
    [
      'a válaszok csak ékezetben tértek el (a DB is elutasítaná)',
      '{"q": "Melyik szó helyesírása helyes?", "a": ["egyelőre", "egyellőre", "egyellőrre", "egyelöre"], "c": 0, "d": "medium", "e": "Az „egyelőre” jelentése: pillanatnyilag.", "t": "helyesírás"}',
      '{"q": "Melyik szó jelentése „pillanatnyilag, mostanáig”?", "a": ["Egyelőre", "Egyenlőre", "Egyaránt", "Egyenesen"], "c": 0, "d": "medium", "e": "Az „egyenlőre” azt jelenti: egyenlő méretűre – gyakran összekeverik a kettőt.", "t": "helyesírás"}'
    ],
    [
      'a válaszok csak szóközben tértek el',
      '{"q": "Hogyan írjuk helyesen: „szerintem ez ...”?", "a": ["mindegy", "mind egy", "minde gy", "mind-egy"], "c": 0, "d": "easy", "e": "A „mindegy” egybeírt szó.", "t": "helyesírás"}',
      '{"q": "Melyik szót írjuk a magyarban egybe?", "a": ["Mindegy", "Nem tudom", "Meg is", "Azon kívül"], "c": 0, "d": "medium", "e": "A „mindegy” egybeírt szó, a tagadószót viszont külön írjuk az igétől.", "t": "helyesírás"}'
    ],
    [
      'a válaszok csak ékezetben tértek el',
      '{"q": "Melyik írásmód helyes?", "a": ["nem tudom", "nemtudom", "nem-tudom", "nemtudóm"], "c": 0, "d": "easy", "e": "A tagadószót külön írjuk az igétől.", "t": "helyesírás"}',
      '{"q": "Hogyan írjuk a tagadószót az ige mellett?", "a": ["Külön", "Egybe", "Kötőjellel", "Idézőjelben"], "c": 0, "d": "easy", "e": "Például: „nem tudom”, „nem megy”.", "t": "helyesírás"}'
    ],
    [
      'az „utca” és az „útca” normalizálva megegyezik',
      '{"q": "Melyik alak helyes?", "a": ["utca", "úcca", "uttca", "útca"], "c": 0, "d": "easy", "e": "Kiejtésben „ucca”, írásban utca.", "t": "helyesírás"}',
      '{"q": "Melyik alak a helyes írásmód?", "a": ["Utca", "Ucca", "Uttza", "Utsza"], "c": 0, "d": "easy", "e": "Kiejtésben „ucca”, írásban utca – ez kiejtéstől eltérő írásmód.", "t": "helyesírás"}'
    ],
    [
      'a „husz” és a „húsz” normalizálva megegyezik – jelentés-kérdésre cseréljük',
      '{"q": "Melyik írásmód helyes?", "a": ["húsz", "husz", "hűsz", "hútz"], "c": 0, "d": "medium", "e": "A húsz számnév hosszú ú-val írandó.", "t": "helyesírás"}',
      '{"q": "Mit jelent a „tulajdonképpen” szó?", "a": ["Valójában", "Véletlenül", "Kizárólag", "Alkalmanként"], "c": 0, "d": "medium", "e": "A tulajdonképpen a lényeget, a valódi helyzetet vezeti be.", "t": "szókincs"}'
    ],
    [
      'a dátumformátumok normalizálva egybeestek',
      '{"q": "Hogyan írjuk helyesen a dátumot magyarul?", "a": ["2026. március 15.", "2026 Március 15", "15. március 2026.", "2026/03/15."], "c": 0, "d": "medium", "e": "Az év után pont, a hónap kisbetűvel, a nap után pont.", "t": "helyesírás"}',
      '{"q": "Milyen sorrendben írjuk a dátumot a magyar helyesírás szerint?", "a": ["Év, hónap, nap", "Nap, hónap, év", "Hónap, nap, év", "Hónap, év, nap"], "c": 0, "d": "medium", "e": "Például: 2026. március 15. – az év után pont áll, a hónap kisbetűvel.", "t": "helyesírás"}'
    ],
    [
      'a válaszok csak betűkettőzésben tértek el',
      '{"q": "Hogyan írjuk helyesen: „a legjobb ...”?", "a": ["barátom", "baráttom", "baratom", "barrátom"], "c": 0, "d": "easy", "e": "A barát szó egy t-vel írandó.", "t": "helyesírás"}',
      '{"q": "Melyik a helyes birtokos alak a „barát” szóból többes számban?", "a": ["Barátaim", "Barátjaim", "Barátim", "Barátomék"], "c": 0, "d": "hard", "e": "A helyes alak: barátaim.", "t": "nyelvtan"}'
    ],
    [
      'a kérdés tartalmazta a helyes választ',
      '{"q": "Melyik a helyes alak: „Szegeden” vagy „Szegedben”?", "a": ["Szegeden", "Szegedben", "Szegedön", "Szegednál"], "c": 0, "d": "medium", "e": "A magyar városnevek többségéhez -n/-on/-en/-ön járul.", "t": "nyelvtan"}',
      '{"q": "Milyen toldalékot kap a legtöbb magyar városnév a „hol?” kérdésre?", "a": ["-n / -on / -en / -ön", "-ban / -ben", "-nál / -nél", "-hoz / -hez"], "c": 0, "d": "medium", "e": "Például Szegeden, Debrecenben viszont belső helyhatározó – ez kivétel.", "t": "nyelvtan"}'
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
      console.error(`✗ ${file}: nem található (${reason})`);
      failures++;
      continue;
    }
    text = text.replace(from, to);
    console.log(`✓ ${file}: ${reason}`);
    applied++;
  }

  try {
    JSON.parse(text);
  } catch (error) {
    console.error(`✗ ${file}: érvénytelen JSON a javítás után – nem írjuk ki. ${error.message}`);
    failures++;
    continue;
  }
  writeFileSync(path, text);
}

console.log(`\n${applied} javítás alkalmazva, ${failures} hiba.`);
process.exit(failures > 0 ? 1 : 0);
