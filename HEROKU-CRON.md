# Migrar el scraper de tarifas Shoppre a un cron de Heroku

## Qué pasar al otro repo

**Un solo archivo: `shoppre-scraper.js`.** Cero dependencias, cero config. Ponelo donde tengas el resto
de tus scripts (ej. `scripts/shoppre-scraper.js`).

No hace falta llevar nada más. `scrape-rates.js`, `shipping-rates-usa-usd.json` y `README.md` de este
repo fueron para el análisis puntual — el que sirve para producción es `shoppre-scraper.js`.

Requisito: **Node >= 18** (usa `fetch` y `AbortSignal.timeout` nativos). Si tu app Heroku está en Node
18+ ya estás.

---

## ⚠️ Lo primero: el filesystem de Heroku es efímero

El Scheduler corre un **one-off dyno** que se destruye al terminar. Todo lo que el script escriba en
disco **se pierde**. Un `fs.writeFileSync('rates.json')` en Heroku no persiste nada.

Por eso `shoppre-scraper.js` está hecho como **módulo que devuelve la data**, sin decidir dónde se
guarda. Vos la enchufás a donde ya persistas cosas.

---

## Uso desde tu script existente

```js
const { scrapeRates, diffRates, summarizeDiff } = require('./scripts/shoppre-scraper');

async function actualizarTarifas() {
  // Lanza si algún peso falla: nunca devuelve datos parciales.
  const data = await scrapeRates();          // 211 pesos, 1.0 → 22.0 kg, paso 0.1, USA
  console.log(`Shoppre: ${data.rates.length} pesos OK`);

  const previo = await traerUltimoDeTuDB(); // el `rates` de la corrida anterior, o null
  const diff = diffRates(previo, data.rates);
  console.log(summarizeDiff(diff));

  if (diff.total === 0) return;              // nada cambió, no ensuciamos la DB
  await guardarEnTuDB(data);
}
```

### API del módulo

| Función | Qué hace |
|---|---|
| `scrapeRates(opts?)` | Trae todo el rango. Devuelve el dataset. **Lanza** si algún peso falla. |
| `diffRates(oldRates, newRates)` | Compara dos corridas → `{ changed, added, removed, total }` |
| `summarizeDiff(diff)` | Resumen legible para logs / notificaciones |

Opciones de `scrapeRates` (todas opcionales):

```js
await scrapeRates({
  country: 226,       // id de país de Shoppre (226 = United States)
  from: 1.0, to: 22.0, step: 0.1,
  length: 0.5, width: 0.5, height: 0.5,   // cm
  concurrency: 3,     // requests en paralelo
  delay: 100,         // ms entre requests (cortesía con el server)
  retries: 4,
  timeout: 20000,     // ms por request
  onProgress: (hechos, total) => {},
});
```

Con los defaults tarda **~30–40 segundos** (211 requests, 3 en paralelo, 100 ms de pausa).

---

## Dónde guardar la data

### Opción A — Heroku Postgres (recomendada si ya la tenés)

Una tabla append-only te da historial de precios gratis:

```sql
CREATE TABLE shoppre_rates (
  id           BIGSERIAL PRIMARY KEY,
  scraped_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  country_id   INT NOT NULL,
  payload      JSONB NOT NULL
);
CREATE INDEX ON shoppre_rates (country_id, scraped_at DESC);
```

```js
const { rows } = await pg.query(
  'SELECT payload FROM shoppre_rates WHERE country_id = $1 ORDER BY scraped_at DESC LIMIT 1',
  [226]
);
const previo = rows[0]?.payload?.rates ?? null;

const data = await scrapeRates();
if (diffRates(previo, data.rates).total > 0) {
  await pg.query(
    'INSERT INTO shoppre_rates (country_id, payload) VALUES ($1, $2)',
    [data.destination_country_id, data]
  );
}
```

Consultar un precio puntual después:

```sql
SELECT c->>'carrier', c->>'basic_price_usd'
FROM shoppre_rates s,
     jsonb_array_elements(s.payload->'rates') r,
     jsonb_array_elements(r->'carriers') c
WHERE s.id = (SELECT max(id) FROM shoppre_rates WHERE country_id = 226)
  AND (r->>'weight_kg')::numeric = 10.5;
```

### Opción B — S3 / Cloudflare R2

Subí el JSON con la fecha en la key (`shoppre/2026-08-03.json`) más un `latest.json`. Requiere el SDK
de AWS como dependencia.

### Opción C — commitear al repo vía API de GitHub

Te deja el historial en git, pero necesitás un token con permiso de escritura como config var. Más
frágil que Postgres; solo si querés los diffs en el repo.

---

## Configurar el Scheduler

```bash
heroku addons:create scheduler:standard -a TU-APP
heroku addons:open scheduler -a TU-APP
```

En el panel, agregá un job:

| Campo | Valor |
|---|---|
| Command | `node scripts/tu-script.js` |
| Dyno size | `Basic` (alcanza de sobra) |
| Frequency | **Daily** |

**Diario es más que suficiente.** Las tarifas de flete se mueven cada semanas o meses, no cada hora.
Correr cada 10 minutos serían ~30.000 requests por día contra un endpoint ajeno — te van a bloquear y
no ganás nada.

Si querés control de horario, `scheduler:standard` solo ofrece cada 10 min / hora / día. Para un cron
real (`0 6 * * 1`) usá el add-on **Advanced Scheduler**.

---

## Manejo de errores

`scrapeRates()` **lanza** si algún peso falla tras los reintentos, con `err.failures` (array de
mensajes). Es a propósito: un dataset incompleto es peor que ninguno, porque una tarifa faltante no se
distingue de una baja de precio y te corrompe el historial.

Para que Heroku registre la falla, dejá que el proceso salga con código distinto de cero:

```js
actualizarTarifas().catch((err) => {
  console.error(`FALLO: ${err.message}`);
  for (const f of err.failures ?? []) console.error(`  - ${f}`);
  process.exit(1);   // Heroku lo marca como failed; enganchalo a tu alerting
});
```

Si ya tenés Sentry/Rollbar en la app, reportá ahí antes del `exit(1)`.

---

## Probarlo local antes de deployar

```bash
node shoppre-scraper.js --from 1 --to 2 --step 0.5 --stdout   # prueba rápida, 3 pesos
node shoppre-scraper.js --out rates.json                      # corrida completa a archivo
```

Flags del CLI: `--country --from --to --step --dims LxWxH --concurrency --delay --out --stdout`.
El CLI escribe a disco solo para probar local — **en Heroku no lo uses**, usá el módulo.

---

## Dos cosas a tener en cuenta

**La API no es pública ni documentada.** La descubrí mirando el tráfico de red del calculador. Hoy no
pide auth ni cookies, pero Shoppre puede cambiarla o cerrarla sin aviso. Si empieza a fallar seguido,
volvé a abrir el calculador en el navegador y revisá qué request hace ahora. Si algún día la ponen
detrás de login o Cloudflare, ahí sí haría falta Playwright.

**El precio depende del peso facturable, no del real.** Los defaults usan una caja de 0.5 × 0.5 × 0.5 cm
para que el peso volumétrico sea ~0 y manda el peso real — así el dataset es una tabla limpia de
precio por kilo facturable. Si querés modelar cajas reales, pasá `--dims` o las opciones
`length/width/height`.