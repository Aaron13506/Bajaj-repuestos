
'use strict';

/**
 * Scraper de tarifas de envio de Shoppre (India -> pais destino).
 *
 * El calculador publico https://www.shoppre.com/cheap-rates-international-shipping-cost-calculator
 * no renderiza las tarifas en el HTML: consulta esta API JSON, que ya devuelve el precio
 * convertido a dolares en `customer_rate_in_usd`. No hace falta navegador ni Playwright.
 *
 * Sin dependencias. Requiere Node >= 18 (fetch nativo).
 *
 * Uso como modulo (lo que vas a querer en Heroku):
 *
 *   const { scrapeRates, diffRates } = require('./shoppre-scraper');
 *   const data = await scrapeRates();            // lanza si algun peso falla
 *   await guardarDondeQuieras(data);             // Postgres, S3, etc.
 *
 * Uso como CLI (para probar local; en Heroku el archivo se pierde):
 *
 *   node shoppre-scraper.js --out rates.json
 *   node shoppre-scraper.js --stdout | jq .
 */

const API = 'https://logistics-v2.shoppre.com/api/pricing';
const CALCULATOR_URL = 'https://www.shoppre.com/cheap-rates-international-shipping-cost-calculator';
const MEMBER_DISCOUNT = 0.05; // "Member Price (5% Extra Off)", la web lo aplica en el cliente
const USER_AGENT = 'shoppre-rates-scraper/1.0';

