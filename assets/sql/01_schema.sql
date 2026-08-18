-- ============================================================
-- JHIRO ERP v2 — SCHEMA COMPLETO (v3 — rewrite 2026-07-06)
-- Archivo: 01_schema.sql
-- Orden de ejecución: 00_grants → 01_schema → 02_functions → 03_rls_policies → 04_seed_data
-- ============================================================
-- CAMBIOS RESPECTO A v2:
--   • journal_entry_lines: entry_id→journal_entry_id, tipo+importe→debe+haber
--     + contact_id, referencia_doc, fecha_vencimiento (ledger CxC/CxP)
--   • journal_entries: columna 'numero' renombrada a 'numero_asiento'
--   • items.tipo_item agrega 'otro' (gastos sin detalle de producto)
--   • lotes: agrega costo_estado, costo_unitario_provisional, carpeta_id, almacen_id
--   • kardex: agrega almacen_id, almacen_destino_id
--   • cuentas_cobrar: agrega asiento_odoo, moneda, monto_me, saldo_me
--   • cuentas_pagar: ahora en schema base (antes en 05_schema_changes.sql)
--   • pagos_proveedores: agrega cxp_id
--   • NUEVAS TABLAS: empresa_config, almacenes, ubicaciones,
--                    letras_cambio, carpetas_importacion
--   • ELIMINADAS: costeo_gastos_despacho, costeo_gastos_financieros,
--                 costeo_productos_fob (sin referencias en frontend)
-- ============================================================
-- NOTA MULTI-EMPRESA: proyecto Supabase separado por RUC.
-- Este mismo schema se aplica a cada proyecto.
-- ============================================================

-- ============================================================
-- EXTENSIONES
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. CONFIGURACIÓN DE EMPRESA
-- ============================================================
CREATE TABLE IF NOT EXISTS public.empresa_config (
  id                    serial      PRIMARY KEY,
  ruc                   varchar(11) NOT NULL UNIQUE,
  razon_social          varchar     NOT NULL,
  nombre_comercial      varchar     NOT NULL,
  direccion             varchar     NOT NULL,
  ubigeo                varchar,
  distrito              varchar,
  provincia             varchar,
  departamento          varchar,
  pais                  varchar     DEFAULT 'PE',
  telefono              varchar,
  email                 varchar,
  logo_url              text,
  -- Tributación (LIR / IGV)
  regimen_tributario    varchar     DEFAULT 'RG'
                          CHECK (regimen_tributario IN ('RG','RMT','RER','NRUS')),
  tipo_contribuyente    varchar,
  igv_porcentaje        numeric     DEFAULT 18,
  moneda_base           varchar     DEFAULT 'PEN',
  -- Método de valuación autorizado (LIR Art. 62°)
  metodo_valuacion      varchar     DEFAULT 'identificacion_especifica'
                          CHECK (metodo_valuacion IN ('identificacion_especifica','promedio_ponderado','peps','ueps')),
  -- Facturación electrónica NUBEFACT
  nubefact_token        varchar,
  nubefact_ambiente     varchar     DEFAULT 'demo' CHECK (nubefact_ambiente IN ('demo','produccion')),
  nubefact_ruc          varchar,
  -- Series de comprobantes
  serie_factura         varchar     DEFAULT 'F001',
  serie_boleta          varchar     DEFAULT 'B001',
  serie_nc_factura      varchar     DEFAULT 'FC01',
  serie_nc_boleta       varchar     DEFAULT 'BC01',
  serie_nd_factura      varchar     DEFAULT 'FD01',
  -- Cuentas contables default (PCGE)
  cuenta_cxc_facturas   varchar     DEFAULT '121111',
  cuenta_cxp_facturas   varchar     DEFAULT '421111',
  cuenta_ventas_gravadas varchar     DEFAULT '701111',
  cuenta_igv_ventas     varchar     DEFAULT '401111',
  cuenta_igv_compras    varchar     DEFAULT '401111',
  cuenta_caja           varchar     DEFAULT '101',
  updated_at            timestamptz DEFAULT now()
);

COMMENT ON TABLE public.empresa_config IS
  'Configuración global de la empresa. Una sola fila por proyecto Supabase (un proyecto = una empresa/RUC).';

-- ============================================================
-- 2. USUARIOS (autenticación propia con bcrypt)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.users (
  id            bigserial   PRIMARY KEY,
  username      varchar     NOT NULL UNIQUE,
  password_hash varchar     NOT NULL,
  nombre        varchar     NOT NULL,
  email         varchar     UNIQUE,
  role          varchar     DEFAULT 'user' CHECK (role IN ('admin','contador','vendedor','almacen','user')),
  active        boolean     DEFAULT true,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  login         boolean,
  log_time      timestamptz
);

