// A nem játékbeli képernyők: főoldal, statisztika, ranglista, profil,
// beállítások, névjegy.

import { CONFIG } from './config.js';
import { settings, results, history, remoteQuestions, localStats } from './store.js';
import { Wheel } from './wheel.js';
import { sfx, setSoundEnabled } from './sound.js';
import {
  el, clear, card, primaryButton, stateMessage, spinner, toast, fmt,
  AVATARS, avatarEmoji, haptic, HAPTIC
} from './ui.js';

// ─────────────────────────── főoldal ───────────────────────────

export function homeScreen(app) {
  const root = el('div.screen');
  const canvas = el('canvas.wheel', { width: 280, height: 280 });

  const categories = app.bank.wheelCategories({
    onlyHungarian: settings.get('onlyHungarianCategories')
  });
  const stats = localStats(app.bank.categoriesBySlug);

  const hero = el('div.hero', null, [
    el('div.wheel-host.wheel-host-small', null, canvas),
    el('p.hero-text', {
      text: 'Pörgesd meg, válaszolj, és döntsd el: megállsz vagy kockáztatsz?'
    })
  ]);

  const canPlay = categories.length >= 2;
  const online = app.supabase.isConfigured && navigator.onLine;

  const actions = el('div.actions', null, [
    primaryButton('Egyjátékos kör', () => app.navigate('game'), {
      tone: 'gold',
      disabled: !canPlay
    }),
    primaryButton('Online többjátékos', () => app.navigate('multiplayer'), {
      tone: 'secondary',
      disabled: !online
    }),
    !online
      ? el('p.muted.small.center', {
          text: app.supabase.isConfigured
            ? 'A többjátékos módhoz internet kell.'
            : 'A többjátékos módhoz be kell állítani a backendet (lásd README).'
        })
      : null,
    !canPlay
      ? el('p.warn.small.center', {
          text: 'Még nincs elég kategória kérdésekkel. Frissítsd a kérdéseket a Beállításokban.'
        })
      : null
  ]);

  const statusRow = el('div.status-row', null, [
    navigator.onLine ? null : el('span.chip.chip-warn', { text: '📴 Offline mód' }),
    el('span.muted.small', {
      text: `${app.bank.questions.length} kérdés helyben · ${categories.length} kategória`
    })
  ]);

  const quickStats = card([
    el('div.card-head', null, [
      el('h3', { text: 'Eredményeid' }),
      el('span.muted.small', { text: settings.displayNickname })
    ]),
    el('div.metric-row', null, [
      metric('Legjobb kör', fmt.points(stats.bestRoundScore), '🏆'),
      metric('Összpont', fmt.points(stats.totalScore), '⭐'),
      metric('Körök', String(stats.gamesPlayed), '🎯')
    ]),
    stats.accuracy !== null
      ? el('div.accuracy', null, [
          el('div.accuracy-head', null, [
            el('span.muted.small', { text: 'Helyes válaszok aránya' }),
            el('span.gold.small', { text: fmt.percent(stats.accuracy) })
          ]),
          el('div.bar', null, el('div.bar-fill', { style: { width: `${stats.accuracy * 100}%` } }))
        ])
      : null
  ]);

  root.append(hero, actions, statusRow, quickStats);

  // A dekoratív kerék lassan forog a főoldalon.
  requestAnimationFrame(() => {
    const wheel = new Wheel(canvas);
    wheel.setCategories(categories);
    wheel.startIdleSpin(5);
    root.addEventListener('screen:unmount', () => wheel.stop(), { once: true });
  });

  return root;
}

function metric(title, value, icon) {
  return el('div.metric', null, [
    el('div.metric-icon', { text: icon }),
    el('div.metric-value', { text: value }),
    el('div.metric-title', { text: title })
  ]);
}

// ─────────────────────────── statisztika ───────────────────────────

