-- 0011 – kieséses (egyidejű) multiplayer
--
-- ÚJ JÁTÉKMENET, ami leváltja a korábbi váltakozó (turn-based) módot:
--
--   * A kerék kategóriát választ – ugyanazt MINDENKINEK.
--   * A szoba összes még játékban lévő tagja UGYANARRA a kérdésre válaszol.
--   * Aki hibázik (vagy nem válaszol időben), az KIESIK a körből, és nézővé
--     válik. A megszerzett pontjait megtartja.
--   * A kör addig megy, amíg vagy elfogy a 10 kérdés, vagy mindenki kiesik.
--   * Ekkor a körben gyűjtött pontok bekerülnek az összesített pontszámba, és
--     jön a következő kör (új kategóriával).
--
-- Két fontos tervezési döntés:
--
--   1. A HELYES VÁLASZ SENKINEK NEM DERÜL KI, amíg a kérdés nem zárult le
--      (mindenki válaszolt vagy lejárt az idő). Így egy gyorsan válaszoló
--      játékos nem tudja megsúgni a többieknek. A `answer_room_question` ezért
--      nem is adja vissza, hogy jó volt-e a válasz.
--
--   2. A játékot egyetlen `room_tick()` RPC hajtja, amit a kliensek pollozzák.
--      Idempotens és zárolt, ezért mindegy, hányan hívják egyszerre: a kérdés
--      lezárása és a továbbléptetés pontosan egyszer történik meg.

-- ─────────────── a régi váltakozó mód eltávolítása ───────────────

drop function if exists public.begin_turn(uuid);
drop function if exists public.end_turn(uuid, uuid);
drop function if exists public.advance_room_turn(uuid);
drop table if exists public.room_rounds;

-- ─────────────────────── séma-kiegészítések ───────────────────────

alter table public.rooms
  add column if not exists block_no smallint not null default 0,
  -- Hány kérdés jön egy kategóriából, mielőtt újra pörgetünk.
  -- 1 = minden kérdés előtt új pörgetés; 10 = egy kategória egy teljes körön át.
  add column if not exists questions_per_category smallint not null default 1,
  -- Mennyi idő van válaszolni. Egyidejű módban ez nem opcionális: különben egy
  -- lassú játékos megállítaná az egész szobát.
  add column if not exists answer_seconds smallint not null default 20,
  -- Mennyi ideig látszik a helyes válasz, mielőtt jön a következő kérdés.
  add column if not exists reveal_seconds smallint not null default 5,
  -- Amíg a kerék pörög, még nem lehet válaszolni. Így a válaszidő mindenkinek
  -- ugyanannyi, függetlenül attól, hogy nála mennyi ideig tart az animáció.
  add column if not exists spin_seconds smallint not null default 3,
  -- Az előző kör eredménye, hogy a felület ki tudja írni.
  add column if not exists last_block_scores jsonb,
  add column if not exists last_block_ended_at timestamptz;

do $$ begin
  alter table public.rooms
    add constraint rooms_questions_per_category
    check (questions_per_category between 1 and 10);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.rooms
    add constraint rooms_answer_seconds
    check (answer_seconds between 5 and 120);
exception when duplicate_object then null; end $$;

alter table public.room_players
  -- Kiesett-e az AKTUÁLIS körben (körönként nullázódik).
  add column if not exists is_eliminated boolean not null default false,
  -- Az aktuális körben gyűjtött pont (a kör végén adódik a `score`-hoz).
  add column if not exists block_score integer not null default 0;

-- A szobában feltett kérdések. Egyben napló és „ne jöjjön kétszer” garancia.
create table if not exists public.room_questions (
  id           uuid primary key default extensions.gen_random_uuid(),
  room_id      uuid not null references public.rooms (id) on delete cascade,
  block_no     smallint not null,
  ordinal      smallint not null,
  question_id  uuid not null references public.questions (id) on delete restrict,
  category_id  uuid not null references public.categories (id) on delete restrict,
  started_at      timestamptz not null default now(),
  -- Amíg ez nem jött el, a kerék pörög és a válaszok zárva vannak.
  answer_open_at  timestamptz not null,
  deadline_at     timestamptz not null,
  resolved_at  timestamptz,
  unique (room_id, block_no, ordinal),
  -- Egy kérdés egy szobában csak egyszer jöhet elő.
  unique (room_id, question_id)
);

