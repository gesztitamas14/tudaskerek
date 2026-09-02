// Online többjátékos: KIESÉSES mód.
//
// A játékmenet:
//   1. A kerék KÖRÖNKÉNT EGYSZER pörög, és kiad egy kategóriát – ugyanazt
//      mindenkinek. A kör mind a 10 kérdése ebből a kategóriából jön.
//   2. A szoba minden még játékban lévő tagja UGYANARRA a kérdésre válaszol,
//      egyszerre, időre.
//   3. Aki hibázik vagy nem válaszol időben, kiesik a körből és nézővé válik.
//      A megszerzett pontjait megtartja.
//   4. A kör addig megy, amíg elfogy a 10 kérdés, vagy mindenki kiesik.
//   5. Ekkor a köri pontok beolvadnak az összesítettbe, és jön a következő kör
//      – új pörgetéssel, új kategóriával. 10 kör = 10 kategória egy játékban.
//
// Két dolog, amit érdemes tudni a felépítésről:
//
//   * A játékot a szerver `room_tick()` RPC-je hajtja, amit itt pollozunk. A
//     tick idempotens: mindegy, hogy négy kliens hívja egyszerre, a kérdés
//     lezárása és a továbbléptetés pontosan egyszer történik meg. A kliens
//     tehát nem „vezeti” a játékot, csak kérdezi és megjeleníti.
//
//   * A helyes válasz addig SENKINEK nem derül ki, amíg a kérdés le nem zárult.
//     Így egy gyorsan válaszoló játékos nem tudja megsúgni a többieknek. Ezt a
//     szerver kényszeríti ki, nem ez a fájl.
//
// A fázisok időalapúak (pörgetés → válasz → kiértékelés), ezért a pollozás
// mellett fut egy rövid helyi óra is, ami a visszaszámlálót rajzolja és
// észreveszi a fázisváltást.

import { Wheel } from './wheel.js';
import { settings } from './store.js';
import { sfx } from './sound.js';
import { digitPicker } from './picker.js';
import {
  el, clear, card, primaryButton, spinner, stateMessage, toast, fmt,
  avatarEmoji, haptic, HAPTIC, categoryBadge
} from './ui.js';

// Játék közben sűrűn kérdezünk: a lezárás és a továbblépés időzítés kérdése.
const POLL_PLAYING_MS = 1000;
const POLL_LOBBY_MS = 3000;
// A helyi óra ennyit vár két újrarajzolás között (visszaszámláló).
const CLOCK_MS = 200;

const LETTERS = ['A', 'B', 'C', 'D'];

// ─────────────────────────── belépő ───────────────────────────

