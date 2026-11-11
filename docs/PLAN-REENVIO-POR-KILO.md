# Plan: reenvío por kilo en paralelo a Shoppre (catálogo, presupuestos y config)

Fecha: 2026-11-11 · Estado: **sin implementar**. Escrito para que lo ejecute otra sesión.
Rama: `claude/parallel-shipping-kilo-pricing-sd02og`.

## 0. Para quien lo ejecuta

1. Cargar los skills `costeo`, `pedidos` y `catalogo` antes de tocar nada (y `envios` para la fase 5).
2. Ejecutar las fases **en orden**, un commit por fase. Cada fase deja la app funcionando.
3. Después de cada fase: `pnpm typecheck && pnpm lint && pnpm check:costeo`.
4. **No hace falta cambiar el esquema** (ver §2). Se despliega sin `--migrar`.
5. La fase 6 **no se ejecuta** sin el visto bueno explícito del dueño: cambia precios de venta guardados.
6. Regla que no se negocia: **con la ruta en Shoppre, ningún número de hoy cambia**. Todo lo nuevo
   entra por un parámetro opcional cuyo valor ausente es el comportamiento actual. `check:costeo`
   tiene que seguir pasando sin tocar ni un caso existente.

## 1. Qué se pide y cómo se resuelve

El dueño quiere tener los dos reenvíos India → USA **a la vez**: la tabla escalón de Shoppre (hoy
la única que mueve catálogo y presupuestos) y el **reenvío por kilo** (₹/kg), pudiendo alternar,
con un **₹/kg cargado en `/config`** para ver los precios y el margen que deja cada uno.

Hoy el por kilo existe solo en la caja real y en el express por USA:

| Lugar | Hoy | Después |
|---|---|---|
| Caja aérea / express (`Envio.reenvio`, `Envio.tarifaKgInr`) | Shoppre o por kilo, cotizado por caja | igual, no se toca |
| Presupuesto express (`Pedido.reenvio`, `Pedido.tarifaKgInr`) | elige ruta y ₹/kg | igual |
| Presupuesto **normal** (por Miami) | siempre Shoppre (`rutaExpress` lo fuerza) | **elige Shoppre o por kilo** |
| Catálogo y ficha de producto | solo Shoppre (+ marítimo CBM) | **las dos, lado a lado** |
| `/config` | sin ₹/kg | **₹/kg de referencia + con cuál se cotiza por defecto** |
| `/simular` | aéreo, marítimo, CBM | **+ aéreo por kilo** |

Decisiones de diseño (ya tomadas, con su porqué):

- **No hay interruptor global que re-costee todo.** Ya hubo dos y se sacaron (`lib/modo.ts`,
  `lib/cost-columns.ts` lo cuentan). Las dos rutas se **muestran siempre juntas** en el catálogo,
  y **el presupuesto elige la suya** con un botón de dos opciones, igual que hoy elige normal/express.
  El "alternar" es por presupuesto; `/config` solo dice con cuál **nacen** los nuevos.
- **El ₹/kg de `/config` es una referencia para cotizar, no el costo de la caja.** La caja real
  sigue con su `Envio.tarifaKgInr` cotizado por caja y sin fallback: una caja por kilo sin tarifa
  sigue marcada `faltaTarifa` (subcosteada, no gratis). No inventar el número de la caja desde config.
- **Vacío no es cero.** Sin ₹/kg en config, la ruta por kilo no se muestra en el catálogo y un
  presupuesto por kilo sin tarifa propia no se puede guardar. Nunca se costea con 0.
- **El presupuesto congela su ₹/kg al guardar** (snapshot en `Pedido.tarifaKgInr`). Mover la tarifa
  en config no re-costea presupuestos ya dichos al cliente.
- **Mismo margen por las dos rutas** (el de la pieza, o el global). No se crea un margen por kilo:
  lo que cambia es el landed, y el margen que queda "a precio de hoy" se muestra al lado.
- **`Product.price` sigue saliendo de Shoppre** en las fases 1 a 5. Que el catálogo pase a
  repreciarse por kilo es la fase 6, aparte y con confirmación.

## 2. Modelo de datos

Nada nuevo en la base:

- `Pedido.reenvio` (`shoppre` | `por_kilo`, CHECK `Pedido_reenvio_valido`) y `Pedido.tarifaKgInr`
  ya existen (`prisma/manual/2026-11-10-pedido-express-por-usa.sql`) y no tienen ningún CHECK que
  los ate a `via = 'express'`. Solo el código los fuerza (`rutaExpress` en
  `app/(pages)/presupuestos/actions.ts:165`).
