-- ============================================================================
-- 113_abonos_agente_comision.sql  (2026-10-27)
-- SOLO ESTRUCTURA. Cada abono al agente puede traer su comisión bancaria
-- (transferencia interbancaria). Se guarda en el abono y la línea de costo
-- `comision_bancaria` (gasto financiero) se crea en el ledger, igual que los
-- pagos al proveedor. Aditivo. Idempotente.
-- ============================================================================
BEGIN;
ALTER TABLE public.importacion_liquidacion_abonos
  ADD COLUMN IF NOT EXISTS comision numeric NOT NULL DEFAULT 0 CHECK (comision >= 0);
COMMENT ON COLUMN public.importacion_liquidacion_abonos.comision IS 'Comisión bancaria cobrada a Jhiro por este abono, en la moneda del abono. Pasa al ledger como gasto financiero.';
COMMIT;
