#!/usr/bin/env bash
# Despliega desde tu PC: comprueba, sube a GitHub, corre deploy.sh en el servidor y verifica.
#
#   pnpm deploy:prod                    muestra lo que se desplegará y pide confirmación
#   pnpm deploy:prod --dry              solo comprueba y muestra; no sube ni toca el servidor
#   pnpm deploy:prod -y                 sin preguntar (hace falta si no hay terminal)
#   pnpm deploy:prod --esquema-aplicado confirma que el cambio de esquema ya se aplicó a mano en la base
#
# Qué comprueba antes de tocar nada, porque el servidor solo ve lo que está en GitHub:
#   - estás en master y no hay cambios sin commitear en archivos versionados (si los hubiera,
#     el deploy "funcionaría" y la app seguiría sin ellos);
#   - tu master no está detrás de origin (sería un push rechazado o un merge a ciegas);
#   - si lo que se va a desplegar cambia prisma/schema.prisma, se detiene: deploy.sh no corre
#     migraciones, y una app nueva (su cliente de Prisma sale de ese archivo) contra una base
#     vieja arranca rota. Un .sql en prisma/manual/ solo avisa: es un archivo, deploy.sh no lo
#     ejecuta, y lo que lo vuelve peligroso es el cambio de esquema que lo acompaña.
# Al terminar compara el commit del servidor con el tuyo y pide la app por HTTP (401 = viva,
# la puerta es el Basic Auth).
#
# Requiere ssh al servidor por Tailscale (ubuntu@motokira). DEPLOY_HOST lo cambia.
set -euo pipefail

HOST=${DEPLOY_HOST:-ubuntu@motokira}
APP_DIR=${DEPLOY_APP_DIR:-/srv/bajaj/app}
RAMA=master

dry=0; si=0; esquema_ok=0
for a in "$@"; do
  case "$a" in
    --) ;;
    --dry) dry=1 ;;
    -y|--yes) si=1 ;;
    --esquema-aplicado) esquema_ok=1 ;;
    *) echo "Opción desconocida: $a"; exit 2 ;;
  esac
done

die() { echo "✗ $*" >&2; exit 1; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."

[[ "$(git branch --show-current)" == "$RAMA" ]] || die "Estás en '$(git branch --show-current)': se despliega desde $RAMA."

sucio=$(git status --porcelain --untracked-files=no)
[[ -z "$sucio" ]] || { echo "$sucio"; die "Hay cambios sin commitear en archivos versionados (arriba). El servidor no los vería."; }

git fetch --quiet origin "$RAMA"
read -r detras adelante < <(git rev-list --left-right --count "origin/$RAMA...HEAD")
(( detras == 0 )) || die "Tu $RAMA está $detras commit(s) detrás de origin/$RAMA. Traelos primero (git pull --rebase)."

local_head=$(git rev-parse HEAD)
srv_head=$(ssh -o ConnectTimeout=10 "$HOST" "sudo -u bajaj git -C $APP_DIR rev-parse HEAD" | tr -d '\r') \
  || die "No pude leer el commit del servidor en $HOST:$APP_DIR (¿Tailscale prendido?)."
[[ "$srv_head" =~ ^[0-9a-f]{40}$ ]] || die "Respuesta rara del servidor sobre su commit: '$srv_head'"
git cat-file -e "$srv_head^{commit}" 2>/dev/null || die "El servidor está en $srv_head, que no existe en tu copia. Hacé fetch o revisá a mano."

if [[ "$srv_head" == "$local_head" ]]; then
  echo "✓ El servidor ya está en ${local_head:0:7}. No hay nada que desplegar."
  exit 0
fi

echo "Servidor: ${srv_head:0:7}   →   Local: ${local_head:0:7}   (sin subir: $adelante)"
echo
git log --oneline --no-decorate "$srv_head..$local_head"
echo
cambios=$(git diff --name-only "$srv_head" "$local_head")

if grep -Eq '^prisma/schema\.prisma$' <<<"$cambios"; then
  echo "⚠ Este deploy cambia prisma/schema.prisma."
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

(( dry )) && { echo "--dry: no se sube ni se despliega nada."; exit 0; }

if (( ! si )); then
  [[ -t 0 ]] || die "Sin terminal para preguntar: usá -y."
  read -r -p "¿Subir a GitHub y desplegar? [s/N] " r
  [[ "$r" =~ ^[sSyY]$ ]] || { echo "Cancelado."; exit 1; }
fi

if (( adelante > 0 )); then
  echo "==> git push origin $RAMA"
  git push origin "$RAMA"
fi

echo "==> deploy.sh en $HOST"
ssh "$HOST" "sudo -iu bajaj $APP_DIR/deploy/deploy.sh" || die "deploy.sh falló (si fue el build, la versión anterior sigue sirviendo)."

nuevo_srv=$(ssh "$HOST" "sudo -u bajaj git -C $APP_DIR rev-parse HEAD" | tr -d '\r')
[[ "$nuevo_srv" == "$local_head" ]] || die "El servidor quedó en ${nuevo_srv:0:7}, no en ${local_head:0:7}."

codigo=000
for _ in 1 2 3 4 5 6 7 8 9 10; do
  codigo=$(ssh "$HOST" 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/' 2>/dev/null || true)
  [[ "$codigo" == 401 ]] && break
  sleep 1
done
[[ "$codigo" == 401 ]] || die "El servidor está en ${local_head:0:7} pero la app respondió '$codigo' (se esperaba 401). Revisá: journalctl -u bajaj-app -n 50"
echo "✓ Desplegado ${local_head:0:7}: servidor en el mismo commit y la app responde (401 = Basic Auth)."
