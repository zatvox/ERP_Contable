-- ============================================================================
-- 128 · FIX — reposiciones_caja sin ámbito ni empresa  ·  2026-11-01
-- ----------------------------------------------------------------------------
-- Error en pantalla: «column reposiciones_caja.empresa_id does not exist».
--
-- Causa: el filtro multiempresa del ERP intercepta todo .select() sobre las
-- tablas con dueño y les aplica `empresa_id IN (…)`. `reposiciones_caja` entró
-- a esa lista en el front, pero el SQL 124 no le puso la columna: las otras
-- dos (gastos, entregas_a_rendir) sí la tienen.
--
-- Se agregan `ambito` + `empresa_id` con el mismo candado del SQL 123/124, y
-- se heredan de la caja: una reposición es siempre de la caja que repone.
-- IDEMPOTENTE. NO BORRA NADA.
-- ============================================================================

BEGIN;

ALTER TABLE public.reposiciones_caja
  ADD COLUMN IF NOT EXISTS ambito     varchar,
  ADD COLUMN IF NOT EXISTS empresa_id integer REFERENCES public.empresa_config(id),
  ADD COLUMN IF NOT EXISTS sede_id    integer REFERENCES public.sedes(id);

COMMENT ON COLUMN public.reposiciones_caja.ambito IS
  'Se hereda de la caja que se repone. Igual que en gastos: empresa ⟹ empresa_id NOT NULL, familiar ⟹ NULL.';

-- Backfill desde la caja
UPDATE public.reposiciones_caja r
   SET ambito     = COALESCE(r.ambito, b.ambito),
       empresa_id = CASE WHEN COALESCE(r.ambito, b.ambito) = 'familiar' THEN NULL
                         ELSE COALESCE(r.empresa_id, b.empresa_id) END,
       sede_id    = COALESCE(r.sede_id, b.sede_id)
  FROM public.bancos b
 WHERE b.id = r.caja_id AND r.ambito IS NULL;

-- Por si quedara alguna sin caja válida
UPDATE public.reposiciones_caja SET ambito = 'empresa'
 WHERE ambito IS NULL AND empresa_id IS NOT NULL;
UPDATE public.reposiciones_caja SET ambito = 'familiar'
 WHERE ambito IS NULL AND empresa_id IS NULL;

ALTER TABLE public.reposiciones_caja ALTER COLUMN ambito SET NOT NULL;

ALTER TABLE public.reposiciones_caja DROP CONSTRAINT IF EXISTS ck_reposiciones_ambito;
ALTER TABLE public.reposiciones_caja ADD CONSTRAINT ck_reposiciones_ambito CHECK (
  (ambito = 'empresa'  AND empresa_id IS NOT NULL) OR
  (ambito = 'familiar' AND empresa_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_reposiciones_ambito ON public.reposiciones_caja(ambito);

-- La reposición hereda de la caja sin que la UI tenga que acordarse.
CREATE OR REPLACE FUNCTION public.fn_reposicion_heredar_ambito()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_amb varchar; v_emp integer; v_sede integer;
BEGIN
  IF NEW.ambito IS NULL OR NEW.empresa_id IS NULL THEN
    SELECT ambito, empresa_id, sede_id INTO v_amb, v_emp, v_sede
      FROM public.bancos WHERE id = NEW.caja_id;
    NEW.ambito     := COALESCE(NEW.ambito, v_amb, 'empresa');
    NEW.empresa_id := CASE WHEN NEW.ambito = 'familiar' THEN NULL
                           ELSE COALESCE(NEW.empresa_id, v_emp) END;
    NEW.sede_id    := COALESCE(NEW.sede_id, v_sede);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_reposicion_heredar_ambito ON public.reposiciones_caja;
CREATE TRIGGER trg_reposicion_heredar_ambito
  BEFORE INSERT OR UPDATE ON public.reposiciones_caja
  FOR EACH ROW EXECUTE FUNCTION public.fn_reposicion_heredar_ambito();

COMMIT;
NOTIFY pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
SELECT '1. COLUMNAS' AS bloque, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='reposiciones_caja'
   AND column_name IN ('ambito','empresa_id','sede_id') ORDER BY column_name;

SELECT '2. CANDADO' AS bloque, conname, pg_get_constraintdef(oid)
  FROM pg_constraint WHERE conname = 'ck_reposiciones_ambito';

SELECT '3. FILAS' AS bloque, count(*) AS reposiciones FROM public.reposiciones_caja;
