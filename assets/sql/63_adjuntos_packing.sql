-- ============================================================================
-- 63 · Adjuntos para Packing (foto del formato anulado) — 2026-10-02
-- ----------------------------------------------------------------------------
-- Reusa la tabla genérica public.adjuntos + bucket privado 'tesoreria-adjuntos'
-- (script 60). Solo amplía el CHECK de entidad para aceptar 'packing'.
-- No toca cobros/pagos/letras.
-- ============================================================================
BEGIN;
ALTER TABLE public.adjuntos DROP CONSTRAINT IF EXISTS adjuntos_entidad_check;
ALTER TABLE public.adjuntos
  ADD CONSTRAINT adjuntos_entidad_check CHECK (entidad IN ('cobro', 'pago', 'letra', 'packing'));
COMMIT;

-- Verificación
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'public.adjuntos'::regclass AND contype = 'c';
