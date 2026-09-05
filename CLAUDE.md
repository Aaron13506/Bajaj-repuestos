# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
pnpm dev          # Start Next.js dev server
pnpm build        # Production build
pnpm lint         # ESLint via next lint

# Auditoría de peso y dimensiones ya cargadas (solo lee)
pnpm measures:audit            cobertura + chequeo físico, ordenado por piezas que se mueven
pnpm measures:audit --usadas   solo lo que aparece en un pedido o un embarque

# Aritmética del costeo de una caja (sin DB): tramos, cargos de Shoppre, comisiones de giro
pnpm check:costeo

# Catálogo — consulta de peso, medidas y volumen (sin levantar la app)
pnpm q sku <SKU...>            # ficha: peso, medidas, ft³/u, CBM/u, ₹, stock
pnpm q quote <SKU:qty>...      # totales de una lista: kg, volumétrico, ft³, CBM, landed
pnpm q quote --file=<ruta|->   # lo mismo desde JSON [{ sku, qty }] o stdin
pnpm q search <texto>          # buscar por nombre o SKU
pnpm q missing                 # piezas sin peso o sin medidas

# Precios externos (los corre el cron horario de Heroku: pnpm fx:update)
pnpm fx:update                 # tasas INR/USD + BsD/USD, y de paso las tarifas de flete
pnpm rates:update [--force]    # solo tarifas Shoppre → Config.shoppre_rates_usd
pnpm rates:baseline            # regenera shipping_rates.json (el fallback del bundle)

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
- **`Product.models`** (`MotoModel[]`) — the bikes a product fits. An assembly carries exactly one (that *is* its identity: two "Spark Plugs" groups differ only by bike); a loose part carries every bike that uses it, and **that is the cross-compatibility**: one brake pad serving the N250 and the N160 is a single row, not two. 59% of parts cover ≥2 bikes. Replaced a free-text `compatibleModels`, which let in strings that were not a model at all (`"Pulsar N250/N160"`) and inflated compatibility when counted. The legacy column is kept only as the backfill's backup — nothing reads it. **`lib/modelo.ts`** is the presentation table (family, variant, years) and the only translation between the stored enum and anything displayed; `lib/catalog.ts` asserts at compile time that its ids still match the Prisma enum, and exposes `whereModel()` for the `has` filter. Display goes through `formatModels`, which collapses by family — "N160 Single y Dual ABS", "N250 (todas)" — because thirteen full labels is 400 unreadable characters.
- **ProductComponent** — many-to-many self-join on `Product`. One parent can have many children, grouped by `groupName` and ordered by `sortOrder`. The unique constraint is `(parentId, childId, groupName)` — the same child can appear in multiple groups of the same parent.
- **Config** — key-value table for runtime settings (exchange rates, shipping parameters). Read at render time and passed to `calcLanded`.
- **Supplier / SupplierPrice** — alternative sources. Two independent axes describe a supplier, and they were **one field until Garuda Impex proved they were two**: `Supplier.origen` (`india` | `china`) says where the goods are, and `Supplier.inbound` (`shoppre` | `cotizado`) says how the leg to the USA is priced. They used to coincide — India meant Shoppre's step table, China meant a hand-loaded amount — so `origen` did both jobs. Garuda is Indian, quotes per piece in the same list as everyone else, and yet ships itself by India Post to the USA address for a flat DDP total: no per-kg rate to apply, and Shoppre's two stages never happen. `inbound` is therefore what decides the costing *and* the route; the country decides nothing. `lib/inbound.ts` is the single home of that vocabulary, including the rule that a Chinese supplier is always `cotizado` (that leg never had a table). A `cotizado` supplier is DDP by construction — it paid the export duties, so **nothing gets added on top**: no Shoppre insurance, no Shoppre processing. Charging them would invent a cost nobody bills and would make the cheaper lane look dearer.
  There is deliberately **no commission rule on the supplier**. A wire fee is not a trait of who you buy from: only some suppliers get wired at all, and the bank charges differently per transfer. A stored percentage would emit an invented number wearing the costume of a datum, and it would then flow into the landed cost that decides prices. The commission is *recorded* per shipment instead, as **two amounts** (`Envio.comisionSalienteUsd` / `comisionEntranteUsd`) — see the `Envio` entry. The cost of *not* having a rule is that supplier comparison (`compararProveedores`) can't price it in — correctly so: the number does not exist yet when you are choosing whom to buy from.
  `Supplier.origen` is a fixed fact about the supplier and determines the physical route of anything bought from it. A `SupplierPrice` row is the signal that a SKU *can* be sourced from that supplier; `isLanded` means they quote delivered in Venezuela (never inferred from the amount — only set explicitly). `moq` is that supplier's **minimum order quantity** for that SKU — a floor, not a multiple (min 5 forbids 3 but allows 7): `priceUsd` stays **per piece** and the MOQ raises the *quantity* you are forced to buy, never the unit price (`null` = they don't declare it, which is not the same as 1). Both live on the (product, supplier) pair, so neither touches 99rpm's base price nor the air lane — they only describe what buying a shipment from that supplier really costs.