export async function statsScreen(app) {
  const root = el('div.screen');
  root.append(spinner());

  let stats = localStats(app.bank.categoriesBySlug);

  // Ha van backend és bejelentkezés, a szerver adata a hitelesebb (több eszközt
  // összegez) – de a lokális mindig megjelenik előbb.
  if (app.supabase.isConfigured && app.supabase.isSignedIn && navigator.onLine) {
    try {
      const remote = await app.supabase.rpc('my_stats');
      const profile = remote.profile ?? {};
      stats = {
        ...stats,
        gamesPlayed: profile.games_played ?? stats.gamesPlayed,
        totalScore: profile.total_score ?? stats.totalScore,
        bestRoundScore: profile.best_round_score ?? stats.bestRoundScore,
        questionsAnswered: profile.questions_answered ?? stats.questionsAnswered,
        questionsCorrect: profile.questions_correct ?? stats.questionsCorrect,
        accuracy: profile.accuracy ?? stats.accuracy,
        byCategory: (remote.by_category ?? []).length
          ? remote.by_category.map((row) => ({
              slug: row.slug,
              name: row.name,
              // A my_stats RPC nem ad ikont – a helyi katalógusból pótoljuk.
              icon: app.bank.categoriesBySlug.get(row.slug)?.icon ?? null,
              answered: row.answered,
              correct: row.correct,
              accuracy: row.answered ? row.correct / row.answered : null
            }))
          : stats.byCategory
      };
    } catch {
      /* offline adat marad */
    }
  }

  clear(root);

  if (stats.gamesPlayed === 0) {
    root.append(
      stateMessage({
        icon: '📊',
        title: 'Még nincs adat',
        message: 'Játssz le egy kört, és itt megjelenik a teljesítményed kategóriákra bontva.'
      })
    );
    return root;
  }

  root.append(
    card([
      el('div.tile-grid', null, [
        tile('Összpont', fmt.points(stats.totalScore), 'gold'),
        tile('Legjobb kör', fmt.points(stats.bestRoundScore), 'warn'),
        tile('Lejátszott kör', String(stats.gamesPlayed), 'primary'),
        tile('Pontosság', fmt.percent(stats.accuracy), 'good')
      ]),
      el('p.muted.small', {
        text: `${stats.questionsCorrect} helyes / ${stats.questionsAnswered} kérdés`
      })
    ]),

    card([
      el('h3', { text: 'Kategóriák szerint' }),
      ...(stats.byCategory.length
        ? stats.byCategory.map((item) =>
            el('div.cat-stat', null, [
              el('div.cat-stat-head', null, [
                el('span.grow', null, [
                  item.icon ? `${item.icon} ` : '',
                  item.name
                ]),
                el('span.muted.small', { text: `${item.correct}/${item.answered}` }),
                el('span.small', {
                  class: accuracyTone(item.accuracy),
                  text: fmt.percent(item.accuracy)
                })
              ]),
              el('div.bar', null,
                el('div.bar-fill', {
                  class: accuracyTone(item.accuracy),
                  style: { width: `${(item.accuracy ?? 0) * 100}%` }
                })
              )
            ])
          )
        : [el('p.muted', { text: 'Még nincs kategóriabontás.' })])
    ]),

    card([
      el('h3', { text: 'Legutóbbi körök' }),
      ...(stats.recentResults.length
        ? stats.recentResults.map((result) =>
            el('div.result-row', null, [
              el('span', { class: result.busted ? 'bad' : 'good', text: result.busted ? '↓' : '✓' }),
              el('div.grow', null, [
                el('div', { text: `${fmt.points(result.score)} pont` }),
                el('div.muted.small', {
                  text:
                    `${result.correct}/${result.questions} helyes · ` +
                    fmt.dateTime(result.playedAt)
                })
              ]),
              result.isSynced ? null : el('span.chip.chip-warn.small', { text: 'nincs feltöltve' })
            ])
          )
        : [el('p.muted', { text: 'Még nincs lejátszott kör.' })])
    ])
  );

  return root;
}

function tile(title, value, tone) {
  return el('div.tile', { class: `tile-${tone}` }, [
    el('div.tile-value', { text: value }),
    el('div.tile-title', { text: title })
  ]);
}

function accuracyTone(accuracy) {
  if (accuracy === null || accuracy === undefined) return 'muted';
  if (accuracy >= 0.75) return 'good';
  if (accuracy >= 0.45) return 'warn';
  return 'bad';
}

