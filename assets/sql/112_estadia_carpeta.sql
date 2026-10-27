-- ============================================================================
-- 112_estadia_carpeta.sql  (2026-10-27)
-- SOLO ESTRUCTURA. Control de ESTADÍA de la carpeta:
--   · contenedor (naviera): días libres desde la descarga hasta devolver el vacío
--   · almacenaje (terminal / depósito temporal): días libres hasta el retiro
-- La constancia oficial (aviso de llegada, SUNAT/terminal) va en adjuntos
-- (entidad 'carpeta_importacion', concepto 'estadia'). Aditivo. Idempotente.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.importacion_estadia (
  id                      bigserial PRIMARY KEY,
  carpeta_importacion_id  bigint NOT NULL REFERENCES public.carpetas_importacion(id) ON DELETE CASCADE,
  fecha_descarga          date,
  -- Contenedor (naviera)
  contenedor_nro          varchar,
  dias_libres_contenedor  integer CHECK (dias_libres_contenedor IS NULL OR dias_libres_contenedor >= 0),
  tarifa_dia_contenedor   numeric,
  fecha_devolucion_vacio  date,
  -- Almacenaje (terminal / depósito temporal)
  deposito_nombre         varchar,
  dias_libres_almacen     integer CHECK (dias_libres_almacen IS NULL OR dias_libres_almacen >= 0),
  tarifa_dia_almacen      numeric,
  fecha_retiro            date,
  fuente                  varchar,       -- ej. «Aviso de llegada ONE», «SUNAT - consulta de manifiesto»
  observaciones           text,
  created_by              bigint REFERENCES public.users(id),
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_estadia_carpeta ON public.importacion_estadia(carpeta_importacion_id);

DROP TRIGGER IF EXISTS trg_estadia_touch ON public.importacion_estadia;
CREATE TRIGGER trg_estadia_touch BEFORE UPDATE ON public.importacion_estadia
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();

ALTER TABLE public.importacion_estadia ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON public.importacion_estadia;
CREATE POLICY "authenticated_all" ON public.importacion_estadia FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.importacion_estadia TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.importacion_estadia_id_seq TO authenticated;

ALTER TABLE public.adjuntos DROP CONSTRAINT IF EXISTS adjuntos_concepto_check;
ALTER TABLE public.adjuntos ADD CONSTRAINT adjuntos_concepto_check
  CHECK (concepto IN ('voucher','recibo','dietario','otro','swift','correo','certificado_origen','ficha_tecnica','contrato',
                      'proforma','invoice','bl','packing','poliza','dam','autoliquidacion','boletin',
                      'notificacion_aduana','garantia','dam_completa','liquidacion','factura_gasto','rh','guia','estadia'));
COMMIT;
