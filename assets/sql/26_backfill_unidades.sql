-- ============================================================================
-- 26_backfill_unidades.sql
-- Rellena cantidad_unidades para lotes/stock_ubicaciones que ya existían
-- antes de 24_unidades_stock_kardex.sql (y por lo tanto quedaron en 0).
--
-- Criterio: unidades = cantidad_actual (kg) / peso_por_unidad. No se intenta
-- reconstruir el historial de ventas pasadas (nunca registraron unidades,
-- no hay cómo saber cuántas se vendieron exactamente) — se deriva del
-- stock actual, que sí es confiable. Solo afecta lotes donde ya existe
-- peso_por_unidad (los que capturaron N° de Unidades en su guía de
-- ingreso); los que nunca lo capturaron quedan en 0.
--
-- Es idempotente: correrlo de nuevo no rompe nada, solo recalcula.
-- ============================================================================

-- Antes: revisar cuántas filas se van a tocar y con qué pinta de números.
SELECT id, numero_lote, cantidad, peso_por_unidad,
       ROUND(cantidad / peso_por_unidad, 2) AS unidades_calculadas,
       cantidad_unidades AS unidades_actuales
FROM public.lotes
WHERE peso_por_unidad IS NOT NULL AND peso_por_unidad > 0
ORDER BY id;

-- 1) lotes.cantidad_unidades (stock total del lote, todas las zonas)
UPDATE public.lotes
SET cantidad_unidades = ROUND(cantidad / peso_por_unidad, 2)
WHERE peso_por_unidad IS NOT NULL AND peso_por_unidad > 0;

-- 2) stock_ubicaciones.cantidad_unidades (stock por zona)
UPDATE public.stock_ubicaciones su
SET cantidad_unidades = ROUND(su.cantidad / l.peso_por_unidad, 2)
FROM public.lotes l
WHERE su.lote_id = l.id
  AND l.peso_por_unidad IS NOT NULL AND l.peso_por_unidad > 0;

-- Verificación: suma de unidades por zona debería acercarse a
-- lotes.cantidad_unidades (puede haber pequeñas diferencias de redondeo).
SELECT l.id AS lote_id, l.numero_lote, l.cantidad_unidades AS unidades_lote,
       SUM(su.cantidad_unidades) AS unidades_suma_zonas
FROM public.lotes l
JOIN public.stock_ubicaciones su ON su.lote_id = l.id
WHERE l.peso_por_unidad IS NOT NULL AND l.peso_por_unidad > 0
GROUP BY l.id, l.numero_lote, l.cantidad_unidades
ORDER BY l.id;
