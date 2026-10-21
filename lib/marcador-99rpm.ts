/**
 * Tildar un bloque de la lista de compra en la página del ensamble de 99rpm.
 *
 * El botón de cada bloque abre la página con lo que hay que tildar en el hash
 * (`#mk=SKU1,SKU2&q=2`) y el marcador —que corre en la pestaña de 99rpm, con tu sesión—
 * lo lee, tilda esas casillas, destilda las demás y pone el Qty. El "Add to cart" lo das
 * vos: es la última revisión antes de pagar.
 *
 * Se cruza por SKU contra el texto del `<label>` de cada casilla ("1 x Nombre| DJ161129|
 * 36DK0017 ₹ 40"), que trae los dos códigos de Bajaj. Si un SKU sale dos veces en la página
 * (en dos subgrupos) se tilda solo la primera: el bloque lo pide una vez.
 *
 * shortcut: las piezas sin código no viajan en el hash y no se tildan; son rarísimas en
 * 99rpm y la lista las muestra con "—". Si aparecen seguido, mandar también el nombre.
 */
export function urlTildar(sourceUrl: string, skus: (string | null)[], qty: number): string {
  const codigos = skus.filter((s): s is string => !!s).map(s => s.toUpperCase())
  return `${sourceUrl.split('#')[0]}#mk=${encodeURIComponent(codigos.join(','))}&q=${qty}`
}

// String y no función con toString(): el bundler renombraría y metería helpers en el cuerpo.
const CODIGO = `(function(){
var m=location.hash.match(/mk=([^&]*)&q=(\\d+)/);
if(!m){alert('Motokira: abrí esta página con el botón de la lista de compra.');return}
var pend=decodeURIComponent(m[1]).split(',').filter(Boolean),total=pend.length,ok=0,nls=[];
document.querySelectorAll('input[type=checkbox][name^="bundle_option"]').forEach(function(cb){
var l=document.querySelector('label[for="'+cb.id+'"]');
var toks=(l?l.textContent:'').toUpperCase().split(/[|\\s]+/);
var i=pend.findIndex(function(k){return toks.indexOf(k)>=0});
var quiero=i>=0;
if(quiero){var sku=pend.splice(i,1)[0];if(cb.disabled){nls.push(sku);return}ok++}
if(cb.checked!==quiero&&!cb.disabled)cb.click();
});
var q=document.getElementById('qty');
if(q){q.value=m[2];q.dispatchEvent(new Event('change',{bubbles:true}))}
alert('Motokira: tildadas '+ok+' de '+total+' · Qty '+m[2]
+(pend.length?'\\nNo están en la página: '+pend.join(', '):'')
+(nls.length?'\\nDeshabilitadas (NLS): '+nls.join(', '):'')
+(ok===total?'\\nRevisá y dale Add to cart.':''));
})()`

export const MARCADOR_99RPM = `javascript:${encodeURIComponent(CODIGO)}`
