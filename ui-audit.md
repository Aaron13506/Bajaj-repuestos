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
- [x] `/buscar` Búsqueda
- [x] `/products` Catálogo
- [x] `/products/new` Nuevo producto
- [x] `/products/[id]` Ficha de producto
- [x] `/products/[id]/edit` Editar producto
- [x] `/products/import` Importar productos
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
| `/buscar` | 76 | 97 | Campo con aria-label y form role=search; estado inicial que explica qué busca y el atajo #123; sin resultados sugiere qué probar (y el texto largo se corta); grupos topados en 15 lo dicen; nombres truncados con title. | Bajo: los grupos topados no enlazan a la lista completa filtrada. |
| `/products` | 37 | 94 | CatalogFilters (compartido con otras listas): aria-label en modelo, categoría, búsqueda y peso; búsqueda type=search; "Buscando…" con role=status. Vacío con filtros dice "Ningún producto coincide" + Limpiar filtros (antes ofrecía "Agregar el primero"). Botón ▶ de ensambles con aria-label y 24 px. Columna de nombre a 300 px (el nombre en español se leía "Prot…") y title en los truncados. Texto celeste de la ruta marítima a sky-700/500 por contraste. Cabecera y paginación con flex-wrap (móvil); paginación en <nav>. "g" con abbr "Peso en gramos". | Bajo: "Editar"/"Eliminar" repetidos en cada fila sin el nombre de la pieza en el nombre accesible; el color del stock (rojo/amarillo/verde) acompaña al número. |
| `/products/new` | 66 | 95 | ProductForm: "Motos" y "Foto" como role=group con aria-labelledby; filtro y select de "Ensamble padre" con nombre (htmlFor + aria-label). ModelPicker: botón de familia con aria-pressed (antes "todas marcadas" era solo color) y cada familia como grupo con nombre (la casilla decía solo "BS6"). PegarImagen: la zona enfocable para pegar tiene rol, nombre y aria-busy. FichaProductoIA: textarea con nombre y resultado con role=status. Separadores "/" del breadcrumb aria-hidden en las 18 pantallas que lo usan. Títulos de pestaña en las 13 páginas que no tenían (WCAG 2.4.2). "Nuevo producto" en minúscula como el resto. | Bajo: el "*" de obligatorio se lee como asterisco; los botones "Nuevo Producto" del listado siguen en mayúscula inicial. |
| `/products/[id]` | 63 | 95 | Peso y ₹ en 0 se muestran (antes "—", contra la regla vacío ≠ cero); medidas parciales con "?" en lo que falta en vez de esconderlas todas. AddToAssemblyForm: buscador y select con nombre; avisa "Ningún ensamble coincide" cuando la búsqueda volvió vacía y "No se pudo buscar" si falló (antes quedaba callado; un rechazo quedaba sin atrapar). "Grupo: X · 2×" sin el punto colgando cuando no hay grupo. Cabecera con min-w-0/flex-wrap y h1 que corta palabras largas. Link a la fuente avisa que abre otra pestaña. Título de pestaña "Producto". | Bajo: el desglose es una lista de div y no un <dl>; el título de pestaña no incluye el nombre de la pieza (costaría otra consulta por render). |
| `/products/[id]/edit` | 55 | 97 | Hereda lo corregido en ProductForm/ModelPicker/PegarImagen (ver /products/new) y el título de pestaña. Breadcrumb en <nav> con un nivel a la ficha de la pieza (antes solo volvía al listado). "Editar producto" / "Guardar cambios" en minúscula. Verificado: ningún campo sin nombre. | Bajo: "Cancelar" del formulario vuelve al listado y no a la ficha (es navegación del componente compartido con "nuevo"). |
| `/products/import` | 66 | 94 | Textarea del JSON asociado a su etiqueta. Botones "Copiar" con type=button y área de 24 px. Si el portapapeles falla se avisa (antes no pasaba nada) y "Copiado" se anuncia por role=status. El resultado de la importación es role=status. | Bajo: el resultado aparece debajo del formulario y en pantallas chicas puede quedar fuera de vista. |

## Pendiente (cambia comportamiento, no se aplicó)
- `/products/import`: El prompt para la IA pide motos "por id del enum MotoModel" (el enum se dropeó; la fuente es compatibleModels en texto) y dice "margen fijo 40%" (el margen por defecto sale de Config). Corregir el texto cambia lo que la IA devuelve y lo que se importa: decidirlo aparte.