create index if not exists room_questions_room_idx
  on public.room_questions (room_id, block_no, ordinal desc);

-- Ki mit válaszolt. A `selected_answer is null` azt jelenti: nem válaszolt időben.
create table if not exists public.room_answers (
  room_question_id uuid not null references public.room_questions (id) on delete cascade,
  player_id        uuid not null references public.profiles (id) on delete cascade,
  selected_answer  smallint,
  is_correct       boolean not null,
  answer_ms        integer,
  awarded_points   integer not null default 0,
  answered_at      timestamptz not null default now(),
  primary key (room_question_id, player_id),
  constraint room_answers_range check (selected_answer is null or selected_answer between 0 and 3)
);

alter table public.room_questions enable row level security;
alter table public.room_answers   enable row level security;

-- Szándékosan NINCS select policy és NINCS grant ezekre a táblákra: a kliens
-- mindent a `room_tick()` / `room_state()` függvényen keresztül kap meg, ami
-- eldönti, mit szabad látni (pl. a helyes választ csak lezárás után).

-- ─────────────────────── szobalétrehozás ───────────────────────

create or replace function public.create_room(
  p_max_players            smallint default 4,
  p_rounds_per_player      smallint default 1,
  p_difficulty             text default null,
  p_questions_per_category smallint default 1,
  p_answer_seconds         smallint default 20
)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_player  uuid := auth.uid();
  v_version integer;
  v_room    public.rooms;
begin
  if v_player is null then
    raise exception 'Bejelentkezés szükséges' using errcode = '42501';
  end if;

  -- Egy játékos egyszerre egy nyitott szobát vezethet
  update public.rooms set status = 'cancelled', finished_at = now()
  where host_id = v_player and status = 'lobby';

  select version into v_version from public.scoring_rules where is_active limit 1;

  insert into public.rooms (
    code, host_id, max_players, rounds_per_player, difficulty, scoring_version,
    questions_per_category, answer_seconds
  )
  values (
    public.generate_room_code(), v_player,
    least(greatest(coalesce(p_max_players, 4), 2), 5),
    least(greatest(coalesce(p_rounds_per_player, 1), 1), 5),
    nullif(p_difficulty, '')::public.difficulty,
    v_version,
    least(greatest(coalesce(p_questions_per_category, 1), 1), 10),
    least(greatest(coalesce(p_answer_seconds, 20), 5), 120)
  )
  returning * into v_room;

  insert into public.room_players (room_id, player_id, seat, is_ready)
  values (v_room.id, v_player, 1, true);

  return public.room_state(v_room.id);
end
$$;

-- ─────────────────────── szoba indítása ───────────────────────

create or replace function public.start_room(p_room uuid)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_room  public.rooms;
  v_count integer;
begin
  select * into v_room from public.rooms where id = p_room for update;
  if v_room.id is null then
    raise exception 'Nincs ilyen szoba' using errcode = 'no_data_found';
  end if;
  if v_room.host_id <> auth.uid() then
    raise exception 'Csak a szoba létrehozója indíthatja el' using errcode = '42501';
  end if;
  if v_room.status <> 'lobby' then
    raise exception 'A szoba már nem várakozó állapotban van' using errcode = 'check_violation';
  end if;

  select count(*) into v_count
  from public.room_players where room_id = p_room and left_at is null;

  if v_count < 2 then
    raise exception 'Legalább két játékos kell az indításhoz' using errcode = 'check_violation';
  end if;

  -- Tiszta lap: senki nem kiesett, a köri pont nulla.
  update public.room_players
  set is_eliminated = false, block_score = 0
  where room_id = p_room;

  update public.rooms
  set status = 'playing',
      started_at = now(),
      block_no = 1,
      current_round = 1,
      current_seat = null,       -- egyidejű módban nincs „soron lévő” játékos
      expires_at = now() + interval '3 hours'
  where id = p_room;

  -- Az első kérdést a következő tick hozza létre.
  return public.room_tick(p_room);
end
$$;

-- ─────────────────── válasz beküldése ───────────────────

create or replace function public.answer_room_question(
  p_room      uuid,
  p_question  uuid,     -- room_questions.id
  p_answer    smallint,
  p_answer_ms integer default null
)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_player  uuid := auth.uid();
  v_rq      public.room_questions;
  v_correct smallint;
  v_ok      boolean;
  v_award   integer := 0;
  v_rules   public.scoring_rules;
  v_room    public.rooms;
