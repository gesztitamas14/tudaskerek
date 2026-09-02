// Apró DOM- és formázó segédek. Nincs keretrendszer: a felület kézzel épül,
// így nincs build lépés, és az egész alkalmazás statikus fájlokból fut.

// ─────────────────────────── DOM ───────────────────────────

/**
 * Elem létrehozása.
 * @param {string} tag - `div`, `button.primary`, `span#score` alakban is
 * @param {object|null} props - attribútumok; `text`, `html`, `on` speciális
 * @param {Array|string} children
 */
export function el(tag, props = null, children = []) {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const node = document.createElement(name || 'div');

  for (const token of rest) {
    if (token.startsWith('.')) node.classList.add(token.slice(1));
    else if (token.startsWith('#')) node.id = token.slice(1);
  }

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'text') node.textContent = String(value);
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'class') node.className += (node.className ? ' ' : '') + value;
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'on') {
        for (const [event, handler] of Object.entries(value)) {
          node.addEventListener(event, handler);
        }
      } else if (key === 'dataset') {
        Object.assign(node.dataset, value);
      } else if (key in node && key !== 'list') {
        node[key] = value;
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }

  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function qs(selector, root = document) {
  return root.querySelector(selector);
}

// ─────────────────────────── formázás ───────────────────────────

const pointsFormatter = new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 0 });

export const fmt = {
  points(value) {
    return pointsFormatter.format(Math.round(Number(value) || 0));
  },

  percent(ratio) {
    if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '–';
    return `${Math.round(ratio * 100)}%`;
  },

  dateTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '–';

    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    const time = date.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return `ma ${time}`;
    if (date.toDateString() === yesterday.toDateString()) return `tegnap ${time}`;
    return `${date.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })} ${time}`;
  },

  difficulty(value) {
    return { easy: 'Könnyű', medium: 'Közepes', hard: 'Nehéz' }[value] ?? value;
  }
};

// ─────────────────────────── visszajelzés ───────────────────────────

/**
 * Rezgés. iOS Safariban a Vibration API NEM elérhető, ezért ott ez csendben
 * nem tesz semmit; Androidon és asztali gépen működik. Ez a webes megoldás
 * tudatosan vállalt hátránya – a vizuális és hangvisszajelzés pótolja.
 */
let hapticsEnabled = true;

export function setHapticsEnabled(value) {
  hapticsEnabled = Boolean(value);
}

export function haptic(pattern = 12) {
  if (!hapticsEnabled) return;
  if (typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(pattern);
    } catch {
      /* nem támogatott */
    }
  }
}

export const HAPTIC = {
  tick: 6,
  tap: 12,
  correct: [18, 40, 24],
  wrong: [60, 50, 60],
  bigWin: [24, 40, 24, 40, 60],
  stop: 30
};

// ─────────────────────────── toast ───────────────────────────

let toastTimer = null;

export function toast(message, { tone = 'info', duration = 3500 } = {}) {
  let host = qs('#toast');
  if (!host) {
    host = el('div#toast');
    document.body.append(host);
  }
  host.textContent = message;
  host.className = `toast toast-${tone} visible`;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.classList.remove('visible'), duration);
}

// ─────────────────────────── konfetti ───────────────────────────

/** Könnyű konfetti: néhány tucat animált négyzet, külső könyvtár nélkül. */
export function confetti(host, count = 40) {
  const layer = el('div.confetti');
  const colors = ['#F5D07A', '#7C5CFF', '#35C77B', '#E8556B', '#F2A93B'];

  for (let i = 0; i < count; i++) {
    const piece = el('i');
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDelay = `${Math.random() * 0.6}s`;
    piece.style.animationDuration = `${1.6 + Math.random() * 1.4}s`;
    piece.style.setProperty('--spin', `${180 + Math.random() * 720}deg`);
    layer.append(piece);
  }

  host.append(layer);
  setTimeout(() => layer.remove(), 3600);
}

// ─────────────────────────── közös komponensek ───────────────────────────

export function card(children, { padding = null } = {}) {
  const node = el('section.card', null, children);
  if (padding) node.style.padding = padding;
  return node;
}

export function primaryButton(label, onClick, { icon = null, tone = 'primary', disabled = false } = {}) {
  return el(
    'button.btn',
    {
      class: `btn-${tone}`,
      type: 'button',
      disabled,
      on: { click: onClick }
    },
    [icon ? el('span.btn-icon', { text: icon }) : null, el('span', { text: label })]
  );
}

export function scorePill(title, value) {
  return el('div.pill', null, [
    el('span.pill-title', { text: title }),
    el('span.pill-value', { text: fmt.points(value) })
  ]);
}

/** Körjelző: 1/10 … 10/10, a bónuszpozíciók aranyszínű kerettel. */
export function progressBar({ current, total, marks, bonus }) {
  const track = el('div.progress');
  for (let index = 1; index <= total; index++) {
    const state =
      marks[index - 1] === true ? 'correct'
      : marks[index - 1] === false ? 'wrong'
      : index === current ? 'active'
      : 'idle';
    track.append(
      el('span.segment', {
        class: `segment-${state}${bonus.has(index) ? ' segment-bonus' : ''}`,
        title: bonus.has(index) ? `${index}. kérdés – bónusz` : `${index}. kérdés`
      })
    );
  }
  return el('div.progress-wrap', null, [
    track,
    el('div.progress-label', {
      text: `${Math.min(Math.max(current, 0), total)}/${total}. kérdés`
    })
  ]);
}

export function categoryBadge(category, { compact = false } = {}) {
  // A kategória `icon` mezője emoji – így nincs képi asset, és minden
  // platformon megjelenik.
  return el('span.badge', {
    class: compact ? 'badge-compact' : '',
    style: { background: category.color || '#7C5CFF' }
  }, [
    category.icon ? el('span.badge-icon', { text: category.icon }) : null,
    el('span', { text: category.name })
  ]);
}

export function stateMessage({ icon = '•', title, message, actionLabel = null, action = null }) {
  return el('div.state-message', null, [
    el('div.state-icon', { text: icon }),
    el('h3', { text: title }),
    el('p', { text: message }),
    actionLabel && action ? primaryButton(actionLabel, action, { tone: 'secondary' }) : null
  ]);
}

export function spinner(label = 'Betöltés…') {
  return el('div.spinner-wrap', null, [el('div.spinner'), el('span', { text: label })]);
}

/** Avatar-készlet: emoji, hogy ne kelljen képi asset. */
export const AVATARS = [
  { id: 'fox', emoji: '🦊', name: 'Róka' },
  { id: 'owl', emoji: '🦉', name: 'Bagoly' },
  { id: 'bear', emoji: '🐻', name: 'Medve' },
  { id: 'cat', emoji: '🐱', name: 'Macska' },
  { id: 'dog', emoji: '🐶', name: 'Kutya' },
  { id: 'hare', emoji: '🐰', name: 'Nyúl' },
  { id: 'tortoise', emoji: '🐢', name: 'Teknős' },
  { id: 'bird', emoji: '🐦', name: 'Madár' },
  { id: 'fish', emoji: '🐟', name: 'Hal' },
  { id: 'ant', emoji: '🐜', name: 'Hangya' },
  { id: 'ladybug', emoji: '🐞', name: 'Katica' },
  { id: 'lizard', emoji: '🦎', name: 'Gyík' }
];

export function avatarEmoji(id) {
  return AVATARS.find((avatar) => avatar.id === id)?.emoji ?? '🦊';
}
