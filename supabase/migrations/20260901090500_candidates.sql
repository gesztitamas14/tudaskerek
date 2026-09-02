-- 0006 – AI-generált kérdésjelöltek és review folyamat
--
-- Kulcsszabály: generált kérdés SOHA nem kerülhet közvetlenül a `questions`
-- táblába. Ezt nem csak konvenció tartja: külön tábla, külön RLS, és a
-- production táblába csak az `approve_candidate()` SECURITY DEFINER függvény ír,
-- ami admin/moderátor szerepkört követel.

create table if not exists public.generation_batches (
  id            uuid primary key default extensions.gen_random_uuid(),
  category_id   uuid references public.categories (id) on delete set null,
  topic         text,
  requested     integer not null default 0,
  model         text,
  prompt_hash   text,
  created_by    uuid references public.profiles (id) on delete set null,
  notes         text,
  created_at    timestamptz not null default now()
);

create table if not exists public.question_candidates (
  id             uuid primary key default extensions.gen_random_uuid(),
  batch_id       uuid references public.generation_batches (id) on delete set null,
  category_id    uuid not null references public.categories (id) on delete restrict,

  question_text  text not null,
  answer_a       text not null,
  answer_b       text not null,
  answer_c       text not null,
  answer_d       text not null,
  correct_answer smallint not null,
  difficulty     public.difficulty not null default 'medium',
  explanation    text,
  source         text,
  language       text not null default 'hu',
  topic          text,
  provenance     public.question_provenance not null default 'ai_generated',
  license        text,

  status         public.candidate_status not null default 'pending_review',
  -- Automatikus ellenőrzések eredménye (formai, Wikidata, LLM cross-check)
  validation     jsonb not null default '{}'::jsonb,
  -- Talált duplikátumok: [{kind, question_id, similarity}]
  duplicates     jsonb not null default '[]'::jsonb,
  -- 0..1 automatikus minőségpontszám, a review sor rendezéséhez
  quality_score  double precision,

  reviewed_by    uuid references public.profiles (id) on delete set null,
  reviewed_at    timestamptz,
  review_note    text,
  published_question_id uuid references public.questions (id) on delete set null,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  norm_question  text generated always as (public.norm_text(question_text)) stored,

  constraint qc_correct_range check (correct_answer between 0 and 3),
  constraint qc_text_len check (char_length(question_text) between 8 and 400)
);

create index if not exists qc_status_idx
  on public.question_candidates (status, quality_score desc nulls last, created_at);

create index if not exists qc_category_idx
  on public.question_candidates (category_id, status);

create index if not exists qc_batch_idx
  on public.question_candidates (batch_id);

-- Batch-en belüli önduplikáció kizárása
create unique index if not exists qc_norm_unique
  on public.question_candidates (category_id, norm_question)
  where status in ('generated', 'pending_review', 'flagged');

create index if not exists qc_trgm_idx
  on public.question_candidates using gin (norm_question extensions.gin_trgm_ops);

drop trigger if exists qc_touch on public.question_candidates;
create trigger qc_touch before update on public.question_candidates
  for each row execute function public.tg_touch_updated_at();

-- ───────────────── jelölt jóváhagyása / elutasítása ─────────────────

create or replace function public.approve_candidate(
  p_candidate uuid,
  p_note      text default null,
  p_force     boolean default false     -- duplikátum-figyelmeztetés felülbírálása
)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c       public.question_candidates;
  v_slug    text;
  v_dupes   json;
  v_qid     uuid;
  v_blocking integer;
