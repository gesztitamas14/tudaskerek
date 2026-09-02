-- 0005 – publikus API: nézetek és RPC-k
--
-- Fontos szabály: a kliens SOHA nem kap `correct_answer`-t kérdéskiszolgáláskor.
-- A `questions_public` nézet ezt a mezőt (és a magyarázatot) elhagyja.

-- ───────────────────────── nézetek ──────────────────────────

create or replace view public.questions_public as
  select
    q.id,
    q.category_id,
    c.slug        as category_slug,
    q.question_text,
    q.answers,
    q.difficulty,
    q.language,
    q.topic,
    q.pack_id
  from public.questions q
  join public.categories c on c.id = q.category_id
  where q.is_active and c.is_active;

comment on view public.questions_public is
  'Kliensnek szánt kérdésnézet. Tudatosan security_invoker = false (a hívó nem olvashatja közvetlenül a questions táblát), és nem tartalmaz correct_answer/explanation mezőt.';

create or replace view public.categories_public as
  select id, slug, name, description, icon, color, is_hungarian, sort_order
  from public.categories
  where is_active
  order by sort_order, name;

-- Kategóriánkénti kérdésszám – a kerék csak feltöltött kategóriát pörgethet.
create or replace view public.category_stats as
  select
    c.id                                             as category_id,
    c.slug,
    count(q.id)                                      as question_count,
    count(q.id) filter (where q.difficulty = 'easy')   as easy_count,
    count(q.id) filter (where q.difficulty = 'medium') as medium_count,
    count(q.id) filter (where q.difficulty = 'hard')   as hard_count
  from public.categories c
  left join public.questions q
    on q.category_id = c.id and q.is_active
  where c.is_active
  group by c.id, c.slug;

-- ──────────────────── aktív pontozási szabály ────────────────────

create or replace function public.active_scoring_rules()
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select json_build_object(
    'version', r.version,
    'max_questions', r.max_questions,
    'reward_table', r.reward_table,
    'penalty_multiplier', r.penalty_multiplier,
    'allow_bank', r.allow_bank,
    'time_limit_seconds', r.time_limit_seconds
  )
  from public.scoring_rules r
  where r.is_active
  limit 1
$$;

-- ───────────────────── duplikátum-ellenőrzés ─────────────────────
-- Négy szint: exact · hasonló szöveg · azonos válaszhalmaz · azonos tény.