// ─────────────────────────── ranglista ───────────────────────────

const SCOPES = [
  { id: 'all_time', label: 'Örökrangsor' },
  { id: 'month', label: 'Havi' },
  { id: 'week', label: 'Heti' },
  { id: 'day', label: 'Napi' }
];

export function leaderboardScreen(app) {
  const root = el('div.screen');
  let scope = 'all_time';

  const tabs = el('div.tabs');
  const body = el('div.leaderboard-body');

  function renderTabs() {
    clear(tabs);
    for (const item of SCOPES) {
      tabs.append(
        el('button.tab', {
          type: 'button',
          class: item.id === scope ? 'tab-active' : '',
          text: item.label,
          on: {
            click: () => {
              scope = item.id;
              renderTabs();
              load();
            }
          }
        })
      );
    }
  }

  async function load() {
    clear(body);
    body.append(spinner());

    if (!app.supabase.isConfigured) {
      clear(body);
      body.append(
        stateMessage({
          icon: '🏆',
          title: 'Ranglista nincs beállítva',
          message:
            'A globális ranglistához Supabase backend kell. Amíg nincs, a saját ' +
            'eredményeidet a Statisztika fülön látod.'
        })
      );
      return;
    }
    if (!navigator.onLine) {
      clear(body);
      body.append(
        stateMessage({
          icon: '📴',
          title: 'Nincs internetkapcsolat',
          message: 'A ranglistához hálózat kell. Offline is játszhatsz tovább.',
          actionLabel: 'Újra',
          action: load
        })
      );
      return;
    }

    try {
      const rows = await app.supabase.rpc(
        'leaderboard',
        { p_scope: scope, p_limit: 50 },
        { authorized: false }
      );

      clear(body);
      if (!rows || rows.length === 0) {
        body.append(
          stateMessage({
            icon: '🏆',
            title: 'Még üres',
            message: 'Ebben az időszakban még nincs eredmény. Legyél te az első!'
          })
        );
        return;
      }

      const myId = app.supabase.userId;
      for (const row of rows) {
        const isMe = myId && row.player_id === myId;
        body.append(
          el('div.lb-row', { class: isMe ? 'lb-me' : '' }, [
            el('span.lb-rank', { class: row.rank <= 3 ? `medal medal-${row.rank}` : '', text: String(row.rank) }),
            el('span.lb-avatar', { text: avatarEmoji(row.avatar_id) }),
            el('div.grow', null, [
              el('div', { text: row.nickname }),
              el('div.muted.small', { text: `${row.games} kör` })
            ]),
            el('span.gold', { text: fmt.points(row.best_score) })
          ])
        );
      }

      if (app.supabase.isSignedIn) {
        try {
          const mine = await app.supabase.rpc('my_rank', { p_scope: scope });
          body.append(
            el('div.lb-footer', null, [
              el('span', {
                text: mine.rank ? `A helyezésed: ${mine.rank}.` : 'Még nem vagy a top 200-ban'
              }),
              el('span.gold', { text: fmt.points(mine.best_score ?? 0) })
            ])
          );
        } catch {
          /* nem kritikus */
        }
      }
    } catch (error) {
      clear(body);
      body.append(
        stateMessage({
          icon: '⚠',
          title: 'Ranglista nem elérhető',
          message: error.message,
          actionLabel: 'Újra',
          action: load
        })
      );
    }
  }

  renderTabs();
  root.append(tabs, body);
  load();
  return root;
}

// ─────────────────────────── profil ───────────────────────────

