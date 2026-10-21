---
name: pedidos
description: Presupuestos y pedidos (Pedido, PedidoItem, app/(pages)/presupuestos/, PresupuestoBuilder, lib/pedido-edicion.ts, lib/pedido-cancelacion.ts, lib/pedido-derivado.ts, lib/incidencias.ts, lib/validez.ts, lib/saldo-entrega.ts, lib/linea-pedido.ts). Usar al tocar el armador, líneas pieza o conjunto, estados presupuesto/pedido/cancelado, editar un pedido confirmado o uno propio, cancelar, devolver plata, incidencias y reclamos, reposición/sobrante, validez del presupuesto, entregar con saldo, o qué se puede borrar.
---

# Pedidos

All rules here are **pure functions in `lib/`** (checked by `pnpm check:costeo`) applied by `presupuestos/actions.ts`, `presupuestos/flujos-actions.ts` and `envios/actions.ts`, each in one transaction under `bloquearPedido` (pedido first, its movimientos after).

## The document

- **`PedidoItem` is the unit of purchase and logistics**, not `Pedido`: an order is routinely bought in parts, from different suppliers, in different boxes. Each line carries `envioId`, `shippingStatus`, `supplierId`, `origen`, `inbound`, `isLanded`, `costRealUsd`, `compraId`, `compradoAt`. The order's stage is **derived** (`stageSummary`), never stored.
- **A line is a piece or a bundle, never both**: `productId`, or `ensambleId` + the `bundleItems` snapshot of the chosen pieces (CHECKs only in SQL: `PedidoItem_pieza_xor_conjunto`, `PedidoItem_conjunto_lleva_piezas`). Piece and assembly ids can coincide, so a line's identity is `claveLinea()`, never the bare number; `cabeceraDeLinea()` answers what to show. A bundle has no weight, price or stock of its own: it is costed from its snapshot (`expandCostPieces` with `product: null`), never `isLanded`, and its price is computed in the builder over the chosen pieces and frozen in `salePrice`.
- **Status**: `presupuesto` → `pedido` → `cancelado` (CHECK `Pedido_cancelado_coherente`). Anything testing `status !== 'presupuesto'` as "confirmed" must think of `cancelado`. `tipo`: `cliente` · `propio` (own stock, born `pedido`) · `venta` (see the `dinero` skill).
- Derived orders: `origenId` + `origenMotivo` (`reposicion` | `sobrante`). `PedidoEvento` is the order's memory (text, nothing computed from it). `PedidoItemEtapa` is one row per real stage change; old lines have no history and none is invented.
- Discontinued parts (`bloquearDescontinuadas`) are refused when quoting, adding or rewriting a line, and at approval if discontinued after quoting.

## What a line is, for editing: `estadoLinea`

`libre` (no `costRealUsd` and still `pendiente`) · `comprada` (money left or it travels, not delivered) · `entregada`. Every rule below hangs from it, and the builder shows each line's limits (`restriccion`).

**Confirmed client order (`editarPedidoConfirmado`, `planEdicion`)**: a *libre* line changes freely; a *comprada* line admits another price and **fewer** units — never more, never another bundle composition. The units that leave go with their prorated cost (`repartirSobrante`, exact to the cent), box and stage to a `propio` order (`origenMotivo = 'sobrante'`, one per origin; `pasarAStockPropio`). An *entregada* line is untouched (problems are claims). The client and the frozen escalón stay. Editing **never refunds by itself**: a total below what was collected shows "a favor del cliente" and `devolverAlCliente` returns it.

**Own-stock order or quote (`updatePresupuesto`)**: a *comprada* line is fixed except its price (`permisoSinCliente` / `motivoEdicionSinCliente`) — there is nowhere to send the excess, and removing it erased a paid cost. Editing an own order's *entregada* lines adjusts `Product.stock` by pieces (and refuses to push stock negative). Saving a client quote re-quotes it (new date, today's escalón).

## Outside the happy path

- **Cancel (`cancelarPedido`)**: confirmed client order with nothing delivered. The owner writes what is returned (proposal: everything if nothing was bought, nothing if something was). What is kept counts in the month (`cancelacionesUsd`). Bought lines go to stock propio with their cost (no loss booked); never-bought lines leave their box. A cancelled order doesn't collect and its lines don't move.
- **Incidents (`Incidencia`)**: `no_disponible` (before buying), `danada`/`perdida`/`faltante`/`equivocada` (bought), `defecto` and client claims (delivered; flagged, not refused, past `reclamo_horas`). `tiposPara` decides what each state admits. Open `no_disponible` blocks buying; any open one blocks delivery. Close as `llego`, `sustituida`, `rechazado` (claims), `reposicion` (new client order at $0 — its negative margin is the re-buy cost) or `reembolso` (lowers units and sale, moves their cost out of the line into `perdidaUsd`, which the margin adds back). In a bundle the problem is usually one SKU: `Incidencia.pieza` (`etiquetaPieza`); removing that piece in the edit closes it as `sustituida` (`cerradosPorEdicion`).
- **Validity (`cotizadoAt` / `escalonCotizadoPct`)**: past `presupuesto_validez_dias` (default 7, end of day Venezuela time) a quote cannot be confirmed; `renovarPresupuesto` re-dates it with today's escalón and does **not** touch prices. Old quotes without the fields are valid from creation with today's escalón.
- **Lost quote (`perdidoAt` / `perdidoMotivo`)**: `marcarPerdido` / `reabrirPresupuesto`; it stays `status = 'presupuesto'` on purpose (CHECK `Pedido_perdido_solo_presupuesto`) and cannot be confirmed. `embudo` (lib/validez.ts) counts confirmed / lost / expired / open; conversion is over the decided ones.
- **Served from the warehouse (`PedidoItem.desdeStock`)**: a free, loose-piece line of a confirmed client order can be served with existing stock (`servirDesdeStock`): conditional stock decrement, `costRealUsd` = inventory cost × qty, stage `en_venezuela`, no purchase, no box (CHECK `PedidoItem_desde_stock_coherente`; not assignable to a box). Delivered with `confirmarEntrega` like any received line, or returned (`devolverAlDeposito`) from the order page. While served it cannot be removed, change quantity or let the order be cancelled — return it first; price may change.
- **Deliver (`confirmarEntrega`, lib/saldo-entrega.ts)**: the only way a client line reaches `entregado`. From the order page, one transaction under `bloquearPedido`: pick the received lines (`motivoNoEntregable`: `en_venezuela` and no open incident, box or warehouse alike), collect what was paid at that moment (`cobrarPedido`, optional), record change given as `devolverACliente` ("Vuelto de la entrega", capped at the surplus the payment left), then move the lines. Balance left without the "entregar igual" box → `codigo: 'saldo_pendiente'` and nothing is saved, not even the payment; with it, logged as `entrega_con_saldo`. Contabilidad's *por cobrar* separates delivered-unpaid from in-transit (`situacionDeCobro`).

## What can be deleted

Pure functions shared by the screen (hides the button) and the action (the real lock): `motivoNoEliminable` — a client order past `presupuesto`, or anything with money, ledger entries, a real cost, a box or a purchased line, stays; `motivoProveedorEnUso` — a supplier with boxes, lines or payments stays (`SetNull` would re-cost its history as 99rpm); `motivoEnsambleEnUso` — an assembly sold in any order stays.
