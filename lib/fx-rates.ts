// Lo que trajo cada fuente. Una que falla queda en undefined con su motivo en `errores`: las
// fuentes son independientes, y que se caiga una no puede congelar las otras.
export interface FxRates {
  inrUsd?: number
  bsdUsd?: number
  bcv?: { bcvUsd: number; brechaPct: number }
  errores: string[]
}

// `fetch` no tiene timeout propio: si el otro lado acepta la conexión y después se queda
// callado, la promesa no resuelve nunca. Esto lo corre el timer horario del servidor, así que
// sin corte la corrida se queda colgada esperando a una API de terceros — y sin dejar dicho
// cuál fue.
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

// Tasa oficial BCV y brecha contra el mejor precio paralelo — usdt.com.ve, API pública,
// sin autenticación. La brecha es lo que permite cobrar a la tasa oficial sin regalar la
// diferencia (ver calcPrecioBcv en lib/calc.ts): la tasa BCV sola convierte a un monto en
// Bs que vale menos dólares reales que el precio de lista.
async function fetchBcvGap(): Promise<{ bcvUsd: number; brechaPct: number }> {
  const res = await fetch('https://www.usdt.com.ve/api/v1/rates/current', {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`usdt.com.ve respondió ${res.status}`)
  const json = (await res.json()) as {
    success?: boolean
    data?: { bcv?: { rate?: number }; brecha_pct?: number }
  }
  const bcvUsd = json.data?.bcv?.rate
  const brechaPct = json.data?.brecha_pct
  if (!json.success || !bcvUsd || !Number.isFinite(bcvUsd) || !Number.isFinite(brechaPct)) {
    throw new Error('usdt.com.ve no devolvió tasa BCV / brecha válidas')
  }
  return { bcvUsd, brechaPct: brechaPct! }
}

export async function fetchFxRates(): Promise<FxRates> {
  const [inr, bsd, bcv] = await Promise.allSettled([fetchInrUsd(), fetchBsdUsd(), fetchBcvGap()])
  const errores = [inr, bsd, bcv].flatMap(r => (r.status === 'rejected' ? [String((r.reason as Error)?.message ?? r.reason)] : []))
  return {
    inrUsd: inr.status === 'fulfilled' ? inr.value : undefined,
    bsdUsd: bsd.status === 'fulfilled' ? bsd.value : undefined,
    bcv: bcv.status === 'fulfilled' ? bcv.value : undefined,
    errores,
  }
}
