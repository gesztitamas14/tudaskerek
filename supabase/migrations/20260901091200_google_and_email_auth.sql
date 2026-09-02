-- 0013 – Google és e-mail bejelentkezés, vendégfiók átalakítása
--
-- Az Apple bejelentkezés kikerült a projektből: fizetős Apple Developer
-- tagságot (99 USD/év) és egy félévente cserélendő, `.p8` kulccsal aláírt
-- titkot igényel. Helyette Google OAuth (ingyenes Client ID + Secret) és
-- e-mail + jelszó.
--
-- ITT EGY VALÓDI HIBÁT IS JAVÍTUNK:
--
-- A `profiles.is_anonymous` mezőt eddig CSAK az `auth.users` beszúrásakor
-- futó trigger állította be. Ha egy vendég később e-mailt és jelszót ad meg
-- (ugyanaz a felhasználó marad, csak már nem névtelen), a profil
-- `is_anonymous` mezője `true` maradt volna – és mivel a `leaderboard()`
-- kizárja a vendégeket, az illető ÖRÖKRE kimaradt volna a ranglistából,
-- pedig már rendes fiókja van.
--
-- Ezért az `auth.users` frissítésére is kell trigger.

create or replace function public.tg_auth_user_updated()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_anon boolean;
begin
  -- Védekező kiértékelés: ne bízzunk egyetlen jelzésre.
  --   * `is_anonymous` az, amit a GoTrue állít,
  --   * de ha van e-mail, a fiók biztosan nem névtelen.
  v_anon := coalesce(new.is_anonymous, false) and new.email is null;

  update public.profiles p
  set is_anonymous = v_anon
  where p.id = new.id and p.is_anonymous <> v_anon;

  return new;
end
$$;

comment on function public.tg_auth_user_updated() is
  'A profiles.is_anonymous szinkronban tartása, ha egy vendégfiók igazi fiókká alakul (e-mail + jelszó megadása). Enélkül az illető örökre kimaradna a ranglistából.';

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update on auth.users
  for each row execute function public.tg_auth_user_updated();

-- Meglévő adat helyretétele: ha valakinek már van e-mailje, de a profilja
-- vendégként van jelölve, javítsuk. (Új projektben ez nulla sort érint.)
update public.profiles p
set is_anonymous = false
where p.is_anonymous
  and exists (select 1 from auth.users u where u.id = p.id and u.email is not null);
