-- ============================================================================
-- 124 · TESORERÍA — Gastos, entregas a rendir y reposiciones (Etapa T1–T3)
-- 2026-10-31 · Requiere el SQL 123 ya aplicado.
-- ----------------------------------------------------------------------------
-- Las tres piezas que reemplazan al Excel de caja chica:
--
--   gastos              → la fila del Excel, pero con los 3 ejes y su comprobante
--   entregas_a_rendir   → el "vuelto": se entrega S/100, se rinde S/60, vuelven S/40
--   reposiciones_caja   → el cierre: cuánto se gastó, cuánto hay, cuánto reponer
--
-- Analogía del vuelto: hoy el Excel netea (una fila con ingreso 100 y egreso 100,
-- ver REC-122) y el saldo corrido se distorsiona. Aquí la entrega es un préstamo
-- a la persona: sale de caja pero NO es gasto hasta que trae el comprobante.
--
-- NO BORRA NADA. IDEMPOTENTE.
-- ⚠ CONTABILIDAD FUERA DE ALCANCE: las columnas de asiento quedan creadas y
--   comentadas; ninguna función las escribe todavía.
-- ============================================================================

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 1 · Prefijo de recibo por caja (el REC-### del Excel)
-- ════════════════════════════════════════════════════════════════════════════
-- En el Excel la numeración salta (REC-116 → REC-41 → REC-119): dos series
-- mezcladas en una sola columna. Aquí el correlativo es POR CAJA.
ALTER TABLE public.bancos
  ADD COLUMN IF NOT EXISTS prefijo_recibo varchar NOT NULL DEFAULT 'REC';

COMMENT ON COLUMN public.bancos.prefijo_recibo IS
  'Prefijo del correlativo de gastos de esta caja (REC, REC-F para la familiar, etc). Evita el cruce de series del Excel.';

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 2 · GASTOS — la entidad central
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.gastos (
  id                     bigserial   PRIMARY KEY,
  numero_recibo          varchar     NOT NULL,
  fecha                  date        NOT NULL,

  -- ── Eje 1: de dónde salió la plata
  caja_id                integer     NOT NULL REFERENCES public.bancos(id),
  -- ── Eje 2: para quién fue
  ambito                 varchar     NOT NULL,
  empresa_id             integer     REFERENCES public.empresa_config(id),
  sede_id                integer     REFERENCES public.sedes(id),
  -- ── Eje 3: cómo se trata
  destino_costo          varchar     NOT NULL DEFAULT 'gasto_operativo',

  categoria_gasto_id     integer     NOT NULL REFERENCES public.categorias_gasto(id),
  responsable_contact_id bigint      REFERENCES public.contacts(id),
  detalle                varchar     NOT NULL,

  moneda                 varchar     NOT NULL DEFAULT 'PEN',
  tipo_cambio            numeric     NOT NULL DEFAULT 1,
  monto                  numeric     NOT NULL CHECK (monto > 0),

  -- ── Sustento
  tipo_sustento          varchar     NOT NULL DEFAULT 'sin_documento',
  estado_sustento        varchar,    -- NULL | 'pendiente' | 'conciliado' (mismo vocabulario del SQL 122)
  deducible              boolean     NOT NULL DEFAULT false,

  -- ── Enlaces (se llenan según el flujo)
  compra_id              bigint      REFERENCES public.compras(id),
  cxp_id                 bigint      REFERENCES public.cuentas_pagar(id),
  guia_despacho_id       bigint      REFERENCES public.guias_despacho_venta(id),
  movimiento_id          bigint      REFERENCES public.movimientos_banco(id),
  entrega_id             bigint,     -- FK se agrega en la PARTE 3
  reposicion_id          bigint,     -- FK se agrega en la PARTE 4
  asiento_id             bigint      REFERENCES public.journal_entries(id),

  observaciones          text,
  anulado                boolean     NOT NULL DEFAULT false,
  motivo_anulacion       text,
  created_by             bigint      REFERENCES public.users(id),
  created_at             timestamptz DEFAULT now(),
  updated_at             timestamptz DEFAULT now()
);

COMMENT ON TABLE public.gastos IS
  'Un gasto = una fila del Excel de caja chica. Puede tener comprobante (→ compra + CxP) o no (mercado). El movimiento de caja se crea aparte y se enlaza por movimiento_id.';
COMMENT ON COLUMN public.gastos.estado_sustento IS
  'pendiente = marcado como facturado pero la factura aún no llega. Es la bandeja "pendientes de factura". Mismo vocabulario que documentos_importacion.regularizacion (SQL 122).';
COMMENT ON COLUMN public.gastos.deducible IS
  'Se precarga de categorias_gasto.deducible_defecto. Sin comprobante de pago no hay gasto deducible (LIR art. 44 inc. j), pero el costo SÍ se registra para gestión.';
COMMENT ON COLUMN public.gastos.guia_despacho_id IS
  'Cuando destino_costo = costo_venta: liga el gasto (cargadores, peajes, combustible del camión) a la guía de despacho. Se liga a la GUÍA, no a la venta, porque una guía puede cubrir varias ventas.';
COMMENT ON COLUMN public.gastos.asiento_id IS
  '⚠ PENDIENTE módulo contable. Columna creada para no migrar después; hoy nadie la escribe.';

-- ★ El mismo candado del SQL 123: imposible guardar un gasto en estado inválido
ALTER TABLE public.gastos DROP CONSTRAINT IF EXISTS ck_gastos_ambito;
ALTER TABLE public.gastos ADD CONSTRAINT ck_gastos_ambito CHECK (
  (ambito = 'empresa'  AND empresa_id IS NOT NULL) OR
  (ambito = 'familiar' AND empresa_id IS NULL)
);

ALTER TABLE public.gastos DROP CONSTRAINT IF EXISTS ck_gastos_destino;
ALTER TABLE public.gastos ADD CONSTRAINT ck_gastos_destino CHECK (destino_costo IN
  ('gasto_operativo','costo_venta','viatico_reembolsable','gasto_personal','no_deducible'));

ALTER TABLE public.gastos DROP CONSTRAINT IF EXISTS ck_gastos_sustento;
ALTER TABLE public.gastos ADD CONSTRAINT ck_gastos_sustento CHECK (tipo_sustento IN
  ('factura','boleta','recibo_honorarios','vale','sin_documento'));

ALTER TABLE public.gastos DROP CONSTRAINT IF EXISTS ck_gastos_estado_sustento;
ALTER TABLE public.gastos ADD CONSTRAINT ck_gastos_estado_sustento
  CHECK (estado_sustento IS NULL OR estado_sustento IN ('pendiente','conciliado'));

-- Un gasto sin documento no puede ser deducible. La base lo impide.
ALTER TABLE public.gastos DROP CONSTRAINT IF EXISTS ck_gastos_deducible;
ALTER TABLE public.gastos ADD CONSTRAINT ck_gastos_deducible
  CHECK (NOT (deducible = true AND tipo_sustento = 'sin_documento'));

-- Correlativo único por caja (no global: cada caja lleva su propia serie)
CREATE UNIQUE INDEX IF NOT EXISTS ux_gastos_recibo_caja
  ON public.gastos(caja_id, numero_recibo) WHERE anulado = false;

CREATE INDEX IF NOT EXISTS idx_gastos_fecha      ON public.gastos(fecha);
CREATE INDEX IF NOT EXISTS idx_gastos_caja       ON public.gastos(caja_id);
CREATE INDEX IF NOT EXISTS idx_gastos_ambito     ON public.gastos(ambito);
CREATE INDEX IF NOT EXISTS idx_gastos_categoria  ON public.gastos(categoria_gasto_id);
CREATE INDEX IF NOT EXISTS idx_gastos_resp       ON public.gastos(responsable_contact_id);
CREATE INDEX IF NOT EXISTS idx_gastos_pendientes ON public.gastos(estado_sustento) WHERE estado_sustento = 'pendiente';

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 3 · ENTREGAS A RENDIR — el vuelto, bien modelado
-- ════════════════════════════════════════════════════════════════════════════
-- Flujo real descrito por Luis: la tesorera entrega efectivo o Yape → el
-- empleado compra y vuelve con el comprobante → normalmente hay vuelto.
-- El Excel netea esto en una sola fila y rompe el saldo. Aquí:
--   1. Entrega  → sale de caja, NO es gasto todavía (es un préstamo)
--   2. Rendición→ nacen los gastos con su comprobante
--   3. Devuelto → reingresa a caja
-- Además responde "¿cuánto efectivo hay en manos de la gente sin rendir?",
-- que es la bandeja de pendientes del día anterior.
CREATE TABLE IF NOT EXISTS public.entregas_a_rendir (
  id                     bigserial   PRIMARY KEY,
  caja_id                integer     NOT NULL REFERENCES public.bancos(id),
  contact_id             bigint      NOT NULL REFERENCES public.contacts(id),
  ambito                 varchar     NOT NULL DEFAULT 'empresa',
  empresa_id             integer     REFERENCES public.empresa_config(id),
  fecha_entrega          date        NOT NULL,
  concepto               varchar,
  moneda                 varchar     NOT NULL DEFAULT 'PEN',
  monto_entregado        numeric     NOT NULL CHECK (monto_entregado > 0),
  monto_rendido          numeric     NOT NULL DEFAULT 0,
  monto_devuelto         numeric     NOT NULL DEFAULT 0,
  fecha_rendicion        date,
  estado                 varchar     NOT NULL DEFAULT 'abierta',
  movimiento_salida_id   bigint      REFERENCES public.movimientos_banco(id),
  movimiento_vuelto_id   bigint      REFERENCES public.movimientos_banco(id),
  observaciones          text,
  created_by             bigint      REFERENCES public.users(id),
  created_at             timestamptz DEFAULT now(),
  updated_at             timestamptz DEFAULT now()
);

COMMENT ON TABLE public.entregas_a_rendir IS
  'Efectivo/Yape entregado a una persona para comprar. No es gasto hasta que rinde. Saldo pendiente = entregado - rendido - devuelto.';

ALTER TABLE public.entregas_a_rendir DROP CONSTRAINT IF EXISTS ck_entregas_estado;
ALTER TABLE public.entregas_a_rendir ADD CONSTRAINT ck_entregas_estado
  CHECK (estado IN ('abierta','parcial','rendida','anulada'));

ALTER TABLE public.entregas_a_rendir DROP CONSTRAINT IF EXISTS ck_entregas_ambito;
ALTER TABLE public.entregas_a_rendir ADD CONSTRAINT ck_entregas_ambito CHECK (
  (ambito = 'empresa'  AND empresa_id IS NOT NULL) OR
  (ambito = 'familiar' AND empresa_id IS NULL)
);

-- No se puede rendir + devolver más de lo entregado
ALTER TABLE public.entregas_a_rendir DROP CONSTRAINT IF EXISTS ck_entregas_montos;
ALTER TABLE public.entregas_a_rendir ADD CONSTRAINT ck_entregas_montos
  CHECK (monto_rendido >= 0 AND monto_devuelto >= 0
     AND monto_rendido + monto_devuelto <= monto_entregado + 0.01);

CREATE INDEX IF NOT EXISTS idx_entregas_contact ON public.entregas_a_rendir(contact_id);
CREATE INDEX IF NOT EXISTS idx_entregas_abiertas ON public.entregas_a_rendir(estado)
  WHERE estado IN ('abierta','parcial');

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_gastos_entrega') THEN
    ALTER TABLE public.gastos ADD CONSTRAINT fk_gastos_entrega
      FOREIGN KEY (entrega_id) REFERENCES public.entregas_a_rendir(id);
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 4 · REPOSICIONES DE CAJA — el cierre y el arqueo
-- ════════════════════════════════════════════════════════════════════════════
-- Luis: las reposiciones son semanales "o antes, depende de los gastos".
-- El arqueo es el punto álgido: saldo del sistema vs. efectivo físico contado.
CREATE TABLE IF NOT EXISTS public.reposiciones_caja (
  id                    bigserial   PRIMARY KEY,
  caja_id               integer     NOT NULL REFERENCES public.bancos(id),
  numero                varchar,
  fecha                 date        NOT NULL,
  periodo_desde         date        NOT NULL,
  periodo_hasta         date        NOT NULL,

  saldo_inicial         numeric     NOT NULL DEFAULT 0,
  total_ingresos        numeric     NOT NULL DEFAULT 0,
  total_egresos         numeric     NOT NULL DEFAULT 0,
  saldo_final_sistema   numeric     NOT NULL DEFAULT 0,
  saldo_fisico_contado  numeric,    -- el arqueo: lo que realmente hay en el cajón
  diferencia            numeric     GENERATED ALWAYS AS
                          (COALESCE(saldo_fisico_contado, saldo_final_sistema) - saldo_final_sistema) STORED,

  monto_repuesto        numeric     NOT NULL DEFAULT 0,
  origen_banco_id       integer     REFERENCES public.bancos(id),
  movimiento_ingreso_id bigint      REFERENCES public.movimientos_banco(id),

  estado                varchar     NOT NULL DEFAULT 'borrador',
  observaciones         text,
  created_by            bigint      REFERENCES public.users(id),
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

COMMENT ON TABLE public.reposiciones_caja IS
  'Cierre de periodo de una caja chica: qué se gastó, cuánto hay realmente (arqueo) y cuánto se repone hasta el fondo fijo.';
COMMENT ON COLUMN public.reposiciones_caja.diferencia IS
  'Faltante (negativo) o sobrante (positivo) del arqueo. Si no se contó físico, es 0.';
COMMENT ON COLUMN public.reposiciones_caja.origen_banco_id IS
  'De dónde sale la reposición (banco o caja mayor). Genera una transferencia entre cuentas.';

ALTER TABLE public.reposiciones_caja DROP CONSTRAINT IF EXISTS ck_reposiciones_estado;
ALTER TABLE public.reposiciones_caja ADD CONSTRAINT ck_reposiciones_estado
  CHECK (estado IN ('borrador','cerrada','anulada'));

ALTER TABLE public.reposiciones_caja DROP CONSTRAINT IF EXISTS ck_reposiciones_periodo;
ALTER TABLE public.reposiciones_caja ADD CONSTRAINT ck_reposiciones_periodo
  CHECK (periodo_hasta >= periodo_desde);

CREATE INDEX IF NOT EXISTS idx_reposiciones_caja ON public.reposiciones_caja(caja_id, periodo_hasta);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_gastos_reposicion') THEN
    ALTER TABLE public.gastos ADD CONSTRAINT fk_gastos_reposicion
      FOREIGN KEY (reposicion_id) REFERENCES public.reposiciones_caja(id);
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 5 · Correlativo de recibo (la UI lo llama con ⏭, como en Cobranzas)
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.siguiente_numero_recibo(p_caja_id integer)
RETURNS varchar LANGUAGE plpgsql AS $$
DECLARE v_prefijo varchar; v_max int;
BEGIN
  SELECT COALESCE(prefijo_recibo, 'REC') INTO v_prefijo FROM public.bancos WHERE id = p_caja_id;
  IF v_prefijo IS NULL THEN RAISE EXCEPTION 'No existe la caja %', p_caja_id; END IF;

  -- Toma el número más alto YA USADO en esta caja, ignorando el prefijo
  SELECT COALESCE(MAX(NULLIF(regexp_replace(numero_recibo, '\D', '', 'g'), '')::int), 0)
    INTO v_max FROM public.gastos WHERE caja_id = p_caja_id;

  RETURN v_prefijo || '-' || (v_max + 1)::text;
END $$;

COMMENT ON FUNCTION public.siguiente_numero_recibo IS
  'Sugiere el siguiente N° de recibo de la caja. Es SUGERENCIA, no reserva: la tesorera puede escribir otro (el Excel tiene huecos reales).';

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 6 · Vista de apoyo — saldo pendiente por persona
-- ════════════════════════════════════════════════════════════════════════════
-- Alimenta la bandeja "pendientes del día anterior" de la pantalla de inicio.
CREATE OR REPLACE VIEW public.v_entregas_pendientes AS
SELECT e.id, e.caja_id, b.nombre AS caja, e.contact_id, c.nombre AS responsable,
       e.ambito, e.empresa_id, e.fecha_entrega, e.concepto, e.moneda,
       e.monto_entregado, e.monto_rendido, e.monto_devuelto,
       (e.monto_entregado - e.monto_rendido - e.monto_devuelto) AS saldo_pendiente,
       (CURRENT_DATE - e.fecha_entrega) AS dias_sin_rendir,
       e.estado
  FROM public.entregas_a_rendir e
  JOIN public.bancos   b ON b.id = e.caja_id
  JOIN public.contacts c ON c.id = e.contact_id
 WHERE e.estado IN ('abierta','parcial');

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 7 · RLS (permisiva, igual que el resto)
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ PENDIENTE PRE-PRODUCCIÓN: endurecer junto con el resto del ERP.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['gastos','entregas_a_rendir','reposiciones_caja'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL USING (true) WITH CHECK (true)', t || '_all', t);
  END LOOP;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN — pégame el resultado
-- ════════════════════════════════════════════════════════════════════════════
SELECT '1. TABLAS' AS bloque, table_name,
       (SELECT count(*) FROM information_schema.columns c WHERE c.table_name = t.table_name) AS columnas
  FROM information_schema.tables t
 WHERE table_schema = 'public' AND table_name IN ('gastos','entregas_a_rendir','reposiciones_caja')
 ORDER BY table_name;

SELECT '2. CANDADOS DE GASTOS' AS bloque, conname, pg_get_constraintdef(oid) AS definicion
  FROM pg_constraint WHERE conrelid = 'public.gastos'::regclass AND contype = 'c'
 ORDER BY conname;

SELECT '3. CORRELATIVO' AS bloque, id, nombre, prefijo_recibo,
       public.siguiente_numero_recibo(id) AS siguiente
  FROM public.bancos WHERE tipo_cuenta = 'caja' ORDER BY id;

SELECT '4. VISTA' AS bloque, count(*) AS entregas_pendientes FROM public.v_entregas_pendientes;
