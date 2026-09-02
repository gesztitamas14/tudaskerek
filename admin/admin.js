// Admin felület – nulla build, nulla függőség: fetch + PostgREST.
//
// Biztonság: a felület csak az `anon` kulcsot ismeri. Minden írási művelet a
// bejelentkezett felhasználó JWT-jével megy, és a Row Level Security dönt: az
// írás csak `moderator` vagy `admin` szerepkörrel engedélyezett. A böngészőben
// tehát nincs semmilyen kiemelt kulcs – aki nem moderátor, annak a szerver
// egyszerűen elutasítja a kéréseit.

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 25;

const state = {
  url: localStorage.getItem('admin.url') ?? '',
  anonKey: localStorage.getItem('admin.key') ?? '',
  session: null,
  profile: null,
  categories: [],
  page: 0,
  total: 0
};

// ─────────────────────────── HTTP ───────────────────────────

function headers({ authorized = true, extra = {} } = {}) {
  const token = (authorized && state.session?.access_token) || state.anonKey;
  return {
    apikey: state.anonKey,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra
  };
}

async function api(path, { method = 'GET', body, prefer, authorized = true } = {}) {
  const response = await fetch(`${state.url}${path}`, {
    method,
    headers: headers({ authorized, extra: prefer ? { Prefer: prefer } : {} }),
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed.message ?? parsed.error_description ?? parsed.msg ?? text;
    } catch { /* nyers szöveg */ }
    const error = new Error(message || `HTTP ${response.status}`);
    error.status = response.status;
    error.contentRange = response.headers.get('content-range');
    throw error;
  }
  return {
    data: text ? JSON.parse(text) : null,
    contentRange: response.headers.get('content-range')
  };
}

const rest = (table, query = '') => api(`/rest/v1/${table}${query ? `?${query}` : ''}`);
const rpc = (name, params = {}) =>
  api(`/rest/v1/rpc/${name}`, { method: 'POST', body: params }).then((r) => r.data);

// ─────────────────────────── segédek ───────────────────────────

function toast(message, ms = 3000) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('visible'), ms);
}

function el(tag, props = null, children = []) {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const node = document.createElement(name || 'div');
  for (const token of rest) {
    if (token.startsWith('.')) node.classList.add(token.slice(1));
    else if (token.startsWith('#')) node.id = token.slice(1);
  }
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'text') node.textContent = String(value);
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'class') node.className += ` ${value}`;
      else if (key === 'on') {
        for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
      } else if (key in node) node[key] = value;
      else node.setAttribute(key, String(value));
    }
  }
  for (const child of (Array.isArray(children) ? children : [children])) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

function download(filename, content, type = 'application/json') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// ─────────────────────────── bejelentkezés ───────────────────────────

$('cfgUrl').value = state.url;
$('cfgKey').value = state.anonKey;

$('signIn').addEventListener('click', async () => {
  $('loginError').textContent = '';
  state.url = $('cfgUrl').value.trim().replace(/\/+$/, '');
  state.anonKey = $('cfgKey').value.trim();

  if (!state.url || !state.anonKey) {
    $('loginError').textContent = 'A Supabase URL és az anon kulcs kötelező.';
    return;
  }
  localStorage.setItem('admin.url', state.url);
  localStorage.setItem('admin.key', state.anonKey);

  try {
    const { data } = await api('/auth/v1/token?grant_type=password', {
      method: 'POST',
      authorized: false,
      body: { email: $('email').value.trim(), password: $('password').value }
    });
    state.session = data;
    localStorage.setItem('admin.session', JSON.stringify(data));
    await afterSignIn();
  } catch (error) {
    $('loginError').textContent = `Bejelentkezés nem sikerült: ${error.message}`;
  }
});

$('signOut').addEventListener('click', () => {
  localStorage.removeItem('admin.session');
  location.reload();
});

