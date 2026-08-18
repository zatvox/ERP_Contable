-- ============================================================================
-- 30_correccion_retroactiva_costo_pen.sql
-- Corrección retroactiva de costo_unitario/costo_total/saldo_valor/
-- costo_promedio en KARDEX y COSTO_UNITARIO en LOTES, para lotes comprados
-- en USD cuyo costo nunca se convirtió a soles (bug corregido en compras.js
-- el 2026-08-01; este script corrige lo histórico).
--
-- Por qué es seguro escalar linealmente: el sistema usa costeo por
-- identificación específica (LIR Art. 62°) — cada lote tiene UN SOLO
-- costo_unitario que NUNCA cambia después de creado, y TODOS sus movimientos
-- de kardex (entrada por compra, salidas por venta/traslado) usan ese mismo
-- costo_unitario. Por lo tanto, si el costo real es costo_actual x
-- tipo_cambio, TODA fila de kardex de ese lote_id escala exactamente por el
-- mismo tipo_cambio — no hay riesgo de mezclar capas de costo distintas ni
-- de afectar otros lotes.
-- ============================================================================

-- 1) DIAGNÓSTICO (solo lectura) — antes/después, para revisar montos.
SELECT k.id AS kardex_id, l.numero_lote, k.tipo_movimiento, k.fecha,
       k.costo_unitario AS costo_unit_antes, ROUND(k.costo_unitario * l.tipo_cambio, 4) AS costo_unit_despues,
       k.costo_total AS costo_total_antes, ROUND(k.costo_total * l.tipo_cambio, 2) AS costo_total_despues,
       k.saldo_valor AS saldo_valor_antes, ROUND(k.saldo_valor * l.tipo_cambio, 2) AS saldo_valor_despues,
       k.moneda AS moneda_antes, l.moneda AS moneda_lote, l.tipo_cambio
FROM public.kardex k
JOIN public.lotes l ON l.id = k.lote_id
WHERE l.moneda = 'USD' AND k.moneda = 'PEN'   -- solo filas aún no corregidas (entradas ya quedaron bien)
ORDER BY l.numero_lote, k.fecha;

-- ============================================================================
-- 2) CORRECCIÓN — kardex: escala por el tipo_cambio DEL LOTE (no de la
-- venta). Idempotente: la condición k.moneda = 'PEN' hace que una segunda
-- corrida no vuelva a escalar filas ya corregidas.
-- ============================================================================
UPDATE public.kardex k
SET costo_unitario       = ROUND(k.costo_unitario * l.tipo_cambio, 4),
    costo_total          = ROUND(k.costo_total * l.tipo_cambio, 2),
    saldo_valor          = ROUND(k.saldo_valor * l.tipo_cambio, 2),
    costo_promedio       = ROUND(k.costo_promedio * l.tipo_cambio, 4),
    moneda               = l.moneda,
    tipo_cambio          = l.tipo_cambio,
    costo_unit_original  = k.costo_unitario,
    costo_unit_pen       = ROUND(k.costo_unitario * l.tipo_cambio, 4)
FROM public.lotes l
WHERE k.lote_id = l.id
  AND l.moneda = 'USD'
  AND k.moneda = 'PEN';

-- ============================================================================
-- 2b) CORRECCIÓN — filas de ENTRADA (compra) que ya tenían moneda='USD'
-- desde el backfill del script 29 (por eso el paso 2 las saltó), pero cuya
-- columna costo_unitario en sí nunca se tocó y seguía con el valor viejo sin
-- convertir. costo_unit_pen para estas filas YA está correcto (se calculó
-- bien en el backfill), así que solo replicamos ese valor a las columnas
-- "vivas". Filtro por costo_unitario <> costo_unit_pen en vez de moneda:
-- así se detecta cualquier fila (de cualquier tipo) que aún no esté al día,
-- sea cual sea la razón, y es idempotente (una fila ya corregida tiene
-- costo_unitario = costo_unit_pen y no vuelve a tocarse).
-- ============================================================================
UPDATE public.kardex
SET costo_unitario = costo_unit_pen,
    costo_total    = ROUND((cantidad_entrada + cantidad_salida) * costo_unit_pen, 2),
    saldo_valor    = ROUND(saldo_cantidad * costo_unit_pen, 2),
    costo_promedio = costo_unit_pen
WHERE moneda = 'USD' AND costo_unitario <> costo_unit_pen;

-- ============================================================================
-- 3) CORRECCIÓN — lotes: costo_unitario pasa a ser el valor ya convertido
-- (costo_unit_pen), que es lo que se venía usando desde el backfill del
-- script 29 para calcular costo_unit_pen. Idempotente.
-- ============================================================================
UPDATE public.lotes
SET costo_unitario = costo_unit_pen
WHERE moneda = 'USD' AND costo_unitario <> costo_unit_pen;

-- ============================================================================
-- 4) VERIFICACIÓN — Kardex Valorizado del lote 5 (tu ejemplo) debería
-- mostrar ahora costo_unitario = 4.6630 en TODAS las filas, saldo_valor
-- escalado y saldo_cantidad/saldo_unidades intactos (no deben cambiar).
-- ============================================================================
SELECT k.id, k.tipo_movimiento, k.fecha, k.cantidad_entrada, k.cantidad_salida,
       k.costo_unitario, k.costo_total, k.saldo_cantidad, k.saldo_valor, k.moneda, k.tipo_cambio
FROM public.kardex k
WHERE k.lote_id = 5
ORDER BY k.fecha;