export function profileScreen(app) {
  const root = el('div.screen');
  const stats = localStats(app.bank.categoriesBySlug);

  const nicknameInput = el('input.text-input', {
    type: 'text',
    value: settings.get('nickname'),
    maxLength: 24,
    placeholder: 'Becenév',
    autocomplete: 'nickname'
  });

  const avatarGrid = el('div.avatar-grid');
  function renderAvatars() {
    clear(avatarGrid);
    for (const avatar of AVATARS) {
      avatarGrid.append(
        el('button.avatar-btn', {
          type: 'button',
          class: settings.get('avatar') === avatar.id ? 'avatar-active' : '',
          title: avatar.name,
          text: avatar.emoji,
          on: {
            click: () => {
              settings.set('avatar', avatar.id);
              haptic(HAPTIC.tap);
              renderAvatars();
              app.pushProfile({ avatar_id: avatar.id });
            }
          }
        })
      );
    }
  }
  renderAvatars();

  const identity = card([
    el('div.profile-head', null, [
      el('div.profile-avatar', { text: avatarEmoji(settings.get('avatar')) }),
      el('div.grow', null, [
        el('label.muted.small', { text: 'Becenév' }),
        el('div.input-row', null, [
          nicknameInput,
          primaryButton('Mentés', () => {
            const value = nicknameInput.value.trim();
            if (value.length < 2) {
              toast('A becenév legalább 2 karakter legyen.', { tone: 'warn' });
              return;
            }
            settings.set('nickname', value);
            app.pushProfile({ nickname: value });
            toast('Becenév mentve.');
            app.refreshCurrentScreen();
          })
        ]),
        el('p.muted.small', { text: '2–24 karakter. A ranglistán ez a név látszik.' })
      ])
    ]),
    el('h3', { text: 'Avatar' }),
    avatarGrid
  ]);

  const statsCard = card([
    row('Összpontszám', fmt.points(stats.totalScore)),
    row('Legjobb kör', fmt.points(stats.bestRoundScore)),
    row('Lejátszott körök', String(stats.gamesPlayed)),
    row(
      'Helyes válaszok',
      stats.accuracy === null
        ? '–'
        : `${fmt.percent(stats.accuracy)} (${stats.questionsCorrect}/${stats.questionsAnswered})`
    )
  ]);

  const account = card([
    el('h3', { text: 'Fiók' }),
    el('p.muted.small', { text: accountStatusText(app) }),
    ...accountActions(app)
  ]);

  root.append(identity, statsCard, account);
  return root;
}

function row(title, value) {
  return el('div.kv-row', null, [
    el('span.muted', { text: title }),
    el('strong', { text: value })
  ]);
}

function accountStatusText(app) {
  if (!app.supabase.isConfigured) {
    return 'Offline mód – nincs backend beállítva. Az eredmények csak ezen a készüléken vannak.';
  }
  if (!app.supabase.isSignedIn) {
    return 'Nem vagy bejelentkezve. Az eredmények a készüléken maradnak, amíg nincs kapcsolat.';
  }
  return app.supabase.isAnonymous
    ? 'Vendégfiók. Minden működik, de a pontod nem kerül a nyilvános ranglistára, ' +
      'és készülékcserénél elveszne. Adj meg egy e-mailt vagy jelentkezz be ' +
      'Google-fiókkal – az eredményeid megmaradnak.'
    : 'Bejelentkezve. Az eredményeid a fiókodhoz tartoznak, és felkerülsz a ranglistára.';
}

/**
 * Fiókműveletek: Google OAuth vagy e-mail + jelszó.
 *
 * Miért nem Apple? Ahhoz fizetős Apple Developer tagság (99 USD/év) és egy
 * félévente cserélendő, `.p8` kulccsal aláírt titok kell. A Google-höz csak
 * egy ingyenes Client ID + Secret, az e-mailhez pedig semmi.
 *
 * Vendégként a form NEM új fiókot csinál, hanem a meglévőt alakítja át
 * (`upgradeGuest`) – így nem veszik el a statisztika.
 */
