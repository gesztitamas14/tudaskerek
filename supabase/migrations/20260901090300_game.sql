-- 0004 – játékmenet: sessionök, kiszolgált kérdések, eredmények

do $$ begin
  create type public.game_mode as enum ('single', 'multiplayer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.session_status as enum ('active', 'banked', 'busted', 'completed', 'abandoned');
exception when duplicate_object then null; end $$;

-- ───────────────────────── session ──────────────────────────

create table if not exists public.game_sessions (
  id               uuid primary key default extensions.gen_random_uuid(),
  player_id        uuid not null references public.profiles (id) on delete cascade,
  mode             public.game_mode not null default 'single',
  room_id          uuid,                    -- FK-t a multiplayer migráció adja hozzá
  scoring_version  integer not null references public.scoring_rules (version),
  status           public.session_status not null default 'active',
  banked_score     integer not null default 0,
  questions_served integer not null default 0,
  correct_count    integer not null default 0,
  -- true, ha minden válasz szerveroldalon lett validálva (offline körnél false)
  is_trusted       boolean not null default true,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  client_version   text,
  constraint game_sessions_scores_nonneg check (banked_score >= 0)
);

create index if not exists game_sessions_player_idx
  on public.game_sessions (player_id, started_at desc);

create index if not exists game_sessions_active_idx
  on public.game_sessions (player_id) where status = 'active';

-- ─────────────── a sessionben kiszolgált kérdések ───────────────
-- Ez a tábla egyszerre naplózás és „ebben a körben ne jöjjön újra” garancia.

create table if not exists public.session_questions (
  session_id      uuid not null references public.game_sessions (id) on delete cascade,
  question_id     uuid not null references public.questions (id) on delete cascade,
  ordinal        smallint not null,
  category_id     uuid not null references public.categories (id) on delete restrict,
  served_at       timestamptz not null default now(),
  answered_at     timestamptz,
  selected_answer smallint,
  is_correct      boolean,
  answer_ms       integer,
  awarded_points  integer,
  primary key (session_id, question_id),
  constraint session_questions_position_range check (ordinal between 1 and 50),
  constraint session_questions_selected_range check (
    selected_answer is null or selected_answer between 0 and 3
  )
);

create unique index if not exists session_questions_position_unique
  on public.session_questions (session_id, ordinal);

-- ─────────── a játékos kérdés-előtörténete (ismétlés elleni) ───────────

create table if not exists public.player_question_history (
  player_id    uuid not null references public.profiles (id) on delete cascade,
  question_id  uuid not null references public.questions (id) on delete cascade,
  times_seen   integer not null default 1,
  last_seen_at timestamptz not null default now(),
  primary key (player_id, question_id)
);

create index if not exists player_question_history_recent_idx
  on public.player_question_history (player_id, last_seen_at desc);

-- ───────────────────── végleges eredmények ──────────────────────

create table if not exists public.game_results (
  id            uuid primary key default extensions.gen_random_uuid(),
  player_id     uuid not null references public.profiles (id) on delete cascade,
  session_id    uuid unique references public.game_sessions (id) on delete set null,
  mode          public.game_mode not null default 'single',
  score         integer not null,
  questions     smallint not null,
  correct       smallint not null,
  busted        boolean not null default false,   -- rossz válasszal ért véget
  is_trusted    boolean not null default true,
  created_at    timestamptz not null default now(),
  -- Rangsor-partíciók. Nem generált oszlop: az `at time zone` és a
  -- `to_char(timestamptz, …)` STABLE, nem IMMUTABLE, ezért generált oszlopban
  -- nem használható. Trigger tölti ki, mindig a created_at-ből.
  day_key       date not null default current_date,
  week_key      text not null default '',
  month_key     text not null default '',
  constraint game_results_score_nonneg check (score >= 0),
  constraint game_results_counts check (correct <= questions)
);

create or replace function public.tg_game_results_keys()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_local timestamp := new.created_at at time zone 'UTC';
begin
  new.day_key   := v_local::date;
  new.week_key  := to_char(v_local, 'IYYY-"W"IW');
  new.month_key := to_char(v_local, 'YYYY-MM');
  return new;
end
$$;

drop trigger if exists game_results_keys on public.game_results;
create trigger game_results_keys
  before insert or update of created_at on public.game_results
  for each row execute function public.tg_game_results_keys();

create index if not exists game_results_player_idx
  on public.game_results (player_id, created_at desc);

create index if not exists game_results_alltime_idx
  on public.game_results (score desc) where is_trusted;

create index if not exists game_results_week_idx
  on public.game_results (week_key, score desc) where is_trusted;

create index if not exists game_results_month_idx
  on public.game_results (month_key, score desc) where is_trusted;

-- ─────────── profil-aggregátumok karbantartása eredményből ───────────

create or replace function public.tg_game_results_aggregate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles p
  set total_score        = p.total_score + new.score,
      best_round_score   = greatest(p.best_round_score, new.score),
      games_played       = p.games_played + 1,
      questions_answered = p.questions_answered + new.questions,
      questions_correct  = p.questions_correct + new.correct
  where p.id = new.player_id;
  return new;
end
$$;

drop trigger if exists game_results_aggregate on public.game_results;
create trigger game_results_aggregate
  after insert on public.game_results
  for each row execute function public.tg_game_results_aggregate();
