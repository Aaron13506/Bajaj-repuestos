import type { CompraPorEnsamble } from './compra-99rpm'

/**
 * Cargar al carrito de 99rpm la lista de compra entera, y verificarla, de un clic.
 *
 * 99rpm es un Magento 1: "Add to cart" es un POST a la `action` del form
 * `product_addtocart_form` del ensamble, con `form_key` (uno por sesión), `product` (el id del
 * ensamble), `qty` (multiplica toda la selección) y un `bundle_option[<subgrupo>][]=<pieza>` por
 * casilla tildada. `bundle_option_qty[<subgrupo>]=N` reemplaza la cantidad del despiece por N
 * (probado: el perno "de a 5" entró como "2 x"). Si sale bien redirige al carrito; si no,
 * vuelve a la página del ensamble. El carrito lista cada pieza como "N x Nombre| SKU1| SKU2"
 * dentro de la línea del ensamble, multiplicada por el Qty de la línea.
 *
 * El botón de la lista abre el carrito de 99rpm con la lista en el hash (`#mkc=<json>`) y el
 * marcador —que corre en esa pestaña, con tu sesión—:
 *  1. Lee el carrito y reparte lo que ya hay entre las piezas de la lista, por SKU.
 *  2. Lo que falta lo agrega desde su ensamble con la cantidad exacta: un POST por ensamble
 *     (más, solo si dos piezas del mismo subgrupo llevan cantidades distintas).
 *  3. Lo que no está en su ensamble o sale NLS lo busca por SKU en el buscador de 99rpm (trae
 *     ensambles de cualquier moto: es la misma pieza Bajaj) y lo agrega desde el primero que la
 *     tenga habilitada.
 *  4. Vuelve a leer el carrito y deja un panel: qué agregó, qué falta todavía y qué hay en el
 *     carrito que la lista no pide (o de más). Sobrantes no se borran solos.
 * Como solo agrega lo que falta, volver a tocarlo es la verificación: no duplica. Pagar sigue
 * siendo a mano.
 *
 * Si un SKU sale dos veces en la página (en dos subgrupos) se toma la primera casilla
 * habilitada.
 *
 * shortcut: las piezas sin código no viajan y no se agregan; son rarísimas en 99rpm y la lista
 * las muestra con "—". Si aparecen seguido, mandar también el nombre.
 * shortcut: si la casilla no deja cambiar la cantidad (customQty 0, 2 de 28.640) entra la del
 * despiece; la verificación lo marca como faltante o sobrante.
 */
export function urlCarrito99(datos: CompraPorEnsamble): string {
  const lista = datos.ensambles
    .filter(e => e.sourceUrl)
    .map(e => ({
      u: e.sourceUrl!.split('#')[0],
      n: e.nombre,
      // [SKU, unidades]. Cada pieza cae en una sola pasada, así que no se repiten.
      s: e.bloques.flatMap(b => b.piezas.flatMap(p => (p.sku ? [[p.sku.toUpperCase(), p.unidades]] : []))),
    }))
  return `https://www.99rpm.com/bajaj/checkout/cart/#mkc=${encodeURIComponent(JSON.stringify(lista))}`
}

