# Plan de inventario: escaneo, kardex y recepción

Objetivo: que el depósito funcione con las mismas prácticas que un WMS o un ERP (Odoo, SAP, NetSuite), adaptadas a este sistema y a un solo operador, con el teléfono como herramienta principal.

Hoy el sistema ya resuelve bien varias cosas: la recepción contra lo esperado por caja, las incidencias (faltante, dañada, equivocada, sin enviar), las cajas como las pesó el transportista (`EnvioCaja`), la marca de medido contra estimado (`medidoAt`) y el flete real por encima del estimado. Este plan corrige lo que no sigue la práctica estándar y agrega el escaneo.

## Problemas que resuelve

1. **El conteo no decide lo que entra.** `ConteoCaja` guarda el conteo en `localStorage` y la recepción suma lo esperado, no lo contado (`recibirEmbarque` suma `EnvioLinea.quantity`; en aéreo `saveItemChanges` pasa todo a `en_venezuela`). El conteo se borra al confirmar.
2. **El stock no tiene libro.** `Product.stock` es un entero que se edita desde unos diez lugares sin dejar rastro, mientras que la plata sí tiene libro (`Movimiento`).
3. **"Llegó" y "ya lo conté" son el mismo estado.** Mover una línea a `en_venezuela` (o una caja marítima a `entregado`) apaga el conteo, cuando la llegada es justo el momento de contar.
4. **Medidas en dos bases distintas.** El catálogo estimado es la pieza desnuda; lo que se pesa en el conteo es la pieza con su bolsa o caja. Las dos van a las mismas columnas.
5. **No hay ubicaciones** ni conteo cíclico.
6. **No se puede escanear.** Las cajas de Bajaj traen QR y las bolsas reempacadas por el proveedor traen Code 128, los dos con el formato `SKU-cantidad<separador>MRP`.

## Fases

Cada fase sirve por sí sola y prepara la siguiente.

1. [Lector: QR, Code 128 y entrada manual](01-lector.md). Sin cambios de esquema.
2. [Kardex: libro de movimientos de stock](02-kardex.md)
3. [Recepción: llegada, conteo persistido, cierre y backorder](03-recepcion.md)
4. [Medidas en una sola base](04-medidas.md)
5. [Ubicaciones y conteo cíclico](05-ubicaciones-conteo.md)
6. [La pantalla del teléfono (`/escanear`)](06-telefono.md). Se construye por partes junto con las fases 1, 3 y 5.
7. [Casos del teléfono, lectura por lectura](07-casos-telefono.md). Referencia de qué pasa en cada situación; no es una fase.

El orden 2 antes de 3 es a propósito: la recepción es el primer lugar que escribe en el kardex, así que el kardex tiene que existir antes.

## Principios (los de `CLAUDE.md`, aplicados al inventario)

- **El libro es la verdad, `Product.stock` es caché.** Igual que `Movimiento` y `Pedido.depositUsd`.
- **Vacío no es cero.** `contado = null` es "sin contar"; `0` es "la busqué y no está".
- **Un documento validado no se reabre: se corrige con movimientos nuevos.** Una recepción cerrada se corrige con un ajuste, una incidencia o una reversa con contramovimientos.
- **Reglas puras en `lib/`**, compartidas por la pantalla (que esconde el botón) y la acción (el candado real), con casos en `check:costeo` o `check:etapas`.
- **Escrituras con guarda**, no leer y después escribir: `updateMany where <estado esperado>` y actuar según el conteo de filas.
- **Errores legibles con `ActionResult`** y `ErrorDeNegocio` adentro.

## Estados de una caja al llegar (fase 3)

Tomado de cómo lo separan los ERP:

1. **En tránsito.** Lo que ya existe (etapas y tracking).
2. **Llegada (check-in).** La caja está en mis manos. Se anota fecha y, si hace falta, peso y estado del bulto. No toca el stock. Habilita el conteo.
3. **En recepción.** Se está contando. Se puede pausar y retomar desde cualquier dispositivo.
4. **Recibida (validada).** Al cerrar se generan los movimientos de stock y las incidencias. El conteo queda bloqueado.
5. **Ubicada.** Cada pieza en su estante (fase 5).

## Decisiones pendientes

- **Reparto de un faltante entre pedidos** cuando el mismo código viene para varios. Propuesta: lo absorbe primero el stock propio, después el pedido de cliente más nuevo. Así el cliente que lleva más tiempo esperando es el último en quedarse sin su pieza.
- **Costo de un sobrante:** $0 (regalo del proveedor) o costo landed (lo va a cobrar). Propuesta: vacío ("no se sabe") hasta que se resuelva, siguiendo la regla de vacío no es cero.
- **Rearme de la cámara:** una etiqueta igual vuelve a contar cuando dejó de verse unos 300 ms (uso tipo caja registradora). El umbral se ajusta en el depósito.

## Fuera de alcance

- El MRP que traen las etiquetas: el parser lo descarta.
- Las líneas `isLanded`: no viajan en la caja y siguen su flujo actual.
- Modo offline del teléfono. Se agrega solo si la señal del depósito lo exige (cola en IndexedDB).
