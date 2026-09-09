-- ============================================================================
-- 49_CONTACTS_AGENTE_RETENCION_SUNAT.SQL
-- ============================================================================
-- El checkbox "Sujeto a retención IGV" (contacts.sujeto_retencion) es un
-- booleano NOT NULL DEFAULT false, operativo y editable a mano — pero eso
-- lo vuelve ambiguo como indicador de lo que dijo SUNAT: un checkbox sin
-- marcar puede significar "SUNAT confirmó que NO es agente de retención" o
-- simplemente "nunca se consultó el RUC". El usuario no podía distinguir
-- ambos casos con un solo checkbox.
--
-- Este script agrega una columna aparte, igual en espíritu a
-- es_buen_contribuyente (script 48): guarda el valor EXACTO que devolvió la
-- última consulta a Decolecta (es_agente_retencion), sin mezclarse con el
-- estado operativo del checkbox. Se muestra como badge de solo lectura
-- "Sí" / "No" / "—" (nunca consultado) junto a Estado/Condición/Buen
-- Contribuyente en el bloque "Datos SUNAT" del modal de contacto.
--
-- Idempotente.
-- ============================================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS es_agente_retencion_sunat boolean;

COMMENT ON COLUMN public.contacts.es_agente_retencion_sunat IS
  'Dato informativo de SUNAT (vía Decolecta): true/false = lo que la última consulta RUC devolvió en es_agente_retencion. NULL = nunca se consultó o el contacto es DNI/VAT. No confundir con sujeto_retencion (ese es el flag operativo editable que usa el sistema para avisar la retención del 3% de IGV al cobrar/pagar).';

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'contacts' AND column_name = 'es_agente_retencion_sunat';
