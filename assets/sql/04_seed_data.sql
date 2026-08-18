-- ============================================================
-- JHIRO ERP v2 — DATOS SEMILLA
-- Archivo: 04_seed_data.sql
-- Ejecutar ÚLTIMO (después de 01, 02, 03)
-- Incluye: tipo_documentos SUNAT, plan_cuentas PCGE Perú,
--          diarios de asientos automáticos, período inicial.
-- ============================================================

-- ============================================================
-- 1. TIPOS DE DOCUMENTOS SUNAT
-- ============================================================

INSERT INTO public.tipo_documentos (id, name, electronic, active) VALUES
  ('01', 'Factura',                              true,  true),
  ('03', 'Boleta de Venta',                      true,  true),
  ('07', 'Nota de Crédito',                      true,  true),
  ('08', 'Nota de Débito',                       true,  true),
  ('09', 'Guía de Remisión Remitente',           false, true),
  ('12', 'Ticket de Máquina Registradora',       false, true),
  ('18', 'Documento Emitido por AFP',            false, true),
  ('20', 'Comprobante de Retención',             false, true),
  ('31', 'Guía de Remisión Transportista',       false, true),
  ('40', 'Comprobante de Percepción',            false, true),
  ('50', 'Declaración Única de Aduanas (DUA)',   false, true),
  ('52', 'Despacho Simplificado Importación',    false, true),
  ('91', 'Comprobante de Pago No Domiciliado',   false, true),
  ('97', 'Nota de Crédito Especial',             false, false),
  ('98', 'Nota de Débito Especial',              false, false),
  ('02', 'Recibo por Honorarios',                true,  true),
  ('14', 'Recibo de Servicios Públicos',         false, true),
  ('NE', 'No Especificado / Otro',               false, true)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, electronic = EXCLUDED.electronic;


-- ============================================================
-- 2. PLAN DE CUENTAS PCGE PERÚ (cuentas principales del ERP)
-- Solo cuentas movibles (nivel 5 o más) usadas en un importador/distribuidor peruano.
-- Agregar más cuentas según necesidades específicas.
-- ============================================================
-- Columnas: codigo, nombre, tipo, categoria_balance, nivel, codigo_padre,
--           moneda, permite_conciliacion, grupo_reporte, subgrupo, subgrupo_fino,
--           naturaleza_saldo, activo
-- ============================================================

INSERT INTO public.plan_cuentas
  (codigo, nombre, tipo, categoria_balance, nivel, codigo_padre, moneda,
   permite_conciliacion, grupo_reporte, subgrupo, subgrupo_fino, naturaleza_saldo, activo)
VALUES

-- =========================================================
-- ELEMENTO 1: ACTIVO CORRIENTE
-- =========================================================

-- 10 EFECTIVO Y EQUIVALENTES
('10111','Caja General PEN',     'Activo','Balance',5,'101','PEN',true,'Activo','Activo Corriente','Efectivo y Equivalentes','deudor',true),
('10121','Fondos Fijos PEN',     'Activo','Balance',5,'101','PEN',false,'Activo','Activo Corriente','Efectivo y Equivalentes','deudor',true),
('10411','Ctas Ctes BCP PEN',   'Activo','Balance',5,'104','PEN',true,'Activo','Activo Corriente','Efectivo y Equivalentes','deudor',true),
('10412','Ctas Ctes BBVA PEN',  'Activo','Balance',5,'104','PEN',true,'Activo','Activo Corriente','Efectivo y Equivalentes','deudor',true),
('10413','Ctas Ctes BCP USD',   'Activo','Balance',5,'104','USD',true,'Activo','Activo Corriente','Efectivo y Equivalentes','deudor',true),
('10421','Ctas Ahorro BCP PEN', 'Activo','Balance',5,'104','PEN',true,'Activo','Activo Corriente','Efectivo y Equivalentes','deudor',true),
('10491','Detracciones SUNAT',  'Activo','Balance',5,'104','PEN',true,'Activo','Activo Corriente','Efectivo y Equivalentes','deudor',true),

