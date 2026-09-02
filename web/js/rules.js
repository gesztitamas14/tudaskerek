// A játék szabályai és állapotgépe – tisztán, DOM és hálózat nélkül.
//
// A `scoring_rules` tábla a közös igazság: a szabály onnan érkezik, ez a fájl
// csak a lokális fallbacket és a számítást tartalmazza. Így új pontozás
// bevezetéséhez nem kell új verziót kiadni.
//
// A modul tiszta: nincs benne DOM, hálózat vagy tárolás – ezért a 30 egységteszt
// (`web/tests/rules.test.mjs`) Node-ban, böngésző nélkül fut.

/** A specifikáció szerinti alapszabály: 1-4. és 6-9. 1000, 5. 2000, 10. 5000. */
export const FALLBACK_RULES = Object.freeze({
  maxQuestions: 10,
  rewardTable: [1000, 1000, 1000, 1000, 2000, 1000, 1000, 1000, 1000, 5000],
  penaltyMultiplier: 0.5,
  allowBank: true,
  timeLimitSeconds: null,
  version: 0
});

/** Backendről jövő szabály beolvasása (snake_case → camelCase) + validáció. */
export function parseRules(raw) {
  if (!raw) return FALLBACK_RULES;
  const table = Array.isArray(raw.reward_table) ? raw.reward_table.map(Number) : null;
  const rules = {
    maxQuestions: Number(raw.max_questions ?? table?.length ?? 10),
    rewardTable: table ?? FALLBACK_RULES.rewardTable,
    penaltyMultiplier: Number(raw.penalty_multiplier ?? 0.5),
    allowBank: raw.allow_bank !== false,
    timeLimitSeconds: raw.time_limit_seconds ?? null,
    version: Number(raw.version ?? 0)
  };
  return isUsable(rules) ? rules : FALLBACK_RULES;
}

function isUsable(rules) {
  return (
    Number.isFinite(rules.maxQuestions) &&
    rules.maxQuestions > 0 &&
    rules.maxQuestions <= 100 &&
    Array.isArray(rules.rewardTable) &&
    rules.rewardTable.length > 0 &&
    rules.rewardTable.every((value) => Number.isFinite(value) && value >= 0) &&
    rules.penaltyMultiplier >= 0 &&
    rules.penaltyMultiplier <= 1
  );
}

/** Az `ordinal`. (1-alapú) helyes válasz jutalma. */
export function reward(rules, ordinal) {
  const table = rules.rewardTable;
  if (!table.length || ordinal < 1) return 0;
  return ordinal <= table.length ? table[ordinal - 1] : table[table.length - 1];
}

/** Hibás válasz utáni pontszám (feleződés, lefelé kerekítve). */
export function penalized(rules, score) {
  return score > 0 ? Math.floor(score * rules.penaltyMultiplier) : 0;
}

/** Azok a pozíciók, amelyek az alapnál többet érnek – a UI ezeket kiemeli. */
export function bonusPositions(rules) {
  const base = Math.min(...rules.rewardTable);
  const result = new Set();
  rules.rewardTable.forEach((value, index) => {
    if (value > base) result.add(index + 1);
  });
  return result;
}

export function perfectScore(rules) {
  return rules.rewardTable.slice(0, rules.maxQuestions).reduce((a, b) => a + b, 0);
}

// ─────────────────────────── állapotgép ───────────────────────────

/**
 * Egy kör állapotgépe.
 *
 * Fázisok: idle → spinning → question → revealed → finished
 * A `resolve()` NEM dönti el, mi a helyes válasz – azt kívülről kapja
 * (online: a szerver, offline: a lokális összehasonlítás). Így ugyanez a kód
 * hajtja mindkét módot, és nem kell ismernie a helyes választ.
 */
export class GameEngine {
  constructor(rules = FALLBACK_RULES) {
    this.rules = isUsable(rules) ? rules : FALLBACK_RULES;
    this.phase = 'idle';
    this.score = 0;
    this.ordinal = 0;
    this.answers = [];
    this.currentCategorySlug = null;
    this.outcome = null;      // 'banked' | 'busted' | 'completed'
    this.lastCorrect = null;
  }

  get correctCount() {
    return this.answers.filter((entry) => entry.isCorrect).length;
  }

  get isFinished() {
    return this.phase === 'finished';
  }

  get canServeMore() {
    return this.ordinal < this.rules.maxQuestions && !this.isFinished;
  }

  get nextReward() {
    return reward(this.rules, this.ordinal + 1);
  }

  get scoreIfWrong() {
    return penalized(this.rules, this.score);
  }

  get canBank() {
    return (
      this.rules.allowBank &&
      this.phase === 'revealed' &&
      this.lastCorrect === true &&
      this.canServeMore
    );
  }

  /** Pozíciónkénti eredmény a körjelzőhöz: null = még nem volt. */
  get outcomeMarks() {
    const marks = new Array(this.rules.maxQuestions).fill(null);
    for (const entry of this.answers) {
      if (entry.ordinal >= 1 && entry.ordinal <= marks.length) {
        marks[entry.ordinal - 1] = entry.isCorrect;
      }
    }
    return marks;
  }

