-- ============================================================================
-- reset_secuencias.sql
-- Reinicia el contador (sequence) de cada tabla al valor real que quedó
-- después de tus borrados manuales, para que el próximo INSERT continúe
-- desde MAX(id)+1 en vez de seguir donde se quedó el contador viejo (que
-- no baja solo cuando borras filas a mano).
--
-- Es genérico: recorre TODAS las tablas de public con columna "id" que
-- tengan una sequence asociada (sirve tanto para bigserial/serial como
-- para GENERATED ALWAYS AS IDENTITY) y hace setval(MAX(id) o 1 si está vacía).
-- No borra ni modifica ninguna fila — solo el contador interno.
-- ============================================================================

DO $$
DECLARE
  r RECORD;
  seq_name text;
  max_id bigint;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'id'
  LOOP
    seq_name := pg_get_serial_sequence('public.' || quote_ident(r.table_name), 'id');
    IF seq_name IS NOT NULL THEN
      EXECUTE format('SELECT COALESCE(MAX(id), 0) FROM public.%I', r.table_name) INTO max_id;
      IF max_id = 0 THEN
        PERFORM setval(seq_name, 1, false);  -- tabla vacía: el próximo id será 1
      ELSE
        PERFORM setval(seq_name, max_id, true); -- próximo id será max_id + 1
      END IF;
      RAISE NOTICE 'Tabla %: sequence % -> %', r.table_name, seq_name, max_id;
    END IF;
  END LOOP;
END $$;

-- Verificación: valor actual de cada sequence tras el reinicio (el próximo
-- INSERT usará last_value + 1, salvo las que quedaron en 1/false por estar vacías).
SELECT schemaname, sequencename, last_value
FROM pg_sequences
WHERE schemaname = 'public'
ORDER BY sequencename;