-- 12 CUENTAS POR COBRAR COMERCIALES - TERCEROS
('12111','Facturas por Cobrar PEN',  'Activo','Balance',5,'121','PEN',true,'Activo','Activo Corriente','Cuentas por Cobrar','deudor',true),
('12112','Facturas por Cobrar USD',  'Activo','Balance',5,'121','USD',true,'Activo','Activo Corriente','Cuentas por Cobrar','deudor',true),
('12131','Letras por Cobrar',        'Activo','Balance',5,'121','PEN',true,'Activo','Activo Corriente','Cuentas por Cobrar','deudor',true),

-- 14 CUENTAS POR COBRAR DIVERSAS - TERCEROS
('14111','Anticipo a Proveedores PEN','Activo','Balance',5,'141','PEN',true,'Activo','Activo Corriente','Otras Cuentas por Cobrar','deudor',true),
('14112','Anticipo a Proveedores USD','Activo','Balance',5,'141','USD',true,'Activo','Activo Corriente','Otras Cuentas por Cobrar','deudor',true),

-- 16 CUENTAS POR COBRAR DIVERSAS (IGV Crédito Fiscal)
('16111','Préstamos Otorgados','Activo','Balance',5,'161','PEN',false,'Activo','Activo Corriente','Otras Cuentas por Cobrar','deudor',true),

-- 18 SERVICIOS PAGADOS POR ANTICIPADO
('18111','Seguros Pagados por Anticipado','Activo','Balance',5,'181','PEN',false,'Activo','Activo Corriente','Gastos Pagados por Anticipado','deudor',true),
('18112','Flete Pagado por Anticipado',   'Activo','Balance',5,'181','PEN',false,'Activo','Activo Corriente','Gastos Pagados por Anticipado','deudor',true),

-- 20 MERCADERÍAS
('20111','Mercaderías PEN (al costo)',     'Activo','Balance',5,'201','PEN',false,'Activo','Activo Corriente','Inventarios','deudor',true),
('20112','Mercaderías USD (al costo)',     'Activo','Balance',5,'201','USD',false,'Activo','Activo Corriente','Inventarios','deudor',true),
('20113','Mercaderías en Tránsito',        'Activo','Balance',5,'201','USD',false,'Activo','Activo Corriente','Inventarios','deudor',true),

-- 28 EXISTENCIAS POR RECIBIR
('28111','Mercaderías en Tránsito CIF',   'Activo','Balance',5,'281','USD',false,'Activo','Activo Corriente','Inventarios','deudor',true),

-- 29 DESVALORIZACIÓN DE EXISTENCIAS
('29111','Desvalorización Mercaderías',   'Activo','Balance',5,'291','PEN',false,'Activo','Activo Corriente','Inventarios','acreedor',true),

-- =========================================================
-- ELEMENTO 3: ACTIVO NO CORRIENTE
-- =========================================================

-- 33 INMUEBLES, MAQUINARIA Y EQUIPO
('33111','Terrenos',            'Activo','Balance',5,'331','PEN',false,'Activo','Activo No Corriente','Activo Fijo','deudor',true),
('33211','Edificios y Locales', 'Activo','Balance',5,'332','PEN',false,'Activo','Activo No Corriente','Activo Fijo','deudor',true),
('33411','Muebles y Enseres',   'Activo','Balance',5,'334','PEN',false,'Activo','Activo No Corriente','Activo Fijo','deudor',true),
('33511','Equipos de Cómputo',  'Activo','Balance',5,'335','PEN',false,'Activo','Activo No Corriente','Activo Fijo','deudor',true),
('33611','Equipos Diversos',    'Activo','Balance',5,'336','PEN',false,'Activo','Activo No Corriente','Activo Fijo','deudor',true),
('33711','Unidades de Transporte','Activo','Balance',5,'337','PEN',false,'Activo','Activo No Corriente','Activo Fijo','deudor',true),

-- 39 DEPRECIACIÓN
('39131','Depr. Edif. y Locales Acum.',   'Activo','Balance',5,'391','PEN',false,'Activo','Activo No Corriente','Activo Fijo','acreedor',true),
('39141','Depr. Muebles y Enseres Acum.', 'Activo','Balance',5,'391','PEN',false,'Activo','Activo No Corriente','Activo Fijo','acreedor',true),
('39151','Depr. Equip. Cómputo Acum.',    'Activo','Balance',5,'391','PEN',false,'Activo','Activo No Corriente','Activo Fijo','acreedor',true),
('39161','Depr. Equip. Diversos Acum.',   'Activo','Balance',5,'391','PEN',false,'Activo','Activo No Corriente','Activo Fijo','acreedor',true),
('39171','Depr. Unid. Transporte Acum.',  'Activo','Balance',5,'391','PEN',false,'Activo','Activo No Corriente','Activo Fijo','acreedor',true),

