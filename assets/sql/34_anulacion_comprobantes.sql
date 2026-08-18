-- ============================================================================
-- 34_ANULACION_COMPROBANTES.SQL
-- ============================================================================
-- Objetivo: poder ANULAR un comprobante (factura de venta, factura de compra,
-- guía de despacho de venta, guía de ingreso de compra) sin borrarlo.
--
-- Por qué anular en vez de eliminar:
--   * SUNAT exige que los comprobantes emitidos queden registrados aunque se
--     anulen (van al Registro de Ventas/Compras con estado de anulación).
--   * Eliminar rompe la correlatividad y la trazabilidad contable.
--   * El asiento contable no se borra: se reversa con un asiento espejo.
--
-- ESTADO DEL COMPROBANTE (columna estado_comprobante, varchar):
--   '1' = Válido / anotación que corresponde al periodo   (valor por defecto)
--   '2' = Anotación extemporánea (comprobante de periodo anterior)
--   '0' = ANULADO
--   Se deja como varchar SIN CHECK para no romper filas históricas que puedan
--   traer otros códigos de la migración desde Odoo. La validación se hace en
--   la aplicación; aquí solo se documenta el significado.
--
-- Idempotente: se puede correr varias veces sin efecto adicional.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1) VENTAS — estado_comprobante y comprobante_anulado (espejo de compras)
-- ────────────────────────────────────────────────────────────────────────────
-- `ventas` ya tenía `estado` ('borrador','emitida','anulada'), pero le faltaban
-- las dos columnas que sí tiene `compras`. Se agregan para que ambos módulos
-- se lean igual y el Registro de Ventas pueda reportar el estado SUNAT.

ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS estado_comprobante  varchar DEFAULT '1',
  ADD COLUMN IF NOT EXISTS comprobante_anulado boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fecha_anulacion     date,
  ADD COLUMN IF NOT EXISTS motivo_anulacion    text,
  ADD COLUMN IF NOT EXISTS anulado_por         bigint REFERENCES public.users(id);

COMMENT ON COLUMN public.ventas.estado_comprobante IS
  'Estado SUNAT del comprobante: 1=válido/periodo, 2=anotación extemporánea, 0=anulado.';
COMMENT ON COLUMN public.ventas.comprobante_anulado IS
  'TRUE si el comprobante fue anulado. Los anulados NO suman en reportes, KPIs, CxC ni IGV.';
COMMENT ON COLUMN public.ventas.motivo_anulacion IS
  'Motivo obligatorio de la anulación (sustento ante fiscalización).';

-- ────────────────────────────────────────────────────────────────────────────
-- 2) COMPRAS — ya tiene estado_comprobante y comprobante_anulado; faltan los
--    campos de auditoría de la anulación.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.compras
  ADD COLUMN IF NOT EXISTS fecha_anulacion  date,
  ADD COLUMN IF NOT EXISTS motivo_anulacion text,
  ADD COLUMN IF NOT EXISTS anulado_por      bigint REFERENCES public.users(id);

COMMENT ON COLUMN public.compras.estado_comprobante IS
  'Estado SUNAT del comprobante: 1=válido/periodo, 2=anotación extemporánea, 0=anulado.';
COMMENT ON COLUMN public.compras.comprobante_anulado IS
  'TRUE si el comprobante fue anulado. Los anulados NO suman en reportes, KPIs, CxP ni crédito fiscal.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3) GUÍA DE DESPACHO DE VENTA — no tenía ningún estado
-- ────────────────────────────────────────────────────────────────────────────
-- Una guía anulada devuelve el stock a Inventario (lo hace la aplicación) pero
-- conserva el registro y su numeración, que también es correlativa.

ALTER TABLE public.guias_despacho_venta
  ADD COLUMN IF NOT EXISTS estado           varchar NOT NULL DEFAULT 'emitida',
  ADD COLUMN IF NOT EXISTS fecha_anulacion  date,
  ADD COLUMN IF NOT EXISTS motivo_anulacion text,
  ADD COLUMN IF NOT EXISTS anulado_por      bigint REFERENCES public.users(id);

-- El CHECK se agrega aparte y tolerante: si ya existía, se reemplaza.
ALTER TABLE public.guias_despacho_venta
  DROP CONSTRAINT IF EXISTS guias_despacho_venta_estado_check;
ALTER TABLE public.guias_despacho_venta
  ADD CONSTRAINT guias_despacho_venta_estado_check
  CHECK (estado IN ('emitida', 'anulada'));

COMMENT ON COLUMN public.guias_despacho_venta.estado IS
  'emitida = la mercadería salió y el stock está descontado. anulada = se revirtió el stock; la guía queda como registro histórico.';

