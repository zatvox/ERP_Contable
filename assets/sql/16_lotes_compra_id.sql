-- ============================================================================
-- 16_lotes_compra_id.sql
-- Agrega trazabilidad compra -> lote para poder saber, al eliminar una
-- compra, exactamente qué lotes generó y si ya tuvieron ventas (FIFO) antes
-- de borrarlos. Sin esta columna no había forma de vincular un lote con la
-- compra que lo originó.
-- ============================================================================

ALTER TABLE public.lotes
  ADD COLUMN IF NOT EXISTS compra_id bigint REFERENCES public.compras(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_lotes_compra_id ON public.lotes(compra_id);

COMMENT ON COLUMN public.lotes.compra_id IS
  'Compra (mercadería) que originó este lote. Null para lotes creados manualmente o antes de esta migración.';
