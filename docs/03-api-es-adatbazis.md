# API és adatbázis

A kliens **nem ír táblát**, és a `questions` táblát **nem is olvassa**. Minden
művelet nézeten vagy `SECURITY DEFINER` RPC-n megy, ami maga ellenőrzi a
jogosultságot. Ez teszi lehetővé, hogy a helyes válasz ne szivárogjon ki, és a
pontszám ne legyen hamisítható.

---

## 1. Táblák

### Tartalom

| Tábla | Mit tárol | Kliens hozzáférés |
|---|---|---|
| `categories` | 22 kategória (név, ikon, szín, sorrend) | olvasás (RLS: aktív) |
| `questions` | a kérdésbank, **helyes válasszal** | **nincs** – csak moderátor |
| `question_stats` | válaszszám, találati arány, átlagos idő, bejelentések | nincs |
| `question_packs` | monetizáció-előkészítés (`NULL` pack = ingyenes) | olvasás |
| `scoring_rules` | verziózott pontozási szabály | olvasás |

Kulcsmegoldások a `questions` táblán:

```sql
norm_question   text  generated always as (norm_text(question_text)) stored
answers         text[] generated always as (array[answer_a … answer_d]) stored
answer_set_hash text  generated always as (answer_set_hash(a,b,c,d)) stored
```

- `unique (category_id, norm_question)` – **pontos duplikátum lehetetlen**
- `gin (norm_question gin_trgm_ops)` – közel-duplikátum keresés
- `check` a négy válasz normalizált páronkénti különbözőségére – ezért nem lehet
  olyan kérdést felvenni, ahol két válasz csak ékezetben tér el

### Játék

| Tábla | Mit tárol |
|---|---|
| `profiles` | becenév, avatar, szerepkör, aggregált statisztika |
| `game_sessions` | egy kör szerveroldali állapota (bankolt pont, státusz) |
| `session_questions` | a körben kiszolgált kérdések (`ordinal`, válasz, pont) |
| `player_question_history` | ki mit látott már – ismétlésvédelem sessionök között |
| `game_results` | lezárt körök; a ranglista alapja (`day_key`, `week_key`, `month_key`) |

### Multiplayer

| Tábla | Mit tárol |
|---|---|
| `rooms` | szobakód, host, létszám, aktuális kör, időzítés (`answer_seconds`, `spin_seconds`, `reveal_seconds`) |
| `room_players` | résztvevők, székek, összesített pont, köri pont, kiesett-e |
| `room_questions` | a szobában feltett kérdések: kör, sorszám, kategória, határidők |
| `room_answers` | ki mit válaszolt, jó volt-e, mennyi pontot ért |

A `room_questions` és a `room_answers` táblákra **szándékosan nincs semmilyen
kliensjog** (se grant, se policy). A kliens mindent a `room_tick()` /
`room_state()` RPC-n keresztül kap meg – az dönti el, mit szabad látni.

### AI pipeline

| Tábla | Mit tárol |
|---|---|
| `generation_batches` | egy generálási futam (kategória, téma, modell) |
| `question_candidates` | jelöltek review-ra; `status`, `validation`, `duplicates` |

**Ez a legfontosabb szerkezeti garancia:** a generált kérdés fizikailag más
táblában van, mint a játékban használt. A production táblába csak az
`approve_candidate()` függvény ír, ami moderátori szerepkört követel.

---

## 2. Nézetek

| Nézet | Mire jó |
|---|---|
| `questions_public` | kliensnek szánt kérdésnézet – **nincs benne `correct_answer` és `explanation`** |
| `categories_public` | aktív kategóriák |
| `category_stats` | kategóriánkénti kérdésszám nehézség szerint |

A `questions_public` szándékosan `security_invoker = false`, azaz a nézet
tulajdonosának jogaival fut. Ez itt nem hiba, hanem a lényeg: a hívónak **nincs**
joga a `questions` táblához, mégis lát kérdést – csak a helyes válasz nélkül.

---

## 3. RPC-k (a tényleges API)

### Játékmenet

