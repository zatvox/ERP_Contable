-- ============================================================================
-- 130 · Libro de caja — orden manual dentro del día  ·  2026-11-01
-- ----------------------------------------------------------------------------
-- En el Excel el orden es la POSICIÓN de la fila. En la base, el orden real es
-- la fecha; dentro de un mismo día el `id` solo dice en qué orden se tecleó,
-- que no es necesariamente el orden en que pasaron las cosas.
--
-- Esta columna permite reordenar DENTRO de la fecha sin tocar nada más:
--   ORDER BY fecha, COALESCE(orden, id), id
--
-- Se usa `numeric` a propósito, no `integer`: para insertar una fila entre
-- otras dos basta con el promedio de sus órdenes (12 y 13 → 12.5). Así nunca
-- hay que renumerar la tabla entera, que con 40 filas por mes sería un
-- UPDATE masivo cada vez que la tesorera intercala un recibo.
--
-- IDEMPOTENTE. NO BORRA NADA.
-- ============================================================================

BEGIN;

ALTER TABLE public.movimientos_banco
  ADD COLUMN IF NOT EXISTS orden numeric;

COMMENT ON COLUMN public.movimientos_banco.orden IS
  'Orden manual dentro de la misma fecha. NULL = ordenar por id. Numérico para poder intercalar (promedio de los vecinos) sin renumerar.';

-- Arranque: el orden actual es el de captura, así que se siembra con el id.
-- Solo las filas que todavía no tienen orden.
UPDATE public.movimientos_banco SET orden = id WHERE orden IS NULL;

CREATE INDEX IF NOT EXISTS idx_movbanco_orden
  ON public.movimientos_banco(banco_id, fecha, orden);

-- La vista del libro expone el orden para que la grilla lo respete
DROP VIEW IF EXISTS public.v_libro_caja;
CREATE VIEW public.v_libro_caja AS
SELECT
  m.id                       AS movimiento_id,
  m.orden                    AS orden,
  g.id                       AS gasto_id,
  m.banco_id                 AS caja_id,
  b.nombre                   AS caja_nombre,
  b.moneda                   AS moneda,
  m.fecha                    AS fecha,
  to_char(m.fecha, 'TMMonth')AS mes_nombre,
  COALESCE(g.numero_recibo, m.referencia)        AS numero_recibo,
  g.tipo_documento_id,
  td.nombre                  AS tipo_documento,
  td.color                   AS tipo_documento_color,
  COALESCE(g.categoria_gasto_id, m.categoria_gasto_id) AS categoria_gasto_id,
  cg.nombre                  AS categoria,
  cg.color                   AS categoria_color,
  COALESCE(g.responsable_contact_id, m.responsable_contact_id) AS responsable_contact_id,
  c.nombre                   AS responsable,
  COALESCE(g.detalle, m.concepto) AS detalle,
  CASE WHEN m.tipo = 'ingreso' THEN m.monto ELSE 0 END AS ingreso,
  CASE WHEN m.tipo = 'egreso'  THEN m.monto ELSE 0 END AS egreso,
  m.tipo                     AS tipo_movimiento,
  COALESCE(g.ambito, m.ambito)         AS ambito,
  COALESCE(g.empresa_id, m.empresa_id) AS empresa_id,
  g.destino_costo,
  g.tipo_sustento,
  g.estado_sustento,
  g.deducible,
  g.guia_despacho_id,
  g.entrega_id,
  g.reposicion_id,
  g.nota,
  g.observaciones,
  (SELECT count(*) FROM public.adjuntos a
    WHERE a.entidad = 'gasto' AND a.entidad_id = g.id) AS adjuntos,
  m.created_at
FROM public.movimientos_banco m
JOIN      public.bancos               b  ON b.id  = m.banco_id
LEFT JOIN public.gastos               g  ON g.movimiento_id = m.id AND g.anulado = false
LEFT JOIN public.tipos_documento_gasto td ON td.id = g.tipo_documento_id
LEFT JOIN public.categorias_gasto     cg ON cg.id = COALESCE(g.categoria_gasto_id, m.categoria_gasto_id)
LEFT JOIN public.contacts             c  ON c.id  = COALESCE(g.responsable_contact_id, m.responsable_contact_id);

COMMENT ON VIEW public.v_libro_caja IS
  'Libro de caja estilo Excel. Orden: fecha, luego `orden` (manual dentro del día). El saldo corrido lo calcula el front porque depende del orden y de los filtros.';

COMMIT;
NOTIFY pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
SELECT '1. COLUMNA' AS bloque, column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='movimientos_banco' AND column_name='orden';

SELECT '2. ORDEN DEL LIBRO' AS bloque, numero_recibo, fecha, orden, ingreso, egreso
  FROM public.v_libro_caja WHERE caja_id = 6
 ORDER BY fecha, COALESCE(orden, movimiento_id), movimiento_id;
