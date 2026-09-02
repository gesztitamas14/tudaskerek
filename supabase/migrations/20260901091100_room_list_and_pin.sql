-- 0012 – nyitott szobák listája + 3 jegyű PIN, és vendégjáték
--
-- Három változás:
--
--   1. NINCS TÖBB GENERÁLT SZOBAKÓD a felületen. A játékos a nyitott szobák
--      listájából választ, és egy 3 jegyű PIN-nel léphet be. A PIN-t a szoba
--      készítője adja meg.
--
--      A `rooms.code` oszlop MEGMARAD, de csak belső azonosítóként (naplók,
--      támogatás) – a felület nem mutatja, és nem lehet vele csatlakozni.
--      Azért nem töröltük, mert egyedi és stabil kapaszkodó egy szobára,
--      a 3 jegyű PIN pedig nyilvánvalóan nem egyedi.
--
--   2. A 3 jegyű PIN önmagában gyenge (1000 lehetőség), ezért a hibás
--      próbálkozásokat számoljuk és zároljuk. Enélkül a lista + PIN
--      kombináció végigpróbálható lenne.
--
--   3. VENDÉGJÁTÉK: névtelenül bejelentkezett játékos is csinálhat és
--      használhat szobát, de az eredménye NEM kerül a nyilvános ranglistára.
--      A saját statisztikája viszont megmarad.

-- ─────────── 1. Hosszabb játék: 10 kör is lehet ───────────

alter table public.rooms drop constraint if exists rooms_rounds;
alter table public.rooms
  add constraint rooms_rounds check (rounds_per_player between 1 and 10);

-- ─────────── 2. PIN ───────────

alter table public.rooms
  add column if not exists join_pin text;

do $$ begin
  alter table public.rooms
    add constraint rooms_join_pin_format check (join_pin is null or join_pin ~ '^[0-9]{3}$');
exception when duplicate_object then null; end $$;

-- Hibás PIN-próbálkozások. Játékosonként és szobánként számolunk: így egy
-- rossz tipp nem zárja ki a többieket, viszont a végigpróbálás megáll.
create table if not exists public.room_join_attempts (
  room_id          uuid not null references public.rooms (id) on delete cascade,
  player_id        uuid not null references public.profiles (id) on delete cascade,
  failures         smallint not null default 0,
  first_failure_at timestamptz not null default now(),
  last_failure_at  timestamptz not null default now(),
  primary key (room_id, player_id)
);

alter table public.room_join_attempts enable row level security;
revoke all on public.room_join_attempts from anon, authenticated;
-- Szándékosan nincs policy: csak a `join_room` (security definer) írja.

-- ─────────── 3. A ranglista nem tartalmaz vendégeket ───────────

