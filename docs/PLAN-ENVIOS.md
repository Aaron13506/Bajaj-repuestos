# Plan — refactor de la ficha de envío aéreo (`/envios/[id]`)

Fecha: 2026-10-04 · Estado: **fases 1, 2 y 3 implementadas en la rama `refactor/envios`** (sin desplegar). Falta: desplegar, cargar los pagos viejos en producción y el ajuste de cierre. De la fase 4 se hizo el checklist de pasos (I1); quedan I2–I8.

Alcance: la ficha de una caja **aérea** (`app/(pages)/envios/[id]/page.tsx`) y lo que toca
alrededor (acciones, tabla de ítems, contabilidad). La ficha marítima (`maritimo.tsx`) queda
fuera salvo donde se dice explícitamente.

**No hace falta cambiar el esquema** para nada de lo pedido: todo sale de columnas que ya
existen (`Envio.shippingCostRealAereo/Maritimo`) y del libro (`Movimiento` con
`categoria = flete_aereo | flete_maritimo` y `envioId`). Se despliega con `pnpm deploy:prod`
sin `--migrar`.

---

## 1. Cómo está hoy la ficha (orden real en pantalla)

| # | Bloque | Qué hace | Archivo / línea |
|---|---|---|---|
| 1 | Header | nombre, ruta, eliminar | `page.tsx:570` |
| 2 | 💵 **Cobranza** | ya recibí / falta que paguen / venta total, "de tu bolsillo", quién debe qué | `page.tsx:613`, `Cobranza()` `:1438`, `lib/clientes.ts:123` |
| 3 | Grilla de 2 columnas (`xl:grid-cols-2`) con **todo** lo de plata adentro: | | `page.tsx:618` |
| 3a | 🇮🇳 Tramo India → USA · peso cobrable | ΣW, ΣV, cobrable, $/kg, utilización, consejo de escalón | `:704` |
| 3b | 💸 Proveedor · lo que le pagás (solo con proveedor) | tramo DDP, comisiones, pagado al proveedor | `:779` |
| 3c | Registrar compra (picker plegado) | costo real de las líneas | `:942` |
| 3d | 📦 **Caja real** · peso y medidas **+ flete aéreo/marítimo facturado** (un solo form) | + tabla suma vs real + avisos facturado vs calculado | `:953` |
| 3e | Costo del envío (landed) | desglose + margen bruto | `:1148` |
| 4 | Ítems en el envío | estado por presupuesto o por línea | `components/EnvioItemsTable.tsx` |
| 5 | Desglose por pieza (plegado) | peso/vol/flete/landed por pieza | `:1225` |
| 6 | Pendiente de comprar (botón) | lista por proveedor, vista 99rpm por ensamble | `components/PendientesCompraButton.tsx` |
| 7 | 🇮🇳 Lista de compra India (**abierta**) | toda la caja consolidada por SKU en INR | `:1273` |
| 8 | 🇨🇳 Lista de compra China | idem | `:1324` |
| 9 | Pedidos confirmados con ítems sueltos | para sumar a la caja | `:1355` |
| 10 | Presupuestos sin aprobar | informativo | `:1402` |

El problema de layout que describís viene del punto 3: son 5 tarjetas de alto muy distinto
en una grilla de 2 columnas, así que cuando "Caja real" crece (aparece la tabla de
comparación o los avisos) empuja y reacomoda la columna vecina.

---

## 2. Lo que pediste, punto por punto

### 2.1 Cobranza: se descuadra con stock propio

**Qué pasa hoy.** `Cobranza` calcula:

```
descubierto = landed de TODA la caja − adelantos recibidos de pedidos de cliente aprobados
```

El landed incluye las líneas de **stock propio** (y las de presupuestos sin aprobar), pero
los adelantos solo pueden venir de clientes. El número de "de tu bolsillo" es correcto en
cuanto a efectivo, pero queda mezclado: no se puede leer cuánto es *financiar a un cliente
mientras paga* y cuánto es *inversión tuya en inventario*. En la copia local se ve el
tamaño del problema:

| Caja | Venta clientes | Venta stock propio | % propio |
|---|---|---|---|
| #1 | $638.00 | $213.32 | 25% |
| #8 | $1147.50 | $511.62 | 31% |
| #9 | $70.00 | $34.48 | 33% |

Hay además dos descuadres que no son del stock propio:

- **Pedidos partidos entre cajas**: el adelanto se cuenta **entero** en cada caja donde el
  pedido tiene una línea (`cobranzaEnvio` lo hace a propósito para la deuda). Para la cuenta
  de "de tu bolsillo" eso es contar dos veces la misma plata: dos cajas creen que el mismo
  adelanto de $100 las financia.