export function multiplayerScreen(app) {
  const root = el('div.screen');

  if (!app.supabase.isConfigured) {
    root.append(
      stateMessage({
        icon: '👥',
        title: 'Backend szükséges',
        message:
          'A többjátékos módhoz Supabase projekt kell. Állítsd be a web/js/config.js ' +
          'fájlban (részletek: docs/05-beallitas.md).'
      })
    );
    return root;
  }

  let isWorking = false;
  let openRooms = [];
  let refreshTimer = null;
  // Ha a belépés eleve nem megy, ezt írjuk ki a lista helyén.
  let authProblem = null;
  // null = még nem tudjuk; a szerver válasza után true/false.
  let isGuest = null;

  const listHost = el('div.room-list');
  const listCard = card([
    el('div.card-head', null, [
      el('h3', { text: 'Nyitott szobák' }),
      el('button.link-btn', { type: 'button', text: 'Frissítés', on: { click: () => refresh() } })
    ]),
    listHost
  ]);

  // ── vendégjelzés ──
  //
  // Vendégként is lehet szobát csinálni és csatlakozni. A pont viszont nem
  // kerül a nyilvános ranglistára: a vendégnév generált, a fiók eldobható.
  const guestNote = el('div.guest-note', { hidden: true }, [
    el('span', { text: '👤' }),
    el('span', {
      text:
        'Vendégként játszol: a szobában minden működik, de a pontod nem kerül a ' +
        'nyilvános ranglistára. A saját statisztikád megmarad.'
    })
  ]);

  // ─────────── belépés ───────────

  /**
   * A szobákhoz játékosazonosító kell. Ha nincs bejelentkezve, csendben
   * vendégbelépést próbálunk – de ez a Supabase projekten ki lehet kapcsolva
   * (`Anonymous sign-ins`). Akkor nem elég egy nyers hibát kiírni: meg kell
   * mondani, mi a kiút.
   */
  async function ensureSignedIn() {
    if (app.supabase.isSignedIn) {
      authProblem = null;
      return true;
    }
    try {
      await app.supabase.signInAnonymously();
      authProblem = null;
      isGuest = null;   // új session → újra meg kell kérdezni
      return true;
    } catch (error) {
      authProblem = signInProblem(error);
      return false;
    }
  }

  /** A Supabase auth hibái angolul jönnek – a lényegeseket lefordítjuk. */
  function signInProblem(error) {
    const raw = String(error?.message ?? error);

    if (/anonymous.*disabled|anonymous_provider_disabled/i.test(raw)) {
      return {
        title: 'Jelentkezz be a játékhoz',
        message:
          'Ezen a szerveren a vendégjáték ki van kapcsolva, ezért szobához ' +
          'bejelentkezés kell. A Profil lapon beléphetsz Google-fiókkal vagy ' +
          'e-maillel – utána visszatérhetsz ide.',
        // Ez a projekt beállítása, nem a játékos hibája – de a tulajdonosnak
        // hasznos tudni, hol lehet bekapcsolni.
        hint: 'A projekt tulajdonosának: Supabase → Authentication → Providers → Anonymous sign-ins.'
      };
    }
    if (/rate limit|too many/i.test(raw)) {
      return {
        title: 'Túl sok próbálkozás',
        message: 'A szerver egy időre visszafogta a belépéseket. Próbáld újra pár perc múlva.'
      };
    }
    if (/failed to fetch|networkerror|network/i.test(raw)) {
      return {
        title: 'Nincs kapcsolat',
        message: 'A többjátékos módhoz internet kell. Az egyjátékos mód offline is működik.'
      };
    }
    return { title: 'Belépés nem sikerült', message: raw };
  }

  function renderAuthProblem() {
    clear(listHost);
    guestNote.hidden = true;
    listHost.append(
      stateMessage({
        icon: '🔒',
        title: authProblem.title,
        message: authProblem.message,
        actionLabel: 'Ugrás a Profil lapra',
        action: () => app.navigate('profile')
      }),
      authProblem.hint ? el('p.muted.small.center', { text: authProblem.hint }) : null
    );
  }

  // ─────────── szobalista ───────────

  async function refresh({ silent = false } = {}) {
    if (!(await ensureSignedIn())) {
      renderAuthProblem();
      return;
    }
    // A vendégfigyelmeztetést CSAK akkor írjuk ki, ha a szerver megerősíti.
    //
    // Korábban a JWT `is_anonymous` állítására épült, és bejelentkezett
    // felhasználónak is megjelent. A JWT ezt nem mindig tartalmazza, és
    // vendégfiók átalakítása után elavul – a `profiles` sor viszont hiteles.
    // Ha nem tudjuk eldönteni, hallgatunk: rosszabb valótlant állítani a
    // felhasználó fiókjáról, mint semmit.
    if (isGuest === null) {
      isGuest = await app.supabase.isGuestAccount();
    }
    guestNote.hidden = isGuest !== true;

    try {
      openRooms = (await app.supabase.rpc('list_open_rooms', { p_limit: 30 })) ?? [];
      renderList();
    } catch (error) {
      if (!silent) toast(error.message, { tone: 'error' });
    }
  }

  function renderList() {
    clear(listHost);

    if (openRooms.length === 0) {
      listHost.append(
        el('p.muted.small.center', {
          text: 'Most nincs nyitott szoba. Készíts egyet, és oszd meg a PIN-t!'
        })
      );
      return;
    }

    for (const item of openRooms) {
      const full = item.player_count >= item.max_players;
      const row = el('div.room-row');

      row.append(
        el('button.room-item', {
          type: 'button',
          disabled: full && !item.i_am_in,
          on: { click: () => openJoin(item) }
        }, [
          el('span.lb-avatar', { text: avatarEmoji(item.host_avatar) }),
          el('div.room-item-main', null, [
            el('div.room-item-host', null, [
              el('span', { text: item.host_nickname }),
              item.host_is_guest ? el('span.muted.small', { text: '(vendég)' }) : null,
              item.needs_pin ? el('span', { text: '🔒' }) : null
            ]),
            el('div.room-item-meta', null, [
              el('span', { text: `${item.rounds_per_player} kör` }),
              el('span', { text: `${item.answer_seconds} mp / kérdés` }),
              item.difficulty ? el('span', { text: fmt.difficulty(item.difficulty) }) : null,
              item.i_am_host ? el('span.gold', { text: 'a te szobád' }) : null,
              item.i_am_in && !item.i_am_host ? el('span.good', { text: 'már bent vagy' }) : null,
              full && !item.i_am_in ? el('span.warn', { text: 'tele' }) : null
            ])
          ]),
          el('span.room-item-count', { text: `${item.player_count}/${item.max_players}` })
        ])
      );

      // A saját szobát innen is meg lehessen szüntetni.
      if (item.i_am_host) {
        row.append(
          el('button.room-delete', {
            type: 'button',
            'aria-label': 'Szoba törlése',
            title: 'Szoba törlése',
            text: '✕',
            on: { click: () => deleteRoom(item) }
          })
        );
      }

      listHost.append(row);
    }
  }

  /** A saját szoba megszüntetése a listából. */
  async function deleteRoom(item) {
    if (isWorking) return;
    if (!confirm('Biztosan törlöd a szobát?')) return;
    isWorking = true;
    try {
      await app.supabase.rpc('close_room', { p_room: item.id });
      haptic(HAPTIC.tap);
      toast('Szoba törölve.');
      await refresh({ silent: true });
    } catch (error) {
      toast(error.message, { tone: 'error' });
    } finally {
      isWorking = false;
    }
  }

  // ─────────── csatlakozás PIN-nel ───────────

  function openJoin(item) {
    haptic(HAPTIC.tap);

    // Nincs PIN: azonnal beléphet.
    if (!item.needs_pin || item.i_am_in) {
      join(item, null);
      return;
    }

    const feedback = el('p.pin-attempts', { hidden: true });
    const picker = digitPicker({ length: 3 });

    const dialog = modal({
      title: `${item.host_nickname} szobája`,
      body: [
        el('p.muted.small.center', { text: 'Add meg a szoba 3 jegyű PIN-jét.' }),
        picker.node,
        feedback
      ],
      confirmLabel: 'Belépés',
      onConfirm: async (setBusy) => {
        setBusy(true);
        const result = await join(item, picker.value(), { keepOpen: true });
        setBusy(false);
        if (result?.ok) return true;          // a modal bezárul
        feedback.hidden = false;
        feedback.textContent =
          result?.error === 'locked'
            ? 'Túl sok hibás PIN. Próbáld újra 10 perc múlva.'
            : result?.error === 'bad_pin'
              ? `Hibás PIN. Még ${result.attempts_left ?? 0} próbálkozásod van.`
              : (result?.message ?? 'Nem sikerült belépni.');
        haptic(HAPTIC.wrong);
        sfx.wrong();
        return false;                          // a modal nyitva marad
      }
    });

    root.append(dialog);
    requestAnimationFrame(() => picker.relayout());
  }

  async function join(item, pin, { keepOpen = false } = {}) {
    if (isWorking) return null;
    isWorking = true;
    try {
      if (!(await ensureSignedIn())) return null;
      const result = await app.supabase.rpc('join_room', {
        p_room: item.id,
        p_pin: pin
      });

      if (!result?.ok) {
        if (!keepOpen) toast(result?.message ?? 'Nem sikerült belépni.', { tone: 'error' });
        // Tele/elindult szoba esetén a lista elavult – frissítsük.
        if (result?.error === 'full' || result?.error === 'started') refresh({ silent: true });
        return result;
      }

      haptic(HAPTIC.tap);
      sfx.tap();
      app.navigate('room', { room: result.room });
      return result;
    } catch (error) {
      if (!keepOpen) toast(error.message, { tone: 'error' });
      return { ok: false, message: error.message };
    } finally {
      isWorking = false;
    }
  }

  // ─────────── új szoba ───────────

  function openCreate() {
    haptic(HAPTIC.tap);

    let maxPlayers = 4;
    let rounds = 10;
    let answerSeconds = 15;
    let difficulty = null;
    let usePin = true;

    const picker = digitPicker({ value: randomPin() });

    const pinRow = el('div', null, [
      el('p.muted.small.center', {
        text: 'Ezt a 3 jegyű PIN-t kell megadnia annak, aki belép. Pörgesd be, amit szeretnél.'
      }),
      picker.node
    ]);

    const pinToggle = el('input', {
      type: 'checkbox',
      checked: true,
      on: {
        change: (event) => {
          usePin = event.target.checked;
          pinRow.hidden = !usePin;
          if (usePin) requestAnimationFrame(() => picker.relayout());
        }
      }
    });

    const difficultySelect = el('select.select', {
      on: {
        change: (event) => {
          difficulty = event.target.value === 'mixed' ? null : event.target.value;
        }
      }
    }, [
      el('option', { value: 'mixed', text: 'Vegyes' }),
      el('option', { value: 'easy', text: 'Könnyű' }),
      el('option', { value: 'medium', text: 'Közepes' }),
      el('option', { value: 'hard', text: 'Nehéz' })
    ]);

    const dialog = modal({
      title: 'Új szoba',
      body: [
        stepper('Játékosok', maxPlayers, 2, 5, (value) => { maxPlayers = value; }),
        stepper('Körök száma', rounds, 1, 10, (value) => { rounds = value; }),
        stepper('Válaszidő (mp)', answerSeconds, 5, 60, (value) => { answerSeconds = value; }, 5),
        el('div.setting-row', null, [el('span', { text: 'Nehézség' }), difficultySelect]),
        el('div.setting-row', null, [el('span', { text: 'PIN-kód kérése' }), pinToggle]),
        pinRow
      ],
      confirmLabel: 'Létrehozás',
      onConfirm: async (setBusy) => {
        setBusy(true);
        try {
          if (!(await ensureSignedIn())) return false;
          const room = await app.supabase.rpc('create_room', {
            p_max_players: maxPlayers,
            p_rounds_per_player: rounds,
            p_difficulty: difficulty,
            p_answer_seconds: answerSeconds,
            p_join_pin: usePin ? picker.value() : null
          });
          haptic(HAPTIC.tap);
          sfx.bank();
          app.navigate('room', { room });
          return true;
        } catch (error) {
          toast(error.message, { tone: 'error' });
          return false;
        } finally {
          setBusy(false);
        }
      }
    });

    root.append(dialog);
    requestAnimationFrame(() => picker.relayout());
  }

  // ─────────── összeállítás ───────────

  root.append(
    el('div.about-head', null, [
      el('div.about-logo', { text: '👥' }),
      el('h2', { text: 'Kieséses játék barátokkal' }),
      el('p.muted.small', {
        text:
          'A kerék kategóriát pörget, és abból jön a kör mind a 10 kérdése. ' +
          'Mindenki a saját telefonján, ugyanarra a kérdésre, egyszerre válaszol. ' +
          'Aki hibázik, kiesik a körből és nézővé válik – aztán jön az új kategória.'
      })
    ]),
    guestNote,
    el('div.actions', null, [primaryButton('Új szoba létrehozása', openCreate, { tone: 'gold' })]),
    listCard
  );

  // A lista magától frissül, hogy ne kelljen nyomkodni: közben más is nyithat
  // szobát. 6 másodperc elég ritka ahhoz, hogy ne terhelje a backendet.
  refresh();
  refreshTimer = setInterval(() => refresh({ silent: true }), 6000);
  root.addEventListener('screen:unmount', () => clearInterval(refreshTimer), { once: true });

  return root;
}

