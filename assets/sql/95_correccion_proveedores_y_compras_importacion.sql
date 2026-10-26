-- ============================================================================
-- 95_correccion_proveedores_y_compras_importacion.sql  (2026-10-21)
--
-- CORRIGE DATOS EXISTENTES. No crea importaciones, OC ni carpetas: eso lo haces
-- tú desde el sistema.
--
-- Qué arregla (salió de tus consultas 4.1 y 4.3 del SQL 93):
--   A. v_proveedores_exterior marcaba como "no domiciliado" a PROVEEDORES VARIOS
--      (documento NN). Un documento NN, CE o PAS no es señal de proveedor
--      del exterior.
--   B. Proveedores: HANGZHOU ANDAO figuraba con país Perú (es de China);
--      TRANS POWER (China) tenía tipo de documento DNI; conviven 'PERU' y 'Perú'.
--   C. Las 21 compras de proveedores del exterior:
--        · 17 estaban como comprobante '01' (factura nacional) → '91'
--        · proveedor_domiciliado → false
--        · líneas sin IGV marcadas 'gravada'/'exonerada' → 'no_gravada'
--
-- NO toca: tipo_compra (la guía de ingreso depende de él), las bases del
-- encabezado (base_imponible_*) ni los asientos. El PDT 621 ya trata estas
-- compras como "exterior" por proveedor, así que no cambia su resultado.
--
-- SEGURIDAD: antes de cambiar nada copia el estado original a
-- zz_respaldo_95_*; el rollback está al final, comentado. Todo va en una sola
-- transacción: si algo falla, no queda nada a medias.
-- ============================================================================
BEGIN;

-- ============================================================
-- A. Quién es proveedor del exterior (mismas columnas que en el 93)
-- ============================================================
CREATE OR REPLACE VIEW public.v_proveedores_exterior AS
SELECT
  c.id, c.nombre, c.pais, c.tipo_documento, c.nro_documento, c.activo,
  public.fn_pais_normalizado(c.pais) AS pais_norm,
  ( c.tipo_documento NOT IN ('RUC','DNI','CE','PAS','NN')
    OR public.fn_pais_normalizado(c.pais) NOT IN ('PERU','') ) AS no_domiciliado,
  (c.tipo_documento NOT IN ('RUC','DNI','CE','PAS','NN'))       AS senal_documento,
  (public.fn_pais_normalizado(c.pais) NOT IN ('PERU',''))       AS senal_pais,
  ( (c.tipo_documento NOT IN ('RUC','DNI','CE','PAS','NN'))
    <> (public.fn_pais_normalizado(c.pais) NOT IN ('PERU','')) ) AS revisar
FROM public.contacts c
WHERE c.tipo_contacto::text ILIKE '%proveedor%'
   OR c.tipo_contacto::text ILIKE '%ambos%';

-- ============================================================
-- B. Proveedores
-- ============================================================
UPDATE public.contacts SET pais = 'Perú'
 WHERE public.fn_pais_normalizado(pais) = 'PERU' AND pais <> 'Perú';

UPDATE public.contacts SET pais = 'China'
 WHERE id = 283 AND nombre ILIKE 'HANGZHOU ANDAO%';

UPDATE public.contacts SET tipo_documento = 'otro'
 WHERE id = 582 AND nombre ILIKE 'TRANS POWER%' AND tipo_documento = 'DNI';

-- ============================================================
-- C. Compras de proveedores del exterior
-- ============================================================
CREATE TABLE IF NOT EXISTS public.zz_respaldo_95_compras (
  respaldo_id               bigserial PRIMARY KEY,
  respaldado_en             timestamptz DEFAULT now(),
  compra_id                 bigint NOT NULL,
  tipo_comprobante          varchar,
  proveedor_domiciliado     boolean,
  UNIQUE (compra_id)
);
CREATE TABLE IF NOT EXISTS public.zz_respaldo_95_detalle (
  respaldo_id   bigserial PRIMARY KEY,
  respaldado_en timestamptz DEFAULT now(),
  detalle_id    bigint NOT NULL,
  compra_id     bigint NOT NULL,
  tipo_base     varchar,
  UNIQUE (detalle_id)
);

-- Las compras a corregir: proveedor del exterior, no anuladas, factura o invoice.
-- (Sin tabla temporal: el editor de Supabase puede ejecutar en autocommit y
-- una TEMP ... ON COMMIT DROP desaparece entre sentencias.)