-- =========================================================
-- ELEMENTO 4: PASIVO
-- =========================================================

-- 40 TRIBUTOS POR PAGAR
('40111','IGV - Cuenta Propia',       'Pasivo','Balance',5,'401','PEN',false,'Pasivo','Pasivo Corriente','Tributos por Pagar','acreedor',true),
('40171','Retenciones IGV',            'Pasivo','Balance',5,'401','PEN',false,'Pasivo','Pasivo Corriente','Tributos por Pagar','acreedor',true),
('40181','Percepciones IGV',           'Pasivo','Balance',5,'401','PEN',false,'Pasivo','Pasivo Corriente','Tributos por Pagar','acreedor',true),
('40111C','IGV Crédito Fiscal',        'Activo','Balance',5,'401','PEN',false,'Activo','Activo Corriente','IGV Crédito Fiscal','deudor',true),
('40151','Renta 3ra Categoría',        'Pasivo','Balance',5,'401','PEN',false,'Pasivo','Pasivo Corriente','Tributos por Pagar','acreedor',true),
('40311','ESSALUD por Pagar',           'Pasivo','Balance',5,'403','PEN',false,'Pasivo','Pasivo Corriente','Tributos por Pagar','acreedor',true),
('40711','AFP/ONP por Pagar',           'Pasivo','Balance',5,'407','PEN',false,'Pasivo','Pasivo Corriente','Tributos por Pagar','acreedor',true),
('40141','Ad Valorem Aduanas',         'Pasivo','Balance',5,'401','PEN',false,'Pasivo','Pasivo Corriente','Tributos por Pagar','acreedor',true),

-- 41 REMUNERACIONES Y PARTICIPACIONES POR PAGAR
('41111','Sueldos y Salarios por Pagar','Pasivo','Balance',5,'411','PEN',false,'Pasivo','Pasivo Corriente','Remuneraciones','acreedor',true),
('41211','Vacaciones por Pagar',        'Pasivo','Balance',5,'412','PEN',false,'Pasivo','Pasivo Corriente','Remuneraciones','acreedor',true),
('41311','CTS por Pagar',               'Pasivo','Balance',5,'413','PEN',false,'Pasivo','Pasivo Corriente','Remuneraciones','acreedor',true),

-- 42 CUENTAS POR PAGAR COMERCIALES - TERCEROS
('42111','Facturas por Pagar PEN',     'Pasivo','Balance',5,'421','PEN',true,'Pasivo','Pasivo Corriente','Cuentas por Pagar','acreedor',true),
('42122','Facturas por Pagar USD',     'Pasivo','Balance',5,'421','USD',true,'Pasivo','Pasivo Corriente','Cuentas por Pagar','acreedor',true),
('42131','Letras por Pagar PEN',       'Pasivo','Balance',5,'421','PEN',true,'Pasivo','Pasivo Corriente','Cuentas por Pagar','acreedor',true),

-- 44 CUENTAS POR PAGAR DIVERSAS
('44111','Anticipo Recibido de Clientes','Pasivo','Balance',5,'441','PEN',false,'Pasivo','Pasivo Corriente','Otras Cuentas por Pagar','acreedor',true),

-- 45 OBLIGACIONES FINANCIERAS
('45111','Préstamos Bancarios PEN',    'Pasivo','Balance',5,'451','PEN',false,'Pasivo','Pasivo Corriente','Obligaciones Financieras','acreedor',true),
('45112','Préstamos Bancarios USD',    'Pasivo','Balance',5,'451','USD',false,'Pasivo','Pasivo Corriente','Obligaciones Financieras','acreedor',true),

-- 46 CUENTAS POR PAGAR DIVERSAS
('46111','Dividendos por Pagar',       'Pasivo','Balance',5,'461','PEN',false,'Pasivo','Pasivo Corriente','Otras Cuentas por Pagar','acreedor',true),