create or replace function public.check_question_duplicates(
  p_category_slug  text,
  p_question_text  text,
  p_answers        text[] default null,
  p_source         text default null,
  p_threshold      double precision default 0.72,
  p_limit          integer default 10
)
returns table (
  match_kind  text,
  question_id uuid,
  similarity  double precision,
  question_text text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_category  uuid;
  v_norm      text := public.norm_text(p_question_text);
  v_hash      text;
begin
  select id into v_category from public.categories where slug = p_category_slug;
  if v_category is null then
    raise exception 'Ismeretlen kategória: %', p_category_slug using errcode = 'no_data_found';
  end if;

  if p_answers is not null and cardinality(p_answers) = 4 then
    v_hash := public.answer_set_hash(p_answers[1], p_answers[2], p_answers[3], p_answers[4]);
  end if;

  return query
  with candidates as (
    -- 1. pontos egyezés (kategórián belül)
    select 'exact'::text as kind, q.id, 1.0::double precision as sim, q.question_text
    from public.questions q
    where q.category_id = v_category and q.norm_question = v_norm

    union all
    -- 2. közel-duplikátum szöveg
    select 'similar_text', q.id,
           extensions.similarity(q.norm_question, v_norm)::double precision,
           q.question_text
    from public.questions q
    where q.category_id = v_category
      and q.norm_question <> v_norm
      and extensions.similarity(q.norm_question, v_norm) >= p_threshold

    union all
    -- 3. azonos válaszhalmaz + részleges szöveghasonlóság
    select 'same_answers', q.id,
           extensions.similarity(q.norm_question, v_norm)::double precision,
           q.question_text
    from public.questions q
    where v_hash is not null
      and q.category_id = v_category
      and q.answer_set_hash = v_hash
      and extensions.similarity(q.norm_question, v_norm) >= 0.45

    union all
    -- 4. azonos tény: ugyanaz a forrás-entitás, ugyanaz a helyes válasz
    select 'same_fact', q.id,
           extensions.similarity(q.norm_question, v_norm)::double precision,
           q.question_text
    from public.questions q
    where p_source is not null
      and q.source = p_source
      and p_answers is not null
      and public.norm_text(q.answers[q.correct_answer + 1]) = any (
            select public.norm_text(a) from unnest(p_answers) as a
          )
  ), ranked as (
    select distinct on (c.id)
           c.kind, c.id, c.sim, c.question_text,
           case c.kind
             when 'exact' then 0 when 'same_answers' then 1
             when 'same_fact' then 2 else 3
           end as prio
    from candidates c
    order by c.id, prio, c.sim desc
  )
  select r.kind, r.id, r.sim, r.question_text
  from ranked r
  order by r.prio, r.sim desc
  limit p_limit;
end
$$;

-- ───────────────────── session életciklus ──────────────────────

create or replace function public.start_session(
  p_mode           text default 'single',
  p_room_id        uuid default null,
  p_client_version text default null
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
  v_id      uuid;
begin
  if v_player is null then
    raise exception 'Bejelentkezés szükséges' using errcode = '42501';
  end if;

  select version into v_version from public.scoring_rules where is_active limit 1;
  if v_version is null then
    raise exception 'Nincs aktív pontozási szabály' using errcode = 'no_data_found';
  end if;

  -- Az előző, félbehagyott kört lezárjuk (nem kap eredményt).
  update public.game_sessions
  set status = 'abandoned', finished_at = now()
  where player_id = v_player and status = 'active';

  insert into public.game_sessions (player_id, mode, room_id, scoring_version, client_version)
  values (v_player, p_mode::public.game_mode, p_room_id, v_version, p_client_version)
  returning id into v_id;

  return json_build_object(
    'session_id', v_id,
    'scoring', public.active_scoring_rules()
  );
end
$$;

-- Súlyozott kérdéskiválasztás.
--
-- Súlytényezők:
--   * kitettség kiegyenlítése – a sokszor kiszolgált kérdés kisebb súlyt kap
--   * nehézség-illesztés – ha kértek nehézséget, a többi csak tartalék
--   * minőség – a sokszor bejelentett kérdés súlya csökken
--   * degeneráltság – a ~0% vagy ~100% találati arányú kérdés súlya csökken
--       (túl könnyű / félreérthető), ha már van elég mérés
-- A választás A-Res súlyozott mintavétel: kulcs = random()^(1/w), a legnagyobb nyer.
create or replace function public.next_question(
  p_session       uuid,
  p_category_slug text,
  p_difficulty    text default null,
  p_history_days  integer default 60
)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_player     uuid := auth.uid();
  v_session    public.game_sessions;
  v_category   uuid;
  v_max        smallint;
  v_position   smallint;
  v_qid        uuid;
  v_row        record;
begin
  select * into v_session from public.game_sessions where id = p_session;
  if v_session.id is null then
    raise exception 'Nincs ilyen session' using errcode = 'no_data_found';
  end if;
  if v_session.player_id <> v_player then
    raise exception 'Nem a saját sessionöd' using errcode = '42501';
  end if;
  if v_session.status <> 'active' then
    raise exception 'A kör már véget ért' using errcode = 'check_violation';
  end if;

  select r.max_questions into v_max
  from public.scoring_rules r where r.version = v_session.scoring_version;

  if v_session.questions_served >= v_max then
    raise exception 'A körben már nem kérhető több kérdés' using errcode = 'check_violation';
  end if;

  -- Van-e még megválaszolatlan, kiszolgált kérdés? Akkor azt adjuk vissza
  -- (hálózati újrapróbálkozás / app-újraindítás esetén idempotens).
  select sq.question_id into v_qid
  from public.session_questions sq
  where sq.session_id = p_session and sq.answered_at is null
  order by sq.ordinal desc
  limit 1;

  if v_qid is null then
    select id into v_category from public.categories where slug = p_category_slug and is_active;
    if v_category is null then
      raise exception 'Ismeretlen kategória: %', p_category_slug using errcode = 'no_data_found';
    end if;

    v_position := v_session.questions_served + 1;

    with pool as (
      select
        q.id,
        greatest(
          0.02,
          -- kitettség kiegyenlítése
          (1.0 / (1.0 + coalesce(s.times_answered, 0) / 400.0))
          -- nehézség-illesztés
          * case
              when p_difficulty is null then 1.0
              when q.difficulty = p_difficulty::public.difficulty then 1.0
              else 0.15
            end
          -- bejelentések
          * case when coalesce(s.times_reported, 0) >= 3 then 0.1 else 1.0 end
          -- degenerált találati arány
          * case
              when coalesce(s.times_answered, 0) < 25 then 1.0
              when s.correct_ratio > 0.97 then 0.35
              when s.correct_ratio < 0.12 then 0.35
              else 1.0
            end
        ) as w
      from public.questions q
      left join public.question_stats s on s.question_id = q.id
      where q.is_active
        and q.category_id = v_category
        and q.language = 'hu'
        and q.pack_id is null       -- MVP: csak az ingyenes alaptartalom
        and not exists (
          select 1 from public.session_questions sq
          where sq.session_id = p_session and sq.question_id = q.id
        )
        and not exists (
          select 1 from public.player_question_history h
          where h.player_id = v_player
            and h.question_id = q.id
            and h.last_seen_at > now() - make_interval(days => p_history_days)
        )
    )
    select id into v_qid
    from pool
    order by power(random(), 1.0 / w) desc
    limit 1;

    -- Ha a történet miatt kiürült a merítés, engedjük el a történet-szűrőt.
    if v_qid is null then
      select q.id into v_qid
      from public.questions q
      where q.is_active and q.category_id = v_category and q.language = 'hu'
        and q.pack_id is null
        and not exists (
          select 1 from public.session_questions sq
          where sq.session_id = p_session and sq.question_id = q.id
        )
      order by random()
      limit 1;
    end if;

    if v_qid is null then
      raise exception 'Ebben a kategóriában nincs több kiszolgálható kérdés'
        using errcode = 'no_data_found';
    end if;

    insert into public.session_questions (session_id, question_id, ordinal, category_id)
    values (p_session, v_qid, v_position, v_category);

    update public.game_sessions
    set questions_served = v_position
    where id = p_session;

    insert into public.player_question_history (player_id, question_id)
    values (v_player, v_qid)
    on conflict (player_id, question_id) do update
      set times_seen = player_question_history.times_seen + 1,
          last_seen_at = now();
  end if;

  select
    qp.id, qp.question_text, qp.answers, qp.difficulty, qp.category_slug,
    sq.ordinal
  into v_row
  from public.questions_public qp
  join public.session_questions sq
    on sq.question_id = qp.id and sq.session_id = p_session
  where qp.id = v_qid;

  select r.max_questions into v_max
  from public.scoring_rules r where r.version = v_session.scoring_version;

  return json_build_object(
    'question', json_build_object(
      'id', v_row.id,
      'question_text', v_row.question_text,
      'answers', v_row.answers,
      'difficulty', v_row.difficulty,
      'category_slug', v_row.category_slug
    ),
    'position', v_row.ordinal,
    'max_questions', v_max
  );
end
$$;

-- Válasz beküldése. A helyes index CSAK innen jön vissza.
create or replace function public.submit_answer(
  p_session     uuid,
  p_question    uuid,
  p_answer      smallint,
  p_answer_ms   integer default null
)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_player   uuid := auth.uid();
  v_session  public.game_sessions;
  v_sq       public.session_questions;
  v_q        public.questions;
  v_rules    public.scoring_rules;
  v_correct  boolean;
  v_award    integer := 0;
  v_banked   integer;
  v_status   public.session_status;
  v_can_more boolean;
begin
  select * into v_session from public.game_sessions where id = p_session for update;
  if v_session.id is null then
    raise exception 'Nincs ilyen session' using errcode = 'no_data_found';
  end if;
  if v_session.player_id <> v_player then
    raise exception 'Nem a saját sessionöd' using errcode = '42501';
  end if;
  if v_session.status <> 'active' then
    raise exception 'A kör már véget ért' using errcode = 'check_violation';
  end if;

  select * into v_sq from public.session_questions
  where session_id = p_session and question_id = p_question;
  if v_sq.question_id is null then
    raise exception 'Ez a kérdés nem ebben a körben lett kiszolgálva'
      using errcode = 'check_violation';
  end if;
  if v_sq.answered_at is not null then
    raise exception 'Erre a kérdésre már válaszoltál' using errcode = 'unique_violation';
  end if;
  if p_answer is null or p_answer < 0 or p_answer > 3 then
    raise exception 'Érvénytelen válaszindex' using errcode = 'check_violation';
  end if;

  select * into v_q from public.questions where id = p_question;
  select * into v_rules from public.scoring_rules where version = v_session.scoring_version;

  v_correct := (p_answer = v_q.correct_answer);

  if v_correct then
    v_award  := v_rules.reward_table[v_sq.ordinal];
    v_banked := v_session.banked_score + v_award;
    v_can_more := v_sq.ordinal < v_rules.max_questions;
    v_status := case when v_can_more then 'active' else 'completed' end;
  else
    v_award  := 0;
    v_banked := floor(v_session.banked_score * v_rules.penalty_multiplier)::integer;
    v_can_more := false;
    v_status := 'busted';
  end if;

  update public.session_questions
  set answered_at = now(),
      selected_answer = p_answer,
      is_correct = v_correct,
      answer_ms = p_answer_ms,
      awarded_points = v_award
  where session_id = p_session and question_id = p_question;

  update public.game_sessions
  set banked_score  = v_banked,
      correct_count = correct_count + case when v_correct then 1 else 0 end,
      status        = v_status,
      finished_at   = case when v_status = 'active' then null else now() end
  where id = p_session;

  update public.question_stats
  set times_answered   = times_answered + 1,
      times_correct    = times_correct + case when v_correct then 1 else 0 end,
      total_answer_ms  = total_answer_ms + greatest(0, coalesce(p_answer_ms, 0)),
      last_answered_at = now()
  where question_id = p_question;

  -- Ha a kör itt véget ért, azonnal rögzítjük az eredményt.
  if v_status <> 'active' then
    perform public.finalize_session(p_session);
  end if;

  return json_build_object(
    'is_correct', v_correct,
    'correct_answer', v_q.correct_answer,
    'explanation', v_q.explanation,
    'source', v_q.source,
    'awarded_points', v_award,
    'banked_score', v_banked,
    'position', v_sq.ordinal,
    'can_continue', v_can_more,
    'session_status', v_status
  );
end
$$;

-- Kör lezárása: bankolás („megállok”) vagy a szerver által kiváltott vég.
create or replace function public.finalize_session(p_session uuid)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session public.game_sessions;
  v_answered integer;
  v_result public.game_results;
begin
  select * into v_session from public.game_sessions where id = p_session for update;
  if v_session.id is null then
    raise exception 'Nincs ilyen session' using errcode = 'no_data_found';
  end if;
  if v_session.player_id <> auth.uid() and not public.is_admin() then
    raise exception 'Nem a saját sessionöd' using errcode = '42501';
  end if;

  if v_session.status = 'active' then
    update public.game_sessions
    set status = 'banked', finished_at = now()
    where id = p_session
    returning * into v_session;
  end if;

  select count(*) into v_answered
  from public.session_questions
  where session_id = p_session and answered_at is not null;

  insert into public.game_results
    (player_id, session_id, mode, score, questions, correct, busted, is_trusted)
  values (
    v_session.player_id, v_session.id, v_session.mode, v_session.banked_score,
    v_answered, v_session.correct_count, v_session.status = 'busted', v_session.is_trusted
  )
  on conflict (session_id) do nothing
  returning * into v_result;

  return json_build_object(
    'session_id', v_session.id,
    'status', v_session.status,
    'score', v_session.banked_score,
    'questions', v_answered,
    'correct', v_session.correct_count,
    'result_id', v_result.id
  );
end
$$;

-- Offline lejátszott kör feltöltése. Nem megbízható (a kliens számolta),
-- ezért `is_trusted = false`, és a globális rangsorba nem kerül be.
create or replace function public.submit_offline_result(
  p_score      integer,
  p_questions  smallint,
  p_correct    smallint,
  p_busted     boolean,
  p_played_at  timestamptz default now(),
  p_client_id  uuid default null
)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_player uuid := auth.uid();
  v_id uuid;
begin
  if v_player is null then
    raise exception 'Bejelentkezés szükséges' using errcode = '42501';
  end if;
  if p_score < 0 or p_questions < 0 or p_correct > p_questions or p_questions > 50 then
    raise exception 'Érvénytelen eredmény' using errcode = 'check_violation';
  end if;

  -- Idempotencia: a kliens által generált id megismételt feltöltésnél ugyanaz.
  if p_client_id is not null and exists (
    select 1 from public.game_results where id = p_client_id
  ) then
    return json_build_object('result_id', p_client_id, 'duplicate', true);
  end if;

  insert into public.game_results
    (id, player_id, session_id, mode, score, questions, correct, busted, is_trusted, created_at)
  values (
    coalesce(p_client_id, extensions.gen_random_uuid()),
    v_player, null, 'single', p_score, p_questions, p_correct, p_busted, false,
    least(p_played_at, now())
  )
  returning id into v_id;

  return json_build_object('result_id', v_id, 'duplicate', false);
end
$$;

-- ─────────────── offline csomag (teljes kérdések) ────────────────
-- Offline módban a helyes válasznak szükségszerűen a kliensen kell lennie.
-- Ezért az offline kör eredménye `is_trusted = false`.

create or replace function public.offline_pack(
  p_per_category integer default 10,
  p_since        timestamptz default null
)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_per_category, 10), 1), 60);
  v_questions json;
