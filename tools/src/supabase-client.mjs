// Minimális Supabase kliens a Node-eszközökhöz (beépített fetch, nulla függőség).
//
// A service role kulcsot használjuk, ami MINDEN RLS-t megkerül. Ezért:
//   * csak lokálisan, `.env` fájlból olvassuk,
//   * soha nem kerül a repóba (lásd .gitignore),
//   * a hibaüzenetekben sem jelenítjük meg.

import { readFileSync, existsSync } from 'node:fs';

/** Egyszerű .env betöltő (nincs dotenv függőség). */
export function loadEnv(path = 'tools/.env') {
  const env = { ...process.env };
  if (!existsSync(path)) return env;

  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // A .env nem írja felül a valódi környezeti változót
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

export class SupabaseAdmin {
  /**
   * @param {{url: string, serviceKey: string}} options
   */
  constructor({ url, serviceKey }) {
    if (!url || !serviceKey) {
      throw new Error(
        'Hiányzó SUPABASE_URL vagy SUPABASE_SERVICE_ROLE_KEY. ' +
        'Hozd létre a tools/.env fájlt a tools/.env.example alapján.'
      );
    }
    this.url = url.replace(/\/+$/, '');
    this.serviceKey = serviceKey;
  }

  static fromEnv(env = loadEnv()) {
    return new SupabaseAdmin({
      url: env.SUPABASE_URL,
      serviceKey: env.SUPABASE_SERVICE_ROLE_KEY
    });
  }

  get headers() {
    return {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
  }

  async request(path, { method = 'GET', body, prefer } = {}) {
    const headers = { ...this.headers };
    if (prefer) headers.Prefer = prefer;

    const response = await fetch(`${this.url}/rest/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const text = await response.text();
    if (!response.ok) {
      // A kulcsot sosem írjuk ki – csak az útvonalat és a szerver válaszát.
      throw new Error(`Supabase ${method} ${path} → ${response.status}: ${text.slice(0, 600)}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  select(table, query = '') {
    const suffix = query ? (query.startsWith('?') ? query : `?${query}`) : '';
    return this.request(`/${table}${suffix}`);
  }

  /** Beszúrás/frissítés. `onConflict` esetén upsert. */
  upsert(table, rows, { onConflict, returning = 'representation' } = {}) {
    const conflict = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
    const prefer = [
      `return=${returning}`,
      onConflict ? 'resolution=merge-duplicates' : null
    ].filter(Boolean).join(',');
    return this.request(`/${table}${conflict}`, { method: 'POST', body: rows, prefer });
  }

  insert(table, rows, { returning = 'representation' } = {}) {
    return this.request(`/${table}`, {
      method: 'POST',
      body: rows,
      prefer: `return=${returning}`
    });
  }

  update(table, query, patch) {
    return this.request(`/${table}?${query}`, {
      method: 'PATCH',
      body: patch,
      prefer: 'return=representation'
    });
  }

  rpc(name, params = {}) {
    return this.request(`/rpc/${name}`, { method: 'POST', body: params });
  }
}

/** Tömbök feldarabolása – a PostgREST nem szeret tízezres batcheket. */
export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
