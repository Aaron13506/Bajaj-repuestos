# Revisión crítica del sistema: qué está flojo, qué falta y qué está mal

Revisión del 2026-10-12. Sale de leer el esquema, presupuestos, cobros, contabilidad, el costeo y los envíos; no se ejecutó la app.

> **Estado (2026-10-16): todo lo de abajo está atendido**, salvo lo que dice "queda". Las reglas viven en las skills `pedidos`, `dinero` y `envios`.
>
> - 1.1 Ventas del depósito (`/ventas`) y líneas de cliente servidas con lo del depósito (`PedidoItem.desdeStock`). Queda: servir un conjunto (hoy solo piezas sueltas).
> - 1.2 La brecha del saldo la asume el negocio. Se mide solo con lo que se anota (Bs cobrados y lo recibido al convertir), nunca con una tasa de mercado: aparece como costo de conversión en el resultado del mes.
> - 1.3 Cuentas (banco Bs, efectivo, USDT, banco USD), Bs y tasa por movimiento, conversión Bs → USDT con su costo.
> - 1.4 Un solo camino para cobrar (`cobrarPedido`), también desde Contabilidad.
> - 1.5 `/resultados`: margen realizado por pedido y resultado por mes.
> - 2.x Cancelar, editar confirmado, incidencias por línea y por pieza, validez y renovación, revalidar al aprobar, freno al entregar con saldo, historial de etapas y guía. Queda: entrega parcial de una línea al cliente y reembolso del proveedor ligado a una incidencia.
> - 3.1 `fx:update` recalcula el precio de catálogo cada hora.
> - 3.2 Dashboard de acción.
> - 3.3 Presupuestos perdidos y tasa de conversión.
> - 3.4 Next 16.4.2 estable. `check:costeo` cubre las reglas nuevas; sigue sin haber tests de integración versionados (solo `check:etapas`).

**Resumen.** La parte de costeo es muy buena: precisa y bien defendida. El problema es que **el sistema cubre solo el camino feliz de la compra y el costeo, y está casi ciego después de la venta**. Con un margen del 30%, ahí es donde se pierde la plata.

---

## 1. Lo grave: hace perder plata o muestra números falsos

### 1.1 El stock entra pero no tiene por dónde salir

No existe un flujo de venta de stock: ningún código descuenta `Product.stock` al vender. El comentario de `app/(pages)/products/actions.ts:70` dice "vender resta", pero esa función no existe.

- Todo lo que hay para stock propio (carril marítimo, `/inventario`, simulador CBM, insignias de stock en los armadores) termina en un callejón sin salida.
- Vender del depósito obliga a anotar un `otro_ingreso` suelto y bajar el stock a mano. Eso trae tres problemas:
  - no queda costo de lo vendido;
  - no se conoce el margen de esa venta;
  - el valor de inventario se infla si uno se olvida de bajar el stock.
- Un presupuesto de cliente con una pieza que ya está en el depósito la manda igual a comprar y a viajar en una caja: no existe una línea "servida desde stock".

### 1.2 El riesgo cambiario del saldo lo paga el negocio, y el libro no lo registra

El escalón de brecha se congela al aprobar (`Pedido.brechaEscalonPct`). El 50% restante se cobra en Bs semanas después, y `realDeCobro` (`lib/cobro-bcv.ts`) lo pasa a dólares reales con **ese factor congelado**.

- Si la brecha sube del 20% al 30% durante el viaje, entran menos dólares reales de los que anota el libro.
- La caja muestra plata que no existe, y la idea de que "se cobra a la tasa del día, sin riesgo" no se cumple para el saldo.
- Hay que decidir de forma explícita quién asume la brecha del saldo (recalcular el escalón al cobrar, o dejarlo pactado en los términos) y que el libro guarde lo que realmente entró.

### 1.3 El libro no sabe qué moneda entró

`Movimiento` guarda solo el monto en USD reales: ni los Bs que llegaron ni la tasa usada.

- La caja es un único saldo (`saldoCaja` en `lib/movimientos.ts`) que mezcla Bs en el banco (que se devalúan), efectivo en USD y USDT.
- No hay cuentas separadas ni conversiones. El spread de pasar de Bs a USDT para pagarle a India es un costo real en cada pedido y no aparece en ningún lado.
- No se puede cuadrar la caja contra el banco ni contra Binance.

### 1.4 Una segunda puerta reabre el bug del BCV

`MovimientoForm` en `/contabilidad` permite cargar un ingreso ligado a un pedido con "Pago móvil / Transferencia Bs" **sin la conversión BCV** (`app/(pages)/contabilidad/actions.ts:52`). La conversión solo la hace `registrarPagoPedido`.

Si se carga el cobro desde ahí, se guardan dólares BCV como si fueran reales: justo el error que el CLAUDE.md da por arreglado. Hay que hacer que esa puerta use la misma conversión o que no permita ligar cobros a pedidos.

### 1.5 No se sabe si se ganó

No hay margen realizado por pedido (venta contra el costo real de la caja) ni resultados por mes.

- `/contabilidad` muestra caja, por cobrar, por pagar e inventario, pero no utilidad.
- La ficha de la caja tiene un margen por caja, pero un pedido repartido en varias cajas no tiene el suyo.
- La memoria del proyecto ya registra que el margen de un presupuesto aislado puede ir de −133% a +37% por los escalones del flete, y aun así el sistema no dice cuál fue el real.

