# Plan de migración: Heroku + Supabase → AWS Lightsail

Todo en una sola máquina: la app, Postgres, los crons, los backups. Una sola persona la usa.

```
Internet ──► https://motokira.<tailnet>.ts.net      Tailscale Funnel: HTTPS + nombre gratis,
              │                                   cero puertos abiertos en Lightsail
              ▼
           oauth2-proxy  127.0.0.1:4180          "Entrar con Google", solo tu correo
              │
              ▼
           next start    127.0.0.1:3000          Basic Auth de proxy.ts, segunda capa
              │
              ▼
           Postgres 17   localhost:5432          nunca escucha afuera

Timers: bajaj-fx (cada hora, fx:update)  ·  bajaj-backup (diario, pg_dump → bucket)
Fuera de la máquina: bucket de backups (privado) · bucket de imágenes (lectura pública)
```

**Por qué así.** La latencia a Supabase (`us-west-2`, ~200 ms por consulta, ~2,5 s por
conexión nueva) es lo que más pesa en cada render; con la base en la misma máquina cada
consulta tarda menos de 1 ms. La app no usa nada propio de Supabase (0 usuarios de Auth,
0 RLS, 0 funciones ni triggers en `public`) salvo el Storage de imágenes, que se muda a un
bucket. La seguridad no queda en un login propio: queda en tu cuenta de Google (con
passkey) y en que la máquina no tiene ningún puerto abierto a internet.

**Costo estimado** (verificar en la consola, los precios cambian): instancia 2 GB ≈ USD 12,
snapshots automáticos ≈ USD 1–2, dos buckets ≈ USD 1 c/u → **≈ USD 15–16/mes**.

---

## Índice

| Fase | Qué | Dónde | Afecta producción | Estado |
|---|---|---|---|---|
| 0 | Completar `deploy/` y ensayar todo en Docker | Tu PC | No | ✅ hecha (2026-10-04) |
| 1 | Cuentas: Tailscale, Google OAuth, buckets | Navegador | No | ✅ hecha (2026-10-04) |
| 2 | Crear la instancia | Consola Lightsail | No | ✅ hecha (2026-10-04) |
| 3 | Aprovisionar | Servidor | No | ✅ hecha (2026-10-04) |
| 4 | Ensayo con datos reales | Servidor | No (solo lectura) | ✅ hecha (2026-10-04); un error abierto, ver abajo |
| 5 | Pasarse: timers, apagar Heroku | Servidor + Heroku | Sí (minutos) | ✅ hecha (2026-10-04) |
| 6 | Imágenes fuera de Supabase | Servidor | Sí (URLs) | ✅ hecha (2026-10-04) |
| 7 | Estabilización y baja de Heroku/Supabase | Todo | Sí | ⏳ |
| 8 | Recién después: migración de ensambles | — | — | ⏳ |

Cada fase termina en un **criterio de salida**: no se pasa a la siguiente sin cumplirlo.

### Decisiones tomadas (valen para el resto del plan)

| Qué | Valor |
|---|---|
| Nombre del negocio en la infraestructura | **motokira** (no `bajaj`) para todo nombre nuevo. Lo ya probado conserva `bajaj`: usuario de Linux, `/srv/bajaj`, unidades `bajaj-*`, base `bajaj_repuestos`, y el bucket viejo de Supabase `bajaj-imagenes` |
| URL pública | `https://motokira.tailb33395.ts.net` (host de Tailscale `motokira`, tailnet `tailb33395`) |
| Redirect URI en Google | `https://motokira.tailb33395.ts.net/oauth2/callback` |
| Instancia de Lightsail | `motokira-prod`, `us-east-1`, Ubuntu 24.04, 2 GB |
| Buckets | `motokira-backups` (privado), `motokira-images` (lectura pública) |
| Acceso SSH | Con IP dinámica no se restringe el 22 por IP: queda **solo para el SSH del navegador**. Desde la PC se entra por Tailscale SSH |
| Dónde están los secretos | En el gestor de claves del usuario (client ID/secret de Google, access keys de los dos buckets). No van en el repo ni en el chat |

---

## Fase 0 — Preparación local  ✅

### 0.1 Commitear el árbol de trabajo  ✅ *(app y `deploy/` pusheados)*
Hay ~60 archivos modificados sin commitear. El servidor despliega desde GitHub: lo que no
está pusheado no existe para él.
```bash
git status            # revisar
git add -A && git commit && git push
```

### 0.2 Completar `deploy/`  ✅
`setup.sh` ya está. Faltan estos archivos, que el setup instala o que se usan después:

