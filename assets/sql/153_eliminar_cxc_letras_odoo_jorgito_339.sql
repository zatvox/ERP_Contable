-- ============================================================================
-- 153_eliminar_cxc_letras_odoo_jorgito_339.sql  (2026-11-10)
-- CxC #30 "LT.339-04" y #29 "LT.339-05" de CORPORACION TEXTIL JORGITO S.A.C.
-- (contact 152, empresa 1): se crearon con la importación masiva de apertura
-- desde Odoo (asiento_odoo 'LETRA/2026/05/0007|0008 (FFFI-339)').
-- Revisado en BD (2026-11-10): no tienen venta, cobros, letras ni asiento;
-- cobrado 0, y cada una tiene 1 cuota (2 en total).
-- La FFFI-339 real (CxC #236, venta 316, 5 cuotas) NO se toca.
--
-- Se borra con respaldo. Si algo no es lo esperado, se aborta sin borrar.
-- Corre los pasos 1, 2 y 3 en orden.
-- ============================================================================

-- 1) VISTA PREVIA: deben salir 2 filas, con cobros=0, letras=0 y cuotas=1
SELECT c.id, c.serie, c.numero_comprobante, c.asiento_odoo, c.contact_id, c.monto_total, c.monto_cobrado, c.estado,
  (SELECT count(*) FROM public.cobros        WHERE cxc_id = c.id) AS cobros,
  (SELECT count(*) FROM public.letras_cambio WHERE cxc_id = c.id) AS letras,
  (SELECT count(*) FROM public.cuotas_cobrar WHERE cxc_id = c.id) AS cuotas
FROM public.cuentas_cobrar c WHERE c.id IN (29, 30) ORDER BY c.id;

-- 2) RESPALDO + BORRADO (corre el bloque completo)
BEGIN;
CREATE TABLE IF NOT EXISTS public.zz_respaldo_153_cxc    AS SELECT * FROM public.cuentas_cobrar WHERE false;
CREATE TABLE IF NOT EXISTS public.zz_respaldo_153_cuotas AS SELECT * FROM public.cuotas_cobrar  WHERE false;
INSERT INTO public.zz_respaldo_153_cxc    SELECT * FROM public.cuentas_cobrar WHERE id IN (29, 30);
INSERT INTO public.zz_respaldo_153_cuotas SELECT * FROM public.cuotas_cobrar  WHERE cxc_id IN (29, 30);

DO $$
BEGIN
  IF (SELECT count(*) FROM public.cuentas_cobrar
      WHERE id IN (29, 30) AND contact_id = 152 AND venta_id IS NULL
        AND asiento_odoo LIKE 'LETRA/2026/05/%(FFFI-339)') <> 2 THEN
    RAISE EXCEPTION 'Las CxC 29/30 no son las esperadas (Jorgito / letras Odoo FFFI-339): no se borra nada';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cobros WHERE cxc_id IN (29, 30))
     OR EXISTS (SELECT 1 FROM public.letras_cambio WHERE cxc_id IN (29, 30)) THEN
    RAISE EXCEPTION 'Las CxC 29/30 tienen cobros o letras: no se borra nada';
  END IF;
  DELETE FROM public.cuotas_cobrar  WHERE cxc_id IN (29, 30);
  DELETE FROM public.cuentas_cobrar WHERE id IN (29, 30);
END $$;
COMMIT;

-- 3) VERIFICACIÓN: las dos columnas deben dar 0, y la FFFI-339 (#236) debe seguir ahí
SELECT (SELECT count(*) FROM public.cuentas_cobrar WHERE id IN (29, 30))     AS cxc_quedan,
       (SELECT count(*) FROM public.cuotas_cobrar  WHERE cxc_id IN (29, 30)) AS cuotas_quedan,
       (SELECT count(*) FROM public.cuentas_cobrar WHERE id = 236)           AS fffi_339_sigue;

-- ROLLBACK (solo si hiciera falta):
-- INSERT INTO public.cuentas_cobrar OVERRIDING SYSTEM VALUE SELECT * FROM public.zz_respaldo_153_cxc;
-- INSERT INTO public.cuotas_cobrar  OVERRIDING SYSTEM VALUE SELECT * FROM public.zz_respaldo_153_cuotas;
