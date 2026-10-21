-- ============================================================================
-- 91_enlaces_compra_oc_carpeta.sql  (2026-10-20)
--
-- PROBLEMA QUE RESUELVE
-- Hoy no hay forma de enlazar los tres documentos del mismo negocio:
--   · `compras` no tiene `orden_compra_id`  → una compra no sabe de qué OC viene
--   · `compras` no tiene `carpeta_importacion_id` → una compra de importación no
--     sabe a qué carpeta pertenece, así que la carpeta no puede nacer de ella
--   · `orden_compra` no tiene nada que diga "esta OC es una importación"
--
-- Y la OC NO es obligatoria: lo común con proveedores de confianza es la compra
-- directa, y recién después se genera la OC a partir de la factura. Por eso los
-- enlaces son NULLABLE en los dos sentidos: compra sin OC, OC sin compra,
-- compra sin carpeta. Ninguno obliga al otro.
--
-- Puramente aditivo. Idempotente. No toca datos existentes.
-- ============================================================================
BEGIN;

-- ============================================================
-- 1. COMPRAS ↔ OC ↔ CARPETA
-- ============================================================
ALTER TABLE public.compras
  ADD COLUMN IF NOT EXISTS orden_compra_id        bigint REFERENCES public.orden_compra(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS carpeta_importacion_id bigint REFERENCES public.carpetas_importacion(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_compras_oc      ON public.compras(orden_compra_id);
CREATE INDEX IF NOT EXISTS idx_compras_carpeta ON public.compras(carpeta_importacion_id);

COMMENT ON COLUMN public.compras.orden_compra_id IS
  'OC de origen, si la hay. NULLABLE a propósito: la compra directa es lo común y la OC puede generarse DESPUÉS a partir de la factura del proveedor.';
COMMENT ON COLUMN public.compras.carpeta_importacion_id IS
  'Carpeta de importación a la que pertenece esta compra (factura del exterior, DUA, factura del agente). Varias compras pueden apuntar a la misma carpeta.';

-- ============================================================
-- 2. LA OC PUEDE SER UNA PROFORMA INVOICE
-- ============================================================
ALTER TABLE public.orden_compra
  ADD COLUMN IF NOT EXISTS es_importacion            boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS numero_proforma_proveedor varchar,
  ADD COLUMN IF NOT EXISTS incoterm                  varchar,
  ADD COLUMN IF NOT EXISTS puerto_embarque           varchar,
  ADD COLUMN IF NOT EXISTS pais_origen               varchar,
  ADD COLUMN IF NOT EXISTS flete_estimado            numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS seguro_estimado           numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS anticipo_porcentaje       numeric DEFAULT 20
    CHECK (anticipo_porcentaje IS NULL OR (anticipo_porcentaje >= 0 AND anticipo_porcentaje <= 100)),
  ADD COLUMN IF NOT EXISTS carpeta_importacion_id    bigint REFERENCES public.carpetas_importacion(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_oc_importacion ON public.orden_compra(es_importacion) WHERE es_importacion;
CREATE INDEX IF NOT EXISTS idx_oc_carpeta     ON public.orden_compra(carpeta_importacion_id);

COMMENT ON COLUMN public.orden_compra.es_importacion IS
  'true = esta OC es una Proforma Invoice: activa incoterm, puerto, país, flete/seguro estimados y el % de anticipo, y puede abrir una carpeta de importación.';
COMMENT ON COLUMN public.orden_compra.numero_proforma_proveedor IS
  'El número que pone el proveedor del exterior (ej. HY5012-26-1). Distinto del número propio de la OC.';

-- Peso y partida en las líneas: sin esto el prorrateo por peso no tiene base
ALTER TABLE public.detalle_orden_compra
  ADD COLUMN IF NOT EXISTS peso_neto           numeric,
  ADD COLUMN IF NOT EXISTS peso_bruto          numeric,
  ADD COLUMN IF NOT EXISTS bultos              integer,
  ADD COLUMN IF NOT EXISTS partida_arancelaria varchar;

-- ============================================================
-- 3. LA CARPETA RECUERDA DE DÓNDE NACIÓ
-- ============================================================
ALTER TABLE public.carpetas_importacion
  ADD COLUMN IF NOT EXISTS origen           varchar NOT NULL DEFAULT 'manual'
    CHECK (origen IN ('manual','compra','orden_compra')),
  ADD COLUMN IF NOT EXISTS compra_origen_id bigint REFERENCES public.compras(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS orden_compra_id  bigint REFERENCES public.orden_compra(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.carpetas_importacion.origen IS
  'De dónde nació la carpeta: manual, desde una compra ya registrada, o desde una OC-Proforma.';

COMMIT;

-- ============================================================
-- 4. VISTA: COMPRAS CANDIDATAS A SER UNA IMPORTACIÓN
-- ============================================================
-- Hoy ninguna compra tiene marca de importación, así que se detectan por
-- señales: tipo_compra, comprobante del exterior, proveedor no domiciliado o
-- moneda extranjera. La vista ordena por cuántas señales cumple.
CREATE OR REPLACE VIEW public.v_compras_importacion AS
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
  (c.tipo_compra = 'importacion')      AS senal_tipo_compra,
  (c.tipo_comprobante = '91')          AS senal_comprobante_exterior,
  (c.tipo_comprobante = '50')          AS senal_dua,
  (c.proveedor_domiciliado IS FALSE)   AS senal_no_domiciliado,
  (c.currency <> 'PEN')                AS senal_moneda_extranjera,
  ( (c.tipo_compra = 'importacion')::int
  + (c.tipo_comprobante = '91')::int
  + (c.proveedor_domiciliado IS FALSE)::int
  + (c.currency <> 'PEN')::int )       AS senales,
  c.empresa_id
FROM public.compras c
WHERE c.comprobante_anulado IS NOT TRUE
  AND ( c.tipo_compra = 'importacion'
     OR c.tipo_comprobante IN ('91','50')
     OR c.proveedor_domiciliado IS FALSE
     OR c.currency <> 'PEN' );

COMMENT ON VIEW public.v_compras_importacion IS
  'Compras que parecen de importación, detectadas por señales (tipo_compra, comprobante 91/50, proveedor no domiciliado, moneda extranjera). Alimenta el buscador de "Nueva carpeta de importación". senal_dua marca las DUAs: sirven para el PDT 621 pero NO deben abrir carpeta.';

GRANT SELECT ON public.v_compras_importacion TO authenticated;

-- ============================================================
-- 5. VERIFICACIÓN
-- ============================================================
-- 5.1 · Columnas nuevas (deben salir 15)
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND ( (table_name = 'compras'               AND column_name IN ('orden_compra_id','carpeta_importacion_id'))
      OR (table_name = 'orden_compra'          AND column_name IN ('es_importacion','numero_proforma_proveedor','incoterm','puerto_embarque','pais_origen','flete_estimado','seguro_estimado','anticipo_porcentaje','carpeta_importacion_id'))
      OR (table_name = 'detalle_orden_compra'  AND column_name IN ('peso_neto','peso_bruto','bultos','partida_arancelaria'))
      OR (table_name = 'carpetas_importacion'  AND column_name IN ('origen','compra_origen_id','orden_compra_id')) )
 ORDER BY table_name, column_name;

-- 5.2 · Tus compras que parecen importación, con sus señales
SELECT documento, fecha_emision, proveedor_nombre, tipo_compra, tipo_comprobante,
       currency, total, senales, senal_dua, carpeta_importacion_id
  FROM public.v_compras_importacion
 ORDER BY senales DESC, fecha_emision DESC;

-- 5.3 · Resumen: cuántas hay de cada tipo
SELECT tipo_compra, tipo_comprobante, currency,
       COUNT(*) AS compras, SUM(total) AS total
  FROM public.v_compras_importacion
 GROUP BY tipo_compra, tipo_comprobante, currency
 ORDER BY compras DESC;
