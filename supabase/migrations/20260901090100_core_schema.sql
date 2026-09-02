-- 0002 – kategóriák, kérdések, statisztika, pontozási szabályok

-- ─────────────────────────── enumok ───────────────────────────

do $$ begin
  create type public.difficulty as enum ('easy', 'medium', 'hard');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.question_provenance as enum (
    'handwritten',   -- ember írta
    'ai_generated',  -- LLM generálta, ember hagyta jóvá
    'wikidata',      -- Wikidata SPARQL sablonból (CC0)
    'opentdb',       -- Open Trivia DB import (CC BY-SA 4.0!)
    'import'         -- egyéb tömeges import
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.candidate_status as enum (
    'generated', 'pending_review', 'approved', 'rejected', 'flagged'
  );
exception when duplicate_object then null; end $$;

-- ───────────────── válaszhalmaz kanonikus hash ─────────────────
-- Külön IMMUTABLE függvény, mert generált oszlop kifejezésében nem lehet
-- közvetlenül subquery, függvényhívásban viszont igen.

create or replace function public.answer_set_hash(a text, b text, c text, d text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select md5(string_agg(v, '|' order by v))
  from unnest(array[
    public.norm_text(a), public.norm_text(b),
    public.norm_text(c), public.norm_text(d)
  ]) as t(v)
$$;

comment on function public.answer_set_hash(text, text, text, text) is
  'Sorrendfüggetlen hash a négy válasz normalizált alakjából – „azonos válaszok” duplikátumszűréshez.';

-- ─────────────────────── kérdéscsomagok ───────────────────────
-- Monetizáció-előkészítés: NULL pack_id = ingyenes alaptartalom.

create table if not exists public.question_packs (
  id           uuid primary key default extensions.gen_random_uuid(),
  slug         text not null unique,
  name         text not null,
  description  text,
  is_premium   boolean not null default false,
  product_id   text,                     -- StoreKit product identifier (később)
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

-- ───────────────────────── kategóriák ─────────────────────────

create table if not exists public.categories (
  id           uuid primary key default extensions.gen_random_uuid(),
  slug         text not null unique,
  name         text not null,
  description  text,
  icon         text not null default 'questionmark.circle',  -- SF Symbol név
  color        text not null default '#7C5CFF',              -- hex, a kerék cikkéhez
  is_hungarian boolean not null default false,               -- magyar fókuszú kategória
  is_active    boolean not null default true,
  sort_order   integer not null default 100,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint categories_color_hex check (color ~ '^#[0-9A-Fa-f]{6}$'),
  constraint categories_slug_format check (slug ~ '^[a-z0-9-]+$')
);

create index if not exists categories_active_sort_idx
  on public.categories (is_active, sort_order);

-- ─────────────────────────── kérdések ──────────────────────────

create table if not exists public.questions (
  id             uuid primary key default extensions.gen_random_uuid(),
  category_id    uuid not null references public.categories (id) on delete restrict,
  pack_id        uuid references public.question_packs (id) on delete set null,

  question_text  text not null,
  answer_a       text not null,
  answer_b       text not null,
  answer_c       text not null,
  answer_d       text not null,
  -- 0 = answer_a, 1 = answer_b, 2 = answer_c, 3 = answer_d
  correct_answer smallint not null,

  difficulty     public.difficulty not null default 'medium',
  explanation    text,
  source         text,                    -- ellenőrizhető hivatkozás (URL vagy Wikidata Q-id)
  language       text not null default 'hu',
  license        text,                    -- csak ha a forrás megkötést tesz (pl. CC-BY-SA-4.0)
  provenance     public.question_provenance not null default 'handwritten',
  topic          text,                    -- finomabb témakör a kategórián belül
  min_age        smallint,                -- gyerek-változat előkészítése

  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- Kanonikus alakok deduplikációhoz (generált, mindig szinkronban)
  norm_question    text   generated always as (public.norm_text(question_text)) stored,
  answers          text[] generated always as (
                     array[answer_a, answer_b, answer_c, answer_d]
                   ) stored,
  answer_set_hash  text   generated always as (
                     public.answer_set_hash(answer_a, answer_b, answer_c, answer_d)
                   ) stored,

  constraint questions_correct_range check (correct_answer between 0 and 3),
  constraint questions_text_len check (char_length(question_text) between 8 and 400),
  constraint questions_answers_nonempty check (
    btrim(answer_a) <> '' and btrim(answer_b) <> '' and
    btrim(answer_c) <> '' and btrim(answer_d) <> ''
  ),
  -- A négy válasz normalizált alakja legyen páronként különböző
  -- (CHECK-ben nem lehet subquery, ezért kifejtve.)
  constraint questions_answers_distinct check (
    public.norm_text(answer_a) is distinct from public.norm_text(answer_b) and
    public.norm_text(answer_a) is distinct from public.norm_text(answer_c) and
    public.norm_text(answer_a) is distinct from public.norm_text(answer_d) and
    public.norm_text(answer_b) is distinct from public.norm_text(answer_c) and
    public.norm_text(answer_b) is distinct from public.norm_text(answer_d) and
    public.norm_text(answer_c) is distinct from public.norm_text(answer_d)
  )
);

create unique index if not exists questions_norm_unique
  on public.questions (category_id, norm_question);

create index if not exists questions_trgm_idx
  on public.questions using gin (norm_question extensions.gin_trgm_ops);

create index if not exists questions_pick_idx
  on public.questions (category_id, difficulty, is_active)
  where is_active;

create index if not exists questions_answer_set_idx
  on public.questions (category_id, answer_set_hash);

create index if not exists questions_fts_idx
  on public.questions using gin (
    to_tsvector('public.hungarian_unaccent', question_text)
  );

create index if not exists questions_pack_idx
  on public.questions (pack_id) where pack_id is not null;

-- ──────────────────────── kérdésstatisztika ─────────────────────

create table if not exists public.question_stats (
  question_id        uuid primary key references public.questions (id) on delete cascade,
  times_answered     bigint not null default 0,
  times_correct      bigint not null default 0,
  total_answer_ms    bigint not null default 0,
  times_reported     integer not null default 0,     -- játékos jelentette hibásnak
  last_answered_at   timestamptz,
  -- Származtatott mutatók a kiválasztáshoz és a nehézség-kalibrációhoz
  correct_ratio      double precision generated always as (
                       case when times_answered = 0 then null
                            else times_correct::double precision / times_answered end
                     ) stored,
  average_answer_ms  integer generated always as (
                       case when times_answered = 0 then null
                            else (total_answer_ms / times_answered)::integer end
                     ) stored
);

create index if not exists question_stats_ratio_idx
  on public.question_stats (correct_ratio);

-- Minden új kérdéshez automatikusan statisztika-sor
create or replace function public.tg_questions_ensure_stats()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.question_stats (question_id)
  values (new.id)
  on conflict (question_id) do nothing;
  return new;
end
$$;

drop trigger if exists questions_ensure_stats on public.questions;
create trigger questions_ensure_stats
  after insert on public.questions
  for each row execute function public.tg_questions_ensure_stats();

-- ─────────────────────── updated_at trigger ─────────────────────

create or replace function public.tg_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists categories_touch on public.categories;
create trigger categories_touch before update on public.categories
  for each row execute function public.tg_touch_updated_at();

drop trigger if exists questions_touch on public.questions;
create trigger questions_touch before update on public.questions
  for each row execute function public.tg_touch_updated_at();

-- ───────────────────── pontozási szabályok ──────────────────────
-- Backendről vezérelt, verziózott. A kliens a legfrissebb aktív sort kéri le és
-- lokálisan cache-eli; ha nincs kapcsolat, a beépített fallback lép be.

create table if not exists public.scoring_rules (
  id                 uuid primary key default extensions.gen_random_uuid(),
  version            integer not null unique,
  max_questions      smallint not null default 10,
  -- reward_table[i] = az i. helyes válasz jutalma (1-alapú tömbindex)
  reward_table       integer[] not null,
  -- hibás válasz esetén a kör pontja * penalty_multiplier (lefelé kerekítve)
  penalty_multiplier double precision not null default 0.5,
  -- lehet-e a kör közepén megállni és bankolni
  allow_bank         boolean not null default true,
  -- opcionális időlimit kérdésenként (másodperc); NULL = nincs
  time_limit_seconds smallint,
  is_active          boolean not null default false,
  notes              text,
  created_at         timestamptz not null default now(),
  constraint scoring_rules_table_len check (cardinality(reward_table) = max_questions),
  constraint scoring_rules_penalty check (penalty_multiplier >= 0 and penalty_multiplier <= 1)
);

-- Egyszerre csak egy aktív szabálykészlet lehet
create unique index if not exists scoring_rules_single_active
  on public.scoring_rules ((is_active)) where is_active;

insert into public.scoring_rules
  (version, max_questions, reward_table, penalty_multiplier, is_active, notes)
values (
  1, 10,
  array[1000, 1000, 1000, 1000, 2000, 1000, 1000, 1000, 1000, 5000],
  0.5, true,
  'MVP alapszabály: 1-4. és 6-9. kérdés 1000, 5. kérdés 2000, 10. kérdés 5000 pont.'
)
on conflict (version) do nothing;
