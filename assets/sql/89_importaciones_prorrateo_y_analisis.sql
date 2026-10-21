-- ============================================================================
-- 89_importaciones_prorrateo_y_analisis.sql  (2026-10-20)
-- FASE C del módulo de Importaciones: el prorrateo que convierte el ledger en
-- costo POR ARTÍCULO, y el "Análisis general" con el formato del Excel de
-- Jhiro & Benji (estado de contenedores + antigüedad).
--
-- ⚠️ ESTE SCRIPT ES PURAMENTE ADITIVO. No toca nada del 86, 87 ni 88:
--    · NO recrea v_importacion_costos / v_importacion_doc_cuadre /
--      v_importacion_resumen — la PARTE 8.5 del SQL 87 ya las dejó con
--      empresa_id como última columna. Se usan tal como están.
--    · NO toca índices ni triggers. El 87 ya cambió el índice único de
--      documentos_importacion a (empresa_id, proveedor, serie, número) y
--      agregó trg_mx_impcosto_coherente; ambos siguen vigentes.
--    · Solo agrega 2 columnas, 1 parámetro y 3 vistas nuevas.
--
-- Requiere 86 y 87 ejecutados (en ese orden). Idempotente.
--
-- Qué agrega:
--
--   1. v_importacion_costo_detalle — reparte cada línea del ledger entre las
--      líneas de la Commercial Invoice según su base_prorrateo:
--        directo    → 100% a la línea que dice detalle_ci_id
--        valor_fob  → proporcional al FOB de la línea   (tributos, comisiones %)
--        peso_neto / peso_bruto → proporcional al peso  (flete, almacén, estiba)
--        bultos     → proporcional a los bultos
--      Resultado: costo contable (NIC 2) y costo de gestión por kg y por línea.
--      Es de SOLO LECTURA: la Fase D lo persistirá en lotes.costo_unitario y
--      lotes.costo_real. Hoy se puede mirar sin tocar inventario ni kardex.
--
--   2. v_importacion_prorrateo_cuadre — control: lo repartido tiene que ser
--      igual al costo del ledger.
--
--   3. v_importacion_analisis_general — una fila por artículo con las columnas
--      del Excel: COSTO · % UTILIDAD · UTI POR KG · VALOR VENTA · PRECIO ·
--      STOCK · UTILIDAD REC. · VENTA, más ETA/DÍAS/MES para la antigüedad.
--      Fórmulas del Excel (margen SOBRE LA VENTA):
--        uti_kg      = costo_kg × m / (1 − m)
--        valor_venta = costo_kg / (1 − m)
--        precio      = valor_venta × (1 + IGV)
--      Verificado contra la hoja: 1.774546 × 0.13 / 0.87 = 0.265162 ✔
-- ============================================================================
BEGIN;

-- ============================================================
-- 1. COLUMNAS NUEVAS
-- ============================================================
-- El % de utilidad del Excel es por artículo y se fija a mano (va de 5% a 30%
-- según el hilo). Vive en la línea de la CI, no en un parámetro global.
ALTER TABLE public.detalle_comercial_invoice
  ADD COLUMN IF NOT EXISTS margen_objetivo numeric
    CHECK (margen_objetivo IS NULL OR (margen_objetivo >= 0 AND margen_objetivo < 1));

COMMENT ON COLUMN public.detalle_comercial_invoice.margen_objetivo IS
  'Margen objetivo SOBRE LA VENTA (0.13 = 13%), como la columna "% UTILIDAD" del Excel de análisis general. NULL = usa el parámetro margen_objetivo_default.';

-- La columna "CONT." del Excel es el contador propio de Luis (1.1, 2.0, 5.2),
-- no el número de contenedor de la naviera.
ALTER TABLE public.contenedores
  ADD COLUMN IF NOT EXISTS etiqueta varchar;

-- lotes.costo_real: lo define el SQL 81, que NO se habia corrido en este
-- proyecto (de ahi el error "column l.costo_real does not exist"). Se agrega
-- aqui con la misma definicion, idempotente: si el 81 ya corrio, no hace nada.
-- Es la columna donde la Fase D escribira el costo de gestion por kg.
ALTER TABLE public.lotes
  ADD COLUMN IF NOT EXISTS costo_real numeric CHECK (costo_real IS NULL OR costo_real > 0);
