-- ============================================================================
-- 69_preferencias_reporte.sql  (2026-10-06)
-- Vista predeterminada por USUARIO y por REPORTE del motor de reportes
-- (reportes.js): agrupar por, columnas, orden, granularidad de fecha y
-- filtros (incluidas fechas). Botón "⭐ Guardar vista" / "✕ Quitar vista".
-- Una sola vista por usuario+reporte (UNIQUE). Se guarda como JSON.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.preferencias_reporte (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint  NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reporte_id  varchar NOT NULL,                 -- ej. 'repv-vendedor', 'repv-lote'
  estado      jsonb   NOT NULL,
  updated_at  timestamptz DEFAULT now(),
  CONSTRAINT preferencias_reporte_unica UNIQUE (user_id, reporte_id)
);

COMMENT ON TABLE public.preferencias_reporte IS 'Vista guardada (filtros/agrupación/columnas) de cada reporte, por usuario.';

ALTER TABLE public.preferencias_reporte ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS preferencias_reporte_all_auth ON public.preferencias_reporte;
CREATE POLICY preferencias_reporte_all_auth ON public.preferencias_reporte FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.preferencias_reporte TO authenticated;

COMMIT;
