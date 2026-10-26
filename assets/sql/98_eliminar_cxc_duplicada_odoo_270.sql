-- ============================================================================
-- 98_eliminar_cxc_duplicada_odoo_270.sql  (2026-10-23)
-- CxC #28 "(01) Factura 000002-00000270" de BUSATEX: duplicado de la FFFI-270
-- (CxC #210) creado por la importación masiva de apertura desde Odoo
-- (asiento_odoo = 'FFFI-00000270'). Su "cobrado" 13,636.97 es un número
-- importado: NO tiene cobros, letras, adjuntos, asiento ni líneas contables.
-- La FFFI-270 real (#210) ya está canjeada en las letras 270-01…06.
--
-- Se elimina por BD (sin validaciones de UI) con respaldo y controles:
-- si encuentra cualquier dependencia, aborta sin borrar nada.
-- ============================================================================

-- 1) VISTA PREVIA: debe salir 1 fila con dependencias en 0
SELECT c.id, c.serie || '-' || c.numero_comprobante AS doc, c.asiento_odoo, c.monto_total, c.monto_cobrado, c.estado,
  (SELECT count(*) FROM public.cobros        WHERE cxc_id = c.id) AS cobros,
  (SELECT count(*) FROM public.letras_cambio WHERE cxc_id = c.id) AS letras,
  (SELECT count(*) FROM public.cuotas_cobrar WHERE cxc_id = c.id) AS cuotas
FROM public.cuentas_cobrar c WHERE c.id = 28;

-- 2) RESPALDO + BORRADO (bloque único)
BEGIN;
CREATE TABLE IF NOT EXISTS public.zz_respaldo_98_cxc    AS SELECT * FROM public.cuentas_cobrar WHERE false;
CREATE TABLE IF NOT EXISTS public.zz_respaldo_98_cuotas AS SELECT * FROM public.cuotas_cobrar  WHERE false;
INSERT INTO public.zz_respaldo_98_cxc    SELECT * FROM public.cuentas_cobrar WHERE id = 28;
INSERT INTO public.zz_respaldo_98_cuotas SELECT * FROM public.cuotas_cobrar  WHERE cxc_id = 28;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.cuentas_cobrar WHERE id = 28 AND asiento_odoo = 'FFFI-00000270' AND contact_id = 135) THEN
    RAISE EXCEPTION 'La CxC 28 no es la esperada (Busatex / FFFI-00000270): no se borra nada';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cobros WHERE cxc_id = 28) OR EXISTS (SELECT 1 FROM public.letras_cambio WHERE cxc_id = 28) THEN
    RAISE EXCEPTION 'La CxC 28 tiene cobros o letras: no se borra nada';
  END IF;
  DELETE FROM public.cuotas_cobrar  WHERE cxc_id = 28;
  DELETE FROM public.cuentas_cobrar WHERE id = 28;
END $$;
COMMIT;

-- 3) VERIFICACIÓN: debe dar 0
SELECT count(*) AS queda FROM public.cuentas_cobrar WHERE id = 28;

-- ROLLBACK (solo si hiciera falta):
-- INSERT INTO public.cuentas_cobrar OVERRIDING SYSTEM VALUE SELECT * FROM public.zz_respaldo_98_cxc;
-- INSERT INTO public.cuotas_cobrar  OVERRIDING SYSTEM VALUE SELECT * FROM public.zz_respaldo_98_cuotas;
