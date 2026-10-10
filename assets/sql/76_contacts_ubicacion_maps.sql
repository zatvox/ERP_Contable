-- ============================================================================
-- 76 — contacts.ubicacion_maps (2026-10-07)
-- Enlace de Google Maps (o coordenadas convertidas a link) de la dirección
-- del contacto. Lo llena el modal único "Nuevo contacto" (shared/contacto-modal.js)
-- y se muestra en la tabla de Clientes / Proveedores como columna "Ubicación".
-- ============================================================================
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS ubicacion_maps text;
COMMENT ON COLUMN public.contacts.ubicacion_maps IS 'URL de Google Maps de la ubicación del contacto (opcional).';

-- Verificación
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'ubicacion_maps';
