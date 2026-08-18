// ─────────────────────────────────────────────────────────────────────────────
// Prompt de investigación de peso y dimensiones.
//
// Vive acá y no dentro de un componente porque lo usan tres pantallas (ficha de
// ensamble, presupuesto y envío) y tiene que ser EL MISMO texto en todas: si se
// duplica, una copia se queda vieja y los datos que entran al catálogo dejan de ser
// comparables entre sí.
//
// Va en español NEUTRO a propósito: lo lee un modelo, no un argentino. Cada modismo
// rioplatense es una palabra que el modelo desambigua en vez de obedecer.
//
// Tres decisiones sostienen el texto, y cada una corrige una falla observada:
//  · El código Bajaj está degradado a identificador, con tope duro de 2 búsquedas.
//    Antes el modelo agotaba el SKU (que en >95% no tiene peso publicado) y de ahí
//    saltaba a estimar por geometría, salteándose lo único que funciona: la pieza
//    equivalente de otra marca.
//  · Peso y volumen pesan igual: el aéreo cobra max(real, volumétrico) y de ahí sale
//    el precio de venta; el marítimo cobra m³. Ningún campo deriva del otro.
//  · Validación visual obligatoria en piezas propias de la moto. Los nombres del
//    catálogo son genéricos o mal traducidos y el modelo alucinaba la pieza a partir
//    del nombre — una "T" de suspensión no es una placa en T.
//
// Está escrito lo más corto posible SIN sacar el porqué de cada regla: la
// justificación es lo que sostiene al modelo en el caso borde que el prompt no previó.
// Lo que se recortó fue el porqué REPETIDO, no el porqué.
// ─────────────────────────────────────────────────────────────────────────────