async function afterSignIn() {
  // Szerepkör ellenőrzése: a felület nem próbál olyat, amit a szerver amúgy is
  // elutasítana – így érthető hibát tudunk mutatni.
  const userId = state.session?.user?.id;
  const { data: profiles } = await rest(
    'profiles',
    `select=id,nickname,role&id=eq.${userId}`
  );
  state.profile = profiles?.[0] ?? null;

  if (!state.profile) {
    $('loginError').textContent =
      'Nincs profil ehhez a felhasználóhoz. Játssz egy kört az appban, vagy hozd létre kézzel.';
    return;
  }
  if (!['admin', 'moderator'].includes(state.profile.role)) {
    $('loginError').textContent =
      `A felhasználó szerepköre „${state.profile.role}”. Az admin felülethez ` +
      'moderator vagy admin szerepkör kell (lásd docs/05-beallitas.md).';
    return;
  }

  $('who').textContent = `${state.profile.nickname} (${state.profile.role})`;
  $('signOut').hidden = false;
  $('loginPanel').hidden = true;
  $('main').hidden = false;

  await loadCategories();
  await loadQuestions();
  await refreshReviewCount();
}

// Mentett session visszaállítása
(async () => {
  const saved = localStorage.getItem('admin.session');
  if (!saved || !state.url || !state.anonKey) return;
  try {
    state.session = JSON.parse(saved);
    await afterSignIn();
  } catch {
    localStorage.removeItem('admin.session');
  }
})();

// ─────────────────────────── fülek ───────────────────────────

for (const button of document.querySelectorAll('.tabs button')) {
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tabs button')) {
      other.classList.toggle('active', other === button);
    }
    for (const panel of document.querySelectorAll('.tab-panel')) {
      panel.hidden = panel.dataset.panel !== button.dataset.tab;
    }
    if (button.dataset.tab === 'review') loadReview();
    if (button.dataset.tab === 'categories') loadCategoryPanel();
    if (button.dataset.tab === 'stats') loadStats();
  });
}

// ─────────────────────────── kategóriák ───────────────────────────

async function loadCategories() {
  const { data } = await rest('categories', 'select=*&order=sort_order');
  state.categories = data ?? [];

  const options = state.categories.map((category) =>
    el('option', { value: category.slug, text: `${category.name} (${category.slug})` })
  );

  for (const id of ['filterCategory', 'reviewCategory', 'exportCategory']) {
    const select = $(id);
    const current = select.value;
    clear(select);
    select.append(el('option', { value: '', text: 'Minden kategória' }));
    for (const option of options) select.append(option.cloneNode(true));
    select.value = current;
  }

  const editorSelect = $('edCategory');
  clear(editorSelect);
  for (const category of state.categories) {
    editorSelect.append(el('option', { value: category.id, text: category.name }));
  }
}

async function loadCategoryPanel() {
  const host = clear($('categoryList'));
  const { data: stats } = await rest('category_stats', 'select=slug,question_count');
  const counts = new Map((stats ?? []).map((row) => [row.slug, row.question_count]));

  for (const category of state.categories) {
    const count = counts.get(category.slug) ?? 0;
    host.append(
      el('div.row', { class: category.is_active ? '' : 'inactive' }, [
        el('div.row-head', null, [
          el('span.q', { text: category.name }),
          el('span.tag', { text: `${count} kérdés` })
        ]),
        el('div.row-meta', null, [
          el('span', { text: `slug: ${category.slug}` }),
          el('span', { text: `ikon: ${category.icon}` }),
          el('span', { text: `szín: ${category.color}` }),
          el('span', { text: category.is_hungarian ? 'magyar fókusz' : 'általános' }),
          el('span', { text: `sorrend: ${category.sort_order}` })
        ]),
        el('div.row-actions', null, [
          el('button', {
            text: category.is_active ? 'Deaktiválás' : 'Aktiválás',
            on: {
              click: async () => {
                try {
                  await api(`/rest/v1/categories?id=eq.${category.id}`, {
                    method: 'PATCH',
                    body: { is_active: !category.is_active },
                    prefer: 'return=minimal'
                  });
                  toast('Mentve.');
                  await loadCategories();
                  await loadCategoryPanel();
                } catch (error) {
                  toast(`Hiba: ${error.message}`, 6000);
                }
              }
            }
          })
        ])
      ])
    );
  }
}

// ─────────────────────────── kérdéslista ───────────────────────────

