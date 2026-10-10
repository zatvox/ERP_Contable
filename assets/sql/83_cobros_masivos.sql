-- ============================================================================
-- 83_cobros_masivos.sql  (2026-10-10)
-- Cobro masivo: UN depósito del cliente se aplica a VARIAS facturas / letras
-- (por antigüedad: cancela las más antiguas y la siguiente queda parcial).
--   • cobros_lote : el depósito (fecha, cuenta, importe recibido, T.C., N° op.,
--                   N° recibo) y su ÚNICO movimiento bancario.
--   • cobros.lote_id / letras_abonos.lote_id : cada aplicación a un documento
--     es un cobro (o abono de letra) normal, con su asiento e imputación a
--     cuotas, pero SIN movimiento bancario propio (lo tiene el lote).
-- Idempotente. Requiere SQL 74 y 77.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.cobros_lote (
  id                   bigserial   PRIMARY KEY,
  contact_id           bigint      NOT NULL REFERENCES public.contacts(id),
  fecha                date        NOT NULL,
  banco_id             integer     REFERENCES public.bancos(id),
  moneda               varchar     NOT NULL DEFAULT 'PEN',   -- moneda del depósito (= de la cuenta)
  tipo_cambio          numeric,
  monto_recibido       numeric     NOT NULL,                  -- lo que entró al banco
  monto_aplicado       numeric     NOT NULL DEFAULT 0,        -- suma aplicada (en moneda del depósito)
  medio_pago           varchar,
  numero_operacion     varchar,
  numero_recibo        varchar,
  movimiento_banco_id  bigint      REFERENCES public.movimientos_banco(id) ON DELETE SET NULL,
  observaciones        text,
  created_by           bigint      REFERENCES public.users(id),
  created_at           timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cobros_lote_contact ON public.cobros_lote(contact_id);

ALTER TABLE public.cobros        ADD COLUMN IF NOT EXISTS lote_id bigint REFERENCES public.cobros_lote(id);
ALTER TABLE public.letras_abonos ADD COLUMN IF NOT EXISTS lote_id bigint REFERENCES public.cobros_lote(id);
CREATE INDEX IF NOT EXISTS idx_cobros_lote_id        ON public.cobros(lote_id);
CREATE INDEX IF NOT EXISTS idx_letras_abonos_lote_id ON public.letras_abonos(lote_id);

COMMENT ON TABLE public.cobros_lote IS 'Cobro masivo: un depósito aplicado a varias facturas/letras (FIFO por antigüedad). Un solo movimiento bancario por lote.';

ALTER TABLE public.cobros_lote ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON public.cobros_lote;
CREATE POLICY "authenticated_all" ON public.cobros_lote FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cobros_lote TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.cobros_lote_id_seq TO authenticated;

COMMIT;