begin
  if v_player is null then
    raise exception 'Bejelentkezés szükséges' using errcode = '42501';
  end if;
  if p_answer is null or p_answer < 0 or p_answer > 3 then
    raise exception 'Érvénytelen válaszindex' using errcode = 'check_violation';
  end if;

  select * into v_rq from public.room_questions
  where id = p_question and room_id = p_room
  for update;

  if v_rq.id is null then
    raise exception 'Nincs ilyen kérdés ebben a szobában' using errcode = 'no_data_found';
  end if;
  if v_rq.resolved_at is not null then
    raise exception 'Ez a kérdés már lezárult' using errcode = 'check_violation';
  end if;
  if now() < v_rq.answer_open_at then
    raise exception 'Még pörög a kerék' using errcode = 'check_violation';
  end if;
  -- Fél másodperc ráhagyás a hálózati késésre.
  if now() > v_rq.deadline_at + interval '500 milliseconds' then
    raise exception 'Lejárt az idő' using errcode = 'check_violation';
  end if;

  -- Csak játékban lévő tag válaszolhat.
  if not exists (
    select 1 from public.room_players
    where room_id = p_room and player_id = v_player
      and left_at is null and not is_eliminated
  ) then
    raise exception 'Nem vagy játékban ebben a körben' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.room_answers
    where room_question_id = v_rq.id and player_id = v_player
  ) then
    raise exception 'Erre a kérdésre már válaszoltál' using errcode = 'unique_violation';
  end if;

  select * into v_room from public.rooms where id = p_room;
  select * into v_rules from public.scoring_rules where version = v_room.scoring_version;
  select correct_answer into v_correct from public.questions where id = v_rq.question_id;

  v_ok := (p_answer = v_correct);
  if v_ok then
    v_award := v_rules.reward_table[v_rq.ordinal];
  end if;

  insert into public.room_answers
    (room_question_id, player_id, selected_answer, is_correct, answer_ms, awarded_points)
  values (v_rq.id, v_player, p_answer, v_ok, p_answer_ms, v_award);

  if v_ok then
    update public.room_players
    set block_score = block_score + v_award
    where room_id = p_room and player_id = v_player;
  end if;

  update public.question_stats
  set times_answered = times_answered + 1,
      times_correct = times_correct + case when v_ok then 1 else 0 end,
      total_answer_ms = total_answer_ms + greatest(0, coalesce(p_answer_ms, 0)),
      last_answered_at = now()
  where question_id = v_rq.question_id;

  -- SZÁNDÉKOSAN nem adjuk vissza, hogy jó volt-e: amíg a kérdés nem zárult le,
  -- senki nem tudhatja a helyes választ (különben megsúghatná a többieknek).
  return json_build_object('accepted', true, 'question_id', v_rq.id);
end
$$;

-- ─────────────── a játékot hajtó tick ───────────────

create or replace function public.room_tick(p_room uuid)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_room       public.rooms;
  v_rules      public.scoring_rules;
  v_rq         public.room_questions;
  v_alive      integer;
  v_answered   integer;
  v_next_ord   smallint;
  v_category   uuid;
  v_question   uuid;
  v_recent     uuid[];
  v_scores     jsonb;
  v_spin       integer;
