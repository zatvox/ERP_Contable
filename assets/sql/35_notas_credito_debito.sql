-- ============================================================================
-- 35_NOTAS_CREDITO_DEBITO.SQL
-- ============================================================================
-- Notas de Crédito (tipo 07) y Notas de Débito (tipo 08), tanto emitidas
-- (ventas) como recibidas del proveedor (compras).
--
-- QUÉ SON Y POR QUÉ IMPORTAN
--   Nota de Crédito  → REDUCE el importe de un comprobante ya emitido
--                      (devolución, descuento, anulación, error en el monto).
--   Nota de Débito   → AUMENTA el importe de un comprobante ya emitido
--                      (intereses por mora, penalidades, aumento de valor).
--
--   Una factura ya declarada a SUNAT no se corrige editándola: se emite una
--   NC o ND que la referencia. Por eso cada nota guarda a qué documento
--   modifica y con qué motivo del catálogo SUNAT.
--
-- DECISIÓN DE DISEÑO: las notas se guardan en las MISMAS tablas `ventas` y
-- `compras`, no en tablas aparte. Motivos:
--   * `ventas.tipo_comprobante` ya acepta '07' y '08' desde el esquema inicial.
--   * El Registro de Ventas/Compras de SUNAT las lista junto a las facturas.
--   * Reutilizan detalle, asiento contable, CxC/CxP y todos los reportes.
--   Los importes se guardan SIEMPRE EN POSITIVO; el signo lo aplica la
--   aplicación según el tipo (07 resta, 08 suma). Guardar negativos rompería
--   los CHECK de `total >= 0` que ya existen.
--
-- Idempotente.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1) VENTAS — referencia al documento que modifica y motivo SUNAT
-- ────────────────────────────────────────────────────────────────────────────
-- Ya existían `doc_referencia_tipo/serie/numero` (texto suelto). Se agrega la
-- FK real para poder cruzar sin depender de que las cadenas coincidan.

ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS venta_referencia_id bigint REFERENCES public.ventas(id),
  ADD COLUMN IF NOT EXISTS motivo_nota_codigo  varchar,
  ADD COLUMN IF NOT EXISTS motivo_nota_texto   text;

COMMENT ON COLUMN public.ventas.venta_referencia_id IS
  'Solo en notas (07/08): id de la venta que esta nota modifica.';
COMMENT ON COLUMN public.ventas.motivo_nota_codigo IS
  'Código SUNAT del motivo. NC = Catálogo 09 (01..10). ND = Catálogo 10 (01..03).';

CREATE INDEX IF NOT EXISTS idx_ventas_referencia ON public.ventas(venta_referencia_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 2) COMPRAS — mismas columnas para las notas que recibimos del proveedor
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.compras
  ADD COLUMN IF NOT EXISTS compra_referencia_id bigint REFERENCES public.compras(id),
  ADD COLUMN IF NOT EXISTS motivo_nota_codigo   varchar,
  ADD COLUMN IF NOT EXISTS motivo_nota_texto    text,
  ADD COLUMN IF NOT EXISTS doc_referencia_tipo  varchar,
  ADD COLUMN IF NOT EXISTS doc_referencia_serie varchar,
  ADD COLUMN IF NOT EXISTS doc_referencia_numero varchar;

COMMENT ON COLUMN public.compras.compra_referencia_id IS
  'Solo en notas (07/08): id de la compra que esta nota modifica.';

CREATE INDEX IF NOT EXISTS idx_compras_referencia ON public.compras(compra_referencia_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 3) CATÁLOGO DE MOTIVOS SUNAT
-- ────────────────────────────────────────────────────────────────────────────
-- Se guarda en tabla (y no en el código JS) porque SUNAT puede agregar
-- códigos, y porque el Registro de Ventas exige reportar el código exacto.

CREATE TABLE IF NOT EXISTS public.motivos_nota (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo_nota      varchar NOT NULL CHECK (tipo_nota IN ('07', '08')),
  codigo         varchar NOT NULL,
  descripcion    varchar NOT NULL,
  -- Si TRUE, este motivo anula por completo el comprobante de origen y la
  -- nota debe emitirse por el total (ej. "Anulación de la operación").
  anula_total    boolean NOT NULL DEFAULT false,
  activo         boolean NOT NULL DEFAULT true,
  created_at     timestamptz DEFAULT now(),
  UNIQUE (tipo_nota, codigo)
);