-- =========================================================
-- ELEMENTO 5: PATRIMONIO
-- =========================================================
('50111','Capital Social',             'Patrimonio','Balance',5,'501','PEN',false,'Patrimonio','Patrimonio','Capital','acreedor',true),
('58111','Reserva Legal',              'Patrimonio','Balance',5,'581','PEN',false,'Patrimonio','Patrimonio','Reservas','acreedor',true),
('59111','Resultados Acumulados',      'Patrimonio','Balance',5,'591','PEN',false,'Patrimonio','Patrimonio','Resultados','acreedor',true),
('59211','Utilidad / Pérdida Ej. Ant.','Patrimonio','Balance',5,'592','PEN',false,'Patrimonio','Patrimonio','Resultados','acreedor',true),

-- =========================================================
-- ELEMENTO 6: GASTOS POR NATURALEZA
-- =========================================================

-- 60 COMPRAS
('601111','Compras Mercaderías PEN',   'Gasto','Resultado',6,'6011','PEN',false,'Resultado','Gastos','Compras','deudor',true),
('601112','Compras Mercaderías USD',   'Gasto','Resultado',6,'6011','USD',false,'Resultado','Gastos','Compras','deudor',true),

-- 61 VARIACIÓN DE INVENTARIOS
('611511','Variación Existencias - Mercaderías','Gasto','Resultado',5,'615','PEN',false,'Resultado','Costos','Variación Inventarios','acreedor',true),

-- 62 GASTOS DE PERSONAL
('621111','Sueldos Administración',    'Gasto','Resultado',5,'621','PEN',false,'Resultado','Gastos','Gastos Personal','deudor',true),
('621112','Sueldos Ventas',            'Gasto','Resultado',5,'621','PEN',false,'Resultado','Gastos','Gastos Personal','deudor',true),
('627111','Seguridad Social (ESSALUD)','Gasto','Resultado',5,'627','PEN',false,'Resultado','Gastos','Gastos Personal','deudor',true),
('628111','AFP / ONP',                 'Gasto','Resultado',5,'628','PEN',false,'Resultado','Gastos','Gastos Personal','deudor',true),

-- 63 GASTOS DE SERVICIOS PRESTADOS POR TERCEROS
('631111','Transporte de Carga Local', 'Gasto','Resultado',5,'631','PEN',false,'Resultado','Gastos','Servicios Terceros','deudor',true),
('632111','Asesoría Contable',         'Gasto','Resultado',5,'632','PEN',false,'Resultado','Gastos','Servicios Terceros','deudor',true),
('636111','Servicios Legales',         'Gasto','Resultado',5,'636','PEN',false,'Resultado','Gastos','Servicios Terceros','deudor',true),
('638111','Otros Servicios Terceros',  'Gasto','Resultado',5,'638','PEN',false,'Resultado','Gastos','Servicios Terceros','deudor',true),
('638211','Servicios de Aduana',       'Gasto','Resultado',5,'638','PEN',false,'Resultado','Gastos','Servicios Terceros','deudor',true),

-- 64 GASTOS POR TRIBUTOS
('641111','IGV sin Crédito Fiscal',    'Gasto','Resultado',5,'641','PEN',false,'Resultado','Gastos','Tributos','deudor',true),
('641211','Aranceles Aduaneros',       'Gasto','Resultado',5,'641','PEN',false,'Resultado','Gastos','Tributos','deudor',true),
('641311','ITF',                       'Gasto','Resultado',5,'641','PEN',false,'Resultado','Gastos','Tributos','deudor',true),

-- 65 OTROS GASTOS DE GESTIÓN
('651111','Almacenaje y Depósito',     'Gasto','Resultado',5,'651','PEN',false,'Resultado','Gastos','Otros Gastos Gestión','deudor',true),
('659111','Gastos Varios de Gestión',  'Gasto','Resultado',5,'659','PEN',false,'Resultado','Gastos','Otros Gastos Gestión','deudor',true),

-- 67 GASTOS FINANCIEROS
('671111','Intereses por Préstamos',   'Gasto','Resultado',5,'671','PEN',false,'Resultado','Gastos','Gastos Financieros','deudor',true),
('672111','Comisiones Bancarias',      'Gasto','Resultado',5,'672','PEN',false,'Resultado','Gastos','Gastos Financieros','deudor',true),
('676111','Diferencia de Cambio',      'Gasto','Resultado',5,'676','PEN',false,'Resultado','Gastos','Gastos Financieros','deudor',true),

