-- Proveedor que despacha por su cuenta (Garuda Impex: India Post directo a USA, DDP)
-- más la comisión de la transferencia con la que se le paga.
--
-- Dos cambios de modelo, y los dos salen de lo mismo: hoy viajan en paralelo una caja de
-- Shoppre y una de Garuda.
--
-- 1) `origen` decía a la vez dónde está la mercancía Y cómo se cobra el tramo a USA,
--    porque coincidía (India ⇒ Shoppre, China ⇒ monto a mano). Garuda es de India y
--    despacha él mismo, así que hizo falta `inbound` para lo segundo.
--
-- 2) El proveedor pasa a ser de la CAJA y no de cada línea. La caja es la compra: se le
--    compró a alguien, y todo lo que va adentro se le compró a esa misma persona. Elegirlo
--    por línea permitía el estado imposible de una caja de Garuda con una línea marcada
--    Shoppre, que además costeaba mal en silencio. `Envio.supplierId` ya existía para el
--    marítimo; ahora aplica a las dos rutas.
--
-- El default 'shoppre' es exactamente lo que eran las filas anteriores: todo lo comprado
-- hasta acá pasó por Shoppre. Los proveedores de China quedan en 'shoppre' en la columna
-- pero el código los lee como 'cotizado' (lib/inbound.ts) — ese tramo nunca tuvo tabla.
--
-- La comisión NO se guarda como regla en Supplier: no es un rasgo del proveedor sino de
-- cada giro (se le transfiere a algunos y a otros no, y el banco cobra distinto cada vez).
-- Es un monto que se anota por caja.

-- AlterTable
ALTER TABLE "Supplier"   ADD COLUMN "inbound" TEXT NOT NULL DEFAULT 'shoppre';

-- AlterTable
ALTER TABLE "PedidoItem" ADD COLUMN "inbound" TEXT NOT NULL DEFAULT 'shoppre';

-- AlterTable
-- `inboundChinaUsd` era literalmente este dato, pero cableado a un solo origen: asumía que
-- el único proveedor sin tabla de tarifas iba a ser el chino. Se renombra en vez de crear
-- una segunda columna con el mismo significado (está en NULL en las 3 filas, así que el
-- rename no arrastra nada).
ALTER TABLE "Envio" RENAME COLUMN "inboundChinaUsd" TO "tramoUsd";

-- AlterTable
-- Null ⇒ no se cargó, que NO es cero: cero es "ese giro no costó nada" y es un dato
-- distinto. Las pantallas muestran "sin cargar" para el primero.
ALTER TABLE "Envio" ADD COLUMN "comisionUsd" DECIMAL(10,2);

-- Garuda Impex es el proveedor que motivó todo esto: despacha por India Post a USA con un
-- total DDP. La comisión de sus giros no se toca acá — se anota caja por caja.
UPDATE "Supplier" SET "inbound" = 'cotizado' WHERE "name" = 'Garuda Impex';
