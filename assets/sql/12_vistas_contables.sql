-- ============================================================
-- 12_vistas_contables.sql
-- Vistas derivadas del libro mayor y de los módulos CxC/CxP.
-- PREREQUISITO: 05_schema_changes.sql + todos los SQLs de apertura
-- ============================================================
-- VISTAS:
--   v_cxc_pendientes  — documentos CxC con saldo > 0
--   v_cxp_pendientes  — documentos CxP con saldo > 0
--   v_antiguedad_cxc_cliente — antigüedad por cliente (30/60/90/+90 días)
--   v_antiguedad_cxp  — antigüedad CxP por tramos
--   v_libro_mayor     — libro mayor desde journal_entry_lines
--   v_balance_cxc_cxp — resumen ejecutivo CxC vs CxP
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- 1. CUENTAS POR COBRAR PENDIENTES
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_cxc_pendientes AS
SELECT
  cc.id,
  c.nombre                                        AS cliente,
  c.nro_documento                                 AS ruc_dni,
  cc.tipo_comprobante,
  cc.serie || '-' || cc.numero_comprobante        AS comprobante,
  cc.asiento_odoo                                 AS referencia,
  cc.fecha_emision,
  cc.fecha_vencimiento,
  COALESCE(cc.moneda, 'PEN')                      AS moneda,
  COALESCE(cc.tipo_cambio, 1)                     AS tc,
  cc.monto_total,
  COALESCE(cc.monto_cobrado, 0)                   AS monto_cobrado,
  cc.monto_total - COALESCE(cc.monto_cobrado, 0)  AS saldo_mn,
  COALESCE(cc.saldo_me, 0)                        AS saldo_me,
  cc.estado,
  -- Días de mora (negativo = aún no vence)
  CASE
    WHEN cc.fecha_vencimiento IS NULL THEN NULL
    ELSE CURRENT_DATE - cc.fecha_vencimiento
  END                                             AS dias_mora,
  cc.updated_at
FROM public.cuentas_cobrar cc
JOIN public.contacts c ON c.id = cc.contact_id
WHERE cc.estado IN ('pendiente', 'parcial');

COMMENT ON VIEW public.v_cxc_pendientes
  IS 'Documentos por cobrar con saldo pendiente. Para el total en MN: SUM(saldo_mn). Para vencidos: WHERE dias_mora > 0.';


-- ────────────────────────────────────────────────────────────
-- 2. CUENTAS POR PAGAR PENDIENTES
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_cxp_pendientes AS
SELECT
  cp.id,
  c.nombre                                        AS proveedor,
  c.nro_documento                                 AS ruc_dni,
  cp.tipo_comprobante,
  COALESCE(cp.serie, '') || '-' || COALESCE(cp.numero_comprobante, '') AS comprobante,
  cp.asiento_odoo                                 AS referencia,
  cp.referencia_cuenta                            AS cuenta_contable,
  cp.fecha_emision,
  cp.fecha_vencimiento,
  COALESCE(cp.moneda, 'PEN')                      AS moneda,
  COALESCE(cp.tipo_cambio, 1)                     AS tc,
  cp.monto_total,
  COALESCE(cp.monto_pagado, 0)                    AS monto_pagado,
  cp.monto_total - COALESCE(cp.monto_pagado, 0)   AS saldo_mn,
  CASE
    WHEN cp.fecha_vencimiento IS NULL THEN NULL
    ELSE CURRENT_DATE - cp.fecha_vencimiento
  END                                             AS dias_mora,
  cp.estado,
  cp.updated_at
FROM public.cuentas_pagar cp
JOIN public.contacts c ON c.id = cp.contact_id
WHERE cp.estado IN ('pendiente', 'parcial');

COMMENT ON VIEW public.v_cxp_pendientes
  IS 'Documentos por pagar con saldo pendiente. Para total deuda: SUM(saldo_mn). Agrupa por proveedor para ver exposición.';


