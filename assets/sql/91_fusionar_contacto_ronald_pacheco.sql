-- ============================================================================
-- 91 — Fusionar contacto duplicado (2026-10-20)
--   Duplicado : 1179  RONALD PACHECO            (DNI 00000001, creado 15/10)
--   Original  : 1173  PACHECO REGALADO RONEL ANTONIO (RUC 10425050597)
-- Cambia contact_id 1179 → 1173 en TODA tabla de public que tenga la columna
-- contact_id (ventas, packing, cuentas_cobrar, cobros, cobros_lote, letras…),
-- con respaldo previo, y desactiva el contacto duplicado.
-- Ejecutar en 2 pasos: PASO 1 (vista previa) y luego PASO 2.
-- ============================================================================

-- PASO 1 · VISTA PREVIA: cuántas filas cambiarían por tabla (no modifica nada)
DO $$
DECLARE t record; n bigint;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'contact_id'
             AND table_name NOT LIKE '\_bk%' AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE')
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE contact_id = 1179', t.table_name) INTO n;
    IF n > 0 THEN RAISE NOTICE '%: % fila(s)', t.table_name, n; END IF;
  END LOOP;
END $$;

-- PASO 2 · APLICAR (respaldo + cambio + desactivar duplicado)
DO $$
DECLARE t record; n bigint;
BEGIN
  CREATE TABLE IF NOT EXISTS public._bk91_fusion_contacto (tabla text, fila_id bigint, contact_id_ant bigint, fecha timestamptz DEFAULT now());
  FOR t IN SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'contact_id'
             AND table_name NOT LIKE '\_bk%' AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE')
  LOOP
    EXECUTE format('INSERT INTO public._bk91_fusion_contacto (tabla, fila_id, contact_id_ant) SELECT %L, id, contact_id FROM public.%I WHERE contact_id = 1179', t.table_name, t.table_name);
    EXECUTE format('UPDATE public.%I SET contact_id = 1173 WHERE contact_id = 1179', t.table_name);
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE NOTICE '%: % fila(s) actualizadas', t.table_name, n; END IF;
  END LOOP;
  -- Desactivar el duplicado (no se borra)
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contacts' AND column_name='activo') THEN
    UPDATE public.contacts SET activo = false WHERE id = 1179;
  END IF;
END $$;

-- Verificación: debe dar 0 filas con 1179 y ver las ventas en 1173
SELECT serie || '-' || correlativo AS comprobante, contact_id FROM public.ventas
 WHERE contact_id IN (1179, 1173) ORDER BY 1;

-- REVERTIR (solo si hiciera falta):
-- DO $$ DECLARE r record; BEGIN
--   FOR r IN SELECT DISTINCT tabla FROM public._bk91_fusion_contacto LOOP
--     EXECUTE format('UPDATE public.%I x SET contact_id = b.contact_id_ant FROM public._bk91_fusion_contacto b WHERE b.tabla = %L AND x.id = b.fila_id', r.tabla, r.tabla);
--   END LOOP;
--   UPDATE public.contacts SET activo = true WHERE id = 1179;
-- END $$;