begin
  select coalesce(json_agg(row_to_json(t)), '[]'::json) into v_questions
  from (
    select
      q.id, c.slug as category_slug, q.question_text, q.answers,
      q.correct_answer, q.difficulty, q.explanation, q.source, q.topic,
      q.updated_at
    from (
      select q.*, row_number() over (
               partition by q.category_id
               order by coalesce(s.times_answered, 0), q.id
             ) as rn
      from public.questions q
      left join public.question_stats s on s.question_id = q.id
      where q.is_active and q.language = 'hu' and q.pack_id is null
        and (p_since is null or q.updated_at > p_since)
    ) q
    join public.categories c on c.id = q.category_id and c.is_active
    where q.rn <= v_limit
  ) t;

  return json_build_object(
    'generated_at', now(),
    'scoring', public.active_scoring_rules(),
    'categories', (
      select coalesce(json_agg(row_to_json(cc)), '[]'::json)
      from (
        select id, slug, name, description, icon, color, is_hungarian, sort_order
        from public.categories where is_active order by sort_order, name
      ) cc
    ),
    'questions', v_questions
  );
end
$$;

-- ───────────────────────── ranglisták ──────────────────────────

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
  where p.banned_until is null or p.banned_until < now()
  order by rank
  limit v_limit;
end
$$;

