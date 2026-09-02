// Közös segédkönyvtár a seed fájlok feldolgozásához.
//
// Egy helyen definiáljuk a normalizálást és a determinisztikus keverést, hogy a
// build (web/seed-questions.json) és az import (Supabase) pontosan ugyanazt az
// eredményt adja – különben a helyi és a szerveroldali bank elcsúszna.
// Ez fontos: különben a lokális és a szerveroldali kérdésbank eltérne.

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const SEED_DIR = 'content/seed';
export const CATEGORIES_FILE = 'content/categories.json';

/**
 * Kanonikus alak duplikátum-kereséshez.
 * A Postgres `norm_text()` SQL függvény és a PWA `normalize()`-ának párja:
 * kisbetű, ékezet nélkül, csak alfanumerikus, egy szóközzel.
 */
export function normalize(text) {
  return (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // kombináló ékezetek levágása
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Determinisztikus 32 bites hash egy stringből (FNV-1a). */
export function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Determinisztikus, seedelhető generátor (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A válaszok determinisztikus keverése.
 *
 * Miért kell? A kézzel írt seedben a helyes válasz gyakran az első helyen áll –
 * ez felismerhető mintázat lenne, és a szerver a tárolt sorrendben szolgálja ki
 * a kérdést. A keverés a kérdés szövegéből vett maggal történik, így
 * reprodukálható: ugyanaz a kérdés mindig ugyanazt a sorrendet kapja, akárhol
 * futtatjuk a buildet.
 */
export function shuffleAnswers(question, categorySlug) {
  const seed = hash32(`${categorySlug}|${normalize(question.q)}`);
  const random = rng(seed);

  const correctValue = question.a[question.c];
  const indices = question.a.map((_, i) => i);

  // Fisher–Yates a seedelt generátorral
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  const answers = indices.map((i) => question.a[i]);
  const correct = answers.indexOf(correctValue);
  return { answers, correct };
}

/** Egy kérdés determinisztikus, stabil azonosítója. */
export function questionID(categorySlug, questionText) {
  // Kulcs: "kategória|normalizált kérdés". SHA-1 alapú, v5-szerű UUID, mert a
  // szerveroldalon ez a kanonikus forma – és mert így ugyanaz a kérdés minden
  // gépen ugyanazt az azonosítót kapja.
  const digest = createHash('sha1')
    .update(`tudaskerek:${categorySlug}|${normalize(questionText)}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;   // v5-szerű jelölés
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20, 32)
  ].join('-');
}

export function loadCategories() {
  return JSON.parse(readFileSync(CATEGORIES_FILE, 'utf8'));
}

/**
 * Minden seed fájl beolvasása és egységes alakra hozása.
 * @returns {{questions: Array, files: Array<{file: string, count: number}>}}
 */
export function loadSeedQuestions({ shuffle = true } = {}) {
  const files = readdirSync(SEED_DIR).filter((name) => name.endsWith('.json')).sort();
  const questions = [];
  const summary = [];

  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(SEED_DIR, file), 'utf8'));
    const categorySlug = raw.category;
    if (!categorySlug) {
      throw new Error(`${file}: hiányzik a "category" mező`);
    }

    for (const item of raw.questions) {
      const { answers, correct } = shuffle
        ? shuffleAnswers(item, categorySlug)
        : { answers: item.a, correct: item.c };

      questions.push({
        id: questionID(categorySlug, item.q),
        category: categorySlug,
        question: item.q,
        answers,
        correct,
        difficulty: item.d ?? 'medium',
        explanation: item.e ?? null,
        source: item.s ?? raw.default_source ?? null,
        topic: item.t ?? null,
        provenance: raw.provenance ?? 'handwritten',
        license: raw.license ?? null
      });
    }
    summary.push({ file, count: raw.questions.length });
  }

  return { questions, files: summary };
}
