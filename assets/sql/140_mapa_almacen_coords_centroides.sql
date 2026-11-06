-- ============================================================================
-- 140 · Mapa de entregas v2: coordenadas del almacén, centroides de distritos, datos ampliados
-- 2026-11-06 · Requiere SQL 87 (almacenes por empresa), 136 y 139.
-- ----------------------------------------------------------------------------
--   1. almacenes.lat / lng: ubicación exacta (se elige en el mapa desde el modal "Editar almacén").
--   2. distritos_lima_centroide: centro aproximado de cada distrito → pedidos antiguos sin link de Maps
--      salen en el mapa como "ubicación aprox.".
--   3. crm_mapa_origen(empresa): ALM-01 de la empresa → si no tiene coordenadas, distrito de la dirección fiscal (aprox).
--   4. crm_mapa_entregas v2: + empresa (código/color), último documento y su fecha, fecha/hora de emisión de la guía,
--      ubicación aproximada, 7 días por defecto.
-- NO BORRA DATOS. IDEMPOTENTE (solo reemplaza la función del mapa, que cambia de columnas).
-- ============================================================================
BEGIN;

ALTER TABLE public.almacenes ADD COLUMN IF NOT EXISTS lat numeric, ADD COLUMN IF NOT EXISTS lng numeric;

CREATE TABLE IF NOT EXISTS public.distritos_lima_centroide (
  clave text PRIMARY KEY,            -- nombre normalizado (minúsculas, sin tildes)
  distrito text NOT NULL, lat numeric NOT NULL, lng numeric NOT NULL
);
ALTER TABLE public.distritos_lima_centroide ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS distritos_centroide_lee ON public.distritos_lima_centroide;
CREATE POLICY distritos_centroide_lee ON public.distritos_lima_centroide FOR SELECT TO authenticated USING (true);

INSERT INTO public.distritos_lima_centroide (clave, distrito, lat, lng) VALUES
 ('san juan de lurigancho','San Juan de Lurigancho',-11.9770,-77.0080),('sjl','San Juan de Lurigancho',-11.9770,-77.0080),('lima','Lima (Cercado)',-12.0464,-77.0428),
 ('cercado de lima','Lima (Cercado)',-12.0464,-77.0428),('ate','Ate',-12.0260,-76.9180),('santa anita','Santa Anita',-12.0450,-76.9700),
 ('el agustino','El Agustino',-12.0420,-77.0100),('la victoria','La Victoria',-12.0650,-77.0170),('san luis','San Luis',-12.0760,-76.9970),
 ('brena','Breña',-12.0580,-77.0510),('rimac','Rímac',-12.0290,-77.0430),('san martin de porres','San Martín de Porres',-12.0000,-77.0850),
 ('los olivos','Los Olivos',-11.9700,-77.0700),('independencia','Independencia',-11.9900,-77.0540),('comas','Comas',-11.9400,-77.0600),
 ('carabayllo','Carabayllo',-11.8600,-77.0400),('puente piedra','Puente Piedra',-11.8650,-77.0750),('ancon','Ancón',-11.7730,-77.1750),
 ('santa rosa','Santa Rosa',-11.8000,-77.1700),('callao','Callao',-12.0560,-77.1180),('bellavista','Bellavista',-12.0600,-77.1250),
 ('la perla','La Perla',-12.0690,-77.1180),('la punta','La Punta',-12.0720,-77.1640),('carmen de la legua','Carmen de la Legua',-12.0430,-77.0950),
 ('ventanilla','Ventanilla',-11.8700,-77.1250),('san miguel','San Miguel',-12.0780,-77.0900),('pueblo libre','Pueblo Libre',-12.0720,-77.0630),
 ('magdalena del mar','Magdalena del Mar',-12.0900,-77.0720),('jesus maria','Jesús María',-12.0700,-77.0500),('lince','Lince',-12.0850,-77.0340),
 ('san isidro','San Isidro',-12.0980,-77.0360),('miraflores','Miraflores',-12.1210,-77.0300),('san borja','San Borja',-12.1050,-76.9990),
 ('surquillo','Surquillo',-12.1110,-77.0100),('barranco','Barranco',-12.1400,-77.0200),('chorrillos','Chorrillos',-12.1700,-77.0100),
 ('santiago de surco','Santiago de Surco',-12.1450,-76.9930),('surco','Santiago de Surco',-12.1450,-76.9930),('la molina','La Molina',-12.0860,-76.9060),
 ('cieneguilla','Cieneguilla',-12.1100,-76.8100),('chaclacayo','Chaclacayo',-11.9750,-76.7670),('lurigancho chosica','Lurigancho-Chosica',-11.9400,-76.7000),
 ('chosica','Lurigancho-Chosica',-11.9400,-76.7000),('huachipa','Huachipa',-11.9200,-76.9300),('villa el salvador','Villa El Salvador',-12.2120,-76.9360),
 ('villa maria del triunfo','Villa María del Triunfo',-12.1650,-76.9400),('san juan de miraflores','San Juan de Miraflores',-12.1550,-76.9700),
 ('lurin','Lurín',-12.2750,-76.8700),('pachacamac','Pachacámac',-12.2300,-76.8600)
