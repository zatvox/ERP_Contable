-- 121_dam_transporte_hoja_a.sql (2026-10-30)
-- Campos de transporte de la DAM según Hoja A: 3.1 Empresa de transporte,
-- 3.2 N° manifiesto, 7.8 Doc. de transporte (N° B/L). Aditivo e idempotente.
BEGIN;
ALTER TABLE public.dams ADD COLUMN IF NOT EXISTS empresa_transporte varchar;
ALTER TABLE public.dams ADD COLUMN IF NOT EXISTS nro_manifiesto     varchar;
ALTER TABLE public.dams ADD COLUMN IF NOT EXISTS doc_transporte     varchar;
COMMIT;
NOTIFY pgrst, 'reload schema';

SELECT column_name FROM information_schema.columns
 WHERE table_name = 'dams' AND column_name IN ('empresa_transporte','nro_manifiesto','doc_transporte');
