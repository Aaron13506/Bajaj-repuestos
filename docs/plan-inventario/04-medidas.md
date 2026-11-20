# Fase 4: medidas en una sola base

Independiente de las fases 2 y 3. Se puede hacer en cualquier momento después de la fase 1.

## El problema

- El comentario de `Envio` en `schema.prisma` dice que el catálogo guarda la pieza **desnuda**, y `calc.ts` trata la suma de las piezas como un piso que no incluye el empaque.
- Pero el formulario de pesar de `ConteoCaja` pide la pieza **"con su bolsa o caja"**, y lo guarda en las mismas columnas (`weightGrams`, `dimL/A/H`) con `medidoAt`.
- Resultado: las estimadas son pieza desnuda y las medidas son pieza empacada, en la misma columna, sin forma de distinguirlas.

Efectos:

1. **El reparto del flete entre piezas se tuerce.** Dentro de una caja, el costo se reparte según los números de cada pieza. Una pieza medida con su empaque se lleva más flete que una estimada desnuda del mismo tamaño real.
2. **La comparación entre la suma de piezas y la caja real (`netRealKg` contra la caja pesada) mezcla dos cosas**, así que no sirve para medir cuánto agrega el empaque.
3. **Las bolsas reempacadas no tienen cómo medirse bien**: una bolsa con 2 unidades pesa y mide por 2.

## La decisión: medir empacada

La base es la **pieza empacada como llega**: la caja individual de Bajaj o la bolsa del proveedor. Es lo que se tiene en la mano al contar y es lo que viaja. La diferencia contra la caja del transportista queda reducida al cartón exterior y el hueco entre piezas.

## Esquema

```prisma
model Product {
  // …
  // Qué describen weightGrams y dimL/A/H: 'pieza' (desnuda, como las estimaciones) o
  // 'empaque' (como llega, en su caja o bolsa). Null = medida a mano antes de que
  // existiera esto: no se sabe en qué base, se re-mide cuando pase por un conteo.
  medidaBase      String?
  // Cuántas unidades había en el empaque que se midió (una bolsa reempacada de 2 → 2).
  // Los números guardados son los del empaque entero; lib/medido.ts los divide.
  // Null = 1.
  medidaUnidades  Int?
}
```

Migración `prisma/manual/AAAA-MM-DD-medida-base.sql`:

- CHECKs: `medidaBase IN ('pieza', 'empaque')` o nulo; `medidaUnidades > 0` o nulo.
- Las estimadas (`medidoAt IS NULL`) → `medidaBase = 'pieza'`.
- Las ya medidas → quedan en `NULL` (base desconocida).

## Un solo lugar para leer las medidas

`lib/medido.ts` agrega:

```ts
// Peso y volumen POR UNIDAD, sea cual sea la base y el tamaño del empaque medido.
// Todo lo que costea tiene que leer por acá y no las columnas directo.
export function fisicoPorUnidad(p: Fisico & { medidaUnidades: number | null }): {
  gramos: number | null
  cm3: number | null
}
```

Con `medidaUnidades = 2`, divide el peso y el volumen por 2. Las dimensiones se guardan como las del empaque porque L×A×H no se puede dividir; lo que se divide es el volumen.

Hay que pasar por `fisicoPorUnidad` en cada lugar que hoy lee `weightGrams` o `dimL/dimA/dimH` para costear. Para encontrarlos: `grep -rn "dimL\|weightGrams" lib/calc.ts lib/quote-metrics.ts lib/costo-envios.ts lib/cbm.ts scripts/q.ts`. `lib/measures-check.ts` (`chequearMedidas`) valida la densidad sobre el empaque entero, que es lo que de verdad se pesó.

## Al medir

- **En el conteo** (`ConteoCaja` y `/escanear`, modo Medir): el formulario dice "Pésala como llegó, en su caja o bolsa" y guarda `medidaBase = 'empaque'`. Si la lectura venía con `cantidad > 1` (bolsa), propone `medidaUnidades` con ese número.
- **En la edición de pieza** (`ProductForm`, `QuickEditProduct`): selector de base, y unidades del empaque.
- **`medirPieza`** (`products/actions.ts:291`) recibe los dos campos nuevos.
- **La IA (`applyMeasures`, `MedidasIA`)** sigue estimando `pieza` y sigue sin pisar una medida.

## Indicador

`IndicadorMedido` pasa a tres estados: **✓ empaque** (medida), **? base** (medida, base desconocida) y **≈ estimado**. Más el filtro `/products?medido=sin_base` para ver qué re-medir.

## Opcional, después de medir varias cajas completas

Cuando haya cajas donde todas las piezas estén medidas en base `empaque`, se puede comparar la suma contra la caja pesada (`EnvioCaja`) y obtener el factor del cartón y el hueco. Serviría para estimar mejor un presupuesto antes de que exista la caja (hoy esa suma es un piso). Esto cambia precios, así que es una decisión aparte, no parte de esta fase.

## Chequeos

- **`check:costeo`:** `fisicoPorUnidad` con 1 unidad, con 2 y con valores vacíos (vacío sigue siendo vacío, no cero).
- **`pnpm measures:audit`:** agrega el listado de piezas medidas sin base.

## Hecho cuando

- Ningún archivo de costeo lee `weightGrams` o `dimL/A/H` sin pasar por `fisicoPorUnidad`.
- Una bolsa de 2 medida en el conteo deja en la pieza el peso por unidad correcto.
- El comentario de `Envio` sobre la pieza desnuda se actualiza a la nueva regla.
