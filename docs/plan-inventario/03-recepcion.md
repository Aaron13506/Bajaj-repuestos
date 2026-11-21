# Fase 3: recepción (llegada, conteo persistido, cierre y backorder)

Requiere la fase 2 (el cierre escribe en el kardex) y aprovecha la fase 1 (lector).

## Qué cambia, en una línea cada uno

- **Llegar y contar se separan.** "Llegó" habilita el conteo en vez de apagarlo.
- **El conteo vive en la base**, no en `localStorage`: se puede escanear con el teléfono y mirar desde la laptop, y queda como registro.
- **Lo que entra es lo contado.** Las diferencias generan sus incidencias al cerrar.
- **Conteo con avisos de falta y sobra por defecto** (el modo ciego sigue disponible como interruptor en la laptop).
- **Al cerrar con faltantes se decide si se espera el resto (backorder) o es faltante definitivo**, como el "¿Crear backorder?" de Odoo.
- **Una recepción cerrada no se reabre.** Se corrige con un ajuste, una incidencia o una reversa completa con contramovimientos.

## Estados de la caja al llegar

1. **En tránsito:** lo de hoy (etapas y tracking).
2. **Llegada:** `Envio.llegadaAt`. No toca stock. Abre la recepción.
3. **En recepción:** `Recepcion` abierta.
4. **Recibida:** `Recepcion.cerradaAt`. Aquí, y solo aquí, se escriben stock e incidencias.

## Esquema

```prisma
model Envio {
  // …
  // Check-in: la caja está en mis manos. No toca stock ni etapas; habilita el conteo.
  // Null = todavía no llegó (o no se marcó). Ver marcarLlegada.
  llegadaAt    DateTime?
  llegadaNota  String?     // "llegó golpeada", "cinta abierta"
  recepciones  Recepcion[]
}

// Un conteo de lo que llegó en una caja. Puede haber más de una por caja (llegó en dos
// partes, o quedó un backorder), pero solo una abierta a la vez (índice parcial en el SQL).
// Abierta = se puede seguir contando desde cualquier dispositivo. Cerrada = ya generó sus
// movimientos de stock e incidencias, y no se edita: se revierte entera o se corrige aparte.
model Recepcion {
  id         Int       @id @default(autoincrement())
  envioId    Int
  ciego      Boolean   @default(false)
  abiertaAt  DateTime  @default(now())
  cerradaAt  DateTime?
  // Revertida con contramovimientos (revertirRecepcion). Una revertida no cuenta para el
  // esperado de la siguiente.
  revertidaAt DateTime?
  notas      String?

  envio      Envio            @relation(fields: [envioId], references: [id], onDelete: Restrict)
  lineas     RecepcionLinea[]
  lecturas   RecepcionLectura[]
  incidencias Incidencia[]

  @@index([envioId])
}

// Una fila de la mesa de conteo: un código físico (los conjuntos ya abiertos en sus piezas,
// la misma pieza de varios pedidos sumada en una fila, igual que piezasAContar).
model RecepcionLinea {
  id          Int      @id @default(autoincrement())
  recepcionId Int
  // Null solo en una pieza "sin identificar" (bloquea el cierre hasta resolverla).
  codigo      String?
  productId   Int?
  nombre      String
  // 0 = no se esperaba (llegó de más o equivocada).
  esperado    Int
  // Caché de SUM(RecepcionLectura.cantidad) no anuladas. Vacío = sin contar; 0 = la busqué y no está.
  contado     Int?
  // Al cerrar, qué se decidió con lo que faltó: 'backorder' (el proveedor lo manda después)
  // o 'faltante' (no va a llegar). Null si no faltó nada.
  decision    String?
  nota        String?

  recepcion Recepcion          @relation(fields: [recepcionId], references: [id], onDelete: Cascade)
  product   Product?           @relation(fields: [productId], references: [id], onDelete: Restrict)
  lecturas  RecepcionLectura[]

  @@unique([recepcionId, codigo])
}

// Cada lectura, cruda: el libro del conteo. RecepcionLinea.contado es su caché.
// Una corrección a mano ("eran 20, no 2") también es una lectura, con la diferencia.
model RecepcionLectura {
  id          Int       @id @default(autoincrement())
  recepcionId Int
  lineaId     Int
  // Lo que leyó la cámara o el lector, tal cual. Vacío en las correcciones a mano.
  raw         String?
  cantidad    Int       // con signo: una corrección puede restar
  origen      String    // 'camara' | 'lector' | 'manual'. CHECK en la base.
  anuladaAt   DateTime? // "deshacer último"
  createdAt   DateTime  @default(now())

  recepcion Recepcion      @relation(fields: [recepcionId], references: [id], onDelete: Cascade)
  linea     RecepcionLinea @relation(fields: [lineaId], references: [id], onDelete: Cascade)

  @@index([recepcionId, createdAt])
}

model Incidencia {
  // …
  // La recepción que la creó al cerrar. Es lo que permite revertir esa recepción
  // borrando solo las incidencias que ella misma generó (si siguen abiertas).
  recepcionId Int?
  recepcion   Recepcion? @relation(fields: [recepcionId], references: [id], onDelete: SetNull)
}
```