function questionQuery() {
  const params = [
    'select=id,question_text,answer_a,answer_b,answer_c,answer_d,correct_answer,' +
      'difficulty,explanation,source,topic,is_active,provenance,license,created_at,' +
      'categories!inner(slug,name)',
    'order=created_at.desc'
  ];

  const search = $('search').value.trim();
  if (search) {
    // A PostgREST `ilike` szűrője; a `*` a joker.
    params.push(`question_text=ilike.*${encodeURIComponent(search)}*`);
  }
  const category = $('filterCategory').value;
  if (category) params.push(`categories.slug=eq.${category}`);

  const difficulty = $('filterDifficulty').value;
  if (difficulty) params.push(`difficulty=eq.${difficulty}`);

  const active = $('filterActive').value;
  if (active) params.push(`is_active=is.${active}`);

  return params.join('&');
}

async function loadQuestions() {
  const host = clear($('questionList'));
  host.append(el('p.muted', { text: 'Betöltés…' }));

  const from = state.page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  try {
    const response = await fetch(`${state.url}/rest/v1/questions?${questionQuery()}`, {
      headers: headers({ extra: { Range: `${from}-${to}`, Prefer: 'count=exact' } })
    });
    if (!response.ok) throw new Error(await response.text());

    const rows = await response.json();
    const range = response.headers.get('content-range') ?? '';
    state.total = Number(range.split('/')[1] ?? rows.length);

    clear(host);
    if (rows.length === 0) {
      host.append(el('p.muted', { text: 'Nincs találat.' }));
    }
    for (const row of rows) host.append(questionRow(row));

    const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    $('pageInfo').textContent = `${state.page + 1} / ${pages} oldal · ${state.total} kérdés`;
    $('prevPage').disabled = state.page === 0;
    $('nextPage').disabled = state.page + 1 >= pages;
  } catch (error) {
    clear(host);
    host.append(el('p.error', { text: `Nem sikerült betölteni: ${error.message}` }));
  }
}

function questionRow(row) {
  const answers = [row.answer_a, row.answer_b, row.answer_c, row.answer_d];

  return el('div.row', { class: row.is_active ? '' : 'inactive' }, [
    el('div.row-head', null, [
      el('span.q', { text: row.question_text }),
      el('span.tag', { class: `tag-${row.difficulty}`, text: row.difficulty }),
      row.provenance !== 'handwritten'
        ? el('span.tag', { class: `tag-${row.provenance === 'ai_generated' ? 'ai' : row.provenance}`, text: row.provenance })
        : null,
      row.license ? el('span.tag.tag-license', { text: row.license }) : null
    ]),
    el('ol.row-answers', { type: 'A' }, answers.map((answer, index) =>
      el('li', { class: index === row.correct_answer ? 'correct' : '', text: answer })
    )),
    el('div.row-meta', null, [
      el('span', { text: row.categories?.name ?? '' }),
      row.topic ? el('span', { text: `téma: ${row.topic}` }) : null,
      row.explanation ? el('span', { text: `magyarázat: ${row.explanation.slice(0, 90)}` }) : null,
      row.source ? el('span', { text: `forrás: ${String(row.source).slice(0, 60)}` }) : null
    ]),
    el('div.row-actions', null, [
      el('button', { text: 'Szerkesztés', on: { click: () => openEditor(row) } }),
      el('button', {
        text: row.is_active ? 'Deaktiválás' : 'Aktiválás',
        on: { click: () => setActive(row, !row.is_active) }
      }),
      el('button.danger', { text: 'Törlés', on: { click: () => deleteQuestion(row) } })
    ])
  ]);
}

async function setActive(row, isActive) {
  try {
    await api(`/rest/v1/questions?id=eq.${row.id}`, {
      method: 'PATCH',
      body: { is_active: isActive },
      prefer: 'return=minimal'
    });
    toast(isActive ? 'Aktiválva.' : 'Deaktiválva.');
    await loadQuestions();
  } catch (error) {
    toast(`Hiba: ${error.message}`, 6000);
  }
}

async function deleteQuestion(row) {
  if (!confirm(`Véglegesen törlöd?\n\n${row.question_text}\n\n(A deaktiválás visszafordítható – a törlés nem.)`)) {
    return;
  }
  try {
    await api(`/rest/v1/questions?id=eq.${row.id}`, { method: 'DELETE', prefer: 'return=minimal' });
    toast('Törölve.');
    await loadQuestions();
  } catch (error) {
    toast(`Hiba: ${error.message}`, 6000);
  }
}

