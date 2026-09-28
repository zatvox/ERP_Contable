-- ============================================================================
-- 56_secuencias_documentos_traslados.sql
-- Correlativo genérico de documento (estilo Odoo: "SJLP/INT/00393") + tabla
-- "Historial de Movimientos" (front): agrupa por número de documento las
-- varias líneas (producto+lote) de un mismo traslado interno.
--
-- Por qué una tabla + función atómica y NO el patrón "max(numero)+1" del
-- cliente (ver generarNumeroVenta en supabase-data.js): ese patrón ya causó
-- una colisión real por UNIQUE constraint cuando dos usuarios generaban el
-- número casi al mismo tiempo. INSERT ... ON CONFLICT DO UPDATE ... RETURNING
-- es atómico a nivel de fila en Postgres — dos llamadas simultáneas nunca
-- pueden devolver el mismo número.
-- ============================================================================

-- 1) Contador por almacén + tipo de documento. Empieza en 0; cada llamada a
--    la función de abajo lo sube en 1 y devuelve el nuevo valor.
CREATE TABLE IF NOT EXISTS public.secuencias_documentos (
  id            bigserial   PRIMARY KEY,
  almacen_id    integer     NOT NULL REFERENCES public.almacenes(id),
  tipo          text        NOT NULL,
  ultimo_numero integer     NOT NULL DEFAULT 0,
  updated_at    timestamptz DEFAULT now(),
  UNIQUE (almacen_id, tipo)
);

COMMENT ON TABLE public.secuencias_documentos IS
  'Contador atómico por almacén+tipo para generar numero_documento (ej. SJLP/INT/00393). Ver fn obtener_siguiente_numero_secuencia.';

-- 2) Función atómica: sube el contador y devuelve el nuevo número en una
--    sola sentencia (INSERT ... ON CONFLICT ... RETURNING), sin condición de
--    carrera posible entre llamadas concurrentes.
CREATE OR REPLACE FUNCTION public.obtener_siguiente_numero_secuencia(p_almacen_id integer, p_tipo text)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_numero integer;
BEGIN
  INSERT INTO public.secuencias_documentos (almacen_id, tipo, ultimo_numero)
  VALUES (p_almacen_id, p_tipo, 1)
  ON CONFLICT (almacen_id, tipo)
  DO UPDATE SET ultimo_numero = public.secuencias_documentos.ultimo_numero + 1,
                updated_at = now()
  RETURNING ultimo_numero INTO v_numero;
  RETURN v_numero;
END;
$$;

-- 3) Columna en kardex para guardar el correlativo ya formateado
--    (ej. "SJLP/INT/00393") — todas las líneas de un mismo traslado
--    comparten el mismo numero_documento, igual que en Odoo.
ALTER TABLE public.kardex ADD COLUMN IF NOT EXISTS numero_documento text;
CREATE INDEX IF NOT EXISTS idx_kardex_numero_documento ON public.kardex(numero_documento);

-- 4) RLS + GRANTS para la tabla nueva (mismo patrón que 18_almacenes_zonas_stock.sql)
ALTER TABLE public.secuencias_documentos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS secuencias_documentos_select_auth ON public.secuencias_documentos;
DROP POLICY IF EXISTS secuencias_documentos_insert_auth ON public.secuencias_documentos;
DROP POLICY IF EXISTS secuencias_documentos_update_auth ON public.secuencias_documentos;
DROP POLICY IF EXISTS secuencias_documentos_delete_auth ON public.secuencias_documentos;

CREATE POLICY secuencias_documentos_select_auth ON public.secuencias_documentos FOR SELECT TO authenticated USING (true);
CREATE POLICY secuencias_documentos_insert_auth ON public.secuencias_documentos FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY secuencias_documentos_update_auth ON public.secuencias_documentos FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY secuencias_documentos_delete_auth ON public.secuencias_documentos FOR DELETE TO authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.secuencias_documentos TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT EXECUTE ON FUNCTION public.obtener_siguiente_numero_secuencia(integer, text) TO authenticated;

-- Verificación
SELECT tablename, policyname FROM pg_policies WHERE tablename = 'secuencias_documentos' ORDER BY policyname;
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'kardex' AND column_name = 'numero_documento';
