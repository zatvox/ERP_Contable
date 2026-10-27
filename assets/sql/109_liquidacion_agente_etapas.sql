-- ============================================================================
-- 109_liquidacion_agente_etapas.sql  (2026-10-27)
-- SOLO ESTRUCTURA. La carpeta puede tener primero la PROFORMA del agente (y su
-- abono) y recién después la liquidación final: n° y fecha de liquidación pasan
-- a ser opcionales. Requiere 107 y 108. Idempotente.
-- ============================================================================
BEGIN;
ALTER TABLE public.importacion_liquidaciones_agente ALTER COLUMN numero DROP NOT NULL;
ALTER TABLE public.importacion_liquidaciones_agente ALTER COLUMN fecha  DROP NOT NULL;
COMMIT;
