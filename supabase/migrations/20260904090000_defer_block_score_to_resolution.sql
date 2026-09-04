-- A pontjóváírás átkerül válaszadáskor -> a kérdés LEZÁRÁSAKOR.
--
-- HIBA, amit ez javít: az `answer_room_question()` eddig AZONNAL, a válasz
-- beküldésekor megnövelte a `room_players.block_score`-t helyes válasznál.
-- Mivel a `room_state()`/`room_tick()` a teljes játékoslistát (a
-- `block_score`-ral együtt) mindig visszaadja, a pontsáv a KÖVETKEZŐ
-- pollozáskor már mutatta a pontnövekedést – jóval azelőtt, hogy a kérdés a
-- többiek számára hivatalosan lezárult volna. Ez pontosan olyan kiszivárgás,
-- mint a helyes válasz idő előtti elárulása (amit a `correct_answer` mező
-- `resolved_at`-hoz kötése már eddig is megakadályozott): a pontsávból ki
-- lehetett következtetni, hogy valaki eltalálta-e a választ, mielőtt a
-- kiértékelés megjelent volna a képernyőn.
--
-- A JAVÍTÁS: a `block_score` növelése átkerül a `room_tick()`-be, PONTOSAN
-- abba a lépésbe, ahol a kérdést lezárjuk (`resolved_at = now()`) – a
-- `room_answers.awarded_points`-ból (amit `answer_room_question()` továbbra
-- is kiszámol és eltárol) számolva. Így a pont a kliens felé is csak azzal
-- egy időben jelenik meg, amikor a kiértékelés amúgy is látszik.
--
-- A teljes függvénytörzs azért van itt újra (nem csak a diff), mert a
-- Postgres nem tud részleges függvénymódosítást, a migrációk pedig
-- visszamenőleg nem szerkeszthetők.

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

  -- A `block_score`-t SZÁNDÉKOSAN nem itt írjuk. Ha itt frissülne, a
  -- `room_state()` már a lezárás ELŐTT visszaadná a megnövelt pontszámot –
  -- ez pontosan olyan kiszivárgás lenne, mint a helyes válasz elárulása:
  -- a pontsávon elárulná, hogy valaki eltalálta (vagy elrontotta), mielőtt a
  -- kérdés hivatalosan lezárult volna mindenki számára. A pontot a
  -- `room_tick()` írja jóvá, PONTOSAN akkor, amikor a kérdést lezárja.

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

      -- A pont ITT íródik jóvá, a lezárás pillanatában – NEM az
      -- `answer_room_question()`-ben. Ha korábban írnánk jóvá, a pontsáv már
      -- a hivatalos lezárás ELŐTT elárulná, hogy valaki eltalálta a választ
      -- (vagy sem), pontosan úgy, ahogy a helyes válasz szövegét sem adjuk
      -- ki addig. Lásd `answer_room_question()` megjegyzését is.
      update public.room_players rp
      set block_score = rp.block_score + ra.awarded_points
      from public.room_answers ra
      where ra.room_question_id = v_rq.id
        and ra.player_id = rp.player_id
        and rp.room_id = p_room
        and ra.is_correct;

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


revoke all on function public.answer_room_question(uuid, uuid, smallint, integer) from public;
grant execute on function public.answer_room_question(uuid, uuid, smallint, integer) to authenticated;

revoke all on function public.room_tick(uuid) from public;
grant execute on function public.room_tick(uuid) to authenticated;
