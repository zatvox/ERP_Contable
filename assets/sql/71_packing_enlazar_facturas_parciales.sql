-- ============================================================================
-- 71 · Enlazar líneas de facturas de PK que quedaron sin detalle_packing_id
-- (2026-10-06). El backfill del sql/70 solo cubrió packing.venta_id (1 factura
-- por PK); un PK con VARIAS facturas (ej. PK-018655) quedaba con líneas sueltas
-- y su estado no pasaba a "Facturado". El ERP ya las reparte en vivo (parche
-- en packing.js); esto lo deja grabado en la BD. Opcional, idempotente.
-- ============================================================================
-- 1) DIAGNÓSTICO: líneas de facturas de PK sin enlace
SELECT p.numero AS pk, v.serie || '-' || v.correlativo AS factura, dv.id, dv.item_id, dv.cantidad
FROM public.detalle_ventas dv
JOIN public.ventas v  ON v.id = dv.venta_id
JOIN public.packing p ON p.id = v.packing_id
WHERE dv.detalle_packing_id IS NULL
ORDER BY p.numero, v.id;

-- 2) ENLACE: cada línea suelta va a la línea del PK con el mismo producto
--    (si el PK repite el producto, a la primera por orden).
BEGIN;
UPDATE public.detalle_ventas dv
   SET detalle_packing_id = (
         SELECT d.id FROM public.detalle_packing d
          WHERE d.packing_id = v.packing_id AND d.item_id = dv.item_id
          ORDER BY d.orden, d.id LIMIT 1)
  FROM public.ventas v
 WHERE v.id = dv.venta_id
   AND v.packing_id IS NOT NULL
   AND dv.detalle_packing_id IS NULL;
COMMIT;

-- 3) VERIFICACIÓN (debe devolver 0 filas con producto existente en el PK)
SELECT count(*) AS lineas_sin_enlace
FROM public.detalle_ventas dv JOIN public.ventas v ON v.id = dv.venta_id
WHERE v.packing_id IS NOT NULL AND dv.detalle_packing_id IS NULL;
