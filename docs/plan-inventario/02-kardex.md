# Fase 2: kardex (libro de movimientos de stock)

El mismo patrón que ya usa la plata: `Movimiento` es la verdad y `Pedido.depositUsd` es su caché. Acá `MovimientoStock` es la verdad y `Product.stock` es su caché. No cambia ninguna regla de negocio: cada lugar que hoy escribe `stock` sigue haciendo lo mismo, pero a través de un solo helper que deja el movimiento.

## Esquema

```prisma
// Libro de stock: cada unidad que entra o sale del depósito, con por qué y de dónde.
// Product.stock es la caché de SUM(cantidad) por pieza, y la mantiene SOLO moverStock
// (lib/stock.ts), en la misma sentencia que inserta el movimiento.
//
// Un movimiento no se edita ni se borra: un error se corrige con otro movimiento
// (un ajuste, o la reversa de lo que lo generó).
model MovimientoStock {
  id           Int      @id @default(autoincrement())
  productId    Int
  // Con signo: + entra al depósito, − sale. Nunca 0 (CHECK).
  cantidad     Int
  // Ver MOTIVOS_STOCK en lib/stock.ts. CHECK en la base.
  motivo       String
  // Costo por unidad de ESTE movimiento, si se sabe. Vacío = no se sabe, no es cero.
  costoUnitUsd Decimal? @db.Decimal(10, 2)
  nota         String?
  envioId      Int?
  pedidoId     Int?
  pedidoItemId Int?
  recepcionId  Int?     // fase 3
  // Las filas de un mismo hecho (una recepción, una venta de varias piezas) comparten este valor.
  grupo        String?
  createdAt    DateTime @default(now())

  product    Product     @relation(fields: [productId], references: [id], onDelete: Restrict)
  envio      Envio?      @relation(fields: [envioId], references: [id], onDelete: SetNull)
  pedido     Pedido?     @relation(fields: [pedidoId], references: [id], onDelete: SetNull)
  pedidoItem PedidoItem? @relation(fields: [pedidoItemId], references: [id], onDelete: SetNull)

  @@index([productId, createdAt])
  @@index([envioId])
  @@index([pedidoId])
  @@index([grupo])
}
```

Y en `Product`, `Envio`, `Pedido`, `PedidoItem`: la relación inversa `movimientosStock MovimientoStock[]`.

`onDelete: Restrict` en `Product`: una pieza con historial no se borra. `lib/producto-en-uso.ts` tiene que contar sus movimientos para no ofrecer el botón.

`SetNull` en `Pedido`: `anularVenta` borra el pedido de venta, y sus movimientos (la venta y la anulación) quedan como historial sin pedido.

## Migración: `prisma/manual/AAAA-MM-DD-movimiento-stock.sql`

1. `CREATE TABLE "MovimientoStock"` con sus FKs e índices.
2. `CONSTRAINT "MovimientoStock_cantidad_no_cero" CHECK ("cantidad" <> 0)`.
3. `CONSTRAINT "MovimientoStock_motivo_valido" CHECK ("motivo" IN (…))` con la lista de abajo.
4. Saldo inicial, para que el libro cuadre desde el primer día:
   ```sql
   INSERT INTO "MovimientoStock" ("productId", "cantidad", "motivo", "nota", "grupo")
   SELECT "id", "stock", 'saldo_inicial', 'Stock al crear el libro', 'saldo_inicial'
   FROM "Product" WHERE "stock" <> 0;
   ```
5. Stock nunca negativo, como red en la base además de los chequeos en las acciones:
   ```sql
   DO $$ BEGIN
     IF EXISTS (SELECT 1 FROM "Product" WHERE "stock" < 0) THEN
       RAISE EXCEPTION 'Hay piezas con stock negativo: corregirlas antes de migrar (pnpm check:libro las lista).';
     END IF;
   END $$;
   ALTER TABLE "Product" ADD CONSTRAINT "Product_stock_no_negativo" CHECK ("stock" >= 0);
   ```

Como siempre: `pnpm db:migrar --probar` antes de `--aplicar`.

## `lib/stock.ts` (nuevo)

