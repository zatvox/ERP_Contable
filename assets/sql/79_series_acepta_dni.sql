-- ============================================================================
-- 79 — series_documentos.acepta_dni (2026-10-08)
-- Serie de FACTURA física (no CPE) que también puede emitirse a clientes con
-- DNI. Caso: NV01 (nota de venta física, no va a SUNAT). Con un cliente DNI,
-- Nueva venta / Editar venta ofrecen Boleta + las series de Factura con este
-- flag; las facturas electrónicas (FFFI) siguen bloqueadas para DNI.
-- Se edita en Ventas → Configuración → Series (casilla "Acepta clientes con DNI").
-- ============================================================================
ALTER TABLE public.series_documentos ADD COLUMN IF NOT EXISTS acepta_dni boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.series_documentos.acepta_dni IS 'Factura física (es_cpe=false) que se puede emitir a clientes con DNI.';

-- NV01 acepta DNI desde ya (se puede desmarcar en Configuración → Series)
UPDATE public.series_documentos SET acepta_dni = true
WHERE serie = 'NV01' AND tipo_documento = '01' AND es_cpe = false;

-- Verificación
SELECT tipo_documento, serie, es_cpe, acepta_dni FROM public.series_documentos
WHERE tipo_documento IN ('01','03') ORDER BY tipo_documento, serie;
