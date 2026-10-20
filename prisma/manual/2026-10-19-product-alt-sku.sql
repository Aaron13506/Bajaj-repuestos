-- El segundo número Bajaj de una pieza vivía solo en ScrapedPart: una pieza cargada a mano, o
-- una que un proveedor empezó a mandar con un código nuevo, no tenía dónde anotarlo, y los
-- buscadores (menos el del embarque) solo miraban bajajCode. Ver lib/alt-sku.ts.
ALTER TABLE "Product" ADD COLUMN "altSku" TEXT;

-- Arranca con los pares que ya publicaba 99rpm. Solo los inequívocos: si un código aparece en
-- dos pares con alternos distintos no se elige ninguno (el mismo criterio que alternosDe).
WITH pares AS (
  SELECT UPPER(TRIM("sku")) AS a, UPPER(TRIM("altSku")) AS b FROM "ScrapedPart" WHERE "altSku" IS NOT NULL
), lados AS (
  SELECT a AS mio, b AS otro FROM pares UNION SELECT b, a FROM pares
), unico AS (
  SELECT mio, MIN(otro) AS otro FROM lados WHERE mio <> otro GROUP BY mio HAVING COUNT(DISTINCT otro) = 1
)
UPDATE "Product" p SET "altSku" = u.otro
FROM unico u
WHERE UPPER(TRIM(p."bajajCode")) = u.mio;
