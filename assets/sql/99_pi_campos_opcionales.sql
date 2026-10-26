-- ============================================================================
-- 99_pi_campos_opcionales.sql  (2026-10-23)
-- Tres datos que traen algunas Proformas (PI) y que faltaban en orden_compra:
--   · entrega_pactada       texto libre: "JULIO 2026" (hay PI que no dan días, dan un mes)
--   · dias_saldo_desde_bl   "70% dentro de 30 días desde la fecha del B/L" -> 30
--   · validez_oferta        "VALIDITY: 7 days till Jul.17.2026" (NO es el plazo del anticipo)
-- Aditivo e idempotente. No toca datos.
-- ============================================================================
BEGIN;

ALTER TABLE public.orden_compra
  ADD COLUMN IF NOT EXISTS entrega_pactada     varchar,
  ADD COLUMN IF NOT EXISTS dias_saldo_desde_bl integer CHECK (dias_saldo_desde_bl IS NULL OR dias_saldo_desde_bl >= 0),
  ADD COLUMN IF NOT EXISTS validez_oferta      date;

COMMENT ON COLUMN public.orden_compra.entrega_pactada IS 'Entrega según la PI, texto libre (ej. JULIO 2026).';
COMMENT ON COLUMN public.orden_compra.dias_saldo_desde_bl IS 'Días para pagar el saldo contados desde la fecha del B/L (ej. 30). Con la fecha del BL se proyecta el vencimiento.';
COMMENT ON COLUMN public.orden_compra.validez_oferta IS 'Hasta cuándo vale la oferta del proveedor. Distinto de dias_validez_anticipo (plazo para pagar el anticipo).';

COMMIT;

-- VERIFICACIÓN (deben salir 3 filas)
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'orden_compra'
   AND column_name IN ('entrega_pactada', 'dias_saldo_desde_bl', 'validez_oferta')
 ORDER BY column_name;
