# Migraciones de esquema (SQL manual)

Cada cambio de esquema es un archivo `AAAA-MM-DD-nombre.sql` en esta carpeta, que hace en la base lo mismo que el
cambio correspondiente de `../schema.prisma`. Los aplica `pnpm db:migrar` (`scripts/migrar.ts`), en orden de nombre y
una sola vez cada uno; en producción, `pnpm deploy:prod --migrar`.

Reglas (el porqué está en `CLAUDE.md`, sección «Schema changes»):

- **Sin `BEGIN`/`COMMIT`**: el ejecutor envuelve cada archivo en una transacción junto con su registro.
- **Un archivo aplicado no se edita** (se compara su checksum). El cambio va en uno nuevo.
- Lo que no puede ir en transacción (`CREATE INDEX CONCURRENTLY`, `ALTER TYPE … ADD VALUE`): primera línea
  `-- sin-transaccion`. `--probar` lo omite.
- Un chequeo previo de datos va dentro del archivo, como `DO $$ … RAISE EXCEPTION '…'; $$`.
- Siempre: `pnpm db:migrar --probar` (ensaya y deshace) antes de `--aplicar`.

Los siete archivos anteriores a `2026-10-03-ensambles.sql` ya estaban aplicados en producción cuando existió el
registro: se declaran con `--baseline=2026-09-03-comision-saliente-entrante.sql` la primera vez.