-- ────────────────────────────────────────────────────────────
-- 3. ANTIGÜEDAD CxC (tramos 0-30, 31-60, 61-90, +90 días)
-- ────────────────────────────────────────────────────────────
-- RENOMBRADA en el script 36: el nombre `v_antiguedad_cxc` pasó a ser el
-- detalle POR CUOTA (necesario para representar un 30/70). Este resumen por
-- cliente se conserva bajo `v_antiguedad_cxc_cliente`.
CREATE OR REPLACE VIEW public.v_antiguedad_cxc_cliente AS
SELECT
  c.nombre                                               AS cliente,
  SUM(cc.monto_total - COALESCE(cc.monto_cobrado, 0))   AS saldo_total,
  SUM(CASE
    WHEN cc.fecha_vencimiento IS NULL
      OR CURRENT_DATE <= cc.fecha_vencimiento
    THEN cc.monto_total - COALESCE(cc.monto_cobrado, 0)
    ELSE 0
  END)                                                   AS corriente,
  SUM(CASE
    WHEN cc.fecha_vencimiento IS NOT NULL
      AND CURRENT_DATE - cc.fecha_vencimiento BETWEEN 1 AND 30
    THEN cc.monto_total - COALESCE(cc.monto_cobrado, 0)
    ELSE 0
  END)                                                   AS vencido_1_30,
  SUM(CASE
    WHEN cc.fecha_vencimiento IS NOT NULL
      AND CURRENT_DATE - cc.fecha_vencimiento BETWEEN 31 AND 60
    THEN cc.monto_total - COALESCE(cc.monto_cobrado, 0)
    ELSE 0
  END)                                                   AS vencido_31_60,
  SUM(CASE
    WHEN cc.fecha_vencimiento IS NOT NULL
      AND CURRENT_DATE - cc.fecha_vencimiento BETWEEN 61 AND 90
    THEN cc.monto_total - COALESCE(cc.monto_cobrado, 0)
    ELSE 0
  END)                                                   AS vencido_61_90,
  SUM(CASE
    WHEN cc.fecha_vencimiento IS NOT NULL
      AND CURRENT_DATE - cc.fecha_vencimiento > 90
    THEN cc.monto_total - COALESCE(cc.monto_cobrado, 0)
    ELSE 0
  END)                                                   AS vencido_mas_90
FROM public.cuentas_cobrar cc
JOIN public.contacts c ON c.id = cc.contact_id
WHERE cc.estado IN ('pendiente', 'parcial')
GROUP BY c.id, c.nombre
ORDER BY saldo_total DESC;

COMMENT ON VIEW public.v_antiguedad_cxc_cliente
  IS 'Reporte de antigüedad de saldos CxC. Corriente = no vencido. Tramos de mora en días.';


-- ────────────────────────────────────────────────────────────
-- 4. ANTIGÜEDAD CxP
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_antiguedad_cxp AS
SELECT
  c.nombre                                               AS proveedor,
  SUM(cp.monto_total - COALESCE(cp.monto_pagado, 0))    AS saldo_total,
  SUM(CASE
    WHEN cp.fecha_vencimiento IS NULL
      OR CURRENT_DATE <= cp.fecha_vencimiento
    THEN cp.monto_total - COALESCE(cp.monto_pagado, 0)
    ELSE 0
  END)                                                   AS corriente,
  SUM(CASE
    WHEN cp.fecha_vencimiento IS NOT NULL
      AND CURRENT_DATE - cp.fecha_vencimiento BETWEEN 1 AND 30
    THEN cp.monto_total - COALESCE(cp.monto_pagado, 0)
    ELSE 0
  END)                                                   AS vencido_1_30,
  SUM(CASE
    WHEN cp.fecha_vencimiento IS NOT NULL
      AND CURRENT_DATE - cp.fecha_vencimiento BETWEEN 31 AND 60
    THEN cp.monto_total - COALESCE(cp.monto_pagado, 0)
    ELSE 0
  END)                                                   AS vencido_31_60,
  SUM(CASE
    WHEN cp.fecha_vencimiento IS NOT NULL
      AND CURRENT_DATE - cp.fecha_vencimiento BETWEEN 61 AND 90
    THEN cp.monto_total - COALESCE(cp.monto_pagado, 0)
    ELSE 0
  END)                                                   AS vencido_61_90,
  SUM(CASE
    WHEN cp.fecha_vencimiento IS NOT NULL
      AND CURRENT_DATE - cp.fecha_vencimiento > 90
    THEN cp.monto_total - COALESCE(cp.monto_pagado, 0)
    ELSE 0
  END)                                                   AS vencido_mas_90
FROM public.cuentas_pagar cp
JOIN public.contacts c ON c.id = cp.contact_id
WHERE cp.estado IN ('pendiente', 'parcial')
GROUP BY c.id, c.nombre
ORDER BY saldo_total DESC;

COMMENT ON VIEW public.v_antiguedad_cxp
  IS 'Reporte de antigüedad de saldos CxP. Para ver deuda total con cada proveedor.';


