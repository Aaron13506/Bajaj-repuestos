---
name: costeo
description: Reglas del costeo landed (lib/calc.ts calcLanded/calcEnvio, lib/cbm.ts, lib/shipping-rates.ts, lib/comparar-compra.ts, lib/quote-metrics.ts, lib/cost-columns.ts). Usar al tocar o razonar sobre flete aéreo Shoppre/ShipGlobal, tramo cotizado, Miami→Caracas, CBM marítimo, FOB, seguro/processing, reparto por pieza, caja pesada, tabla escalón, comparar proveedores o compras, o cualquier "cuánto pesa / cuánto cuesta" de una lista.
---

# Costeo

`pnpm check:costeo` verifies this arithmetic without the DB. Totals stay plausible when the per-piece attribution breaks, so only per-piece figures give a bug away — add a case there when changing a rule.

## `calcLanded(product, cfg, modo)` — one part

Chain **India → USA (Shoppre) → Venezuela (sea leg Miami→CCS)**: product + Shoppre air (prorated on `reference_weight_kg`) + insurance + maritime by ft³. No import duty. Returns `null` without cost (`priceInr`/`priceUsd`) or without the datum the mode bills (weight by air, dimensions by sea).

- The air rate is **USD** (Shoppre's API returns the converted price): it never passes through `inr_usd_rate`. That rate only applies to what really is in rupees: `priceInr`, `shoppre_processing_inr`.
- **Sale prices always come from the air lane** (`Product.price`, `reprice`, `applyMeasures`, the quote builder): it is the route client orders travel. The sea landed decides where to stock up, never what to charge.
- The air quote is optimistic by weight (no volumetric per part): boxes are built to be weight-bound. Not a bug.

## `calcEnvio(items, cfg, opts)` — a real box

The inbound leg is priced **by how it is billed, not by country** (`inbound`):
- `shoppre` lines: one ShipGlobal step lookup on the group's chargeable weight (`breakdown.air`).
- `cotizado` lines: the flat total the supplier invoiced (`breakdown.tramo`; `faltaCosto` when `Envio.tramoUsd` is null — the box is under-costed, not free).
- Both pay the maritime leg. `isLanded` lines are out of weight, volume, insurance and freight.
- The split is per line, not per box: old boxes can mix both kinds.
- **Which depot carries `shoppre` lines is the box's `reenvio`** (`lib/reenvio.ts`, `opts.reenvio`), not the supplier's: `shoppre` (the table) or `por_kilo` — chargeable kg × `Envio.tarifaKgInr` (₹/kg quoted per box) ÷ `inr_usd_rate`, one box, no cap, **no insurance**, plus `Config.reenvio_kilo_gastos_inr` as the fixed charge (in `processingUsd`, no default). Missing rate/fixed charge ⇒ `reenvio.faltaTarifa/faltaGastos` (under-costed, not free). The billed air freight replaces both; with no rate loaded it is split directly by the binding dimension (a 0 estimate would split it evenly). Without `opts.reenvio` everything is Shoppre: catalog, quotes and sale prices never use the per-kilo lane.

Charges attach to what generated them (spreading them wrecks the per-piece landed used to choose suppliers):
- Shoppre insurance and processing → only `shoppre` lines. A DDP supplier declares nothing to Shoppre.
- The quoted leg → only `cotizado` lines.
- Wire commissions (outgoing + incoming, recorded on the box, never computed) → every line by product cost, `isLanded` included.
- `breakdown.giro` exists even without a commission: `montoUsd` (merchandise + quoted leg) is the base the bank charges on.

**Real box (`opts.medidas` = `Envio.pesoRealKg` + `cajaL/A/H`) replaces the summed pieces**, it does not scale them. No packing factor anywhere: parts are stored packed, the scale knows the rest. The only ratio is `escala`, splitting a weighed box between legs by each one's share. `breakdown.caja.medido = false` ⇒ the number is a floor, and screens say so. `net*` fields report the summed totals beside the billed ones.

**Billed freight replaces the table** (`opts.fleteFacturado` ← `Envio.shippingCostRealAereo/Maritimo`), prorated like the estimate; the Shoppre invoice includes processing, so `processingUsd` is zeroed when it is loaded.

**Air leg split among lines (`repartirTramo`)**: by real weight when weight binds, by volumetric when volume binds — but on a box **not both weighed and measured** it slides linearly from weight to volume across `caja_sin_pesar_tolerancia_pct` (default 10%), because "volume binds" there compares two floors. `LegBreakdown.repartoVolumen` says the share. It lives in `calcEnvio` so the box page, supplier comparison and `/resultados` give the same per-piece landed.

## Rate table (`lib/shipping-rates.ts`)

- Live table: `Config.shoppre_rates_usd`, refreshed by `pnpm fx:update` (hourly timer) → `scripts/update-shipping-rates.ts`, throttled to one scrape per `SHOPPRE_RATES_MAX_AGE_H` (72 h) measured from the row's `updatedAt` (touched even when nothing changed). Fallback: bundled `shipping_rates.json` (`pnpm rates:baseline`). Shape: `[maxKg, basicUsd]` steps per carrier; member price = fixed 5% off, derived.
- **`cotizarTramoAereo` is the only door into the table.** 22 kg is the carrier's cap per box: past it there are more boxes, split into **equal** boxes (not the cheapest split — you don't choose how Shoppre packs, and the optimum would end up in a sale price). `LegBreakdown.cajas/.cajasKg/.capKg` expose it.
- **Two tables, one per destination** (`DestinoTarifa`): `'usa'` (above) and `'ve'`, Shoppre's express straight to Venezuela (`Config.shoppre_rates_ve_usd`, baseline `shipping_rates_ve.json`, API country 231, carrier `CARRIER_EXPRESS_VE`). Same cron, same throttle, same member discount (confirmed on a real invoice). `pnpm rates:baseline [--destino=usa|ve]`.

