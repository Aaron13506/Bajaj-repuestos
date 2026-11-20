# Fase 1: lector (QR, Code 128 y entrada manual)

Sin cambios de esquema. Al terminar, `ConteoCaja` se puede usar desde el teléfono con la cámara, con un lector físico o tecleando, y cada lectura suma la cantidad que trae el empaque.

## Qué traen las etiquetas

- **Caja de Bajaj:** QR con `DH181135-1_842`.
- **Bolsa reempacada por el proveedor:** Code 128 con el mismo formato, por ejemplo `XX123456-2@...`. Bajaj vende ciertas piezas en lotes de 100; el proveedor las reparte en bolsas y rotula cuántas lleva cada una.

Formato: `SKU`, separador, `cantidad`, separador, `MRP`. Solo importan el SKU y la cantidad. El MRP se descarta.

## `lib/qr-bajaj.ts` (nuevo, puro)

```ts
// Lo que trae la etiqueta de una caja de Bajaj (QR) o de una bolsa reempacada (Code 128):
// SKU, cantidad y MRP, con separadores que cambian según quién la imprimió ('_' en Bajaj, '@'
// en el proveedor). Un lector USB o Bluetooth además escribe como teclado en inglés, y con
// el teclado del sistema en español '-1_842' llega como "'1?842". Por eso no se depende del
// carácter separador: el SKU es el primer tramo alfanumérico y la cantidad el siguiente
// tramo de dígitos. El MRP no se usa.

export type OrigenLectura = 'camara' | 'lector' | 'manual'

export interface Lectura {
  codigo: string     // sin separadores, en mayúsculas
  cantidad: number   // unidades en ese empaque; 1 si la etiqueta no la trae (tecleado a mano)
  raw: string
}

export function leerCodigo(raw: string): Lectura {
  const s = raw.trim().toUpperCase()
  const m = s.match(/^([A-Z0-9]+)[^A-Z0-9]+(\d+)(?:[^A-Z0-9].*)?$/)
  if (!m) return { codigo: s.replace(/[^A-Z0-9]/g, ''), cantidad: 1, raw }
  const n = Number(m[2])
  return { codigo: m[1], cantidad: Number.isInteger(n) && n > 0 ? n : 1, raw }
}
```

No se valida "2 letras + 6 dígitos" porque hay códigos Bajaj que no siguen ese patrón.

### Casos para `scripts/check-costeo.ts`

- `DH181135-1_842` → `DH181135`, 1
- `JW401011-1_174` → `JW401011`, 1
- `XX123456-2@315` → `XX123456`, 2
- `DH181135'1?842` (lector con teclado en español) → `DH181135`, 1
- `dh181135` (tecleado) → `DH181135`, 1
- `DH18 1135` (tecleado con espacio) → `DH181135`, 1
- `DH181135-0_842` → cantidad 1 (una etiqueta con 0 no resta)
- `DH181135-12_90` → 12

## Resolver el código contra la caja (con alternos)

Una pieza puede llegar rotulada con su `altSku` (ver `lib/alt-sku.ts`). La resolución se hace contra **las piezas de esa caja**, no contra todo el catálogo:

1. `PiezaAContar` (`lib/conteo.ts`) agrega `alternos: string[]`. La página de la caja los llena con `alternosDe(productIds)` y, para piezas de conjuntos, con `equivalenciasDe(codigos)`.
2. Función pura nueva en `lib/conteo.ts`:

```ts
// Qué fila de la caja corresponde a una lectura. Exacto por código o alterno; si no, la única
// fila cuyo código o nombre contiene lo tecleado. null = no viene en esta caja o es ambiguo.
export function resolverLectura(
  piezas: PiezaAContar[],
  lectura: Lectura,
): { pieza: PiezaAContar } | { ninguna: true } | { varias: PiezaAContar[] }
```

Orden: código exacto, alterno exacto, y recién después búsqueda parcial (que solo tiene sentido para lo tecleado). Casos en `check:costeo`: código principal, alterno, parcial único, parcial ambiguo, inexistente.

## Cambios en `components/ConteoCaja.tsx`

