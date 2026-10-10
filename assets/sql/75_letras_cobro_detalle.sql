-- ============================================================================
-- 75_letras_cobro_detalle.sql  (2026-10-07)
-- Detalle del cobro/pago de una letra según el "Dietario de cobranzas" del
-- banco: intereses (mora) cobrados, gastos (portes, comisión, otros), neto
-- abonado, N° de recibo físico opcional, fecha de cobro. Y renovación
-- parcial: monto amortizado (la letra original queda 'refinanciada' y la
-- nueva apunta a ella por letra_origen_id, columna ya existente).
-- Idempotente.
-- ============================================================================
BEGIN;
ALTER TABLE public.letras_cambio
  ADD COLUMN IF NOT EXISTS fecha_cobro       date,
  ADD COLUMN IF NOT EXISTS interes_cobrado   numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gasto_portes      numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gasto_comision    numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gasto_otros       numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS monto_neto        numeric,
  ADD COLUMN IF NOT EXISTS monto_amortizado  numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS numero_recibo     varchar;

COMMENT ON COLUMN public.letras_cambio.interes_cobrado  IS 'Intereses/mora cobrados (emitida) o pagados (recibida) al cancelar o renovar la letra.';
COMMENT ON COLUMN public.letras_cambio.monto_neto       IS 'Neto que entró/salió del banco: letra (o amortización) + intereses − gastos (emitida).';
COMMENT ON COLUMN public.letras_cambio.monto_amortizado IS 'Renovación parcial: parte de la letra pagada; el resto pasa a una nueva letra (letra_origen_id).';
COMMIT;
