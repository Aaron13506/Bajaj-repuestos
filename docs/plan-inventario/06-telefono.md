# Fase 6: la pantalla del teléfono (`/escanear`)

No es una fase aparte en el tiempo: se construye por partes junto con las demás.

- **Con la fase 1:** el lector de cámara dentro de `ConteoCaja`, y el modo Consultar.
- **Con la fase 2:** el modo Vender.
- **Con la fase 3:** el modo Recibir y el emparejamiento con la laptop.
- **Con la fase 4:** el modo Medir.
- **Con la fase 5:** el modo Inventario y la asignación de ubicaciones.

## Conexión

No hay app nativa: el teléfono abre el mismo sistema en el navegador.

- **HTTPS:** la cámara solo funciona en un contexto seguro. Por el nombre `*.ts.net` de Tailscale Funnel funciona; por la IP del tailnet en `http://`, no.
- **Login:** el mismo de siempre (oauth2-proxy). La cookie queda en el teléfono.
- **Instalable (PWA):** `app/manifest.ts` con `display: 'standalone'`, `orientation: 'portrait'`, `start_url: '/escanear'` e íconos. Se instala con "Agregar a pantalla de inicio" y abre a pantalla completa.
  - Ojo: el navegador pide el manifiesto y los íconos **sin cookies**. Hay que dejarlos pasar en `proxy.ts` y en `skip_auth_routes` de `deploy/oauth2-proxy.cfg`, o la instalación falla en silencio.
- **Sin service worker al principio.** Solo hace falta si la señal del depósito obliga a trabajar offline (cola de lecturas en IndexedDB).

## Rutas

En un grupo propio, `app/(escaneo)/`, con un layout sin el `Sidebar` de `(pages)`, a pantalla completa y pensado para una mano:

- `/escanear`: elegir modo.
- `/escanear/recepcion/[id]`: recibir una caja (fase 3). Es el enlace del QR que muestra la laptop.
- `/escanear/consultar`
- `/escanear/inventario/[id]`: un conteo cíclico (fase 5).
- `/escanear/venta`: arma una venta del depósito y la abre en `/ventas/new` para cobrarla.
- `/escanear/medir`

## Cómo se ve (de arriba a abajo)

1. **Barra superior:** el modo y el contexto ("Caja #48 · 99rpm · 12/18 códigos"), y un botón para volver.
2. **Cámara:** ocupa la mitad superior, con un recuadro guía en el centro. Botones flotantes de linterna y de pausa.
3. **Aviso de la última lectura**, grande: `+1 DH181135 · Pastilla freno del. → 3`. Verde si sumó, ámbar si es una bolsa (`+2 (bolsa)` con "corregir"), rojo si no viene en la caja. Con botón "Deshacer".
4. **Campo manual**, siempre visible: código, parte del código o nombre. Autocompleta contra lo que corresponde al modo (las piezas de la caja al recibir; todo el catálogo al consultar).
5. **Lista** (se desliza hacia arriba): las filas de la caja o del conteo, con + / − y la cantidad editable. En modo ciego, sin la columna "Esperado".
6. **Botón final** según el modo: "Cerrar recepción", "Cerrar conteo", "Ir a cobrar".

## Modos

- **Recibir:** lectura → `registrarLectura`. El aviso agrega la ubicación de destino (fase 5).
- **Consultar:** lectura → ficha corta: stock, ubicación, precio de venta, medido o estimado, en qué pedidos y cajas aparece, y botones a "Medir" y "Asignar ubicación".
- **Inventario:** primero el estante (`UBI:`), después las piezas.
- **Vender:** cada lectura agrega la pieza a la venta en armado (respetando el stock disponible).
- **Medir:** lectura → formulario de peso y medidas en base `empaque`, con las unidades del empaque si era una bolsa.

## Detalles del lector

(La implementación está en la fase 1, `LectorCamara`.)

- `barcode-detector` con `['qr_code', 'code_128']`.
- **Rearme por ausencia:** la misma etiqueta vuelve a contar cuando dejó de verse unos 300 ms, así diez cajas iguales pasadas seguidas suman 10. Modo gatillo opcional (lee solo al tocar).
- **Pitido** (WebAudio), **vibración** (`navigator.vibrate`, solo Android) y **destello** de color.
- **Linterna** con `applyConstraints({ advanced: [{ torch: true }] })` donde el teléfono la soporte.
- **Pantalla encendida** mientras la cámara está activa: `navigator.wakeLock.request('screen')`.
- Al salir de la pantalla o pausar, se detienen los tracks de la cámara.

## Emparejar con la laptop

- En `/envios/[id]`, con la recepción abierta, la laptop muestra un QR con la URL `/escanear/recepcion/[id]`. Lo escaneas con la cámara del teléfono y quedas en esa recepción.
- La laptop hace `router.refresh()` cada 3 s mientras el panel está abierto y la pestaña visible (`document.visibilityState`). Para un solo usuario no hace falta SSE ni websockets.
- Las dos pantallas escriben por las mismas acciones con candado de la recepción, así que pueden usarse a la vez.

## Server actions

Las mismas de la fase 3 (`registrarLectura`, `corregirConteo`, `deshacerLectura`…) y de las demás fases. La pantalla del teléfono no tiene lógica propia de negocio: devuelve `ActionResult` con el estado de la fila para pintar el aviso, y en caso de error, el texto se muestra en el aviso rojo.

## Hecho cuando

- Instalada en el teléfono, abre directo en `/escanear` sin barra del navegador.
- Se puede recibir una caja entera sin tocar la laptop, con la laptop mostrando el progreso si está abierta.
- Con la etiqueta rota, la pieza se cuenta igual por el campo manual o la lista.
