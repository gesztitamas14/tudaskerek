// Wikidata SPARQL sablonok kérdésgeneráláshoz.
//
// Minden sablon szerződése:
//   * a SPARQL adjon vissza `?subject`, `?subjectLabel` és `?answerLabel` mezőt,
//   * a `{{LIMIT}}` helyére a szkript írja be a sorlimitet,
//   * a `question` és `explanation` sablonokban `{{subject}}` és `{{answer}}`
//     helyettesítődik.
//
// A hamis válaszokat a szkript a lekérdezés SAJÁT eredményhalmazából veszi,
// ezért minden distractor ugyanolyan típusú entitás, mint a helyes válasz.
//
// A `SERVICE wikibase:label` blokk magyar címkét kér, angol tartalékkal.

const LABELS = `SERVICE wikibase:label { bd:serviceParam wikibase:language "hu,en". }`;

export const TEMPLATES = [
  // ───────────────────── magyar földrajz ─────────────────────
  {
    id: 'magyar-telepules-megye',
    category: 'magyar-foldrajz',
    topic: 'települések és megyék',
    difficulty: 'medium',
    question: 'Melyik megyében található {{subject}}?',
    explanation: '{{subject}} {{answer}} megyében található.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q3308732 ;      # magyarországi város
                 wdt:P131 ?answer .
        ?answer wdt:P31 wd:Q170321 .        # magyarországi megye
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'magyar-megye-szekhely',
    category: 'magyar-foldrajz',
    topic: 'megyeszékhelyek',
    difficulty: 'medium',
    question: 'Melyik város {{subject}} székhelye?',
    explanation: '{{subject}} székhelye {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q170321 ;       # magyarországi megye
                 wdt:P36 ?answer .          # székhely
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── magyar irodalom ─────────────────────
  {
    id: 'magyar-iro-mu',
    category: 'magyar-irodalom',
    topic: 'szerzők és műveik',
    difficulty: 'hard',
    question: 'Ki írta a következő művet: {{subject}}?',
    explanation: 'A mű szerzője {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31/wdt:P279* wd:Q7725634 ;   # irodalmi mű
                 wdt:P50 ?answer .                  # szerző
        ?answer wdt:P27 wd:Q28 .                    # magyar állampolgár
        ?answer wdt:P106 wd:Q49757 .                # költő
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── világföldrajz ─────────────────────
  {
    id: 'orszag-fovaros',
    category: 'foldrajz',
    topic: 'fővárosok',
    difficulty: 'easy',
    question: 'Melyik város {{subject}} fővárosa?',
    explanation: '{{subject}} fővárosa {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q3624078 ;      # szuverén állam
                 wdt:P36 ?answer .
        FILTER NOT EXISTS { ?subject wdt:P576 ?dissolved }
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'orszag-valuta',
    category: 'foldrajz',
    topic: 'valuták',
    difficulty: 'medium',
    question: 'Mi {{subject}} hivatalos fizetőeszköze?',
    explanation: '{{subject}} pénzneme a(z) {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q3624078 ;
                 wdt:P38 ?answer .
        FILTER NOT EXISTS { ?subject wdt:P576 ?dissolved }
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'orszag-kontinens',
    category: 'foldrajz',
    topic: 'kontinensek',
    difficulty: 'easy',
    question: 'Melyik földrészen található {{subject}}?',
    explanation: '{{subject}} {{answer}} területén helyezkedik el.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q3624078 ;
                 wdt:P30 ?answer .
        FILTER NOT EXISTS { ?subject wdt:P576 ?dissolved }
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── tudomány ─────────────────────
  {
    id: 'elem-vegyjel',
    category: 'tudomany',
    topic: 'kémiai elemek',
    difficulty: 'medium',
    question: 'Mi a következő kémiai elem vegyjele: {{subject}}?',
    explanation: '{{subject}} vegyjele: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q11344 ;        # kémiai elem
                 wdt:P246 ?answerLabel .    # vegyjel (string)
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── művészet ─────────────────────
  {
    id: 'festmeny-festo',
    category: 'muveszet',
    topic: 'festmények és festők',
    difficulty: 'hard',
    question: 'Ki festette a következő képet: {{subject}}?',
    explanation: 'A festmény készítője {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q3305213 ;      # festmény
                 wdt:P170 ?answer ;         # készítő
                 wdt:P6216 wd:Q19652 .      # közkincs
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── film ─────────────────────
  {
    id: 'film-rendezo',
    category: 'film-sorozat',
    topic: 'rendezők',
    difficulty: 'medium',
    question: 'Ki rendezte a következő filmet: {{subject}}?',
    explanation: 'A film rendezője {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q11424 ;        # film
                 wdt:P57 ?answer ;          # rendező
                 wdt:P166 wd:Q102427 .      # legjobb film Oscar-díja
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── állatvilág ─────────────────────
  {
    id: 'allat-rend',
    category: 'allatvilag',
    topic: 'rendszerezés',
    difficulty: 'hard',
    question: 'Melyik rendbe tartozik a következő állat: {{subject}}?',
    explanation: '{{subject}} a(z) {{answer}} rendbe tartozik.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q16521 ;        # taxon
                 wdt:P105 wd:Q7432 ;        # faj szintű
                 wdt:P171+ ?answer .
        ?answer wdt:P105 wd:Q36602 .        # rend szintű
        ?subject wdt:P171/wdt:P171* wd:Q5113 .   # madarak
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── zene ─────────────────────
  {
    id: 'zenemu-szerzo',
    category: 'zene',
    topic: 'zeneszerzők',
    difficulty: 'hard',
    question: 'Ki komponálta a következő művet: {{subject}}?',
    explanation: 'A mű szerzője {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31/wdt:P279* wd:Q2188189 ;  # zenemű
                 wdt:P86 ?answer .                 # zeneszerző
        ?answer wdt:P106 wd:Q36834 .               # zeneszerző szakma
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── világtörténelem ─────────────────────
  {
    id: 'orszag-fuggetlenseg-evtized',
    category: 'vilagtortenelem',
    topic: 'függetlenségi dátumok',
    difficulty: 'hard',
    question: 'Melyik évtizedben lett független {{subject}}?',
    explanation: '{{subject}} függetlenségének évtizede: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel (CONCAT(STR(FLOOR(YEAR(?date)/10)*10), "-es évek") AS ?answerLabel) WHERE {
        ?subject wdt:P31 wd:Q3624078 ;
                 wdt:P571 ?date .
        FILTER (YEAR(?date) > 1800)
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  }
];
