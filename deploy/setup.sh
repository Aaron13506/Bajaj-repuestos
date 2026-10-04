#!/usr/bin/env bash
# Aprovisiona un Ubuntu 24.04 limpio (Lightsail) para correr Bajaj Repuestos: Postgres 17
# local, la app Next como servicio, oauth2-proxy delante y Tailscale Funnel como única
# entrada desde internet. Se corre como root, UNA vez, y es re-ejecutable: cada paso mira
# si ya está hecho antes de hacerlo.
#
#   read -rs DB_PASSWORD && export DB_PASSWORD     # la clave no queda en el historial
#   sudo --preserve-env=DB_PASSWORD bash ~/deploy/setup.sh
#
# Corre desde una copia SUELTA de la carpeta deploy/ (subida con scp), no desde el repo
# clonado: el clon vive en el home del usuario `bajaj`, que lo crea este mismo script.
#
# No clona el repo, no carga secretos y no prende ningún servicio: eso lo guía
# deploy/PLAN-MIGRACION.md, porque necesita una llave de GitHub, valores que no deben pasar
# por la línea de comandos, y un orden (la app no puede arrancar antes de tener la base).
set -euo pipefail

: "${DB_PASSWORD:?Definí DB_PASSWORD (la clave del rol de Postgres de la app)}"

APP_USER=bajaj
APP_HOME=/srv/bajaj
ETC=/etc/bajaj
PG_VERSION=17
NODE_MAJOR=24
# Fijado con su checksum: es lo que se para entre internet y la app, así que no se baja
# "la última" sin mirar. Para actualizar: cambiar las dos líneas juntas (el sha256 está
# en el .tar.gz-sha256sum.txt de la release).
OAUTH2_PROXY_VERSION=v7.15.5
OAUTH2_PROXY_SHA256_AMD64=f63f94bf72c5f46ab002a0a275aa8b3cf19b4d828aed08a13978cb9a62c3a1fd

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Correr como root (sudo)."; exit 1; }
[[ "$(dpkg --print-architecture)" == amd64 ]] || { echo "Solo amd64 (Lightsail es x86_64)."; exit 1; }

export DEBIAN_FRONTEND=noninteractive
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for need in env/app.env.example env/oauth2-proxy.env.example env/backup.env.example oauth2-proxy.cfg systemd; do
  [[ -e "$DEPLOY_DIR/$need" ]] || { echo "Falta $DEPLOY_DIR/$need: subí la carpeta deploy/ completa."; exit 1; }
done

# ── Swap ──────────────────────────────────────────────────────────────────────────
# `next build` pasa de 1 GB de pico. Con 2 GB de RAM alcanza justo; el swap es para que
# un build en un mal momento no lo mate el OOM killer en vez de tardar un poco más.
if ! swapon --show | grep -q .; then
  log "Swap de 2 GB"
  if fallocate -l 2G /swapfile 2>/dev/null && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    # En un contenedor de prueba no se puede: no es un error del script.
    rm -f /swapfile; echo "(no se pudo activar swap acá; en Lightsail sí)"
  fi
fi

# ── Paquetes base ─────────────────────────────────────────────────────────────────
log "Paquetes base"
apt-get update -q
apt-get install -y -q curl ca-certificates gnupg git rclone unattended-upgrades jq
# Parches de seguridad solos: la máquina la mira una persona, de vez en cuando.
echo 'unattended-upgrades unattended-upgrades/enable_auto_updates boolean true' | debconf-set-selections
dpkg-reconfigure -f noninteractive unattended-upgrades

# ── Postgres 17 (repo oficial PGDG: Ubuntu 24.04 trae el 16) ──────────────────────
# Misma versión mayor que la de producción en Supabase, así el dump restaura sin sorpresas.
if [[ ! -x /usr/lib/postgresql/$PG_VERSION/bin/postgres ]]; then
  log "Postgres $PG_VERSION"
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -q
  apt-get install -y -q "postgresql-$PG_VERSION"
fi
systemctl enable --now postgresql

# Solo escucha en localhost (el default de Ubuntu, pero se deja explícito: es la regla que
# sostiene todo el resto — la base no se ve desde afuera ni aunque se abra el firewall).
PG_CONF=/etc/postgresql/$PG_VERSION/main/postgresql.conf
grep -q "^listen_addresses = 'localhost'" "$PG_CONF" || {
  echo "listen_addresses = 'localhost'" >> "$PG_CONF"
  systemctl restart postgresql
}

log "Rol y base de la app"
# La clave llega a psql por el entorno (\getenv), no por argv: así no queda en `ps`.
export DB_PASSWORD
sudo --preserve-env=DB_PASSWORD -u postgres psql -v ON_ERROR_STOP=1 -q <<'SQL'
\getenv pass DB_PASSWORD
SELECT format('CREATE ROLE bajaj LOGIN PASSWORD %L', :'pass')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bajaj') \gexec
SELECT format('ALTER ROLE bajaj PASSWORD %L', :'pass') \gexec
SELECT 'CREATE DATABASE bajaj_repuestos OWNER bajaj'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'bajaj_repuestos') \gexec
SQL