-- ────────────────────────────────────────────────────────────────────────────
-- 4) GUÍA DE INGRESO DE COMPRA — espejo de la anterior
-- ────────────────────────────────────────────────────────────────────────────
-- Anular una guía de ingreso RETIRA del stock lo que había ingresado. Solo se
-- puede si esa mercadería todavía está disponible (no se vendió ni se trasladó);
-- esa validación la hace la aplicación antes de permitir la anulación.

ALTER TABLE public.guias_ingreso_compra
  ADD COLUMN IF NOT EXISTS estado           varchar NOT NULL DEFAULT 'emitida',
  ADD COLUMN IF NOT EXISTS fecha_anulacion  date,
  ADD COLUMN IF NOT EXISTS motivo_anulacion text,
  ADD COLUMN IF NOT EXISTS anulado_por      bigint REFERENCES public.users(id);

ALTER TABLE public.guias_ingreso_compra
  DROP CONSTRAINT IF EXISTS guias_ingreso_compra_estado_check;
ALTER TABLE public.guias_ingreso_compra
  ADD CONSTRAINT guias_ingreso_compra_estado_check
  CHECK (estado IN ('emitida', 'anulada'));

COMMENT ON COLUMN public.guias_ingreso_compra.estado IS
  'emitida = la mercadería ingresó y sumó al stock. anulada = se retiró del stock; la guía queda como registro histórico.';

-- ────────────────────────────────────────────────────────────────────────────
-- 5) CUENTAS POR COBRAR / PAGAR — permitir el estado 'anulado'
-- ────────────────────────────────────────────────────────────────────────────
-- Al anular la factura, su cuenta por cobrar/pagar deja de ser exigible.
-- Si la tabla tenía un CHECK que no incluía 'anulado', el UPDATE fallaría.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cuentas_cobrar_estado_check') THEN
    ALTER TABLE public.cuentas_cobrar DROP CONSTRAINT cuentas_cobrar_estado_check;
  END IF;
  ALTER TABLE public.cuentas_cobrar
    ADD CONSTRAINT cuentas_cobrar_estado_check
    CHECK (estado IN ('pendiente', 'parcial', 'cobrado', 'anulado'));
EXCEPTION WHEN others THEN
  RAISE NOTICE 'cuentas_cobrar: no se pudo ajustar el CHECK de estado (%). Revisar valores existentes.', SQLERRM;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cuentas_pagar_estado_check') THEN
    ALTER TABLE public.cuentas_pagar DROP CONSTRAINT cuentas_pagar_estado_check;
  END IF;
  ALTER TABLE public.cuentas_pagar
    ADD CONSTRAINT cuentas_pagar_estado_check
    CHECK (estado IN ('pendiente', 'parcial', 'pagado', 'anulado'));
EXCEPTION WHEN others THEN
  RAISE NOTICE 'cuentas_pagar: no se pudo ajustar el CHECK de estado (%). Revisar valores existentes.', SQLERRM;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 6) BACKFILL — sincronizar ventas ya anuladas con las columnas nuevas
-- ────────────────────────────────────────────────────────────────────────────
-- Si alguna venta ya estaba en estado='anulada' (el flujo anterior), se le
-- ponen ahora las banderas nuevas para que los reportes la excluyan igual.

UPDATE public.ventas
SET comprobante_anulado = true,
    estado_comprobante  = '0'
WHERE estado = 'anulada'
  AND comprobante_anulado IS DISTINCT FROM true;

-- Coherencia inversa: si alguna compra ya tenía comprobante_anulado = true
-- pero su estado_comprobante seguía en '1', se corrige.
UPDATE public.compras
SET estado_comprobante = '0'
WHERE comprobante_anulado = true
  AND COALESCE(estado_comprobante, '1') <> '0';

-- ────────────────────────────────────────────────────────────────────────────
-- 7) ÍNDICES — los listados filtran casi siempre por "no anulados"
-- ────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_ventas_anulado  ON public.ventas(comprobante_anulado);
CREATE INDEX IF NOT EXISTS idx_compras_anulado ON public.compras(comprobante_anulado);
CREATE INDEX IF NOT EXISTS idx_gdv_estado      ON public.guias_despacho_venta(estado);
CREATE INDEX IF NOT EXISTS idx_gic_estado      ON public.guias_ingreso_compra(estado);

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN — correr después del script
-- ════════════════════════════════════════════════════════════════════════════
-- SELECT 'ventas'  AS tabla, estado_comprobante, comprobante_anulado, COUNT(*)
--   FROM public.ventas  GROUP BY 2,3
-- UNION ALL
-- SELECT 'compras', estado_comprobante, comprobante_anulado, COUNT(*)
--   FROM public.compras GROUP BY 2,3
-- ORDER BY 1,2,3;
--
-- SELECT 'guias_despacho_venta' AS tabla, estado, COUNT(*)
--   FROM public.guias_despacho_venta GROUP BY 2
-- UNION ALL
-- SELECT 'guias_ingreso_compra', estado, COUNT(*)
--   FROM public.guias_ingreso_compra GROUP BY 2;
