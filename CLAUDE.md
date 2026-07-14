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
- **Envio / Pedido / PedidoItem** — shipping batch and order models (defined in schema, UI not yet fully built out).

### Cost calculation (`lib/calc.ts`)

`calcLanded(product, cfg)` computes a full landed-cost breakdown for the supply chain: **India → USA (Shoppre) → Venezuela (maritime)**. It pulls rates from `shipping_rates.json` via `lib/shipping-rates.ts` (step-function table keyed by carrier and weight). Config keys control all rates (INR/USD rate, BsD/USD rate, Shoppre membership, maritime cost per ft³, insurance %, processing fee). The landed cost is **product + Shoppre air shipping + insurance + processing + maritime** — no import duty (the maritime route is duty-free). Returns `null` if `priceInr` or `weightGrams` is missing.

### Pages

| Route | Purpose |
|---|---|
| `/products` | List all products with stock and price |
| `/products/new` | Create product; optional `?parentId=` pre-links to an assembly |
| `/products/[id]` | Detail: cost breakdown, component list, assembly membership |
| `/products/[id]/edit` | Edit product fields |
| `/groups` | List assemblies with their component sub-groups |
| `/config` | Edit all `Config` key-value settings |

### API routes

`app/api/products/` and `app/api/products/[id]/` expose a JSON CRUD API (used separately from the UI Server Actions). `app/api/health/` returns a simple status check.
