-- 0007 – online multiplayer szobák
--
-- Modell: körökre osztott, váltakozó („hot seat online”) játék. Egy szobában
-- 2–5 játékos van; a szoba minden fordulójában a soron lévő játékos lejátszik
-- egy teljes press-your-luck kört (ugyanazzal a `game_sessions` motorral, mint
-- egyjátékosban), a többiek élőben követik. Így a teljes egyjátékos logika
-- újrahasznosul, és a válaszvalidáció ugyanúgy szerveroldali marad.

do $$ begin
  create type public.room_status as enum ('lobby', 'playing', 'finished', 'cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.rooms (
  id                uuid primary key default extensions.gen_random_uuid(),
  code              text not null unique,
  host_id           uuid not null references public.profiles (id) on delete cascade,
  max_players       smallint not null default 4,
  rounds_per_player smallint not null default 1,
  difficulty        public.difficulty,          -- NULL = vegyes
  scoring_version   integer not null references public.scoring_rules (version),
  status            public.room_status not null default 'lobby',
  -- A soron lévő játékos és forduló
  current_seat      smallint,
  current_round     smallint not null default 0,
  created_at        timestamptz not null default now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  expires_at        timestamptz not null default now() + interval '6 hours',
  constraint rooms_code_format check (code ~ '^[A-Z0-9]{6}$'),
  constraint rooms_max_players check (max_players between 2 and 5),
  constraint rooms_rounds check (rounds_per_player between 1 and 5)
);

create index if not exists rooms_status_idx on public.rooms (status, expires_at);
create index if not exists rooms_host_idx on public.rooms (host_id);

create table if not exists public.room_players (
  room_id    uuid not null references public.rooms (id) on delete cascade,
  player_id  uuid not null references public.profiles (id) on delete cascade,
  seat       smallint not null,
  score      integer not null default 0,
  rounds_done smallint not null default 0,
  is_ready   boolean not null default false,
  is_connected boolean not null default true,
  joined_at  timestamptz not null default now(),
  left_at    timestamptz,
  primary key (room_id, player_id),
  constraint room_players_seat_range check (seat between 1 and 5)
);

create unique index if not exists room_players_seat_unique
  on public.room_players (room_id, seat) where left_at is null;

create table if not exists public.room_rounds (
  id          uuid primary key default extensions.gen_random_uuid(),
  room_id     uuid not null references public.rooms (id) on delete cascade,
  round_no    smallint not null,
  seat        smallint not null,
  player_id   uuid not null references public.profiles (id) on delete cascade,
  session_id  uuid references public.game_sessions (id) on delete set null,
  score       integer,
  busted      boolean,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  unique (room_id, round_no, seat)
);

create index if not exists room_rounds_room_idx on public.room_rounds (room_id, round_no);

-- A game_sessions.room_id FK-ját itt adjuk hozzá (körkörös hivatkozás elkerülése)
do $$ begin
  alter table public.game_sessions
    add constraint game_sessions_room_fk
    foreign key (room_id) references public.rooms (id) on delete set null;
exception when duplicate_object then null; end $$;

-- ─────────────────────── szobakód generálás ───────────────────────
-- Kihagyjuk a könnyen összekeverhető karaktereket (0/O, 1/I, 5/S).

create or replace function public.generate_room_code()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- Nincs benne I, O, S, 0, 1, 5 – ezek szóban/írásban összekeverhetők.
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';
  v_code text;
begin
  for v_attempt in 1 .. 40 loop
    v_code := '';
    for v_pos in 1 .. 6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * char_length(v_alphabet))::int, 1);
    end loop;
    if not exists (
      select 1 from public.rooms
      where code = v_code and status in ('lobby', 'playing')
    ) then
      return v_code;
    end if;
  end loop;
  raise exception 'Nem sikerült szabad szobakódot generálni' using errcode = 'too_many_rows';
end
$$;

