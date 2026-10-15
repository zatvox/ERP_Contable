-- ============================================================================
-- 86_importaciones_ledger_costos.sql  (2026-10-13)
-- FASE A del módulo de Importaciones: UN SOLO LEDGER de costos por carpeta.
--
-- Reemplaza los 3 modelos paralelos que había (gastos_locales para el tab 5,
-- nada para el tab 7 "Despacho", campos fijos en el form para el tab 8
-- "Financieros") por una sola tabla de líneas de costo clasificadas.
--
-- Fórmula que implementa (conciliada con los 2 Excel de costeo del lote
-- MB31539 / DAM 118-2026-10-436155-00):
--   Costo contable (NIC 2) = CIF + Ad Valorem (incl. adicional por duda
--     razonable) + gastos de nacionalización SIN IGV.
--   Costo de gestión       = Costo contable + reposición (% del CIF) +
--     comisiones bancarias (si el parámetro está activo).
--   NO son costo: IGV, IPM, percepción 3.5% (créditos) ni intereses.
--   El IPM se rige por las normas del IGV (art. 76 TUO LTM) → crédito fiscal.
--
-- Estructura:
--   contenedores            : N por carpeta (el BL puede traer varios).
--   documentos_importacion  : el comprobante físico (1 PDF → N líneas de
--                             costo). NO tiene carpeta: un mismo documento
--                             puede repartirse entre 2 carpetas.
--   importacion_costos      : el ledger. Cada línea sabe a qué carpeta va,
--                             cómo se clasifica y con qué base se prorratea.
--   dam_autoliquidaciones   : N autoliquidaciones por DAM (duda razonable).
--   importacion_parametros  : defaults activables (reposición %, bancarios).
--
-- Enlaces al resto del ERP: documentos_importacion.compra_id (Registro de
-- Compras / PDT 621) y .cxp_id (cuentas_pagar → pagos_proveedores).
--
-- Idempotente. Requiere 01_schema.sql, 60_adjuntos_cobros_pagos.sql y 81.
-- ============================================================================
BEGIN;

-- ============================================================
-- 1. CONTENEDORES  (tab 7 los usaba como <select> sin tabla)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.contenedores (
  id                      bigserial   PRIMARY KEY,
  carpeta_importacion_id  bigint      NOT NULL REFERENCES public.carpetas_importacion(id) ON DELETE CASCADE,
  bill_of_lading_id       bigint      REFERENCES public.bill_of_ladings(id) ON DELETE SET NULL,
  numero                  varchar     NOT NULL,            -- ej. ONEU1234567
  tipo                    varchar     DEFAULT '40HC',      -- 20GP / 40GP / 40HC / LCL
  numero_precinto         varchar,
  peso_bruto              numeric     DEFAULT 0,
  bultos                  integer     DEFAULT 0,
  canal                   varchar     CHECK (canal IS NULL OR canal IN ('verde','naranja','rojo')),
  fecha_eta               date,
  fecha_llegada           date,
  fecha_retiro            date,
  observaciones           text,
  created_by              bigint      REFERENCES public.users(id),
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now(),
  CONSTRAINT contenedores_carpeta_numero_uk UNIQUE (carpeta_importacion_id, numero)
);
CREATE INDEX IF NOT EXISTS idx_contenedores_carpeta ON public.contenedores(carpeta_importacion_id);
CREATE INDEX IF NOT EXISTS idx_contenedores_bl      ON public.contenedores(bill_of_lading_id);

COMMENT ON TABLE public.contenedores IS
  'Contenedores de una carpeta de importación. Es una DIMENSIÓN del costeo, no un nivel jerárquico: un contenedor puede repartirse entre 2 DAMs (levante parcial) y una DAM puede traer varios contenedores.';