- **El margen bruto** de la tarjeta de costo (`page.tsx:1195`) resta el landed a la suma de
  `salePrice` de **todas** las líneas, incluidas las de stock propio. El `salePrice` de una
  línea propia es una estimación de cuando creaste el pedido, no una venta: infla el margen
  de la caja con plata que todavía no existe.

**Propuesta: cambiar "Cobranza" por "💵 Quién pone la plata"**, una franja compacta (una
fila, sin la tabla de quién debe qué) que separa la caja en tres bolsillos:

```
Costo de la caja $1 420  =  Clientes $980  +  Stock propio $380  +  Sin aprobar $60
Adelantos que la cubren: $520  (prorrateados en los pedidos partidos)
De tu bolsillo hasta entregar: $900  =  $460 de clientes por cobrar + $380 de inventario tuyo + $60 de riesgo
```

- El landed por línea ya existe (`landedByItem`, `page.tsx:468`): solo hay que agruparlo
  por `pedido.tipo` / `pedido.status`. Sale de una función pura nueva en
  `lib/clientes.ts` (ej. `financiamientoEnvio`) que reemplaza a `cobranzaEnvio` en esta
  ficha. `cobranzaEnvio` sigue existiendo para quien la use (hoy solo esta ficha).
- **Adelanto prorrateado** por la parte de la venta del pedido que viaja en esta caja. Con
  eso la suma de "lo que cubre" en todas las cajas nunca supera lo que el cliente pagó.
- **Margen**: se muestra solo sobre las líneas de cliente (venta real − landed de esas
  líneas). El stock propio no tiene margen todavía; se muestra como "inventario a costo"
  ($380), que es lo que va a entrar a `valorInventario` al llegar.
- **"Quién debe qué"** se saca de la ficha. Ya existe en `/contabilidad` (cuentas por
  cobrar) y por cliente en `/clientes`. Si se quiere, un link "ver saldos de estos N
  clientes →".

> Alternativa más simple: borrar la tarjeta entera. No la recomiendo: "cuánta plata tengo
> metida en esta caja" es la pregunta del día a día con un margen de 30% y adelanto del 50%;
> lo que está mal es la mezcla, no la tarjeta.

### 2.2 Caja real: peso y dimensiones finales

**Hoy** la tarjeta "Caja real" tiene un solo formulario con peso, L×A×H **y** los dos fletes
facturados, y debajo una tabla "suma de piezas vs caja real" que mezcla físicas con fletes.

**Propuesta:** la tarjeta queda **solo** con lo físico:

- Peso real (kg), L × A × H (cm), Guardar.
- La comparación suma vs real **solo** con Peso, Volumen y Cobrable (sin filas de flete).
- El aviso "sin la caja real todo es un piso" se mantiene.
- Ocupa **todo el ancho** (ver §2.8).

⚠️ **Cuidado al partir el formulario** (problema real, no cosmético): `saveMedidasCaja`
(`actions.ts:227`) arranca los 6 campos en `null` y hace `updateMany` con todos. Si se
separa el form de medidas del de flete sin tocar la acción, **guardar el peso borra el flete
facturado** (y viceversa). La acción se parte en dos —`saveMedidasCaja` (4 campos físicos)
y la nueva acción de flete (§2.3)— o se usa el patrón `formData.has(name)` que ya usa
`saveCostosProveedor`. Prefiero partirla: son dos datos que llegan en momentos distintos.

### 2.3 Flete real: costo real + marcar pagado → contabilidad

**Hoy** los dos campos "Flete aéreo/marítimo facturado" están dentro del form de la caja,
con apariencia de dato opcional. Ya se usan en el landed cuando están cargados (pisan al
estimado, `lib/calc.ts:826` y `:872`), pero:

- no hay forma de decir "esto ya lo pagué" ni de que llegue a contabilidad;
- el form de "Registrar pago a proveedor" **ofrece "Flete aéreo"** como concepto
  (`components/RegistrarPagoProveedorForm.tsx:17`), pero el "Pagado" de esa tarjeta solo
  suma `pago_proveedor` y `comision_giro` (`CATEGORIAS_PAGO_PROVEEDOR`), así que un flete
  anotado ahí **desaparece de la ficha** (está en el libro, no se ve en la caja);
- en una caja `cotizado` (Garuda) el campo "Flete aéreo facturado" **no hace nada**: el
  facturado se aplica solo a las líneas Shoppre (`aplicarFacturado(shoppreLines, …)`), que
  en esa caja son cero. Además se pisa con "Envío + impuestos" (`tramoUsd`), que es el
  mismo concepto para ese proveedor.