  beginSpin() {
    if (this.isFinished || !this.canServeMore) return;
    this.currentCategorySlug = null;
    this.phase = 'spinning';
  }

  present(categorySlug) {
    if (this.isFinished) return;
    this.currentCategorySlug = categorySlug;
    this.ordinal += 1;
    this.phase = 'question';
  }

  /**
   * Válasz feldolgozása.
   * @returns {number} az új kör-pontszám
   */
  resolve({ questionId, isCorrect, elapsed = 0 }) {
    if (this.phase !== 'question') return this.score;

    const awarded = isCorrect ? reward(this.rules, this.ordinal) : 0;
    this.score = isCorrect ? this.score + awarded : penalized(this.rules, this.score);
    this.lastCorrect = isCorrect;

    this.answers.push({
      ordinal: this.ordinal,
      categorySlug: this.currentCategorySlug ?? '',
      questionId,
      isCorrect,
      awarded,
      elapsed
    });

    if (!isCorrect) {
      this.phase = 'finished';
      this.outcome = 'busted';
    } else if (this.ordinal >= this.rules.maxQuestions) {
      this.phase = 'finished';
      this.outcome = 'completed';
    } else {
      this.phase = 'revealed';
    }
    return this.score;
  }

  /** Az idő lejárt: ugyanaz, mint egy hibás válasz. */
  timeOut(questionId) {
    this.resolve({ questionId, isCorrect: false, elapsed: this.rules.timeLimitSeconds ?? 0 });
  }

  /** „Megállok, megtartom a pontjaimat.” */
  bank() {
    if (!this.canBank) return;
    this.phase = 'finished';
    this.outcome = 'banked';
  }

  /** „Megyek tovább.” */
  advance() {
    if (this.phase !== 'revealed' || !this.canServeMore) return;
    this.beginSpin();
  }

  get summary() {
    const questionsAnswered = this.answers.length;
    return {
      score: this.score,
      questionsAnswered,
      correctAnswers: this.correctCount,
      busted: this.outcome === 'busted',
      outcome: this.outcome,
      entries: [...this.answers],
      scoringVersion: this.rules.version,
      perfectScore: perfectScore(this.rules),
      accuracy: questionsAnswered > 0 ? this.correctCount / questionsAnswered : null
    };
  }
}

// ─────────────────────────── kerék matematika ───────────────────────────

export function normalizeDegrees(value) {
  const result = value % 360;
  return result < 0 ? result + 360 : result;
}

export function wedgeAngle(count) {
  return count > 0 ? 360 / count : 360;
}

/**
 * Pörgetés megoldása: megkeressük azt a végszöget, ahol a 12 óránál lévő mutató
 * épp a kiválasztott cikkre esik. Az eredmény determinisztikus – az animáció
 * csak megjeleníti, nem ő dönt.
 */
export function solveSpin({
  targetIndex,
  count,
  currentRotation,
  jitter = 0,
  turns = 5,
  duration = 3.4
}) {
  if (count <= 0) {
    return { targetIndex: 0, finalRotation: currentRotation, duration: 0, turns: 0 };
  }
  const index = ((targetIndex % count) + count) % count;
  const wedge = wedgeAngle(count);
  const center = wedge * (index + 0.5);
  const clampedJitter = Math.max(-1, Math.min(1, jitter));
  const offset = clampedJitter * (wedge * 0.35);

  const desired = normalizeDegrees(360 - center - offset);
  const current = normalizeDegrees(currentRotation);
  let delta = desired - current;
  if (delta < 0) delta += 360;

  return {
    targetIndex: index,
    finalRotation: currentRotation + delta + Math.max(1, turns) * 360,
    duration,
    turns: Math.max(1, turns)
  };
}

/** Melyik cikk van a mutató alatt egy adott elfordulásnál? */
export function indexAt(rotation, count) {
  if (count <= 0) return 0;
  const wedge = wedgeAngle(count);
  const underPointer = normalizeDegrees(360 - normalizeDegrees(rotation));
  return Math.min(Math.floor(underPointer / wedge), count - 1);
}

/**
 * Súlyozott kategóriaválasztás: a legutóbb kisorsolt kategóriák kisebb esélyt
 * kapnak, hogy ne érződjön beragadtnak a kerék.
 */
export function pickWheelIndex(count, recentIndices = [], random = Math.random) {
  if (count <= 1) return 0;
  const weights = new Array(count).fill(1);
  const penalties = [0.12, 0.35, 0.6];
  recentIndices.slice(0, penalties.length).forEach((index, offset) => {
    if (index >= 0 && index < count) weights[index] *= penalties[offset];
  });

  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return Math.floor(random() * count);

  let roll = random() * total;
  for (let index = 0; index < count; index++) {
    roll -= weights[index];
    if (roll <= 0) return index;
  }
  return count - 1;
}
