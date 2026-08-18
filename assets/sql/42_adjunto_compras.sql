-- ============================================================================
-- 42_ADJUNTO_COMPRAS.SQL
-- ============================================================================
-- Adjunto de factura (PDF/JPEG) por compra — 1 archivo por compra. Pensado
-- para el caso de la comisión bancaria de letras (Etapa B): se registra la
-- Compra de Servicio de inmediato, pero la factura física del banco llega
-- después; con esto se puede subir/reemplazar el documento cuando llegue y
-- confirmar a mano. Sirve para cualquier compra, no solo esa.
--
-- No hay uso previo de Supabase Storage en todo el sistema, así que este
-- script también crea el bucket. Privado (no público): se sirve con signed
-- URL desde la app, igual de accesible para cualquier usuario logueado pero
-- sin exponer las facturas por URL pública indexable.
--
-- Idempotente.
-- ============================================================================

BEGIN;

ALTER TABLE public.compras
  ADD COLUMN IF NOT EXISTS adjunto_url    text,   -- path dentro del bucket, no URL pública
  ADD COLUMN IF NOT EXISTS adjunto_nombre text;   -- nombre original del archivo, para mostrarlo

COMMENT ON COLUMN public.compras.adjunto_url IS
  'Path del archivo (PDF/JPEG) dentro del bucket compras-adjuntos. NULL si la compra no tiene documento adjunto. Se resuelve a URL firmada temporal en el cliente, nunca se expone pública.';

COMMIT;

-- ── Bucket de Storage ────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('compras-adjuntos', 'compras-adjuntos', false, 10485760, ARRAY['application/pdf','image/jpeg','image/png'])
ON CONFLICT (id) DO NOTHING;

-- ── RLS sobre storage.objects para este bucket ─────────────────────────────
-- Mismo criterio que el resto de las tablas del sistema: cualquier usuario
-- autenticado puede leer/escribir (no hay roles diferenciados todavía).
DROP POLICY IF EXISTS "compras_adjuntos_select" ON storage.objects;
CREATE POLICY "compras_adjuntos_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'compras-adjuntos');

DROP POLICY IF EXISTS "compras_adjuntos_insert" ON storage.objects;
CREATE POLICY "compras_adjuntos_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'compras-adjuntos');

DROP POLICY IF EXISTS "compras_adjuntos_update" ON storage.objects;
CREATE POLICY "compras_adjuntos_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'compras-adjuntos');

DROP POLICY IF EXISTS "compras_adjuntos_delete" ON storage.objects;
CREATE POLICY "compras_adjuntos_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'compras-adjuntos');

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
-- SELECT id, name, public FROM storage.buckets WHERE id = 'compras-adjuntos';
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'compras' AND column_name LIKE 'adjunto%';
