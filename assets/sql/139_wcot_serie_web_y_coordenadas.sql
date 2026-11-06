-- ============================================================================
-- 139 · Serie WCOT para cotizaciones WEB + coordenadas de entrega + hora de salida de guía
-- 2026-11-06 · Requiere SQL 131 (crm_cotizaciones) y 136 (packing despacho, guías punto de llegada).
-- ----------------------------------------------------------------------------
--   1. Cotizaciones web pasan de COT-26-00001 a WCOT-26-00001 (para no confundirlas con las
--      COT-0012 del ERP). Se renombran también las ya creadas y los PK que heredaron ese N°.
--   2. packing.despacho_lat/lng y guias_despacho_venta.punto_llegada_lat/lng: coordenadas de la
--      entrega (salen del link de Maps) → alimentan el mapa de camioncitos.
--   3. guias_despacho_venta.hora_salida / hora_llegada: para animar el viaje y medir tiempos reales.
-- NO BORRA NADA. IDEMPOTENTE.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_crm_cot_numero()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.numero IS NULL THEN
    NEW.numero := 'WCOT-' || to_char(now(), 'YY') || '-' || lpad(nextval('public.crm_cotizacion_seq')::text, 5, '0');
  END IF;
  RETURN NEW;
END $$;

UPDATE public.crm_cotizaciones SET numero = 'WCOT-' || substr(numero, 5) WHERE numero LIKE 'COT-__-%';
UPDATE public.packing           SET cot_numero = 'WCOT-' || substr(cot_numero, 5) WHERE cot_numero LIKE 'COT-__-%';

ALTER TABLE public.packing
  ADD COLUMN IF NOT EXISTS despacho_lat numeric, ADD COLUMN IF NOT EXISTS despacho_lng numeric;
ALTER TABLE public.guias_despacho_venta
  ADD COLUMN IF NOT EXISTS punto_llegada_lat numeric, ADD COLUMN IF NOT EXISTS punto_llegada_lng numeric,
  ADD COLUMN IF NOT EXISTS hora_salida timestamptz, ADD COLUMN IF NOT EXISTS hora_llegada timestamptz;

-- 4. Datos del mapa de camioncitos: una fila por entrega con coordenadas, salida y llegada de la última guía vigente
CREATE OR REPLACE FUNCTION public.crm_mapa_entregas(p_empresa integer, p_dias integer DEFAULT 2)
RETURNS TABLE (packing_id bigint, cot_numero text, doc_actual text, cliente text, estado_flujo text, termino_despacho text,
               distrito text, lat numeric, lng numeric, guia text, hora_salida timestamptz, hora_llegada timestamptz, total numeric, moneda text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.packing_id, b.cot_numero, b.doc_actual, b.cliente, b.estado_flujo, b.termino_despacho, b.distrito,
         COALESCE(g.punto_llegada_lat, p.despacho_lat), COALESCE(g.punto_llegada_lng, p.despacho_lng),
         g.numero_guia::text, g.hora_salida, g.hora_llegada, b.total, b.moneda
    FROM public.crm_bandeja(p_empresa, true) b
    JOIN public.packing p ON p.id = b.packing_id
    LEFT JOIN LATERAL (
      SELECT gd.numero_guia, gd.hora_salida, gd.hora_llegada, gd.punto_llegada_lat, gd.punto_llegada_lng
        FROM public.guias_despacho_venta gd JOIN public.ventas v ON v.id = gd.venta_id
       WHERE v.packing_id = p.id AND COALESCE(gd.estado, 'emitida') <> 'anulada'
       ORDER BY gd.fecha_guia DESC, gd.id DESC LIMIT 1) g ON true
   WHERE b.packing_id IS NOT NULL AND b.estado_flujo <> 'cotizacion'
     AND (b.estado_flujo <> 'despachado' OR COALESCE(g.hora_llegada, g.hora_salida, now()) > now() - make_interval(days => GREATEST(p_dias, 0)))
$$;
REVOKE EXECUTE ON FUNCTION public.crm_mapa_entregas(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_mapa_entregas(integer, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;

SELECT 'OK · web: ' || count(*) FILTER (WHERE numero LIKE 'WCOT-%') || ' WCOT, ' || count(*) FILTER (WHERE numero LIKE 'COT-%') || ' sin renombrar' AS control FROM public.crm_cotizaciones
UNION ALL SELECT 'OK · columnas nuevas: ' || count(*) FROM information_schema.columns
 WHERE table_schema='public' AND column_name IN ('despacho_lat','despacho_lng','punto_llegada_lat','punto_llegada_lng','hora_salida','hora_llegada');
