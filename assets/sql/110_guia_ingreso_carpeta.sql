-- ============================================================================
-- 110_guia_ingreso_carpeta.sql  (2026-10-27)
-- SOLO ESTRUCTURA. Vincula la GUÍA DE INGRESO (módulo Compras) con la carpeta de
-- importación, y amplía guias_remision con los datos reales del traslado
-- (transportista, placa, conductor, contenedor, precinto, fecha de traslado).
-- Cadena: carpeta → guía de ingreso → lote → kardex. Aditivo. Idempotente.
-- ============================================================================
BEGIN;

ALTER TABLE public.guias_ingreso_compra
  ADD COLUMN IF NOT EXISTS carpeta_importacion_id bigint REFERENCES public.carpetas_importacion(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_gic_carpeta ON public.guias_ingreso_compra(carpeta_importacion_id);

ALTER TABLE public.guias_remision
  ADD COLUMN IF NOT EXISTS guia_ingreso_id      bigint REFERENCES public.guias_ingreso_compra(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tipo_guia            varchar DEFAULT 'remitente',
  ADD COLUMN IF NOT EXISTS transportista_nombre varchar,
  ADD COLUMN IF NOT EXISTS transportista_ruc    varchar,
  ADD COLUMN IF NOT EXISTS placa                varchar,
  ADD COLUMN IF NOT EXISTS conductor            varchar,
  ADD COLUMN IF NOT EXISTS conductor_licencia   varchar,
  ADD COLUMN IF NOT EXISTS contenedor_nro       varchar,
  ADD COLUMN IF NOT EXISTS precinto             varchar,
  ADD COLUMN IF NOT EXISTS fecha_traslado       date,
  ADD COLUMN IF NOT EXISTS punto_partida        varchar,
  ADD COLUMN IF NOT EXISTS observaciones        text;
ALTER TABLE public.guias_remision DROP CONSTRAINT IF EXISTS guias_remision_tipo_guia_check;
ALTER TABLE public.guias_remision ADD CONSTRAINT guias_remision_tipo_guia_check CHECK (tipo_guia IS NULL OR tipo_guia IN ('remitente','transportista'));
CREATE INDEX IF NOT EXISTS idx_gr_guia_ingreso ON public.guias_remision(guia_ingreso_id);

COMMIT;