-- ───────────────────────── szoba műveletek ─────────────────────────

create or replace function public.create_room(
  p_max_players       smallint default 4,
  p_rounds_per_player smallint default 1,
  p_difficulty        text default null
)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_player uuid := auth.uid();
  v_version integer;
  v_room public.rooms;
begin
  if v_player is null then
    raise exception 'Bejelentkezés szükséges' using errcode = '42501';
  end if;

  -- Egy játékos egyszerre egy nyitott szobát vezethet
  update public.rooms set status = 'cancelled', finished_at = now()
  where host_id = v_player and status = 'lobby';

  select version into v_version from public.scoring_rules where is_active limit 1;

  insert into public.rooms (code, host_id, max_players, rounds_per_player, difficulty, scoring_version)
  values (
    public.generate_room_code(), v_player,
    least(greatest(coalesce(p_max_players, 4), 2), 5),
    least(greatest(coalesce(p_rounds_per_player, 1), 1), 5),
    nullif(p_difficulty, '')::public.difficulty,
    v_version
  )
  returning * into v_room;

  insert into public.room_players (room_id, player_id, seat, is_ready)
  values (v_room.id, v_player, 1, true);

  return public.room_state(v_room.id);
end
$$;

create or replace function public.join_room(p_code text)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_player uuid := auth.uid();
  v_room public.rooms;
  v_seat smallint;
  v_count integer;
begin
  if v_player is null then
    raise exception 'Bejelentkezés szükséges' using errcode = '42501';
  end if;

  select * into v_room from public.rooms
  where code = upper(btrim(p_code)) and status in ('lobby', 'playing')
  order by created_at desc
  limit 1
  for update;

  if v_room.id is null then
    raise exception 'Nincs ilyen szoba, vagy már véget ért' using errcode = 'no_data_found';
  end if;

  -- Visszatérő játékos
  if exists (select 1 from public.room_players where room_id = v_room.id and player_id = v_player) then
    update public.room_players
    set left_at = null, is_connected = true
    where room_id = v_room.id and player_id = v_player;
    return public.room_state(v_room.id);
  end if;

  if v_room.status <> 'lobby' then
    raise exception 'A játék már elindult' using errcode = 'check_violation';
  end if;

  select count(*) into v_count
  from public.room_players where room_id = v_room.id and left_at is null;

  if v_count >= v_room.max_players then
    raise exception 'A szoba tele van' using errcode = 'check_violation';
  end if;

  select coalesce(min(s.seat), 1) into v_seat
  from generate_series(1, v_room.max_players) as s(seat)
  where not exists (
    select 1 from public.room_players rp
    where rp.room_id = v_room.id and rp.seat = s.seat and rp.left_at is null
  );

  insert into public.room_players (room_id, player_id, seat)
  values (v_room.id, v_player, v_seat);

  return public.room_state(v_room.id);
end
$$;

create or replace function public.set_ready(p_room uuid, p_ready boolean default true)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.room_players
  set is_ready = coalesce(p_ready, true)
  where room_id = p_room and player_id = auth.uid();
  return public.room_state(p_room);
end
$$;

create or replace function public.leave_room(p_room uuid)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_player uuid := auth.uid();
  v_room public.rooms;
  v_remaining integer;
begin
  update public.room_players
  set left_at = now(), is_connected = false, is_ready = false
  where room_id = p_room and player_id = v_player and left_at is null;

  select * into v_room from public.rooms where id = p_room for update;
  if v_room.id is null then
    return json_build_object('left', true);
  end if;

  select count(*) into v_remaining
  from public.room_players where room_id = p_room and left_at is null;

  if v_remaining = 0 then
    update public.rooms set status = 'cancelled', finished_at = now() where id = p_room;
  elsif v_room.host_id = v_player and v_room.status = 'lobby' then
    -- új host: a legkisebb szabad szék
    update public.rooms r
    set host_id = (
      select rp.player_id from public.room_players rp
      where rp.room_id = p_room and rp.left_at is null
      order by rp.seat limit 1
    )
    where r.id = p_room;
  elsif v_room.status = 'playing' and v_room.current_seat = (
      select seat from public.room_players where room_id = p_room and player_id = v_player
  ) then
    -- a soron lévő játékos lépett ki: továbbadjuk a kört
    perform public.advance_room_turn(p_room);
  end if;

  return json_build_object('left', true);
