# Casos del teléfono, lectura por lectura

Referencia de qué hace la pantalla en cada situación. El uso es tipo caja registradora: se agarra lo primero que esté a mano, se pasa, y suma en su fila. Nunca hay que buscar una pieza en la lista para contarla.

**Regla base:** cada lectura suma la cantidad que trae la etiqueta (`-1` suma 1, `-2` suma 2). Solo lo tecleado sin cantidad suma 1.

## Modo Recibir

1. **Caja de Bajaj (QR, `-1`).** Suma 1. Aviso verde, pitido agudo: `+1 DH181135 · Pastilla freno del.`. En modo ciego muestra solo el total contado; fuera del ciego, "3 de 4".
2. **Bolsa reempacada (Code 128, `-N`).** Suma N. Aviso ámbar, doble pitido: `+2 bolsa`, con **Corregir** unos segundos. Si traía 3, se escribe 3 y queda una corrección manual de +1.
3. **Código alterno.** Igual que 1 o 2, con la nota "leído como JR233069". Misma fila.
4. **Varias cajas iguales seguidas** (diez filtros). Cada una suma. La misma etiqueta vuelve a contar cuando dejó de verse unos 300 ms, el hueco natural al cambiar de caja. Una caja quieta frente a la cámara cuenta una sola vez.
5. **Sobra.** Suma igual. En ciego se ve al cerrar; fuera del ciego el aviso dice "sobran 2". Al cerrar entra como `sobrante_recepcion`.
6. **En el catálogo pero no en esta caja.** No suma. Aviso rojo, pitido grave: "no viene en esta caja". Opciones: **Anotar como no esperada** (fila con esperado 0; al cerrar es sobrante, o `equivocada` si llegó en lugar de otra) o **Ignorar**.
7. **No está en el catálogo.** No suma. Aviso rojo: "DX123456 no está en el catálogo". Opciones: **Anotar** (guarda el código) o **Crear pieza** (alta con el código puesto). Bloquea el cierre hasta que exista la pieza o se descarte.
8. **Piezas sueltas sin etiqueta** (una bolsa rota con 6 arandelas). No hay qué escanear: se toca la fila y se escribe la cantidad. Es el único caso donde se teclea una cantidad.
9. **Error.** **Deshacer** en el aviso quita la última lectura. Para una anterior, se toca la fila y se ajusta con + / − o escribiendo el número. Nada se borra: todo queda como lectura.
10. **Etiqueta rota o ilegible.** Si el código se lee a la vista, se teclean los últimos 4 o 5 caracteres y autocompleta con las piezas de la caja. Si no, búsqueda por nombre o tocar la fila.
11. **Pieza sin etiqueta y desconocida.** **Sin identificar**, con nota o foto. Bloquea el cierre hasta asignarla a una pieza o descartarla.
12. **Conjuntos y códigos repetidos.** Un conjunto se cuenta por piezas (cada una trae su etiqueta). Un código que viene para varios pedidos es una sola fila con el total; el reparto lo hace el cierre.
13. **Etiqueta de estante (`UBI:A-3`, fase 5).** No suma. Si la última pieza leída no tenía ubicación, se la asigna: "DH181135 → A-3".
14. **Falla de red.** Aviso rojo: "No se guardó, reintenta". No cuenta hasta que el servidor confirme, así la pantalla nunca muestra un número que la base no tiene.
15. **La laptop cerró la recepción mientras se escaneaba.** "Esta recepción ya está cerrada", con el resumen.

Con un lector físico pasa lo mismo: una lectura por cada vez que se aprieta el gatillo. Solo cambia el origen guardado (`lector`).

## Peso y medidas

- **Al marcar la llegada:** peso y medidas opcionales del bulto completo, para comparar contra lo que cobró el transportista.
- **Durante el conteo:** la primera vez que se lee un código con medidas estimadas aparece, debajo del aviso, "Medidas estimadas. ¿La mides ahora?" con **Medir** y **Ahora no**.
  - **Ahora no** la oculta para ese código durante toda la recepción.
  - **Medir:** peso en gramos y largo, ancho y alto en centímetros, con el estimado como referencia. Base siempre "empaque". Si la lectura era una bolsa de N, las unidades del empaque vienen en N y el peso por unidad se divide.
  - Validación de `chequearMedidas`: densidad imposible se rechaza, rara solo avisa.
  - Guardar la medida no toca el conteo.
- **Ya medidas:** no pregunta nada. Las medidas con base desconocida ofrecen re-medir con un aviso discreto.
- **Modo Medir:** se escanea y abre el formulario directo, sin contar.

## Otros modos

- **Consultar:** ficha con stock, ubicación, precio, medido o estimado, y pedidos y cajas donde aparece. Fuera del catálogo, ofrece crearla.
- **Vender:** suma N al carrito sin pasar del stock disponible; la cantidad se puede editar.
- **Inventario:** suma N en el estante que se está contando. Si la pieza tenía otra ubicación: "Estaba en B-1, ¿la muevo a A-3?".

## Señales sin mirar

- **Pitido agudo:** sumó 1.
- **Doble pitido:** bolsa, sumó N.
- **Pitido grave:** no sumó, hay que mirar la pantalla.
- **Silencio:** la misma etiqueta sigue en cuadro, no se volvió a contar.
