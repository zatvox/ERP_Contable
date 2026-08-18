-- ============================================================
-- 10_apertura_cxc_cxp.sql
-- Apertura CxC + CxP al 30/06/2026
-- Consolida: 10_apertura_cxc + 10_correccion_cxc + 11_apertura_cxp
-- PREREQUISITO: 08_apertura_contactos.sql ejecutado
-- Los valores del CxC ya incorporan las correcciones (v4 definitivo).
-- ============================================================


-- ============================================================
-- SECCIÓN 1: CxC — 20 documentos por cobrar
-- ============================================================
-- ────────────────────────────────────────────────────────────
-- Contacto CORPORACION TEXTIL GATE (ausente en SQL 08)
-- ────────────────────────────────────────────────────────────
-- CORPORACION TEXTIL GATE S.A.C. RUC 20601211841 — ya incluido en 08_apertura_contactos.sql


-- ────────────────────────────────────────────────────────────
-- INSERT cuentas_cobrar
-- Nota: monto_total = monto MN del CSV (real, no duplicado)
--       monto_cobrado = monto ya cobrado (saldo parcial)
--       tipo_cambio   = monto_mn / monto_me del CSV
--       saldo_me      = saldo pendiente en ME
-- ────────────────────────────────────────────────────────────
INSERT INTO public.cuentas_cobrar (
  contact_id, tipo_comprobante, serie, numero_comprobante,
  fecha_emision, fecha_vencimiento, moneda, tipo_cambio,
  monto_total, monto_me, monto_cobrado, saldo_me, estado, asiento_odoo
)
VALUES

  -- 1. BENJI BILLION E.I.R.L.
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20611982446'),
    '(01) Factura', '000003', '00000364',
    '2026-06-16', '2026-07-31', 'PEN', 1.0,
    6501.60, 0.0, 0.0, 0.0,
    'pendiente', 'FFFI-00000364'
  ),

  -- 2. BROOKLING S.R.L — factura 187 (parcialmente cobrada)
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20508972815'),
    '(01) Factura', '000001', '00000187',
    '2025-09-26', '2026-01-24', 'PEN', 1.0,
    6981.00, 0.0, 6771.57, 0.0,
    'parcial', 'FFFI-00000187'
  ),

  -- 3. BROOKLING S.R.L — factura 165 (parcialmente cobrada)
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20508972815'),
    '(01) Factura', '000001', '00000165',
    '2025-09-01', '2025-12-30', 'PEN', 1.0,
    7085.00, 0.0, 6872.45, 0.0,
    'parcial', 'FFFI-00000165'
  ),

  -- 4. BROOKLING S.R.L — letra refinanciada LT.187
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20508972815'),
    '', 'LT.187', 'LT.187-01/FNDI-09/FNI-10',
    '2026-01-12', '2026-07-24', 'PEN', 1.0,
    7497.48, 0.0, 0.0, 0.0,
    'pendiente', 'LETRA/2026/01/0004 (REFIN.LT.187-01/FNDI-09/FNI-10)'
  ),

  -- 5. BROOKLING S.R.L — letra refinanciada LT.165
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20508972815'),
    '', 'LT.165', 'LT.165-01/LT.165-02/FNDI-9',
    '2026-01-12', '2026-07-17', 'PEN', 1.0,
    7497.48, 0.0, 0.0, 0.0,
    'pendiente', 'LETRA/2026/01/0003 (REFIN. LT.165-01/LT.165-02/FNDI-9)'
  ),

  -- 6. CAMPOS CISNEROS JULIA — factura USD (parcialmente cobrada)
  --    tipo_cambio calculado: 30197.56 / 8119.8 = 3.719
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10470968082'),
    '(01) Factura', '000000', '00000037',
    '2025-02-14', '2025-03-16', 'USD', 3.719,
    30197.56, 8119.80, 24335.69, 1576.19,
    'parcial', 'FFFI-00000037'
  ),

  -- 7. CORPORACION BROOKLING S.A.C. — letra refinanciada LT.167
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20544471245'),
    '', 'LT.167', 'LT.167-01/LT.167-02/FNDI-11',
    '2026-01-12', '2026-07-31', 'PEN', 1.0,
    7404.50, 0.0, 0.0, 0.0,
    'pendiente', 'LETRA/2026/01/0005 (REFIN.LT.167-01/LT.167-02 /FNDI-11)'
  ),

  -- 8. CORPORACION BUSATEX S.A.C. — factura USD (parcialmente cobrada)
  --    tipo_cambio calculado: 14985.47 / 4461.3 = 3.359
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20603278888'),
    '(01) Factura', '000002', '00000270',
    '2026-01-26', '2026-04-26', 'USD', 3.359,
    14985.47, 4461.30, 13636.97, 401.46,
    'parcial', 'FFFI-00000270'
  ),

  -- 9. CORPORACION TEXTIL JORGITO S.A.C. — letra LT.339-05 USD
  --    tipo_cambio: 32633.87 / 9500.4 = 3.435
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20601469953'),
    '', 'LT.339', 'LT.339-05',
    '2026-05-18', '2026-07-29', 'USD', 3.435,
    32633.87, 9500.40, 0.0, 9500.40,
    'pendiente', 'LETRA/2026/05/0008 (FFFI-339)'
  ),

  -- 10. CORPORACION TEXTIL JORGITO S.A.C. — letra LT.339-04 USD
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20601469953'),
    '', 'LT.339', 'LT.339-04',
    '2026-05-18', '2026-07-14', 'USD', 3.435,
    32633.87, 9500.40, 0.0, 9500.40,
    'pendiente', 'LETRA/2026/05/0007 (FFFI-339)'
  ),

  -- 11. CORPORACION TEXTIL GATE S.A.C. — apertura
  --    tipo_cambio: 975.71 / 260.19 = 3.75
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20601211841'),
    '', '', '416',
    '2025-01-02', NULL, 'USD', 3.75,
    975.71, 260.19, 0.0, 260.19,
    'pendiente', 'APERT/2025/01/0002 (ASIENTO DE APERTURA 01/2025 - DETALLE DE [...])'
  ),

  -- 12. IMPORT & EXPORT COTTON LU E.I.R.L. — factura 376 USD
  --    tipo_cambio: 55057.86 / 16146.0 = 3.410
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20548798061'),
    '(01) Factura', '000003', '00000376',
    '2026-06-24', '2026-09-27', 'USD', 3.410,
    55057.86, 16146.00, 0.0, 16146.00,
    'pendiente', 'FFFI-00000376'
  ),

  -- 13. IMPORT & EXPORT COTTON LU E.I.R.L. — factura 375 USD
  --    tipo_cambio: 8705.95 / 2570.4 = 3.387
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20548798061'),
    '(01) Factura', '000003', '00000375',
    '2026-06-23', '2026-07-23', 'USD', 3.387,
    8705.95, 2570.40, 0.0, 2570.40,
    'pendiente', 'FFFI-00000375'
  ),

  -- 14. INVERSIONES TEXTIL DEL SUR E.I.R.L. — factura 372 USD
  --    tipo_cambio: 18949.75 / 5596.5 = 3.386
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20601704367'),
    '(01) Factura', '000003', '00000372',
    '2026-06-20', '2026-07-05', 'USD', 3.386,
    18949.75, 5596.50, 0.0, 5596.50,
    'pendiente', 'FFFI-00000372'
  ),

  -- 15. INVERSIONES TEXTIL DEL SUR E.I.R.L. — factura 370 USD
  --    tipo_cambio: 17528.67 / 5173.75 = 3.388
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20601704367'),
    '(01) Factura', '000003', '00000370',
    '2026-06-19', '2026-07-04', 'USD', 3.388,
    17528.67, 5173.75, 0.0, 5173.75,
    'pendiente', 'FFFI-00000370'
  ),

  -- 16. JADESA CORPORATION S.A.C. — CUOTA 1/2 (50% — 30 días)
  --    tipo_cambio: 11432.81 / 3393.53 = 3.369
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20604172145'),
    '(01) Factura', '000002', '00000284',
    '2026-02-03', '2026-03-05', 'USD', 3.369,
    11432.81, 3393.53, 0.0, 3393.53,
    'pendiente', 'FFFI-00000284'
  ),

  -- 17. JADESA CORPORATION S.A.C. — CUOTA 2/2 (50% — 60 días)
  --    Misma factura FFFI-284, segundo vencimiento
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20604172145'),
    '(01) Factura', '000002', '00000284',
    '2026-02-03', '2026-04-04', 'USD', 3.369,
    11432.82, 3393.54, 0.0, 3393.54,
    'pendiente', 'FFFI-00000284-C2'
  ),

  -- 18. UNITED GROUP CT E.I.R.L. — factura USD (parcialmente cobrada)
  --    tipo_cambio: 71175.29 / 21114.0 = 3.371
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20601186684'),
    '(01) Factura', '000002', '00000222',
    '2025-11-27', '2026-02-10', 'USD', 3.371,
    71175.29, 21114.00, 67371.01, 1128.53,
    'parcial', 'FFFI-00000222'
  ),

  -- 19. VANITEX IMPORT & EXPORT S.A.C. — factura 366 USD
  --    tipo_cambio: 11675.80 / 3447.24 = 3.387
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20392524739'),
    '(01) Factura', '000003', '00000366',
    '2026-06-16', '2026-07-31', 'USD', 3.387,
    11675.80, 3447.24, 0.0, 3447.24,
    'pendiente', 'FFFI-00000366'
  ),

  -- 20. VANITEX IMPORT & EXPORT S.A.C. — factura 355 USD
  --    tipo_cambio: 18753.64 / 5483.52 = 3.420
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20392524739'),
    '(01) Factura', '000003', '00000355',
    '2026-05-27', '2026-06-26', 'USD', 3.420,
    18753.64, 5483.52, 0.0, 5483.52,
    'pendiente', 'FFFI-00000355'
  )

