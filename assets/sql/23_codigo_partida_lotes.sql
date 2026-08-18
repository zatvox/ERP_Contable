-- ============================================================================
-- 23_codigo_partida_lotes.sql
-- Nuevo concepto "código de partida": etiqueta de texto libre y OPCIONAL que
-- agrupa varios lotes recibidos juntos en UNA misma Guía de Remisión (ej.
-- LT.26027-01, LT.26027-02, LT.26027-03... todos con codigo_partida =
-- 'LT.26027'), tal como se ve en Odoo (Movimiento de stock > Número de
-- serie/lote).
--
-- IMPORTANTE: esto NO tiene relación con la tabla public.partidas (Partidas
-- Arancelarias / aduanas), que sigue existiendo intacta con su propio tab
-- CRUD en Inventario > Partidas y su FK lotes.partida_id / detalle_guias_
-- ingreso_compra.partida_id. Son dos conceptos distintos a propósito, por
-- eso el nuevo campo se llama "codigo_partida" (texto libre, no FK) y no
-- reutiliza el nombre "partida_id" para no confundirlos en el código.
-- ============================================================================

ALTER TABLE public.detalle_guias_ingreso_compra
  ADD COLUMN IF NOT EXISTS codigo_partida varchar;

ALTER TABLE public.lotes
  ADD COLUMN IF NOT EXISTS codigo_partida varchar;

COMMENT ON COLUMN public.detalle_guias_ingreso_compra.codigo_partida IS
  'Código de agrupación de lotes (texto libre, opcional). Varios lotes recibidos en la misma guía pueden compartir el mismo codigo_partida, ej. "LT.26027" agrupa LT.26027-01, -02, -03. No confundir con partida_id (Partidas Arancelarias/aduanas).';
COMMENT ON COLUMN public.lotes.codigo_partida IS
  'Copiado desde detalle_guias_ingreso_compra.codigo_partida al crear el lote. Agrupación libre de lotes de una misma recepción, no relacionado con partida_id (aduanas).';

CREATE INDEX IF NOT EXISTS idx_lotes_codigo_partida ON public.lotes(codigo_partida);

-- Verificación
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('detalle_guias_ingreso_compra', 'lotes')
  AND column_name = 'codigo_partida';
