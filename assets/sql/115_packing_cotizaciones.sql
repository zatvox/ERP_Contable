-- ============================================================================
-- 115 · Cotizaciones en Packing (2026-10-27)
--
-- Problema: cada vendedor sacaba un N° de PK al cotizar; como se confirman en
-- otro orden, había que editar correlativos a mano.
-- Solución: la COTIZACIÓN es un registro de `packing` con estado 'cotizacion'
-- y SIN correlativo de PK. Usa su propia numeración interna COT-0001
-- (cot_correlativo, por empresa) que no consume la serie PK.
-- Al CONFIRMAR toma el siguiente correlativo PK libre y pasa a 'borrador'
-- (conserva cot_correlativo como trazabilidad).
--
--   numero        → 'COT-0012' mientras es cotización; 'PK-018710' al confirmar
--   correlativo   → NULL mientras es cotización
-- ============================================================================
DO $$
BEGIN
  ALTER TABLE public.packing ALTER COLUMN correlativo DROP NOT NULL;
  ALTER TABLE public.packing ADD COLUMN IF NOT EXISTS cot_correlativo integer;
  COMMENT ON COLUMN public.packing.cot_correlativo IS
    'N° interno de cotización (COT-0001) por empresa. Se conserva al confirmar el PK. Ver sql/115.';

  ALTER TABLE public.packing DROP CONSTRAINT IF EXISTS packing_estado_check;
  ALTER TABLE public.packing ADD CONSTRAINT packing_estado_check
    CHECK (estado IN ('cotizacion', 'borrador', 'enviado', 'parcial', 'facturado', 'anulado'));

  -- Una cotización con correlativo de PK no tiene sentido (y viceversa no aplica:
  -- un PK puede venir de una cotización y conservar su cot_correlativo).
  ALTER TABLE public.packing DROP CONSTRAINT IF EXISTS packing_cotizacion_sin_corr_check;
  ALTER TABLE public.packing ADD CONSTRAINT packing_cotizacion_sin_corr_check
    CHECK (estado <> 'cotizacion' OR correlativo IS NULL);
  ALTER TABLE public.packing DROP CONSTRAINT IF EXISTS packing_pk_con_corr_check;
  ALTER TABLE public.packing ADD CONSTRAINT packing_pk_con_corr_check
    CHECK (estado = 'cotizacion' OR correlativo IS NOT NULL);
END $$;

-- N° de cotización único por empresa (NULLs permitidos para PK sin cotización)
CREATE UNIQUE INDEX IF NOT EXISTS ux_packing_empresa_cot
  ON public.packing (empresa_id, cot_correlativo) WHERE cot_correlativo IS NOT NULL;

NOTIFY pgrst, 'reload schema';

-- Revertir (solo si no hay cotizaciones):
-- DELETE FROM public.packing WHERE estado = 'cotizacion';
-- ALTER TABLE public.packing DROP CONSTRAINT packing_cotizacion_sin_corr_check;
-- ALTER TABLE public.packing DROP CONSTRAINT packing_pk_con_corr_check;
-- ALTER TABLE public.packing ALTER COLUMN correlativo SET NOT NULL;
-- ALTER TABLE public.packing DROP CONSTRAINT packing_estado_check;
-- ALTER TABLE public.packing ADD CONSTRAINT packing_estado_check CHECK (estado IN ('borrador','enviado','parcial','facturado','anulado'));
