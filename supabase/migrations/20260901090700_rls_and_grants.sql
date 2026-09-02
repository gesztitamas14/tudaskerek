-- 0008 – Row Level Security és jogosultságok
--
-- Alapelv: a kliens (anon/authenticated) közvetlenül SEMMIT nem ír, és a
-- `questions` táblát közvetlenül nem is olvassa. Minden művelet RPC-n megy,
-- ami SECURITY DEFINER és maga ellenőrzi a jogosultságot. Így a helyes válasz
-- nem szivároghat ki, és a pontszám nem hamisítható.

-- ─────────────────── RLS bekapcsolása mindenhol ───────────────────

alter table public.categories             enable row level security;
alter table public.questions              enable row level security;
alter table public.question_stats         enable row level security;
alter table public.question_packs         enable row level security;
alter table public.scoring_rules          enable row level security;
alter table public.profiles               enable row level security;
alter table public.game_sessions          enable row level security;
alter table public.session_questions      enable row level security;
alter table public.player_question_history enable row level security;
alter table public.game_results           enable row level security;
alter table public.question_candidates    enable row level security;
alter table public.generation_batches     enable row level security;
alter table public.rooms                  enable row level security;
alter table public.room_players           enable row level security;
alter table public.room_rounds            enable row level security;

-- ───────────────────────── kategóriák ─────────────────────────
-- Olvasás mindenkinek (ez publikus tartalom), írás csak adminnak.

drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories
  for select to anon, authenticated
  using (is_active or public.current_role_is('moderator'));

drop policy if exists categories_admin_write on public.categories;
create policy categories_admin_write on public.categories
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ─────────────────────────── kérdések ──────────────────────────
-- FONTOS: a `questions` táblára NINCS select policy anon/authenticated
-- számára. A játékos a `questions_public` nézetet és az RPC-ket használja.
-- Moderátor/admin viszont teljes hozzáférést kap (admin felület).

drop policy if exists questions_moderator_read on public.questions;
create policy questions_moderator_read on public.questions
  for select to authenticated
  using (public.current_role_is('moderator'));

drop policy if exists questions_admin_write on public.questions;
create policy questions_admin_write on public.questions
  for all to authenticated
  using (public.current_role_is('moderator'))
  with check (public.current_role_is('moderator'));

-- ────────────────────── kérdésstatisztika ──────────────────────

drop policy if exists question_stats_moderator_read on public.question_stats;
create policy question_stats_moderator_read on public.question_stats
  for select to authenticated
  using (public.current_role_is('moderator'));

-- ───────────────────── csomagok, pontozás ──────────────────────

drop policy if exists packs_read on public.question_packs;
create policy packs_read on public.question_packs
  for select to anon, authenticated using (is_active);

drop policy if exists packs_admin_write on public.question_packs;
create policy packs_admin_write on public.question_packs
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists scoring_read on public.scoring_rules;
create policy scoring_read on public.scoring_rules
  for select to anon, authenticated using (true);

drop policy if exists scoring_admin_write on public.scoring_rules;
create policy scoring_admin_write on public.scoring_rules
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ─────────────────────────── profilok ──────────────────────────
-- A becenév és avatar publikus (ranglista), a többi mező is olvasható,
-- de érzékeny adat nincs a táblában. Írni csak a sajátját lehet, és a
-- `role` mezőt a játékos nem állíthatja.

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to anon, authenticated using (true);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    -- szerepkör-emelés tiltása: csak akkor engedjük az UPDATE-et, ha a role
    -- változatlan marad az adatbázisban tárolt értékhez képest
    and role = (select p.role from public.profiles p where p.id = auth.uid())
  );

drop policy if exists profiles_admin_write on public.profiles;
create policy profiles_admin_write on public.profiles
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ───────────────────── játék: csak a sajátját ─────────────────────

drop policy if exists sessions_read_own on public.game_sessions;
create policy sessions_read_own on public.game_sessions
  for select to authenticated
  using (player_id = auth.uid() or public.current_role_is('moderator'));

drop policy if exists session_questions_read_own on public.session_questions;
create policy session_questions_read_own on public.session_questions
  for select to authenticated
  using (exists (
    select 1 from public.game_sessions gs
    where gs.id = session_id and (gs.player_id = auth.uid() or public.current_role_is('moderator'))
  ));

drop policy if exists pqh_read_own on public.player_question_history;
create policy pqh_read_own on public.player_question_history
  for select to authenticated using (player_id = auth.uid());

drop policy if exists results_read on public.game_results;
create policy results_read on public.game_results
  for select to authenticated
  using (player_id = auth.uid() or public.current_role_is('moderator'));

-- Írás egyik játéktáblába sem közvetlenül – csak RPC-n (SECURITY DEFINER).

-- ─────────────────────── AI jelöltek ───────────────────────

drop policy if exists candidates_moderator_all on public.question_candidates;
create policy candidates_moderator_all on public.question_candidates
  for all to authenticated
  using (public.current_role_is('moderator'))
  with check (public.current_role_is('moderator'));

drop policy if exists batches_moderator_all on public.generation_batches;
create policy batches_moderator_all on public.generation_batches
  for all to authenticated
  using (public.current_role_is('moderator'))
  with check (public.current_role_is('moderator'));

