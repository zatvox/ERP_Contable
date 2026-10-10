-- ============================================================================
-- 81 — lotes.costo_real (2026-10-09)
-- Costo REAL por unidad (kg) en la MONEDA ORIGINAL del lote (misma que
-- costo_unit_original): costo CIF / factura + costos de destino (flete local,
-- aduana, almacenaje, etc.). Hoy se ingresa a mano en Inventario → Lotes;
-- más adelante lo alimentará el módulo de Importaciones (prorrateo).
-- No modifica kardex ni costo_unitario: es informativo para margen real.
-- ============================================================================
ALTER TABLE public.lotes ADD COLUMN IF NOT EXISTS costo_real numeric CHECK (costo_real IS NULL OR costo_real > 0);
ALTER TABLE public.lotes ADD COLUMN IF NOT EXISTS costo_real_actualizado_at timestamptz;
COMMENT ON COLUMN public.lotes.costo_real IS 'Costo real por unidad en moneda original del lote = CIF + costos de destino. Manual hoy; luego desde Importaciones.';

SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'lotes' AND column_name LIKE 'costo_real%';