| Archivo | Contenido | Decisiones que fija |
|---|---|---|
| `env/app.env.example` | `DATABASE_URL`, `DIRECT_URL`, `ADMIN_USER`, `ADMIN_PASSWORD`, `S3_*` | Sin `APP_ENV` (así `proxy.ts` falla cerrado si falta algo). `DATABASE_URL` apunta a `localhost`: `lib/db.ts` ya no usa TLS ahí |
| `env/oauth2-proxy.env.example` | `OAUTH2_PROXY_CLIENT_ID`, `_CLIENT_SECRET`, `_COOKIE_SECRET`, `_REDIRECT_URL` | Los secretos van por entorno, no en el `.cfg` del repo |
| `env/backup.env.example` | Remoto de rclone vía `RCLONE_CONFIG_BACKUP_*`, `BACKUP_REMOTE`, retención | |
| `oauth2-proxy.cfg` | Config no secreta, versionada | `http_address = 127.0.0.1:4180`; `upstreams = http://127.0.0.1:3000`; `provider = google`; `authenticated_emails_file = /etc/oauth2-proxy/emails-autorizados`, **sin** `email_domains = *`; **`pass_basic_auth = false`** (si no, pisa el `Authorization` del navegador y el Basic Auth de la app falla siempre, sumando intentos al bloqueo); `reverse_proxy = true` + `trusted_ips` solo localhost; `pass_user_headers = false`; `cookie_secure = true`; `cookie_expire = 168h`; `skip_provider_button = true` |
| `systemd/bajaj-app.service` | `next start -H 127.0.0.1 -p 3000` como `bajaj` | `NODE_ENV=production`, `TZ=UTC` (igual que Heroku: los formularios con fecha asumen render en UTC), `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`, `Restart=always`, endurecimiento (`NoNewPrivileges`, `ProtectSystem=full`, `PrivateTmp`) |
| `systemd/bajaj-oauth2-proxy.service` | `oauth2-proxy --config=…` | `DynamicUser=yes`; `EnvironmentFile=/etc/bajaj/oauth2-proxy.env` (lo lee systemd como root antes de bajar privilegios). El `.cfg` y la lista de correos viven en `/etc/oauth2-proxy/` (root, 644, sin secretos): `/etc/bajaj` no es legible para un usuario dinámico, y `LoadCredential` no funciona en el contenedor de ensayo, así que no se pudo probar |
| `systemd/bajaj-fx.{service,timer}` | `pnpm fx:update` cada hora | Reemplaza al Heroku Scheduler. `Persistent=true` (si la máquina estuvo apagada, corre al volver) |
| `systemd/bajaj-backup.{service,timer}` | `backup.sh` diario 07:30 UTC (03:30 Caracas) | |
| `deploy.sh` | `git pull --ff-only` → `pnpm install --frozen-lockfile` → `pnpm build` → reinicio | Si el build falla, **no reinicia**, y la versión anterior sigue sirviendo (probado con un error de tipos: la app respondió 200 durante y después). El reinicio es un corte de ~1 s; lo hace `bajaj` con un `sudoers` que permite solo `systemctl restart bajaj-app`. Corre `set -a; . /etc/bajaj/app.env` por su cuenta, y `setup.sh` agrega eso mismo al `~/.profile` de `bajaj`. No corre migraciones: las de `prisma/manual/` se aplican a mano, como hoy |
| `backup.sh` | `pg_dump -Fc` → `pg_restore -l` (el dump se puede leer) → `rclone copy` → poda | 14 dumps locales; en el bucket, `rclone delete --min-age 60d` |
| `checksums.sql` | La consulta de filas + md5 por tabla de esta sesión | `COLLATE "C"` y `TIME ZONE 'UTC'`, para que dos servidores distintos den el mismo hash |

Antes de seguir: shellcheck sin errores en todos los `.sh` y `systemd-analyze verify` en
las unidades.

### 0.3 Ensayo completo en Docker  ✅ *(resultado más abajo)*
Un contenedor Ubuntu 24.04 con systemd (privilegiado) hace de Lightsail:

1. Copiar `deploy/` y correr `setup.sh` tal cual se va a correr en el servidor.
2. Clonar el repo en `/srv/bajaj/app` y restaurar `bajaj_prod_copy`, la copia ya verificada.
3. Correr `deploy.sh` y arrancar `bajaj-app` y `bajaj-oauth2-proxy` (con un client ID de prueba).
4. Verificar:
   - `curl 127.0.0.1:4180/` responde con una redirección a `accounts.google.com`.
   - `curl -u user:pass 127.0.0.1:3000/` responde 200.
   - **El header `Authorization` atraviesa oauth2-proxy sin cambios.** Se prueba con una
     ruta `skip_auth_routes` temporal y se compara lo que recibe la app. Es la trampa más
     probable de toda la arquitectura.
   - Correr `bajaj-backup.service` a mano: el dump se genera y restaura.
   - Correr `bajaj-fx.service` a mano: termina en `status=0`.
   - Reiniciar el contenedor: todo vuelve a levantar solo.
5. Lo que el contenedor no puede probar: el swap, Tailscale Funnel y el login real con
   Google. Eso queda para la fase 4.

**Resultado del ensayo (2026-10-04).** Pasó entero. Lo que salió y ya está corregido en `deploy/`:
- `setup.sh` es idempotente (segunda corrida: no reinstala nada).
- `LoadCredential=` de systemd no funciona dentro del contenedor, así que el `.cfg` y la lista de
  correos del proxy van a `/etc/oauth2-proxy/` (ver la tabla de 0.2).
- `sudo -iu bajaj ~/app/...` y `sudo -iu bajaj psql "$DATABASE_URL"` estaban mal: `~` y `$VAR` los
  expande **tu** shell, no el de `bajaj`. Ahora van con la ruta entera o dentro de `bash -c '…'`.
- La sesión de `bajaj` no tenía `DATABASE_URL`: `setup.sh` ahora carga `app.env` en su `~/.profile`.
- `deploy.sh` no podía reiniciar la app (`bajaj` no es sudoer): `sudoers` mínimo para esa unidad.
- Los `.sh` desde un checkout de Windows pueden quedar con CRLF y no ejecutan: `.gitattributes`
  fija LF para `deploy/` y `*.sh`.
- `checksums.sql` también compara las **secuencias**: una restauración que las dejara en 1 pasaría
  la comparación de filas y chocaría con la primera inserción.

Medido: el header `Authorization` atraviesa oauth2-proxy sin cambios; el `X-Forwarded-For` que la
app recibe es `<lo que mande el cliente>, 127.0.0.1`, así que `proxy.ts` (que toma el **último**) ve
siempre `127.0.0.1` y un header falso no esquiva el bloqueo; el `Host` se conserva, que es lo que
Next compara con el `Origin` de los Server Actions.

