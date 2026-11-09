-- 148 · Tamaño del logo en los PDF (2026-11-09)
-- Alto máximo del logo en px (el ancho está topado en 200 px por el formato).
-- 70 = tamaño de siempre. Logos sin letras (cuadrados, ej. BENJI) lucen mejor más grandes.
ALTER TABLE public.empresa_config ADD COLUMN IF NOT EXISTS logo_alto smallint NOT NULL DEFAULT 70;
ALTER TABLE public.empresa_config DROP CONSTRAINT IF EXISTS empresa_config_logo_alto_check;
ALTER TABLE public.empresa_config ADD CONSTRAINT empresa_config_logo_alto_check CHECK (logo_alto BETWEEN 40 AND 150);
NOTIFY pgrst, 'reload schema';
