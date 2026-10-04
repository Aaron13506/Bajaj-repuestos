#!/usr/bin/env bash
# Le dice al servidor que se actualice con lo que haya en GitHub: pull → install → build →
# reinicio (deploy.sh), y comprueba que quedó bien. NO hace push: antes hacelo vos.
#
#   pnpm deploy:prod                    muestra qué trae el servidor y lo despliega
#   pnpm deploy:prod --dry              solo muestra; no despliega nada
#   pnpm deploy:prod --esquema-aplicado confirma que el cambio de esquema ya se aplicó a mano en la base
#
# Todo se consulta al servidor, que es quien hace el pull: no depende de tu git local (Windows,
# WSL, saltos de línea). Se detiene si lo que llega cambia prisma/schema.prisma: deploy.sh no
# corre migraciones, y una app nueva (su cliente de Prisma sale de ese archivo) contra una base
# vieja arranca rota. Un .sql en prisma/manual/ solo avisa: deploy.sh no lo ejecuta.
# Avisa (sin bloquear) si tu commit local todavía no está en GitHub, porque entonces el
# servidor no lo verá.
#
# Requiere ssh al servidor por Tailscale (ubuntu@motokira). DEPLOY_HOST lo cambia.
set -euo pipefail

HOST=${DEPLOY_HOST:-ubuntu@motokira}
APP_DIR=${DEPLOY_APP_DIR:-/srv/bajaj/app}

dry=0; esquema_ok=0
for a in "$@"; do
  case "$a" in
    --) ;;
    --dry) dry=1 ;;
    --esquema-aplicado) esquema_ok=1 ;;
    *) echo "Opción desconocida: $a"; exit 2 ;;
  esac
done

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
  echo "⚠ Esto cambia prisma/schema.prisma."
  (( esquema_ok )) || die "deploy.sh no corre migraciones. Aplicá el cambio en la base (SQL manual, con backup) y repetí con --esquema-aplicado."
  echo "  (--esquema-aplicado: seguimos)"
fi
if grep -Eq '^prisma/manual/' <<<"$cambios"; then
  echo "ℹ Trae SQL en prisma/manual/ (deploy.sh no lo aplica; se corre a mano, con backup, cuando toque):"
  grep -E '^prisma/manual/' <<<"$cambios" | sed 's/^/    /'
fi
if grep -Eq '^deploy/(systemd/|setup\.sh|oauth2-proxy\.cfg)' <<<"$cambios"; then
  echo "⚠ Cambió la infraestructura (deploy/systemd, setup.sh u oauth2-proxy.cfg): deploy.sh NO la reinstala; hay que aplicarla a mano en el servidor."
fi

(( dry )) && { echo "--dry: no se despliega nada."; exit 0; }

echo "==> deploy.sh en $HOST"
ssh "$HOST" "sudo -iu bajaj $APP_DIR/deploy/deploy.sh" || die "deploy.sh falló (si fue el build, la versión anterior sigue sirviendo)."

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