$('reload').addEventListener('click', () => { state.page = 0; loadQuestions(); });
$('search').addEventListener('change', () => { state.page = 0; loadQuestions(); });
for (const id of ['filterCategory', 'filterDifficulty', 'filterActive']) {
  $(id).addEventListener('change', () => { state.page = 0; loadQuestions(); });
}
$('prevPage').addEventListener('click', () => { state.page = Math.max(0, state.page - 1); loadQuestions(); });
$('nextPage').addEventListener('click', () => { state.page += 1; loadQuestions(); });

// ─────────────────────────── szerkesztő ───────────────────────────

let editing = null;

function openEditor(row = null) {
  editing = row;
  $('editorTitle').textContent = row ? 'Kérdés szerkesztése' : 'Új kérdés';
  $('editorError').textContent = '';
  $('dupeWarning').hidden = true;

  const category = state.categories.find((item) => item.slug === row?.categories?.slug);
  $('edCategory').value = category?.id ?? state.categories[0]?.id ?? '';
  $('edQuestion').value = row?.question_text ?? '';
  $('edA').value = row?.answer_a ?? '';
  $('edB').value = row?.answer_b ?? '';
  $('edC').value = row?.answer_c ?? '';
  $('edD').value = row?.answer_d ?? '';
  $('edCorrect').value = String(row?.correct_answer ?? 0);
  $('edDifficulty').value = row?.difficulty ?? 'medium';
  $('edExplanation').value = row?.explanation ?? '';
  $('edSource').value = row?.source ?? '';
  $('edTopic').value = row?.topic ?? '';
  $('edActive').checked = row ? row.is_active : true;

  $('editor').showModal();
}

$('newQuestion').addEventListener('click', () => openEditor(null));
$('editorCancel').addEventListener('click', () => $('editor').close());

function editorPayload() {
  return {
    category_id: $('edCategory').value,
    question_text: $('edQuestion').value.trim(),
    answer_a: $('edA').value.trim(),
    answer_b: $('edB').value.trim(),
    answer_c: $('edC').value.trim(),
    answer_d: $('edD').value.trim(),
    correct_answer: Number($('edCorrect').value),
    difficulty: $('edDifficulty').value,
    explanation: $('edExplanation').value.trim() || null,
    source: $('edSource').value.trim() || null,
    topic: $('edTopic').value.trim() || null,
    is_active: $('edActive').checked
  };
}

$('checkDupes').addEventListener('click', async () => {
  const payload = editorPayload();
  const slug = state.categories.find((c) => c.id === payload.category_id)?.slug;
  if (!slug) return;

  try {
    const matches = await rpc('check_question_duplicates', {
      p_category_slug: slug,
      p_question_text: payload.question_text,
      p_answers: [payload.answer_a, payload.answer_b, payload.answer_c, payload.answer_d],
      p_source: payload.source
    });

    const others = (matches ?? []).filter((match) => match.question_id !== editing?.id);
    const warning = $('dupeWarning');
    if (others.length === 0) {
      warning.hidden = false;
      warning.textContent = 'Nem találtam hasonló kérdést.';
      return;
    }
    warning.hidden = false;
    clear(warning);
    warning.append(el('strong', { text: `${others.length} lehetséges duplikátum:` }));
    for (const match of others) {
      warning.append(
        el('div', {
          text: `[${match.match_kind}, ${Number(match.similarity).toFixed(2)}] ${match.question_text}`
        })
      );
    }
  } catch (error) {
    $('editorError').textContent = `Ellenőrzés hiba: ${error.message}`;
  }
});

