#!/usr/bin/env bash
# Respaldo de la base: pg_dump → se comprueba que el dump se pueda leer → se sube a un
# bucket → se podan los viejos. Lo corre bajaj-backup.timer; también a mano:
#   sudo systemctl start bajaj-backup   (o)   sudo -iu bajaj bash ~/app/deploy/backup.sh
#
# Un dump que no se puede leer no es un respaldo: se descubriría el día que hace falta.
# `pg_restore -l` lista el contenido y falla si el archivo está truncado o corrupto; no
# prueba que restaure (eso se prueba a mano, ver fases 4 y 5), pero atrapa lo común.
set -euo pipefail
umask 077   # los dumps tienen nombres y teléfonos de clientes

: "${DATABASE_URL:?Falta DATABASE_URL (cargar /etc/bajaj/app.env)}"
: "${BACKUP_REMOTE:?Falta BACKUP_REMOTE (cargar /etc/bajaj/backup.env)}"

DIR="${BACKUP_DIR:-/var/backups/bajaj}"
KEEP_LOCAL="${BACKUP_KEEP_LOCAL:-14}"
REMOTE_MAX_AGE="${BACKUP_REMOTE_MAX_AGE:-60d}"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
final="$DIR/bajaj-$stamp.dump"
parcial="$final.partial"
trap 'rm -f "$parcial"' EXIT

pg_dump "$DATABASE_URL" -Fc --no-owner --no-acl -f "$parcial"

# Con `-l` basta para el formato, pero una base vacía también "se lista": exigir datos.
tablas=$(pg_restore -l "$parcial" | grep -c ' TABLE DATA ' || true)
if (( tablas == 0 )); then
  echo "El dump no trae ninguna tabla con datos: no se sube ni se poda nada." >&2
  exit 1
fi

mv "$parcial" "$final"
echo "dump $(basename "$final"): $(du -h "$final" | cut -f1), $tablas tablas con datos"

rclone copyto "$final" "$BACKUP_REMOTE/$(basename "$final")"
echo "subido a $BACKUP_REMOTE"

# Se poda DESPUÉS de subir bien: si algo falla arriba, no se borra nada.
# shellcheck disable=SC2012
ls -1t "$DIR"/bajaj-*.dump | tail -n +"$((KEEP_LOCAL + 1))" | xargs -r rm -v --
rclone delete "$BACKUP_REMOTE" --include 'bajaj-*.dump' --min-age "$REMOTE_MAX_AGE" -v
