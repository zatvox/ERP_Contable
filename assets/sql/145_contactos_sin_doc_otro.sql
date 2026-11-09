-- ============================================================================
-- 145 · Contactos: prohibido el tipo de documento "Otro" y los N° de relleno
-- (0000…, 9999…) — 2026-11-07
--
-- NOT VALID = no revisa los contactos ya existentes (no falla al correr),
-- pero SÍ bloquea toda alta nueva y toda edición de un contacto que siga
-- teniendo esos datos: al editarlo hay que poner su documento real.
-- Contactos internos sin documento (tipo y N° vacíos, ej. empleados) siguen
-- permitidos.
-- ============================================================================
DO $$
BEGIN
  ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_doc_valido_check;
  ALTER TABLE public.contacts ADD CONSTRAINT contacts_doc_valido_check
    CHECK (
      lower(coalesce(tipo_documento, '')) <> 'otro'
      AND coalesce(btrim(nro_documento), '') !~ '^(0+|9+)$'
    ) NOT VALID;
END $$;

-- Para ubicar los que hay que corregir (no modifica nada):
SELECT id, nombre, tipo_documento, nro_documento, tipo_contacto
FROM public.contacts
WHERE lower(coalesce(tipo_documento, '')) = 'otro'
   OR coalesce(btrim(nro_documento), '') ~ '^(0+|9+)$'
ORDER BY nombre;

-- Revertir: ALTER TABLE public.contacts DROP CONSTRAINT contacts_doc_valido_check;