$('editorSave').addEventListener('click', async () => {
  const payload = editorPayload();
  $('editorError').textContent = '';

  // Kliens oldali előellenőrzés – a szerver amúgy is ellenőrzi, de így
  // azonnali és érthető visszajelzést adunk.
  const answers = [payload.answer_a, payload.answer_b, payload.answer_c, payload.answer_d];
  if (answers.some((answer) => !answer)) {
    $('editorError').textContent = 'Mind a négy válasz kötelező.';
    return;
  }
  const normalized = answers.map((answer) =>
    answer.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  );
  if (new Set(normalized).size !== 4) {
    $('editorError').textContent =
      'A négy válasz ékezet és írásjel nélkül is különbözzön (a szerver ezt kikényszeríti).';
    return;
  }
  if (payload.question_text.length < 8) {
    $('editorError').textContent = 'A kérdés legalább 8 karakter legyen.';
    return;
  }

  try {
    if (editing) {
      await api(`/rest/v1/questions?id=eq.${editing.id}`, {
        method: 'PATCH', body: payload, prefer: 'return=minimal'
      });
      toast('Kérdés frissítve.');
    } else {
      await api('/rest/v1/questions', {
        method: 'POST', body: [payload], prefer: 'return=minimal'
      });
      toast('Kérdés létrehozva.');
    }
    $('editor').close();
    await loadQuestions();
  } catch (error) {
    $('editorError').textContent = error.message;
  }
});

// ─────────────────────────── review ───────────────────────────

async function refreshReviewCount() {
  try {
    const response = await fetch(
      `${state.url}/rest/v1/question_candidates?select=id&status=eq.pending_review`,
      { headers: headers({ extra: { Range: '0-0', Prefer: 'count=exact' } }) }
    );
    const range = response.headers.get('content-range') ?? '';
    const count = Number(range.split('/')[1] ?? 0);
    $('reviewCount').textContent = count > 0 ? String(count) : '';
  } catch {
    $('reviewCount').textContent = '';
  }
}

async function loadReview() {
  const host = clear($('reviewList'));
  host.append(el('p.muted', { text: 'Betöltés…' }));

  try {
    const rows = await rpc('review_queue', {
      p_status: $('reviewStatus').value,
      p_category: $('reviewCategory').value || null,
      p_limit: 50,
      p_offset: 0
    });

    clear(host);
    if (!rows || rows.length === 0) {
      host.append(el('p.muted', { text: 'Nincs elem ebben az állapotban.' }));
      return;
    }
    for (const row of rows) host.append(candidateRow(row));
  } catch (error) {
    clear(host);
    host.append(el('p.error', { text: `Hiba: ${error.message}` }));
  }
}

function candidateRow(row) {
  const duplicates = Array.isArray(row.duplicates) ? row.duplicates : [];
  const validation = row.validation ?? {};

  return el('div.row', null, [
    el('div.row-head', null, [
      el('span.q', { text: row.question_text }),
      el('span.tag', { class: `tag-${row.difficulty}`, text: row.difficulty }),
      row.quality_score !== null && row.quality_score !== undefined
        ? el('span.tag', { text: `q=${Number(row.quality_score).toFixed(2)}` })
        : null
    ]),
    el('ol.row-answers', { type: 'A' }, (row.answers ?? []).map((answer, index) =>
      el('li', { class: index === row.correct_answer ? 'correct' : '', text: answer })
    )),
    el('div.row-meta', null, [
      el('span', { text: row.category_name ?? row.category_slug }),
      row.topic ? el('span', { text: `téma: ${row.topic}` }) : null,
      row.source ? el('span', { text: `forrás: ${String(row.source).slice(0, 70)}` }) : null,
      validation.verdict ? el('span', { text: `validáció: ${validation.verdict}` }) : null
    ]),
    row.explanation ? el('div.row-meta', null, el('span', { text: row.explanation })) : null,

    duplicates.length
      ? el('div.warning', null, [
          el('strong', { text: `${duplicates.length} lehetséges duplikátum:` }),
          ...duplicates.map((match) =>
            el('div', {
              text: `[${match.match_kind}] ${match.question_text ?? ''}`
            })
          )
        ])
      : null,

    validation.wikidata && validation.wikidata.verdict !== 'inconclusive'
      ? el('div.row-meta', null,
          el('span', { text: `Wikidata: ${validation.wikidata.verdict} – ${validation.wikidata.detail ?? ''}` })
        )
      : null,

    el('div.row-actions', null, [
      el('button.primary', {
        text: 'Jóváhagyás',
        on: { click: () => approve(row.id, false) }
      }),
      duplicates.length
        ? el('button', {
            text: 'Jóváhagyás duplikátum ellenére',
            on: { click: () => approve(row.id, true) }
          })
        : null,
      el('button.danger', {
        text: 'Elutasítás',
        on: { click: () => reject(row.id) }
      })
    ])
  ]);
}

