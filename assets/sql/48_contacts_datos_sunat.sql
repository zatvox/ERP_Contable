-- ============================================================================
-- 48_CONTACTS_DATOS_SUNAT.SQL
-- ============================================================================
-- La consulta de RUC vía Decolecta (assets/js/sunat-api.js) devuelve, además
-- de razón social/dirección, varios datos SUNAT útiles para saber con qué
-- tipo de contacto se está tratando:
--   estado                -> ya existe en contacts (script 01_schema.sql)
--   condicion              -> ya existe en contacts (script 01_schema.sql)
--   es_agente_retencion    -> ya existe como contacts.sujeto_retencion
--                             (script 44) — mismo dato, se reutiliza esa
--                             columna en vez de duplicarla.
--   es_buen_contribuyente  -> NO existe todavía. Este script la agrega.
--
-- Este dato permite advertir, por ejemplo, si un proveedor perdió la
-- condición de Buen Contribuyente (relevante para ciertos beneficios/
-- percepciones SUNAT), o mostrarlo simplemente como información de
-- referencia al dar de alta el contacto.
--
-- Idempotente.
-- ============================================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS es_buen_contribuyente boolean;

COMMENT ON COLUMN public.contacts.es_buen_contribuyente IS
  'Dato informativo de SUNAT (vía Decolecta): true/false si el contacto figura como Buen Contribuyente al momento de la consulta RUC. NULL = nunca se consultó o el contacto es DNI/VAT (no aplica).';

COMMENT ON COLUMN public.contacts.sujeto_retencion IS
  'true = el contacto es agente de retención IGV (Régimen de Retenciones SUNAT). Se puede marcar manualmente o autocompletar desde la consulta RUC (Decolecta: es_agente_retencion). No confundir con compras.sujeto_retencion (esa es por compra puntual, no por contacto).';

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'contacts' AND column_name IN ('estado','condicion','sujeto_retencion','es_buen_contribuyente');