-- 68 DEPRECIACIÓN
('681111','Depr. Edif. y Locales',     'Gasto','Resultado',5,'681','PEN',false,'Resultado','Gastos','Depreciación','deudor',true),
('681211','Depr. Muebles y Enseres',   'Gasto','Resultado',5,'681','PEN',false,'Resultado','Gastos','Depreciación','deudor',true),
('681311','Depr. Equip. de Cómputo',   'Gasto','Resultado',5,'681','PEN',false,'Resultado','Gastos','Depreciación','deudor',true),
('681411','Depr. Equip. Diversos',     'Gasto','Resultado',5,'681','PEN',false,'Resultado','Gastos','Depreciación','deudor',true),
('681511','Depr. Unid. Transporte',    'Gasto','Resultado',5,'681','PEN',false,'Resultado','Gastos','Depreciación','deudor',true),

-- 69 COSTO DE VENTAS
('691111','Costo de Ventas Mercaderías PEN','Gasto','Resultado',5,'691','PEN',false,'Resultado','Costos','Costo de Ventas','deudor',true),
('691112','Costo de Ventas Mercaderías USD','Gasto','Resultado',5,'691','USD',false,'Resultado','Costos','Costo de Ventas','deudor',true),

-- =========================================================
-- ELEMENTO 7: INGRESOS
-- =========================================================
('701111','Ventas Mercaderías PEN',    'Ingreso','Resultado',5,'701','PEN',false,'Resultado','Ingresos','Ventas','acreedor',true),
('701112','Ventas Mercaderías USD',    'Ingreso','Resultado',5,'701','USD',false,'Resultado','Ingresos','Ventas','acreedor',true),
('707111','Descuentos Concedidos',     'Ingreso','Resultado',5,'707','PEN',false,'Resultado','Ingresos','Ventas','deudor',true),
('756111','Ganancia por Dif. Cambio',  'Ingreso','Resultado',5,'756','PEN',false,'Resultado','Ingresos','Ingresos Financieros','acreedor',true),
('779111','Otros Ingresos de Gestión', 'Ingreso','Resultado',5,'779','PEN',false,'Resultado','Ingresos','Otros Ingresos','acreedor',true)

ON CONFLICT (codigo) DO UPDATE SET
  nombre = EXCLUDED.nombre,
  tipo = EXCLUDED.tipo,
  activo = EXCLUDED.activo;


-- ============================================================
-- 3. DIARIOS (plantillas de asientos automáticos)
-- Formula usa marcadores %variable%: %subtotal%, %igv%, %total%,
--   %monto%, %costo_mercaderia%, %derechos%, etc.
-- tipo: 'debe' o 'haber'
-- ============================================================

-- Limpiar diarios existentes para reinsertar completos
TRUNCATE public.diario_lineas CASCADE;
TRUNCATE public.diarios CASCADE;

-- ---- COMPRA NACIONAL (factura proveedor domiciliado, mercadería gravada) ----
INSERT INTO public.diarios (nombre, tipo_movimiento, tipo_documento, moneda, activo)
VALUES ('Compra nacional mercadería', 'Compra', '01', 'PEN', true)
RETURNING id;

-- Usaremos una variable para el id del diario
DO $$
DECLARE v_id integer;
BEGIN

-- Compra nacional mercadería (01 - Factura, PEN)
INSERT INTO public.diarios (nombre, tipo_movimiento, tipo_documento, moneda, activo)
VALUES ('Compra nacional mercadería', 'Compra', '01', 'PEN', true)
RETURNING id INTO v_id;

INSERT INTO public.diario_lineas (diario_id, orden, cuenta_codigo, tipo, formula, descripcion) VALUES
  (v_id, 1, '601111',  'debe',  '%subtotal%', 'Compra mercadería'),
  (v_id, 2, '40111C',  'debe',  '%igv%',      'IGV crédito fiscal'),
  (v_id, 3, '42111',   'haber', '%total%',    'Factura proveedor PEN');

-- Compra USD (mercadería importada, proveedor no domiciliado)
INSERT INTO public.diarios (nombre, tipo_movimiento, tipo_documento, moneda, activo)
VALUES ('Compra importación mercadería', 'Importación', '01', 'USD', true)
RETURNING id INTO v_id;

