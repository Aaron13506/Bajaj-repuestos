# Fase 5: ubicaciones y conteo cíclico

Requiere la fase 2 (los ajustes del conteo son movimientos del kardex). Aprovecha el lector de la fase 1.

## Ubicaciones

Un solo depósito, así que alcanza con un texto por pieza:

```prisma
model Product {
  // …
  // Dónde está en el depósito ("A-3": estante A, nivel o caja 3). Texto libre, en mayúsculas.
  // Null = sin asignar.
  ubicacion  String?
  // Último conteo cíclico que la incluyó. Null = nunca se contó.
  contadoAt  DateTime?
}
```

Si algún día hay más de un depósito, se pasa a una tabla `Ubicacion` y a stock por ubicación. Hoy sería complejidad sin uso.

### Etiquetas de estante

- Cada estante o caja lleva un QR con `UBI:A-3`. El prefijo es lo que distingue una ubicación de una pieza.
- `lib/qr-bajaj.ts` pasa de `leerCodigo` a `leerEtiqueta(raw)`, que devuelve `{ tipo: 'ubicacion', codigo }` o `{ tipo: 'pieza', codigo, cantidad }`. Casos nuevos en `check:costeo`.
- `/inventario/etiquetas`: genera un PDF para imprimir con `jspdf` (ya es dependencia) y la librería `qrcode`.

### Asignar al recibir (putaway)

- En la recepción (fase 3), después de cada lectura el aviso dice a dónde va: `+1 DH181135 → A-3`.
- Si la pieza no tiene ubicación: `sin ubicación, escanea el estante`. La siguiente lectura de una etiqueta `UBI:` se la asigna.
- Lo mismo sirve fuera de la recepción, en el modo Consultar del teléfono: escaneas la pieza y luego el estante.

### Donde se muestra

La ficha de la pieza, `/inventario`, la venta del depósito (`/ventas/new`) y la tabla de la caja. Al servir un pedido desde el depósito, saber el estante ahorra buscar.

## Conteo cíclico

En vez de un inventario completo una vez al año, se cuenta un pedazo cada vez. Es la práctica estándar.

```prisma
// Un conteo físico de una parte del depósito (un estante, o una lista de piezas).
model ConteoInventario {
  id         Int       @id @default(autoincrement())
  ubicacion  String?   // null = por lista de piezas, no por estante
  abiertoAt  DateTime  @default(now())
  cerradoAt  DateTime?
  notas      String?
  lineas     ConteoInventarioLinea[]
}

model ConteoInventarioLinea {
  id        Int     @id @default(autoincrement())
  conteoId  Int
  productId Int
  // Product.stock al abrir el conteo, para mostrar la diferencia si no es ciego.
  sistema   Int
  // Vacío = sin contar; 0 = la busqué y no está.
  contado   Int?

  conteo  ConteoInventario @relation(fields: [conteoId], references: [id], onDelete: Cascade)
  product Product          @relation(fields: [productId], references: [id], onDelete: Restrict)

  @@unique([conteoId, productId])
}
```

### Flujo

1. **Abrir:** por estante (escaneas `UBI:A-3` y se cargan las piezas con esa ubicación) o por lista sugerida.
2. **Contar:** ciego, con el mismo lector. Una pieza que aparece en el estante y no estaba en la lista se agrega (y se le asigna esa ubicación).
3. **Cerrar:** por cada fila con diferencia, un movimiento `conteo` en el kardex. La diferencia se calcula contra el stock **al cerrar**, no contra la foto al abrir. Si la pieza tuvo movimientos durante el conteo (una venta en el medio), la pantalla lo avisa antes de cerrar. Las diferencias grandes piden nota.
4. `Product.contadoAt = now()` para todas las filas contadas.

### Qué contar (lista sugerida en `/inventario/conteo`)

- Piezas con stock que **nunca** se contaron, o hace más de 60 días.
- Piezas con **movimientos recientes**: lo que más se mueve es lo que más se desajusta.
- Piezas donde una **venta falló por stock** o hubo un **ajuste a mano** reciente.

Con unos pocos estantes por semana, todo el depósito se cuenta solo, sin un día de inventario.

## Chequeos

- **`check:costeo`:** `leerEtiqueta` (ubicación contra pieza) y el cálculo de diferencias con movimientos durante el conteo.
- **`check:etapas`:** cerrar dos veces no duplica los movimientos `conteo`.

## Hecho cuando

- Un estante real se cuenta desde el teléfono, la diferencia queda como movimiento `conteo` con su nota, y la ficha de cada pieza muestra ubicación y fecha del último conteo.
