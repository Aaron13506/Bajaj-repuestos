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
- [x] Contraste: `text-gray-400` → `text-gray-500` en 64 archivos (4,8:1 sobre blanco). El menú y el visor (fondo oscuro) quedan igual. Después, en commit aparte: text-red-500/amber-600/green-600/sky-500 → un tono más oscuro (quedaban entre 2,8:1 y 3,8:1) en 21 archivos.
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
- [x] `/products/discontinued` Descontinuados
- [x] `/groups` Ensambles
- [x] `/ensambles/new` Nuevo ensamble
- [x] `/ensambles/[id]` Ensamble
- [x] `/ensambles/[id]/edit` Editar ensamble
- [x] `/suppliers` Proveedores
- [x] `/suppliers/[id]/import` Importar precios
- [x] `/presupuestos` Presupuestos
- [x] `/presupuestos/new` Nuevo presupuesto
- [x] `/presupuestos/[id]` Detalle de presupuesto/pedido
- [x] `/presupuestos/[id]/edit` Editar presupuesto
- [x] `/presupuestos/[id]/comparar` Comparar proveedores
- [x] `/presupuestos/[id]/proveedor` Orden al proveedor
- [x] `/ventas` Ventas del depósito
- [x] `/ventas/new` Nueva venta
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
| `/products/discontinued` | 83 | 97 | Si marcar/desmarcar falla por red o server se muestra el error al lado (antes la promesa sin atrapar tiraba la pantalla entera al error genérico). Resultado con role=status. Ayuda vinculada al textarea con aria-describedby. Tabla con overflow-x-auto (se recortaba en móvil), breadcrumb con flex-wrap, nombres largos que cortan. Título de pestaña. | Bajo: "Marcadas hoy" se lee como "marcadas en el día" cuando es el total actual. |
| `/groups` | 80 | 96 | Vacío sin filtros ofrece "Crear el primero" (antes "limpiá los filtros" sin haber filtros); con filtros dice "Ningún ensamble coincide". Piezas sin sub-grupo bajo "Sin sub-grupo" en vez de "—". "1 sub-grupo". Nombres truncados con title. Miniatura con alt="" (el nombre está al lado). Cabecera de página y de cada tarjeta con wrap y padding de 16 px en móvil. Paginación en <nav>. Los filtros heredan las etiquetas de CatalogFilters. | Bajo: "Editar" de cada tarjeta lleva a la ficha (donde se edita el despiece), no a /edit. |
| `/ensambles/new` | 81 | 97 | EnsambleForm: "Moto *" como role=group con aria-labelledby y la ayuda en aria-describedby (las casillas no tenían a qué pregunta respondían). Ejemplos de nombre de ensamble ("Freno trasero" / "Rear Brake Assembly") en vez de los de una pieza. Breadcrumb con wrap. Título de pestaña. | — |
| `/ensambles/[id]/edit` | 78 | 97 | Hereda EnsambleForm (ver /ensambles/new). Breadcrumb con flex-wrap y nombre que corta (los nombres de 99rpm son largos); h1 "Editar ensamble" en vez de "Editar". Título de pestaña. | — |
| `/ensambles/[id]` | 47 | 94 | El botón de cada pieza dice "Quitar" (decía "Eliminar" y solo la saca del ensamble). AddComponentForm: buscador y select con nombre, aviso de "ninguna coincide" y de falla de búsqueda (antes callado / rechazo sin atrapar). MedidasIA (compartido con presupuestos y envíos): el <h2> envuelve al botón (antes un h2 dentro del button), aria-expanded, flecha aria-hidden; buscador con nombre y resultado role=status; ensamble activo con aria-pressed; textarea asociado con useId; copiar con aviso de fallo y "Copiado" anunciado; botones de 24 px; resultado role=status. Peso/medidas faltantes en red-600 (red-400 no llegaba a 4,5:1). Cabecera con wrap, h1 que corta, link externo avisado, "1 pieza". | Bajo: "Editar"/"Quitar" repetidos en cada fila sin el nombre de la pieza en el nombre accesible. |
| `/suppliers` | 88 | 97 | Cada proveedor es role=group con su nombre (los campos repetían "Nombre/Origen/FOB" sin decir de cuál). Ayuda del FOB visible y enlazada con aria-describedby (antes solo en title, invisible en teclado y teléfono). "1 precio cargado". Fila de acciones con wrap y padding de 16 px en móvil. Link interno a Configuración con <Link>. | Bajo: la explicación menciona ?proveedor=id (jerga de URL). |
| `/suppliers/[id]/import` | 63 | 95 | Textarea asociado a su etiqueta. Copiar con type=button, área de 24 px, aviso si el portapapeles falla y "Copiado" anunciado. Resultado con role=status. Título con wrap/balance (incluye el nombre del proveedor). Título de pestaña. | Bajo: el resultado aparece debajo del formulario. |
| `/presupuestos` | 60 | 95 | Buscador con aria-label y form role=search. Pestaña activa con aria-current="page". El 🔒 de "no se puede eliminar" lleva el motivo en texto para lector de pantalla y sube a gris 500 (antes solo title en gris 300). Filas y cabecera con flex-wrap y padding de 16 px: verificado a 390 px sin scroll horizontal. Vacío con enlace "Crear el primer presupuesto". "Presupuestos y pedidos" en minúscula. | Bajo: el motivo del candado sigue sin verse por teclado para quien ve (es un span, no un control); "Ver" repetido en cada fila. |
| `/presupuestos/new` | 52 | 92 | Armador: 12 campos sin nombre ahora tienen etiqueta (moto, buscadores con type=search, cantidades y precio por línea con el nombre de la pieza, cliente/referencia con htmlFor, teléfono type=tel). Botones de quitar (✕ e ícono) con aria-label por pieza, gris 500 y área más grande. Chip de compatibilidad con aria-expanded. Búsqueda de pieza: try/catch y línea role=status ("Ninguna pieza coincide", "Lo que coincide ya está en el presupuesto", "No se pudo buscar"); antes un rechazo quedaba sin aviso y la búsqueda vacía no decía nada. Miniaturas del buscador con alt="" (el nombre está al lado). Textos gris 300 → 500. Verificado: 0 campos sin nombre; búsqueda vacía y con resultados. | Medio: el desplegable de resultados no es un combobox (sin flechas ni aria-activedescendant). (A 390 px se verificó en /presupuestos/5/edit: sin scroll horizontal.) |
| `/presupuestos/[id]` | 66 | 93 | "Ir a Por comprar" llevaba a /compras, que no existe (404): ahora va a /contabilidad/comprar, igual que la tarjeta del inicio. Cabecera y filas de acciones con wrap (a 390 px los botones se salían de la pantalla; verificado #5 y #18 sin scroll horizontal). Tabla de piezas con overflow-x-auto y columna de foto con nombre sr-only. "No se puede cancelar / eliminar" lleva el motivo en texto para lector de pantalla (antes solo title). Barra de avance aria-hidden (el texto al lado ya dice N de M). Código Bajaj del desglose gris 300 → 500. Padding de 16 px en móvil. | No se pudo ver un presupuesto abierto ni uno cancelado: la copia local no tiene ninguno. Bajo: el motivo del candado sigue sin verse por teclado para quien ve. |
| `/presupuestos/[id]/edit` | 85 | 96 | Hereda los arreglos del armador. Ruta de migas dentro de <nav aria-label="Ruta">. Título con balance/break-words (incluye el nombre del cliente). Verificado #5 con piezas: 0 campos sin nombre y sin scroll horizontal a 390 px. | — |
| `/presupuestos/[id]/comparar` | 72 | 94 | Totales: si a un proveedor le faltan líneas (sin SKU o sin peso), el total lo dice ("sin N líneas") y una nota explica el —; antes el total más bajo podía serlo solo por sumar menos piezas. "—" con texto para lector de pantalla. La celda más barata dice "(el más barato)" en sr-only (antes solo verde). Vacío si no hay piezas. Migas en <nav>, cabecera sin flex vacío, "/suppliers" → "Proveedores". Verificado #5 sin scroll horizontal y sin errores en consola. | Medio (comportamiento): el "vs 99rpm" compara totales con distinto set de líneas cuando falta alguna; habría que comparar solo las líneas comunes. |
| `/presupuestos/[id]/proveedor` | 80 | 95 | PrintButton (compartido con el PDF del presupuesto): type=button, ícono aria-hidden y el motivo del fallo como texto role=alert (antes solo title). Vacío si el pedido no tiene piezas. Tabla con overflow-x-auto y nombres con break-words. Migas en <nav>, cabecera con wrap. Verificado #5: 4 filas, sin scroll horizontal ni errores de hidratación. | Bajo: encabezados en inglés (SKU/Part/Qty) a propósito, porque es para el proveedor. |
| `/ventas` | 74 | 95 | Buscador y selector de mes con aria-label, form role=search, "Filtrar" type=submit. Vacío con enlace "Registrar una venta". Filas y cabecera con wrap, padding de 16 px en móvil y break-words en cliente y notas. Verificado a 390 px: 2 filas, sin scroll horizontal y 0 campos sin nombre. | Bajo: "Ver" repetido sin el nombre del cliente. |
| `/ventas/new` | 55 | 93 | VentaDirectaForm: 5 campos visibles sin nombre más los que aparecen después (moto, buscadores con type=search, cliente con aria-labelledby, cliente nuevo nombre/teléfono tel, nota, cantidad/precio/costo por línea con el nombre de la pieza, "Cobrado" con htmlFor). Quitar con el nombre de la pieza y área más grande. Búsqueda de pieza con try/catch y línea role=status ("No tenés en stock nada que coincida" / "No se pudo buscar"). La carga de piezas de un ensamble ahora tiene catch y aviso role=alert (antes un rechazo sin manejar dejaba la lista vacía, como si no hubiera piezas). "ya agregado" azul 500 → 700. Miniaturas con alt="". Verificado: 0 campos sin nombre, aviso de búsqueda vacía, sin scroll horizontal a 390 px. | Medio: el desplegable de resultados no es un combobox (sin flechas). No se probó una venta completa (crea movimientos). |

## Pendiente (cambia comportamiento, no se aplicó)
- `/products/import`: El prompt para la IA pide motos "por id del enum MotoModel" (el enum se dropeó; la fuente es compatibleModels en texto) y dice "margen fijo 40%" (el margen por defecto sale de Config). Corregir el texto cambia lo que la IA devuelve y lo que se importa: decidirlo aparte.
