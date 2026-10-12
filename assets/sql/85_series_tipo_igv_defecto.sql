-- ============================================================================
-- 85 — series_documentos.tipo_igv_defecto (2026-10-11)
-- Tipo de IGV que propone la serie al emitir. NULL = sin preferencia (las
-- líneas conservan su tipo, ej. FFFI facturando un PK con +18%).
-- Al elegir una serie con valor en Nueva venta, las líneas se ajustan a ese
-- tipo (con aviso) y siguen editables por línea.
-- Se edita en Ventas → Configuración → Series ("Tipo de IGV por defecto").
-- ============================================================================
ALTER TABLE public.series_documentos ADD COLUMN IF NOT EXISTS tipo_igv_defecto text NULL;

DO $$ BEGIN
  ALTER TABLE public.series_documentos ADD CONSTRAINT series_tipo_igv_defecto_chk
    CHECK (tipo_igv_defecto IS NULL OR tipo_igv_defecto IN ('gravada','gravada_incluido','exonerada','inafecta'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.series_documentos.tipo_igv_defecto IS
  'Tipo IGV propuesto por la serie: gravada | gravada_incluido | exonerada | inafecta. NULL = respeta el de cada línea.';

-- NV01 (nota de venta física) → Inafecta. FFFI y demás quedan en blanco.
UPDATE public.series_documentos SET tipo_igv_defecto = 'inafecta'
WHERE serie = 'NV01' AND tipo_documento = '01';

-- Verificación
SELECT tipo_documento, serie, es_cpe, tipo_igv_defecto FROM public.series_documentos
ORDER BY tipo_documento, serie;