### 0.4 Guardar el dump fuera de la sesión  ✅
`prod-public.dump` (1,4 MB) vive en un directorio temporal y tiene nombres y teléfonos de
clientes: moverlo a una carpeta de backups personal, **fuera del repo**. *Hecho: `C:\Users\Aaron\backups\bajaj\prod-public-2026-10-03.dump`.*

**Criterio de salida:** el ensayo en Docker pasa entero, sin pasos manuales que no estén
escritos en este plan.

---

## Fase 1 — Cuentas externas (antes de crear nada en AWS)  ✅

### 1.1 Tu cuenta de Google  ✅
Es la llave de todo. Passkey + verificación en dos pasos activadas, y códigos de respaldo
guardados en un lugar físico.

### 1.2 Tailscale  ✅ *(PC conectada con la cuenta; celular agregado)*
1. Crear la cuenta en tailscale.com **con esa misma cuenta de Google**.
2. Admin → **DNS**: activar MagicDNS y **HTTPS Certificates**. Anotar el nombre del tailnet
   (`<algo>.ts.net`): lo necesita el paso 1.3.
3. Admin → **Access controls**: Funnel tiene que estar permitido (por defecto, el primer
   `tailscale funnel` te muestra un link para habilitarlo).
4. Instalar Tailscale en tu PC y en tu celular. No es necesario para usar la app (eso va por
   Funnel), pero sí para administrar la máquina por SSH sin puertos abiertos.

### 1.3 Cliente OAuth de Google  ✅ *(cliente creado; secretos guardados por el usuario)*
En console.cloud.google.com:
1. Crear un proyecto `bajaj-repuestos`.
2. **OAuth consent screen**: tipo *External* y estado **Testing**, con tu correo como único
   *test user*. Así Google mismo rechaza cualquier otra cuenta antes de llegar a
   oauth2-proxy: es una capa más, gratis.
3. **Credentials → OAuth client ID → Web application**.
   - Authorized redirect URI: `https://motokira.<tailnet>.ts.net/oauth2/callback`
4. Guardar el client ID y el secret en tu gestor de claves. Van a `/etc/bajaj/oauth2-proxy.env`.

> Riesgo a verificar acá mismo: que Google acepte el dominio `.ts.net` como redirect URI.
> Debería, porque es un dominio público. Si lo rechazara, el plan B es `sslip.io` con la IP
> estática: se cambia solo la URL, el resto del plan queda igual.

### 1.4 Buckets en Lightsail (región `us-east-1`)  ✅ *(creados con estos nombres; access keys guardadas)*
| Bucket | Acceso | Para |
|---|---|---|
| `motokira-backups` | **Privado** | Dumps diarios |
| `motokira-images` | Objetos de **lectura pública** | Las 1513 imágenes (140 MB) que hoy están en Supabase Storage |

Crear una *access key* por bucket, con permiso solo sobre su bucket, y guardarlas.

**Criterio de salida (cumplido):** tenés el client ID y el secret, el nombre del tailnet y las dos
access keys, y Tailscale está instalado en la PC y el celular.

---

## Fase 2 — Crear la instancia  ✅

1. Lightsail → Create instance:
   - Región **us-east-1 (Virginia)**: la más cercana a Venezuela.
   - Plataforma Linux, blueprint **OS only → Ubuntu 24.04 LTS**.
   - Plan de **2 GB de RAM**. Con 1 GB, `next build` se queda sin memoria.
   - Nombre: `motokira-prod`.
   - **Automatic snapshots: activado** (diario).
2. Networking → **IPv4 firewall**:
   - Borrar la regla HTTP (80) que viene por defecto.
   - SSH (22): dejarlo **solo para *Lightsail browser SSH***, sin ninguna IP tuya. Con IP
     dinámica no hay una IP que fijar, y no hace falta: para trabajar con la máquina desde la PC
     se usa Tailscale SSH (fase 3.1), que no necesita ningún puerto abierto.
   - IPv6: lo mismo.
3. Bajar la llave SSH por defecto de la región (Account → SSH keys). Queda de respaldo: con el 22
   cerrado a todo menos al navegador, `ssh -i` desde la PC no entra.

**Criterio de salida:** entrás por el botón *Connect using SSH* del navegador, y el firewall no
tiene ningún puerto abierto a internet.

---

## Fase 3 — Aprovisionar  ✅

Tailscale va **primero** y se instala desde el SSH del navegador: así `deploy/` se sube por la
red privada y el puerto 22 nunca se abre.

### 3.1 Tailscale en el servidor  ✅
Desde el SSH del navegador de Lightsail:
```bash
curl -fsSL https://tailscale.com/install.sh | sudo sh
sudo tailscale up --ssh --hostname motokira
```
1. Abrir el link que imprime y autorizar la máquina.
2. **Admin → Machines → motokira → Disable key expiry.** Si no se desactiva, a los 180 días el
   servidor se cae de la red y solo se recupera por el SSH del navegador.
3. Probar desde la PC (con Tailscale iniciado): `ssh ubuntu@motokira` (entra sin llave, por
   Tailscale SSH).

### 3.2 Correr el setup  ✅
```bash
# Desde tu PC (por Tailscale, no hace falta llave ni IP):
scp -r deploy ubuntu@motokira:~/

# En el servidor. Una clave larga y nueva: no reusar la de Supabase.
read -rs DB_PASSWORD && export DB_PASSWORD
sudo --preserve-env=DB_PASSWORD bash ~/deploy/setup.sh
```
`setup.sh` ve que Tailscale ya está y no lo toca. Verificar: `node --version` da v24,
`psql --version` da 17, `oauth2-proxy --version` da v7.15.5, `swapon --show` muestra 2 GB.