const DEFAULTS = {
  country: 226,   // United States
  from: 1.0,
  to: 22.0,
  step: 0.1,
  length: 0.5,    // cm; con 0.5^3 el peso volumetrico es ~0, manda el peso real
  width: 0.5,
  height: 0.5,
  concurrency: 3,
  delay: 100,     // ms entre requests de un mismo worker (cortesia)
  retries: 4,
  timeout: 20000, // ms por request
  onProgress: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function weightList({ from, to, step }) {
  const out = [];
  const steps = Math.round((to - from) / step);
  for (let i = 0; i <= steps; i++) out.push(Number((from + i * step).toFixed(3)));
  return out;
}

function buildUrl(cfg, weight) {
  const p = new URLSearchParams({
    weight: String(weight),
    country_id: String(cfg.country),
    category_id: '',
    length: String(cfg.length),
    width: String(cfg.width),
    height: String(cfg.height),
    scale: 'kg',
    unit: 'cm',
    resType: 'shipcal',
  });
  return `${API}?${p}`;
}

async function fetchWeight(cfg, weight) {
  let lastError;
  for (let attempt = 1; attempt <= cfg.retries; attempt++) {
    try {
      const res = await fetch(buildUrl(cfg, weight), {
        headers: { accept: 'application/json', referer: CALCULATOR_URL, 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(cfg.timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();

      const carriers = (body.pricingData ?? []).map((p) => {
        const basic = Number(p.customer_rate_in_usd);
        if (!Number.isFinite(basic)) throw new Error(`precio USD invalido para "${p.name}"`);
        return {
          carrier: p.name,
          service: p.type || null,
          transit_business_days: p.estimated_delivery_days ?? null,
          basic_price_usd: basic,
          member_price_usd: Number((basic * (1 - MEMBER_DISCOUNT)).toFixed(2)),
          basic_price_inr: p.customer_rate ?? null,
        };
      });
      if (carriers.length === 0) throw new Error('respuesta sin tarifas');

      carriers.sort((a, b) => a.carrier.localeCompare(b.carrier)); // orden estable
      return { weight_kg: weight, carriers };
    } catch (err) {
      lastError = err;
      if (attempt < cfg.retries) await sleep(400 * attempt);
    }
  }
  throw new Error(`peso ${weight} kg: ${lastError?.message ?? lastError}`);
}

/**
 * Trae todas las tarifas del rango.
 *
 * Si algun peso falla tras los reintentos, LANZA en vez de devolver datos parciales:
 * un dataset incompleto es peor que ninguno, porque no se distingue de una baja de precio.
 *
 * @returns {Promise<object>} dataset completo, listo para persistir
 */
async function scrapeRates(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const weights = weightList(cfg);
  const results = new Array(weights.length);
  const errors = [];
  let next = 0;
  let done = 0;

  async function worker() {
    while (next < weights.length) {
      const i = next++;
      try {
        results[i] = await fetchWeight(cfg, weights[i]);
      } catch (err) {
        errors.push(err.message);
      }
      done++;
      cfg.onProgress?.(done, weights.length);
      if (cfg.delay > 0) await sleep(cfg.delay);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, cfg.concurrency) }, worker));

  if (errors.length) {
    const err = new Error(`Shoppre: ${errors.length}/${weights.length} pesos fallaron`);
    err.failures = errors;
    throw err;
  }

  return {
    source: CALCULATOR_URL,
    api: API,
    origin: 'India',
    destination_country_id: cfg.country,
    currency: 'USD',
    member_discount: MEMBER_DISCOUNT,
    dimensions_cm: { length: cfg.length, width: cfg.width, height: cfg.height },
    weight_range_kg: { from: cfg.from, to: cfg.to, step: cfg.step },
    generated_at: new Date().toISOString(),
    rates: results.filter(Boolean).sort((a, b) => a.weight_kg - b.weight_kg),
  };
}

/** Aplana a "peso|carrier" -> precio USD. */
function flatten(rates) {
  const m = new Map();
  for (const r of rates ?? []) {
    for (const c of r.carriers ?? []) m.set(`${r.weight_kg}|${c.carrier}`, c.basic_price_usd);
  }
  return m;
}

/**
 * Compara dos corridas. Usalo para no guardar una fila nueva si nada cambio,
 * y para disparar un aviso cuando los precios se mueven.
 *
 * @returns {{changed: Array, added: string[], removed: string[], total: number}}
 */
function diffRates(oldRates, newRates) {
  const a = flatten(oldRates);
  const b = flatten(newRates);
  const changed = [];
  const added = [];
  const removed = [];
  for (const [k, v] of b) {
    if (!a.has(k)) added.push(k);
    else if (a.get(k) !== v) changed.push({ key: k, from: a.get(k), to: v });
  }
  for (const k of a.keys()) if (!b.has(k)) removed.push(k);
  return { changed, added, removed, total: changed.length + added.length + removed.length };
}

/** Resumen legible de un diff, para logs o notificaciones. */
function summarizeDiff(diff, limit = 10) {
  if (diff.total === 0) return 'Sin cambios de precio.';
  const lines = [
    `${diff.changed.length} precios cambiaron, ${diff.added.length} nuevos, ${diff.removed.length} eliminados.`,
  ];
  const worst = diff.changed
    .slice()
    .sort((x, y) => Math.abs(y.to - y.from) - Math.abs(x.to - x.from))
    .slice(0, limit);
  for (const c of worst) {
    const [w, carrier] = c.key.split('|');
    const pct = c.from ? ((c.to - c.from) / c.from) * 100 : 0;
    lines.push(`  ${w} kg  ${carrier}: $${c.from} -> $${c.to} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`);
  }
  if (diff.changed.length > worst.length) lines.push(`  ... y ${diff.changed.length - worst.length} mas`);
  return lines.join('\n');
}

module.exports = { scrapeRates, diffRates, summarizeDiff, DEFAULTS, API, CALCULATOR_URL };

// ------------------------------------------------------------------ CLI

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const flag = (name, fallback) => {
      const i = argv.indexOf(name);
      return i === -1 ? fallback : argv[i + 1];
    };

    const opts = {};
    for (const k of ['country', 'from', 'to', 'step', 'concurrency', 'delay']) {
      const v = flag(`--${k}`);
      if (v !== undefined) opts[k] = Number(v);
    }
    const dims = flag('--dims');
    if (dims) {
      const [length, width, height] = dims.split('x').map(Number);
      Object.assign(opts, { length, width, height });
    }
    if (process.stderr.isTTY) {
      opts.onProgress = (d, t) => process.stderr.write(`\r  ${d}/${t} pesos`);
    }

    try {
      const data = await scrapeRates(opts);
      if (process.stderr.isTTY) process.stderr.write('\n');

      if (argv.includes('--stdout')) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      } else {
        const fs = require('node:fs');
        const path = require('node:path');
        const out = flag('--out', 'shoppre-rates.json');
        fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
        fs.writeFileSync(out, JSON.stringify(data, null, 2) + '\n', 'utf8');
        console.error(`Escrito ${out} (${data.rates.length} pesos).`);
      }
      process.exit(0);
    } catch (err) {
      console.error(`FALLO: ${err.message}`);
      for (const f of (err.failures ?? []).slice(0, 10)) console.error(`  - ${f}`);
      process.exit(1);
    }
  })();
}