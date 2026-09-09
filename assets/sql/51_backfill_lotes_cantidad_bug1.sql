-- ============================================================================
-- ✅ APLICADO EN PRODUCCIÓN (30/08/2026)
-- BUG 1: lotes.cantidad no llegaba a 0 en lotes 100% vendidos.
--
-- Diagnóstico:
--   - Se descartó una condición de carrera / caché en el código en vivo:
--     getById/getLoteById (supabase-client.js, supabase-data.js) hacen SIEMPRE
--     una consulta fresca a Supabase (sin caché), y los 3 loops que descuentan
--     lotes.cantidad (guardarGuiaDespachoVenta, guardarEdicionGuiaDespachoVenta
--     y la importación masiva de guías, todos en ventas.js) son secuenciales
--     con await correcto — no hay ventana de carrera posible ahí.
--   - La prueba real: los kardex.created_at de los lotes afectados son todos
--     de agosto 2026 (hace días/semanas), mientras que kardex.fecha (fecha de
--     venta real) es de enero/febrero 2026. Es decir, esas filas de Kardex y
--     detalle_guias_despacho_venta se insertaron por un BACKFILL/migración
--     histórica (no por el flujo en vivo de despacho), y esa migración grabó
--     bien Kardex + detalle_guias_despacho_venta pero nunca llamó a
--     updateLote() para estos 10 lotes.
--
-- Alcance (recalculado con Kardex como fuente de verdad, igual criterio que
-- 50_stock_ubicaciones_vista_kardex.sql):
--   - HR-Q083072T0 (id 6): cantidad 23,112 → 0 (kardex: 100% vendido)
--   - 9 lotes LT-25375-13..LT-25375-2x (ids 78-87): cantidad 414.4 → 0 cada uno
--     (nunca se habían descontado, quedaron en su cantidad de compra original)
--   - cantidad_unidades de HR-Q083072T0 quedó en -680 tras el cálculo (kardex
--     de unidades incompleto en las filas de entrada históricas de ese lote,
--     mismo tipo de gap que el Punto 3 pendiente) — se corrigió a 0 a mano
--     por separado (no tiene sentido negativo en un lote 100% vendido).
--
-- Excluidos a propósito de este backfill (no son "bug 1", son otro problema,
-- pendiente de decisión con Luis):
--   - Lote 70168E/1Z775 (id 280): 1 sola fila de kardex, salida de 89.3 sin
--     ninguna entrada registrada. lotes.cantidad YA está en 0 (correcto — la
--     venta sí descontó bien) — el problema es que a este lote le falta la
--     fila de ENTRADA en Kardex (compra sin kardex), no que cantidad esté mal.
--   - Lote C11843 (id 195): cantidad=2,520 pero CERO filas en Kardex (ni
--     entrada ni salida). lotes.cantidad probablemente sigue correcto (nunca
--     se vendió), pero el Kardex de este lote está vacío — falta la entrada
--     de compra. No se tocó nada de este lote.
-- ============================================================================

-- Backfill (ya ejecutado): lotes.cantidad/cantidad_unidades = Kardex neto
-- (SUM entrada tipo='entrada' - SUM salida tipo='salida'), solo para lotes
-- con diferencia > 0.01 y excluyendo los 2 casos de arriba.
WITH kd AS (
  SELECT
    lote_id,
    SUM(CASE WHEN tipo_movimiento = 'entrada' THEN cantidad_entrada ELSE 0 END) ent,
    SUM(CASE WHEN tipo_movimiento = 'salida'  THEN cantidad_salida  ELSE 0 END) sal,
    SUM(CASE WHEN tipo_movimiento = 'entrada' THEN cantidad_unidades_entrada ELSE 0 END) ent_u,
    SUM(CASE WHEN tipo_movimiento = 'salida'  THEN cantidad_unidades_salida  ELSE 0 END) sal_u
  FROM kardex
  GROUP BY lote_id
)
UPDATE lotes l
SET cantidad          = ROUND((kd.ent - kd.sal)::numeric, 4),
    cantidad_unidades = GREATEST(ROUND((kd.ent_u - kd.sal_u)::numeric, 4), 0)
FROM kd
WHERE kd.lote_id = l.id
  AND l.id NOT IN (280, 195)
  AND ABS(l.cantidad - (kd.ent - kd.sal)) > 0.01
RETURNING l.id, l.numero_lote, l.cantidad, l.cantidad_unidades;

-- Verificación: no debería quedar ninguna fila fuera de los 2 casos excluidos.
SELECT l.id, l.numero_lote, l.cantidad,
       COALESCE(kd.ent, 0) - COALESCE(kd.sal, 0) AS cantidad_kardex
FROM lotes l
LEFT JOIN (
  SELECT lote_id,
         SUM(CASE WHEN tipo_movimiento = 'entrada' THEN cantidad_entrada ELSE 0 END) ent,
         SUM(CASE WHEN tipo_movimiento = 'salida'  THEN cantidad_salida  ELSE 0 END) sal
  FROM kardex GROUP BY lote_id
) kd ON kd.lote_id = l.id
WHERE ABS(l.cantidad - (COALESCE(kd.ent,0) - COALESCE(kd.sal,0))) > 0.01
ORDER BY l.id;
