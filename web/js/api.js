// Backend-kapcsolat és a játékkör kiszolgálása.
//
// Két „driver” van, ugyanazzal a felülettel:
//   * OnlineDriver  – a Supabase RPC-ket hívja. A helyes választ a szerver
//     csak a válasz beküldése UTÁN adja meg, és a pontszámot is ő számolja.
//   * OfflineDriver – a helyi kérdésbankból szolgál ki és lokálisan értékel.
//     Ilyenkor a helyes válasz szükségszerűen a kliensen van, ezért az eredmény
//     `is_trusted = false` jelöléssel megy fel, és a globális ranglistán nem
//     számít.
//
// A játékképernyő nem tudja, melyikkel dolgozik – ez az egész architektúra
// legfontosabb absztrakciója: emiatt működik ugyanaz a játékmenet interneten és
// repülőgép módban is.

import { CONFIG } from './config.js';
import { FALLBACK_RULES, parseRules, reward, penalized } from './rules.js';
import { history as seenHistory, meta, outbox, remoteQuestions, results, categoryStats } from './store.js';

// ─────────────────────────── Supabase kliens ───────────────────────────

const SESSION_KEY = 'tudaskerek.auth.session';

export class Supabase {
  constructor({ url, anonKey }) {
    this.url = String(url ?? '').replace(/\/+$/, '');
    this.anonKey = anonKey ?? '';
    this.session = this.#loadSession();
  }

  get isConfigured() {
    return Boolean(this.url && this.anonKey);
  }

  get userId() {
    return this.session?.user?.id ?? null;
  }

  get isSignedIn() {
    return Boolean(this.session?.access_token);
  }

