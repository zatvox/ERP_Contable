-- ============================================================================
-- 47_DECOLECTA_CONSULTAS.SQL — Contador de consultas RUC/DNI vía Decolecta API
-- ============================================================================
-- Contexto (decidido con el usuario):
--   Se habilita Decolecta (https://decolecta.com) como fuente principal para
--   consultar RUC/DNI en Compras/Ventas, con APIs.pe como respaldo si
--   Decolecta falla o se acabó la cuota del mes (implementado en
--   assets/js/sunat-api.js). El token va en assets/js/config.js →
--   SUNAT_CONFIG.DECOLECTA_TOKEN (NO se sube a git).
--
--   Decolecta NO expone un endpoint de "cuota restante" ni un header estándar
--   de rate-limit — la única forma confiable de mostrar "cuántas consultas
--   quedan este mes" es que el propio ERP lleve la cuenta.
--
-- Diseño:
--   1) decolecta_consultas_log: una fila por cada llamada real que SÍ llegó a
--      pegarle a la API de Decolecta (sea que encontró el RUC/DNI o no — un
--      422 "ruc no válido" igual consume cuota porque la llamada se hizo).
--      No se cuentan aquí los rechazos locales (ej. "el RUC debe tener 11
--      dígitos") porque esos nunca salen del navegador.
--   2) decolecta_uso_ajuste: un ajuste manual por periodo (YYYY-MM) para
--      arrancar el contador sincronizado con el consumo real de la cuenta
--      cuando el usuario ya había gastado consultas ANTES de que este
--      contador existiera (o para corregir el conteo si Decolecta y el ERP
--      se desincronizan por cualquier motivo). Total del mes = ajuste_manual
--      + COUNT(log del mismo periodo).
--   Semilla: al 2026-08-26 el usuario confirmó 22/100 consultas ya
--   consumidas este mes en su cuenta de Decolecta → se precarga el ajuste
--   del periodo 2026-08 en 22, límite mensual 100 (plan gratuito).
--
-- Idempotente.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.decolecta_consultas_log (
  id              bigserial   PRIMARY KEY,
  tipo            varchar     NOT NULL CHECK (tipo IN ('ruc', 'dni')),
  numero          varchar     NOT NULL,
  exitosa         boolean     NOT NULL DEFAULT true,
  mensaje_error   text,
  origen_modulo   varchar,    -- 'compras' | 'ventas' | etc. (informativo)
  created_by      bigint      REFERENCES public.users(id),
  created_at      timestamptz DEFAULT now()
);

COMMENT ON TABLE public.decolecta_consultas_log IS
  'Una fila por cada llamada real a la API de Decolecta (RUC o DNI) que efectivamente salió del navegador y consumió cuota del plan mensual, haya encontrado el documento o no.';

CREATE INDEX IF NOT EXISTS idx_decolecta_log_created ON public.decolecta_consultas_log(created_at);
CREATE INDEX IF NOT EXISTS idx_decolecta_log_tipo    ON public.decolecta_consultas_log(tipo);

CREATE TABLE IF NOT EXISTS public.decolecta_uso_ajuste (
  periodo         varchar(7)  PRIMARY KEY,  -- 'YYYY-MM'
  ajuste_manual   integer     NOT NULL DEFAULT 0,
  limite_mensual  integer     NOT NULL DEFAULT 100,
  nota            text,
  updated_at      timestamptz DEFAULT now()
);

COMMENT ON TABLE public.decolecta_uso_ajuste IS
  'Ajuste manual por periodo para que el contador del ERP arranque sincronizado con el consumo real de la cuenta Decolecta (consultas hechas antes de existir este log, o correcciones). Total usado en el periodo = ajuste_manual + COUNT(decolecta_consultas_log del mismo periodo).';

ALTER TABLE public.decolecta_consultas_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.decolecta_uso_ajuste    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS decolecta_consultas_log_select_auth ON public.decolecta_consultas_log;
DROP POLICY IF EXISTS decolecta_consultas_log_insert_auth ON public.decolecta_consultas_log;
DROP POLICY IF EXISTS decolecta_uso_ajuste_select_auth     ON public.decolecta_uso_ajuste;
DROP POLICY IF EXISTS decolecta_uso_ajuste_insert_auth     ON public.decolecta_uso_ajuste;
DROP POLICY IF EXISTS decolecta_uso_ajuste_update_auth     ON public.decolecta_uso_ajuste;

CREATE POLICY decolecta_consultas_log_select_auth ON public.decolecta_consultas_log FOR SELECT TO authenticated USING (true);
CREATE POLICY decolecta_consultas_log_insert_auth ON public.decolecta_consultas_log FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY decolecta_uso_ajuste_select_auth ON public.decolecta_uso_ajuste FOR SELECT TO authenticated USING (true);
CREATE POLICY decolecta_uso_ajuste_insert_auth ON public.decolecta_uso_ajuste FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY decolecta_uso_ajuste_update_auth ON public.decolecta_uso_ajuste FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON public.decolecta_consultas_log TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.decolecta_uso_ajuste TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- Semilla del mes en curso (confirmada con el usuario el 2026-08-26).
-- Si vuelves a correr esta migración más adelante, este INSERT no pisa el
-- valor si ya existe (ON CONFLICT DO NOTHING) — para corregirlo a mano usa
-- UPDATE directo sobre decolecta_uso_ajuste.
INSERT INTO public.decolecta_uso_ajuste (periodo, ajuste_manual, limite_mensual, nota)
VALUES ('2026-08', 22, 100, 'Semilla inicial: consumo real ya gastado en la cuenta Decolecta antes de activar este contador, confirmado por el usuario el 2026-08-26.')
ON CONFLICT (periodo) DO NOTHING;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'decolecta_consultas_log' ORDER BY ordinal_position;
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'decolecta_uso_ajuste' ORDER BY ordinal_position;
-- SELECT * FROM public.decolecta_uso_ajuste;
-- SELECT polname FROM pg_policies WHERE tablename IN ('decolecta_consultas_log', 'decolecta_uso_ajuste');