// String y no función con toString(): el bundler renombraría y metería helpers en el cuerpo.
// Bucles a mano sobre los NodeList: 99rpm carga prototype.js, que pisa Array#filter/map/find
// y revientan con `[].filter.call(nodeList)`.
const CODIGO = `(async function(){
var m=location.hash.match(/^#mkc=(.+)$/);
if(!m){alert('Motokira: abrí el carrito de 99rpm con el botón «Cargar al carrito» de la caja.');return}
var lista=JSON.parse(decodeURIComponent(m[1])),items=[],cache={},por={},otros=[],mal=[],envios=0,n=0;
lista.forEach(function(e){e.s.forEach(function(p){items.push({s:p[0],u:p[1],e:e})})});
function esperar(){return new Promise(function(r){setTimeout(r,300)})}
function slug(u){return u.split('/').pop().replace('.html','')}
async function pagina(u){
if(!(u in cache)){try{cache[u]=new DOMParser().parseFromString(await(await fetch(u)).text(),'text/html')}catch(x){cache[u]=null}}
var d=cache[u];return d&&d.getElementById('product_addtocart_form')?d:null}
function casilla(d,sku){
var cs=d.querySelectorAll('input[type=checkbox][name^="bundle_option"]'),pri=null;
for(var i=0;i<cs.length;i++){
var l=d.querySelector('label[for="'+cs[i].id+'"]');
if((l?l.textContent:'').toUpperCase().split(/[|\\s]+/).indexOf(sku)<0)continue;
if(!cs[i].disabled)return cs[i];
pri=pri||cs[i]}
return pri}
async function leerCarrito(){
var d=new DOMParser().parseFromString(await(await fetch('/bajaj/checkout/cart/')).text(),'text/html'),ls=[];
d.querySelectorAll('#shopping-cart-table tbody tr').forEach(function(r){
var q=r.querySelector('input[name^="cart["]');if(!q)return;
var mult=+q.value||0;
r.querySelectorAll('.item-options dd').forEach(function(dd){
dd.innerHTML.split(/<br\\s*\\/?>/i).forEach(function(h){
var t=h.replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/\\s+/g,' ').trim(),k=t.match(/^(\\d+) ?x (.*)$/);
if(k)ls.push({u:+k[1]*mult,toks:k[2].toUpperCase().split(/[|\\s]+/),txt:k[2].split('₹')[0].trim()})})})});
return ls}
function cubrir(ls){
items.forEach(function(it){it.falta=it.u;
ls.forEach(function(l){if(it.falta>0&&l.u>0&&l.toks.indexOf(it.s)>=0){var x=Math.min(l.u,it.falta);l.u-=x;it.falta-=x}})});
return ls}
async function agregar(d,sel){
var f=d.getElementById('product_addtocart_form'),fd=new FormData();
fd.append('form_key',f.querySelector('[name=form_key]').value);
fd.append('product',f.querySelector('[name=product]').value);
fd.append('qty',1);
sel.forEach(function(x){fd.append(x.cb.name,x.cb.value);fd.set('bundle_option_qty['+x.cb.name.match(/\\d+/)[0]+']',x.n)});
envios++;
var r=await fetch(f.getAttribute('action'),{method:'POST',body:fd});
return r.url.indexOf('/checkout/cart')>=0}
document.title='Motokira: leyendo el carrito …';
cubrir(await leerCarrito());
var buscar=[];
for(var e of lista){
document.title='Motokira '+(++n)+'/'+lista.length+' …';
var fal=[];items.forEach(function(it){if(it.e===e&&it.falta>0)fal.push(it)});
if(!fal.length)continue;
if(!/^https:\\/\\/www\\.99rpm\\.com\\//.test(e.u)){mal.push(e.n+': URL que no es de 99rpm');continue}
var d=await pagina(e.u),tandas=[];
fal.forEach(function(it){
var cb=d&&casilla(d,it.s);
if(!cb||cb.disabled){por[it.s]=!d?'no abrió la página':cb?'NLS':'no está en la página';buscar.push(it);return}
var o=cb.name.match(/\\d+/)[0],ta=null;
for(var i=0;i<tandas.length&&!ta;i++)if(!(o in tandas[i].q)||tandas[i].q[o]===it.falta)ta=tandas[i];
if(!ta){ta={q:{},sel:[]};tandas.push(ta)}
ta.q[o]=it.falta;ta.sel.push({cb:cb,n:it.falta,s:it.s})});
for(var ta of tandas)if(!await agregar(d,ta.sel))mal.push(e.n+': 99rpm no aceptó '+ta.sel.map(function(x){return x.s}).join(', '));
await esperar();
}
for(var x of buscar){
document.title='Motokira buscando '+x.s+' …';
var dd=null,cb=null,url=null;
try{
var sr=new DOMParser().parseFromString(await(await fetch('/bajaj/catalogsearch/result/?q='+encodeURIComponent(x.s))).text(),'text/html');
var as=sr.querySelectorAll('.category-products .product-name a'),urls=[];
for(var i=0;i<as.length&&urls.length<8;i++){var h=as[i].getAttribute('href');if(/^https:\\/\\/www\\.99rpm\\.com\\//.test(h)&&h!==x.e.u&&urls.indexOf(h)<0)urls.push(h)}
for(var u of urls){var d2=await pagina(u),c=d2&&casilla(d2,x.s);if(c&&!c.disabled){dd=d2;cb=c;url=u;break}await esperar()}
}catch(err){}
if(!cb){por[x.s]+=', y no está habilitada en ningún otro ensamble';continue}
if(await agregar(dd,[{cb:cb,n:x.falta}]))otros.push(x.s+' ×'+x.falta+'  '+x.e.n+' ('+por[x.s]+') → '+slug(url));
else mal.push(x.s+': 99rpm no aceptó el reemplazo de '+slug(url));
}
document.title='Motokira: verificando …';
var sobra=[];cubrir(await leerCarrito()).forEach(function(l){if(l.u>0)sobra.push(l.txt+' ×'+l.u)});
var falta=[];items.forEach(function(it){if(it.falta>0)falta.push(it.s+' ×'+it.falta+'  '+it.e.n+(por[it.s]?': '+por[it.s]:''))});
document.title='Motokira: listo';
var t=[envios?'Motokira: '+envios+' envío(s) al carrito.':'Motokira: no hizo falta agregar nada.'];
if(otros.length)t=t.concat(['','SACADAS DE OTRO ENSAMBLE ('+otros.length+'):'],otros);
t=t.concat([''],falta.length?['FALTAN EN EL CARRITO ('+falta.length+'):'].concat(falta):['✓ El carrito tiene todo lo de la lista.']);
if(sobra.length)t=t.concat(['','EN EL CARRITO Y NO EN LA LISTA, O DE MÁS ('+sobra.length+') — borralas a mano si no van:'],sobra);
if(mal.length)t=t.concat(['','PROBLEMAS:'],mal);
t.push('','Volvé a tocar el marcador para verificar: solo agrega lo que falte.');
var p=document.getElementById('motokira-panel')||document.createElement('div');
p.id='motokira-panel';
p.style.cssText='position:fixed;top:10px;right:10px;z-index:99999;max-width:560px;max-height:85vh;overflow:auto;background:#fff;color:#111;border:2px solid #2563eb;border-radius:8px;padding:12px;font:13px/1.45 sans-serif;white-space:pre-wrap;box-shadow:0 4px 24px rgba(0,0,0,.3)';
p.textContent=t.join('\\n');
var bt=document.createElement('button');
bt.textContent='Recargar carrito';bt.onclick=function(){location.reload()};
bt.style.cssText='display:block;margin-top:10px;padding:5px 12px;background:#2563eb;color:#fff;border:0;border-radius:4px;cursor:pointer';
p.appendChild(bt);document.body.appendChild(p);
})()`

export const MARCADOR_99RPM = `javascript:${encodeURIComponent(CODIGO)}`