**Propuesta: tarjeta nueva "🚚 Flete real · lo que te cobraron"**, todo el ancho, debajo de
la caja real. Una fila por tramo que existe en esta caja:

```
Tramo                  Facturado      Calculado   Dif.     Estado
✈️ Aéreo (Shoppre)     [ 612.54 ]     $580.10     +5.6%    ● Pagado 03/10 · Zelle   [deshacer]
🚢 Marítimo Miami→CCS  [        ]     $210.00       —      ○ Sin cargar             [Guardar] [Pagar]
```

- **El facturado es el costo**, no una sugerencia. El calculado queda al lado en gris, como
  referencia y para la diferencia %. (Los mensajes "facturado vs calculado" de hoy,
  `page.tsx:1105–1134`, se mudan acá y se acortan.)
- **Marcar pagado** (un pago por tramo: son empresas distintas) abre un mini-modal (monto prellenado con el facturado, método, fecha con
  `CampoFecha`) y crea un `Movimiento` egreso con `categoria = flete_aereo | flete_maritimo`
  y `envioId`. Llega a `/contabilidad` sin ningún paso extra porque ya es el libro.
- **Pagar sin facturado cargado**: si el campo está vacío, el monto pagado se guarda también
  como facturado (pagar *es* saber cuánto costó). En la misma transacción.
- **Estado** se **deriva** del libro, nunca se guarda en `Envio` (mismo criterio que el
  "pagado" al proveedor, `page.tsx:191`): Σ egresos `flete_<tramo>` con ese `envioId`
  contra el facturado → `sin cargar` / `por pagar $X` / `pagado parcial $X de $Y` /
  `pagado` / `pagado de más $X`.
- **Deshacer**: borra ese movimiento (acción acotada a `envioId` + categoría de flete, no
  el `eliminarMovimiento` genérico).
- **Doble click / dos pestañas**: el movimiento es aditivo, así que un doble envío pagaría
  dos veces. La acción toma el lock de la fila `Envio` (`SELECT … FOR UPDATE`) y rechaza
  si `pagado + monto > facturado + 0.01` con un `ActionResult` legible ("ya está pagado").
- **Caja cotizada** (Garuda): no se muestra la fila aérea — ese tramo es `tramoUsd` y se le
  paga al proveedor dentro del giro. Solo la fila marítima.
- En la **lista `/envios`**: badge "flete por pagar" / "flete pagado" por caja.
- Se saca "Flete aéreo" de las opciones de `RegistrarPagoProveedorForm`: el flete tiene su
  propia puerta y se le paga a otro.

**Qué cubre el facturado aéreo (decidido 2026-10-04).** La factura de Shoppre **incluye el
processing** y **no se paga seguro**. Por eso:

- El campo se llama "Factura Shoppre (flete + processing)" y, cuando está cargado,
  **reemplaza flete aéreo + processing** en el landed. Hoy reemplaza solo el flete
  (`aplicarFacturado` sobre `airUsd`) y suma el processing aparte. Ahora no se nota porque
  `shoppre_processing_inr = 0` en Config, pero si alguien lo carga, se contaría dos veces.
  Cambio en `calcEnvio`: con facturado aéreo, `processingUsd = 0`. Va con un caso en
  `pnpm check:costeo`.
- El seguro ya está en `shoppre_insurance_pct = 0.00`, así que no suma. Las filas
  "Seguro Shoppre" y "Processing Shoppre" de la tarjeta de costo se ocultan cuando valen
  0, para no mostrar cargos que no existen.
- **Consecuencia en el estimado** de las cajas sin factura: con processing en 0, el estimado
  aéreo de la caja queda corto por lo que Shoppre cobre de processing. Si es un monto fijo
  por caja, alcanza con cargar el valor real en `shoppre_processing_inr` (/config). Es un
  cambio de configuración, no de código. Ver pregunta 9.
- **Los precios de venta no cambian con esto.** `calcLanded` (el costo por pieza que fija
  `Product.price` y el sugerido del armador) deja afuera a propósito los cargos fijos por
  caja (`lib/calc.ts:232`). El processing solo entra en el costo de la caja
  (`calcEnvio`). Repartido entre las ~30 líneas de una caja son ~$1.2 por línea, y lo
  absorbe el margen.

Archivos: `actions.ts` (nueva `guardarFleteReal`, `pagarFlete`, `deshacerPagoFlete`;
`saveMedidasCaja` reducida), `page.tsx`, componente cliente nuevo
`components/FleteRealCard.tsx` (o `PagarFleteForm.tsx` para el modal, en el estilo de
`RegistrarPagoProveedorForm` con `useEnviarAccion`), `app/(pages)/envios/page.tsx` (badge),
`lib/costo-envios.ts` (agregar el pagado al resultado para la lista).