### 3.3 Clonar el repo con una llave de solo lectura  ✅
```bash
sudo -iu bajaj
ssh-keygen -t ed25519 -N '' -f ~/.ssh/github -C 'bajaj@lightsail'
printf 'Host github.com\n  IdentityFile ~/.ssh/github\n' > ~/.ssh/config
cat ~/.ssh/github.pub
```
Pegar la llave en GitHub → repo → Settings → **Deploy keys**, **sin** permiso de escritura.
```bash
git clone git@github.com:Aaron13506/Bajaj-repuestos.git ~/app
```

### 3.4 Cargar secretos  ✅
`sudoedit /etc/bajaj/app.env`:
```
DATABASE_URL="postgresql://bajaj:<DB_PASSWORD>@localhost:5432/bajaj_repuestos"
DIRECT_URL="postgresql://bajaj:<DB_PASSWORD>@localhost:5432/bajaj_repuestos"
ADMIN_USER="<nuevo>"
ADMIN_PASSWORD="<nueva, larga>"
# S3_*: por ahora los de Supabase (la fase 6 los cambia)
```
`sudoedit /etc/bajaj/oauth2-proxy.env`:
```
OAUTH2_PROXY_CLIENT_ID="…"
OAUTH2_PROXY_CLIENT_SECRET="…"
OAUTH2_PROXY_COOKIE_SECRET="<salida de: openssl rand -base64 32 | tr -- '+/' '-_'>"
OAUTH2_PROXY_REDIRECT_URL="https://motokira.<tailnet>.ts.net/oauth2/callback"
```
`sudoedit /etc/bajaj/backup.env` (con las credenciales del bucket de backups) y
`echo 'tu@gmail.com' | sudo tee /etc/oauth2-proxy/emails-autorizados`.

**Criterio de salida:** `sudo -iu bajaj bash -c 'psql "$DATABASE_URL" -c "select 1"'` funciona y los
cuatro archivos de `/etc/bajaj` están completos.

---

## Fase 4 — Ensayo con datos reales (producción sigue en Heroku)  ✅

> Mientras sigas usando la app vieja, lo que escribas en el servidor nuevo se pisa si
> volvés a cargar la base (fase 5, paso 1).

### 4.1 Traer la base  ✅ *(con el dump de 0.4, ver el resultado más abajo)*
Desde el servidor, directo contra Supabase. Es solo lectura, y la versión 17 del cliente
coincide con la del servidor de Supabase:
```bash
sudo -iu bajaj
read -rs SUPABASE_URL      # el DIRECT_URL de Supabase, con ?sslmode=require
pg_dump "$SUPABASE_URL" -n public --no-owner --no-acl -Fc -f /var/backups/bajaj/ensayo.dump
pg_restore -d "$DATABASE_URL" --no-owner --no-acl /var/backups/bajaj/ensayo.dump
#   el único error esperado es "schema public already exists"
```
Verificar con `deploy/checksums.sql` contra Supabase: 14 de 14 tablas iguales.

### 4.2 Primer deploy y arranque  ✅
```bash
~/app/deploy/deploy.sh
exit
sudo systemctl enable --now bajaj-app bajaj-oauth2-proxy
sudo tailscale funnel --bg 4180
```

### 4.3 Verificación  ✅
Desde el **celular con datos móviles y Tailscale apagado**, que es lo que vería cualquiera:
1. `https://motokira.<tailnet>.ts.net` → pantalla de Google.
2. Una **cuenta de Google que no sea la tuya** → rechazada.
3. Tu cuenta → prompt de Basic Auth → la app.

Recorrer las pantallas. **Guardar algo de verdad en una** (cualquier formulario: es un Server Action, y Next rechaza los que llegan con un `Origin` que no coincide con el `Host`: es lo único que el ensayo en Docker no pudo cubrir de punta a punta):
- `/products`, `/products/<id>`, `/groups`
- `/presupuestos/<id>` de uno con conjuntos
- `/envios/<id>` aéreo y marítimo
- `/simular`, `/contabilidad`, `/config`

Medir: la carga de `/products` y `/envios/<id>` contra Heroku. Es la razón de todo esto, así
que la mejora tiene que notarse.

En el servidor:
- `pnpm check:costeo` y `pnpm check:libro` deben dar limpio.
- `systemctl start bajaj-backup` → el dump llega al bucket → se baja y se restaura en una
  base descartable → `checksums.sql` coincide.
- `systemctl start bajaj-fx` → `journalctl -u bajaj-fx` sin errores.
- `sudo reboot` → al volver, todo arriba solo y Funnel activo.

**Criterio de salida:** todo lo de arriba en verde, y probaste un restore del backup
(un backup que nunca se restauró no está probado).

**Resultado del ensayo (2026-10-04).** Pasó, con un error abierto. Lo medido:
- **Restore.** Se usó el dump de 0.4 (03/10, hecho con pg_dump 18.3 desde el Postgres 17.6 de Supabase) y el
  `pg_restore` 17 del servidor lo leyó sin problema. Único error: `schema "public" already exists`. Quedaron
  las 14 tablas y las 13 secuencias (Product 5717, ProductComponent 14592, SupplierPrice 3988, Pedido 34).
  **No se comparó contra Supabase**: eso lleva la URL de Supabase y se hace con el dump fresco de la fase 5.
- **Deploy.** `deploy.sh` instaló y construyó en el servidor (Next 16.4.0-canary.39). Los tres puertos solo
  escuchan en `127.0.0.1` (3000, 4180, 5432). La app da 401 sin credenciales y 200 con ellas; el proxy da 302 a
  Google. `/products` en frío: 0,42 s en el servidor.
