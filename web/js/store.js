// Lokális tárolás: beállítások, kérdés-cache, eredmények, kimenő sor.
//
// Miért `localStorage` és nem IndexedDB?
//   * A tárolt adat kicsi: néhány száz eredmény és néhány ezer „látott kérdés”
//     azonosító. A kérdésbank maga statikus fájl (`seed-questions.json`), amit a
//     service worker cache-el – nem kell adatbázisba másolni.
//   * A `localStorage` szinkron, ezért nincs versenyhelyzet a játékmenet közben.
//   * iOS Safari mindkettőt ugyanúgy kezeli: a 7 napos törlési szabály alól a
//     home screenre telepített webalkalmazás mentesül, böngészőben viszont
//     mindkettő elveszhet – ezért az eredmények szinkronizálódnak a backendre.
// Ha egyszer a helyi bank tízezres lesz, IndexedDB-re kell váltani: a felület
// (`Store`) ugyanaz maradhat.

const PREFIX = 'tudaskerek.';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    // Privát mód, tiltott tárolás vagy sérült érték: a játék működjön tovább.
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* nincs mit tenni */
  }
}

// ─────────────────────────── beállítások ───────────────────────────

const DEFAULT_SETTINGS = {
  nickname: '',
  avatar: 'fox',
  hapticsEnabled: true,
  soundEnabled: false,
  showExplanations: true,
  onlyHungarianCategories: false,
  reduceWheelSpin: false,
  preferredDifficulty: null,   // null = vegyes
  autoDownloadQuestions: true
};

export const settings = {
  all() {
    return { ...DEFAULT_SETTINGS, ...read('settings', {}) };
  },
  get(key) {
    return this.all()[key];
  },
  set(key, value) {
    const next = this.all();
    next[key] = value;
    write('settings', next);
    return next;
  },
  get displayNickname() {
    const nickname = this.get('nickname');
    return nickname && nickname.trim() ? nickname.trim() : 'Vendég';
  }
};

// ─────────────────────────── meta (kulcs–érték) ───────────────────────────

export const meta = {
  get: (key, fallback = null) => read(`meta.${key}`, fallback),
  set: (key, value) => write(`meta.${key}`, value),
  remove: (key) => remove(`meta.${key}`)
};

// ─────────────────────────── eredmények ───────────────────────────

/**
 * Egy lezárt kör naplója. Ez a személyes statisztika forrása, és akkor is
 * megvan, ha a feltöltés nem sikerült.
 */
export const results = {
  all() {
    return read('results', []);
  },

  add({ score, questions, correct, busted, isTrusted, mode = 'single' }) {
    const entry = {
      id: crypto.randomUUID(),
      score,
      questions,
      correct,
      busted,
      isTrusted: Boolean(isTrusted),
      // Online körnél a szerver már tudja; offline körnél feltöltésre vár.
      isSynced: Boolean(isTrusted),
      mode,
      playedAt: new Date().toISOString()
    };
    const list = this.all();
    list.unshift(entry);
    // Ne nőjön a végtelenbe: 500 kör bőven elég a statisztikához.
    write('results', list.slice(0, 500));
    return entry;
  },

  markSynced(id) {
    const list = this.all().map((entry) =>
      entry.id === id ? { ...entry, isSynced: true } : entry
    );
    write('results', list);
  },

  unsynced() {
    return this.all().filter((entry) => !entry.isSynced);
  },

  clear() {
    remove('results');
    remove('categoryStats');
  }
};

// ─────────────────────── kategóriánkénti statisztika ───────────────────────

export const categoryStats = {
  all() {
    return read('categoryStats', {});
  },

  record(entries) {
    const stats = this.all();
    for (const entry of entries) {
      const slug = entry.categorySlug;
      if (!slug) continue;
      if (!stats[slug]) stats[slug] = { answered: 0, correct: 0 };
      stats[slug].answered += 1;
      if (entry.isCorrect) stats[slug].correct += 1;
    }
    write('categoryStats', stats);
  }
};

