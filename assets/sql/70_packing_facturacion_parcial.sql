-- ============================================================================
-- 70 · Packing: facturación PARCIAL por cantidad (2026-10-06)
-- ----------------------------------------------------------------------------
-- Decisiones de Luis:
--   · Un PK se puede facturar en varias facturas, por CANTIDAD por línea.
--   · Facturado/pendiente NO se guardan: se calculan de detalle_ventas
--     (facturas vigentes) → anular una factura devuelve su cantidad a pendiente.
--   · Si se factura más de lo pedido (peso real), el PK se actualiza con la
--     cantidad real. Ítems que el cliente ya no lleva se retiran editando el PK.
-- Cambios:
--   1) detalle_ventas.detalle_packing_id → enlace línea factura ↔ línea PK
--   2) packing.estado acepta 'parcial'
--   3) Backfill: enlaza las facturas YA emitidas desde un PK (por producto y orden)
-- ============================================================================
BEGIN;

ALTER TABLE public.detalle_ventas
  ADD COLUMN IF NOT EXISTS detalle_packing_id bigint REFERENCES public.detalle_packing(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_detalle_ventas_detalle_packing ON public.detalle_ventas(detalle_packing_id);
COMMENT ON COLUMN public.detalle_ventas.detalle_packing_id IS
  'Línea del PK que factura esta línea. Facturado de una línea PK = Σ cantidad de facturas vigentes que la referencian (sql/70).';

ALTER TABLE public.packing DROP CONSTRAINT IF EXISTS packing_estado_check;
ALTER TABLE public.packing ADD CONSTRAINT packing_estado_check
  CHECK (estado IN ('borrador', 'enviado', 'parcial', 'facturado', 'anulado'));

-- Backfill: PK facturados antes de este script (1 PK → 1 venta). Se emparejan
-- las líneas por producto y por orden de aparición dentro de cada producto.
WITH dp AS (
  SELECT d.id, p.venta_id, d.item_id,
         row_number() OVER (PARTITION BY d.packing_id, d.item_id ORDER BY d.orden, d.id) AS rn
  FROM public.detalle_packing d
  JOIN public.packing p ON p.id = d.packing_id
  WHERE p.venta_id IS NOT NULL
), dv AS (
  SELECT v.id, v.venta_id, v.item_id,
         row_number() OVER (PARTITION BY v.venta_id, v.item_id ORDER BY v.id) AS rn
  FROM public.detalle_ventas v
  WHERE v.detalle_packing_id IS NULL
    AND v.venta_id IN (SELECT venta_id FROM public.packing WHERE venta_id IS NOT NULL)
)
UPDATE public.detalle_ventas t
   SET detalle_packing_id = dp.id
  FROM dv JOIN dp ON dp.venta_id = dv.venta_id AND dp.item_id = dv.item_id AND dp.rn = dv.rn
 WHERE t.id = dv.id;

COMMIT;

-- Verificación: líneas de factura enlazadas a su PK
SELECT p.numero, count(dv.id) AS lineas_enlazadas
FROM public.packing p
JOIN public.detalle_packing d ON d.packing_id = p.id
LEFT JOIN public.detalle_ventas dv ON dv.detalle_packing_id = d.id
WHERE p.venta_id IS NOT NULL
GROUP BY p.numero ORDER BY p.numero;

-- ROLLBACK:
-- ALTER TABLE public.detalle_ventas DROP COLUMN IF EXISTS detalle_packing_id;
-- ALTER TABLE public.packing DROP CONSTRAINT packing_estado_check;
-- ALTER TABLE public.packing ADD CONSTRAINT packing_estado_check CHECK (estado IN ('borrador','enviado','facturado','anulado'));