Y `MovimientoStock.recepcionId` (de la fase 2) gana su relación.

## Migración: `prisma/manual/AAAA-MM-DD-recepciones.sql`

- Las tablas, FKs e índices.
- **Una sola abierta por caja:**
  `CREATE UNIQUE INDEX "Recepcion_una_abierta" ON "Recepcion" ("envioId") WHERE "cerradaAt" IS NULL;`
- CHECKs: `RecepcionLectura_origen_valido`, `RecepcionLinea_decision_valida` (`NULL`, `'backorder'`, `'faltante'`), `RecepcionLinea_esperado_no_negativo`, `RecepcionLinea_contado_no_negativo`, y `Recepcion_revertida_solo_cerrada` (`revertidaAt` solo si hay `cerradaAt`).
- **Cajas que ya llegaron antes de esto**, para que no vuelvan a pedir conteo:
  - Marítimas `estado = 'entregado'`: `llegadaAt = entregadoAt`.
  - Aéreas: `llegadaAt = MIN(PedidoItemEtapa.at)` de sus líneas con `hacia = 'en_venezuela'`.
  - No se les crea `Recepcion`. La pantalla dice "Recibida antes del registro de recepciones".

## Reglas puras: `lib/recepcion.ts`

Todas con casos en `check:costeo`.

- **`esperadoDeRecepcion(caja, recepcionesAnteriores)`**: arma las filas a partir de `piezasAContar` (lo de hoy) menos lo ya contado en recepciones cerradas y no revertidas de la misma caja. Así un backorder que llega después se cuenta en una segunda recepción con solo lo que faltaba.
- **`repartirConteo(lineasDeLaCaja, contadoPorCodigo)`**: decide qué líneas (`PedidoItem`) quedan cubiertas. Orden propuesto (decisión pendiente en el README): **primero los pedidos de cliente del más viejo al más nuevo, al final los propios**. Un conjunto queda completo solo si están todas sus piezas; si no, la incidencia lleva `pieza` (`etiquetaPieza`).
- **`planCierre(recepcion, reparto, decisiones)`**: devuelve, sin tocar la base, todo lo que el cierre va a escribir: movimientos de stock, incidencias, cambios de etapa y sobrantes. La acción solo ejecuta el plan. Es lo que hace testeable el cierre.
- **`puedeCerrar(recepcion)`**: todas las filas con `contado` no vacío, ninguna "sin identificar", ninguna fila contada sin `productId` (código fuera del catálogo), y una `decision` en cada fila con faltante.
- **`transicionManualPermitida(desde, hacia, linea)`**: ver "El stepper" más abajo.

## Acciones: `app/(pages)/envios/recepcion-actions.ts` (nuevo)

Todas devuelven `ActionResult`, usan `conErrorDeNegocio` y toman primero un candado de la recepción (`bloquearRecepcion(tx, id)`: `SELECT … FOR UPDATE` y verificar que siga abierta), con el mismo patrón que `bloquearPedido`.