- Las claves nuevas de Config no necesitan fila previa: `/config` pinta lo que está en
  `FIELD_META` y `saveConfig` hace upsert (`app/(pages)/config/actions.ts:70`).

Actualizar el comentario de `Pedido.reenvio` / `tarifaKgInr` en `prisma/schema.prisma` (ya no son
solo del express) y correr `pnpm db:generate` solo si Prisma lo pide (un comentario no cambia el cliente).

Claves nuevas de Config:

| Clave | Tipo | Significado |
|---|---|---|
| `reenvio_kilo_tarifa_inr` | número, `rango: POSITIVO` | ₹ por kg cobrable del reenvío por kilo, **de referencia**. Vacío = la ruta por kilo no se muestra ni se ofrece por defecto. |
| `reenvio_precios` | `options: ['shoppre', 'por_kilo']`, vacío = `shoppre` | Con cuál nacen los presupuestos normales nuevos (y, en la fase 6, cuál manda en el precio de catálogo). |

## 3. Fase 1: el costeo puro (`lib/`)

### 3.1 `lib/reenvio.ts`

Agregar (el módulo es puro, puede importar `./config`):

```ts
/** ₹/kg de referencia (Config.reenvio_kilo_tarifa_inr). null = no cargada: la ruta por kilo no se cotiza. */
export function tarifaKgReferencia(cfg: ConfigMap): number | null
// trim; vacío → null; parseFloat; no finito o <= 0 → null. NO usar num(): su fallback inventaría la tarifa.

/** Con cuál reenvío nacen los presupuestos normales (Config.reenvio_precios). Sin tarifa de referencia, siempre 'shoppre'. */
export function reenvioPorDefecto(cfg: ConfigMap): Reenvio

/** El reenvío con el que se costea un presupuesto NORMAL, o null si es Shoppre. */
export function reenvioDelPresupuestoNormal(
  ruta: string | null | undefined, tarifaKgInr: number | null, cfg: ConfigMap,
): { tipo: 'por_kilo'; tarifaKgInr: number | null } | null
// ruta !== 'por_kilo' → null. Si es por kilo: tarifaKgInr ?? tarifaKgReferencia(cfg) (puede quedar null = falta tarifa).
```

