// A PWA játéklogikájának egységtesztjei.
//
// A pontozás, a feleződés, a bankolás határesetei és a kerékmatematika.
// Böngésző nélkül fut, mert a `rules.js` tiszta logika.
//
// Futtatás: node --test web/tests/rules.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FALLBACK_RULES,
  GameEngine,
  parseRules,
  reward,
  penalized,
  bonusPositions,
  perfectScore,
  solveSpin,
  indexAt,
  normalizeDegrees,
  pickWheelIndex,
  wedgeAngle
} from '../js/rules.js';

// ─────────────────────────── pontozás ───────────────────────────

test('a jutalomtábla megfelel a specifikációnak', () => {
  assert.equal(reward(FALLBACK_RULES, 1), 1000);
  assert.equal(reward(FALLBACK_RULES, 4), 1000);
  assert.equal(reward(FALLBACK_RULES, 5), 2000);
  assert.equal(reward(FALLBACK_RULES, 6), 1000);
  assert.equal(reward(FALLBACK_RULES, 9), 1000);
  assert.equal(reward(FALLBACK_RULES, 10), 5000);
});

test('a teljes kör 15 000 pont', () => {
  assert.equal(perfectScore(FALLBACK_RULES), 15000);
});

test('a bónuszpozíciók az 5. és a 10. kérdés', () => {
  assert.deepEqual([...bonusPositions(FALLBACK_RULES)].sort((a, b) => a - b), [5, 10]);
});

test('a táblán túli pozíció az utolsó értéket adja, nem hibázik', () => {
  assert.equal(reward(FALLBACK_RULES, 25), 5000);
  assert.equal(reward(FALLBACK_RULES, 0), 0);
});

test('a feleződés lefelé kerekít', () => {
  assert.equal(penalized(FALLBACK_RULES, 4001), 2000);
  assert.equal(penalized(FALLBACK_RULES, 1), 0);
  assert.equal(penalized(FALLBACK_RULES, 0), 0);
});

// ─────────────────────────── állapotgép ───────────────────────────

function playCorrect(engine, category = 'magyar-tortenelem') {
  engine.beginSpin();
  engine.present(category);
  engine.resolve({ questionId: 'x', isCorrect: true, elapsed: 1 });
}

test('négy helyes válasz 4000 pont', () => {
  const engine = new GameEngine();
  for (let i = 0; i < 4; i++) playCorrect(engine);
  assert.equal(engine.score, 4000);
  assert.equal(engine.correctCount, 4);
  assert.equal(engine.isFinished, false);
});

test('az ötödik válasz 2000 pontot ér', () => {
  const engine = new GameEngine();
  for (let i = 0; i < 5; i++) playCorrect(engine);
  assert.equal(engine.score, 6000);
});

test('a tizedik helyes válasz lezárja a kört 15 000 ponttal', () => {
  const engine = new GameEngine();
  for (let i = 0; i < 10; i++) playCorrect(engine);
  assert.equal(engine.score, 15000);
  assert.equal(engine.outcome, 'completed');
  assert.equal(engine.canServeMore, false);
});

test('hibás válasz felezi a pontot és lezárja a kört', () => {
  const engine = new GameEngine();
  for (let i = 0; i < 5; i++) playCorrect(engine);
  engine.beginSpin();
  engine.present('tudomany');
  engine.resolve({ questionId: 'y', isCorrect: false, elapsed: 3 });

  assert.equal(engine.score, 3000);
  assert.equal(engine.outcome, 'busted');
  assert.equal(engine.summary.busted, true);
});

test('az első kérdésre adott hibás válasz nullát hagy', () => {
  const engine = new GameEngine();
  engine.beginSpin();
  engine.present('sport');
  engine.resolve({ questionId: 'y', isCorrect: false });
  assert.equal(engine.score, 0);
  assert.equal(engine.summary.questionsAnswered, 1);
  assert.equal(engine.summary.correctAnswers, 0);
});

test('a bankolás megtartja a pontot és lezár', () => {
  const engine = new GameEngine();
  for (let i = 0; i < 3; i++) playCorrect(engine);
  assert.equal(engine.canBank, true);
  engine.bank();
  assert.equal(engine.score, 3000);
  assert.equal(engine.outcome, 'banked');
  assert.equal(engine.summary.busted, false);
});

test('válasz előtt nem lehet bankolni', () => {
  const engine = new GameEngine();
  engine.beginSpin();
  engine.present('zene');
  assert.equal(engine.canBank, false);
  engine.bank();
  assert.equal(engine.isFinished, false);
});

test('hibás válasz után nem lehet bankolni', () => {
  const engine = new GameEngine();
  playCorrect(engine);
  engine.beginSpin();
  engine.present('zene');
  engine.resolve({ questionId: 'z', isCorrect: false });
  assert.equal(engine.canBank, false);
});

test('a tizedik kérdés után nincs bankolás, mert a kör véget ért', () => {
  const engine = new GameEngine();
  for (let i = 0; i < 10; i++) playCorrect(engine);
  assert.equal(engine.canBank, false);
});

test('kiszolgált kérdés nélkül a resolve nem tesz semmit', () => {
  const engine = new GameEngine();
  engine.resolve({ questionId: 'a', isCorrect: true });
  assert.equal(engine.score, 0);
  assert.equal(engine.answers.length, 0);
});

test('lezárt kör után nem indul új pörgetés', () => {
  const engine = new GameEngine();
  playCorrect(engine);
  engine.bank();
  engine.beginSpin();
  assert.equal(engine.outcome, 'banked');
});

