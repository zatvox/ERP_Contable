-- ============================================================================
-- 88_fix_cxc_monto_cobrado_duplicado.sql  (2026-10-15)
-- Bug 13/10–15/10: el JS sumaba el cobro sobre cuentas_cobrar.monto_cobrado
-- DESPUÉS de que el trigger trg_actualizar_estado_cxc ya lo había sumado
-- (SUM(cobros)) → cobrado x2 y "Pendiente" en negativo. Ya corregido en cobranzas.js.
-- Este script recalcula monto_cobrado = SUM(cobros) y el estado SOLO en las
-- CxC con algún cobro creado desde el 13/10 cuyo monto_cobrado no cuadra.
-- No toca cobros, asientos, bancos ni cuotas (esos están bien). Idempotente.
-- ============================================================================

-- 1) VISTA PREVIA (ejecuta primero esto solo)
WITH s AS (
  SELECT cxc_id, SUM(monto) AS suma, MAX(created_at) AS ultimo
  FROM public.cobros GROUP BY cxc_id
)
SELECT c.id, c.serie || '-' || c.numero_comprobante AS doc, c.moneda, c.monto_total,
       c.monto_cobrado AS cobrado_actual, s.suma AS cobrado_real, c.estado
FROM public.cuentas_cobrar c JOIN s ON s.cxc_id = c.id
WHERE s.ultimo >= '2026-10-13'
  AND abs(c.monto_cobrado - s.suma) > 0.01
ORDER BY c.id;

-- 2) CORRECCIÓN
BEGIN;
WITH s AS (
  SELECT cxc_id, SUM(monto) AS suma, MAX(created_at) AS ultimo
  FROM public.cobros GROUP BY cxc_id
)
UPDATE public.cuentas_cobrar c
SET monto_cobrado = s.suma,
    estado = CASE
      WHEN s.suma + COALESCE(c.monto_retenido,0) + COALESCE(c.monto_canjeado,0) + COALESCE(c.monto_anticipo_aplicado,0)
           >= c.monto_total + COALESCE(c.monto_notas_debito,0) - COALESCE(c.monto_notas_credito,0) - 0.01 THEN 'cobrado'
      WHEN s.suma + COALESCE(c.monto_retenido,0) > 0.01 THEN 'parcial'
      ELSE 'pendiente' END,
    updated_at = now()
FROM s
WHERE s.cxc_id = c.id
  AND s.ultimo >= '2026-10-13'
  AND abs(c.monto_cobrado - s.suma) > 0.01
  AND c.estado <> 'anulado';
COMMIT;

-- Esperado (5 filas): FFFI-465 1600→800 cobrado · NV01-11 16059→10656 cobrado ·
-- FFFI-515 962.74→481.37 cobrado · NV01-23 2029→1014.50 PARCIAL · FFFI-519 1677→838.50 PARCIAL
