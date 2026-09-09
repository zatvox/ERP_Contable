-- ============================================================================
-- 53_DEVOLUCION_COMPRA.SQL — Devolución de mercadería al proveedor con
-- Nota de Crédito recibida + Guía de Devolución (dos pasos separados).
-- ============================================================================
-- Decisiones confirmadas con Luis:
--   1) Punto de entrada de la Guía de Devolución: acción SEPARADA, disponible
--      cuando el proveedor efectivamente venga a recoger la mercadería — no
--      se exige en el mismo paso que la NC (la NC solo declara qué se debe
--      devolver; la guía es la que de verdad mueve stock/kardex). Mismo
--      espejo que Ventas: Guía de Despacho vs. la venta misma.
--   2) La NC de devolución solo deja elegir lotes de la COMPRA que referencia
--      (compra_origen_id) — no lotes de otras compras del mismo proveedor.
--   3) Peso variable: el bulto devuelto pasa a estado='devuelto_proveedor' y
--      sale del stock. NO se crea un bulto nuevo (a diferencia de una
--      devolución de CLIENTE, que sí repesa) porque este bulto no vuelve a
--      entrar a la empresa.
--
-- Nota: lote_bultos (43_lote_bultos.sql) YA tenía el estado 'devuelto_proveedor'
-- y la columna nota_credito_compra_id previstos desde esa migración, sin usar
-- todavía — este script los activa y agrega la columna de trazabilidad que
-- faltaba (detalle_guia_devolucion_id), espejo de detalle_guia_despacho_id.
--
-- Idempotente.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 0) RENOMBRE: nota_credito_detalle (ventas) → nota_credito_venta_detalle.
--    El nombre original era genérico — no decía "venta" — y al agregar la
--    tabla espejo de compras (nota_credito_compra_detalle) quedaba asimétrico
--    y confuso. Sin pérdida de datos (ALTER TABLE RENAME). Los índices
--    quedan con su nombre viejo (autogenerado, cosmético); las policies se
--    recrean explícitamente abajo con el nombre nuevo.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE IF EXISTS public.nota_credito_detalle RENAME TO nota_credito_venta_detalle;

COMMENT ON TABLE public.nota_credito_venta_detalle IS
  'Detalle por ítem/lote de una Nota de Crédito EMITIDA al cliente (devolución de venta). Una fila por producto devuelto en una NC. Para productos con peso variable, lote_bulto_nuevo_id apunta al bulto repesado creado en Inventario (estado=disponible, bulto_origen_id -> el bulto vendido que ahora queda estado=devuelto_cliente). Antes se llamaba nota_credito_detalle — renombrada para ser simétrica con nota_credito_compra_detalle.';

-- ────────────────────────────────────────────────────────────────────────────
-- 1) NOTA_CREDITO_COMPRA_DETALLE — declara QUÉ se devuelve (ítem, lote,
--    cantidad, precio unitario). Espejo de nota_credito_venta_detalle,
--    pero NO toca stock por sí sola — solo es la base para saber cuánto
--    falta cubrir con guía(s) de devolución.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.nota_credito_compra_detalle (
  id                    bigserial   PRIMARY KEY,
  -- Fila de la NC misma: una compra con tipo_comprobante='07' y
  -- compra_referencia_id = compra_origen_id.
  nota_compra_id        bigint      NOT NULL REFERENCES public.compras(id) ON DELETE CASCADE,
  compra_origen_id      bigint      NOT NULL REFERENCES public.compras(id),
  item_id               bigint      NOT NULL REFERENCES public.items(id),
  lote_id               bigint      NOT NULL REFERENCES public.lotes(id),
  cantidad              numeric     NOT NULL CHECK (cantidad > 0),
  precio_unitario       numeric     NOT NULL DEFAULT 0,
  unidad_medida         varchar,
  created_by            bigint      REFERENCES public.users(id),
  created_at            timestamptz DEFAULT now()
);