| RPC | Paraméterek | Visszatér | Jogosultság |
|---|---|---|---|
| `active_scoring_rules()` | – | pontozási szabály JSON | anon |
| `start_session(mode, room_id, client_version)` | – | `session_id`, `scoring` | bejelentkezett |
| `next_question(session, category_slug, difficulty, history_days)` | – | kérdés **helyes válasz nélkül**, `position`, `max_questions` | saját session |
| `submit_answer(session, question, answer, answer_ms)` | – | `is_correct`, `correct_answer`, `explanation`, `awarded_points`, `banked_score`, `can_continue` | saját session |
| `finalize_session(session)` | – | végpontszám, eredmény azonosító | saját session |
| `submit_offline_result(score, questions, correct, busted, played_at, client_id)` | – | `result_id`, `duplicate` | bejelentkezett |
| `offline_pack(per_category, since)` | – | kategóriák + kérdések **helyes válasszal** | anon |

Amit ez a felület garantál:

- **A helyes válasz csak a beküldés után derül ki.** A `next_question` a
  `questions_public` nézetből olvas.
- **A pontszámot a szerver számolja.** A `submit_answer` a `scoring_rules`
  táblából veszi a jutalmat, és a `game_sessions.banked_score`-t frissíti.
- **Egy kérdésre egyszer lehet válaszolni.** A `session_questions.answered_at`
  ellenőrzése `unique_violation`-t dob ismételt beküldésnél.
- **A `next_question` idempotens.** Ha van megválaszolatlan kiszolgált kérdés,
  azt adja vissza – hálózati újrapróbálkozás vagy app-újraindítás nem „ égeti
  el ” a kérdést.
- Az `offline_pack` szükségszerűen kiadja a helyes választ (offline enélkül nem
  lehet értékelni), ezért az offline kör eredménye `is_trusted = false`, és a
  globális ranglistára nem kerül.

### Kérdéskiválasztás súlyozása

A `next_question` A-Res súlyozott mintavétellel választ (`random()^(1/w)`
maximum). A súly:

```
w = kitettség        (1 / (1 + times_answered/400))
  × nehézség-illesztés (1.0 egyezésnél, 0.15 egyébként)
  × minőség          (0.1, ha ≥3 bejelentés)
  × degeneráltság    (0.35, ha ≥25 válasznál a találati arány >97% vagy <12%)
```

Kizárás: a sessionben már feltett kérdések, és amit a játékos az elmúlt 60
napban látott. Ha ettől kiürül a merítés, a történet-szűrő elesik – jobb
ismételni, mint játszhatatlan kategóriát adni.

### Statisztika és ranglista

| RPC | Mit ad |
|---|---|
| `leaderboard(scope, limit)` | `all_time` / `month` / `week` / `day` rangsor; **csak `is_trusted` eredmények** |
| `my_rank(scope)` | a hívó helye a top 200-ban |
| `my_stats()` | profil + kategóriabontás + legutóbbi körök |
| `attributions()` | licenc-megkötéses források összesítése (CC BY-SA feltüntetéshez) |
| `report_question(question, reason)` | hibás kérdés jelzése |

### Multiplayer

| RPC | Mit tesz |
|---|---|
| `create_room(max_players, rounds, difficulty, questions_per_category, answer_seconds)` | szoba + 6 karakteres kód |
| `join_room(code)` | csatlakozás, szék kiosztása, visszatérő játékos kezelése |
| `set_ready(room, ready)` | készenlét |
| `start_room(room)` | indítás – csak host, min. 2 játékos |
| **`room_tick(room)`** | **a játékot hajtó RPC**: lezárás, kiesés, továbblépés, majd a teljes állapot |
| `answer_room_question(room, room_question, answer, ms)` | válasz beküldése – nem adja vissza, hogy jó volt-e |
| `room_state(room)` | teljes szobaállapot, léptetés nélkül (váróhoz, olvasáshoz) |
| `leave_room(room)` | kilépés, host-átadás |

#### A `room_tick()` és a kieséses menet

A kliensek játék közben ezt az egy RPC-t pollozzák. Mindent elvégez, amit a
szoba állapota megkíván, majd visszaadja a teljes állapotot:

