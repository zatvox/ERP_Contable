-- ============================================================================
-- 103_bl_campos_y_adjuntos_origen_ficha.sql  (2026-10-24)
-- 1) bill_of_ladings: datos que trae el BL y que no tenían dónde guardarse
--    (booking, naviera, nave/viaje, bultos, CBM, ETA/llegada del seguimiento,
--    flete prepagado y flete por cobrar en destino) para cruzarlos contra el
--    PL, el CI y la DAM, y para armar el enlace de rastreo.
-- 2) adjuntos: dos tipos nuevos, 'certificado_origen' y 'ficha_tecnica'.
-- Aditivo e idempotente. No toca datos.
-- ============================================================================
BEGIN;

ALTER TABLE public.bill_of_ladings
  ADD COLUMN IF NOT EXISTS booking_number    varchar,
  ADD COLUMN IF NOT EXISTS naviera           varchar,
  ADD COLUMN IF NOT EXISTS nave_viaje        varchar,
  ADD COLUMN IF NOT EXISTS tipo_contenedor   varchar,
  ADD COLUMN IF NOT EXISTS bultos            integer,
  ADD COLUMN IF NOT EXISTS volumen_cbm       numeric,
  ADD COLUMN IF NOT EXISTS fecha_eta         date,
  ADD COLUMN IF NOT EXISTS fecha_llegada     date,
  ADD COLUMN IF NOT EXISTS tracking_actualizado timestamptz,
  ADD COLUMN IF NOT EXISTS flete_prepago_usd numeric,
  ADD COLUMN IF NOT EXISTS flete_prepago_cny numeric,
  ADD COLUMN IF NOT EXISTS flete_destino_usd numeric;

COMMENT ON COLUMN public.bill_of_ladings.fecha IS 'Fecha de embarque a bordo (Shipped on board / Date laden on board).';
COMMENT ON COLUMN public.bill_of_ladings.fecha_eta IS 'ETA al puerto de descarga según el seguimiento de la naviera.';
COMMENT ON COLUMN public.bill_of_ladings.flete_destino_usd IS 'Cargos "collect" del BL que la naviera cobra en destino (THD, CVC...).';

ALTER TABLE public.adjuntos DROP CONSTRAINT IF EXISTS adjuntos_concepto_check;
ALTER TABLE public.adjuntos ADD CONSTRAINT adjuntos_concepto_check
  CHECK (concepto IN ('voucher','recibo','dietario','otro',
                      'invoice','proforma','bl','dam','liquidacion','autoliquidacion',
                      'factura_gasto','rh','poliza','packing','boletin','guia',
                      'swift','contrato','correo',
                      'certificado_origen','ficha_tecnica'));

COMMIT;

-- VERIFICACIÓN 1 (deben salir 12 columnas)
SELECT COUNT(*) AS columnas_nuevas FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'bill_of_ladings'
   AND column_name IN ('booking_number','naviera','nave_viaje','tipo_contenedor','bultos','volumen_cbm',
                       'fecha_eta','fecha_llegada','tracking_actualizado','flete_prepago_usd','flete_prepago_cny','flete_destino_usd');
-- VERIFICACIÓN 2 (la definición debe incluir certificado_origen y ficha_tecnica)
SELECT pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid = 'public.adjuntos'::regclass AND conname = 'adjuntos_concepto_check';
