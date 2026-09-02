-- 0003 – profilok, szerepkörök

do $$ begin
  create type public.user_role as enum ('player', 'moderator', 'admin');
exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  nickname       text not null,
  avatar_id      text not null default 'fox',   -- beépített avatar-készlet azonosítója
  role           public.user_role not null default 'player',
  is_anonymous   boolean not null default false,
  country        text,
  -- Aggregált statisztika (trigger tartja karban, hogy a profil egy lekérés legyen)
  total_score        bigint  not null default 0,
  best_round_score   integer not null default 0,
  games_played       integer not null default 0,
  questions_answered integer not null default 0,
  questions_correct  integer not null default 0,
  longest_streak     integer not null default 0,
  banned_until       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint profiles_nickname_len check (char_length(btrim(nickname)) between 2 and 24),
  constraint profiles_nickname_chars check (nickname !~ '[\x00-\x1F]')
);

-- Becenév egyediség kis-nagybetű és ékezet függetlenül
create unique index if not exists profiles_nickname_unique
  on public.profiles (public.norm_text(nickname));

create index if not exists profiles_total_score_idx
  on public.profiles (total_score desc);

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.tg_touch_updated_at();

-- ─────────────── automatikus profil új usernek ───────────────
-- Apple Sign In esetén a display name a `raw_user_meta_data`-ban jöhet;
-- ha nincs, generálunk egy szabad becenevet („Játékos1234”).

create or replace function public.tg_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base  text;
  v_try   text;
  v_i     integer := 0;
begin
  v_base := nullif(btrim(coalesce(
    new.raw_user_meta_data ->> 'nickname',
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name'
  )), '');

  if v_base is null or char_length(v_base) < 2 then
    v_base := 'Játékos';
  end if;
  v_base := left(v_base, 18);

  v_try := v_base;
  loop
    begin
      insert into public.profiles (id, nickname, is_anonymous)
      values (
        new.id,
        v_try,
        coalesce((new.raw_user_meta_data ->> 'is_anonymous')::boolean, new.email is null)
      );
      exit;
    exception when unique_violation then
      v_i := v_i + 1;
      if v_i > 40 then
        -- végső mentsvár: garantáltan egyedi
        v_try := v_base || '-' || left(replace(new.id::text, '-', ''), 6);
      else
        v_try := v_base || (1000 + floor(random() * 9000))::int::text;
      end if;
    end;
  end loop;

  return new;
end
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.tg_auth_user_created();

-- ────────────────────── segédfüggvények ─────────────────────

create or replace function public.current_role_is(p_min public.user_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and (
        p.role = 'admin'
        or (p_min = 'moderator' and p.role in ('moderator', 'admin'))
        or (p_min = 'player')
      )
  )
$$;

comment on function public.current_role_is(public.user_role) is
  'Igaz, ha a bejelentkezett user szerepköre legalább a megadott szint.';

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  )
$$;
