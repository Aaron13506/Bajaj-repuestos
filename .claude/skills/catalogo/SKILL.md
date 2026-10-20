---
name: catalogo
description: Catálogo de piezas, ensambles y proveedores (Product, Ensamble, EnsambleComponente, Supplier, SupplierPrice, app/(pages)/products, ensambles, suppliers, lib/measures.ts, lib/measures-check.ts, lib/medido.ts, lib/modelo.ts, lib/reprice.ts, lib/producto-ia.ts, MedidasIA, scripts de 99rpm). Usar al tocar productos, peso y medidas, descontinuados, motos compatibles, ensambles, proveedores y sus precios/MOQ, el formulario o modal de producto, fotos, o la actualización de precios de 99rpm.
---

# Catálogo

## Product — a part, and only that

- `priceInr` (99rpm source price), weight and dimensions, sale `price`, `margin`, `priceLocked`, `landedCostUsd`, `stock`.
- **Price, cost and margin come from `reprice` (`lib/reprice.ts`)** — the full form, the quick-edit modal, `applyMeasures` and the 99rpm price script all use it. Always via the air chain. Without `priceLocked` the price derives from cost and margin; with it the price is given and the margin is derived. An empty margin stays empty (= use `default_margin_pct`).
- `discontinuedAt` = Bajaj stopped manufacturing it: a fact of the factory, not of a supplier. **Hard block** on quoting and on the sea builder; selling existing stock is fine. Marked in bulk on `/products/discontinued` (pasted codes, matched through the alternate SKU).
- `compatibleModels` is **text**: comma-separated labels. A loose part lists every bike it fits (that is the cross-compatibility); an assembly has exactly one. The `MotoModel` enum column `Product.models` **does not exist** (reverted in e2ff02d) — the enum survives only for `ScrapedProduct.model`; writing `models` fails the build. `lib/modelo.ts` is the only translation to display (`formatModels` collapses by family); `whereModel()` filters with `contains`; `compatibleModelsFrom` keeps labels the picker cannot show.
- Two Bajaj SKUs per part are common and each supplier uses one: `Product.altSku` (typed in the product form, backfilled/materialized from `ScrapedPart.altSku`) wins over the scrape pair. Every product search ORs `codigoContiene(q)` and every code match goes through `lib/alt-sku.ts` — don't search `bajajCode` alone.

## Ensamble / EnsambleComponente

An assembly is the 99rpm exploded view that *groups* parts — **not a product**: identity only (`nameEn` required, `nameEs` optional via `nombreEnsamble()`, one bike in `compatibleModels`, unique `sourceUrl`, `imageUrl`). **No price, by decision** — don't add one or bring back `BundlePriceEditor`. Ids were preserved when it left `Product`, so `/products/<old id>` redirects to `/ensambles/<id>`. Components: `(ensambleId, productId, quantity, groupName, sortOrder)`, unique on `(ensambleId, productId, groupName)`; deleting an assembly cascades links, the piece side is `Restrict`.

## Supplier / SupplierPrice

- Two independent axes: `origen` (`india` | `china`, where the goods are) and `inbound` (`shoppre` | `cotizado`, how the leg to the USA is priced). `inbound` decides costing **and** route; `lib/inbound.ts` owns the vocabulary (a Chinese supplier is always `cotizado`). A `cotizado` supplier is DDP: no Shoppre insurance or processing on top.
- No commission rule on the supplier (recorded per box — `envios` skill). `/suppliers` sets `origen`, `inbound` and the FOB.
- `SupplierPrice`: `priceUsd` per piece; `isLanded` = delivered in Venezuela, **only set explicitly, never inferred from the amount**; `moq` = minimum quantity (a floor, not a multiple; null ≠ 1; it raises quantity, never unit price). Neither touches 99rpm's base price.
- Quick-edit modal with `?proveedor=`: edits only that `SupplierPrice` plus physical fields; the part's price stays on 99rpm's base and is recomputed only if weight or dimensions changed.

## Weight and dimensions

- The four numbers describe the **shipping bundle** (part + its box/bag), not the bare part — the carrier bills the bundle. No multiplier afterwards.
- Loaded **together** (by sea the volume is what is billed). Every door checks them with `chequearMedidas` (`lib/measures-check.ts`): impossible density (> 8 or < 0.02 g/cm³) or a zero is refused; the rest only warns (thresholds at the catalog's tail). Manual forms check only when the numbers changed and also demand all four or none. `pnpm measures:audit` runs the same checks over stored data.
- `MedidasIA` is the one AI loader (assembly page, quote, sea shipment), **one assembly at a time**; `MEASURES_PROMPT` (`lib/prompts.ts`) is the single prompt copy. `applyMeasures` parses via `lib/json-ia.ts`, matches by `id` or `bajajCode`, merges patches before checking, and reprices.
- `Product.medidoAt` (`lib/medido.ts`) = measured by hand. Set only from the part's edit form (never from a table); re-measuring refreshes it. `applyMeasures` skips measured parts and `MedidasIA` doesn't send them. Shown read-only by `IndicadorMedido`; filter `/products?medido=si|no`. Doesn't change costing.

## Products with no catalog (accessories)

A product like any other, with an invented SKU. The form's "Llenar con IA" panel uses `productoPrompt()` and `leerFichaProducto`, which only **fills the form** (nothing saved until Save): SKU and `nameEn` echoed, `nameEs` translated, bikes mapped to exact `MOTO_MODELS` labels, `priceInr` only if given, measures all-or-none and checked. **Photos are pasted, never picked from disk** (`PegarImagen`): shrunk in the browser and uploaded on paste to `motokira-images/productos/<sha256>`; a copied address is downloaded by the server (`copiarImagenAlBucket`). `Product.imageUrl` is always our bucket. Server-action body limit is 6 MB for this.

## Refreshing 99rpm prices (`scripts/update-prices-99rpm.ts`)

`pnpm scrape:99rpm` (writes only `data/scrape/`) then `pnpm prices:99rpm --file=…` — **dry by default**, `--apply` writes. Writes only what 99rpm owns: `priceInr`, `discontinuedAt`, and the `reprice` result. Never goes through `seed-scraped`/`materialize-catalog` (those incorporate a catalog: create products, relink, upload images). Guards: a scraped 0 never overwrites; a change above `--max-delta` (300%) is set aside (its discontinued flag still applies); the report shows catalog vs scraped name so a different unit (pack vs piece) is caught — `--skip=SKU,…` excludes those.
