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
// A `scrollend` esemény nem elérhető mindenhol (iOS Safari később kapta meg),
// ezért a `scroll`-t is figyeljük egy rövid késleltetéssel.

import { el } from './ui.js';
import { sfx } from './sound.js';

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

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

    // Fölé-alá kerülő üres hely, hogy az első és utolsó jegy is középre álljon.
    list.append(el('div.picker-pad'));
    for (const digit of DIGITS) {
      list.append(el('div.picker-item', { text: String(digit), dataset: { digit: String(digit) } }));
    }
    list.append(el('div.picker-pad'));

    let settleTimer = null;
    let lastReported = selected[index];

    /** Melyik jegy van középen? A tétel magasságából számoljuk. */
    function currentIndex() {
      const item = list.querySelector('.picker-item');
      const itemHeight = item?.offsetHeight || 44;
      return Math.min(DIGITS.length - 1, Math.max(0, Math.round(list.scrollTop / itemHeight)));
    }

    function paint() {
      const active = currentIndex();
      list.querySelectorAll('.picker-item').forEach((item, i) => {
        item.classList.toggle('picker-active', i === active);
      });
      list.setAttribute('aria-valuenow', String(DIGITS[active]));
      return active;
    }

    function settle() {
      const active = paint();
      selected[index] = DIGITS[active];
      if (lastReported !== selected[index]) {
        lastReported = selected[index];
        sfx.tap();
      }
      emit();
    }

    list.addEventListener('scroll', () => {
      paint();
      clearTimeout(settleTimer);
      // A `scroll-snap` befejezésére várunk. A `scrollend` nem mindenhol van meg.
      settleTimer = setTimeout(settle, 90);
    });

    // Koppintás egy jegyre: odagörgetünk. Így nem kell pörgetni apró listán.
    list.addEventListener('click', (event) => {
      const item = event.target.closest('.picker-item');
      if (!item) return;
      scrollToDigit(Number(item.dataset.digit), true);
    });

    // Billentyűzet: nyilakkal is állítható (asztali gép, kisegítő technológia).
    list.addEventListener('keydown', (event) => {
      const active = currentIndex();
      let next = null;
      if (event.key === 'ArrowUp') next = active - 1;
      else if (event.key === 'ArrowDown') next = active + 1;
      else if (/^[0-9]$/.test(event.key)) next = Number(event.key);
      else return;
      event.preventDefault();
      scrollToDigit(Math.min(9, Math.max(0, next)), true);
    });

    function scrollToDigit(digit, smooth = false) {
      const item = list.querySelector('.picker-item');
      const itemHeight = item?.offsetHeight || 44;
      list.scrollTo({ top: digit * itemHeight, behavior: smooth ? 'smooth' : 'auto' });
      // Sima görgetésnél a `scroll` esemény hozza a `settle`-t; azonnalinál nem
      // biztos, ezért itt is beállítjuk.
      selected[index] = digit;
      paint();
      emit();
    }

    columns.push({ list, scrollToDigit, paint });
    node.append(list);
  }

  // A kijelölt sort jelző keret. Külön elem, hogy a görgetéssel ne mozogjon.
  node.append(el('div.picker-highlight', { 'aria-hidden': 'true' }));

  /**
   * A kezdőértékre állás csak akkor működik, ha az elem már a DOM-ban van és
   * van magassága. Ezért egy `requestAnimationFrame` után futtatjuk.
   */
  function layout() {
    columns.forEach((column, index) => column.scrollToDigit(selected[index], false));
  }
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
