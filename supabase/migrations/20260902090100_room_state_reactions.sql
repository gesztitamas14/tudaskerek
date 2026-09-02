-- A room_state() kiegészítése a friss beszólásokkal.
--
-- A függvény törzse VÁLTOZATLAN a 20260901091400 migrációhoz képest, egyetlen
-- kivétellel: a visszaadott JSON-ba bekerül a `reactions` kulcs. A teljes
-- törzs azért van itt újra, mert a Postgres nem tud részleges függvény-
-- módosítást; a migrációk pedig visszamenőleg nem szerkeszthetők.

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
  v_block    json := null;
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

  -- Az aktuális kör kategóriája és haladása. A kör ELSŐ kérdésének
  -- kategóriája az egész körre érvényes.
  if v_room.status = 'playing' and v_rq.id is not null then
    select json_build_object(
      'category_slug', c.slug,
      'category_name', c.name,
      'answered_questions', (
        select count(*) from public.room_questions rq2
        where rq2.room_id = p_room and rq2.block_no = v_room.block_no
          and rq2.resolved_at is not null
      ),
      'questions_in_round', v_rules.max_questions
    )
    into v_block
    from public.room_questions rq
    join public.categories c on c.id = rq.category_id
    where rq.room_id = p_room and rq.block_no = v_room.block_no
    order by rq.ordinal
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
    'spin_seconds', v_room.spin_seconds,
    'has_pin', v_room.join_pin is not null,
    'max_questions', v_rules.max_questions,
    'server_time', now(),
    'current_round', v_block,
    'current_question', v_current,
    -- Friss beszólások: a kliens amúgy is másodpercenként kérdezi az
    -- állapotot, ezért nem kell hozzá külön csatorna vagy realtime.
    'reactions', public.room_recent_reactions(p_room),
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