-- ============================================================
-- 3. CONTACTOS (Clientes, Proveedores, Ambos)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.contacts (
  id              bigserial   PRIMARY KEY,
  nombre          varchar     NOT NULL,
  tipo_documento  varchar     NOT NULL CHECK (tipo_documento IN ('RUC','DNI','CE','pasaporte','otro','NN')),
  nro_documento   varchar     NOT NULL UNIQUE,
  tipo_contacto   varchar     NOT NULL CHECK (tipo_contacto IN ('cliente','proveedor','ambos','empleado','otro')),
  direccion       varchar     NOT NULL DEFAULT '',
  distrito        varchar     NOT NULL DEFAULT '',
  email           varchar,
  numero          varchar     NOT NULL DEFAULT '0',
  activo          boolean     DEFAULT true,
  pais            varchar     NOT NULL DEFAULT 'Perú',
  telefono        varchar,
  -- Para facturación electrónica SUNAT
  condicion       varchar,    -- 'HABIDO','NO HABIDO'
  estado          varchar,    -- 'ACTIVO','BAJA DE OFICIO',...
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- ============================================================
-- 4. CATÁLOGO — CATEGORÍAS Y MARCAS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.categorias (
  id          bigserial   PRIMARY KEY,
  nombre      varchar     NOT NULL UNIQUE,
  descripcion text,
  activo      boolean     DEFAULT true,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.marcas (
  id          bigserial   PRIMARY KEY,
  nombre      varchar     NOT NULL UNIQUE,
  descripcion text,
  pais_origen varchar,
  activo      boolean     DEFAULT true,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- ============================================================
-- 5. ARTÍCULOS (Items)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.items (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku             varchar     UNIQUE CHECK (sku IS NULL OR sku <> ''),
  nombre          varchar     NOT NULL CHECK (nombre <> ''),
  descripcion     text,
  tipo_item       varchar     NOT NULL
                    CHECK (tipo_item IN ('mercaderia','servicio','otro')),
                    -- mercaderia: tiene lotes y kardex
                    -- servicio:   sin lotes, sin kardex
                    -- otro:       gastos genéricos sin detalle de producto
  categoria_id    bigint      NOT NULL REFERENCES public.categorias(id),
  marca_id        bigint      REFERENCES public.marcas(id),
  unidad_medida   varchar     NOT NULL DEFAULT 'KG',  -- KG siempre para textiles
  -- Costeo (LIR Art. 35 / Art. 62°)
  costo_promedio  numeric     DEFAULT 0,   -- costo promedio ponderado (actualizado por kardex)
  precio_venta    numeric     DEFAULT 0,
  stock_actual    numeric     DEFAULT 0,   -- actualizado por kardex
  activo          boolean     DEFAULT true,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

COMMENT ON COLUMN public.items.tipo_item IS
  'mercaderia: tiene lotes y kardex. servicio: sin lotes ni kardex. otro: gastos genéricos.';

-- ============================================================
-- 6. ALMACENES Y UBICACIONES (multi-almacén)
-- ============================================================
-- LIR Art. 35: el kardex debe identificar el almacén.
-- GRE SUNAT RS 000262-2023: se requiere GRE para traslados entre
-- diferentes establecimientos (diferentes ubigeos / direcciones).
CREATE TABLE IF NOT EXISTS public.almacenes (
  id                        serial      PRIMARY KEY,
  codigo                    varchar     NOT NULL UNIQUE,
  nombre                    varchar     NOT NULL,
  direccion                 varchar     NOT NULL,
  ubigeo                    varchar,
  establecimiento_sunat     varchar,    -- código SUNAT del establecimiento
  es_principal              boolean     DEFAULT false,
  activo                    boolean     DEFAULT true,
  created_at                timestamptz DEFAULT now()
);

COMMENT ON TABLE public.almacenes IS
  'Almacenes fiscales. Traslados entre distintos almacenes requieren GRE (RS 000262-2023/SUNAT).';

CREATE TABLE IF NOT EXISTS public.ubicaciones (
  id          serial      PRIMARY KEY,
  almacen_id  integer     NOT NULL REFERENCES public.almacenes(id),
  codigo      varchar     NOT NULL,
  nombre      varchar     NOT NULL,
  tipo        varchar     DEFAULT 'zona' CHECK (tipo IN ('zona','rack','pasillo','otro')),
  activo      boolean     DEFAULT true,
  created_at  timestamptz DEFAULT now(),
  UNIQUE (almacen_id, codigo)
);

-- ============================================================
-- 7. LOTES DE INVENTARIO (identificación específica — LIR Art. 62°)
-- ============================================================
-- Cada lote tiene su propio costo unitario.
-- El costo puede ser provisional (solo CIF) hasta que la carpeta de
-- importación se cierre y se calcule el factor definitivo.
CREATE TABLE IF NOT EXISTS public.lotes (
  id                          bigserial   PRIMARY KEY,
  item_id                     bigint      NOT NULL REFERENCES public.items(id),
  proveedor_id                bigint      REFERENCES public.contacts(id),
  numero_lote                 varchar     NOT NULL UNIQUE,
  -- Documentos de origen
  numero_factura              varchar,
  dua_numero                  varchar,    -- número DUA cuando es importación
  -- Costeo (LIR Art. 62°)
  costo_unitario              numeric     NOT NULL DEFAULT 0,  -- costo vigente (provisional o definitivo)
  costo_unitario_provisional  numeric     DEFAULT 0,           -- costo provisional (solo CIF)
  costo_estado                varchar     DEFAULT 'definitivo'
                                CHECK (costo_estado IN ('provisional','definitivo')),
  -- Cantidades
  cantidad                    numeric     NOT NULL DEFAULT 0,
  cantidad_unidades           numeric     NOT NULL DEFAULT 0,
  peso_por_unidad             numeric,   -- kg por unidad (cuerda, cono, etc.)
  -- Almacén y ubicación
  almacen_id                  integer     REFERENCES public.almacenes(id),
  ubicacion_id                integer     REFERENCES public.ubicaciones(id),
  -- Carpeta de importación (si aplica)
  carpeta_importacion_id      bigint,    -- FK diferida a carpetas_importacion (creada abajo)
  -- Fechas
  fecha_ingreso               date,
  fecha_vencimiento           date,      -- NULL para textiles (no vence)
  -- Trazabilidad
  partida_id                  bigint,    -- FK lógica a partidas arancelarias
  created_by                  bigint      REFERENCES public.users(id),
  created_at                  timestamptz DEFAULT now(),
  updated_at                  timestamptz DEFAULT now()
);

COMMENT ON COLUMN public.lotes.costo_estado IS
  'provisional: folder de importación aún no cerrado. Al cierre se ajusta a definitivo (NIC 8 párr. 36).';
COMMENT ON COLUMN public.lotes.costo_unitario IS
  'Costo vigente en PEN/kg. Si costo_estado=provisional, este es el CIF; al cierre se actualiza al costo final.';

-- ============================================================
-- 8. PLAN DE CUENTAS (PCGE Perú)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.plan_cuentas (
  id                   serial      PRIMARY KEY,
  codigo               text        NOT NULL UNIQUE,
  nombre               text        NOT NULL,
  tipo                 varchar     NOT NULL,  -- 'Activo','Pasivo','Patrimonio','Ingreso','Gasto','Costo'
  categoria_balance    varchar     NOT NULL DEFAULT 'Balance',
  nivel                smallint    NOT NULL,
  codigo_padre         varchar,
  moneda               varchar     NOT NULL DEFAULT 'PEN',
  permite_conciliacion boolean     NOT NULL DEFAULT false,
  grupo_reporte        varchar     NOT NULL,  -- 'Activo','Pasivo','Patrimonio','Resultado'
  subgrupo             varchar     NOT NULL,
  subgrupo_fino        varchar     NOT NULL,
  naturaleza_saldo     varchar     NOT NULL CHECK (naturaleza_saldo IN ('deudor','acreedor')),
  saldo_debe           numeric     NOT NULL DEFAULT 0,
  saldo_haber          numeric     NOT NULL DEFAULT 0,
  activo               boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 9. PERIODOS CONTABLES (bloqueo de meses cerrados)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.periodos_contables (
  id          serial      PRIMARY KEY,
  periodo     varchar(7)  NOT NULL UNIQUE,  -- 'YYYY-MM'
  ano         integer     NOT NULL,
  mes         integer     NOT NULL CHECK (mes BETWEEN 1 AND 12),
  estado      varchar     NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto','cerrado')),
  fecha_cierre date,
  cerrado_por  bigint      REFERENCES public.users(id),
  notas       text,
  created_at  timestamptz DEFAULT now()
);

-- ============================================================
-- 10. DIARIOS (plantillas de asientos automáticos)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.diarios (
  id              serial      PRIMARY KEY,
  nombre          varchar     NOT NULL,
  tipo_movimiento varchar     NOT NULL,
  tipo_documento  varchar,
  moneda          varchar,
  activo          boolean     DEFAULT true,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.diario_lineas (
  id          serial      PRIMARY KEY,
  diario_id   integer     NOT NULL REFERENCES public.diarios(id) ON DELETE CASCADE,
  orden       smallint    NOT NULL,
  cuenta_codigo varchar   NOT NULL,
  tipo        varchar     NOT NULL CHECK (tipo IN ('debe','haber')),
  formula     text,        -- '%subtotal%', '%igv%', '%total%'
  condicion   text,
  descripcion varchar,
  created_at  timestamptz DEFAULT now()
);

-- ============================================================
-- 11. TIPO DE DOCUMENTOS SUNAT
-- ============================================================
CREATE TABLE IF NOT EXISTS public.tipo_documentos (
  id          varchar     PRIMARY KEY,  -- '01','03','07','08',...
  name        varchar     NOT NULL,
  electronic  boolean     NOT NULL DEFAULT false,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz DEFAULT now()
);

-- ============================================================
-- 12. ASIENTOS CONTABLES — CABECERA (journal_entries)
-- ============================================================
-- FUENTE DE VERDAD CONTABLE: todo evento económico genera un asiento.
-- Las líneas (journal_entry_lines) garantizan DEBE = HABER.
CREATE TABLE IF NOT EXISTS public.journal_entries (
  id                    bigserial   PRIMARY KEY,
  numero_asiento        varchar     NOT NULL UNIQUE,   -- 'AP-2026-001', 'AS-000001'
  fecha                 date        NOT NULL,
  periodo_contable      varchar(7)  NOT NULL,           -- 'YYYY-MM'
  descripcion           varchar     NOT NULL,
  documento_referencia  varchar,
  tipo_movimiento       varchar     NOT NULL,           -- 'venta','compra','cobro','pago','importacion','apertura','manual','cierre'
  tipo_documento        varchar,
  moneda                varchar     DEFAULT 'PEN',
  tipo_cambio           numeric     DEFAULT 1,
  total_debe            numeric     DEFAULT 0,
  total_haber           numeric     DEFAULT 0,
  contact_id            bigint      REFERENCES public.contacts(id),
  status                varchar     DEFAULT 'borrador'
                          CHECK (status IN ('borrador','confirmado','reversado')),
  -- Trazabilidad al documento origen
  origen_tipo           varchar,    -- 'compra','venta','cobro','pago_proveedor','importacion','cierre','manual'
  origen_id             bigint,
  -- Para asientos de reversión
  asiento_origen_id     bigint      REFERENCES public.journal_entries(id),
  serie_comprobante     text,
  correlativo_comprobante text,
  created_by            bigint      REFERENCES public.users(id),
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

COMMENT ON TABLE public.journal_entries IS
  'Cabecera de cada evento contable. DEBE = HABER garantizado por journal_entry_lines.';
COMMENT ON COLUMN public.journal_entries.numero_asiento IS
  'Número único del asiento. Formato: AP-YYYY-NNN (apertura), AS-NNNNNN (diario), CI-YYYYMM (cierre).';

-- ============================================================
-- 13. APUNTES CONTABLES — LÍNEAS (journal_entry_lines)
-- ============================================================
-- CAMBIO v3: columnas debe y haber reemplazan tipo+importe.
-- Una línea tiene debe > 0 O haber > 0 (nunca ambos).
-- Suma de DEBE = Suma de HABER por asiento = partida doble.
CREATE TABLE IF NOT EXISTS public.journal_entry_lines (
  id                  bigserial   PRIMARY KEY,
  journal_entry_id    bigint      NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  account_id          integer     NOT NULL REFERENCES public.plan_cuentas(id),
  -- Partida doble: debe y haber (uno siempre es 0)
  debe                numeric     NOT NULL DEFAULT 0 CHECK (debe >= 0),
  haber               numeric     NOT NULL DEFAULT 0 CHECK (haber >= 0),
  CONSTRAINT chk_jel_debe_o_haber CHECK (debe > 0 OR haber > 0),
  CONSTRAINT chk_jel_no_ambos CHECK (NOT (debe > 0 AND haber > 0)),
  -- Moneda extranjera
  importe_original    numeric,    -- monto en USD/EUR si aplica
  moneda_original     varchar,    -- 'USD','EUR'
  tipo_cambio         numeric,    -- TC aplicado
  -- Glosa de la línea
  descripcion         text,
  fecha               date,
  -- CxC/CxP desde el ledger (LIR Art. 35)
  contact_id          bigint      REFERENCES public.contacts(id),    -- cliente/proveedor
  referencia_doc      varchar,    -- nro comprobante: FFFI-00000364, LETRA/2026/01/0004
  fecha_vencimiento   date,       -- vencimiento de esta cuota
  -- Conciliación bancaria
  reconciliado        boolean     DEFAULT false,
  reconciliacion_id   bigint,
  created_at          timestamptz DEFAULT now()
);

COMMENT ON TABLE public.journal_entry_lines IS
  'Apuntes contables en partida doble. DEBE > 0 XOR HABER > 0 por línea.
   Las líneas con cuenta 12xxxx/42xxxx llevan contact_id + referencia_doc para CxC/CxP sin tabla auxiliar.';
COMMENT ON COLUMN public.journal_entry_lines.debe IS 'Cargo (Debe). Solo uno de debe/haber puede ser > 0.';
COMMENT ON COLUMN public.journal_entry_lines.haber IS 'Abono (Haber). Solo uno de debe/haber puede ser > 0.';
COMMENT ON COLUMN public.journal_entry_lines.contact_id IS
  'Contacto (cliente/proveedor) de la línea. Solo en cuentas 12xxxx y 42xxxx.';
COMMENT ON COLUMN public.journal_entry_lines.referencia_doc IS
  'Número del comprobante origen: FFFI-00000364, LETRA/2026/01/0004, etc.';

-- ============================================================
-- 14. ÓRDENES DE COMPRA
-- ============================================================
CREATE TABLE IF NOT EXISTS public.orden_compra (
  id              bigserial   PRIMARY KEY,
  numero          varchar     NOT NULL UNIQUE,
  contact_id      bigint      NOT NULL REFERENCES public.contacts(id),
  cantidad_total  numeric     NOT NULL,
  total_igv       numeric     DEFAULT 0,
  total_subtotal  numeric     NOT NULL,
  total_OC        numeric     NOT NULL,
  currency        varchar     DEFAULT 'USD',
  status          varchar     DEFAULT 'borrador',
  fecha           date,
  tipo_pago       text,
  created_by      bigint      REFERENCES public.users(id),
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.detalle_orden_compra (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  orden_compra_id bigint      NOT NULL REFERENCES public.orden_compra(id) ON DELETE CASCADE,
  item_id         bigint      REFERENCES public.items(id),
  descripcion     varchar,
  cantidad        numeric     CHECK (cantidad > 0),
  precio_unitario numeric     NOT NULL CHECK (precio_unitario >= 0),
  unidad_medida   varchar,
  igv_porcentaje  numeric     DEFAULT 18,
  subtotal        numeric     NOT NULL,
  igv_monto       numeric     DEFAULT 0,
  total           numeric     NOT NULL,
  observaciones   text,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- ============================================================
-- 15. COMPRAS (Registro de Compras — Formato 8.1 SUNAT)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.compras (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referencia                varchar     NOT NULL UNIQUE CHECK (referencia <> ''),
  tipo_referencia           varchar     NOT NULL,
  tipo_comprobante          varchar     NOT NULL CHECK (tipo_comprobante IN
                              ('01','02','03','08','09','10','12','18','20','91','97','98')),
  serie                     varchar,
  numero                    varchar     NOT NULL,
  -- Periodo (Formato 8.1 SUNAT)
  periodo_mes               integer     NOT NULL,
  periodo_ano               integer     NOT NULL,
  fecha_emision             date        NOT NULL,
  fecha_recepcion           date        NOT NULL,
  -- Proveedor
  contact_id                bigint      NOT NULL REFERENCES public.contacts(id),
  proveedor_ruc             varchar     NOT NULL,
  proveedor_nombre          varchar     NOT NULL,
  proveedor_domiciliado     boolean     DEFAULT true,
  -- Tipo y montos
  tipo_compra               varchar     NOT NULL,  -- 'mercaderia','servicio','activo_fijo','importacion'
  descripcion               text,
  unidad_medida             varchar     NOT NULL DEFAULT 'KG',
  cantidad                  numeric     NOT NULL DEFAULT 0 CHECK (cantidad > 0),
  total_unidades            numeric,
  precio_unitario           numeric     NOT NULL CHECK (precio_unitario >= 0),
  -- Bases imponibles (Formato 8.1)
  base_imponible_gravada    numeric     DEFAULT 0,
  base_imponible_no_gravada numeric     DEFAULT 0,
  monto_exportacion         numeric     DEFAULT 0,
  monto_no_gravado          numeric     DEFAULT 0,
  monto_exonerado           numeric     DEFAULT 0,
  igv_gravado               numeric     DEFAULT 0,
  subtotal                  numeric     NOT NULL,
  total                     numeric     NOT NULL CHECK (total >= 0),
  igv_retenido              numeric     DEFAULT 0,
  sujeto_retencion          boolean     DEFAULT false,
  -- Moneda
  currency                  varchar     DEFAULT 'PEN' CHECK (currency IN ('PEN','USD','EUR')),
  tipo_cambio               numeric     DEFAULT 1.0,
  -- Estado
  estado_comprobante        varchar     DEFAULT '1',
  comprobante_anulado       boolean     DEFAULT false,
  estado_pago               varchar     DEFAULT 'pendiente'
                              CHECK (estado_pago IN ('pendiente','parcial','pagado')),
  -- Asiento contable
  asiento_id                bigint      REFERENCES public.journal_entries(id),
  created_by                bigint      REFERENCES public.users(id),
  created_at                timestamptz DEFAULT now(),
  updated_at                timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.detalle_compras (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  compra_id           bigint      NOT NULL REFERENCES public.compras(id) ON DELETE CASCADE,
  item_id             bigint      REFERENCES public.items(id),
  descripcion         varchar     NOT NULL,
  unidad_medida       varchar,
  cantidad            numeric     NOT NULL CHECK (cantidad > 0),
  precio_unitario     numeric     NOT NULL CHECK (precio_unitario >= 0),
  subtotal            numeric     NOT NULL,
  tipo_base           varchar     NOT NULL CHECK (tipo_base IN ('gravada','no_gravada','exportacion','exonerada')),
  descuento_porcentaje numeric     DEFAULT 0 CHECK (descuento_porcentaje BETWEEN 0 AND 100),
  descuento_monto     numeric     DEFAULT 0,
  igv_porcentaje      numeric     DEFAULT 0,
  igv_monto           numeric     DEFAULT 0,
  total_linea         numeric     NOT NULL,
  cuenta_contable_id  bigint      REFERENCES public.plan_cuentas(id),
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

-- ============================================================
-- 16. COTIZACIONES DE VENTA
-- ============================================================
-- Se crea antes que ventas porque ventas.cotizacion_id la referencia.
CREATE TABLE IF NOT EXISTS public.sales_quotes (
  id              bigserial   PRIMARY KEY,
  numero          varchar     NOT NULL UNIQUE,
  contact_id      bigint      NOT NULL REFERENCES public.contacts(id),
  lote_id         bigint      REFERENCES public.lotes(id),
  cantidad        numeric     NOT NULL,
  precio_unitario numeric     NOT NULL,
  igv             numeric     DEFAULT 0,
  subtotal        numeric     NOT NULL,
  total           numeric     NOT NULL,
  currency        varchar     DEFAULT 'PEN',
  status          varchar     DEFAULT 'borrador',
  created_by      bigint      REFERENCES public.users(id),
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- ============================================================
-- 17. VENTAS (Comprobantes de Venta — CPE SUNAT)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ventas (
  id                    bigserial   PRIMARY KEY,
  numero                varchar     NOT NULL UNIQUE,
  -- Comprobante (Catálogos 09/10 RS 097-2012)
  tipo_comprobante      varchar     NOT NULL CHECK (tipo_comprobante IN ('01','03','07','08')),
  serie                 varchar,
  correlativo           varchar,
  -- Cliente
  contact_id            bigint      NOT NULL REFERENCES public.contacts(id),
  -- Fecha
  fecha_emision         date        NOT NULL,
  fecha_vencimiento     date,
  periodo_contable      varchar(7)  NOT NULL,
  -- Montos
  moneda                varchar     DEFAULT 'PEN' CHECK (moneda IN ('PEN','USD','EUR')),
  tipo_cambio           numeric     DEFAULT 1,
  base_imponible        numeric     DEFAULT 0,
  igv                   numeric     DEFAULT 0,
  total                 numeric     NOT NULL CHECK (total >= 0),
  -- Estado
  estado                varchar     DEFAULT 'borrador'
                          CHECK (estado IN ('borrador','emitida','anulada')),
  estado_pago           varchar     DEFAULT 'pendiente'
                          CHECK (estado_pago IN ('pendiente','parcial','pagado')),
  descripcion           text,
  observaciones         text,
  -- Asiento contable
  asiento_id            bigint      REFERENCES public.journal_entries(id),
  -- CPE SUNAT (NUBEFACT)
  nubefact_id           varchar,
  nubefact_enlace       text,
  nubefact_qr           text,
  nubefact_hash         varchar,
  xml_url               text,
  pdf_url               text,
  cpe_estado            varchar     DEFAULT 'no_enviado'
                          CHECK (cpe_estado IN ('no_enviado','enviando','aceptado','rechazado','baja')),
  -- NC/ND: referencia al documento origen
  doc_referencia_tipo   varchar,
  doc_referencia_serie  varchar,
  doc_referencia_numero varchar,
  -- Trazabilidad a cotización (sales_quotes ya existe arriba)
  cotizacion_id         bigint      REFERENCES public.sales_quotes(id),
  created_by            bigint      REFERENCES public.users(id),
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.detalle_ventas (
  id                  bigserial   PRIMARY KEY,
  venta_id            bigint      NOT NULL REFERENCES public.ventas(id) ON DELETE CASCADE,
  item_id             bigint      REFERENCES public.items(id),
  lote_id             bigint      REFERENCES public.lotes(id),
  descripcion         varchar     NOT NULL,
  unidad_medida       varchar     NOT NULL DEFAULT 'KG',
  cantidad            numeric     NOT NULL CHECK (cantidad > 0),
  precio_unitario     numeric     NOT NULL CHECK (precio_unitario >= 0),
  subtotal            numeric     NOT NULL,
  tipo_base           varchar     NOT NULL DEFAULT 'gravada'
                        CHECK (tipo_base IN ('gravada','exonerada','inafecta','exportacion')),
  igv_porcentaje      numeric     DEFAULT 18,
  igv_monto           numeric     DEFAULT 0,
  total_linea         numeric     NOT NULL,
  costo_unitario      numeric     DEFAULT 0,   -- costo en PEN/kg al momento de la venta
  created_at          timestamptz DEFAULT now()
);

-- ============================================================
-- 18. CUENTAS POR COBRAR (CxC)
-- ============================================================
-- Tracking de documentos por cobrar. El saldo real = monto_total - monto_cobrado.
-- El estado (pendiente/parcial/cobrado) se puede derivar de estos valores.
CREATE TABLE IF NOT EXISTS public.cuentas_cobrar (
  id                  bigserial   PRIMARY KEY,
  contact_id          bigint      NOT NULL REFERENCES public.contacts(id),
  venta_id            bigint      REFERENCES public.ventas(id),
  tipo_comprobante    varchar,
  serie               varchar,
  numero_comprobante  varchar,
  fecha_emision       date        NOT NULL DEFAULT CURRENT_DATE,
  fecha_vencimiento   date,
  -- Moneda
  moneda              varchar     DEFAULT 'PEN',
  tipo_cambio         numeric     DEFAULT 1,
  monto_me            numeric     DEFAULT 0,   -- monto en moneda extranjera
  saldo_me            numeric     DEFAULT 0,   -- saldo en moneda extranjera
  -- Montos en PEN
  monto_total         numeric     NOT NULL CHECK (monto_total > 0),
  monto_cobrado       numeric     NOT NULL DEFAULT 0 CHECK (monto_cobrado >= 0),
  -- Estado
  estado              varchar     DEFAULT 'pendiente'
                        CHECK (estado IN ('pendiente','parcial','cobrado','anulado')),
  -- Contabilidad
  cuenta_contable_id  integer     REFERENCES public.plan_cuentas(id),
  asiento_id          bigint      REFERENCES public.journal_entries(id),
  -- Trazabilidad Odoo (migración / idempotencia)
  asiento_odoo        varchar,
  -- Auditoría
  created_by          bigint      REFERENCES public.users(id),
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cxc_asiento_odoo
  ON public.cuentas_cobrar(asiento_odoo)
  WHERE asiento_odoo IS NOT NULL;

COMMENT ON TABLE public.cuentas_cobrar IS
  'Tracking de documentos por cobrar. saldo = monto_total - monto_cobrado. Ver v_cxc_pendientes.';

-- ============================================================
-- 19. CUENTAS POR PAGAR (CxP)
-- ============================================================
-- Espejo de cuentas_cobrar para el lado pasivo.
-- Incluye facturas de proveedor, letras recibidas, nómina, planilla.
CREATE TABLE IF NOT EXISTS public.cuentas_pagar (
  id                  bigserial   PRIMARY KEY,
  contact_id          bigint      NOT NULL REFERENCES public.contacts(id),
  compra_id           bigint      REFERENCES public.compras(id),
  asiento_id          bigint      REFERENCES public.journal_entries(id),
  tipo_comprobante    varchar,
  serie               varchar,
  numero_comprobante  varchar,
  fecha_emision       date        NOT NULL DEFAULT '2025-01-01',  -- default para migración
  fecha_vencimiento   date,
  -- Moneda
  moneda              varchar     DEFAULT 'PEN',
  tipo_cambio         numeric     DEFAULT 1,
  -- Montos en PEN
  monto_total         numeric     NOT NULL CHECK (monto_total > 0),
  monto_pagado        numeric     NOT NULL DEFAULT 0 CHECK (monto_pagado >= 0),
  -- Estado
  estado              varchar     DEFAULT 'pendiente'
                        CHECK (estado IN ('pendiente','parcial','pagado','anulado')),
  -- Contabilidad
  cuenta_contable_id  integer     REFERENCES public.plan_cuentas(id),
  -- Trazabilidad (migración Odoo / idempotencia)
  asiento_odoo        varchar,
  referencia_cuenta   varchar,    -- código de cuenta contable origen del saldo
  observaciones       text,
  created_by          bigint      REFERENCES public.users(id),
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cuentas_pagar_contact  ON public.cuentas_pagar(contact_id);
CREATE INDEX IF NOT EXISTS idx_cuentas_pagar_estado   ON public.cuentas_pagar(estado);
CREATE INDEX IF NOT EXISTS idx_cuentas_pagar_vto      ON public.cuentas_pagar(fecha_vencimiento);
CREATE INDEX IF NOT EXISTS idx_cuentas_pagar_asiento  ON public.cuentas_pagar(asiento_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cxp_asiento_contact_cuenta
  ON public.cuentas_pagar(asiento_odoo, contact_id, referencia_cuenta)
  WHERE asiento_odoo IS NOT NULL;

COMMENT ON TABLE public.cuentas_pagar IS
  'Tracking de documentos por pagar. saldo = monto_total - monto_pagado. Ver v_cxp_pendientes.';

-- ============================================================
-- 20. COBROS (aplicación de pagos a CxC)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cobros (
  id              bigserial   PRIMARY KEY,
  cxc_id          bigint      REFERENCES public.cuentas_cobrar(id),
  contact_id      bigint      NOT NULL REFERENCES public.contacts(id),
  fecha           date        NOT NULL,
  monto           numeric     NOT NULL CHECK (monto > 0),
  moneda          varchar     DEFAULT 'PEN',
  tipo_cambio     numeric     DEFAULT 1,
  medio_pago      varchar     NOT NULL
                    CHECK (medio_pago IN ('transferencia','cheque','efectivo','deposito','detraccion','otro')),
  referencia      varchar,
  banco_id        integer,
  numero_operacion varchar,
  observaciones   text,
  asiento_id      bigint      REFERENCES public.journal_entries(id),
  created_by      bigint      REFERENCES public.users(id),
  created_at      timestamptz DEFAULT now()
);

-- ============================================================
-- 21. PAGOS A PROVEEDORES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.pagos_proveedores (
  id              bigserial   PRIMARY KEY,
  compra_id       bigint      REFERENCES public.compras(id),
  cxp_id          bigint      REFERENCES public.cuentas_pagar(id),  -- FK a cuentas_pagar
  contact_id      bigint      NOT NULL REFERENCES public.contacts(id),
  fecha           date        NOT NULL,
  monto           numeric     NOT NULL CHECK (monto > 0),
  moneda          varchar     DEFAULT 'PEN',
  tipo_cambio     numeric     DEFAULT 1,
  medio_pago      varchar     NOT NULL
                    CHECK (medio_pago IN ('transferencia','cheque','efectivo','detraccion','otro')),
  referencia      varchar,
  banco_id        integer,
  numero_operacion varchar,
  observaciones   text,
  asiento_id      bigint      REFERENCES public.journal_entries(id),
  created_by      bigint      REFERENCES public.users(id),
  created_at      timestamptz DEFAULT now()
);

COMMENT ON COLUMN public.pagos_proveedores.cxp_id IS
  'FK a cuentas_pagar cuando el pago cancela un documento CxP.';

-- ============================================================
-- 22. LETRAS DE CAMBIO (PCGE 1212/1213/1214 emitidas, 4212 recibidas)
-- ============================================================
-- Una letra puede ser aceptada, enviada a banco, protestada o refinanciada.
-- Numeración: FFFI-XXXXX-NN (ej: LT.187-01, LETRA/2026/01/0004)
CREATE TABLE IF NOT EXISTS public.letras_cambio (
  id                    bigserial   PRIMARY KEY,
  numero_letra          varchar     NOT NULL UNIQUE,  -- 'LT.187-01', 'FNDI-09'
  tipo                  varchar     NOT NULL CHECK (tipo IN ('emitida','recibida')),
  contact_id            bigint      NOT NULL REFERENCES public.contacts(id),
  -- Documento origen
  venta_id              bigint      REFERENCES public.ventas(id),
  compra_id             bigint      REFERENCES public.compras(id),
  cxc_id                bigint      REFERENCES public.cuentas_cobrar(id),
  cxp_id                bigint      REFERENCES public.cuentas_pagar(id),
  -- Montos
  moneda                varchar     DEFAULT 'PEN',
  tipo_cambio           numeric     DEFAULT 1,
  monto                 numeric     NOT NULL CHECK (monto > 0),
  -- Fechas
  fecha_emision         date        NOT NULL,
  fecha_vencimiento     date        NOT NULL,
  -- Estado (flujo PCGE letras)
  estado                varchar     DEFAULT 'cartera'
                          CHECK (estado IN ('cartera','banco','cobranza','cobrada','protestada','refinanciada','anulada')),
  -- Cuenta PCGE según estado:
  -- cartera → 1212, banco/descontada → 1213, cobranza → 1214 (emitidas)
  -- recibidas → 4212
  cuenta_contable_codigo varchar,
  -- Protesto y refinanciamiento
  fecha_protesto        date,
  letra_origen_id       bigint      REFERENCES public.letras_cambio(id),  -- si es refinanciamiento
  -- Asientos
  asiento_emision_id    bigint      REFERENCES public.journal_entries(id),
  asiento_cobro_id      bigint      REFERENCES public.journal_entries(id),
  asiento_protesto_id   bigint      REFERENCES public.journal_entries(id),
  -- Trazabilidad
  observaciones         text,
  created_by            bigint      REFERENCES public.users(id),
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

COMMENT ON TABLE public.letras_cambio IS
  'Letras de cambio emitidas (CxC) y recibidas (CxP). Estado controla el movimiento entre subcuentas 1212/1213/1214.';

-- ============================================================
-- 23. BANCOS (cuentas bancarias de la empresa)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.bancos (
  id                    serial      PRIMARY KEY,
  nombre                varchar     NOT NULL,
  banco                 varchar     NOT NULL,  -- 'BCP','BBVA','Interbank','Scotiabank','BN','otro'
  numero_cuenta         varchar     NOT NULL,
  cci                   varchar,
  tipo_cuenta           varchar     NOT NULL
                          CHECK (tipo_cuenta IN ('corriente','ahorro','detracciones','cuentas_recaudacion')),
  moneda                varchar     DEFAULT 'PEN',
  saldo_inicial         numeric     DEFAULT 0,
  saldo_actual          numeric     DEFAULT 0,
  cuenta_contable_codigo varchar,
  cuenta_contable_id    integer     REFERENCES public.plan_cuentas(id),
  activo                boolean     DEFAULT true,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

-- ============================================================
-- 24. MOVIMIENTOS BANCARIOS (cartola / extracto)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.movimientos_banco (
  id                  bigserial   PRIMARY KEY,
  banco_id            integer     NOT NULL REFERENCES public.bancos(id),
  fecha               date        NOT NULL,
  tipo                varchar     NOT NULL CHECK (tipo IN ('ingreso','egreso')),
  concepto            varchar     NOT NULL,
  categoria           varchar,    -- 'cobro_cliente','pago_proveedor','gasto_banco','otro'
  referencia          varchar,
  numero_operacion    varchar,
  monto               numeric     NOT NULL CHECK (monto > 0),
  saldo_posterior     numeric,
  reconciliado        boolean     DEFAULT false,
  asiento_id          bigint      REFERENCES public.journal_entries(id),
  cobro_id            bigint      REFERENCES public.cobros(id),
  pago_proveedor_id   bigint      REFERENCES public.pagos_proveedores(id),
  created_by          bigint      REFERENCES public.users(id),
  created_at          timestamptz DEFAULT now()
);

-- ============================================================
-- 25. KARDEX (inventario valorizado — LIR Art. 35)
-- ============================================================
-- Registro permanente valorizado obligatorio para empresas con
-- ingresos > 1,500 UIT. Formato: fecha, documento, concepto,
-- entradas (cant+costo+total), salidas, saldo.
CREATE TABLE IF NOT EXISTS public.kardex (
  id                    bigserial   PRIMARY KEY,
  item_id               bigint      NOT NULL REFERENCES public.items(id),
  lote_id               bigint      REFERENCES public.lotes(id),
  almacen_id            integer     REFERENCES public.almacenes(id),
  almacen_destino_id    integer     REFERENCES public.almacenes(id),  -- para traslados entre almacenes
  fecha                 date        NOT NULL,
  tipo_movimiento       varchar     NOT NULL
                          CHECK (tipo_movimiento IN (
                            'entrada','salida','ajuste_entrada','ajuste_salida',
                            'devolucion_venta','devolucion_compra','traslado_salida','traslado_entrada'
                          )),
  concepto              varchar     NOT NULL,
  documento_referencia  varchar,
  -- Movimiento
  cantidad_entrada      numeric     NOT NULL DEFAULT 0 CHECK (cantidad_entrada >= 0),
  cantidad_salida       numeric     NOT NULL DEFAULT 0 CHECK (cantidad_salida >= 0),
  costo_unitario        numeric     NOT NULL DEFAULT 0,
  costo_total           numeric     NOT NULL DEFAULT 0,
  -- Saldo después del movimiento (por lote)
  saldo_cantidad        numeric     NOT NULL DEFAULT 0,
  saldo_valor           numeric     NOT NULL DEFAULT 0,
  costo_promedio        numeric     NOT NULL DEFAULT 0,
  -- Método de valuación (LIR Art. 62°)
  metodo_valuacion      varchar     DEFAULT 'identificacion_especifica',
  -- Trazabilidad
  asiento_id            bigint      REFERENCES public.journal_entries(id),
  compra_id             bigint      REFERENCES public.compras(id),
  venta_id              bigint      REFERENCES public.ventas(id),
  carpeta_importacion_id bigint,    -- FK lógica a carpetas_importacion
  created_by            bigint      REFERENCES public.users(id),
  created_at            timestamptz DEFAULT now()
);

COMMENT ON TABLE public.kardex IS
  'Kardex permanente valorizado (LIR Art. 35). Método: identificación específica por lote (LIR Art. 62°).';
COMMENT ON COLUMN public.kardex.almacen_destino_id IS
  'Almacén destino para movimientos de tipo traslado. Requiere GRE si los almacenes tienen diferente ubigeo.';

-- ============================================================
-- 26. PARTIDAS ARANCELARIAS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.partidas (
  id              bigserial   PRIMARY KEY,
  numero_partida  varchar     NOT NULL UNIQUE,
  product_id      bigint      NOT NULL REFERENCES public.items(id),
  descripcion     text,
  fecha_inicio    date        NOT NULL,
  fecha_fin       date,
  status          varchar     DEFAULT 'activa',
  created_by      bigint      REFERENCES public.users(id),
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- ============================================================
-- 27. CARPETAS DE IMPORTACIÓN (costeo FACTOR — LIR Art. 35/62°)
-- ============================================================
-- Cada carpeta agrupa un contenedor o DUA. El FACTOR se calcula al cierre:
--   Factor = (CIF_total_pen + gastos_destino_pen) / FOB_total_pen
-- Los lotes creados desde esta carpeta usan el factor para su costo unitario.
CREATE TABLE IF NOT EXISTS public.carpetas_importacion (
  id                      bigserial   PRIMARY KEY,
  numero_carpeta          varchar     NOT NULL UNIQUE,  -- 'IMP-2026-001'
  descripcion             text,
  proveedor_id            bigint      NOT NULL REFERENCES public.contacts(id),
  comercial_invoice_id    bigint,    -- FK diferida a comercial_invoices (creada abajo en sección 28)
  -- Temporalidad
  fecha_apertura          date        NOT NULL,
  fecha_cierre            date,
  -- Valores FOB (USD)
  fob_total_usd           numeric     NOT NULL DEFAULT 0,
  flete_usd               numeric     NOT NULL DEFAULT 0,
  seguro_usd              numeric     NOT NULL DEFAULT 0,
  -- CIF total en USD y PEN
  cif_total_usd           numeric     NOT NULL DEFAULT 0,  -- = fob + flete + seguro
  tipo_cambio             numeric     NOT NULL DEFAULT 3.75,
  cif_total_pen           numeric     NOT NULL DEFAULT 0,  -- = cif_total_usd * tc
  fob_total_pen           numeric     NOT NULL DEFAULT 0,  -- = fob_total_usd * tc
  -- Gastos de destino (sin impuestos recuperables = sin IGV, sin Percepción)
  ad_valorem_pen          numeric     DEFAULT 0,  -- 6% sobre CIF (o tasa específica)
  agente_aduana_pen       numeric     DEFAULT 0,
  flete_local_pen         numeric     DEFAULT 0,
  almacenaje_pen          numeric     DEFAULT 0,
  manipuleo_pen           numeric     DEFAULT 0,
  otros_gastos_pen        numeric     DEFAULT 0,
  -- Factor calculado al cierre (solo cuando estado = 'cerrada')
  factor                  numeric,    -- = (cif_pen + gastos_destino) / fob_pen
  -- Estado
  estado                  varchar     DEFAULT 'abierta'
                            CHECK (estado IN ('abierta','cerrada','anulada')),
  -- Asientos contables
  asiento_provisional_id  bigint      REFERENCES public.journal_entries(id),
  asiento_ajuste_id       bigint      REFERENCES public.journal_entries(id),
  -- DUA
  numero_dam              varchar,
  fecha_dam               date,
  -- Notas
  observaciones           text,
  created_by              bigint      REFERENCES public.users(id),
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now()
);

COMMENT ON TABLE public.carpetas_importacion IS
  'Carpeta de importación por DUA. Al cierre calcula el FACTOR = (CIF_pen + gastos_destino_pen) / FOB_pen.
   Costo_unitario_lote = FOB_unitario_pen × Factor.';
COMMENT ON COLUMN public.carpetas_importacion.factor IS
  'Factor de distribución de costos. Ej: 1.1240 → por cada sol FOB, el costo total es S/ 1.1240.';

-- FK diferida en lotes (permite el orden de CREATE TABLE)
ALTER TABLE public.lotes
  ADD CONSTRAINT fk_lotes_carpeta
  FOREIGN KEY (carpeta_importacion_id) REFERENCES public.carpetas_importacion(id);

-- FK diferida en kardex
ALTER TABLE public.kardex
  ADD CONSTRAINT fk_kardex_carpeta
  FOREIGN KEY (carpeta_importacion_id) REFERENCES public.carpetas_importacion(id);

-- ============================================================
-- 28. IMPORTACIONES (módulo legacy — Commercial Invoice, BL, DAM)
-- ============================================================
-- Estas tablas alimentan al módulo costeo-importaciones.html.
-- La carpeta_importacion_id enlaza cada CI con su carpeta FACTOR.
CREATE TABLE IF NOT EXISTS public.comercial_invoices (
  id                      bigserial   PRIMARY KEY,
  contact_id              bigint      REFERENCES public.contacts(id),
  invoice_number          varchar,
  proforma_number         varchar,
  fecha                   date,
  product                 varchar,
  terminos_delivery       varchar     DEFAULT 'FOB',
  terminos_payment        text,
  total_unidades          integer     DEFAULT 0,
  cantidad_total_neto     numeric     DEFAULT 0,
  cantidad_total_gross    numeric     DEFAULT 0,
  valor_total_final_ci    numeric     DEFAULT 0,
  valor_total_final_fob   numeric,
  costo_flete             numeric     DEFAULT 0,
  costo_seguro            numeric     DEFAULT 0,
  puerto_embarque         varchar,
  pais_origen             varchar,
  pagado                  varchar     DEFAULT 'Pendiente',
  status                  varchar     DEFAULT 'borrador',
  carpeta_importacion_id  bigint      REFERENCES public.carpetas_importacion(id),
  created_by              bigint      REFERENCES public.users(id),
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now()
);

-- FK diferida carpetas_importacion → comercial_invoices
-- (no se pudo poner en la sección 27 porque comercial_invoices aún no existía)
ALTER TABLE public.carpetas_importacion
  ADD CONSTRAINT fk_carpeta_ci
  FOREIGN KEY (comercial_invoice_id) REFERENCES public.comercial_invoices(id)
  ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.detalle_comercial_invoice (
  id                    bigserial   PRIMARY KEY,
  comercial_invoice_id  bigint      NOT NULL REFERENCES public.comercial_invoices(id) ON DELETE CASCADE,
  lote                  varchar,
  product_id            bigint      REFERENCES public.items(id),
  partida_arancelaria   text,
  cantidad_neto         numeric     NOT NULL DEFAULT 0,
  cantidad_gross        numeric     NOT NULL DEFAULT 0,
  cantidad_unid         integer     NOT NULL DEFAULT 0,
  costo_unitario        numeric     NOT NULL DEFAULT 0,
  costo_total           numeric     NOT NULL DEFAULT 0,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bill_of_ladings (
  id                  bigserial   PRIMARY KEY,
  importacion_id      bigint      NOT NULL REFERENCES public.comercial_invoices(id),
  nro_bill_lading     varchar     NOT NULL,
  contenedor_number   varchar     NOT NULL,
  fecha               date,
  estado              varchar     DEFAULT 'pendiente',
  numero_precinto     text,
  peso_bruto          real,
  created_at          timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.dams (
  id                      bigserial   PRIMARY KEY,
  importacion_id          bigint      NOT NULL REFERENCES public.comercial_invoices(id),
  numero_dam              varchar     NOT NULL,
  fecha_dam               date        NOT NULL,
  valor_cif               numeric,
  valor_fob               numeric,
  flete_maritimo          numeric,
  seguro_maritimo         numeric,
  ad_valorem_usd          numeric     DEFAULT 0,
  imp_usd                 numeric,
  igv_usd                 numeric     DEFAULT 0,
  percepcion              numeric,
  tipo_cambio             numeric,
  total_liquidacion       numeric,
  total_liquidacion_sol   numeric     DEFAULT 0,
  estado                  varchar     DEFAULT 'pendiente',
  created_at              timestamptz DEFAULT timezone('utc', now()),
  updated_at              timestamptz DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS public.guias_remision (
  id              bigserial   PRIMARY KEY,
  importacion_id  bigint      NOT NULL REFERENCES public.comercial_invoices(id),
  numero_guia     varchar     NOT NULL,
  fecha_guia      date        NOT NULL,
  peso_bruto      numeric     DEFAULT 0,
  lugar_destino   varchar,
  dam_relacionado text,
  proveedor       bigint      REFERENCES public.contacts(id),
  estado          varchar     DEFAULT 'pendiente',
  created_at      timestamptz DEFAULT timezone('utc', now()),
  updated_at      timestamptz DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS public.gastos_locales (
  id              bigserial   PRIMARY KEY,
  importacion_id  bigint      NOT NULL REFERENCES public.comercial_invoices(id),
  concepto        varchar     NOT NULL,
  tipo_gasto      varchar     NOT NULL
                    CHECK (tipo_gasto IN ('flete_local','cuadrilla','comision','almacenaje','otro')),
  monto_usd       numeric     NOT NULL,
  monto_sol       numeric     DEFAULT 0,
  tipo_cambio     numeric     DEFAULT 3.70,
  numero_documento varchar,
  fecha           date,
  acreedor        varchar,
  igv             numeric     DEFAULT 18,
  estado          varchar     DEFAULT 'pendiente' CHECK (estado IN ('pendiente','pagado')),
  created_at      timestamptz DEFAULT timezone('utc', now()),
  updated_at      timestamptz DEFAULT timezone('utc', now())
);

-- ============================================================
-- 29. PAGOS DE IMPORTACIÓN (pagos al proveedor extranjero)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.pagos (
  id                  bigserial   PRIMARY KEY,
  importacion_id      bigint      NOT NULL REFERENCES public.comercial_invoices(id),
  tipo_pago           varchar     NOT NULL
                        CHECK (tipo_pago IN ('comercial_invoice','arancel','igv','gasto_local','otro')),
  referencia          varchar,
  monto_usd           numeric     NOT NULL,
  monto_sol           numeric     DEFAULT 0,
  tipo_cambio         numeric     DEFAULT 3.70,
  fecha_pago          date        NOT NULL,
  medio_pago          varchar     NOT NULL
                        CHECK (medio_pago IN ('transferencia','cheque','efectivo','tarjeta','otro')),
  numero_comprobante  varchar,
  banco               varchar,
  observaciones       text,
  created_at          timestamptz DEFAULT timezone('utc', now()),
  updated_at          timestamptz DEFAULT timezone('utc', now())
);

-- ============================================================
-- 30. AUDITORÍA
-- ============================================================
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id              bigserial   PRIMARY KEY,
  auth_user_id    uuid,
  user_id         bigint,
  modulo          varchar,
  entidad_tipo    varchar,
  entidad_id      varchar,
  accion          varchar,    -- 'INSERT','UPDATE','DELETE','LOGIN','CONFIRM'
  cambios         jsonb,
  referencia_a    varchar,
  ip_address      varchar,
  timestamp       timestamptz DEFAULT now()
);

-- ============================================================
-- ÍNDICES — PERFORMANCE
-- ============================================================

-- Asientos
CREATE INDEX IF NOT EXISTS idx_je_fecha           ON public.journal_entries(fecha);
CREATE INDEX IF NOT EXISTS idx_je_periodo         ON public.journal_entries(periodo_contable);
CREATE INDEX IF NOT EXISTS idx_je_origen          ON public.journal_entries(origen_tipo, origen_id);
CREATE INDEX IF NOT EXISTS idx_je_status          ON public.journal_entries(status);
CREATE INDEX IF NOT EXISTS idx_je_numero          ON public.journal_entries(numero_asiento);

-- Líneas de asiento
CREATE INDEX IF NOT EXISTS idx_jel_entry          ON public.journal_entry_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_jel_account        ON public.journal_entry_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_jel_contact        ON public.journal_entry_lines(contact_id);
CREATE INDEX IF NOT EXISTS idx_jel_referencia     ON public.journal_entry_lines(referencia_doc);
CREATE INDEX IF NOT EXISTS idx_jel_vencimiento    ON public.journal_entry_lines(fecha_vencimiento);

-- Plan de cuentas
CREATE INDEX IF NOT EXISTS idx_pc_codigo          ON public.plan_cuentas(codigo);
CREATE INDEX IF NOT EXISTS idx_pc_grupo           ON public.plan_cuentas(grupo_reporte);

-- Compras / Ventas
CREATE INDEX IF NOT EXISTS idx_compras_periodo    ON public.compras(periodo_ano, periodo_mes);
CREATE INDEX IF NOT EXISTS idx_compras_contact    ON public.compras(contact_id);
CREATE INDEX IF NOT EXISTS idx_compras_estado_pago ON public.compras(estado_pago);
CREATE INDEX IF NOT EXISTS idx_ventas_fecha       ON public.ventas(fecha_emision);
CREATE INDEX IF NOT EXISTS idx_ventas_contact     ON public.ventas(contact_id);
CREATE INDEX IF NOT EXISTS idx_ventas_estado_pago ON public.ventas(estado_pago);

-- CxC / CxP
CREATE INDEX IF NOT EXISTS idx_cxc_contact        ON public.cuentas_cobrar(contact_id);
CREATE INDEX IF NOT EXISTS idx_cxc_estado         ON public.cuentas_cobrar(estado);
CREATE INDEX IF NOT EXISTS idx_cxc_vto            ON public.cuentas_cobrar(fecha_vencimiento);

-- Cobros / Bancos
CREATE INDEX IF NOT EXISTS idx_cobros_fecha       ON public.cobros(fecha);
CREATE INDEX IF NOT EXISTS idx_mbanco_banco       ON public.movimientos_banco(banco_id);
CREATE INDEX IF NOT EXISTS idx_mbanco_fecha       ON public.movimientos_banco(fecha);

-- Kardex
CREATE INDEX IF NOT EXISTS idx_kardex_item        ON public.kardex(item_id);
CREATE INDEX IF NOT EXISTS idx_kardex_lote        ON public.kardex(lote_id);
CREATE INDEX IF NOT EXISTS idx_kardex_fecha       ON public.kardex(fecha);
CREATE INDEX IF NOT EXISTS idx_kardex_almacen     ON public.kardex(almacen_id);

-- Lotes
CREATE INDEX IF NOT EXISTS idx_lotes_item         ON public.lotes(item_id);
CREATE INDEX IF NOT EXISTS idx_lotes_almacen      ON public.lotes(almacen_id);
CREATE INDEX IF NOT EXISTS idx_lotes_carpeta      ON public.lotes(carpeta_importacion_id);

-- Periodos
CREATE INDEX IF NOT EXISTS idx_periodos_estado    ON public.periodos_contables(estado);

-- Letras de cambio
CREATE INDEX IF NOT EXISTS idx_letras_contact     ON public.letras_cambio(contact_id);
CREATE INDEX IF NOT EXISTS idx_letras_estado      ON public.letras_cambio(estado);
CREATE INDEX IF NOT EXISTS idx_letras_vto         ON public.letras_cambio(fecha_vencimiento);

-- Carpetas importación
CREATE INDEX IF NOT EXISTS idx_carpetas_estado    ON public.carpetas_importacion(estado);
CREATE INDEX IF NOT EXISTS idx_carpetas_proveedor ON public.carpetas_importacion(proveedor_id);