ALTER TABLE public.lotes
  ADD COLUMN IF NOT EXISTS costo_real_actualizado_at timestamptz;
COMMENT ON COLUMN public.lotes.costo_real IS
  'Costo real por unidad en moneda original del lote = CIF + costos de destino. Manual hoy; luego desde Importaciones (Fase D).';

COMMENT ON COLUMN public.contenedores.etiqueta IS
  'Etiqueta corta del contenedor para reportes gerenciales (ej. "1.1", "5.2") — la columna CONT. del Excel de análisis general. Si está vacía se muestra el número de la naviera.';

-- El parametro 'margen_objetivo_default' lo siembra el SQL 90: importacion_parametros
-- tiene empresa_id NOT NULL (SQL 87) y su UNIQUE seguia siendo por clave sola, asi
-- que hay que arreglar el indice y sembrar una fila POR EMPRESA. Corre 89 y luego 90.

-- ============================================================
-- 2. PRORRATEO: el ledger repartido por línea de la CI
-- ============================================================
CREATE OR REPLACE VIEW public.v_importacion_costo_detalle AS
WITH base AS (
  SELECT
    d.id                                               AS detalle_id,
    d.comercial_invoice_id,
    ci.carpeta_importacion_id                          AS carpeta_id,
    ci.empresa_id,
    d.product_id AS item_id,   -- la columna real se llama product_id
    d.lote, d.lote_id, d.partida_arancelaria,
    COALESCE(d.inventariable, true)                    AS inventariable,
    d.margen_objetivo,
    COALESCE(d.cantidad_recibida, d.cantidad_neto, 0)  AS peso_neto,
    COALESCE(d.cantidad_gross, d.cantidad_neto, 0)     AS peso_bruto,
    COALESCE(d.cantidad_unid, 0)                       AS bultos,
    COALESCE(d.costo_total, 0)                         AS fob_usd,
    d.costo_unitario                                   AS fob_unitario
  FROM public.detalle_comercial_invoice d
  JOIN public.comercial_invoices ci ON ci.id = d.comercial_invoice_id
  WHERE ci.carpeta_importacion_id IS NOT NULL
),
-- Los totales incluyen las líneas NO inventariables a propósito: una muestra
-- consume flete y tributos, así que debe absorber su parte en vez de que la
-- mercadería vendible cargue con ella.
tot AS (
  SELECT carpeta_id,
         SUM(fob_usd)    AS fob_t,
         SUM(peso_neto)  AS pn_t,
         SUM(peso_bruto) AS pb_t,
         SUM(bultos)     AS b_t
  FROM base GROUP BY carpeta_id
),
reparto AS (
  SELECT
    b.detalle_id,
    SUM(k.monto_usd * w.peso) FILTER (WHERE k.entra_costo_contable) AS costo_contable_usd,
    SUM(k.monto_pen * w.peso) FILTER (WHERE k.entra_costo_contable) AS costo_contable_pen,
    SUM(k.monto_usd * w.peso) FILTER (WHERE k.entra_costo_gestion)  AS costo_gestion_usd,
    SUM(k.monto_pen * w.peso) FILTER (WHERE k.entra_costo_gestion)  AS costo_gestion_pen,
    SUM(k.monto_usd * w.peso) FILTER (WHERE k.grupo = 'cif')        AS cif_usd,
    -- Líneas de costo que no se pudieron repartir porque su base está en 0
    COUNT(*) FILTER (WHERE w.peso IS NULL)                          AS lineas_sin_base
  FROM base b
  JOIN tot t                       ON t.carpeta_id = b.carpeta_id
  JOIN public.importacion_costos k ON k.carpeta_importacion_id = b.carpeta_id AND NOT k.anulado
  CROSS JOIN LATERAL (
    SELECT CASE k.base_prorrateo
             WHEN 'directo'    THEN CASE WHEN k.detalle_ci_id = b.detalle_id THEN 1::numeric ELSE 0::numeric END
             WHEN 'peso_neto'  THEN b.peso_neto  / NULLIF(t.pn_t,  0)
             WHEN 'peso_bruto' THEN b.peso_bruto / NULLIF(t.pb_t,  0)
             WHEN 'bultos'     THEN b.bultos     / NULLIF(t.b_t,   0)
             ELSE                   b.fob_usd    / NULLIF(t.fob_t, 0)
           END AS peso
  ) w
  GROUP BY b.detalle_id
)
SELECT
  b.detalle_id, b.carpeta_id, b.comercial_invoice_id,
  b.item_id, b.lote, b.lote_id, b.partida_arancelaria, b.inventariable,
  b.peso_neto, b.peso_bruto, b.bultos, b.fob_usd, b.fob_unitario, b.margen_objetivo,
  COALESCE(r.cif_usd, 0)            AS cif_usd,
  COALESCE(r.costo_contable_usd, 0) AS costo_contable_usd,
  COALESCE(r.costo_contable_pen, 0) AS costo_contable_pen,
  COALESCE(r.costo_gestion_usd, 0)  AS costo_gestion_usd,
  COALESCE(r.costo_gestion_pen, 0)  AS costo_gestion_pen,
  COALESCE(r.lineas_sin_base, 0)    AS lineas_sin_base,
  CASE WHEN b.peso_neto > 0 THEN round(COALESCE(r.costo_contable_usd, 0) / b.peso_neto, 6) END AS costo_contable_kg,
  CASE WHEN b.peso_neto > 0 THEN round(COALESCE(r.costo_gestion_usd,  0) / b.peso_neto, 6) END AS costo_gestion_kg,
  CASE WHEN b.peso_neto > 0 THEN round(COALESCE(r.costo_contable_pen, 0) / b.peso_neto, 6) END AS costo_contable_kg_pen,
  -- empresa_id va al FINAL, igual que en las vistas del 87, para que un
  -- CREATE OR REPLACE futuro pueda seguir agregando columnas sin romperla.
  b.empresa_id