-- Respaldo del estado original (una sola vez por fila)
INSERT INTO public.zz_respaldo_95_compras (compra_id, tipo_comprobante, proveedor_domiciliado)
SELECT c.id, c.tipo_comprobante, c.proveedor_domiciliado
  FROM public.compras c
 WHERE c.id IN (SELECT c2.id FROM public.compras c2
             JOIN public.v_proveedores_exterior pe ON pe.id = c2.contact_id
            WHERE pe.no_domiciliado
              AND c2.comprobante_anulado IS NOT TRUE
              AND c2.tipo_comprobante IN ('01','91'))
   AND (c.tipo_comprobante <> '91' OR c.proveedor_domiciliado IS DISTINCT FROM false)
ON CONFLICT (compra_id) DO NOTHING;

INSERT INTO public.zz_respaldo_95_detalle (detalle_id, compra_id, tipo_base)
SELECT d.id, d.compra_id, d.tipo_base
  FROM public.detalle_compras d
 WHERE d.compra_id IN (SELECT c2.id FROM public.compras c2
             JOIN public.v_proveedores_exterior pe ON pe.id = c2.contact_id
            WHERE pe.no_domiciliado
              AND c2.comprobante_anulado IS NOT TRUE
              AND c2.tipo_comprobante IN ('01','91'))
   AND COALESCE(d.igv_monto, 0) = 0 AND d.tipo_base IN ('gravada','exonerada')
ON CONFLICT (detalle_id) DO NOTHING;

UPDATE public.compras c
   SET tipo_comprobante = '91',
       proveedor_domiciliado = false
 WHERE c.id IN (SELECT c2.id FROM public.compras c2
             JOIN public.v_proveedores_exterior pe ON pe.id = c2.contact_id
            WHERE pe.no_domiciliado
              AND c2.comprobante_anulado IS NOT TRUE
              AND c2.tipo_comprobante IN ('01','91'))
   AND (c.tipo_comprobante <> '91' OR c.proveedor_domiciliado IS DISTINCT FROM false);

UPDATE public.detalle_compras d
   SET tipo_base = 'no_gravada'
 WHERE d.compra_id IN (SELECT c2.id FROM public.compras c2
             JOIN public.v_proveedores_exterior pe ON pe.id = c2.contact_id
            WHERE pe.no_domiciliado
              AND c2.comprobante_anulado IS NOT TRUE
              AND c2.tipo_comprobante IN ('01','91'))
   AND COALESCE(d.igv_monto, 0) = 0
   AND d.tipo_base IN ('gravada','exonerada');

COMMIT;

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================
-- 1 · Las compras del exterior ya clasificadas (deben ser 21, todas 91 / no domiciliado)
SELECT c.tipo_comprobante,
       c.proveedor_domiciliado,
       COUNT(*)                         AS compras,
       COUNT(*) FILTER (WHERE c.igv_gravado > 0) AS con_igv_a_revisar
  FROM public.v_compras_importacion v
  JOIN public.compras c ON c.id = v.id
 GROUP BY 1, 2
 ORDER BY 1, 2;

-- 2 · Líneas de esas compras por tipo de base (no debe quedar 'gravada' sin IGV)
SELECT d.tipo_base, COUNT(*) AS lineas, ROUND(SUM(d.igv_monto), 2) AS igv
  FROM public.detalle_compras d
  JOIN public.v_compras_importacion v ON v.id = d.compra_id
 GROUP BY 1
 ORDER BY 1;

-- 3 · Proveedores con datos contradictorios (ya no deben salir Hangzhou ni Trans Power)
SELECT id, nombre, pais, tipo_documento, no_domiciliado, revisar
  FROM public.v_proveedores_exterior
 WHERE revisar
 ORDER BY nombre;

-- 4 · Qué cambió exactamente (compra por compra, antes → después)
SELECT c.referencia, r.tipo_comprobante AS antes, c.tipo_comprobante AS ahora,
       r.proveedor_domiciliado AS domiciliado_antes, c.proveedor_domiciliado AS domiciliado_ahora
  FROM public.zz_respaldo_95_compras r
  JOIN public.compras c ON c.id = r.compra_id
 ORDER BY c.fecha_emision DESC;

-- ============================================================================
-- ROLLBACK — solo si quieres volver atrás (descomenta y corre)
-- ============================================================================
-- BEGIN;
-- UPDATE public.compras c SET tipo_comprobante = r.tipo_comprobante,
--        proveedor_domiciliado = r.proveedor_domiciliado
--   FROM public.zz_respaldo_95_compras r WHERE r.compra_id = c.id;
-- UPDATE public.detalle_compras d SET tipo_base = r.tipo_base
--   FROM public.zz_respaldo_95_detalle r WHERE r.detalle_id = d.id;
-- COMMIT;
