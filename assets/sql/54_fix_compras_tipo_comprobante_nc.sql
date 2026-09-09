-- ============================================================================
-- 54_FIX_COMPRAS_TIPO_COMPROBANTE_NC.SQL
-- ============================================================================
-- BUG ENCONTRADO en vivo (2026-09-03): compras.tipo_comprobante tiene un
-- CHECK que permite ('01','02','03','08','09','10','12','18','20','91','97','98')
-- — falta '07' (Nota de Crédito, Catálogo 01 SUNAT). Por eso NINGUNA Nota de
-- Crédito de compra se pudo guardar nunca: el INSERT fallaba con
-- "violates check constraint compras_tipo_comprobante_check" (código 23514).
-- El error se tragaba en silencio porque supabase-client.js:insert() solo
-- hace console.error y devuelve null — _abrirNotaCompra no revisaba ese
-- null, así que la UI mostraba "Nota registrada ✅" aunque no se guardó nada.
--
-- Esta migración:
--   1) Agrega '07' al CHECK de compras.tipo_comprobante.
--   2) Corrige supabase-data.js/compras.js (en el mismo commit) para que
--      addCompra() lance error real si el insert falla, en vez de seguir
--      como si hubiera funcionado.
--
-- Idempotente.
-- ============================================================================

BEGIN;

ALTER TABLE public.compras DROP CONSTRAINT IF EXISTS compras_tipo_comprobante_check;

ALTER TABLE public.compras ADD CONSTRAINT compras_tipo_comprobante_check
  CHECK (tipo_comprobante IN ('01','02','03','07','08','09','10','12','18','20','91','97','98'));

COMMENT ON COLUMN public.compras.tipo_comprobante IS
  'Catálogo 01 SUNAT + 07 (Nota de Crédito) y 08 (Nota de Débito) para notas registradas sobre una compra.';

COMMIT;

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'compras_tipo_comprobante_check';
