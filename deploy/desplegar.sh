#!/usr/bin/env bash
# Le dice al servidor que se actualice con lo que haya en GitHub: pull → install → build →
# reinicio (deploy.sh), y comprueba que quedó bien. NO hace push: antes hacelo vos.
#
#   pnpm deploy:prod                    muestra qué trae el servidor y lo despliega
#   pnpm deploy:prod --dry              solo muestra; no despliega nada
#   pnpm deploy:prod --migrar           además aplica las migraciones de esquema que traiga (prisma/manual/*.sql)
#   pnpm deploy:prod --migrar --baseline=<archivo>
#                                       la primera vez en una base sin registro de migraciones (ver scripts/migrar.ts)
#
# Todo se consulta al servidor, que es quien hace el pull: no depende de tu git local (Windows,
# WSL, saltos de línea). Si lo que llega trae un .sql nuevo en prisma/manual/ se niega a seguir sin
# --migrar, ANTES de que el servidor haga nada: aplicar un cambio de esquema implica parar la app unos
# segundos y hacer un backup, y eso se pide a propósito. Qué hace --migrar, paso a paso: deploy.sh.
# Un cambio de prisma/schema.prisma SIN .sql ya no se detecta acá (podría ser solo un comentario): lo
# frena deploy.sh comparando la base real contra el esquema, antes de construir.
# Avisa (sin bloquear) si tu commit local todavía no está en GitHub, porque entonces el
# servidor no lo verá.
#
# Requiere ssh al servidor por Tailscale (ubuntu@motokira). DEPLOY_HOST lo cambia.
set -euo pipefail

HOST=${DEPLOY_HOST:-ubuntu@motokira}
APP_DIR=${DEPLOY_APP_DIR:-/srv/bajaj/app}

dry=0; migrar=0; baseline=''
for a in "$@"; do
  case "$a" in
    --) ;;
    --dry) dry=1 ;;
    --migrar) migrar=1 ;;
    --baseline=*) baseline="$a" ;;
    *) echo "Opción desconocida: $a"; exit 2 ;;
  esac
done
[[ -z "$baseline" || $migrar -eq 1 ]] || { echo "--baseline va con --migrar."; exit 2; }

die() { echo "✗ $*" >&2; exit 1; }
# git en el servidor, como el usuario que hace el deploy (-i: su HOME, donde está la deploy key)
srv() { ssh -o ConnectTimeout=10 "$HOST" "sudo -iu bajaj git -C $APP_DIR $*" | tr -d '\r'; }

srv fetch --quiet origin master || die "El servidor no pudo traer de GitHub (¿Tailscale prendido? ¿deploy key?)."
actual=$(srv rev-parse HEAD)
destino=$(srv rev-parse origin/master)
[[ "$actual" =~ ^[0-9a-f]{40}$ && "$destino" =~ ^[0-9a-f]{40}$ ]] || die "Respuesta rara del servidor: '$actual' / '$destino'"

# Un commit local que GitHub no tiene es el descuido típico: se despliega, y el cambio no está.
local_head=$(git rev-parse HEAD 2>/dev/null || true)
if [[ -n "$local_head" ]] && ! srv merge-base --is-ancestor "$local_head" origin/master 2>/dev/null; then
  echo "⚠ Tu commit local ${local_head:0:7} no está en GitHub (origin/master): el servidor no lo verá. ¿Falta el push?"
  echo
fi

if [[ "$actual" == "$destino" ]]; then
  echo "✓ El servidor ya está en ${actual:0:7}, igual que GitHub. No hay nada que desplegar."
  exit 0
fi

echo "Servidor: ${actual:0:7}   →   GitHub: ${destino:0:7}"
echo
srv log --oneline --no-decorate "$actual..$destino"
echo
cambios=$(srv diff --name-only "$actual" "$destino")

if grep -Eq '^prisma/schema\.prisma$' <<<"$cambios"; then
  echo "ℹ Cambia prisma/schema.prisma (deploy.sh comprueba que la base coincida antes de construir)."
fi
if grep -Eq '^prisma/manual/.+\.sql$' <<<"$cambios"; then
  echo "⚠ Trae migraciones de esquema (prisma/manual/):"
  grep -E '^prisma/manual/.+\.sql$' <<<"$cambios" | sed 's/^/    /'
  (( migrar )) || die "Aplicarlas implica parar la app unos segundos y hacer un backup. Repetí con --migrar (antes podés ensayarlas contra la base real, sin dejar nada: en el servidor, 'pnpm exec tsx scripts/migrar.ts --probar')."
  echo "  (--migrar: se ensayan, se para la app, se hace backup, se aplican y se arranca)"
elif (( migrar )) && [[ -z "$baseline" ]]; then
  echo "ℹ --migrar: este deploy no trae .sql nuevos; solo se aplicará algo si el servidor ya tenía pendientes."
fi
if grep -Eq '^deploy/(systemd/|setup\.sh|oauth2-proxy\.cfg)' <<<"$cambios"; then
  echo "⚠ Cambió la infraestructura (deploy/systemd, setup.sh u oauth2-proxy.cfg): deploy.sh NO la reinstala; hay que aplicarla a mano en el servidor."
fi

(( dry )) && { echo "--dry: no se despliega nada."; exit 0; }

echo "==> deploy.sh en $HOST"
extra=''; envs=''
if (( migrar )); then
  extra=' --migrar'; [[ -n "$baseline" ]] && extra+=" $baseline"
  # El deploy.sh que ya está en el servidor puede ser anterior a --migrar (el primer deploy con este
  # mecanismo) y no lo entendería: se trae el repo ANTES de correrlo, para ejecutar la versión nueva,
  # y se le dice cuál era el commit de partida (el destino de un rollback), que si no sería este.
  srv merge --ff-only origin/master >/dev/null || die "El servidor no pudo adelantar su repo a origin/master."
  envs="env DEPLOY_ANTERIOR=$actual "
fi
ssh "$HOST" "sudo -iu bajaj $envs$APP_DIR/deploy/deploy.sh$extra" || die "deploy.sh falló (leé arriba: si fue el build de un deploy sin migraciones, la versión anterior sigue sirviendo; si migraba, el mensaje dice en qué estado quedó la app)."

nuevo=$(srv rev-parse HEAD)
[[ "$nuevo" == "$destino" ]] || die "El servidor quedó en ${nuevo:0:7}, no en ${destino:0:7}."

codigo=000
for _ in 1 2 3 4 5 6 7 8 9 10; do
  codigo=$(ssh "$HOST" 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/' 2>/dev/null || true)
  [[ "$codigo" == 401 ]] && break
  sleep 1
done
[[ "$codigo" == 401 ]] || die "El servidor está en ${destino:0:7} pero la app respondió '$codigo' (se esperaba 401). Revisá: journalctl -u bajaj-app -n 50"
echo "✓ Desplegado ${destino:0:7}: la app responde (401 = Basic Auth)."
