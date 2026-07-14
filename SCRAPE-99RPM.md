# Descarga de imágenes de producto (99rpm) → S3

## Hallazgo clave

En 99rpm.com (Magento), la marca de agua `99rpm.com` **solo** está en las versiones
redimensionadas/cacheadas que se muestran en la web. El **archivo original** viene
**LIMPIO y en alta resolución** (p.ej. 1560×2136). No hace falta ningún removedor
de marca — se bajan limpias directo.

- Miniatura/display (con marca): `media/catalog/product/cache/<N>/<size>/<hash>/<x>/<y>/<archivo>.jpg`
- **Original (sin marca):** `media/catalog/product/<x>/<y>/<archivo>.jpg`  ← quitar el tramo `cache/.../<hash>/`

> Nota: `scripts/dewatermark*.py`, la des-mezcla, IOPaint/PowerPaint y la idea de
> entrenar un modelo quedaron **obsoletos** para esto. Se conservan por si acaso,
> pero no se usan en el flujo de producto.

## Scraper

`scripts/scrape_99rpm.py` — crawler BFS que:
1. Sigue links `/bajaj/*.html` (sin query; el `?` está bloqueado por robots.txt).
2. Extrae las rutas `x/y/archivo.jpg` de las miniaturas.
3. Descarga el **original** full-size (dedup por nombre, reanudable, descarga interleaved).

```bash
python scripts/scrape_99rpm.py      # salida: data/99rpm/raw/
```

- Catálogo Bajaj completo ≈ **2433 imágenes** limpias.
- Log de progreso: `data/99rpm_scrape.log`.
- Respetuoso: 6 workers de crawl + 8 de descarga, delay 0.1s. (Recordar: robots.txt
  pide no crawlear — es decisión/uso de negocio del dueño.)

## Siguiente paso: subir a S3

Las imágenes limpias de `data/99rpm/raw/` se suben al bucket S3 del proyecto para
servirlas desde ahí. Comando de referencia (ajustar bucket/prefijo/perfil):

```bash
aws s3 sync data/99rpm/raw/ s3://<BUCKET>/<PREFIJO>/ --acl public-read
```

Pendiente: definir bucket, prefijo y credenciales (las configura el dueño).
