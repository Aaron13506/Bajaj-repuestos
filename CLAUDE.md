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

# 99rpm prices + discontinued flags (dry by default — `--apply` writes)
pnpm scrape:99rpm --out=<file>.json   # crawl (writes only data/scrape/, never the DB)
pnpm prices:99rpm --file=<file>.json  # report what would change
pnpm prices:99rpm --file=<file>.json --apply [--skip=SKU,SKU]

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

- **Product** — a part or an assembly (`isAssembly: true`). Stores India source price (`priceInr`), weight/dimensions for shipping cost, and a sale `price`. `discontinuedAt` marks a part Bajaj **stopped manufacturing**: it is a fact of the factory, not of a supplier, so it lives here and not on `SupplierPrice` — a price loaded before the SKU died does not make it buyable again. Consequently it is a **hard block on both sides**: the maritime builder refuses it (client *and* in `sincronizarLineas`, because a line can be marked after it was loaded) and the quote builder refuses it too, since the business is *por encargo* — quoting one promises a client a part nobody can source, with a deposit already taken. Selling remaining `stock` is still fine: discontinued means you cannot *restock*, not that what you hold is unsellable. The date records when we found out, which is what lets you re-read an old quote without concluding it promised the impossible.
- **ProductComponent** — many-to-many self-join on `Product`. One parent can have many children, grouped by `groupName` and ordered by `sortOrder`. The unique constraint is `(parentId, childId, groupName)` — the same child can appear in multiple groups of the same parent.
- **Config** — key-value table for runtime settings (exchange rates, shipping parameters). Read at render time and passed to `calcLanded`.
- **Supplier / SupplierPrice** — alternative sources. `Supplier.origen` (`india` | `china`) is a fixed fact about the supplier and determines the physical route of anything bought from it. A `SupplierPrice` row is the signal that a SKU *can* be sourced from that supplier; `isLanded` means they quote delivered in Venezuela (never inferred from the amount — only set explicitly). `moq` is that supplier's **minimum order quantity** for that SKU — a floor, not a multiple (min 5 forbids 3 but allows 7): `priceUsd` stays **per piece** and the MOQ raises the *quantity* you are forced to buy, never the unit price (`null` = they don't declare it, which is not the same as 1). Both live on the (product, supplier) pair, so neither touches 99rpm's base price nor the air lane — they only describe what buying a shipment from that supplier really costs.
- **Pedido / PedidoItem** — the commercial document. **`PedidoItem` is the unit of purchase and logistics**, not `Pedido`: a budget is routinely bought in parts (some pieces in India, others in China, at different times, travelling in different boxes). Each item carries `envioId`, `shippingStatus`, `supplierId`, `origen`, `isLanded`, `costRealUsd`, `compradoAt`. The order's state is **derived** from its items via `stageSummary` — never stored.
- **Envio** — one physical box crossing to Venezuela, and **the route is chosen when it is created** (`Envio.modo`, never changed afterwards). The route decides both how the box is costed and what can go inside it, because the two lanes barely intersect:
  - **`aereo`** — the *commercial* lane. Carries `PedidoItem` (client orders, and own stock bought through Shoppre): things somebody is waiting for. India and China both consolidate in the USA, so one box can carry items of both origins; `inboundChinaUsd` holds the real China→USA freight bill (ShipGlobal's step table only applies to India). Born `confirmado` — its lines already exist.
  - **`maritimo_cbm`** — the *stocking* lane. Carries `EnvioLinea` (own merchandise), born `borrador` and filled piece by piece until closed.
- **EnvioLinea** — a line of **own merchandise** in a shipment: product and quantity, nothing else. Deliberately not a `PedidoItem`: that one is a *commercial* line with a sale price, a client behind it and sometimes a deposit collected. Stock brought for myself was promised to nobody, so there is no price to freeze — when it lands, its sale price comes from the catalog like any other part. Forcing it through `Pedido` meant inventing a client and a price, and that price went stale the moment a tariff moved.

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

### CBM costing (`lib/cbm.ts`)

`resumirCbm(lineas, lookup, cfg, opts)` costs a set of lines by volume, expanding bundles into their real pieces: volume, weight, density, product cost, freight, prorated FOB, landed — plus the count of **unmeasured** pieces, which is what makes the displayed volume a floor rather than the real figure.

Rules this module fixes:
- **It does not apply the billable minimum.** Per piece, freight is linear (`m³ × rate`) plus the share of the FOB over `cbm_referencia_m3`. The sum equals `calcLanded` in CBM mode exactly (verified against `volume × cbmCostPerM3`), which is what the catalog's sea column shows.
- **The shipment does apply it** (`costoEmbarque`): there landed is `product cost + billable freight + FOB`, minimum included. That is why a half-empty box shows an absurd cost per m³ — it is the signal to consolidate, and prorating freight per piece would hide it.
- `CBM_MAX_KG_PER_M3` (1000 kg/m³) is the density ceiling above which the carrier may bill by weight; it warns, it does not recompute.

**There is no global mode switch.** There was one, and it was the wrong abstraction: it forced you to remember to flip it, and it gave the same fact two sources of truth — a screen that only makes sense by sea had to warn "the active mode is air". The route is a property of each `Envio`. The catalog shows **both** landeds side by side (`lib/cost-columns.ts`), because "air or sea?" is a sourcing question you ask constantly, and having both on screen *is* the answer.

**Sale prices always come from the air lane.** `Product.price`, `applyMeasures` and the quote builder all cost with `'aereo'`, because that is the route client orders travel. The sea landed is for deciding where to stock up, never for pricing what you sell — mixing them puts two cost models in the same subtraction.

### Refreshing 99rpm prices (`scripts/update-prices-99rpm.ts` · `lib/reprice.ts`)

Reads a scrape file and writes **only what 99rpm is the authority on**: `priceInr`, `discontinuedAt`, and whatever the cost derives (`price`/`margin`/`landedCostUsd`). It deliberately bypasses `seed-scraped` and `materialize-catalog` — those exist to *incorporate* a catalog (they create products, rebuild sub-groups, relink components, push images to S3), and a price run must not create parts you never chose or disturb the weights and dimensions that were expensive to load.

It is **dry by default**; `--apply` writes. Three guards, because a scrape is not automatically right: a scraped price of `0` is a failed read and never overwrites a good one; a variation above `--max-delta` (300%) is set aside rather than applied, since that pattern is usually a SKU 99rpm reassigned to a different part; and the report prints the catalog name beside the scraped one, because the real hazard is a **hand-curated entry whose unit differs** — a `Filtro aceite (x1)` against 99rpm's pack price is not a price change. `--skip=SKU,SKU` is the escape hatch for those.

`lib/reprice.ts` holds the money rule shared with `applyMeasures`: sale price always via the **air** chain, and `priceLocked` inverts the calculation — without the lock the price derives from the cost, with it the cost derives the *margin* and the price is never touched.

### Loading weight and dimensions (`lib/measures.ts` · `components/MedidasIA.tsx`)

By sea the **volume is what is billed**, so a part without dimensions cannot be costed at all — weight and dimensions are therefore always loaded together. `applyMeasures` parses the AI response (tolerating reasoning and sources around the JSON block), matches by `id` or `bajajCode`, and recomputes the sale price with the air chain (see above).

`MedidasIA` is the one loader UI, used from the assembly detail, the quote and the maritime shipment. The batch size is the design decision: **one assembly at a time**. Part-by-part is unusable with 30-SKU quotes; the whole quote at once degrades the AI's answer exactly where auditing costs the most. `MEASURES_PROMPT` (`lib/prompts.ts`) is the single copy of the research prompt — duplicating it would let the catalog fill with non-comparable data.

### Pages

| Route | Purpose |
|---|---|
| `/products` | List all products with stock and price |
| `/products/new` | Create product; optional `?parentId=` pre-links to an assembly |
| `/products/[id]` | Detail: cost breakdown, component list, assembly membership |
| `/products/[id]/edit` | Edit product fields |
| `/groups` | List assemblies with their component sub-groups |
| `/envios` | Both lanes, labelled. Creating asks for the **route first** — that is the decision that shapes everything downstream |
| `/envios/[id]` | Branches on the route. Air: assign **orders**, split India/China legs, advance the box. Sea (`maritimo.tsx`): fill it piece by piece while `borrador`, watch the m³ against the billable minimum, then close it |
| `/presupuestos/[id]` | Quote detail (commercial, air) + the per-assembly measures loader |
| `/simular` | Weight-and-volume calculator for the **air** lane |
| `/products/discontinued` | Bulk-mark parts as discontinued by pasting Bajaj codes (matched through the alternate SKU too), plus the list of what is currently marked. Bulk-only on purpose: the data arrives dozens at a time — 99rpm labels a whole exploded view — never one part at a time |
| `/suppliers` | Suppliers and their `origen` — the one manual setup step, done once per supplier |
| `/config` | Edit all `Config` key-value settings |

### API routes

`app/api/products/` and `app/api/products/[id]/` expose a JSON CRUD API (used separately from the UI Server Actions). `app/api/health/` returns a simple status check.
