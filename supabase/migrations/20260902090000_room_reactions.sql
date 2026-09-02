-- Játék közbeni rövid megjegyzések („beszólások”) a szobában.
--
-- MIÉRT ELŐRE MEGÍRT SZÖVEG, ÉS MIÉRT NEM SZABAD CHAT?
-- Mert egy szabad szöveges csatorna három dolgot hozna magával, amit itt nem
-- akarunk: (1) a helyes válasz bekiabálását, (2) moderálási kötelezettséget,
-- (3) egy újabb felületet, amin keresztül tartalmat lehet másokhoz eljuttatni.
-- Ezért a kliens NEM szöveget küld, hanem egy azonosítót, és a szöveg
-- kizárólag itt, a szerveren van tárolva. Amit a katalógus nem tartalmaz, azt
-- nem lehet elküldeni.

create table if not exists public.reaction_catalog (
  id          text primary key,
  body        text not null,
  emoji       text not null default '💬',
  sort_order  int  not null default 100,
  is_active   boolean not null default true
);

alter table public.reaction_catalog enable row level security;

-- A katalógus olvasható: a kliensnek meg kell tudnia jeleníteni a listát.
drop policy if exists reaction_catalog_read on public.reaction_catalog;
create policy reaction_catalog_read on public.reaction_catalog
  for select to authenticated using (is_active);

grant select on public.reaction_catalog to authenticated;

insert into public.reaction_catalog (id, body, emoji, sort_order) values
  ('gg',        'Ez nagyon jó volt!',            '👏', 10),
  ('close',     'Ez majdnem sikerült…',          '😅', 20),
  ('lucky',     'Csak tippeltem, bevallom.',     '🍀', 30),
  ('hard',      'Ez most kifogott rajtam.',      '🤯', 40),
  ('easy',      'Ezt még én is tudtam!',         '😎', 50),
  ('hurry',     'Gyerünk, ketyeg az óra!',       '⏳', 60),
  ('respect',   'Le a kalappal.',                '🎩', 70),
  ('rematch',   'Visszavágót kérek!',            '🔁', 80),
  ('oops',      'Rossz gombra nyomtam…',         '🙈', 90),
  ('watching',  'Nézőként is izgulok.',          '🍿', 100),
  ('almost',    'Egy hajszál választott el.',    '💥', 110),
  ('nice-cat',  'Jó kategória jött ki!',         '🎯', 120)
on conflict (id) do update
  set body = excluded.body,
      emoji = excluded.emoji,
      sort_order = excluded.sort_order,
      is_active = true;

create table if not exists public.room_reactions (
  id          bigserial primary key,
  room_id     uuid not null references public.rooms(id) on delete cascade,
  player_id   uuid not null references public.profiles(id) on delete cascade,
  reaction_id text not null references public.reaction_catalog(id),
  created_at  timestamptz not null default now()
);

create index if not exists room_reactions_room_time
  on public.room_reactions (room_id, created_at desc);

alter table public.room_reactions enable row level security;
-- Nincs sem policy, sem grant: kizárólag a lenti SECURITY DEFINER függvényeken
-- keresztül lehet írni és olvasni. Így a szűrés (csak a saját szobám, csak a
-- friss üzenetek) nem kerülhető ki.
revoke all on public.room_reactions from authenticated;

-- ── küldés ────────────────────────────────────────────────────────────────
--
-- Csak az küldhet, aki tagja a szobának és a szoba játékban van. Kiesett
-- játékos is küldhet: nézőként is része a társasjátéknak.
--
-- Szándékos szigorítás: 3 másodperc két üzenet között ugyanattól a játékostól.
-- Enélkül egy gyors koppintgatás teleszemetelné mindenki képernyőjét, ami
-- pontosan olyan zavaró, mint a helyes válasz bekiabálása.
create or replace function public.send_room_reaction(p_room uuid, p_reaction text)
returns json
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me     uuid := auth.uid();
  v_status text;
  v_last   timestamptz;
begin
  if v_me is null then
    return json_build_object('ok', false, 'error', 'auth');
  end if;

  select r.status into v_status
  from public.rooms r
  where r.id = p_room;

  if v_status is null then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;

  if not exists (
    select 1 from public.room_players rp
    where rp.room_id = p_room and rp.player_id = v_me and rp.left_at is null
  ) then
    return json_build_object('ok', false, 'error', 'not_in_room');
  end if;

  if v_status <> 'playing' then
    return json_build_object('ok', false, 'error', 'not_playing');
  end if;

  if not exists (
    select 1 from public.reaction_catalog c
    where c.id = p_reaction and c.is_active
  ) then
    -- A kliens csak a katalógusból választhat; ha ide jutunk, az hibás hívás.
    return json_build_object('ok', false, 'error', 'unknown_reaction');
  end if;

  select max(rr.created_at) into v_last
  from public.room_reactions rr
  where rr.room_id = p_room and rr.player_id = v_me;

  if v_last is not null and v_last > now() - interval '3 seconds' then
    return json_build_object('ok', false, 'error', 'too_fast');
  end if;

  insert into public.room_reactions (room_id, player_id, reaction_id)
  values (p_room, v_me, p_reaction);

  return json_build_object('ok', true);
end
$fn$;

revoke all on function public.send_room_reaction(uuid, text) from public;
grant execute on function public.send_room_reaction(uuid, text) to authenticated;

-- ── a szobaállapot kiegészítése ───────────────────────────────────────────
--
-- A friss üzenetek a `room_state()`-be kerülnek, mert a kliens azt amúgy is
-- másodpercenként kérdezi. Így nincs szükség külön csatornára, se realtime
-- előfizetésre.
--
-- Csak a legutóbbi 8 másodperc: ez az üzenet a képernyő tetején pár pillanatra
-- felvillan, nem üzenetfal. Ha valaki épp nem figyelt, az lemaradt róla –
-- ez szándékos, mert a régi üzenetek listázása már chat lenne.
create or replace function public.room_recent_reactions(p_room uuid)
returns json
language sql
security definer
set search_path = public
as $fn$
  select coalesce(json_agg(row_to_json(t) order by t.created_at), '[]'::json)
  from (
    select rr.id,
           rr.player_id,
           p.nickname,
           p.avatar_id,
           c.body,
           c.emoji,
           rr.created_at
    from public.room_reactions rr
    join public.reaction_catalog c on c.id = rr.reaction_id
    join public.profiles p on p.id = rr.player_id
    where rr.room_id = p_room
      and rr.created_at > now() - interval '8 seconds'
    order by rr.created_at
    limit 12
  ) t;
$fn$;

revoke all on function public.room_recent_reactions(uuid) from public;
grant execute on function public.room_recent_reactions(uuid) to authenticated;
