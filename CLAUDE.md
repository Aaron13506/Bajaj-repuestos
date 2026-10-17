# CLAUDE.md

Motokira / Bajaj repuestos: a one-owner admin app for selling Bajaj motorcycle parts **por encargo** (quote → client deposit → buy in India/China → box to Venezuela → deliver). Thin margin (~30%), so costing to the cent is the point.

The detailed rules live in **project skills** (`.claude/skills/`), loaded only when the task needs them:

| Skill | Load it for |
|---|---|
| `costeo` | landed cost, air/sea freight, rate table, per-piece split, comparing suppliers or purchases |
| `envios` | boxes (air/sea), assigning orders, stages and routes, box weight, billed freight, commissions |
| `pedidos` | quotes/orders, the builder, editing confirmed or own orders, cancel, incidents, validity, deletion rules |
| `dinero` | ledger, collections, BCV dollars, Bs and conversion, purchases, sales from stock, margin, inventory |
| `catalogo` | parts, assemblies, suppliers and prices, weight/dimensions, discontinued, 99rpm price refresh |
| `deploy-y-esquema` | schema changes (`prisma/manual/*.sql`), deploying, production access, local DB |

## Commands

```bash
pnpm dev | build | lint | typecheck
pnpm check:costeo        # pure arithmetic and rules (no DB) — add a case when changing a rule
pnpm check:libro         # ledger vs caches, negative stock (reads the local DB)
pnpm check:etapas        # stage/stock SQL against the Docker DB (creates and deletes its rows)
pnpm q sku|quote|search|missing …   # weight, volume, landed of parts or lists (via calcEnvio)
pnpm measures:audit [--usadas]      # physical check of stored weights/dimensions
pnpm db:up | db:pull-prod           # local Postgres 17 copy of production on 127.0.0.1:5432
pnpm db:migrar [--probar|--aplicar|--drift] · pnpm db:generate · pnpm db:studio
pnpm deploy:prod [--migrar] [--dry] # push first; see the deploy-y-esquema skill
pnpm fx:update [--force-rates]      # rates + Shoppre table (hourly on the server)
pnpm scrape:99rpm · pnpm prices:99rpm --file=… [--apply]
```

## Environment

Copy `.env.example` to `.env`. `DATABASE_URL`/`DIRECT_URL` point at the local Docker copy; production is reachable only on purpose (server or SSH tunnel on `localhost:15432` — **with the tunnel open, writes hit production**). `ADMIN_USER`/`ADMIN_PASSWORD`: the `admin`/`admin123` fallback exists only with `APP_ENV=local`; elsewhere a missing value fails closed (503). `S3_*` + `S3_PUBLIC_BASE_URL`: the image bucket (`motokira-images`); `lib/s3-publico.ts` refuses to derive the public URL from the endpoint.

## Architecture

- Next.js 16 App Router · React 19 · Prisma 5 (PostgreSQL, driver adapter `pg`) · Tailwind · TypeScript · pnpm. This Next has breaking changes: check `node_modules/next/dist/docs/` before relying on memory.
- Auth: `proxy.ts` (Next 16's `middleware.ts`) enforces Basic Auth with a lockout; in production `oauth2-proxy` + Tailscale Funnel sit in front, so the lockout is one shared counter.
- UI under `app/(pages)/`; pages are Server Components querying `lib/db.ts` (singleton on `globalThis`). Mutations are Server Actions (`actions.ts`, `component-actions.ts`) that `revalidatePath` and often `redirect`; no client fetch. `app/api/health` is the only API route.

## Conventions that apply everywhere

- **Money is stored in real dollars.** BCV dollars are only how quotes are presented and charged (`dinero` skill).
- **Empty is never zero.** Empty means "not known yet"; an explicit `0` is a fact. An unreadable number is **rejected**, never saved as empty (empty replaces what was stored).
- **Rules are pure functions in `lib/`**, shared by the screen (which hides the button) and the action (the real lock), and checked by `pnpm check:costeo`.
- **Costs only through `lib/`** (`Config` + `calcEnvio`/`resumirCbm`/`quote-metrics`), never ad-hoc arithmetic or hardcoded rates.
- **Concurrency is guarded writes, not read-then-write**: `updateMany where <expected state>` / conditional `UPDATE` and act on the count; per-order work takes `bloquearPedido` first, then touches its movimientos.
- **Errors the user must read return `ActionResult`** (`lib/action-result.ts`): deep inside, throw `ErrorDeNegocio` and wrap with `conErrorDeNegocio` (a plain `throw` loses its text in production; a silent `return` looks like success). Clients: `FormConResultado` for a `<form action>`, `useEnviarAccion` / `useAccionDirecta` for hand-submitted panels and loose controls, `DeleteButton` and `PresupuestoBuilder` read it too. `app/(pages)/error.tsx` is only for the unexpected.
- **Default dates are local**: initial date values go through `CampoFecha` (server renders in UTC; from 20:00 Venezuela `toISOString()` is tomorrow). Months are cut in Venezuela time (UTC−4).
- Volume conversions only via `CM3_PER_FT3` / `CM3_PER_M3`.

## Domain in one line each

- **Product** — a part (never an assembly); price/cost via `reprice`, always the air lane.
- **Ensamble** — the 99rpm exploded view grouping parts; identity only, no price.
- **Supplier / SupplierPrice** — `origen` (where) and `inbound` (`shoppre` | `cotizado`: how the leg to the USA is priced); per-piece price, MOQ, explicit `isLanded`.
- **Pedido / PedidoItem** — the commercial document; the **line** is the unit of purchase and logistics; a line is a piece or a bundle.
- **Envio** — one physical box from one supplier; `aereo` carries order lines, `maritimo_cbm` carries `EnvioLinea` (own stock). Route and supplier frozen at creation.
- **Movimiento** — the ledger, the truth about money; `Pedido.depositUsd` is its cache.
- **Config** — key/value settings (rates, tariffs, margins), read at render and passed to the costing; `/config` validates ranges.

## Pages

`/` (dashboard) · `/products` (+ `new`, `[id]`, `[id]/edit`, `import`, `discontinued`) · `/groups` and `/ensambles/…` (assemblies) · `/suppliers` (+ `[id]/import`) · `/presupuestos` (+ `new`, `[id]`, `[id]/edit`, `[id]/comparar`, `[id]/proveedor`) · `/ventas` (+ `new`, `[id]`: sales from stock, apart from quotes) · `/envios` (+ `[id]`, which branches by route; `maritimo.tsx` for sea) · `/simular` (who to buy from / which route, nothing saved) · `/contabilidad` (+ `comprar`: register purchases) · `/resultados` (realised margin) · `/inventario` · `/clientes` (+ `[id]`) · `/config`.
