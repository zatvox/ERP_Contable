-- 149 · Alineación del logo en los PDF (2026-11-09): left | center | right
ALTER TABLE public.empresa_config ADD COLUMN IF NOT EXISTS logo_align varchar NOT NULL DEFAULT 'left';
ALTER TABLE public.empresa_config DROP CONSTRAINT IF EXISTS empresa_config_logo_align_check;
ALTER TABLE public.empresa_config ADD CONSTRAINT empresa_config_logo_align_check CHECK (logo_align IN ('left', 'center', 'right'));
NOTIFY pgrst, 'reload schema';