- **Desde afuera.** Sin VPN, desde el celular: Google → Basic Auth → la app. Una cuenta de Google ajena es
  **rechazada**. Un formulario **guarda** bien (el Server Action pasa por Funnel sin que Next rechace el
  `Origin`). La velocidad se nota mejor que en Heroku.
- **Servidor.** `check:costeo` y `check:libro` limpios; `bajaj-fx` termina en `status=0`; `bajaj-backup` sube
  el dump al bucket, se baja y se restaura en una base descartable con las **mismas huellas** que la
  restauración original (las 13 tablas y las 13 secuencias; `Config` aparte porque `fx:update` la acababa
  de cambiar). `sudo reboot`: app, proxy, Postgres, swap y Funnel vuelven solos.
- Los timers (`bajaj-fx`, `bajaj-backup`) **siguen sin activar**: eso es de la fase 5.

Lo que salió y conviene saber:
- **Funnel tarda en aparecer.** Recién activado, el DNS público de `motokira.<tailnet>.ts.net` seguía dando la
  IP privada `100.x` (TTL 600) y desde afuera no abría; apareció unos 20 minutos después, sin tocar nada.
  El chequeo es `Resolve-DnsName motokira.<tailnet>.ts.net -Server 8.8.8.8`: mientras dé `100.x`, no es público.
- **No probar con la VPN prendida.** Dentro del tailnet el nombre resuelve a la IP privada y abre igual, sin
  pasar por Funnel, así que esconde justamente lo que se quiere probar. En el celular con Tailscale prendido
  la app **no** abrió (el nombre no se resolvía bien); sin VPN sí. **Tailscale no hace falta para usar la app**,
  solo para administrar el servidor desde la PC.
- **SSH desde PowerShell:** un comando con comillas anidadas (`ssh host 'sudo -iu bajaj bash -c "..."'`) se rompe
  de dos maneras (PowerShell las desarma y le agrega BOM y CRLF a lo que se manda por pipe). Lo que funcionó
  siempre: escribir el script en un archivo con LF, `scp` al servidor y correrlo allá.
- `StrictHostKeyChecking accept-new` en `~/.ssh/config` de `bajaj` evita que el primer `git clone` pida confirmar
  la huella de GitHub.

**Abierto (sigue sin resolver; Heroku ya está apagado, ya no hay con qué comparar):** al borrar un presupuesto, la pantalla muestra «No se pudo completar la
acción» aunque el borrado **sí ocurrió**. En el servidor la acción terminó bien (`POST /presupuestos` → 200, 20 KB,
0,16 s, sin errores en ningún log), así que la falla es del lado del navegador al procesar el redirect de
`deletePresupuesto` (`components/DeleteButton.tsx:32` es el mensaje genérico). Falta saber si en Heroku pasaba
igual y qué dice la consola del navegador. Con Heroku apagado ya no habrá con qué comparar.

---

## Fase 5 — Pasarse  ✅

No hace falta ventana ni modo mantenimiento: la app la usás solo vos, así que no hay
escrituras que congelar. Lo único que escribe solo es el cron de `fx:update` en Heroku, y lo
que escribe (tasas y tarifas en `Config`) el servidor nuevo lo recalcula en su primera corrida.

1. **Cargar la base definitiva.** El dump del ensayo es del 03/10 y la base del servidor ya tiene
   escrituras de la prueba (se borró un presupuesto y `fx:update` cambió `Config`), así que **no sirve
   como definitivo**: traé un dump fresco (4.1, esta vez con el `pg_dump` directo contra Supabase) y
   comparalo con `checksums.sql` contra Supabase (14 de 14). Como la base no está vacía, hay que
   recrearla antes de restaurar, con la app parada:
   ```bash
   sudo systemctl stop bajaj-app
   sudo -u postgres psql -c 'DROP DATABASE bajaj_repuestos' -c 'CREATE DATABASE bajaj_repuestos OWNER bajaj'
   # pg_restore como en 4.1 (el único error esperado sigue siendo "schema public already exists")
   sudo systemctl start bajaj-app
   ```
2. Prender los timers y correr fx una vez:
   ```bash
   sudo systemctl enable --now bajaj-fx.timer bajaj-backup.timer
   sudo systemctl start bajaj-fx        # /config: tasas con fecha de hoy
   ```
3. Apagar Heroku para no entrar ahí por costumbre y escribir en la base vieja:
   `heroku ps:scale web=0 -a <app>` y borrar el job del Scheduler.

Volver atrás, si algo falla los primeros días, es `heroku ps:scale web=1`: Supabase sigue
intacto. Solo que lo que hayas cargado en Lightsail mientras tanto no estaría ahí.

**Resultado (2026-10-04).** Los tres pasos hechos; el 3 (Heroku) lo hizo el usuario.
- **Base definitiva.** Dump fresco de Supabase, restaurado con la app parada: las huellas de
  `checksums.sql` dieron **iguales** (16 tablas y 13 secuencias; `Config` incluida, porque el cron de
  Heroku no escribió entre el dump y la comparación). Único error de `pg_restore`: `schema "public"
  already exists`. `check:costeo` y `check:libro` limpios.
- **Timers.** `bajaj-fx.timer` (cada hora) y `bajaj-backup.timer` (07:30 UTC) activos. `fx` corrido
  a mano: `status=0`, INR 96,32, BsD 975,47, tarifas de Shoppre sin cambios.
