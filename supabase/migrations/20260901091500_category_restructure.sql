-- 0016 – kategóriaszerkezet: a kért lista szerinti bontás
--
-- Változások a 0009-es seedhez képest:
--
--   * KIKAPCSOLVA: `magyar-zene-film` (a magyar film és zene belefér a magyar
--     kultúrába) és `magyar-nyelv` (magyar anyanyelvűeknek túl könnyűek voltak
--     a kérdései). A kérdéseik nem tűntek el: átkerültek a `magyar-kultura`
--     alá – a `magyar-nyelv` esetében csak a `medium` és `hard` nehézségűek.
--   * ÚJ: cégek/márkák, híres emberek, fizika, kémia, mitológia/vallás,
--     ünnepek, játékok, divat.
--   * Néhány név pontosítva (pl. „Filmek és sorozatok” → „Film, színház”).
--
-- A `hires-ember` és a `divat` szándékosan `is_active = false`: definiálva
-- vannak, de még nincs hozzájuk elég kérdés. Egy üres kategória a keréken
-- elhasalást okozna, mert egy kör 10 kérdés UGYANABBÓL a kategóriából.
--
-- A megszüntetés `is_active = false`, NEM `delete`: a `questions` tábla
-- `on delete restrict`-tel hivatkozik a kategóriákra, és a lejátszott körök
-- hivatkozásait sem szabad elveszíteni.

update public.categories set is_active = false
where slug in ('magyar-zene-film', 'magyar-nyelv');

insert into public.categories
  (slug, name, description, icon, color, is_hungarian, is_active, sort_order)
values
  ('magyar-tortenelem', 'Magyar történelem', 'Honfoglalástól a rendszerváltásig: királyok, csaták, korszakok.', '👑', '#B23A48', true, true, 10),
  ('magyar-irodalom', 'Magyar irodalom', 'Költők, regények, szereplők, idézetek, évszámok.', '📖', '#8E5572', true, true, 20),
  ('magyar-kultura', 'Magyar kultúra', 'Hagyományok, népszokások, találmányok, hétköznapi műveltség.', '🎭', '#C77D3A', true, true, 30),
  ('magyar-foldrajz', 'Magyar földrajz', 'Megyék, városok, folyók, tavak, hegyek, nemzeti parkok.', '🗺️', '#3E7C59', true, true, 40),
  ('magyar-kozelet', 'Magyar közélet', 'Államszervezet, jelképek, intézmények – tényszerű általános műveltség.', '🏛️', '#5A6B8C', true, true, 50),
  ('magyar-sport', 'Magyar sport', 'Olimpiai bajnokok, aranycsapat, klubok, rekordok.', '🏃', '#2E7D9A', true, true, 60),
  ('vilagtortenelem', 'Világtörténelem', 'Ókortól a 20. századig: birodalmak, uralkodók, fordulópontok.', '🏺', '#7A5C3E', false, true, 110),
  ('foldrajz', 'Földrajz, csillagászat', 'Országok, fővárosok, hegyek, óceánok, rekordok.', '🌍', '#2F7F8C', false, true, 120),
  ('tudomany', 'Tudomány', 'Fizika, kémia, biológia, matematika, csillagászat.', '🔬', '#3C6EBF', false, true, 130),
  ('technologia', 'Technika, találmányok', 'Számítástechnika, internet, mérnöki megoldások, találmányok.', '💻', '#4B5563', false, true, 140),
  ('allatvilag', 'Állatok, biológia', 'Emlősök, madarak, halak, rovarok – élőhelyek és rekordok.', '🦊', '#6B8E23', false, true, 150),
  ('termeszet', 'Természet', 'Növények, éghajlat, ökoszisztémák, természeti jelenségek.', '🌿', '#3F8F5B', false, true, 160),
  ('sport', 'Sport', 'Világbajnokságok, olimpiák, sportágak szabályai, legendák.', '⚽', '#1F7A8C', false, true, 170),
  ('film-sorozat', 'Film, színház', 'Klasszikusok, rendezők, szereplők, díjak.', '🍿', '#B5446E', false, true, 180),
  ('zene', 'Zene, tánc', 'Klasszikus és populáris zene, előadók, hangszerek.', '🎵', '#8A5CF6', false, true, 190),
  ('irodalom', 'Irodalom', 'Világirodalmi művek, szerzők, korszakok.', '📚', '#7C5CFF', false, true, 200),
  ('muveszet', 'Művészet, építészet', 'Festészet, szobrászat, építészet, stílusok.', '🎨', '#D97706', false, true, 210),
  ('etel-ital', 'Étel és ital', 'Konyhák, alapanyagok, italok, gasztronómiai fogalmak.', '🍽️', '#C2410C', false, true, 220),
  ('erdekessegek', 'Egyéb tudomány, kultúra', 'Vegyes tudnivalók, rekordok, kevéssé ismert tények.', '✨', '#0EA5A4', false, true, 230),
  ('cegek-markak', 'Cégek, márkák', 'Vállalatok, logók, alapítók és a mögöttük lévő történetek.', '🏢', '#4A6FA5', false, true, 230),
  ('hires-ember', 'Híres emberek', 'Feltalálók, uralkodók, sztárok – ki kicsoda a világtörténelemben.', '🌟', '#C9A227', false, false, 235),
  ('logika', 'Logika és fejtörők', 'Számsorok, következtetés, klasszikus fejtörők.', '🧩', '#6366F1', false, true, 240),
  ('fizika', 'Fizika', 'Erők, energia, fény és a világ működésének szabályai.', '⚛️', '#3C6E71', false, true, 240),
  ('kemia', 'Kémia', 'Elemek, vegyületek, reakciók és a periódusos rendszer.', '🧪', '#6A8E7F', false, true, 245),
  ('mitologia-vallas', 'Mitológia, vallás', 'Istenek, hősök, szent könyvek és világvallások.', '🏺', '#8E6C88', false, true, 250),
  ('unnepek', 'Ünnepek, jeles napok', 'Szokások, hagyományok és a naptár nevezetes napjai.', '🎉', '#D96C6C', false, true, 255),
  ('jatekok', 'Játékok', 'Társasjátékok, kártya, sakk és videojátékok.', '🎲', '#5C7AEA', false, true, 260),
  ('divat', 'Divat, öltözködés', 'Márkák, tervezők, stílusok és a ruhák története.', '👗', '#B5838D', false, false, 265)
on conflict (slug) do update set
  name = excluded.name,
  description = excluded.description,
  icon = excluded.icon,
  color = excluded.color,
  is_hungarian = excluded.is_hungarian,
  is_active = excluded.is_active,
  sort_order = excluded.sort_order;
