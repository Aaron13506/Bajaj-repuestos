# Importar productos desde JSON

Esta guía explica el formato JSON que acepta la página **Productos → Importar JSON**
(`/products/import`). Sirve tanto para pegarlo a mano como para dárselo a una IA que
extraiga los datos de una página (99rpm, Boodmo, etc.).

> **Lo único obligatorio es `nameEs`** (el nombre en español). Todo lo demás es opcional:
> si no tenés un dato, **omitilo** (o ponelo en `null`). No inventes valores.

---

## Reglas generales

- **Margen:** NO lo pongas en el JSON. El margen se aplica internamente y es fijo en **40%**.
- **Stock:** NO hace falta. Entra siempre en `0` y se ajusta después desde la ficha.
- **Precio:** tampoco hace falta normalmente. Se calcula solo a partir de
  `priceInr` + `weightGrams` (+ dimensiones) y el margen del 40%.
  - Si querés forzar un precio de venta, podés mandar `price` (en USD) y ese gana.
  - Si una pieza no tiene `priceInr` ni `price`, se crea igual con **precio $0** para
    completarlo luego.
- **Cada pieza se crea por separado:** si una falla (ej. le falta `nameEs`), las demás
  igual se importan. Al final la página te muestra qué piezas fallaron y por qué.
- Los números pueden venir como número o como texto (`"450"`, `"₹450"` → `450`).

---

## Campos de una pieza

| Campo              | Tipo    | Obligatorio | Descripción |
|--------------------|---------|:-----------:|-------------|
| `nameEs`           | string  | **Sí**      | Nombre en español (se usa en presupuestos). |
| `nameEn`           | string  | No          | Nombre en inglés / catálogo Bajaj. |
| `bajajCode`        | string  | No          | Código de la pieza (ej. `JR161036`). |
| `compatibleModels` | string  | No          | Modelos compatibles (ej. `Pulsar N250/N160`). |
| `sourceUrl`        | string  | No          | URL de la página de origen. |
| `description`      | string  | No          | Descripción libre. |
| `notes`            | string  | No          | Notas o variantes. |
| `priceInr`         | número  | No          | Precio en India, en rupias ₹. **Base del costo.** |
| `weightGrams`      | número  | No          | Peso real en **gramos**. |
| `dimL`             | número  | No          | Largo en **cm**. |
| `dimA`             | número  | No          | Ancho en **cm**. |
| `dimH`             | número  | No          | Alto en **cm**. |
| `quantity`         | número  | No          | Solo dentro de un ensamble: cuántas unidades de esa pieza lleva (default `1`). |
| `price`            | número  | No          | Precio de venta en USD. Solo si querés forzarlo (normalmente se calcula). |
| `isAssembly`       | boolean | No          | `true` si la pieza es en sí un ensamble. Normalmente no hace falta ponerlo. |

### Tamaño y peso — cómo se cargan

- `weightGrams` → **gramos** (ej. 320 g = `"weightGrams": 320`). No uses kg.
- `dimL`, `dimA`, `dimH` → **centímetros**, en orden Largo × Ancho × Alto.
- Sirven para calcular el costo de envío (aéreo por peso, marítimo por volumen).
- Si no conocés alguna dimensión, omitila. Si no hay ninguna, el producto se crea igual,
  solo que sin esa parte del costo.

---

## 1. Un solo producto individual

Lo mínimo posible (solo el nombre):

```json
{ "nameEs": "Cable de embrague" }
```

Un producto individual completo (con tamaño y peso):

```json
{
  "nameEs": "Pastilla de freno trasera",
  "nameEn": "Rear Brake Pad",
  "bajajCode": "JR161036",
  "compatibleModels": "Pulsar N250/N160",
  "sourceUrl": "https://www.99rpm.com/...",
  "priceInr": 450,
  "weightGrams": 320,
  "dimL": 18,
  "dimA": 6,
  "dimH": 4
}
```

---

## 2. Varios productos individuales (lista plana)

Un **array** de piezas sueltas, sin ensamble:

```json
[
  { "nameEs": "Pastilla de freno", "bajajCode": "JR161036", "priceInr": 450, "weightGrams": 320 },
  { "nameEs": "Cable de embrague", "priceInr": 180, "weightGrams": 90, "dimL": 120, "dimA": 3, "dimH": 1 },
  { "nameEs": "Filtro de aceite", "priceInr": 220 }
]
```

Cada objeto del array se crea como un producto independiente.

---

## 3. Grupo / subgrupo / ensamble

### Conceptos (importante para la IA)

- **Ensamble (assembly / `group`):** un conjunto que agrupa piezas. Por ejemplo
  *"Pedal de freno trasero"* es un ensamble que contiene tornillos, un resorte, el pedal, etc.
  En la base se guarda como un producto con `isAssembly: true`.
- **Subgrupo (`subgroups[].name`):** una sección **dentro** del ensamble que agrupa piezas
  relacionadas. Ej. `Fasteners` (tornillería), `Spring` (resortes). Es solo una etiqueta
  de agrupación; el mismo ensamble puede tener varios subgrupos.
- **Pieza/producto (`products[]`):** cada componente individual que vive dentro de un subgrupo.