```ts
export const MOTIVOS_STOCK = [
  'saldo_inicial',      // migración
  'alta',               // pieza creada con stock
  'ajuste',             // corrección a mano, con nota obligatoria
  'recepcion',          // caja recibida (fase 3 la unifica para aéreo y marítimo)
  'reversa_recepcion',
  'entrega_propio',     // línea propia aérea que pasa a 'entregado' (hasta la fase 3)
  'reversa_entrega_propio',
  'edicion_pedido',     // editar lo entregado de un pedido propio
  'servido_pedido',     // servir una línea de cliente con lo del depósito
  'devuelto_deposito',  // deshacer lo anterior
  'venta',
  'anulacion_venta',
  'sobrante_recepcion', // fase 3
  'conteo',             // fase 5
] as const
export type MotivoStock = (typeof MOTIVOS_STOCK)[number]

// Signo que exige cada motivo: +1, −1 o 0 (cualquiera: ajuste, conteo, saldo_inicial).
export const SIGNO_MOTIVO: Record<MotivoStock, 1 | -1 | 0>

export interface MovStock {
  productId: number
  cantidad: number
  motivo: MotivoStock
  costoUnitUsd?: number | null
  nota?: string | null
  envioId?: number | null
  pedidoId?: number | null
  pedidoItemId?: number | null
  recepcionId?: number | null
}

// Inserta los movimientos y actualiza Product.stock en UNA sentencia:
//
//   WITH m AS (INSERT INTO "MovimientoStock" (…) VALUES … RETURNING "productId", "cantidad")
//   UPDATE "Product" p SET "stock" = p."stock" + s.delta, "updatedAt" = NOW()
//   FROM (SELECT "productId", SUM("cantidad")::int AS delta FROM m GROUP BY 1) s
//   WHERE p."id" = s."productId"
//
// Corre dentro de la transacción de quien llama. Si deja una pieza en negativo, la base lo
// rechaza (Product_stock_no_negativo) y se convierte en ErrorDeNegocio con el código de la pieza.
// Valida el signo de cada motivo y que `ajuste` traiga nota antes de escribir.
export async function moverStock(tx: Prisma.TransactionClient, movs: MovStock[], grupo?: string): Promise<void>
```

En `lib/prisma-errors.ts`: reconocer la violación de `Product_stock_no_negativo` (código Postgres `23514`; con `$executeRaw` llega como `P2010` con ese código en el mensaje) y traducirla a "No alcanza el stock de X".

## Los lugares que escriben `stock` hoy

Cada uno pasa a llamar a `moverStock`. La regla de negocio y los chequeos que ya tienen se quedan como están.

1. `app/(pages)/products/actions.ts`, crear pieza (`stock: parseInt(…)`) → `alta`.
2. `app/(pages)/products/actions.ts:171`, editar pieza (`deltaDeStock`) → `ajuste`.
3. `app/(pages)/products/actions.ts:222`, edición rápida → `ajuste`.
4. `app/(pages)/envios/linea-actions.ts:302`, `recibirEmbarque` → `recepcion` (cambia en la fase 3).
5. `app/(pages)/envios/linea-actions.ts:347`, `deshacerRecepcion` → `reversa_recepcion`.
6. `lib/mover-etapas.ts:68`, `moverEtapas` (a o desde `entregado`) → `entrega_propio` / `reversa_entrega_propio`. Esta ya es una sola sentencia con CTEs: el `INSERT … RETURNING` se agrega como otra CTE sobre `movidas`, así una fila que otra request ya movió tampoco deja movimiento.
7. `app/(pages)/presupuestos/actions.ts:421`, editar lo entregado de un pedido → `edicion_pedido`.
8. `app/(pages)/presupuestos/flujos-actions.ts:271`, `servirDesdeStock` → `servido_pedido` (con `costoUnitUsd`).
9. `app/(pages)/presupuestos/flujos-actions.ts:307`, `devolverAlDeposito` → `devuelto_deposito`.
10. `app/(pages)/ventas/actions.ts:186`, crear venta → `venta` (con `costoUnitUsd` = `costRealUsd / quantity`).
11. `app/(pages)/ventas/actions.ts:274`, `anularVenta` → `anulacion_venta`.

Para encontrar cualquiera que falte: `grep -rnE '"stock"|stock: \{ ?increment' app lib scripts`. Después de esta fase, ese grep solo debería encontrar `lib/stock.ts`.

## Pantallas

- **`/products/[id]`: "Movimientos de stock".** Fecha, motivo, cantidad, saldo acumulado (`SUM(cantidad) OVER (ORDER BY id)`), nota y el enlace a lo que lo generó (caja, pedido, venta, recepción).
- **Formularios de pieza (`ProductForm`, `QuickEditProduct`):** el stock deja de ser un número absoluto y pasa a "Ajustar: + / − cantidad" con una nota obligatoria. Se mantiene la lógica de `deltaDeStock` (aplicar la diferencia, no el absoluto).

## Chequeos

- **`scripts/check-libro.ts`**, sección nueva "STOCK vs KARDEX": piezas donde `Product.stock` no coincide con `SUM(MovimientoStock.cantidad)`. Solo lee, igual que la sección del depósito.
- **`scripts/check-etapas-sql.ts`**: mover una línea propia a `entregado` crea un movimiento `+n`; sacarla crea `−n`; el doble clic (misma etapa leída) no crea un segundo movimiento; sacar de `entregado` algo ya vendido falla y no deja movimiento.
- **`check:costeo`**: `SIGNO_MOTIVO` (una venta positiva se rechaza, un ajuste sin nota también).

## Hecho cuando

- El grep de arriba solo encuentra `lib/stock.ts`.
- `pnpm check:libro` da 0 desfases contra la copia local de producción.
- La ficha de una pieza muestra su historial completo desde `saldo_inicial`.
