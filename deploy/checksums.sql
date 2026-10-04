-- Huella de cada tabla de `public`: filas + md5 del contenido. Sirve para decidir si dos
-- bases (Supabase y la copia, o un dump y su restauración) son LA MISMA, que es la única
-- prueba de que una mudanza no perdió ni cambió nada.
--
--   psql -X -At -F ' ' "$URL_A" -f checksums.sql > a.txt
--   psql -X -At -F ' ' "$URL_B" -f checksums.sql > b.txt
--   diff a.txt b.txt && echo IGUALES
--
-- Es solo lectura y no crea nada en la base (por eso usa query_to_xml en vez de una
-- función): se puede correr contra producción sin tocarla.
--
-- Para que dos servidores distintos den el mismo hash hay que fijar lo que cambia el TEXTO
-- de una fila sin cambiar su contenido: la zona horaria de los timestamptz y los decimales
-- de los float. El orden no puede depender del índice ni de la collation de cada base, por
-- eso se ordena por el texto de la fila con COLLATE "C".
SET TIME ZONE 'UTC';
SET extra_float_digits = 3;

SELECT c.relname AS tabla,
       (xpath('/row/n/text()', query_to_xml(
         format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text AS filas,
       (xpath('/row/h/text()', query_to_xml(
         format($q$SELECT coalesce(md5(string_agg(t::text, E'\n' ORDER BY t::text COLLATE "C")), 'vacia') AS h
                     FROM public.%I t$q$, c.relname), false, true, '')))[1]::text AS md5
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
 ORDER BY c.relname COLLATE "C";

-- Las secuencias no se ven en el contenido de las filas: una restauración que las dejara
-- en 1 pasaría el chequeo de arriba y chocaría con la primera inserción.
SELECT 'seq:' || sequencename, coalesce(last_value::text, 'sin-usar')
  FROM pg_sequences
 WHERE schemaname = 'public'
 ORDER BY sequencename COLLATE "C";
