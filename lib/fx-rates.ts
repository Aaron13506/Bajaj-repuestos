export interface FxRates {
  inrUsd: number
  bsdUsd: number
}

// `fetch` no tiene timeout propio: si el otro lado acepta la conexión y después se queda
// callado, la promesa no resuelve nunca. Esto lo corre el cron horario de Heroku, así que
// sin corte el dyno se queda colgado esperando a una API de terceros hasta que Heroku lo
// mata — y encima sin dejar dicho cuál de las dos fue.
const TIMEOUT_MS = 15_000

// INR por 1 USD — frankfurter.app (tasas BCE, gratis, sin API key).
async function fetchInrUsd(): Promise<number> {
  const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=INR', {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`frankfurter.app respondió ${res.status}`)
  const data = (await res.json()) as { rates?: { INR?: number } }
  const rate = data.rates?.INR
  if (!rate || !Number.isFinite(rate)) throw new Error('frankfurter.app no devolvió una tasa INR válida')
  return rate
}

// BsD por 1 USD — promedio compra/venta del P2P de Binance (USDT≈USD) vía alcambio.app.
async function fetchBsdUsd(): Promise<number> {
  const res = await fetch('https://api.alcambio.app/graphql', {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operationName: 'getBinanceP2PAverages',
      variables: {},
      query: `query getBinanceP2PAverages {
        getBinanceP2PAverages {
          sellAverage
          buyAverage
        }
      }`,
    }),
  })
  if (!res.ok) throw new Error(`alcambio.app respondió ${res.status}`)
  const json = (await res.json()) as {
    data?: { getBinanceP2PAverages?: { sellAverage?: number; buyAverage?: number } }
  }
  const avg = json.data?.getBinanceP2PAverages
  if (!avg || !Number.isFinite(avg.sellAverage) || !Number.isFinite(avg.buyAverage)) {
    throw new Error('alcambio.app no devolvió promedios P2P válidos')
  }
  return (avg.sellAverage! + avg.buyAverage!) / 2
}

export async function fetchFxRates(): Promise<FxRates> {
  const [inrUsd, bsdUsd] = await Promise.all([fetchInrUsd(), fetchBsdUsd()])
  return { inrUsd, bsdUsd }
}
