-- ============================================================================
-- 65 · Corrección puntual: BBOL-00000041 se guardó como Factura (tipo 01)
-- (2026-10-02). Pasa a Boleta (tipo 03) en la venta y en su asiento.
-- Correr por bloques. Si el bloque 1 muestra cpe_estado = 'aceptado' o
-- 'enviando', DETENERSE y avisar (ya salió a SUNAT/NUBEFACT).
-- ============================================================================

-- 1) DIAGNÓSTICO
SELECT v.id, v.serie, v.correlativo, v.tipo_comprobante, v.cpe_estado, v.estado,
       v.total, v.contact_id, c.nombre, c.tipo_documento, c.nro_documento
FROM public.ventas v
LEFT JOIN public.contacts c ON c.id = v.contact_id
WHERE v.serie = 'BBOL' AND NULLIF(regexp_replace(v.correlativo::text, '\D', '', 'g'), '')::int = 41;

-- Asientos ligados (por número del comprobante)
SELECT id, numero, tipo_movimiento, tipo_documento, documento_referencia, descripcion
FROM public.journal_entries
WHERE documento_referencia ILIKE 'BBOL-%41' OR descripcion ILIKE '%BBOL-%41%';

-- 2) BACKUP
CREATE TABLE IF NOT EXISTS _bk_fix_bbol41_20261002 AS
SELECT * FROM public.ventas
WHERE serie = 'BBOL' AND NULLIF(regexp_replace(correlativo::text, '\D', '', 'g'), '')::int = 41;

-- 3) CORRECCIÓN
BEGIN;
  UPDATE public.ventas
     SET tipo_comprobante = '03'
   WHERE serie = 'BBOL' AND NULLIF(regexp_replace(correlativo::text, '\D', '', 'g'), '')::int = 41
     AND tipo_comprobante = '01'
     AND COALESCE(cpe_estado, 'no_enviado') NOT IN ('aceptado', 'enviando');

  UPDATE public.journal_entries
     SET tipo_documento = '03',
         descripcion = replace(descripcion, '— Factura', '— Boleta')
   WHERE (documento_referencia ILIKE 'BBOL-%41' OR descripcion ILIKE '%BBOL-%41%')
     AND tipo_documento = '01';
COMMIT;

-- 4) VERIFICACIÓN (debe salir tipo_comprobante = 03)
SELECT id, serie, correlativo, tipo_comprobante, cpe_estado FROM public.ventas
WHERE serie = 'BBOL' AND NULLIF(regexp_replace(correlativo::text, '\D', '', 'g'), '')::int = 41;

-- 5) Control general: ¿hay más ventas con serie de otro tipo?
SELECT v.id, v.serie, v.correlativo, v.tipo_comprobante AS tipo_venta, s.tipo_documento AS tipo_de_la_serie
FROM public.ventas v
JOIN public.series_documentos s ON s.serie = v.serie
WHERE s.tipo_documento IN ('01','03') AND v.tipo_comprobante IN ('01','03')
  AND v.tipo_comprobante <> s.tipo_documento;