begin
  if not public.current_role_is('moderator') then
    raise exception 'Moderátori jogosultság szükséges' using errcode = '42501';
  end if;

  select * into v_c from public.question_candidates where id = p_candidate for update;
  if v_c.id is null then
    raise exception 'Nincs ilyen jelölt' using errcode = 'no_data_found';
  end if;
  if v_c.status = 'approved' then
    return json_build_object('question_id', v_c.published_question_id, 'already_approved', true);
  end if;

  select slug into v_slug from public.categories where id = v_c.category_id;

  -- Friss duplikátum-ellenőrzés a jóváhagyás pillanatában
  select coalesce(json_agg(row_to_json(d)), '[]'::json) into v_dupes
  from public.check_question_duplicates(
    v_slug, v_c.question_text,
    array[v_c.answer_a, v_c.answer_b, v_c.answer_c, v_c.answer_d],
    v_c.source
  ) d;

  select count(*) into v_blocking
  from json_array_elements(v_dupes) e
  where e ->> 'match_kind' in ('exact', 'same_answers');

  if v_blocking > 0 and not p_force then
    update public.question_candidates
    set duplicates = v_dupes::jsonb, status = 'flagged', review_note = coalesce(p_note, review_note)
    where id = p_candidate;
    return json_build_object('question_id', null, 'blocked_by_duplicates', v_dupes);
  end if;

  insert into public.questions (
    category_id, question_text, answer_a, answer_b, answer_c, answer_d,
    correct_answer, difficulty, explanation, source, language, license,
    provenance, topic
  )
  values (
    v_c.category_id, v_c.question_text, v_c.answer_a, v_c.answer_b, v_c.answer_c,
    v_c.answer_d, v_c.correct_answer, v_c.difficulty, v_c.explanation, v_c.source,
    v_c.language, v_c.license, v_c.provenance, v_c.topic
  )
  returning id into v_qid;

  update public.question_candidates
  set status = 'approved',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_note = p_note,
      duplicates = v_dupes::jsonb,
      published_question_id = v_qid
  where id = p_candidate;

  return json_build_object('question_id', v_qid, 'already_approved', false);
end
$$;

create or replace function public.reject_candidate(p_candidate uuid, p_note text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.current_role_is('moderator') then
    raise exception 'Moderátori jogosultság szükséges' using errcode = '42501';
  end if;
  update public.question_candidates
  set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note
  where id = p_candidate;
end
$$;

-- Tömeges jóváhagyás: csak azok, ahol nincs blokkoló duplikátum és a
-- validáció sem talált hibát.
create or replace function public.approve_clean_candidates(
  p_batch uuid default null,
  p_limit integer default 100
)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_ok integer := 0;
  v_skipped integer := 0;
  v_res json;
begin
  if not public.current_role_is('moderator') then
    raise exception 'Moderátori jogosultság szükséges' using errcode = '42501';
  end if;

  for v_id in
    select id from public.question_candidates
    where status in ('generated', 'pending_review')
      and (p_batch is null or batch_id = p_batch)
      and coalesce(validation ->> 'verdict', '') = 'ok'
      and jsonb_array_length(duplicates) = 0
    order by quality_score desc nulls last
    limit least(greatest(coalesce(p_limit, 100), 1), 500)
  loop
    v_res := public.approve_candidate(v_id, 'auto-approve: clean');
    if (v_res ->> 'question_id') is null then
      v_skipped := v_skipped + 1;
    else
      v_ok := v_ok + 1;
    end if;
  end loop;

  return json_build_object('approved', v_ok, 'skipped', v_skipped);
end
$$;

-- ───────── review sor a admin felülethez (rendezett, szűrhető) ─────────

create or replace function public.review_queue(
  p_status   text default 'pending_review',
  p_category text default null,
  p_limit    integer default 50,
  p_offset   integer default 0
)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.current_role_is('moderator') then
    raise exception 'Moderátori jogosultság szükséges' using errcode = '42501';
  end if;

  return (
    select coalesce(json_agg(row_to_json(t)), '[]'::json)
    from (
      select qc.id, qc.question_text,
             array[qc.answer_a, qc.answer_b, qc.answer_c, qc.answer_d] as answers,
             qc.correct_answer, qc.difficulty, qc.explanation, qc.source, qc.topic,
             qc.status, qc.validation, qc.duplicates, qc.quality_score,
             c.slug as category_slug, c.name as category_name,
             qc.created_at
      from public.question_candidates qc
      join public.categories c on c.id = qc.category_id
      where qc.status = p_status::public.candidate_status
        and (p_category is null or c.slug = p_category)
      order by qc.quality_score desc nulls last, qc.created_at
      limit least(greatest(coalesce(p_limit, 50), 1), 200)
      offset greatest(coalesce(p_offset, 0), 0)
    ) t
  );
end
$$;
