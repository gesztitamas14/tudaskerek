// A játékképernyő: kerék → kérdés → válasz-eredmény → döntés → kör vége.
//
// A képernyő szándékosan nem tudja, hogy online vagy offline driverrel
// dolgozik – lásd `api.js`.

import { GameEngine, bonusPositions, pickWheelIndex } from './rules.js';
import { ApiError, OfflineDriver, OnlineDriver } from './api.js';
import { settings, meta } from './store.js';
import { Wheel } from './wheel.js';
import {
  el, clear, card, primaryButton, progressBar, scorePill, categoryBadge,
  stateMessage, spinner, toast, haptic, HAPTIC, confetti, fmt
} from './ui.js';

const LETTERS = ['A', 'B', 'C', 'D'];

export class GameScreen {
  /**
   * @param {object} app - az alkalmazás kontextusa (bank, supabase, sync, nav)
   * @param {{onRoundFinished?: (summary: object) => void}} options
   */
  constructor(app, options = {}) {
    this.app = app;
    this.onRoundFinished = options.onRoundFinished ?? null;

    this.root = el('div.game-screen');
    this.header = el('header.game-header');
    this.stage = el('main.game-stage');
    this.root.append(this.header, this.stage);

    this.engine = new GameEngine();
    this.driver = null;
    this.categories = [];
    this.currentQuestion = null;
    this.outcome = null;
    this.selectedAnswer = null;
    this.finalSummary = null;
    this.questionShownAt = 0;
    this.isBusy = false;
    this.recentWheelIndices = meta.get('recentWheelIndices', []);
    this.didReport = false;
  }

  // ─────────────────────────── életciklus ───────────────────────────

  async mount(container) {
    container.append(this.root);
    this.stage.append(spinner('Kör előkészítése…'));

    try {
      await this.prepare();
    } catch (error) {
      this.renderFailure(error.message);
    }
  }

  unmount() {
    this.wheel?.stop();
  }

  async prepare() {
    const { bank, supabase, sync } = this.app;

    this.categories = bank.wheelCategories({
      onlyHungarian: settings.get('onlyHungarianCategories')
    });

    if (this.categories.length < 2) {
      this.renderFailure(
        'Nincs elég kategória kérdésekkel. Frissítsd a kérdéseket a Beállításokban.'
      );
      return;
    }

    const rules = await sync.scoringRules();

    // Online kör csak akkor, ha minden megvan: backend, hálózat, bejelentkezés.
    // Bármelyik hiányzik → offline kör, ami teljes értékű, csak a globális
    // ranglistán nem számít.
    let driver = null;
    if (supabase.isConfigured && navigator.onLine) {
      if (!supabase.isSignedIn) {
        try {
          await supabase.signInAnonymously();
        } catch {
          /* marad az offline mód */
        }
      }
      if (supabase.isSignedIn) {
        const online = new OnlineDriver({ supabase, rules });
        try {
          const serverRules = await online.start();
          driver = online;
          this.engine = new GameEngine(serverRules);
        } catch (error) {
          console.info('Online kör nem indult el, offline folytatjuk:', error.message);
        }
      }
    }

    if (!driver) {
      driver = new OfflineDriver({ bank, rules });
      await driver.start();
      this.engine = new GameEngine(rules);
    }

    this.driver = driver;
    this.renderWheelStage();
  }

  // ─────────────────────────── fejléc ───────────────────────────

  renderHeader() {
    clear(this.header);

    const closeButton = el('button.icon-btn', {
      type: 'button',
      'aria-label': 'Kilépés a körből',
      text: '✕',
      on: { click: () => this.confirmExit() }
    });

    const trustBadge = el('span.trust-badge', {
      class: this.driver?.isTrusted ? 'trust-online' : 'trust-offline',
      title: this.driver?.isTrusted
        ? 'A szerver ellenőrzi a válaszokat – az eredmény a ranglistára kerül.'
        : 'Offline kör – a személyes statisztikába számít, a globális ranglistára nem.',
      text: this.driver?.isTrusted ? '🛡️' : '📴'
    });

    this.header.append(
      el('div.game-header-row', null, [
        closeButton,
        scorePill('Kör pontja', this.engine.score),
        trustBadge
      ]),
      progressBar({
        current: this.engine.ordinal,
        total: this.engine.rules.maxQuestions,
        marks: this.engine.outcomeMarks,
        bonus: bonusPositions(this.engine.rules)
      })
    );
  }