- **Heroku.** Apagado por el usuario. Marcha atrás: `heroku ps:scale web=1`. *(Confirmar que el job
  del Scheduler también se borró: si queda, al reencender un dyno volvería a escribir tasas en la
  base vieja.)*
- **Pendiente de verificar el primer backup automático** (07:30 UTC): que el dump llegue al bucket.

Lo que salió y conviene saber:
- **`/var/backups/bajaj` lo lee solo `bajaj`** (los dumps se crean con `umask 077`). Desde `ubuntu`,
  `ls`, `wc`, `diff` o `grep` sobre esos archivos dan *Permission denied*: hay que pasar por
  `sudo -u bajaj`. Tampoco puede `bajaj` leer el home de `ubuntu`: un script se le pasa por stdin
  (`ssh ubuntu@motokira 'sudo -u bajaj bash -s' < script.sh`).
- **`pg_dump` contra Supabase sin `sslmode`** usa `prefer` y cae a texto plano si el SSL falla. El
  `DIRECT_URL` del `.env` no lo trae (la app pone el SSL por código, `lib/db.ts`) y es el **pooler en
  modo sesión** (`…pooler.supabase.com:5432`), que sirve para `pg_dump`. Se agrega `?sslmode=require`.
- **Un script con `set -e` que lee esos archivos como `ubuntu` corta a mitad**, y lo peor es que lo
  hace *antes* del paso destructivo solo por suerte de orden: el script de carga hace primero todo lo
  de afuera (copia de la base del servidor, dump y huellas de Supabase) y recién después para la app.
- Un comando `ssh host "…"` desde PowerShell con comillas anidadas deja variables vacías sin avisar
  (un `diff` de dos archivos inexistentes dio «IGUALES»). Verificar siempre que el resultado no sea
  vacío; mejor, script en archivo.
- Quedan en `/var/backups/bajaj` los dumps `pre-fase5-*` y `fase5-*` (de dos corridas). Se pueden
  borrar cuando el backup automático esté probado.

---

## Fase 6 — Imágenes fuera de Supabase  ✅

> **No dejarlo para "algún día".** Si el proyecto de Supabase es del plan Free, Supabase lo
> pausa tras ~1 semana sin actividad en la base, y desde que te pasás esa base ya no recibe
> consultas. Proyecto pausado = Storage caído = las 1513 imágenes rotas. Hacer esta fase
> dentro de los días siguientes a la fase 5.

**Qué se sabe del código antes de empezar** (revisado el 2026-10-04):
- Las URLs viven en **tres columnas**, y solo ahí: `Product.imageUrl`, `ScrapedProduct.imageS3Url`,
  `ScrapedPart.imageUrl`. `sourceUrl` y `mainImageUrl` apuntan a 99rpm, no a Supabase.
- Las keys eran `99rpm/<nombre>`: si la copia las conserva, reescribir la URL es solo cambiar el
  prefijo. Se copió **con las mismas keys** y después se **quitó el prefijo** (ver el resultado): una URL pública
  con `99rpm/` delata de dónde viene cada imagen.
- `next.config.mjs` está vacío: no hay `images.remotePatterns` ni `next/image` con dominios fijos, así
  que cambiar de host no pide tocar la config de Next.
- **Dos** scripts arman la URL pública asumiendo Supabase, no uno: `prisma/seed-scraped.ts:49-51` y
  `scripts/recover-missing-images.ts:44-45` (ambos sacan `PROJECT_REF` del endpoint y lo meten en
  `https://<ref>.supabase.co/storage/v1/object/public/<bucket>`). Se adaptan en el paso 5.

1. Copiar con rclone de bucket a bucket (los dos son S3), sin pasar por tu PC. Necesita dos remotos
   en el servidor, y se definen **por entorno** como en `backup.env` (sin `rclone.conf`): uno `supabase`
   con las `S3_*` de hoy (`provider=Other`, el `S3_ENDPOINT_URL` de Supabase, path-style) y uno
   `lightsail` con la access key de `motokira-images` (`provider=AWS`, `us-east-1`,
   `NO_CHECK_BUCKET=true`). Van en un archivo temporal que se borra al terminar la fase.
   ```bash
   rclone copy supabase:bajaj-imagenes lightsail:motokira-images --progress --checksum
   rclone size supabase:bajaj-imagenes ; rclone size lightsail:motokira-images
   ```
   Es `copy` y no `sync`: no borra nada del destino, y si se corta se repite sin riesgo.
   Tiene que dar 1513 objetos y 140 MB en los dos. Abrir una URL pública del bucket nuevo en una
   ventana de incógnito **antes** de seguir: confirma que la lectura pública funciona y deja ver el
   formato exacto de la URL (`https://motokira-images.s3.us-east-1.amazonaws.com/<nombre>`
   es lo esperado, pero se verifica en la consola de Lightsail, no se asume).
2. Inventariar dónde están guardadas las URLs:
   ```sql
   SELECT 'Product', count(*) FROM "Product" WHERE "imageUrl" LIKE '%supabase.co%'
   UNION ALL SELECT 'ScrapedProduct', count(*) FROM "ScrapedProduct" WHERE "imageS3Url" LIKE '%supabase.co%'
   UNION ALL SELECT 'ScrapedPart', count(*) FROM "ScrapedPart" WHERE "imageUrl" LIKE '%supabase.co%';
   ```
3. Backup, y después reescribir el prefijo en una transacción: `replace(col, '<prefijo
   supabase>/', '<prefijo bucket>/')`. Verificar que los conteos del paso 2 den 0 y abrir
   una muestra de imágenes.
