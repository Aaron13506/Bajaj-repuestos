# Plan de migración: Heroku + Supabase → AWS Lightsail

Todo en una sola máquina: la app, Postgres, los crons, los backups. Una sola persona la usa.

```
Internet ──► https://bajaj.<tailnet>.ts.net      Tailscale Funnel: HTTPS + nombre gratis,
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

| Fase | Qué | Dónde | Afecta producción |
|---|---|---|---|
| 0 | Completar `deploy/` y ensayar todo en Docker | Tu PC | No |
| 1 | Cuentas: Tailscale, Google OAuth, buckets | Navegador | No |
| 2 | Crear la instancia | Consola Lightsail | No |
| 3 | Aprovisionar | Servidor | No |
| 4 | Ensayo con datos reales | Servidor | No (solo lectura) |
| 5 | Pasarse: timers, apagar Heroku | Servidor + Heroku | Sí (minutos) |
| 6 | Imágenes fuera de Supabase | Servidor | Sí (URLs) |
| 7 | Estabilización y baja de Heroku/Supabase | Todo | Sí |
| 8 | Recién después: migración de ensambles | — | — |

Cada fase termina en un **criterio de salida**: no se pasa a la siguiente sin cumplirlo.

---

## Fase 0 — Preparación local

### 0.1 Commitear el árbol de trabajo
Hay ~60 archivos modificados sin commitear. El servidor despliega desde GitHub: lo que no
está pusheado no existe para él.
```bash
git status            # revisar
git add -A && git commit && git push
```

### 0.2 Completar `deploy/`
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

### 0.3 Ensayo completo en Docker
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

### 0.4 Guardar el dump fuera de la sesión
`prod-public.dump` (1,4 MB) vive en un directorio temporal y tiene nombres y teléfonos de
clientes: moverlo a una carpeta de backups personal, **fuera del repo**. *Hecho: `C:\Users\Aaron\backups\bajaj\prod-public-2026-10-03.dump`.*

**Criterio de salida:** el ensayo en Docker pasa entero, sin pasos manuales que no estén
escritos en este plan.

---

## Fase 1 — Cuentas externas (antes de crear nada en AWS)

### 1.1 Tu cuenta de Google
Es la llave de todo. Passkey + verificación en dos pasos activadas, y códigos de respaldo
guardados en un lugar físico.

### 1.2 Tailscale
1. Crear la cuenta en tailscale.com **con esa misma cuenta de Google**.
2. Admin → **DNS**: activar MagicDNS y **HTTPS Certificates**. Anotar el nombre del tailnet
   (`<algo>.ts.net`): lo necesita el paso 1.3.
3. Admin → **Access controls**: Funnel tiene que estar permitido (por defecto, el primer
   `tailscale funnel` te muestra un link para habilitarlo).
4. Instalar Tailscale en tu PC y en tu celular. No es necesario para usar la app (eso va por
   Funnel), pero sí para administrar la máquina por SSH sin puertos abiertos.

### 1.3 Cliente OAuth de Google
En console.cloud.google.com:
1. Crear un proyecto `bajaj-repuestos`.
2. **OAuth consent screen**: tipo *External* y estado **Testing**, con tu correo como único
   *test user*. Así Google mismo rechaza cualquier otra cuenta antes de llegar a
   oauth2-proxy: es una capa más, gratis.
3. **Credentials → OAuth client ID → Web application**.
   - Authorized redirect URI: `https://bajaj.<tailnet>.ts.net/oauth2/callback`
4. Guardar el client ID y el secret en tu gestor de claves. Van a `/etc/bajaj/oauth2-proxy.env`.

> Riesgo a verificar acá mismo: que Google acepte el dominio `.ts.net` como redirect URI.
> Debería, porque es un dominio público. Si lo rechazara, el plan B es `sslip.io` con la IP
> estática: se cambia solo la URL, el resto del plan queda igual.

### 1.4 Buckets en Lightsail (región `us-east-1`)
| Bucket | Acceso | Para |
|---|---|---|
| `bajaj-backups-<sufijo>` | **Privado** | Dumps diarios |
| `bajaj-imagenes-<sufijo>` | Objetos de **lectura pública** | Las 1513 imágenes (140 MB) que hoy están en Supabase Storage |

Crear una *access key* por bucket, con permiso solo sobre su bucket, y guardarlas.

**Criterio de salida:** tenés el client ID y el secret, el nombre del tailnet y las dos
access keys, y Tailscale está instalado en la PC y el celular.

---

## Fase 2 — Crear la instancia

1. Lightsail → Create instance:
   - Región **us-east-1 (Virginia)**: la más cercana a Venezuela.
   - Plataforma Linux, blueprint **OS only → Ubuntu 24.04 LTS**.
   - Plan de **2 GB de RAM**. Con 1 GB, `next build` se queda sin memoria.
   - Nombre: `bajaj`.
   - **Automatic snapshots: activado** (diario).
2. Networking → **IPv4 firewall**:
   - Borrar la regla HTTP (80) que viene por defecto.
   - SSH (22) restringido a *Lightsail browser SSH* + tu IP actual (después de la fase 3 queda
     solo el de Lightsail).
   - IPv6: lo mismo.
3. Bajar la llave SSH por defecto de la región (Account → SSH keys).

**Criterio de salida:** entrás por `ssh -i llave.pem ubuntu@<ip>` y por el SSH del navegador.

---

## Fase 3 — Aprovisionar

