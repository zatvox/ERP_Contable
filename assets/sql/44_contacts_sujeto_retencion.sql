-- ============================================================================
-- 44_CONTACTS_SUJETO_RETENCION.SQL
-- ============================================================================
-- El modal "Nuevo Cliente" (ventas.js) intentaba guardar contacts.sujeto_
-- retencion desde siempre, pero esa columna nunca existió en contacts — es
-- una confusión con compras.sujeto_retencion (que es si ESA COMPRA puntual
-- está sujeta a retención, no si el CLIENTE es agente de retención IGV).
-- Resultado: cada alta/edición de cliente con el checkbox marcado fallaba
-- en silencio con PGRST204 ("Could not find the 'sujeto_retencion' column"),
-- aunque el toast mostrara éxito (el insert/update fallaba, pero el catch
-- no distinguía ese error del resto).
--
-- "Cliente sujeto a retención IGV" SÍ es un dato real y activo: ventas.js
-- (_actualizarAvisoRetencionVenta) ya lo usa para avisar en la venta que al
-- cobrar se retendrá el 3% de IGV (Régimen de Retenciones SUNAT). Solo le
-- faltaba la columna. Este script la agrega.
--
-- Idempotente.
-- ============================================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS sujeto_retencion boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.contacts.sujeto_retencion IS
  'true = el CLIENTE es agente de retención IGV (Régimen de Retenciones SUNAT): al cobrarle se retiene el 3% de IGV. No confundir con compras.sujeto_retencion (esa es por compra puntual, no por contacto).';

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
-- SELECT column_name, data_type, column_default FROM information_schema.columns
--   WHERE table_name = 'contacts' AND column_name = 'sujeto_retencion';
