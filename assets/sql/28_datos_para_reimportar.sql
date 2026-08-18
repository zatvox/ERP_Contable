-- ============================================================================
-- 28_datos_para_reimportar.sql
-- Solo lectura. Junta todo lo necesario para reconstruir el Excel de
-- reimportación (mismo formato de plantilla_importar_ventas.xlsx) para las
-- ventas mal importadas de los 5 lotes con peso incorrecto.
-- ============================================================================

SELECT
  v.id            AS venta_id,
  v.numero        AS numero_documento,
  v.tipo_comprobante,
  v.fecha_emision,
  v.moneda,
  v.tipo_cambio,
  c.nro_documento AS cliente_ruc,
  c.nombre        AS cliente_nombre,
  i.sku,
  l.numero_lote,
  u.codigo        AS zona_origen_codigo,
  u.nombre        AS zona_origen_nombre,
  dv.cantidad     AS cantidad_registrada_erronea,
  dv.precio_unitario,
  dv.igv_porcentaje
FROM public.detalle_ventas dv
JOIN public.ventas v   ON v.id = dv.venta_id
JOIN public.lotes l    ON l.id = dv.lote_id
JOIN public.items i    ON i.id = dv.item_id
LEFT JOIN public.contacts c ON c.id = v.contact_id
LEFT JOIN public.ubicaciones u ON u.id = dv.ubicacion_id
WHERE l.numero_lote IN ('JWXY2601', 'JWBS2510-T20', 'JWBS2510-T30', 'JWHY2510-T20', 'JWHY2510-T30')
ORDER BY l.numero_lote, v.fecha_emision, v.id;
