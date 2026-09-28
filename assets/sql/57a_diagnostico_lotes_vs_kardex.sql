-- ============================================================================
-- 57a_diagnostico_lotes_vs_kardex.sql — SOLO LECTURA · 2026-09-25
-- Paso previo a 57_lotes_cantidad_desde_kardex.sql. No modifica nada.
-- Devuelve 1 celda JSON: cópiala y pégamela.
--
-- Stock "según kardex" = misma regla que la vista stock_ubicaciones
-- (entra si el DESTINO es zona real, sale si el ORIGEN es zona real; los
-- almacenes virtuales Partners/* no cuentan), pero SIN el HAVING > 0 ni el
-- GREATEST(…,0) de la vista → aquí sí aparecen los negativos.
-- ============================================================================
WITH reales AS (
  SELECT u.id FROM ubicaciones u JOIN almacenes a ON a.id = u.almacen_id WHERE NOT a.es_virtual
),
k AS (
  SELECT k.lote_id,
         SUM(CASE WHEN k.ubicacion_destino_id IN (SELECT id FROM reales) THEN k.cantidad_entrada ELSE 0 END
           - CASE WHEN k.ubicacion_origen_id  IN (SELECT id FROM reales) THEN k.cantidad_salida  ELSE 0 END) AS kg_zona,
         SUM(CASE WHEN k.ubicacion_destino_id IN (SELECT id FROM reales) THEN k.cantidad_unidades_entrada ELSE 0 END
           - CASE WHEN k.ubicacion_origen_id  IN (SELECT id FROM reales) THEN k.cantidad_unidades_salida  ELSE 0 END) AS ud_zona,
         SUM(k.cantidad_entrada - k.cantidad_salida) AS kg_simple,
         COUNT(*) AS movs,
         COUNT(*) FILTER (WHERE k.ubicacion_origen_id IS NULL OR k.ubicacion_destino_id IS NULL) AS movs_sin_zona
  FROM kardex k WHERE k.lote_id IS NOT NULL GROUP BY k.lote_id
),
b AS (
  SELECT lote_id, SUM(peso) AS kg_bultos, COUNT(*) AS ud_bultos
  FROM lote_bultos WHERE estado = 'disponible' GROUP BY lote_id
),
cmp AS (
  SELECT l.id, l.numero_lote, l.item_id, l.es_peso_variable, l.peso_por_unidad,
         ROUND(l.cantidad,4) AS kg_lote, ROUND(l.cantidad_unidades,4) AS ud_lote,
         ROUND(COALESCE(k.kg_zona,0),4) AS kg_kardex, ROUND(COALESCE(k.ud_zona,0),4) AS ud_kardex,
         ROUND(COALESCE(k.kg_simple,0),4) AS kg_simple, COALESCE(k.movs,0) AS movs, COALESCE(k.movs_sin_zona,0) AS movs_sin_zona,
         b.kg_bultos, b.ud_bultos
  FROM lotes l LEFT JOIN k ON k.lote_id = l.id LEFT JOIN b ON b.lote_id = l.id
)
SELECT jsonb_pretty(jsonb_build_object(
  'resumen', jsonb_build_object(
     'lotes_total',            (SELECT COUNT(*) FROM cmp),
     'difieren_kg',            (SELECT COUNT(*) FROM cmp WHERE ABS(kg_lote-kg_kardex) > 0.01),
     'difieren_ud',            (SELECT COUNT(*) FROM cmp WHERE ABS(ud_lote-ud_kardex) > 0.01),
     'kardex_kg_negativo',     (SELECT COUNT(*) FROM cmp WHERE kg_kardex < -0.01),
     'kardex_ud_negativo',     (SELECT COUNT(*) FROM cmp WHERE ud_kardex < -0.01),
     'fantasmas_sin_kardex',   (SELECT COUNT(*) FROM cmp WHERE movs = 0 AND kg_lote > 0),
     'kardex_con_movs_sin_zona',(SELECT COUNT(*) FROM cmp WHERE movs_sin_zona > 0),
     'peso_var_bultos_vs_kardex',(SELECT COUNT(*) FROM cmp WHERE es_peso_variable AND ABS(COALESCE(kg_bultos,0)-kg_kardex) > 0.01)
  ),
  -- 1) Lotes donde lotes ≠ kardex (lo que el trigger va a corregir)
  'diferencias', (SELECT jsonb_agg(to_jsonb(c) ORDER BY ABS(kg_lote-kg_kardex) DESC) FROM cmp c
                  WHERE ABS(kg_lote-kg_kardex) > 0.01 OR ABS(ud_lote-ud_kardex) > 0.01),
  -- 2) Movimientos con kg pero 0 unidades (mismo caso que kardex id 56)
  'kardex_sin_unidades', (SELECT jsonb_agg(jsonb_build_object('kardex_id',k.id,'lote_id',k.lote_id,'numero_lote',l.numero_lote,
            'tipo',k.tipo_movimiento,'fecha',k.fecha,'doc',k.documento_referencia,
            'kg',k.cantidad_entrada+k.cantidad_salida,'peso_por_unidad',l.peso_por_unidad,
            'ud_sugeridas',ROUND((k.cantidad_entrada+k.cantidad_salida)/NULLIF(l.peso_por_unidad,0),2)) ORDER BY k.lote_id,k.id)
          FROM kardex k JOIN lotes l ON l.id = k.lote_id
          WHERE NOT l.es_peso_variable
            AND ((k.cantidad_entrada > 0 AND k.cantidad_unidades_entrada = 0)
              OR (k.cantidad_salida  > 0 AND k.cantidad_unidades_salida  = 0))),
  -- 3) Ventas que salen de un lote ANTES de su primera entrada (caso MB31516)
  'salidas_antes_de_entrada', (SELECT jsonb_agg(jsonb_build_object('kardex_id',k.id,'lote_id',k.lote_id,'numero_lote',l.numero_lote,
            'fecha_salida',k.fecha,'primera_entrada',pe.f,'doc',k.documento_referencia,'kg',k.cantidad_salida))
          FROM kardex k JOIN lotes l ON l.id = k.lote_id
          JOIN (SELECT lote_id, MIN(fecha) f FROM kardex WHERE cantidad_entrada > 0 AND tipo_movimiento <> 'traslado_interno' GROUP BY lote_id) pe ON pe.lote_id = k.lote_id
          WHERE k.cantidad_salida > 0 AND k.tipo_movimiento <> 'traslado_interno' AND k.fecha < pe.f),
  -- 4) Constraints actuales de lotes (para saber si un negativo bloquearía)
  'constraints_lotes', (SELECT jsonb_agg(jsonb_build_object('nombre',conname,'def',pg_get_constraintdef(oid)))
          FROM pg_constraint WHERE conrelid = 'public.lotes'::regclass AND contype = 'c'),
  -- 5) Triggers ya existentes en lotes / kardex
  'triggers', (SELECT jsonb_agg(jsonb_build_object('tabla',event_object_table,'trigger',trigger_name,'evento',event_manipulation,'accion',action_statement))
          FROM information_schema.triggers WHERE event_object_table IN ('lotes','kardex'))
)) AS diagnostico;
