#!/usr/bin/env bash
# Pone en el servidor la versión de GitHub: pull → install → build → reinicio.
# Se corre como el usuario `bajaj`:   sudo -iu bajaj ~/app/deploy/deploy.sh [--migrar] [--baseline=<archivo>]
#
# Sin opciones NO toca el esquema: si el deploy trae migraciones pendientes (prisma/manual/*.sql que
# la base todavía no tiene), se niega ANTES de construir y dice qué hacer. Una app nueva contra una
# base vieja arranca rota (su cliente de Prisma sale de schema.prisma).
#
#   --migrar               aplica las pendientes. Orden, pensado para que un fallo casi nunca llegue a
#                          producción y para poder volver atrás:
#                            1. pull + install              (la app vieja sigue sirviendo)
#                            2. migrar --probar             ensaya el SQL contra los datos reales y lo
#                                                           deshace (la app vieja sigue sirviendo)
#                            3. para bajaj-app + backup     dump verificado en /var/backups/bajaj
#                            4. migrar --aplicar            cada archivo en su transacción; al final
#                                                           compara la base contra schema.prisma
#                            5. build + arranque            el build ya corre contra el esquema nuevo
#                          Si el paso 4 falla SIN haber aplicado nada, vuelve al commit anterior y
#                          arranca la versión vieja (su .next sigue intacto porque aún no se construyó).
#                          Si falla habiendo aplicado algo, o si el esquema no coincide, la app QUEDA
#                          PARADA y se imprime cómo seguir: no se adivina un camino.
#   --baseline=<archivo>   solo la primera vez en una base sin registro de migraciones: declara que
#                          todo hasta ese archivo, inclusive, ya está aplicado (ver scripts/migrar.ts).
#
# Primer deploy tras agregar este mecanismo: el sudoers de bajaj tiene que permitir parar/arrancar la
# app (ver setup.sh); se comprueba antes de empezar.
set -euo pipefail

[[ "$(id -un)" == bajaj ]] || { echo "Correr como bajaj:  sudo -iu bajaj $0"; exit 1; }

migrar=0; baseline=()
for a in "$@"; do
  case "$a" in
    --migrar) migrar=1 ;;
    --baseline=*) baseline=("$a") ;;
    *) echo "Opción desconocida: $a"; exit 2 ;;
  esac
