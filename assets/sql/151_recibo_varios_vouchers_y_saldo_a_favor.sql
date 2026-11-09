-- ============================================================================
-- 151_recibo_varios_vouchers_y_saldo_a_favor.sql  (2026-11-09)
-- Cobro masivo → "Cobro por recibo": 1 recibo con VARIOS vouchers (fechas,
-- cuentas y T.C. distintos) que cancelan 1 o varias facturas/letras del cliente.
-- Y SALDO A FAVOR del cliente: si los vouchers suman más que lo aplicado, el
-- sobrante queda como saldo a favor y se netea en la próxima cobranza.
--
--  • cobros_lote.grupo_recibo: une los vouchers (uno por fila) de un mismo recibo.
--    Deshacer = todo el grupo.
--  • saldos_favor_cliente: el sobrante (por cliente, empresa y moneda).
--  • cobros.saldo_favor_id / saldo_favor_monto: un cobro pagado CON saldo a favor
--    (medio 'saldo_favor', sin banco). El consumo del saldo se recalcula solo
--    con trigger (al aplicar o al deshacer/eliminar el cobro).
--  • cobros.medio_pago: se agregan 'yape_plin' (ya lo ofrecía el cobro masivo y
--    fallaba) y 'saldo_favor'.
-- Aditivo. Idempotente.
-- ============================================================================
BEGIN;

-- 1) Grupo de recibo en los depósitos
ALTER TABLE public.cobros_lote ADD COLUMN IF NOT EXISTS grupo_recibo uuid;
CREATE INDEX IF NOT EXISTS idx_cobros_lote_grupo ON public.cobros_lote(grupo_recibo);

-- 2) Saldos a favor del cliente
CREATE TABLE IF NOT EXISTS public.saldos_favor_cliente (
  id              bigserial   PRIMARY KEY,
  empresa_id      integer     NOT NULL,
  contact_id      bigint      NOT NULL REFERENCES public.contacts(id),
  fecha           date        NOT NULL,
  moneda          varchar     NOT NULL DEFAULT 'PEN',
  monto           numeric     NOT NULL CHECK (monto > 0),
  monto_aplicado  numeric     NOT NULL DEFAULT 0,
  estado          varchar     NOT NULL DEFAULT 'disponible' CHECK (estado IN ('disponible','aplicado','anulado')),
  origen          varchar     NOT NULL DEFAULT 'sobrante_cobro',
  lote_id         bigint      REFERENCES public.cobros_lote(id) ON DELETE SET NULL,
  grupo_recibo    uuid,
  numero_recibo   varchar,
  observaciones   text,
  created_by      bigint      REFERENCES public.users(id),
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sfc_contact ON public.saldos_favor_cliente(contact_id, estado);
CREATE INDEX IF NOT EXISTS idx_sfc_grupo   ON public.saldos_favor_cliente(grupo_recibo);
COMMENT ON TABLE public.saldos_favor_cliente IS 'Sobrante de un cobro (el cliente pagó de más): se netea en una cobranza siguiente. Disponible = monto − monto_aplicado.';

ALTER TABLE public.saldos_favor_cliente ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON public.saldos_favor_cliente;
CREATE POLICY "authenticated_all" ON public.saldos_favor_cliente FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.saldos_favor_cliente TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.saldos_favor_cliente_id_seq TO authenticated;

-- 3) Cobros pagados con saldo a favor
ALTER TABLE public.cobros ADD COLUMN IF NOT EXISTS saldo_favor_id    bigint REFERENCES public.saldos_favor_cliente(id);
ALTER TABLE public.cobros ADD COLUMN IF NOT EXISTS saldo_favor_monto numeric;   -- consumido, en la moneda del saldo
CREATE INDEX IF NOT EXISTS idx_cobros_saldo_favor ON public.cobros(saldo_favor_id);

-- 4) medio_pago: + yape_plin, + saldo_favor
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.cobros'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%medio_pago%' LOOP
    EXECUTE format('ALTER TABLE public.cobros DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE public.cobros ADD CONSTRAINT cobros_medio_pago_check
  CHECK (medio_pago IN ('transferencia','cheque','efectivo','deposito','detraccion','yape_plin','saldo_favor','otro'));

-- 5) Consumo del saldo a favor = Σ cobros que lo usan (se recalcula solo)
CREATE OR REPLACE FUNCTION public.fn_saldo_favor_recalcular() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_id bigint; v_apl numeric; v_monto numeric;
BEGIN
  FOREACH v_id IN ARRAY ARRAY[CASE WHEN TG_OP <> 'INSERT' THEN OLD.saldo_favor_id END,
                              CASE WHEN TG_OP <> 'DELETE' THEN NEW.saldo_favor_id END] LOOP
    CONTINUE WHEN v_id IS NULL;
    SELECT COALESCE(SUM(saldo_favor_monto), 0) INTO v_apl FROM public.cobros WHERE saldo_favor_id = v_id;
    SELECT monto INTO v_monto FROM public.saldos_favor_cliente WHERE id = v_id;
    UPDATE public.saldos_favor_cliente
       SET monto_aplicado = round(v_apl, 2),
           estado = CASE WHEN estado = 'anulado' THEN 'anulado'
                         WHEN v_apl >= v_monto - 0.009 THEN 'aplicado' ELSE 'disponible' END
     WHERE id = v_id;
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS trg_saldo_favor_recalcular ON public.cobros;
CREATE TRIGGER trg_saldo_favor_recalcular AFTER INSERT OR UPDATE OF saldo_favor_id, saldo_favor_monto OR DELETE ON public.cobros
  FOR EACH ROW EXECUTE FUNCTION public.fn_saldo_favor_recalcular();

COMMIT;

-- VERIFICACIÓN
SELECT 'grupo_recibo' AS objeto, count(*) FROM information_schema.columns WHERE table_name = 'cobros_lote' AND column_name = 'grupo_recibo'
UNION ALL SELECT 'saldos_favor_cliente', count(*) FROM information_schema.tables WHERE table_name = 'saldos_favor_cliente'
UNION ALL SELECT 'cobros.saldo_favor_*', count(*) FROM information_schema.columns WHERE table_name = 'cobros' AND column_name LIKE 'saldo_favor%'
UNION ALL SELECT 'trigger saldo favor', count(*) FROM pg_trigger WHERE tgname = 'trg_saldo_favor_recalcular';
