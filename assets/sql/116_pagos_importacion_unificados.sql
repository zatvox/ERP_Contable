-- ============================================================================
-- 116_pagos_importacion_unificados.sql
-- Registro ÚNICO de pagos de una carpeta de importación (bi-moneda) + aplicación
-- de cada pago a uno o varios documentos (anticipo de la PI, saldo del CI,
-- tributos de la DAM, percepción, ajuste de valor, agente…) + enlace con Bancos.
--
-- Idempotente: se puede correr más de una vez.
--   · Un PAGO sale de una cuenta de banco (cuenta_origen_id), en la moneda de la
--     cuenta (moneda / monto_transferido), con su T.C. (soles por 1 USD).
--   · Una APLICACIÓN dice qué documento paga y cuánto, en la moneda del documento
--     (p. ej. tributos en USD pagados en soles). Un pago puede tener varias
--     (1 voucher que paga tributos + percepción).
--   · El estado de cada documento (pendiente / parcial / pagado) se CALCULA con
--     las aplicaciones; ya no se escribe a mano.
-- Migra los pagos que ya existen como «históricos» (sin movimiento en Bancos
-- hasta que los confirmes) y los pagos de DAM / ajustes marcados como pagados.
-- ============================================================================
BEGIN;

-- 1) importacion_pagos: más tipos y columnas ---------------------------------
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.importacion_pagos'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%anticipo%'
  LOOP
    EXECUTE format('ALTER TABLE public.importacion_pagos DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.importacion_pagos
  ADD CONSTRAINT importacion_pagos_tipo_check
  CHECK (tipo IN ('anticipo','saldo','pago_total','agente','devolucion','otro',
                  'tributos','percepcion','ajuste_valor','combinado'));

ALTER TABLE public.importacion_pagos
  ADD COLUMN IF NOT EXISTS medio                  varchar,     -- transferencia | deposito | cheque | vep | efectivo | otro
  ADD COLUMN IF NOT EXISTS monto_equiv_usd        numeric,
  ADD COLUMN IF NOT EXISTS monto_equiv_pen        numeric,
  ADD COLUMN IF NOT EXISTS movimiento_banco_id    bigint REFERENCES public.movimientos_banco(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS movimiento_comision_id bigint REFERENCES public.movimientos_banco(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS es_historico           boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.importacion_pagos.es_historico IS
  'Pago anterior al registro unificado: no tiene movimiento en Bancos hasta que se confirme (botón «Registrar en Bancos»).';

-- 2) Aplicaciones: qué documento paga cada pago ------------------------------
CREATE TABLE IF NOT EXISTS public.importacion_pago_aplicaciones (
  id                      bigserial PRIMARY KEY,
  pago_id                 bigint  NOT NULL REFERENCES public.importacion_pagos(id) ON DELETE CASCADE,
  carpeta_importacion_id  bigint  NOT NULL REFERENCES public.carpetas_importacion(id) ON DELETE CASCADE,
  doc_tipo                varchar NOT NULL
                            CHECK (doc_tipo IN ('oc_anticipo','ci_saldo','dam_tributos','dam_percepcion','ajuste_valor','agente','otro')),
  doc_id                  bigint,                      -- id de la OC, CI, DAM, ajuste, liquidación del agente…
  concepto                varchar,
  moneda_doc              varchar NOT NULL DEFAULT 'USD' CHECK (moneda_doc IN ('USD','PEN','EUR')),
  monto_doc               numeric NOT NULL CHECK (monto_doc >= 0),   -- en la moneda del DOCUMENTO
  created_at              timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_impapl_pago    ON public.importacion_pago_aplicaciones(pago_id);
CREATE INDEX IF NOT EXISTS idx_impapl_carpeta ON public.importacion_pago_aplicaciones(carpeta_importacion_id);
CREATE INDEX IF NOT EXISTS idx_impapl_doc     ON public.importacion_pago_aplicaciones(doc_tipo, doc_id);

DROP TRIGGER IF EXISTS trg_impapl_carpeta_abierta ON public.importacion_pago_aplicaciones;
CREATE TRIGGER trg_impapl_carpeta_abierta
  BEFORE INSERT OR UPDATE OR DELETE ON public.importacion_pago_aplicaciones
  FOR EACH ROW EXECUTE FUNCTION public.fn_importacion_carpeta_abierta();

ALTER TABLE public.importacion_pago_aplicaciones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON public.importacion_pago_aplicaciones;
CREATE POLICY "authenticated_all" ON public.importacion_pago_aplicaciones FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.importacion_pago_aplicaciones TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.importacion_pago_aplicaciones_id_seq TO authenticated;

COMMENT ON TABLE public.importacion_pago_aplicaciones IS
  'A qué documento(s) de la carpeta se aplica cada pago. El estado del documento = total − suma de sus aplicaciones.';

-- 3) Migración ----------------------------------------------------------------
-- 3.a Pagos existentes (anticipo / saldo / agente…): quedan como históricos y se aplican a su documento.
UPDATE public.importacion_pagos p
   SET es_historico = true
 WHERE NOT EXISTS (SELECT 1 FROM public.importacion_pago_aplicaciones a WHERE a.pago_id = p.id)
   AND p.tipo IN ('anticipo','saldo','pago_total','agente','otro');

INSERT INTO public.importacion_pago_aplicaciones (pago_id, carpeta_importacion_id, doc_tipo, doc_id, concepto, moneda_doc, monto_doc)
SELECT p.id, p.carpeta_importacion_id,
       CASE p.tipo WHEN 'anticipo' THEN 'oc_anticipo' WHEN 'saldo' THEN 'ci_saldo' WHEN 'pago_total' THEN 'ci_saldo'
                   WHEN 'agente' THEN 'agente' ELSE 'otro' END,
       CASE WHEN p.tipo = 'anticipo' THEN COALESCE(p.orden_compra_id, (SELECT c.orden_compra_id FROM public.carpetas_importacion c WHERE c.id = p.carpeta_importacion_id))
            WHEN p.tipo IN ('saldo','pago_total') THEN (SELECT ci.id FROM public.comercial_invoices ci WHERE ci.carpeta_importacion_id = p.carpeta_importacion_id ORDER BY ci.id LIMIT 1)
            ELSE NULL END,
       CASE p.tipo WHEN 'anticipo' THEN 'Anticipo' WHEN 'saldo' THEN 'Saldo' WHEN 'pago_total' THEN 'Pago total' WHEN 'agente' THEN 'Agente' ELSE 'Otro' END,
       p.moneda, p.monto_transferido
  FROM public.importacion_pagos p
 WHERE p.tipo IN ('anticipo','saldo','pago_total','agente','otro')
   AND NOT EXISTS (SELECT 1 FROM public.importacion_pago_aplicaciones a WHERE a.pago_id = p.id);

-- 3.b Tributos y percepción de DAM marcadas «pagado»; ajustes «pagada» → un pago histórico c/u.
DO $$
DECLARE
  d record; a record; v_pago bigint; v_carpeta bigint; v_trib numeric;
BEGIN
  FOR d IN SELECT * FROM public.dams WHERE estado = 'pagado' AND fecha_pago IS NOT NULL AND COALESCE(tipo_cambio,0) > 0 LOOP
    SELECT c.id INTO v_carpeta FROM public.carpetas_importacion c WHERE c.comercial_invoice_id = d.importacion_id LIMIT 1;
    CONTINUE WHEN v_carpeta IS NULL;
    v_trib := COALESCE(d.ad_valorem_usd,0) + COALESCE(d.imp_usd,0) + COALESCE(d.igv_usd,0);

    IF v_trib > 0 AND NOT EXISTS (SELECT 1 FROM public.importacion_pago_aplicaciones x WHERE x.doc_tipo = 'dam_tributos' AND x.doc_id = d.id) THEN
      INSERT INTO public.importacion_pagos (carpeta_importacion_id, tipo, fecha, moneda, tipo_cambio, monto_transferido, estado, es_historico,
                                            referencia, observaciones, monto_equiv_usd, monto_equiv_pen)
      VALUES (v_carpeta, 'tributos', d.fecha_pago, 'USD', d.tipo_cambio, v_trib, 'ejecutado', true,
              'Tributos DAM ' || d.numero_dam, 'Migrado de la DAM: confirma monto, medio y cuenta de origen',
              v_trib, round(v_trib * d.tipo_cambio, 2))
      RETURNING id INTO v_pago;
      INSERT INTO public.importacion_pago_aplicaciones (pago_id, carpeta_importacion_id, doc_tipo, doc_id, concepto, moneda_doc, monto_doc)
      VALUES (v_pago, v_carpeta, 'dam_tributos', d.id, 'Tributos DAM ' || d.numero_dam, 'USD', v_trib);
    END IF;

    IF COALESCE(d.percepcion,0) > 0 AND NOT EXISTS (SELECT 1 FROM public.importacion_pago_aplicaciones x WHERE x.doc_tipo = 'dam_percepcion' AND x.doc_id = d.id) THEN
      INSERT INTO public.importacion_pagos (carpeta_importacion_id, tipo, fecha, moneda, tipo_cambio, monto_transferido, estado, es_historico,
                                            referencia, observaciones, monto_equiv_usd, monto_equiv_pen)
      VALUES (v_carpeta, 'percepcion', d.fecha_pago, 'PEN', d.tipo_cambio, d.percepcion, 'ejecutado', true,
              'Percepción DAM ' || d.numero_dam, 'Migrado de la DAM: confirma monto, fecha, medio y cuenta de origen',
              round(d.percepcion / d.tipo_cambio, 2), d.percepcion)
      RETURNING id INTO v_pago;
      INSERT INTO public.importacion_pago_aplicaciones (pago_id, carpeta_importacion_id, doc_tipo, doc_id, concepto, moneda_doc, monto_doc)
      VALUES (v_pago, v_carpeta, 'dam_percepcion', d.id, 'Percepción DAM ' || d.numero_dam, 'PEN', d.percepcion);
    END IF;

    -- Ajustes de valor pagados de esa DAM
    FOR a IN SELECT * FROM public.dam_autoliquidaciones x WHERE x.dam_id = d.id AND x.estado = 'pagada' LOOP
      CONTINUE WHEN EXISTS (SELECT 1 FROM public.importacion_pago_aplicaciones y WHERE y.doc_tipo = 'ajuste_valor' AND y.doc_id = a.id);
      v_trib := COALESCE(a.ad_valorem_usd,0) + COALESCE(a.ipm_usd,0) + COALESCE(a.igv_usd,0) + COALESCE(a.intereses_usd,0);
      CONTINUE WHEN v_trib <= 0;
      INSERT INTO public.importacion_pagos (carpeta_importacion_id, tipo, fecha, moneda, tipo_cambio, monto_transferido, estado, es_historico,
                                            referencia, observaciones, monto_equiv_usd, monto_equiv_pen)
      VALUES (v_carpeta, 'ajuste_valor', COALESCE(a.fecha_pago, a.fecha), 'USD', COALESCE(a.tipo_cambio, d.tipo_cambio), v_trib, 'ejecutado', true,
              'Ajuste de valor ' || a.numero, 'Migrado del ajuste: confirma monto, medio y cuenta de origen',
              v_trib, round(v_trib * COALESCE(a.tipo_cambio, d.tipo_cambio), 2))
      RETURNING id INTO v_pago;
      INSERT INTO public.importacion_pago_aplicaciones (pago_id, carpeta_importacion_id, doc_tipo, doc_id, concepto, moneda_doc, monto_doc)
      VALUES (v_pago, v_carpeta, 'ajuste_valor', a.id, 'Ajuste de valor ' || a.numero, 'USD', v_trib);
    END LOOP;
  END LOOP;
END $$;

-- 3.c Equivalentes en USD / S/ de los pagos que aún no los tienen (T.C. = soles por 1 USD)
UPDATE public.importacion_pagos
   SET monto_equiv_usd = CASE WHEN moneda = 'USD' THEN monto_transferido WHEN moneda = 'PEN' AND tipo_cambio > 0 THEN round(monto_transferido / tipo_cambio, 2) END,
       monto_equiv_pen = CASE WHEN moneda = 'PEN' THEN monto_transferido WHEN moneda = 'USD' THEN round(monto_transferido * tipo_cambio, 2) END
 WHERE monto_equiv_usd IS NULL AND monto_equiv_pen IS NULL;

COMMIT;

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================
-- 1 · Pagos y sus aplicaciones (cada pago debe tener ≥ 1 aplicación, salvo devoluciones)
SELECT p.id, p.carpeta_importacion_id AS carpeta, p.tipo, p.fecha, p.moneda, p.monto_transferido AS monto,
       p.tipo_cambio AS tc, p.cuenta_origen_id AS cuenta, p.es_historico AS historico,
       (SELECT string_agg(a.doc_tipo || ' ' || a.moneda_doc || ' ' || a.monto_doc, ' + ') FROM public.importacion_pago_aplicaciones a WHERE a.pago_id = p.id) AS aplicado_a
  FROM public.importacion_pagos p ORDER BY p.carpeta_importacion_id, p.fecha, p.id;
