---
name: dinero
description: Libro de caja y plata (lib/movimientos.ts, lib/cobro-bcv.ts, lib/cuentas.ts, lib/conversion.ts, lib/venta-stock.ts, lib/margen.ts, lib/resultados.ts, lib/inventario.ts, app/(pages)/contabilidad, ventas, resultados, inventario). Usar al tocar cobros, adelantos, depositUsd, dólar BCV y escalón, pagos en Bs y tasas, conversión Bs→USDT, compras y costRealUsd, pagos a proveedores y cuentas por pagar, ventas del depósito, margen realizado y resultado mensual, o valuación del inventario.
---

# Dinero: ledger, collections, stock and margin

`pnpm check:libro` checks the ledger against its caches (read-only, local DB); `pnpm check:costeo` covers the pure rules.

## Ledger (`Movimiento`) and the deposit cache

- `Movimiento.monto` is **real dollars** and the only thing the cash balance sums. `Pedido.depositUsd` is a **cache** of what the client paid, net of refunds; every write of a client income goes through one place so they never disagree: `registrarIngresoPedido`, `ajustarDeposito` (one `UPDATE … COALESCE(depositUsd,0) + x`), `descontarIngresosPedido`, `devolverACliente` — all under `bloquearPedido`'s row lock, **pedido first, then its movimientos**.
- **Every client payment goes through `cobrarPedido`** (order page, approve form, Contabilidad's loose entry). A cancelled order no longer collects.
- Lowering an advance in `aprobarPedido` is a **typo correction**: it trims incomes newest-first. Empty advance on an order that already collected is refused (type `0`). A real refund is `devolverACliente` (egreso `devolucion_cliente` that also lowers the deposit; deleting it restores the deposit; not typeable as a loose category).
- Categories fix the type (`tipoDeCategoria`). "Paid to the supplier" is only `CATEGORIAS_PAGO_PROVEEDOR` (`pago_proveedor`, `comision_giro`); freight goes to the carrier. `cuentasPorPagar` → `{ pendientes, sobrepagadas }`; a sea box's debt is merchandise + FOB (`giroUsd`).

## Purchases (`registrarCompra`)

The total paid for a selection of lines is split by catalog estimate with `repartirEnCentavos` (sums to the cent). Guarded write: `UPDATE … WHERE costRealUsd IS NULL`, and if fewer rows update than selected the whole transaction aborts (no double expense). Only lines of confirmed orders (`status = 'pedido'`) outside draft boxes. Each line stores the expense that paid it (`PedidoItem.compraId`): **deleting that expense in Contabilidad undoes the purchase** (lines lose `costRealUsd` and can be registered again). Lines bought before `compraId` existed don't have it.

## Charging in "dólar BCV" (`lib/cobro-bcv.ts`)

Quotes and orders are **presented** in BCV dollars (real ÷ (1 − escalón), `calcPrecioBcv`); everything stored stays real. A quote uses today's escalón (frozen in `escalonCotizadoPct` when quoted); confirming freezes it in `Pedido.brechaEscalonPct` (null = order in real dollars). Paid in Bs → typed in BCV dollars, stored at real value; paid in foreign currency → stored as is (that is the cash discount). Convert with the order's own ratio `totalReal / totalBcv`, so unpaid shows the table's total and fully paid shows exactly zero. Aggregates (`/clientes`, `/contabilidad`, box funding) stay real.

## Accounts and bolívares (`lib/cuentas.ts` · `lib/conversion.ts`)

- `cuenta` (`banco_bs` · `efectivo_usd` · `usdt` · `banco_usd`) is derived from `metodoPago` (`cuentaDeMetodo`), never asked. `montoBs` + `tasaBs` go together (CHECK).
- A Bs payment is written as it happened (`MontoBs`, `leerCobroBs`): the bolívares received and that day's rate; dollars come from dividing. Bs stored exactly as typed (reconcilable with the bank).
- Bs → USDT (`registrarConversion`): two rows sharing `grupo` — `conversion_salida` out of `banco_bs` at book value, `conversion_entrada` into `usdt` for what arrived. Book value = **moving-average cost of what is left** in `banco_bs` (`usdPorBsEnCuenta`: signed USD / signed Bs over rows with Bs recorded); falls back to `bsd_usd_rate` and says so. The cost of converting is the difference of the legs, never a third row; `saldoCaja` subtracts it as `costoConversion`. Legs are created and deleted together.
- **The business bears the gap on the balance** (decided 2026-10-15). A Bs payment of an order with a frozen escalón also writes a `diferencia_brecha` row (`anotarDiferenciaBrecha`): signed egreso in `banco_bs`, linked to the order, sharing `grupo` with its ingreso — credited real − BCV amount × (1 − today's `bcv_brecha_pct`); + lost, − gained. It enters the order's cost (`MargenPedido.brechaUsd`) and the book value of the Bs (`valorBsEnLibro` adds it), so the later conversion only shows spread and later drift — no double count. Deleting or trimming the ingreso takes it along; a `grupo` alone does not mean conversion (check the category).

## Selling from the warehouse (`lib/venta-stock.ts` · `/ventas`)

A `Pedido` with `tipo = 'venta'`, born `status = 'pedido'` with every line `entregado`; reuses `cobrarPedido`, BCV escalón and client totals. Loose pieces only (a bundle has no stock). Each line freezes its cost in `costRealUsd` (prefilled from `landedCostUsd`, **required**). Stock drops with `UPDATE … WHERE stock >= qty` in the same transaction. Never assigned to boxes. Not editable; `anularVenta` returns pieces, removes its incomes and deletes the order (not a refund).

## Realised margin (`lib/margen.ts` · `lib/resultados.ts` · `/resultados`)

Real dollars, recognised on **delivery**. A line's cost is the landed its box gives it (`costearAereo`, same numbers as the box page); a sale brings its frozen cost; a landed-supplier line outside a box costs what was paid. **Any line without cost makes the order's margin `null`** (`sin_costo`, excluded from the month). States: `realizado` (all real: purchase, both freights billed, box weighed), `estimado`, `sin_costo`, `en_curso`. Reimbursed incidents add `Incidencia.perdidaUsd` to the order's cost. Month cut in Venezuela time (UTC−4). **Monthly result = delivered margin + what cancelled orders kept − `gasto_operativo`/`otro_egreso` − cost of converting Bs**; freight, commissions and supplier payments are already inside each landed.

## Inventory (`lib/inventario.ts`)

Own merchandise only. *Aquí* = `Product.stock` at current replacement cost (`landedCostUsd`, explicit decision — no lot costing). *En camino* = lines in **confirmed** boxes not yet arrived, at each line's landed as its box costs it (`costo-envios.ts`). Own orders outside a box and anything in a `borrador` box appear nowhere. `posicionesParaArmador()` feeds the builders' informative `StockBadge`.

## Caja apertura

`caja_apertura_desde` / `caja_apertura_usd` in Config anchor the displayed balance (`saldoInicial + real flow since`); the ledger keeps only real movements.