  confirmExit() {
    if (this.engine.isFinished || this.engine.ordinal === 0) {
      this.leave();
      return;
    }
    const confirmed = window.confirm(
      'Kilépsz a körből? A kör eddig összegyűjtött pontjai elveszik.'
    );
    if (confirmed) this.leave();
  }

  leave() {
    this.unmount();
    if (this.onRoundFinished) this.onRoundFinished(null);
    else this.app.navigate('home');
  }

  // ─────────────────────────── kerék ───────────────────────────

  renderWheelStage() {
    this.renderHeader();
    clear(this.stage);

    const canvas = el('canvas.wheel', { width: 320, height: 320 });
    const wheelHost = el('div.wheel-host', null, canvas);

    const prompt = el('div.wheel-prompt');
    const spinButton = primaryButton('Pörgetés', () => this.spin(), { tone: 'gold' });

    this.stage.append(
      wheelHost,
      el('div.wheel-caption'),
      el('div.wheel-actions', null, [prompt, spinButton])
    );

    this.wheel = new Wheel(canvas);
    this.wheel.setCategories(this.categories);
    this.spinButton = spinButton;
    this.wheelCaption = this.stage.querySelector('.wheel-caption');

    this.updateWheelPrompt(prompt);
    // Az első pörgetés előtt a méret még változhat (layout), ezért újraszámoljuk.
    requestAnimationFrame(() => this.wheel.resize());
  }

  updateWheelPrompt(prompt) {
    clear(prompt);
    if (this.engine.ordinal === 0) {
      prompt.append(
        el('h2', { text: 'Pörgesd meg a kereket!' }),
        el('p', {
          text:
            'A kerék választ kategóriát. Minden helyes válasz után eldöntheted, ' +
            'hogy megállsz vagy továbbmész.'
        })
      );
    } else {
      prompt.append(
        el('h2.gold', {
          text: `${this.engine.ordinal + 1}. kérdés – ${fmt.points(this.engine.nextReward)} pontért`
        })
      );
    }
  }

  async spin() {
    if (this.isBusy || this.wheel?.isSpinning) return;
    this.isBusy = true;
    this.spinButton.disabled = true;
    this.spinButton.querySelector('span:last-child').textContent = 'Pörög…';

    this.engine.beginSpin();
    this.selectedAnswer = null;
    this.outcome = null;
    this.didReport = false;
    clear(this.wheelCaption);

    const targetIndex = pickWheelIndex(this.categories.length, this.recentWheelIndices);
    const reduced = settings.get('reduceWheelSpin');

    const landedIndex = await this.wheel.spinTo({
      targetIndex,
      turns: reduced ? 2 : 4 + Math.floor(Math.random() * 3),
      duration: reduced ? 1.2 : 3 + Math.random() * 0.8,
      jitter: Math.random() * 1.6 - 0.8,
      onTick: (intensity) => haptic(Math.max(4, Math.round(HAPTIC.tick * intensity)))
    });

    haptic(HAPTIC.stop);

    const category = this.categories[landedIndex];
    this.recentWheelIndices = [landedIndex, ...this.recentWheelIndices].slice(0, 6);
    meta.set('recentWheelIndices', this.recentWheelIndices);

    this.wheelCaption.append(categoryBadge(category));

    // Rövid szünet, hogy a játékos lássa, mit pörgetett ki.
    await new Promise((resolve) => setTimeout(resolve, 650));
    await this.loadQuestion(category);
  }

  // ─────────────────────────── kérdés ───────────────────────────