INSERT INTO public.diario_lineas (diario_id, orden, cuenta_codigo, tipo, formula, descripcion) VALUES
  (v_id, 1, '28111',   'debe',  '%monto%',    'Mercadería en tránsito CIF'),
  (v_id, 2, '42122',   'haber', '%monto%',    'Proveedor extranjero USD');

-- Liquidación DAM / DUA
INSERT INTO public.diarios (nombre, tipo_movimiento, tipo_documento, moneda, activo)
VALUES ('Importación liquidación impuestos', 'Importación', '50', 'PEN', true)
RETURNING id INTO v_id;

INSERT INTO public.diario_lineas (diario_id, orden, cuenta_codigo, tipo, formula, descripcion) VALUES
  (v_id, 1, '641211',  'debe',  '%derechos%', 'Ad valorem / Aranceles'),
  (v_id, 2, '40111C',  'debe',  '%igv%',      'IGV importación crédito fiscal'),
  (v_id, 3, '10411',   'haber', '%total_pagado%', 'Pago liquidación SUNAT aduanas');

-- Ingreso a almacén (Guía de Remisión = movimiento de inventario)
INSERT INTO public.diarios (nombre, tipo_movimiento, tipo_documento, moneda, activo)
VALUES ('Valuación de inventario', 'Guía Remisión', '09', 'PEN', true)
RETURNING id INTO v_id;

INSERT INTO public.diario_lineas (diario_id, orden, cuenta_codigo, tipo, formula, descripcion) VALUES
  (v_id, 1, '20111',   'debe',  '%monto%',    'Ingreso mercadería a almacén'),
  (v_id, 2, '611511',  'haber', '%monto%',    'Variación de existencias');

-- Venta mercadería (Factura, PEN)
INSERT INTO public.diarios (nombre, tipo_movimiento, tipo_documento, moneda, activo)
VALUES ('Venta mercadería factura PEN', 'Venta', '01', 'PEN', true)
RETURNING id INTO v_id;

INSERT INTO public.diario_lineas (diario_id, orden, cuenta_codigo, tipo, formula, descripcion) VALUES
  (v_id, 1, '12111',   'debe',  '%total%',         'Cliente — factura PEN'),
  (v_id, 2, '701111',  'haber', '%subtotal%',       'Ingreso por ventas'),
  (v_id, 3, '40111',   'haber', '%igv%',            'IGV cuenta propia');

-- Venta mercadería (Boleta, PEN)
INSERT INTO public.diarios (nombre, tipo_movimiento, tipo_documento, moneda, activo)
VALUES ('Venta mercadería boleta PEN', 'Venta', '03', 'PEN', true)
RETURNING id INTO v_id;

INSERT INTO public.diario_lineas (diario_id, orden, cuenta_codigo, tipo, formula, descripcion) VALUES
  (v_id, 1, '10111',   'debe',  '%total%',    'Caja — boleta'),
  (v_id, 2, '701111',  'haber', '%subtotal%', 'Ingreso por ventas'),
  (v_id, 3, '40111',   'haber', '%igv%',      'IGV cuenta propia');

-- Costo de ventas (por costo de la mercadería vendida)
INSERT INTO public.diarios (nombre, tipo_movimiento, tipo_documento, moneda, activo)
VALUES ('Costo de ventas mercadería', 'Costo Ventas', NULL, 'PEN', true)
RETURNING id INTO v_id;

INSERT INTO public.diario_lineas (diario_id, orden, cuenta_codigo, tipo, formula, descripcion) VALUES
  (v_id, 1, '691111',  'debe',  '%costo_mercaderia%', 'Costo de ventas'),
  (v_id, 2, '20111',   'haber', '%costo_mercaderia%', 'Salida de inventario');

-- Cobro a cliente (transferencia bancaria)
INSERT INTO public.diarios (nombre, tipo_movimiento, tipo_documento, moneda, activo)
VALUES ('Cobro cliente transferencia', 'Cobro', NULL, 'PEN', true)
RETURNING id INTO v_id;

INSERT INTO public.diario_lineas (diario_id, orden, cuenta_codigo, tipo, formula, descripcion) VALUES
  (v_id, 1, '10411',   'debe',  '%monto%',    'Banco — cobro cliente'),
  (v_id, 2, '12111',   'haber', '%monto%',    'Cuentas por cobrar cliente');

