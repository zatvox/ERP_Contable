-- ============================================================================
-- 19_traslados_internos_y_vendedor.sql
-- Etapa 2 de Almacenes: Traslados internos entre zonas (kardex).
-- Además: habilita 'vendedor' como tipo_contacto y agrega ventas.vendedor_id.
-- ============================================================================

-- 1) Kardex: columnas de zona (origen/destino) para trazar traslados
--    internos, además de almacen_id/almacen_destino_id que ya existían
--    (pensados para traslados ENTRE almacenes, con GRE).
ALTER TABLE public.kardex
  ADD COLUMN IF NOT EXISTS ubicacion_id integer REFERENCES public.ubicaciones(id);
ALTER TABLE public.kardex
  ADD COLUMN IF NOT EXISTS ubicacion_destino_id integer REFERENCES public.ubicaciones(id);

-- 2) Nuevo tipo de movimiento 'traslado_interno' (zona a zona, sin GRE,
--    distinto de 'traslado_salida'/'traslado_entrada' que son entre almacenes).
ALTER TABLE public.kardex DROP CONSTRAINT IF EXISTS kardex_tipo_movimiento_check;
ALTER TABLE public.kardex ADD CONSTRAINT kardex_tipo_movimiento_check
  CHECK (tipo_movimiento IN (
    'entrada','salida','ajuste_entrada','ajuste_salida',
    'devolucion_venta','devolucion_compra','traslado_salida','traslado_entrada',
    'traslado_interno'
  ));

-- 3) RLS + GRANTS de kardex (no estaba en el alcance original de los 3
--    módulos porque el tab Kardex Valorizado seguía en standby; ahora se
--    escribe activamente desde Traslados internos).
ALTER TABLE public.kardex ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kardex_select_auth ON public.kardex;
DROP POLICY IF EXISTS kardex_insert_auth ON public.kardex;
DROP POLICY IF EXISTS kardex_update_auth ON public.kardex;
DROP POLICY IF EXISTS kardex_delete_auth ON public.kardex;

CREATE POLICY kardex_select_auth ON public.kardex FOR SELECT TO authenticated USING (true);
CREATE POLICY kardex_insert_auth ON public.kardex FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY kardex_update_auth ON public.kardex FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY kardex_delete_auth ON public.kardex FOR DELETE TO authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.kardex TO authenticated;

-- 4) Habilitar 'vendedor' como tipo_contacto válido (hoy solo permite
--    cliente/proveedor/empleado/otro).
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_tipo_contacto_check;
ALTER TABLE public.contacts ADD CONSTRAINT contacts_tipo_contacto_check
  CHECK (tipo_contacto <@ ARRAY['cliente','proveedor','empleado','otro','vendedor']
         AND array_length(tipo_contacto, 1) >= 1);

-- 5) Campo Vendedor en Ventas (referencia a contacts con tipo_contacto
--    que incluya 'vendedor').
ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS vendedor_id bigint REFERENCES public.contacts(id);

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- Verificación
SELECT tablename, policyname FROM pg_policies WHERE tablename = 'kardex' ORDER BY policyname;
