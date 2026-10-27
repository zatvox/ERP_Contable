-- ============================================================================
-- 111_costos_lote_carpeta.sql  (2026-10-27)
-- SOLO ESTRUCTURA. El costo final de la carpeta llega al lote:
--   lotes.costo_real      = costo CONTABLE (NIC 2) por kg en USD (solo lectura en UI)
--   lotes.costo_comercial = costo comercial (gestión) por kg en USD
--   lotes.costo_unitario  = costo contable en S/ (ya existía; lo usa el kardex)
-- + bitácora lote_costo_historial (valores anteriores para poder revertir). Idempotente.
-- ============================================================================
BEGIN;

ALTER TABLE public.lotes
  ADD COLUMN IF NOT EXISTS costo_comercial           numeric,
  ADD COLUMN IF NOT EXISTS costo_carpeta_id          bigint REFERENCES public.carpetas_importacion(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS costo_carpeta_aplicado_at timestamptz;
COMMENT ON COLUMN public.lotes.costo_real IS 'Costo CONTABLE final (NIC 2) por kg en USD. Lo escribe SOLO la acción «Aplicar costo final al lote» de Importaciones.';
COMMENT ON COLUMN public.lotes.costo_comercial IS 'Costo COMERCIAL (gestión) final por kg en USD, desde la hoja de costeo de la carpeta.';

CREATE TABLE IF NOT EXISTS public.lote_costo_historial (
  id                      bigserial PRIMARY KEY,
  lote_id                 bigint NOT NULL REFERENCES public.lotes(id) ON DELETE CASCADE,
  carpeta_importacion_id  bigint REFERENCES public.carpetas_importacion(id) ON DELETE SET NULL,
  aplicado_at             timestamptz DEFAULT now(),
  aplicado_por            bigint REFERENCES public.users(id),
  anterior                jsonb,
  nuevo                   jsonb,
  cambios                 jsonb      -- [{t:'kardex',id:1,prev:{...}}] para revertir
);
CREATE INDEX IF NOT EXISTS idx_lch_lote ON public.lote_costo_historial(lote_id);
ALTER TABLE public.lote_costo_historial ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON public.lote_costo_historial;
CREATE POLICY "authenticated_all" ON public.lote_costo_historial FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lote_costo_historial TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.lote_costo_historial_id_seq TO authenticated;

COMMIT;
