// Játékhangok – szintetizálva, hangfájlok nélkül.
//
// Miért nincs egyetlen .mp3 sem?
//   * A projekt offline-first: minden hangfájlt a service workernek is
//     cache-elnie kellene. Nyolc rövid effekt is 100–300 kB.
//   * A szintetizált hang néhány száz bájt kód, és pontosan hangolható a
//     játékmenethez (a pörgetés kattogása például a kerék sebességét követi).
//   * Nincs licencgond: nem kell külső hangkészletet behozni.
//
// A böngészők nem engedik, hogy hang szóljon felhasználói interakció előtt,
// ezért az AudioContext az első koppintásnál/kattintásnál indul (`unlock`).
// Ha egy hangot kérünk előbb, azt csendben eldobjuk – nem hiba.
//
// iOS-specifikus tudnivaló: a WebAudio a telefon néma kapcsolóját (silent
// switch) figyeli. Ha a telefon néma állásban van, ez a hang NEM szól, akkor
// sem, ha az appban be van kapcsolva. Ez iOS-megkötés, nem tudjuk kikerülni.

let ctx = null;
let master = null;
let enabled = true;
let unlockBound = false;

// Egyszerre ennyi hang szólhat. Fölötte eldobjuk az újakat, hogy a pörgetés
// kattogása ne torzuljon el és ne halmozódjon.
const MAX_VOICES = 8;
let voices = 0;

export function setSoundEnabled(value) {
  enabled = Boolean(value);
  if (!enabled) return;
  // Bekapcsoláskor rögtön próbáljuk feloldani: a kattintás még „élő”.
  unlock();
}

export function isSoundEnabled() {
  return enabled;
}

/**
 * A hangmotor állapota – hibakereséshez és teszthez.
 *
 * 'none'      = nincs AudioContext (nem támogatott, vagy még nem volt interakció)
 * 'suspended' = van, de a böngésző még nem engedi (nem volt gesztus)
 * 'running'   = szól
 */
export function audioState() {
  if (!ctx) return 'none';
  return ctx.state;
}

/**
 * Az AudioContext létrehozása/folytatása. Bármikor hívható; csak
 * felhasználói interakció közben lesz belőle működő hang.
 */
export function unlock() {
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    if (!ctx) {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.32;      // az effektek háttérben maradnak
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    ctx = null;   // nincs WebAudio: a játék hang nélkül megy tovább
  }
}

/** Az első felhasználói interakcióra feloldjuk a hangot. */
export function bindUnlockOnFirstGesture() {
  if (unlockBound) return;
  unlockBound = true;
  const handler = () => unlock();
  for (const event of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(event, handler, { once: true, passive: true });
  }
}

/**
 * Egy hang: oszcillátor + burkoló. A `type` a hangszínt adja, a `from`/`to`
 * pedig a frekvenciasöprést (pl. lefelé csúszó „hiba” hang).
 */
function tone({
  from,
  to = from,
  duration = 0.12,
  type = 'sine',
  gain = 0.6,
  delay = 0,
  attack = 0.005
}) {
  if (!enabled || !ctx || ctx.state !== 'running') return;
  if (voices >= MAX_VOICES) return;

  try {
    const start = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(from, start);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + duration);

    // Lineáris felfutás, exponenciális lecsengés: így nem pattog.
    env.gain.setValueAtTime(0.0001, start);
    env.gain.linearRampToValueAtTime(gain, start + Math.min(attack, duration / 2));
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(env);
    env.connect(master);

    voices++;
    osc.onended = () => {
      voices--;
      try {
        env.disconnect();
      } catch {
        /* már le van kötve */
      }
    };

    osc.start(start);
    osc.stop(start + duration + 0.02);
  } catch {
    /* a hang soha ne állítsa meg a játékot */
  }
}

/** Rövid zörej-koppanás (kerék kattogása). */
function click(gain = 0.5) {
  if (!enabled || !ctx || ctx.state !== 'running') return;
  if (voices >= MAX_VOICES) return;
  try {
    const duration = 0.03;
    const frames = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      // Gyorsan lecsengő fehér zaj – ez adja a „kop” karaktert.
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 3;
    }
    const src = ctx.createBufferSource();
    const env = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1800;
    filter.Q.value = 1.2;
    env.gain.value = gain;

    src.buffer = buffer;
    src.connect(filter);
    filter.connect(env);
    env.connect(master);

    voices++;
    src.onended = () => {
      voices--;
      try {
        env.disconnect();
        filter.disconnect();
      } catch {
        /* már le van kötve */
      }
    };
    src.start();
  } catch {
    /* néma marad */
  }
}

// ─────────────────────────── effektek ───────────────────────────
//
// A nevek a játékmenet pillanataihoz szólnak, nem hangszínhez – így a
// hívási helyeken olvasható marad, mit jelez a hang.

export const sfx = {
  /** Gombnyomás, választás. */
  tap() {
    tone({ from: 880, to: 1180, duration: 0.05, type: 'triangle', gain: 0.35 });
  },

  /** A kerék egy szeletet átlépett. `intensity` 0–1: a kerék sebessége. */
  wheelTick(intensity = 1) {
    click(0.18 + 0.4 * Math.min(1, Math.max(0, intensity)));
  },

  /** A kerék megállt: tompa koppanás + rövid felfelé csúszás. */
  wheelStop() {
    click(0.7);
    tone({ from: 320, to: 520, duration: 0.18, type: 'triangle', gain: 0.45 });
  },

  /** Helyes válasz: két hangból álló felfelé lépés. */
  correct() {
    tone({ from: 660, duration: 0.1, type: 'sine', gain: 0.5 });
    tone({ from: 990, duration: 0.16, type: 'sine', gain: 0.45, delay: 0.09 });
  },

  /** Rossz válasz: lefelé csúszó, „szomorú” hang. */
  wrong() {
    tone({ from: 300, to: 150, duration: 0.34, type: 'sawtooth', gain: 0.3 });
    tone({ from: 200, to: 110, duration: 0.4, type: 'square', gain: 0.16, delay: 0.03 });
  },

  /** Kiesés a körből: mélyebb és hosszabb, mint a sima rossz válasz. */
  eliminated() {
    tone({ from: 420, to: 140, duration: 0.55, type: 'sawtooth', gain: 0.32 });
    tone({ from: 140, duration: 0.4, type: 'sine', gain: 0.22, delay: 0.3 });
  },

  /** Nagy pont (2000/5000) vagy kör vége: rövid fanfár. */
  bigWin() {
    const notes = [523, 659, 784, 1047];
    notes.forEach((freq, index) => {
      tone({ from: freq, duration: 0.2, type: 'triangle', gain: 0.4, delay: index * 0.075 });
    });
  },

  /** Bankolás: megkaptad a pontot. */
  bank() {
    tone({ from: 784, duration: 0.1, type: 'sine', gain: 0.4 });
    tone({ from: 1047, duration: 0.22, type: 'sine', gain: 0.36, delay: 0.08 });
  },

  /** Az utolsó másodpercek visszaszámlálása. */
  countdown() {
    tone({ from: 1200, duration: 0.07, type: 'square', gain: 0.22 });
  },

  /** Lejárt az idő. */
  timeout() {
    tone({ from: 520, to: 180, duration: 0.45, type: 'square', gain: 0.26 });
  },

  /** Új kérdés érkezett (multiplayerben mindenkinél egyszerre). */
  newQuestion() {
    tone({ from: 587, duration: 0.08, type: 'triangle', gain: 0.3 });
    tone({ from: 880, duration: 0.12, type: 'triangle', gain: 0.26, delay: 0.07 });
  }
};
