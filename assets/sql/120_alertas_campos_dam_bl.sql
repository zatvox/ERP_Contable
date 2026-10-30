-- ============================================================================
-- 120_alertas_campos_dam_bl.sql  (2026-10-30)
-- Campos para que las alertas de la carpeta se CALCULEN desde datos registrados:
--   dams: ultimo_dia_pago, puerto_origen, nave, tlc_aplica (ad valorem liberado por TLC)
--   bill_of_ladings: puerto_embarque, puerto_descarga
-- carpeta_observaciones: codigo (regla) para recordar «resuelta» y quitar las
-- filas sembradas a mano (origen 'registro'): ahora las alertas se calculan.
-- Aditivo e idempotente.
-- ============================================================================
BEGIN;

ALTER TABLE public.dams ADD COLUMN IF NOT EXISTS ultimo_dia_pago date;
ALTER TABLE public.dams ADD COLUMN IF NOT EXISTS puerto_origen   varchar;
ALTER TABLE public.dams ADD COLUMN IF NOT EXISTS nave            varchar;
ALTER TABLE public.dams ADD COLUMN IF NOT EXISTS tlc_aplica      boolean DEFAULT false;

ALTER TABLE public.bill_of_ladings ADD COLUMN IF NOT EXISTS puerto_embarque varchar;
ALTER TABLE public.bill_of_ladings ADD COLUMN IF NOT EXISTS puerto_descarga varchar;

ALTER TABLE public.carpeta_observaciones ADD COLUMN IF NOT EXISTS codigo varchar;
CREATE UNIQUE INDEX IF NOT EXISTS uq_carpobs_codigo ON public.carpeta_observaciones(carpeta_id, codigo) WHERE codigo IS NOT NULL;

DELETE FROM public.carpeta_observaciones WHERE origen = 'registro';

COMMIT;
NOTIFY pgrst, 'reload schema';

SELECT 'dams' AS tabla, column_name FROM information_schema.columns
 WHERE table_name = 'dams' AND column_name IN ('ultimo_dia_pago','puerto_origen','nave','tlc_aplica')
UNION ALL
SELECT 'bill_of_ladings', column_name FROM information_schema.columns
 WHERE table_name = 'bill_of_ladings' AND column_name IN ('puerto_embarque','puerto_descarga')
UNION ALL
SELECT 'carpeta_observaciones', column_name FROM information_schema.columns
 WHERE table_name = 'carpeta_observaciones' AND column_name = 'codigo';
