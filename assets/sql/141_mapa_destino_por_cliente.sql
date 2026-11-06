-- ============================================================================
-- 141 · Mapa de entregas: destino aproximado también por el distrito/dirección del cliente
-- 2026-11-06 · Requiere SQL 140. Solo reemplaza crm_mapa_entregas (sin borrar datos). IDEMPOTENTE.
-- Pedidos sin link de Maps ni distrito en el PK ahora usan el distrito/dirección del contacto del cliente.
-- ============================================================================
BEGIN;

-- Entregas del mapa v2
DROP FUNCTION IF EXISTS public.crm_mapa_entregas(integer, integer);
CREATE OR REPLACE FUNCTION public.crm_mapa_entregas(p_empresa integer, p_dias integer DEFAULT 7)
RETURNS TABLE (packing_id bigint, cot_numero text, doc_actual text, doc_tipo text, fecha_doc date, cliente text,
               estado_flujo text, termino_despacho text, distrito text, lat numeric, lng numeric, aprox boolean,
               guia_id bigint, guia text, guia_emitida timestamptz, hora_salida timestamptz, hora_llegada timestamptz,
               total numeric, moneda text, empresa_id integer, empresa_codigo text, empresa_color text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.packing_id, b.cot_numero, b.doc_actual, b.doc_tipo, b.fecha_doc, b.cliente, b.estado_flujo, b.termino_despacho, b.distrito,
         COALESCE(g.punto_llegada_lat, p.despacho_lat, cd.lat), COALESCE(g.punto_llegada_lng, p.despacho_lng, cd.lng),
         (COALESCE(g.punto_llegada_lat, p.despacho_lat) IS NULL AND cd.lat IS NOT NULL),
         g.id, g.numero_guia::text, g.created_at, g.hora_salida, g.hora_llegada, b.total, b.moneda,
         p.empresa_id, ec.codigo::text, ec.color::text
    FROM public.crm_bandeja(p_empresa, true) b
    JOIN public.packing p ON p.id = b.packing_id
    LEFT JOIN public.empresa_config ec ON ec.id = p.empresa_id
    LEFT JOIN public.contacts ct ON ct.id = p.contact_id
    LEFT JOIN LATERAL (
      SELECT gd.id, gd.numero_guia, gd.created_at, gd.hora_salida, gd.hora_llegada, gd.punto_llegada_lat, gd.punto_llegada_lng
        FROM public.guias_despacho_venta gd JOIN public.ventas v ON v.id = gd.venta_id
       WHERE v.packing_id = p.id AND COALESCE(gd.estado, 'emitida') <> 'anulada'
       ORDER BY gd.fecha_guia DESC, gd.id DESC LIMIT 1) g ON true
    LEFT JOIN LATERAL public.fn_centroide_distrito(COALESCE(NULLIF(btrim(b.distrito), ''), NULLIF(btrim(p.despacho_distrito), ''), NULLIF(btrim(COALESCE(ct.distrito, '') || ' ' || COALESCE(ct.direccion, '')), ''))) cd ON true
   WHERE b.packing_id IS NOT NULL AND b.estado_flujo <> 'cotizacion'
     AND (b.estado_flujo <> 'despachado'
          OR COALESCE(g.hora_llegada, g.hora_salida, g.created_at, now()) > now() - make_interval(days => GREATEST(p_dias, 0)))
$$;
REVOKE EXECUTE ON FUNCTION public.crm_mapa_entregas(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_mapa_entregas(integer, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;

SELECT 'OK · crm_mapa_entregas actualizada' AS control;
