-- ============================================================================
-- 146 · Factura: Packing asociado (PK fuera del ERP) + término de despacho
-- (2026-11-07)
--   packing_ref        → N° de PK escrito a mano cuando NO existe en el ERP
--                        (packing_id sigue siendo el FK a un PK del sistema).
--   termino_despacho   → heredado del PK, editable en la factura
--   despacho_direccion / despacho_distrito / despacho_maps_url
-- La obligatoriedad (packing_id o packing_ref) se valida en la app al crear o
-- editar una factura de mercadería: un CHECK en la tabla bloquearía los
-- updates automáticos (estado de despacho, CPE, asientos) de facturas
-- antiguas sin PK.
-- ============================================================================
DO $$
BEGIN
  ALTER TABLE public.ventas ADD COLUMN IF NOT EXISTS packing_ref        varchar(40);
  ALTER TABLE public.ventas ADD COLUMN IF NOT EXISTS termino_despacho   varchar;
  ALTER TABLE public.ventas ADD COLUMN IF NOT EXISTS despacho_direccion varchar;
  ALTER TABLE public.ventas ADD COLUMN IF NOT EXISTS despacho_distrito  varchar;
  ALTER TABLE public.ventas ADD COLUMN IF NOT EXISTS despacho_maps_url  text;

  ALTER TABLE public.ventas DROP CONSTRAINT IF EXISTS ventas_termino_despacho_check;
  ALTER TABLE public.ventas ADD CONSTRAINT ventas_termino_despacho_check
    CHECK (termino_despacho IS NULL OR termino_despacho IN ('recoge_cliente', 'despacho'));

  COMMENT ON COLUMN public.ventas.packing_ref IS 'N° de PK que no existe en el ERP (texto). Si el PK existe se usa packing_id. Ver SQL 146.';
  COMMENT ON COLUMN public.ventas.termino_despacho IS 'Heredado del PK y editable en la factura. La guía de despacho lo toma de aquí primero.';

  -- Facturas que ya vienen de un PK: copiar su término de despacho
  UPDATE public.ventas v
     SET termino_despacho   = p.termino_despacho,
         despacho_direccion = CASE WHEN p.despacho_usa_dir_cliente = false THEN p.despacho_direccion END,
         despacho_distrito  = p.despacho_distrito,
         despacho_maps_url  = p.despacho_maps_url
    FROM public.packing p
   WHERE v.packing_id = p.id AND v.termino_despacho IS NULL AND p.termino_despacho IS NOT NULL;
END $$;

NOTIFY pgrst, 'reload schema';