  #loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  #saveSession(session) {
    this.session = session;
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      /* privát mód: memóriában marad */
    }
  }

  #headers(authorized = true) {
    const token = (authorized && this.session?.access_token) || this.anonKey;
    return {
      apikey: this.anonKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
  }

  async #fetch(path, { method = 'GET', body, authorized = true, retries = 1 } = {}) {
    if (!this.isConfigured) throw new ApiError('A backend nincs beállítva.', 'not_configured');

    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(400 * attempt + Math.random() * 200);
      try {
        const response = await fetch(`${this.url}${path}`, {
          method,
          headers: this.#headers(authorized),
          body: body === undefined ? undefined : JSON.stringify(body)
        });

        const text = await response.text();
        if (!response.ok) {
          let message = text;
          try {
            const parsed = JSON.parse(text);
            message = parsed.message ?? parsed.error_description ?? parsed.msg ?? text;
          } catch { /* nyers szöveg marad */ }

          const error = new ApiError(message || `HTTP ${response.status}`, 'http', response.status);
          // 5xx és 429 újrapróbálható, a többi nem
          if ((response.status >= 500 || response.status === 429) && attempt < retries) {
            lastError = error;
            continue;
          }
          throw error;
        }
        return text ? JSON.parse(text) : null;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        lastError = new ApiError(error.message, 'network');
        if (attempt < retries) continue;
        throw lastError;
      }
    }
    throw lastError;
  }

  rpc(name, params = {}, { authorized = true } = {}) {
    return this.#fetch(`/rest/v1/rpc/${name}`, { method: 'POST', body: params, authorized });
  }

  select(table, query = '', { authorized = true } = {}) {
    const suffix = query ? (query.startsWith('?') ? query : `?${query}`) : '';
    return this.#fetch(`/rest/v1/${table}${suffix}`, { authorized });
  }

  patch(table, query, body) {
    return this.#fetch(`/rest/v1/${table}?${query}`, { method: 'PATCH', body });
  }

  // ── auth ──

  /** Anonim (vendég) bejelentkezés – valódi szerveroldali fiók e-mail nélkül. */
  async signInAnonymously() {
    const session = await this.#fetch('/auth/v1/signup', {
      method: 'POST',
      body: {},
      authorized: false
    });
    this.#saveSession(session);
    return session;
  }

  /**
   * OAuth bejelentkezés átirányítással (weben ez a járható út).
   *
   * Miért Google és nem Apple? Az Apple OAuth-hoz fizetős Apple Developer
   * tagság kell (99 USD/év) és egy félévente cserélendő, `.p8` kulccsal aláírt
   * titok. A Google-höz csak egy Client ID + Client Secret kell, ingyen.
   */
  oauthSignInUrl(provider = 'google', redirectTo = location.origin + location.pathname) {
    const params = new URLSearchParams({ provider, redirect_to: redirectTo });
    return `${this.url}/auth/v1/authorize?${params}`;
  }

  /**
   * Hova térjen vissza a megerősítő e-mailben lévő link.
   *
   * Enélkül a Supabase a projekt **Site URL**-jét használja, ami gyárilag
   * `http://localhost:3000` – tehát a levélben lévő link egy nem létező helyi
   * szerverre visz. Ezért minden e-mailes műveletnél explicit megadjuk, hol
   * vagyunk épp: fejlesztéskor a localhost, éles helyzetben a Pages-cím.
   *
   * A Supabase csak a **Redirect URLs** listán szereplő címeket fogadja el,
   * tehát oda fel kell venni ezt a címet (lásd HOSTING.md).
   */
  get #emailRedirectTo() {
    return location.origin + location.pathname;
  }

  /** Regisztráció e-mail + jelszóval. */
  async signUpWithEmail(email, password) {
    const query = new URLSearchParams({ redirect_to: this.#emailRedirectTo });
    const response = await this.#fetch(`/auth/v1/signup?${query}`, {
      method: 'POST',
      body: { email, password },
      authorized: false
    });

    // Ha a Supabase-en be van kapcsolva az e-mail megerősítés, itt még NINCS
    // session – a felhasználónak először kattintania kell a levélben.
    if (response?.access_token) {
      this.#saveSession(response);
      return { session: response, needsConfirmation: false };
    }
    return { session: null, needsConfirmation: true };
  }

  /** Bejelentkezés e-mail + jelszóval. */
  async signInWithEmail(email, password) {
    const session = await this.#fetch('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email, password },
      authorized: false
    });
    this.#saveSession(session);
    return session;
  }

  /**
   * Vendégfiók átalakítása igazi fiókká – az eredmények megmaradnak.
   *
   * Ez ugyanaz a felhasználó marad (ugyanaz az `id`), csak kap e-mailt és
   * jelszót. Ezért nem veszik el a statisztika, és a ranglistára is felkerül
   * (a `profiles.is_anonymous` egy trigger révén false-ra vált).
   */
  async upgradeGuest(email, password) {
    const query = new URLSearchParams({ redirect_to: this.#emailRedirectTo });
    const user = await this.#fetch(`/auth/v1/user?${query}`, {
      method: 'PUT',
      body: { email, password }
    });

    // Ha a projekten be van kapcsolva az e-mail megerősítés, az e-mail még
    // NEM az övé: a `new_email` mezőben várakozik, amíg rá nem kattint a
    // levélben. Addig vendég marad – ezt a felületnek meg kell tudnia mondani.
    const needsConfirmation = Boolean(user?.new_email) && user?.email !== email;

    // A JWT még a régi `is_anonymous: true` állítást tartalmazza, ezért
    // frissítjük – enélkül a felület vendégként kezelne tovább.
    if (!needsConfirmation) await this.refreshIfNeeded(true);

    return { user, needsConfirmation };
  }

  async signInWithGoogle() {
    location.href = this.oauthSignInUrl('google');
  }

  /**
   * Az OAuth visszatérés a tokeneket az URL fragmentjében adja
   * (#access_token=…&refresh_token=…). Ezt kell elmenteni és eltakarítani.
   */
  async captureOAuthRedirect() {
    // A sikertelen OAuth is visszahoz ide, csak `error`/`error_description`
    // paraméterekkel. Ezt eddig csendben eldobtuk: a felhasználó úgy látta,
    // mintha semmi nem történt volna. Most kivételként jelezzük.
    const failure = readOAuthError();
    if (failure) {
      window.history.replaceState(null, '', location.pathname);
      throw new ApiError(failure, 'oauth', 400);
    }

    if (!location.hash.includes('access_token')) return false;
    const params = new URLSearchParams(location.hash.slice(1));
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    if (!accessToken) return false;

    const expiresIn = Number(params.get('expires_in') ?? 3600);
    this.#saveSession({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      user: { id: readJwtClaim(accessToken, 'sub') }
    });
    window.history.replaceState(null, '', location.pathname + location.search);
    return true;
  }

  /**
   * @param {boolean} [force] a lejárattól függetlenül újítsa meg a tokent.
   *   Vendégfiók átalakítása után kell: a régi JWT-ben még
   *   `is_anonymous: true` szerepel, és abból a felület vendéget olvasna.
   */
  async refreshIfNeeded(force = false) {
    const session = this.session;
    if (!session?.refresh_token) return false;
    const expiresAt = Number(session.expires_at ?? 0);
    if (!force && expiresAt - Date.now() / 1000 > 120) return true;

    try {
      const fresh = await this.#fetch('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: { refresh_token: session.refresh_token },
        authorized: false
      });
      this.#saveSession({
        ...fresh,
        expires_at: Math.floor(Date.now() / 1000) + Number(fresh.expires_in ?? 3600)
      });
      return true;
    } catch {
      this.#saveSession(null);
      return false;
    }
  }

  signOut() {
    this.#saveSession(null);
  }

  /** Anonim-e a bejelentkezett felhasználó (a JWT claimből, hálózat nélkül). */
  get isAnonymous() {
    const token = this.session?.access_token;
    if (!token) return true;
    return readJwtClaim(token, 'is_anonymous') === true;
  }

  /**
   * Vendég-e a bejelentkezett felhasználó – a SZERVER szerint.
   *
   * Az `isAnonymous` a JWT `is_anonymous` állítását olvassa, ami két esetben
   * félrevezet: (1) a szolgáltató nem mindig teszi bele, (2) vendégfiók
   * átalakítása után a régi token még vendéget mond, amíg le nem cserélődik.
   * A `profiles.is_anonymous` viszont hiteles, és a kliens olvashatja.
   *
   * @returns {Promise<boolean|null>} null, ha nem lehetett megállapítani –
   *   ilyenkor a felület NE állítson semmit a felhasználóról.
   */
  /**
   * A választható beszólások listája.
   *
   * A SZÖVEG A SZERVEREN VAN, a kliens csak megjeleníti, és az `id`-t küldi
   * vissza. Így a csatornán szabad szöveg nem juthat át.
   */
  async reactionCatalog() {
    const rows = await this.select(
      'reaction_catalog',
      'is_active=eq.true&select=id,body,emoji,sort_order&order=sort_order.asc'
    );
    return Array.isArray(rows) ? rows : [];
  }

  async isGuestAccount() {
    if (!this.isSignedIn) return null;
    const id = this.userId;
    if (!id) return null;
    try {
      const rows = await this.select('profiles', `id=eq.${id}&select=is_anonymous&limit=1`);
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return rows[0].is_anonymous === true;
    } catch {
      return null;
    }
  }
}