-- A hívó helye a ranglistán (a top listán kívül is)
create or replace function public.my_rank(p_scope text default 'all_time')
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_player uuid := auth.uid();
  v_rank   bigint;
  v_best   integer;
begin
  if v_player is null then
    return json_build_object('rank', null, 'best_score', 0);
  end if;

  select l.rank, l.best_score into v_rank, v_best
  from public.leaderboard(p_scope, 200) l
  where l.player_id = v_player;

  if v_rank is null then
    return json_build_object('rank', null, 'best_score', coalesce(v_best, 0), 'outside_top', true);
  end if;

  return json_build_object('rank', v_rank, 'best_score', v_best, 'outside_top', false);
end
$$;

-- ───────────────── személyes statisztika ─────────────────

create or replace function public.my_stats()
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_player uuid := auth.uid();
begin
  if v_player is null then
    raise exception 'Bejelentkezés szükséges' using errcode = '42501';
  end if;

  return (
    select json_build_object(
      'profile', json_build_object(
        'nickname', p.nickname,
        'avatar_id', p.avatar_id,
        'total_score', p.total_score,
        'best_round_score', p.best_round_score,
        'games_played', p.games_played,
        'questions_answered', p.questions_answered,
        'questions_correct', p.questions_correct,
        'accuracy', case when p.questions_answered = 0 then null
                         else p.questions_correct::double precision / p.questions_answered end
      ),
      'by_category', (
        select coalesce(json_agg(row_to_json(t) order by t.answered desc), '[]'::json)
        from (
          select c.slug, c.name,
                 count(*)::int as answered,
                 count(*) filter (where sq.is_correct)::int as correct
          from public.session_questions sq
          join public.game_sessions gs on gs.id = sq.session_id
          join public.categories c on c.id = sq.category_id
          where gs.player_id = v_player and sq.answered_at is not null
          group by c.slug, c.name
        ) t
      ),
      'recent', (
        select coalesce(json_agg(row_to_json(r)), '[]'::json)
        from (
          select gr.score, gr.questions, gr.correct, gr.busted, gr.created_at
          from public.game_results gr
          where gr.player_id = v_player
          order by gr.created_at desc
          limit 20
        ) r
      )
    )
    from public.profiles p where p.id = v_player
  );
end
$$;

-- ─────────── kérdés bejelentése (hibás/félreérthető) ───────────

create or replace function public.report_question(p_question uuid, p_reason text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Bejelentkezés szükséges' using errcode = '42501';
  end if;
  update public.question_stats
  set times_reported = times_reported + 1
  where question_id = p_question;
end
$$;

-- ─────────── attribúciós lista (ShareAlike források) ───────────

create or replace function public.attributions()
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(json_agg(row_to_json(t)), '[]'::json)
  from (
    select q.license, q.provenance::text as provenance, count(*)::int as question_count
    from public.questions q
    where q.license is not null and q.is_active
    group by q.license, q.provenance
  ) t
$$;