-- Cobro a cliente (efectivo)
INSERT INTO public.diarios (nombre, tipo_movimiento, tipo_documento, moneda, activo)
VALUES ('Cobro cliente efectivo', 'Cobro Efectivo', NULL, 'PEN', true)
RETURNING id INTO v_id;

INSERT INTO public.diario_lineas (diario_id, orden, cuenta_codigo, tipo, formula, descripcion) VALUES
  (v_id, 1, '10111',   'debe',  '%monto%',    'Caja — cobro cliente efectivo'),
  (v_id, 2, '12111',   'haber', '%monto%',    'Cuentas por cobrar cliente');

-- Pago a proveedor nacional (transferencia)
INSERT INTO public.diarios (nombre, tipo_movimiento, tipo_documento, moneda, activo)
VALUES ('Pago proveedor nacional transferencia', 'Pago Proveedor', NULL, 'PEN', true)
RETURNING id INTO v_id;

INSERT INTO public.diario_lineas (diario_id, orden, cuenta_codigo, tipo, formula, descripcion) VALUES
  (v_id, 1, '42111',   'debe',  '%monto%',    'Cancelación factura proveedor PEN'),
  (v_id, 2, '10411',   'haber', '%monto%',    'Banco — pago proveedor');

-- Pago a proveedor extranjero (USD)
INSERT INTO public.diarios (nombre, tipo_movimiento, tipo_documento, moneda, activo)
VALUES ('Pago proveedor extranjero USD', 'Pago Importación', NULL, 'USD', true)
RETURNING id INTO v_id;

INSERT INTO public.diario_lineas (diario_id, orden, cuenta_codigo, tipo, formula, descripcion) VALUES
  (v_id, 1, '42122',   'debe',  '%monto%',    'Cancelación factura proveedor USD'),
  (v_id, 2, '10413',   'haber', '%monto%',    'Banco USD — pago proveedor extranjero');

-- Depreciación mensual
INSERT INTO public.diarios (nombre, tipo_movimiento, tipo_documento, moneda, activo)
VALUES ('Depreciación mensual activos', 'Depreciación', NULL, 'PEN', true)
RETURNING id INTO v_id;

INSERT INTO public.diario_lineas (diario_id, orden, cuenta_codigo, tipo, formula, descripcion) VALUES
  (v_id, 1, 'CUENTA_GASTO', 'debe',  '%monto%', 'Gasto depreciación — seleccionar cuenta'),
  (v_id, 2, 'CUENTA_GASTO', 'haber', '%monto%', 'Depreciación acumulada — seleccionar cuenta');

END $$;


-- ============================================================
-- 4. PERÍODO CONTABLE INICIAL (mes actual)
-- ============================================================

INSERT INTO public.periodos_contables (periodo, ano, mes, estado)
VALUES (TO_CHAR(CURRENT_DATE, 'YYYY-MM'),
        EXTRACT(YEAR FROM CURRENT_DATE)::integer,
        EXTRACT(MONTH FROM CURRENT_DATE)::integer,
        'abierto')
ON CONFLICT (periodo) DO NOTHING;


-- ============================================================
-- 5. USUARIO ADMINISTRADOR INICIAL
-- (cambiar la contraseña inmediatamente después del primer login)
-- La contraseña 'admin123' en bcrypt — cambiar en producción.
-- ============================================================
-- NOTA: En producción usar Supabase Auth en lugar de users tabla.
-- Esta tabla es el sistema de auth legacy del proyecto.
-- ============================================================

INSERT INTO public.users (username, password_hash, nombre, email, role, active)
VALUES ('admin', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhu2', 'Administrador', 'admin@empresa.com', 'admin', true)
ON CONFLICT (username) DO NOTHING;

-- ============================================================
-- VERIFICACIÓN FINAL
-- ============================================================
-- SELECT 'plan_cuentas', COUNT(*) FROM public.plan_cuentas UNION ALL
-- SELECT 'tipo_documentos', COUNT(*) FROM public.tipo_documentos UNION ALL
-- SELECT 'diarios', COUNT(*) FROM public.diarios UNION ALL
-- SELECT 'diario_lineas', COUNT(*) FROM public.diario_lineas;