4. Cambiar `S3_*` en `/etc/bajaj/app.env` al bucket nuevo y reiniciar.
5. **Código:** `prisma/seed-scraped.ts` y `scripts/recover-missing-images.ts` arman la URL pública
   con el formato de Supabase. Sacar esa construcción a un solo lugar (por ejemplo una variable
   `S3_PUBLIC_BASE_URL` en `app.env`) y leerla en los dos, en vez de derivarla del endpoint. Si no, la
   próxima corrida de cualquiera de los dos escribe URLs de `supabase.co` otra vez en la base.

**Criterio de salida:** ninguna URL apunta a `supabase.co` y las imágenes cargan.

**Resultado (2026-10-04).** Los cinco pasos hechos, más un sexto que no estaba en el plan: quitar el prefijo `99rpm/`.
- **Copia.** `rclone copy` de bucket a bucket, desde el servidor: 1513 objetos y 146 501 171 bytes en origen y destino, con las
  keys `99rpm/<nombre>` de Supabase. Lectura pública sin credenciales: 200, `image/jpeg`.
- **Inventario.** 1512 filas en `Product.imageUrl` y 1512 en `ScrapedProduct.imageS3Url`; `ScrapedPart.imageUrl` no tenía ninguna
  (0 de 14 583). Un solo prefijo en todas. Todas las keys referenciadas existían en el bucket nuevo; sobra un objeto sin fila (1513 contra
  1512). Sin triggers en la base.
- **Reescritura 1 (host).** Backup previo (`pre-fase6-20261004T0640Z.dump`) y un `UPDATE` de las dos columnas en una transacción que
  verifica adentro y aborta si no cuadra: 0 con `supabase.co`, 1512 + 1512 con el prefijo nuevo, y el `replace` inverso devuelve cada fila a su
  valor original. `updatedAt` no se tocó (SQL directo, sin que Prisma intervenga).
- **Reescritura 2 (quitar `99rpm/`).** El bucket es público y la URL con `99rpm/` dice de dónde salió cada imagen, así que las keys pasaron a ser
  solo `<nombre>`. Orden que no rompe nada en ningún momento: (1) copia dentro del mismo bucket de `99rpm/` a la raíz, en el servidor de S3 y sin
  descargar; (2) verificar; (3) backup (`pre-fase6b-20261004T0649Z.dump`) y el mismo `UPDATE` guardado (`…amazonaws.com/99rpm/` →
  `…amazonaws.com/`); (4) probar **las 1512 URLs tal como están en la base**: 1510 × `200 image/jpeg` y 2 × `200 image/png`, ninguna con
  `99rpm` o `supabase`, y 5 al azar desde fuera del servidor; (5) recién ahí, borrar `99rpm/`. Estado final del bucket: 1513 objetos en la raíz,
  0 en `99rpm/`, la URL vieja da 403 y la nueva 200.
- **`app.env`.** `S3_*` apunta a `motokira-images` (`S3_ENDPOINT_URL` vacío, `S3_REGION=us-east-1`) y se agregó `S3_PUBLIC_BASE_URL`
  (`https://motokira-images.s3.us-east-1.amazonaws.com`). Copia del anterior en `/etc/bajaj/app.env.pre-fase6` (tiene las llaves de Supabase:
  borrarla en la fase 7). `bajaj-app` reiniciada; `check:libro` limpio.
- **Código.** `lib/s3-publico.ts` (`s3PublicBase()` exige `S3_PUBLIC_BASE_URL`, sin derivarla del endpoint; `s3ClientConfig()` omite el
  endpoint si está vacío) y la key sin prefijo (`key = name`) en `prisma/seed-scraped.ts` y `scripts/recover-missing-images.ts`.
- Borrado el archivo temporal con los remotos de rclone y los scripts de trabajo del servidor.

Lo que salió y conviene saber:
- **Un `rclone copy` de un prefijo a la raíz del mismo bucket** choca con el chequeo de remotos solapados. Se resuelve con dos remotos
  de rclone con nombres distintos y las mismas llaves, más `--server-side-across-configs` (copia dentro de S3, sin descargar).
- **`rclone check` hacia la raíz del bucket reporta «1513 differences» aunque todo esté bien:** el destino recursivo incluye también la carpeta
  vieja, y esos 1513 son «sobrantes del lado destino». Se comprueba con `--max-depth 1` (0 diferencias, 1513 coincidentes).
- `rclone lsf -R` ya devuelve `99rpm/<nombre>`: al comparar keys de la base con el bucket no hay que anteponer `99rpm/` otra vez (un primer
  intento lo duplicó y dio «todo falta»; la falla de comillas de otro dejó vacía una lista y la comparación habría dado «todo bien»).
  Verificar siempre que las listas comparadas no estén vacías.
- `systemctl restart` deja `Failed with result 'exit-code'` en el journal (`status=143`: SIGTERM de Node). Es ruido de la parada, no una caída.
- **Lo que sigue delatando el origen:** `Product.sourceUrl` y `mainImageUrl` guardan URLs de 99rpm en la base. Si alguna pantalla las muestra,
  el prefijo ya no es el único rastro. No se revisó.
- **Pendiente en la PC:** el `.env` local sigue con las `S3_*` de Supabase y sin `S3_PUBLIC_BASE_URL`, así que los dos scripts de imágenes se
  niegan a correr hasta que se actualice (parte del punto 7.4).

---

## Fase 7 — Estabilización (1–2 semanas) y baja

**Durante:**
- Cada pocos días: `systemctl list-timers bajaj-*`, que el último dump esté en el bucket y
  que `journalctl -p err -S yesterday` esté limpio.

**Después:**
1. **Heroku:** anotar las config vars (`heroku config -a <app>`) en el gestor de claves,
   bajar los dynos a 0 y, una semana más tarde, borrar la app.
