-- 106_adjuntos_conceptos_aduana.sql (2026-10-26) — ADITIVO e idempotente.
-- 1) Adjuntos: el CHECK de `concepto` no aceptaba los documentos nuevos de Aduanas
--    (DAM completa, Notificación de duda razonable, Orden de depósito de garantía).
--    Sin esto, subir esos PDF falla con «no se pudo registrar».
-- 2) Ajustes de valor: el N° de liquidación pasa a ser opcional, para poder registrar
--    primero la NOTIFICACIÓN y luego completar la liquidación de cobranza.
BEGIN;

ALTER TABLE public.adjuntos DROP CONSTRAINT IF EXISTS adjuntos_concepto_check;
ALTER TABLE public.adjuntos ADD CONSTRAINT adjuntos_concepto_check
  CHECK (concepto IN ('voucher','recibo','dietario','otro','swift','correo','certificado_origen','ficha_tecnica','contrato',
                      'proforma','invoice','bl','packing','poliza','dam','autoliquidacion','boletin',
                      'notificacion_aduana','garantia','dam_completa','liquidacion','factura_gasto','rh','guia'));

ALTER TABLE public.dam_autoliquidaciones ALTER COLUMN numero DROP NOT NULL;

COMMIT;

-- VERIFICACIÓN (debe salir la lista con notificacion_aduana, garantia y dam_completa)
SELECT pg_get_constraintdef(oid) AS check_concepto FROM pg_constraint WHERE conname = 'adjuntos_concepto_check';
