-- ============================================================================
-- 78_adjuntos_concepto_dietario.sql  (2026-10-07)
-- Nuevo concepto de adjunto: 'dietario' (Dietario de cobranzas del banco),
-- usado al cobrar/renovar letras en banco. Idempotente.
-- ============================================================================
BEGIN;
ALTER TABLE public.adjuntos DROP CONSTRAINT IF EXISTS adjuntos_concepto_check;
ALTER TABLE public.adjuntos ADD CONSTRAINT adjuntos_concepto_check
  CHECK (concepto IN ('voucher', 'recibo', 'dietario', 'otro'));
COMMIT;