---

## 2. Flujos que faltan

### 2.1 No se puede cancelar

Si un cliente se arrepiente con la seña pagada, no hay estado para eso; `lib/pedido-eliminable.ts:13` lo reconoce en un comentario. El pedido queda vivo para siempre en "por cobrar".

### 2.2 Un pedido confirmado no se puede editar

Si el proveedor no tiene la pieza, si Bajaj la reemplazó por otro código (pasa seguido) o si cambia la cantidad, no hay ningún camino: `updatePresupuesto` rechaza todo pedido de cliente ya confirmado. Es lo más común del negocio por encargo.

### 2.3 No hay estados de excepción

El recorrido de cada línea (`lib/shipping-status.ts`) es solo el camino feliz:

- no tiene "no disponible", "llegó dañada", "perdida", "incompleta" ni "pieza equivocada";
- no hay recepción parcial: si llegan 3 de 5, no hay forma de anotarlo, porque el estado es por línea y no por unidad.

### 2.4 Reclamos y garantía

Los términos (`lib/terminos.ts`) prometen 48 horas para reclamar y garantía por defecto de fábrica, pero no hay dónde registrar un reclamo, ni su costo, ni el reemplazo.

### 2.5 Aprobar no revalida nada

`aprobarPedido` (`app/(pages)/presupuestos/actions.ts`):

- **Validez:** los 7 días son solo un texto en el PDF; un presupuesto de hace dos meses se aprueba igual, con precios y tasas viejos.
- **Descontinuadas:** `bloquearDescontinuadas` no se llama al aprobar, así que una pieza marcada como descontinuada después de cotizar pasa.
- **Escalón:** se congela el del día de aprobación, no el del PDF que vio el cliente: el total BCV que aceptó puede cambiar al aprobar.

### 2.6 Se puede entregar sin cobrar el saldo

No hay freno ni aviso al marcar una línea como `entregado` con saldo pendiente. Además, "por cobrar" no separa **entregado sin pagar** (el riesgo real) de **en tránsito** (lo normal).

### 2.7 No queda historial de etapas

`shippingStatusAt` guarda solo la última fecha, así que no se puede medir cuánto tarda de verdad India → Caracas, que es lo que se le promete al cliente. Tampoco hay número de guía o tracking en `Envio`.

---

## 3. Diseño flojo

### 3.1 `Product.price` es una caché que nunca se refresca sola

`fx:update` mueve las tasas cada hora, pero el precio guardado solo se recalcula al tocar medidas o al correr `prices:99rpm`. Y es el precio que el armador pone por defecto en el carrito (`components/PresupuestoBuilder.tsx:343`), al lado del sugerido calculado en vivo (`builder-actions.ts`): dos números para lo mismo.

### 3.2 El dashboard mide cosas que no sirven

- "Stock bajo (<5)" sobre todo el catálogo, en un negocio por encargo con miles de piezas en cero, es ruido.
- "Productos recientes" no informa nada.
- Lo útil sería ver: piezas por comprar, saldos de pedidos ya entregados, cajas paradas, presupuestos por vencer y deuda con proveedores.

### 3.3 Los presupuestos nunca se cierran

No hay estado de perdido o vencido, así que no se sabe qué porcentaje se convierte en pedido ni a quién hacerle seguimiento.

### 3.4 No hay tests

La única red son `check:costeo` y `check:libro`, con tanta lógica de dinero, locks y repartos al centavo. Y producción corre `next@16.4.0-canary.39`.

### 3.5 Las prioridades están invertidas

Hay muchísimo trabajo (y documentación) en el carril marítimo, que "todavía no se usa", en el comparador de proveedores y en el tope de tramo. Mientras tanto, vender del stock, cancelar un pedido o saber cuánto se ganó en el mes no existen.

---

## 4. Revisado y descartado: peso volumétrico en la cotización

`calcLanded` (`lib/calc.ts:218`) reparte el flete aéreo solo por `weightGrams`, mientras la caja real cobra max(peso real, volumétrico) en `calcEnvio`.

**No es un error: es una decisión.** La cotización es optimista a propósito: las cajas se arman para que pesen más de lo que miden, y en una caja atada por peso las piezas voluminosas viajan en la holgura casi gratis. Cotizarlas por volumétrico sería cobrarle al cliente un flete que la caja real no paga.

Lo único que queda como riesgo es una caja que, por cómo salió el armado, termine atada por volumen. Eso ya se ve en la ficha de la caja (`calcEnvio`), así que no hace falta cambiar la cotización.

---

## 5. Por dónde empezar

1. **Venta y salida de stock:** una línea servida "desde stock" que descuente piezas y registre el costo de lo vendido.
2. **Cobros con moneda real:** guardar los Bs y la tasa de cada cobro, tener cuentas de caja y registrar las conversiones. Decidir quién asume la brecha del saldo y dejarlo escrito en los términos. Cerrar la puerta lateral de `MovimientoForm` (1.4).
3. **Cancelación, sustitución y excepciones** en el recorrido de cada línea.
4. **Margen realizado** por pedido y por mes.
5. **Revalidar al aprobar:** validez, descontinuadas y escalón.
6. **Dashboard de acción:** lo que hay que hacer hoy, no conteos del catálogo.
