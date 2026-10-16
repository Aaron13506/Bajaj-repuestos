---
name: deploy-y-esquema
description: Producción, deploy y cambios de esquema (deploy/, scripts/migrar.ts, prisma/manual/*.sql, prisma/schema.prisma, systemd timers, backups, base local en Docker). Usar al cambiar el esquema de la base, escribir una migración, desplegar con pnpm deploy:prod, tocar el servidor Lightsail, el túnel SSH, las variables de entorno, los timers (fx, backup) o la copia local de producción.
---

# Deploy and schema changes

## Environments

- Production: one AWS Lightsail machine (app, Postgres, timers, backups) — `deploy/PLAN-MIGRACION.md`. Variables in `/etc/bajaj/app.env`. Entry: Tailscale Funnel → `oauth2-proxy` (owner's Google account) → Basic Auth in `proxy.ts`. SSH via Tailscale (`ubuntu@motokira`) may wait for browser authorization.
- The DB is private (localhost of the server). Locally `DATABASE_URL` points at the Docker copy (`pnpm db:up`, refreshed with `pnpm db:pull-prod`, which wipes the local DB). To touch production **on purpose**: run on the server (`sudo -iu bajaj`) or open the SSH tunnel from `.env.example` (`localhost:15432`) — with it open, anything that writes writes to production.
- Timers: `bajaj-fx.timer` hourly (`pnpm fx:update`: rates + Shoppre table), `bajaj-backup.timer` (dump → verified → rclone → prune).

## Changing the schema

Production's schema changes with **hand-written SQL**, not `prisma migrate` (`prisma/migrations` is one unused legacy migration).

1. Edit `prisma/schema.prisma` **and** add `prisma/manual/AAAA-MM-DD-nombre.sql` doing the same to the DB.
2. `pnpm db:migrar --probar` (runs pending files in a transaction and rolls back) against the local copy, then `--aplicar`, then `pnpm db:generate`.

File rules:
- Order is the file name's. **No `BEGIN`/`COMMIT`**: the runner wraps each file together with its `MigracionManual` row (stray lines are stripped).
- `-- sin-transaccion` in the first lines for what cannot run in a transaction (`CREATE INDEX CONCURRENTLY`, `ALTER TYPE … ADD VALUE`); such files are skipped by `--probar` and can fail half-done.
- **An applied file is never edited** (checksum, line endings ignored) — the change goes in a new file. A file that failed was not registered and can be fixed in place.
- A data precondition goes in the file as `DO $$ … RAISE EXCEPTION`, so `--probar` fails readably.
- A DB with no registry demands `--baseline=<last file already applied>` — never guessed.
- After applying, the runner compares the DB with `schema.prisma` (`prisma migrate diff`, exit 3 if different). CHECK constraints are invisible to Prisma. `MigracionManual` is in the schema only so the diff ignores it.

## Deploying (`pnpm deploy:prod [--migrar] [--dry]`)

Push first: the server pulls from GitHub. `deploy:prod` refuses without `--migrar` when the incoming commits carry a new `.sql`.

`deploy/deploy.sh` on the server: pull + install (old app serving) → if migrations: `--probar` (still serving) → stop `bajaj-app` → verified dump `/var/backups/bajaj/pre-migracion-*.dump` → `--aplicar` → build → start. Without pending migrations a `schema.prisma` that differs from the DB stops the deploy before building.

Failure paths: applying fails with nothing applied → back to the previous commit and its intact build. Applied something, or schema mismatch → app **left stopped** with the backup path and the way back. Build fails without migrations → rebuilds and restarts the previous commit (`next build` empties `.next` first, so the old app cannot just keep running). Stopping the app needs the sudoers entry from `setup.sh`.

The deployed commit is `/srv/bajaj/app/.desplegado`, written only on success — **not** the server repo's HEAD (`--migrar` fast-forwards before running the new `deploy.sh`; a failed attempt leaves HEAD unbuilt). `desplegar.sh` compares GitHub against it and rollbacks return to it. `deploy.sh` does not reinstall `deploy/systemd`, `setup.sh` or `oauth2-proxy.cfg`: apply those by hand.

Run a long deploy in the background without piping to `tail`; a cut deploy may keep running on the server.
