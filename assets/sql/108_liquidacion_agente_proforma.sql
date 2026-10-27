-- ============================================================================
-- 108_liquidacion_agente_proforma.sql  (2026-10-26)
-- SOLO ESTRUCTURA. La proforma del agente aduanero (ej. DESA 2026-091 del 27/08)
-- es una PRE-liquidación: estima gastos locales (USD) y derechos (S/). Se guarda
-- en la misma cabecera que la liquidación final para poder AUDITAR diferencias
-- (proforma vs real). No es un documento contable: no entra al costeo.
-- Requiere el SQL 107. Aditivo. Idempotente.
-- ============================================================================
BEGIN;

ALTER TABLE public.importacion_liquidaciones_agente
  ADD COLUMN IF NOT EXISTS proforma_numero  varchar,
  ADD COLUMN IF NOT EXISTS proforma_fecha   date,
  ADD COLUMN IF NOT EXISTS proforma_tc      numeric,
  -- {"gl":[{"concepto":"THC DESTINO","usd":185,"codigo":"thc"}], "tr":[{"concepto":"AD-VALOREM (6%)","pen":6886.86,"codigo":"ad_valorem"}]}
  ADD COLUMN IF NOT EXISTS proforma_items   jsonb;

COMMENT ON COLUMN public.importacion_liquidaciones_agente.proforma_items IS
  'Pre-liquidación (proforma) del agente: gl = gastos locales en USD, tr = derechos estimados en S/. "codigo" = concepto del ledger con el que se compara en la auditoría.';

COMMIT;