- **Pedido / PedidoItem** — the commercial document. **`PedidoItem` is the unit of purchase and logistics**, not `Pedido`: a budget is routinely bought in parts (some pieces in India, others in China, at different times, travelling in different boxes). Each item carries `envioId`, `shippingStatus`, `supplierId`, `origen`, `isLanded`, `costRealUsd`, `compradoAt`. The order's state is **derived** from its items via `stageSummary` — never stored.
- **Envio** — one physical box crossing to Venezuela, bought from **one supplier**. Both the route (`Envio.modo`) and the supplier (`Envio.supplierId`) are chosen when it is created and never change afterwards.
  `supplierId` used to be maritime-only, back when anything flown was bought from 99rpm. That stopped being true: a Shoppre box and a Garuda box now travel in parallel, each with its own dispatch and its own invoice. **The box is the purchase**, so the supplier belongs to the box and lines inherit it on assignment (`asignarAEnvio`). Picking it per line allowed the impossible state of a Garuda box holding a line marked Shoppre — which also mis-costed silently, since that line went looking for a per-kilo rate its box does not have. `null` = 99rpm, the base ₹ price.
  Three amounts live on the box because nothing can derive them. **`tramoUsd`** is the total a `cotizado` supplier billed to carry it to the USA (it is `inboundChinaUsd` renamed — the same datum, but that name had assumed the only supplier without a rate table would ever be the Chinese one). The other two are the wire, and they are **two because an international transfer is charged at both ends**: `comisionSalienteUsd` is what my own bank deducts for sending it — known the same day, from the statement — and `comisionEntranteUsd` is what the correspondent and the supplier's bank take on arrival, which never shows on my statement at all: it shows up as the supplier saying he received less than he invoiced, and having to be topped up. Both are my cost and both enter the landed, summed. They were one column, and that forced you to invent the second in order to record the first — and here empty is not zero, so the invention went straight into the landed cost that sets sale prices.
  All three are nullable, and **empty never means zero**: a missing `tramoUsd` flags the shipment as **under-costed** rather than quietly flying those pieces for free, and a missing commission is "not recorded yet" while an explicit `0` is a finding ("that end charged nothing"). They add the same nothing to the total and only one means you are done — `giro.cargada` (both ends recorded) is the flag the screens use to say so, and it stays false on a half-recorded wire even though the recorded half is already costing. The sea lane reads the same columns and has the same form, so a commission is one concept and not four lookalike fields on two screens.
  The route decides how the box is costed and what can go inside it, because the two lanes barely intersect:
  - **`aereo`** — the *commercial* lane. Carries `PedidoItem` (client orders, and own stock): things somebody is waiting for. **How the leg to the USA prices is decided by the box's supplier**: a `shoppre` box pays one ShipGlobal step-table lookup on its chargeable weight (which is why piling kilos into one box gets cheaper), a `cotizado` box pays the flat total its supplier invoiced. Born `confirmado` — its lines already exist.
  - **`maritimo_cbm`** — the *stocking* lane. Carries `EnvioLinea` (own merchandise), born `borrador` and filled piece by piece until closed.

  `pesoRealKg` + `cajaL/A/H` are **the box as the carrier weighed and measured it**, and when they are loaded they **replace** the summed pieces — they do not correct them and nothing gets multiplied. What gets billed is what the scale read. They exist because even with every part stored packed (see below), a sum cannot know the outer carton or the void left between irregular parts, so it stays a **floor that can only come out low**: against the first real box (Shoppre 64898) the sum fell 3 kg and 27 000 cm³ short, paid twice over — a costlier ShipGlobal step *and* 56% more ft³ on the Miami→CCS leg.
