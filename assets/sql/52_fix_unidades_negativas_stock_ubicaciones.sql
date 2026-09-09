-- ============================================================================
-- ✅ APLICADO EN PRODUCCIÓN (30/08/2026)
-- PUNTO 3: cantidad_unidades negativa en stock_ubicaciones para lotes con
-- traslados/ventas antiguos (ej. JWXY2601 Zona A mostraba -406).
--
-- Causa real (distinta a la de 50_stock_ubicaciones_vista_kardex.sql):
--   No es un problema de traslado_interno (esos ya quedaron simétricos con el
--   fix anterior). Es que la fila de Kardex ENTRADA (compra) de estos lotes
--   nunca tuvo cantidad_unidades_entrada cargado (quedó en 0) — probablemente
--   porque en compras antiguas no se capturaba el conteo de bultos/rollos por
--   línea, solo el peso. Las ventas de esos mismos lotes SÍ registran
--   cantidad_unidades_salida real. Resultado: la vista resta unidades que
--   nunca "entraron" según Kardex → negativo. El KG (cantidad) no se ve
--   afectado, solo la columna de unidades.
--   Ejemplo JWXY2601: kardex entrada unidades=0, pero 75 filas de
--   salida/traslado con unidades reales sumando cientos.
--
-- No se puede reconstruir con certeza cuántas unidades entraron realmente
-- (el dato simplemente no se capturó en su momento) — inventar un número
-- violaría la regla de no fabricar datos. Fix aplicado: la vista ya no
-- puede devolver cantidad_unidades negativa (se pisa a 0 con GREATEST), en
-- vez de mostrar un número confuso/incorrecto. El kg sigue siendo exacto.
-- ============================================================================

CREATE OR REPLACE VIEW public.stock_ubicaciones AS
WITH mov AS (
  SELECT lote_id,
         ubicacion_destino_id AS ubicacion_id,
         cantidad_entrada     AS cant,
         cantidad_unidades_entrada AS uni
  FROM public.kardex
  WHERE ubicacion_destino_id IS NOT NULL

  UNION ALL

  SELECT lote_id,
         ubicacion_origen_id  AS ubicacion_id,
         -cantidad_salida     AS cant,
         -cantidad_unidades_salida AS uni
  FROM public.kardex
  WHERE ubicacion_origen_id IS NOT NULL
),
calc AS (
  SELECT
    mov.lote_id,
    mov.ubicacion_id,
    SUM(mov.cant) AS cantidad,
    SUM(mov.uni)  AS cantidad_unidades
  FROM mov
  JOIN public.ubicaciones u ON u.id = mov.ubicacion_id
  JOIN public.almacenes   a ON a.id = u.almacen_id
  WHERE a.es_virtual = false
  GROUP BY mov.lote_id, mov.ubicacion_id
  HAVING ROUND(SUM(mov.cant)::numeric, 4) > 0
)
SELECT
  row_number() OVER (ORDER BY lote_id, ubicacion_id)::bigint AS id,
  lote_id,
  ubicacion_id,
  ROUND(cantidad::numeric, 4)                          AS cantidad,
  GREATEST(ROUND(cantidad_unidades::numeric, 4), 0)    AS cantidad_unidades, -- nunca negativo
  now() AS created_at,
  now() AS updated_at
FROM calc;

-- Verificación: ya no debería haber ninguna fila negativa.
SELECT * FROM public.stock_ubicaciones WHERE cantidad_unidades < 0;