// ─────────────────────── látott kérdések (ismétlésvédelem) ───────────────────────

/**
 * A már látott kérdések azonosítói, hogy ne ismétlődjenek.
 * Ha elfogy a bank, a legrégebbi bejegyzéseket elengedjük – különben a
 * kategória játszhatatlanná válna.
 */
export const history = {
  all() {
    return read('seenQuestions', []);
  },

  set() {
    return new Set(this.all());
  },

  add(ids) {
    const list = this.all();
    const seen = new Set(list);
    for (const id of ids) {
      if (!seen.has(id)) {
        list.push(id);
        seen.add(id);
      }
    }
    write('seenQuestions', list.slice(-4000));
  },

  /** Egy kategória előtörténetének felszabadítása, ha kifogytak a kérdések. */
  releaseCategory(categoryQuestionIds) {
    const drop = new Set(categoryQuestionIds);
    write('seenQuestions', this.all().filter((id) => !drop.has(id)));
  },

  clear() {
    remove('seenQuestions');
  }
};

// ─────────────────────── letöltött (remote) kérdések ───────────────────────

export const remoteQuestions = {
  all() {
    return read('remoteQuestions', []);
  },

  merge(questions) {
    const byId = new Map(this.all().map((q) => [q.id, q]));
    let inserted = 0;
    for (const question of questions) {
      if (!byId.has(question.id)) inserted++;
      byId.set(question.id, question);
    }
    // A legfrissebb 3000-et tartjuk meg – a seed bank amúgy is mindig megvan.
    const merged = [...byId.values()].slice(-3000);
    write('remoteQuestions', merged);
    return inserted;
  },

  clear() {
    remove('remoteQuestions');
  }
};

// ─────────────────────────── kimenő sor (outbox) ───────────────────────────

export const outbox = {
  all() {
    return read('outbox', []);
  },

  enqueue(kind, payload) {
    const list = this.all();
    list.push({ id: crypto.randomUUID(), kind, payload, attempts: 0, createdAt: Date.now() });
    write('outbox', list.slice(-200));
  },

  remove(id) {
    write('outbox', this.all().filter((item) => item.id !== id));
  },

  markFailed(id, error) {
    const list = this.all()
      .map((item) =>
        item.id === id
          ? { ...item, attempts: item.attempts + 1, lastError: String(error).slice(0, 200) }
          : item
      )
      // 8 kudarc után feladjuk, hogy ne blokkolja a sort örökre
      .filter((item) => item.attempts < 8);
    write('outbox', list);
  }
};

// ─────────────────────────── összesített statisztika ───────────────────────────

export function localStats(categoriesBySlug = new Map()) {
  const list = results.all();
  const stats = categoryStats.all();

  const byCategory = Object.entries(stats)
    .map(([slug, value]) => ({
      slug,
      name: categoriesBySlug.get(slug)?.name ?? slug,
      icon: categoriesBySlug.get(slug)?.icon ?? null,
      answered: value.answered,
      correct: value.correct,
      accuracy: value.answered > 0 ? value.correct / value.answered : null
    }))
    .sort((a, b) => b.answered - a.answered);

  const questionsAnswered = byCategory.reduce((sum, item) => sum + item.answered, 0);
  const questionsCorrect = byCategory.reduce((sum, item) => sum + item.correct, 0);

  return {
    gamesPlayed: list.length,
    totalScore: list.reduce((sum, item) => sum + item.score, 0),
    bestRoundScore: list.reduce((max, item) => Math.max(max, item.score), 0),
    questionsAnswered,
    questionsCorrect,
    accuracy: questionsAnswered > 0 ? questionsCorrect / questionsAnswered : null,
    byCategory,
    recentResults: list.slice(0, 20)
  };
}

/** Van-e egyáltalán működő tárolás? (privát mód, tiltott cookie-k) */
export function storageAvailable() {
  return write('meta.probe', Date.now());
}
