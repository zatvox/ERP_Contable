-- ============================================================================
-- 31_simplificar_columnas_kardex.sql
-- 1) Termina de corregir saldo_valor/costo_unitario de filas de ENTRADA que
--    quedaron sin tocar (mismo caso que la fila de compra del lote 5: ya
--    tenían moneda='USD' desde el backfill del script 29, así que el UPDATE
--    del script 30 (filtraba por moneda='PEN') las saltó).
-- 2) Reestructura kardex: costo_total (ambiguo: no dice si es de la entrada
--    o la salida) se reemplaza por valor_entrada/valor_salida, replicando
--    el mismo patrón que ya existe para cantidad_entrada/cantidad_salida.
-- 3) Elimina columnas redundantes: costo_promedio (en este sistema SIEMPRE
--    es igual a costo_unitario — costeo por identificación específica, no
--    hay promedio real) y costo_unit_pen (idéntica a costo_unitario desde
--    que costo_unitario pasó a ser siempre el valor en soles).
-- ============================================================================

-- ── Paso 1: terminar la corrección de moneda (igual que 30, paso 2b) ────────
UPDATE public.kardex
SET costo_unitario = costo_unit_pen,
    costo_total    = ROUND((cantidad_entrada + cantidad_salida) * costo_unit_pen, 2),
    saldo_valor    = ROUND(saldo_cantidad * costo_unit_pen, 2),
    costo_promedio = costo_unit_pen
WHERE moneda = 'USD' AND costo_unitario <> costo_unit_pen;

UPDATE public.lotes
SET costo_unitario = costo_unit_pen
WHERE moneda = 'USD' AND costo_unitario <> costo_unit_pen;

-- ── Paso 2: columnas nuevas de valor, backfill desde costo_total ───────────
ALTER TABLE public.kardex
  ADD COLUMN IF NOT EXISTS valor_entrada numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS valor_salida  numeric NOT NULL DEFAULT 0;

UPDATE public.kardex
SET valor_entrada = CASE WHEN cantidad_entrada > 0 THEN costo_total ELSE 0 END,
    valor_salida  = CASE WHEN cantidad_salida  > 0 THEN costo_total ELSE 0 END;

COMMENT ON COLUMN public.kardex.valor_entrada IS 'Valor en soles de la entrada de este movimiento (0 si es una salida). Reemplaza a costo_total.';
COMMENT ON COLUMN public.kardex.valor_salida IS 'Valor en soles de la salida de este movimiento (0 si es una entrada). Reemplaza a costo_total.';

-- ── Paso 3: soltar columnas redundantes ─────────────────────────────────────
ALTER TABLE public.kardex
  DROP COLUMN IF EXISTS costo_total,
  DROP COLUMN IF EXISTS costo_promedio,
  DROP COLUMN IF EXISTS costo_unit_pen;

ALTER TABLE public.lotes
  DROP COLUMN IF EXISTS costo_unit_pen;

-- ── Verificación: lote 5 completo, debe verse limpio y consistente ─────────
SELECT id, tipo_movimiento, fecha, cantidad_entrada, cantidad_salida,
       costo_unitario, valor_entrada, valor_salida, saldo_cantidad, saldo_valor,
       moneda, tipo_cambio, costo_unit_original
FROM public.kardex
WHERE lote_id = 5
ORDER BY fecha;