COMMENT ON TABLE public.motivos_nota IS
  'Catálogo 09 (Nota de Crédito) y Catálogo 10 (Nota de Débito) de SUNAT.';

-- Catálogo 09 — Notas de Crédito
INSERT INTO public.motivos_nota (tipo_nota, codigo, descripcion, anula_total) VALUES
  ('07', '01', 'Anulación de la operación',              true),
  ('07', '02', 'Anulación por error en el RUC',          true),
  ('07', '03', 'Corrección por error en la descripción', false),
  ('07', '04', 'Descuento global',                       false),
  ('07', '05', 'Descuento por ítem',                     false),
  ('07', '06', 'Devolución total',                       true),
  ('07', '07', 'Devolución por ítem',                    false),
  ('07', '08', 'Bonificación',                           false),
  ('07', '09', 'Disminución en el valor',                false),
  ('07', '10', 'Otros conceptos',                        false)
ON CONFLICT (tipo_nota, codigo) DO NOTHING;

-- Catálogo 10 — Notas de Débito
INSERT INTO public.motivos_nota (tipo_nota, codigo, descripcion, anula_total) VALUES
  ('08', '01', 'Intereses por mora',                     false),
  ('08', '02', 'Aumento en el valor',                    false),
  ('08', '03', 'Penalidades / otros conceptos',          false)
ON CONFLICT (tipo_nota, codigo) DO NOTHING;

ALTER TABLE public.motivos_nota ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'motivos_nota' AND policyname = 'motivos_nota_select') THEN
    CREATE POLICY motivos_nota_select ON public.motivos_nota FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4) COMPRAS — permitir tipo_comprobante '07' y '08'
-- ────────────────────────────────────────────────────────────────────────────
-- `ventas` ya los aceptaba en su CHECK original. En `compras` el tipo se
-- valida contra la tabla tipo_documentos, así que solo hay que asegurarse de
-- que esos dos códigos existan ahí.

-- La PK de tipo_documentos es el propio código SUNAT (varchar), y la columna
-- del nombre es `name`, no `descripcion`.
INSERT INTO public.tipo_documentos (id, name, electronic, active)
VALUES ('07', 'Nota de Crédito', true, true),
       ('08', 'Nota de Débito',  true, true)
ON CONFLICT (id) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 5) CUENTAS POR COBRAR / PAGAR — enlazar la nota con la cuenta que ajusta
-- ────────────────────────────────────────────────────────────────────────────
-- Una NC baja el saldo por cobrar del cliente sin que haya entrado dinero;
-- una ND lo sube. Se registra el ajuste acumulado para poder auditarlo.

ALTER TABLE public.cuentas_cobrar
  ADD COLUMN IF NOT EXISTS monto_notas_credito numeric NOT NULL DEFAULT 0 CHECK (monto_notas_credito >= 0),
  ADD COLUMN IF NOT EXISTS monto_notas_debito  numeric NOT NULL DEFAULT 0 CHECK (monto_notas_debito >= 0);

COMMENT ON COLUMN public.cuentas_cobrar.monto_notas_credito IS
  'Acumulado de notas de crédito aplicadas. Saldo = total + ND − NC − cobrado − retenido.';

ALTER TABLE public.cuentas_pagar
  ADD COLUMN IF NOT EXISTS monto_notas_credito numeric NOT NULL DEFAULT 0 CHECK (monto_notas_credito >= 0),
  ADD COLUMN IF NOT EXISTS monto_notas_debito  numeric NOT NULL DEFAULT 0 CHECK (monto_notas_debito >= 0);

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
-- SELECT tipo_nota, codigo, descripcion, anula_total
--   FROM public.motivos_nota ORDER BY tipo_nota, codigo;
--
-- SELECT tipo_comprobante, COUNT(*) FROM public.ventas  GROUP BY 1 ORDER BY 1;
-- SELECT tipo_comprobante, COUNT(*) FROM public.compras GROUP BY 1 ORDER BY 1;
