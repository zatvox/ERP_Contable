-- ============================================================================
-- 24_unidades_stock_kardex.sql
-- Rastrea cantidad_unidades (bultos/conos/cajas) a través de todo el ciclo,
-- no solo al nacer el lote:
--   1) lotes.es_peso_variable: indica si peso_por_unidad es un cálculo exacto
--      (false, default) o aproximado (true) — algunos artículos no tienen
--      peso exacto por unidad.
--   2) stock_ubicaciones.cantidad_unidades: stock en unidades por zona,
--      espejo de la columna cantidad (kg) que ya existía.
--   3) kardex.cantidad_unidades_entrada / cantidad_unidades_salida /
--      saldo_unidades: mismo patrón que cantidad_entrada/cantidad_salida/
--      saldo_cantidad que ya existen, para no tocar el reporte Kardex
--      Valorizado actual.
-- ============================================================================

-- 1) lotes.es_peso_variable
ALTER TABLE public.lotes
  ADD COLUMN IF NOT EXISTS es_peso_variable boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.lotes.es_peso_variable IS
  'true = peso_por_unidad es aproximado (el artículo no tiene peso exacto por unidad); false = cálculo exacto (cantidad / cantidad_unidades).';

-- 2) stock_ubicaciones.cantidad_unidades
ALTER TABLE public.stock_ubicaciones
  ADD COLUMN IF NOT EXISTS cantidad_unidades numeric NOT NULL DEFAULT 0 CHECK (cantidad_unidades >= 0);

COMMENT ON COLUMN public.stock_ubicaciones.cantidad_unidades IS
  'Stock en unidades (bultos/conos/cajas) de este lote en esta zona. Espejo de cantidad (kg).';

-- 3) kardex: columnas de unidades, mismo patrón que cantidad_entrada/salida
ALTER TABLE public.kardex
  ADD COLUMN IF NOT EXISTS cantidad_unidades_entrada numeric NOT NULL DEFAULT 0 CHECK (cantidad_unidades_entrada >= 0);
ALTER TABLE public.kardex
  ADD COLUMN IF NOT EXISTS cantidad_unidades_salida numeric NOT NULL DEFAULT 0 CHECK (cantidad_unidades_salida >= 0);
ALTER TABLE public.kardex
  ADD COLUMN IF NOT EXISTS saldo_unidades numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.kardex.cantidad_unidades_entrada IS 'Unidades que entran en este movimiento (espejo de cantidad_entrada).';
COMMENT ON COLUMN public.kardex.cantidad_unidades_salida  IS 'Unidades que salen en este movimiento (espejo de cantidad_salida).';
COMMENT ON COLUMN public.kardex.saldo_unidades             IS 'Saldo en unidades del lote después del movimiento (espejo de saldo_cantidad).';

-- 4) Backfill: para lotes/stock_ubicaciones ya existentes, no hay forma de
--    saber cuántas unidades reales quedan hoy en cada zona (nunca se
--    trackeó por ubicación) — se deja en 0 y quedará correcto desde el
--    primer movimiento nuevo que toque cada fila. Si se quiere una foto
--    inicial aproximada, se puede prorratear cantidad_unidades del lote
--    entre sus zonas según el peso (cantidad) de cada una:
--
-- UPDATE public.stock_ubicaciones su
-- SET cantidad_unidades = ROUND(
--       l.cantidad_unidades * su.cantidad / NULLIF(l.cantidad, 0)
--     , 2)
-- FROM public.lotes l
-- WHERE su.lote_id = l.id
--   AND su.cantidad_unidades = 0
--   AND l.cantidad_unidades > 0;
--
-- Descomentar y ejecutar manualmente solo si se quiere ese prorrateo inicial.

-- Verificación
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'lotes' AND column_name = 'es_peso_variable')
    OR (table_name = 'stock_ubicaciones' AND column_name = 'cantidad_unidades')
    OR (table_name = 'kardex' AND column_name IN ('cantidad_unidades_entrada','cantidad_unidades_salida','saldo_unidades'))
  );