-- ────────────────────────────────────────────────────────────
-- 5. LIBRO MAYOR
--    Desde journal_entry_lines (fuente de verdad contable).
--    Incluye el contacto si la línea lo tiene (12xxxx, 42xxxx).
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_libro_mayor AS
SELECT
  je.fecha                                       AS fecha,
  je.numero_asiento,
  je.descripcion,
  je.tipo_movimiento,
  pc.codigo                                      AS cuenta_codigo,
  pc.nombre                                      AS cuenta_nombre,
  jel.debe,
  jel.haber,
  jel.debe - jel.haber                           AS movimiento,
  c.nombre                                       AS contacto,
  jel.referencia_doc,
  jel.fecha_vencimiento,
  COALESCE(jel.moneda_original, 'PEN')           AS moneda,
  COALESCE(jel.tipo_cambio, 1)                   AS tc,
  jel.importe_original,
  jel.descripcion                                AS glosa_linea,
  je.id                                          AS journal_entry_id,
  jel.id                                         AS journal_entry_line_id
FROM public.journal_entry_lines jel
JOIN public.journal_entries je ON je.id = jel.journal_entry_id
JOIN public.plan_cuentas pc    ON pc.id = jel.account_id
LEFT JOIN public.contacts c    ON c.id  = jel.contact_id
ORDER BY je.fecha, je.numero_asiento, jel.id;

COMMENT ON VIEW public.v_libro_mayor
  IS 'Libro mayor completo. Filtrar por cuenta_codigo para ver movimientos de una cuenta. Filtrar por tipo_movimiento para separar ventas, compras, cobros, etc.';


-- ────────────────────────────────────────────────────────────
-- 6. BALANCE EJECUTIVO CxC vs CxP
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_balance_cxc_cxp AS
SELECT
  'CxC' AS tipo,
  COUNT(*)                                                      AS documentos,
  COUNT(*) FILTER (WHERE cc.estado = 'pendiente')              AS pendientes,
  COUNT(*) FILTER (WHERE cc.estado = 'parcial')                AS parciales,
  SUM(cc.monto_total)                                          AS monto_original,
  SUM(COALESCE(cc.monto_cobrado, 0))                           AS cobrado_pagado,
  SUM(cc.monto_total - COALESCE(cc.monto_cobrado, 0))          AS saldo_neto,
  SUM(CASE
    WHEN cc.fecha_vencimiento IS NOT NULL
      AND CURRENT_DATE > cc.fecha_vencimiento
    THEN cc.monto_total - COALESCE(cc.monto_cobrado, 0)
    ELSE 0
  END)                                                         AS vencido
FROM public.cuentas_cobrar cc
WHERE cc.estado IN ('pendiente', 'parcial')

UNION ALL

SELECT
  'CxP' AS tipo,
  COUNT(*),
  COUNT(*) FILTER (WHERE cp.estado = 'pendiente'),
  COUNT(*) FILTER (WHERE cp.estado = 'parcial'),
  SUM(cp.monto_total),
  SUM(COALESCE(cp.monto_pagado, 0)),
  SUM(cp.monto_total - COALESCE(cp.monto_pagado, 0)),
  SUM(CASE
    WHEN cp.fecha_vencimiento IS NOT NULL
      AND CURRENT_DATE > cp.fecha_vencimiento
    THEN cp.monto_total - COALESCE(cp.monto_pagado, 0)
    ELSE 0
  END)
FROM public.cuentas_pagar cp
WHERE cp.estado IN ('pendiente', 'parcial');

COMMENT ON VIEW public.v_balance_cxc_cxp
  IS 'Resumen ejecutivo: total CxC vs CxP. Saldo neto positivo = más cuentas por cobrar que pagar (favorable). La diferencia = capital de trabajo neto.';


-- ────────────────────────────────────────────────────────────
-- 7. BALANCE DE COMPROBACIÓN (Trial Balance — PCGE)
-- ────────────────────────────────────────────────────────────
-- Suma de movimientos reales desde journal_entry_lines (estado contabilizado).
-- Los saldos de plan_cuentas son acumuladores en tiempo real; esta vista
-- los reconcilia con los apuntes históricos para reporting.
CREATE OR REPLACE VIEW public.v_balance_comprobacion AS
SELECT
  pc.codigo,
  pc.nombre,
  pc.tipo,
  pc.naturaleza_saldo,
  COALESCE(SUM(jel.debe),  0)  AS total_debe,
  COALESCE(SUM(jel.haber), 0)  AS total_haber,
  COALESCE(SUM(jel.debe),  0)
    - COALESCE(SUM(jel.haber), 0)                     AS saldo_deudor,
  GREATEST(COALESCE(SUM(jel.haber), 0)
    - COALESCE(SUM(jel.debe),  0), 0)                 AS saldo_acreedor
