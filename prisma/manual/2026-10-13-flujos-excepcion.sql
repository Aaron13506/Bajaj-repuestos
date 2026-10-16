-- Los flujos que faltaban fuera del camino feliz (docs/REVISION-NEGOCIO.md, punto 2):
--   · cancelar un pedido                       → Pedido.canceladoAt / canceladoMotivo
--   · pedidos derivados (reposición, sobrante) → Pedido.origenId / origenMotivo
--   · validez del presupuesto y su escalón     → Pedido.cotizadoAt / escalonCotizadoPct
--   · historial de lo que se hizo sobre un pedido → PedidoEvento
--   · historial de etapas de cada línea        → PedidoItemEtapa
--   · problemas de una línea (no disponible, dañada, perdida, faltante, reclamo…) → Incidencia
--   · guía de la caja                          → Envio.guia / transportista
--
-- Nada de esto cambia lo que ya está guardado: todas las columnas nuevas nacen en NULL y las
-- tablas nuevas nacen vacías. Un presupuesto anterior sin `cotizadoAt` se sigue leyendo con su
-- fecha de creación y con el escalón de hoy, como hasta ahora.

ALTER TABLE "Pedido"
  ADD COLUMN "canceladoAt"        TIMESTAMP(3),
  ADD COLUMN "canceladoMotivo"    TEXT,
  ADD COLUMN "cotizadoAt"         TIMESTAMP(3),
  ADD COLUMN "escalonCotizadoPct" DECIMAL(5, 2),
  ADD COLUMN "origenId"           INTEGER,
  ADD COLUMN "origenMotivo"       TEXT;

ALTER TABLE "Pedido"
  ADD CONSTRAINT "Pedido_origenId_fkey"
  FOREIGN KEY ("origenId") REFERENCES "Pedido"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Pedido_origenId_idx" ON "Pedido"("origenId");

-- Un pedido derivado dice de dónde viene Y por qué; los dos o ninguno.
ALTER TABLE "Pedido" ADD CONSTRAINT "Pedido_origen_coherente"
  CHECK (("origenId" IS NULL AND "origenMotivo" IS NULL)
      OR ("origenMotivo" IN ('reposicion', 'sobrante')));

-- Cancelado = tiene fecha, y solo un pedido cancelado la tiene.
ALTER TABLE "Pedido" ADD CONSTRAINT "Pedido_cancelado_coherente"
  CHECK (("status" = 'cancelado') = ("canceladoAt" IS NOT NULL));

-- ── Historial de lo que se hizo sobre un pedido ─────────────────────────────────────────────
CREATE TABLE "PedidoEvento" (
  "id"        SERIAL PRIMARY KEY,
  "pedidoId"  INTEGER NOT NULL,
  "tipo"      TEXT NOT NULL,
  "detalle"   TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PedidoEvento_pedidoId_fkey"
    FOREIGN KEY ("pedidoId") REFERENCES "Pedido"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PedidoEvento_pedidoId_createdAt_idx" ON "PedidoEvento"("pedidoId", "createdAt");

-- ── Historial de etapas de cada línea ───────────────────────────────────────────────────────
-- Lo que ya existe solo guardaba la ÚLTIMA fecha (PedidoItem.shippingStatusAt). Desde ahora cada
-- cambio de etapa deja su fila, y de ahí sale cuánto tarda de verdad cada tramo. Las líneas
-- anteriores no tienen historia y no se inventa: empiezan a tenerla en su próximo movimiento.
CREATE TABLE "PedidoItemEtapa" (
  "id"     SERIAL PRIMARY KEY,
  "itemId" INTEGER NOT NULL,
  "desde"  TEXT NOT NULL,
  "hacia"  TEXT NOT NULL,
  "at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PedidoItemEtapa_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "PedidoItem"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PedidoItemEtapa_itemId_at_idx" ON "PedidoItemEtapa"("itemId", "at");
CREATE INDEX "PedidoItemEtapa_hacia_idx" ON "PedidoItemEtapa"("hacia");

-- ── Incidencias: lo que le pasa a una línea fuera del camino feliz ──────────────────────────
-- Cuelga del PEDIDO (y no solo de la línea) porque una línea puede desaparecer —se reembolsó
-- entera— y el costo que se perdió tiene que seguir en el pedido. `descripcion` es el nombre de
-- la pieza en ese momento, por la misma razón.
CREATE TABLE "Incidencia" (
  "id"             SERIAL PRIMARY KEY,
  "pedidoId"       INTEGER NOT NULL,
  "itemId"         INTEGER,
  "descripcion"    TEXT NOT NULL,
  "tipo"           TEXT NOT NULL,
  "origen"         TEXT NOT NULL DEFAULT 'operacion',
  "cantidad"       INTEGER NOT NULL,
  "nota"           TEXT,
  "estado"         TEXT NOT NULL DEFAULT 'abierta',
  "resolucion"     TEXT,
  "perdidaUsd"     DECIMAL(10, 2),
  "reposicionId"   INTEGER,
  "creadaAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resueltaAt"     TIMESTAMP(3),
  CONSTRAINT "Incidencia_pedidoId_fkey"
    FOREIGN KEY ("pedidoId") REFERENCES "Pedido"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Incidencia_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "PedidoItem"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Incidencia_reposicionId_fkey"
    FOREIGN KEY ("reposicionId") REFERENCES "Pedido"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Incidencia_tipo_valido"
    CHECK ("tipo" IN ('no_disponible', 'danada', 'perdida', 'faltante', 'equivocada', 'defecto')),
  CONSTRAINT "Incidencia_origen_valido" CHECK ("origen" IN ('operacion', 'cliente')),
  CONSTRAINT "Incidencia_estado_valido" CHECK ("estado" IN ('abierta', 'resuelta')),
  CONSTRAINT "Incidencia_resolucion_valida"
    CHECK ("resolucion" IS NULL OR "resolucion" IN ('llego', 'reposicion', 'reembolso', 'rechazado', 'sustituida')),
  CONSTRAINT "Incidencia_cantidad_positiva" CHECK ("cantidad" > 0),
  CONSTRAINT "Incidencia_perdida_no_negativa" CHECK ("perdidaUsd" IS NULL OR "perdidaUsd" >= 0),
  -- Resuelta si y solo si dice cómo y cuándo.
  CONSTRAINT "Incidencia_resuelta_coherente"
    CHECK (("estado" = 'resuelta') = ("resolucion" IS NOT NULL AND "resueltaAt" IS NOT NULL))
);
CREATE INDEX "Incidencia_pedidoId_idx" ON "Incidencia"("pedidoId");
CREATE INDEX "Incidencia_itemId_idx" ON "Incidencia"("itemId");
CREATE INDEX "Incidencia_estado_idx" ON "Incidencia"("estado");

-- ── La guía de la caja ──────────────────────────────────────────────────────────────────────
ALTER TABLE "Envio"
  ADD COLUMN "guia"          TEXT,
  ADD COLUMN "transportista" TEXT;
