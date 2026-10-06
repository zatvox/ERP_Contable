-- ============================================================================
-- 66_familias_lotes.sql  (2026-10-05)
-- Familias: agrupación comercial libre de lotes (ej. "10/1 Spun colores")
-- para ver en Resumen de Stock una sola fila con kg/unidades sumados y
-- costo / peso por unidad promediados. Solo es una capa de VISTA: no toca
-- kardex, costeo ni contabilidad.
--
-- Un "lote" aquí = Producto + N° de Lote (texto), igual que la fila de
-- "Por Ubicación": así cubre todos los ingresos (lotes.id) de ese N° de lote,
-- incluidos ingresos futuros con el mismo número.
-- Un lote pertenece a UNA sola familia (UNIQUE item_id + numero_lote).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.familias (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre      varchar NOT NULL UNIQUE CHECK (nombre <> ''),
  descripcion text,
  activo      boolean DEFAULT true,
  created_by  bigint REFERENCES public.users(id),
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.familia_lotes (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  familia_id   bigint  NOT NULL REFERENCES public.familias(id) ON DELETE CASCADE,
  item_id      bigint  NOT NULL REFERENCES public.items(id),
  numero_lote  varchar NOT NULL,
  created_at   timestamptz DEFAULT now(),
  CONSTRAINT familia_lotes_lote_unico UNIQUE (item_id, numero_lote)
);
CREATE INDEX IF NOT EXISTS idx_familia_lotes_familia ON public.familia_lotes(familia_id);

COMMENT ON TABLE public.familias IS 'Agrupación comercial libre de lotes (vista de Resumen de Stock).';
COMMENT ON TABLE public.familia_lotes IS 'Lotes (producto + N° lote texto) que pertenecen a una familia. Un lote = una sola familia.';

ALTER TABLE public.familias      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.familia_lotes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS familias_all_auth ON public.familias;
CREATE POLICY familias_all_auth ON public.familias FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS familia_lotes_all_auth ON public.familia_lotes;
CREATE POLICY familia_lotes_all_auth ON public.familia_lotes FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.familias, public.familia_lotes TO authenticated;

COMMIT;