ON CONFLICT (clave) DO NOTHING;

-- Busca el centroide cuyo nombre aparece dentro del texto (gana el nombre más largo).
CREATE OR REPLACE FUNCTION public.fn_centroide_distrito(p_texto text)
RETURNS TABLE (lat numeric, lng numeric) LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT c.lat, c.lng FROM public.distritos_lima_centroide c
   WHERE btrim(COALESCE(p_texto,'')) <> ''
     AND lower(translate(p_texto, 'áéíóúñÁÉÍÓÚÑ', 'aeiounaeioun')) LIKE '%' || c.clave || '%'
   ORDER BY length(c.clave) DESC LIMIT 1
$$;

-- Origen del mapa por empresa
DROP FUNCTION IF EXISTS public.crm_mapa_origen(integer);
CREATE OR REPLACE FUNCTION public.crm_mapa_origen(p_empresa integer)
RETURNS TABLE (almacen_id integer, nombre text, direccion text, lat numeric, lng numeric, fuente text, empresa_codigo text, empresa_color text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE a record; e record; c record;
BEGIN
  IF NOT public.fn_es_staff_crm() THEN RAISE EXCEPTION 'Sin permiso.' USING ERRCODE = '42501'; END IF;
  SELECT * INTO a FROM public.almacenes
   WHERE empresa_id = p_empresa AND COALESCE(activo, true)
   ORDER BY (codigo = 'ALM-01') DESC, COALESCE(es_principal,false) DESC, id LIMIT 1;
  IF a.id IS NOT NULL AND a.lat IS NOT NULL AND a.lng IS NOT NULL THEN
    SELECT * INTO e FROM public.empresa_config WHERE id = p_empresa;
    RETURN QUERY SELECT a.id, a.nombre::text, a.direccion::text, a.lat, a.lng, 'almacen'::text, e.codigo::text, e.color::text; RETURN;
  END IF;
  SELECT * INTO e FROM public.empresa_config WHERE id = p_empresa;
  SELECT * INTO c FROM public.fn_centroide_distrito(COALESCE(a.direccion, '') || ' ' || COALESCE(e.distrito, '') || ' ' || COALESCE(e.direccion, ''));
  RETURN QUERY SELECT a.id, COALESCE(a.nombre, e.nombre_comercial)::text, COALESCE(a.direccion, e.direccion)::text,
                      c.lat, c.lng, (CASE WHEN c.lat IS NULL THEN 'sin_datos' ELSE 'fiscal_aprox' END)::text, e.codigo::text, e.color::text;
END $$;
REVOKE EXECUTE ON FUNCTION public.crm_mapa_origen(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_mapa_origen(integer) TO authenticated, service_role;

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
    LEFT JOIN LATERAL (
      SELECT gd.id, gd.numero_guia, gd.created_at, gd.hora_salida, gd.hora_llegada, gd.punto_llegada_lat, gd.punto_llegada_lng
        FROM public.guias_despacho_venta gd JOIN public.ventas v ON v.id = gd.venta_id
       WHERE v.packing_id = p.id AND COALESCE(gd.estado, 'emitida') <> 'anulada'
       ORDER BY gd.fecha_guia DESC, gd.id DESC LIMIT 1) g ON true
    LEFT JOIN LATERAL public.fn_centroide_distrito(COALESCE(b.distrito, p.despacho_distrito)) cd ON true
   WHERE b.packing_id IS NOT NULL AND b.estado_flujo <> 'cotizacion'
     AND (b.estado_flujo <> 'despachado'
          OR COALESCE(g.hora_llegada, g.hora_salida, g.created_at, now()) > now() - make_interval(days => GREATEST(p_dias, 0)))
$$;
REVOKE EXECUTE ON FUNCTION public.crm_mapa_entregas(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_mapa_entregas(integer, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;

SELECT 'OK · centroides: ' || count(*) AS control FROM public.distritos_lima_centroide
UNION ALL SELECT 'OK · almacenes con coordenadas: ' || count(*) FILTER (WHERE lat IS NOT NULL) || ' de ' || count(*) FROM public.almacenes
UNION ALL SELECT 'OK · anon sin acceso al mapa: ' || (NOT has_function_privilege('anon','public.crm_mapa_entregas(integer,integer)','EXECUTE'))::text;
