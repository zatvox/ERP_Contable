-- ============================================================================
-- 90_fix_parametros_importacion_por_empresa.sql  (2026-10-20)
--
-- QUÉ PASÓ: el SQL 87 le puso `empresa_id NOT NULL` a importacion_parametros,
-- pero el UNIQUE del 86 seguía siendo sobre `clave` SOLA. Resultado:
--   · el INSERT del 89 reventó (null value in column "empresa_id"), y
--   · aunque se arreglara, Benji y Rama NUNCA podrían tener sus parámetros,
--     porque la clave 'reposicion_pct' ya estaba tomada por Jhiro.
--
-- QUÉ ARREGLA:
--   1. UNIQUE pasa de (clave) a (empresa_id, clave).
--   2. Siembra los 5 parámetros en TODAS las empresas (las de Jhiro ya están,
--      no se duplican).
--   3. v_importacion_analisis_general leía el margen por defecto con un
--      MAX() sobre todas las empresas; ahora lo lee de la empresa de la fila.
--
-- Idempotente. Requiere 86, 87 y 89.
-- ============================================================================
BEGIN;

-- ── 1. UNIQUE por empresa ───────────────────────────────────────────────────
DO $$
DECLARE c text;
BEGIN
  -- Cualquier unique/pk que sea SOLO sobre (clave) estorba en multiempresa.
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = 'importacion_parametros'
       AND con.contype IN ('u','p')
       -- attname es de tipo `name`: hay que castear a text para comparar
       AND (SELECT array_agg(att.attname::text ORDER BY att.attname::text)
              FROM unnest(con.conkey) k
              JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k)
           = ARRAY['clave']::text[]
  LOOP
    EXECUTE format('ALTER TABLE public.importacion_parametros DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_imp_param_empresa_clave
  ON public.importacion_parametros (empresa_id, clave);

COMMENT ON INDEX public.idx_imp_param_empresa_clave IS
  'Cada empresa tiene su propio juego de parámetros de costeo: Jhiro puede usar 1.5% de reposición y Benji otro.';

-- ── 2. Sembrar los 5 parámetros en todas las empresas ───────────────────────
INSERT INTO public.importacion_parametros
  (empresa_id, clave, etiqueta, tipo, valor, base, moneda, activo, grupo, concepto_codigo, clasificacion, orden, descripcion)
SELECT e.id, p.clave, p.etiqueta, p.tipo, p.valor, p.base, p.moneda, true,
       p.grupo, p.concepto_codigo, p.clasificacion, p.orden, p.descripcion
FROM public.empresa_config e
CROSS JOIN (VALUES
  ('reposicion_pct', 'Costo de reposición (% del CIF)', 'porcentaje', 1.5, 'cif', 'USD',
   'ajuste', 'reposicion', 'solo_gestion', 10,
   'Política interna. No cumple NIC 2 ni LIR (no es desembolso), así que entra SOLO al costo de gestión. En el Excel 2 figuraba como "Costo de oportunidad".'),
  ('bancarios_al_costo', 'Comisiones bancarias entran al costo de gestión', 'switch', 1, NULL, 'USD',
   'financiero', 'comision_bancaria', 'gasto_financiero', 20,
   'NIC 23 las trata como gasto financiero (costo contable NO), pero el costeo de gestión sí las absorbe como desembolso real.'),
  ('tolerancia_definitivo_pct', 'Alerta si el definitivo se desvía del provisional (%)', 'porcentaje', 5, 'fijo', 'USD',
   NULL, NULL, NULL, 30,
   'Al cerrar la carpeta, si una línea definitiva se desvía más de este % de su provisional, pide confirmación y motivo.'),
  ('comision_interna_default', 'Comisión de agente interno por contenedor', 'monto', 250, 'fijo', 'USD',
   'nacionalizacion', 'comision_interna', 'inventario', 40,
   'Monto fijo editable por contenedor. Debe sustentarse con Recibo por Honorarios: el costo es el BRUTO, la retención de 4ta es pasivo.'),
  ('margen_objetivo_default', 'Margen objetivo por defecto (% sobre la venta)', 'porcentaje', 15, 'fijo', 'USD',
   NULL, NULL, NULL, 50,
   'Se usa en el Análisis general cuando la línea de la CI no tiene su propio % de utilidad. Es margen sobre la venta: precio = costo / (1 - m).')
) AS p(clave, etiqueta, tipo, valor, base, moneda, grupo, concepto_codigo, clasificacion, orden, descripcion)
ON CONFLICT (empresa_id, clave) DO NOTHING;

COMMIT;

-- ── 3. El margen por defecto se lee de la empresa de la fila ────────────────
CREATE OR REPLACE VIEW public.v_importacion_analisis_general AS
SELECT
  cd.detalle_id,
  e.codigo                                             AS empresa_codigo,
  LEFT(COALESCE(e.codigo, e.nombre_comercial, 'X'), 1) AS empresa_inicial,
  e.nombre_comercial                                   AS empresa_nombre,
  cd.carpeta_id,
  c.numero_carpeta,
  c.estado                                             AS carpeta_estado,
  c.numero_dam,
  COALESCE(cnt.etiquetas, c.numero_carpeta)            AS contenedor,
  CASE WHEN i.sku IS NOT NULL AND i.sku <> '' THEN '(' || i.sku || ') ' || i.nombre
       ELSE COALESCE(i.nombre, cd.lote, 'Sin producto') END AS articulo,
  cd.item_id, cd.lote, cd.lote_id, cd.inventariable,
  cd.peso_neto, cd.fob_unitario,
  cd.costo_contable_kg,
  cd.costo_gestion_kg                                  AS costo_kg,
  m.margen,
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
  cnt.eta                                              AS fecha_eta,
  CASE WHEN cnt.eta IS NOT NULL THEN (CURRENT_DATE - cnt.eta) END                  AS dias_desde_eta,
  CASE WHEN cnt.eta IS NOT NULL THEN round((CURRENT_DATE - cnt.eta) / 30.0, 2) END AS meses_desde_eta,
  cnt.llegada                                          AS fecha_llegada,
  cd.empresa_id
FROM public.v_importacion_costo_detalle cd
JOIN public.carpetas_importacion c ON c.id = cd.carpeta_id
JOIN public.empresa_config e       ON e.id = cd.empresa_id
LEFT JOIN public.items i           ON i.id = cd.item_id
-- El margen por defecto es de LA EMPRESA de la fila, no un MAX() global.
LEFT JOIN LATERAL (
  SELECT p.valor / 100.0 AS margen_default
  FROM public.importacion_parametros p
  WHERE p.clave = 'margen_objetivo_default' AND p.activo AND p.empresa_id = cd.empresa_id
  LIMIT 1
) pr ON true
CROSS JOIN LATERAL (
  SELECT COALESCE(cd.margen_objetivo, pr.margen_default, 0.15) AS margen
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
  SELECT SUM(l.cantidad)                        AS stock,
         MAX(l.costo_unitario)                  AS costo_unitario_pen,
         MAX(l.costo_real)                      AS costo_real,
         bool_or(l.costo_estado = 'provisional') AS provisional
  FROM public.lotes l
  WHERE (cd.lote_id IS NOT NULL AND l.id = cd.lote_id)
     OR (cd.lote_id IS NULL AND cd.lote IS NOT NULL
         AND l.numero_lote = cd.lote AND l.empresa_id = cd.empresa_id)
) st ON true;

-- ============================================================
-- 4. VERIFICACIÓN (SELECT: se ve en el panel de resultados)
-- ============================================================
-- 4.1 · Cada empresa debe tener sus 5 parámetros
SELECT e.id, e.codigo, COUNT(p.id) AS parametros,
       CASE WHEN COUNT(p.id) >= 5 THEN 'OK' ELSE 'FALTAN' END AS estado
  FROM public.empresa_config e
  LEFT JOIN public.importacion_parametros p ON p.empresa_id = e.id
 GROUP BY e.id, e.codigo
 ORDER BY e.id;

-- 4.2 · El UNIQUE debe ser por (empresa_id, clave)
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'importacion_parametros'
 ORDER BY indexname;

-- 4.3 · Los parámetros, empresa por empresa
SELECT e.codigo, p.clave, p.valor, p.base, p.activo
  FROM public.importacion_parametros p
  JOIN public.empresa_config e ON e.id = p.empresa_id
 ORDER BY e.codigo, p.orden;
