-- Los ensambles salen de `Product` a su propia tabla.
--
-- Un ensamble nunca fue un producto: es la página de 99rpm que AGRUPA piezas. Vivía en
-- `Product` con `isAssembly = true` y arrastraba todas las columnas de una pieza sin usar
-- ninguna — en producción, de 1520 ensambles: 0 con peso, 0 con medidas, 0 con priceInr,
-- 0 con margen, 0 con landed, 0 con bajajCode, 0 descontinuados, 0 con stock. Lo único que
-- usan es nombre, título original, motos, URL de origen e imagen.
--
-- Compartir la tabla obligaba a cada consulta a recordar `isAssembly` para no mezclar, y
-- dejaba escribir sobre el ensamble cosas que solo tienen sentido en una pieza: entregar un
-- conjunto de un pedido `propio` le sumaba el stock AL ENSAMBLE (una fila que nadie mira)
-- en vez de a sus piezas, y la guarda de descontinuadas revisaba un `discontinuedAt` que
-- un ensamble nunca tiene.
--
-- Los ids se PRESERVAN. Con eso:
--   · ProductComponent.parentId ya apunta a la fila correcta: la tabla se renombra y se le
--     cambia la FK, sin reescribir sus ~14,6k filas.
--   · PedidoItem.ensambleId es el mismo número que el productId que tenía.
--   · /products/<id> de un ensamble viejo redirige 1:1 a /ensambles/<id> (Product no
--     reusa ids, así que no hay ambigüedad).
--
-- Precio del conjunto: a propósito, un ensamble NO tiene precio. Casi nunca se vende
-- completo — en el armador se destildan piezas y se cambian cantidades —, así que el precio
-- de una línea de conjunto se calcula en el front sobre las piezas elegidas y se congela en
-- PedidoItem.salePrice. 3 ensambles tenían un precio fijo (`price` + `priceLocked`) que el
-- armador ya ignoraba desde julio, y que se había quedado viejo (Accesorios N250 vendía a
-- pérdida contra el landed de sus piezas). No se migra. Para el registro, los valores eran:
--   5559 Accesorios N250 $60.00 · 5101 Fuel Pump $75.00 · 5558 Oil Filter $4.00
--
-- Todo en una transacción: si cualquier chequeo falla no queda nada a medias.

BEGIN;

-- ── 0. Chequeos previos ──────────────────────────────────────────────────────────────
-- El plan asume un grafo limpio (ensamble → pieza, nunca al revés) y que fuera de
-- ProductComponent y PedidoItem nada apunta a un ensamble. Hoy es así; acá lo garantiza el
-- SQL y no la memoria de quien lo corre.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "ProductComponent" c JOIN "Product" p ON p.id = c."childId" WHERE p."isAssembly";
  IF n > 0 THEN RAISE EXCEPTION '% componentes tienen un ENSAMBLE como hijo', n; END IF;

  SELECT count(*) INTO n FROM "ProductComponent" c JOIN "Product" p ON p.id = c."parentId" WHERE NOT p."isAssembly";
  IF n > 0 THEN RAISE EXCEPTION '% componentes tienen una PIEZA como padre', n; END IF;

  SELECT count(*) INTO n FROM "EnvioLinea" l JOIN "Product" p ON p.id = l."productId" WHERE p."isAssembly";
  IF n > 0 THEN RAISE EXCEPTION '% EnvioLinea apuntan a un ensamble', n; END IF;

  SELECT count(*) INTO n FROM "SupplierPrice" s JOIN "Product" p ON p.id = s."productId" WHERE p."isAssembly";
  IF n > 0 THEN RAISE EXCEPTION '% SupplierPrice apuntan a un ensamble', n; END IF;

  SELECT count(*) INTO n FROM "ScrapedPart" s JOIN "Product" p ON p.id = s."matchedProductId" WHERE p."isAssembly";
  IF n > 0 THEN RAISE EXCEPTION '% ScrapedPart apuntan a un ensamble', n; END IF;

  -- Un conjunto de pedido se reconoce por su snapshot de piezas. Si alguna línea rompe esa
  -- equivalencia, el CHECK de más abajo fallaría con un mensaje menos legible.
  SELECT count(*) INTO n FROM "PedidoItem" pi JOIN "Product" p ON p.id = pi."productId"
   WHERE p."isAssembly" <> (pi."bundleItems" IS NOT NULL);
  IF n > 0 THEN RAISE EXCEPTION '% PedidoItem no coinciden ensamble <-> bundleItems', n; END IF;

  -- El nombre en inglés es la identidad del ensamble (el que publica 99rpm) y la columna es
  -- NOT NULL: uno vacío haría fallar el INSERT de más abajo con un mensaje poco legible.
  SELECT count(*) INTO n FROM "Product" WHERE "isAssembly" AND (NULLIF(trim("nameEn"), '') IS NULL);
  IF n > 0 THEN RAISE EXCEPTION '% ensambles no tienen nameEn (nombre en inglés)', n; END IF;

  -- Datos de pieza cargados en un ensamble: se perderían al borrar la fila.
  SELECT count(*) INTO n FROM "Product" WHERE "isAssembly" AND (
    "weightGrams" IS NOT NULL OR "dimL" IS NOT NULL OR "dimA" IS NOT NULL OR "dimH" IS NOT NULL
    OR "priceInr" IS NOT NULL OR "landedCostUsd" IS NOT NULL OR "margin" IS NOT NULL
    OR "bajajCode" IS NOT NULL OR "discontinuedAt" IS NOT NULL OR "stock" <> 0
    OR "description" IS NOT NULL OR "notes" IS NOT NULL);
  IF n > 0 THEN RAISE EXCEPTION '% ensambles tienen datos de pieza que se perderían', n; END IF;