COMMENT ON TABLE public.nota_credito_compra_detalle IS
  'Detalle por ítem/lote de una Nota de Crédito RECIBIDA del proveedor (devolución). Solo declara qué se debe devolver — no mueve stock. lote_id se limita a lotes de compra_origen_id (misma compra que la NC referencia). El movimiento real de stock lo hace detalle_guias_devolucion_compra cuando se emite la guía.';

CREATE INDEX IF NOT EXISTS idx_ncc_detalle_nota    ON public.nota_credito_compra_detalle(nota_compra_id);
CREATE INDEX IF NOT EXISTS idx_ncc_detalle_origen   ON public.nota_credito_compra_detalle(compra_origen_id);
CREATE INDEX IF NOT EXISTS idx_ncc_detalle_lote      ON public.nota_credito_compra_detalle(lote_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Estado de devolución de la NC (solo aplica a compras con
--    tipo_comprobante='07' que tengan detalle en nota_credito_compra_detalle).
--    Se recalcula al guardar/eliminar una guía de devolución, comparando lo
--    ya devuelto (detalle_guias_devolucion_compra) contra lo declarado en
--    nota_credito_compra_detalle. Mismo patrón que ventas.estado_despacho.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.compras
  ADD COLUMN IF NOT EXISTS estado_devolucion varchar
    CHECK (estado_devolucion IN ('pendiente', 'parcial', 'completa'));

COMMENT ON COLUMN public.compras.estado_devolucion IS
  'Solo relevante en filas con tipo_comprobante=''07'' (NC) que tienen detalle en nota_credito_compra_detalle. NULL = esta NC no es una devolución de mercadería (ajuste puro). Se recalcula al guardar/eliminar una guía de devolución.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3) GUIAS_DEVOLUCION_COMPRA — cabecera. Espejo de guias_despacho_venta.
--    Se referencia a la COMPRA ORIGEN (no a la NC) porque una devolución
--    física puede terminar cubriendo líneas de más de una NC del mismo
--    proveedor sobre la misma compra (poco común, pero el modelo lo permite
--    sin forzar). La NC concreta que cada línea cubre queda en
--    detalle_guias_devolucion_compra.nota_credito_compra_detalle_id.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guias_devolucion_compra (
  id              bigserial   PRIMARY KEY,
  compra_id       bigint      NOT NULL REFERENCES public.compras(id),
  numero_guia     varchar     NOT NULL,
  fecha_guia      date        NOT NULL,
  observaciones   text,
  created_by      bigint      REFERENCES public.users(id),
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

COMMENT ON TABLE public.guias_devolucion_compra IS
  'Guía de Remisión de SALIDA de mercadería hacia el proveedor (devolución). Espejo de guias_despacho_venta. Referencia la compra origen; el proveedor recoge la mercadería con su propia movilidad.';

CREATE INDEX IF NOT EXISTS idx_guias_devolucion_compra_compra_id ON public.guias_devolucion_compra(compra_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 4) DETALLE_GUIAS_DEVOLUCION_COMPRA — por cada línea, lote y zona real de la
--    que sale (obligatorio). Referencia la línea de NC que cubre, para poder
--    recalcular estado_devolucion.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.detalle_guias_devolucion_compra (
  id                              bigserial   PRIMARY KEY,
  guia_id                         bigint      NOT NULL REFERENCES public.guias_devolucion_compra(id) ON DELETE CASCADE,
  nota_credito_compra_detalle_id  bigint      NOT NULL REFERENCES public.nota_credito_compra_detalle(id),
  item_id                         bigint      REFERENCES public.items(id),
  cantidad                        numeric     NOT NULL CHECK (cantidad > 0),
  numero_lote                     varchar     NOT NULL,
  lote_id                         bigint      REFERENCES public.lotes(id),
  ubicacion_id                    bigint      NOT NULL REFERENCES public.ubicaciones(id),
  created_at                      timestamptz DEFAULT now()
);

COMMENT ON TABLE public.detalle_guias_devolucion_compra IS
  'Línea de guía de devolución: de qué zona real sale cada lote. Esta es la fila que SÍ dispara Kardex salida (origen=zona real, destino=Partners/Vendors) y descuenta lotes.cantidad — mismo modelo que detalle_guias_despacho_venta.';

CREATE INDEX IF NOT EXISTS idx_dgdc_guia_id ON public.detalle_guias_devolucion_compra(guia_id);
CREATE INDEX IF NOT EXISTS idx_dgdc_nota_credito_compra_detalle_id ON public.detalle_guias_devolucion_compra(nota_credito_compra_detalle_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 5) lote_bultos: trazabilidad de qué guía de devolución sacó cada bulto
--    (espejo de detalle_guia_despacho_id, que ya existe para ventas).
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.lote_bultos
  ADD COLUMN IF NOT EXISTS detalle_guia_devolucion_id bigint
    REFERENCES public.detalle_guias_devolucion_compra(id);

COMMENT ON COLUMN public.lote_bultos.detalle_guia_devolucion_id IS
  'Fila de detalle_guias_devolucion_compra que marcó este bulto como devuelto_proveedor (peso variable). NULL si el bulto nunca salió por devolución.';

-- ────────────────────────────────────────────────────────────────────────────
-- 6) RLS + GRANTS (mismo patrón usado en todo el sistema)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.nota_credito_compra_detalle    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guias_devolucion_compra        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.detalle_guias_devolucion_compra ENABLE ROW LEVEL SECURITY;

-- Policies con el nombre viejo (previas al RENAME de la sección 0) — se
-- botan explícitamente porque el bucle de abajo solo conoce el nombre nuevo.
DROP POLICY IF EXISTS nota_credito_detalle_select_auth ON public.nota_credito_venta_detalle;
DROP POLICY IF EXISTS nota_credito_detalle_insert_auth ON public.nota_credito_venta_detalle;
DROP POLICY IF EXISTS nota_credito_detalle_update_auth ON public.nota_credito_venta_detalle;
DROP POLICY IF EXISTS nota_credito_detalle_delete_auth ON public.nota_credito_venta_detalle;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'nota_credito_venta_detalle',
    'nota_credito_compra_detalle',
    'guias_devolucion_compra',
    'detalle_guias_devolucion_compra'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_select_auth ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_insert_auth ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_update_auth ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_delete_auth ON public.%I', t, t);

    EXECUTE format('CREATE POLICY %I_select_auth ON public.%I FOR SELECT TO authenticated USING (true)', t, t);
    EXECUTE format('CREATE POLICY %I_insert_auth ON public.%I FOR INSERT TO authenticated WITH CHECK (true)', t, t);
    EXECUTE format('CREATE POLICY %I_update_auth ON public.%I FOR UPDATE TO authenticated USING (true) WITH CHECK (true)', t, t);
    EXECUTE format('CREATE POLICY %I_delete_auth ON public.%I FOR DELETE TO authenticated USING (true)', t, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.nota_credito_venta_detalle      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.nota_credito_compra_detalle     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.guias_devolucion_compra        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.detalle_guias_devolucion_compra TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
-- SELECT table_name FROM information_schema.tables WHERE table_name = 'nota_credito_detalle'; -- debe devolver 0 filas (ya renombrada)
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'nota_credito_venta_detalle' ORDER BY ordinal_position;
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'nota_credito_compra_detalle' ORDER BY ordinal_position;
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'guias_devolucion_compra' ORDER BY ordinal_position;
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'detalle_guias_devolucion_compra' ORDER BY ordinal_position;
-- SELECT polname FROM pg_policies WHERE tablename IN ('nota_credito_venta_detalle','nota_credito_compra_detalle','guias_devolucion_compra','detalle_guias_devolucion_compra');