- **EnvioLinea** — a line of **own merchandise** in a shipment: product and quantity, nothing else. Deliberately not a `PedidoItem`: that one is a *commercial* line with a sale price, a client behind it and sometimes a deposit collected. Stock brought for myself was promised to nobody, so there is no price to freeze — when it lands, its sale price comes from the catalog like any other part. Forcing it through `Pedido` meant inventing a client and a price, and that price went stale the moment a tariff moved.

### Shipping routes (`lib/shipping-status.ts`)

`SHIPPING_STATUSES` is the canonical ordered pipeline. The three routes are **subsets of it in the same order**, so `statusIndex` stays comparable across routes:

| Route | Stages |
|---|---|
| `shoppre` | pendiente → camino_shoppre → en_shoppre → camino_usa → en_usa → camino_venezuela → en_venezuela → entregado |
| `cotizado` | pendiente → camino_usa → … (skips Shoppre) |
| `landed` | pendiente → en_venezuela → entregado (`isLanded`: never travels in the box) |

What separates the first two is **not the country** but whether the goods pass through Shoppre's warehouse. They were named `india`/`china` while that coincided; Garuda broke it — Indian, shipping straight to the USA — and leaving Shoppre's two stages on its route promised a status that would never arrive. `routeFor(inbound, isLanded)` picks the route; `nextStatus`/`prevStatus` take it and skip inapplicable stages; `normalizeToRoute` repairs an item left on a stage its route doesn't have. `PedidoItem.inbound` is the snapshot that keeps a bought line on the route it was bought with, even if the supplier later changes how it ships.

### Cost calculation (`lib/calc.ts`)

`calcLanded(product, cfg)` computes a full landed-cost breakdown for the supply chain: **India → USA (Shoppre) → Venezuela (maritime)**. It pulls the air rate from `lib/shipping-rates.ts` (step-function table keyed by carrier and weight), **quoted in USD** — Shoppre's own API returns the converted price, so the air leg never passes through `inr_usd_rate`. Storing it in rupees made the freight cost move every time the rupee moved, even when Shoppre hadn't touched its tariff. `inr_usd_rate` still applies to what actually *is* in rupees: `priceInr` and `shoppre_processing_inr`. Config keys control all rates (INR/USD rate, BsD/USD rate, Shoppre membership, maritime cost per ft³, insurance %, processing fee). The landed cost is **product + Shoppre air shipping + insurance + processing + maritime** — no import duty (the maritime route is duty-free). Returns `null` if `priceInr` or `weightGrams` is missing.

