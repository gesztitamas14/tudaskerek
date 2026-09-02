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
    minSitelinks: 4,
    requireHungarianSubject: true,
    topic: 'települések és megyék',
    difficulty: 'medium',
    question: 'Melyik megyében található {{subject}}?',
    explanation: '{{subject}} {{answer}} megyében található.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q3308732 ;      # magyarországi város
                 wdt:P131 ?answer .
        ?answer wdt:P31 wd:Q170321 .        # magyarországi megye
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'magyar-megye-szekhely',
    category: 'magyar-foldrajz',
    minSitelinks: 4,
    requireHungarianSubject: true,
    topic: 'megyeszékhelyek',
    difficulty: 'medium',
    question: 'Melyik város {{subject}} székhelye?',
    explanation: '{{subject}} székhelye {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q170321 ;       # magyarországi megye
                 wdt:P36 ?answer .          # székhely
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── magyar irodalom ─────────────────────
  {
    id: 'magyar-iro-mu',
    minAnswerSitelinks: 10,
    category: 'magyar-irodalom',
    minSitelinks: 4,
    requireHungarianSubject: true,
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
        {{NOTABLE}}
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
        {{NOTABLE}}
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
        {{NOTABLE}}
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
        {{NOTABLE}}
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
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── művészet ─────────────────────
  {
    id: 'festmeny-festo',
    minAnswerSitelinks: 10,
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
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── film ─────────────────────
  {
    id: 'film-rendezo',
    minAnswerSitelinks: 10,
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
        {{NOTABLE}}
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
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── zene ─────────────────────
  {
    id: 'zenemu-szerzo',
    minAnswerSitelinks: 10,
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
        {{NOTABLE}}
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
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── magyar történelem ─────────────────────

  {
    id: 'magyar-tortenelmi-szemely-evszazad',
    category: 'magyar-tortenelem',
    minSitelinks: 4,
    requireHungarianSubject: true,
    topic: 'történelmi személyek',
    difficulty: 'hard',
    question: 'Melyik évszázadban született {{subject}}?',
    explanation: '{{subject}} születése: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel
             (CONCAT(STR(CEIL(YEAR(?date)/100)), ". század") AS ?answerLabel) WHERE {
        ?subject wdt:P31 wd:Q5 ;
                 wdt:P27 wd:Q28 ;         # magyar
                 wdt:P106 wd:Q82955 ;     # politikus
                 wdt:P569 ?date .
        FILTER (YEAR(?date) < 1930)
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── magyar sport ─────────────────────
  {
    id: 'magyar-sportolo-sportag',
    category: 'magyar-sport',
    minSitelinks: 4,
    requireHungarianSubject: true,
    topic: 'sportolók és sportágak',
    difficulty: 'medium',
    question: 'Melyik sportágban jeleskedett {{subject}}?',
    explanation: '{{subject}} sportága: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q5 ;
                 wdt:P27 wd:Q28 ;          # magyar
                 wdt:P106 wd:Q2066131 ;    # sportoló
                 wdt:P641 ?answer .        # sportág
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── magyar zene és film ─────────────────────
  {
    id: 'magyar-film-rendezo',
    category: 'magyar-zene-film',
    minSitelinks: 4,
    requireHungarianSubject: true,
    topic: 'magyar filmek',
    difficulty: 'hard',
    question: 'Ki rendezte a következő magyar filmet: {{subject}}?',
    explanation: 'A film rendezője {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q11424 ;      # film
                 wdt:P495 wd:Q28 ;        # magyar származású
                 wdt:P57 ?answer .        # rendező
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── magyar kultúra ─────────────────────
  {
    id: 'magyar-szinesz-szuletesi-hely',
    category: 'magyar-kultura',
    minSitelinks: 4,
    requireHungarianSubject: true,
    topic: 'színészek',
    difficulty: 'hard',
    question: 'Melyik településen született {{subject}}?',
    explanation: '{{subject}} születési helye {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q5 ;
                 wdt:P27 wd:Q28 ;
                 wdt:P106 wd:Q33999 ;     # színész
                 wdt:P19 ?answer .
        ?answer wdt:P17 wd:Q28 .          # magyarországi hely
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── technológia ─────────────────────
  {
    id: 'programnyelv-tervezo',
    minAnswerSitelinks: 10,
    category: 'technologia',
    topic: 'programozási nyelvek',
    difficulty: 'hard',
    question: 'Ki tervezte a következő programozási nyelvet: {{subject}}?',
    explanation: '{{subject}} tervezője {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q9143 ;       # programozási nyelv
                 wdt:P287 ?answer .       # tervező
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'ceg-alapito',
    minAnswerSitelinks: 10,
    category: 'technologia',
    topic: 'cégek és alapítók',
    difficulty: 'medium',
    question: 'Ki az egyik alapítója a következő vállalatnak: {{subject}}?',
    explanation: '{{subject}} egyik alapítója {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P452 wd:Q880371 ;    # szoftveripar
                 wdt:P112 ?answer .       # alapító
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── természet ─────────────────────
  {
    id: 'hegy-orszag',
    category: 'termeszet',
    topic: 'hegyek',
    difficulty: 'medium',
    question: 'Melyik országban található {{subject}}?',
    explanation: '{{subject}} {{answer}} területén található.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q8502 ;       # hegy
                 wdt:P2044 ?h ;
                 wdt:P17 ?answer .
        FILTER(?h > 2000)
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── sport (nemzetközi) ─────────────────────
  {
    id: 'sportolo-sportag',
    category: 'sport',
    topic: 'sportolók és sportágak',
    difficulty: 'medium',
    question: 'Melyik sportágban ismert {{subject}}?',
    explanation: '{{subject}} sportága: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q5 ;
                 wdt:P106 wd:Q2066131 ;   # sportoló
                 wdt:P641 ?answer ;
                 wdt:P166 ?award .        # kapott valamilyen elismerést
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'klub-orszag',
    category: 'sport',
    topic: 'labdarúgóklubok',
    difficulty: 'medium',
    question: 'Melyik országban játszik a következő labdarúgóklub: {{subject}}?',
    explanation: '{{subject}} {{answer}} klubja.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q476028 ;     # labdarúgóklub
                 wdt:P17 ?answer .
        ?subject wdt:P118 ?liga .
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── irodalom (nemzetközi) ─────────────────────
  {
    id: 'vilagirodalom-szerzo',
    minAnswerSitelinks: 10,
    category: 'irodalom',
    topic: 'szerzők és műveik',
    difficulty: 'hard',
    question: 'Ki írta a következő művet: {{subject}}?',
    explanation: 'A mű szerzője {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31/wdt:P279* wd:Q7725634 ;
                 wdt:P50 ?answer .
        ?answer wdt:P166 wd:Q37922 .      # irodalmi Nobel-díj
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ───────────────────── étel és ital ─────────────────────

  // ───────────────────── érdekességek ─────────────────────
  {
    id: 'elem-felfedezo',
    minAnswerSitelinks: 10,
    category: 'erdekessegek',
    topic: 'kémiai elemek',
    difficulty: 'hard',
    question: 'Ki fedezte fel a következő kémiai elemet: {{subject}}?',
    explanation: '{{subject}} felfedezője {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q11344 ;      # kémiai elem
                 wdt:P61 ?answer .        # felfedező
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ═════════════════ CÉGEK, MÁRKÁK ═════════════════
  {
    id: 'ceg-szekhely-orszag',
    category: 'cegek-markak',
    topic: 'cégek székhelye',
    difficulty: 'medium',
    question: 'Melyik országban van a következő vállalat székhelye: {{subject}}?',
    explanation: '{{subject}} székhelye {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q4830453 ;    # vállalat (közvetlen, nem alosztály-bejárás)
                 wdt:P414 ?tozsde ;       # tőzsdén jegyzett → szűk, ismert halmaz
                 wdt:P17 ?answer .
        ?answer wdt:P31 wd:Q6256 .
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'ceg-alapitas-evtized',
    category: 'cegek-markak',
    topic: 'cégek alapítása',
    difficulty: 'hard',
    question: 'Melyik évtizedben alapították a következő vállalatot: {{subject}}?',
    explanation: '{{subject}} alapítása: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel
             (CONCAT(STR(FLOOR(YEAR(?date)/10)*10), "-es évek") AS ?answerLabel) WHERE {
        ?subject wdt:P31 wd:Q4830453 ;
                 wdt:P414 ?tozsde ;
                 wdt:P571 ?date .
        FILTER (YEAR(?date) > 1850)
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'markanev-iparag',
    category: 'cegek-markak',
    topic: 'iparágak',
    difficulty: 'medium',
    question: 'Melyik iparágban működik a következő vállalat: {{subject}}?',
    explanation: '{{subject}} iparága: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q4830453 ;
                 wdt:P414 ?tozsde ;
                 wdt:P452 ?answer .
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ═════════════════ HÍRES EMBEREK ═════════════════
  {
    id: 'hires-ember-foglalkozas',
    category: 'hires-ember',
    topic: 'foglalkozások',
    difficulty: 'medium',
    question: 'Mivel foglalkozott {{subject}}?',
    explanation: '{{subject}} foglalkozása: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q5 ;
                 wdt:P166 ?dij ;          # kapott elismerést → szűk halmaz
                 wdt:P106 ?answer .
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'hires-ember-nemzetiseg',
    category: 'hires-ember',
    topic: 'nemzetiség',
    difficulty: 'medium',
    question: 'Melyik ország szülötte {{subject}}?',
    explanation: '{{subject}} állampolgársága: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q5 ;
                 wdt:P166 ?dij ;
                 wdt:P27 ?answer .
        ?answer wdt:P31 wd:Q6256 .
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'nobel-dijas-terulet',
    category: 'hires-ember',
    topic: 'Nobel-díjasok',
    difficulty: 'hard',
    question: 'Milyen területen kapott Nobel-díjat {{subject}}?',
    explanation: '{{subject}} Nobel-díja: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P166 ?answer .
        ?answer wdt:P31 wd:Q7191 .        # Nobel-díj
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ═════════════════ KÉMIA ═════════════════
  {
    id: 'kemia-elem-vegyjel',
    category: 'kemia',
    topic: 'vegyjelek',
    difficulty: 'medium',
    question: 'Mi a következő kémiai elem vegyjele: {{subject}}?',
    explanation: '{{subject}} vegyjele: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q11344 ;
                 wdt:P246 ?answerLabel .
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'kemia-elem-felfedezo',
    category: 'kemia',
    topic: 'elemek felfedezői',
    difficulty: 'hard',
    minAnswerSitelinks: 10,
    question: 'Ki fedezte fel a következő kémiai elemet: {{subject}}?',
    explanation: '{{subject}} felfedezője {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q11344 ;
                 wdt:P61 ?answer .
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'kemia-elem-csoport',
    category: 'kemia',
    topic: 'periódusos rendszer',
    difficulty: 'hard',
    question: 'Melyik elemcsoportba tartozik a következő elem: {{subject}}?',
    explanation: '{{subject}} elemcsoportja: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q11344 ;
                 wdt:P279 ?answer .
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ═════════════════ FIZIKA ═════════════════
  {
    id: 'fizikus-nemzetiseg',
    category: 'fizika',
    topic: 'fizikusok',
    difficulty: 'hard',
    question: 'Melyik ország szülötte a következő fizikus: {{subject}}?',
    explanation: '{{subject}} állampolgársága: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q5 ;
                 wdt:P106 wd:Q169470 ;    # fizikus
                 wdt:P166 ?dij ;          # elismeréssel → szűkebb és ismertebb
                 wdt:P27 ?answer .
        ?answer wdt:P31 wd:Q6256 .
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'mertekegyseg-mennyiseg',
    category: 'fizika',
    topic: 'mértékegységek',
    difficulty: 'medium',
    question: 'Milyen fizikai mennyiség mértékegysége a következő: {{subject}}?',
    explanation: 'A(z) {{subject}} a(z) {{answer}} mértékegysége.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31/wdt:P279* wd:Q47574 ;   # mértékegység
                 wdt:P111 ?answer .              # mért mennyiség
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ═════════════════ MITOLÓGIA, VALLÁS ═════════════════
  {
    id: 'gorog-isten-terulet',
    category: 'mitologia-vallas',
    topic: 'görög mitológia',
    difficulty: 'hard',
    question: 'Melyik mitológiához tartozik {{subject}}?',
    explanation: '{{subject}} a(z) {{answer}} alakja.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31/wdt:P279* wd:Q178885 ;   # istenség
                 wdt:P2925 ?answer .              # mitológia
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'vallas-alapito',
    category: 'mitologia-vallas',
    topic: 'vallások',
    difficulty: 'hard',
    minAnswerSitelinks: 10,
    question: 'Kihez köthető a következő vallás vagy felekezet: {{subject}}?',
    explanation: '{{subject}} alapítója {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31/wdt:P279* wd:Q9174 ;    # vallás
                 wdt:P112 ?answer .
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ═════════════════ JÁTÉKOK ═════════════════
  {
    id: 'videojatek-fejleszto',
    category: 'jatekok',
    topic: 'videojátékok',
    difficulty: 'hard',
    question: 'Melyik stúdió fejlesztette a következő játékot: {{subject}}?',
    explanation: '{{subject}} fejlesztője: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q7889 ;       # videojáték
                 wdt:P178 ?answer .       # fejlesztő
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'videojatek-platform',
    category: 'jatekok',
    topic: 'platformok',
    difficulty: 'medium',
    question: 'Melyik platformra jelent meg a következő játék: {{subject}}?',
    explanation: '{{subject}} platformja: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q7889 ;
                 wdt:P400 ?answer .
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ═════════════════ DIVAT ═════════════════
  {
    id: 'divatmarka-orszag',
    category: 'divat',
    topic: 'divatmárkák',
    difficulty: 'medium',
    question: 'Melyik országból származik a következő divatmárka: {{subject}}?',
    explanation: '{{subject}} származási országa: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q431289 ;     # márka
                 wdt:P17 ?answer .
        ?answer wdt:P31 wd:Q6256 .
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'divattervezo-nemzetiseg',
    category: 'divat',
    topic: 'divattervezők',
    difficulty: 'hard',
    question: 'Melyik ország szülötte a következő divattervező: {{subject}}?',
    explanation: '{{subject}} állampolgársága: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q5 ;
                 wdt:P106 wd:Q3501317 ;   # divattervező
                 wdt:P27 ?answer .
        ?subject wdt:P569 ?szul .
        ?answer wdt:P31 wd:Q6256 .
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ═════════════════ ÜNNEPEK ═════════════════
  {
    id: 'unnep-orszag',
    category: 'unnepek',
    topic: 'nemzeti ünnepek',
    difficulty: 'hard',
    question: 'Melyik országban nemzeti ünnep a következő: {{subject}}?',
    explanation: '{{subject}} {{answer}} ünnepe.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31/wdt:P279* wd:Q1197685 ;   # nemzeti ünnep
                 wdt:P17 ?answer .
        ?answer wdt:P31 wd:Q6256 .
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },

  // ═════════════════ VÁLTOZATOSSÁG A MEGLÉVŐKNEK ═════════════════
  {
    id: 'film-orszag',
    category: 'film-sorozat',
    topic: 'filmek országa',
    difficulty: 'medium',
    question: 'Melyik ország filmje a következő: {{subject}}?',
    explanation: '{{subject}} származási országa: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q11424 ;
                 wdt:P495 ?answer .
        ?answer wdt:P31 wd:Q6256 .
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'film-evtized',
    category: 'film-sorozat',
    topic: 'filmek évtizede',
    difficulty: 'hard',
    question: 'Melyik évtizedben jelent meg a következő film: {{subject}}?',
    explanation: '{{subject}} bemutatója: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel
             (CONCAT(STR(FLOOR(YEAR(?date)/10)*10), "-es évek") AS ?answerLabel) WHERE {
        ?subject wdt:P31 wd:Q11424 ;
                 wdt:P577 ?date .
        FILTER (YEAR(?date) > 1920)
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'zenekar-orszag',
    category: 'zene',
    topic: 'zenekarok',
    difficulty: 'medium',
    question: 'Melyik országból származik a következő zenekar: {{subject}}?',
    explanation: '{{subject}} származási helye: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q215380 ;     # zenei együttes
                 wdt:P495 ?answer .
        ?answer wdt:P31 wd:Q6256 .
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'zenesz-hangszer',
    category: 'zene',
    topic: 'hangszerek',
    difficulty: 'hard',
    question: 'Melyik hangszeren játszott {{subject}}?',
    explanation: '{{subject}} hangszere: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q5 ;
                 wdt:P1303 ?answer .      # hangszer
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'folyo-orszag',
    category: 'foldrajz',
    topic: 'folyók',
    difficulty: 'medium',
    question: 'Melyik országon folyik át a következő folyó: {{subject}}?',
    explanation: '{{subject}} {{answer}} területén folyik.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q4022 ;       # folyó
                 wdt:P17 ?answer .
        ?answer wdt:P31 wd:Q6256 .
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'muzeum-varos',
    category: 'muveszet',
    topic: 'múzeumok',
    difficulty: 'hard',
    question: 'Melyik városban található a következő múzeum: {{subject}}?',
    explanation: '{{subject}} {{answer}}ban/ben található.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31/wdt:P279* wd:Q33506 ;   # múzeum
                 wdt:P131 ?answer .
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'iro-nemzetiseg',
    category: 'irodalom',
    topic: 'írók nemzetisége',
    difficulty: 'medium',
    question: 'Melyik ország szülötte a következő író: {{subject}}?',
    explanation: '{{subject}} állampolgársága: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P31 wd:Q5 ;
                 wdt:P106 wd:Q36180 ;     # író
                 wdt:P27 ?answer .
        ?answer wdt:P31 wd:Q6256 .
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
  {
    id: 'allat-taplalkozas',
    category: 'allatvilag',
    topic: 'állatok élőhelye',
    difficulty: 'medium',
    question: 'Melyik földrészen él a következő állat: {{subject}}?',
    explanation: '{{subject}} élőhelye: {{answer}}.',
    sparql: `
      SELECT ?subject ?subjectLabel ?answerLabel WHERE {
        ?subject wdt:P105 wd:Q7432 ;
                 wdt:P183 ?answer .       # endemikus terület
        {{NOTABLE}}
        ${LABELS}
      }
      LIMIT {{LIMIT}}
    `
  },
];