**Datos existentes.** Confirmado el 2026-10-04: los fletes de estas cajas **ya están pagados**:

| Caja | Etapa hoy | Flete aéreo cargado | Flete marítimo cargado | Egreso de flete en el libro |
|---|---|---|---|---|
| #1 "Primer envío 99rpm" | camino a Venezuela | — (pagado **$316**, Shoppre) | — (pagado **$47.90**) | ninguno |
| #8 "Encargos septiembre" | camino a USA | $612.54 | — | ninguno |

**Caja #1, real contra estimado** (copia local, caja pesada 18.6 kg, 38.1×35.5×28 cm). Es la
primera caja con los dos tramos facturados:

| Tramo | Estimado | Facturado | Diferencia |
|---|---|---|---|
| Aéreo Shoppre (18.6 kg cobrables) | $280.84 | $316.00 | +$35.16 (+12.5%) |
| Marítimo Miami→CCS | $46.81 | $47.90 | +$1.09 (+2.3%) |
| **Total flete** | **$327.65** | **$363.90** | **+$36.25 (+11.1%)** |

Qué dice esto:
- El **marítimo está bien calibrado** (`miami_caracas_per_ft3` y las medidas de la caja).
- El **aéreo queda corto por ~$35**, y es consistente con el processing que la factura trae
  y el estimado no (`shoppre_processing_inr = 0`). Si el processing es fijo por caja,
  cargar **≈ 3 390 INR** (35.16 × 96.32, la tasa actual) en `shoppre_processing_inr` cierra
  la diferencia. **Hay que confirmarlo con el desglose de la factura antes de cargarlo**:
  con una sola caja no se puede separar el processing de un error en la tabla de tarifas.
  Solo afecta el costo estimado de las cajas, no los precios de venta (ver arriba).
- Es el primer dato real para la idea I3 (precisión del estimado).