## Express (`lib/express.ts`)

`calcEnvio(…, { modo: 'express' })`: the `shoppre` lines pay the **Venezuela** table on the package's chargeable weight, plus Shoppre insurance and processing from Config; **no maritime leg**. Billed freight (`fleteFacturado.aereoUsd`) replaces the table and zeroes processing, as on the air lane. `calcLanded` refuses `'express'` by type: the freight is one rate per package, so there is no per-piece landed.

`calcExpress` adds what is express-only: **the package's landed (product + freight + insurance + processing) may not exceed `express_tope_usd` ($100)**, per package; the sale price may. `holguraUsd` (negative = over), `productoQueEntraUsd` (room ÷ (1 + insurance), valid while the freight stays on its step), `kgHastaProximoEscalon`. Price = line landed per unit ÷ (1 − `express_margen_pct`, falling back to the default margin), rounded to the cent: never the catalog price, which carries the Miami freight and sea leg. UI: the Express tab in `/simular` (nothing saved) and express quotes (`Pedido.via`, see the `pedidos` skill).

## CBM, the sea lane (`lib/cbm.ts`)

- `resumirCbm` costs lines by volume, expanding bundles, and counts **unmeasured** pieces (the volume is then a floor). Per piece it does **not** apply the billable minimum: `m³ × rate` + FOB share over `cbm_referencia_m3` — equals `calcLanded` in CBM mode.
- `costoEmbarque` (the shipment) **does** apply the minimum: landed = product + billable freight + FOB + commissions; `giroUsd` = merchandise + FOB (what the supplier is paid; freight goes to the carrier). A half-empty box shows an absurd cost per m³ on purpose: it is the signal to consolidate.
- `CBM_MAX_KG_PER_M3` (1000) warns that the carrier may bill by weight; it does not recompute.
- `CM3_PER_FT3` / `CM3_PER_M3` are the only conversion constants; never re-derive inline.

**No global air/sea switch**: the route is a property of each `Envio`. The catalog shows both landeds side by side (`lib/cost-columns.ts`); in `/ensambles/[id]` the 🚢 block is behind `Config.ensambles_columnas_maritimas` (`costHeaders(…, { maritimo })` and `CostCells maritimo` must get the same value).

## Comparing a purchase (`lib/comparar-compra.ts` · `lib/lista-skus.ts`)

`compararCompra` costs the same SKU list once per supplier **on the air lane, through `calcEnvio`** (a separate arithmetic would choose with a number the real box never shows). Pure, recomputed in the browser on every keystroke. Twin of `compararProveedores` (sea shipment: volume × rate + FOB); two modules on purpose.

- The key output is the **ceiling** `tramoTopeUsd = landedReferencia − landedSinTramo`: what a self-dispatching supplier can charge for the leg before it stops paying off. `check:costeo` loads it back and checks the tie.
- Never hidden: **coverage** (unquoted pieces fall to 99rpm's base price), **MOQ** (raises quantity, never unit price; applied by default, extra units named), **pieces with no price** (enter as $0).
- Inputs: an existing `Pedido` (`cargarPedido`, bundles expanded) or a pasted list. The list carries **only SKU and quantity** — the price comes from `SupplierPrice`, the thing under test. `parseListaSkus` tolerates fenced JSON, `{items:[…]}`, or a code per line, and drops freight/tax/total rows. `LISTA_SKU_PROMPT` warns that "Set Qty" is the MOQ, not the quantity wanted. SKUs resolve through the alternate SKU (`lib/alt-sku.ts`).

## Any "how much does this weigh / cost" question

Go through `lib/quote-metrics.ts` (`{ sku, qty }[]` → `calcEnvio`), e.g. `pnpm q quote` — never a one-off script with hardcoded rates: it drifts from the app the moment a Config value moves.
