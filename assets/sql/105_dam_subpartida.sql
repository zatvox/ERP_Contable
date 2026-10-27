-- 105_dam_subpartida.sql (2026-10-26) — ADITIVO e idempotente.
-- Subpartida nacional de la DAM (Hoja A 7.19): sirve para calcular la percepción de IGV
-- (monto fijo SUNAT por kg en mercancías sensibles al fraude, DS 104-2026-EF).
BEGIN;
ALTER TABLE public.dams ADD COLUMN IF NOT EXISTS subpartida varchar;
COMMENT ON COLUMN public.dams.subpartida IS 'Subpartida nacional (10 dígitos) declarada en la DAM.';
COMMIT;
-- VERIFICACIÓN (debe salir 1)
SELECT COUNT(*) AS col_subpartida FROM information_schema.columns WHERE table_schema='public' AND table_name='dams' AND column_name='subpartida';