begin
  select * into v_room from public.rooms where id = p_room for update;
  if v_room.id is null then
    raise exception 'Nincs ilyen szoba' using errcode = 'no_data_found';
  end if;

  -- Csak tag (vagy admin) hívhatja
  if not exists (
    select 1 from public.room_players where room_id = p_room and player_id = auth.uid()
  ) and not public.is_admin() then
    raise exception 'Nem vagy a szoba tagja' using errcode = '42501';
  end if;

  if v_room.status <> 'playing' then
    return public.room_state(p_room);
  end if;

  select * into v_rules from public.scoring_rules where version = v_room.scoring_version;

  -- Lejárt szoba: ne lógjon örökre
  if v_room.expires_at < now() then
    update public.rooms set status = 'cancelled', finished_at = now() where id = p_room;
    return public.room_state(p_room);
  end if;

  -- ── 1. Az aktuális kérdés lezárása, ha esedékes ──
  select * into v_rq from public.room_questions
  where room_id = p_room and block_no = v_room.block_no
  order by ordinal desc
  limit 1;

  if v_rq.id is not null and v_rq.resolved_at is null then
    select count(*) into v_alive
    from public.room_players
    where room_id = p_room and left_at is null and not is_eliminated;

    select count(*) into v_answered
    from public.room_answers where room_question_id = v_rq.id;

    if v_answered >= v_alive or now() > v_rq.deadline_at then
      -- Aki nem válaszolt időben, azt „nem válaszolt” sorral pótoljuk.
      insert into public.room_answers
        (room_question_id, player_id, selected_answer, is_correct, awarded_points)
      select v_rq.id, rp.player_id, null, false, 0
      from public.room_players rp
      where rp.room_id = p_room and rp.left_at is null and not rp.is_eliminated
        and not exists (
          select 1 from public.room_answers ra
          where ra.room_question_id = v_rq.id and ra.player_id = rp.player_id
        )
      on conflict do nothing;

      -- Kiesések
      update public.room_players rp
      set is_eliminated = true
      from public.room_answers ra
      where ra.room_question_id = v_rq.id
        and ra.player_id = rp.player_id
        and rp.room_id = p_room
        and not ra.is_correct
        and not rp.is_eliminated;

      update public.room_questions set resolved_at = now() where id = v_rq.id;
      select * into v_rq from public.room_questions where id = v_rq.id;
    end if;
  end if;

  -- ── 2. Továbblépés: új kérdés, kör vége vagy játék vége ──
  if v_rq.id is null
     or (v_rq.resolved_at is not null
         and now() >= v_rq.resolved_at + make_interval(secs => v_room.reveal_seconds)) then

    select count(*) into v_alive
    from public.room_players
    where room_id = p_room and left_at is null and not is_eliminated;

    if v_rq.id is not null and (v_alive = 0 or v_rq.ordinal >= v_rules.max_questions) then
      -- ── kör vége ──
      select jsonb_agg(jsonb_build_object(
               'player_id', rp.player_id,
               'nickname', p.nickname,
               'block_score', rp.block_score,
               'survived', not rp.is_eliminated
             ))
      into v_scores
      from public.room_players rp
      join public.profiles p on p.id = rp.player_id
      where rp.room_id = p_room and rp.left_at is null;

      update public.room_players
      set score = score + block_score,
          block_score = 0,
          is_eliminated = false
      where room_id = p_room;

      if v_room.block_no >= v_room.rounds_per_player then
        -- ── játék vége: eredmények rögzítése a ranglistához ──
        update public.rooms
        set status = 'finished',
            finished_at = now(),
            last_block_scores = v_scores,
            last_block_ended_at = now()
        where id = p_room;

        insert into public.game_results
          (player_id, session_id, mode, score, questions, correct, busted, is_trusted)
        select
          rp.player_id,
          null::uuid,
          'multiplayer'::public.game_mode,
          rp.score,
          coalesce(stats.answered, 0)::smallint,
          coalesce(stats.correct, 0)::smallint,
          false,
          true
        from public.room_players rp
        left join (
          select ra.player_id,
                 count(*) as answered,
                 count(*) filter (where ra.is_correct) as correct
          from public.room_answers ra
          join public.room_questions rq on rq.id = ra.room_question_id
          where rq.room_id = p_room
          group by ra.player_id
        ) stats on stats.player_id = rp.player_id
        where rp.room_id = p_room and rp.left_at is null;
      else
        update public.rooms
        set block_no = block_no + 1,
            current_round = block_no + 1,
            last_block_scores = v_scores,
            last_block_ended_at = now()
        where id = p_room;
      end if;

      return public.room_state(p_room);
    end if;

    -- ── új kérdés ──
    v_next_ord := coalesce(v_rq.ordinal, 0) + 1;

    -- Ugyanaz a kategória marad, amíg a `questions_per_category` engedi.
    if v_rq.id is not null and ((v_next_ord - 1) % v_room.questions_per_category) <> 0 then
      v_category := v_rq.category_id;
    else
      -- Az utóbbi három kategóriát kerüljük, hogy ne érződjön beragadtnak a kerék.
      select array_agg(t.category_id) into v_recent
      from (
        select category_id from public.room_questions
        where room_id = p_room
        order by started_at desc
        limit 3
      ) t;

      select c.id into v_category
      from public.categories c
      where c.is_active
        and (v_recent is null or not (c.id = any (v_recent)))
        and exists (
          select 1 from public.questions q
          where q.category_id = c.id and q.is_active and q.language = 'hu'
            and q.pack_id is null
            and (v_room.difficulty is null or q.difficulty = v_room.difficulty)
            and not exists (
              select 1 from public.room_questions rq
              where rq.room_id = p_room and rq.question_id = q.id
            )
        )
      order by random()
      limit 1;

      -- Ha a „kerüljük a legutóbbiakat” szűrő kiürítette a merítést, elengedjük.
      if v_category is null then
        select c.id into v_category
        from public.categories c
        where c.is_active
          and exists (
            select 1 from public.questions q
            where q.category_id = c.id and q.is_active and q.language = 'hu'
              and q.pack_id is null
              and not exists (
                select 1 from public.room_questions rq
                where rq.room_id = p_room and rq.question_id = q.id
              )
          )
        order by random()
        limit 1;
      end if;
    end if;

    if v_category is null then
      -- Nincs több kiszolgálható kérdés: lezárjuk a játékot.
      update public.rooms set status = 'finished', finished_at = now() where id = p_room;
      return public.room_state(p_room);
    end if;

    -- Kérdésválasztás a kategóriából: a kevésbé „elhasznált” kérdés előnyben.
    select q.id into v_question
    from public.questions q
    left join public.question_stats s on s.question_id = q.id
    where q.category_id = v_category
      and q.is_active and q.language = 'hu' and q.pack_id is null
      and (v_room.difficulty is null or q.difficulty = v_room.difficulty)
      and not exists (
        select 1 from public.room_questions rq
        where rq.room_id = p_room and rq.question_id = q.id
      )
    order by power(
      random(),
      1.0 / greatest(0.05, 1.0 / (1.0 + coalesce(s.times_answered, 0) / 400.0))
    ) desc
    limit 1;

    if v_question is null then
      update public.rooms set status = 'finished', finished_at = now() where id = p_room;
      return public.room_state(p_room);
    end if;

    -- Idempotencia: ha két kliens egyszerre tickel, a unique index dönt.
    -- Pörgetés csak akkor, ha tényleg kategóriát váltunk.
    v_spin := case when v_category is distinct from v_rq.category_id
                   then v_room.spin_seconds else 0 end;

    insert into public.room_questions
      (room_id, block_no, ordinal, question_id, category_id, answer_open_at, deadline_at)
    values (
      p_room, v_room.block_no, v_next_ord, v_question, v_category,
      now() + make_interval(secs => v_spin),
      now() + make_interval(secs => v_spin + v_room.answer_seconds)
    )
    on conflict do nothing;
  end if;

  return public.room_state(p_room);
