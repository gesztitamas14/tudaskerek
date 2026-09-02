// Alkalmazás-bootstrap és navigáció.
//
// Nincs router-könyvtár: a képernyők egyszerű függvények, amelyek DOM-csomópontot
// adnak vissza. A `hash` az útvonal, így a vissza gomb és a megosztott link is
// működik.

import { CONFIG, HAS_BACKEND } from './config.js';
import { QuestionBank, SyncService, supabase } from './api.js';
import { settings, storageAvailable, outbox } from './store.js';
import { GameScreen } from './game-screen.js';
import { multiplayerScreen, roomScreen } from './multiplayer.js';
import {
  homeScreen, statsScreen, leaderboardScreen, profileScreen, settingsScreen, aboutScreen
} from './screens.js';
import { el, clear, qs, toast, setHapticsEnabled, spinner } from './ui.js';

const TABS = [
  { id: 'home', label: 'Játék', icon: '🎡' },
  { id: 'leaderboard', label: 'Ranglista', icon: '🏆' },
  { id: 'stats', label: 'Statisztika', icon: '📊' },
  { id: 'profile', label: 'Profil', icon: '👤' }
];

class App {
  constructor() {
    this.bank = new QuestionBank();
    this.supabase = supabase;
    this.sync = new SyncService({ supabase, bank: this.bank });
    this.currentScreen = null;
    this.currentRoute = null;
    this.currentParams = {};
  }

  // ─────────────────────────── indítás ───────────────────────────

