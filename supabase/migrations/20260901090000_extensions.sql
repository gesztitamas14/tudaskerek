-- 0001 – kiegészítők és szövegnormalizálás
--
-- A deduplikáció és a magyar szövegkeresés alapja. A Supabase a kiegészítőket az
-- `extensions` sémába teszi, ezért mindenhol teljes névvel hivatkozunk rájuk.

create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- Az `unaccent(text)` STABLE, ezért indexben és generált oszlopban nem
-- használható. Az egyargumentumú, szótárat explicit megadó változat determinisztikus,
-- így IMMUTABLE-ként burkolható. (Bevett Postgres-minta.)
create or replace function public.immutable_unaccent(t text)
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $$
  select extensions.unaccent('extensions.unaccent'::regdictionary, t)
$$;

comment on function public.immutable_unaccent(text) is
  'IMMUTABLE unaccent burkoló, hogy generált oszlopban és indexben használható legyen.';

-- Kérdésszöveg normalizálása duplikátum-kereséshez:
-- kisbetűsítés, ékezetek eltávolítása, írásjelek törlése, whitespace összevonása.
create or replace function public.norm_text(t text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(
    btrim(
      regexp_replace(
        regexp_replace(lower(public.immutable_unaccent(coalesce(t, ''))), '[^a-z0-9]+', ' ', 'g'),
        '\s+', ' ', 'g'
      )
    ),
    ''
  )
$$;

comment on function public.norm_text(text) is
  'Kanonikus alak duplikátum-egyezéshez: kisbetű, ékezet nélkül, csak alfanumerikus + egy szóköz.';

-- Magyar full-text konfiguráció (a Postgres tartalmazza a `hungarian` snowball
-- szótárat). Ékezet-független kereséshez az unaccent szűrőt is beillesztjük.
do $$
begin
  if not exists (select 1 from pg_ts_config where cfgname = 'hungarian_unaccent') then
    create text search configuration public.hungarian_unaccent ( copy = pg_catalog.hungarian );
    alter text search configuration public.hungarian_unaccent
      alter mapping for hword, hword_part, word
      with extensions.unaccent, hungarian_stem;
  end if;
end
$$;
