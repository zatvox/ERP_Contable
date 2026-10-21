-- ============================================================================
-- 93_proveedor_no_domiciliado_y_campos_pi.sql  (2026-10-20)
--
-- Dos cosas, las dos salidas de mirar los datos reales:
--
-- 1. LA DETECCIÓN DE IMPORTACIONES ESTABA MAL PLANTEADA.
--    La vista del 92 detectaba por señales de la COMPRA (moneda, comprobante)
--    y eso marcaba 115 compras locales en USD como si fueran importaciones:
--    JAS IMPORT, LEONEL TEXTIL, AMITEX, YMB facturan en dólares y son de Lima.
--    La señal correcta es el PROVEEDOR: `contacts.pais` + `tipo_documento`.
--    Los 8 proveedores del exterior tienen tipo_documento 'VAT' u 'otro';
--    ninguno tiene RUC. Ningún proveedor peruano tiene VAT.
--    Ojo con `pais`: conviven 'PERU' y 'Perú', así que hay que normalizar
--    (mayúsculas + sin tilde) antes de comparar, o JAS IMPORT sale extranjero.
--
-- 2. CAMPOS QUE PIDE UNA PROFORMA INVOICE REAL.
--    Salieron de la PI Nytex NY 2491: puerto de DESTINO (Callao), tolerancia
--    de cantidad (±10%), plazo del anticipo (2 días desde la PI) y plazo de
--    embarque (20 días desde el anticipo). Los dos últimos permiten proyectar
--    cuándo debería zarpar y avisar si el anticipo está por vencer.
--
-- Aditivo. Idempotente. NO cambia datos: las correcciones van comentadas al
-- final para que las revises antes de aplicarlas.
-- ============================================================================
BEGIN;

