-- ============================================================================
-- 122_gasto_factura_regularizar.sql  (2026-10-30)
-- Facturas de gastos locales de importación registradas como COMPRA de servicio/gasto
-- y marca «pendiente de regularizar» para conciliar después en CxP con los abonos
-- hechos al agente (liquidación). Aditivo e idempotente.
--   documentos_importacion.regularizacion         : NULL | 'pendiente' | 'conciliado'
--   importacion_liquidacion_abonos.regularizacion : NULL | 'pendiente' | 'conciliado'
-- (documentos_importacion.compra_id / cxp_id ya existen desde el SQL 86)
-- ============================================================================
BEGIN;

ALTER TABLE public.documentos_importacion ADD COLUMN IF NOT EXISTS regularizacion varchar;
ALTER TABLE public.importacion_liquidacion_abonos ADD COLUMN IF NOT EXISTS regularizacion varchar;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_docimp_regularizacion') THEN
    ALTER TABLE public.documentos_importacion ADD CONSTRAINT ck_docimp_regularizacion
      CHECK (regularizacion IS NULL OR regularizacion IN ('pendiente','conciliado'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_liqabono_regularizacion') THEN
    ALTER TABLE public.importacion_liquidacion_abonos ADD CONSTRAINT ck_liqabono_regularizacion
      CHECK (regularizacion IS NULL OR regularizacion IN ('pendiente','conciliado'));
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';

SELECT table_name, column_name FROM information_schema.columns
 WHERE column_name = 'regularizacion' AND table_name IN ('documentos_importacion','importacion_liquidacion_abonos');
