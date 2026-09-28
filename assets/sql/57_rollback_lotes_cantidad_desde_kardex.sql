-- ============================================================================
-- ROLLBACK de 57_lotes_cantidad_desde_kardex.sql
-- Quita los triggers. El JS sigue escribiendo lotes.cantidad a mano (esas
-- escrituras no se eliminaron), así que el ERP sigue funcionando igual que
-- antes de la migración.
-- Opcional (paso 3): devolver los valores exactos que había antes.
-- ============================================================================
BEGIN;
DROP TRIGGER IF EXISTS kardex_sync_lote ON public.kardex;
DROP TRIGGER IF EXISTS lotes_cantidad_desde_kardex ON public.lotes;
DROP FUNCTION IF EXISTS public.trg_kardex_sync_lote();
DROP FUNCTION IF EXISTS public.trg_lotes_cantidad_desde_kardex();
DROP FUNCTION IF EXISTS public.fn_lote_stock_kardex(bigint);

-- 3) OPCIONAL — restaurar valores previos (descomentar si se quiere volver
--    EXACTAMENTE al estado anterior, incluidos sus descuadres):
-- UPDATE public.lotes l SET cantidad = b.cantidad, cantidad_unidades = b.cantidad_unidades
--   FROM public._bk_lotes_cantidad_20260925 b WHERE b.id = l.id;
COMMIT;
