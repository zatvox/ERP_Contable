-- ============================================================================
-- 62 · Series de Guía de Remisión (09) + enlace comprobante → guía → destino
-- (2026-10-02)
-- ----------------------------------------------------------------------------
-- Decisiones de Luis:
--   · FFFI y BBOL generan guía T001 (electrónica). NV01 genera guía GN01 (física).
--   · Guía T001 de venta  → mercadería a Partners / Customers.
--     Guía GN01 de venta  → mercadería a Partners / 90.
--   · Devolución a proveedor también usa T001 (su destino sigue siendo Vendors).
--   · Traslados internos NO usan guía: se numeran por PK (etapa 2 del PK).
-- Columnas nuevas en series_documentos:
--   serie_guia            → en series de comprobante (01/03): qué serie 09 genera.
--   ubicacion_destino_id  → en series de guía (09): a qué ubicación virtual va la venta.
-- Los correlativos (inicial / último usado) los ajusta Luis desde
-- Ventas → Configuración → Series y correlativos.
-- ============================================================================
BEGIN;

-- 1) Permitir tipo '09' (Guía de Remisión Remitente)
ALTER TABLE public.series_documentos DROP CONSTRAINT IF EXISTS series_documentos_tipo_documento_check;
ALTER TABLE public.series_documentos
  ADD CONSTRAINT series_documentos_tipo_documento_check
  CHECK (tipo_documento IN ('PK','01','03','07','08','09'));

-- 2) Columnas de enlace
ALTER TABLE public.series_documentos ADD COLUMN IF NOT EXISTS serie_guia varchar;
ALTER TABLE public.series_documentos ADD COLUMN IF NOT EXISTS ubicacion_destino_id integer REFERENCES public.ubicaciones(id);
COMMENT ON COLUMN public.series_documentos.serie_guia IS 'Serie (tipo 09) de la guía que genera este comprobante. Ej. FFFI→T001, NV01→GN01.';
COMMENT ON COLUMN public.series_documentos.ubicacion_destino_id IS 'Solo tipo 09: ubicación virtual destino de la venta en el kardex (Customers, 90…).';

-- 3) Series de guía. ultimo_correlativo = mayor número ya emitido con ese prefijo
--    (guías de venta + guías de devolución a proveedor comparten T001).
WITH usados AS (
  SELECT split_part(numero_guia, '-', 1) AS serie,
         MAX(NULLIF(regexp_replace(split_part(numero_guia, '-', 2), '\D', '', 'g'), '')::int) AS ult
  FROM (
    SELECT numero_guia FROM public.guias_despacho_venta
    UNION ALL
    SELECT numero_guia FROM public.guias_devolucion_compra
  ) g
  WHERE numero_guia LIKE '%-%'
  GROUP BY 1
)
INSERT INTO public.series_documentos
  (tipo_documento, serie, descripcion, correlativo_inicial, ultimo_correlativo, digitos, es_cpe, por_defecto, ubicacion_destino_id)
VALUES
  ('09', 'T001', 'Guía de remisión electrónica', 1,
     COALESCE((SELECT ult FROM usados WHERE serie = 'T001'), 0), 8, true,  true,
     (SELECT id FROM public.ubicaciones WHERE codigo = 'CUSTOMERS' LIMIT 1)),
  ('09', 'GN01', 'Guía de remisión física (no se envía a SUNAT)', 1,
     COALESCE((SELECT ult FROM usados WHERE serie = 'GN01'), 0), 8, false, false,
     -- Partners / 90: se busca por nombre dentro del almacén virtual; si no
     -- matchea queda NULL y se elige en Configuración → Series (Editar GN01).
     (SELECT u.id FROM public.ubicaciones u JOIN public.almacenes a ON a.id = u.almacen_id
       WHERE a.es_virtual AND (u.nombre ILIKE '%90%' OR u.codigo ILIKE '%90%') ORDER BY u.id LIMIT 1))
ON CONFLICT (tipo_documento, serie) DO NOTHING;

-- 4) Qué guía genera cada comprobante
UPDATE public.series_documentos SET serie_guia = 'T001' WHERE tipo_documento IN ('01','03') AND serie IN ('FFFI','BBOL') AND serie_guia IS NULL;
UPDATE public.series_documentos SET serie_guia = 'GN01' WHERE tipo_documento = '01' AND serie = 'NV01' AND serie_guia IS NULL;

COMMIT;

-- 5) VERIFICACIÓN
SELECT s.tipo_documento, s.serie, s.serie_guia, s.ultimo_correlativo,
       a.nombre || ' / ' || u.nombre AS destino
FROM public.series_documentos s
LEFT JOIN public.ubicaciones u ON u.id = s.ubicacion_destino_id
LEFT JOIN public.almacenes  a ON a.id = u.almacen_id
ORDER BY s.tipo_documento, s.serie;

-- ROLLBACK (si hiciera falta):
-- DELETE FROM public.series_documentos WHERE tipo_documento = '09' AND serie IN ('T001','GN01');
-- ALTER TABLE public.series_documentos DROP COLUMN IF EXISTS serie_guia, DROP COLUMN IF EXISTS ubicacion_destino_id;
-- ALTER TABLE public.series_documentos DROP CONSTRAINT series_documentos_tipo_documento_check;
-- ALTER TABLE public.series_documentos ADD CONSTRAINT series_documentos_tipo_documento_check CHECK (tipo_documento IN ('PK','01','03','07','08'));
