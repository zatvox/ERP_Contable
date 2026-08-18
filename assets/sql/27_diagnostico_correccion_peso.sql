-- ============================================================================
-- 27_diagnostico_correccion_peso.sql
-- Solo lectura. Junta todo lo necesario para cruzar contra el Excel
-- "correccionpeso.xlsx" (columna "Peso para envío") y armar la corrección:
-- ventas + kardex + detalle_ventas de los 5 lotes con cantidades erróneas
-- por la importación masiva (JWXY2601, JWBS2510-T20, JWBS2510-T30,
-- JWHY2510-T20, JWHY2510-T30).
-- ============================================================================

-- 1) Los 5 lotes en cuestión (id, cantidad actual, cantidad_unidades)
SELECT id, numero_lote, item_id, cantidad, cantidad_unidades, peso_por_unidad
FROM public.lotes
WHERE numero_lote IN ('JWXY2601', 'JWBS2510-T20', 'JWBS2510-T30', 'JWHY2510-T20', 'JWHY2510-T30')
ORDER BY id;

-- 2) Kardex de esos lotes: cada movimiento con su documento_referencia
--    (para cruzar contra "Facturas" del Excel) y su saldo después del
--    movimiento — necesario para recalcular la cascada de saldos.
SELECT k.id AS kardex_id, k.lote_id, l.numero_lote, k.tipo_movimiento, k.fecha,
       k.documento_referencia, k.venta_id,
       k.cantidad_entrada, k.cantidad_salida, k.saldo_cantidad,
       k.cantidad_unidades_entrada, k.cantidad_unidades_salida, k.saldo_unidades,
       k.costo_unitario, k.costo_total, k.saldo_valor
FROM public.kardex k
JOIN public.lotes l ON l.id = k.lote_id
WHERE l.numero_lote IN ('JWXY2601', 'JWBS2510-T20', 'JWBS2510-T30', 'JWHY2510-T20', 'JWHY2510-T30')
ORDER BY l.numero_lote, k.fecha, k.id;

-- 3) Detalle de venta de esos lotes, con datos de la venta (número,
--    estado CPE — CLAVE: si cpe_estado = 'aceptado' esa venta ya fue
--    enviada a SUNAT y NO se puede corregir solo con un UPDATE, hay que
--    hacer nota de crédito).
SELECT dv.id AS detalle_id, dv.venta_id, v.numero AS venta_numero, v.serie, v.correlativo,
       v.fecha_emision, v.cpe_estado, v.tipo_comprobante,
       dv.lote_id, l.numero_lote, dv.cantidad, dv.cantidad_unidades,
       dv.precio_unitario, dv.subtotal, dv.igv_monto, dv.total_linea
FROM public.detalle_ventas dv
JOIN public.lotes l ON l.id = dv.lote_id
JOIN public.ventas v ON v.id = dv.venta_id
WHERE l.numero_lote IN ('JWXY2601', 'JWBS2510-T20', 'JWBS2510-T30', 'JWHY2510-T20', 'JWHY2510-T30')
ORDER BY l.numero_lote, v.fecha_emision, dv.id;

-- 4) Stock actual por zona de esos lotes (para la corrección final de stock_ubicaciones)
SELECT su.id AS stock_ubicacion_id, su.lote_id, l.numero_lote, su.ubicacion_id, u.nombre AS zona,
       su.cantidad, su.cantidad_unidades
FROM public.stock_ubicaciones su
JOIN public.lotes l ON l.id = su.lote_id
LEFT JOIN public.ubicaciones u ON u.id = su.ubicacion_id
WHERE l.numero_lote IN ('JWXY2601', 'JWBS2510-T20', 'JWBS2510-T30', 'JWHY2510-T20', 'JWHY2510-T30')
ORDER BY l.numero_lote;
