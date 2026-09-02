# Edge Functions – szándékosan üres

A specifikáció Edge Functionöket említett a válaszvalidációhoz és az AI
kérdésgeneráláshoz. A megvalósításban **nincs egyetlen Edge Function sem**, és
ez tudatos döntés.

## Miért nem kell a válaszvalidációhoz?

A válaszvalidáció `SECURITY DEFINER` SQL függvényben fut
(`public.submit_answer`, lásd `../migrations/20260901090400_api_functions.sql`).

Amit ezzel nyerünk:

- **Egy körutazás.** A `submit_answer` egyetlen tranzakcióban validálja a
  választ, kiszámolja a pontot, frissíti a session és a kérdésstatisztika
  sorait, majd visszaadja a magyarázatot. Egy Edge Function ugyanezt 3-4
  adatbázis-körutazással tenné meg.
- **Nincs versenyhelyzet.** A `select … for update` a session soron
  sorosítja a beküldéseket. Edge Functionből ez csak explicit zárolással vagy
  optimista verziózással lenne biztosítható.
- **Kevesebb üzemeltetés.** Nincs deploy, nincs cold start, nincs külön
  secret-kezelés.
- **A jogosultság ott van, ahol az adat.** A `SECURITY DEFINER` + RLS
  kombinációt nem lehet „megkerülni” a függvény mellett.

## Miért nem kell az AI generáláshoz?

Az AI kérdésgenerálás **nem játékmenet közbeni művelet**: kötegelt, ritka,
hosszú (percekig futhat) és emberi review követi. Ez a `tools/` alatti Node
szkriptek dolga:

- `tools/src/generate-questions.mjs` – Claude API, strukturált kimenet
- `tools/src/generate-from-wikidata.mjs` – CC0 SPARQL sablonok
- `tools/src/factcheck.mjs` – formai + Wikidata + LLM cross-check

Így az `ANTHROPIC_API_KEY` **soha nem hagyja el a fejlesztői gépet**, és nem
kell Edge Function secretbe tenni. A generált kérdések a
`question_candidates` táblába kerülnek, ahonnan az admin felület
(`admin/`) veszi át őket.

## Mikor lenne mégis értelme Edge Functionnek?

Ha később kell:

- **webhook fogadása** (pl. StoreKit / RevenueCat vásárlás-értesítés),
- **időzített takarítás** hívása kívülről (a `cleanup_expired_rooms()` SQL
  függvény már megvan; pg_cron vagy egy külső ütemező is meghívhatja),
- **AI generálás önkiszolgálóan az admin felületről**, fejlesztői gép nélkül.

Ilyenkor ide kerülnek a Deno függvények, és a `supabase/config.toml`-ban kell
őket regisztrálni.
