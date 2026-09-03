// Görgetős számjegyválasztó – a 3 jegyű szoba-PIN megadásához.
//
// Miért nem sima `<input type="number">`? Mert telefonon a numerikus billentyűzet
// felugrik, eltakarja a felületet, és a „3 pontosan 3 jegy” szabályt csak
// utólag lehet ellenőrizni. A görgetős kerék mindig érvényes értéket ad, és
// hüvelykujjal kényelmes.
//
// Megvalósítás: három egymás melletti, függőlegesen görgethető lista
// `scroll-snap-type: y mandatory`-val. A kiválasztott jegy a görgetés
// pozíciójából adódik – nincs saját drag-kezelés, tehát a böngésző natív
// tehetetlensége (momentum scroll) érintetlen marad.
//
// KÖRKÖRÖS LAPOZÁS: a 0 fölött a 9-nek kell jönnie, ne érjen véget a lista.
// Ezt úgy oldjuk meg, hogy a 0–9 sort HÁROMSZOR egymás után ismételjük, és a
// középső másolatból indulunk. Amikor a görgetés megáll a szélső (első vagy
// utolsó) másolatban, egy ÉSZREVÉTLEN, animáció nélküli ugrással visszatérjük
// a középső másolat ugyanarra a számjegyére – a felhasználó ebből semmit nem
// lát, mert a megjelenő szám ugyanaz marad.
//
// A `scrollend` esemény nem elérhető mindenhol (iOS Safari később kapta meg),
// ezért a `scroll`-t is figyeljük egy rövid késleltetéssel.

import { el } from './ui.js';
import { sfx } from './sound.js';

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const SET_SIZE = DIGITS.length;
// A `.picker-item` magassága a CSS-ben FIXEN 44px (nem reszponzív, nincs rá
// médialekérdezés) – ezért ezt nem kell (és nem is szabad) élő DOM-mérésből
// (`offsetHeight`) kiolvasni. A KEZDETI pozicionálás korábban erre épült, és
// versenyhelyzetet okozott: ha a párbeszéd elemei még nem voltak teljesen
// kiszámolva (lassabb eszköz, vagy – ahogy a tesztekben kiderült – headless
// böngésző virtuális órája alatt), az `offsetHeight` időnként 0-t vagy egy
// átmeneti, hibás értéket adott vissza, és a választó rossz pozícióra ugrott
// (vagy sehova). Egy állandóval ez a hibaosztály megszűnik.
const ITEM_HEIGHT = 44;
// Három másolat: egy "előtte", egy "otthon" (ahonnan indulunk és ahová
// mindig visszaugrunk), egy "utána". Bőven elég, mert minden megálláskor
// visszaközepedünk – a felhasználó sosem tudja "kigörgetni" a puffert.
const REPEAT = 3;
const HOME_BASE = SET_SIZE * Math.floor(REPEAT / 2);

/**
 * @param {object} options
 * @param {number} [options.length] hány jegyű (alap: 3)
 * @param {string} [options.value] kezdőérték, pl. "407"
 * @param {(value: string) => void} [options.onChange]
 * @returns {{node: HTMLElement, value: () => string, set: (v: string) => void, focusFirst: () => void}}
 */