FROM base b
LEFT JOIN reparto r ON r.detalle_id = b.detalle_id;

COMMENT ON VIEW public.v_importacion_costo_detalle IS
  'Prorrateo del ledger por línea de la Commercial Invoice según base_prorrateo (directo / valor_fob / peso_neto / peso_bruto / bultos). Solo lectura: la Fase D persistirá esto en lotes.costo_unitario (NIC 2) y lotes.costo_real (gestión). lineas_sin_base > 0 avisa que una línea de costo no se pudo repartir porque su base está en 0.';

-- ============================================================
-- 3. CUADRE DEL PRORRATEO: lo repartido debe ser lo del ledger
-- ============================================================
CREATE OR REPLACE VIEW public.v_importacion_prorrateo_cuadre AS
SELECT
  r.carpeta_id, r.numero_carpeta, r.estado,
  r.costo_contable_usd                                               AS ledger_contable_usd,
  COALESCE(d.repartido_contable, 0)                                  AS repartido_contable_usd,
  round(r.costo_contable_usd - COALESCE(d.repartido_contable, 0), 2) AS dif_contable_usd,
  r.costo_gestion_usd                                                AS ledger_gestion_usd,
  COALESCE(d.repartido_gestion, 0)                                   AS repartido_gestion_usd,
  round(r.costo_gestion_usd - COALESCE(d.repartido_gestion, 0), 2)   AS dif_gestion_usd,
  COALESCE(d.lineas, 0)                                              AS lineas_ci,
  COALESCE(d.sin_base, 0)                                            AS lineas_sin_base,
  (abs(r.costo_contable_usd - COALESCE(d.repartido_contable, 0)) < 0.01
   AND abs(r.costo_gestion_usd - COALESCE(d.repartido_gestion, 0)) < 0.01) AS cuadra,
  r.empresa_id