ON CONFLICT (asiento_odoo) WHERE asiento_odoo IS NOT NULL DO UPDATE SET
  monto_total   = EXCLUDED.monto_total,
  monto_me      = EXCLUDED.monto_me,
  monto_cobrado = EXCLUDED.monto_cobrado,
  saldo_me      = EXCLUDED.saldo_me,
  tipo_cambio   = EXCLUDED.tipo_cambio,
  estado        = EXCLUDED.estado,
  updated_at    = now();


-- ────────────────────────────────────────────────────────────
-- RESUMEN ESPERADO:
-- 20 registros → 11 en USD, 9 en PEN
-- Total MN pendiente ≈ 259,142.73
-- Clientes con saldo parcial: BROOKLING x2, CAMPOS, BUSATEX, UNITED
-- ────────────────────────────────────────────────────────────

-- Verificar:
-- SELECT c.nombre, cc.numero_comprobante, cc.moneda, cc.monto_total,
--        cc.monto_cobrado, cc.monto_total - cc.monto_cobrado AS saldo_mn,
--        cc.saldo_me, cc.estado
-- FROM cuentas_cobrar cc
-- JOIN contacts c ON cc.contact_id = c.id
-- ORDER BY c.nombre, cc.fecha_emision;


-- ============================================================
-- SECCIÓN 2: CxP — 119 documentos por pagar
-- ============================================================
-- NOTAS DE MAPEO:
--   monto_total  = ABS(monto_mn)  — importe original del documento
--   monto_pagado = ABS(monto_mn) - ABS(saldo_mn)  — ya pagado
--   estado       = 'parcial' si monto_pagado > 0, 'pendiente' si = 0
--   fecha_emision = NULL en Odoo → usa '2025-01-01' como placeholder
--   asiento_odoo + contact_id + referencia_cuenta = clave única idempotente
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- PASO 1: Insertar contactos que NO están en 08_apertura_contactos.sql
-- (Los demás ya tienen RUC/DNI real en el archivo de contactos)
-- ────────────────────────────────────────────────────────────
INSERT INTO public.contacts (nombre, tipo_documento, nro_documento, tipo_contacto)
VALUES
  ('PROVEEDORES VARIOS', 'NN', '9999991', 'proveedor'),
  ('VACACIONES 2022',    'NN', '9999992',    'empleado')
ON CONFLICT (nro_documento) DO NOTHING;


-- ────────────────────────────────────────────────────────────
-- PASO 2: INSERT 119 registros en cuentas_pagar
-- ────────────────────────────────────────────────────────────