-- ─────────────────────── multiplayer ───────────────────────
-- A Realtime `postgres_changes` betartja az RLS-t, ezért a szobatagoknak
-- SELECT jogot adunk a saját szobájuk soraira – így élőben látják a
-- pontszámokat és a kör állapotát, írni viszont csak RPC-n tudnak.

drop policy if exists rooms_read_member on public.rooms;
create policy rooms_read_member on public.rooms
  for select to authenticated
  using (
    host_id = auth.uid()
    or exists (
      select 1 from public.room_players rp
      where rp.room_id = id and rp.player_id = auth.uid()
    )
    or public.current_role_is('moderator')
  );

drop policy if exists room_players_read_member on public.room_players;
create policy room_players_read_member on public.room_players
  for select to authenticated
  using (
    player_id = auth.uid()
    or exists (
      select 1 from public.room_players me
      where me.room_id = room_players.room_id and me.player_id = auth.uid()
    )
    or public.current_role_is('moderator')
  );

drop policy if exists room_rounds_read_member on public.room_rounds;
create policy room_rounds_read_member on public.room_rounds
  for select to authenticated
  using (
    exists (
      select 1 from public.room_players rp
      where rp.room_id = room_rounds.room_id and rp.player_id = auth.uid()
    )
    or public.current_role_is('moderator')
  );

-- ──────────────────────── GRANT-ok ────────────────────────
-- A táblákra alapból nem adunk semmit a kliens role-oknak; a PostgREST-en
-- keresztül elérhető felület a nézetek és az RPC-k.

revoke all on all tables in schema public from anon, authenticated;

-- Nézetek: publikus olvasás
grant select on public.questions_public   to anon, authenticated;
grant select on public.categories_public  to anon, authenticated;
grant select on public.category_stats     to anon, authenticated;

-- Táblák, amiket RLS mellett közvetlenül is olvashat a kliens
grant select on public.categories     to anon, authenticated;
grant select on public.scoring_rules  to anon, authenticated;
grant select on public.question_packs to anon, authenticated;
grant select on public.profiles        to anon, authenticated;
grant update (nickname, avatar_id, country) on public.profiles to authenticated;
grant select on public.game_sessions      to authenticated;
grant select on public.session_questions  to authenticated;
grant select on public.game_results       to authenticated;
grant select on public.rooms               to authenticated;
grant select on public.room_players        to authenticated;
grant select on public.room_rounds         to authenticated;

-- Admin felület (moderátor/admin JWT-vel, RLS dönt)
grant select, insert, update, delete on public.questions             to authenticated;
grant select, insert, update, delete on public.question_candidates   to authenticated;
grant select, insert, update, delete on public.generation_batches    to authenticated;
grant select                        on public.question_stats         to authenticated;

-- RPC-k
grant execute on function public.active_scoring_rules()                       to anon, authenticated;
grant execute on function public.offline_pack(integer, timestamptz)           to anon, authenticated;
grant execute on function public.leaderboard(text, integer)                   to anon, authenticated;
grant execute on function public.attributions()                               to anon, authenticated;
grant execute on function public.start_session(text, uuid, text)              to authenticated;
grant execute on function public.next_question(uuid, text, text, integer)     to authenticated;
grant execute on function public.submit_answer(uuid, uuid, smallint, integer) to authenticated;
grant execute on function public.finalize_session(uuid)                       to authenticated;
grant execute on function public.submit_offline_result(integer, smallint, smallint, boolean, timestamptz, uuid) to authenticated;
grant execute on function public.my_stats()                                   to authenticated;
grant execute on function public.my_rank(text)                                to authenticated;
grant execute on function public.report_question(uuid, text)                  to authenticated;
grant execute on function public.create_room(smallint, smallint, text)        to authenticated;
grant execute on function public.join_room(text)                              to authenticated;
grant execute on function public.leave_room(uuid)                             to authenticated;
grant execute on function public.set_ready(uuid, boolean)                     to authenticated;
grant execute on function public.start_room(uuid)                             to authenticated;
grant execute on function public.begin_turn(uuid)                             to authenticated;
grant execute on function public.end_turn(uuid, uuid)                         to authenticated;
grant execute on function public.room_state(uuid)                             to authenticated;

-- Moderátor/admin RPC-k (a függvény maga ellenőrzi a szerepkört)
grant execute on function public.check_question_duplicates(text, text, text[], text, double precision, integer) to authenticated;
grant execute on function public.approve_candidate(uuid, text, boolean)       to authenticated;
grant execute on function public.reject_candidate(uuid, text)                 to authenticated;
grant execute on function public.approve_clean_candidates(uuid, integer)      to authenticated;
grant execute on function public.review_queue(text, text, integer, integer)   to authenticated;

-- Belső segédfüggvények: nem hívhatók kívülről
revoke execute on function public.advance_room_turn(uuid)      from anon, authenticated;
revoke execute on function public.generate_room_code()         from anon, authenticated;
revoke execute on function public.cleanup_expired_rooms()      from anon, authenticated;

-- ─────────────── Realtime publikáció a multiplayerhez ───────────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.rooms;
    alter publication supabase_realtime add table public.room_players;
    alter publication supabase_realtime add table public.room_rounds;
  end if;
exception when duplicate_object then null;
end
$$;

-- A REPLICA IDENTITY FULL kell ahhoz, hogy a Realtime a régi értékeket is
-- lássa (szűréshez és törléshez).
alter table public.rooms        replica identity full;
alter table public.room_players replica identity full;
alter table public.room_rounds  replica identity full;
