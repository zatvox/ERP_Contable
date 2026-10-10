-- ============================================================================
-- 82 — pdt621_declaraciones (2026-10-09)
-- Guarda por período (AAAA-MM) los datos que NO salen del sistema y lo que se
-- DECLARÓ en SUNAT, para comparar "Sistema vs Declarado" en
-- Contabilidad → Reportes → PDT 621.
--   manual   : saldos de arrastre e inputs (145, 168, 171, 176, 179, 303, 315, 380…)
--   declarado: casillas tal como salen en la constancia del PDT 621
-- Seed: julio 2026 (constancia N° Orden 1200703764, presentada 12/08/2026).
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pdt621_declaraciones (
  periodo        varchar(7)  PRIMARY KEY CHECK (periodo ~ '^\d{4}-\d{2}$'),
  manual         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  declarado      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  numero_orden   varchar,
  fecha_presentacion date,
  updated_at     timestamptz DEFAULT now()
);
ALTER TABLE public.pdt621_declaraciones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pdt621_all_auth ON public.pdt621_declaraciones;
CREATE POLICY pdt621_all_auth ON public.pdt621_declaraciones FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pdt621_declaraciones TO authenticated;

INSERT INTO public.pdt621_declaraciones (periodo, numero_orden, fecha_presentacion, manual, declarado)
VALUES ('2026-07', '1200703764', '2026-08-12',
  '{"145":123798,"168":166632,"171":0,"176":24991,"179":0,"303":29068,"315":1.5,"380":0}'::jsonb,
  '{"100":484137,"101":87145,"102":0,"103":0,"106":0,"105":0,"109":0,"112":0,"131":87145,
    "107":304902,"108":54882,"110":0,"111":0,"113":0,"114":0,"115":0,"120":172391,"122":104,"178":54882,
    "301":484137,"380":0,"315":1.5,"894":0.015,"312":7262,
    "140":32263,"145":123798,"184":-91535,"168":166632,"164":166632,"176":24991,"165":24991,
    "302":7262,"303":29068,"304":-21806,"681":0,"682":0,"188":0,"324":0}'::jsonb)
ON CONFLICT (periodo) DO NOTHING;

SELECT periodo, numero_orden, declarado->>'100' AS c100, declarado->>'107' AS c107 FROM public.pdt621_declaraciones;