### 3.1 Correr el setup
```bash
# Desde tu PC:
scp -i llave.pem -r deploy ubuntu@<ip>:~/

# En el servidor. Una clave larga y nueva: no reusar la de Supabase.
read -rs DB_PASSWORD && export DB_PASSWORD
sudo --preserve-env=DB_PASSWORD bash ~/deploy/setup.sh
```
Verificar: `node --version` da v24, `psql --version` da 17, `oauth2-proxy --version` da
v7.15.5, `swapon --show` muestra 2 GB.

### 3.2 Tailscale en el servidor
```bash
sudo tailscale up --ssh --hostname bajaj
```
1. Abrir el link que imprime y autorizar la máquina.
2. **Admin → Machines → bajaj → Disable key expiry.** Si no se desactiva, a los 180 días el
   servidor se cae de la red y solo se recupera por el SSH del navegador.
3. Probar desde la PC: `ssh ubuntu@bajaj` (entra sin llave, por Tailscale SSH).
4. Funciona → en el firewall de Lightsail, dejar el 22 **solo** para *Lightsail browser SSH*.

### 3.3 Clonar el repo con una llave de solo lectura
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

### 3.4 Cargar secretos
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
OAUTH2_PROXY_REDIRECT_URL="https://bajaj.<tailnet>.ts.net/oauth2/callback"
```
`sudoedit /etc/bajaj/backup.env` (con las credenciales del bucket de backups) y
`echo 'tu@gmail.com' | sudo tee /etc/oauth2-proxy/emails-autorizados`.

**Criterio de salida:** `sudo -iu bajaj bash -c 'psql "$DATABASE_URL" -c "select 1"'` funciona y los
cuatro archivos de `/etc/bajaj` están completos.

---

## Fase 4 — Ensayo con datos reales (producción sigue en Heroku)

> Mientras sigas usando la app vieja, lo que escribas en el servidor nuevo se pisa si
> volvés a cargar la base (fase 5, paso 1).

### 4.1 Traer la base
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

### 4.2 Primer deploy y arranque
```bash
~/app/deploy/deploy.sh
exit
sudo systemctl enable --now bajaj-app bajaj-oauth2-proxy
sudo tailscale funnel --bg 4180
```

### 4.3 Verificación
Desde el **celular con datos móviles y Tailscale apagado**, que es lo que vería cualquiera:
1. `https://bajaj.<tailnet>.ts.net` → pantalla de Google.
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

---

## Fase 5 — Pasarse

No hace falta ventana ni modo mantenimiento: la app la usás solo vos, así que no hay
escrituras que congelar. Lo único que escribe solo es el cron de `fx:update` en Heroku, y lo
que escribe (tasas y tarifas en `Config`) el servidor nuevo lo recalcula en su primera corrida.

1. **Si usaste la app vieja después del dump de 4.1**, repetí 4.1 (la base se recarga en un
   minuto). Si no la tocaste, el dump de la fase 4 ya es el definitivo.
2. Prender los timers y correr fx una vez:
   ```bash
   sudo systemctl enable --now bajaj-fx.timer bajaj-backup.timer
   sudo systemctl start bajaj-fx        # /config: tasas con fecha de hoy
   ```
3. Apagar Heroku para no entrar ahí por costumbre y escribir en la base vieja:
   `heroku ps:scale web=0 -a <app>` y borrar el job del Scheduler.

Volver atrás, si algo falla los primeros días, es `heroku ps:scale web=1`: Supabase sigue
intacto. Solo que lo que hayas cargado en Lightsail mientras tanto no estaría ahí.

---

## Fase 6 — Imágenes fuera de Supabase

> **No dejarlo para "algún día".** Si el proyecto de Supabase es del plan Free, Supabase lo
> pausa tras ~1 semana sin actividad en la base, y desde que te pasás esa base ya no recibe
> consultas. Proyecto pausado = Storage caído = las 1513 imágenes rotas. Hacer esta fase
> dentro de los días siguientes a la fase 5.

1. Copiar con rclone de bucket a bucket (los dos son S3), sin pasar por tu PC:
   ```bash
   rclone sync supabase:bajaj-imagenes lightsail:bajaj-imagenes-<sufijo> --progress
   rclone size supabase:bajaj-imagenes ; rclone size lightsail:bajaj-imagenes-<sufijo>
   ```
   Tiene que dar 1513 objetos y 140 MB en los dos.
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
5. **Código:** `scripts/recover-missing-images.ts` saca el `PROJECT_REF` del endpoint de
   Supabase. Hay que adaptarlo, o anotar que solo sirve contra Supabase.

**Criterio de salida:** ninguna URL apunta a `supabase.co` y las imágenes cargan.

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
   - `lib/db.ts`: la CA de Supabase sobra, pero no molesta. Se puede sacar más adelante.
4. **Tu `.env` local:** hoy `DATABASE_URL` apunta a producción. Los scripts que escriben en
   la base desde la PC (`prices:99rpm --apply`, `materialize`, `cross-ref`…) pasan a ir por un
   túnel:
   ```bash
   ssh -N -L 15432:localhost:5432 ubuntu@bajaj     # por Tailscale; 5432 local está ocupado
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
| Deploy | `ssh ubuntu@bajaj` → `sudo -iu bajaj /srv/bajaj/app/deploy/deploy.sh` (ruta entera: un `~` lo expande tu shell, no el de `bajaj`) |
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
| La llave de Tailscale vence a los 180 días | Key expiry desactivado en el servidor (fase 3.2) |
| Supabase pausa el proyecto y se caen las imágenes | La fase 6 va en los días siguientes a la fase 5 |
| Te quedás afuera de Google | Códigos de respaldo físicos; acceso de emergencia por el SSH del navegador de AWS |
