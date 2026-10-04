# Auditoría de código — 2026-10-02

Revisión manual de server actions, componentes cliente, `lib/` y API, más chequeos automáticos.
Cada hallazgo trae **dónde**, **qué pasa**, **cómo se reproduce** y **cómo arreglarlo**.
Están ordenados por prioridad; marcá la casilla al cerrar cada uno.

> **Alcance de este documento:** solo **detecta y registra**. No se modificó código del proyecto para escribirlo. Los "Fix" de cada hallazgo son el criterio propuesto, no cambios hechos. Las verificaciones contra la base fueron consultas de solo lectura. Un hallazgo nuevo se investiga y se agrega acá; arreglarlo es un trabajo aparte, que se pide explícitamente.

## Estado verificado al momento de la revisión

| Chequeo | Resultado |
|---|---|
| `pnpm typecheck` | ✅ sin errores |
| `pnpm lint` | ✅ 0 errores, 0 warnings (eran 14, ver [P3-6](#p3-6)) |
| `pnpm check:costeo` | ✅ todo ok |
| `pnpm check:libro` (nuevo, solo lee) | ✅ 30/30 pedidos coinciden con el libro; sin ingresos huérfanos ni stock negativo (verificado 2026-10-02, antes y después de los cambios de P0) |
| Consulta de solo lectura a `Config` | ❌ hay una fila `$ACTION_ID_40db9b73…` (ver [P1-1](#p1-1)) |

Hay trabajo **sin commitear** (flete en vivo en `/envios`: `lib/costo-envios.ts`, `repartirCostoReal`, borrado de `saveEstimate`). Lo que lo afecta está en la sección [Trabajo en curso](#trabajo-en-curso).

### Leyenda

- **P0**: plata o stock mal registrados, o datos que se pierden. Arreglar primero.
- **P1**: funcionalidad rota o que miente en pantalla.
- **P2**: UX/React: botones que se traban, errores invisibles, dobles envíos.
- **P3**: limpieza, rendimiento, deuda.

---

## P0 — Integridad de plata y stock

### P0-1. Recibir / deshacer recepción de un embarque puede sumar el stock dos veces
- [x] **Dónde:** `app/(pages)/envios/linea-actions.ts:251` (`recibirEmbarque`), `:276` (`deshacerRecepcion`); botones en `app/(pages)/envios/[id]/maritimo.tsx:321-355`.
- **Qué pasa:** se lee `estado === 'confirmado'` y *después* se corre la transacción que incrementa stock. Entre la lectura y la escritura no hay cerrojo, y los botones son `<button type="submit">` planos (sin `PendingButton`, sin `confirm`). Un doble click, o dos pestañas, ejecutan las dos requests: las dos leen `confirmado` y las dos suman. Lo mismo al revés con `deshacerRecepcion` (resta dos veces y puede dejar stock negativo).
- **Repro:** embarque marítimo cerrado → doble click rápido en "Marcar recibido" → cada pieza queda con el doble de stock.
- **Fix:** hacer que el cambio de estado sea la condición de la transacción:
  ```ts
  await db.$transaction(async tx => {
    const r = await tx.envio.updateMany({
      where: { id: envioId, modo: 'maritimo_cbm', estado: 'confirmado' },
      data: { estado: 'entregado', entregadoAt: new Date() },
    })
    if (r.count === 0) return            // otra request ya la recibió
    const lineas = await tx.envioLinea.findMany({ where: { envioId } })
    for (const l of lineas) {
      await tx.product.update({ where: { id: l.productId }, data: { stock: { increment: l.quantity } } })
    }
  })
  ```
  Igual para `deshacerRecepcion` (`estado: 'entregado'` → `'confirmado'`). Si se quiere evitar la transacción interactiva (latencia a us-west-2), alternativa: `UPDATE ... RETURNING` vía `$queryRaw`. Además: usar `PendingButton` en los cuatro botones y `confirm()` en "Marcar recibido" y "Deshacer recepción". `cerrarEmbarque`/`reabrirEmbarque` conviene pasarlos al mismo patrón `updateMany where estado`.
- **Resuelto (2026-10-02):** las cuatro transiciones usan `updateMany where estado = <esperado>` y solo corren el efecto si `count === 1`. El stock se mueve con **una** sentencia (`UPDATE "Product" … FROM "EnvioLinea"`) en vez de un `update` por línea (una caja trae ~180). Los cuatro botones pasaron a `PendingButton` (que ahora acepta `confirmMessage`) y recibir / deshacer / reabrir piden confirmación. De regalo (era un punto de P3-7): `deshacerRecepcion` se niega, revirtiendo todo, si el stock ya no alcanza para restar lo que sumó la caja.

### P0-2. `registrarCompra` puede registrar el mismo pago dos veces y pisar costos reales
- [x] **Dónde:** `lib/movimientos.ts:465` (`estimarCostos`) y `:469` (`registrarCompra`); disparado desde `components/RegistrarCompraPicker.tsx`.
- **Qué pasa:** el picker solo muestra ítems con `costRealUsd: null`, pero la acción vuelve a buscar los ítems por `id IN (...)` **sin** ese filtro. Un doble submit o una pestaña vieja crea **dos egresos** `pago_proveedor` (el saldo de caja baja el doble) y re-escribe `costRealUsd` de ítems que ya lo tenían.
- **Fix:** filtrar `costRealUsd: null` en `estimarCostos` y abortar si la cantidad encontrada no coincide con la pedida (devolver error al cliente, ver [P2-1](#p2-1)). Hacer el update condicional (`updateMany where { id, costRealUsd: null }`) dentro de la misma transacción.
- **Extra:** el reparto redondea cada parte a centavos y la suma puede diferir de `monto` en ±$0,01–0,0n. Asignarle el residuo a la última línea para que `Σ costRealUsd === monto`.
- **Resuelto (2026-10-02):** `estimarCostos` filtra `costRealUsd: null` y, si vuelven menos piezas de las pedidas, rechaza todo con un mensaje (no reparte el monto entero entre unas pocas). La escritura es un único `UPDATE … FROM (VALUES …) WHERE costRealUsd IS NULL` dentro de la transacción: si actualiza menos filas que las pedidas, aborta y con ella el egreso. El residuo no va a *una* línea sino por **mayor resto** (`lib/reparto-compra.ts`), que además no puede dejar partes negativas; `Σ costRealUsd === monto` al centavo. `registrarCompra` devuelve `ActionResult` y el picker muestra el error sin limpiar lo tipeado (de paso corrige ahí el `e.currentTarget` de P2-2).

### P0-3. `crearMovimiento` no actualiza `depositUsd`, pero `eliminarMovimiento` sí lo descuenta
- [x] **Dónde:** `app/(pages)/contabilidad/actions.ts:24` vs `:61`.
- **Qué pasa:** un ingreso cargado desde `/contabilidad` con `pedidoId` (`pago_cliente`/`adelanto_cliente`) crea el `Movimiento` pero **no** suma a `Pedido.depositUsd` (la caché que leen cobranza y clientes). Si después se borra ese movimiento, `eliminarMovimiento` **sí** resta del depósito → el pedido muestra menos cobrado del real (o `null`).
- **Repro:** pedido con adelanto $100 → en Contabilidad, ingreso "Pago de cliente" $50 ligado al pedido → depósito sigue en $100 (mal) → borrar ese movimiento → depósito queda en $50 (peor).
- **Fix:** que `crearMovimiento`, cuando `tipo === 'ingreso' && pedidoId`, haga lo mismo que `registrarPagoPedido` (incrementar `depositUsd` en la misma transacción). Mejor aún: extraer una sola función `registrarIngresoPedido(tx, …)` que usen las tres acciones.
- **Resuelto (2026-10-02):** `registrarIngresoPedido` / `ajustarDeposito` / `bloquearPedido` en `lib/movimientos.ts`, usadas por `crearMovimiento` (ingreso + pedido), `registrarPagoPedido` y `aprobarPedido`. El depósito se mueve con `UPDATE … COALESCE("depositUsd",0) + x` (no "leer, sumar, escribir"). `eliminarMovimiento` pasó a `deleteMany` + `count`: repetirlo ya no tira P2025 ni resta dos veces (cubre su parte de DUP-4).

### P0-4. Bajar un adelanto deja el libro inflado
- [x] **Dónde:** `app/(pages)/presupuestos/actions.ts:276` (`aprobarPedido`).
- **Qué pasa:** si se carga $1000 por error y se corrige a $100, `depositUsd` baja a 100 pero el `Movimiento` de $1000 queda. El saldo de caja (que suma movimientos) queda $900 arriba para siempre. También: dejar el campo vacío pone `depositUsd = null` sin tocar el libro. Además la lectura de `actual` está **fuera** de la transacción (carrera con `registrarPagoPedido`).
- **Fix:** en una corrección a la baja, crear un movimiento compensatorio (p.ej. categoría nueva `correccion_ingreso` de tipo egreso, o un ingreso negativo) **o** ajustar/eliminar el movimiento de adelanto original. Mover la lectura de `actual` dentro de `$transaction(async tx => …)`. Rechazar vacío/NaN cuando el pedido ya tiene depósito.
- **Resuelto (2026-10-02):** se eligió la segunda opción del Fix: **ajustar el libro, no compensar con un movimiento nuevo.** Bajar el adelanto recorta/borra los ingresos del pedido del más reciente al más viejo (`descontarIngresosPedido`), así `Σ ingresos = depositUsd` siempre y no hace falta una categoría `correccion_ingreso`. Una devolución *real* al cliente es otro hecho y va como egreso aparte. La lectura del depósito ocurre dentro de la transacción bajo `SELECT … FOR UPDATE`, así que un doble envío ve el resultado del primero. Campo vacío con plata ya cobrada se rechaza ("escribí 0"). `aprobarPedido` devuelve `ActionResult` y `AprobarPedidoForm` muestra el error y no se cierra.

### P0-5. Borrar un proveedor re-costea en silencio cajas históricas y borra todos sus precios
- [x] **Dónde:** `app/(pages)/suppliers/actions.ts:69` (`deleteSupplier`) + `onDelete` del schema.
- **Qué pasa:** `SupplierPrice` es `Cascade` (se borra toda su lista de precios), `Envio.supplierId` y `PedidoItem.supplierId` son `SetNull`. Una caja de Garuda pasa a ser "99rpm": `calcEnvio` deja de recibir `proveedor`, el `tramoUsd` y las comisiones dejan de aplicarse y el landed histórico cambia. `Movimiento.supplierId` también queda en null.
- **Fix:** bloquear el borrado si el proveedor tiene `envios`, `pedidoItems` o `movimientos` (contar y devolver error). Si se quiere "retirarlo", agregar `Supplier.archivedAt` y filtrarlo de los selectores.
- **Resuelto (2026-10-02):** `motivoProveedorEnUso` (`lib/proveedor-en-uso.ts`) la usan la página (en vez de "Eliminar" muestra 🔒 con el motivo) y `deleteSupplier` (el cerrojo real, dentro de una transacción). **No se agregó `archivedAt`** (pide migración sobre la base de producción): sigue siendo decisión tuya si querés poder "retirar" proveedores con historia.

### P0-6. Borrar un presupuesto/pedido con plata o logística asociada
- [x] **Dónde:** `app/(pages)/presupuestos/actions.ts:348` (`deletePresupuesto`).
- **Qué pasa:** borra el pedido y en cascada sus ítems aunque estén comprados, viajando en una caja o con adelanto cobrado. Los `Movimiento` quedan con `pedidoId = null` (ingreso huérfano en el libro), las cajas pierden líneas sin aviso, y en `tipo='propio'` el stock ya sumado queda sin explicación.
- **Fix:** permitir borrar solo si `status === 'presupuesto'`, sin movimientos y sin ítems con `envioId`/`shippingStatus !== 'pendiente'`. Para lo demás, un estado `cancelado` en vez de borrar.
- **Resuelto (2026-10-02):** `motivoNoEliminable` (`lib/pedido-eliminable.ts`, cubierto por `check:costeo`): un pedido de **cliente** solo se borra mientras es `presupuesto`; el **stock propio** (que nace como `pedido`) se rige por lo que le pasó. En ambos casos se bloquea con plata cobrada, movimientos, `costRealUsd`, línea en una caja o línea ya comprada. La lista y la ficha muestran 🔒 con el motivo en lugar de "Eliminar"; `deletePresupuesto` lo re-chequea en una transacción. **No se agregó el estado `cancelado`**: tocaría cobranza, clientes y totales (todo lo que filtra por `status`), así que queda como decisión aparte.

### P0-7. Editar un pedido `propio` no corrige el stock ya entregado
- [x] **Dónde:** `app/(pages)/presupuestos/actions.ts:194` (`updatePresupuesto`).
- **Qué pasa:** el stock propio es editable siempre. Si una línea ya está `entregado` (y por lo tanto ya sumó a `Product.stock` en `saveItemChanges`), cambiarle la cantidad o borrarla no ajusta el stock.
- **Fix:** en las líneas que existen y están `entregado`, aplicar `stock: { increment: nueva - vieja }` (o `decrement` al borrarlas) dentro de la misma `$transaction`; o bloquear la edición de líneas ya entregadas.
- **Resuelto (2026-10-02):** se eligió ajustar: para cada línea `entregado` de un pedido `propio`, cambiar la cantidad aplica `increment: nueva − vieja` y sacarla resta su cantidad, todo en la misma `$transaction` de la edición. Si el stock quedaría negativo (se vendió lo que se quiere "des-entregar") la acción se niega con un mensaje y no cambia nada.

### P0-8. "Cuentas por pagar" mezcla fletes con la deuda al proveedor e ignora el marítimo
- [x] **Dónde:** `lib/movimientos.ts:262` (`cuentasPorPagar`) y `app/(pages)/envios/[id]/page.tsx:186` (`egresosCaja`).
- **Qué pasa:**
  1. `pagado` suma **todos** los egresos ligados a la caja, incluidos `flete_aereo`/`flete_maritimo` (que se le pagan a Shoppre / la naviera, no al proveedor). Pagar el flete "reduce" lo que se le debe al proveedor.
  2. `debido` solo mira `PedidoItem.costRealUsd`. Un embarque marítimo tiene `EnvioLinea` (sin costo real) → su mercadería + FOB nunca aparecen como deuda.
  3. Las cajas sobrepagadas (`pendiente < 0`) desaparecen del listado.
- **Fix:** filtrar `categoria IN ('pago_proveedor','comision_giro')` para `pagado`. Para el marítimo, usar `costoEmbarque(...).giroUsd` (mercancía + FOB) como `debido`. Mostrar sobrepagos aparte.
- **Resuelto (2026-10-02):** `CATEGORIAS_PAGO_PROVEEDOR` (`pago_proveedor` + `comision_giro`) es la única definición de "pagado al proveedor" y la usan `cuentasPorPagar` y la ficha de la caja (`envios/[id]/page.tsx`). Para el marítimo, `debido` = `costoEmbarque(...).giroUsd` (mercancía + FOB; sin el flete por m³, que es de la naviera) + comisiones, con la mercancía costeada igual que la ficha de la caja (precio del proveedor, o catálogo si no hay). `cuentasPorPagar()` ahora devuelve `{ pendientes, sobrepagadas }` y Contabilidad muestra un bloque **"Pagado de más"** (solo cuando el debido está completo: contra un piso no se puede afirmar un sobrepago). **Ojo:** la rama marítima no tiene dato real contra qué probarse todavía — hoy la única caja marítima (#5) está en borrador.

---

## DUP — Acciones que se ejecutan más de una vez

Inventario completo de los puntos de entrada a server actions, con la protección que tienen hoy contra el doble envío (doble click, Enter repetido, dos pestañas, reintento de red).

**Por qué pasa:** con la base en us-west-2 cada acción tarda entre 200 ms y varios segundos, y durante ese tiempo nada impide volver a clickear. Además, React 19 **encola** los envíos sucesivos de un `<form action={…}>` y los ejecuta todos, uno detrás del otro: no los descarta. Un botón que no se deshabilita produce N ejecuciones.

**Dos capas, y hacen falta las dos:**
- **Cliente:** el botón se deshabilita mientras la acción está en vuelo. Frena el doble click, pero no dos pestañas, ni un reintento, ni un formulario reenviado tras un error.
- **Servidor:** la acción es idempotente (repetirla deja la base igual) o condiciona la escritura al estado que leyó. Es la única capa que protege la plata y el stock.

**Base de datos (consulta de solo lectura, 2026-10-02):** no encontré registros duplicados con pocos segundos de diferencia en `Envio`, `Movimiento`, `Pedido` ni `Cliente`. Los `Product` homónimos creados con segundos de diferencia ("Cylinder Head", "Crankcase LH"…) son ensambles del seed, uno por moto, y son legítimos. Es decir: el riesgo está abierto, pero no dejó basura que haya que limpiar.

> **Avance (2026-10-03, al cerrar P2):** los botones de `createEnvio`, `createSupplier`, `createCliente` y los de costos/medidas de la caja ya se bloquean en el cliente (DUP-1), y los paneles de pagos cortan el segundo envío con una guarda. Del lado del servidor no cambió nada ahí: las altas de plata siguen necesitando la clave de idempotencia del final de esta sección.
>
> **Avance (2026-10-02, al cerrar P0):** quedaron cubiertas con protección en el servidor `recibirEmbarque`, `deshacerRecepcion`, `cerrarEmbarque`, `reabrirEmbarque`, `registrarCompra` (ya no registra dos veces) y `aprobarPedido` (el segundo envío ve el depósito del primero y no anota nada). Los cuatro botones del embarque ya usan `PendingButton`. **Siguen abiertas** `createEnvio`, `crearMovimiento`, `registrarPagoProveedor`, `registrarPagoPedido`, `createPresupuesto` y el resto de la tabla: son altas de plata que solo se protegen de verdad con una clave de idempotencia (migración), ver el final de esta sección.
>
> **Avance (2026-10-03, DUP-3 y DUP-5):** `saveItemChanges` ya no puede acreditar el stock dos veces y el `guardar` del embarque marítimo ya no se traba (ver más abajo). Lo único que queda abierto de esta sección es la clave de idempotencia de las altas.

### DUP-1. Formularios sin ningún bloqueo en el cliente
Son `<button type="submit">` planos dentro de un `<form action={…}>`: no se deshabilitan nunca. `PendingButton` (`components/PendingButton.tsx`) existe para esto, pero se usa en un solo lugar.

| Dónde | Acción | Qué pasa con 2 envíos |
|---|---|---|
| `app/(pages)/envios/page.tsx:137` | `createEnvio` | ❌ **Se crean dos cajas** (el servidor no deduplica). |
| `app/(pages)/envios/[id]/maritimo.tsx:343` | `recibirEmbarque` | ❌ **El stock se suma dos veces** (ver P0-1). |
| `app/(pages)/envios/[id]/maritimo.tsx:332` | `deshacerRecepcion` | ❌ **El stock se resta dos veces**, y puede quedar negativo (P0-1). |
| `app/(pages)/envios/[id]/maritimo.tsx:322` | `cerrarEmbarque` | ✅ Inofensivo: el segundo ve que ya no está en borrador. |
| `app/(pages)/envios/[id]/maritimo.tsx:351` | `reabrirEmbarque` | ✅ Inofensivo (mismo motivo). |
| `app/(pages)/suppliers/page.tsx:104` | `createSupplier` | ⚠️ El segundo choca con `name @unique` → error P2002 sin manejar → página de error. |
| `app/(pages)/clientes/page.tsx:72` | `createCliente` | ⚠️ El segundo encuentra el que creó el primero y redirige a `?existe=…`: el usuario ve "ese cliente ya existe" justo después de crearlo. |
| `app/(pages)/config/page.tsx:178` | `saveConfig` | ⚠️ Idempotente, pero tarda ~5 s (P1-1), así que es donde más fácil se clickea dos veces; cada envío reescribe todas las claves. |
| `app/(pages)/envios/[id]/page.tsx:873` · `maritimo.tsx:529` | `saveCostosProveedor` | ✅ Idempotente (escribe valores absolutos). |
| `app/(pages)/envios/[id]/page.tsx:1014` | `saveMedidasCaja` | ✅ Idempotente. |
| `app/(pages)/suppliers/page.tsx:172` | `renameSupplier` | ✅ Idempotente. |
| `app/(pages)/clientes/[id]/page.tsx:79` | `updateCliente` | ✅ Idempotente. |
| `components/AddComponentForm.tsx:86` · `AddToAssemblyForm.tsx:81` | `addComponent` / `addToAssembly` | ✅ Idempotente (`upsert`). |

### DUP-2. Bloqueo en el cliente, pero la acción no es idempotente en el servidor
Estos botones sí se deshabilitan (`isPending`, `submitting` o `useFormStatus`), así que el doble click común está cubierto. Pero el servidor no se defiende: dos pestañas, un reintento o un reenvío tras un error duplican el registro.

| Dónde (cliente → servidor) | Qué se duplica |
|---|---|
| `MovimientoForm.tsx` → `crearMovimiento` (`contabilidad/actions.ts:24`) | Un ingreso/egreso más en el libro: el saldo de caja queda mal. |
| `RegistrarPagoProveedorForm.tsx` → `registrarPagoProveedor` (`envios/actions.ts:255`) | Un egreso más contra la caja: "pagado" se infla. |
| `RegistrarPagoClienteForm.tsx` → `registrarPagoPedido` (`presupuestos/actions.ts:322`) | Un ingreso más **y** `depositUsd` sube dos veces: el cliente figura con más pagado. |
| `RegistrarCompraPicker.tsx` → `registrarCompra` (`lib/movimientos.ts:469`) | Dos egresos `pago_proveedor`, y se pisa `costRealUsd` (P0-2). |
| `AprobarPedidoForm.tsx` → `aprobarPedido` (`presupuestos/actions.ts:276`) | Si dos requests leen el depósito anterior antes de que ninguna escriba (la lectura está fuera de la transacción), las dos crean el movimiento por el delta: adelanto anotado dos veces. |
| `PresupuestoBuilder.tsx:469` → `createPresupuesto` | Un segundo pedido idéntico. |
| `ProductForm.tsx` → `createProduct` | Un producto duplicado (y su enlace al ensamble si vino con `parentId`). |
| `ImportProductsForm.tsx` → `importProducts` | Reimportar el mismo JSON crea **todo** de nuevo (no busca por SKU, ver P1-5). |

### DUP-3. Cambios de estado en la tabla del envío que pueden sumar stock dos veces
- [x] **Resuelto (2026-10-03)** — ver al final de esta sección.
- **Dónde:** `components/EnvioItemsTable.tsx` (`aplicar`/`aplicarA`, ~línea 136) → `saveItemChanges` (`app/(pages)/envios/actions.ts:293`).
- **Qué pasa:** cada cambio de select dispara un guardado y **no se bloquea** mientras hay otro en vuelo (no hay chequeo de `guardando`). En el servidor, para los pedidos `propio`, el ajuste de stock depende de comparar el estado leído con el nuevo (`eraEntregado !== quedaEntregado`). Si dos requests que llevan la misma línea a `entregado` leen ambas el estado anterior antes de que la otra escriba, **las dos suman la cantidad a `Product.stock`**. Se da al aplicar el estado a todo un presupuesto desde la cabecera y volver a hacerlo antes de que termine, o con dos pestañas.
- **Además:** el `update` de la línea no está condicionado al estado leído (`where: { id }` y no `where: { id, shippingStatus: <leído> }`), que es lo que haría que la segunda request no encuentre nada que cambiar.

### DUP-4. Borrados repetidos que terminan en página de error
- **Dónde:** `components/DeleteButton.tsx` → `deleteEnvio`, `deletePresupuesto`, `deleteProduct`, `deleteCliente`, `deleteSupplier`, `eliminarMovimiento`, `removeComponent`.
- **Qué pasa:** el botón se deshabilita con `isPending`, pero si la segunda ejecución llega (dos pestañas, reintento), Prisma tira `P2025` (no existe) y, como ninguna lo captura, termina en la página de error genérica. No duplica datos; es ruido que parece una falla.
- `eliminarMovimiento` en particular está bien protegido: busca el movimiento dentro de la transacción y no hace nada si ya no existe.

### DUP-5. Handlers que no liberan el bloqueo si algo falla
- [x] **Resuelto (2026-10-03)** — ver al final de esta sección.
Están relacionados con el doble envío porque empujan a recargar y reintentar:
- `components/EmbarqueMaritimo.tsx:290` (`guardar`): `setGuardando(true)` sin `try/finally`. Si `sincronizarLineas` tira (y no solo devuelve `ok: false`), "Guardar" queda deshabilitado hasta recargar la página.
- `components/PresupuestoBuilder.tsx:469` y `components/BundlePriceEditor.tsx:24`: ver P2-5.

**Resuelto (2026-10-03):** `guardar` de `EmbarqueMaritimo` ahora libera el botón en un `finally` y, si la acción rechaza (no solo si devuelve `ok: false`), muestra el error y conserva el borrador. Los otros dos ya estaban resueltos con P2-5.

### DUP-3 — cómo quedó
- **Servidor (`saveItemChanges`):** cada fila viaja con el estado que se leyó (`desde`) y el que se quiere (`hacia`), y todo el lote es **una sentencia SQL**: un `UPDATE … WHERE shippingStatus = desde … RETURNING` dentro de un CTE, y el ajuste de stock sale de las filas que de verdad se movieron. Si dos requests llevan la misma línea a `entregado`, la segunda espera el candado de la fila, la encuentra ya movida y no actualiza nada — así que no acredita el stock por segunda vez. El cambio de estado y su stock no pueden separarse (antes eran operaciones sueltas dentro de un `$transaction` armado con lo leído). Verifiqué el SQL contra la base con `EXPLAIN` (sin ejecutar): es válido y usa `PedidoItem_pkey` y `Product_pkey`. **No lo ejecuté contra datos reales** (escribiría stock en producción): la primera vez conviene mover una línea de un pedido `propio` a entregado y de vuelta, mirando el stock del producto.
- **Cliente (`EnvioItemsTable`):** los selects se deshabilitan mientras se guarda, y `aplicarA` se corta con un candado en un `useRef` (el `isPending` recién se ve en el render siguiente) **antes** de pintar el cambio, para no mostrar un estado que nunca se mandó.
- **Lo que cambia visiblemente:** si otra pestaña ya movió esa línea, tu cambio se descarta en silencio y la pantalla vuelve a mostrar lo que hay (revalida). No hay mensaje de "otro usuario ya la cambió".
- **No cubre** el caso de un `delta` que deje el stock negativo (des-entregar algo ya vendido): sigue sin chequearse, igual que antes.

### Qué haría falta, para registrar el criterio (sin implementar)
- **Cliente:** todo `type="submit"` dentro de un `<form action>` debe usar `PendingButton`. Los handlers manuales deberían cortar con un `useRef` ("ya hay uno en vuelo") además del `disabled`, porque `isPending` recién se ve en el próximo render. Sumar `confirm()` a recibir/deshacer recepción.
- **Servidor, transiciones de estado** (recibir, deshacer, `saveItemChanges`, `registrarCompra`): condicionar la escritura al estado leído (`updateMany where { id, estado/shippingStatus/costRealUsd: <leído> }`) y seguir solo si `count === 1`.
- **Servidor, altas de plata** (`crearMovimiento`, `registrarPagoProveedor`, `registrarPagoPedido`, `createPresupuesto`, `createEnvio`): no se pueden volver idempotentes por estado. La forma estándar es una **clave de idempotencia**: el formulario genera un `crypto.randomUUID()` al renderizarse y lo manda oculto, y la tabla lo guarda con `@unique` (p.ej. `Movimiento.requestId`). El segundo envío choca con la clave y se descarta. Requiere una migración, así que es una decisión a tomar.

---

## P1 — Funcionalidad rota o que miente

### P1-1. `saveConfig` guarda basura de Next y "refresca" tasas viejas
- [x] **Dónde:** `app/(pages)/config/actions.ts:17-35`, `app/(pages)/config/page.tsx:77`.
- **Qué pasa (confirmado en la base):**
  1. El filtro excluye `'$ACTION_ID'` exacto, pero Next manda `$ACTION_ID_<hash>`. Resultado: existe la fila `Config.$ACTION_ID_40db9b732c927a18146593ac1f4900e9be221a7165`, que además la página muestra como un campo "extra" editable.
  2. Se hace `upsert` de **todas** las claves en cada guardado, cambien o no. Eso actualiza `updatedAt` de las tasas que escribe el cron (`inr_usd_rate`, `bsd_usd_rate`, `bcv_*`) → el indicador "hace X" que existe justamente para detectar un cron caído queda en "hace 0 min". Y si el cron corrió entre que se abrió la página y se guardó, se pisa la tasa nueva con la vieja.
  3. Son N upserts **en serie** (~28 claves × ~200 ms ≈ 5–6 s por guardado).
- **Fix:**
  ```ts
  if (!key || key.startsWith('$ACTION') || typeof value !== 'string') continue
  ```
  Leer los valores actuales y escribir **solo los que cambiaron**, en un único `db.$transaction([...])`. Aceptar solo claves de `FIELD_META` (+ las extra existentes). Borrar la fila basura:
  `DELETE FROM "Config" WHERE key LIKE '$ACTION%';`
  Revisar también si `active_supplier_id` y `app_modo` siguen teniendo sentido (no los lee ningún código; ver [P3-3](#p3-3)).
- **Resuelto (2026-10-02):** `saveConfig` descarta toda clave que empiece con `$` (el filtro anterior comparaba contra `'$ACTION_ID'` exacto y Next manda `$ACTION_ID_<hash>`), acepta solo claves de `FIELD_META` o que ya existan, **lee lo que hay y escribe solo lo que cambió** en un único `$transaction`, y el botón pasó a `PendingButton`. Para no deshacer lo que escribió el cron, el formulario manda un campo oculto (`__cargado`) con el `updatedAt` más nuevo de las tasas al abrirse: si el cron escribió una tasa *después*, no se pisa con el valor viejo y la página avisa cuál. Sin cambios muestra "No había nada que guardar". `FIELD_META` se mudó a `config/campos.ts` porque lo comparten la página y la acción.
  **Fila basura borrada (2026-10-03):** era exactamente una, `$ACTION_ID_40db9b73…`, con valor vacío; ya no queda ninguna clave que empiece con `$`.

### P1-2. Quick edit con "comparar contra proveedor" pisa el precio base del producto
- [x] **Dónde:** `app/(pages)/products/actions.ts:105` (`quickUpdateProduct`), `components/QuickEditProduct.tsx:111-116,224`, `app/(pages)/products/page.tsx:168`.
- **Qué pasa:** `?proveedor=X` en `/products` es un **filtro de comparación**, pero se pasa como `activeSupplierId` al modal de edición. En ese modo:
  - el cliente calcula landed y precio con `'maritimo_cbm'`, pero el server recalcula con el default `'aereo'` → lo que ves no es lo que se guarda;
  - el server escribe en `Product.landedCostUsd` un landed **del proveedor** y en `Product.price` el precio que el modal derivó del landed marítimo. CLAUDE.md dice lo contrario: el precio de venta y el landed del producto salen siempre del carril aéreo con 99rpm, y `SupplierPrice` no toca el precio base.
- **Fix:** en modo proveedor, `quickUpdateProduct` debe escribir **solo** `SupplierPrice` (precio, `isLanded`, idealmente `moq`) y los campos físicos/descriptivos; nunca `landedCostUsd`/`price`/`margin`. El landed y precio del producto se recalculan siempre con `reprice()` (`lib/reprice.ts`) sobre `priceInr` y `'aereo'`, igual que `applyMeasures`.
- **Resuelto (2026-10-02):** `quickUpdateProduct` separa los dos modos. **Con proveedor** solo escribe `SupplierPrice` (precio e `isLanded`) y los campos físicos/descriptivos de la pieza; nunca `price`, `margin`, `priceLocked` ni un landed del proveedor. Si el peso o las medidas cambiaron, re-costea la pieza con `reprice()` (aéreo, sobre el ₹ base), igual que `applyMeasures`; si no cambiaron, no toca ni el precio ni el landed. **Sin proveedor** queda como siempre. El modal en modo proveedor ya no ofrece margen, precio de venta ni candado: muestra el precio vigente de la pieza como solo lectura y el landed marítimo rotulado "referencia". **No agregué `moq`** al modal (el `upsert` no lo toca, así que editar un precio no lo borra); queda para cuando se quiera cargarlo desde ahí.

### P1-3. Los errores de server actions no se ven en producción (no hay `error.tsx`)
- [x] **Dónde:** `app/(pages)/` (solo existe `loading.tsx`). Acciones que hacen `throw` con mensajes pensados para el usuario: `parseItems`, `bloquearDescontinuadas` y el candado de `updatePresupuesto` (`presupuestos/actions.ts`), `findUniqueOrThrow` en varias, y cualquier `P2003` (ver P1-4).
- **Qué pasa:** en producción Next **oculta** el mensaje de errores lanzados en el server ("An error occurred in the Server Components render…") y, sin `error.tsx`, cae a la página de error genérica. Todo el cuidado puesto en los mensajes ("Bajaj no la fabrica más: sacala…") nunca llega al usuario.
- **Fix:**
  1. Agregar `app/(pages)/error.tsx` (client component con botón "Reintentar") como red de seguridad.
  2. Para errores esperables, **devolver** `{ ok: false, error }` en vez de `throw`, y consumirlo con `useActionState` (ver P2-1). `sincronizarLineas` ya sigue este patrón; replicarlo.
- **Resuelto (2026-10-02):** `app/(pages)/error.tsx` (con botón "Reintentar" y el `digest` para buscarlo en los logs de Heroku). Y los errores esperables dejaron de tirarse: `ErrorDeNegocio` + `conErrorDeNegocio` (en `lib/action-result.ts`) convierten en `{ ok: false, error }` lo que antes era `throw`/`return` mudo en `createPresupuesto` y `updatePresupuesto` (sin cliente, sin líneas, JSON ilegible, pieza descontinuada, pedido ya confirmado, stock que no alcanza). `PresupuestoBuilder` muestra el mensaje y libera el botón. Los bloqueos de P0-5/P0-6 (`deleteSupplier`, `deletePresupuesto`) también devuelven su motivo: eran `throw`, y en producción su texto nunca llegaba. `DeleteButton` ahora lee ese resultado y lo muestra. Las acciones que no son de presupuestos se convirtieron con P2-1.

### P1-4. Borrar un producto en uso revienta con un 500
- [x] **Dónde:** `app/(pages)/products/actions.ts:173` (`deleteProduct`); botones en `products/[id]/page.tsx:171` y `components/ProductRow.tsx:249`.
- **Qué pasa:** `PedidoItem.product`, `EnvioLinea.product` y `ProductComponent.child` son `Restrict` → Prisma tira `P2003`. La API (`app/api/products/[id]/route.ts`) ya lo traduce a 409; la server action no. Además, borrando desde la ficha no hay `redirect('/products')`: si sale bien, el usuario queda parado en una URL que ahora es 404.
- **Fix:** capturar `P2003` y devolver un error legible; `redirect('/products')` cuando se borra desde la ficha. Considerar contar usos antes y ocultar el botón.
- **Resuelto (2026-10-02):** `deleteProduct` cuenta primero qué la retiene (`motivoProductoEnUso`, `lib/producto-en-uso.ts`: líneas de pedido, líneas de embarque marítimo, ensambles que la usan) y devuelve el motivo; el `P2003` queda de red por si algo la toma entre el conteo y el borrado, y un `P2025` (ya borrada) cuenta como éxito. Desde la ficha, `deleteProduct.bind(null, id, true)` redirige a `/products`. **No oculté el botón** en el listado (habría que sumar tres `_count` a cada fila de 20): se ofrece y, si está en uso, explica por qué no.

### P1-5. El importador de productos duplica piezas que ya existen y saltea la validación de medidas
- [x] **Dónde:** `app/(pages)/products/import/actions.ts:131-215`.
- **Qué pasa:** siempre hace `product.create`, sin buscar por `bajajCode` (ni por SKU alterno). Importar un ensamble cuyas piezas ya están en el catálogo crea **filas duplicadas** — lo opuesto al modelo de compatibilidad cruzada (una pieza = una fila con todas sus motos). Además escribe peso/dimensiones sin pasar por `chequearMedidas` (`lib/measures-check.ts`), que CLAUDE.md define como *el* gate (el caso del spoiler de 1 g puede volver a entrar por acá).
- **Fix:** resolver cada pieza por `bajajCode` + `lib/alt-sku.ts`; si existe, enlazarla (y agregar la moto a `compatibleModels`) en vez de crearla. Pasar `chequearMedidas` a los datos físicos y reportar rechazos igual que `applyMeasures`. Actualizar `IMPORTAR-PRODUCTOS.md` (dice "margen fijo 40%"; en realidad sale de `default_margin_pct`).
- **Resuelto (2026-10-02):** las piezas se reconocen por `bajajCode` cruzando el alterno (`equivalenciasDe`), con una sola consulta previa. Si ya existen se **enlazan** y su moto se **suma** a `compatibleModels`; su precio, peso y medidas no se pisan. La misma pieza en dos subgrupos del JSON es una fila. Si los dos códigos de una pieza son filas distintas del catálogo, se avisa y no se toca. Un ensamble se reconoce por nombre + motos (solo si trae motos), y un enlace que ya existía (`P2002`) no es error: **reimportar el mismo JSON ya no duplica**. Peso y medidas pasan por `chequearMedidas`: si son imposibles, la pieza se crea sin ellas y la página lo dice. El resultado trae `linked` además de `created`. `IMPORTAR-PRODUCTOS.md` actualizado (margen por defecto, enlace, gate). **No lo probé contra un JSON real** (escribiría en producción): el tipado, el build y el SQL de resolución (que sí corrí, de solo lectura) pasan, pero conviene un primer import chico mirando el resultado.

### P1-6. El importador de precios de proveedor no cruza SKU alterno, ignora MOQ y es lento
- [x] **Dónde:** `app/(pages)/suppliers/[id]/import/actions.ts:79-104`.
- **Qué pasa:** matchea solo por `bajajCode` exacto; CLAUDE.md marca que cada proveedor cotiza con *uno* de los dos números de Bajaj → muchas filas salen "SKU no encontrado". No importa `moq`. Hace un `upsert` por fila **en serie** (500 precios ≈ 100 s → riesgo de timeout del request en Heroku, 30 s).
- **Fix:** resolver con `equivalenciasDe()` de `lib/alt-sku.ts`; aceptar `moq` en el JSON; agrupar en `db.$transaction([...upserts])` por lotes de ~200.
- **Resuelto (2026-10-02):** resuelve con `equivalenciasDe` y busca solo los códigos necesarios (ya no baja el catálogo entero; la comparación es sin distinguir mayúsculas). Acepta `moq` (o `minQty`) y rechaza uno menor a 1; sin `moq` en el JSON no borra el que ya estaba cargado. Escribe con **un solo `INSERT … ON CONFLICT DO UPDATE` por tanda de 400** en vez de un `upsert` por fila: no era el `$transaction` por lotes que sugería el Fix, porque con la base en us-west-2 eso sigue siendo un viaje por sentencia. Un mismo producto repetido en la lista (sus dos numeraciones) se avisa y gana el último, porque Postgres no deja tocar una fila dos veces en un `INSERT`. Verifiqué con `EXPLAIN` (sin ejecutar) que el SQL es válido y usa el índice único como árbitro. El formulario y su prompt mencionan `moq`.

### P1-7. Redirect a una ruta que no existe (`/envios/plan`)
- [x] **Dónde:** `app/(pages)/presupuestos/actions.ts:164-167`, `components/PresupuestoBuilder.tsx:90-103,485`, comentario en `components/Sidebar.tsx:119`.
- **Qué pasa:** si llega `volver=plan`, se redirige a `/envios/plan`, que no existe (404). Es código muerto del planificador viejo.
- **Fix:** borrar la prop `volver`, el campo del form, la rama del redirect y el comentario del Sidebar.
- **Resuelto (2026-10-02):** ninguna pantalla pasaba `volver`; se borró la prop, el campo del form, la rama del redirect y el texto del Sidebar (la lógica de "gana el prefijo más largo" se queda, solo cambió el comentario).

### P1-8. Asignar ítems a una caja no valida la caja
- [x] **Dónde:** `app/(pages)/envios/actions.ts:51` (`assignPedido`), `:69` (`assignItems`), `:108` (`asignarAEnvio`), `:162` (`assignAllConfirmados`).
- **Qué pasa:** ninguna verifica que el envío exista, sea `aereo` ni que no esté entregado. Con un id viejo se puede colgar un `PedidoItem` de un embarque marítimo (que no muestra `items`, así que la línea "desaparece"). Con un id inexistente, error de FK sin manejar.
- **Fix:** en `asignarAEnvio`, leer `modo`/`estado` y cortar si no es `aereo`. Devolver error legible.
- **Resuelto (2026-10-02):** `asignarAEnvio` lee `modo` y `estado` junto con el proveedor y devuelve un motivo si la caja no existe, no es aérea o ya se entregó. Las tres puertas (`assignPedido`, `assignItems`, `assignAllConfirmados`) devuelven `ActionResult`. `SueltoPedido` lo muestra, y para los `<form action>` que no tenían dónde mostrarlo se agregó `FormConResultado` (un `<form>` que sí lo muestra y deja funcionar `PendingButton`).

### P1-9. `mercanciaEnCamino` cuenta como "en camino" lo que todavía no se compró
- [x] **Dónde:** `lib/movimientos.ts:188`.
- **Qué pasa:** el filtro es solo `!isDelivered`, así que un pedido `propio` recién creado (todas sus líneas en `pendiente`, sin comprar) suma a "mercancía en camino" en Contabilidad. El comentario de la función dice "que ya se compró".
- **Fix:** `pendientes = itemsPropios.filter(it => isBought(it.shippingStatus) && !isDelivered(it.shippingStatus))`. Detalle menor: `aereoUnidades` se suma también para ítems sin costo y el marítimo no — unificar el criterio.
- **Resuelto (2026-10-02):** el filtro es `isBought && !isDelivered`. De regalo, `aereoUnidades` solo cuenta las líneas que entran a la suma (igual que el marítimo), así que "unidades" y "valor" hablan del mismo conjunto; las que no tienen costo siguen en `sinCosto`.

### P1-10. Fechas por defecto corridas un día en la tarde-noche
- [x] **Dónde:** `new Date().toISOString().slice(0, 10)` en `AperturaCajaForm.tsx:16`, `AprobarPedidoForm.tsx:32`, `MovimientoForm.tsx:54`, `RegistrarCompraPicker.tsx:22`, `RegistrarPagoClienteForm.tsx:16`, `RegistrarPagoProveedorForm.tsx:23`.
- **Qué pasa:** `toISOString()` es UTC. En Venezuela (UTC-4), desde las 20:00 el campo propone la fecha de **mañana**, y si no se corrige el movimiento queda con fecha futura (y cae en otro mes en los reportes de fin de mes).
- **Fix:** helper `hoyLocal()` en `lib/utils.ts`:
  ```ts
  export const hoyLocal = () => new Date().toLocaleDateString('en-CA') // YYYY-MM-DD en la zona del navegador
  ```
- **Resuelto (2026-10-02), y el Fix propuesto solo no alcanzaba:** agregué `hoyLocal()` a `lib/utils.ts`, pero seis de estos formularios se renderizan primero en el server (Heroku, UTC) y React **no corrige en la hidratación un atributo que difiere**: `defaultValue={hoyLocal()}` habría seguido mostrando la fecha de mañana. `CampoFecha` manda el campo vacío desde el server y pone la fecha local al hidratar (también como `defaultValue` del DOM, para que `form.reset()` vuelva a hoy). Los seis formularios lo usan.

### P1-11. Editar un producto puede borrarle motos compatibles
- [x] **Dónde:** `app/(pages)/products/actions.ts:46` y `:118` (`formData.getAll('models').filter(isMotoModelId)`).
- **Qué pasa:** `compatibleModels` es texto libre, pero el formulario solo puede devolver IDs de `MOTO_MODELS`. Si un producto tiene una etiqueta que `modelByLabel` no reconoce (variante nueva, typo heredado del scrape), abrir el editor y guardar —aunque no se toque el campo motos— la **borra**.
- **Fix:** al guardar, conservar las etiquetas del valor actual que no mapean a un ID (merge), o mostrar esas etiquetas en el `ModelPicker` como chips no editables.
- **Resuelto (2026-10-02):** `compatibleModelsFrom(ids, actual)` (`lib/modelo.ts`) conserva siempre las etiquetas que la tabla no reconoce, porque el selector no puede mostrarlas ni desmarcarlas; lo que sí es de la tabla sigue dependiendo de lo que marcó el usuario. Lo usan `createProduct`, `updateProduct` y `quickUpdateProduct`. Cubierto en `check:costeo`. **No mostré** esas etiquetas como chips en el `ModelPicker` (habría que pasarlas por cuatro pantallas): se conservan, pero no se ven.

---

## P2 — React: acciones, botones y estados

### <a id="p2-1"></a>P2-1. Patrón general: acciones que fallan "en silencio"
- [x] **Dónde:** casi todas las acciones de formulario: `createPresupuesto`/`updatePresupuesto` (`return` si no hay cliente o ítems), `crearMovimiento`, `registrarPagoProveedor`, `registrarPagoPedido`, `guardarAperturaCaja`, `registrarCompra`, `createSupplier`, `createCliente`, `addComponent`, etc.
- **Qué pasa:** validan y hacen `return` sin decir nada. El cliente (`startTransition(async () => { await action(fd); setOpen(false) })`) interpreta eso como éxito: cierra el modal / resetea el form y el dato no se guardó.
- **Fix (patrón único para todo el repo):**
  ```ts
  // lib/action-result.ts
  export type ActionResult = { ok: true } | { ok: false; error: string }
  ```
  Las acciones devuelven `ActionResult`; los formularios usan `useActionState` (como ya hacen `MedidasIA`, `ImportProductsForm`, `CompararCompra`) o, si son manuales, chequean `r.ok` antes de cerrar y muestran `r.error`. Envolver siempre en `try/catch` el `await` dentro de `startTransition`.
- **Resuelto (2026-10-03):** devuelven `ActionResult` `crearMovimiento`, `guardarAperturaCaja`, `registrarPagoProveedor`, `registrarPagoPedido`, `createEnvio`, `saveCostosProveedor`, `saveMedidasCaja`, `createSupplier`/`renameSupplier`, `createCliente`/`updateCliente`, `cambiarProveedor`, `setBundlePrice`, `quickUpdateProduct`, `addComponent` y `addToAssembly` (`registrarCompra`, `createPresupuesto`/`updatePresupuesto` ya lo hacían). Dos criterios que no estaban en el Fix:
  - **Un número ilegible ya no se guarda como vacío.** `saveCostosProveedor`, `saveMedidasCaja` y `setBundlePrice` convertían un valor mal tipeado en `null`/`0`, que en este modelo es "no lo sé" y *reemplaza* lo que hubiera: tipear "18,6x" borraba en silencio el peso ya cargado. Ahora se rechaza con un mensaje. Vacío y `0` siguen siendo "sin dato".
  - **Un P2002/P2003 es un mensaje, no una página de error** (`lib/prisma-errors.ts`): nombre de proveedor repetido, o un pedido/envío/proveedor que se borró desde otra pestaña mientras el formulario seguía abierto.
  Del lado del cliente, los cuatro paneles de plata (`MovimientoForm`, `AperturaCajaForm`, `RegistrarPagoClienteForm`, `RegistrarPagoProveedorForm`) comparten `useEnviarAccion` (`components/useEnviarAccion.ts`): no cierran ni limpian si el resultado es `ok: false`, muestran el motivo, atrapan el rechazo y liberan el botón. Los `<form action>` de las páginas usan `FormConResultado` + `PendingButton`. **Un detalle de React 19:** un `<form action>` se resetea solo al terminar la acción, *incluso si falló*, así que en los formularios de alta (proveedor, cliente, caja) el mensaje aparece pero los campos vuelven a vacío; los cuatro paneles de plata sí conservan lo tipeado porque no usan `action`.

### P2-2. `e.currentTarget` usado después de un `await` → TypeError
- [x] **Dónde:** `components/MovimientoForm.tsx:64`, `components/RegistrarCompraPicker.tsx:75`.
- **Qué pasa:** React pone `event.currentTarget = null` al terminar el dispatch. Dentro del `startTransition(async …)`, después del `await action(fd)`, `e.currentTarget` ya es `null` → `Cannot read properties of null (reading 'reset')`. El dato se guardó, pero la transición termina en error (va al error boundary) y el formulario no se limpia.
- **Fix:** capturar el form antes:
  ```ts
  const form = e.currentTarget
  const fd = new FormData(form)
  startTransition(async () => { await action(fd); form.reset() })
  ```
- **Resuelto (2026-10-03):** `RegistrarCompraPicker` se corrigió con P0-2; `MovimientoForm` ahora pasa por `useEnviarAccion`, que captura el `<form>` antes del `await`. Revisé el resto de los `e.currentTarget` del repo: todos se leen antes de cualquier `await`.

### P2-3. `startTransition` que no espera la acción
- [x] **Dónde:** `components/CompararProveedores.tsx:172`, `components/SelectorProveedorEmbarque.tsx:44`.
- **Qué pasa:** `startTransition(() => { cambiarProveedor(...) })` — la promesa no se devuelve, así que `pending` vuelve a `false` al instante (el select/botón no se deshabilita mientras guarda) y un rechazo queda como "unhandled promise rejection".
- **Fix:** `startTransition(async () => { await cambiarProveedor(...) })` + manejo de error.
- **Resuelto (2026-10-03):** `useAccionDirecta` (en `components/useEnviarAccion.ts`) devuelve la promesa dentro del `startTransition`, así que el select/botón sí se bloquea mientras guarda, y atrapa el rechazo. `cambiarProveedor` pasó a devolver `ActionResult`: antes, si el embarque ya no era borrador, hacía `return` mudo y el select quedaba mostrando un proveedor que no se había guardado; ahora lo dice.

### P2-4. Botones de submit sin protección contra doble click
- [x] **Dónde:** `PendingButton` existe pero se usa en **un** solo lugar (`envios/[id]/page.tsx:1355`). Botones planos en: crear envío (`envios/page.tsx:137`), cerrar/recibir/deshacer/reabrir embarque (`maritimo.tsx:322-351`, ver P0-1), costos del proveedor (`envios/[id]/page.tsx:873`, `maritimo.tsx:529`), medidas de caja (`envios/[id]/page.tsx:1014`), proveedores (`suppliers/page.tsx:104,172`), config (`config/page.tsx:178`), clientes (`clientes/page.tsx:72`, `clientes/[id]/page.tsx:79`), apertura de caja (`contabilidad/page.tsx:276`).
- **Qué pasa:** con ~200–800 ms de latencia por acción, un doble click crea dos envíos, dos proveedores, etc.
- **Fix:** reemplazar por `<PendingButton>` en todos. Es un cambio mecánico.
- El inventario completo, con el efecto de cada una y la protección que falta en el servidor, está en la sección [DUP](#dup--acciones-que-se-ejecutan-más-de-una-vez).
- **Resuelto (2026-10-03):** pasaron a `PendingButton` (dentro de `FormConResultado`, para que además se vea el rechazo) crear envío, costos del proveedor (aéreo y marítimo), medidas de caja, proveedores (alta y edición), clientes (alta y ficha) y los dos formularios de componentes. Cerrar/recibir/deshacer/reabrir se cerraron con P0-1 y config con P1-1; los paneles de apertura de caja y pagos ya se deshabilitaban, y ahora además cortan con una guarda `useRef` (el `isPending` recién se ve en el render siguiente). **No cierra DUP-1/DUP-2 del lado del servidor:** el botón frena el doble click, pero `createEnvio`, `createCliente` y los alta de movimientos siguen sin clave de idempotencia (dos pestañas o un reintento duplican).

### P2-5. Botones que quedan trabados para siempre
- [x] `components/PresupuestoBuilder.tsx:469-495`: `setSubmitting(true)` y `await action(fd)` sin `finally`. *(Resuelto con P1-3: se libera si hubo rechazo o falla; en el éxito queda bloqueado a propósito porque guardar redirige.)* Si la acción tira (P1-3) o hace `return` sin redirect (P2-1), el botón "Guardar" queda deshabilitado hasta recargar.
- [x] `components/BundlePriceEditor.tsx:24-30`: mismo problema con `saving`.
- [x] `components/QuickEditProduct.tsx:213-225` + `components/ProductRow.tsx:165`: cierra el modal y pinta el valor optimista **antes** de guardar; si `quickUpdateProduct` falla, la fila queda con el valor que no se guardó (y en `opacity-60`) hasta el próximo refresh, sin aviso.
- **Fix:** `try { … } finally { setSubmitting(false) }`; en el quick edit, en el `catch` revertir el optimista (`onOptimistic(null)`) y mostrar error. Considerar `useOptimistic` en `ProductRow`, que revierte solo y además elimina el warning `set-state-in-effect`.
- **Resuelto (2026-10-03):** `BundlePriceEditor` libera el botón en un `finally` y muestra el error (y `setBundlePrice` ya no convierte un precio mal tipeado en `0`, que borraba el fijo). En `QuickEditProduct` el cierre inmediato queda **solo cuando el padre sabe pintar y soltar el valor** (`onOptimistic`, o sea la lista): si el guardado falla, `onOptimistic(null)` revierte la fila y `ProductRow` muestra "No se guardó: …" bajo el nombre hasta que se descarte o se vuelva a guardar. Desde la ficha del producto (sin `onOptimistic`) el modal ahora **espera** el resultado y muestra el error adentro, en vez de cerrarse antes de saber si funcionó. **No migré a `useOptimistic`:** el `useEffect` que limpia el valor sigue siendo el warning de P3-6.

### P2-6. `DeleteButton` ignora `label` y `pendingLabel`
- [x] **Dónde:** `components/DeleteButton.tsx:33`. *(Resuelto de pasada con P1-4: usa `label`/`pendingLabel` y muestra el error de la acción.)*
- **Qué pasa:** las props están declaradas y documentadas ("para acciones destructivas que no son eliminar") pero el render tiene el texto hardcodeado. Además no maneja el error de la acción (ver P1-4).
- **Fix:** `{isPending ? pendingLabel : label}` + `try/catch` con aviso.

### P2-7. Acciones destructivas sin confirmación
- [x] "Marcar recibido", "Deshacer recepción" y "Reabrir" (mueven stock / estado) no piden confirmación; `removePedido` desde la tabla sí. Unificar con `confirm()` o con el mismo `DeleteButton` (una vez arreglado P2-6).
- **Resuelto (con P0-1, verificado 2026-10-03):** los tres piden confirmación vía `PendingButton confirmMessage` (`maritimo.tsx:336,347,356`). No los pasé por `DeleteButton`: viven dentro de un `<form action>`, y `PendingButton` ya cubre confirmación y bloqueo en un solo componente.

---

## P3 — Limpieza, rendimiento y deuda

### P3-1. Rendimiento: queries que traen el catálogo entero
- [x] `app/(pages)/envios/[id]/page.tsx`: **Resuelto (2026-10-03).** Ya no baja los ~5.8k productos ni los precios de todos los proveedores: usa `lookupDeConjuntos()` (solo las piezas de los conjuntos de la caja) y trae el `SupplierPrice` solo de los proveedores de sus líneas y de los productos que aparecen. Cuesta una vuelta más a la base (depende de qué conjuntos trae la caja), a cambio de miles de filas menos. De paso se borró `landedPairs`, que se calculaba y nadie leía.
- [x] `app/(pages)/suppliers/[id]/import/actions.ts` (catálogo entero): ya resuelto con P1-6 (`equivalenciasDe` + búsqueda de solo los códigos necesarios).
- [x] `app/(pages)/config/actions.ts` (upserts en serie): ya resuelto con P1-1 (un solo `$transaction`, solo lo que cambió).
- [x] `app/(pages)/suppliers/[id]/import/actions.ts` (upserts en serie): ya resuelto con P1-6 (un `INSERT … ON CONFLICT` por tanda de 400).

### P3-2. API JSON sin uso y con un filtro roto
- [ ] **Pendiente de tu decisión.** `app/api/products/route.ts` y `[id]/route.ts`: filtra por `categoryId` (columna que no existe → 500), y el `PUT` saltea las reglas de negocio. Nada del repo las llama. Intenté borrar `app/api/products/` y la herramienta lo bloqueó (borrado de código), así que **no se tocó**. Si querés borrarlas: `git rm -r app/api/products` y sacar la mención en CLAUDE.md (sección "API routes"; `app/api/health` se queda).

### <a id="p3-3"></a>P3-3. Columnas y claves muertas
- [ ] `Envio.shippingCostEst`: **no se droppeó.** La columna no la lee ni la escribe ningún código ni script (verificado con grep, incluidos `backup-logistics`/`verify-logistics`), pero **hay 1 caja con un valor guardado** (consulta de solo lectura, 2026-10-03) y dropearla pide una migración manual sobre la base de producción. Decisión tuya: si ese valor no importa, `ALTER TABLE "Envio" DROP COLUMN "shippingCostEst"` (como las de `prisma/manual/`) y sacar la línea del schema.
- [ ] `Config.app_modo`, `Config.active_supplier_id`: ningún código las lee. **Las dos filas siguen en la base** (`app_modo = maritimo_cbm`, `active_supplier_id = 6`, valores anotados por si hiciera falta restaurarlas); borrarlas fue bloqueado. Mientras existan, `/config` las muestra como campos "extra" editables (el filtro especial de `app_modo` se sacó del código antes de verificar que la fila existía). Para cerrar: `DELETE FROM "Config" WHERE key IN ('app_modo','active_supplier_id');`. Si preferís no borrarlas todavía, hay que volver a poner el filtro en `config/page.tsx`.
- [x] `Config.$ACTION_ID_…`: borrada con P1-1.
- [x] Hints de `/config`: el de CBM ya no dice "se alterna en el sidebar". **Dejé** el de "Solo lo usa el simulador… No afecta ningún costo actual" porque sigue siendo cierto: `maritimo_directo_per_ft3` y compañía los lee solo `SimuladorEnvio` (el escenario "marítimo directo").
- [x] Comentarios del schema: `Envio.modo` (ya no habla del modo global activo) y `Supplier.origen` (ya dice que la ruta y el costeo los decide `inbound`).
- [x] Comentario de `builder-actions.ts`: sin la mención al selector del sidebar (y sin decir que ningún proveedor alternativo puede surtir por avión, que Garuda desmiente).
- [x] Scripts sueltos con `_`: movidos con `git mv` a `scripts/dev/` (sin el prefijo), con los imports ajustados a `../../lib`. No se borraron.

### P3-4. Next 16: `middleware.ts` → `proxy.ts`
- [x] **Resuelto (2026-10-03).** `git mv middleware.ts proxy.ts` y la función pasó a `proxy` (el resto del archivo igual, incluido el limitador). Verificado levantando `next dev`: 401 sin credenciales, 200 con ellas, sin aviso de deprecación. **`pnpm build` no pude cerrarlo en esta máquina:** falla bajando la fuente Inter de Google (7 × "Error while requesting resource", sin relación con el cambio); conviene correrlo donde haya red antes de desplegar.

### P3-5. Documentación desactualizada
- [x] `CLAUDE.md`: Next 16 + React 19; `pnpm lint` es `eslint .` (y se agregó `pnpm typecheck`); la sección de Auth ahora habla de `proxy.ts`, del bloqueo por IP y de que el `admin/admin123` solo existe con `APP_ENV=local`.
- [x] `IMPORTAR-PRODUCTOS.md`: ya decía `default_margin_pct` (se corrigió con P1-5).
- [ ] `CLAUDE.md` todavía describe `app/api/products/` en "API routes": se actualiza junto con P3-2.

### <a id="p3-6"></a>P3-6. Warnings de lint (14)
- [x] **Resuelto (2026-10-03): `eslint .` sale con 0 warnings.**
  - Buscadores con debounce (`AddComponentForm`, `AddToAssemblyForm`, `EmbarqueMaritimo`, `PresupuestoBuilder`): con el término corto el resultado se **deriva al renderizar** en vez de hacer `setX([])` desde el efecto.
  - `PresupuestoBuilder`: la búsqueda por pieza guarda el resultado junto con el término al que contesta, así "Buscando…" se deriva de comparar los dos (y ya no queda prendido si la búsqueda falla); el costeo en vivo hace lo mismo con la composición ("calculando…" y "carrito vacío" derivados), y el seguimiento del precio sugerido pasó de un efecto que reaccionaba a `costoPorLinea` a hacerse **cuando llega el costo**.
  - `CompararCompra`, `EmbarqueMaritimo` (sincronizar el borrador con el servidor) y `ProductRow` (descartar el valor optimista): el patrón de React "ajustar estado durante el render" contra el último valor visto, en vez de un efecto. De paso `ProductRow` ya no necesita el `useEffect`.
  - `SimuladorEnvio`: la clave serializada es a propósito (`items` es nuevo en cada render), así que quedó con un `eslint-disable-next-line` por línea y el motivo escrito, en vez de un warning permanente.
  - La directiva `eslint-disable` sin uso de `CompararCompra` se fue con el efecto.
- **Sin probar en el navegador.** Typecheck y lint pasan, pero son cambios en el orden de renders de React: conviene recorrer a mano el armador de presupuestos (buscar una pieza, borrar el texto, agregar y quitar líneas, ver que el precio sugerido siga a la línea sin fijar), el armado del embarque marítimo y la lista de productos tras editar uno.

### P3-7. Detalles menores de server actions
- [x] `component-actions.ts`: `addComponent` / `addToAssembly` rechazan un **ciclo** (A contiene a B contiene a A) bajando el despiece por niveles, una consulta por nivel. `removeComponent` verifica que el componente pertenezca al `parentId` (y devuelve `ActionResult`; si ya no existe cuenta como éxito).
- [x] `products/actions.ts`: `nameEs` se recorta y se rechaza vacío (`createProduct`/`updateProduct` devuelven `ActionResult`; `ProductForm` usa `FormConResultado` para mostrarlo). **El stock ya no se pisa:** el formulario manda `stockCargado` (lo que mostraba al abrirse) y se aplica la **diferencia** con `increment`, así una recepción ocurrida mientras estaba abierto no se pierde; si la diferencia dejaría el stock negativo se rechaza. Vale para el formulario completo y para la edición rápida. Sin `stockCargado` (pestaña vieja) o con el campo ilegible, no se toca el stock.
- [x] `removePedido` y `assignAllConfirmados` revalidan `/envios` y `/presupuestos`.
- [x] `sincronizarLineas` revalida `/envios`.
- [x] `deleteEnvio`: se niega (con motivo visible, ya devuelve `ActionResult`) si la caja se recibió o tiene movimientos de caja registrados. Antes lo de "recibida" era un `return` mudo.
- [x] `registrarPagoProveedor`: valida la categoría contra `CATEGORIAS_EGRESO`.
- [x] `deshacerRecepcion` con stock insuficiente: ya cortaba, resuelto con P0-1.

---

## Trabajo en curso

Notas sobre el diff sin commitear (flete en vivo en `/envios`):

- [x] `lib/costo-envios.ts`: `incompleto` en aéreo ahora también es `true` si a una caja `cotizado` le falta `tramoUsd` o si alguna línea no tiene peso.
- [x] `lib/costo-envios.ts`: solo se costean las cajas **vivas** (se saltan los marítimos recibidos y los aéreos con todas sus líneas entregadas). **Efecto visible:** en la lista, las cajas ya cerradas dejan de mostrar flete/landed; siguen en su ficha. Si preferís verlas en la lista, la alternativa es paginar el listado.
- [x] Acciones que mueven el costo y no revalidaban `/envios`: `updateProduct`, `quickUpdateProduct`, `updateMeasures` (cuando guarda algo) y la importación de precios de proveedor ahora lo hacen.
- [x] Al dropear `shippingCostEst` no hay nada que ajustar en `scripts/backup-logistics.ts` / `verify-logistics.ts`: no la mencionan.

---

## Orden sugerido

1. **P0-1, P0-2, DUP-1, DUP-3** (doble stock / doble pago / botones sin bloqueo): cambios chicos, alto impacto.
2. **P1-1** (config) + borrar la fila `$ACTION_ID_…`.
3. **P2-2, P2-3** (bugs de React de una línea).
4. **P0-3, P0-4, P0-8** (libro de movimientos coherente) — conviene hacerlos juntos con una función única de ingresos.
5. **P1-3 + P2-1** (error.tsx + `ActionResult`), y aprovechar para **P2-4/P2-5** (PendingButton y `finally`).
6. **P0-5, P0-6, P0-7** (borrados y ediciones que rompen historia).
7. **P1-2** (quick edit en modo proveedor).
8. Resto de P1, después P3.

Después de cada bloque: `pnpm typecheck && pnpm lint && pnpm check:costeo`. Para P0-2/P0-3/P0-4 vale la pena agregar casos a `scripts/check-costeo.ts` (o un script hermano `check:libro`) que verifiquen `Σ movimientos ingreso por pedido === depositUsd`.
