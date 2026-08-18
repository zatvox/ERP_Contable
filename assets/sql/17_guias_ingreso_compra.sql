-- ============================================================================
-- 17_guias_ingreso_compra.sql
-- Nuevo flujo: la Compra ya NO genera lote/stock directo. El stock se agrega
-- recién al registrar la Guía de Remisión (recepción física), donde se pide
-- N° de Lote, Marca y Partida por producto.
-- Confirmado contra columnas reales (ver 00_ver_columnas_actuales.sql):
--   - guias_ingreso_compra / detalle_guias_ingreso_compra NO existen aún.
--   - lotes.compra_id YA existe (migración 16). lotes.marca_id NO existe.
--   - detalle_compras NO tiene columna de "unidades" por línea.
-- ============================================================================

-- 1) Marca por lote: la marca real recibida puede diferir de items.marca_id
--    (marca "default" del producto). Se registra la marca real en el lote.
ALTER TABLE public.lotes
  ADD COLUMN IF NOT EXISTS marca_id bigint REFERENCES public.marcas(id);

-- 2) N° de unidades por línea de compra (bultos/cajas), separado de
--    cantidad (peso/medida). Se pidió al registrar la compra.
ALTER TABLE public.detalle_compras
  ADD COLUMN IF NOT EXISTS unidades numeric;

COMMENT ON COLUMN public.detalle_compras.unidades IS
  'N° de unidades físicas (bultos/cajas) de esta línea, informado en la compra. Referencial para la Guía de Remisión.';

-- 3) Cabecera de Guía de Remisión (recepción de mercadería de una compra)
CREATE TABLE IF NOT EXISTS public.guias_ingreso_compra (
  id              bigserial   PRIMARY KEY,
  compra_id       bigint      NOT NULL REFERENCES public.compras(id),
  numero_guia     varchar     NOT NULL,
  fecha_guia      date        NOT NULL,
  observaciones   text,
  created_by      bigint      REFERENCES public.users(id),
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

COMMENT ON TABLE public.guias_ingreso_compra IS
  'Guía de Remisión de recepción de mercadería vinculada a una compra (módulo Compras). No confundir con guias_remision (módulo Costeo Importaciones).';

-- 4) Detalle de la Guía: por cada línea de la compra recibida, se pide
--    N° de Lote (obligatorio), Marca (obligatorio) y Partida (opcional).
--    Al guardar, cada línea genera un registro en "lotes" (aumenta stock).
CREATE TABLE IF NOT EXISTS public.detalle_guias_ingreso_compra (
  id                  bigserial   PRIMARY KEY,
  guia_id             bigint      NOT NULL REFERENCES public.guias_ingreso_compra(id) ON DELETE CASCADE,
  detalle_compra_id   bigint      REFERENCES public.detalle_compras(id),
  item_id             bigint      REFERENCES public.items(id),
  cantidad            numeric     NOT NULL CHECK (cantidad > 0),
  numero_lote         varchar     NOT NULL,
  marca_id            bigint      REFERENCES public.marcas(id),
  partida_id          bigint      REFERENCES public.partidas(id),
  lote_id             bigint      REFERENCES public.lotes(id),
  created_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dgic_guia_id ON public.detalle_guias_ingreso_compra(guia_id);
CREATE INDEX IF NOT EXISTS idx_guias_ingreso_compra_compra_id ON public.guias_ingreso_compra(compra_id);
CREATE INDEX IF NOT EXISTS idx_lotes_marca_id ON public.lotes(marca_id);

-- 5) Trazabilidad directa lote -> guía (además de lote -> compra ya existente)
ALTER TABLE public.lotes
  ADD COLUMN IF NOT EXISTS guia_id bigint REFERENCES public.guias_ingreso_compra(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_lotes_guia_id ON public.lotes(guia_id);

-- 6) RLS + GRANTS (mismo patrón que 15_columnas_rls_grants_3_modulos.sql)
ALTER TABLE public.guias_ingreso_compra ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.detalle_guias_ingreso_compra ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['guias_ingreso_compra', 'detalle_guias_ingreso_compra'])
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.guias_ingreso_compra TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.detalle_guias_ingreso_compra TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- Verificación
SELECT tablename, policyname FROM pg_policies
WHERE tablename IN ('guias_ingreso_compra', 'detalle_guias_ingreso_compra')
ORDER BY tablename, policyname;