async function approve(id, force) {
  try {
    const result = await rpc('approve_candidate', {
      p_candidate: id,
      p_note: null,
      p_force: force
    });
    if (result?.blocked_by_duplicates) {
      toast('Duplikátum miatt blokkolva – nézd meg a listát, vagy hagyd jóvá kényszerítve.', 6000);
    } else {
      toast('Jóváhagyva, bekerült a kérdésbankba.');
    }
    await loadReview();
    await refreshReviewCount();
  } catch (error) {
    toast(`Hiba: ${error.message}`, 6000);
  }
}

async function reject(id) {
  const note = prompt('Elutasítás oka (opcionális):') ?? null;
  try {
    await rpc('reject_candidate', { p_candidate: id, p_note: note });
    toast('Elutasítva.');
    await loadReview();
    await refreshReviewCount();
  } catch (error) {
    toast(`Hiba: ${error.message}`, 6000);
  }
}

$('reloadReview').addEventListener('click', loadReview);
$('reviewStatus').addEventListener('change', loadReview);
$('reviewCategory').addEventListener('change', loadReview);

$('approveClean').addEventListener('click', async () => {
  if (!confirm('Jóváhagyod az összes olyan jelöltet, amelynél nincs duplikátum és a validáció is rendben van?')) {
    return;
  }
  try {
    const result = await rpc('approve_clean_candidates', { p_batch: null, p_limit: 200 });
    toast(`Jóváhagyva: ${result?.approved ?? 0}, kihagyva: ${result?.skipped ?? 0}`, 6000);
    await loadReview();
    await refreshReviewCount();
  } catch (error) {
    toast(`Hiba: ${error.message}`, 6000);
  }
});

// ─────────────────────────── import / export ───────────────────────────

$('exportJson').addEventListener('click', () => exportQuestions('json'));
$('exportCsv').addEventListener('click', () => exportQuestions('csv'));

