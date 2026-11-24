-- ============================================================================
-- 162_crm_catalogo_slug_privado.sql  (2026-11-23)
-- Catálogo web: cada empresa se abre con un CÓDIGO PÚBLICO aleatorio (slug), no con su id.
--   · Antes: crm_empresas_publicas() devolvía TODAS las empresas a cualquier visitante anónimo
--     (y el id 1,2,3 se podía adivinar con ?emp=2).
--   · Ahora: el visitante solo puede pedir UNA empresa y solo si conoce su slug.
-- Idempotente. El personal (authenticated) conserva crm_empresas_publicas().
-- ============================================================================

-- 1. Columna slug (aleatoria) + backfill
ALTER TABLE public.empresa_config ADD COLUMN IF NOT EXISTS slug text;
UPDATE public.empresa_config
   SET slug = substr(md5(random()::text || clock_timestamp()::text || id::text), 1, 10)
 WHERE slug IS NULL OR slug = '';
ALTER TABLE public.empresa_config
  ALTER COLUMN slug SET DEFAULT substr(md5(random()::text || clock_timestamp()::text), 1, 10);
CREATE UNIQUE INDEX IF NOT EXISTS empresa_config_slug_uidx ON public.empresa_config (slug);

-- 2. Empresa pública por slug (una sola fila, mismas columnas que crm_empresas_publicas)
CREATE OR REPLACE FUNCTION public.crm_empresa_publica(p_slug text)
RETURNS TABLE (
  id integer, codigo text, nombre_comercial text, color text, logo_url text,
  whatsapp text, titulo text, mensaje text, mostrar_precios boolean,
  igv_incluido boolean, moneda_precio text, cuentas_bancarias jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.id, e.codigo::text, e.nombre_comercial::text, e.color::text, e.logo_url::text,
         c.whatsapp::text, c.titulo::text, c.mensaje, c.mostrar_precios,
         c.igv_incluido, c.moneda_precio::text, c.cuentas_bancarias
    FROM public.empresa_config e
    JOIN public.crm_config c ON c.empresa_id = e.id
   WHERE e.slug = p_slug
     AND length(coalesce(p_slug, '')) >= 6
     AND e.activo IS NOT FALSE
     AND EXISTS (SELECT 1 FROM public.crm_catalogo_config cc WHERE cc.empresa_id = e.id AND cc.publicado)
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.crm_empresa_publica(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.crm_empresa_publica(text) TO anon, authenticated, service_role;

-- 3. Cerrar la lista pública de empresas: solo personal logueado
REVOKE EXECUTE ON FUNCTION public.crm_empresas_publicas() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.crm_empresas_publicas() TO authenticated, service_role;

-- Control
SELECT id, codigo, slug FROM public.empresa_config ORDER BY id;