FROM public.v_importacion_resumen r
LEFT JOIN (
  SELECT carpeta_id,
         SUM(costo_contable_usd) AS repartido_contable,
         SUM(costo_gestion_usd)  AS repartido_gestion,
         COUNT(*)                AS lineas,
         SUM(lineas_sin_base)    AS sin_base
  FROM public.v_importacion_costo_detalle
  GROUP BY carpeta_id
) d ON d.carpeta_id = r.carpeta_id;

COMMENT ON VIEW public.v_importacion_prorrateo_cuadre IS
  'Control: la suma de los costos prorrateados por artículo tiene que ser igual al costo del ledger. cuadra = false ⇒ hay líneas de costo con base en 0 (peso o FOB sin registrar en el detalle de la CI).';

-- ============================================================
-- 4. ANÁLISIS GENERAL — formato del Excel de Jhiro & Benji
-- ============================================================
CREATE OR REPLACE VIEW public.v_importacion_analisis_general AS
WITH param AS (
  SELECT COALESCE(MAX(valor) FILTER (WHERE clave = 'margen_objetivo_default' AND activo), 15) / 100.0 AS margen_default
  FROM public.importacion_parametros
)
SELECT
  cd.detalle_id,
  e.codigo                                             AS empresa_codigo,
  LEFT(COALESCE(e.codigo, e.nombre_comercial, 'X'), 1) AS empresa_inicial,
  e.nombre_comercial                                   AS empresa_nombre,
  cd.carpeta_id,
  c.numero_carpeta,
  c.estado                                             AS carpeta_estado,
  c.numero_dam,
  -- Columna "CONT." del Excel: la etiqueta corta, o los números de la naviera
  COALESCE(cnt.etiquetas, c.numero_carpeta)            AS contenedor,
  -- Columna "ARTICULO": convención del ERP "(SKU) Nombre"
  CASE WHEN i.sku IS NOT NULL AND i.sku <> '' THEN '(' || i.sku || ') ' || i.nombre
       ELSE COALESCE(i.nombre, cd.lote, 'Sin producto') END AS articulo,
  cd.item_id, cd.lote, cd.lote_id, cd.inventariable,
  cd.peso_neto, cd.fob_unitario,
  cd.costo_contable_kg,
  -- "COSTO" del Excel = costo real por kg = costo de GESTIÓN
  cd.costo_gestion_kg                                  AS costo_kg,
  m.margen,
  -- Margen SOBRE LA VENTA: uti = costo × m/(1−m)
  round(cd.costo_gestion_kg * m.margen / NULLIF(1 - m.margen, 0), 6) AS utilidad_kg,
  round(cd.costo_gestion_kg / NULLIF(1 - m.margen, 0), 6)            AS valor_venta_kg,
  round(cd.costo_gestion_kg / NULLIF(1 - m.margen, 0)
        * (1 + COALESCE(e.igv_porcentaje, 18) / 100.0), 6)           AS precio_con_igv,
  COALESCE(st.stock, 0)                                              AS stock,
  round(cd.costo_gestion_kg * m.margen / NULLIF(1 - m.margen, 0) * COALESCE(st.stock, 0), 2) AS utilidad_recuperable,
  round(cd.costo_gestion_kg / NULLIF(1 - m.margen, 0) * COALESCE(st.stock, 0), 2)            AS venta_potencial,
  round(cd.costo_gestion_kg * COALESCE(st.stock, 0), 2)                                      AS inventario_valorizado,
  st.costo_real                                        AS lote_costo_real,
  st.costo_unitario_pen                                AS lote_costo_unitario_pen,
  st.provisional                                       AS lote_costo_provisional,
  -- Bloque "Datos de contenedores pendientes": antigüedad
  cnt.eta                                              AS fecha_eta,
  CASE WHEN cnt.eta IS NOT NULL THEN (CURRENT_DATE - cnt.eta) END               AS dias_desde_eta,
  CASE WHEN cnt.eta IS NOT NULL THEN round((CURRENT_DATE - cnt.eta) / 30.0, 2) END AS meses_desde_eta,
  cnt.llegada                                          AS fecha_llegada,
  cd.empresa_id
