-- ============================================================================
-- 72 · Tesorería: tipo de cuenta "caja" (efectivo) — 2026-10-06
-- Permite registrar cajas (efectivo PEN/USD) en la misma tabla bancos, sin
-- banco/N° de cuenta/CCI (el ERP guarda banco='CAJA', numero_cuenta='EFECTIVO').
-- ============================================================================
ALTER TABLE public.bancos DROP CONSTRAINT IF EXISTS bancos_tipo_cuenta_check;
ALTER TABLE public.bancos ADD CONSTRAINT bancos_tipo_cuenta_check
  CHECK (tipo_cuenta IN ('caja', 'corriente', 'ahorro', 'detracciones', 'cuentas_recaudacion'));

-- Verificación
SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'bancos_tipo_cuenta_check';