-- ============================================================
-- 2. DOCUMENTOS DE IMPORTACIÓN  (el comprobante físico)
-- ============================================================
-- Un documento puede sustentar N líneas de costo, y esas líneas pueden caer
-- en carpetas distintas (ej. la factura del agente que cubre 2 DAMs). Por eso
-- el documento NO tiene carpeta_importacion_id.
CREATE TABLE IF NOT EXISTS public.documentos_importacion (
  id                  bigserial   PRIMARY KEY,
  tipo                varchar     NOT NULL DEFAULT 'factura'
                        CHECK (tipo IN ('proforma','invoice','factura','boleta','rh','liquidacion_sunat',
                                        'dam','autoliquidacion','nota_credito','nota_debito',
                                        'voucher_bancario','poliza','sin_comprobante','otro')),
  tipo_comprobante    varchar,    -- código SUNAT (01,02,91,...) cuando va al Registro de Compras
  serie               varchar,
  numero              varchar,
  proveedor_id        bigint      REFERENCES public.contacts(id),
  fecha_emision       date        NOT NULL,
  fecha_vencimiento   date,
  -- Moneda. tipo_cambio = SOLES POR 1 USD, siempre, sea la moneda que sea.
  moneda              varchar     NOT NULL DEFAULT 'USD' CHECK (moneda IN ('USD','PEN','EUR')),
  tipo_cambio         numeric     NOT NULL DEFAULT 1 CHECK (tipo_cambio > 0),
  monto_sin_igv       numeric     NOT NULL DEFAULT 0,
  igv_monto           numeric     NOT NULL DEFAULT 0,
  monto_total         numeric     NOT NULL DEFAULT 0,
  -- Recibo por honorarios (agente interno): el COSTO es el bruto.
  retencion_4ta       numeric     DEFAULT 0,
  neto_pagado         numeric,
  -- Enlaces al resto del ERP
  compra_id           bigint      REFERENCES public.compras(id) ON DELETE SET NULL,
  cxp_id              bigint      REFERENCES public.cuentas_pagar(id) ON DELETE SET NULL,
  estado_pago         varchar     DEFAULT 'pendiente'
                        CHECK (estado_pago IN ('pendiente','parcial','pagado','no_aplica')),
  -- Ciclo provisional → definitivo
  es_provisional      boolean     NOT NULL DEFAULT false,  -- proforma/estimado del agente
  sustentado          boolean     NOT NULL DEFAULT true,   -- false = sin comprobante válido
  observaciones        text,
  created_by          bigint      REFERENCES public.users(id),
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_docimp_proveedor ON public.documentos_importacion(proveedor_id);
CREATE INDEX IF NOT EXISTS idx_docimp_compra    ON public.documentos_importacion(compra_id);
CREATE INDEX IF NOT EXISTS idx_docimp_cxp       ON public.documentos_importacion(cxp_id);
CREATE INDEX IF NOT EXISTS idx_docimp_fecha     ON public.documentos_importacion(fecha_emision);

-- No registrar dos veces el mismo comprobante del mismo proveedor.
CREATE UNIQUE INDEX IF NOT EXISTS idx_docimp_comprobante_uk
  ON public.documentos_importacion(proveedor_id, tipo_comprobante, serie, numero)
  WHERE proveedor_id IS NOT NULL AND serie IS NOT NULL AND numero IS NOT NULL;

COMMENT ON TABLE public.documentos_importacion IS
  'Comprobante que sustenta gastos de importación (factura, RH, liquidación SUNAT, voucher). 1 documento → N líneas en importacion_costos, posiblemente de carpetas distintas. compra_id lo lleva al Registro de Compras / PDT 621; cxp_id al módulo de Cobranzas (CxP y pagos).';
COMMENT ON COLUMN public.documentos_importacion.tipo_cambio IS
  'Soles por 1 USD, SIEMPRE (también en documentos en PEN). Así el costeo en USD y el asiento en PEN salen del mismo campo.';
COMMENT ON COLUMN public.documentos_importacion.es_provisional IS
  'true = proforma/estimado del agente de aduana. Al llegar las facturas reales se liquida con N líneas definitivas (ver importacion_costos.provisional_de_id).';

-- ============================================================
-- 3. IMPORTACION_COSTOS  (el ledger — tabs 5, 7 y 8 juntos)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.importacion_costos (
  id                      bigserial   PRIMARY KEY,
  carpeta_importacion_id  bigint      NOT NULL REFERENCES public.carpetas_importacion(id) ON DELETE CASCADE,
  documento_id            bigint      REFERENCES public.documentos_importacion(id) ON DELETE SET NULL,
  contenedor_id           bigint      REFERENCES public.contenedores(id) ON DELETE SET NULL,
  -- Agrupación de pantalla (los 3 tabs viejos + CIF y tributos)
  grupo                   varchar     NOT NULL
                            CHECK (grupo IN ('cif','tributos','nacionalizacion','despacho','financiero','ajuste')),
  concepto                varchar     NOT NULL,
  concepto_codigo         varchar,    -- flete, seguro, ad_valorem, igv, ipm, percepcion, almacen,
                                      -- thc, gate_in, visto_bueno, transporte_local, cuadrilla,
                                      -- comision_aduanas, comision_interna, boletin_quimico,
                                      -- reposicion, comision_bancaria, interes, otro
  -- Clasificación contable: es lo único que decide si la plata es costo
  clasificacion           varchar     NOT NULL
                            CHECK (clasificacion IN ('inventario','solo_gestion','credito_fiscal',
                                                     'percepcion','gasto_financiero','no_costo')),
  entra_costo_contable    boolean,    -- NIC 2  → lotes.costo_unitario   (NULL = lo deriva el trigger)
  entra_costo_gestion     boolean,    -- gerencial → lotes.costo_real    (NULL = lo deriva el trigger)
  -- Importes. tipo_cambio = soles por 1 USD, siempre.
  moneda                  varchar     NOT NULL DEFAULT 'USD' CHECK (moneda IN ('USD','PEN','EUR')),
  tipo_cambio             numeric     NOT NULL DEFAULT 1 CHECK (tipo_cambio > 0),
  monto_moneda            numeric     NOT NULL DEFAULT 0,   -- en la moneda de la línea (puede ser negativo: NC)
  monto_usd               numeric     NOT NULL DEFAULT 0,   -- lo calcula el trigger
  monto_pen               numeric     NOT NULL DEFAULT 0,   -- lo calcula el trigger
  igv_monto               numeric     NOT NULL DEFAULT 0,   -- informativo: el IGV va en su propia línea
  -- Prorrateo
  base_prorrateo          varchar     NOT NULL DEFAULT 'valor_fob'
                            CHECK (base_prorrateo IN ('valor_fob','peso_neto','peso_bruto','bultos','directo')),
  detalle_ci_id           bigint      REFERENCES public.detalle_comercial_invoice(id) ON DELETE SET NULL,
  -- Ciclo provisional → definitivo
  es_provisional          boolean     NOT NULL DEFAULT false,
  provisional_de_id       bigint      REFERENCES public.importacion_costos(id) ON DELETE SET NULL,
  castigada               boolean     NOT NULL DEFAULT false,  -- provisional que "no se facturará"
  -- Estado
  anulado                 boolean     NOT NULL DEFAULT false,
  observaciones           text,
  created_by              bigint      REFERENCES public.users(id),
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now(),
  -- Una línea 'directo' tiene que decir A QUÉ línea de la CI se carga.
  CONSTRAINT importacion_costos_directo_ck
    CHECK (base_prorrateo <> 'directo' OR detalle_ci_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_impcosto_carpeta     ON public.importacion_costos(carpeta_importacion_id);
CREATE INDEX IF NOT EXISTS idx_impcosto_documento   ON public.importacion_costos(documento_id);
CREATE INDEX IF NOT EXISTS idx_impcosto_contenedor  ON public.importacion_costos(contenedor_id);
CREATE INDEX IF NOT EXISTS idx_impcosto_grupo       ON public.importacion_costos(carpeta_importacion_id, grupo);
CREATE INDEX IF NOT EXISTS idx_impcosto_provisional ON public.importacion_costos(provisional_de_id);
CREATE INDEX IF NOT EXISTS idx_impcosto_detalle_ci  ON public.importacion_costos(detalle_ci_id);

COMMENT ON TABLE public.importacion_costos IS
  'Ledger único de costos de una carpeta de importación. Unifica los tabs 5 (Gastos locales), 7 (Gastos de despacho) y 8 (Gastos financieros): son el mismo dato, solo cambia el grupo. El costo NO se escribe a mano: sale de clasificacion + entra_costo_contable/gestion.';
COMMENT ON COLUMN public.importacion_costos.clasificacion IS
  'inventario = costo NIC 2 y gestión (CIF, ad valorem, nacionalización sin IGV). solo_gestion = costo gerencial no NIC 2 (reposición % del CIF). credito_fiscal = IGV e IPM (art. 76 TUO LTM). percepcion = anticipo IGV 3.5% (cta. 40113). gasto_financiero = comisiones bancarias e intereses. no_costo = informativo.';
COMMENT ON COLUMN public.importacion_costos.base_prorrateo IS
  'valor_fob (default; tributos y comisiones % del valor) · peso_neto · peso_bruto (flete y servicios físicos) · bultos · directo (gasto atribuible a UNA línea de la CI, requiere detalle_ci_id).';

-- ============================================================
-- 4. AUTOLIQUIDACIONES DE LA DAM  (duda razonable)
-- ============================================================
-- Llegan semanas después de la DAM, con su propia fecha y T.C., y cada
-- componente va a un lado distinto: ad valorem = costo, IGV/IPM = crédito
-- fiscal DEL MES DE LA AUTOLIQUIDACIÓN, intereses = gasto financiero.
CREATE TABLE IF NOT EXISTS public.dam_autoliquidaciones (
  id                bigserial   PRIMARY KEY,
  dam_id            bigint      NOT NULL REFERENCES public.dams(id) ON DELETE CASCADE,
  numero            varchar     NOT NULL,              -- ej. 118-329439-26
  motivo            varchar     NOT NULL DEFAULT 'duda_razonable'
                      CHECK (motivo IN ('duda_razonable','ajuste_valor','error_clasificacion','otro')),
  fecha             date        NOT NULL,
  tipo_cambio       numeric     CHECK (tipo_cambio IS NULL OR tipo_cambio > 0),
  ad_valorem_usd    numeric     NOT NULL DEFAULT 0,    -- COSTO
  ipm_usd           numeric     NOT NULL DEFAULT 0,    -- crédito fiscal
  igv_usd           numeric     NOT NULL DEFAULT 0,    -- crédito fiscal
  intereses_usd     numeric     NOT NULL DEFAULT 0,    -- gasto financiero
  garantia_tipo     varchar     CHECK (garantia_tipo IS NULL OR garantia_tipo IN ('carta_fianza','deposito','poliza','ninguna')),
  garantia_monto    numeric     DEFAULT 0,
  estado            varchar     NOT NULL DEFAULT 'pendiente'
                      CHECK (estado IN ('pendiente','pagada','desestimada')),
  observaciones     text,
  created_by        bigint      REFERENCES public.users(id),
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  CONSTRAINT dam_autoliq_numero_uk UNIQUE (dam_id, numero)
);
CREATE INDEX IF NOT EXISTS idx_dam_autoliq_dam ON public.dam_autoliquidaciones(dam_id);

COMMENT ON TABLE public.dam_autoliquidaciones IS
  'Autoliquidaciones de una DAM (duda razonable y otros ajustes de valor). N por DAM: puede haber más de una. estado=desestimada cuando se sustenta el precio y se libera la garantía (hay que reversar las líneas de costo).';

-- ============================================================
-- 5. PARÁMETROS DE COSTEO (defaults activables en Configuración)
-- ============================================================
-- Viven en BD y no en localStorage (como config-modulo.js) porque afectan el
-- COSTO: si cada navegador tuviera su valor, dos usuarios verían dos costos
-- distintos para la misma carpeta y no habría nada que auditar.
CREATE TABLE IF NOT EXISTS public.importacion_parametros (
  id                bigserial   PRIMARY KEY,
  clave             varchar     NOT NULL UNIQUE,
  etiqueta          varchar     NOT NULL,
  tipo              varchar     NOT NULL CHECK (tipo IN ('porcentaje','monto','switch')),
  valor             numeric     NOT NULL DEFAULT 0,
  base              varchar     CHECK (base IS NULL OR base IN ('cif','fob','cif_tributos','fijo')),
  moneda            varchar     DEFAULT 'USD' CHECK (moneda IN ('USD','PEN')),
  activo            boolean     NOT NULL DEFAULT true,
  grupo             varchar,
  concepto_codigo   varchar,
  clasificacion     varchar,
  orden             integer     DEFAULT 0,
  descripcion       text,
  updated_at        timestamptz DEFAULT now()
);

INSERT INTO public.importacion_parametros
  (clave, etiqueta, tipo, valor, base, moneda, activo, grupo, concepto_codigo, clasificacion, orden, descripcion)
VALUES
  ('reposicion_pct', 'Costo de reposición (% del CIF)', 'porcentaje', 1.5, 'cif', 'USD', true,
   'ajuste', 'reposicion', 'solo_gestion', 10,
   'Política interna de Luis. No cumple NIC 2 ni LIR (no es desembolso), así que entra SOLO al costo de gestión. En el Excel 2 figuraba como "Costo de oportunidad".'),
  ('bancarios_al_costo', 'Comisiones bancarias entran al costo de gestión', 'switch', 1, NULL, 'USD', true,
   'financiero', 'comision_bancaria', 'gasto_financiero', 20,
   'Zona gris: NIC 23 las trata como gasto financiero (costo contable NO), pero el costeo de gestión sí las absorbe como desembolso real.'),
  ('tolerancia_definitivo_pct', 'Alerta si el definitivo se desvía del provisional (%)', 'porcentaje', 5, 'fijo', 'USD', true,
   NULL, NULL, NULL, 30,
   'Al cerrar la carpeta, si una línea definitiva se desvía más de este % de su provisional, pide confirmación y motivo.'),
  ('comision_interna_default', 'Comisión de agente interno por contenedor', 'monto', 250, 'fijo', 'USD', true,
   'nacionalizacion', 'comision_interna', 'inventario', 40,
   'Monto fijo editable por contenedor. Debe sustentarse con Recibo por Honorarios: el costo es el BRUTO, la retención de 4ta es pasivo.')
ON CONFLICT (clave) DO NOTHING;

COMMENT ON TABLE public.importacion_parametros IS
  'Valores por defecto del costeo de importación, activables. La carpeta copia estos valores a carpetas_importacion.parametros_snapshot al abrirse: cambiar un default NUNCA recalcula una carpeta ya abierta sin que alguien pulse "Actualizar parámetros".';

-- ============================================================
-- 6. CARPETAS_IMPORTACION: snapshot, doble costo, cierre y reapertura
-- ============================================================
ALTER TABLE public.carpetas_importacion
  ADD COLUMN IF NOT EXISTS parametros_snapshot   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS moneda_costeo         varchar     NOT NULL DEFAULT 'USD',
  -- Resultado del costeo, congelado al cerrar
  ADD COLUMN IF NOT EXISTS costo_contable_usd    numeric,
  ADD COLUMN IF NOT EXISTS costo_gestion_usd     numeric,
  ADD COLUMN IF NOT EXISTS costo_contable_pen    numeric,
  ADD COLUMN IF NOT EXISTS costo_gestion_pen     numeric,
  ADD COLUMN IF NOT EXISTS factor_contable       numeric,
  ADD COLUMN IF NOT EXISTS factor_gestion        numeric,
  ADD COLUMN IF NOT EXISTS peso_neto_costeo      numeric,    -- peso con el que se cerró (guía de ingreso)
  -- Trazabilidad de cierre / reapertura
  ADD COLUMN IF NOT EXISTS cerrada_por           bigint      REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS cerrada_at            timestamptz,
  ADD COLUMN IF NOT EXISTS reabierta_por         bigint      REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS reabierta_at          timestamptz,
  ADD COLUMN IF NOT EXISTS motivo_reapertura     text,
  ADD COLUMN IF NOT EXISTS veces_reabierta       integer     NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.carpetas_importacion.parametros_snapshot IS
  'Copia de importacion_parametros al abrir la carpeta: {"reposicion_pct":1.5,"bancarios_al_costo":1,...}. Evita que cambiar un default mueva el costo de carpetas ya en curso.';
COMMENT ON COLUMN public.carpetas_importacion.factor_contable IS
  'F.D. NIC 2 = costo_contable / FOB. En el lote MB31539 el Excel 2 daba 1.3082 (39,419.48 / 30,131.97).';

-- ============================================================
-- 7. La CARPETA es el eje: carpeta_importacion_id en las operativas
-- ============================================================
ALTER TABLE public.bill_of_ladings ADD COLUMN IF NOT EXISTS carpeta_importacion_id bigint REFERENCES public.carpetas_importacion(id) ON DELETE SET NULL;
ALTER TABLE public.dams            ADD COLUMN IF NOT EXISTS carpeta_importacion_id bigint REFERENCES public.carpetas_importacion(id) ON DELETE SET NULL;
ALTER TABLE public.guias_remision  ADD COLUMN IF NOT EXISTS carpeta_importacion_id bigint REFERENCES public.carpetas_importacion(id) ON DELETE SET NULL;
ALTER TABLE public.gastos_locales  ADD COLUMN IF NOT EXISTS carpeta_importacion_id bigint REFERENCES public.carpetas_importacion(id) ON DELETE SET NULL;
ALTER TABLE public.gastos_locales  ADD COLUMN IF NOT EXISTS migrado_costo_id       bigint REFERENCES public.importacion_costos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bl_carpeta    ON public.bill_of_ladings(carpeta_importacion_id);
CREATE INDEX IF NOT EXISTS idx_dams_carpeta  ON public.dams(carpeta_importacion_id);
CREATE INDEX IF NOT EXISTS idx_gr_carpeta    ON public.guias_remision(carpeta_importacion_id);
CREATE INDEX IF NOT EXISTS idx_gl_carpeta    ON public.gastos_locales(carpeta_importacion_id);

COMMENT ON COLUMN public.gastos_locales.migrado_costo_id IS
  'Fila ya trasladada al ledger importacion_costos. La tabla vieja se conserva como respaldo (no se borra sin confirmación de Luis).';

-- ============================================================
-- 8. DETALLE DE LA CI: qué se inventaria y a qué lote fue
-- ============================================================
ALTER TABLE public.detalle_comercial_invoice
  ADD COLUMN IF NOT EXISTS inventariable             boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS lote_id                   bigint  REFERENCES public.lotes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cantidad_recibida         numeric,   -- peso real de la guía de ingreso
  ADD COLUMN IF NOT EXISTS costo_contable_unitario   numeric,   -- resultado del prorrateo (Fase D)
  ADD COLUMN IF NOT EXISTS costo_gestion_unitario    numeric;
CREATE INDEX IF NOT EXISTS idx_detci_lote ON public.detalle_comercial_invoice(lote_id);

COMMENT ON COLUMN public.detalle_comercial_invoice.inventariable IS
  'false = muestras, embalaje gratuito o repuestos: consumen flete y tributos pero no se venden. Absorben su prorrateo y van a gasto, no inflan el costo de lo vendible.';
COMMENT ON COLUMN public.detalle_comercial_invoice.cantidad_recibida IS
  'Peso realmente recibido (guía de ingreso). El costo unitario final se calcula sobre ESTE peso, no sobre el declarado: la diferencia es merma y se reporta, no se diluye.';

-- ============================================================
-- 9. ADJUNTOS: ampliar entidades y conceptos
-- ============================================================
ALTER TABLE public.adjuntos DROP CONSTRAINT IF EXISTS adjuntos_entidad_check;
ALTER TABLE public.adjuntos ADD CONSTRAINT adjuntos_entidad_check
  CHECK (entidad IN ('cobro','pago','letra','compra','packing',
                     'carpeta_importacion','documento_importacion','costo_importacion',
                     'comercial_invoice','bill_of_lading','contenedor','dam',
                     'autoliquidacion','guia_remision'));

ALTER TABLE public.adjuntos DROP CONSTRAINT IF EXISTS adjuntos_concepto_check;
ALTER TABLE public.adjuntos ADD CONSTRAINT adjuntos_concepto_check
  CHECK (concepto IN ('voucher','recibo','dietario','otro',
                      'invoice','proforma','bl','dam','liquidacion','autoliquidacion',
                      'factura_gasto','rh','poliza','packing','boletin','guia'));

-- ============================================================
-- 10. TRIGGERS: que el dato no pueda nacer descuadrado
-- ============================================================

-- 10.a Montos USD/PEN y flags de costo: los calcula la BD, no el JS.
CREATE OR REPLACE FUNCTION public.fn_importacion_costos_normalizar()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.tipo_cambio IS NULL OR NEW.tipo_cambio <= 0 THEN
    NEW.tipo_cambio := 1;
  END IF;

  -- tipo_cambio = soles por 1 USD, siempre.
  IF NEW.moneda = 'PEN' THEN
    NEW.monto_pen := round(NEW.monto_moneda, 6);
    NEW.monto_usd := round(NEW.monto_moneda / NEW.tipo_cambio, 6);
  ELSE
    NEW.monto_usd := round(NEW.monto_moneda, 6);
    NEW.monto_pen := round(NEW.monto_moneda * NEW.tipo_cambio, 6);
  END IF;

  -- Flags derivados de la clasificación cuando el llamador no los fija.
  IF NEW.entra_costo_contable IS NULL THEN
    NEW.entra_costo_contable := (NEW.clasificacion = 'inventario');
  END IF;
  IF NEW.entra_costo_gestion IS NULL THEN
    NEW.entra_costo_gestion := (NEW.clasificacion IN ('inventario','solo_gestion','gasto_financiero'));
  END IF;

  -- Una línea anulada o castigada no cuesta nada.
  IF NEW.anulado OR NEW.castigada THEN
    NEW.entra_costo_contable := false;
    NEW.entra_costo_gestion  := false;
  END IF;

  -- Coherencia: lo que no es inventario no puede entrar al costo contable.
  IF NEW.clasificacion <> 'inventario' AND NEW.entra_costo_contable THEN
    RAISE EXCEPTION 'Una línea clasificada como "%" no puede entrar al costo contable NIC 2. Cámbiala a "inventario" o desmárcala.', NEW.clasificacion
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_importacion_costos_normalizar ON public.importacion_costos;
CREATE TRIGGER trg_importacion_costos_normalizar
  BEFORE INSERT OR UPDATE ON public.importacion_costos
  FOR EACH ROW EXECUTE FUNCTION public.fn_importacion_costos_normalizar();

-- 10.b Carpeta cerrada o anulada = ledger de solo lectura.
CREATE OR REPLACE FUNCTION public.fn_importacion_carpeta_abierta()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v_carpeta bigint;
  v_estado  varchar;
  v_numero  varchar;
BEGIN
  v_carpeta := COALESCE(NEW.carpeta_importacion_id, OLD.carpeta_importacion_id);
  SELECT estado, numero_carpeta INTO v_estado, v_numero
    FROM public.carpetas_importacion WHERE id = v_carpeta;

  IF v_estado IN ('cerrada','anulada') THEN
    RAISE EXCEPTION 'La carpeta % está %: reábrela (con motivo) antes de tocar sus costos.', COALESCE(v_numero, v_carpeta::text), v_estado
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$fn$;

DROP TRIGGER IF EXISTS trg_importacion_costos_carpeta_abierta ON public.importacion_costos;
CREATE TRIGGER trg_importacion_costos_carpeta_abierta
  BEFORE INSERT OR UPDATE OR DELETE ON public.importacion_costos
  FOR EACH ROW EXECUTE FUNCTION public.fn_importacion_carpeta_abierta();

-- 10.c updated_at en las tablas nuevas que lo tienen.
CREATE OR REPLACE FUNCTION public.fn_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_contenedores_touch ON public.contenedores;
CREATE TRIGGER trg_contenedores_touch BEFORE UPDATE ON public.contenedores
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();

DROP TRIGGER IF EXISTS trg_docimp_touch ON public.documentos_importacion;
CREATE TRIGGER trg_docimp_touch BEFORE UPDATE ON public.documentos_importacion
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();

DROP TRIGGER IF EXISTS trg_dam_autoliq_touch ON public.dam_autoliquidaciones;
CREATE TRIGGER trg_dam_autoliq_touch BEFORE UPDATE ON public.dam_autoliquidaciones
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();

-- ============================================================
-- 11. VISTAS
-- ============================================================

-- 11.a El ledger ya resuelto (proveedor, documento, contenedor).
CREATE OR REPLACE VIEW public.v_importacion_costos AS
SELECT
  k.id, k.carpeta_importacion_id, c.numero_carpeta, c.estado AS carpeta_estado,
  k.grupo, k.concepto, k.concepto_codigo, k.clasificacion,
  k.entra_costo_contable, k.entra_costo_gestion,
  k.moneda, k.tipo_cambio, k.monto_moneda, k.monto_usd, k.monto_pen, k.igv_monto,
  k.base_prorrateo, k.detalle_ci_id,
  k.es_provisional, k.provisional_de_id, k.castigada, k.anulado,
  k.observaciones, k.created_at,
  d.id         AS documento_id,
  d.tipo       AS documento_tipo,
  d.tipo_comprobante,
  NULLIF(TRIM(CONCAT_WS('-', d.serie, d.numero)), '') AS documento_numero,
  d.fecha_emision,
  d.estado_pago,
  d.sustentado,
  d.compra_id, d.cxp_id,
  p.id         AS proveedor_id,
  p.nombre     AS proveedor_nombre,
  p.nro_documento AS proveedor_documento,
  ct.id        AS contenedor_id,
  ct.numero    AS contenedor_numero
FROM public.importacion_costos k
JOIN public.carpetas_importacion c      ON c.id  = k.carpeta_importacion_id
LEFT JOIN public.documentos_importacion d ON d.id = k.documento_id
LEFT JOIN public.contacts p             ON p.id  = d.proveedor_id
LEFT JOIN public.contenedores ct        ON ct.id = k.contenedor_id;

COMMENT ON VIEW public.v_importacion_costos IS
  'Fuente única de los tabs 5/7/8 del módulo de importaciones. Filtrar por grupo para cada tab.';

-- 11.b Cuadre de un documento repartido entre varias carpetas.
CREATE OR REPLACE VIEW public.v_importacion_doc_cuadre AS
SELECT
  d.id AS documento_id,
  d.tipo, d.tipo_comprobante, d.serie, d.numero, d.fecha_emision,
  d.proveedor_id, d.moneda, d.tipo_cambio,
  d.monto_total,
  COALESCE(SUM(k.monto_moneda) FILTER (WHERE NOT k.anulado), 0)        AS monto_asignado,
  COALESCE(SUM(k.igv_monto)    FILTER (WHERE NOT k.anulado), 0)       AS igv_asignado,
  d.monto_total - COALESCE(SUM(k.monto_moneda + k.igv_monto) FILTER (WHERE NOT k.anulado), 0) AS pendiente_asignar,
  COUNT(k.id) FILTER (WHERE NOT k.anulado)                             AS lineas,
  COUNT(DISTINCT k.carpeta_importacion_id) FILTER (WHERE NOT k.anulado) AS carpetas
FROM public.documentos_importacion d
LEFT JOIN public.importacion_costos k ON k.documento_id = d.id
GROUP BY d.id;

COMMENT ON VIEW public.v_importacion_doc_cuadre IS
  'Control del caso "una factura cubre 2 DAMs": pendiente_asignar debe quedar en 0. Si no, falta repartir el documento.';

-- 11.c Resumen por carpeta = la hoja "Costeo Real" del Excel, calculada.
CREATE OR REPLACE VIEW public.v_importacion_resumen AS
WITH pesos AS (
  SELECT ci.carpeta_importacion_id          AS carpeta_id,
         SUM(COALESCE(d.cantidad_recibida, d.cantidad_neto))  AS peso_neto,
         SUM(d.cantidad_gross)                                AS peso_bruto,
         SUM(d.cantidad_unid)                                 AS bultos,
         SUM(d.costo_total)                                   AS fob_detalle
  FROM public.detalle_comercial_invoice d
  JOIN public.comercial_invoices ci ON ci.id = d.comercial_invoice_id
  WHERE COALESCE(d.inventariable, true)
    AND ci.carpeta_importacion_id IS NOT NULL
  GROUP BY ci.carpeta_importacion_id
),
ledger AS (
  SELECT k.carpeta_importacion_id AS carpeta_id,
         SUM(k.monto_usd) FILTER (WHERE k.entra_costo_contable)                      AS costo_contable_usd,
         SUM(k.monto_pen) FILTER (WHERE k.entra_costo_contable)                      AS costo_contable_pen,
         SUM(k.monto_usd) FILTER (WHERE k.entra_costo_gestion)                       AS costo_gestion_usd,
         SUM(k.monto_pen) FILTER (WHERE k.entra_costo_gestion)                       AS costo_gestion_pen,
         SUM(k.monto_usd) FILTER (WHERE k.grupo = 'cif')                             AS cif_usd,
         SUM(k.monto_usd) FILTER (WHERE k.clasificacion = 'credito_fiscal')          AS credito_fiscal_usd,
         SUM(k.monto_usd) FILTER (WHERE k.clasificacion = 'percepcion')              AS percepcion_usd,
         SUM(k.monto_usd) FILTER (WHERE k.clasificacion = 'gasto_financiero')        AS financiero_usd,
         SUM(k.monto_usd) FILTER (WHERE k.clasificacion = 'solo_gestion')            AS solo_gestion_usd,
         SUM(k.monto_usd)                                                            AS desembolso_usd,
         COUNT(*) FILTER (WHERE k.es_provisional AND NOT k.castigada)                 AS lineas_provisionales,
         COUNT(*) FILTER (WHERE NOT COALESCE(d.sustentado, true))                     AS lineas_sin_sustento
  FROM public.importacion_costos k
  LEFT JOIN public.documentos_importacion d ON d.id = k.documento_id
  WHERE NOT k.anulado
  GROUP BY k.carpeta_importacion_id
)
SELECT
  c.id AS carpeta_id, c.numero_carpeta, c.descripcion, c.estado,
  c.proveedor_id, c.fecha_apertura, c.fecha_cierre, c.numero_dam,
  c.moneda_costeo, c.parametros_snapshot,
  COALESCE(p.peso_neto, 0)   AS peso_neto,
  COALESCE(p.peso_bruto, 0)  AS peso_bruto,
  COALESCE(p.bultos, 0)      AS bultos,
  COALESCE(p.fob_detalle, c.fob_total_usd, 0) AS fob_usd,
  COALESCE(l.cif_usd, 0)              AS cif_usd,
  COALESCE(l.costo_contable_usd, 0)   AS costo_contable_usd,
  COALESCE(l.costo_contable_pen, 0)   AS costo_contable_pen,
  COALESCE(l.costo_gestion_usd, 0)    AS costo_gestion_usd,
  COALESCE(l.costo_gestion_pen, 0)    AS costo_gestion_pen,
  COALESCE(l.credito_fiscal_usd, 0)   AS credito_fiscal_usd,
  COALESCE(l.percepcion_usd, 0)       AS percepcion_usd,
  COALESCE(l.financiero_usd, 0)       AS financiero_usd,
  COALESCE(l.solo_gestion_usd, 0)     AS solo_gestion_usd,
  COALESCE(l.desembolso_usd, 0)       AS desembolso_usd,
  COALESCE(l.lineas_provisionales, 0) AS lineas_provisionales,
  COALESCE(l.lineas_sin_sustento, 0)  AS lineas_sin_sustento,
  CASE WHEN COALESCE(p.peso_neto, 0) > 0
       THEN round(COALESCE(l.costo_contable_usd, 0) / p.peso_neto, 6) END AS costo_contable_kg,
  CASE WHEN COALESCE(p.peso_neto, 0) > 0
       THEN round(COALESCE(l.costo_gestion_usd, 0)  / p.peso_neto, 6) END AS costo_gestion_kg,
  CASE WHEN COALESCE(p.fob_detalle, c.fob_total_usd, 0) > 0
       THEN round(COALESCE(l.costo_contable_usd, 0) / COALESCE(p.fob_detalle, c.fob_total_usd), 6) END AS factor_contable_calc,
  CASE WHEN COALESCE(p.fob_detalle, c.fob_total_usd, 0) > 0
       THEN round(COALESCE(l.costo_gestion_usd, 0)  / COALESCE(p.fob_detalle, c.fob_total_usd), 6) END AS factor_gestion_calc
FROM public.carpetas_importacion c
LEFT JOIN pesos  p ON p.carpeta_id = c.id
LEFT JOIN ledger l ON l.carpeta_id = c.id;

COMMENT ON VIEW public.v_importacion_resumen IS
  'Resumen de costeo por carpeta: costo contable (NIC 2) vs costo de gestión, créditos fiscales, factor y costo por kg. Es la fuente del tab 9 (Resumen Final).';

COMMIT;

-- ============================================================
-- 12. MIGRACIÓN: toda CI necesita carpeta + gastos_locales → ledger
-- ============================================================
-- La carpeta pasa a ser el eje del módulo, así que cada Commercial Invoice
-- suelta recibe su carpeta. Después se traslada gastos_locales al ledger.
-- Todo con guardas: correrlo dos veces no duplica nada.
DO $mig$
DECLARE
  v_carpetas_creadas integer := 0;
  v_ci_sin_proveedor integer := 0;
  v_gastos_migrados  integer := 0;
  v_gastos_huerfanos integer := 0;
  r RECORD;
  v_carpeta_id bigint;
  v_doc_id     bigint;
  v_costo_id   bigint;
  v_clasif     varchar;
  v_grupo      varchar;
  v_tc         numeric;
  v_moneda     varchar;
  v_concepto   varchar;
  v_monto      numeric;
BEGIN
  -- 12.a Una carpeta por cada CI que no tenga
  FOR r IN
    SELECT ci.* FROM public.comercial_invoices ci
    WHERE ci.carpeta_importacion_id IS NULL
    ORDER BY ci.id
  LOOP
    IF r.contact_id IS NULL THEN
      v_ci_sin_proveedor := v_ci_sin_proveedor + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.carpetas_importacion
      (numero_carpeta, descripcion, proveedor_id, comercial_invoice_id, fecha_apertura,
       fob_total_usd, flete_usd, seguro_usd, cif_total_usd, estado, parametros_snapshot)
    VALUES
      ('IMP-' || LPAD(r.id::text, 4, '0'),
       COALESCE(NULLIF(r.product, ''), 'Importación ' || COALESCE(r.invoice_number, r.id::text)),
       r.contact_id, r.id, COALESCE(r.fecha, r.created_at::date, CURRENT_DATE),
       COALESCE(r.valor_total_final_fob, r.valor_total_final_ci, 0),
       COALESCE(r.costo_flete, 0), COALESCE(r.costo_seguro, 0),
       COALESCE(r.valor_total_final_fob, r.valor_total_final_ci, 0)
         + COALESCE(r.costo_flete, 0) + COALESCE(r.costo_seguro, 0),
       'abierta',
       (SELECT COALESCE(jsonb_object_agg(clave, valor), '{}'::jsonb)
          FROM public.importacion_parametros WHERE activo))
    ON CONFLICT (numero_carpeta) DO NOTHING
    RETURNING id INTO v_carpeta_id;

    IF v_carpeta_id IS NULL THEN
      SELECT id INTO v_carpeta_id FROM public.carpetas_importacion
       WHERE numero_carpeta = 'IMP-' || LPAD(r.id::text, 4, '0');
    ELSE
      v_carpetas_creadas := v_carpetas_creadas + 1;
    END IF;

    UPDATE public.comercial_invoices SET carpeta_importacion_id = v_carpeta_id WHERE id = r.id;
  END LOOP;

  -- 12.b Heredar la carpeta en BL / DAM / guías / gastos (via su CI)
  UPDATE public.bill_of_ladings b SET carpeta_importacion_id = ci.carpeta_importacion_id
    FROM public.comercial_invoices ci
   WHERE ci.id = b.importacion_id AND b.carpeta_importacion_id IS NULL
     AND ci.carpeta_importacion_id IS NOT NULL;

  UPDATE public.dams d SET carpeta_importacion_id = ci.carpeta_importacion_id
    FROM public.comercial_invoices ci
   WHERE ci.id = d.importacion_id AND d.carpeta_importacion_id IS NULL
     AND ci.carpeta_importacion_id IS NOT NULL;

  UPDATE public.guias_remision g SET carpeta_importacion_id = ci.carpeta_importacion_id
    FROM public.comercial_invoices ci
   WHERE ci.id = g.importacion_id AND g.carpeta_importacion_id IS NULL
     AND ci.carpeta_importacion_id IS NOT NULL;

  UPDATE public.gastos_locales gl SET carpeta_importacion_id = ci.carpeta_importacion_id
    FROM public.comercial_invoices ci
   WHERE ci.id = gl.importacion_id AND gl.carpeta_importacion_id IS NULL
     AND ci.carpeta_importacion_id IS NOT NULL;

  -- 12.c Contenedores desde el texto libre de bill_of_ladings.contenedor_number
  INSERT INTO public.contenedores (carpeta_importacion_id, bill_of_lading_id, numero, numero_precinto, peso_bruto)
  SELECT b.carpeta_importacion_id, b.id, TRIM(b.contenedor_number), b.numero_precinto, b.peso_bruto
    FROM public.bill_of_ladings b
   WHERE b.carpeta_importacion_id IS NOT NULL
     AND COALESCE(TRIM(b.contenedor_number), '') <> ''
  ON CONFLICT (carpeta_importacion_id, numero) DO NOTHING;

  -- 12.d gastos_locales → documentos_importacion + importacion_costos
  FOR r IN
    SELECT gl.* FROM public.gastos_locales gl
    WHERE gl.migrado_costo_id IS NULL
    ORDER BY gl.id
  LOOP
    IF r.carpeta_importacion_id IS NULL THEN
      v_gastos_huerfanos := v_gastos_huerfanos + 1;
      CONTINUE;
    END IF;

    -- La tabla vieja guardaba monto_usd + monto_sol + tipo_cambio sin decir
    -- cuál era la moneda original: si hay soles, se asume que nació en soles.
    v_tc := CASE WHEN COALESCE(r.tipo_cambio, 0) > 0 THEN r.tipo_cambio ELSE 3.75 END;
    IF COALESCE(r.monto_sol, 0) > 0 AND COALESCE(r.monto_usd, 0) = 0 THEN
      v_moneda := 'PEN'; v_monto := r.monto_sol;
    ELSE
      v_moneda := 'USD'; v_monto := COALESCE(r.monto_usd, 0);
    END IF;

    -- tipo_gasto viejo → grupo, concepto y clasificación nuevos
    v_grupo  := CASE r.tipo_gasto WHEN 'comision' THEN 'despacho' ELSE 'nacionalizacion' END;
    v_concepto := CASE r.tipo_gasto
                    WHEN 'flete_local' THEN 'transporte_local'
                    WHEN 'cuadrilla'   THEN 'cuadrilla'
                    WHEN 'comision'    THEN 'comision_aduanas'
                    WHEN 'almacenaje'  THEN 'almacen'
                    ELSE 'otro' END;
    v_clasif := 'inventario';

    INSERT INTO public.documentos_importacion
      (tipo, serie, numero, proveedor_id, fecha_emision, moneda, tipo_cambio,
       monto_sin_igv, igv_monto, monto_total, estado_pago, observaciones)
    VALUES
      ('factura', NULL, NULLIF(r.numero_documento, ''), NULL,
       COALESCE(r.fecha, CURRENT_DATE), v_moneda, v_tc,
       v_monto, 0, v_monto,
       CASE WHEN r.estado = 'pagado' THEN 'pagado' ELSE 'pendiente' END,
       'Migrado de gastos_locales #' || r.id ||
       CASE WHEN COALESCE(r.acreedor,'') <> '' THEN ' · acreedor: ' || r.acreedor ELSE '' END)
    RETURNING id INTO v_doc_id;

    INSERT INTO public.importacion_costos
      (carpeta_importacion_id, documento_id, grupo, concepto, concepto_codigo, clasificacion,
       moneda, tipo_cambio, monto_moneda, base_prorrateo, observaciones)
    VALUES
      (r.carpeta_importacion_id, v_doc_id, v_grupo, r.concepto,
       v_concepto, v_clasif,
       v_moneda, v_tc, v_monto, 'valor_fob',
       'Migrado de gastos_locales #' || r.id)
    RETURNING id INTO v_costo_id;

    UPDATE public.gastos_locales SET migrado_costo_id = v_costo_id WHERE id = r.id;
    v_gastos_migrados := v_gastos_migrados + 1;
  END LOOP;

  RAISE NOTICE '--- 86_importaciones_ledger_costos ---';
  RAISE NOTICE 'Carpetas creadas desde CI sueltas : %', v_carpetas_creadas;
  RAISE NOTICE 'CI sin proveedor (revisar a mano) : %', v_ci_sin_proveedor;
  RAISE NOTICE 'Gastos locales migrados al ledger : %', v_gastos_migrados;
  RAISE NOTICE 'Gastos locales sin carpeta        : %', v_gastos_huerfanos;
END;
$mig$;

-- ============================================================
-- 13. RLS + GRANTS
-- ============================================================
ALTER TABLE public.contenedores            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documentos_importacion  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.importacion_costos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dam_autoliquidaciones   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.importacion_parametros  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_all" ON public.contenedores;
CREATE POLICY "authenticated_all" ON public.contenedores FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON public.documentos_importacion;
CREATE POLICY "authenticated_all" ON public.documentos_importacion FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON public.importacion_costos;
CREATE POLICY "authenticated_all" ON public.importacion_costos FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON public.dam_autoliquidaciones;
CREATE POLICY "authenticated_all" ON public.dam_autoliquidaciones FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all" ON public.importacion_parametros;
CREATE POLICY "authenticated_all" ON public.importacion_parametros FOR ALL TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contenedores            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.documentos_importacion  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.importacion_costos      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dam_autoliquidaciones   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.importacion_parametros  TO authenticated;

GRANT USAGE, SELECT ON SEQUENCE public.contenedores_id_seq            TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.documentos_importacion_id_seq  TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.importacion_costos_id_seq      TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.dam_autoliquidaciones_id_seq   TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.importacion_parametros_id_seq  TO authenticated;

GRANT SELECT ON public.v_importacion_costos     TO authenticated;
GRANT SELECT ON public.v_importacion_doc_cuadre TO authenticated;
GRANT SELECT ON public.v_importacion_resumen    TO authenticated;
