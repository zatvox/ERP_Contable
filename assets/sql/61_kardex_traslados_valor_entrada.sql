-- ============================================================================
-- 61 · Kardex: traslados internos con valor simétrico (2026-10-01)
-- ----------------------------------------------------------------------------
-- Antes: traslado_interno guardaba valor_entrada = 0 y valor_salida = cant×costo
-- → "Valor salidas" del Kardex resumido se inflaba como si fuera costo de venta.
-- Ahora (criterio SUNAT, Tabla 12 op. 11 "transferencia entre almacenes"):
-- lo que sale de la zona origen entra a la destino al MISMO costo
-- → valor_entrada = valor_salida, neto de valor 0.
-- No toca cantidades, saldo_cantidad ni saldo_valor (esos no dependen de
-- valor_entrada). El trigger de lotes (57) solo mira cantidades.
-- Correr los bloques EN ORDEN. Rollback al final.
-- ============================================================================

-- 1) DIAGNÓSTICO (solo lectura) — cuántas filas se corregirán y por cuánto
SELECT COUNT(*)                         AS filas_a_corregir,
       ROUND(SUM(valor_salida)::numeric, 2) AS valor_que_pasa_a_entrada
FROM kardex
WHERE tipo_movimiento = 'traslado_interno'
  AND COALESCE(valor_entrada, 0) <> COALESCE(valor_salida, 0);

-- Filas con valor_salida = 0 pero costo conocido (por si alguna quedó sin valorizar)
SELECT id, fecha, item_id, lote_id, cantidad_salida, costo_unitario, valor_entrada, valor_salida
FROM kardex
WHERE tipo_movimiento = 'traslado_interno'
  AND COALESCE(valor_salida, 0) = 0
  AND COALESCE(costo_unitario, 0) > 0;

-- 2) BACKUP
CREATE TABLE IF NOT EXISTS _bk_kardex_traslados_valor_20261001 AS
SELECT id, valor_entrada, valor_salida
FROM kardex
WHERE tipo_movimiento = 'traslado_interno';

-- 3) CORRECCIÓN
BEGIN;
  -- 3a) si quedó alguna sin valor de salida, valorizarla con su costo_unitario
  UPDATE kardex
     SET valor_salida = ROUND((COALESCE(cantidad_salida, 0) * costo_unitario)::numeric, 2)
   WHERE tipo_movimiento = 'traslado_interno'
     AND COALESCE(valor_salida, 0) = 0
     AND COALESCE(costo_unitario, 0) > 0;

  -- 3b) simetría: entrada = salida
  UPDATE kardex
     SET valor_entrada = valor_salida
   WHERE tipo_movimiento = 'traslado_interno'
     AND COALESCE(valor_entrada, 0) <> COALESCE(valor_salida, 0);
COMMIT;

-- 4) VERIFICACIÓN — debe devolver 0
SELECT COUNT(*) AS traslados_asimetricos
FROM kardex
WHERE tipo_movimiento = 'traslado_interno'
  AND COALESCE(valor_entrada, 0) <> COALESCE(valor_salida, 0);

-- ============================================================================
-- ROLLBACK (solo si hiciera falta)
-- UPDATE kardex k
--    SET valor_entrada = b.valor_entrada, valor_salida = b.valor_salida
--   FROM _bk_kardex_traslados_valor_20261001 b
--  WHERE k.id = b.id;
-- ============================================================================