- `sumarUna` pasa a `sumarLectura(lectura, origen)`: resuelve con `resolverLectura` y suma `lectura.cantidad`, no 1.
- **Cuando `cantidad > 1`**, el aviso dice `+2 (bolsa) DH181135 → 4/6` en grande y ofrece "corregir" durante unos segundos. La etiqueta de la bolsa la puso el proveedor a mano y puede estar mal.
- **"Deshacer último"**: un botón que resta la última lectura. Al escanear rápido es el error más común.
- **Lectura que no viene en la caja**: en vez de solo mostrar el error, ofrece "Anotar como no esperada" (se guarda en el borrador y se resuelve en la fase 3; hasta entonces es solo una nota visible en la confirmación).
- **Botón de cámara** al lado del campo (ver abajo).
- El campo de texto sigue siendo el mismo: un lector físico escribe ahí y manda Enter.

## Cámara: `components/LectorCamara.tsx` (nuevo, cliente)

- Dependencia: `barcode-detector` (polyfill sobre zxing-wasm). Usa el `BarcodeDetector` nativo donde existe (Chrome Android) y cubre Safari de iOS donde no.
- Formatos: `['qr_code', 'code_128']`. Si algún proveedor usa otro, se agrega `code_39`.
- `getUserMedia({ video: { facingMode: 'environment' } })`. Requiere HTTPS: funciona por el nombre `*.ts.net` de Tailscale Funnel, no por la IP del tailnet en `http://`.
- Bucle con `requestAnimationFrame` o cada ~150 ms, sobre un `<video>` a pantalla completa con un recuadro guía.
- **Rearme por ausencia, no por tiempo.** El uso es tipo caja registradora: se pasan diez filtros iguales uno detrás de otro, y todos tienen la misma etiqueta (el sufijo es el MRP, no un serial). Mientras una etiqueta sigue en cuadro, la cámara la detecta muchas veces por segundo y eso cuenta una sola vez. Se vuelve a contar el mismo `raw` cuando dejó de verse durante unos 300 ms, que es el hueco natural al cambiar una caja por la siguiente. Un cooldown por tiempo fijo frenaría justo el caso normal (diez cajas iguales seguidas). El umbral se ajusta en el depósito.
- **Modo gatillo (opcional):** un botón grande en pantalla que solo lee al tocarlo, como el gatillo de un lector físico. Para quien prefiera control total en vez de lectura continua.
- **Confirmación sin mirar**: pitido corto con WebAudio (agudo si sumó, grave si falló), `navigator.vibrate(60)` (solo Android) y un destello verde o rojo en el borde.
- **Linterna** si el track la soporta: `track.applyConstraints({ advanced: [{ torch: true }] })`.
- Expone `onLectura(raw)`; el padre llama a `leerCodigo` y `sumarLectura(…, 'camara')`.
- Al desmontar, detener los tracks (si no, la cámara queda encendida).

## Entrada manual (etiqueta rota o ilegible)

Tres niveles, todos en la misma pantalla, sin modo aparte:

1. **Se lee a la vista pero no escanea:** se teclean los últimos 4 o 5 caracteres en el campo de siempre; autocompleta contra las piezas de la caja.
2. **No se lee pero sé qué pieza es:** buscar por nombre en el mismo campo, o tocar la fila en la lista y usar sus botones + / − o escribir la cantidad.
3. **No sé qué pieza es:** "Anotar sin identificar" con una nota. En la fase 1 queda como nota en el borrador; en la fase 3 bloquea el cierre hasta resolverla.

## Lector físico (opcional)

- Tiene que ser **2D** (los láser 1D no leen QR).
- Configurarlo con su hoja de códigos para el teclado del sistema (español latino) y **sin sufijo de tabulador**, solo Enter. Igual, el parser tolera separadores mal traducidos.

## Hecho cuando

- `check:costeo` pasa con los casos de arriba.
- Desde el teléfono, en una caja real: escanear un QR de Bajaj suma 1, escanear una bolsa Code 128 suma su cantidad, un código alterno cae en la pieza correcta y tecleando parte del código también funciona.