done

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Las env vars de la app (DATABASE_URL...) hacen falta para `prisma generate`, para el build (que
# consulta la base al prerenderizar) y para el ejecutor de migraciones.
set -a
# shellcheck disable=SC1091
. "${APP_ENV_FILE:-/etc/bajaj/app.env}"
set +a
export NODE_ENV=production TZ=UTC COREPACK_ENABLE_DOWNLOAD_PROMPT=0

die() { echo "✗ $*" >&2; exit 1; }
MIGRAR=(pnpm exec tsx scripts/migrar.ts)

# Si algo corta el script con la app parada, que no pase desapercibido.
parada=0
trap 'if (( parada )); then echo "⚠ bajaj-app QUEDÓ PARADA. Estado de la base: pnpm exec tsx scripts/migrar.ts   Para arrancarla: sudo systemctl start bajaj-app" >&2; fi' EXIT

# El commit que HOY está desplegado (el de la última vez que este script terminó bien) vive en
# .desplegado, y NO es necesariamente el HEAD del repo: desplegar.sh adelanta el repo antes de correr
# este script, y un intento fallido deja el HEAD en el commit nuevo sin haberlo construido. Es el
# destino de un rollback y lo que desplegar.sh compara contra GitHub. Sin el archivo (primer deploy
# con este mecanismo) se parte del HEAD.
MARCA="$PWD/.desplegado"
if [[ -s "$MARCA" ]]; then anterior_full=$(tr -d '[:space:]' < "$MARCA"); else anterior_full=$(git rev-parse HEAD); fi
[[ "$anterior_full" =~ ^[0-9a-f]{40}$ ]] || die "El commit desplegado no es válido ($MARCA): '$anterior_full'"
anterior=${anterior_full:0:7}
git pull --ff-only
nuevo=$(git rev-parse --short HEAD)
echo "==> $anterior → $nuevo"

# NODE_ENV=production haría que pnpm omita las devDependencies, y el build las necesita
# (typescript, tailwind, postcss) — y el ejecutor de migraciones necesita tsx.
NODE_ENV=development pnpm install --frozen-lockfile

# ── ¿Hay cambios de esquema pendientes? ─────────────────────────────────────────────────────────
pendientes=$("${MIGRAR[@]}" --pendientes "${baseline[@]}") || die "No se pudo leer el estado de las migraciones (arriba)."
if (( pendientes > 0 )); then
  (( migrar )) || die "Hay $pendientes migración(es) de esquema pendiente(s) en prisma/manual/. Esto NO las aplica: repetí con --migrar (las ensaya, para la app, hace backup, migra, construye y arranca). Ver: pnpm exec tsx scripts/migrar.ts"
  sudo -n -l /usr/bin/systemctl stop bajaj-app >/dev/null 2>&1 \
    || die "Falta el permiso sudo para parar/arrancar bajaj-app (hace falta para migrar). Una sola vez, como ubuntu: echo 'bajaj ALL=(root) NOPASSWD: /usr/bin/systemctl restart bajaj-app, /usr/bin/systemctl stop bajaj-app, /usr/bin/systemctl start bajaj-app' | sudo tee /etc/sudoers.d/bajaj-deploy && sudo visudo -cf /etc/sudoers.d/bajaj-deploy   (no se tocó la base ni la app)"
  echo "==> $pendientes migración(es) pendiente(s): ensayo con la app todavía sirviendo"
  "${MIGRAR[@]}" --probar "${baseline[@]}" \
    || die "El ensayo falló: no se tocó la base ni la app (sigue sirviendo la versión anterior). El repo del servidor quedó en $nuevo."
elif (( ${#baseline[@]} )); then
  echo "==> Sin migraciones pendientes: solo se registra el punto de partida"
  "${MIGRAR[@]}" --aplicar "${baseline[@]}" || die "No se pudo registrar el baseline."
elif (( migrar )); then
  echo "==> --migrar sin migraciones pendientes: nada que aplicar"
fi

# Sin migraciones pendientes la base tiene que coincidir con schema.prisma. Un cambio de ese archivo
# sin su .sql (que un git diff no distingue de un cambio de comentarios) se frena acá, antes de
# construir y reiniciar: la app nueva arrancaría contra una base que no es la que espera.
if (( pendientes == 0 )); then
  "${MIGRAR[@]}" --drift     || die "prisma/schema.prisma no coincide con la base y no hay ninguna migración pendiente: falta el .sql en prisma/manual/ (o alguien tocó la base a mano). No se construye ni se reinicia nada."
fi

# ── Migrar: parar → backup → aplicar ────────────────────────────────────────────────────────────
if (( pendientes > 0 )); then
  echo "==> parando bajaj-app"
  sudo systemctl stop bajaj-app
  parada=1

  dump="${BACKUP_DIR:-/var/backups/bajaj}/pre-migracion-$(date -u +%Y%m%dT%H%M%SZ).dump"
  echo "==> backup → $dump"
  # La URL de Prisma puede traer ?schema=public, que pg_dump no entiende.
  ( umask 077; pg_dump "${DATABASE_URL%%\?*}" -Fc --no-owner --no-acl -f "$dump" ) \
    && pg_restore -l "$dump" | grep -q ' TABLE DATA ' \
    || { rm -f "$dump"; echo "✗ El backup falló: no se migra nada." >&2
         git reset --hard "$anterior_full" && NODE_ENV=development pnpm install --frozen-lockfile \
           && sudo systemctl start bajaj-app && parada=0 && echo "  (volvió a $anterior y la app arrancó)" >&2
         exit 1; }

  echo "==> aplicando migraciones"
  if ! "${MIGRAR[@]}" --aplicar "${baseline[@]}"; then
    # ¿Llegó a aplicar algo? Cada archivo es una transacción: si ninguno se aplicó, la base quedó igual.
    restantes=$("${MIGRAR[@]}" --pendientes 2>/dev/null || echo "?")
    if [[ "$restantes" == "$pendientes" ]]; then
      echo "✗ La migración falló y la base quedó como estaba. Vuelvo a $anterior y arranco la versión anterior." >&2
      git reset --hard "$anterior_full"
      NODE_ENV=development pnpm install --frozen-lockfile
      sudo systemctl start bajaj-app && parada=0
      die "Migración fallida; la app volvió a $anterior. Backup (por las dudas): $dump"
    fi
    die "La migración falló o el esquema no coincide, con la base ya modificada: bajaj-app queda PARADA. Backup previo: $dump. Para volver atrás: restaurar ese dump (ver 'Restaurar un backup' en PLAN-MIGRACION.md) y 'git reset --hard $anterior_full'. Para seguir adelante: corregir el .sql que falló (no quedó registrado, así que se puede editar) o agregar uno nuevo, y repetir el deploy con --migrar."
  fi
  echo "==> base migrada; backup previo en $dump (se puede borrar cuando la versión nueva esté probada)"
fi

pnpm build

if (( parada )); then
  sudo systemctl start bajaj-app
  parada=0
  echo "==> bajaj-app arrancada en $nuevo"
elif systemctl is-active --quiet bajaj-app; then
  sudo systemctl restart bajaj-app
  echo "==> bajaj-app reiniciado en $nuevo"
else
  echo "==> bajaj-app no está corriendo (primer deploy): arrancarlo con"
  echo "    sudo systemctl enable --now bajaj-app"
fi

# Recién ahora —construido y arrancado— este commit pasa a ser el desplegado.
git rev-parse HEAD > "$MARCA"