FROM public.v_importacion_costo_detalle cd
JOIN public.carpetas_importacion c ON c.id = cd.carpeta_id
JOIN public.empresa_config e       ON e.id = cd.empresa_id
LEFT JOIN public.items i           ON i.id = cd.item_id
CROSS JOIN param
CROSS JOIN LATERAL (
  SELECT COALESCE(cd.margen_objetivo, param.margen_default) AS margen
) m
LEFT JOIN LATERAL (
  SELECT string_agg(DISTINCT COALESCE(NULLIF(x.etiqueta, ''), x.numero), ', '
                    ORDER BY COALESCE(NULLIF(x.etiqueta, ''), x.numero)) AS etiquetas,
         MIN(x.fecha_eta)     AS eta,
         MAX(x.fecha_llegada) AS llegada
  FROM public.contenedores x
  WHERE x.carpeta_importacion_id = cd.carpeta_id
) cnt ON true
LEFT JOIN LATERAL (
  SELECT SUM(l.cantidad)                         AS stock,
         MAX(l.costo_unitario)                   AS costo_unitario_pen,
         MAX(l.costo_real)                       AS costo_real,
         bool_or(l.costo_estado = 'provisional')  AS provisional
  FROM public.lotes l
  WHERE (cd.lote_id IS NOT NULL AND l.id = cd.lote_id)
     OR (cd.lote_id IS NULL AND cd.lote IS NOT NULL
         AND l.numero_lote = cd.lote AND l.empresa_id = cd.empresa_id)
) st ON true;

COMMENT ON VIEW public.v_importacion_analisis_general IS
  'Análisis general con el formato del Excel de Jhiro & Benji: una fila por artículo con COSTO (gestión USD/kg), % UTILIDAD, UTI POR KG, VALOR VENTA, PRECIO con IGV, STOCK, UTILIDAD RECUPERABLE y VENTA potencial, más ETA / días / meses para el bloque de antigüedad. El margen es SOBRE LA VENTA (precio = costo / (1-m)), igual que la hoja original.';

COMMIT;

-- ============================================================
-- 5. GRANTS (solo las 3 vistas nuevas; las del 86/87 ya los tienen)
-- ============================================================
GRANT SELECT ON public.v_importacion_costo_detalle    TO authenticated;
GRANT SELECT ON public.v_importacion_prorrateo_cuadre TO authenticated;
GRANT SELECT ON public.v_importacion_analisis_general TO authenticated;

-- ============================================================
-- 6. VERIFICACIÓN (SELECT: se ve en el panel de resultados)
-- ============================================================
-- 6.1 · Las 6 vistas y si exponen empresa_id (las 6 deben decir SI)
SELECT v.table_name AS vista,
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns c
                          WHERE c.table_schema = 'public' AND c.table_name = v.table_name
                            AND c.column_name = 'empresa_id') THEN 'SI' ELSE 'NO' END AS empresa_id
  FROM information_schema.views v
 WHERE v.table_schema = 'public' AND v.table_name LIKE 'v_importacion%'
 ORDER BY v.table_name;

-- 6.2 · Columnas nuevas (deben salir las 4)
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND ( (table_name = 'detalle_comercial_invoice' AND column_name = 'margen_objetivo')
      OR (table_name = 'contenedores'              AND column_name = 'etiqueta')
      OR (table_name = 'lotes'                     AND column_name LIKE 'costo_real%') )
 ORDER BY table_name, column_name;

-- 6.3 · Cuadre del prorrateo por carpeta (vacío si aún no hay carpetas;
--       lo importante es que responda sin error). cuadra debe ser true.
SELECT carpeta_id, numero_carpeta, estado,
       ledger_contable_usd, repartido_contable_usd, dif_contable_usd,
       lineas_ci, lineas_sin_base, cuadra
  FROM public.v_importacion_prorrateo_cuadre
 ORDER BY carpeta_id;

-- 6.4 · Análisis general: costo por artículo (vacío si aún no hay datos)
SELECT empresa_codigo, contenedor, articulo, peso_neto, costo_kg,
       margen, valor_venta_kg, stock, utilidad_recuperable
  FROM public.v_importacion_analisis_general
 ORDER BY empresa_codigo, contenedor, articulo;