async function exportQuestions(format) {
  const category = $('exportCategory').value;
  const filter = category ? `&categories.slug=eq.${category}` : '';

  try {
    const { data } = await rest(
      'questions',
      'select=question_text,answer_a,answer_b,answer_c,answer_d,correct_answer,difficulty,' +
      `explanation,source,topic,is_active,provenance,license,categories!inner(slug)&limit=20000${filter}`
    );

    if (format === 'json') {
      // A `content/seed/*.json` szerkezetébe írjuk vissza, hogy kör be tudjon zárulni:
      // export → kézi szerkesztés → import.
      const byCategory = new Map();
      for (const row of data) {
        const slug = row.categories.slug;
        if (!byCategory.has(slug)) byCategory.set(slug, []);
        byCategory.get(slug).push({
          q: row.question_text,
          a: [row.answer_a, row.answer_b, row.answer_c, row.answer_d],
          c: row.correct_answer,
          d: row.difficulty,
          e: row.explanation ?? undefined,
          s: row.source ?? undefined,
          t: row.topic ?? undefined
        });
      }
      const payload = [...byCategory.entries()].map(([slug, questions]) => ({
        category: slug,
        questions
      }));
      download(
        `tudaskerek-export-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(category ? payload[0] ?? { category, questions: [] } : payload, null, 2)
      );
    } else {
      const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
      const header = [
        'category', 'question', 'answer_a', 'answer_b', 'answer_c', 'answer_d',
        'correct_answer', 'difficulty', 'explanation', 'source', 'topic',
        'is_active', 'provenance', 'license'
      ];
      const lines = [header.join(',')];
      for (const row of data) {
        lines.push([
          row.categories.slug, row.question_text, row.answer_a, row.answer_b,
          row.answer_c, row.answer_d, row.correct_answer, row.difficulty,
          row.explanation, row.source, row.topic, row.is_active,
          row.provenance, row.license
        ].map(escape).join(','));
      }
      // BOM, hogy az Excel felismerje az UTF-8-at
      download(
        `tudaskerek-export-${new Date().toISOString().slice(0, 10)}.csv`,
        '﻿' + lines.join('\r\n'),
        'text/csv'
      );
    }
    toast(`${data.length} kérdés exportálva.`);
  } catch (error) {
    toast(`Export hiba: ${error.message}`, 6000);
  }
}

$('importRun').addEventListener('click', async () => {
  const file = $('importFile').files?.[0];
  const log = $('importLog');
  log.textContent = '';

  if (!file) {
    log.textContent = 'Válassz fájlt.';
    return;
  }

  const write = (line) => { log.textContent += `${line}\n`; log.scrollTop = log.scrollHeight; };

  try {
    const text = await file.text();
    const rows = file.name.endsWith('.csv') ? parseCsv(text) : parseJsonImport(text);
    write(`Beolvasva: ${rows.length} kérdés`);

    const slugToId = new Map(state.categories.map((c) => [c.slug, c.id]));
    const direct = $('importDirect').checked;
    const table = direct ? 'questions' : 'question_candidates';
    write(direct
      ? 'CÉL: questions (közvetlenül a játékba)'
      : 'CÉL: question_candidates (review-ra vár)');

    let ok = 0;
    let failed = 0;

    for (const row of rows) {
      const categoryId = slugToId.get(row.category);
      if (!categoryId) {
        write(`  ✗ ismeretlen kategória: ${row.category} – „${row.question.slice(0, 50)}”`);
        failed++;
        continue;
      }

      const payload = {
        category_id: categoryId,
        question_text: row.question,
        answer_a: row.answers[0],
        answer_b: row.answers[1],
        answer_c: row.answers[2],
        answer_d: row.answers[3],
        correct_answer: row.correct,
        difficulty: row.difficulty ?? 'medium',
        explanation: row.explanation ?? null,
        source: row.source ?? null,
        topic: row.topic ?? null,
        provenance: row.provenance ?? 'import',
        license: row.license ?? null
      };
      if (!direct) payload.status = 'pending_review';
      else payload.is_active = true;

      try {
        await api(`/rest/v1/${table}`, {
          method: 'POST', body: [payload], prefer: 'return=minimal'
        });
        ok++;
      } catch (error) {
        failed++;
        write(`  ✗ „${row.question.slice(0, 60)}” – ${String(error.message).split('\n')[0].slice(0, 140)}`);
      }
    }

    write(`\nKész: ${ok} beszúrva, ${failed} hibás.`);
    toast(`Import: ${ok} sikeres, ${failed} hibás.`, 6000);
    await loadQuestions();
    await refreshReviewCount();
  } catch (error) {
    write(`Hiba: ${error.message}`);
  }
});

/** Elfogadja a seed formátumot és a generátorok kimenetét is. */
function parseJsonImport(text) {
  const payload = JSON.parse(text);
  const out = [];

  const pushSeed = (block) => {
    for (const item of block.questions ?? []) {
      out.push({
        category: block.category,
        question: item.q ?? item.question,
        answers: item.a ?? item.answers,
        correct: item.c ?? item.correct ?? item.correct_index ?? 0,
        difficulty: item.d ?? item.difficulty,
        explanation: item.e ?? item.explanation,
        source: item.s ?? item.source ?? block.default_source,
        topic: item.t ?? item.topic
      });
    }
  };

  if (Array.isArray(payload)) {
    // Több kategória blokkja
    for (const block of payload) {
      if (block.category && block.questions) pushSeed(block);
      else if (block.question) out.push(normalizeFlat(block));
    }
  } else if (payload.category && payload.questions) {
    pushSeed(payload);
  } else if (Array.isArray(payload.questions)) {
    for (const item of payload.questions) out.push(normalizeFlat(item));
  } else {
    throw new Error('Nem ismerem fel a JSON szerkezetét.');
  }

  return out.filter((row) => row.question && Array.isArray(row.answers) && row.answers.length === 4);
}

function normalizeFlat(item) {
  return {
    category: item.category,
    question: item.question ?? item.q,
    answers: item.answers ?? item.a,
    correct: item.correct_index ?? item.correct ?? item.c ?? 0,
    difficulty: item.difficulty ?? item.d,
    explanation: item.explanation ?? item.e,
    source: item.source ?? item.s,
    topic: item.topic ?? item.t,
    provenance: item.provenance,
    license: item.license
  };
}

/** Egyszerű CSV olvasó, idézőjeles mezőkkel. */
function parseCsv(text) {
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;

  const body = text.replace(/^﻿/, '');
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (inQuotes) {
      if (char === '"') {
        if (body[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ',') { record.push(field); field = ''; }
    else if (char === '\n') { record.push(field); rows.push(record); record = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (field || record.length) { record.push(field); rows.push(record); }

  const [header, ...dataRows] = rows.filter((row) => row.some((cell) => cell !== ''));
  const index = (name) => header.indexOf(name);

  return dataRows.map((row) => ({
    category: row[index('category')],
    question: row[index('question')],
    answers: [
      row[index('answer_a')], row[index('answer_b')],
      row[index('answer_c')], row[index('answer_d')]
    ],
    correct: Number(row[index('correct_answer')] ?? 0),
    difficulty: row[index('difficulty')] || 'medium',
    explanation: row[index('explanation')] || null,
    source: row[index('source')] || null,
    topic: row[index('topic')] || null,
    provenance: row[index('provenance')] || 'import',
    license: row[index('license')] || null
  }));
}

// ─────────────────────────── statisztika ───────────────────────────

$('reloadStats').addEventListener('click', loadStats);

async function loadStats() {
  const host = clear($('statsBody'));
  host.append(el('p.muted', { text: 'Betöltés…' }));

  try {
    const { data: categoryStats } = await rest(
      'category_stats',
      'select=slug,question_count,easy_count,medium_count,hard_count&order=slug'
    );

    // A leggyakrabban rontott kérdések – ezek a kalibrálás célpontjai.
    const { data: worst } = await rest(
      'question_stats',
      'select=times_answered,times_correct,correct_ratio,times_reported,' +
      'questions!inner(question_text,categories!inner(slug))' +
      '&times_answered=gte.20&order=correct_ratio.asc&limit=20'
    );

    clear(host);

    const table = el('table', null, [
      el('thead', null, el('tr', null, [
        el('th', { text: 'Kategória' }),
        el('th.num', { text: 'Összes' }),
        el('th.num', { text: 'Könnyű' }),
        el('th.num', { text: 'Közepes' }),
        el('th.num', { text: 'Nehéz' })
      ])),
      el('tbody', null, (categoryStats ?? []).map((row) =>
        el('tr', null, [
          el('td', { text: row.slug }),
          el('td.num', { text: String(row.question_count) }),
          el('td.num', { text: String(row.easy_count) }),
          el('td.num', { text: String(row.medium_count) }),
          el('td.num', { text: String(row.hard_count) })
        ])
      ))
    ]);
    host.append(el('h3', { text: 'Kérdésszám kategóriánként' }), table);

    if (worst?.length) {
      host.append(
        el('h3', { text: 'Legalacsonyabb találati arányú kérdések (min. 20 válasz)' }),
        el('p.muted.small', {
          text:
            'Ezek vagy nagyon nehezek, vagy félreérthetőek, vagy hibás a megjelölt ' +
            'helyes válasz. Érdemes átnézni őket.'
        }),
        el('table', null, [
          el('thead', null, el('tr', null, [
            el('th', { text: 'Kérdés' }),
            el('th', { text: 'Kategória' }),
            el('th.num', { text: 'Válasz' }),
            el('th.num', { text: 'Helyes %' }),
            el('th.num', { text: 'Jelentés' })
          ])),
          el('tbody', null, worst.map((row) =>
            el('tr', null, [
              el('td', { text: row.questions?.question_text ?? '' }),
              el('td', { text: row.questions?.categories?.slug ?? '' }),
              el('td.num', { text: String(row.times_answered) }),
              el('td.num', {
                text: row.correct_ratio === null ? '–' : `${Math.round(row.correct_ratio * 100)}%`
              }),
              el('td.num', { text: String(row.times_reported) })
            ])
          ))
        ])
      );
    }
  } catch (error) {
    clear(host);
    host.append(el('p.error', { text: `Hiba: ${error.message}` }));
  }
}
