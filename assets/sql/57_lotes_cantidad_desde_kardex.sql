-- ============================================================================
-- 57_lotes_cantidad_desde_kardex.sql · 2026-09-25
-- lotes.cantidad / lotes.cantidad_unidades pasan a ser DERIVADOS del kardex.
--
-- Enfoque elegido por Luis: TRIGGER (no vista). La columna se queda en la
-- tabla — las ~80 lecturas en JS siguen igual — pero la BD la mantiene sola:
--   · kardex  AFTER  INSERT/UPDATE/DELETE → recalcula el lote afectado.
--   · lotes   BEFORE INSERT/UPDATE        → ignora lo que mande el JS y pone
--                                           el valor del kardex.
-- Resultado: aunque algún flujo JS escriba mal lotes.cantidad (o falle a
-- medias), el valor guardado SIEMPRE es el del kardex. Las escrituras
-- manuales que aún hace el JS quedan como no-ops (igual que pasó con
-- addStockUbicacion tras la migración 50) → rollback trivial.
--
-- Regla de cálculo = misma que la vista stock_ubicaciones:
--   entra si ubicacion_destino es zona REAL · sale si ubicacion_origen es zona REAL
--   (Partners/* virtuales no cuentan; traslado_interno neto 0).
-- Diferencia con la vista: aquí NO se recorta a 0 → un negativo queda visible.
--
-- ORDEN DE EJECUCIÓN:
--   0) fix_lote_MB31516.sql   (ya entregado)
--   1) 57a_diagnostico…       (solo lectura, revisar)
--   2) 57b_backfill_unidades… (preview → aplicar)
--   3) ESTE archivo
--   Rollback: 57_rollback_lotes_cantidad_desde_kardex.sql
-- ============================================================================
BEGIN;

-- 1) Respaldo de los valores actuales (para auditoría / rollback)
CREATE TABLE IF NOT EXISTS public._bk_lotes_cantidad_20260925 AS
  SELECT id, cantidad, cantidad_unidades, now() AS respaldado_en FROM public.lotes;
COMMENT ON TABLE public._bk_lotes_cantidad_20260925 IS
  'Respaldo de lotes.cantidad/cantidad_unidades antes de 57_lotes_cantidad_desde_kardex.sql. No borrar sin confirmar con Luis.';

-- 2) Índices para que el recálculo por lote sea instantáneo
CREATE INDEX IF NOT EXISTS idx_kardex_lote_id ON public.kardex(lote_id);

-- 3) Stock de un lote según kardex
CREATE OR REPLACE FUNCTION public.fn_lote_stock_kardex(p_lote_id bigint,
  OUT kg numeric, OUT uds numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH reales AS (
    SELECT u.id FROM ubicaciones u JOIN almacenes a ON a.id = u.almacen_id WHERE NOT a.es_virtual
  )
  SELECT
    COALESCE(ROUND(SUM(
        CASE WHEN k.ubicacion_destino_id IN (SELECT id FROM reales) THEN k.cantidad_entrada ELSE 0 END
      - CASE WHEN k.ubicacion_origen_id  IN (SELECT id FROM reales) THEN k.cantidad_salida  ELSE 0 END)::numeric, 4), 0),
    COALESCE(ROUND(SUM(
        CASE WHEN k.ubicacion_destino_id IN (SELECT id FROM reales) THEN k.cantidad_unidades_entrada ELSE 0 END
      - CASE WHEN k.ubicacion_origen_id  IN (SELECT id FROM reales) THEN k.cantidad_unidades_salida  ELSE 0 END)::numeric, 4), 0)
  FROM kardex k
  WHERE k.lote_id = p_lote_id;
$$;

-- 4) lotes BEFORE INSERT/UPDATE: la cantidad SIEMPRE sale del kardex
CREATE OR REPLACE FUNCTION public.trg_lotes_cantidad_desde_kardex()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Un lote recién creado todavía no puede tener kardex (FK): nace en 0 y
    -- sube cuando se inserte su fila de entrada en kardex.
    NEW.cantidad := 0;
    NEW.cantidad_unidades := 0;
  ELSE
    SELECT s.kg, s.uds INTO NEW.cantidad, NEW.cantidad_unidades
    FROM public.fn_lote_stock_kardex(NEW.id) s;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS lotes_cantidad_desde_kardex ON public.lotes;
CREATE TRIGGER lotes_cantidad_desde_kardex
  BEFORE INSERT OR UPDATE ON public.lotes
  FOR EACH ROW EXECUTE FUNCTION public.trg_lotes_cantidad_desde_kardex();

-- 5) kardex AFTER INSERT/UPDATE/DELETE: toca el lote para que se recalcule
CREATE OR REPLACE FUNCTION public.trg_kardex_sync_lote()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP IN ('INSERT','UPDATE') AND NEW.lote_id IS NOT NULL THEN
    UPDATE public.lotes SET updated_at = now() WHERE id = NEW.lote_id;   -- el BEFORE de lotes recalcula
  END IF;
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.lote_id IS NOT NULL
     AND (TG_OP = 'DELETE' OR OLD.lote_id IS DISTINCT FROM NEW.lote_id) THEN
    UPDATE public.lotes SET updated_at = now() WHERE id = OLD.lote_id;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS kardex_sync_lote ON public.kardex;
CREATE TRIGGER kardex_sync_lote
  AFTER INSERT OR DELETE OR UPDATE OF lote_id, cantidad_entrada, cantidad_salida,
        cantidad_unidades_entrada, cantidad_unidades_salida, ubicacion_origen_id, ubicacion_destino_id
  ON public.kardex
  FOR EACH ROW EXECUTE FUNCTION public.trg_kardex_sync_lote();

-- 6) Reconciliación: recalcula TODOS los lotes una vez (kardex manda)
UPDATE public.lotes SET updated_at = updated_at;

-- 7) Candado: si algún lote queda negativo, se aborta todo (nada se aplica)
DO $$
DECLARE v_neg text;
BEGIN
  SELECT string_agg(numero_lote || ' (id ' || id || ': ' || cantidad || ' kg / ' || cantidad_unidades || ' ud)', ', ')
    INTO v_neg
  FROM public.lotes WHERE cantidad < -0.0001 OR cantidad_unidades < -0.0001;
  IF v_neg IS NOT NULL THEN
    RAISE EXCEPTION 'Migración 57 abortada: lotes negativos según kardex → %. Corregir kardex primero (ver 57a).', v_neg;
  END IF;
END $$;

COMMIT;

-- ── VERIFICACIÓN (fuera de la transacción) ─────────────────────────────────
-- a) Qué cambió respecto al respaldo
SELECT l.id, l.numero_lote, b.cantidad AS kg_antes, l.cantidad AS kg_ahora,
       b.cantidad_unidades AS ud_antes, l.cantidad_unidades AS ud_ahora
FROM public.lotes l JOIN public._bk_lotes_cantidad_20260925 b ON b.id = l.id
WHERE ABS(b.cantidad - l.cantidad) > 0.01 OR ABS(b.cantidad_unidades - l.cantidad_unidades) > 0.01
ORDER BY ABS(b.cantidad - l.cantidad) DESC;
