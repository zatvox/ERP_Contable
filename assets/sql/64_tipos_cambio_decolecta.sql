-- ============================================================================
-- 64 · Tipos de cambio SUNAT guardados (caché de Decolecta) — 2026-10-02
-- ----------------------------------------------------------------------------
-- Cada consulta real a Decolecta (/v1/tipo-cambio/sunat?date=) se guarda aquí.
-- Si se vuelve a pedir la misma fecha, el ERP lee esta tabla y NO consume
-- crédito. Las consultas reales se registran en decolecta_consultas_log con
-- tipo 'tc' → cuentan en el mismo contador mensual (100) que RUC/DNI.
-- Ventas usa `venta`, Compras usa `compra` (criterio actual, a revisar con
-- el contador).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.tipos_cambio (
  fecha              date        PRIMARY KEY,          -- fecha pedida por el ERP
  compra             numeric(10,4) NOT NULL CHECK (compra > 0),
  venta              numeric(10,4) NOT NULL CHECK (venta > 0),
  fecha_publicacion  date,                             -- fecha que devolvió SUNAT (puede diferir en feriados)
  moneda             varchar     NOT NULL DEFAULT 'USD',
  fuente             varchar     NOT NULL DEFAULT 'decolecta-sunat',
  created_by         bigint      REFERENCES public.users(id),
  created_at         timestamptz DEFAULT now()
);
COMMENT ON TABLE public.tipos_cambio IS
  'Caché de TC USD/PEN SUNAT por fecha (Decolecta). Una consulta por fecha = 1 crédito; repetirla lee de aquí.';

ALTER TABLE public.tipos_cambio ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tipos_cambio_all_auth ON public.tipos_cambio;
CREATE POLICY tipos_cambio_all_auth ON public.tipos_cambio FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tipos_cambio TO authenticated;

-- El log de consumo acepta también 'tc' (mismo contador que RUC/DNI)
ALTER TABLE public.decolecta_consultas_log DROP CONSTRAINT IF EXISTS decolecta_consultas_log_tipo_check;
ALTER TABLE public.decolecta_consultas_log
  ADD CONSTRAINT decolecta_consultas_log_tipo_check CHECK (tipo IN ('ruc', 'dni', 'tc'));

COMMIT;

-- Verificación
SELECT count(*) AS tc_guardados FROM public.tipos_cambio;
SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'decolecta_consultas_log_tipo_check';
