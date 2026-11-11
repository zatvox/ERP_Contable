-- ============================================================================
-- 156_comprobantes_retencion.sql  (2026-11-11)
-- COMPROBANTE DE RETENCIÓN ELECTRÓNICO (CRE, tipo 20) que entrega el cliente
-- agente de retención del IGV. Régimen de Retenciones del IGV — R.S. 037-2002/SUNAT:
--   • Tasa vigente 3 % sobre el IMPORTE DEL PAGO (total con IGV de la factura,
--     o de cada pago parcial). No aplica si el pago y los comprobantes
--     involucrados suman S/ 700 o menos.
--   • Moneda extranjera: se convierte con el T.C. promedio ponderado VENTA SBS
--     de la FECHA DE PAGO (= fecha del CRE). La retención SIEMPRE es en soles.
--   • El agente lo emite al momento del pago. La norma permite que un CRE agrupe
--     varias retenciones del mes a un mismo proveedor; en el ERP se registra
--     UNA FILA POR FACTURA (si un CRE trae 2 facturas, se registran 2 filas con el
--     mismo serie-número). Así cada factura conserva su T.C., su base y su PDF.
--   • El proveedor (nosotros) lo DEDUCE del IGV a pagar del periodo de la fecha
--     del CRE en el PDT 621. Si sobra se arrastra; tras 3 periodos se puede
--     pedir la devolución. No se compensa con otros tributos.
--
-- CONTABILIDAD (ejemplo R002-23464 Camones, FFFI-288, USD 9,799.68, T.C. 3.387):
--   Al cobrar (cliente paga el NETO y retiene el 3 %):
--     D 104x Bancos ME .................... USD 9,505.69 × 3.387 = S/ 32,195.77
--     D 40114 IGV – Régimen de retenciones  S/    995.74   (ctaRetencionIgv, def. 401141)
--     H 1212 Facturas por cobrar ME ...... USD 9,799.68 × T.C. de la factura
--     D/H 676 / 776 Diferencia de cambio .. lo que falte o sobre
--   Al liquidar el IGV del periodo (PDT 621):
--     D 40111 IGV – Cuenta propia / H 40114 IGV – Régimen de retenciones
--
-- Corre todo el archivo (no borra nada).
-- ============================================================================

-- 1) Tabla del CRE (una fila por factura relacionada)
CREATE TABLE IF NOT EXISTS public.comprobantes_retencion (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id         bigint NOT NULL,
  contact_id         bigint NOT NULL REFERENCES public.contacts(id),
  cxc_id             bigint NOT NULL REFERENCES public.cuentas_cobrar(id),
  cobro_id           bigint REFERENCES public.cobros(id) ON DELETE SET NULL,
  serie              varchar(4)  NOT NULL,          -- R001, R002…
  numero             bigint      NOT NULL,          -- sin ceros a la izquierda (estándar del ERP)
  fecha_emision      date        NOT NULL,          -- = fecha de pago / retención
  tasa               numeric(5,2) NOT NULL DEFAULT 3.00,
  -- Documento relacionado (foto de la factura al momento del CRE)
  doc_tipo           varchar(2)  DEFAULT '01',
  doc_serie          varchar(10),
  doc_numero         varchar(20),
  doc_fecha          date,
  doc_moneda         varchar(3)  NOT NULL DEFAULT 'PEN',
  doc_importe_total  numeric(14,2) NOT NULL,        -- total de la factura (moneda del doc)
  importe_pago       numeric(14,2) NOT NULL,        -- "importe sin retención": base del pago (moneda del doc)
  tipo_cambio        numeric(10,4) NOT NULL DEFAULT 1,  -- venta SBS de la fecha de pago (1 si PEN)
  retencion_pen      numeric(14,2) NOT NULL CHECK (retencion_pen > 0),   -- lo que dice el CRE (deducible)
  neto_pen           numeric(14,2) NOT NULL,        -- "importe neto" / total pagado en soles
  retencion_doc      numeric(14,2) NOT NULL CHECK (retencion_doc > 0),   -- equivalente en moneda del doc (baja la CxC)
  origen             varchar(20) NOT NULL DEFAULT 'vinculado' CHECK (origen IN ('vinculado', 'sin_cobro')),
  estado             varchar(12) NOT NULL DEFAULT 'registrado' CHECK (estado IN ('registrado', 'anulado')),
  observaciones      text,
  created_by         bigint,
  created_at         timestamptz NOT NULL DEFAULT now(),
  anulado_at         timestamptz
);
COMMENT ON TABLE  public.comprobantes_retencion IS 'CRE (tipo 20) recibidos de clientes agentes de retención. Una fila por factura relacionada. SQL 156.';
COMMENT ON COLUMN public.comprobantes_retencion.origen IS 'vinculado = se enlazó a un cobro que ya tenía la retención; sin_cobro = el ERP creó un cobro de retención sin banco (medio retencion).';