end
$$;

-- ─────────────── teljes szobaállapot ───────────────

create or replace function public.room_state(p_room uuid)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_room     public.rooms;
  v_rules    public.scoring_rules;
  v_rq       public.room_questions;
  v_current  json := null;
  v_me       uuid := auth.uid();
begin
  select * into v_room from public.rooms where id = p_room;
  if v_room.id is null then
    raise exception 'Nincs ilyen szoba' using errcode = 'no_data_found';
  end if;

  if not exists (
    select 1 from public.room_players where room_id = p_room and player_id = v_me
  ) and not public.is_admin() then
    raise exception 'Nem vagy a szoba tagja' using errcode = '42501';
  end if;

  select * into v_rules from public.scoring_rules where version = v_room.scoring_version;

  if v_room.status = 'playing' then
    select * into v_rq from public.room_questions
    where room_id = p_room and block_no = v_room.block_no
    order by ordinal desc
    limit 1;
  end if;

  if v_rq.id is not null then
    select json_build_object(
      'id',             v_rq.id,
      'question_text',  qp.question_text,
      'answers',        qp.answers,
      'difficulty',     qp.difficulty,
      'category_slug',  qp.category_slug,
      'ordinal',        v_rq.ordinal,
      'max_questions',  v_rules.max_questions,
      'reward',         v_rules.reward_table[v_rq.ordinal],
      'answer_open_at', v_rq.answer_open_at,
      'deadline_at',    v_rq.deadline_at,
      'resolved',       v_rq.resolved_at is not null,
      'resolved_at',    v_rq.resolved_at,
      -- A saját válaszom mindig látszik; a többiek válasza csak lezárás után.
      'my_answer', (
        select ra.selected_answer from public.room_answers ra
        where ra.room_question_id = v_rq.id and ra.player_id = v_me
      ),
      'i_answered', exists (
        select 1 from public.room_answers ra
        where ra.room_question_id = v_rq.id and ra.player_id = v_me
      ),
      'answered_count', (
        select count(*) from public.room_answers ra where ra.room_question_id = v_rq.id
      ),
      'alive_count', (
        select count(*) from public.room_players rp
        where rp.room_id = p_room and rp.left_at is null and not rp.is_eliminated
      ),
      -- CSAK lezárás után:
      'correct_answer', case when v_rq.resolved_at is not null then q.correct_answer end,
      'explanation',    case when v_rq.resolved_at is not null then q.explanation end,
      'results', case when v_rq.resolved_at is not null then (
        select coalesce(json_agg(json_build_object(
                 'player_id', ra.player_id,
                 'selected_answer', ra.selected_answer,
                 'is_correct', ra.is_correct,
                 'awarded_points', ra.awarded_points
               )), '[]'::json)
        from public.room_answers ra where ra.room_question_id = v_rq.id
      ) end
    )
    into v_current
    from public.questions_public qp
    join public.questions q on q.id = qp.id
    where qp.id = v_rq.question_id;
  end if;

  return json_build_object(
    'id', v_room.id,
    'code', v_room.code,
    'host_id', v_room.host_id,
    'status', v_room.status,
    'max_players', v_room.max_players,
    'rounds_per_player', v_room.rounds_per_player,
    'difficulty', v_room.difficulty,
    'block_no', v_room.block_no,
    'questions_per_category', v_room.questions_per_category,
    'answer_seconds', v_room.answer_seconds,
    'reveal_seconds', v_room.reveal_seconds,
    'max_questions', v_rules.max_questions,
    'server_time', now(),
    'current_question', v_current,
    'last_block_scores', v_room.last_block_scores,
    'last_block_ended_at', v_room.last_block_ended_at,
    'players', (
      select coalesce(json_agg(row_to_json(t) order by t.seat), '[]'::json)
      from (
        select rp.player_id, rp.seat, rp.score, rp.block_score, rp.is_ready,
               rp.is_eliminated, (rp.left_at is not null) as has_left,
               p.nickname, p.avatar_id
        from public.room_players rp
        join public.profiles p on p.id = rp.player_id
        where rp.room_id = p_room
      ) t
    )
  );