- **`marcarLlegada(envioId, nota?)`**: `updateMany where { id, llegadaAt: null, estado: not 'borrador' }` y crea la recepción abierta con `esperadoDeRecepcion`. Si ya había llegada, no hace nada. También se puede abrir una recepción antes de marcar llegada, como hoy permite "abrirlo antes".
- **`registrarLectura(recepcionId, raw, origen)`**: `leerCodigo` + `resolverLectura` (fase 1) contra las filas. Inserta la `RecepcionLectura` y hace `contado = COALESCE(contado, 0) + n` en la misma transacción. Si el código no está en la caja, crea una fila con `esperado = 0`. Devuelve el estado de la fila para el aviso ("+2 (bolsa) DH181135 → 4/6", o "4" a secas si es ciego).
- **`corregirConteo(lineaId, nuevoTotal)`**: inserta una lectura `manual` con la diferencia (puede ser negativa). No se escribe `contado` directo: siempre pasa por lecturas.
- **`deshacerLectura(lecturaId)`**: `anuladaAt = now()` y resta su cantidad de `contado`. Solo con la recepción abierta.
- **`anotarSinIdentificar(recepcionId, nota)`** y **`identificar(lineaId, productId)`**: la fila sin código y su resolución (se fusiona con la fila de ese código si ya existe).
- **Código que no está en el catálogo:** `registrarLectura` crea la fila con `codigo` y `productId` vacío, y la pantalla ofrece "Crear pieza" (abre el alta con el código puesto). Al crearla, la fila se enlaza sola por código. Como no se puede sumar stock a una pieza que no existe, `puedeCerrar` exige que toda fila con conteo tenga `productId`, o que se descarte.
- **`cerrarRecepcion(recepcionId, decisiones)`**: ver abajo.
- **`revertirRecepcion(recepcionId)`**: ver abajo.

## El cierre

En una transacción, ejecutando `planCierre`:

1. Guarda: `updateMany where { id, cerradaAt: null }` → `cerradaAt = now()`. Si `count = 0`, otra pestaña ya cerró.
2. **Aéreo (líneas de pedido):**
   - Línea de cliente cubierta → `en_venezuela` (vía `moverEtapas`, que deja su `PedidoItemEtapa`).
   - Línea propia cubierta → `entregado` y movimiento `recepcion` por lo contado. Con eso desaparece el paso manual de pasar lo propio a `entregado` para que entre al stock.
   - Línea con faltante y decisión `backorder` → incidencia `sin_enviar` (la semántica que ya existe: el proveedor no lo mandó todavía). Si es la línea entera, queda fuera de `en_venezuela` como hoy hace `lineaNoViene`.
   - Línea con faltante y decisión `faltante` → incidencia `faltante` con la cantidad. La línea pasa igual a `en_venezuela`, con la incidencia abierta, que es la práctica de hoy, pero ahora la crea el sistema.
3. **Marítimo (`EnvioLinea`, stock propio):** movimiento `recepcion` por lo contado de cada pieza, con `costoUnitUsd` del landed de esa caja (`costo-envios.ts`). La caja pasa a `estado = 'entregado'`. Las diferencias quedan registradas en `RecepcionLinea` (esperado contra contado). No hay incidencia porque no hay pedido. Un backorder se cuenta en una segunda recepción de la misma caja.
4. **Sobrantes y no esperadas** (`contado > esperado`): movimiento `sobrante_recepcion` con `costoUnitUsd` vacío hasta decidir (ver README). Si un código esperado faltó y llegó otro en su lugar, la pantalla de cierre ofrece anotarlo como `equivocada` en la línea del esperado.
5. Cada incidencia creada lleva `recepcionId`.
6. `revalidatePath` de la caja, `/envios`, `/inventario`, `/products`, `/presupuestos`, `/contabilidad` y `/`.

**Pantalla de cierre** (reemplaza el `alertdialog` actual de `ConteoCaja`): la lista de diferencias, y en cada faltante la pregunta "¿Esperas el resto?" con **Sí, llega después** (backorder) y **No, es faltante**. El botón final está deshabilitado mientras `puedeCerrar` sea falso, y dice por qué.

## La reversa

`revertirRecepcion(recepcionId)` es la versión con kardex de `deshacerRecepcion`, y la reemplaza:

