-- ============================================================================
-- 32_guias_despacho_venta.sql
-- Nuevo flujo de Ventas, espejo exacto del flujo que ya existe en Compras
-- (ver 17_guias_ingreso_compra.sql):
--
--   ANTES: Nueva Venta pedía lote+zona por línea y descontaba stock/kardex
--          en el mismo paso que se registraba el comprobante.
--   AHORA: Nueva Venta SOLO registra el comprobante (cliente, líneas con
--          producto/cantidad/precio) — NO mueve stock. El movimiento de
--          stock (elegir lote+zona real, descontar kardex) se hace después,
--          en un paso separado: la Guía de Despacho de Venta. Una venta
--          puede despacharse en varias guías (envíos parciales), igual que
--          una compra puede recibirse en varias guías de ingreso.
--
-- La importación masiva de ventas (procesarImportacionVentas) tampoco va a
-- mover stock de aquí en adelante — solo crea venta + detalle_ventas, igual
-- que procesarImportacionCompras ya hace hoy con las compras. La guía se
-- arma manual después, para ambos módulos por igual.
-- ============================================================================

-- ── 1) Estado de despacho de la venta ───────────────────────────────────────
-- 'pendiente'  = nada despachado todavía (recién creada la venta)
-- 'parcial'    = algunas líneas (o parte de la cantidad de una línea) ya se
--                despacharon, falta el resto
-- 'despachado' = toda la cantidad de todas las líneas ya salió de almacén
ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS estado_despacho varchar NOT NULL DEFAULT 'pendiente'
    CHECK (estado_despacho IN ('pendiente', 'parcial', 'despachado'));

COMMENT ON COLUMN public.ventas.estado_despacho IS
  'Se recalcula al guardar/eliminar una guía de despacho, comparando lo despachado (detalle_guias_despacho_venta) contra detalle_ventas.cantidad.';

-- ── 2) Cabecera de Guía de Despacho de Venta ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guias_despacho_venta (
  id              bigserial   PRIMARY KEY,
  venta_id        bigint      NOT NULL REFERENCES public.ventas(id),
  numero_guia     varchar     NOT NULL,
  fecha_guia      date        NOT NULL,
  observaciones   text,
  created_by      bigint      REFERENCES public.users(id),
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

COMMENT ON TABLE public.guias_despacho_venta IS
  'Guía de Remisión de salida de mercadería vinculada a una venta (módulo Ventas). Espejo de guias_ingreso_compra. Una venta puede tener varias guías (despacho parcial).';

CREATE INDEX IF NOT EXISTS idx_guias_despacho_venta_venta_id ON public.guias_despacho_venta(venta_id);

-- ── 3) Detalle de la Guía: por cada línea despachada se pide lote y zona
-- real (obligatorio), igual que en compras. cantidad_unidades es opcional
-- (igual que en el resto del sistema: dos dimensiones distintas, cantidad
-- en kg vs N° de unidades físicas).
-- ============================================================================
-- IMPORTANTE: detalle_venta_id NO es 1 a 1 con este detalle — una sola línea
-- de venta se puede despachar repartida entre varios lotes (visto en la
-- vida real: una factura de 3,816 kg salió de 9 lotes distintos de 424 kg
-- cada uno). Por eso puede haber varias filas de detalle_guias_despacho_venta
-- para el mismo detalle_venta_id, incluso en guías distintas si el despacho
-- fue parcial en el tiempo.
CREATE TABLE IF NOT EXISTS public.detalle_guias_despacho_venta (
  id                  bigserial   PRIMARY KEY,
  guia_id             bigint      NOT NULL REFERENCES public.guias_despacho_venta(id) ON DELETE CASCADE,
  detalle_venta_id    bigint      REFERENCES public.detalle_ventas(id),
  item_id             bigint      REFERENCES public.items(id),
  cantidad            numeric     NOT NULL CHECK (cantidad > 0),
  cantidad_unidades   numeric     DEFAULT 0,
  numero_lote         varchar     NOT NULL,
  lote_id             bigint      REFERENCES public.lotes(id),
  ubicacion_id        bigint      REFERENCES public.ubicaciones(id),
  created_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dgdv_guia_id ON public.detalle_guias_despacho_venta(guia_id);
CREATE INDEX IF NOT EXISTS idx_dgdv_detalle_venta_id ON public.detalle_guias_despacho_venta(detalle_venta_id);

-- ── 4) Trazabilidad directa detalle_ventas -> lote/zona (referencial, para
-- reportes rápidos "¿qué lote se vendió?" sin tener que ir a la guía).
-- Se llena recién cuando se despacha, por eso queda NULL en ventas nuevas
-- hasta que tengan su guía. Ya eran nullable así que no hace falta ALTER.
-- (detalle_ventas.lote_id y detalle_ventas.ubicacion_id ya existen.)

-- ── 5) RLS + GRANTS (mismo patrón usado en todo el sistema) ────────────────
ALTER TABLE public.guias_despacho_venta ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.detalle_guias_despacho_venta ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['guias_despacho_venta', 'detalle_guias_despacho_venta'])
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.guias_despacho_venta TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.detalle_guias_despacho_venta TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- ── Verificación ─────────────────────────────────────────────────────────
SELECT tablename, policyname FROM pg_policies
WHERE tablename IN ('guias_despacho_venta', 'detalle_guias_despacho_venta')
ORDER BY tablename, policyname;
