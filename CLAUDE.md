# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
pnpm dev          # Start Next.js dev server
pnpm build        # Production build
pnpm lint         # ESLint via next lint

# Database
pnpm db:push      # Push schema changes without migration (dev)
pnpm db:migrate   # Create and apply a migration
pnpm db:generate  # Regenerate Prisma client after schema changes
pnpm db:studio    # Open Prisma Studio GUI
pnpm db:seed      # Run prisma/seed.ts

# Local database (Docker)
docker compose up -d    # Start PostgreSQL on port 5432
docker compose down     # Stop
```

## Environment

Copy `.env.example` to `.env`. Required variables:
- `DATABASE_URL` — PostgreSQL connection string
- `ADMIN_USER` / `ADMIN_PASSWORD` — HTTP Basic Auth credentials (defaults: `admin` / `admin123`)

## Architecture

**Stack:** Next.js 14 App Router · Prisma 5 (PostgreSQL) · Tailwind CSS · TypeScript · pnpm

**Auth:** `middleware.ts` enforces HTTP Basic Auth on every route (excluding Next.js static assets). Credentials come from env vars with insecure defaults.

**Routing:** All UI lives under the `app/(pages)/` route group. The layout in `app/(pages)/layout.tsx` wraps pages with the `Sidebar`. Pages are Server Components that query the DB directly via `lib/db.ts`.

**Data mutations:** Use Next.js Server Actions (files named `actions.ts` and `component-actions.ts`). No client-side fetch — forms post to server actions which call `revalidatePath` and often `redirect`.

**Database (`lib/db.ts`):** Singleton Prisma client attached to `globalThis` to survive hot-reloads in dev.

### Domain model

- **Product** — a part or an assembly (`isAssembly: true`). Stores India source price (`priceInr`), weight/dimensions for shipping cost, and a sale `price`.
- **ProductComponent** — many-to-many self-join on `Product`. One parent can have many children, grouped by `groupName` and ordered by `sortOrder`. The unique constraint is `(parentId, childId, groupName)` — the same child can appear in multiple groups of the same parent.
- **Config** — key-value table for runtime settings (exchange rates, shipping parameters). Read at render time and passed to `calcLanded`.
- **Supplier / SupplierPrice** — alternative sources. `Supplier.origen` (`india` | `china`) is a fixed fact about the supplier and determines the physical route of anything bought from it. A `SupplierPrice` row is the signal that a SKU *can* be sourced from that supplier; `isLanded` means they quote delivered in Venezuela (never inferred from the amount — only set explicitly).
- **Pedido / PedidoItem** — the commercial document. **`PedidoItem` is the unit of purchase and logistics**, not `Pedido`: a budget is routinely bought in parts (some pieces in India, others in China, at different times, travelling in different boxes). Each item carries `envioId`, `shippingStatus`, `supplierId`, `origen`, `isLanded`, `costRealUsd`, `compradoAt`. The order's state is **derived** from its items via `stageSummary` — never stored.
- **Envio** — one physical box crossing to Venezuela. India and China both consolidate in the USA, so a single box can carry items of both origins; `inboundChinaUsd` holds the real China→USA freight bill (ShipGlobal's step table only applies to India).

### Shipping routes (`lib/shipping-status.ts`)

`SHIPPING_STATUSES` is the canonical ordered pipeline. The three routes are **subsets of it in the same order**, so `statusIndex` stays comparable across routes:

| Route | Stages |
|---|---|
| `india` | pendiente → camino_shoppre → en_shoppre → camino_usa → en_usa → camino_venezuela → en_venezuela → entregado |
| `china` | pendiente → camino_usa → … (skips Shoppre) |
| `directo` | pendiente → en_venezuela → entregado (`isLanded`: never travels in the box) |

`routeFor(origen, isLanded)` picks the route; `nextStatus`/`prevStatus` take it and skip inapplicable stages; `normalizeToRoute` repairs an item left on a stage its route doesn't have.

### Cost calculation (`lib/calc.ts`)

`calcLanded(product, cfg)` computes a full landed-cost breakdown for the supply chain: **India → USA (Shoppre) → Venezuela (maritime)**. It pulls rates from `shipping_rates.json` via `lib/shipping-rates.ts` (step-function table keyed by carrier and weight). Config keys control all rates (INR/USD rate, BsD/USD rate, Shoppre membership, maritime cost per ft³, insurance %, processing fee). The landed cost is **product + Shoppre air shipping + insurance + processing + maritime** — no import duty (the maritime route is duty-free). Returns `null` if `priceInr` or `weightGrams` is missing.

`calcEnvio(items, cfg, opts)` costs a real box, and splits the inbound legs because they price differently: the **India** group pays ShipGlobal's step-function on *its own* chargeable weight, the **China** group splits `inboundChinaUsd` (the real invoice), and both share the maritime leg. Items with `isLanded` are excluded from weight, volume, insurance and freight entirely — they never travel in the box. Each leg is reported separately in `breakdown.air` / `breakdown.china`.

### Pages

| Route | Purpose |
|---|---|
| `/products` | List all products with stock and price |
| `/products/new` | Create product; optional `?parentId=` pre-links to an assembly |
| `/products/[id]` | Detail: cost breakdown, component list, assembly membership |
| `/products/[id]/edit` | Edit product fields |
| `/groups` | List assemblies with their component sub-groups |
| `/compras` | **Everything still to buy**, across all confirmed orders. Items with no `SupplierPrice` need no decision (99rpm/India, bulk-marked); items with alternatives show a landed-cost comparison. Marking as bought freezes supplier + origin + route |
| `/envios` · `/envios/[id]` | Boxes. The detail page assigns **items** (not orders), shows the India and China legs separately, and advances the whole consolidated box at once |
| `/suppliers` | Suppliers and their `origen` — the one manual setup step, done once per supplier |
| `/config` | Edit all `Config` key-value settings |

### API routes

`app/api/products/` and `app/api/products/[id]/` expose a JSON CRUD API (used separately from the UI Server Actions). `app/api/health/` returns a simple status check.