end
$$;

-- Szoba indítása (csak host, min. 2 csatlakozott játékos)
create or replace function public.start_room(p_room uuid)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_count integer;
  v_first smallint;
begin
  select * into v_room from public.rooms where id = p_room for update;
  if v_room.id is null then
    raise exception 'Nincs ilyen szoba' using errcode = 'no_data_found';
  end if;
  if v_room.host_id <> auth.uid() then
    raise exception 'Csak a szoba létrehozója indíthatja el' using errcode = '42501';
  end if;
  if v_room.status <> 'lobby' then
    raise exception 'A szoba már nem a várakozó állapotban van' using errcode = 'check_violation';
  end if;

  select count(*), min(seat) into v_count, v_first
  from public.room_players where room_id = p_room and left_at is null;

  if v_count < 2 then
    raise exception 'Legalább két játékos kell az indításhoz' using errcode = 'check_violation';
  end if;

  update public.rooms
  set status = 'playing', started_at = now(), current_round = 1, current_seat = v_first,
      expires_at = now() + interval '3 hours'
  where id = p_room;

  return public.room_state(p_room);
end
$$;

-- A soron lévő játékos elindítja a saját körét (session jön létre a szobához)
create or replace function public.begin_turn(p_room uuid)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_player uuid := auth.uid();
  v_room public.rooms;
  v_seat smallint;
  v_session uuid;
  v_existing public.room_rounds;
begin
  select * into v_room from public.rooms where id = p_room for update;
  if v_room.id is null or v_room.status <> 'playing' then
    raise exception 'A szoba nem játszik' using errcode = 'check_violation';
  end if;

  select seat into v_seat from public.room_players
  where room_id = p_room and player_id = v_player and left_at is null;

  if v_seat is null then
    raise exception 'Nem vagy a szoba tagja' using errcode = '42501';
  end if;
  if v_seat <> v_room.current_seat then
    raise exception 'Nem te vagy soron' using errcode = '42501';
  end if;

  select * into v_existing from public.room_rounds
  where room_id = p_room and round_no = v_room.current_round and seat = v_seat;

  if v_existing.id is not null and v_existing.finished_at is null and v_existing.session_id is not null then
    return json_build_object('session_id', v_existing.session_id, 'resumed', true,
                             'scoring', public.active_scoring_rules());
  end if;

  insert into public.game_sessions (player_id, mode, room_id, scoring_version)
  values (v_player, 'multiplayer', p_room, v_room.scoring_version)
  returning id into v_session;

  insert into public.room_rounds (room_id, round_no, seat, player_id, session_id)
  values (p_room, v_room.current_round, v_seat, v_player, v_session)
  on conflict (room_id, round_no, seat) do update
    set session_id = excluded.session_id, started_at = now(), finished_at = null;

  return json_build_object('session_id', v_session, 'resumed', false,
                           'scoring', public.active_scoring_rules());
end
$$;

-- Kör lezárása a szobában: pontok könyvelése és a kör továbbadása
create or replace function public.end_turn(p_room uuid, p_session uuid)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_player uuid := auth.uid();
  v_session public.game_sessions;
  v_final json;