```json
{
  "status": "playing",
  "block_no": 2,
  "rounds_per_player": 3,
  "answer_seconds": 20,
  "reveal_seconds": 5,
  "server_time": "2026-09-01T19:40:12.482Z",
  "current_question": {
    "id": "…",
    "question_text": "Melyik évben volt a mohácsi csata?",
    "answers": ["1514", "1526", "1541", "1552"],
    "difficulty": "easy",
    "category_slug": "magyar-tortenelem",
    "ordinal": 3,
    "max_questions": 10,
    "reward": 1000,
    "answer_open_at": "2026-09-01T19:40:10.000Z",
    "deadline_at": "2026-09-01T19:40:30.000Z",
    "resolved": false,
    "my_answer": null,
    "i_answered": false,
    "answered_count": 2,
    "alive_count": 4,
    "correct_answer": null,
    "explanation": null,
    "results": null
  },
  "last_block_scores": [ … ],
  "players": [
    { "player_id": "…", "nickname": "Anna", "seat": 1,
      "score": 3000, "block_score": 1000, "is_eliminated": false, "has_left": false }
  ]
}
```

**Miért egyetlen RPC?** Mert a léptetéshez írni kell (lezárás, kiesés, új
kérdés), az állapot olvasásához pedig ugyanazokat a sorokat kell látni. Külön
hívásokból versenyhelyzet lenne. A tick `for update` zárral dolgozik és
idempotens: mindegy, hogy négy kliens hívja egyszerre, a lezárás és a
továbbléptetés pontosan egyszer történik meg.

A `room_state()` ugyanezt a szerkezetet adja vissza, de `stable` és nem léptet –
a váróban és olvasáshoz ezt használjuk.

#### Amit lezárás előtt nem küld el

A `correct_answer`, az `explanation` és a `results` **addig `null`, amíg a kérdés
le nem zárult** – annak is, aki már válaszolt:

```sql
'correct_answer', case when v_rq.resolved_at is not null then q.correct_answer end,
'explanation',    case when v_rq.resolved_at is not null then q.explanation end,
'results',        case when v_rq.resolved_at is not null then ( … ) end
```

Két csalást zár ki:

1. **Megsúgás** – aki elsőként válaszol, nem tudja bekiabálni a helyes választ a
   még gondolkodóknak.
2. **Többség-leolvasás** – a `results` sem jön ki előre, tehát abból sem lehet
   visszafejteni, mit tippeltek a többiek.

Ezért nem adja vissza az `answer_room_question()` sem, hogy jó volt-e a válasz:
csak `{"accepted": true}`. Az eredmény a következő tickből jön, mindenkinek
egyszerre.

A kliens nem kerülheti meg: a `questions`, `room_questions` és `room_answers`
táblákhoz nincs olvasási joga, a kérdést csak ezek a `security definer`
függvények adhatják ki. Ezt a `tools/src/db-test.mjs` külön ellenőrzi, kliens
szerepben futtatva (superuserként az RLS nem érvényesülne, és a teszt hamis
zöldet adna).

#### Három fázis, két időbélyeg

| Fázis | Feltétel | Válaszolhat? |
|---|---|---|
| pörgetés | `now() < answer_open_at` | nem – „Még pörög a kerék” |
| válasz | `answer_open_at ≤ now() ≤ deadline_at` | igen, egyszer |
| kiértékelés | `resolved_at is not null` | nem – „Ez a kérdés már lezárult” |

A pörgetés külön időablakot kap (`rooms.spin_seconds`, alapból 3 s), mert
különben a kerék animációja elvenne a válaszidőből – annak viszont mindenkinél
ugyanannyinak kell lennie. Pörgetés csak kategóriaváltásnál van; ha a
`questions_per_category` miatt marad a kategória, `spin = 0`.

A határidők szerveridőben jönnek, ezért az állapot `server_time`-ot is ad: a
kliens ebből számol óraeltolást, és azzal értelmezi a visszaszámlálót.

#### Kiesés és körök

- Rossz válasz **vagy** lejárt idő → `room_players.is_eliminated = true`. A már
  megszerzett `block_score` megmarad, de többet nem gyűjthet ebben a körben.
- A kör véget ér, ha `ordinal = max_questions` (10), vagy mindenki kiesett.
- Ekkor `score += block_score`, a `block_score` nullázódik, és **mindenki
  visszatér a játékba** a következő körre. Az előző kör eredménye a
  `last_block_scores` mezőben marad meg a felület számára.
- A `rounds_per_player` körök után a szoba `finished`, és minden játékosnak
  bekerül egy `game_results` sor (`mode = 'multiplayer'`, `is_trusted = true`),
  tehát a szobás pont beszámít a ranglistába.