-- Mismo CRE no se registra dos veces para la misma factura (anulados no cuentan)
CREATE UNIQUE INDEX IF NOT EXISTS ux_cre_cliente_serie_num_doc
  ON public.comprobantes_retencion (contact_id, serie, numero, cxc_id) WHERE estado <> 'anulado';
CREATE INDEX IF NOT EXISTS idx_cre_cxc   ON public.comprobantes_retencion (cxc_id);
CREATE INDEX IF NOT EXISTS idx_cre_fecha ON public.comprobantes_retencion (empresa_id, fecha_emision);

ALTER TABLE public.comprobantes_retencion ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON public.comprobantes_retencion;
CREATE POLICY "authenticated_all" ON public.comprobantes_retencion FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.comprobantes_retencion TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.comprobantes_retencion_id_seq TO authenticated;

-- 2) cobros: un "cobro de retención" puede tener monto 0 (solo retención, sin banco)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.cobros'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE 'CHECK ((monto > %' LOOP
    EXECUTE format('ALTER TABLE public.cobros DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE public.cobros DROP CONSTRAINT IF EXISTS cobros_monto_o_retencion_check;
ALTER TABLE public.cobros ADD CONSTRAINT cobros_monto_o_retencion_check
  CHECK (monto >= 0 AND (monto > 0 OR monto_retencion > 0));

-- medio_pago: + retencion (conserva SQL 151 y 154)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.cobros'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%medio_pago%' LOOP
    EXECUTE format('ALTER TABLE public.cobros DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE public.cobros ADD CONSTRAINT cobros_medio_pago_check
  CHECK (medio_pago IN ('transferencia','cheque','efectivo','deposito','detraccion','yape_plin','saldo_favor','ajuste_redondeo','retencion','otro'));

-- 3) adjuntos: entidad 'comprobante_retencion' y concepto 'cre' (conserva lo que ya acepta)
DO $$
DECLARE v_def text; v_vals text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'adjuntos_entidad_check';
  IF v_def IS NOT NULL AND v_def NOT LIKE '%comprobante_retencion%' THEN
    v_vals := replace(replace((regexp_match(v_def, 'ARRAY\[(.*?)\]'))[1], '::character varying', ''), '::text', '');
    EXECUTE 'ALTER TABLE public.adjuntos DROP CONSTRAINT adjuntos_entidad_check';
    EXECUTE 'ALTER TABLE public.adjuntos ADD CONSTRAINT adjuntos_entidad_check CHECK (entidad IN (' || v_vals || ', ''comprobante_retencion''))';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'adjuntos_concepto_check';
  IF v_def IS NOT NULL AND v_def NOT LIKE '%''cre''%' THEN
    v_vals := replace(replace((regexp_match(v_def, 'ARRAY\[(.*?)\]'))[1], '::character varying', ''), '::text', '');
    EXECUTE 'ALTER TABLE public.adjuntos DROP CONSTRAINT adjuntos_concepto_check';
    EXECUTE 'ALTER TABLE public.adjuntos ADD CONSTRAINT adjuntos_concepto_check CHECK (concepto IN (' || v_vals || ', ''cre''))';
  END IF;
END $$;

-- 4) VERIFICACIÓN: las 5 columnas deben dar 1
SELECT
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='comprobantes_retencion') AS tabla_cre,
  (SELECT count(*) FROM pg_constraint WHERE conname='cobros_monto_o_retencion_check') AS cobro_solo_retencion,
  (SELECT count(*) FROM pg_constraint WHERE conname='cobros_medio_pago_check' AND pg_get_constraintdef(oid) ILIKE '%''retencion''%') AS medio_retencion,
  (SELECT count(*) FROM pg_constraint WHERE conname='adjuntos_entidad_check' AND pg_get_constraintdef(oid) ILIKE '%comprobante_retencion%') AS adj_entidad,
  (SELECT count(*) FROM pg_constraint WHERE conname='adjuntos_concepto_check' AND pg_get_constraintdef(oid) ILIKE '%''cre''%') AS adj_concepto;