Reescribir el último párrafo del encabezado del archivo ("Los precios de venta y el catálogo
siguen con la tabla de Shoppre...") para que diga la regla nueva.

### 3.2 `lib/calc.ts`: `calcLanded` con reenvío

Cuarto parámetro opcional. Ausente = exactamente lo de hoy.

```ts
export interface LandedOptions {
  /** Reenvío del tramo India → USA. Ausente o 'shoppre' = la tabla escalón (lo de siempre). */
  reenvio?: { tipo: Reenvio; tarifaKgInr?: number | null } | null
}
export function calcLanded(product, cfg, modo = 'aereo', opts: LandedOptions = {}): LandedBreakdown | null
```

Con `opts.reenvio.tipo === 'por_kilo'` y solo en `modo === 'aereo'` (en los modos marítimos se ignora):

- `tarifaKgInr == null` → **devuelve `null`** (falta el dato que cobra la ruta, igual que falta el peso).
- `shoppreShippingUsd = (weightGrams / 1000) × tarifaKgInr ÷ inr_usd_rate`. Es lineal por kilo:
  no hay caja de referencia ni `cotizarTramoAereo`.
- `insuranceUsd = 0` (el reenvío por kilo no cobra seguro; mismo criterio que `calcEnvio`).
- `maritimeUsd` igual que hoy (Miami → CCS por ft³).
- Fuera del landed por pieza, como hoy el processing: el redondeo a 0,5 kg con mínimo de 1 kg y el
  reempaque son **por caja** y los pone `calcEnvio`. Dejarlo dicho en un comentario.
- El peso es el real, sin volumétrico por pieza: mismo optimismo que la ruta Shoppre (el skill
  `costeo` lo explica). No "arreglarlo" acá.
- `priceIsLanded` sigue cortando antes: esa pieza no viaja por ningún reenvío.

Agregar a `LandedBreakdown` el campo `reenvio: Reenvio` (`'shoppre'` en todos los caminos de hoy)
para que la pantalla sepa qué está mostrando sin adivinar. El nombre `shoppreShippingUsd` se
queda (renombrarlo toca medio repo): documentar en el tipo que es "el tramo del depósito a USA".

### 3.3 `pnpm check:costeo`: casos nuevos (`scripts/check-costeo.ts`)

Sección nueva "Reenvío por kilo por pieza". Mínimo:

1. `calcLanded(p, cfg, 'aereo')` da **el mismo objeto** con `opts` ausente, `{}` y
   `{ reenvio: { tipo: 'shoppre' } }` (nada de hoy se mueve).
2. Por kilo: tramo = `kg × ₹ ÷ tasa`, seguro = 0, marítimo = el de Shoppre.
3. Por kilo sin tarifa → `null`. Con tarifa `0` explícita en el presupuesto → tramo 0 (es un dato).
4. **Empate pieza vs caja**: una caja de piezas que suman un múltiplo exacto de 0,5 kg, atada por
   peso, con `calcEnvio(items, cfg, { reenvio: { tipo: 'por_kilo', tarifaKgInr, reempaqueInr: 0 } })`:
   `Σ calcLanded(...).landedCostUsd × qty === calcEnvio.landedUsd`. Es el caso que impide que el
   catálogo y la caja diverjan.
5. `tarifaKgReferencia`: vacío, espacios, texto, `0`, negativo → `null`; `"650"` → `650`.
6. `reenvioPorDefecto`: `por_kilo` en config pero sin tarifa → `'shoppre'`.
7. `reenvioDelPresupuestoNormal`: la tarifa del presupuesto pisa a la de config; sin ninguna queda `null`.

## 4. Fase 2: `/config`

`app/(pages)/config/campos.ts`: agregar las dos claves de §2 a `FIELD_META` con hints en el tono
de los demás, y ubicarlas en `app/(pages)/config/page.tsx` en la sección donde están
`shoppre_*` (una clave sin ubicar cae en "Otros"). Texto sugerido:

- `reenvio_kilo_tarifa_inr`: "Reenvío por kilo: tarifa de referencia (₹/kg)". Hint: "Lo que cobra
  el reenvío por kilo cobrable para llevar a USA. Se usa para ver el catálogo y cotizar presupuestos
  por kilo. La caja real sigue con la tarifa que te cotizan para esa caja. Vacío = la ruta por kilo
  no se muestra."
- `reenvio_precios`: "Reenvío con el que se cotiza". Hint: "Con cuál nacen los presupuestos nuevos
  por Miami. En cada presupuesto se puede cambiar. Vacío = Shoppre."

Verificar que el `<select>` de `options` admite el valor vacío (mirar cómo lo hace `shoppre_carrier`).

## 5. Fase 3: catálogo y ficha de producto (ver las dos rutas y el margen)

### 5.1 Columnas (`lib/cost-columns.ts` + `components/ProductRow.tsx`)

Bloque nuevo **"por kilo"** entre el aéreo y el marítimo, con un color propio (por ejemplo ámbar,
como el celeste del mar), y el mismo patrón de apagado que `maritimo`:

- `costHeaders(variant, { maritimo, porKilo })` y `<CostCells ... porKilo />`. **Los dos tienen que
  recibir el mismo valor** (ya pasa con `maritimo`; el comentario del archivo lo advierte).
- `porKilo = tarifaKgReferencia(cfg) != null`, calculado donde ya se tiene `cfg`.
- Columnas:

| Columna | Valor |
|---|---|
| `Flete kilo` | `k.shoppreShippingUsd` (title: "kg × ₹X/kg ÷ tasa. Sin seguro") |
| `Landed kilo` | `k.landedCostUsd` |
| `Venta kilo` | `k.priceUsd`: el precio al mismo margen sobre el landed por kilo |
| `Margen hoy` | `1 − k.landedCostUsd ÷ saleUsd`: el margen que queda si se vende **al precio de hoy** y viaja por kilo |

  donde `k = calcLanded(forAereo, cfg, 'aereo', { reenvio: { tipo: 'por_kilo', tarifaKgInr: tarifaKgReferencia(cfg) } })`
  (mismo `forAereo`: el por kilo también es 99rpm por el depósito). Con precio fijo (`precioFijo`)
  `Venta kilo` es el precio fijo y la columna útil es `Margen hoy`. Sin peso: `—`.
- Llamadores a actualizar (verificar con `grep -rn "costHeaders(\|<CostCells"`):
  `app/(pages)/products/page.tsx:194`, `components/ProductRow.tsx:173` (`COLUMNAS`, sale de
  `costHeaders().length`: tiene que recibir las mismas opciones o los `colSpan` se corren) y `:254`,
  `app/(pages)/ensambles/[id]/page.tsx:198` y `:273`.
- En la ficha del ensamble (variante `compact`) el bloque por kilo va **apagado** salvo que se
  quiera lo contrario: esa tabla ya es ancha (por eso existe `ensambles_columnas_maritimas`). No
  crear otra bandera de config; pasar `porKilo: false` ahí.

### 5.2 Ficha del producto (`app/(pages)/products/[id]/page.tsx`, líneas ~80 y ~245)

Junto al bloque "por mar" agregar el de "por kilo": landed, flete, diferencia % contra Shoppre,
precio al mismo margen y margen al precio de hoy. Sin tarifa en config el bloque no aparece.

### 5.3 Lo que NO cambia en esta fase

`reprice`, `Product.price`, `Product.landedCostUsd`, `QuickEditProduct`, `ProductForm`, el
importador, `prices:99rpm`, ventas del depósito, inventario. Todo eso sigue en Shoppre.

## 6. Fase 4: presupuestos normales por kilo (cotizar)

### 6.1 Acciones (`app/(pages)/presupuestos/actions.ts`)

`rutaExpress(formData, via)` (línea 165) pasa a `rutaDelPresupuesto(formData, via, cfg)`:

- `via === 'express'`: **igual que hoy** (vacío = la tarifa de la caja; no se toca).
- `via === 'normal'`:
  - `reenvio` ausente o `shoppre` → `{ reenvio: 'shoppre', tarifaKgInr: null }`.
  - `por_kilo`: tarifa escrita → se valida (ilegible o negativa se **rechaza** con `ErrorDeNegocio`,
    como hoy); vacía → **snapshot de `tarifaKgReferencia(cfg)`**; si tampoco hay →
    `ErrorDeNegocio('Falta la tarifa ₹/kg del reenvío por kilo: anotala acá o en Configuración.')`.
- Llamadores: creación (~línea 190) y edición (~línea 452). La regla de cuándo se puede cambiar es
  la que ya rige ahí: solo en `status = 'presupuesto'` o stock propio; un pedido confirmado ya se
  cobró con esa ruta. `cfg` ya se lee en esos caminos o cuesta un `getConfig()`.
- "Duplicar / desde" (`new/page.tsx`, `desde`) ya copia `reenvio` y `tarifaKgInr`: verificar que
  ahora también lo haga para vía normal.

### 6.2 Costeo del carrito (`app/(pages)/presupuestos/builder-actions.ts`, `costearCarrito`)

La firma ya trae `ruta` y `tarifaKgInr`; hoy solo los usa la rama express. En la rama normal:

```ts
const reenvio = reenvioDelPresupuestoNormal(ruta, tarifaValida, cfg)   // null = Shoppre
const b = calcLanded({...}, cfg, 'aereo', { reenvio })
```

- Por kilo sin tarifa: no costear con 0. Devolver el carrito con `faltaTarifa: true` (campo nuevo en
  `CostoCarrito`), `landedUsd` 0 y `sugeridoUsd: null` en las líneas.
- **Precio fijo**: en la ruta por kilo, una pieza con `priceLocked` sugiere su `Product.price` (el
  precio es el dato, el margen la consecuencia). Sumar `price` y `priceLocked` al `select` de
  `margenes`. En la ruta Shoppre no tocar la cuenta de hoy.
- **La otra ruta, siempre a la vista**: agregar a `CostoCarrito` un
  `alternativa: { reenvio: Reenvio; landedUsd: number; sugeridoUsd: number | null } | null` con el
  mismo carrito costeado por el reenvío que **no** está elegido (null si esa ruta no se puede
  costear: por kilo sin tarifa de referencia). Es un segundo `calcLanded` por pieza en el mismo
  loop; no duplicar el loop.
- `proveedor`, `express: null` y el resto quedan igual.

### 6.3 El armador (`components/PresupuestoBuilder.tsx`)

- Props nuevas desde `new/page.tsx` y `[id]/edit/page.tsx`: `reenvioDefault` (`reenvioPorDefecto(cfg)`)
  y `tarifaKgReferencia` (número o null). Hoy `ruta` se inicializa pensando en express (línea ~180):
  el estado inicial pasa a ser `initialRuta` si se edita o duplica, y `reenvioDefault` solo en un
  presupuesto **nuevo y normal**. Al cambiar de vía (normal ↔ express) reponer la ruta al default
  de esa vía (express: `shoppre`), para que "por USA" no quede elegido por arrastre.
- Bajo el selector "Envío", cuando la vía es **normal**, un segundo par de botones con el mismo
  estilo que "Ruta express":
  - `Shoppre` · "Tabla escalón, con seguro"
  - `Por kilo` · "₹/kg, sin seguro"
  - con por kilo, el input ₹/kg que ya existe (`pb-tarifa-kg`), con placeholder
    `vacío = ₹{tarifaKgReferencia} de Configuración` o `ej. 650` si no hay.
  - deshabilitado con las mismas condiciones que la vía (`clienteFijo || viaFija`).
- `composicion` (línea ~496) hoy mete `ruta` y la tarifa solo si es express: incluirlas siempre,
  así cambiar de reenvío recostea. Igual al armar el `FormData` (línea ~765): mandar `reenvio` y
  `tarifaKgInr` también en vía normal.
- Panel de costo (línea ~1391): el título dice la ruta ("✈️ Costo por Miami · reenvío por kilo
  ₹650/kg" / "· Shoppre") y debajo una línea con `costo.alternativa`: "Por Shoppre: landed $X,
  venta sugerida $Y (+$Z)". Es la comparación que responde "cuál me conviene para este pedido".
- `costo.faltaTarifa`: aviso en rojo y botón de guardar deshabilitado (el candado real es la acción).
- Precios: las líneas sin tocar siguen solas al sugerido (ya pasa, líneas ~537 a 548). Para las
  tocadas, generalizar el aviso que hoy es solo del express ("Los precios que ya tenía no cambian
  solos: usá Aplicar precios sugeridos") a cualquier cambio de ruta.
- Los catálogos internos del armador (precio de lista al buscar, líneas ~1004 y ~1092) muestran
  `product.price` (Shoppre): dejarlos, el precio real de la línea lo pone el sugerido al costear.

### 6.4 Ficha del presupuesto (`app/(pages)/presupuestos/[id]/detalle.tsx`)

Solo información: un chip junto a la vía cuando `via = normal` y `reenvio = por_kilo`:
"Reenvío por kilo · ₹650/kg". No va al PDF del cliente (`lib/pdf/presupuesto-pdf.ts` no se toca).

Nota a dejar escrita, no a resolver: el margen estimado de un pedido que todavía no está en una
caja sale de `Product.landedCostUsd` (Shoppre), así que un pedido por kilo se ve con margen
pesimista hasta que entra a su caja. Verificar en `lib/margen.ts` / `cargarMargenes` que es así y,
si es trivial, usar el landed por kilo cuando `Pedido.reenvio = 'por_kilo'`; si no lo es, dejarlo.

### 6.5 `check:costeo`

`reenvioDelPresupuestoNormal` ya queda cubierto en la fase 1. Si la validación de
`rutaDelPresupuesto` se puede extraer a una función pura en `lib/` (recomendado: `leerRuta(raw,
tarifaRaw, via, cfg)` que devuelve valor o motivo), agregarle casos: vacío toma config, ilegible
se rechaza, sin ninguna tarifa se rechaza, express no cambia.

## 7. Fase 5: simulador, `pnpm q` y la caja

- **`/simular`** (`components/SimuladorEnvio.tsx`, línea ~211): una columna más, "Aéreo por kilo",
  con `calcEnvio(items, cfg, { modo: 'aereo', reenvio: { tipo: 'por_kilo', tarifaKgInr: tarifaKgReferencia(cfg), reempaqueInr: null } })`.
  Solo si hay tarifa de referencia. Mostrar `reenvio.kgFacturados` y aclarar "sin el reempaque de
  la caja" (`faltaReempaque` va a venir en `true`: es correcto, no forzarlo a 0).
- **`pnpm q`** (`scripts/q.ts` + `lib/quote-metrics.ts`): opción `--por-kilo[=₹]` que pasa
  `opts.reenvio` a `calcEnvio`. Sin número usa la referencia de config.
- **Caja vs presupuesto**: un presupuesto normal por kilo puede terminar en una caja Shoppre y al
  revés (la caja congela su reenvío al crearse). **No bloquear** (a diferencia del express, acá
  las dos cajas hacen el mismo recorrido): en la ficha de la caja, en las listas "Pedidos
  confirmados con ítems sueltos" y en `EnvioItemsTable`, un chip "cotizado por kilo" / "cotizado
  por Shoppre" cuando `Pedido.reenvio` difiere de `Envio.reenvio`. El margen real ya lo calcula la
  caja con su propio reenvío.
- **Alta de caja** (`app/(pages)/envios/page.tsx`, select `reenvio`): preseleccionar
  `reenvioPorDefecto(cfg)`. En la pestaña Plata, el placeholder de `tarifa-kg` puede decir
  "referencia ₹650": solo placeholder, **el valor guardado sigue vacío hasta que se cotice la caja**.

## 8. Fase 6 (NO ejecutar sin confirmación del dueño): que el precio de catálogo salga del por kilo

Pregunta para el dueño antes de empezar: "¿Querés que el precio de venta del catálogo
(`Product.price`) pase a calcularse con el reenvío por kilo cuando `reenvio_precios = por_kilo`?".
Implica:

- `lib/reprice.ts` recibe el reenvío (`reenvioPorDefecto(cfg)` + tarifa de referencia) y lo pasa a
  `calcLanded`. Llamadores: `products/actions.ts` (3), `lib/measures.ts`, `scripts/repreciar-catalogo.ts`,
  `scripts/update-prices-99rpm.ts` (2), más `QuickEditProduct`, `ProductForm` e
  `products/import/actions.ts`, que previsualizan con `calcLanded` directo.
- `Product.landedCostUsd` cambia de significado (lo leen inventario, ventas del depósito y márgenes).
- Cambiar la clave en `/config` **no** reprecia sola: hay que correr `pnpm tsx scripts/repreciar-catalogo.ts`
  (en seco primero) y mostrarle al dueño cuántos precios bajan y cuánto.
- Mover el ₹/kg de referencia pasa a mover precios de venta: `saveConfig` debería avisarlo.
- En el catálogo, el bloque que manda en el precio pasa a ser el de por kilo (resaltar ese).

Recomendación: no hacerlo hasta tener dos o tres cajas por kilo facturadas que confirmen la tarifa.
El por kilo se cotiza por caja y varía; Shoppre es una tabla publicada. Mientras tanto, las fases
1 a 5 ya dejan cotizar por kilo presupuesto por presupuesto y ver el margen en el catálogo.

## 9. Documentación a actualizar junto con el código

- `.claude/skills/costeo/SKILL.md`: `calcLanded` acepta reenvío; la frase "catalog, quotes and sale
  prices never use the per-kilo lane" deja de ser cierta (decir cuál sí y cuál no); el bloque por
  kilo del catálogo; `tarifaKgReferencia`.
- `.claude/skills/pedidos/SKILL.md`: `Pedido.reenvio` / `tarifaKgInr` valen para la vía normal;
  snapshot al guardar; cuándo se puede cambiar.
- `.claude/skills/envios/SKILL.md`: la referencia de config no es la tarifa de la caja; el chip de
  reenvío distinto.
- `CLAUDE.md`: en "Product" la frase "always the air lane" sigue valiendo (por kilo también es la
  ruta aérea); no hace falta más salvo que se ejecute la fase 6.

## 10. Verificación final

1. `pnpm typecheck && pnpm lint && pnpm check:costeo` en verde.
2. `pnpm db:up` y `pnpm dev`. Con `reenvio_kilo_tarifa_inr` vacío: el catálogo, un presupuesto
   normal nuevo y `/simular` se ven **idénticos** a antes (comparar landed y precio de 3 piezas
   contra `main`).
3. Cargar `650` en config: aparece el bloque por kilo en `/products` y en la ficha; los `colSpan`
   de las filas expandidas no se corren.
4. Presupuesto normal nuevo: alternar Shoppre ↔ por kilo recostea, los precios sin tocar siguen al
   sugerido, la línea de "la otra ruta" muestra la diferencia. Guardar por kilo con el input vacío
   deja `Pedido.tarifaKgInr = 650`. Cambiar config a 700 no mueve ese presupuesto.
5. Borrar la tarifa de config y guardar un presupuesto por kilo sin tarifa: se rechaza con el
   mensaje, y no queda guardado.
6. Un presupuesto express (directo y por USA) se comporta igual que antes.
7. Confirmar un pedido por kilo y meterlo en una caja Shoppre: entra, con el chip de aviso.

## 11. Fuera de alcance

- `compararCompra` / `/presupuestos/[id]/comparar` (siguen comparando proveedores por Shoppre).
- Un margen propio para el por kilo, y el volumétrico por pieza.
- Tarifa por kilo por tramos de peso (hoy es un solo ₹/kg; si el reenvío cotiza distinto según el
  tamaño, eso sigue viviendo en la tarifa de cada caja).