export function digitPicker({ length = 3, value = '', onChange = null } = {}) {
  const start = String(value).replace(/\D/g, '').padEnd(length, '0').slice(0, length);
  const selected = [...start].map(Number);
  const columns = [];

  const node = el('div.picker', {
    role: 'group',
    'aria-label': `${length} jegyű kód`
  });

  function emit() {
    onChange?.(selected.join(''));
  }

  for (let index = 0; index < length; index++) {
    const list = el('div.picker-col', {
      tabIndex: 0,
      role: 'spinbutton',
      'aria-label': `${index + 1}. számjegy`,
      'aria-valuemin': '0',
      'aria-valuemax': '9'
    });

    // Fölé-alá kerülő üres hely, hogy a legszélső (elvileg sosem látott)
    // tétel is középre tudjon állni, ha valaki mégis odagörgetne.
    list.append(el('div.picker-pad'));
    for (let copy = 0; copy < REPEAT; copy++) {
      for (const digit of DIGITS) {
        list.append(
          el('div.picker-item', {
            text: String(digit),
            dataset: { digit: String(digit), raw: String(copy * SET_SIZE + digit) }
          })
        );
      }
    }
    list.append(el('div.picker-pad'));

    let settleTimer = null;
    let lastReportedDigit = selected[index];
    // Amíg igaz, a görgetés-eseményt az ÉSZREVÉTLEN visszaközepedés váltja
    // ki, nem a felhasználó – ilyenkor nem indítunk újabb settle-ciklust.
    let recentering = false;

    /** Melyik (0..SET_SIZE*REPEAT-1) tétel van középen? */
    function currentRaw() {
      const max = SET_SIZE * REPEAT - 1;
      return Math.min(max, Math.max(0, Math.round(list.scrollTop / ITEM_HEIGHT)));
    }

    function digitOf(raw) {
      return DIGITS[((raw % SET_SIZE) + SET_SIZE) % SET_SIZE];
    }

    function paintAt(raw) {
      list.querySelectorAll('.picker-item').forEach((item) => {
        item.classList.toggle('picker-active', Number(item.dataset.raw) === raw);
      });
      list.setAttribute('aria-valuenow', String(digitOf(raw)));
    }

    function scrollToRaw(raw, smooth) {
      list.scrollTo({ top: raw * ITEM_HEIGHT, behavior: smooth ? 'smooth' : 'auto' });
    }

    /**
     * Görgetés egy konkrét pozícióra ÉS AZONNALI kijelölés – nem várjuk meg a
     * `smooth` animáció végét. Így koppintásra/nyílbillentyűre a kijelölés
     * rögtön reagál, a látvány pedig szépen, animálva követi. A természetes
     * görgetési eseményből induló `settle()` úgyis megerősíti (vagy javítja)
     * ugyanezt, amint az animáció ténylegesen befejeződött.
     */
    function jumpTo(raw, smooth) {
      scrollToRaw(raw, smooth);
      const digit = digitOf(raw);
      selected[index] = digit;
      if (lastReportedDigit !== digit) {
        lastReportedDigit = digit;
        sfx.tap();
      }
      paintAt(raw);
      emit();
    }

    function settle() {
      if (recentering) return;
      const raw = currentRaw();
      const digit = digitOf(raw);
      paintAt(raw);
      selected[index] = digit;
      if (lastReportedDigit !== digit) {
        lastReportedDigit = digit;
        sfx.tap();
      }
      emit();

      // Ha a szélső másolatba értünk, észrevétlenül visszaugrunk a középsőbe
      // – UGYANARRA a számjegyre, tehát a látvány nem változik.
      if (raw < SET_SIZE || raw >= SET_SIZE * (REPEAT - 1)) {
        const home = HOME_BASE + digit;
        recentering = true;
        scrollToRaw(home, false);
        paintAt(home);
        // Az azonnali scrollTop-váltás is kivált `scroll` eseményt – ezt a
        // rövid ablakot kell "elnyelnünk", mielőtt újra figyelünk.
        setTimeout(() => { recentering = false; }, 60);
      }
    }

    list.addEventListener('scroll', () => {
      if (recentering) return;
      paintAt(currentRaw());
      clearTimeout(settleTimer);
      // A `scroll-snap` befejezésére várunk. A `scrollend` nem mindenhol van meg.
      settleTimer = setTimeout(settle, 90);
    });

    // Koppintás egy jegyre: a PONTOSAN odamutatott másolatra görgetünk (nem a
    // digitre újraszámolt "otthon" pozícióra) – így nem ugrik a lista.
    list.addEventListener('click', (event) => {
      const item = event.target.closest('.picker-item');
      if (!item) return;
      jumpTo(Number(item.dataset.raw), true);
    });

    // Billentyűzet: nyilakkal is állítható (asztali gép, kisegítő technológia).
    // A nyíl fel/le KÖRKÖRÖSEN is működik: a raw index a settle() utáni
    // visszaközepedés miatt sosem távolodik el messze az "otthon" tartománytól.
    //
    // SZÁNDÉKOSAN NEM animált (`smooth: false`): a `currentRaw()` a tényleges
    // görgetési pozícióból számol, és egy előző, még animálódó (smooth)
    // görgetés közepén lekérdezve HIBÁS pozíciót adna – két gyors egymás
    // utáni billentyűleütés így rossz irányba ugorhatna. Billentyűzetnél az
    // azonnali reakció egyébként is jobb kisegítő-technológiai élmény.
    list.addEventListener('keydown', (event) => {
      const raw = currentRaw();
      let nextRaw = null;
      if (event.key === 'ArrowUp') nextRaw = raw - 1;
      else if (event.key === 'ArrowDown') nextRaw = raw + 1;
      else if (/^[0-9]$/.test(event.key)) nextRaw = HOME_BASE + Number(event.key);
      else return;
      event.preventDefault();
      jumpTo(nextRaw, false);
    });

    /** Külső hívás (kezdőérték beállítása): mindig az "otthon" másolatra ugrik. */
    function scrollToDigit(digit, smooth) {
      jumpTo(HOME_BASE + digit, smooth);
    }

    columns.push({ list, scrollToDigit, paintAt, homeRaw: () => HOME_BASE + selected[index] });
    node.append(list);
  }

  // A kijelölt sort jelző keret. Külön elem, hogy a görgetéssel ne mozogjon.
  node.append(el('div.picker-highlight', { 'aria-hidden': 'true' }));

  function layout() {
    columns.forEach((column, index) => column.scrollToDigit(selected[index], false));
  }
  // AZONNAL, szinkron módon beállítjuk a kijelölést és az értéket – ehhez
  // nem kell megvárni, hogy az elem a dokumentumban legyen, mert a
  // `.picker-active` osztály és a `selected` tömb kizárólag a `raw` indexből
  // számolódik, nem élő DOM-mérésből (lásd `ITEM_HEIGHT`).
  //
  // KORÁBBAN ez egyetlen `requestAnimationFrame`-re várt, ami versenyhelyzetet
  // okozott: ha a hívó (pl. `openCreate`) a picker létrehozása UTÁN fűzi be a
  // DOM-ba a párbeszédet, a keret néha csak később, egy KÉSŐBBI képkockában
  // fut le – addig a választó üresen, kijelölés nélkül állt (ezt a
  // tesztkészlet is elkapta, nem csak elméleti eset).
  layout();
  // A látható GÖRGETÉSI pozíció (nem az érték!) csak akkor áll be helyesen,
  // ha az elem már valóban a dokumentum része és van kiszámolt magassága –
  // ezért ezt még egyszer, egy `requestAnimationFrame` után is elvégezzük.
  // Ha időközben a hívó már be is fűzte a DOM-ba, ez a hívás egyszerűen
  // megerősíti ugyanazt; ha csak ezután fűzi be, ez javítja a látványt.
  requestAnimationFrame(layout);

  return {
    node,
    value: () => selected.join(''),
    set(next) {
      const digits = String(next).replace(/\D/g, '').padEnd(length, '0').slice(0, length);
      [...digits].forEach((digit, index) => {
        selected[index] = Number(digit);
        columns[index].scrollToDigit(Number(digit), true);
      });
    },
    focusFirst() {
      columns[0]?.list.focus();
    },
    /** Ha a felület átméreteződött (pl. elfordult a telefon). */
    relayout: layout
  };
}
