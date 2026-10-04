#!/usr/bin/env bash
# Pone en el servidor la versión de GitHub: pull → install → build → reinicio.
# Se corre como el usuario `bajaj`:   sudo -iu bajaj ~/app/deploy/deploy.sh
#
# NO corre migraciones. Las de prisma/manual/ se aplican a mano, con un backup antes (ver
# "Operación diaria" en PLAN-MIGRACION.md): este script no sabe cuál toca ni si es seguro.
# Si un deploy trae cambios de esquema, aplicar el SQL ANTES de correrlo o la app nueva
# arranca contra una base vieja.
set -euo pipefail

[[ "$(id -un)" == bajaj ]] || { echo "Correr como bajaj:  sudo -iu bajaj $0"; exit 1; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Las env vars de la app (DATABASE_URL...) hacen falta para `prisma generate` y para el
# build, que consulta la base al prerenderizar.
set -a
# shellcheck disable=SC1091
. /etc/bajaj/app.env
set +a
export NODE_ENV=production TZ=UTC COREPACK_ENABLE_DOWNLOAD_PROMPT=0

anterior=$(git rev-parse --short HEAD)
git pull --ff-only
nuevo=$(git rev-parse --short HEAD)
echo "==> $anterior → $nuevo"

# NODE_ENV=production haría que pnpm omita las devDependencies, y el build las necesita
# (typescript, tailwind, postcss).
NODE_ENV=development pnpm install --frozen-lockfile
pnpm build

if systemctl is-active --quiet bajaj-app; then
  sudo systemctl restart bajaj-app
  echo "==> bajaj-app reiniciado en $nuevo"
else
  echo "==> bajaj-app no está corriendo (primer deploy): arrancarlo con"
  echo "    sudo systemctl enable --now bajaj-app"
fi