export class ApiError extends Error {
  constructor(message, kind = 'unknown', status = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
  get isRetryable() {
    return this.kind === 'network' || this.status >= 500 || this.status === 429;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** JWT payload claim kiolvasása. NEM hitelesít – csak UI-döntésekhez. */
/**
 * OAuth hibaüzenet a visszatérési URL-ből – lehet a query stringben és a
 * fragmentben is, szolgáltatótól függően.
 *
 * A leggyakoribb eset a „missing OAuth secret”: a Supabase-en be van kapcsolva
 * a szolgáltató és megvan a Client ID, de a titkos kulcs nincs kitöltve.
 * Erre külön, érthető magyar üzenetet adunk.
 */
function readOAuthError() {
  const sources = [
    new URLSearchParams(location.search),
    new URLSearchParams(location.hash.replace(/^#/, ''))
  ];

  for (const params of sources) {
    const code = params.get('error') ?? params.get('error_code');
    if (!code) continue;

    const description = params.get('error_description') ?? '';
    if (/oauth secret|missing.*secret/i.test(`${code} ${description}`)) {
      return (
        'A bejelentkezési szolgáltató nincs készre állítva: a Supabase-en hiányzik ' +
        'a titkos kulcs (Secret Key for OAuth). A Client ID önmagában nem elég.'
      );
    }
    return description || `Bejelentkezési hiba: ${code}`;
  }
  return null;
}

function readJwtClaim(token, claim) {
  try {
    const [, payload] = token.split('.');
    let base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    return JSON.parse(atob(base64))[claim];
  } catch {
    return undefined;
  }
}

// ─────────────────────────── kérdésbank ───────────────────────────

/**
 * A teljes helyi kérdésbank: a beépített seed + a letöltött kérdések.
 * A seedet a service worker cache-eli, ezért offline is elérhető.
 */
export class QuestionBank {
  constructor() {
    this.categories = [];
    this.questions = [];
    this.seedVersion = 0;
  }

  async load() {
    // A modul helyéhez képest oldjuk fel, nem a dokumentumhoz: így a
    // kérdésbank akkor is betölthető, ha a lapot máshonnan nyitják meg
    // (pl. a tests/smoke.html tesztoldalról).
    const url = new URL('../seed-questions.json', import.meta.url);
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`A kérdésbank nem tölthető be (HTTP ${response.status}).`);
    }
    const bundle = await response.json();

    this.seedVersion = bundle.version;
    this.categories = bundle.categories;

    // A seed kérdéseinek stabil azonosítót adunk (kategória + normalizált szöveg),
    // hogy az ismétlésvédelem működjön az app frissítése után is.
    const seed = bundle.questions.map((q, index) => ({
      id: `seed:${q.category}:${index}`,
      categorySlug: q.category,
      text: q.question,
      answers: q.answers,
      correctIndex: q.correct,
      difficulty: q.difficulty,
      explanation: q.explanation,
      source: q.source,
      topic: q.topic,
      origin: 'seed'
    }));

    const remote = remoteQuestions.all();
    this.questions = [...seed, ...remote];
    return this;
  }

  get categoriesBySlug() {
    return new Map(this.categories.map((category) => [category.slug, category]));
  }

  countsBySlug() {
    const counts = new Map();
    for (const question of this.questions) {
      counts.set(question.categorySlug, (counts.get(question.categorySlug) ?? 0) + 1);
    }
    return counts;
  }

  /** A kerékre kerülő kategóriák: csak amiben van kérdés. */
  wheelCategories({ onlyHungarian = false } = {}) {
    const counts = this.countsBySlug();
    let list = this.categories
      .filter((category) => (counts.get(category.slug) ?? 0) > 0)
      .map((category) => ({ ...category, questionCount: counts.get(category.slug) ?? 0 }));

    if (onlyHungarian) {
      const hungarian = list.filter((category) => category.is_hungarian);
      // Ha a szűrő szinte mindent kizárna, inkább nem szűrünk.
      if (hungarian.length >= 2) list = hungarian;
    }
    return list.sort((a, b) => a.sort_order - b.sort_order);
  }

  /**
   * Kérdésválasztás offline módban. A szerveroldali logikát utánozza:
   * kizárja a körben már feltetteket és a korábban látottakat, a kért
   * nehézséget preferálja, de nem kényszeríti ki.
   */
  pick({ categorySlug, difficulty, excludeIds }) {
    const inCategory = this.questions.filter((q) => q.categorySlug === categorySlug);
    if (inCategory.length === 0) return null;

    const seen = seenHistory.set();
    let pool = inCategory.filter((q) => !excludeIds.has(q.id) && !seen.has(q.id));

    // Ha minden kérdést látott már, felszabadítjuk a kategória előtörténetét:
    // jobb ismételni, mint játszhatatlanná tenni a kategóriát.
    if (pool.length === 0) {
      seenHistory.releaseCategory(inCategory.map((q) => q.id));
      pool = inCategory.filter((q) => !excludeIds.has(q.id));
    }
    if (pool.length === 0) return null;

    if (difficulty) {
      const matching = pool.filter((q) => q.difficulty === difficulty);
      if (matching.length > 0) pool = matching;
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }
}

/** A válaszok keverése kiszolgáláskor, hogy a tárolt sorrend ne legyen mintázat. */
function shuffleAnswers(question) {
  const correctValue = question.answers[question.correctIndex];
  const answers = [...question.answers];
  for (let i = answers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [answers[i], answers[j]] = [answers[j], answers[i]];
  }
  return { answers, correctIndex: answers.indexOf(correctValue) };
}

// ─────────────────────────── driverek ───────────────────────────

export class OfflineDriver {
  constructor({ bank, rules }) {
    this.bank = bank;
    this.rules = rules ?? FALLBACK_RULES;
    this.isTrusted = false;
    this.sessionId = null;
    this.servedIds = new Set();
    this.served = new Map();     // id → { question, correctIndex }
    this.ordinal = 0;
    this.banked = 0;
  }

  async start() {
    return this.rules;
  }

  async nextQuestion({ categorySlug, difficulty }) {
    const question = this.bank.pick({
      categorySlug,
      difficulty,
      excludeIds: this.servedIds
    });
    if (!question) {
      throw new ApiError('Ebben a kategóriában elfogytak a kérdések.', 'empty_pool');
    }

    const { answers, correctIndex } = shuffleAnswers(question);
    this.servedIds.add(question.id);
    this.served.set(question.id, { question, correctIndex });
    this.ordinal += 1;
    seenHistory.add([question.id]);

    return {
      id: question.id,
      text: question.text,
      answers,
      difficulty: question.difficulty,
      categorySlug: question.categorySlug,
      ordinal: this.ordinal,
      maxQuestions: this.rules.maxQuestions,
      knownCorrectIndex: correctIndex
    };
  }

  async submit({ questionId, answerIndex }) {
    const entry = this.served.get(questionId);
    if (!entry) throw new ApiError('Ismeretlen kérdés.', 'unknown_question');

    const isCorrect = answerIndex === entry.correctIndex;
    const awarded = isCorrect ? reward(this.rules, this.ordinal) : 0;
    this.banked = isCorrect ? this.banked + awarded : penalized(this.rules, this.banked);

    return {
      isCorrect,
      correctIndex: entry.correctIndex,
      explanation: entry.question.explanation,
      source: entry.question.source,
      awardedPoints: awarded,
      bankedScore: this.banked,
      canContinue: isCorrect && this.ordinal < this.rules.maxQuestions
    };
  }

  async finish(localSummary) {
    const entry = results.add({
      score: localSummary.score,
      questions: localSummary.questionsAnswered,
      correct: localSummary.correctAnswers,
      busted: localSummary.busted,
      isTrusted: false
    });
    categoryStats.record(localSummary.entries);

    // Feltöltésre várakozó eredmény: a kliens által generált azonosító
    // egyben idempotencia-kulcs is a szerveren.
    outbox.enqueue('result', {
      clientId: entry.id,
      score: entry.score,
      questions: entry.questions,
      correct: entry.correct,
      busted: entry.busted,
      playedAt: entry.playedAt
    });

    return localSummary;
  }
}

export class OnlineDriver {
  constructor({ supabase, rules = FALLBACK_RULES }) {
    this.supabase = supabase;
    this.sessionId = null;
    this.rules = rules;
    this.isTrusted = true;
  }

  async start() {
    const response = await this.supabase.rpc('start_session', {
      p_mode: 'single',
      p_room_id: null,
      p_client_version: 'pwa/1.0'
    });
    this.sessionId = response.session_id;
    this.rules = parseRules(response.scoring);
    return this.rules;
  }

  async nextQuestion({ categorySlug, difficulty }) {
    const response = await this.supabase.rpc('next_question', {
      p_session: this.sessionId,
      p_category_slug: categorySlug,
      p_difficulty: difficulty ?? null
    });

    const question = response.question;
    return {
      id: question.id,
      text: question.question_text,
      answers: question.answers,
      difficulty: question.difficulty,
      categorySlug: question.category_slug,
      ordinal: response.position,
      maxQuestions: response.max_questions,
      // Online módban a helyes válasz szándékosan NEM jön előre.
      knownCorrectIndex: null
    };
  }

  async submit({ questionId, answerIndex, elapsed }) {
    const response = await this.supabase.rpc('submit_answer', {
      p_session: this.sessionId,
      p_question: questionId,
      p_answer: answerIndex,
      p_answer_ms: Math.round((elapsed ?? 0) * 1000)
    });

    return {
      isCorrect: response.is_correct,
      correctIndex: response.correct_answer,
      explanation: response.explanation,
      source: response.source,
      awardedPoints: response.awarded_points,
      bankedScore: response.banked_score,
      canContinue: response.can_continue
    };
  }

  async finish(localSummary) {
    const response = await this.supabase.rpc('finalize_session', {
      p_session: this.sessionId
    });

    const summary = {
      ...localSummary,
      score: response.score,
      questionsAnswered: response.questions,
      correctAnswers: response.correct,
      busted: response.status === 'busted'
    };

    results.add({
      score: summary.score,
      questions: summary.questionsAnswered,
      correct: summary.correctAnswers,
      busted: summary.busted,
      isTrusted: true,
      mode: 'single'
    });
    categoryStats.record(localSummary.entries);

    return summary;
  }
}

// ─────────────────────────── szinkronizálás ───────────────────────────

export class SyncService {
  constructor({ supabase, bank }) {
    this.supabase = supabase;
    this.bank = bank;
    this.status = 'idle';
    this.isRunning = false;
  }

  get canUseNetwork() {
    return this.supabase.isConfigured && navigator.onLine;
  }

  async run({ force = false } = {}) {
    if (this.isRunning || !this.canUseNetwork) return;
    this.isRunning = true;
    this.status = 'syncing';
    const problems = [];

    try {
      await this.supabase.refreshIfNeeded();

      if (!this.supabase.isSignedIn) {
        // Csendes anonim bejelentkezés: így lesz szerveroldali pontszám és
        // ranglista-jelenlét regisztráció nélkül.
        try {
          await this.supabase.signInAnonymously();
        } catch (error) {
          problems.push(`bejelentkezés: ${error.message}`);
        }
      }

      if (this.supabase.isSignedIn) {
        try {
          await this.flushOutbox();
        } catch (error) {
          problems.push(`feltöltés: ${error.message}`);
        }
      }

      if (force || this.#shouldRefreshQuestions()) {
        try {
          await this.refreshQuestions();
        } catch (error) {
          problems.push(`kérdések: ${error.message}`);
        }
      }
    } finally {
      this.isRunning = false;
      this.status = problems.length ? `hiba: ${problems.join(' · ')}` : 'kész';
    }
  }

  #shouldRefreshQuestions() {
    const last = Number(meta.get('lastQuestionSync', 0));
    return Date.now() - last > 24 * 3600 * 1000;
  }

  async flushOutbox() {
    for (const item of outbox.all()) {
      try {
        if (item.kind === 'result') {
          const response = await this.supabase.rpc('submit_offline_result', {
            p_score: item.payload.score,
            p_questions: item.payload.questions,
            p_correct: item.payload.correct,
            p_busted: item.payload.busted,
            p_played_at: item.payload.playedAt,
            p_client_id: item.payload.clientId
          });
          results.markSynced(response?.result_id ?? item.payload.clientId);
          outbox.remove(item.id);
        } else if (item.kind === 'profile') {
          const userId = this.supabase.userId;
          if (!userId) continue;
          await this.supabase.patch('profiles', `id=eq.${userId}`, item.payload);
          outbox.remove(item.id);
        } else {
          outbox.remove(item.id);
        }
      } catch (error) {
        if (error instanceof ApiError && !error.isRetryable) {
          // Érvénytelen adat: eldobjuk, különben örökre blokkolná a sort.
          outbox.remove(item.id);
        } else {
          outbox.markFailed(item.id, error.message);
          throw error;
        }
      }
    }
  }

  async refreshQuestions() {
    const pack = await this.supabase.rpc('offline_pack', { p_per_category: 12 }, { authorized: false });

    const questions = (pack.questions ?? []).map((row) => ({
      id: row.id,
      categorySlug: row.category_slug,
      text: row.question_text,
      answers: row.answers,
      correctIndex: row.correct_answer,
      difficulty: row.difficulty,
      explanation: row.explanation,
      source: row.source,
      topic: row.topic,
      origin: 'remote'
    }));

    const inserted = remoteQuestions.merge(questions);
    if (pack.scoring) meta.set('scoringRules', pack.scoring);
    meta.set('lastQuestionSync', Date.now());

    // A bank újratöltése, hogy a friss kérdések azonnal játszhatók legyenek.
    await this.bank.load();
    return inserted;
  }

  /** Aktuális pontozási szabály: friss backend → cache → beépített fallback. */
  async scoringRules() {
    if (this.canUseNetwork) {
      try {
        const raw = await this.supabase.rpc('active_scoring_rules', {}, { authorized: false });
        meta.set('scoringRules', raw);
        return parseRules(raw);
      } catch {
        /* offline folytatjuk */
      }
    }
    return parseRules(meta.get('scoringRules', null));
  }
}

/** Egy előre összeállított kliens a globális konfigurációból. */
export const supabase = new Supabase({ url: CONFIG.supabaseUrl, anonKey: CONFIG.supabaseAnonKey });
