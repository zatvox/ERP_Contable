-- ============================================================================
-- 147 · Perfil de empresa: web, logo en Storage público y datos de JHIRO
-- (2026-11-09)
--   · empresa_config.web
--   · Bucket PÚBLICO 'empresa-logos' (el logo sale en PDFs: necesita URL fija,
--     no firmada). Lectura pública; escritura solo usuarios autenticados.
--   · JHIRO: sus datos estaban "quemados" en el código del PDF → se copian a
--     empresa_config SOLO en los campos vacíos (no pisa lo que ya escribiste).
-- ============================================================================
ALTER TABLE public.empresa_config ADD COLUMN IF NOT EXISTS web varchar;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('empresa-logos', 'empresa-logos', true, 2097152, ARRAY['image/png','image/jpeg','image/webp','image/svg+xml'])
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS "empresa_logos_select" ON storage.objects;
CREATE POLICY "empresa_logos_select" ON storage.objects FOR SELECT USING (bucket_id = 'empresa-logos');
DROP POLICY IF EXISTS "empresa_logos_insert" ON storage.objects;
CREATE POLICY "empresa_logos_insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'empresa-logos');
DROP POLICY IF EXISTS "empresa_logos_update" ON storage.objects;
CREATE POLICY "empresa_logos_update" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'empresa-logos');
DROP POLICY IF EXISTS "empresa_logos_delete" ON storage.objects;
CREATE POLICY "empresa_logos_delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'empresa-logos');

-- JHIRO: lo que antes salía del código del PDF, ahora en su perfil
UPDATE public.empresa_config SET
  direccion = CASE WHEN coalesce(btrim(direccion), '') IN ('', 'San Juan de Lurigancho, Lima')
                   THEN 'AV. SANTA ROSA LT. 15 MZ. S URB. SAN GABRIEL - LIMA - LIMA - SAN JUAN DE LURIGANCHO' ELSE direccion END,
  distrito     = coalesce(nullif(btrim(distrito), ''), 'SAN JUAN DE LURIGANCHO'),
  provincia    = coalesce(nullif(btrim(provincia), ''), 'LIMA'),
  departamento = coalesce(nullif(btrim(departamento), ''), 'LIMA'),
  email        = coalesce(nullif(btrim(email), ''), 'gerencia@jhiroperu.com'),
  telefono     = coalesce(nullif(btrim(telefono), ''), '979050317'),
  web          = coalesce(nullif(btrim(web), ''), 'https://jhiroperu.com'),
  logo_url     = coalesce(nullif(btrim(logo_url), ''), 'assets/img/logo-jhiro.png')
WHERE ruc = '20600842995';

SELECT codigo, ruc, direccion, email, telefono, web, logo_url FROM public.empresa_config ORDER BY orden;

-- Cuentas de depósito que se imprimen al pie del Packing / Cotización
-- (se eligen en Perfil → Multiempresa → empresa → "Cuentas para depósito")
ALTER TABLE public.bancos ADD COLUMN IF NOT EXISTS mostrar_en_pdf boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.bancos.mostrar_en_pdf IS 'true = la cuenta sale al pie del PDF de Packing/Cotización de su empresa (SQL 147).';
NOTIFY pgrst, 'reload schema';
