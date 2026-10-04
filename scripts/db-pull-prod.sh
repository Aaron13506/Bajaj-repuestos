#!/usr/bin/env bash
# Recarga la base LOCAL con el último backup automático de producción.
#
#   pnpm db:pull-prod
#
# Solo LEE de producción (baja el dump más reciente de /var/backups/bajaj por SSH) y solo ESCRIBE en
# el contenedor local: borra y recrea la base local, así que lo que tengas ahí se pierde. No usa tu
# .env: habla directo con el contenedor, de modo que no puede tocar producción aunque el .env apunte
# allá. El dump trae datos de clientes: va a un archivo temporal que se borra al terminar.
#
# Requiere Docker (el contenedor del docker-compose.yml, sano) y ssh al servidor por Tailscale.
# El dump es de hasta ~24 h atrás (el backup es diario, 07:30 UTC); para algo más fresco, en el
# servidor: sudo systemctl start bajaj-backup.
set -euo pipefail

HOST=${DEPLOY_HOST:-ubuntu@motokira}
CONTENEDOR=bajaj-repuestos-db
DB=bajaj_repuestos

die() { echo "✗ $*" >&2; exit 1; }

[[ "$(docker inspect -f '{{.State.Health.Status}}' "$CONTENEDOR" 2>/dev/null || true)" == healthy ]] \
  || die "El contenedor $CONTENEDOR no está sano. Levantalo con: pnpm db:up"

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

ultimo=$(ssh -o ConnectTimeout=10 "$HOST" "sudo -u bajaj sh -c 'ls -t /var/backups/bajaj/bajaj-*.dump | head -1'" | tr -d '\r') \
  || die "No pude hablar con $HOST (¿Tailscale prendido?)."
[[ "$ultimo" == /var/backups/bajaj/bajaj-*.dump ]] || die "No encontré un backup en el servidor (respuesta: '$ultimo')."

echo "==> bajando ${ultimo##*/}"
ssh "$HOST" "sudo -u bajaj cat $ultimo" > "$tmp"
[[ -s "$tmp" ]] || die "El dump bajó vacío."
docker exec -i "$CONTENEDOR" pg_restore -l < "$tmp" > /dev/null || die "El dump no se puede leer (¿se cortó la descarga?)."
echo "    $(du -h "$tmp" | cut -f1)"

echo "==> recreando la base local '$DB'"
docker exec "$CONTENEDOR" psql -U bajaj -d postgres -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB OWNER bajaj"

echo "==> restaurando"
# pg_restore sale con error por un solo motivo esperado: el esquema public ya existe en la base nueva.
errores=$(docker exec -i "$CONTENEDOR" pg_restore -U bajaj -d "$DB" --no-owner --no-acl < "$tmp" 2>&1 >/dev/null || true)
total=$(grep -c '^pg_restore: error:' <<<"$errores" || true)
esperados=$(grep -c 'schema "public" already exists' <<<"$errores" || true)
if (( total != esperados )); then
  echo "$errores" >&2
  die "La restauración tuvo errores inesperados (arriba)."
fi

# Los ensambles salieron de Product a su propia tabla (fase 8). Un backup anterior al corte todavía
# tiene el esquema viejo, así que el conteo se adapta a lo que se restauró en vez de fallar acá,
# después de haber restaurado bien.
migrada=$(docker exec "$CONTENEDOR" psql -U bajaj -d "$DB" -At -c "SELECT to_regclass('\"Ensamble\"') IS NOT NULL")
if [[ "$migrada" == "t" ]]; then
  ensambles='(SELECT count(*) FROM "Ensamble")'
  componentes='(SELECT count(*) FROM "EnsambleComponente")'
else
  ensambles='(SELECT count(*) FROM "Product" WHERE "isAssembly")'
  componentes='(SELECT count(*) FROM "ProductComponent")'
fi
docker exec "$CONTENEDOR" psql -U bajaj -d "$DB" -At -c \
  "SELECT 'Product='||(SELECT count(*) FROM \"Product\")||' Pedido='||(SELECT count(*) FROM \"Pedido\")||' Ensamble='||$ensambles||' Componentes='||$componentes"
echo "✓ Base local lista (copia de ${ultimo##*/})."
