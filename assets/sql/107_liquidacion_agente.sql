-- ============================================================================
-- 107_liquidacion_agente.sql  (2026-10-26)
-- SOLO ESTRUCTURA. Liquidación del agente aduanero (ej. DESA «Liquidación 2026-080»):
--   · cabecera (n°, fecha, agente, DAM, devolución de saldo)
--   · abonos que el cliente le hizo al agente (anticipos / provisión de fondos)
--   · las facturas de gasto se vinculan desde el ledger: importacion_costos.liquidacion_agente_id
-- La devolución del saldo va en la cabecera (no en importacion_pagos, para no
-- confundirla con devoluciones del proveedor del exterior).
-- Aditivo. Idempotente.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.importacion_liquidaciones_agente (
  id                      bigserial PRIMARY KEY,
  carpeta_importacion_id  bigint  NOT NULL REFERENCES public.carpetas_importacion(id) ON DELETE CASCADE,
  numero                  varchar NOT NULL,
  fecha                   date    NOT NULL,
  agente_nombre           varchar,
  agente_id               bigint,
  dam_numero              varchar,
  estado                  varchar NOT NULL DEFAULT 'conforme' CHECK (estado IN ('borrador','conforme','observada')),
  -- Devolución del saldo a favor del cliente
  dev_monto_usd           numeric NOT NULL DEFAULT 0 CHECK (dev_monto_usd >= 0),
  dev_fecha               date,
  dev_tipo_cambio         numeric,
  dev_operacion           varchar,
  dev_medio               varchar,            -- ej. Transferencia interbancaria
  dev_banco_id            integer REFERENCES public.bancos(id),
  dev_estado              varchar CHECK (dev_estado IS NULL OR dev_estado IN ('en_proceso','recibida')),
  dev_comision_a_cargo    varchar DEFAULT 'agente',
  observaciones           text,
  created_by              bigint REFERENCES public.users(id),
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_liqagente_uk ON public.importacion_liquidaciones_agente(carpeta_importacion_id, numero);

CREATE TABLE IF NOT EXISTS public.importacion_liquidacion_abonos (
  id                      bigserial PRIMARY KEY,
  liquidacion_agente_id   bigint  NOT NULL REFERENCES public.importacion_liquidaciones_agente(id) ON DELETE CASCADE,
  fecha                   date    NOT NULL,
  moneda                  varchar NOT NULL DEFAULT 'USD' CHECK (moneda IN ('USD','PEN')),
  tipo_cambio             numeric NOT NULL DEFAULT 1 CHECK (tipo_cambio > 0),
  monto                   numeric NOT NULL CHECK (monto >= 0),
  operacion               varchar,
  banco_id                integer REFERENCES public.bancos(id),
  concepto                varchar,
  created_at              timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_liqabono_liq ON public.importacion_liquidacion_abonos(liquidacion_agente_id);

ALTER TABLE public.importacion_costos
  ADD COLUMN IF NOT EXISTS liquidacion_agente_id bigint REFERENCES public.importacion_liquidaciones_agente(id) ON DELETE SET NULL;

DROP TRIGGER IF EXISTS trg_liqagente_touch ON public.importacion_liquidaciones_agente;
CREATE TRIGGER trg_liqagente_touch BEFORE UPDATE ON public.importacion_liquidaciones_agente
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();

DROP TRIGGER IF EXISTS trg_liqagente_carpeta_abierta ON public.importacion_liquidaciones_agente;
CREATE TRIGGER trg_liqagente_carpeta_abierta
  BEFORE INSERT OR UPDATE OR DELETE ON public.importacion_liquidaciones_agente
  FOR EACH ROW EXECUTE FUNCTION public.fn_importacion_carpeta_abierta();

ALTER TABLE public.importacion_liquidaciones_agente ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON public.importacion_liquidaciones_agente;
CREATE POLICY "authenticated_all" ON public.importacion_liquidaciones_agente FOR ALL TO authenticated USING (true) WITH CHECK (true);
ALTER TABLE public.importacion_liquidacion_abonos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON public.importacion_liquidacion_abonos;
CREATE POLICY "authenticated_all" ON public.importacion_liquidacion_abonos FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.importacion_liquidaciones_agente, public.importacion_liquidacion_abonos TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.importacion_liquidaciones_agente_id_seq, public.importacion_liquidacion_abonos_id_seq TO authenticated;

-- Adjuntos: la liquidación del agente (PDF, scans) y su devolución.
ALTER TABLE public.adjuntos DROP CONSTRAINT IF EXISTS adjuntos_entidad_check;
ALTER TABLE public.adjuntos ADD CONSTRAINT adjuntos_entidad_check
  CHECK (entidad IN ('cobro','pago','letra','compra','packing',
                     'carpeta_importacion','documento_importacion','costo_importacion',
                     'comercial_invoice','bill_of_lading','contenedor','dam',
                     'autoliquidacion','guia_remision','importacion_pago','liquidacion_agente'));

COMMIT;
