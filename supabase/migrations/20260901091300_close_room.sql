-- 0014 – szoba törlése és a lista „ez az enyém” jelzője
--
-- Eddig a szoba készítője nem tudta megszüntetni a saját szobáját: a
-- `leave_room` kilépteti, és a hostot átadja a következő játékosnak. Ha viszont
-- valaki csak elrontotta a beállításokat (rossz PIN, rossz körszám), akkor a
-- félbehagyott szoba két órán át ott lóg a nyitott szobák listáján.
--
-- Ezért kell egy explicit `close_room()`, és a listának meg kell mondania, hogy
-- melyik szobát láthatja törölhetőnek a hívó.

create or replace function public.close_room(p_room uuid)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
begin
  if auth.uid() is null then
    raise exception 'Bejelentkezés szükséges' using errcode = '42501';
  end if;

  select * into v_room from public.rooms where id = p_room for update;

  if v_room.id is null then
    return json_build_object('ok', true, 'already_closed', true);
  end if;

  -- Csak a szoba készítője (vagy admin) zárhatja be. Nem elég a
  -- felületen elrejteni a gombot.
  if v_room.host_id <> auth.uid() and not public.is_admin() then
    raise exception 'Csak a szoba létrehozója zárhatja be' using errcode = '42501';
  end if;

  if v_room.status in ('finished', 'cancelled') then
    return json_build_object('ok', true, 'already_closed', true);
  end if;

  update public.rooms
  set status = 'cancelled', finished_at = now()
  where id = p_room;

  -- A többi játékos kliense a következő pollozásnál látja a `cancelled`
  -- állapotot, és kiírja, hogy a szoba bezárt.
  return json_build_object('ok', true, 'already_closed', false);
end
$$;

comment on function public.close_room(uuid) is
  'A szoba bezárása (státusz: cancelled). Csak a készítő vagy admin hívhatja. Ezzel eltűnik a nyitott szobák listájáról.';

grant execute on function public.close_room(uuid) to authenticated;

-- ─────────── a lista jelezze, melyik szoba a hívóé ───────────

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
          (r.host_id = auth.uid())                       as i_am_host,
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
  'Nyitott (lobby) szobák a csatlakozáshoz. A join_pin SOHA nem kerül a válaszba – csak a needs_pin jelző. Az i_am_host megmondja, melyiket zárhatja be a hívó.';