end
$$;

comment on function public.room_tick(uuid) is
  'A kieséses multiplayer motorja: lezárja az esedékes kérdést, kiesteti a hibázókat, továbblép, és visszaadja a teljes szobaállapotot. Idempotens, ezért több kliens is hívhatja egyszerre.';

-- ─────────────── kilépés (a kör továbbvitele nélkül) ───────────────

create or replace function public.leave_room(p_room uuid)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_player    uuid := auth.uid();
  v_room      public.rooms;
  v_remaining integer;
begin
  update public.room_players
  set left_at = now(), is_connected = false, is_ready = false, is_eliminated = true
  where room_id = p_room and player_id = v_player and left_at is null;

  select * into v_room from public.rooms where id = p_room for update;
  if v_room.id is null then
    return json_build_object('left', true);
  end if;

  select count(*) into v_remaining
  from public.room_players where room_id = p_room and left_at is null;

  if v_remaining = 0 then
    update public.rooms set status = 'cancelled', finished_at = now() where id = p_room;
  elsif v_room.host_id = v_player then
    -- Új host: a legkisebb szabad szék
    update public.rooms r
    set host_id = (
      select rp.player_id from public.room_players rp
      where rp.room_id = p_room and rp.left_at is null
      order by rp.seat limit 1
    )
    where r.id = p_room;
  end if;

  return json_build_object('left', true);
end
$$;

-- ─────────────────────── jogosultságok ───────────────────────

revoke all on public.room_questions from anon, authenticated;
revoke all on public.room_answers   from anon, authenticated;

grant execute on function public.create_room(smallint, smallint, text, smallint, smallint) to authenticated;
grant execute on function public.room_tick(uuid) to authenticated;
grant execute on function public.answer_room_question(uuid, uuid, smallint, integer) to authenticated;
grant execute on function public.room_state(uuid) to authenticated;
grant execute on function public.start_room(uuid) to authenticated;
grant execute on function public.leave_room(uuid) to authenticated;

-- A régi, 3 paraméteres create_room aláírás eltávolítása, hogy ne maradjon
-- kétértelműség (a PostgREST a paraméternevek alapján választ).
drop function if exists public.create_room(smallint, smallint, text);
