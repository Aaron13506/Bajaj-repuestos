# Sistema de Recompensas (Puntos)

Programa de fidelidad para Bajaj Repuestos. El cliente **gana puntos al comprar** y los **canjea por productos de mantenimiento**.

## Cómo funciona

- **Ganar:** $1 gastado = 1 punto. Sale automático del total del pedido (no se configura por producto).
- **Canjear:** cada producto tiene un *precio en puntos*. El cliente usa sus puntos acumulados para llevarse productos de mantenimiento (filtros, bujías, pastillas, kits, etc.).

## Fórmula

```
precio_venta = costo / (1 - margen)        # margen 33% → precio = costo × 1,5
puntos_para_canjear = precio_venta / tasa_de_retorno
```

> **Importante:** los puntos se calculan sobre el **precio de venta** (lo que el cliente pagaría), NO sobre el costo. Tu costo real de regalar el producto siempre es menor (el costo landed), y ahí está tu protección de margen.

### Atajo del costo a puntos (margen 33%)

Como `precio = costo × 1,5`, se puede ir directo del costo a puntos con un solo multiplicador (`multiplicador = 1,5 / tasa`):

| Tasa de retorno | Multiplicador (costo → puntos) |
|---|---|
| 3% | × 50 |
| 4% | × 37,5 |
| 5% | × 30 |
| 6% | × 25 |
| 7% | × 21,4 |
| 8% | × 18,75 |
| 9% | × 16,7 |
| 10% | × 15 |
| 11% | × 13,6 |
| 12% | × 12,5 |
| 13% | × 11,5 |
| 14% | × 10,7 |
| 15% | × 10 |

### Regla de oro

Con margen de **33%**, lo que regalás siempre es:

```
% de tu ganancia que regalás = 2 × tasa de retorno
```

Ej: 5% de retorno = 10% de tu ganancia regalada.

## Tabla de referencia — Kit de arrastre

**Costo $100 · Precio de venta $150**

| Tasa retorno | Multiplicador (costo → pts) | Puntos para canjear | Gasto del cliente | Tu ganancia (33%) | Te cuesta el canje | Te queda neto | % de ganancia que regalás |
|---|---|---|---|---|---|---|---|
| **3%** | × 50 | 5.000 | $5.000 | $1.667 | $100 | $1.567 | 6% |
| **4%** | × 37,5 | 3.750 | $3.750 | $1.250 | $100 | $1.150 | 8% |
| **5%** | × 30 | 3.000 | $3.000 | $1.000 | $100 | $900 | 10% |
| **6%** | × 25 | 2.500 | $2.500 | $833 | $100 | $733 | 12% |
| **7%** | × 21,4 | 2.143 | $2.143 | $714 | $100 | $614 | 14% |
| **8%** | × 18,75 | 1.875 | $1.875 | $625 | $100 | $525 | 16% |
| **9%** | × 16,7 | 1.667 | $1.667 | $556 | $100 | $456 | 18% |
| **10%** | × 15 | 1.500 | $1.500 | $500 | $100 | $400 | 20% |
| **11%** | × 13,6 | 1.364 | $1.364 | $455 | $100 | $355 | 22% |
| **12%** | × 12,5 | 1.250 | $1.250 | $417 | $100 | $317 | 24% |
| **13%** | × 11,5 | 1.154 | $1.154 | $385 | $100 | $285 | 26% |
| **14%** | × 10,7 | 1.071 | $1.071 | $357 | $100 | $257 | 28% |
| **15%** | × 10 | 1.000 | $1.000 | $333 | $100 | $233 | 30% |

## Zonas de decisión

- **3-5% (conservador):** regalás 6-10% de tu ganancia. Sano y sostenible como base permanente.
- **6-9% (medio):** regalás 12-18%. Atractivo, pero ya se siente en el margen. Para etapa de crecimiento.
- **10-15% (agresivo):** regalás 20-30%. Solo como **promo temporal** (campañas, doble puntos), nunca como base fija.

## Recomendación

- **Base permanente: 5%** de retorno. Estándar de la industria, atractivo y suave para el margen.
- **No bajar el precio de venta** para premiar — el precio es el oxígeno del margen y se le regala a todos (incluido el que compra una sola vez). La generosidad va por los puntos, que solo "pagan" cuando el cliente vuelve y canjea.
- **Breakage:** mucha gente nunca canjea, así que el costo real suele ser menor al peor caso de la tabla.
- La tasa de retorno será **una sola clave en `Config`** — se ajusta cambiando un número, sin tocar precios ni recalcular producto por producto.

## Estructura de datos (pendiente de implementar)

- Modelo **Cliente** con balance de puntos.
- Puntos ganados por pedido (campo en `Pedido`).
- Campo `pointsPrice` en `Product`, calculado automático desde el precio de venta.
- Modelo **Canje** (historial: quién canjeó qué y cuántos puntos).
- Clave `tasaRetorno` en `Config` (valor inicial: 5%).
