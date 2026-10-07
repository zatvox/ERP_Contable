-- ============================================================================
-- 74_numero_recibo_cobros.sql  (2026-10-07)
-- N° del recibo de cobranza FÍSICO (talonario de oficina) de cada cobro.
-- Por ahora se escribe a mano en la tabla "Cobros Registrados" (editable en
-- la celda). Más adelante se definirá la generación de recibos virtuales.
-- Texto libre (ej. 001-000123); no es UNIQUE en BD: el ERP avisa si se repite.
-- ============================================================================
ALTER TABLE public.cobros ADD COLUMN IF NOT EXISTS numero_recibo varchar;
CREATE INDEX IF NOT EXISTS idx_cobros_numero_recibo ON public.cobros(numero_recibo);
COMMENT ON COLUMN public.cobros.numero_recibo IS 'N° del recibo de cobranza físico (talonario). Editable en Cobros Registrados.';
