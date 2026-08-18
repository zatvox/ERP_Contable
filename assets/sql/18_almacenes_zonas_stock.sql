-- ============================================================================
-- 18_almacenes_zonas_stock.sql
-- Etapa 1 del tab "Almacenes": múltiples almacenes físicos, cada uno con
-- zonas internas (ubicaciones), y una tabla de stock por zona independiente
-- del costeo por lote (un lote puede repartirse entre varias zonas).
--
-- almacenes y ubicaciones YA EXISTEN desde 01_schema.sql pero nunca tuvieron
-- RLS/grants (no estaban en el alcance de los 3 módulos original). Se
-- habilitan aquí porque ahora se usan activamente desde la app.
--
-- Nota del usuario: el sistema sigue en etapa de pruebas, así que NO se hace
-- backfill de stock viejo sin zona — se resuelve manualmente a nivel de BD.
-- ============================================================================

-- 1) Stock por zona: cuánta cantidad de un lote está físicamente en cada
--    ubicación. La suma por lote_id debe igualar lotes.cantidad (se
--    mantiene sincronizado desde la app: recepción, traslado, venta).
CREATE TABLE IF NOT EXISTS public.stock_ubicaciones (
  id            bigserial   PRIMARY KEY,
  lote_id       bigint      NOT NULL REFERENCES public.lotes(id) ON DELETE CASCADE,
  ubicacion_id  integer     NOT NULL REFERENCES public.ubicaciones(id),
  cantidad      numeric     NOT NULL DEFAULT 0 CHECK (cantidad >= 0),
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  UNIQUE (lote_id, ubicacion_id)
);

COMMENT ON TABLE public.stock_ubicaciones IS
  'Cantidad de cada lote presente en cada zona/ubicación. Fuente de verdad para stock por zona; lotes.cantidad sigue siendo el total (costeo).';

CREATE INDEX IF NOT EXISTS idx_stock_ubicaciones_lote_id ON public.stock_ubicaciones(lote_id);
CREATE INDEX IF NOT EXISTS idx_stock_ubicaciones_ubicacion_id ON public.stock_ubicaciones(ubicacion_id);

-- 2) Guía de Remisión: cada recepción indica a qué zona entra el lote.
--    Nullable a propósito (compatibilidad con filas de prueba ya creadas);
--    la app exige el dato desde ahora en adelante.
ALTER TABLE public.detalle_guias_ingreso_compra
  ADD COLUMN IF NOT EXISTS ubicacion_id integer REFERENCES public.ubicaciones(id);

-- 3) RLS + GRANTS para almacenes, ubicaciones (ya existían sin política) y
--    stock_ubicaciones (nueva).
ALTER TABLE public.almacenes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ubicaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_ubicaciones ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['almacenes', 'ubicaciones', 'stock_ubicaciones'])
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.almacenes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ubicaciones TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_ubicaciones TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- Verificación
SELECT tablename, policyname FROM pg_policies
WHERE tablename IN ('almacenes', 'ubicaciones', 'stock_ubicaciones')
ORDER BY tablename, policyname;
