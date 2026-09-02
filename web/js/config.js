// A PWA konfigurációja.
//
// Itt CSAK nyilvános adat szerepelhet: a Supabase projekt URL-je és az `anon`
// kulcs. Ezek nem titkosak – a hozzáférést a Row Level Security szabályozza.
// A `service_role` kulcs SOHA nem kerülhet ide.
//
// Ha nincs beállítva backend, az alkalmazás offline módban fut a beépített
// kérdésbankkal: a játék, a pontszám és a statisztika működik, csak a ranglista
// és a többjátékos mód nem.
//
// Beállítás: írd át az alábbi két értéket a Supabase projektedéire
// (Project Settings → API → Project URL és `anon` `public` kulcs).
// Ezeket bátran commitolhatod: az `anon` kulcs kifejezetten publikus, a
// hozzáférést a Row Level Security szabályozza. A `service_role` kulcs viszont
// SOHA nem kerülhet ide – az csak a `tools/.env` fájlba tartozik.
//
// Ha a hosting build-időben tud környezeti változót behelyettesíteni, a
// `window.TUDASKEREK_CONFIG` objektummal is felül lehet írni ezeket.

const DEFAULTS = {
  supabaseUrl: 'https://rwmlxuktppfxoxsxfttq.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ3bWx4dWt0cHBmeG94c3hmdHRxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzMTQxMTcsImV4cCI6MjEwMzg5MDExN30.xoxNndJvGDuOh8zkakSKLRec3r7pur08om9p4wNo32I',

  // Hány kérdést tartsunk offline kategóriánként a letöltött csomagból.
  offlineQuestionsPerCategory: 12,

  // Monetizáció-előkészítés: most minden ingyenes.
  adsEnabled: false,

  appName: 'TudásKerék',
  version: '1.0.0'
};

// A `config.local.js` (ha van) felülírja a beépített értékeket.
const overrides =
  (typeof window !== 'undefined' && window.TUDASKEREK_CONFIG) || {};

export const CONFIG = Object.freeze({ ...DEFAULTS, ...overrides });

export const HAS_BACKEND = Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);