- Solo una cerrada y no revertida.
- Se niega si alguna pieza ya no tiene en stock lo que esa recepción sumó (la misma regla de hoy; con la fase 2, el CHECK de stock no negativo lo garantiza también en la base).
- Se niega si alguna incidencia con su `recepcionId` ya tiene resolución o movimientos de plata. Si siguen abiertas, las borra.
- Escribe contramovimientos `reversa_recepcion`, devuelve las líneas a `camino_venezuela` (aéreo) o la caja a `confirmado` (marítimo), marca `revertidaAt` y abre una recepción nueva con el esperado completo.

## El stepper (`EnvioItemsTable` y `saveItemChanges`)

Para que nadie salte el conteo, `transicionManualPermitida` (usada por la tabla para esconder la opción y por `saveItemChanges` como candado):

- **No se puede mover a mano hacia `en_venezuela` o `entregado`** desde una etapa anterior a `en_venezuela`. Eso solo lo hace `cerrarRecepcion`.
- **No se puede mover a mano hacia atrás** desde `en_venezuela` o `entregado` a una etapa anterior. Eso solo lo hace `revertirRecepcion`.
- **Sí se puede** pasar una línea de cliente de `en_venezuela` a `entregado`: es la entrega al cliente (`ConfirmarEntregaForm`), no la recepción.
- **Excepciones:** las líneas `isLanded` (no viajan en la caja) y las servidas desde el depósito (`desdeStock`, que ya nacen en `en_venezuela`).

Lo mismo para el marítimo: el botón que marcaba `entregado` desaparece; solo lo pone el cierre.

## Tracking

`pnpm tracking:sync` puede **avisar** (por ntfy) que One Way o el courier marcó la caja como entregada, con un enlace a "Marcar llegada". Nunca la marca solo, siguiendo la regla de que lo que trae Track123 no mueve etapas.

## La pantalla de la caja (`/envios/[id]`, pestaña "Llegada")

- **Sin llegada:** botón "Marcar llegada" (con nota opcional) y, como hoy, la opción de contar antes.
- **Recepción abierta:** "Contar y recibir" siempre visible, con el progreso (`12 de 18 códigos contados`) y un QR que abre la misma recepción en el teléfono (`/escanear/recepcion/[id]`, ver fase 6). La tabla se refresca con `router.refresh()` cada 3 s mientras esté abierta.
- **Ciego:** la columna "Esperado" y el botón ✓ ("llegó todo") se ocultan hasta que la fila tiene `contado`. Un interruptor por recepción lo apaga.
- **Cerrada:** solo lectura. Esperado, contado, diferencia y decisión por fila; enlaces a las incidencias y a los movimientos de stock; botón "Revertir recepción". Si quedó un backorder, "Contar lo que faltaba" abre la siguiente recepción.
- **Mientras haya una recepción abierta, el contenido de la caja no se edita** (agregar o quitar líneas cambiaría el esperado a mitad del conteo).

## Lo que se borra

- El `localStorage` de `ConteoCaja` y su prop `recibir`.
- `recibirEmbarque` y `deshacerRecepcion` (`linea-actions.ts`), reemplazadas por `cerrarRecepcion` y `revertirRecepcion`.
- El `saveItemChanges(…, 'en_venezuela')` que hoy usa el conteo aéreo.

## Chequeos

- **`check:costeo`:** `repartirConteo` (cliente viejo antes que nuevo, propio último, conjuntos incompletos), `planCierre` (backorder contra faltante, sobrante, no esperada), `puedeCerrar`, `transicionManualPermitida`.
- **`check:etapas`:** cerrar dos veces no duplica movimientos ni incidencias; lecturas concurrentes suman bien; revertir con stock consumido falla sin dejar nada a medias; revertir con una incidencia ya resuelta falla.
- **`check:libro`:** cada `RecepcionLinea.contado` coincide con la suma de sus lecturas no anuladas.

## Hecho cuando

- Una caja real se marca como llegada, se cuenta desde el teléfono mientras la laptop muestra el progreso, se cierra con un faltante en backorder y otro definitivo, y el stock sube exactamente lo contado.
- Mover una línea a `en_venezuela` desde el stepper ya no es posible.