INSERT INTO public.cuentas_pagar (
  contact_id, tipo_comprobante, numero_comprobante,
  fecha_emision, fecha_vencimiento, moneda, tipo_cambio,
  monto_total, monto_pagado, estado,
  asiento_odoo, referencia_cuenta
)
VALUES

  -- ═══════════════════════════════════════════
  -- AGUILAR JARA MAIRELLY DEL ROSARIO
  -- ═══════════════════════════════════════════

  -- [1] Retención 2da categoría — cuota 06
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10770981501'),
    '', '00842894', '2025-01-01', NULL, 'USD', 3.367,
    15.32, 0.0, 'pendiente',
    'BNK4/2026/00106 (PAGO CUOTA 06 PRESTAMO ROSARIO - JHIRO)', '401710 RENTA DE SEGUNDA CATEGORÖA'
  ),

  -- [2] Retención 2da categoría — cuota 08
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10770981501'),
    '', '00552839', '2025-01-01', NULL, 'USD', 3.499,
    15.92, 0.0, 'pendiente',
    'BNK4/2026/00224 (PAGO CUOTA 08 PRESTAMO ROSARIO - JHIRO)', '401710 RENTA DE SEGUNDA CATEGORÖA'
  ),

  -- [3] Retención 2da categoría — cuota 07
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10770981501'),
    '', '00378173', '2025-01-01', NULL, 'USD', 3.495,
    15.90, 0.0, 'pendiente',
    'BNK4/2026/00151 (PAGO CUOTA 07 PRESTAMO ROSARIO - JHIRO)', '401710 RENTA DE SEGUNDA CATEGORÖA'
  ),

  -- [4] Retención 2da categoría — cuota 09
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10770981501'),
    '', '00961229', '2025-01-01', NULL, 'USD', 3.415,
    15.54, 0.0, 'pendiente',
    'BNK4/2026/00273 (PAGO CUOTA 09 PRESTAMO ROSARIO - JHIRO)', '401710 RENTA DE SEGUNDA CATEGORÖA'
  ),

  -- [5] Planilla junio — AFP Integra
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10770981501'),
    '', 'PLAN-06', '2025-01-01', NULL, 'PEN', 1.0,
    128.48, 0.0, 'pendiente',
    'PLLA/2026/06/0001 (PLANILLA SUELDOS MES JUNIO 2026)', '407113 AFP INTEGRA'
  ),

  -- [6] Planilla junio — Sueldos
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10770981501'),
    '', 'PLAN-06', '2025-01-01', NULL, 'PEN', 1.0,
    1001.52, 0.0, 'pendiente',
    'PLLA/2026/06/0001 (PLANILLA SUELDOS MES JUNIO 2026)', '411111 SUELDOS Y SALARIOS POR PAGAR'
  ),

  -- [7] Préstamo accionista BNK4/2025/00454 (saldo parcial: -66709 mn / saldo -45643)
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10770981501'),
    '', '0617819', '2025-01-01', NULL, 'USD', 3.511,
    66709.00, 21066.00, 'parcial',
    'BNK4/2025/00454 (PRESTAMO DE MAIRELLY DEL ROSARIO AGUILAR [...])', '441110 ACCIONISTAS (O SOCIOS)'
  ),

  -- [8] Provisión vacaciones junio
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10770981501'),
    '', 'VAC-06', '2025-01-01', NULL, 'PEN', 1.0,
    47.08, 0.0, 'pendiente',
    'PLLA/2026/06/0002 (PROVISION VACACIONES MES JUNIO 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [9] Provisión vacaciones marzo
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10770981501'),
    '', 'VAC-03', '2025-01-01', NULL, 'PEN', 1.0,
    47.08, 0.0, 'pendiente',
    'PLLA/2026/03/0002 (PROVISION VACACIONES MES MARZO 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [10] Provisión vacaciones mayo
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10770981501'),
    '', 'VAC-05', '2025-01-01', NULL, 'PEN', 1.0,
    47.08, 0.0, 'pendiente',
    'PLLA/2026/05/0002 (PROVISION VACACIONES MES MAYO 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [11] Provisión vacaciones abril
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10770981501'),
    '', 'VAC-04', '2025-01-01', NULL, 'PEN', 1.0,
    47.08, 0.0, 'pendiente',
    'PLLA/2026/04/0002 (PROVISION VACACIONES MES ABRIL 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [12] Provisión vacaciones febrero
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10770981501'),
    '', 'VAC-02', '2025-01-01', NULL, 'PEN', 1.0,
    47.08, 0.0, 'pendiente',
    'PLLA/2026/02/0002 (PROVISION VACACIONES MES FEBRERO 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [13] Provisión gratificación junio
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10770981501'),
    '', 'GRAT-06', '2025-01-01', NULL, 'PEN', 1.0,
    94.17, 0.0, 'pendiente',
    'PLLA/2026/06/0004 (PROVISION GRATIFICACION MES JUNIO 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [14] Provisión gratificación marzo
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10770981501'),
    '', 'GRAT-03', '2025-01-01', NULL, 'PEN', 1.0,
    94.17, 0.0, 'pendiente',
    'PLLA/2026/03/0004 (PROVISION GRATIFICACION MES MARZO 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [15] Provisión gratificación abril
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10770981501'),
    '', 'GRAT-04', '2025-01-01', NULL, 'PEN', 1.0,
    94.17, 0.0, 'pendiente',
    'PLLA/2026/04/0004 (PROVISION GRATIFICACION MES ABRIL 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [16] Provisión gratificación mayo
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10770981501'),
    '', 'GRAT-05', '2025-01-01', NULL, 'PEN', 1.0,
    94.17, 0.0, 'pendiente',
    'PLLA/2026/05/0004 (PROVISION GRATIFICACION MES MAYO 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [17] Provisión gratificación febrero
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10770981501'),
    '', 'GRAT-02', '2025-01-01', NULL, 'PEN', 1.0,
    94.17, 0.0, 'pendiente',
    'PLLA/2026/02/0004 (PROVISION GRATIFICACION MES FEBRERO 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [18] Provisión CTS junio
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10770981501'),
    '', 'CTS-06', '2025-01-01', NULL, 'PEN', 1.0,
    48.86, 0.0, 'pendiente',
    'PLLA/2026/06/0003 (PROVISION CTS MES JUNIO 2026)', '489114 PROVISION PARA COMPENSACION POR TIEMPO DE SERVICIO'
  ),

  -- [19] Provisión CTS mayo
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10770981501'),
    '', 'CTS-05', '2025-01-01', NULL, 'PEN', 1.0,
    48.86, 0.0, 'pendiente',
    'PLLA/2026/05/0003 (PROVISION CTS MES MAYO 2026)', '489114 PROVISION PARA COMPENSACION POR TIEMPO DE SERVICIO'
  ),

  -- ═══════════════════════════════════════════
  -- ALPES TEXTIL S.A. — factura (pago parcial)
  -- monto_mn=5418, saldo_mn=1918 → pagado=3500
  -- ═══════════════════════════════════════════

  -- [20]
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20160697289'),
    '(01) Factura', '00001765', '2026-06-16', '2026-06-16', 'PEN', 1.0,
    5418.00, 3500.00, 'parcial',
    'FE001-00001765', '421211 EMITIDAS M.N'
  ),

  -- ═══════════════════════════════════════════
  -- AQUIJE JUAREZ PAULA JESUS — recibos honorarios
  -- ═══════════════════════════════════════════

  -- [21]
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10745805961'),
    '(02) Recibo por Honorarios', '144', '2026-06-16', '2026-06-30', 'PEN', 1.0,
    1800.00, 0.0, 'pendiente',
    'RE001-144', '424111 HONORARIOS POR PAGAR M.N.'
  ),

  -- [22]
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10745805961'),
    '(02) Recibo por Honorarios', '145', '2026-06-30', '2026-06-30', 'PEN', 1.0,
    1700.00, 0.0, 'pendiente',
    'RE001-145', '424111 HONORARIOS POR PAGAR M.N.'
  ),

  -- ═══════════════════════════════════════════
  -- BANCO DE CREDITO DEL PERU — préstamo (pago parcial)
  -- monto=230882.75, saldo=224469.34 → pagado=6413.41
  -- ═══════════════════════════════════════════

  -- [23]
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20100047218'),
    '', 'NøO0021547926', '2025-01-01', NULL, 'PEN', 1.0,
    230882.75, 6413.41, 'parcial',
    'BNK1/2026/00292 (PRESTAMO FINANCIERO BCP SOLICITUD NøO0021547926)', '451112 PRESTAMOS BCP'
  ),

  -- ═══════════════════════════════════════════
  -- CHAVEZ AVILA JOSE MIGUEL — recibo honorarios
  -- ═══════════════════════════════════════════

  -- [24]
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10719131056'),
    '(02) Recibo por Honorarios', '31', '2026-06-30', '2026-06-30', 'PEN', 1.0,
    1600.00, 0.0, 'pendiente',
    'RE001-31', '424111 HONORARIOS POR PAGAR M.N.'
  ),

  -- ═══════════════════════════════════════════
  -- CRISTIAN ARON PAZ VILCA
  -- ═══════════════════════════════════════════

  -- [25] AFP Prima
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '72626092'),
    '', 'PLAN-06', '2025-01-01', NULL, 'PEN', 1.0,
    128.48, 0.0, 'pendiente',
    'PLLA/2026/06/0001 (PLANILLA SUELDOS MES JUNIO 2026)', '407112 AFP PRIMA'
  ),

  -- [26] Sueldos
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '72626092'),
    '', 'PLAN-06', '2025-01-01', NULL, 'PEN', 1.0,
    1001.52, 0.0, 'pendiente',
    'PLLA/2026/06/0001 (PLANILLA SUELDOS MES JUNIO 2026)', '411111 SUELDOS Y SALARIOS POR PAGAR'
  ),

  -- [27] Prov. vacaciones junio
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '72626092'),
    '', 'VAC-06', '2025-01-01', NULL, 'PEN', 1.0,
    47.08, 0.0, 'pendiente',
    'PLLA/2026/06/0002 (PROVISION VACACIONES MES JUNIO 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [28] Prov. vacaciones marzo
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '72626092'),
    '', 'VAC-03', '2025-01-01', NULL, 'PEN', 1.0,
    47.08, 0.0, 'pendiente',
    'PLLA/2026/03/0002 (PROVISION VACACIONES MES MARZO 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [29] Prov. vacaciones enero
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '72626092'),
    '', 'VAC-01', '2025-01-01', NULL, 'PEN', 1.0,
    47.08, 0.0, 'pendiente',
    'PLLA/2026/01/0002 (PROVISION VACACIONES MES ENERO 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [30] Prov. vacaciones febrero
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '72626092'),
    '', 'VAC-02', '2025-01-01', NULL, 'PEN', 1.0,
    47.08, 0.0, 'pendiente',
    'PLLA/2026/02/0002 (PROVISION VACACIONES MES FEBRERO 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [31] Prov. vacaciones abril
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '72626092'),
    '', 'VAC-04', '2025-01-01', NULL, 'PEN', 1.0,
    47.08, 0.0, 'pendiente',
    'PLLA/2026/04/0002 (PROVISION VACACIONES MES ABRIL 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [32] Prov. vacaciones mayo
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '72626092'),
    '', 'VAC-05', '2025-01-01', NULL, 'PEN', 1.0,
    47.08, 0.0, 'pendiente',
    'PLLA/2026/05/0002 (PROVISION VACACIONES MES MAYO 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [33] Prov. grat. junio
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '72626092'),
    '', 'GRAT-06', '2025-01-01', NULL, 'PEN', 1.0,
    94.17, 0.0, 'pendiente',
    'PLLA/2026/06/0004 (PROVISION GRATIFICACION MES JUNIO 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [34] Prov. grat. marzo
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '72626092'),
    '', 'GRAT-03', '2025-01-01', NULL, 'PEN', 1.0,
    94.17, 0.0, 'pendiente',
    'PLLA/2026/03/0004 (PROVISION GRATIFICACION MES MARZO 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [35] Prov. grat. enero
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '72626092'),
    '', 'GRAT-01', '2025-01-01', NULL, 'PEN', 1.0,
    94.17, 0.0, 'pendiente',
    'PLLA/2026/01/0004 (PROVISION GRATIFICACION MES ENERO 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [36] Prov. grat. mayo
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '72626092'),
    '', 'GRAT-05', '2025-01-01', NULL, 'PEN', 1.0,
    94.17, 0.0, 'pendiente',
    'PLLA/2026/05/0004 (PROVISION GRATIFICACION MES MAYO 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [37] Prov. grat. febrero
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '72626092'),
    '', 'GRAT-02', '2025-01-01', NULL, 'PEN', 1.0,
    94.17, 0.0, 'pendiente',
    'PLLA/2026/02/0004 (PROVISION GRATIFICACION MES FEBRERO 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [38] Prov. grat. abril
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '72626092'),
    '', 'GRAT-04', '2025-01-01', NULL, 'PEN', 1.0,
    94.17, 0.0, 'pendiente',
    'PLLA/2026/04/0004 (PROVISION GRATIFICACION MES ABRIL 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [39] Prov. CTS junio
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '72626092'),
    '', 'CTS-06', '2025-01-01', NULL, 'PEN', 1.0,
    48.86, 0.0, 'pendiente',
    'PLLA/2026/06/0003 (PROVISION CTS MES JUNIO 2026)', '489114 PROVISION PARA COMPENSACION POR TIEMPO DE SERVICIO'
  ),

  -- [40] Prov. CTS mayo
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '72626092'),
    '', 'CTS-05', '2025-01-01', NULL, 'PEN', 1.0,
    48.86, 0.0, 'pendiente',
    'PLLA/2026/05/0003 (PROVISION CTS MES MAYO 2026)', '489114 PROVISION PARA COMPENSACION POR TIEMPO DE SERVICIO'
  ),

  -- ═══════════════════════════════════════════
  -- CUBA ASENCIO MARIO DANIEL
  -- ═══════════════════════════════════════════

  -- [41] AFP Integra
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'PLAN-06', '2025-01-01', NULL, 'PEN', 1.0,
    284.25, 0.0, 'pendiente',
    'PLLA/2026/06/0001 (PLANILLA SUELDOS MES JUNIO 2026)', '407113 AFP INTEGRA'
  ),

  -- [42] Sueldos
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'PLAN-06', '2025-01-01', NULL, 'PEN', 1.0,
    2215.75, 0.0, 'pendiente',
    'PLLA/2026/06/0001 (PLANILLA SUELDOS MES JUNIO 2026)', '411111 SUELDOS Y SALARIOS POR PAGAR'
  ),

  -- [43] Prov. vac. junio
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'VAC-06', '2025-01-01', NULL, 'PEN', 1.0,
    104.17, 0.0, 'pendiente',
    'PLLA/2026/06/0002 (PROVISION VACACIONES MES JUNIO 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [44] ago-2025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'VAC-08', '2025-01-01', NULL, 'PEN', 1.0,
    104.17, 0.0, 'pendiente',
    'PLLA/2025/08/0002 (PROVISION VACACIONES MES AGOSTO 2025)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [45] sep-2025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'VAC-09', '2025-01-01', NULL, 'PEN', 1.0,
    104.17, 0.0, 'pendiente',
    'PLLA/2025/09/0002 (PROVISION VACACIONES MES SETIEMBRE 2025)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [46] oct-2025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'VAC-10', '2025-01-01', NULL, 'PEN', 1.0,
    104.17, 0.0, 'pendiente',
    'PLLA/2025/10/0002 (PROVISION VACACIONES MES OCTUBRE 2025)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [47] dic-2025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'VAC-12', '2025-01-01', NULL, 'PEN', 1.0,
    104.17, 0.0, 'pendiente',
    'PLLA/2025/12/0004 (PROVISION VACACIONES MES DICIEMBRE 2025)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [48] nov-2025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'VAC-11', '2025-01-01', NULL, 'PEN', 1.0,
    104.17, 0.0, 'pendiente',
    'PLLA/2025/11/0002 (PROVISION VACACIONES MES NOVIEMBRE 2025)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [49] mar-2026
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'VAC-03', '2025-01-01', NULL, 'PEN', 1.0,
    104.17, 0.0, 'pendiente',
    'PLLA/2026/03/0002 (PROVISION VACACIONES MES MARZO 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [50] feb-2025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'VAC-02', '2025-01-01', NULL, 'PEN', 1.0,
    104.17, 0.0, 'pendiente',
    'PLLA/2025/02/0003 (PROVISION VACACIONES MES FEBRERO 2025)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [51] jun-2025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'VAC-06', '2025-01-01', NULL, 'PEN', 1.0,
    104.17, 0.0, 'pendiente',
    'PLLA/2025/06/0003 (PROVISION VACACIONES MES JUNIO 2025)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [52] abr-2026
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'VAC-04', '2025-01-01', NULL, 'PEN', 1.0,
    104.17, 0.0, 'pendiente',
    'PLLA/2026/04/0002 (PROVISION VACACIONES MES ABRIL 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [53] abr-2025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'VAC-04', '2025-01-01', NULL, 'PEN', 1.0,
    104.17, 0.0, 'pendiente',
    'PLLA/2025/04/0002 (PROVISION VACACIONES MES ABRIL 2025)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [54] may-2025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'VAC-05', '2025-01-01', NULL, 'PEN', 1.0,
    104.17, 0.0, 'pendiente',
    'PLLA/2025/05/0002 (PROVISION VACACIONES MES MAYO 2025)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [55] jul-2025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'VAC-07', '2025-01-01', NULL, 'PEN', 1.0,
    104.17, 0.0, 'pendiente',
    'PLLA/2025/07/0002 (PROVISION VACACIONES MES JULIO 2025)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [56] ene-2026
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'VAC-01', '2025-01-01', NULL, 'PEN', 1.0,
    104.17, 0.0, 'pendiente',
    'PLLA/2026/01/0002 (PROVISION VACACIONES MES ENERO 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [57] feb-2026
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'VAC-02', '2025-01-01', NULL, 'PEN', 1.0,
    104.17, 0.0, 'pendiente',
    'PLLA/2026/02/0002 (PROVISION VACACIONES MES FEBRERO 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [58] mar-2025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'VAC-03', '2025-01-01', NULL, 'PEN', 1.0,
    104.17, 0.0, 'pendiente',
    'PLLA/2025/03/0003 (PROVISION VACACIONES MES MARZO 2025)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [59] may-2026
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'VAC-05', '2025-01-01', NULL, 'PEN', 1.0,
    104.17, 0.0, 'pendiente',
    'PLLA/2026/05/0002 (PROVISION VACACIONES MES MAYO 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [60] grat. junio
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'GRAT-06', '2025-01-01', NULL, 'PEN', 1.0,
    208.33, 0.0, 'pendiente',
    'PLLA/2026/06/0004 (PROVISION GRATIFICACION MES JUNIO 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [61] grat. mar
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'GRAT-03', '2025-01-01', NULL, 'PEN', 1.0,
    208.33, 0.0, 'pendiente',
    'PLLA/2026/03/0004 (PROVISION GRATIFICACION MES MARZO 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [62] grat. ene
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'GRAT-01', '2025-01-01', NULL, 'PEN', 1.0,
    208.33, 0.0, 'pendiente',
    'PLLA/2026/01/0004 (PROVISION GRATIFICACION MES ENERO 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [63] grat. feb
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'GRAT-02', '2025-01-01', NULL, 'PEN', 1.0,
    208.33, 0.0, 'pendiente',
    'PLLA/2026/02/0004 (PROVISION GRATIFICACION MES FEBRERO 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [64] grat. abr
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'GRAT-04', '2025-01-01', NULL, 'PEN', 1.0,
    208.33, 0.0, 'pendiente',
    'PLLA/2026/04/0004 (PROVISION GRATIFICACION MES ABRIL 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [65] grat. may
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'GRAT-05', '2025-01-01', NULL, 'PEN', 1.0,
    208.33, 0.0, 'pendiente',
    'PLLA/2026/05/0004 (PROVISION GRATIFICACION MES MAYO 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [66] CTS junio
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'CTS-06', '2025-01-01', NULL, 'PEN', 1.0,
    104.17, 0.0, 'pendiente',
    'PLLA/2026/06/0003 (PROVISION CTS MES JUNIO 2026)', '489114 PROVISION PARA COMPENSACION POR TIEMPO DE SERVICIO'
  ),

  -- [67] CTS mayo
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08013088'),
    '', 'CTS-05', '2025-01-01', NULL, 'PEN', 1.0,
    104.17, 0.0, 'pendiente',
    'PLLA/2026/05/0003 (PROVISION CTS MES MAYO 2026)', '489114 PROVISION PARA COMPENSACION POR TIEMPO DE SERVICIO'
  ),

  -- ═══════════════════════════════════════════
  -- HIGHLAND TRADING COMPANY S.A.C.
  -- ═══════════════════════════════════════════

  -- [68] Arrendamiento financiero
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20512118128'),
    '', '3665', '2025-01-01', NULL, 'PEN', 1.0,
    159756.48, 0.0, 'pendiente',
    'APERT/2025/01/0003 (ASIENTO DE APERTURA 01/2025 - DETALLE DE [...])', '465311 ACTIVOS ADQUIRIDOS EN ARRENDAMIENTO FINA'
  ),

  -- [69] Préstamo por pagar
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20512118128'),
    '', '3666', '2025-01-01', NULL, 'PEN', 1.0,
    33222.38, 0.0, 'pendiente',
    'APERT/2025/01/0003 (ASIENTO DE APERTURA 01/2025 - DETALLE DE [...])', '469915 PRESTAMO POR PAGAR DE TERCEROS'
  ),

  -- ═══════════════════════════════════════════
  -- JHIRO PERU S.A.C.
  -- ═══════════════════════════════════════════

  -- [70] IGV percepciones
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20600842995'),
    '', '', '2025-01-01', NULL, 'PEN', 1.0,
    73026.00, 0.0, 'pendiente',
    'APERT/2025/01/0006 (AJUSTE APERTURA BALANCE COMP. CTA IGV- [...])', '401131 IGV - RGIMEN DE PERCEPCIONES'
  ),

  -- [71] Renta 3ra categoría 2025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20600842995'),
    '', '2025', '2025-01-01', NULL, 'PEN', 1.0,
    9187.00, 0.0, 'pendiente',
    'COMPENSACIàN RENTA 2025 (RENTA 2025)', '401711 RENTA DE TERCERA CATEGORÖA'
  ),

  -- [72] Renta 3ra crédito 052025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20600842995'),
    '', '052025', '2025-01-01', NULL, 'PEN', 1.0,
    2965.00, 0.0, 'pendiente',
    'F0011129 (RENTA 052025 CREDITO)', '401712 RENTA DE TERCERA CREDITO'
  ),

  -- [73] Renta 3ra crédito 2024
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20600842995'),
    '', '2024', '2025-01-01', NULL, 'PEN', 1.0,
    18719.00, 0.0, 'pendiente',
    'F0011167 (RENTA 2024)', '401712 RENTA DE TERCERA CREDITO'
  ),

  -- [74] Renta 3ra crédito 042025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20600842995'),
    '', '042025', '2025-01-01', NULL, 'PEN', 1.0,
    2230.00, 0.0, 'pendiente',
    'F0011112 (RENTA 042025 CREDITO)', '401712 RENTA DE TERCERA CREDITO'
  ),

  -- [75] ESSALUD planilla junio
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20600842995'),
    '', 'PLAN-06', '2025-01-01', NULL, 'PEN', 1.0,
    663.57, 0.0, 'pendiente',
    'PLLA/2026/06/0001 (PLANILLA SUELDOS MES JUNIO 2026)', '403111 ESSALUD'
  ),

  -- ═══════════════════════════════════════════
  -- MARINA'S CAR E.I.R.L. — arrendamiento
  -- ═══════════════════════════════════════════

  -- [76]
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20605690875'),
    '', '3664', '2025-01-01', NULL, 'PEN', 1.0,
    38627.00, 0.0, 'pendiente',
    'APERT/2025/01/0003 (ASIENTO DE APERTURA 01/2025 - DETALLE DE [...])', '461111 RECLAMACIONES DE TERCEROS'
  ),

  -- ═══════════════════════════════════════════
  -- ORELLANA RAMIREZ PAUL ANTONIO
  -- ═══════════════════════════════════════════

  -- [77]
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10106117689'),
    '(01) Factura', '00000007', '2026-06-29', '2026-06-29', 'PEN', 1.0,
    425.00, 0.0, 'pendiente',
    'FFFFI-00000007', '421211 EMITIDAS M.N'
  ),

  -- ═══════════════════════════════════════════
  -- PAZ QUICHCA RAUL GREGORIO
  -- ═══════════════════════════════════════════

  -- [78] Retención 2da — cuota 04
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '09373574'),
    '', '00863651', '2025-01-01', NULL, 'PEN', 1.0,
    90.31, 0.0, 'pendiente',
    'BNK1/2026/00154 (PAGO CUOTA 04 PRESTAMO RAUL GREGORIO PAZ QUICHCA)', '401710 RENTA DE SEGUNDA CATEGORÖA'
  ),

  -- [79] Retención 2da — cuota 05
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '09373574'),
    '', '00391718', '2025-01-01', NULL, 'PEN', 1.0,
    90.31, 0.0, 'pendiente',
    'BNK1/2026/00249 (PAGO CUOTA 05 PRESTAMO RAUL GREGORIO PAZ QUICHCA)', '401710 RENTA DE SEGUNDA CATEGORÖA'
  ),

  -- [80] Retención 2da — cuota 06
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '09373574'),
    '', '00568764', '2025-01-01', NULL, 'PEN', 1.0,
    90.31, 0.0, 'pendiente',
    'BNK1/2026/00354 (PAGO CUOTA 06 PRESTAMO RAUL GREGORIO PAZ QUICHCA)', '401710 RENTA DE SEGUNDA CATEGORÖA'
  ),

  -- [81] Retención 2da — cuota 07
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '09373574'),
    '', '00555262', '2025-01-01', NULL, 'PEN', 1.0,
    90.31, 0.0, 'pendiente',
    'BNK1/2026/00450 (PAGO CUOTA 07 PRESTAMO RAUL GREGORIO PAZ QUICHCA)', '401710 RENTA DE SEGUNDA CATEGORÖA'
  ),

  -- [82] Préstamo S/7,000 (saldo parcial: 7000 - 4242.49 = 2757.51 pagado)
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '09373574'),
    '', '00541463', '2025-01-01', NULL, 'PEN', 1.0,
    7000.00, 2757.51, 'parcial',
    'BNK1/2025/00707 (PRESTAMO DE RAUL GREGORIO PAZ QUICHCA S/. 7,000.00)', '469910 PRESTAMOS DIVERSOS POR PAGAR'
  ),

  -- [83] Préstamo S/46,000
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '09373574'),
    '', '00154422', '2025-01-01', NULL, 'PEN', 1.0,
    46000.00, 0.0, 'pendiente',
    'BNK1/2025/00704 (PRESTAMO DE RAUL GREGORIO PAZ QUICHCA S/. [...])', '469910 PRESTAMOS DIVERSOS POR PAGAR'
  ),

  -- [84] Préstamo S/305,459 (F0011171)
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '09373574'),
    '', '211125', '2025-01-01', NULL, 'PEN', 1.0,
    305459.03, 0.0, 'pendiente',
    'F0011171 (PRESTAMO S/ 175M RPQ)', '469910 PRESTAMOS DIVERSOS POR PAGAR'
  ),

  -- [85] Préstamo (saldo parcial: 36791.62 - 29836.68 = 6954.94 pagado)
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '09373574'),
    '', '02047111', '2025-01-01', NULL, 'PEN', 1.0,
    36791.62, 6954.94, 'parcial',
    'BNK1/2025/00709 (PRESTAMO DE RAUL GREGORIO PAZ QUICHCA S/. [...])', '469910 PRESTAMOS DIVERSOS POR PAGAR'
  ),

  -- [86] Préstamo USD $11,286 — tc: 38124.11/11286 = 3.379
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '09373574'),
    '', '00238725', '2025-01-01', NULL, 'USD', 3.379,
    38124.11, 0.0, 'pendiente',
    'BNK4/2025/00510 (PRESTAMO DE RAUL GREGORIO PAZ QUICHCA $ 11,286.00)', '469910 PRESTAMOS DIVERSOS POR PAGAR'
  ),

  -- [87] Préstamo S/26,000 (saldo parcial: 26000 - 21757.51 = 4242.49 pagado)
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '09373574'),
    '', '00499064', '2025-01-01', NULL, 'PEN', 1.0,
    26000.00, 4242.49, 'parcial',
    'BNK1/2025/00697 (PRESTAMO DE RAUL GREGORIO PAZ QUICHCA S/. [...])', '469910 PRESTAMOS DIVERSOS POR PAGAR'
  ),

  -- [88] Préstamo USD $2,950 — tc: 10000.5/2950 = 3.390
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '09373574'),
    '', '00160901', '2025-01-01', NULL, 'USD', 3.390,
    10000.50, 0.0, 'pendiente',
    'BNK4/2025/00509 (PRESTAMO DE RAUL GREGORIO PAZ QUICHCA $ 2,950.00)', '469910 PRESTAMOS DIVERSOS POR PAGAR'
  ),

  -- ═══════════════════════════════════════════
  -- PAZ VILCA LUIS ANTONIO — honorarios
  -- ═══════════════════════════════════════════

  -- [89]
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '10726260937'),
    '(02) Recibo por Honorarios', '13', '2026-06-30', '2026-06-30', 'PEN', 1.0,
    1600.00, 0.0, 'pendiente',
    'RE001-13', '424111 HONORARIOS POR PAGAR M.N.'
  ),

  -- ═══════════════════════════════════════════
  -- PROVEEDORES VARIOS — saldo por identificar
  -- saldo=2000.62, monto=5740.62 → pagado=3740
  -- ═══════════════════════════════════════════

  -- [90]
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '9999991'),
    '', '3667', '2025-01-01', NULL, 'PEN', 1.0,
    5740.62, 3740.00, 'parcial',
    'APERT/2025/01/0003 (ASIENTO DE APERTURA 01/2025 - DETALLE DE [...])', '469916 POR IDENTIFICAR'
  ),

  -- ═══════════════════════════════════════════
  -- SUNAT
  -- ═══════════════════════════════════════════

  -- [91] Fraccionamiento Renta 2023 (saldo parcial: 56083 - 41215 = 14868 pagado)
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20131312955'),
    '', '0230173985794', '2025-01-01', NULL, 'PEN', 1.0,
    56083.00, 14868.00, 'parcial',
    'F0011146 (FRACCIONAMIENTO RENTA ANUAL 2023)', '401121 FRACCIONAMIENTO'
  ),

  -- [92] Compensación Renta 2024
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20131312955'),
    '', '0230230871861', '2025-01-01', NULL, 'PEN', 1.0,
    1556.00, 0.0, 'pendiente',
    'F0011197 (COMPENSACIàN RENTA 2024)', '401711 RENTA DE TERCERA CATEGORÖA'
  ),

  -- [93] Rectificación Renta 2023
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20131312955'),
    '', '1005143681', '2025-01-01', NULL, 'PEN', 1.0,
    30666.00, 0.0, 'pendiente',
    'F0011145 (RECTIFICACIàN RENTA ANUAL 2023)', '401711 RENTA DE TERCERA CATEGORÖA'
  ),

  -- [94] Renta 3ra crédito 072025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20131312955'),
    '', '1145642969', '2025-01-01', NULL, 'PEN', 1.0,
    3881.00, 0.0, 'pendiente',
    'F0011152 (RENTA 072025 CREDITO)', '401712 RENTA DE TERCERA CREDITO'
  ),

  -- [95] Renta 3ra crédito 082025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20131312955'),
    '', '1149610597', '2025-01-01', NULL, 'PEN', 1.0,
    5974.00, 0.0, 'pendiente',
    'F0011158 (RENTA 082025 CREDITO)', '401712 RENTA DE TERCERA CREDITO'
  ),

  -- [96] Renta 3ra crédito 092025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20131312955'),
    '', '1154826403', '2025-01-01', NULL, 'PEN', 1.0,
    3899.00, 0.0, 'pendiente',
    'F0011170 (RENTA 092025 CREDITO)', '401712 RENTA DE TERCERA CREDITO'
  ),

  -- [97] Renta 3ra crédito 102025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20131312955'),
    '', '102025', '2025-01-01', NULL, 'PEN', 1.0,
    3525.00, 0.0, 'pendiente',
    'F0011174 (RENTA 102025 CREDITO)', '401712 RENTA DE TERCERA CREDITO'
  ),

  -- [98] Renta 3ra crédito 112025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20131312955'),
    '', '112025', '2025-01-01', NULL, 'PEN', 1.0,
    7233.00, 0.0, 'pendiente',
    'F0011184 (RENTA 112025 CREDITO)', '401712 RENTA DE TERCERA CREDITO'
  ),

  -- [99] Renta 3ra crédito 062025
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20131312955'),
    '', '1142102378', '2025-01-01', NULL, 'PEN', 1.0,
    4830.00, 0.0, 'pendiente',
    'F0011142 (RENTA 062025 CREDITO - RENTA 062025 CREDITO)', '401712 RENTA DE TERCERA CREDITO'
  ),

  -- [100] Fraccionamiento tributario cuota 48
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '20131312955'),
    '', '48', '2025-01-01', '2030-04-30', 'PEN', 1.0,
    900.06, 0.0, 'pendiente',
    'VARIOS/2026/04/00004 (FRACCIONAMIENTO TRIBUTARIO Nø 0230200394917 [...])', '469913 FRACCIONAMIENTO'
  ),

  -- ═══════════════════════════════════════════
  -- TONG XIN TEXTIE IDUSTRIES LIMITED
  -- ═══════════════════════════════════════════

  -- [101]
  (
    (SELECT id FROM public.contacts WHERE nro_documento = 'CH000000002'),
    '', '2023001', '2025-01-01', NULL, 'PEN', 1.0,
    550002.19, 0.0, 'pendiente',
    'APERT/2025/01/0003 (ASIENTO DE APERTURA 01/2025 - DETALLE DE [...])', '421211 EMITIDAS M.N'
  ),

  -- ═══════════════════════════════════════════
  -- VACACIONES 2022 (saldo histórico de vacaciones anteriores)
  -- ═══════════════════════════════════════════

  -- [102]
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '9999992'),
    '', '201', '2025-01-01', NULL, 'PEN', 1.0,
    1735.67, 0.0, 'pendiente',
    'APERT/2025/01/0003 (ASIENTO DE APERTURA 01/2025 - DETALLE DE [...])', '411511 VACACIONES POR PAGAR'
  ),

  -- ═══════════════════════════════════════════
  -- VILCA JAMBOY MARIA ELENA
  -- ═══════════════════════════════════════════

  -- [103] AFP Profuturo
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08150584'),
    '', 'PLAN-06', '2025-01-01', NULL, 'PEN', 1.0,
    297.10, 0.0, 'pendiente',
    'PLLA/2026/06/0001 (PLANILLA SUELDOS MES JUNIO 2026)', '407111 AFP RPOFUTURO'
  ),

  -- [104] Sueldos
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08150584'),
    '', 'PLAN-06', '2025-01-01', NULL, 'PEN', 1.0,
    2315.90, 0.0, 'pendiente',
    'PLLA/2026/06/0001 (PLANILLA SUELDOS MES JUNIO 2026)', '411111 SUELDOS Y SALARIOS POR PAGAR'
  ),

  -- [105] Vacaciones 2022 histórico
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08150584'),
    '', '202', '2025-01-01', NULL, 'PEN', 1.0,
    108.44, 0.0, 'pendiente',
    'APERT/2025/01/0003 (ASIENTO DE APERTURA 01/2025 - DETALLE DE [...])', '411511 VACACIONES POR PAGAR'
  ),

  -- [106] Prov. vac. junio
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08150584'),
    '', 'VAC-06', '2025-01-01', NULL, 'PEN', 1.0,
    108.88, 0.0, 'pendiente',
    'PLLA/2026/06/0002 (PROVISION VACACIONES MES JUNIO 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [107] Prov. vac. marzo
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08150584'),
    '', 'VAC-03', '2025-01-01', NULL, 'PEN', 1.0,
    108.88, 0.0, 'pendiente',
    'PLLA/2026/03/0002 (PROVISION VACACIONES MES MARZO 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [108] Prov. vac. febrero
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08150584'),
    '', 'VAC-02', '2025-01-01', NULL, 'PEN', 1.0,
    108.88, 0.0, 'pendiente',
    'PLLA/2026/02/0002 (PROVISION VACACIONES MES FEBRERO 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [109] Prov. vac. enero
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08150584'),
    '', 'VAC-01', '2025-01-01', NULL, 'PEN', 1.0,
    108.88, 0.0, 'pendiente',
    'PLLA/2026/01/0002 (PROVISION VACACIONES MES ENERO 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [110] Prov. vac. abril
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08150584'),
    '', 'VAC-04', '2025-01-01', NULL, 'PEN', 1.0,
    108.88, 0.0, 'pendiente',
    'PLLA/2026/04/0002 (PROVISION VACACIONES MES ABRIL 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [111] Prov. vac. mayo
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08150584'),
    '', 'VAC-05', '2025-01-01', NULL, 'PEN', 1.0,
    108.88, 0.0, 'pendiente',
    'PLLA/2026/05/0002 (PROVISION VACACIONES MES MAYO 2026)', '489112 PROVISION PARA VACACIONES'
  ),

  -- [112] Prov. grat. junio
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08150584'),
    '', 'GRAT-06', '2025-01-01', NULL, 'PEN', 1.0,
    217.75, 0.0, 'pendiente',
    'PLLA/2026/06/0004 (PROVISION GRATIFICACION MES JUNIO 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [113] Prov. grat. marzo
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08150584'),
    '', 'GRAT-03', '2025-01-01', NULL, 'PEN', 1.0,
    217.75, 0.0, 'pendiente',
    'PLLA/2026/03/0004 (PROVISION GRATIFICACION MES MARZO 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [114] Prov. grat. enero
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08150584'),
    '', 'GRAT-01', '2025-01-01', NULL, 'PEN', 1.0,
    217.75, 0.0, 'pendiente',
    'PLLA/2026/01/0004 (PROVISION GRATIFICACION MES ENERO 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [115] Prov. grat. mayo
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08150584'),
    '', 'GRAT-05', '2025-01-01', NULL, 'PEN', 1.0,
    217.75, 0.0, 'pendiente',
    'PLLA/2026/05/0004 (PROVISION GRATIFICACION MES MAYO 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [116] Prov. grat. febrero
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08150584'),
    '', 'GRAT-02', '2025-01-01', NULL, 'PEN', 1.0,
    217.75, 0.0, 'pendiente',
    'PLLA/2026/02/0004 (PROVISION GRATIFICACION MES FEBRERO 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [117] Prov. grat. abril
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08150584'),
    '', 'GRAT-04', '2025-01-01', NULL, 'PEN', 1.0,
    217.75, 0.0, 'pendiente',
    'PLLA/2026/04/0004 (PROVISION GRATIFICACION MES ABRIL 2026)', '489113 PROVISION PARA GRATIFICACIONES'
  ),

  -- [118] Prov. CTS junio
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08150584'),
    '', 'CTS-06', '2025-01-01', NULL, 'PEN', 1.0,
    113.39, 0.0, 'pendiente',
    'PLLA/2026/06/0003 (PROVISION CTS MES JUNIO 2026)', '489114 PROVISION PARA COMPENSACION POR TIEMPO DE SERVICIO'
  ),

  -- [119] Prov. CTS mayo
  (
    (SELECT id FROM public.contacts WHERE nro_documento = '08150584'),
    '', 'CTS-05', '2025-01-01', NULL, 'PEN', 1.0,
    113.39, 0.0, 'pendiente',
    'PLLA/2026/05/0003 (PROVISION CTS MES MAYO 2026)', '489114 PROVISION PARA COMPENSACION POR TIEMPO DE SERVICIO'
  )

ON CONFLICT (asiento_odoo, contact_id, referencia_cuenta) WHERE asiento_odoo IS NOT NULL DO UPDATE SET
  monto_total  = EXCLUDED.monto_total,
  monto_pagado = EXCLUDED.monto_pagado,
  estado       = EXCLUDED.estado,
  updated_at   = now();


-- ────────────────────────────────────────────────────────────
-- RESUMEN ESPERADO:
-- 119 registros — 18 proveedores/acreedores únicos
-- Total monto_total ≈ 1,745,459.95 PEN
-- Registros parcialmente pagados: 9 (BCP, PAZ QUICHCA x4, ALPES, PROVEEDORES VARIOS, MAIRELLY, SUNAT fraccionamiento)
-- ────────────────────────────────────────────────────────────

-- Verificar:
-- SELECT c.nombre, COUNT(*) n,
--        SUM(cp.monto_total) total_original,
--        SUM(cp.monto_pagado) total_pagado,
--        SUM(cp.monto_total - cp.monto_pagado) saldo_pendiente
-- FROM cuentas_pagar cp
-- JOIN contacts c ON cp.contact_id = c.id
-- GROUP BY c.nombre
-- ORDER BY saldo_pendiente DESC;
