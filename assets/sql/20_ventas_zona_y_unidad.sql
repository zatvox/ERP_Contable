-- ============================================================================
-- 20_ventas_zona_y_unidad.sql
-- Etapa 3 de Almacenes: Ventas por Zona.
-- Agrega la columna que faltaba para registrar de qué Zona (ubicación)
-- salió el stock vendido en cada línea de venta. unidad_medida ya existe
-- en detalle_ventas (NOT NULL DEFAULT 'KG') — no requiere cambio de schema,
-- solo se corrige en el JS para dejar de mandar siempre 'KG'.
-- ============================================================================

ALTER TABLE public.detalle_ventas
  ADD COLUMN IF NOT EXISTS ubicacion_id bigint REFERENCES public.ubicaciones(id);

-- detalle_ventas ya tiene RLS/grants heredados de la tabla base (01_schema.sql);
-- agregar una columna nullable no requiere tocar políticas.

-- Verificación
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'detalle_ventas'
ORDER BY ordinal_position;