Jerarquía:

```
group (ensamble)
└── subgroups[]            ← cada uno tiene un "name"
    └── products[]         ← las piezas de ese subgrupo
```

Al importar:
1. Se crea el ensamble como producto (`isAssembly: true`).
2. Cada pieza de cada subgrupo se crea como producto.
3. Cada pieza se **enlaza** al ensamble, guardando el nombre del subgrupo y el orden.

### Ejemplo: un ensamble con subgrupos

```json
{
  "group": {
    "nameEs": "Pedal de freno trasero",
    "nameEn": "Rear Brake Pedal",
    "bajajCode": "JR161036",
    "compatibleModels": "Pulsar N250/N160",
    "sourceUrl": "https://www.99rpm.com/...",
    "subgroups": [
      {
        "name": "Fasteners",
        "products": [
          { "nameEs": "Tornillo M6", "bajajCode": "B0101", "priceInr": 12, "weightGrams": 8, "quantity": 2 },
          { "nameEs": "Tuerca M6",   "bajajCode": "B0102", "priceInr": 8,  "weightGrams": 4, "quantity": 2 }
        ]
      },
      {
        "name": "Spring",
        "products": [
          { "nameEs": "Resorte de retorno", "priceInr": 60, "weightGrams": 25, "dimL": 6, "dimA": 2, "dimH": 2 }
        ]
      },
      {
        "name": "Pedal",
        "products": [
          { "nameEs": "Pedal de freno", "bajajCode": "JR161000", "priceInr": 340, "weightGrams": 210, "dimL": 20, "dimA": 8, "dimH": 5 }
        ]
      }
    ]
  }
}
```

### Ejemplo: ensamble sin subgrupos (piezas directas)

Si las piezas no se dividen en secciones, podés ponerlas directo en `products`:

```json
{
  "group": {
    "nameEs": "Kit de carburador",
    "bajajCode": "CARB-001",
    "products": [
      { "nameEs": "Cuerpo de carburador", "priceInr": 1200, "weightGrams": 400 },
      { "nameEs": "Aguja", "priceInr": 90, "weightGrams": 5 },
      { "nameEs": "Flotador", "priceInr": 110, "weightGrams": 12 }
    ]
  }
}
```

(Internamente se enlazan a un subgrupo vacío.)

### Ejemplo: varios ensambles a la vez

```json
{
  "groups": [
    {
      "nameEs": "Pedal de freno trasero",
      "subgroups": [
        { "name": "Fasteners", "products": [ { "nameEs": "Tornillo M6", "priceInr": 12, "weightGrams": 8, "quantity": 2 } ] }
      ]
    },
    {
      "nameEs": "Tapa de embrague",
      "products": [
        { "nameEs": "Tapa", "priceInr": 800, "weightGrams": 600, "dimL": 22, "dimA": 18, "dimH": 6 },
        { "nameEs": "Junta", "priceInr": 45, "weightGrams": 15 }
      ]
    }
  ]
}
```

---

## Resumen de formatos aceptados

| Querés cargar…                         | Forma del JSON |
|----------------------------------------|----------------|
| Una sola pieza suelta                  | `{ ...pieza }` |
| Varias piezas sueltas                  | `[ {pieza}, {pieza} ]` |
| Un ensamble con subgrupos              | `{ "group": { ..., "subgroups": [...] } }` |
| Un ensamble con piezas directas        | `{ "group": { ..., "products": [...] } }` |
| Varios ensambles                       | `{ "groups": [ {...}, {...} ] }` |

---

## Prompt listo para darle a la IA

Copiá esto y pegáselo a la IA junto con la página del producto:

```
Extraé los datos de los productos de esta página y devolvémelos SOLO como JSON,
sin texto alrededor. Usá una de estas estructuras:

1) Una pieza suelta:        { ...campos... }
2) Varias piezas sueltas:   [ {pieza}, {pieza}, ... ]
3) Un ensamble con secciones:
   {
     "group": {
       "nameEs": "<nombre del ensamble>",
       "nameEn": "...", "bajajCode": "...", "compatibleModels": "...", "sourceUrl": "...",
       "subgroups": [
         { "name": "<nombre de la sección, ej Fasteners>", "products": [ {pieza}, ... ] }
       ]
     }
   }
4) Varios ensambles:        { "groups": [ {...}, {...} ] }

Campos de cada PIEZA (todos opcionales salvo nameEs):
- nameEs            (string, OBLIGATORIO) nombre en español
- nameEn            (string) nombre en inglés / catálogo
- bajajCode         (string) código de la pieza
- compatibleModels  (string) modelos compatibles
- sourceUrl         (string) URL de la página
- description       (string)
- notes             (string)
- priceInr          (número) precio en India en rupias ₹
- weightGrams       (número) peso en GRAMOS
- dimL, dimA, dimH  (número) dimensiones en CM (largo, ancho, alto)
- quantity          (número) solo en ensambles: cuántas de esa pieza lleva (default 1)

NO incluyas "margin" ni "stock" (se manejan internamente).
NO incluyas "price" salvo que quieras forzar un precio de venta en USD.
Si no encontrás un dato, omití ese campo. No inventes valores.
```
