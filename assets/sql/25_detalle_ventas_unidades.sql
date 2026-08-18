-- ============================================================================
-- 25_detalle_ventas_unidades.sql
-- Complemento de 24_unidades_stock_kardex.sql: detalle_ventas también
-- necesita cantidad_unidades para que "Nueva Venta" (selector de lote
-- explícito) guarde cuántas unidades (bultos/conos/cajas) salieron en cada
-- línea, no solo el peso (cantidad).
-- ============================================================================

ALTER TABLE public.detalle_ventas
  ADD COLUMN IF NOT EXISTS cantidad_unidades numeric NOT NULL DEFAULT 0 CHECK (cantidad_unidades >= 0);

COMMENT ON COLUMN public.detalle_ventas.cantidad_unidades IS
  'Unidades (bultos/conos/cajas) vendidas en esta línea. Espejo de cantidad (kg).';

-- Verificación
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'detalle_ventas' AND column_name = 'cantidad_unidades';