/** Véletlen 3 jegyű kezdő-PIN, hogy ne kelljen kitalálni. */
function randomPin() {
  return String(Math.floor(Math.random() * 1000)).padStart(3, '0');
}

/**
 * Egyszerű modális párbeszéd. Az `onConfirm` visszatérési értéke dönt: `true`
 * esetén bezárul, `false` esetén nyitva marad (pl. hibás PIN után).
 */
function modal({ title, body, confirmLabel, onConfirm }) {
  const overlay = el('div.modal-overlay');
  const busyState = { value: false };

  const confirm = primaryButton(confirmLabel, async () => {
    if (busyState.value) return;
    const done = await onConfirm((busy) => {
      busyState.value = busy;
      confirm.disabled = busy;
    });
    if (done) overlay.remove();
  }, { tone: 'gold' });

  const sheet = el('div.modal-sheet', null, [
    el('h3.center', { text: title }),
    ...body.filter(Boolean),
    el('div.actions', null, [
      confirm,
      el('button.link-btn', {
        type: 'button',
        text: 'Mégsem',
        on: { click: () => overlay.remove() }
      })
    ])
  ]);

  overlay.append(sheet);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay && !busyState.value) overlay.remove();
  });

  return overlay;
}

function stepper(label, initial, min, max, onChange, step = 1) {
  let value = initial;
  const display = el('span.stepper-value', { text: String(value) });

  const update = (delta) => {
    value = Math.max(min, Math.min(max, value + delta * step));
    display.textContent = String(value);
    onChange(value);
  };

  return el('div.setting-row', null, [
    el('span', { text: label }),
    el('div.stepper', null, [
      el('button.stepper-btn', { type: 'button', text: '−', on: { click: () => update(-1) } }),
      display,
      el('button.stepper-btn', { type: 'button', text: '+', on: { click: () => update(1) } })
    ])
  ]);
}

