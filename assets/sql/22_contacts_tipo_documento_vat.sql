-- ============================================================================
-- 22_contacts_tipo_documento_vat.sql
-- Fix: el formulario "Nuevo Proveedor" (compras.html) y "Costeo Importaciones"
-- tienen una opción 'VAT' en el select de Tipo Documento (para proveedores
-- extranjeros identificados por VAT number en vez de RUC/DNI/CE/Pasaporte),
-- pero la restricción CHECK de contacts.tipo_documento no la permitía:
-- cualquier intento de crear un proveedor con Tipo Documento = VAT fallaba
-- con 400 (check_violation) en el insert a `contacts`.
-- ============================================================================

ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_tipo_documento_check;

ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_tipo_documento_check
  CHECK (tipo_documento IN ('RUC','DNI','CE','pasaporte','otro','NN','VAT'));

-- Verificación
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.contacts'::regclass
  AND conname = 'contacts_tipo_documento_check';