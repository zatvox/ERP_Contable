-- ============================================================================
-- 43_LOTE_BULTOS.SQL — Fase 1a: peso variable a nivel de bulto + fix de
-- Identificación Específica por adquisición (aprobado por contabilidad).
-- ============================================================================
-- DOS cosas en este script:
--
-- 1) Quita el UNIQUE global de lotes.numero_lote. Hoy ese constraint OBLIGA a
--    que el texto del N° de lote sea único en todo el sistema — por eso el
--    código nunca podía crear una fila nueva cuando el mismo texto de lote
--    venía de una factura distinta con otro costo/TC: solo podía reutilizar
--    (fusionar) la fila existente, aunque el costo no coincidiera. Se
--    reemplaza por UNIQUE(item_id, numero_lote, compra_id): mismo texto +
--    misma compra sigue siendo un solo lote (correcto, es la misma
--    adquisición); mismo texto + compra distinta ahora es una fila nueva
--    (una capa de costo distinta, identificación específica real).
--
-- 2) Crea lote_bultos: detalle de peso individual por bulto/caja/bolsa (el
--    packing list del proveedor), para productos es_peso_variable=true.
--    Cada bulto sabe en qué zona está y en qué estado (disponible, vendido,
--    devuelto). lotes.cantidad/cantidad_unidades, para estos productos,
--    dejan de escribirse a mano — se recalculan sumando/contando sus bultos
--    disponibles (ver función recalcular_lote_desde_bultos, usada por el
--    código al guardar). El stock por zona se lee de la vista
--    v_stock_bultos_zona en vez de stock_ubicaciones, para que nunca se
--    pueda desincronizar del detalle real.
--
-- Alcance de esta fase: solo tabla + vista + fix de unicidad. La UI de
-- recepción (packing list) y el resto de estados (vendido, devuelto_*) se
-- completan en las fases siguientes — las columnas ya quedan listas para no
-- tener que migrar de nuevo.
--
-- Idempotente.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1) FIX: identificación específica por adquisición, no por texto de lote
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.lotes DROP CONSTRAINT IF EXISTS lotes_numero_lote_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_lotes_item_numlote_compra
  ON public.lotes (item_id, numero_lote, compra_id);

COMMENT ON INDEX public.idx_lotes_item_numlote_compra IS
  'Reemplaza al UNIQUE(numero_lote) original. Mismo producto+texto de lote+misma compra = 1 sola fila (se suma cantidad). Mismo texto con compra distinta = fila nueva (identificación específica por adquisición, LIR Art. 62° inciso c) / NIC 2 párr. 24). compra_id NULL (lotes manuales) no choca entre sí por semántica NULL de Postgres en índices únicos.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2) LOTE_BULTOS — detalle de peso individual por bulto (packing list)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.lote_bultos (
  id                          bigserial   PRIMARY KEY,
  lote_id                     bigint      NOT NULL REFERENCES public.lotes(id) ON DELETE CASCADE,
  codigo_bulto                varchar,    -- correlativo/etiqueta física, ej. "B-01" (opcional, informativo)
  peso                        numeric     NOT NULL CHECK (peso > 0),
  unidad_medida                varchar     NOT NULL DEFAULT 'KG',
  ubicacion_id                integer     REFERENCES public.ubicaciones(id),  -- dónde está FÍSICAMENTE ahora
  estado                      varchar     NOT NULL DEFAULT 'disponible'
                                 CHECK (estado IN ('disponible','vendido','devuelto_cliente','devuelto_proveedor','merma')),
  -- Trazabilidad de salida/consumo (se usan a partir de la Fase 2/3)
  detalle_venta_id            bigint      REFERENCES public.detalle_ventas(id),
  detalle_guia_despacho_id    bigint      REFERENCES public.detalle_guias_despacho_venta(id),
  nota_credito_venta_id       bigint      REFERENCES public.ventas(id),   -- NC de cliente que reactivó este bulto
  nota_credito_compra_id      bigint      REFERENCES public.compras(id), -- NC pendiente al devolver a proveedor
  bulto_origen_id             bigint      REFERENCES public.lote_bultos(id),
    -- Cuando una devolución de cliente NO trae exactamente el mismo bulto
    -- (reempacado, cantidad parcial): este es el bulto NUEVO que se pesó en
    -- la devolución, y bulto_origen_id apunta al bulto/venta original para
    -- no perder la trazabilidad aunque el peso no coincida exacto.
  -- Origen de ingreso
  guia_ingreso_id              bigint      REFERENCES public.guias_ingreso_compra(id),
  fecha_ingreso                date,
  created_by                   bigint      REFERENCES public.users(id),
  created_at                   timestamptz DEFAULT now()
);

COMMENT ON TABLE public.lote_bultos IS
  'Detalle de peso individual por bulto/caja/bolsa (packing list del proveedor), para productos con lotes.es_peso_variable=true. lotes.cantidad y cantidad_unidades se calculan sumando/contando los bultos en estado=disponible de este lote, no se escriben a mano cuando el lote tiene bultos.';
COMMENT ON COLUMN public.lote_bultos.estado IS
  'disponible=en stock; vendido=salió por venta; devuelto_cliente=reingresó por NC de cliente; devuelto_proveedor=salió por devolución a proveedor, pendiente de su NC; merma=ajuste/pérdida.';

CREATE INDEX IF NOT EXISTS idx_lote_bultos_lote      ON public.lote_bultos(lote_id);
CREATE INDEX IF NOT EXISTS idx_lote_bultos_ubicacion ON public.lote_bultos(ubicacion_id);
CREATE INDEX IF NOT EXISTS idx_lote_bultos_estado    ON public.lote_bultos(estado);
CREATE INDEX IF NOT EXISTS idx_lote_bultos_venta      ON public.lote_bultos(detalle_venta_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 3) VISTA — stock por zona calculado desde los bultos reales (nunca se
--    desincroniza porque no hay un número aparte que mantener a mano).
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.v_stock_bultos_zona AS
SELECT
  lote_id,
  ubicacion_id,
  COUNT(*)      AS cantidad_unidades,
  SUM(peso)     AS cantidad
FROM public.lote_bultos
WHERE estado = 'disponible'
GROUP BY lote_id, ubicacion_id;

COMMENT ON VIEW public.v_stock_bultos_zona IS
  'Stock disponible por lote y zona para productos con bultos, calculado en vivo sumando lote_bultos (estado=disponible). Reemplaza a stock_ubicaciones para estos productos — no es una tabla que se escriba a mano.';

-- ────────────────────────────────────────────────────────────────────────────
-- 4) RLS + GRANTS
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.lote_bultos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lote_bultos_select_auth ON public.lote_bultos;
DROP POLICY IF EXISTS lote_bultos_insert_auth ON public.lote_bultos;
DROP POLICY IF EXISTS lote_bultos_update_auth ON public.lote_bultos;
DROP POLICY IF EXISTS lote_bultos_delete_auth ON public.lote_bultos;

CREATE POLICY lote_bultos_select_auth ON public.lote_bultos FOR SELECT TO authenticated USING (true);
CREATE POLICY lote_bultos_insert_auth ON public.lote_bultos FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY lote_bultos_update_auth ON public.lote_bultos FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY lote_bultos_delete_auth ON public.lote_bultos FOR DELETE TO authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lote_bultos TO authenticated;
GRANT SELECT ON public.v_stock_bultos_zona TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
-- SELECT indexname FROM pg_indexes WHERE tablename = 'lotes' AND indexname LIKE '%numlote%';
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'lote_bultos' ORDER BY ordinal_position;
-- SELECT * FROM public.v_stock_bultos_zona LIMIT 5;