export const MEASURES_PROMPT = `Eres un especialista en repuestos de motocicleta. Te paso una lista de piezas
(con id, bajajCode, nombre, "quantity" y "falta") y necesito el PESO y las DIMENSIONES de envío de
cada una.

Voy a AUDITAR la respuesta a mano, pieza por pieza y abriendo los enlaces. Un dato inventado que se
ve ordenado me cuesta dinero real en flete y en precio de venta, así que cada número tiene que venir
con la evidencia de dónde salió.

REGLA CENTRAL — EL CÓDIGO BAJAJ NO SE BUSCA, SOLO IDENTIFICA:
Para más del 95% de estos códigos no hay peso ni dimensiones publicados en ninguna parte, y eso es lo
normal, no un fracaso de búsqueda. Toda la investigación se hace sobre el TIPO DE PIEZA, buscando la
EQUIVALENTE de cualquier otra marca y modelo: un retén, una zapata o un resorte del mismo tipo pesan
y miden casi igual sin importar quién los venda.
LÍMITE DURO: 2 búsquedas por el código (tal cual, y sin guiones ni espacios). Después esa vía queda
cerrada. El grueso del trabajo — 4 o 5 búsquedas por pieza — va en el tipo genérico y sus equivalentes.

LOS DOS DATOS SE FACTURAN, NINGUNO ES SECUNDARIO:
- AÉREO: cobra el PESO FACTURABLE = el mayor entre el peso real y el volumétrico (L × A × H / 5000).
  De ese cálculo sale además el precio de venta, así que un peso a ojo se lo traslado al cliente.
- MARÍTIMO: cobra por METRO CÚBICO. Ahí manda el volumen, salvo que la pieza pase de ~1000 kg/m³ y el
  transportista cobre por peso igual.
- O sea: un peso preciso con dimensiones inventadas arruina el costo tanto como lo inverso. Los cuatro
  campos se investigan con el mismo cuidado y se devuelven SIEMPRE los cuatro, aunque "falta" pida uno
  solo — el que ya tengo lo uso para contrastar el tuyo y detectar errores.

UNA SOLA UNIDAD: "quantity" (x2 amortiguadores, x4 arandelas) es cuántas usa este ensamble y es solo
contexto de búsqueda. Peso y dimensiones son SIEMPRE de UNA unidad. Si la única fuente da un par o un
kit ("shock absorber pair: 3.1 kg"), divide e indica de qué total partiste.

PASO 1 — IDENTIFICAR LA PIEZA (antes de buscar peso):
- Define qué componente genérico es ("zapata de freno de tambor trasero", "retén de horquilla"), su
  función, el material probable y su clase de tamaño. Va en la primera línea de la ficha: si la pieza
  está mal identificada, todo lo demás estuvo midiendo otra cosa.
- El nombre, el código y los modelos compatibles son PISTAS para llegar ahí. El modelo de moto dice en
  qué vehículo va la pieza, no cuánto pesa.
- Traduce bien el término técnico al inglés (brake shoe, fork oil seal, clutch cable, sprocket): los
  catálogos con especificaciones publicadas están casi todos en inglés.

VALIDACIÓN VISUAL — OBLIGATORIA EN TODA PIEZA PROPIA DE LA MOTO:
- ESTÁNDAR / FERRETERÍA (tornillo, tuerca, arandela, clip, o-ring, retén, resorte, cable, rodamiento):
  el nombre alcanza, son piezas normalizadas.
- PROPIA DE LA MOTO (tija o "T" de suspensión, basculante, tapas de motor, soportes, ejes, palancas,
  piñones, carcasas, tableros, cualquier pieza fundida o estampada con forma propia): el nombre NO
  alcanza y ASUMIR ES EL ERROR. Los nombres del catálogo Bajaj son genéricos o mal traducidos
  ("bracket", "plate", "cover", "T") y cubren piezas que difieren 10 veces en peso: una "T" de
  suspensión es aluminio forjado de 800 g a 1,5 kg, no la chapita de 80 g que sugiere el nombre. Ese
  error es de un orden de magnitud y no lo detecta ningún chequeo posterior, porque todo lo demás cierra.
- Abre la IMAGEN antes de estimar nada: el despiece de 99rpm o boodmo para ese código, la foto del
  equivalente de otra marca, o el diagrama del manual de taller. Describe lo que ves y no lo que el
  nombre sugiere: forma real, cuántos brazos y agujeros, fundida / estampada / inyectada, maciza o hueca.
- ESCALA POR VECINDAD: dimensiona la pieza contra un vecino de medida conocida del mismo despiece
  (tornillo M6 = cabeza 10 mm · barra de horquilla 30–37 mm · paso de cadena 12,7 mm) y di cuál usaste.
  Eso convierte una foto en una medida.
- La ficha lleva una línea "visual:" con el enlace y qué se ve. Si no conseguiste imagen, escríbelo tal
  cual ("sin imagen — identificación solo por nombre, baja confianza"): esas filas las audito primero.

PASO 2 — ESCALERA DE EVIDENCIA (declara el nivel en cada pieza):
- A · dato publicado de la pieza exacta. Es el ideal, pero no esperes alcanzarlo casi nunca, y no lo
  persigas más allá del límite de 2 búsquedas.
- B · pieza EQUIVALENTE de otra marca o modelo con peso o medidas publicados. ES EL CAMINO NORMAL y
  donde debe estar el grueso de tu evidencia: Honda, Yamaha, Suzuki, Kawasaki, TVS, Hero, Royal
  Enfield, KTM, aftermarket genérico, cualquier cilindrada y año. Que el resultado sea de otra marca es
  exactamente lo que quiero, no un defecto del hallazgo.
- C · rango de familia: varias piezas del mismo tipo y clase de tamaño, de distintas marcas. No hay
  equivalente exacta pero el rango acota el valor: se toma la mediana y se reporta el rango.
- D · geometría (fórmula abajo). Solo si B y C fallaron, y tienes que escribir qué buscaste y por qué no
  sirvió. Sin esa línea, la fila se considera inventada.
- AUTOCONTROL: si más de 1 de cada 4 piezas te queda en nivel D, la investigación fue insuficiente.
  Vuelve a B con otros términos antes de entregar.
- PISO POR PIEZA: 3 fuentes utilizables, de al menos 2 marcas o modelos distintos. Un valor solo, sin
  nada con qué compararlo, no es un dato: es una apuesta.
- VARÍA los términos, no repitas la consulta: nombre genérico en inglés ("brake shoe weight") ·
  equivalente concreto ("Honda CB125 brake shoe specifications") · la medida normalizada cuando la pieza
  la tiene (diámetro de retén, paso de cadena, métrica del tornillo) · variantes de la métrica ("item
  weight", "net weight", "package dimensions"). Muestra todos los valores, incluidos los descartados y
  por qué: un rango amplio es información, no un problema.

FILTRO ANTI-PLACEHOLDER (antes de usar cualquier número):
- Descarta o marca como sospechoso: 0,5 kg / 1 kg / 100 g exactos en un marketplace (es el valor por
  defecto del formulario) · caja 10×10×10 o cualquier L = A = H · peso 0, 0,001, "N/A", "-" o vacío ·
  el mismo peso repetido en todas las variantes de una familia (autocompletado, no medido).
- "shipping weight" incluye caja y relleno y viene redondeado hacia arriba: no es el peso de la pieza.
  Úsalo solo si no hay otra cosa, e indícalo.
- De cada fuente copia la FRASE TEXTUAL donde aparece el dato ("Weight: 0.320 kg") junto al enlace
  exacto. Sin frase textual la fuente no cuenta para el piso de 3. Y no cites una fuente que no abriste:
  un enlace inventado es peor que no encontrar nada, porque me hace confiar en un número falso.

PASO 3 — CRUZAR LOS VALORES:
1. NORMALIZA UNIDADES ANTES DE COMPARAR — es la causa número uno de un valor 10 o 100 veces mal:
   1 kg = 1000 g · 1 lb = 453,6 g · 1 oz = 28,35 g · 1 mm = 0,1 cm · 1 pulgada = 2,54 cm.
2. Con los valores que sobreviven al filtro, toma la MEDIANA, no el promedio: el promedio se deforma
   con un solo valor malo, la mediana no.
3. Trata como atípico lo que supere 3× la mediana o baje de 1/3; descártalo explicando por qué (suele
   ser otra pieza, un kit, o una unidad mal leída) y recalcula.
4. Ante conflicto, pondera por fuente: ficha del fabricante > "item weight" de tienda > "shipping
   weight" > estimación propia.
5. El valor final tiene que quedar DENTRO del rango observado, y ese rango (mín–máx) va en la ficha.

PASO 4 — DIMENSIONES DEL BULTO (no todo viaja en caja):
- EN BOLSA — piezas chicas, acumulables y repetitivas (tornillos, tuercas, arandelas, clips, o-rings,
  gomas y topes chicos, resortes chicos, terminales): viajan sueltas en bolsa dentro de un bulto
  compartido. Sus dimensiones son las de la PIEZA MISMA y NO se les suma empaque. Inventarle una caja a
  un tornillo M6 multiplica su volumen decenas de veces y hace impagable un embarque que en realidad
  son cuatro bolsitas.
- EN CAJA — piezas grandes, frágiles, con forma propia o que ya vienen encajadas (amortiguadores,
  carcasas, faros, discos, plásticos de carrocería): envolvente + empaque real, +1 cm por lado en
  medianas, +2 cm en grandes o frágiles.
- Ante la duda mira el peso: menos de ~150 g y pieza de ferretería o de goma va en bolsa. Indica en la
  ficha cuál de los dos casos aplicaste.
- Mide la pieza EN LA POSICIÓN EN QUE VIAJA, no estirada: un cable de embrague de 1,8 m viaja enrollado
  (≈ 20 × 20 × 3 cm), no en un bulto de 180 cm. Confundir esto multiplica el flete.
- Redondea hacia arriba al medio centímetro: conviene sobreestimar levemente para no perder dinero en
  el flete, pero con margen chico y prudente, no exagerado.

PASO 5 — CHEQUEO FÍSICO (en todas las filas, muestra la cuenta):
- densidad implícita = weightGrams / (dimL × dimA × dimH), en g/cm³.
- Referencia: acero 7,8 · aluminio 2,7 · goma 1,2 · plástico 0,9–1,4.
- INVARIANTE DURO: la densidad implícita NUNCA puede superar la del material. Si la supera hay un error
  seguro (casi siempre el peso, o una confusión kg/g). Corrígelo y vuelve a chequear.
- Que dé bastante MENOR que el material es normal si la pieza no llena la caja (un soporte, un cable
  enrollado); explícalo en una línea. En una pieza en bolsa, en cambio, da CERCA de la del material y
  eso es correcto: no infles el bulto para "corregirla".
- Absurdamente bajo en una pieza maciza (0,1 g/cm³ en un disco de acero) = peso mal o caja inflada.

FÓRMULA DEL NIVEL D: peso ≈ (dimL × dimA × dimH) × factor de llenado × densidad del material.
Factor orientativo: maciza mecanizada (piñón, eje, disco) 0,5–0,8 · goma o retén 0,3–0,5 · carcasa
plástica hueca 0,15–0,35 · chapa, soporte, cable o resorte 0,10–0,25. Ancla la escala en algo real (una
medida estándar de la pieza, su proporción en el despiece, el tamaño de la pieza vecina): una geometría
sin ancla es un número inventado con más pasos.

QUÉ DEVOLVER:

1) FICHA POR PIEZA — una por cada pieza que te pasé, sin excepción:

   JR161036 — Pastilla de freno trasera (x1)
   identificada como: zapata de freno de tambor trasero (metal + ferodo, tamaño mediano)
   visual: https://… → media luna con ferodo pegado y dos orejas de anclaje; en el despiece mide unas
           3 veces el rodamiento de rueda contiguo (≈ 13 cm de diámetro)
   búsquedas: "rear drum brake shoe weight" · "Honda CB125 brake shoe specifications" ·
              "brake shoe 130mm weight" · código Bajaj (2 intentos, sin resultados)
   nivel: B (equivalentes de Honda y TVS con peso publicado)
   hallazgos: 320 g (boodmo) · 340 g (Amazon, Honda CB125) · 310 g (catálogo TVS) ·
              0,5 kg (AliExpress — DESCARTADO: valor por defecto del anuncio)
   cruce: rango 310–340 g · mediana 320 g · elegido 320 g · acero + ferodo
   dims: 18 × 6 × 4 cm (caja, empaque incluido) → densidad 320 / 432 = 0,74 g/cm³ (no maciza, coherente)
   fuentes:
     - https://… → "Weight: 0.320 kg"
     - https://… → "Item weight: 340 g"

2) El JSON final, dentro de un bloque \`\`\`json … \`\`\`, con TODAS las piezas que te pasé (misma cantidad
   de filas que la lista de entrada):

\`\`\`json
[
  {
    "bajajCode": "<el código que te di>",   // o "id": <el id que te di>
    "weightGrams": <peso en GRAMOS>,
    "dimL": <largo en CM>,
    "dimA": <ancho en CM>,
    "dimH": <alto en CM>
  }
]
\`\`\`

Reglas del JSON:
- Identifica cada fila con "bajajCode" (o "id") EXACTAMENTE como te lo di. No lo inventes.
- weightGrams en gramos y dimL/dimA/dimH en cm, siempre de UNA sola unidad, nunca del conjunto.
- Todas las piezas van con los 4 campos completos: nada de null, nada vacío, ninguna fila faltante. Si
  no hay dato directo, entrega tu mejor estimación fundamentada — prefiero eso a un hueco que después
  tengo que volver a pedir.
- Sin precio ni margen. El bloque debe ser válido y contener únicamente el array: la ficha y las fuentes
  van FUERA.`