Egy kérdés egy szobában csak egyszer jöhet elő – ezt a
`room_questions (room_id, question_id)` unique index garantálja, nem csak a
kiválasztó lekérdezés.

A szobakód olyan ábécéből generálódik, amiben nincs `I`, `O`, `S`, `0`, `1`, `5`
– ezeket szóban és írásban gyakran összekeverik.

### Moderátori / admin

| RPC | Jogosultság |
|---|---|
| `check_question_duplicates(category_slug, question_text, answers, source, threshold, limit)` | moderátor |
| `approve_candidate(candidate, note, force)` | moderátor |
| `reject_candidate(candidate, note)` | moderátor |
| `approve_clean_candidates(batch, limit)` | moderátor |
| `review_queue(status, category, limit, offset)` | moderátor |

---

## 4. Duplikátum-ellenőrzés

A `check_question_duplicates()` négy szinten keres, és prioritás szerint
rendezve adja vissza a találatokat:

| Szint | Mit vizsgál | Küszöb |
|---|---|---|
| `exact` | normalizált kérdésszöveg egyezése kategórián belül | pontos |
| `same_answers` | azonos válaszhalmaz-hash + szöveghasonlóság | trigram ≥ 0.45 |
| `same_fact` | azonos `source` entitás + a helyes válasz szerepel a jelölt válaszai közt | – |
| `similar_text` | trigram hasonlóság | ≥ 0.72 (állítható) |

A `approve_candidate()` a jóváhagyás pillanatában **újra lefuttatja** ezt: ha
`exact` vagy `same_answers` találat van, a jelölt `flagged` lesz és nem kerül be
– kivéve, ha a moderátor kifejezetten `p_force := true`-val hagyja jóvá.

---

## 5. Row Level Security

Alapelv: a kliens role-oknak (`anon`, `authenticated`) **minden tábla-jog
visszavonva**, majd célzottan visszaadva. Kivonat:

```sql
revoke all on all tables in schema public from anon, authenticated;

grant select on public.questions_public  to anon, authenticated;   -- válasz nélkül
grant select on public.game_sessions     to authenticated;         -- RLS: csak a sajátja
grant update (nickname, avatar_id, country) on public.profiles to authenticated;
```

A `profiles` mezőszintű GRANT-ja azért fontos, mert így a `role` oszlop
**egyszerűen nem írható** a kliensről – nem lehet magát adminra emelni. Emellett
az RLS `with check` is ellenőrzi, hogy a `role` változatlan marad.

Játéktáblákba a kliens **egyáltalán nem ír**: minden írás `SECURITY DEFINER`
függvényen megy, ami előbb ellenőrzi, hogy a session a hívóé.

---

## 6. Miért nincs külön REST endpoint-készlet?

A specifikáció `GET /categories`, `POST /game/session` stb. végpontokat
javasolt. A megvalósítás ezeket PostgREST-en és RPC-ken adja:

| Specifikáció | Megvalósítás |
|---|---|
| `GET /categories` | `GET /rest/v1/categories_public` |
| `GET /questions/random?category=…&difficulty=…` | `POST /rest/v1/rpc/next_question` |
| `POST /game/session` | `POST /rest/v1/rpc/start_session` |
| `POST /game/result` | `rpc/finalize_session` (online) vagy `rpc/submit_offline_result` |
| `GET /profile` | `GET /rest/v1/profiles?id=eq.…` |
| `GET /leaderboard` | `POST /rest/v1/rpc/leaderboard` |
| `GET /stats` | `POST /rest/v1/rpc/my_stats` |
| `POST/PUT/DELETE /admin/questions` | `POST/PATCH/DELETE /rest/v1/questions` + RLS |

Miért így jobb:

- **A `random` kérdéskiszolgálás nem lehet GET.** Állapotot ír
  (`session_questions`, `player_question_history`), és a session-en belüli
  ismétlésmentességet csak így lehet garantálni.
- **Egy körutazás elég.** A `submit_answer` egyszerre validál, pontoz,
  statisztikát ír és visszaadja a magyarázatot.
- **Nincs külön szerver.** Nincs Node backend, amit üzemeltetni és skálázni
  kell; a logika ott van, ahol az adat.