function accountActions(app) {
  if (!app.supabase.isConfigured) return [];

  if (app.supabase.isSignedIn && !app.supabase.isAnonymous) {
    return [
      primaryButton('Kijelentkezés', () => {
        app.supabase.signOut();
        toast('Kijelentkeztél.');
        app.refreshCurrentScreen();
      }, { tone: 'secondary' })
    ];
  }

  const isGuest = app.supabase.isSignedIn && app.supabase.isAnonymous;
  let mode = 'signin';           // 'signin' | 'signup'
  let isWorking = false;

  const emailInput = el('input.text-input', {
    type: 'email',
    inputMode: 'email',
    autocapitalize: 'off',
    autocomplete: 'email',
    spellcheck: false,
    placeholder: 'valaki@example.com'
  });

  const passwordInput = el('input.text-input', {
    type: 'password',
    autocomplete: 'current-password',
    placeholder: 'jelszó (legalább 6 karakter)'
  });

  const feedback = el('p.small.center', { hidden: true });
  const submit = primaryButton('', () => run());

  // Vendégnél nincs „bejelentkezés/regisztráció” választás: a meglévő fiókot
  // alakítjuk át, különben elveszne az addigi statisztika.
  const switcher = el('button.link-btn', {
    type: 'button',
    hidden: isGuest,
    on: {
      click: () => {
        mode = mode === 'signin' ? 'signup' : 'signin';
        paint();
      }
    }
  });

  function paint() {
    submit.querySelector('span:last-child').textContent = isGuest
      ? 'Fiók létrehozása (eredmények megtartva)'
      : mode === 'signin'
        ? 'Bejelentkezés'
        : 'Regisztráció';
    switcher.textContent =
      mode === 'signin' ? 'Nincs még fiókom – regisztrálok' : 'Van már fiókom – bejelentkezés';
    passwordInput.autocomplete = mode === 'signin' && !isGuest ? 'current-password' : 'new-password';
  }

  function say(message, tone = 'muted') {
    feedback.hidden = false;
    feedback.className = `small center ${tone}`;
    feedback.textContent = message;
  }

  async function run() {
    if (isWorking) return;

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      say('Adj meg egy érvényes e-mail címet.', 'bad');
      return;
    }
    if (password.length < 6) {
      say('A jelszó legalább 6 karakter legyen.', 'bad');
      return;
    }

    isWorking = true;
    submit.disabled = true;
    say('Egy pillanat…');

    try {
      if (isGuest) {
        await app.supabase.upgradeGuest(email, password);
        toast('Kész! Az eredményeid megmaradtak.');
      } else if (mode === 'signup') {
        const { needsConfirmation } = await app.supabase.signUpWithEmail(email, password);
        if (needsConfirmation) {
          // A Supabase-en be van kapcsolva az e-mail megerősítés: session még
          // nincs, a felhasználónak a levélben kell kattintania.
          say('Elküldtünk egy megerősítő levelet. Kattints rá, majd jelentkezz be.', 'good');
          return;
        }
        toast('Fiók létrehozva.');
      } else {
        await app.supabase.signInWithEmail(email, password);
        toast('Bejelentkeztél.');
      }
      app.refreshCurrentScreen();
    } catch (error) {
      say(authErrorText(error, mode, isGuest), 'bad');
    } finally {
      // Sikernél a szülő újrarendereli a képernyőt, de az űrlap ne várjon
      // erre: enélkül egy elmaradó újrarenderelés véglegesen letiltaná.
      isWorking = false;
      submit.disabled = false;
    }
  }

  paint();

  return [
    primaryButton('Belépés Google-fiókkal', () => app.supabase.signInWithGoogle(), {
      tone: 'secondary'
    }),

    el('div.auth-divider', null, [el('span', { text: 'vagy e-maillel' })]),

    el('div.auth-form', null, [emailInput, passwordInput, submit, switcher, feedback]),

    isGuest
      ? el('p.muted.small', {
          text:
            'A fiók a MOSTANI vendégfiókodból lesz: a pontjaid, a statisztikád és ' +
            'az előtörténeted megmarad.'
        })
      : null
  ].filter(Boolean);
}

/** A Supabase auth hibái angolul jönnek – a gyakoriakat lefordítjuk. */
function authErrorText(error, mode, isGuest) {
  const raw = String(error?.message ?? error);

  if (/invalid login credentials/i.test(raw)) {
    return 'Hibás e-mail vagy jelszó.';
  }
  if (/already registered|already been registered|user already exists/i.test(raw)) {
    return isGuest
      ? 'Ezzel az e-maillel már van fiók. Jelentkezz ki, és lépj be vele.'
      : 'Ezzel az e-maillel már van fiók – válts bejelentkezésre.';
  }
  if (/email.*not confirmed/i.test(raw)) {
    return 'Az e-mail még nincs megerősítve. Keresd a levelet a postafiókodban.';
  }
  if (/signups? not allowed|email.*disabled|provider.*disabled/i.test(raw)) {
    return 'Az e-mailes regisztráció nincs engedélyezve a Supabase projektben.';
  }
  if (/missing oauth secret|unsupported provider/i.test(raw)) {
    return 'Ez a bejelentkezési szolgáltató nincs beállítva a Supabase-en.';
  }
  if (/password/i.test(raw) && /short|least|weak/i.test(raw)) {
    return 'A jelszó túl rövid vagy túl egyszerű.';
  }
  if (/rate limit|too many/i.test(raw)) {
    return 'Túl sok próbálkozás. Várj egy kicsit, és próbáld újra.';
  }
  return raw;
}