create or replace function public.leaderboard(
  p_scope text default 'all_time',   -- all_time | month | week | day
  p_limit integer default 50
)
returns table (
  rank        bigint,
  player_id   uuid,
  nickname    text,
  avatar_id   text,
  best_score  integer,
  total_score bigint,
  games       bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_now   timestamp := now() at time zone 'UTC';
  v_week  text := to_char(v_now, 'IYYY-"W"IW');
  v_month text := to_char(v_now, 'YYYY-MM');
  v_day   date := v_now::date;
begin
  return query
  with filtered as (
    select r.player_id, r.score
    from public.game_results r
    where r.is_trusted
      and case p_scope
            when 'week'  then r.week_key = v_week
            when 'month' then r.month_key = v_month
            when 'day'   then r.day_key = v_day
            else true
          end
  ),
  agg as (
    select f.player_id,
           max(f.score)::integer as best_score,
           sum(f.score)::bigint  as total_score,
           count(*)::bigint      as games
    from filtered f
    group by f.player_id
  )
  select
    row_number() over (order by a.best_score desc, a.total_score desc, p.nickname) as rank,
    a.player_id, p.nickname, p.avatar_id, a.best_score, a.total_score, a.games
  from agg a
  join public.profiles p on p.id = a.player_id
  -- Vendég (névtelen) játékos nem kerül a nyilvános ranglistára: a neve
  -- automatikusan generált, és a fiók bármikor eldobható. A saját
  -- statisztikáját (`my_stats`) viszont továbbra is látja.
  where not p.is_anonymous
    and (p.banned_until is null or p.banned_until < now())
  order by rank
  limit v_limit;
end
$$;

comment on function public.leaderboard(text, integer) is
  'Nyilvános ranglista. Csak szerver-hitelesített (is_trusted) eredmény és nem vendég játékos kerül bele.';

-- ─────────── 4. Nyitott szobák listája ───────────

create or replace function public.list_open_rooms(p_limit integer default 30)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Bejelentkezés szükséges' using errcode = '42501';
  end if;

  return coalesce(
    (
      select json_agg(row_to_json(t) order by t.created_at desc)
      from (
        select
          r.id,
          h.nickname          as host_nickname,
          h.avatar_id         as host_avatar,
          h.is_anonymous      as host_is_guest,
          r.max_players,
          r.rounds_per_player,
          r.answer_seconds,
          r.questions_per_category,
          r.difficulty,
          r.created_at,
          -- A PIN SOHA nem kerül bele. Csak azt mondjuk meg, hogy kell-e.
          (r.join_pin is not null)                       as needs_pin,
          (select count(*) from public.room_players rp
           where rp.room_id = r.id and rp.left_at is null) as player_count,
          exists (
            select 1 from public.room_players rp
            where rp.room_id = r.id and rp.player_id = auth.uid() and rp.left_at is null
          )                                              as i_am_in
        from public.rooms r
        join public.profiles h on h.id = r.host_id
        where r.status = 'lobby'
          and r.expires_at > now()
          -- Két óránál régebbi váró szoba szinte biztosan elhagyott.
          and r.created_at > now() - interval '2 hours'
        limit least(greatest(coalesce(p_limit, 30), 1), 100)
      ) t
    ),
    '[]'::json
  );
end
$$;

comment on function public.list_open_rooms(integer) is
  'Nyitott (lobby) szobák a csatlakozáshoz. A join_pin SOHA nem kerül a válaszba – csak a needs_pin jelző.';

-- ─────────── 5. Szoba létrehozása PIN-nel ───────────

create or replace function public.create_room(
  p_max_players            smallint default 4,
  p_rounds_per_player      smallint default 10,
  p_difficulty             text default null,
  p_questions_per_category smallint default 1,
  p_answer_seconds         smallint default 15,
  p_join_pin               text default null
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
  v_pin     text := nullif(btrim(coalesce(p_join_pin, '')), '');
begin
  if v_player is null then
    raise exception 'Bejelentkezés szükséges' using errcode = '42501';
  end if;

  if v_pin is not null and v_pin !~ '^[0-9]{3}$' then
    raise exception 'A PIN pontosan 3 számjegy legyen' using errcode = 'check_violation';
  end if;

  -- Egy játékos egyszerre egy nyitott szobát vezethet
  update public.rooms set status = 'cancelled', finished_at = now()
  where host_id = v_player and status = 'lobby';

  select version into v_version from public.scoring_rules where is_active limit 1;

  insert into public.rooms (
    code, host_id, max_players, rounds_per_player, difficulty, scoring_version,
    questions_per_category, answer_seconds, join_pin
  )
  values (
    -- Belső azonosító; a felület nem mutatja, csatlakozni nem lehet vele.
    public.generate_room_code(), v_player,
    least(greatest(coalesce(p_max_players, 4), 2), 5),
    least(greatest(coalesce(p_rounds_per_player, 10), 1), 10),
    nullif(p_difficulty, '')::public.difficulty,
    v_version,
    least(greatest(coalesce(p_questions_per_category, 1), 1), 10),
    least(greatest(coalesce(p_answer_seconds, 15), 5), 120),
    v_pin
  )
  returning * into v_room;

  insert into public.room_players (room_id, player_id, seat, is_ready)
  values (v_room.id, v_player, 1, true);

  return public.room_state(v_room.id);
end
$$;

-- ─────────── 6. Csatlakozás szoba + PIN alapján ───────────

-- A régi, kódos csatlakozás megszűnik: a felület listából választ.
drop function if exists public.join_room(text);

-- FIGYELEM – MIÉRT AD EZ „BURKOLÓT” ÉS NEM DOB KIVÉTELT?
--
-- A hibás PIN-t számolni kell, különben 1000 lehetőséget végig lehet próbálni.
-- Egy `raise exception` viszont visszapörgeti az EGÉSZ tranzakciót – beleértve
-- a most beírt számláló-sort is. A PL/pgSQL-ben nincs autonóm tranzakció,
-- tehát nem lehet „írok, majd dobok”.
--
-- Ezért a függvény minden kimenetet adatként ad vissza:
--
--   siker:  { "ok": true,  "room": { …szobaállapot… } }
--   hiba:   { "ok": false, "error": "bad_pin" | "locked" | "full" |
--                                   "started" | "not_found",
--             "message": "…", "attempts_left": 3 }
--
-- Így a számláló írása véglegesül. A kliens az `ok` mezőt vizsgálja.
create or replace function public.join_room(p_room uuid, p_pin text default null)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_player   uuid := auth.uid();
  v_room     public.rooms;
  v_seat     smallint;
  v_count    integer;
  v_attempt  public.room_join_attempts;
  v_failures smallint;
  v_pin      text := nullif(btrim(coalesce(p_pin, '')), '');
  -- Ennyi hibás tipp után zárunk, ennyi időre.
  c_max_fail constant smallint := 5;
  c_window   constant interval := interval '10 minutes';
begin
  if v_player is null then
    raise exception 'Bejelentkezés szükséges' using errcode = '42501';
  end if;

  select * into v_room from public.rooms where id = p_room for update;

  if v_room.id is null or v_room.status not in ('lobby', 'playing') then
    return json_build_object(
      'ok', false, 'error', 'not_found',
      'message', 'Ez a szoba már nem elérhető.'
    );
  end if;

  -- Visszatérő játékos: neki nem kell újra a PIN.
  if exists (
    select 1 from public.room_players where room_id = v_room.id and player_id = v_player
  ) then
    update public.room_players
    set left_at = null, is_connected = true
    where room_id = v_room.id and player_id = v_player;
    return json_build_object('ok', true, 'room', public.room_state(v_room.id));
  end if;

  if v_room.status <> 'lobby' then
    return json_build_object(
      'ok', false, 'error', 'started',
      'message', 'Ez a játék már elindult.'
    );
  end if;

  -- ── PIN-ellenőrzés próbálkozás-korláttal ──
  if v_room.join_pin is not null then
    select * into v_attempt from public.room_join_attempts
    where room_id = v_room.id and player_id = v_player;

    -- Lejárt időablak: mintha nem is lett volna hiba.
    if v_attempt.room_id is not null
       and v_attempt.last_failure_at < now() - c_window then
      v_attempt.failures := 0;
    end if;

    if coalesce(v_attempt.failures, 0) >= c_max_fail then
      return json_build_object(
        'ok', false, 'error', 'locked', 'attempts_left', 0,
        'message', 'Túl sok hibás PIN. Próbáld újra 10 perc múlva.'
      );
    end if;

    if v_pin is null or v_pin <> v_room.join_pin then
      insert into public.room_join_attempts (room_id, player_id, failures)
      values (v_room.id, v_player, 1)
      on conflict (room_id, player_id) do update
      set failures = case
                       when public.room_join_attempts.last_failure_at
                            < now() - c_window then 1
                       else public.room_join_attempts.failures + 1
                     end,
          first_failure_at = case
                               when public.room_join_attempts.last_failure_at
                                    < now() - c_window then now()
                               else public.room_join_attempts.first_failure_at
                             end,
          last_failure_at = now()
      returning failures into v_failures;

      return json_build_object(
        'ok', false, 'error', 'bad_pin',
        'attempts_left', greatest(0, c_max_fail - v_failures),
        'message', 'Hibás PIN.'
      );
    end if;
  end if;

  select count(*) into v_count
  from public.room_players where room_id = v_room.id and left_at is null;

  if v_count >= v_room.max_players then
    return json_build_object(
      'ok', false, 'error', 'full',
      'message', 'Ez a szoba megtelt.'
    );
  end if;

  select coalesce(min(s.seat), 1) into v_seat
  from generate_series(1, v_room.max_players) as s(seat)
  where not exists (
    select 1 from public.room_players rp
    where rp.room_id = v_room.id and rp.seat = s.seat and rp.left_at is null
  );

  insert into public.room_players (room_id, player_id, seat)
  values (v_room.id, v_player, v_seat);

  -- Sikeres belépés után a számláló nem érdekes.
  delete from public.room_join_attempts
  where room_id = v_room.id and player_id = v_player;

  return json_build_object('ok', true, 'room', public.room_state(v_room.id));
end
$$;

comment on function public.join_room(uuid, text) is
  'Csatlakozás nyitott szobához 3 jegyű PIN-nel. Burkolót ad vissza ({ok,error,message,room}) és NEM dob kivételt, mert a hibás PIN számlálóját egy kivétel visszapörgetné.';

-- ─────────── 7. A szobaállapot mondja meg, ki vendég ───────────
--
-- A felület ebből tudja kiírni, hogy a vendég pontja nem kerül ranglistára,
-- és a játékoslistán is megjelölhető.

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
    'host_id', v_room.host_id,
    'status', v_room.status,
    'max_players', v_room.max_players,
    'rounds_per_player', v_room.rounds_per_player,
    'difficulty', v_room.difficulty,
    'block_no', v_room.block_no,
    'questions_per_category', v_room.questions_per_category,
    'answer_seconds', v_room.answer_seconds,
    'reveal_seconds', v_room.reveal_seconds,
    'has_pin', v_room.join_pin is not null,
    'max_questions', v_rules.max_questions,
    'server_time', now(),
    'current_question', v_current,
    'last_block_scores', v_room.last_block_scores,
    'last_block_ended_at', v_room.last_block_ended_at,
    -- A saját PIN-t csak a szoba készítője kapja meg, hogy meg tudja mondani.
    'my_pin', case when v_room.host_id = v_me then v_room.join_pin end,
    'i_am_guest', coalesce(
      (select p.is_anonymous from public.profiles p where p.id = v_me), false
    ),
    'players', (
      select coalesce(json_agg(row_to_json(t) order by t.seat), '[]'::json)
      from (
        select rp.player_id, rp.seat, rp.score, rp.block_score, rp.is_ready,
               rp.is_eliminated, (rp.left_at is not null) as has_left,
               p.nickname, p.avatar_id, p.is_anonymous as is_guest
        from public.room_players rp
        join public.profiles p on p.id = rp.player_id
        where rp.room_id = p_room
      ) t
    )
  );
end
$$;

-- ─────────── 8. Jogosultságok ───────────

grant execute on function public.list_open_rooms(integer) to authenticated;
grant execute on function public.join_room(uuid, text) to authenticated;
grant execute on function public.create_room(smallint, smallint, text, smallint, smallint, text)
  to authenticated;

-- A régi 5 paraméteres aláírás eltávolítása, hogy ne legyen kétértelműség.
drop function if exists public.create_room(smallint, smallint, text, smallint, smallint);

-- A `code` oszlop marad, de a felület nem használja. Az egyediségét
-- meghagyjuk: így stabil belső kapaszkodó egy szobára.
comment on column public.rooms.code is
  'Belső azonosító (naplók, támogatás). A felület NEM mutatja, és nem lehet vele csatlakozni – a belépés a nyitott szobák listájából, 3 jegyű PIN-nel történik.';
comment on column public.rooms.join_pin is
  '3 jegyű belépési PIN, a szoba készítője adja meg. NULL = bárki beléphet. Sosem kerül a list_open_rooms válaszába.';