**Cómo se cargan sin descuadrar el saldo (resuelto 2026-10-04).** Los tres pagos ($316 y
$47.90 de la #1, $612.54 de la #8) se hicieron **antes del ajuste del 22/09**. La
contabilidad ya tiene una **apertura de caja** (`caja_apertura_desde = 2026-09-23`,
`caja_apertura_usd = 415.00`, ver `aperturaCaja` en `lib/movimientos.ts`): el saldo es
"$415 + lo que entró y salió desde el 23/09". Cualquier movimiento con fecha anterior queda
en el historial de la caja y de contabilidad **pero no mueve el saldo**. Por eso:

- Se registran con "Marcar pagado" y su **fecha real (≤ 22/09)**. Las cajas quedan
  "pagadas" y el saldo no cambia (o casi: el ajuste final lo cuadra igual). El ajuste de $549.15 tampoco se toca (también es anterior
  a la apertura).
- Se cargan **en producción, desde la pantalla nueva**, después de desplegar la fase 2. No
  se usa SQL ni la copia local, que se pisa con el próximo `pnpm db:pull-prod`. Para
  probar en local sirven los mismos números.
- Hace falta la fecha de cada pago al momento de cargarlo. Si no se sabe exacta, cualquier
  fecha ≤ 22/09 deja el saldo bien. La real sirve para el historial.

**Al terminar el refactor se hace un ajuste nuevo para arrancar de cero** (decisión del
usuario, 2026-10-04: hace falta por el nivel de desorden acumulado). Es el **último paso**,
después de desplegar y de cargar los pagos viejos, para que el ajuste se calcule contra el
libro ya completo y no haya que repetirlo.

### 2.4 Costo del envío: que se actualice con los precios reales

**Hoy** la tarjeta ya se recalcula en cada render con lo que haya cargado: costo real de
las líneas (`costRealUsd`), facturado de flete, tramo DDP, comisiones, peso real, y los
precios del catálogo/proveedor para lo que no tiene real. Lo que **no** hace es decir **qué
número es real y cuál es estimado**, así que después de cargar algo no se nota el cambio.

**Propuesta:**

- Cada fila con una etiqueta a la derecha: `real` (verde) / `estimado` (gris) /
  `sin cargar` (ámbar). Ej.: "Costo de producto · 18 de 30 líneas con costo real",
  "Aéreo Shoppre · facturado", "Marítimo · estimado por ft³".
- Arriba del total: "**Real al 72%**" (porción del landed que ya sale de datos reales). Es
  la forma de ver de un vistazo cuándo la caja está "cerrada" en plata.
- Margen solo sobre clientes (ver §2.1).
- Arreglar la revalidación que hoy falta: `eliminarMovimiento`
  (`contabilidad/actions.ts:84`) no revalida `/envios/[id]`, así que borrar un pago desde
  contabilidad deja la ficha mostrando lo viejo. Con §2.3 eso se vuelve visible.
- ~~Recálculo en vivo mientras tipeás~~ — **descartado** (2026-10-04): alcanza con que se
  actualice al guardar, que es lo que ya pasa. El trabajo es solo mostrar qué es real.

Qué datos, al guardarse, mueven el total de la tarjeta y cuál de sus filas cambia:

| Lo que guardás | Dónde | Fila que pasa de estimado a real |
|---|---|---|
| Costo real de las líneas | Registrar compra | Costo de producto |
| Factura Shoppre | Flete real | Aéreo (incluye processing) |
| Factura del tramo Miami→CCS | Flete real | Marítimo |
| Envío + impuestos (DDP) | Proveedor | Tramo del proveedor |
| Comisiones saliente/entrante | Proveedor | Comisiones |
| Peso y medidas de la caja | Caja real | Aéreo y marítimo *estimados* (sin factura, se recalculan sobre la caja real) |

### 2.5 Desglose por pieza: se elimina

Se borra el `<details>` de `page.tsx:1225–1262`.

⚠️ El aviso del tramo dice "Revisá **las marcadas abajo**" (`page.tsx:771`) y las marcas
"sin peso / sin dim." **viven en ese desglose**. Sin él, el aviso apunta a nada. Se mudan a
`EnvioItemsTable`: un badge ámbar "sin peso" / "sin medidas" en la línea (y en la cabecera
del presupuesto: "2 sin medidas"), con link a la pieza o al loader de medidas del
presupuesto (`MedidasIA`). Es más útil ahí: es donde se ve de quién es la pieza.

### 2.6 Lista de compra India: plegada al inicio

Pasa a `<details>` cerrado (igual que la China), con el total en el `summary` para no tener
que abrirla: "🇮🇳 Lista de compra India · 42 ítems · 87 u. · 125 300 INR ≈ $1 318".

Dos problemas que vi en esta lista y conviene arreglar en el mismo cambio:

- **Ignora el precio del proveedor.** `buildBuyList` (`page.tsx:350`) suma solo `priceInr`
  del catálogo. En una caja de Garuda (proveedor indio, cotiza en USD) muestra el precio
  de 99rpm en rupias: un total que no es lo que vas a pagar. Debe usar `priceUsd` del
  proveedor cuando existe (como hace `PendientesCompraButton`) y mostrar la moneda que
  corresponde.
- **Se pisa con "Pendiente de comprar".** Esta lista es *toda* la caja (incluye lo ya
  comprado) y se titula "Total a comprar"; la de pendientes es lo que falta. Propuesta:
  renombrarla "Contenido de la caja por SKU" o directamente fundirla en el modal de
  pendientes como una pestaña "todo". Ver pregunta 6.

### 2.7 Ítems en el envío: mover el estado de todos a la vez

**Hoy** se puede mover un presupuesto entero (select de la cabecera del grupo) o una línea.
No hay control para la caja entera, que es lo normal cuando la caja se mueve físicamente.

**Propuesta**, en la barra de la tabla:

```
Ítems en el envío (41) · 30 comprados      [Mover todo a ▾]  [Avanzar todo un paso →]
```

- **Mover todo a…**: las etapas de la ruta de la caja. Reutiliza `aplicarA(visibles, …)`;
  el servidor (`saveItemChanges`) ya trabaja en lote y ya es seguro contra doble envío.
- **Avanzar un paso**: `nextStatus` por línea según su ruta. Es el gesto más común ("la caja
  llegó a Miami") y no obliga a elegir la etapa.
- **Líneas `isLanded`** (no viajan; ruta `pendiente → en_venezuela → entregado`): si se
  mueve todo a "camino a USA", `normalizeToRoute` las llevaría a **en Venezuela** —
  adelantaría algo que no viajó. Regla: el movimiento masivo **saltea** las líneas cuya
  ruta no tiene esa etapa y lo dice ("3 líneas puestas en Venezuela quedaron como
  estaban").
- **Confirmación** cuando: el destino es `entregado` y hay stock propio (mueve
  `Product.stock`: "suma 14 u. a 6 productos"), o el movimiento va **para atrás**.
- **No toca las `pendiente`** al avanzar, salvo que se elija explícitamente: una línea sin
  comprar no puede estar "en camino". Opción en el mismo menú: "incluir las no compradas".
- Opcional (fase 4): checkboxes para mover una selección.

Archivo: `components/EnvioItemsTable.tsx` (solo cliente; el servidor no cambia).

### 2.8 Layout nuevo

Lo que pediste: **arriba de todo, lado a lado**, el costo del envío y el cálculo de lo
cobrable del tramo; **caja real y precio real apilados**, cada uno a todo el ancho, para que
al expandirse no muevan nada. (Los montos del esquema son ilustrativos; también los de
§2.1 y §2.3.)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Envíos / #8   Caja Septiembre   ✈️ Aéreo   📦 99rpm                 [Eliminar] │
│ Pasos: ✓ Asignada  ✓ Comprada 30/30  ✓ Pesada  ● Flete aéreo pagado            │
│        ○ Flete marítimo  ○ Entregada 0/41                       (ver §3, I1)   │
├──────────────────────────────────────┬────────────────────────────────────────┤
│ ✈️ TRAMO A USA · PESO COBRABLE       │ COSTO DEL ENVÍO (LANDED)   Real al 72% │
│ ΣW 18.6  ΣV 16.2  Cobrable 18.6  $/kg│ Producto ........ $812  18/30 real     │
│ [utilización ▓▓▓▓▓▓▓░░] 87%          │ Aéreo ........... $612  facturado      │
│ consejo de escalón                   │ Marítimo ........ $210  estimado       │
│                                      │ (seguro/processing ocultos si valen 0) │
│                                      │ TOTAL ......... $1 666                 │
│                                      │ Margen clientes $310 (24%)             │
├──────────────────────────────────────┴────────────────────────────────────────┤
│ 📦 CAJA REAL · PESO Y MEDIDAS                                     [MEDIDA]    │
│ Peso [18.6] kg   L×A×H [60]×[40]×[40] cm   [Guardar]                          │
│ Suma vs real: peso +3.0 kg · volumen +27 000 cm³ · cobrable 15.6 → 18.6       │
├───────────────────────────────────────────────────────────────────────────────┤
│ 🚚 FLETE REAL · LO QUE TE COBRARON                                           │
│ ✈️ Aéreo     [612.54]  calc $580 (+5.6%)   ● Pagado 03/10 · Zelle  [deshacer] │
│ 🚢 Marítimo  [      ]  calc $210           ○ Sin cargar   [Guardar] [Pagar]   │
├───────────────────────────────────────────────────────────────────────────────┤
│ 💸 PROVEEDOR · LO QUE LE PAGÁS (solo si la caja tiene proveedor)              │
├───────────────────────────────────────────────────────────────────────────────┤
│ 💵 QUIÉN PONE LA PLATA  (franja compacta, §2.1)                               │
├───────────────────────────────────────────────────────────────────────────────┤
│ ÍTEMS EN EL ENVÍO (41) · 30 comprados   [Mover todo a ▾] [Avanzar un paso →]  │
├───────────────────────────────────────────────────────────────────────────────┤
│ [Pendiente de comprar]  [Registrar compra]                                    │
│ ▸ Lista de compra India · 42 ítems · 125 300 INR ≈ $1 318      (plegada)      │
│ ▸ Lista de compra China                                        (plegada)      │
├───────────────────────────────────────────────────────────────────────────────┤
│ Pedidos confirmados con ítems sueltos / Presupuestos sin aprobar              │
└───────────────────────────────────────────────────────────────────────────────┘
```

- Arriba: `grid xl:grid-cols-2 items-stretch` con **solo** las dos tarjetas de lectura
  (tramo + costo). Son las que tienen alto parecido y no se expanden.
- Todo lo que se **edita** (caja real, flete real, proveedor) va a todo el ancho, uno debajo
  del otro. Expandir uno solo empuja hacia abajo, nunca reacomoda columnas.
- **Caja cotizada** (Garuda): la tarjeta de arriba a la izquierda muestra el tramo DDP
  (piezas, kg, $/kg sobre `tramoUsd`) en vez de la tabla de Shoppre. Hoy dice "No hay
  piezas de India en este envío", que es falso para un proveedor indio (`page.tsx:714`).
- El picker "Registrar compra" sube junto al botón de pendientes: los dos son "comprar".

---

## 3. Problemas encontrados (independientes de lo pedido)

| # | Severidad | Problema | Dónde |
|---|---|---|---|
| P1 | Alta | Partir el form de caja sin partir `saveMedidasCaja` borra el flete al guardar el peso | `actions.ts:236` |
| P2 | Alta | Un flete anotado desde "Registrar pago a proveedor" no se ve en la caja: el "Pagado" solo suma pago a proveedor y comisión | `RegistrarPagoProveedorForm.tsx:17`, `page.tsx:191` |
| P3 | Media | "De tu bolsillo" mezcla inventario propio con financiación a clientes, y cuenta dos veces el adelanto de un pedido partido | `page.tsx:1447`, `lib/clientes.ts:140` |
| P4 | Media | Margen bruto incluye la venta *estimada* del stock propio | `page.tsx:1195` |
| P5 | Media | Lista de compra India usa el ₹ de 99rpm aunque la caja sea de otro proveedor | `page.tsx:350` |
| P6 | Media | En caja cotizada, "Flete aéreo facturado" se guarda y no tiene ningún efecto | `lib/calc.ts:827` |
| P7 | Baja | Tarjeta del tramo dice "No hay piezas de India" en una caja de Garuda (indio) | `page.tsx:714` |
| P8 | Baja | Borrar un movimiento en contabilidad no refresca la ficha de la caja | `contabilidad/actions.ts:84` |
| P9 | Baja | El aviso de piezas sin peso apunta al desglose que se va a borrar | `page.tsx:771` |
| P10 | Dato | Cajas #1 y #8 con flete ya pagado y sin egreso en el libro. Resuelto: se cargan con fecha ≤ 22/09, antes de la apertura del 23/09, así que no mueven el saldo (§2.3) | DB local |
| P11 | Media | Con factura Shoppre cargada, el processing de Config se sumaría encima (hoy vale 0 y no se nota) | `lib/calc.ts:827` |

---

## 4. Ideas para el negocio y las vistas

**I1 · Pasos de la caja (checklist derivado).** Una fila en el header que se calcula sola:
asignada → comprada (N/M con costo real) → pesada → proveedor pagado → flete aéreo pagado →
flete marítimo pagado → entregada (N/M). Nada se guarda: cada paso sale de datos que ya
existen. Responde "¿qué me falta hacer con esta caja?" sin leer la ficha entera, y en
`/envios` se muestra como "4/7" con el próximo paso ("falta pagar flete aéreo"). Es lo que
pediste de "que ayude con el orden y los pasos".

**I2 · Fletes por pagar en contabilidad.** `cuentasPorPagar` hoy solo mira al proveedor.
Con §2.3 se puede agregar una sección "Transportistas": cajas con flete facturado > pagado.
Es plata que se debe y hoy no aparece en ningún lado.

**I3 · Precisión del estimado.** Con cajas que tienen flete facturado, mostrar el desvío
promedio facturado vs calculado por tramo (ej. "aéreo +5%, marítimo +18% en las últimas 3
cajas"). Dice si hay que corregir `miami_caracas_per_ft3` o si el problema son las medidas
del catálogo. Importa porque los precios de venta salen del estimado y el margen es de
30%: un +18% sistemático en un tramo se come una parte grande del margen.

**I4 · Margen real de la caja al cerrarla.** Cuando "Real al 100%", fijar la comparación
"margen estimado al cotizar vs margen real" sobre las líneas de cliente. Es la única forma
de saber si `default_margin` alcanza.

**I5 · Cobrar al llegar.** En vez de cobranza genérica, cuando líneas pasan a
`en_venezuela`: "Listos para entregar: Juan (saldo $45), María (saldo $0)". Es el momento
en que el saldo se cobra, y es la parte de la cobranza que sí sirve en esta ficha.

**I6 · Stock propio visible en la tabla.** Badge "stock propio" en la cabecera del grupo y
subtotal aparte. Hoy se ve igual que un cliente, que es parte de por qué la cobranza parece
descuadrada.

**I7 · Envío doméstico India → Shoppre — resuelto, no se hace.** Se paga junto con la
compra a 99rpm y son unos $2–3. Ya entra en el costo real de las piezas al registrar la
compra, así que no necesita campo propio.

**I8 · Flete real en el marítimo.** El embarque marítimo no tiene dónde anotar lo que
facturó la naviera ni marcarlo pagado. `FleteRealCard` se puede reutilizar ahí después.

---

## 5. Preguntas

**Respondidas (2026-10-04):**

1. ~~¿La factura de Shoppre incluye seguro y processing?~~ Incluye el **processing**; no se
   paga seguro. → §2.3: la factura reemplaza flete + processing.
3. ~~¿Costo en vivo o al guardar?~~ **Al guardar.** → §2.4, sin recálculo en vivo.
5. ~~¿Caja #8 pagada?~~ **Sí**, y la #1 (camino a Venezuela) también está **pagada entera**.
   → §2.3, datos existentes.
7. ~~¿Envío doméstico a Shoppre?~~ Va incluido en el pago a 99rpm (~$2–3). → I7 descartada.
2. ~~Cobranza~~ → **franja compacta "quién pone la plata"** (§2.1).
4. ~~¿Pagos de flete en partes?~~ **Un pago por tramo**: el aéreo se le paga a Shoppre y el
   marítimo a otra empresa, cada uno de una vez. → En §2.3, cada fila tiene su botón
   **"Marcar pagado"** con el monto prellenado (editable por si difiere). El estado igual
   detecta "pagado de más" / "falta" si el monto no coincide con el facturado.
6. ~~Lista India~~ → **plegada y renombrada "Contenido de la caja por SKU"** (§2.6).
8. ~~Mover en masa~~ → **toda la caja**, sin casillas (§2.7).

5b. ~~Fechas de los fletes ya pagados~~ → **todos antes del 22/09**. Se cargan con fecha
   ≤ 22/09 y quedan fuera del saldo por la apertura del 23/09 (§2.3). Al terminar, ajuste
   nuevo para arrancar de cero.

**Pendiente (no bloquea nada):**

9. **Processing de Shoppre:** ¿cuánto dice la factura de la #1? La diferencia sugiere ~$35
   por caja. Es un valor de /config, no código; mientras tanto queda en 0.

---

## 6. Orden de implementación

Cada fase se puede desplegar sola; ninguna necesita migración.

Antes de empezar: trabajar en una rama (`refactor/envios`, no en `master`) y versionar este
plan con el primer commit.

**Fase 1 · Layout y limpieza (solo UI).**
- Reordenar la ficha según §2.8 (grilla de 2 solo para tramo + costo; el resto a todo el
  ancho).
- Borrar el desglose por pieza; mover los badges sin peso/medidas a `EnvioItemsTable`.
- Lista de compra India plegada con total en el `summary`; usar el precio del proveedor
  (P5).
- Mover estados en masa (§2.7).
- Textos de caja cotizada (P7).

**Fase 2 · Flete real y pagado.**
- Partir `saveMedidasCaja` (P1); acciones `guardarFleteReal`, `pagarFlete`,
  `deshacerPagoFlete` con lock y `ActionResult`.
- `FleteRealCard` + modal de pago; ocultar fila aérea en caja cotizada (P6).
- Sacar "Flete aéreo" de `RegistrarPagoProveedorForm` (P2).
- Revalidar `/envios` y `/envios/[id]` desde `eliminarMovimiento` (P8).
- Badge de flete en `/envios`.
- Con facturado aéreo, el processing pasa a 0 en `calcEnvio` (P11) + caso en `check:costeo`.
- Después de desplegar, en producción: "Marcar pagado" en la #1 (aéreo $316, marítimo $47.90)
  y la #8 (aéreo $612.54), con fecha ≤ 22/09. Verificar que el saldo de `/contabilidad` no cambie.

**Fase 3 · Plata y costo.**
- `financiamientoEnvio` puro en `lib/clientes.ts` + franja "quién pone la plata" (P3).
- Margen solo de clientes (P4); etiquetas real/estimado y "Real al N%" (§2.4).
- Casos nuevos en `pnpm check:costeo` para el prorrateo del adelanto (que la suma entre
  cajas no supere lo pagado) y la separación clientes/propio.

**Cierre · Ajuste para arrancar de cero.** Cuando todo esté desplegado y los pagos viejos
cargados: ajuste nuevo en `/contabilidad` para que el saldo coincida con el banco.
Después, `pnpm check:libro` para confirmar que depósitos y stock siguen coherentes.

**Fase 4 · Ideas** (elegir): pasos de la caja (I1), fletes por pagar en contabilidad
(I2), precisión del estimado (I3), checkboxes, marítimo (I8).

### Verificación por fase

- `pnpm typecheck`, `pnpm lint`, `pnpm check:costeo`, `pnpm check:libro`.
- En la copia local (`pnpm db:up`), las tres cajas reales cubren los casos:
  - **#1**: 99rpm, con stock propio, caja pesada, sin factura cargada → cargar $316 aéreo y
    $47.90 marítimo con "Pagar" sin facturado previo (el pago se vuelve facturado), ver
    "real" en el costo y los diff +12.5% / +2.3%.
  - **#8**: facturado $612.54 sin egreso, sin pesar, 31% propio → "por pagar", pagar con
    fecha vieja, deshacer, que aparezca en contabilidad y en la lista `/envios`.
  - **#9**: con costo real cargado y un pago al proveedor → etiquetas "real", mover en masa
    a entregado con stock propio (verificar `Product.stock` sube y vuelve al retroceder).
- Una caja de Garuda creada a mano en local para P6/P7 (no hay ninguna en los datos).
- Doble click en "Pagar" y dos pestañas: un solo movimiento.
