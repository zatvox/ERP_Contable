-- ============================================================================
-- 37_LETRAS_CAMBIO.SQL — Etapa B: canje de cuotas por letras
-- ============================================================================
-- `letras_cambio` ya existía en el schema original (01_schema.sql) con sus
-- estados PCGE (cartera → 1212, banco/descontada → 1213, cobranza → 1214) y
-- sus FKs a venta/compra/cxc/cxp. Lo que faltaba para conectarla con el
-- sistema de cuotas (script 36) es saber DE QUÉ CUOTA sale la letra — sin
-- eso no se puede descontar `monto_canjeado` de la cuota correcta cuando una
-- factura con 3 cuotas canjea solo la segunda.
--
-- REGLA DE NEGOCIO (confirmada): 1 factura puede generar N letras (una letra
-- por cuota, o varias letras fraccionando una cuota grande), pero UNA letra
-- SIEMPRE nace de una sola cuota — nunca junta cuotas de facturas distintas.
-- Por eso cuota_cobrar_id/cuota_pagar_id son la referencia, no cxc_id/cxp_id
-- directamente (esas dos ya existían y se conservan como acceso rápido a la
-- cabecera, pero la fuente de verdad del saldo es la cuota).
--
-- Idempotente.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1) LETRAS — de qué cuota salen, en qué banco están, con qué operación
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.letras_cambio
  ADD COLUMN IF NOT EXISTS cuota_cobrar_id bigint REFERENCES public.cuotas_cobrar(id),
  ADD COLUMN IF NOT EXISTS cuota_pagar_id  bigint REFERENCES public.cuotas_pagar(id),
  ADD COLUMN IF NOT EXISTS banco_id        integer REFERENCES public.bancos(id),
  ADD COLUMN IF NOT EXISTS numero_operacion varchar;

COMMENT ON COLUMN public.letras_cambio.cuota_cobrar_id IS
  'Solo en letras emitidas (tipo=emitida): la cuota de cuotas_cobrar que esta letra canjea.';
COMMENT ON COLUMN public.letras_cambio.cuota_pagar_id IS
  'Solo en letras recibidas (tipo=recibida): la cuota de cuotas_pagar que esta letra canjea.';
COMMENT ON COLUMN public.letras_cambio.banco_id IS
  'Banco donde está la letra cuando estado IN (banco, cobranza). NULL mientras está en cartera.';

-- Una letra pertenece a una cuota de un solo lado (cobrar O pagar), nunca a
-- ambas ni a ninguna — coherente con tipo IN ('emitida','recibida').
ALTER TABLE public.letras_cambio DROP CONSTRAINT IF EXISTS letras_cambio_cuota_check;
ALTER TABLE public.letras_cambio ADD CONSTRAINT letras_cambio_cuota_check
  CHECK (
    (tipo = 'emitida'  AND cuota_cobrar_id IS NOT NULL AND cuota_pagar_id IS NULL) OR
    (tipo = 'recibida' AND cuota_pagar_id  IS NOT NULL AND cuota_cobrar_id IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_letras_cuota_cobrar ON public.letras_cambio(cuota_cobrar_id);
CREATE INDEX IF NOT EXISTS idx_letras_cuota_pagar  ON public.letras_cambio(cuota_pagar_id);
CREATE INDEX IF NOT EXISTS idx_letras_banco         ON public.letras_cambio(banco_id);
CREATE INDEX IF NOT EXISTS idx_letras_estado        ON public.letras_cambio(estado);

-- ────────────────────────────────────────────────────────────────────────────
-- 2) RLS + GRANTS — letras_cambio quedó fuera del alcance original (Etapa B
--    recién ahora la activa desde el frontend).
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.letras_cambio ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS letras_cambio_select_auth ON public.letras_cambio;
DROP POLICY IF EXISTS letras_cambio_insert_auth ON public.letras_cambio;
DROP POLICY IF EXISTS letras_cambio_update_auth ON public.letras_cambio;
DROP POLICY IF EXISTS letras_cambio_delete_auth ON public.letras_cambio;

CREATE POLICY letras_cambio_select_auth ON public.letras_cambio FOR SELECT TO authenticated USING (true);
CREATE POLICY letras_cambio_insert_auth ON public.letras_cambio FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY letras_cambio_update_auth ON public.letras_cambio FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY letras_cambio_delete_auth ON public.letras_cambio FOR DELETE TO authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.letras_cambio TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'letras_cambio' ORDER BY ordinal_position;
-- SELECT tablename, policyname FROM pg_policies WHERE tablename = 'letras_cambio' ORDER BY policyname;
