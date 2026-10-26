-- ============================================================================
-- 94_importacion_pagos_e_incoterm.sql  (2026-10-21)
--
-- SOLO ESTRUCTURA. No inserta ningún dato: los registros los haces tú desde el
-- sistema. Reemplaza al 94, que cargaba el caso a mano por SQL (YA NO SE CORRE).
--
-- 1. carpetas_importacion.incoterm
--    El incoterm manda sobre el costeo (CIF = flete y seguro ya incluidos) y
--    el Commercial Invoice lo hereda de la Proforma.
--
-- 2. importacion_pagos
--    Lo que no tenía dónde registrarse: el pago al proveedor del exterior
--    (anticipo y saldo) con sus comisiones bancarias, y los pagos al agente.
--    Campos tomados de la constancia BCP y del mensaje SWIFT de la carpeta 8.
--    Es hija de la carpeta (igual que contenedores e importacion_costos): la
--    empresa se resuelve por la carpeta, no lleva empresa_id propio.
--
-- Aditivo. Idempotente.
-- ============================================================================
BEGIN;

ALTER TABLE public.carpetas_importacion
  ADD COLUMN IF NOT EXISTS incoterm varchar;

COMMENT ON COLUMN public.carpetas_importacion.incoterm IS
  'Incoterm pactado (CIF, FOB...). Con CIF/CFR/CIP/CPT/DAP/DDP el precio ya incluye flete y seguro: el ledger no debe volver a cargarlos.';

CREATE TABLE IF NOT EXISTS public.importacion_pagos (
  id                      bigserial   PRIMARY KEY,
  carpeta_importacion_id  bigint      NOT NULL REFERENCES public.carpetas_importacion(id) ON DELETE CASCADE,
  orden_compra_id         bigint      REFERENCES public.orden_compra(id) ON DELETE SET NULL,
  tipo                    varchar     NOT NULL DEFAULT 'anticipo'
                            CHECK (tipo IN ('anticipo','saldo','pago_total','agente','devolucion','otro')),
  fecha                   date        NOT NULL,
  moneda                  varchar     NOT NULL DEFAULT 'USD' CHECK (moneda IN ('USD','PEN','EUR')),
  -- Soles por 1 USD, igual que en el resto del módulo.
  tipo_cambio             numeric     NOT NULL DEFAULT 1 CHECK (tipo_cambio > 0),
  monto_transferido       numeric     NOT NULL CHECK (monto_transferido >= 0),
  comision_transferencia  numeric     NOT NULL DEFAULT 0 CHECK (comision_transferencia >= 0),
  comision_swift          numeric     NOT NULL DEFAULT 0 CHECK (comision_swift >= 0),
  monto_total_debitado    numeric     GENERATED ALWAYS AS
                            (monto_transferido + comision_transferencia + comision_swift) STORED,
  cuenta_origen_id        integer     REFERENCES public.bancos(id),
  beneficiario            varchar,
  banco_beneficiario      varchar,
  swift_bic               varchar,
  referencia              varchar,    -- ej. "CONTRACT NO.260710HY5012, PROFORMA INVOICE P260710HY5012"
  codigo_operacion        varchar,    -- código de solicitud del banco
  uetr                    varchar,    -- rastreo SWIFT gpi, opcional
  estado                  varchar     NOT NULL DEFAULT 'ejecutado'
                            CHECK (estado IN ('en_proceso','ejecutado','observado')),
  observaciones           text,
  created_by              bigint      REFERENCES public.users(id),
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_imppagos_carpeta ON public.importacion_pagos(carpeta_importacion_id);
CREATE INDEX IF NOT EXISTS idx_imppagos_oc      ON public.importacion_pagos(orden_compra_id);

-- No registrar dos veces la misma operación bancaria en la misma carpeta.
CREATE UNIQUE INDEX IF NOT EXISTS idx_imppagos_operacion_uk
  ON public.importacion_pagos(carpeta_importacion_id, codigo_operacion)
  WHERE codigo_operacion IS NOT NULL AND codigo_operacion <> '';

COMMENT ON TABLE public.importacion_pagos IS
  'Pagos de una carpeta de importación: anticipo y saldo al proveedor del exterior, pagos al agente y devoluciones. Las comisiones (transferencia + SWIFT) van aquí y se reflejan como gasto financiero en el ledger.';

-- Carpeta cerrada = solo lectura, igual que el ledger.
DROP TRIGGER IF EXISTS trg_importacion_pagos_carpeta_abierta ON public.importacion_pagos;
CREATE TRIGGER trg_importacion_pagos_carpeta_abierta
  BEFORE INSERT OR UPDATE OR DELETE ON public.importacion_pagos
  FOR EACH ROW EXECUTE FUNCTION public.fn_importacion_carpeta_abierta();

DROP TRIGGER IF EXISTS trg_importacion_pagos_touch ON public.importacion_pagos;
CREATE TRIGGER trg_importacion_pagos_touch BEFORE UPDATE ON public.importacion_pagos
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();

ALTER TABLE public.importacion_pagos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON public.importacion_pagos;
CREATE POLICY "authenticated_all" ON public.importacion_pagos FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.importacion_pagos TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.importacion_pagos_id_seq TO authenticated;

-- Adjuntos: permitir 'importacion_pago' (constancia BCP, SWIFT) y conceptos swift/contrato.
-- Listas completas = las de 86 + lo nuevo.
ALTER TABLE public.adjuntos DROP CONSTRAINT IF EXISTS adjuntos_entidad_check;
ALTER TABLE public.adjuntos ADD CONSTRAINT adjuntos_entidad_check
  CHECK (entidad IN ('cobro','pago','letra','compra','packing',
                     'carpeta_importacion','documento_importacion','costo_importacion',
                     'comercial_invoice','bill_of_lading','contenedor','dam',
                     'autoliquidacion','guia_remision','importacion_pago'));
ALTER TABLE public.adjuntos DROP CONSTRAINT IF EXISTS adjuntos_concepto_check;
ALTER TABLE public.adjuntos ADD CONSTRAINT adjuntos_concepto_check
  CHECK (concepto IN ('voucher','recibo','dietario','otro',
                      'invoice','proforma','bl','dam','liquidacion','autoliquidacion',
                      'factura_gasto','rh','poliza','packing','boletin','guia',
                      'swift','contrato'));

COMMIT;

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================
-- 1 · La columna nueva y la tabla (deben salir 1 + 23 columnas)
SELECT 'carpetas_importacion.incoterm' AS objeto, COUNT(*) AS columnas
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'carpetas_importacion' AND column_name = 'incoterm'
UNION ALL
SELECT 'importacion_pagos', COUNT(*)
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'importacion_pagos';

-- 2 · Los dos triggers de la tabla (deben salir 2)
SELECT tgname
  FROM pg_trigger
 WHERE tgrelid = 'public.importacion_pagos'::regclass AND NOT tgisinternal
 ORDER BY tgname;
