-- ============================================================================
-- 40_LETRAS_COMISION_BANCARIA.SQL — cierre del pendiente de Etapa B
-- ============================================================================
-- Cuando una letra se descuenta o se deja en custodia en el banco, el banco
-- suele cobrar una comisión. Esa comisión es un GASTO real de la empresa
-- (cuenta 679218 "COMISIONES BANCARIAS" ya está en tu plan de cuentas, con
-- movimiento en la apertura), no un simple dato suelto — por eso se modela
-- como una Compra de Servicio normal (mismo camino que cualquier otro gasto:
-- Compras → Registro → Cuenta por Pagar), y la letra solo guarda la
-- referencia de a cuál quedó ligada.
--
-- Idempotente.
-- ============================================================================

BEGIN;

ALTER TABLE public.letras_cambio
  ADD COLUMN IF NOT EXISTS comision_compra_id bigint REFERENCES public.compras(id);

COMMENT ON COLUMN public.letras_cambio.comision_compra_id IS
  'Compra de servicio (tipo_compra=servicio) registrada para la comisión que cobró el banco al llevar esta letra a descuento/custodia. NULL si no hubo comisión o no se registró.';

CREATE INDEX IF NOT EXISTS idx_letras_comision_compra ON public.letras_cambio(comision_compra_id);

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'letras_cambio' AND column_name = 'comision_compra_id';