  async loadQuestion(category, retryCount = 0) {
    try {
      const question = await this.driver.nextQuestion({
        categorySlug: category.slug,
        difficulty: settings.get('preferredDifficulty')
      });

      this.engine.present(category.slug);
      this.currentQuestion = question;
      this.questionShownAt = performance.now();
      this.isBusy = false;
      this.renderQuestionStage(category);
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'empty_pool') {
        await this.handleEmptyCategory(category, retryCount);
        return;
      }
      if (error instanceof ApiError && error.isRetryable && retryCount === 0 && this.driver.isTrusted) {
        // Megszakadt a kapcsolat a kör közepén: offline driverre váltunk, hogy
        // a kör ne szakadjon meg.
        toast('Megszakadt a kapcsolat – offline folytatjuk.', { tone: 'warn' });
        const offline = new OfflineDriver({ bank: this.app.bank, rules: this.engine.rules });
        await offline.start();
        this.driver = offline;
        await this.loadQuestion(category, retryCount + 1);
        return;
      }
      this.isBusy = false;
      this.renderFailure(error.message);
    }
  }

  async handleEmptyCategory(category, retryCount) {
    if (retryCount >= 3) {
      toast('Elfogytak a kérdések – a kört lezárjuk.', { tone: 'warn' });
      await this.bankRound();
      return;
    }
    const alternatives = this.categories.filter((item) => item.slug !== category.slug);
    const next = alternatives[Math.floor(Math.random() * alternatives.length)];
    if (!next) {
      await this.bankRound();
      return;
    }
    toast(`${category.name}: elfogytak a kérdések, jön a ${next.name}.`, { tone: 'warn' });
    clear(this.wheelCaption);
    this.wheelCaption.append(categoryBadge(next));
    await this.loadQuestion(next, retryCount + 1);
  }

  renderQuestionStage(category) {
    this.renderHeader();
    clear(this.stage);

    const question = this.currentQuestion;
    const questionCard = card([
      el('div.question-meta', null, [
        el('span', { text: fmt.difficulty(question.difficulty) }),
        el('span.gold', { text: `${fmt.points(this.engine.nextReward)} pont` })
      ]),
      el('h2.question-text', {
        text: question.text,
        class: question.text.length > 120 ? 'question-long' : ''
      })
    ]);

    const answersHost = el('div.answers');
    question.answers.forEach((answer, index) => {
      answersHost.append(
        el(
          'button.answer',
          {
            type: 'button',
            dataset: { index: String(index) },
            on: { click: () => this.answer(index) }
          },
          [
            el('span.answer-letter', { text: LETTERS[index] ?? '?' }),
            el('span.answer-text', { text: answer })
          ]
        )
      );
    });

    this.stage.append(
      el('div.question-category', null, categoryBadge(category, { compact: true })),
      questionCard,
      answersHost
    );
    this.answersHost = answersHost;
  }

  async answer(index) {
    if (this.selectedAnswer !== null || this.isBusy || !this.currentQuestion) return;
    this.selectedAnswer = index;
    this.isBusy = true;

    for (const button of this.answersHost.querySelectorAll('.answer')) {
      button.disabled = true;
      if (Number(button.dataset.index) === index) button.classList.add('answer-selected');
    }

    const elapsed = (performance.now() - this.questionShownAt) / 1000;

    try {
      const outcome = await this.driver.submit({
        questionId: this.currentQuestion.id,
        answerIndex: index,
        elapsed
      });
      this.applyOutcome(outcome, elapsed);
    } catch (error) {
      // Ha a beküldés nem megy, de offline ismerjük a helyes választ, lokálisan
      // értékelünk. Ha nem ismerjük, visszaengedjük a választ.
      const known = this.currentQuestion.knownCorrectIndex;
      if (known !== null && known !== undefined) {
        const isCorrect = known === index;
        this.applyOutcome(
          {
            isCorrect,
            correctIndex: known,
            explanation: null,
            source: null,
            awardedPoints: isCorrect ? this.engine.nextReward : 0,
            bankedScore: isCorrect
              ? this.engine.score + this.engine.nextReward
              : this.engine.scoreIfWrong,
            canContinue: isCorrect && this.engine.canServeMore
          },
          elapsed
        );
        toast('Offline értékelés – az eredmény később szinkronizálódik.', { tone: 'warn' });
      } else {
        this.selectedAnswer = null;
        this.isBusy = false;
        for (const button of this.answersHost.querySelectorAll('.answer')) {
          button.disabled = false;
          button.classList.remove('answer-selected');
        }
        toast(error.message, { tone: 'error' });
        haptic(HAPTIC.wrong);
      }
    }
  }

  applyOutcome(outcome, elapsed) {
    this.outcome = outcome;
    this.engine.resolve({
      questionId: this.currentQuestion.id,
      isCorrect: outcome.isCorrect,
      elapsed
    });

    // A gombok színezése
    for (const button of this.answersHost.querySelectorAll('.answer')) {
      const index = Number(button.dataset.index);
      button.classList.remove('answer-selected');
      if (index === outcome.correctIndex) button.classList.add('answer-correct');
      else if (index === this.selectedAnswer) button.classList.add('answer-wrong');
      else button.classList.add('answer-dimmed');
    }

    haptic(outcome.awardedPoints >= 2000 ? HAPTIC.bigWin : outcome.isCorrect ? HAPTIC.correct : HAPTIC.wrong);

    this.isBusy = false;
    this.renderHeader();

    // Hagyunk időt arra, hogy a játékos lássa a kijelölt válaszokat, mielőtt
    // a döntési képernyő átveszi a helyét. Hibás válasznál kicsit többet, mert
    // ott van mit feldolgozni.
    const revealDelay = outcome.isCorrect ? 900 : 1300;
    if (this.engine.isFinished) {
      setTimeout(() => this.finishRound(), revealDelay);
    } else {
      setTimeout(() => this.renderAnswerStage(), revealDelay);
    }
  }

  // ─────────────────────────── válasz eredménye ───────────────────────────

  renderAnswerStage() {
    this.renderHeader();
    clear(this.stage);

    const outcome = this.outcome;
    const question = this.currentQuestion;
    const isCorrect = outcome.isCorrect;

    const banner = el('div.result-banner', null, [
      el('div.result-icon', { class: isCorrect ? 'good' : 'bad', text: isCorrect ? '✓' : '✕' }),
      el('h2', { text: isCorrect ? 'Helyes!' : 'Sajnos nem' }),
      isCorrect && outcome.awardedPoints > 0
        ? el('div.result-points', { text: `+${fmt.points(outcome.awardedPoints)} pont` })
        : null
    ]);

    const details = card([
      el('p.muted', { text: question.text }),
      el('hr'),
      el('div.correct-answer', null, [
        el('span.check', { text: '✓' }),
        el('strong', { text: question.answers[outcome.correctIndex] ?? '' })
      ]),
      settings.get('showExplanations') && outcome.explanation
        ? el('p.explanation', { text: outcome.explanation })
        : null,
      outcome.source ? el('p.source', { text: outcome.source }) : null
    ]);

    const decision = el('div.decision', null, [
      card(
        [
          el('div.decision-row', null, [
            el('div', null, [
              el('span.muted.small', { text: 'Ha továbbmész' }),
              el('div.good.big', { text: `+${fmt.points(this.engine.nextReward)}` })
            ]),
            el('div.right', null, [
              el('span.muted.small', { text: 'Ha rontasz' }),
              el('div.bad.big', { text: fmt.points(this.engine.scoreIfWrong) })
            ])
          ])
        ],
        { padding: '14px' }
      ),
      primaryButton(`Tovább – ${this.engine.ordinal + 1}. kérdés`, () => this.continueRound()),
      this.engine.canBank
        ? primaryButton(
            `Megállok – ${fmt.points(this.engine.score)} pont az enyém`,
            () => this.bankRound(),
            { tone: 'secondary' }
          )
        : null,
      el('button.link-btn', {
        type: 'button',
        text: this.didReport ? 'Bejelentve' : 'Hibás kérdés bejelentése',
        disabled: this.didReport,
        on: { click: () => this.reportQuestion() }
      })
    ]);

    this.stage.append(banner, details, decision);
  }

  continueRound() {
    haptic(HAPTIC.tap);
    this.engine.advance();
    this.currentQuestion = null;
    this.outcome = null;
    this.selectedAnswer = null;
    this.renderWheelStage();
    // A ritmus miatt azonnal indítjuk a következő pörgetést.
    requestAnimationFrame(() => this.spin());
  }

  async reportQuestion() {
    if (this.didReport || !this.currentQuestion) return;
    this.didReport = true;
    const { supabase } = this.app;
    if (supabase.isConfigured && supabase.isSignedIn && navigator.onLine) {
      try {
        await supabase.rpc('report_question', {
          p_question: this.currentQuestion.id,
          p_reason: null
        });
      } catch {
        /* nem kritikus */
      }
    }
    toast('Köszönjük, megjelöltük a kérdést ellenőrzésre.');
    this.renderAnswerStage();
  }

  // ─────────────────────────── kör vége ───────────────────────────

  async bankRound() {
    haptic(HAPTIC.tap);
    this.engine.bank();
    await this.finishRound();
  }

  async finishRound() {
    const local = this.engine.summary;
    try {
      this.finalSummary = await this.driver.finish(local);
    } catch (error) {
      console.info('A kör lezárása a szerveren nem sikerült:', error.message);
      const offline = new OfflineDriver({ bank: this.app.bank, rules: this.engine.rules });
      this.finalSummary = await offline.finish(local);
      toast('Az eredmény offline mentve, később szinkronizálódik.', { tone: 'warn' });
    }

    this.renderRoundResult();
    // A háttérben megpróbáljuk feltölteni, amit lehet.
    this.app.sync.run().catch(() => {});
  }

  renderRoundResult() {
    this.renderHeader();
    clear(this.stage);

    const summary = this.finalSummary;
    const maxQuestions = this.engine.rules.maxQuestions;
    const isPerfect = summary.questionsAnswered >= maxQuestions && !summary.busted;

    const title = summary.busted
      ? 'Elrontottad'
      : isPerfect
        ? 'Teljes kör!'
        : 'Megálltál';
    const subtitle = summary.busted
      ? 'A kör pontja feleződött. A következő kör új esély.'
      : isPerfect
        ? `Mind a ${maxQuestions} kérdést végigvitted.`
        : 'Okos döntés: a pontok a tieid.';

    const scoreCard = card([
      el('div.muted.small.center', { text: 'VÉGPONTSZÁM' }),
      el('div.final-score', { text: fmt.points(summary.score) }),
      el('div.stat-row', null, [
        stat('Kérdés', String(summary.questionsAnswered)),
        stat('Helyes', String(summary.correctAnswers)),
        stat('Pontosság', fmt.percent(summary.accuracy))
      ]),
      this.driver.isTrusted
        ? null
        : el('p.warn.small.center', {
            text: 'Offline kör – a globális ranglistán nem számít, a statisztikádban igen.'
          })
    ]);

    const breakdown = card([
      el('h3', { text: 'Kérdésenként' }),
      ...(summary.entries.length
        ? summary.entries.map((entry) =>
            el('div.breakdown-row', null, [
              el('span.muted', { text: `${entry.ordinal}.` }),
              el('span', { class: entry.isCorrect ? 'good' : 'bad', text: entry.isCorrect ? '✓' : '✕' }),
              el('span.grow', { text: this.categoryName(entry.categorySlug) }),
              el('span.gold', { text: entry.isCorrect ? `+${fmt.points(entry.awarded)}` : '–' })
            ])
          )
        : [el('p.muted', { text: 'Ebben a körben nem volt megválaszolt kérdés.' })])
    ]);

    const actions = this.onRoundFinished
      ? el('div.actions', null, [
          primaryButton('Vissza a szobába', () => this.onRoundFinished?.(summary))
        ])
      : el('div.actions', null, [
          primaryButton('Új kör', () => this.app.navigate('game'), { tone: 'gold' }),
          primaryButton('Vissza a főoldalra', () => this.app.navigate('home'), { tone: 'secondary' })
        ]);

    this.stage.append(
      el('div.round-result-head', null, [
        el('div.result-icon.big', {
          class: summary.busted ? 'bad' : 'gold',
          text: summary.busted ? '↓' : isPerfect ? '👑' : '✋'
        }),
        el('h2', { text: title }),
        el('p.muted', { text: subtitle })
      ]),
      scoreCard,
      breakdown,
      actions
    );

    if (!summary.busted && summary.score > 0) {
      confetti(this.root);
      haptic(HAPTIC.bigWin);
    }
  }

  categoryName(slug) {
    return this.categories.find((category) => category.slug === slug)?.name ?? slug;
  }

  renderFailure(message) {
    this.renderHeader();
    clear(this.stage);
    this.stage.append(
      stateMessage({
        icon: '⚠',
        title: 'Nem sikerült elindítani',
        message,
        actionLabel: 'Vissza',
        action: () => this.app.navigate('home')
      })
    );
  }
}

function stat(title, value) {
  return el('div.stat', null, [
    el('div.stat-value', { text: value }),
    el('div.stat-title', { text: title })
  ]);
}
