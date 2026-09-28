-- ============================================================================
-- 57b_backfill_unidades_kardex.sql · 2026-09-25
-- Completa unidades faltantes (kg > 0 pero unidades = 0) en kardex y en
-- detalle_guias_ingreso_compra. Generaliza el fix del kardex id 56 (MB31516).
--
-- Regla (la misma del backfill del 05/09): unidades = kg / lotes.peso_por_unidad
--   · SOLO lotes con es_peso_variable = false y peso_por_unidad > 0
--   · SOLO si la división da (casi) entero (±0.01) → si no, se deja para revisión
-- Peso variable NO se toca: su fuente real es lote_bultos.
--
-- Uso: 1) corre solo el bloque PREVIEW y revisa.  2) corre el bloque APLICAR.
-- ============================================================================

-- ── PREVIEW (solo lectura) ─────────────────────────────────────────────────
SELECT k.id AS kardex_id, l.numero_lote, k.tipo_movimiento, k.fecha, k.documento_referencia,
       k.cantidad_entrada, k.cantidad_salida, l.peso_por_unidad,
       ROUND((k.cantidad_entrada + k.cantidad_salida) / l.peso_por_unidad, 2) AS ud_calculadas,
       CASE WHEN ABS((k.cantidad_entrada + k.cantidad_salida) / l.peso_por_unidad
                   - ROUND((k.cantidad_entrada + k.cantidad_salida) / l.peso_por_unidad)) <= 0.01
            THEN 'SE CORRIGE' ELSE 'REVISAR A MANO (no da entero)' END AS accion
FROM kardex k JOIN lotes l ON l.id = k.lote_id
WHERE NOT l.es_peso_variable AND COALESCE(l.peso_por_unidad,0) > 0
  AND ((k.cantidad_entrada > 0 AND k.cantidad_unidades_entrada = 0)
    OR (k.cantidad_salida  > 0 AND k.cantidad_unidades_salida  = 0))
ORDER BY accion, l.numero_lote, k.fecha, k.id;

-- ── APLICAR ────────────────────────────────────────────────────────────────
BEGIN;

-- Los 48 lotes que salieron en 57a (kardex_sin_unidades / ud negativas).
-- Lista fija: solo se tocan esos lotes y solo se recalculan sus saldos
-- (así el log de trg_erp_audit no se llena con filas de otros lotes).
-- v2: antes usaba una TEMP TABLE que el SQL Editor de Supabase no conserva.
UPDATE kardex k
   SET cantidad_unidades_entrada = CASE WHEN k.cantidad_entrada > 0 AND k.cantidad_unidades_entrada = 0
                                        THEN ROUND(k.cantidad_entrada / l.peso_por_unidad) ELSE k.cantidad_unidades_entrada END,
       cantidad_unidades_salida  = CASE WHEN k.cantidad_salida > 0 AND k.cantidad_unidades_salida = 0
                                        THEN ROUND(k.cantidad_salida / l.peso_por_unidad) ELSE k.cantidad_unidades_salida END
  FROM lotes l
 WHERE l.id = k.lote_id
   AND k.lote_id IN (6,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,33,34,35,36,37,39,40,41,42,43,44,45,46,47,48,49,50,51,52,54,55,56,57,58,59,60,61,62,63)
   AND NOT l.es_peso_variable AND COALESCE(l.peso_por_unidad,0) > 0
   AND ((k.cantidad_entrada > 0 AND k.cantidad_unidades_entrada = 0
         AND ABS(k.cantidad_entrada / l.peso_por_unidad - ROUND(k.cantidad_entrada / l.peso_por_unidad)) <= 0.01)
     OR (k.cantidad_salida > 0 AND k.cantidad_unidades_salida = 0
         AND ABS(k.cantidad_salida / l.peso_por_unidad - ROUND(k.cantidad_salida / l.peso_por_unidad)) <= 0.01));

UPDATE detalle_guias_ingreso_compra d
   SET cantidad_unidades = ROUND(d.cantidad / l.peso_por_unidad)
  FROM lotes l
 WHERE l.id = d.lote_id
   AND NOT l.es_peso_variable AND COALESCE(l.peso_por_unidad,0) > 0
   AND COALESCE(d.cantidad_unidades,0) = 0 AND d.cantidad > 0
   AND ABS(d.cantidad / l.peso_por_unidad - ROUND(d.cantidad / l.peso_por_unidad)) <= 0.01;

-- Recalcular saldo_unidades / saldo_cantidad en orden cronológico
-- (traslado_interno se excluye: su saldo es el de la zona origen, por diseño).
WITH s AS (
  SELECT id,
         SUM(cantidad_entrada - cantidad_salida) OVER w AS saldo_kg,
         SUM(cantidad_unidades_entrada - cantidad_unidades_salida) OVER w AS saldo_ud
  FROM kardex WHERE lote_id IN (6,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,33,34,35,36,37,39,40,41,42,43,44,45,46,47,48,49,50,51,52,54,55,56,57,58,59,60,61,62,63)
  WINDOW w AS (PARTITION BY lote_id ORDER BY fecha, id)
)
UPDATE kardex k
   SET saldo_cantidad = s.saldo_kg, saldo_unidades = s.saldo_ud,
       saldo_valor = ROUND(s.saldo_kg * k.costo_unitario, 2)
  FROM s
 WHERE k.id = s.id AND k.tipo_movimiento <> 'traslado_interno'
   AND (k.saldo_cantidad IS DISTINCT FROM s.saldo_kg OR k.saldo_unidades IS DISTINCT FROM s.saldo_ud);

COMMIT;
