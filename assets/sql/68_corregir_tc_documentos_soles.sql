-- ============================================================================
-- 68_corregir_tc_documentos_soles.sql  (2026-10-05)
-- PASO 2 de 2 — ejecutar DESPUÉS de 67_historial_tc_sunat.sql.
--
-- Las ventas y compras en SOLES se guardaron con tipo_cambio = 1. Desde hoy
-- el T.C. en soles es solo REFERENCIA (T.C. VENTA SUNAT de la fecha de
-- emisión): no convierte montos — el ERP solo convierte cuando la moneda
-- es USD (código blindado el 2026-10-05 en compras/guías/OC/edición).
-- Si la fecha no tiene T.C. publicado, se toma el del día inmediato
-- anterior disponible (regla SUNAT), buscando como máximo 7 días atrás: así
-- un mes que aún no se cargó en el SQL 67 queda en 1 (sale en el CONTROL)
-- en vez de tomar por error el T.C. del mes anterior.
--
-- No toca: documentos en USD, lotes, kardex, CxC/CxP ni asientos.
-- ============================================================================

-- 0) VISTA PREVIA (ejecutar sola primero): qué se va a cambiar
SELECT 'venta' AS doc, v.id, v.numero, v.fecha_emision, v.tipo_cambio AS tc_antes,
       (SELECT t.venta FROM public.tipos_cambio t WHERE t.fecha <= v.fecha_emision AND t.fecha > v.fecha_emision - 7 ORDER BY t.fecha DESC LIMIT 1) AS tc_nuevo
FROM public.ventas v
WHERE COALESCE(v.moneda, 'PEN') = 'PEN' AND COALESCE(v.tipo_cambio, 1) = 1
UNION ALL
SELECT 'compra', c.id, c.numero, c.fecha_emision, c.tipo_cambio,
       (SELECT t.venta FROM public.tipos_cambio t WHERE t.fecha <= c.fecha_emision AND t.fecha > c.fecha_emision - 7 ORDER BY t.fecha DESC LIMIT 1)
FROM public.compras c
WHERE COALESCE(c.currency, 'PEN') = 'PEN' AND COALESCE(c.tipo_cambio, 1) = 1
ORDER BY 1, 4;

-- 1) CORRECCIÓN
BEGIN;

UPDATE public.ventas v
SET tipo_cambio = sub.tc
FROM (
  SELECT v2.id,
         (SELECT t.venta FROM public.tipos_cambio t WHERE t.fecha <= v2.fecha_emision AND t.fecha > v2.fecha_emision - 7 ORDER BY t.fecha DESC LIMIT 1) AS tc
  FROM public.ventas v2
  WHERE COALESCE(v2.moneda, 'PEN') = 'PEN' AND COALESCE(v2.tipo_cambio, 1) = 1
) sub
WHERE v.id = sub.id AND sub.tc IS NOT NULL;

UPDATE public.compras c
SET tipo_cambio = sub.tc
FROM (
  SELECT c2.id,
         (SELECT t.venta FROM public.tipos_cambio t WHERE t.fecha <= c2.fecha_emision AND t.fecha > c2.fecha_emision - 7 ORDER BY t.fecha DESC LIMIT 1) AS tc
  FROM public.compras c2
  WHERE COALESCE(c2.currency, 'PEN') = 'PEN' AND COALESCE(c2.tipo_cambio, 1) = 1
) sub
WHERE c.id = sub.id AND sub.tc IS NOT NULL;

COMMIT;

-- 2) CONTROL: documentos en soles que siguen en 1 (fecha anterior al
--    historial cargado → falta subir ese mes en el SQL 67)
SELECT 'venta' AS doc, id, numero, fecha_emision FROM public.ventas
WHERE COALESCE(moneda, 'PEN') = 'PEN' AND COALESCE(tipo_cambio, 1) = 1
UNION ALL
SELECT 'compra', id, numero, fecha_emision FROM public.compras
WHERE COALESCE(currency, 'PEN') = 'PEN' AND COALESCE(tipo_cambio, 1) = 1
ORDER BY 4;