`calcEnvio(items, cfg, opts)` costs a real box, and **prices the inbound leg by how it is billed, not by country**: the `shoppre` side pays one ShipGlobal step-function lookup on its chargeable weight (`breakdown.air`), the `cotizado` side splits the flat total its supplier invoiced (`breakdown.tramo`, with `faltaCosto` when the number hasn't been loaded). Both then pay the maritime leg, which Garuda changes not at all. Items with `isLanded` are excluded from weight, volume, insurance and freight entirely — they never travel in the box.

The split is still computed **per line** rather than per box even though a box has one supplier, because each `PedidoItem` keeps its own snapshot: an old box, assembled before the supplier belonged to the box, can hold both kinds and must still cost correctly.

Charges attach to what generated them, never to the whole box — spreading them is what would wreck the per-piece landed, the number used to decide which supplier to buy a SKU from:
- **Shoppre insurance and processing** fall only on `shoppre` lines. A DDP supplier declares nothing to Shoppre.
- **The quoted leg** falls only on the `cotizado` lines.
- **The wire commissions** (outgoing + incoming, summed) fall on the box's lines prorated by product cost, `isLanded` included — they never travel, but they rode the same transfer. They are never computed; they are the amounts recorded on `Envio.comisionSalienteUsd` / `comisionEntranteUsd`.

`breakdown.giro` describes the transfer to the box's supplier **whether or not a commission was recorded**, because `montoUsd` (merchandise + the quoted leg — one invoice, one transfer) is useful on its own: it is the base the bank will charge on, and the thing to look at before writing down what it cost.

`pnpm check:costeo` verifies all of that arithmetic without touching the database: the totals stay plausible when this attribution breaks, so only the per-piece figures give it away.

`opts.medidas` is the real box (`Envio.pesoRealKg` + `cajaL/A/H`), and it **replaces** the summed totals rather than scaling them: the chargeable weight *is* 18.6 kg because that is what the scale said, and the billed volume *is* the carton's. There is deliberately **no packing factor anywhere** — a multiplier on top of the data would be a second, invented model of something the data itself should carry (parts are stored packed) or the scale already knows. The only ratio in play is `escala`, which splits a weighed box between the India and China legs in proportion to the pieces each contributed; with one origin — the normal case — it is exact. Per-line values (`lines[].realKg`, `.ft3`) stay as the catalog has them, since the proration is by share and comes out the same either way, and `netRealKg` / `netVolKg` / `netFt3` / `netVolumeM3` report the summed totals beside the billed ones. `breakdown.caja.medido` is `false` when nothing was weighed, and that is the flag every screen uses to say the number is a floor.

### CBM costing (`lib/cbm.ts`)

`resumirCbm(lineas, lookup, cfg, opts)` costs a set of lines by volume, expanding bundles into their real pieces: volume, weight, density, product cost, freight, prorated FOB, landed — plus the count of **unmeasured** pieces, which is what makes the displayed volume a floor rather than the real figure.

Rules this module fixes:
- **It does not apply the billable minimum.** Per piece, freight is linear (`m³ × rate`) plus the share of the FOB over `cbm_referencia_m3`. The sum equals `calcLanded` in CBM mode exactly (verified against `volume × cbmCostPerM3`), which is what the catalog's sea column shows.
- **The shipment does apply it** (`costoEmbarque`): there landed is `product cost + billable freight + FOB + wire commission`, minimum included. The commission is the same pair of recorded amounts the air lane uses, read from the same two columns, and the maritime screen now has its own form to record them — it displayed them before but had nowhere to load them, so a sea box read "sin cargar" forever while the cost was real. What `costoEmbarque` does compute is `giroUsd` — merchandise **+ FOB**, since the FOB is what the *supplier* charges to release the cargo while the per-m³ freight goes to the carrier. Getting that base wrong is getting the cost wrong, so it lives in `lib/` rather than in the page. That is why a half-empty box shows an absurd cost per m³ — it is the signal to consolidate, and prorating freight per piece would hide it.
- `CBM_MAX_KG_PER_M3` (1000 kg/m³) is the density ceiling above which the carrier may bill by weight; it warns, it does not recompute.

**There is no global mode switch.** There was one, and it was the wrong abstraction: it forced you to remember to flip it, and it gave the same fact two sources of truth — a screen that only makes sense by sea had to warn "the active mode is air". The route is a property of each `Envio`. The catalog shows **both** landeds side by side (`lib/cost-columns.ts`), because "air or sea?" is a sourcing question you ask constantly, and having both on screen *is* the answer.

**Sale prices always come from the air lane.** `Product.price`, `applyMeasures` and the quote builder all cost with `'aereo'`, because that is the route client orders travel. The sea landed is for deciding where to stock up, never for pricing what you sell — mixing them puts two cost models in the same subtraction.

### Comparing a purchase before making it (`lib/comparar-compra.ts` · `lib/lista-skus.ts`)

`compararCompra(piezas, proveedores, precios, cfg, montos)` costs the **same list of SKUs** once per supplier on the air lane and sorts by landed. It is the twin of `compararProveedores`, and they are two modules on purpose: that one compares a *sea shipment* (volume × rate, plus a fixed FOB per box), this one compares a *purchase that will fly*, where the leg to the USA is decided by the supplier's `inbound` — a Shoppre box pays one ShipGlobal step lookup plus insurance and processing, a `cotizado` box pays the flat total it invoiced and nothing on top. From the USA the two pay the same maritime leg, so the difference between two options is exactly what changes.

Everything goes through `calcEnvio`. A comparison with its own arithmetic would pick a supplier using a number the real shipment never shows — and the decision is made here but paid there. The module is **pure** so it recomputes in the browser on every keystroke: the rates and the supplier's two amounts get moved by hand while reading the table, which is the normal use, not an edge case.

What the screen exists to produce is not the total but the **ceiling** (`tramoTopeUsd`): how much a supplier that dispatches itself can charge for the leg to the USA before it stops being worth it. That is the useful number, because while comparing you don't have its freight quote yet — you have its price list. It is `landedReferencia − landedSinTramo`, and that subtraction holds only while nothing else depends on the leg; `pnpm check:costeo` asserts it by loading the ceiling back in and checking the two options tie exactly, because a broken ceiling still comes out plausible.

Three things the table refuses to hide, since each one makes a supplier look cheaper than it is:
- **Coverage.** A supplier quoting 3 of 20 pieces looks cheap because the other 17 fall to 99rpm's base price. Without it the winner is whoever quotes least.
- **MOQ.** The minimum raises the *quantity* (never the unit price), and with it the box's volume and its freight. Applied by default, with the extra units named.
- **Pieces with no price at all.** They enter as $0, which makes the total wrong, not merely short.

**The basket comes in through two doors and out through one.** An existing `Pedido` (`cargarPedido`, which expands bundles to their real pieces — a supplier does not quote "the clutch kit", it quotes each part) or a pasted list; below that, nothing in the costing, the warnings or the table knows which it was. The quote door is the one that was missing: without it, asking "is this quote cheaper from Garuda than the usual 99rpm run?" meant transcribing its twenty codes into a textarea, and a transcription is a second source of the same datum — exactly what this screen exists not to have.

**The pasted list carries only SKU and quantity.** The per-piece price comes from `SupplierPrice` — which is exactly what is being put to the test: a price transcribed into the list too would give the same number two sources, and the comparison would end up measuring which one was typed better. `parseListaSkus` tolerates a fenced JSON block, `{items:[…]}`, and falls back to reading plain text a code per line; it drops the freight, tax and total rows a quote mixes in with the merchandise, which would otherwise enter the box as a piece with no weight and no price. `LISTA_SKU_PROMPT` (`lib/prompts.ts`) turns a supplier's PDF, photo or spreadsheet into that JSON and names the trap that matters: the quantity wanted is not the "Set Qty" package minimum, which already lives in `SupplierPrice.moq`.

Resolution crosses the **alternate SKU** (`lib/alt-sku.ts`), because the list comes from the supplier's own quote and each supplier uses one of the two numbers Bajaj publishes — a miss there reads as "not in the catalog" at the exact moment one would load it again.

### Refreshing 99rpm prices (`scripts/update-prices-99rpm.ts` · `lib/reprice.ts`)

Reads a scrape file and writes **only what 99rpm is the authority on**: `priceInr`, `discontinuedAt`, and whatever the cost derives (`price`/`margin`/`landedCostUsd`). It deliberately bypasses `seed-scraped` and `materialize-catalog` — those exist to *incorporate* a catalog (they create products, rebuild sub-groups, relink components, push images to S3), and a price run must not create parts you never chose or disturb the weights and dimensions that were expensive to load.

It is **dry by default**; `--apply` writes. Three guards, because a scrape is not automatically right: a scraped price of `0` is a failed read and never overwrites a good one; a variation above `--max-delta` (300%) is set aside rather than applied, since that pattern is usually a SKU 99rpm reassigned to a different part; and the report prints the catalog name beside the scraped one, because the real hazard is a **hand-curated entry whose unit differs** — a `Filtro aceite (x1)` against 99rpm's pack price is not a price change. `--skip=SKU,SKU` is the escape hatch for those.

`lib/reprice.ts` holds the money rule shared with `applyMeasures`: sale price always via the **air** chain, and `priceLocked` inverts the calculation — without the lock the price derives from the cost, with it the cost derives the *margin* and the price is never touched.

### Loading weight and dimensions (`lib/measures.ts` · `components/MedidasIA.tsx`)

**All four numbers describe the *bundle*, not the bare part**: the piece plus the box or bag it ships in. The carrier weighs and measures what leaves the warehouse, so a bare-part figure is a number that never gets billed and always comes out low — the first real box weighed 18.6 kg against 15.6 summed, and that difference is paid in freight and taken out of the margin. The correction belongs in the datum, loaded once and checkable, not in a multiplier applied afterwards on top of a figure known to be wrong. `MEASURES_PROMPT` therefore asks for the shipping weight (and, when only the bare weight is published, for the carton to be computed from its own surface and added, with the arithmetic shown).

By sea the **volume is what is billed**, so a part without dimensions cannot be costed at all — weight and dimensions are therefore always loaded together. `applyMeasures` parses the AI response (tolerating reasoning and sources around the JSON block, via `lib/json-ia.ts` — a module of its own so a pure parser doesn't drag in the DB client), matches by `id` or `bajajCode`, and recomputes the sale price with the air chain (see above).

**`lib/measures-check.ts` is the gate, and it exists because the prompt asked while the code accepted.** `MEASURES_PROMPT` has always demanded an implicit-density check; nothing verified it, so a spoiler loaded at **1 gram** went into the catalog, got costed, priced and sold, and no screen noticed — everything else about the row was consistent. `chequearMedidas` runs on the **merged** row (a patch carrying only weight is judged against the dimensions already stored, since that combination is what will do the costing) and refuses to write the physically impossible: implicit density above 8 g/cm³ (denser than solid steel) or below 0.02 (lighter than styrofoam), and any field at zero. Everything else is a *warning* that still writes — thresholds sit at the tail of the catalog's real distribution (median 0.44, p95 4.0), not at "unusual", because a flag that fires on 10% of rows is a flag nobody reads. `pnpm measures:audit` runs the same checks over what is already stored, ordered by units that actually moved: a bad number on a part nobody bought costs nothing, the same number on a part that flew was paid in freight and passed into a sale price.

`MedidasIA` is the one loader UI, used from the assembly detail, the quote and the maritime shipment. The batch size is the design decision: **one assembly at a time**. Part-by-part is unusable with 30-SKU quotes; the whole quote at once degrades the AI's answer exactly where auditing costs the most. `MEASURES_PROMPT` (`lib/prompts.ts`) is the single copy of the research prompt — duplicating it would let the catalog fill with non-comparable data.
`CM3_PER_FT3` is the single conversion constant — the maritime leg quotes per ft³ but part dimensions are stored in cm, so every volume conversion goes through it. Never re-derive it inline.

**Where the rate table lives (`lib/shipping-rates.ts`):** the live table is `Config.shoppre_rates_usd`, refreshed by the hourly Heroku cron (`pnpm fx:update` → `scripts/update-shipping-rates.ts` → `scripts/shoppre-scraper.js`); Heroku's filesystem is ephemeral, so it can't be a file, and `Config` is the channel that already reaches `calcLanded`/`calcEnvio` through `cfg`. `shipping_rates.json` is the **bundled fallback** for when that key is missing or corrupt — regenerate with `pnpm rates:baseline`. Both use the same shape: `[maxKg, basicUsd]` steps per carrier, since the tariff *is* a step function (216 scraped weights collapse to 144 steps, ~1.9 KB — it ships in the payload of every page that costs something). The member price is derived, not stored: a fixed 5% Shoppre applies client-side. The scraper covers 0.5 → 22 kg, and **22 kg is the carrier's cap per box, not where the scrape stopped** — so past it there is no dearer step, there is a second box. `cotizarTramoAereo` is the only door into the table for that reason: it splits the chargeable weight into as many boxes as the cap requires and returns the sum. Saturating at the last step (what a plain lookup does, and what this used to do) billed 24 kg at the 22 kg price and 44 kg at it too — an error with no ceiling, pushing the wrong way, since the air lane gets cheaper per kilo as you pile weight on and under-costing the excess rewarded piling it into a box that cannot be dispatched. **The split is into equal boxes, and that is a decision rather than the cheapest arithmetic.** The cheapest split concentrates weight — 24.42 kg costs $27.93 less as 18.9 + 5.5 than as 12.21 + 12.21, since the tariff falls per kilo as a box gets heavier — but that optimum exists only if you choose which piece goes in which box, and you don't: you hand over the goods and Shoppre boxes them. Quoting the optimum would cost the shipment with a saving that will not be realized, and the error would run in the direction that hurts, because the number ends up in a sale price. `LegBreakdown.cajas` / `.cajasKg` / `.capKg` carry it so every screen can say so, and the sweet-spot hint inverts past the cap: another kilo no longer buys a better rate, it opens a box at the most expensive end of the table. The cron self-throttles to one scrape every 3 days (`SHOPPRE_RATES_MAX_AGE_H`, default 72) because freight tariffs move in weeks, not hours.

**`lib/quote-metrics.ts`** resolves a plain `{ sku, qty }[]` into `EnvioItemInput[]` and hands it to `calcEnvio`. This is the entry point for any "how much does this quote weigh / how many ft³" question — from the CLI (`pnpm q`), from a page, or from a Server Action. It exists so those answers come from `Config` and `calcEnvio` rather than from a one-off script with hardcoded rates: a hand-rolled query silently drifts from what the app shows the moment a config value changes.

### Pages

| Route | Purpose |
|---|---|
| `/products` | List all products with stock and price |
| `/products/new` | Create product; optional `?parentId=` pre-links to an assembly |
| `/products/[id]` | Detail: cost breakdown, component list, assembly membership |
| `/products/[id]/edit` | Edit product fields |
| `/groups` | List assemblies with their component sub-groups |
| `/envios` | Both lanes, labelled, each box tagged with its supplier. Creating asks for the **route and the supplier** — the two decisions that shape everything downstream and are frozen from then on |
| `/envios/[id]` | Branches on the route. Air: assign **orders** (they inherit the box's supplier), one card showing what gets wired to that supplier and taking the two recorded amounts (DDP total when it dispatches itself, wire commission always), advance the box. Sea (`maritimo.tsx`): fill it piece by piece while `borrador`, watch the m³ against the billable minimum, then close it |
| `/presupuestos/[id]` | Quote detail (commercial, air) + the per-assembly measures loader |
| `/simular` | Two what-ifs on a box that does not exist yet, in tabs, **both starting from an existing quote**. **Who to buy from**: that quote (or a pasted SKU+qty list) costed against every supplier on the air lane, one card per option, with the ceiling a self-dispatching supplier can charge. **Which route**: the same quote, air against sea. Nothing here is saved |
| `/products/discontinued` | Bulk-mark parts as discontinued by pasting Bajaj codes (matched through the alternate SKU too), plus the list of what is currently marked. Bulk-only on purpose: the data arrives dozens at a time — 99rpm labels a whole exploded view — never one part at a time |
| `/suppliers` | Suppliers: `origen`, `inbound` (how their goods reach the USA) and the FOB — the one manual setup step, done once per supplier. Wire commissions are deliberately **not** here: they are recorded per shipment |
| `/config` | Edit all `Config` key-value settings |

### API routes

`app/api/products/` and `app/api/products/[id]/` expose a JSON CRUD API (used separately from the UI Server Actions). `app/api/health/` returns a simple status check.