test('az outcomeMarks pozíciónként követi az eredményt', () => {
  const engine = new GameEngine();
  playCorrect(engine);
  playCorrect(engine);
  engine.beginSpin();
  engine.present('logika');
  engine.resolve({ questionId: 'q', isCorrect: false });

  const marks = engine.outcomeMarks;
  assert.equal(marks[0], true);
  assert.equal(marks[1], true);
  assert.equal(marks[2], false);
  assert.equal(marks[3], null);
});

test('az időtúllépés ugyanaz, mint egy hibás válasz', () => {
  const engine = new GameEngine();
  for (let i = 0; i < 2; i++) playCorrect(engine);
  engine.beginSpin();
  engine.present('termeszet');
  engine.timeOut('q');
  assert.equal(engine.score, 1000);
  assert.equal(engine.outcome, 'busted');
});

// ─────────────────────────── szabály-validáció ───────────────────────────

test('hibás backend-szabály esetén a fallback lép be', () => {
  const broken = parseRules({ max_questions: 0, reward_table: [], penalty_multiplier: 3 });
  assert.deepEqual(broken, FALLBACK_RULES);
});

test('a backend saját szabályát tiszteljük', () => {
  const custom = parseRules({
    version: 7,
    max_questions: 5,
    reward_table: [500, 500, 1000, 1000, 4000],
    penalty_multiplier: 0.33,
    allow_bank: true,
    time_limit_seconds: 20
  });
  const engine = new GameEngine(custom);
  for (let i = 0; i < 5; i++) playCorrect(engine);
  assert.equal(engine.score, 7000);
  assert.equal(engine.outcome, 'completed');
  assert.equal(penalized(custom, 1000), 330);
});

test('a szabály letilthatja a bankolást', () => {
  const noBank = parseRules({
    version: 3,
    max_questions: 10,
    reward_table: new Array(10).fill(1000),
    penalty_multiplier: 0.5,
    allow_bank: false
  });
  const engine = new GameEngine(noBank);
  playCorrect(engine);
  assert.equal(engine.canBank, false);
});

test('az összegzés pontossága helyes', () => {
  const engine = new GameEngine();
  playCorrect(engine);
  playCorrect(engine);
  engine.beginSpin();
  engine.present('sport');
  engine.resolve({ questionId: 'q', isCorrect: false });

  const summary = engine.summary;
  assert.equal(summary.questionsAnswered, 3);
  assert.equal(summary.correctAnswers, 2);
  assert.ok(Math.abs(summary.accuracy - 2 / 3) < 1e-9);
});

// ─────────────────────────── kerék ───────────────────────────

test('a cikk szöge kiadja a teljes kört', () => {
  assert.equal(wedgeAngle(4), 90);
  assert.ok(Math.abs(wedgeAngle(22) - 360 / 22) < 1e-9);
  assert.equal(wedgeAngle(0), 360);
});

test('a kiszámolt végszög a célcikkre esik', () => {
  for (const count of [2, 3, 5, 12, 18, 22, 25]) {
    for (let target = 0; target < count; target++) {
      const spin = solveSpin({ targetIndex: target, count, currentRotation: 0, jitter: 0, turns: 4 });
      assert.equal(
        indexAt(spin.finalRotation, count),
        target,
        `count=${count} target=${target}`
      );
    }
  }
});

test('a jitter nem tolja át másik cikkre', () => {
  for (let jitter = -1; jitter <= 1; jitter += 0.25) {
    for (let target = 0; target < 22; target++) {
      const spin = solveSpin({ targetIndex: target, count: 22, currentRotation: 137.5, jitter, turns: 5 });
      assert.equal(indexAt(spin.finalRotation, 22), target, `jitter=${jitter} target=${target}`);
    }
  }
});

test('a kerék mindig előre pörög', () => {
  let rotation = 0;
  for (let i = 0; i < 30; i++) {
    const spin = solveSpin({
      targetIndex: Math.floor(Math.random() * 22),
      count: 22,
      currentRotation: rotation,
      jitter: Math.random() * 2 - 1,
      turns: 3
    });
    assert.ok(spin.finalRotation > rotation);
    rotation = spin.finalRotation;
  }
});

test('a túl nagy és negatív index körbefordul', () => {
  assert.equal(solveSpin({ targetIndex: 25, count: 22, currentRotation: 0 }).targetIndex, 3);
  assert.equal(solveSpin({ targetIndex: -1, count: 22, currentRotation: 0 }).targetIndex, 21);
});

test('a szögnormalizálás 0 és 360 közé esik', () => {
  assert.equal(normalizeDegrees(-90), 270);
  assert.equal(normalizeDegrees(720), 0);
  assert.equal(normalizeDegrees(450), 90);
});

test('a kerék ritkítja a legutóbbi kategóriát, de nem tiltja', () => {
  // Determinisztikus generátor, hogy a teszt ne legyen szeszélyes
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const count = 10;
  const hits = new Array(count).fill(0);
  const rounds = 4000;
  for (let i = 0; i < rounds; i++) hits[pickWheelIndex(count, [3], random)]++;

  const average = rounds / count;
  assert.ok(hits[3] < average * 0.5, `a legutóbbi kategória túl gyakran jött: ${hits[3]}`);
  assert.ok(hits[3] > 0, 'nem tiltjuk, csak ritkítjuk');
});

test('a kerékválasztás mindig érvényes indexet ad', () => {
  for (let count = 2; count <= 25; count++) {
    for (let i = 0; i < 50; i++) {
      const index = pickWheelIndex(count, [0, 1, 2]);
      assert.ok(index >= 0 && index < count);
    }
  }
  assert.equal(pickWheelIndex(1, [0]), 0);
});
