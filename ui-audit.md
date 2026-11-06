# Auditoría de UI del panel admin

Skills usadas: rams (nota 0-100, checklist local), harden, baseline-ui, better-accessibility,
better-layout, interface-affordances, interface-design, real-content-design, clarify.

Reglas de la pasada:
- Primero los componentes compartidos; después cada pantalla en orden, con un commit por pantalla.
- Se arreglan hallazgos de severidad alta y media. Lo bajo queda anotado.
- Lo que cambia el comportamiento de la app (no solo lo visual) NO se aplica: queda en "Pendiente".
- No hay tokens propios: el sistema es Tailwind crudo (gris/azul). Se reusa eso, no se inventa paleta.

## Hallazgos sistémicos (antes de empezar)

| Hallazgo | Dónde | Severidad |
|---|---|---|
| Modales hechos a mano (div fijo + click en el fondo): sin Escape, sin foco atrapado, sin `role="dialog"`, el foco no vuelve al botón | 8 formularios | Alta |
| `text-gray-400` sobre blanco (2,5:1, falla 4,5:1) | ~410 usos | Alta |
| Etiquetas `<label>` sin `htmlFor` ni envolviendo el campo | ~160 de 163 | Alta |
| Sin enlace "saltar al contenido"; el link activo del menú sin `aria-current`; dos `<h1>` por página (menú + página) | layout, Sidebar | Media |
| Menú lateral fijo de 256 px: en el teléfono no deja lugar a la página | layout, Sidebar | Media |
| `h-screen` en el shell (en móvil corta la barra del navegador) | layout | Media |
| Números de tablas sin `tabular-nums` (columnas de plata no alinean) | todas las tablas | Media |
| Errores con `alert()` en vez de al lado del botón | DeleteButton | Media |
| `confirm()` nativo para acciones destructivas en vez de un diálogo propio | DeleteButton, PendingButton, ConteoCaja, EnvioItemsTable | Baja (el nativo es accesible) |
| Texto de 10 px | ~100 usos | Baja |
| Animaciones de carga sin `prefers-reduced-motion` | loading.tsx | Baja |

## Componentes compartidos

- [x] `app/(pages)/layout.tsx`: `h-dvh`, enlace "Saltar al contenido", `<main id>` enfocable, padding de 16 px en móvil, menú arriba en el teléfono.
- [x] `components/Sidebar.tsx`: `aria-current="page"`, `<nav aria-label>`, `role="search"`, íconos `aria-hidden`; el título dejó de ser `<h1>` (cada página tiene el suyo); "Administración" con tilde; en móvil es una fila con scroll que muestra el ítem activo; contraste del placeholder y de la versión.
- [x] `app/(pages)/loading.tsx`: `role="status"`, animación solo con `motion-safe`.
- [x] `app/(pages)/error.tsx`: revisado, sin cambios (texto claro, Reintentar, código copiable).
- [x] `app/globals.css`: `tabular-nums` en todas las tablas; `prefers-reduced-motion` apaga spinners y transiciones.
- [x] `components/Modal.tsx` (nuevo, sobre `<dialog>` + `showModal()`) reemplaza los 8 overlays hechos a mano (AperturaCajaForm, CancelarPedidoForm, ConfirmarEntregaForm, DevolverClienteForm, PagarFleteForm, QuickEditProduct, RegistrarPagoClienteForm, RegistrarPagoProveedorForm). Escape cierra, el fondo queda inerte, el foco entra (o va al campo con `data-autofocus`) y vuelve al botón. Verificado en el navegador.
- [x] `components/VisorEnsamble.tsx`: el visor a pantalla completa pasa a `<dialog>` nativo; zoom con `aria-pressed`; contraste de los textos blancos.
- [x] `components/PendingButton.tsx`: revisado, sin cambios.
- [x] `components/DeleteButton.tsx`: `type="button"` (dentro de un form lo enviaba); el error se muestra al lado del botón en vez de `alert()`.
- [x] `components/FormConResultado.tsx` / `useEnviarAccion.ts`: revisados, sin cambios.
- [x] `components/CampoFecha.tsx`, `StockBadge.tsx`, `ChipDescontinuada.tsx`, `IndicadorMedido.tsx`: revisados, sin cambios (el estado va en texto, no solo en color).
- [x] Contraste: `text-gray-400` → `text-gray-500` en 64 archivos (4,8:1 sobre blanco). El menú y el visor (fondo oscuro) quedan igual.
- [x] Etiquetas: 101 campos en 28 archivos pasan de `<div><label>…</label><input></div>` a `<label><span>…</span><input></label>` (codemod; solo donde hay exactamente un campo y ningún botón adentro). El resto se hace por pantalla.

Bajo / pendiente de los compartidos:
- `confirm()` nativo en DeleteButton, PendingButton, ConteoCaja, EnvioItemsTable: es accesible; pasarlo a un diálogo propio no se hizo.
- En las etiquetas convertidas, el texto de ayuda que vive adentro del `<label>` entra en el nombre accesible (largo, no incorrecto).
- `text-gray-300` (53 usos) en separadores y "—": decorativo, queda.
- Texto de 10 px (~100 usos): se mira por pantalla.

## Pantallas

- [x] `/` Inicio (dashboard)
- [ ] `/buscar` Búsqueda
- [ ] `/products` Catálogo
- [ ] `/products/new` Nuevo producto
- [ ] `/products/[id]` Ficha de producto
- [ ] `/products/[id]/edit` Editar producto
- [ ] `/products/import` Importar productos
- [ ] `/products/discontinued` Descontinuados
- [ ] `/groups` Ensambles
- [ ] `/ensambles/new` Nuevo ensamble
- [ ] `/ensambles/[id]` Ensamble
- [ ] `/ensambles/[id]/edit` Editar ensamble
- [ ] `/suppliers` Proveedores
- [ ] `/suppliers/[id]/import` Importar precios
- [ ] `/presupuestos` Presupuestos
- [ ] `/presupuestos/new` Nuevo presupuesto
- [ ] `/presupuestos/[id]` Detalle de presupuesto/pedido
- [ ] `/presupuestos/[id]/edit` Editar presupuesto
- [ ] `/presupuestos/[id]/comparar` Comparar proveedores
- [ ] `/presupuestos/[id]/proveedor` Orden al proveedor
- [ ] `/ventas` Ventas del depósito
- [ ] `/ventas/new` Nueva venta
- [ ] `/ventas/[id]` Venta
- [ ] `/envios` Envíos y embarques
- [ ] `/envios/[id]` Caja aérea / embarque marítimo
- [ ] `/simular` Simular aéreo
- [ ] `/contabilidad` Contabilidad
- [ ] `/contabilidad/comprar` Registrar compras
- [ ] `/resultados` Resultados
- [ ] `/inventario` Inventario
- [ ] `/clientes` Clientes
- [ ] `/clientes/[id]` Cliente
- [ ] `/config` Configuración

## Registro por pantalla

| Pantalla | Rams antes | Rams después | Cambios | Pendiente |
|---|---|---|---|---|
| `/` | 83 | 97 | Listas cortadas en 8 muestran "Ver N más →" hacia la pantalla completa; plurales reales ("1 pedido", "6 líneas") en vez de "pedido(s)"; nombre truncado con title; h1 con text-balance. | Bajo: la tarjeta en alerta se distingue por color (el detalle en texto ya dice por qué); el valor de "Por comprar" en monoespaciada mezcla texto. |

## Pendiente (cambia comportamiento, no se aplicó)

(se completa a medida que avanza)