// ─────────────────────────── beállítások ───────────────────────────

export function settingsScreen(app) {
  const root = el('div.screen');

  const difficultySelect = el('select.select', {
    on: {
      change: (event) => {
        const value = event.target.value;
        settings.set('preferredDifficulty', value === 'mixed' ? null : value);
      }
    }
  }, [
    el('option', { value: 'mixed', text: 'Vegyes' }),
    el('option', { value: 'easy', text: 'Könnyű' }),
    el('option', { value: 'medium', text: 'Közepes' }),
    el('option', { value: 'hard', text: 'Nehéz' })
  ]);
  difficultySelect.value = settings.get('preferredDifficulty') ?? 'mixed';

  const refreshButton = primaryButton('Kérdések frissítése most', async () => {
    if (!app.supabase.isConfigured || !navigator.onLine) {
      toast('Ehhez backend és internetkapcsolat kell.', { tone: 'warn' });
      return;
    }
    refreshButton.disabled = true;
    try {
      const inserted = await app.sync.refreshQuestions();
      toast(`Kész: ${inserted} új kérdés. Összesen ${app.bank.questions.length}.`);
      app.refreshCurrentScreen();
    } catch (error) {
      toast(`Nem sikerült: ${error.message}`, { tone: 'error' });
    } finally {
      refreshButton.disabled = false;
    }
  }, { tone: 'secondary' });

  root.append(
    card([
      el('h3', { text: 'Játékmenet' }),
      settingRow('Nehézség', difficultySelect),
      toggleRow('Csak magyar kategóriák', 'onlyHungarianCategories'),
      toggleRow('Rövid pörgetés', 'reduceWheelSpin'),
      toggleRow('Magyarázat megjelenítése', 'showExplanations'),
      el('p.muted.small', {
        text:
          'A „Vegyes” nehézségnél a szerver a kérdés népszerűsége és a te ' +
          'teljesítményed alapján válogat.'
      })
    ]),

    card([
      el('h3', { text: 'Visszajelzés' }),
      toggleRow('Hang', 'soundEnabled'),
      toggleRow('Rezgés', 'hapticsEnabled'),
      el('p.muted.small', {
        text:
          'A hangok szintetizáltak, nincs letöltendő hangfájl. iPhone-on a néma ' +
          'kapcsoló (silent switch) a böngésző hangját is elhallgattatja – ha nem ' +
          'szól, érdemes azt ellenőrizni.'
      }),
      el('p.muted.small', {
        text:
          'iPhone-on a böngésző nem támogatja a rezgést – ez a natív alkalmazás ' +
          'egyik előnye. Androidon és asztali gépen működik.'
      })
    ]),

    card([
      el('h3', { text: 'Kérdésbank' }),
      row('Helyben tárolt kérdés', String(app.bank.questions.length)),
      row('Letöltött (online) kérdés', String(remoteQuestions.all().length)),
      toggleRow('Kérdések automatikus letöltése', 'autoDownloadQuestions'),
      refreshButton
    ]),

    card([
      el('h3', { text: 'Adatok' }),
      row('Kapcsolat', app.supabase.isConfigured
        ? (navigator.onLine ? 'Online' : 'Offline')
        : 'Nincs backend'),
      row('Verzió', CONFIG.version),
      primaryButton('Helyi haladás törlése', () => {
        if (!window.confirm('Törlöd a készüléken tárolt eredményeket és statisztikát?')) return;
        results.clear();
        history.clear();
        toast('A helyi statisztika törölve.');
        app.refreshCurrentScreen();
      }, { tone: 'danger' })
    ]),

    installHint()
  );

  return root;
}