# ── Node 24 + pnpm ────────────────────────────────────────────────────────────────
if ! node --version 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
  log "Node $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_$NODE_MAJOR.x" | bash -
  apt-get install -y -q nodejs
fi
# pnpm sale de `packageManager` en package.json vía corepack: la versión la fija el repo.
corepack enable

# ── Usuario de la app ─────────────────────────────────────────────────────────────
if ! id "$APP_USER" &>/dev/null; then
  log "Usuario $APP_USER"
  useradd --system --create-home --home-dir "$APP_HOME" --shell /bin/bash "$APP_USER"
fi
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_HOME" /var/backups/bajaj

# ── Secretos ──────────────────────────────────────────────────────────────────────
# app.env y backup.env: root:bajaj 640 — los usa el usuario de la app (la app y el backup
# corren como `bajaj` y los tienen en su entorno igual). oauth2-proxy.env: solo root — lo
# lee systemd antes de arrancar el proxy, y la app no tiene por qué ver el secreto de Google.
install -d -m 750 -g "$APP_USER" "$ETC"
copiar_ejemplo() {  # archivo modo grupo
  if [[ ! -f "$ETC/$1" ]]; then
    install -m "$2" -g "$3" "$DEPLOY_DIR/env/$1.example" "$ETC/$1"
    echo "  → $ETC/$1 creado desde el ejemplo: COMPLETALO antes de arrancar."
  fi
}
copiar_ejemplo app.env          640 "$APP_USER"
copiar_ejemplo backup.env       640 "$APP_USER"
copiar_ejemplo oauth2-proxy.env 600 root
# Sin "*": un email_domains comodín más esta lista dejaría entrar a cualquier cuenta de Google.
# El .cfg y la lista son de root y viven aparte de /etc/bajaj (que solo lee el grupo bajaj):
# oauth2-proxy corre como usuario dinámico y tiene que poder leerlos. No tienen secretos —
# esos van en oauth2-proxy.env— y que los mande root es lo importante: la puerta de entrada
# no la decide el usuario que corre la app.
install -d -m 755 -o root -g root /etc/oauth2-proxy
[[ -f /etc/oauth2-proxy/emails-autorizados ]] || install -m 644 -o root -g root /dev/null /etc/oauth2-proxy/emails-autorizados
# El .cfg no tiene nada propio de esta máquina: se pisa siempre.
install -m 644 -o root -g root "$DEPLOY_DIR/oauth2-proxy.cfg" /etc/oauth2-proxy/oauth2-proxy.cfg

# La sesión de `bajaj` (psql "$DATABASE_URL", pnpm check:*) necesita las mismas variables
# que la app. Se carga el mismo archivo, no una copia: un solo lugar donde cambiar la clave.
PROFILE="$APP_HOME/.profile"
grep -q 'bajaj/app.env' "$PROFILE" 2>/dev/null || {
  printf '\n# Variables de la app (las mismas que usa bajaj-app.service)\nset -a; . %s/app.env; set +a\n' "$ETC" >> "$PROFILE"
  chown "$APP_USER:$APP_USER" "$PROFILE"
}

# deploy.sh corre como `bajaj` y tiene que reiniciar la app. Solo eso, y solo esa unidad.
echo "$APP_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart bajaj-app" > /etc/sudoers.d/bajaj-deploy
chmod 440 /etc/sudoers.d/bajaj-deploy
visudo -cf /etc/sudoers.d/bajaj-deploy >/dev/null

# ── oauth2-proxy ──────────────────────────────────────────────────────────────────
if ! /usr/local/bin/oauth2-proxy --version 2>/dev/null | grep -q "$OAUTH2_PROXY_VERSION"; then
  log "oauth2-proxy $OAUTH2_PROXY_VERSION"
  tmp=$(mktemp -d)
  name="oauth2-proxy-$OAUTH2_PROXY_VERSION.linux-amd64"
  curl -fsSL -o "$tmp/$name.tar.gz" \
    "https://github.com/oauth2-proxy/oauth2-proxy/releases/download/$OAUTH2_PROXY_VERSION/$name.tar.gz"
  echo "$OAUTH2_PROXY_SHA256_AMD64  $tmp/$name.tar.gz" | sha256sum -c --quiet
  tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
  install -m 755 "$tmp/$name/oauth2-proxy" /usr/local/bin/oauth2-proxy
  rm -rf "$tmp"
fi

# ── Tailscale ─────────────────────────────────────────────────────────────────────
if ! command -v tailscale &>/dev/null; then
  log "Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
fi

# ── Servicios ─────────────────────────────────────────────────────────────────────
log "Unidades de systemd"
install -m 644 "$DEPLOY_DIR"/systemd/*.service "$DEPLOY_DIR"/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
# Se instalan pero NO se habilitan. Prenderlas acá sería correr `fx:update` cada hora contra
# un repo que todavía no existe y respaldar una base vacía; el plan las habilita en orden.

log "Listo. Siguiente paso: deploy/PLAN-MIGRACION.md, fase 3."