// ─────────────────────────── szoba ───────────────────────────

export function roomScreen(app, { room: initialRoom }) {
  const root = el('div.screen');
  const body = el('div.room-body');
  root.append(body);

  let room = initialRoom;
  let pollTimer = null;
  let clockTimer = null;
  let currentInterval = null;
  let isWorking = false;
  let lastSignature = null;

  // A szerver és a kliens órája nem jár együtt. Minden határidőt szerveridőben
  // kapunk, ezért egyszer kiszámoljuk az eltérést, és azzal korrigálunk.
  let skewMs = 0;

  // Amíg a beküldés fut, azonnal jelöljük a választ – ne tűnjön akadásnak.
  let answerPending = null;
  // Melyik kérdéshez futott már le a kerék animációja.
  // Melyik kérdésnél futott már LE a kerék animációja (nem az, hogy elindult:
  // így egy közbeeső újrarajzolás újraindítja, nem lefagyasztja).
  let spinDoneFor = null;
  // Melyik kérdés kiértékelését jeleztük már rezgéssel / üzenettel.
  let notifiedFor = null;
  let lastBlockShown = null;

  // Élő elemek, amiket a helyi óra frissít újrarajzolás nélkül.
  let timerFill = null;
  let timerLabel = null;
  let renderedPhase = null;
  // Melyik másodpercnél csipogtunk utoljára (ne szóljon 5×/másodperc).
  let lastBeepSecond = null;

  const myId = () => app.supabase.userId;
  const isHost = () => myId() === room.host_id;
  const me = () => (room.players ?? []).find((player) => player.player_id === myId());
  const amIOut = () => Boolean(me()?.is_eliminated) || Boolean(me()?.has_left);
  const amIReady = () => me()?.is_ready ?? false;
  const activePlayers = () => (room.players ?? []).filter((player) => !player.has_left);
  const nameOf = (id) =>
    (room.players ?? []).find((player) => player.player_id === id)?.nickname ?? 'Játékos';

  function serverNow() {
    return Date.now() - skewMs;
  }

  /** A megjelenítés fázisa. Időalapú, ezért a helyi óra is figyeli. */
  function phaseOf() {
    if (room.status !== 'playing') return room.status;
    const q = room.current_question;
    if (!q) return 'between';                 // kör vége, vagy még jön a kérdés
    if (q.resolved) return 'resolved';
    if (serverNow() < Date.parse(q.answer_open_at)) return 'spin';
    return 'answer';
  }

  // ── pollozás ──

  /**
   * Az újraépítés villog és elveszti a görgetést, ezért csak akkor rendereljük
   * újra, ha az állapot érdemben változott. A visszaszámláló nincs benne: azt a
   * helyi óra frissíti, DOM-csere nélkül.
   */
  function signature(state, phase) {
    const q = state.current_question;
    return JSON.stringify([
      state.status,
      state.block_no,
      phase,
      q?.id ?? null,
      q?.i_answered ?? null,
      q?.answered_count ?? null,
      answerPending,
      state.last_block_ended_at ?? null,
      (state.players ?? []).map((p) => [
        p.player_id, p.score, p.block_score, p.is_ready, p.has_left, p.is_eliminated
      ])
    ]);
  }

  async function poll() {
    try {
      // Játék közben a `room_tick` hajtja a menetet (lezárás, továbblépés).
      // A váróban elég az olvasás – ott nincs mit léptetni.
      const rpc = room.status === 'playing' ? 'room_tick' : 'room_state';
      const next = await app.supabase.rpc(rpc, { p_room: room.id });
      applyState(next);

      // Ha közben véget ért vagy bezárták a szobát, nincs mit tovább kérdezni.
      if (isOver()) {
        stopPolling();
        return;
      }
      restartPollingIfNeeded();
    } catch (error) {
      // Átmeneti hiba: a következő poll újrapróbálja.
      console.info('Szobaállapot frissítése nem sikerült:', error.message);
    }
  }

  function applyState(next, { force = false } = {}) {
    if (next.server_time) skewMs = Date.now() - Date.parse(next.server_time);

    const q = next.current_question;
    // Új kérdés: a beküldés-jelölés és a kerék állapota elavult.
    if ((q?.id ?? null) !== (room.current_question?.id ?? null)) {
      answerPending = null;
    } else if (q?.i_answered) {
      answerPending = null;   // a szerver visszaigazolta
    }

    room = next;
    announceIfNeeded();

    const phase = phaseOf();
    const sig = signature(next, phase);
    if (force || sig !== lastSignature) {
      lastSignature = sig;
      render();
    } else {
      updateClockUi();
    }
  }

  /** Rezgés és rövid üzenet a fontos pillanatokra. */
  function announceIfNeeded() {
    const q = room.current_question;

    if (q?.resolved && notifiedFor !== q.id) {
      notifiedFor = q.id;
      const mine = (q.results ?? []).find((r) => r.player_id === myId());
      if (mine) {
        if (mine.is_correct) {
          haptic(HAPTIC.tap);
          sfx.correct();
        } else {
          haptic(HAPTIC.stop);
          // Kieséses módban a rossz válasz nem „csak” hiba: kiszáll a körből.
          sfx.eliminated();
          toast(
            mine.selected_answer === null
              ? 'Lejárt az idő – kiestél a körből.'
              : 'Rossz válasz – kiestél a körből.',
            { tone: 'error' }
          );
        }
      }
    }

    if (room.last_block_ended_at && lastBlockShown !== room.last_block_ended_at) {
      lastBlockShown = room.last_block_ended_at;
      if (room.status === 'playing') {
        haptic(HAPTIC.bigWin);
        sfx.bigWin();
      }
    }
  }

  function pollInterval() {
    return room.status === 'playing' ? POLL_PLAYING_MS : POLL_LOBBY_MS;
  }

  /** Lezárt szobát nincs értelme tovább kérdezni. */
  function isOver() {
    return room.status === 'finished' || room.status === 'cancelled';
  }

  function startPolling() {
    stopPolling();
    currentInterval = pollInterval();
    pollTimer = setInterval(poll, currentInterval);
    clockTimer = setInterval(onClock, CLOCK_MS);
  }

  function restartPollingIfNeeded() {
    if (pollTimer && currentInterval !== pollInterval()) startPolling();
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    if (clockTimer) clearInterval(clockTimer);
    pollTimer = null;
    clockTimer = null;
  }

  /** Helyi óra: a fázisváltás időalapú, a pollozás nem venné észre időben. */
  function onClock() {
    if (phaseOf() !== renderedPhase) {
      lastSignature = signature(room, phaseOf());
      render();
      return;
    }
    updateClockUi();
  }

  function updateClockUi() {
    const q = room.current_question;
    if (!timerFill || !q || q.resolved) return;
    const total = Math.max(1, (Date.parse(q.deadline_at) - Date.parse(q.answer_open_at)) / 1000);
    const left = Math.max(0, (Date.parse(q.deadline_at) - serverNow()) / 1000);
    timerFill.style.width = `${Math.min(100, (left / total) * 100)}%`;
    timerFill.classList.toggle('timer-low', left <= 5);
    const seconds = Math.ceil(left);
    if (timerLabel) timerLabel.textContent = `${seconds} mp`;

    // Az utolsó három másodperc csipog – de csak ha még válaszolhatok, és
    // másodpercenként legfeljebb egyszer.
    if (seconds !== lastBeepSecond) {
      lastBeepSecond = seconds;
      if (seconds > 0 && seconds <= 3 && !q.i_answered && answerPending === null && !amIOut()) {
        sfx.countdown();
      }
    }
  }

  root.addEventListener('screen:unmount', () => stopPolling(), { once: true });

  // ── műveletek ──

  /**
   * Egy szerverművelet lefuttatása „dolgozunk” állapottal.
   *
   * FIGYELEM – pontosan EGY renderelés kell a művelet után. Korábban a
   * `finally` blokk mindig újrarenderelt, ráadásul az `applyState` renderelése
   * UTÁN: a második renderelés kicserélte a DOM-ot, és a kerék animációja
   * elveszett (a host az első kör pörgetését nem látta). Ezért a `isWorking`
   * flaget az állapot alkalmazása ELŐTT engedjük el, és utána csak egyszer
   * rajzolunk.
   */
  async function run(operation) {
    if (isWorking) return;
    isWorking = true;
    render();

    let next = null;
    try {
      next = await operation();
    } catch (error) {
      toast(error.message, { tone: 'error' });
    }

    isWorking = false;
    if (next) applyState(next, { force: true });
    else render();
  }

  const toggleReady = () =>
    run(() => app.supabase.rpc('set_ready', { p_room: room.id, p_ready: !amIReady() }));

  const startRoom = () =>
    run(async () => {
      const next = await app.supabase.rpc('start_room', { p_room: room.id });
      haptic(HAPTIC.tap);
      return next;
    });

  async function submitAnswer(index) {
    const q = room.current_question;
    if (!q || q.resolved || q.i_answered || answerPending !== null) return;
    if (amIOut() || phaseOf() !== 'answer') return;

    answerPending = index;
    lastSignature = signature(room, phaseOf());
    render();
    haptic(HAPTIC.tap);
    sfx.tap();

    try {
      await app.supabase.rpc('answer_room_question', {
        p_room: room.id,
        p_question: q.id,
        p_answer: index,
        p_answer_ms: Math.max(0, Math.round(serverNow() - Date.parse(q.answer_open_at)))
      });
      // Ha én voltam az utolsó, ez azonnal lezárja a kérdést – ne várjunk a
      // következő poll-ciklusra.
      await poll();
    } catch (error) {
      answerPending = null;
      toast(error.message, { tone: 'error' });
      render();
    }
  }

  async function leave() {
    stopPolling();
    try {
      await app.supabase.rpc('leave_room', { p_room: room.id });
    } catch {
      /* kilépésnél a hiba nem érdekes */
    }
    app.navigate('multiplayer');
  }

  // ── megjelenítés ──

  function render() {
    clear(body);
    timerFill = null;
    timerLabel = null;
    renderedPhase = phaseOf();

    const standings = [...activePlayers()].sort((a, b) =>
      b.score === a.score ? a.seat - b.seat : b.score - a.score
    );

    const sections =
      room.status === 'lobby'
        ? [roomCodeCard(), playerListCard(activePlayers()), lobbyActions()]
        : room.status === 'playing'
          ? [scoreStrip(), ...playingSections()]
          : [finishedPanel(standings), playerListCard(standings)];

    // A készítő a VÁRÓBAN megszüntetheti a szobát – különben egy elrontott
    // beállítású szoba két órán át ott lóg a nyitott szobák listáján.
    //
    // Játék közben szándékosan NEM ajánljuk fel: egy félrekattintás mindenki
    // futó játékát megszakítaná. Ha a host kiszáll, a „Kilépés” elég – a játék
    // a többiekkel megy tovább, és a host-szerep átszáll. A szerveroldali
    // close_room játék közben is működik, ha tényleg le kell zárni egy szobát.
    const canClose = isHost() && room.status === 'lobby';

    sections.push(
      el('div.actions', null, [
        primaryButton(room.status === 'playing' ? 'Kilépés (feladom)' : 'Kilépés a szobából', leave, {
          tone: 'secondary'
        }),
        canClose
          ? primaryButton('Szoba törlése', closeRoom, { tone: 'danger', disabled: isWorking })
          : null
      ].filter(Boolean))
    );

    body.append(...sections.filter(Boolean));
    updateClockUi();
  }

  /**
   * A váró műveletei.
   *
   * A hostnak indítás + szobatörlés, a többieknek „készen állok”. A gomb
   * elrejtése nem védelem: a `start_room` és a `close_room` szerveroldalon is
   * ellenőrzi, hogy a hívó a szoba készítője-e.
   */
  function lobbyActions() {
    const playerCount = activePlayers().length;
    const canStart = playerCount >= 2;

    if (!isHost()) {
      return el('div.actions', null, [
        primaryButton(amIReady() ? 'Mégsem vagyok kész' : 'Készen állok', toggleReady, {
          tone: amIReady() ? 'secondary' : 'primary',
          disabled: isWorking
        }),
        el('p.muted.small.center', {
          text: 'A szoba létrehozója indítja a játékot.'
        })
      ]);
    }

    return el('div.actions', null, [
      primaryButton('Játék indítása', startRoom, {
        tone: 'gold',
        disabled: !canStart || isWorking
      }),
      canStart
        ? el('p.muted.small.center', {
            text:
              `${playerCount} játékos a szobában. ` +
              `${room.rounds_per_player} kör, körönként egy kategória és 10 kérdés.`
          })
        : el('p.muted.small.center', {
            text: room.has_pin
              ? 'Legalább két játékos kell. Mondd be a PIN-t – a szobád a „Nyitott szobák” listában van.'
              : 'Legalább két játékos kell. A szobád a „Nyitott szobák” listában van.'
          })
    ]);
  }

  /** A szoba megszüntetése – csak a készítő. */
  async function closeRoom() {
    if (isWorking) return;
    if (!confirm('Biztosan törlöd a szobát? A többiek kikerülnek belőle.')) return;

    isWorking = true;
    stopPolling();
    try {
      await app.supabase.rpc('close_room', { p_room: room.id });
      haptic(HAPTIC.tap);
      toast('Szoba törölve.');
      app.navigate('multiplayer');
    } catch (error) {
      toast(error.message, { tone: 'error' });
      isWorking = false;
      startPolling();
    }
  }

  /**
   * A váró fejlapja. Nincs többé szobakód: a többiek a nyitott szobák
   * listájában találják meg ezt a szobát. A készítő a PIN-t látja, hogy
   * be tudja mondani.
   */
  function roomCodeCard() {
    return card([
      room.my_pin
        ? el('div', null, [
            el('div.muted.small.center', { text: 'BELÉPÉSI PIN' }),
            el('div.room-code', { text: room.my_pin }),
            el('p.muted.small.center', {
              text: 'Mondd be a többieknek. A szobád a „Nyitott szobák” listában látszik.'
            })
          ])
        : el('div', null, [
            el('div.muted.small.center', { text: 'VÁRUNK A JÁTÉKOSOKRA' }),
            room.has_pin
              ? el('p.muted.small.center', { text: 'Ez a szoba PIN-nel védett.' })
              : el('p.muted.small.center', { text: 'Ebbe a szobába PIN nélkül is be lehet lépni.' })
          ]),
      el('div.room-meta', null, [
        el('span', { text: `${activePlayers().length}/${room.max_players} játékos` }),
        el('span', { text: `${room.rounds_per_player} kör` }),
        el('span', { text: `${room.answer_seconds} mp / kérdés` }),
        room.difficulty ? el('span', { text: fmt.difficulty(room.difficulty) }) : null
      ])
    ]);
  }

  function playerListCard(list) {
    return card([
      el('div.card-head', null, [
        el('h3', { text: room.status === 'lobby' ? 'Játékosok' : 'Végeredmény' }),
        room.status === 'lobby' ? el('span.chip.chip-good.small', { text: 'élő' }) : null
      ]),
      ...list.map((player, index) =>
        el('div.player-row', null, [
          room.status === 'lobby'
            ? el('span.lb-avatar', { text: avatarEmoji(player.avatar_id) })
            : el('span.lb-rank', { text: `${index + 1}.` }),
          el('div.grow', null, [
            el('div', null, [
              player.nickname,
              player.player_id === room.host_id ? el('span.crown', { text: ' 👑' }) : null,
              player.player_id === myId() ? el('span.muted.small', { text: ' (te)' }) : null
            ]),
            el('div.muted.small', { text: playerSubtitle(player, room) })
          ]),
          room.status === 'lobby'
            ? (player.is_ready ? el('span.good', { text: '✓' }) : null)
            : el('span.gold', { text: fmt.points(player.score) })
        ])
      )
    ]);
  }

  /**
   * A pontok „felül végig” látszanak: ki hol áll, ki van még játékban.
   * Kieséses módban ez a legfontosabb információ a kérdés mellett.
   */
  function scoreStrip() {
    const order = [...activePlayers()].sort((a, b) => a.seat - b.seat);
    return el('div.score-strip', null, [
      // A kör kategóriája a kör EGÉSZÉRE érvényes, ezért itt fent a helye –
      // nem csak a kérdés fölött, ahol a kiértékelés közben eltűnne.
      el('div.score-strip-head', null, [
        el('span.muted.small', {
          text:
            `${room.block_no}. kör / ${room.rounds_per_player}` +
            (room.current_round?.category_name ? ` · ${room.current_round.category_name}` : '')
        }),
        el('span.muted.small', {
          text: room.current_question
            ? `${room.current_question.ordinal}. kérdés / ${room.current_question.max_questions}`
            : 'új kategória jön'
        })
      ]),
      el('div.score-chips', null, order.map((player) =>
        el('div.score-chip', {
          class: [
            player.is_eliminated ? 'score-chip-out' : '',
            player.player_id === myId() ? 'score-chip-me' : ''
          ].filter(Boolean).join(' ')
        }, [
          el('span.score-chip-avatar', { text: avatarEmoji(player.avatar_id) }),
          el('span.score-chip-name', { text: player.nickname }),
          el('span.score-chip-score', { text: fmt.points(player.score + player.block_score) }),
          player.is_eliminated
            ? el('span.score-chip-tag', { text: 'kiesett' })
            : player.block_score > 0
              ? el('span.score-chip-tag.gold', { text: `+${fmt.points(player.block_score)}` })
              : null
        ])
      ))
    ]);
  }

  function playingSections() {
    const phase = phaseOf();
    if (phase === 'between') return [betweenBlocksCard()];

    const q = room.current_question;
    if (phase === 'spin') return [spinCard(q)];

    const category = app.bank?.categoriesBySlug?.get?.(q.category_slug);
    const sections = [
      category ? el('div.question-category', null, [categoryBadge(category, { compact: true })]) : null,
      card([
        el('div.question-meta', null, [
          el('span', { text: fmt.difficulty(q.difficulty) }),
          el('span.gold', { text: `${fmt.points(q.reward)} pont` })
        ]),
        el('h2.question-text', {
          text: q.question_text,
          class: q.question_text.length > 120 ? 'question-long' : ''
        })
      ])
    ];

    if (!q.resolved) sections.push(timerBar(), answersLive(q));
    else sections.push(answersResolved(q), resolutionCard(q));

    return sections;
  }

  function timerBar() {
    timerFill = el('div.timer-fill');
    timerLabel = el('span.timer-label');
    return el('div.timer', null, [
      el('div.timer-track', null, [timerFill]),
      timerLabel
    ]);
  }

  /** Válaszgombok: csak akkor aktívak, ha játékban vagyok és még nem válaszoltam. */
  function answersLive(q) {
    const locked = amIOut() || q.i_answered || answerPending !== null;
    const chosen = q.i_answered ? q.my_answer : answerPending;

    const host = el('div.answers', { class: locked ? 'answers-locked' : '' });
    (q.answers ?? []).forEach((answer, index) => {
      host.append(
        el('button.answer', {
          type: 'button',
          disabled: locked,
          dataset: { index: String(index) },
          class: index === chosen ? 'answer-pending' : '',
          on: { click: () => submitAnswer(index) }
        }, [
          el('span.answer-letter', { text: LETTERS[index] ?? '?' }),
          el('span.answer-text', { text: answer })
        ])
      );
    });

    const status = amIOut()
      ? el('p.muted.small.center', { text: 'Kiestél ebből a körből – nézőként követed.' })
      : chosen !== null && chosen !== undefined
        ? el('p.muted.small.center', {
            text: `Válaszod elküldve. Várunk a többiekre (${q.answered_count}/${q.alive_count}).`
          })
        : el('p.muted.small.center', {
            text: `${q.alive_count} játékos van még versenyben. Válassz!`
          });

    return el('div.actions', null, [host, status]);
  }

  /** Kiértékelés: a helyes válasz zölden, a sajátom (ha rontottam) piros. */
  function answersResolved(q) {
    const mine = (q.results ?? []).find((r) => r.player_id === myId());
    const host = el('div.answers.answers-spectator');
    (q.answers ?? []).forEach((answer, index) => {
      let stateClass = 'answer-dimmed';
      if (index === q.correct_answer) stateClass = 'answer-correct';
      else if (mine && index === mine.selected_answer) stateClass = 'answer-wrong';

      // Ki választotta ezt? A kiértékelés után ez már nem árul el semmit.
      const pickers = (q.results ?? [])
        .filter((r) => r.selected_answer === index)
        .map((r) => avatarEmoji(
          (room.players ?? []).find((p) => p.player_id === r.player_id)?.avatar_id
        ))
        .join(' ');

      host.append(
        el('div.answer', { class: `answer-static ${stateClass}` }, [
          el('span.answer-letter', { text: LETTERS[index] ?? '?' }),
          el('span.answer-text', { text: answer }),
          pickers ? el('span.answer-pickers', { text: pickers }) : null
        ])
      );
    });
    return host;
  }

  function resolutionCard(q) {
    const results = q.results ?? [];
    const mine = results.find((r) => r.player_id === myId());
    const out = results.filter((r) => !r.is_correct);

    return el('div.actions', null, [
      mine
        ? el('div.result-banner', {
            class: mine.is_correct ? 'chip-good' : 'chip-warn',
            text: mine.is_correct
              ? `Helyes! +${fmt.points(mine.awarded_points)} pont`
              : mine.selected_answer === null
                ? 'Nem válaszoltál időben – kiestél a körből.'
                : 'Rossz válasz – kiestél a körből.'
          })
        : null,

      card([
        el('h3', { text: 'Ki mit válaszolt' }),
        ...results.map((result) =>
          el('div.result-line', null, [
            el('span.lb-avatar', {
              text: avatarEmoji(
                (room.players ?? []).find((p) => p.player_id === result.player_id)?.avatar_id
              )
            }),
            el('span.grow', { text: nameOf(result.player_id) }),
            el('span.muted.small', {
              text: result.selected_answer === null
                ? 'nem válaszolt'
                : LETTERS[result.selected_answer] ?? '?'
            }),
            result.is_correct
              ? el('span.good', { text: `✓ +${fmt.points(result.awarded_points)}` })
              : el('span.bad', { text: '✕ kiesett' })
          ])
        ),
        out.length === results.length && results.length > 0
          ? el('p.muted.small.center', { text: 'Mindenki elvétette – ezzel a kör véget ér.' })
          : null,
        q.explanation ? el('p.explanation', { text: q.explanation }) : null
      ])
    ]);
  }

  /** A kerék pörgetése: mindenki ugyanarra a kategóriára fut ki. */
  /**
   * A kör kategóriájának kipörgetése.
   *
   * A kerék KÖRÖNKÉNT EGYSZER pörög: a kipörgetett kategóriából jön a kör mind
   * a 10 kérdése. Ezért itt nem sietünk – a pörgetés fázisa (`spin_seconds`,
   * alapból 6 mp) két részre oszlik:
   *
   *   1. a kerék animációja (~2,5 mp),
   *   2. utána marad idő ELOLVASNI, milyen kategória jött ki.
   *
   * A második rész a lényeg: enélkül a kérdés azonnal a pörgetés után jelent
   * meg, és nem volt idő felfogni, miről lesz szó. A válaszidőből ez nem vesz
   * el semmit, mert a szerver csak `answer_open_at` után fogad választ.
   */
  function spinCard(q) {
    const categories = app.bank?.categories ?? [];
    const targetIndex = categories.findIndex((item) => item.slug === q.category_slug);
    const category = app.bank?.categoriesBySlug?.get?.(q.category_slug);

    const canvas = el('canvas.wheel', { width: 320, height: 320 });
    const host = el('div.wheel-host.wheel-host-small', null, [canvas]);
    const caption = el('div.wheel-caption');
    const lead = el('h2.center.gold', { text: 'Kategória pörgetése…' });
    const note = el('p.muted.small.center', {
      text: 'A kör mind a 10 kérdése ebből a kategóriából jön.'
    });

    /** A kerék megállt: mostantól ez a kör témája. */
    function announce() {
      lead.textContent = 'A kör kategóriája';
      clear(caption);
      if (category) {
        caption.append(categoryBadge(category));
      } else {
        caption.append(el('strong', { text: q.category_slug }));
      }
    }

    const untilOpen = (Date.parse(q.answer_open_at) - serverNow()) / 1000;

    if (categories.length > 0 && targetIndex >= 0) {
      const wheel = new Wheel(canvas);
      wheel.setCategories(categories);

      // A pörgetés rövid; a maradék idő az olvasásra megy. Legalább 1,2 mp
      // olvasási szünetet mindig hagyunk, akkor is, ha késve érkeztünk.
      const reduced = settings.get('reduceWheelSpin');
      const spinSeconds = Math.max(
        0.5,
        Math.min(reduced ? 1.2 : 2.6, untilOpen - 1.2)
      );

      // A pörgetés indítása NEM függhet animációs kerettől.
      //
      // A `requestAnimationFrame` rejtett lapon (és fejnélküli böngészőben)
      // nem biztosan fut le. Ha csak arra várnánk, a kártya örökre a
      // „Kategória pörgetése…” állapotban ragadna, és a kategória sosem
      // kerülne kihirdetésre. Ezért a rAF mellett időzítő is elindítja, és
      // egy jelző gondoskodik róla, hogy pontosan egyszer induljon.
      let launched = false;
      const launch = () => {
        if (launched) return;
        launched = true;
        wheel.resize();

        // A „már lefutott” jelzőt CSAK a befejezés állítja be. Így ha közben
        // újrarajzolunk (pl. beesik egy szobaállapot), az animáció újraindul a
        // maradék idővel – nem fagy le félúton egy statikus képre.
        //
        // Ha viszont már lement, ne pörgessük újra: a kategória marad kiírva.
        if (spinDoneFor === q.id || untilOpen < 0.7) {
          wheel.rotation = 0;
          wheel.draw();
          announce();
          return;
        }

        wheel
          .spinTo({
            targetIndex,
            turns: reduced ? 1 : 2,
            duration: spinSeconds,
            onTick: (intensity) => {
              haptic(Math.max(3, Math.round(HAPTIC.tick * intensity)));
              sfx.wheelTick(intensity);
            }
          })
          .then(() => {
            spinDoneFor = q.id;
            haptic(HAPTIC.stop);
            sfx.wheelStop();
            announce();
          })
          .catch(() => {});
      };

      requestAnimationFrame(launch);
      setTimeout(launch, 60);
    } else {
      // Nincs helyi kerék (pl. ismeretlen kategória): rögtön a nevét mutatjuk.
      announce();
    }

    return el('div.actions', null, [
      card([
        el('div.muted.small.center', { text: `${room.block_no}. KÖR / ${room.rounds_per_player}` }),
        lead,
        host,
        caption,
        note
      ])
    ]);
  }

  /** Két kör között: a lezárt kör pontjai. */
  function betweenBlocksCard() {
    const scores = room.last_block_scores;
    if (!Array.isArray(scores) || scores.length === 0) {
      return card([spinner('Kérdés betöltése…')]);
    }
    const sorted = [...scores].sort((a, b) => b.block_score - a.block_score);
    return el('div.actions', null, [
      card([
        el('h3.center', { text: 'Kör vége' }),
        ...sorted.map((entry) =>
          el('div.result-line', null, [
            el('span', { text: entry.survived ? '🏅' : '💤' }),
            el('span.grow', { text: entry.nickname }),
            el('span.gold', { text: `+${fmt.points(entry.block_score)}` })
          ])
        ),
        el('p.muted.small.center', { text: 'Mindenki visszatér a játékba. Jön a következő kategória…' })
      ]),
      spinner('Következő kör…')
    ]);
  }

  function finishedPanel(standings) {
    if (room.status === 'cancelled') {
      return card([
        el('div.result-icon.big', { text: '🚪' }),
        el('h2.center', { text: 'A szoba bezárt' })
      ]);
    }
    const winner = standings[0];
    const tied = standings.filter((player) => player.score === winner?.score);
    return el('div.actions', null, [
      card([
        el('div.result-icon.big.gold', { text: '🏆' }),
        winner
          ? el('div.center', null, [
              el('h2', {
                text: tied.length > 1
                  ? `Döntetlen: ${tied.map((p) => p.nickname).join(', ')}`
                  : `${winner.nickname} nyert!`
              }),
              el('div.final-score', { text: fmt.points(winner.score) })
            ])
          : el('h2.center', { text: 'A játék véget ért' })
      ])
    ]);
  }

  // Az `applyState` már rendereli is – a szignatúra még null.
  applyState(initialRoom);
  startPolling();
  return root;
}

function playerSubtitle(player, room) {
  if (player.has_left) return 'kilépett';
  if (room.status === 'lobby') return player.is_ready ? 'készen áll' : 'várakozik';
  return `${player.score} pont`;
}