2. **Supabase:** un último dump completo archivado (base + inventario del bucket). Después,
   pausar el proyecto y, más adelante, borrarlo. **Rotar** la clave de la base de Supabase y
   las access keys S3 que estaban en `.env`.
3. **Repo y docs:**
   - `CLAUDE.md`: Environment, Auth y la nota sobre dónde viven las tarifas (ya no hay Heroku).
   - `.env.example`: dejar de apuntar a Supabase.
   - `proxy.ts`: el comentario sobre `X-Forwarded-For` habla de Heroku. Ahora el último salto
     es oauth2-proxy (`127.0.0.1`), así que el bloqueo por IP es uno solo para todos. Es
     aceptable, porque a esa puerta solo llega quien ya pasó por tu Google, pero el
     comentario tiene que decirlo.
   - Borrar el `Procfile`.
   - Borrar `/etc/bajaj/app.env.pre-fase6` (tiene las llaves de Supabase) y los dumps `pre-fase6*` de `/var/backups/bajaj` cuando el backup
     automático esté probado.
   - `lib/db.ts`: la CA de Supabase sobra, pero no molesta. Se puede sacar más adelante.
4. **Tu `.env` local:** hoy `DATABASE_URL` **y `DIRECT_URL`** apuntan a Supabase (el pooler `aws-1-us-west-2`,
   puertos 6543 y 5432): cambiar las dos, no solo la de runtime. Mientras tanto, cualquier script que
   escriba desde la PC (`prices:99rpm --apply`, `materialize`…) escribe en la base **vieja**, no en la
   que se usa. Por eso conviene hacer este punto apenas termine la fase 6, no al final de la 7. Los scripts que escriben en
   la base desde la PC (`prices:99rpm --apply`, `materialize`, `cross-ref`…) pasan a ir por un
   túnel:
   ```bash
   ssh -N -L 15432:localhost:5432 ubuntu@motokira     # por Tailscale; 5432 local está ocupado
   # .env → DATABASE_URL="postgresql://bajaj:…@localhost:15432/bajaj_repuestos"
   ```
   `lib/db.ts` no usa TLS hacia `localhost`, y el túnel ya va cifrado.

---

## Fase 8 — Migración de ensambles

Va recién acá, con la base ya estable en Lightsail. Está ensayada en
`prisma/manual/2026-10-03-ensambles.sql`. Mezclarla con la mudanza haría inservibles los
checksums: si el esquema cambia a la vez, ya no hay contra qué comparar la copia.

---

## Operación diaria

| Tarea | Cómo |
|---|---|
| Deploy | Primero `git push`; después, desde la PC, **`pnpm deploy:prod`** (`deploy/desplegar.sh`): le dice al servidor que traiga lo de GitHub, muestra los commits que llegan, corre `deploy.sh` por SSH y verifica que quedó en el mismo commit que GitHub y que la app responde (401). **No hace push ni mira tu árbol local**; solo avisa si tu commit local no está en GitHub. `--dry` solo muestra. Si lo que llega cambia `prisma/schema.prisma` se detiene hasta que apliques el cambio en la base y pases `--esquema-aplicado` (un `.sql` nuevo en `prisma/manual/` solo avisa: `deploy.sh` no lo ejecuta). Es manual a propósito: no hay CI ni timer, un push roto no llega solo a producción. A mano en el servidor: `sudo -iu bajaj /srv/bajaj/app/deploy/deploy.sh` (ruta entera: un `~` lo expande tu shell, no el de `bajaj`) |
| Logs de la app | `journalctl -u bajaj-app -f` |
| Estado general | `systemctl status bajaj-app bajaj-oauth2-proxy` · `systemctl list-timers bajaj-*` · `tailscale funnel status` |
| Migración SQL manual | `sudo -iu bajaj bash -c 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ~/app/prisma/manual/<archivo>.sql'`, con un backup a mano antes |
| Restaurar un backup | Bajar con `rclone copy`, restaurar en una base nueva, comprobar y recién ahí cambiar |
| Dispositivo nuevo | Nada: entrás por la URL con Google. Solo para *administrar* hace falta Tailscale |
| Perdiste el celular | Cerrar las sesiones de Google y sacar el dispositivo en el admin de Tailscale |
| Emergencia (Tailscale caído o sin acceso) | Lightsail → *Connect using SSH* desde cualquier navegador |
| Actualizar oauth2-proxy | Cambiar versión + sha256 en `setup.sh` y volver a correrlo |
| Paquetes del sistema | Se parchean solos (`unattended-upgrades`). Reiniciar si aparece `/var/run/reboot-required` |

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Se rompe el disco o la instancia | Snapshot diario de Lightsail + dump diario en un bucket **separado** de la instancia |
| Un backup que no restaura | `backup.sh` valida cada dump con `pg_restore -l`; restore real probado en las fases 4 y 5 |
| Alguien adivina la URL | Ve Google; el consent screen en *Testing* y la lista de oauth2-proxy rechazan cualquier otra cuenta; después sigue el Basic Auth |
| Una falla de Next o de React | La app no está expuesta: hay que pasar primero por Google. Igual, mantener Next actualizado (`deploy.sh` después de cada bump) |
| `next build` sin memoria | 2 GB + 2 GB de swap; si un build falla, la versión anterior sigue sirviendo |
| La llave de Tailscale vence a los 180 días | Key expiry desactivado en el servidor (fase 3.1) |
| Supabase pausa el proyecto y se caen las imágenes | La fase 6 va en los días siguientes a la fase 5 |
| Te quedás afuera de Google | Códigos de respaldo físicos; acceso de emergencia por el SSH del navegador de AWS |