-- ============================================================
-- 1. QUIÉN ES NO DOMICILIADO: una función, una sola verdad
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_pais_normalizado(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT upper(translate(COALESCE(p, ''), 'áéíóúÁÉÍÓÚàèìòùÀÈÌÒÙ', 'aeiouAEIOUaeiouAEIOU'));
$$;

COMMENT ON FUNCTION public.fn_pais_normalizado(text) IS
  'Normaliza el país para comparar: en contacts conviven "PERU" y "Perú". Sin esto, cualquier filtro por país da falsos positivos.';

CREATE OR REPLACE VIEW public.v_proveedores_exterior AS
SELECT
  c.id, c.nombre, c.pais, c.tipo_documento, c.nro_documento, c.activo,
  public.fn_pais_normalizado(c.pais) AS pais_norm,
  -- No domiciliado si no tiene documento peruano, o si el país no es Perú.
  -- La primera condición atrapa los casos con el país mal cargado.
  ( c.tipo_documento NOT IN ('RUC','DNI')
    OR public.fn_pais_normalizado(c.pais) NOT IN ('PERU','') ) AS no_domiciliado,
  (c.tipo_documento NOT IN ('RUC','DNI'))                            AS senal_documento,
  (public.fn_pais_normalizado(c.pais) NOT IN ('PERU',''))            AS senal_pais,
  -- Señales que NO coinciden entre sí: ahí hay un dato mal cargado
  ( (c.tipo_documento NOT IN ('RUC','DNI'))
    <> (public.fn_pais_normalizado(c.pais) NOT IN ('PERU','')) )     AS revisar
FROM public.contacts c
-- tipo_contacto es text[] desde el SQL 13; comparar sobre su representacion
-- de texto funciona igual para el array y para los valores legacy en varchar.
WHERE c.tipo_contacto::text ILIKE '%proveedor%'
   OR c.tipo_contacto::text ILIKE '%ambos%';

COMMENT ON VIEW public.v_proveedores_exterior IS
  'Proveedores con su condición de domicilio. revisar = true cuando el país y el tipo de documento se contradicen (ej. HANGZHOU ANDAO con país Perú y documento "otro"): ahí hay un dato que corregir.';

-- ============================================================
-- 2. LA VISTA DE COMPRAS, AHORA POR PROVEEDOR
-- ============================================================
CREATE VIEW public.v_compras_importacion AS
SELECT
  c.id,
  c.referencia,
  c.tipo_comprobante,
  c.serie,
  c.numero,
  NULLIF(TRIM(CONCAT_WS('-', c.serie, c.numero)), '') AS documento,
  c.fecha_emision,
  c.periodo_ano, c.periodo_mes,
  c.contact_id,
  c.proveedor_nombre,
  c.proveedor_ruc,
  ct.pais                            AS proveedor_pais,
  ct.tipo_documento                  AS proveedor_tipo_documento,
  c.proveedor_domiciliado,
  c.tipo_compra,
  c.currency,
  c.tipo_cambio,
  c.subtotal,
  c.igv_gravado,
  c.total,
  c.estado_pago,
  c.comprobante_anulado,
  c.orden_compra_id,
  c.carpeta_importacion_id,
  COALESCE(pe.no_domiciliado, false) AS proveedor_exterior,
  (c.tipo_compra = 'importacion')    AS senal_tipo_compra,
  (c.tipo_comprobante = '91')        AS senal_comprobante_exterior,
  (c.tipo_comprobante = '50')        AS senal_dua,
  c.empresa_id
FROM public.compras c
LEFT JOIN public.contacts ct               ON ct.id = c.contact_id
LEFT JOIN public.v_proveedores_exterior pe ON pe.id = c.contact_id
WHERE c.comprobante_anulado IS NOT TRUE
  AND ( COALESCE(pe.no_domiciliado, false)
     OR c.tipo_compra = 'importacion'
     OR c.tipo_comprobante IN ('91','50') );

COMMENT ON VIEW public.v_compras_importacion IS
  'Compras de importación: las de proveedor del exterior, más las marcadas como importación o con comprobante 91/50. Alimenta el buscador de "Nueva carpeta". senal_dua marca las DUAs: van al PDT 621 pero NO abren carpeta.';

GRANT SELECT ON public.v_proveedores_exterior TO authenticated;
GRANT SELECT ON public.v_compras_importacion  TO authenticated;

-- ============================================================
-- 3. CAMPOS QUE PIDE UNA PROFORMA INVOICE REAL
-- ============================================================
ALTER TABLE public.orden_compra
  ADD COLUMN IF NOT EXISTS puerto_destino        varchar,
  ADD COLUMN IF NOT EXISTS tolerancia_porcentaje numeric DEFAULT 10
    CHECK (tolerancia_porcentaje IS NULL OR (tolerancia_porcentaje >= 0 AND tolerancia_porcentaje <= 50)),
  ADD COLUMN IF NOT EXISTS dias_validez_anticipo integer,
  ADD COLUMN IF NOT EXISTS dias_embarque         integer,
  ADD COLUMN IF NOT EXISTS marca                 varchar;

COMMENT ON COLUMN public.orden_compra.tolerancia_porcentaje IS
  'Tolerancia de cantidad pactada (la PI Nytex dice ±10%). El Commercial Invoice casi nunca calza exacto con la Proforma: dentro de este margen no se avisa nada.';
COMMENT ON COLUMN public.orden_compra.dias_validez_anticipo IS
  'Días desde la fecha de la PI para pagar el anticipo (Nytex: 2). Sirve para avisar que está por vencer.';
COMMENT ON COLUMN public.orden_compra.dias_embarque IS
  'Días desde el anticipo hasta el embarque (Nytex: 20). Con la fecha del anticipo se proyecta cuándo debería zarpar.';

COMMIT;

-- ============================================================
-- 4. DIAGNÓSTICO — mirar antes de corregir nada
-- ============================================================
-- 4.1 · Proveedores y su condición de domicilio. revisar=true ⇒ dato a corregir
SELECT id, nombre, pais, tipo_documento, nro_documento,
       no_domiciliado, senal_documento, senal_pais, revisar
  FROM public.v_proveedores_exterior
 WHERE no_domiciliado OR revisar
 ORDER BY revisar DESC, nombre;

-- 4.2 · Cuántas compras quedan ahora como importación (antes salían 121)
SELECT COUNT(*) FILTER (WHERE proveedor_exterior)              AS por_proveedor_exterior,
       COUNT(*) FILTER (WHERE senal_dua)                        AS duas,
       COUNT(*) FILTER (WHERE NOT proveedor_exterior AND NOT senal_dua) AS otras,
       COUNT(*)                                                 AS total
  FROM public.v_compras_importacion;

-- 4.3 · El listado que va a ver el buscador de "Nueva carpeta"
SELECT documento, fecha_emision, proveedor_nombre, proveedor_pais,
       tipo_comprobante, currency, total, senal_dua, carpeta_importacion_id
  FROM public.v_compras_importacion
 WHERE NOT senal_dua
 ORDER BY fecha_emision DESC;

-- ============================================================
-- 5. CORRECCIONES DE DATOS — revisar la 4.1 y recién entonces descomentar
-- ============================================================
-- 5.1 · Normalizar el país (conviven 'PERU' y 'Perú')
-- UPDATE public.contacts SET pais = 'Perú'
--  WHERE public.fn_pais_normalizado(pais) = 'PERU' AND pais <> 'Perú';

-- 5.2 · HANGZHOU ANDAO TEXTILE CO LTD figura con país Perú y es de China
-- UPDATE public.contacts SET pais = 'China' WHERE id = 283;

-- 5.3 · Sincronizar compras.proveedor_domiciliado con el proveedor real
--       (hoy está en true para todos, incluidos los 8 del exterior)
-- UPDATE public.compras c SET proveedor_domiciliado = false
--   FROM public.v_proveedores_exterior pe
--  WHERE pe.id = c.contact_id AND pe.no_domiciliado
--    AND c.proveedor_domiciliado IS DISTINCT FROM false;
