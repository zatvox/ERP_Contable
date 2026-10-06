-- ============================================================================
-- 60_ADJUNTOS_COBROS_PAGOS.SQL  (2026-10-01, v2)
-- ============================================================================
-- Archivos adjuntos (voucher / recibo / otro) de cobros, pagos y letras.
--   • El ARCHIVO vive en Supabase Storage, bucket privado `tesoreria-adjuntos`.
--   • Sus DATOS (a qué registro pertenece, concepto, nombre, tamaño, quién lo
--     subió) viven en la tabla `adjuntos`, una fila por archivo → un cobro
--     puede tener varios archivos, cada uno con su etiqueta.
-- Tabla genérica (entidad + entidad_id) para reutilizarla luego en letras,
-- compras, ventas, etc. sin crear columnas nuevas en cada tabla.
-- Idempotente. Reemplaza a la v1 de este script (columnas adjunto_url en
-- cobros/pagos): si ya la corriste, esas columnas quedan sin uso.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.adjuntos (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entidad     varchar NOT NULL CHECK (entidad IN ('cobro', 'pago', 'letra')),
  entidad_id  bigint  NOT NULL,
  concepto    varchar NOT NULL DEFAULT 'voucher' CHECK (concepto IN ('voucher', 'recibo', 'otro')),
  nombre      text    NOT NULL,          -- nombre original del archivo
  path        text    NOT NULL UNIQUE,   -- ruta dentro del bucket (no URL pública)
  mime        varchar,
  tamano      bigint,
  created_by  bigint REFERENCES public.users(id),
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_adjuntos_entidad ON public.adjuntos(entidad, entidad_id);

COMMENT ON TABLE public.adjuntos IS
  'Metadatos de archivos adjuntos (voucher/recibo/otro) de cobros, pagos y letras. El archivo está en el bucket tesoreria-adjuntos.';

ALTER TABLE public.adjuntos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS adjuntos_all_auth ON public.adjuntos;
CREATE POLICY adjuntos_all_auth ON public.adjuntos FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.adjuntos TO authenticated;

COMMIT;

-- ── Bucket privado ───────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('tesoreria-adjuntos', 'tesoreria-adjuntos', false, 10485760,
        ARRAY['application/pdf','image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "tesoreria_adjuntos_select" ON storage.objects;
CREATE POLICY "tesoreria_adjuntos_select" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'tesoreria-adjuntos');
DROP POLICY IF EXISTS "tesoreria_adjuntos_insert" ON storage.objects;
CREATE POLICY "tesoreria_adjuntos_insert" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'tesoreria-adjuntos');
DROP POLICY IF EXISTS "tesoreria_adjuntos_update" ON storage.objects;
CREATE POLICY "tesoreria_adjuntos_update" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'tesoreria-adjuntos');
DROP POLICY IF EXISTS "tesoreria_adjuntos_delete" ON storage.objects;
CREATE POLICY "tesoreria_adjuntos_delete" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'tesoreria-adjuntos');

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN: 1 bucket + la tabla con 0 filas
-- ════════════════════════════════════════════════════════════════════════════
SELECT id, public, file_size_limit FROM storage.buckets WHERE id = 'tesoreria-adjuntos';
SELECT count(*) AS adjuntos FROM public.adjuntos;
