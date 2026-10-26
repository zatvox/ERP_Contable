-- ============================================================================
-- 102_adjuntos_concepto_correo.sql  (2026-10-24)
-- Nuevo tipo de adjunto 'correo' (Correo de confirmación del pago / del
-- proveedor). Un mismo pago al exterior lleva varios documentos: constancia
-- de transferencia, mensaje SWIFT y el correo que lo confirma.
-- Lista completa = la del SQL 94 + 'correo'.
-- Además el bucket 'tesoreria-adjuntos' deja de restringir el tipo de archivo
-- (antes solo PDF/JPG/PNG/WEBP): ahora acepta cualquiera (Excel, .eml, .msg, zip...).
-- El límite de 10 MB se mantiene. Aditivo e idempotente. No toca datos.
-- ============================================================================
BEGIN;

ALTER TABLE public.adjuntos DROP CONSTRAINT IF EXISTS adjuntos_concepto_check;
ALTER TABLE public.adjuntos ADD CONSTRAINT adjuntos_concepto_check
  CHECK (concepto IN ('voucher','recibo','dietario','otro',
                      'invoice','proforma','bl','dam','liquidacion','autoliquidacion',
                      'factura_gasto','rh','poliza','packing','boletin','guia',
                      'swift','contrato','correo'));

UPDATE storage.buckets SET allowed_mime_types = NULL WHERE id = 'tesoreria-adjuntos';

COMMIT;

-- VERIFICACIÓN 1 (debe salir 1 fila con 'correo' dentro de la definición)
SELECT conname, pg_get_constraintdef(oid) AS definicion
  FROM pg_constraint
 WHERE conrelid = 'public.adjuntos'::regclass AND conname = 'adjuntos_concepto_check';

-- VERIFICACIÓN 2 (allowed_mime_types debe salir NULL = cualquier tipo)
SELECT id, allowed_mime_types, file_size_limit FROM storage.buckets WHERE id = 'tesoreria-adjuntos';