END $$;

-- ── 1. Ensamble ──────────────────────────────────────────────────────────────────────
CREATE TABLE "Ensamble" (
    "id"               SERIAL NOT NULL,
    "nameEs"           TEXT,
    "nameEn"           TEXT NOT NULL,
    "compatibleModels" TEXT NOT NULL,
    "sourceUrl"        TEXT,
    "imageUrl"         TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ensamble_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Ensamble_sourceUrl_key" ON "Ensamble"("sourceUrl");

INSERT INTO "Ensamble" ("id", "nameEs", "nameEn", "compatibleModels", "sourceUrl", "imageUrl", "createdAt", "updatedAt")
SELECT "id", "nameEs", "nameEn", "compatibleModels", "sourceUrl", "imageUrl", "createdAt", "updatedAt"
FROM "Product"
WHERE "isAssembly";

-- La secuencia sigue desde el id más alto copiado: los ensambles nuevos no chocan con los
-- migrados. (Con la tabla vacía, `false` deja el próximo nextval en 1.)
SELECT setval('"Ensamble_id_seq"', COALESCE((SELECT max("id") FROM "Ensamble"), 1), (SELECT count(*) > 0 FROM "Ensamble"));

-- ── 2. ProductComponent → EnsambleComponente ─────────────────────────────────────────
ALTER TABLE "ProductComponent" RENAME TO "EnsambleComponente";
ALTER TABLE "EnsambleComponente" RENAME COLUMN "parentId" TO "ensambleId";
ALTER TABLE "EnsambleComponente" RENAME COLUMN "childId" TO "productId";

ALTER TABLE "EnsambleComponente" RENAME CONSTRAINT "ProductComponent_pkey" TO "EnsambleComponente_pkey";
ALTER SEQUENCE "ProductComponent_id_seq" RENAME TO "EnsambleComponente_id_seq";
ALTER INDEX "ProductComponent_parentId_childId_groupName_key" RENAME TO "EnsambleComponente_ensambleId_productId_groupName_key";

-- La FK del padre deja de apuntar a Product. La del hijo sigue apuntando a Product: solo
-- cambia de nombre.
ALTER TABLE "EnsambleComponente" DROP CONSTRAINT "ProductComponent_parentId_fkey";
ALTER TABLE "EnsambleComponente" RENAME CONSTRAINT "ProductComponent_childId_fkey" TO "EnsambleComponente_productId_fkey";
ALTER TABLE "EnsambleComponente" ADD CONSTRAINT "EnsambleComponente_ensambleId_fkey"
    FOREIGN KEY ("ensambleId") REFERENCES "Ensamble"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- "¿En qué ensambles está esta pieza?" (la ficha de la pieza y el listado de /products) no
-- tenía índice: el único arrancaba por el padre.
CREATE INDEX "EnsambleComponente_productId_idx" ON "EnsambleComponente"("productId");

-- ── 3. PedidoItem: una línea es una pieza O un conjunto ──────────────────────────────
ALTER TABLE "PedidoItem" ADD COLUMN "ensambleId" INTEGER;
ALTER TABLE "PedidoItem" ALTER COLUMN "productId" DROP NOT NULL;

UPDATE "PedidoItem" pi
   SET "ensambleId" = pi."productId", "productId" = NULL
  FROM "Product" p
 WHERE p.id = pi."productId" AND p."isAssembly";

ALTER TABLE "PedidoItem" ADD CONSTRAINT "PedidoItem_ensambleId_fkey"
    FOREIGN KEY ("ensambleId") REFERENCES "Ensamble"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "PedidoItem_pedidoId_ensambleId_key" ON "PedidoItem"("pedidoId", "ensambleId");

-- Prisma no modela CHECKs; viven solo acá. Son lo que impide volver a mezclar.
ALTER TABLE "PedidoItem" ADD CONSTRAINT "PedidoItem_pieza_xor_conjunto"
    CHECK (num_nonnulls("productId", "ensambleId") = 1);
ALTER TABLE "PedidoItem" ADD CONSTRAINT "PedidoItem_conjunto_lleva_piezas"
    CHECK (("ensambleId" IS NULL) = ("bundleItems" IS NULL));

-- ── 4. Product queda solo con piezas ─────────────────────────────────────────────────
DELETE FROM "Product" WHERE "isAssembly";
ALTER TABLE "Product" DROP COLUMN "isAssembly";

-- ── 5. Resultado ─────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE 'Ensamble: %, EnsambleComponente: %, Product: %, PedidoItem conjunto: %, PedidoItem pieza: %',
    (SELECT count(*) FROM "Ensamble"),
    (SELECT count(*) FROM "EnsambleComponente"),
    (SELECT count(*) FROM "Product"),
    (SELECT count(*) FROM "PedidoItem" WHERE "ensambleId" IS NOT NULL),
    (SELECT count(*) FROM "PedidoItem" WHERE "productId" IS NOT NULL);
END $$;

COMMIT;
