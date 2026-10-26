-- ============================================================================
-- 101_dams_fecha_pago_tributos.sql  (2026-10-23)
-- Los tributos de importación (ad valorem, IGV, IPM, percepción) se pagan en
-- soles al T.C. VENTA SUNAT vigente a la FECHA DE PAGO (no a la de numeración
-- de la DAM). La tabla dams solo tenía fecha_dam; se agrega fecha_pago para
-- poder traer ese T.C. y guardarlo en dams.tipo_cambio.
-- Aditivo e idempotente. No toca datos.
-- ============================================================================
BEGIN;

ALTER TABLE public.dams ADD COLUMN IF NOT EXISTS fecha_pago date;
COMMENT ON COLUMN public.dams.fecha_pago IS
  'Fecha de pago de los tributos de la DAM. Su T.C. venta SUNAT queda en dams.tipo_cambio.';

COMMIT;

-- Verificación (visible en el panel)
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'dams' AND column_name IN ('fecha_dam', 'fecha_pago', 'tipo_cambio');