  async boot() {
    const shell = qs('#app');
    clear(shell);
    shell.append(spinner('Kérdésbank betöltése…'));

    setHapticsEnabled(settings.get('hapticsEnabled'));

    if (!storageAvailable()) {
      toast(
        'A böngésző nem engedi az adatok tárolását (privát mód?). ' +
        'A játék működik, de az eredmények nem maradnak meg.',
        { tone: 'warn', duration: 8000 }
      );
    }

    try {
      await this.bank.load();
    } catch (error) {
      clear(shell);
      shell.append(
        el('div.boot-error', null, [
          el('h2', { text: 'Nem sikerült betölteni a kérdésbankot' }),
          el('p', { text: error.message }),
          el('p.muted.small', {
            text:
              'Ha helyben futtatod, indíts webszervert (pl. `npx serve web`) – a ' +
              'fájlrendszerből (file://) a böngésző nem engedi a modulok betöltését.'
          })
        ])
      );
      return;
    }

    // OAuth visszatérés feldolgozása (Apple bejelentkezés a weben)
    if (HAS_BACKEND) {
      try {
        if (await this.supabase.captureOAuthRedirect()) {
          toast('Bejelentkezés sikeres.');
        }
      } catch {
        /* nem kritikus */
      }
    }

    this.renderShell(shell);
    this.startRouting();

    // Szinkronizálás a háttérben – nem blokkolja a UI-t.
    this.sync.run().catch(() => {});

    // Előtérbe kerüléskor és hálózat visszatérésekor újra próbáljuk.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.sync.run().catch(() => {});
    });
    window.addEventListener('online', () => {
      toast('Újra online.');
      this.sync.run().catch(() => {});
      this.updateOfflineChip();
    });
    window.addEventListener('offline', () => this.updateOfflineChip());
  }

  renderShell(shell) {
    clear(shell);

    this.titleEl = el('span.app-title', { text: CONFIG.appName });
    this.offlineChip = el('span.chip.chip-warn.small', { text: '📴 offline' });
    this.offlineChip.hidden = navigator.onLine;

    const topBar = el('header.top-bar', null, [
      el('button.icon-btn', {
        type: 'button',
        'aria-label': 'Névjegy',
        text: 'ⓘ',
        on: { click: () => this.navigate('about') }
      }),
      el('div.top-bar-center', null, [this.titleEl, this.offlineChip]),
      el('button.icon-btn', {
        type: 'button',
        'aria-label': 'Beállítások',
        text: '⚙',
        on: { click: () => this.navigate('settings') }
      })
    ]);

    this.viewport = el('div.viewport');

    this.tabBar = el('nav.tab-bar');
    for (const tab of TABS) {
      this.tabBar.append(
        el('button.tab-item', {
          type: 'button',
          dataset: { route: tab.id },
          on: { click: () => this.navigate(tab.id) }
        }, [
          el('span.tab-icon', { text: tab.icon }),
          el('span.tab-label', { text: tab.label })
        ])
      );
    }

    shell.append(topBar, this.viewport, this.tabBar);
  }

  updateOfflineChip() {
    if (this.offlineChip) this.offlineChip.hidden = navigator.onLine;
  }

  // ─────────────────────────── navigáció ───────────────────────────

  startRouting() {
    window.addEventListener('hashchange', () => {
      const route = location.hash.replace(/^#\/?/, '') || 'home';
      // A navigáláskor átadott paramétereket a hashchange itt veszi át –
      // a hash maga nem tudja hordozni a szobaállapotot.
      const params = this.pendingParams ?? {};
      this.pendingParams = null;
      // Oldalújratöltés vagy megosztott link esetén a szoba nem állítható
      // vissza, ezért a többjátékos belépőre visszük.
      this.render(route === 'room' && !params.room ? 'multiplayer' : route, params);
    });

    const initial = location.hash.replace(/^#\/?/, '') || 'home';
    this.render(initial === 'room' ? 'multiplayer' : initial, {});
  }

  navigate(route, params = {}) {
    this.pendingParams = params;
    if (location.hash.replace(/^#\/?/, '') === route) {
      this.pendingParams = null;
      this.render(route, params);
    } else {
      // A hash beállítása kiváltja a hashchange-et, ami a pendingParams-szal renderel.
      location.hash = `#/${route}`;
    }
  }

  refreshCurrentScreen() {
    this.render(this.currentRoute ?? 'home', this.currentParams);
  }

  async render(route, params) {
    // Az előző képernyő takarítása (kerék-animáció, pollozás leállítása).
    if (this.currentScreen) {
      this.currentScreen.dispatchEvent(new CustomEvent('screen:unmount'));
      if (this.currentScreenObject?.unmount) this.currentScreenObject.unmount();
    }
    this.currentScreenObject = null;
    this.currentRoute = route;
    this.currentParams = params ?? this.currentParams;

    clear(this.viewport);
    this.viewport.append(spinner());

    const isGameLike = route === 'game' || route === 'room';
    this.tabBar.hidden = isGameLike;
    document.body.classList.toggle('in-game', isGameLike);

    for (const item of this.tabBar.querySelectorAll('.tab-item')) {
      item.classList.toggle('tab-active', item.dataset.route === route);
    }

    this.titleEl.textContent = titleFor(route);

    let node;
    try {
      switch (route) {
        case 'game': {
          clear(this.viewport);
          const screen = new GameScreen(this);
          this.currentScreenObject = screen;
          await screen.mount(this.viewport);
          this.currentScreen = screen.root;
          return;
        }
        case 'multiplayer':
          node = multiplayerScreen(this);
          break;
        case 'room':
          if (!this.currentParams.room) {
            node = multiplayerScreen(this);
            break;
          }
          node = roomScreen(this, this.currentParams);
          break;
        case 'stats':
          node = await statsScreen(this);
          break;
        case 'leaderboard':
          node = leaderboardScreen(this);
          break;
        case 'profile':
          node = profileScreen(this);
          break;
        case 'settings':
          node = settingsScreen(this);
          break;
        case 'about':
          node = await aboutScreen(this);
          break;
        case 'home':
        default:
          node = homeScreen(this);
          break;
      }
    } catch (error) {
      node = el('div.screen', null, [
        el('h2', { text: 'Hiba történt' }),
        el('p', { text: error.message })
      ]);
    }

    clear(this.viewport);
    this.viewport.append(node);
    this.currentScreen = node;
    this.viewport.scrollTop = 0;
  }

  // ─────────────────────────── profil szinkron ───────────────────────────

  /** Becenév/avatar feltöltése; offline esetén a kimenő sorba kerül. */
  pushProfile(patch) {
    if (!this.supabase.isConfigured) return;
    if (!this.supabase.isSignedIn || !navigator.onLine) {
      outbox.enqueue('profile', patch);
      return;
    }
    const userId = this.supabase.userId;
    this.supabase.patch('profiles', `id=eq.${userId}`, patch).catch(() => {
      outbox.enqueue('profile', patch);
    });
  }
}

function titleFor(route) {
  return {
    home: CONFIG.appName,
    game: 'Kör',
    stats: 'Statisztika',
    leaderboard: 'Ranglista',
    profile: 'Profil',
    settings: 'Beállítások',
    about: 'Névjegy',
    multiplayer: 'Többjátékos',
    room: 'Szoba'
  }[route] ?? CONFIG.appName;
}

// ─────────────────────────── service worker ───────────────────────────

if ('serviceWorker' in navigator) {
  // Volt-e már korábban service worker? Ha igen, egy vezérlőváltás azt jelenti,
  // hogy ÚJ verzió települt – ilyenkor újra kell tölteni a lapot, különben a
  // már betöltött (régi) JS futna tovább a friss cache mellett.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    // Egyetlen újratöltés, guard-dal – így nem tud ciklusba kerülni.
    location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.info('A service worker regisztrációja nem sikerült:', error.message);
    });
  });
}

const app = new App();
app.boot();

// Fejlesztéshez hasznos: a konzolból elérhető az állapot.
window.tudaskerek = app;