function settingRow(label, control) {
  return el('div.setting-row', null, [el('span', { text: label }), control]);
}

function toggleRow(label, key) {
  const input = el('input', {
    type: 'checkbox',
    checked: Boolean(settings.get(key)),
    on: {
      change: (event) => {
        settings.set(key, event.target.checked);
        if (key === 'hapticsEnabled') haptic(HAPTIC.tap);
        if (key === 'soundEnabled') {
          setSoundEnabled(event.target.checked);
          // Azonnali visszajelzés: a kapcsoló így ellenőrizhető is.
          if (event.target.checked) sfx.correct();
        }
      }
    }
  });
  return el('label.setting-row.toggle', null, [el('span', { text: label }), input]);
}

/** iOS-en a telepítés csak a Safari „Megosztás → Főképernyőre” útján megy. */
function installHint() {
  const isStandalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  if (isStandalone) {
    return card([
      el('h3', { text: 'Telepítve' }),
      el('p.muted.small', {
        text: 'Az alkalmazás a főképernyőről fut. Offline is működik, és az adatok megmaradnak.'
      })
    ]);
  }

  return card([
    el('h3', { text: 'Telepítés a főképernyőre' }),
    el('p.small', {
      text:
        'iPhone: Safari → Megosztás ikon → „Főképernyőhöz adás”. Így saját ikont kap, ' +
        'teljes képernyőn fut, offline is működik, és a tárolt adatok nem törlődnek.'
    }),
    el('p.small', {
      text: 'Android: Chrome → menü → „Alkalmazás telepítése”.'
    })
  ]);
}

// ─────────────────────────── névjegy ───────────────────────────

export async function aboutScreen(app) {
  const root = el('div.screen');

  root.append(
    el('div.about-head', null, [
      el('div.about-logo', { text: '🎡' }),
      el('h2', { text: CONFIG.appName }),
      el('p.muted.small', { text: `Verzió ${CONFIG.version} · web (PWA)` })
    ]),

    card([
      el('h3', { text: 'Hogyan működik?' }),
      bullets([
        'A kerék kisorsol egy kategóriát.',
        'Négy válasz közül egy a helyes.',
        'Helyes válasz után döntesz: megállsz és megtartod a pontokat, vagy továbbmész.',
        'Hibás válasznál a kör pontja feleződik.',
        'Egy körben legfeljebb 10 kérdés van; az 5. és a 10. kérdés többet ér.'
      ])
    ]),

    card([
      el('h3', { text: 'A kérdések' }),
      el('p.small', {
        text:
          'A kérdésbank saját szerkesztésű, illetve közkincs (CC0) adatforrásokból, ' +
          'például a Wikidatából generált tartalom. Minden kérdés emberi jóváhagyás ' +
          'után kerül a játékba.'
      }),
      row('Helyben tárolt kérdés', String(app.bank.questions.length)),
      row('Kategória', String(app.bank.categories.length))
    ]),

    card([
      el('h3', { text: 'Jogi megjegyzés' }),
      el('p.small', {
        text:
          'Ez az alkalmazás önálló fejlesztés. Nem áll kapcsolatban más kvízjátékok ' +
          'fejlesztőivel, és nem használ fel harmadik féltől származó kérdéseket, ' +
          'grafikákat vagy szövegeket.'
      })
    ])
  );

  // Attribúciós lista: csak ha van olyan kérdés, aminek a licence megkötést tesz.
  if (app.supabase.isConfigured && navigator.onLine) {
    try {
      const attributions = await app.supabase.rpc('attributions', {}, { authorized: false });
      if (Array.isArray(attributions) && attributions.length) {
        root.append(
          card([
            el('h3', { text: 'Forrás-attribúciók' }),
            ...attributions.map((item) =>
              row(`${item.provenance} – ${item.license}`, String(item.question_count))
            )
          ])
        );
      }
    } catch {
      /* nem kritikus */
    }
  }

  return root;
}

function bullets(items) {
  return el('ul.bullets', null, items.map((text) => el('li', { text })));
}
