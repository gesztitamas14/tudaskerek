#!/usr/bin/env node
// Generált kérdések feltöltése review-ra egy korábban kiírt JSON fájlból.
//
// Akkor kell, ha a generálás offline (fájlba) történt – például mert a Supabase
// projekt még nem volt beállítva.
//
// Használat: node tools/src/upload-candidates.mjs content/generated/1234.json

import { readFileSync } from 'node:fs';
import { SupabaseAdmin, loadEnv } from './supabase-client.mjs';
import { uploadCandidates } from './generate-questions.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Használat: node tools/src/upload-candidates.mjs <fájl.json>');
  process.exit(1);
}

const payload = JSON.parse(readFileSync(file, 'utf8'));
const questions = payload.questions ?? payload;

if (!Array.isArray(questions) || questions.length === 0) {
  console.error('A fájl nem tartalmaz kérdéseket.');
  process.exit(1);
}

const db = SupabaseAdmin.fromEnv(loadEnv());

const tasks = [...new Set(questions.map((q) => q.category))].map((slug) => ({
  categorySlug: slug,
  topic: [...new Set(questions.filter((q) => q.category === slug).map((q) => q.topic))]
    .slice(0, 5)
    .join(', ')
}));

await uploadCandidates(db, questions, {
  model: payload.model ?? 'ismeretlen',
  tasks
});
