---
name: envios
description: Cajas y logística (Envio, EnvioLinea, app/(pages)/envios/, lib/shipping-status.ts, lib/mover-etapas.ts, lib/flete-real.ts, lib/financiamiento-envio.ts, lib/etapas.ts). Usar al tocar cajas aéreas o embarques marítimos, asignar pedidos a una caja, borrador/confirmar/recibir, etapas y rutas (shoppre/cotizado/landed), tramo cotizado, comisiones del giro, peso/medidas reales de la caja, flete facturado y pagado, guía, o quién financia una caja.
---

# Envíos (boxes) and routes

## Envio — one physical box, one supplier

- Route (`modo`) and supplier (`supplierId`, `null` = 99rpm at the base ₹ price) are chosen at creation and **never change**. The box is the purchase: lines inherit its supplier, `origen` and `inbound` in `asignarAEnvio`.
- **`aereo`** — the commercial lane: carries `PedidoItem` (client orders and own stock). Born `borrador`; `confirmarCajaAerea` makes it a purchase. In `borrador` nothing counts as inventory and nothing can be bought, paid or moved (`motivoCajaEnBorrador`). `volverCajaABorrador` only while nothing was bought, costed or paid. (Old boxes stayed `confirmado`; only `createEnvio` sets `borrador`.)
- **`maritimo_cbm`** — the stocking lane: carries `EnvioLinea` (own merchandise: product + quantity, no price, no client). Filled while `borrador` (`sincronizarLineas` refuses discontinued parts), closed, received (adds to `Product.stock`). Reopening is refused once a payment is recorded against it — same rule as the air lane.
- Unconfirmed client quotes can sit in a box (to see who funds it) but are never bought (`registrarCompra` and the per-box purchase list filter `status = 'pedido'`).

**A bought line does not leave its box.** "Quitar" (`removePedido`) only releases lines that are `pendiente` with no `costRealUsd` and reports what stayed; `deleteEnvio` refuses a box with bought or moving lines or with ledger entries; a line bought outside a box cannot enter a box that has a supplier. Releasing one left the box "overpaid", the piece out of in-transit inventory, and free to be re-costed under another supplier.

## Amounts nothing can derive (all nullable — empty is "not loaded", never zero)

- `tramoUsd` — the flat total a `cotizado` supplier billed to reach the USA. Missing ⇒ the box is flagged under-costed.
- `reenvio` (`shoppre` | `por_kilo`, chosen at creation, forced to `shoppre` for a `cotizado` supplier) + `tarifaKgInr` — which depot carries the box to the USA; the per-kilo one quotes ₹/kg per box (`guardarTarifaKg`). Same route and stages as Shoppre (labels say "depósito"). `cambiarReenvio` switches it only while `motivoNoCambiaReenvio` allows (no non-landed line at `camino_usa` or later, no air freight billed or paid; guarded `updateMany`), keeping the rate. Bought lines may switch: the owner picks the depot address when buying. The box page compares both lanes estimate-to-estimate and shows `tarifaEquilibrioKgInr`, the highest ₹/kg worth accepting.
- `comisionSalienteUsd` (my bank, known the same day) and `comisionEntranteUsd` (correspondent/supplier bank on arrival — shows up as the supplier saying he got less). Two columns because they arrive at different times; both are my cost and both enter the landed. An explicit `0` is a finding. `giro.cargada` = both recorded. **No commission rule on the supplier**: a stored percentage would be an invented number flowing into prices. The sea lane uses the same columns and form.
- `pesoRealKg` + `cajaL/A/H` — the box as the carrier weighed it; they **replace** the summed pieces in the costing (see the `costeo` skill). `saveMedidasCaja` touches only these four.
- `EnvioTracking`: tracking numbers per leg (`local` supplier → depot in India, `usa`, `venezuela`), each with an optional carrier, up to 10 per leg (`lib/tracking.ts`). Just written down; `guardarTrackings` replaces the box's whole list. Shown on each line of the order and searchable in `/buscar`.

**Billed freight (`lib/flete-real.ts`)**: `shippingCostRealAereo/Maritimo` is what each carrier billed and **is the cost**. "Paid" is never stored: it is derived from `Movimiento` egresos `flete_aereo | flete_maritimo` with `envioId`. `pagarFlete` locks the `Envio` row and refuses paying past the billed amount; paying with nothing billed stores the payment as billed. A `cotizado` box has no air-freight row (that leg is `tramoUsd`, paid inside the wire).

**Who funds a box (`lib/financiamiento-envio.ts`)**: cost split into clients / own stock / unapproved quotes; a client's advance is prorated by the share of the order travelling in this box. Gross margin is over client lines only (an own-stock `salePrice` is an estimate).

## Routes (`lib/shipping-status.ts`)

`SHIPPING_STATUSES` is the ordered pipeline; routes are subsets in the same order, so `statusIndex` compares across routes.

| Route | Stages |
|---|---|
| `shoppre` | pendiente → camino_shoppre → en_shoppre → camino_usa → en_usa → camino_venezuela → en_venezuela → entregado |
| `cotizado` | pendiente → camino_usa → … (skips Shoppre) |
| `landed` | pendiente → en_venezuela → entregado (`isLanded`: never travels in the box) |

What separates the first two is whether goods pass through Shoppre's warehouse, not the country (`lib/inbound.ts`). `routeFor(inbound, isLanded)` picks the route, `nextStatus` skips inapplicable stages, `normalizeToRoute` repairs a line left on a stage its route lacks. `PedidoItem.inbound` keeps a bought line on the route it was bought with.

## Moving lines (`saveItemChanges` → `lib/mover-etapas.ts`)

One SQL statement per batch: the guarded `UPDATE … WHERE shippingStatus = desde` (a double click is a no-op), the `PedidoItemEtapa` history row, and — for own-stock lines crossing `entregado` — the `Product.stock` credit/debit by pieces (`lib/stock-piezas.ts`; a bundle credits its pieces, resolved by `bajajCode`, or by name only when the name belongs to one product — an unresolvable piece refuses the whole delivery, never a half credit). Taking a line out of `entregado` when that stock was sold is refused. `pnpm check:etapas` tests this SQL against the Docker DB.

Before moving: cancelled orders don't move; an open `no_disponible` blocks buying, any open incident blocks delivery. **A client line stops at `en_venezuela` ("Recibido")**: the box refuses `entregado` for it (`seEntregaDesdeElPedido`) and the table doesn't offer it; it is delivered from the order with `confirmarEntrega` (see the `pedidos` skill). Taking one *out* of `entregado` is still allowed here, as a correction. Own stock is still delivered (= credited to stock) in the box.

`/envios` shows real times per stage (`lib/etapas.ts`) once there is history; regressions and gaps are not measured as legs.
