-- Eddig egy új kör (kategóriaváltás) csak az UTÓBBI HÁROM kategóriát kerülte
-- (`v_recent`, `limit 3`), tehát egy 10 körből (rounds_per_player = 10) álló
-- játékban statisztikailag előfordulhatott, hogy ugyanaz a kategória kétszer
-- is sorra került. A kérés szerint EGY TELJES JÁTÉKON belül mind a 10 körnek
-- különböző kategóriából kell jönnie (ha a bank ezt egyáltalán engedi).
--
-- Megoldás: a "kerülendő kategóriák" listája mostantól NEM az utóbbi három,
-- hanem AZ EBBEN A SZOBÁBAN EDDIG ELŐFORDULT ÖSSZES kategória. 28 aktív
-- kategóriánk van, a `rounds_per_player` felső korlátja pedig 10 – bőven van
-- tartalék, hogy ez sose ürítse ki a merítést, de a régi "csak az utóbbi
-- hármat kerüljük" fallback-ként megmarad, ha valamiért (pl. szűk
-- nehézség-szűrés miatt) mégis elfogyna a választék, hogy a preferencia ne
-- ronthassa el a játékot.
--
-- A teljes függvénytörzs azért van itt újra, mert a Postgres nem tud
-- részleges függvénymódosítást, a migrációk pedig visszamenőleg nem
-- szerkeszthetők.

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
  v_used       uuid[];
  v_recent     uuid[];
  v_seen       uuid[];
  v_scores     jsonb;
  v_spin       integer;
  -- Ennyi ideig ne jöhessen szembe ugyanaz a kérdés a szobát INDÍTÓ
  -- profilnak – akkor sem, ha közben más szobát nyitott. Szándékosan a
  -- HOSTHOZ kötjük (nem az összes résztvevőhöz): ő látja a legtöbb kört,
  -- és a "host_id" mezőn amúgy is van index, tehát ez olcsón lekérdezhető.
  v_history_days constant int := 30;
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

    -- Ezt a profilt (a szoba HOSTJÁT) a `v_history_days` ablakban már
    -- kiszolgált kérdéseket kerüljük – akkor is, ha közben más szobát
    -- nyitott. EGYSZER számoljuk ki tömbbe (nem korrelált albekérdezésként
    -- kérdésenként), mert így csak egyetlen lekérdezés fut, a szűrés pedig
    -- utána olcsó tömb-tartalmazás vizsgálat (ugyanez a minta, mint a
    -- `v_used`/`v_recent` kategóriáknál).
    select array_agg(distinct rq2.question_id) into v_seen
    from public.room_questions rq2
    join public.rooms r2 on r2.id = rq2.room_id
    where r2.host_id = v_room.host_id
      and rq2.started_at > now() - make_interval(days => v_history_days);

    -- Ugyanaz a kategória marad, amíg a `questions_per_category` engedi.
    if v_rq.id is not null and ((v_next_ord - 1) % v_room.questions_per_category) <> 0 then
      v_category := v_rq.category_id;
    else
      -- EBBEN A JÁTÉKBAN (ebben a szobában) eddig előfordult ÖSSZES
      -- kategóriát kerüljük – nem csak az utóbbi hármat –, hogy egy teljes
      -- játék (`rounds_per_player` kör) lehetőség szerint mind különböző
      -- kategóriából jöjjön.
      select array_agg(distinct category_id) into v_used
      from public.room_questions
      where room_id = p_room;

      select c.id into v_category
      from public.categories c
      where c.is_active
        and (v_used is null or not (c.id = any (v_used)))
        and exists (
          select 1 from public.questions q
          where q.category_id = c.id and q.is_active and q.language = 'hu'
            and q.pack_id is null
            and (v_room.difficulty is null or q.difficulty = v_room.difficulty)
            and not exists (
              select 1 from public.room_questions rq
              where rq.room_id = p_room and rq.question_id = q.id
            )
            and (v_seen is null or not (q.id = any (v_seen)))
        )
      order by random()
      limit 1;

      -- Ha ebben a szobában már annyi kategória fordult elő, hogy a teljes
      -- ismétlődésmentesség nem tartható (pl. szűk nehézség-szűrés miatt),
      -- visszaesünk a régebbi, "csak az utóbbi hármat kerüljük" szabályra –
      -- ez preferencia, nem kőbe vésett szabály.
      if v_category is null then
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
              and (v_seen is null or not (q.id = any (v_seen)))
          )
        order by random()
        limit 1;
      end if;

      -- Ha a „kerüljük a legutóbbiakat” szűrő is kiürítette a merítést,
      -- elengedjük – de a host-történetet még próbáljuk tartani, amíg lehet.
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
              and (v_seen is null or not (q.id = any (v_seen)))
          )
        order by random()
        limit 1;
      end if;

      -- Végső fallback: a host-történet MÁR NEM kötelező szabály, csak
      -- preferencia. Inkább mutassunk egy nemrég látott kérdést, mint hogy
      -- feleslegesen véget érjen a játék – ez a régi (a funkció előtti)
      -- viselkedés, tehát nem ronthat el semmit, ami eddig működött.
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

    -- Kérdésválasztás a kategóriából: a kevésbé „elhasznált” kérdés előnyben,
    -- és – ha van rá választék – a host-nak nemrég feltett kérdéseket kerülve.
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
      and (v_seen is null or not (q.id = any (v_seen)))
    order by power(
      random(),
      1.0 / greatest(0.05, 1.0 / (1.0 + coalesce(s.times_answered, 0) / 400.0))
    ) desc
    limit 1;

    -- Ugyanaz a preferencia-elengedés, mint a kategóriánál: ha EBBEN a
    -- kategóriában csak a hostnak már feltett kérdés maradt, inkább azt
    -- adjuk ki, mint hogy megszakadjon a játék.
    if v_question is null then
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
    end if;

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

revoke all on function public.room_tick(uuid) from public;
grant execute on function public.room_tick(uuid) to authenticated;
