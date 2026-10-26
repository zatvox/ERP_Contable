-- ============================================================================
-- 104_dam_levante_ajustes_declaracion.sql  (2026-10-26)
-- Etapa 3 de la carpeta (despacho y contingencias de Aduanas). ADITIVO e
-- idempotente: no toca datos ni borra nada.
--
-- 1) dams: canal, modalidad, levante, pesos/bultos del despacho, agente aduanero,
--    depósito temporal y la "declaración del agente" (JSON) con su confirmación.
--    La DAM ORIGINAL queda intacta: los ajustes de valor NO la reemplazan.
-- 2) dam_autoliquidaciones (ya existía desde el SQL 86, sin pantalla): se amplía
--    para registrar la notificación de duda razonable, el indicador de precios de
--    SUNAT, el valor adicional en aduana y la fecha de pago.
-- ============================================================================
BEGIN;

-- ── 1) DAM ────────────────────────────────────────────────────────────────
ALTER TABLE public.dams
  ADD COLUMN IF NOT EXISTS canal_aduanero            varchar
    CHECK (canal_aduanero IS NULL OR canal_aduanero IN ('verde','naranja','rojo')),
  ADD COLUMN IF NOT EXISTS modalidad_despacho        varchar,
  ADD COLUMN IF NOT EXISTS fecha_llegada             date,         -- llegada de la nave según manifiesto
  ADD COLUMN IF NOT EXISTS fecha_levante             timestamptz,  -- "levante autorizado"
  ADD COLUMN IF NOT EXISTS peso_bruto_kg             numeric,
  ADD COLUMN IF NOT EXISTS peso_neto_kg              numeric,
  ADD COLUMN IF NOT EXISTS bultos                    integer,
  ADD COLUMN IF NOT EXISTS agente_aduana             varchar,      -- ej. DESPACHOS Y SERVICIOS ADUANEROS S.A.C.
  ADD COLUMN IF NOT EXISTS deposito_temporal         varchar,      -- terminal / almacén donde se despachó
  ADD COLUMN IF NOT EXISTS declaracion_agente        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS declaracion_confirmada_at timestamptz;

COMMENT ON COLUMN public.dams.fecha_levante IS 'Fecha y hora del levante autorizado (consulta de DUA en SUNAT).';
COMMENT ON COLUMN public.dams.declaracion_agente IS
  'Lo que dice la declaración completa del agente (hojas A, B, DAV y percepción), campo por campo. El sistema genera una propuesta con sus datos y se compara con esto; al confirmar se guarda declaracion_confirmada_at.';

-- ── 2) AJUSTES DE VALOR / CONTINGENCIAS ───────────────────────────────────
ALTER TABLE public.dam_autoliquidaciones
  ADD COLUMN IF NOT EXISTS numero_notificacion       varchar,  -- ej. 118-2026-34680
  ADD COLUMN IF NOT EXISTS fecha_notificacion        date,
  ADD COLUMN IF NOT EXISTS fecha_pago                date,
  ADD COLUMN IF NOT EXISTS indicador_precio          varchar,  -- ej. 118-10-2026-80787 (Item 4)
  ADD COLUMN IF NOT EXISTS fob_unitario_declarado    numeric,
  ADD COLUMN IF NOT EXISTS fob_unitario_referencia   numeric,
  ADD COLUMN IF NOT EXISTS valor_adicional_usd       numeric NOT NULL DEFAULT 0,  -- aumento del valor en aduana (no se le paga al proveedor)
  ADD COLUMN IF NOT EXISTS enviada_costeo            boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.dam_autoliquidaciones.valor_adicional_usd IS
  'Aumento del valor en aduana fijado por SUNAT (referencia − declarado) × cantidad. Es solo base de tributos: no es plata pagada al proveedor ni entra al costo; lo que entra son los tributos adicionales pagados.';
COMMENT ON COLUMN public.dam_autoliquidaciones.enviada_costeo IS
  'true = ya se generaron sus líneas en el ledger importacion_costos (evita duplicarlas).';

COMMIT;

-- VERIFICACIÓN 1 (deben salir 11 columnas en dams)
SELECT COUNT(*) AS columnas_dams FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'dams'
   AND column_name IN ('canal_aduanero','modalidad_despacho','fecha_llegada','fecha_levante','peso_bruto_kg','peso_neto_kg',
                       'bultos','agente_aduana','deposito_temporal','declaracion_agente','declaracion_confirmada_at');
-- VERIFICACIÓN 2 (deben salir 8 columnas en dam_autoliquidaciones)
SELECT COUNT(*) AS columnas_autoliq FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'dam_autoliquidaciones'
   AND column_name IN ('numero_notificacion','fecha_notificacion','fecha_pago','indicador_precio','fob_unitario_declarado',
                       'fob_unitario_referencia','valor_adicional_usd','enviada_costeo');