begin
  select * into v_session from public.game_sessions where id = p_session;
  if v_session.id is null or v_session.player_id <> v_player or v_session.room_id <> p_room then
    raise exception 'Érvénytelen session' using errcode = '42501';
  end if;

  v_final := public.finalize_session(p_session);

  select * into v_session from public.game_sessions where id = p_session;

  update public.room_rounds
  set score = v_session.banked_score,
      busted = (v_session.status = 'busted'),
      finished_at = now()
  where room_id = p_room and session_id = p_session;

  update public.room_players
  set score = score + v_session.banked_score,
      rounds_done = rounds_done + 1
  where room_id = p_room and player_id = v_player;

  perform public.advance_room_turn(p_room);

  return public.room_state(p_room);
end
$$;

-- A kör továbbadása: következő szék, vagy következő forduló, vagy vége
create or replace function public.advance_room_turn(p_room uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_next smallint;
begin
  select * into v_room from public.rooms where id = p_room for update;
  if v_room.id is null or v_room.status <> 'playing' then
    return;
  end if;

  select min(rp.seat) into v_next
  from public.room_players rp
  where rp.room_id = p_room and rp.left_at is null and rp.seat > v_room.current_seat;

  if v_next is not null then
    update public.rooms set current_seat = v_next where id = p_room;
    return;
  end if;

  -- Forduló vége
  if v_room.current_round >= v_room.rounds_per_player then
    update public.rooms
    set status = 'finished', finished_at = now(), current_seat = null
    where id = p_room;
    return;
  end if;

  select min(rp.seat) into v_next
  from public.room_players rp
  where rp.room_id = p_room and rp.left_at is null;

  if v_next is null then
    update public.rooms set status = 'cancelled', finished_at = now() where id = p_room;
  else
    update public.rooms
    set current_round = v_room.current_round + 1, current_seat = v_next
    where id = p_room;
  end if;
end
$$;

-- ─────────────────── teljes szobaállapot egy hívásban ───────────────────

create or replace function public.room_state(p_room uuid)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
begin
  select * into v_room from public.rooms where id = p_room;
  if v_room.id is null then
    raise exception 'Nincs ilyen szoba' using errcode = 'no_data_found';
  end if;

  -- Csak tag (vagy admin) kérdezheti le
  if not exists (
    select 1 from public.room_players
    where room_id = p_room and player_id = auth.uid()
  ) and not public.is_admin() then
    raise exception 'Nem vagy a szoba tagja' using errcode = '42501';
  end if;

  return json_build_object(
    'id', v_room.id,
    'code', v_room.code,
    'host_id', v_room.host_id,
    'status', v_room.status,
    'max_players', v_room.max_players,
    'rounds_per_player', v_room.rounds_per_player,
    'difficulty', v_room.difficulty,
    'current_round', v_room.current_round,
    'current_seat', v_room.current_seat,
    'current_player_id', (
      select rp.player_id from public.room_players rp
      where rp.room_id = p_room and rp.seat = v_room.current_seat and rp.left_at is null
    ),
    'players', (
      select coalesce(json_agg(row_to_json(t) order by t.seat), '[]'::json)
      from (
        select rp.player_id, rp.seat, rp.score, rp.rounds_done, rp.is_ready,
               rp.is_connected, (rp.left_at is not null) as has_left,
               p.nickname, p.avatar_id
        from public.room_players rp
        join public.profiles p on p.id = rp.player_id
        where rp.room_id = p_room
      ) t
    ),
    'rounds', (
      select coalesce(json_agg(row_to_json(r) order by r.round_no, r.seat), '[]'::json)
      from (
        select rr.round_no, rr.seat, rr.player_id, rr.score, rr.busted,
               (rr.finished_at is not null) as finished
        from public.room_rounds rr
        where rr.room_id = p_room
      ) r
    )
  );
end
$$;

-- Lejárt szobák takarítása (pg_cron-nal hívható, vagy Edge Functionből)
create or replace function public.cleanup_expired_rooms()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  with upd as (
    update public.rooms
    set status = 'cancelled', finished_at = now()
    where status in ('lobby', 'playing') and expires_at < now()
    returning 1
  )
  select count(*) into v_n from upd;
  return v_n;
end
$$;
