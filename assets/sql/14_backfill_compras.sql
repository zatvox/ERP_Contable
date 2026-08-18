-- ============================================================
-- 14_backfill_compras.sql
-- Puebla la tabla `compras` desde los asientos contables
-- tipo_movimiento='Compra' que aún no tienen registro en ella.
-- A partir de ahora el tab Compras lee de esta tabla (como
-- ventas lee de `ventas`), no del diario contable completo.
-- Ejecutar en Supabase SQL Editor. Idempotente.
-- NOTA: montos desglosados de forma aproximada (subtotal = total/1.18
-- para facturas '01'); cantidad y precio_unitario con valores por
-- defecto porque el asiento no guarda ese detalle.
-- ============================================================

INSERT INTO public.compras (
  referencia, tipo_referencia, tipo_comprobante, serie, numero,
  periodo_mes, periodo_ano, fecha_emision, fecha_recepcion,
  contact_id, proveedor_ruc, proveedor_nombre,
  tipo_compra, descripcion, unidad_medida, cantidad, precio_unitario,
  base_imponible_gravada, igv_gravado, subtotal, total,
  currency, tipo_cambio, estado_pago, asiento_id, created_by
)
SELECT
  je.numero_asiento,                                          -- referencia (única garantizada)
  'backfill_asiento',
  CASE WHEN je.tipo_documento IN ('01','02','03','08','09','10','12','18','20','91','97','98')
       THEN je.tipo_documento ELSE '01' END,
  je.serie_comprobante,
  COALESCE(NULLIF(je.documento_referencia,''), je.numero_asiento),
  split_part(je.periodo_contable, '-', 2)::int,
  split_part(je.periodo_contable, '-', 1)::int,
  je.fecha,
  je.fecha,
  je.contact_id,
  COALESCE(c.nro_documento, '-'),
  COALESCE(c.nombre, 'Sin proveedor'),
  'mercaderia',
  je.descripcion,
  'KG',
  1,                                                          -- cantidad (no disponible en asiento)
  0,                                                          -- precio_unitario (no disponible)
  CASE WHEN COALESCE(je.tipo_documento,'01') = '01'
       THEN round(je.total_debe / 1.18, 2) ELSE je.total_debe END,
  CASE WHEN COALESCE(je.tipo_documento,'01') = '01'
       THEN je.total_debe - round(je.total_debe / 1.18, 2) ELSE 0 END,
  CASE WHEN COALESCE(je.tipo_documento,'01') = '01'
       THEN round(je.total_debe / 1.18, 2) ELSE je.total_debe END,
  je.total_debe,
  COALESCE(je.moneda, 'PEN'),
  COALESCE(je.tipo_cambio, 1),
  'pendiente',
  je.id,
  je.created_by
FROM public.journal_entries je
LEFT JOIN public.contacts c ON c.id = je.contact_id
WHERE je.tipo_movimiento = 'Compra'
  AND je.contact_id IS NOT NULL                               -- contact_id es NOT NULL en compras
  AND NOT EXISTS (SELECT 1 FROM public.compras cp WHERE cp.asiento_id = je.id)
ON CONFLICT (referencia) DO NOTHING;

-- Asientos de compra sin contacto (no se pudieron migrar): revisar manualmente
SELECT je.id, je.numero_asiento, je.fecha, je.descripcion
FROM public.journal_entries je
WHERE je.tipo_movimiento = 'Compra' AND je.contact_id IS NULL;

-- Verificación
SELECT count(*) AS compras_registradas FROM public.compras;