FROM public.plan_cuentas pc
LEFT JOIN public.journal_entry_lines jel ON jel.account_id = pc.id
LEFT JOIN public.journal_entries      je  ON je.id = jel.journal_entry_id
  AND je.status = 'confirmado'
GROUP BY pc.id, pc.codigo, pc.nombre, pc.tipo, pc.naturaleza_saldo
ORDER BY pc.codigo;

COMMENT ON VIEW public.v_balance_comprobacion
  IS 'Balance de Comprobación de Sumas y Saldos. Columnas debe/haber son sumas históricas; saldo_deudor es positivo si debe > haber, saldo_acreedor viceversa.';


-- ────────────────────────────────────────────────────────────
-- 8. REGISTRO DE VENTAS (SUNAT Formato 14.1)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_registro_ventas AS
SELECT
  v.id,
  REPLACE(v.periodo_contable, '-', '')  AS periodo,
  v.fecha_emision,
  v.tipo_comprobante,
  v.serie,
  v.correlativo,
  v.numero,
  ct.tipo_documento                     AS tipo_doc_cliente,
  ct.nro_documento                      AS nro_doc_cliente,
  ct.nombre                             AS razon_social_cliente,
  COALESCE(v.base_imponible, 0)         AS base_imponible_gravada,
  COALESCE(v.igv, 0)                    AS igv,
  COALESCE(v.total, 0)                  AS total,
  v.moneda,
  COALESCE(v.tipo_cambio, 1)            AS tipo_cambio,
  v.estado,
  v.cpe_estado
FROM public.ventas v
JOIN public.contacts ct ON ct.id = v.contact_id
ORDER BY v.fecha_emision, v.numero;

COMMENT ON VIEW public.v_registro_ventas
  IS 'Registro de Ventas — base para Formato 14.1 SUNAT. Filtrar por periodo para el mes requerido.';


-- ────────────────────────────────────────────────────────────
-- 9. REGISTRO DE COMPRAS (SUNAT Formato 8.1)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_registro_compras AS
SELECT
  c.id,
  LPAD(c.periodo_ano::text, 4, '0') || LPAD(c.periodo_mes::text, 2, '0')  AS periodo,
  c.fecha_emision,
  c.fecha_recepcion,
  c.tipo_comprobante,
  c.serie,
  c.numero,
  c.proveedor_ruc                            AS ruc_proveedor,
  c.proveedor_nombre                         AS razon_social_proveedor,
  COALESCE(c.base_imponible_gravada, 0)      AS base_imponible_gravada,
  COALESCE(c.base_imponible_no_gravada, 0)   AS base_no_gravada,
  COALESCE(c.igv_gravado, 0)                 AS igv,
  COALESCE(c.total, 0)                       AS total,
  c.currency                                 AS moneda,
  COALESCE(c.tipo_cambio, 1)                 AS tipo_cambio,
  c.tipo_compra,
  c.estado_comprobante                       AS estado
FROM public.compras c
ORDER BY c.fecha_emision, c.numero;

COMMENT ON VIEW public.v_registro_compras
  IS 'Registro de Compras — base para Formato 8.1 SUNAT. Filtrar por periodo_ano + periodo_mes para el mes requerido.';


-- ────────────────────────────────────────────────────────────
-- QUERIES ÚTILES (para referencias rápidas)
-- ────────────────────────────────────────────────────────────

-- Total CxC y CxP pendiente:
-- SELECT * FROM v_balance_cxc_cxp;

-- Ver CxC por cliente ordenado por saldo:
-- SELECT cliente, moneda, SUM(saldo_mn) total FROM v_cxc_pendientes GROUP BY cliente, moneda ORDER BY total DESC;

-- Ver CxP por proveedor:
-- SELECT proveedor, SUM(saldo_mn) total FROM v_cxp_pendientes GROUP BY proveedor ORDER BY total DESC;

-- Ver facturas vencidas CxC:
-- SELECT * FROM v_cxc_pendientes WHERE dias_mora > 0 ORDER BY dias_mora DESC;

-- Ver libro mayor cuenta 121201:
-- SELECT fecha, descripcion, debe, haber, contacto FROM v_libro_mayor WHERE cuenta_codigo = '121201';

-- Antigüedad resumida CxC:
-- SELECT * FROM v_antiguedad_cxc_cliente;   -- resumen por cliente
-- SELECT * FROM v_antiguedad_cxc;           -- detalle por cuota (script 36)

-- Antigüedad resumida CxP:
-- SELECT * FROM v_antiguedad_cxp;
