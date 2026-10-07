-- ============================================================================
-- 73 — lote_bultos: nuevo estado 'custodiado' (2026-10-06)
-- Bulto VENDIDO cuya guía de despacho tuvo como destino una zona REAL
-- (ej. SJL2/Zona B): la mercadería sigue físicamente en el almacén.
-- Decisión Luis: se trata como DISPONIBLE (se puede volver a despachar) y
-- suma en v_stock_bultos_zona. ubicacion_id del bulto = zona destino.
-- ============================================================================

ALTER TABLE public.lote_bultos DROP CONSTRAINT IF EXISTS lote_bultos_estado_check;
ALTER TABLE public.lote_bultos ADD CONSTRAINT lote_bultos_estado_check
  CHECK (estado IN ('disponible','custodiado','vendido','devuelto_cliente','devuelto_proveedor','merma'));

CREATE OR REPLACE VIEW public.v_stock_bultos_zona AS
SELECT lote_id, ubicacion_id, COUNT(*) AS cantidad_unidades, SUM(peso) AS cantidad
FROM public.lote_bultos
WHERE estado IN ('disponible','custodiado')
GROUP BY lote_id, ubicacion_id;

COMMENT ON VIEW public.v_stock_bultos_zona IS
  'Stock por lote y zona para productos con bultos (estado disponible o custodiado). Custodiado = vendido pero guardado en una zona real; se puede volver a despachar.';

-- Verificación
SELECT estado, COUNT(*) FROM public.lote_bultos GROUP BY estado ORDER BY 1;
