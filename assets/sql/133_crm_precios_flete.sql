-- ============================================================================
-- 133 · CRM — Precios de lista con margen, costo de despacho real y flete por distrito
-- 2026-11-05 · Requiere los SQL 131 (CRM) y 132 (categorias_gasto.es_gasto) ya aplicados.
-- ----------------------------------------------------------------------------
-- QUÉ HACE (en una frase por pieza):
--   1. categorias_gasto.es_costo_despacho  → marca qué categoría de Tesorería es "flete/cargadores".
--   2. lotes.margen_lista_pct / precio_lista → el precio de lista VIVE EN EL LOTE (columna nueva).
--      Los campos de costo (costo_real, costo_comercial) NO se tocan jamás.
--   3. Costo de despacho real con DOS lecturas, jalando desde guia_id:
--        · por despacho  = gasto de despacho ÷ nº de guías
--        · por kg        = gasto de despacho ÷ kg despachados
--      (analogía: el taxi cuesta lo mismo con 1 caja o con 50; por eso se mira por viaje y por kilo).
--   4. v_datos_crm → vista con el costo YA calculado por lote (solo la leen funciones de gestor).
--   5. crm_precios_sugeridos / crm_aplicar_precios → el Panel CRM propone y aplica márgenes.
--      El margen es sobre el PRECIO:  precio_sin_IGV = costo / (1 − margen).
--   6. Flete por distrito (km en línea recta desde SJL) y semáforo de margen en cada cotización.
--   7. crm_catalogo() y crm_crear_cotizacion() se reemplazan (misma firma) para usar todo lo anterior.
--
-- SEGURIDAD: ninguna función nueva es ejecutable por `anon`. Costos y márgenes solo
-- los ven admin/oficina. El vendedor solo recibe un semáforo (verde/amarillo/rojo), sin números.
-- NO BORRA NADA. IDEMPOTENTE (se puede correr varias veces).
-- ============================================================================
BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- §1 · Categoría de gasto → "cuenta como costo de despacho"
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.categorias_gasto
  ADD COLUMN IF NOT EXISTS es_costo_despacho boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.categorias_gasto.es_costo_despacho IS
  'true = los gastos de esta categoría se suman al costo de despacho que usa el CRM para calcular márgenes (cargadores, flete, movilidad de entrega).';

-- ═══════════════════════════════════════════════════════════════════════════
-- §2 · Columnas nuevas en lotes (precio de lista) y en cotizaciones (flete)
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.lotes
  ADD COLUMN IF NOT EXISTS margen_lista_pct     numeric CHECK (margen_lista_pct IS NULL OR (margen_lista_pct >= 0 AND margen_lista_pct < 95)),
  ADD COLUMN IF NOT EXISTS precio_lista         numeric CHECK (precio_lista IS NULL OR precio_lista >= 0),
  ADD COLUMN IF NOT EXISTS precio_lista_moneda  varchar,
  ADD COLUMN IF NOT EXISTS precio_lista_at      timestamptz;
COMMENT ON COLUMN public.lotes.margen_lista_pct IS 'Margen (sobre el precio) fijado a mano para este lote desde el Panel CRM. NULL = hereda el de la familia o el general.';
COMMENT ON COLUMN public.lotes.precio_lista     IS 'Precio de lista por kg (incluye IGV si crm_config.igv_incluido) YA calculado desde costo_comercial. Lo escribe SOLO crm_aplicar_precios().';

ALTER TABLE public.crm_cotizaciones
  ADD COLUMN IF NOT EXISTS km_aprox     numeric,
  ADD COLUMN IF NOT EXISTS flete_soles  numeric,
  ADD COLUMN IF NOT EXISTS flete_estado varchar;
COMMENT ON COLUMN public.crm_cotizaciones.flete_estado IS 'incluido | recargo | cotizar (fuera de zona, de peso o distrito no reconocido). El flete se muestra aparte, no entra al total de la mercadería.';

-- ═══════════════════════════════════════════════════════════════════════════
-- §3 · Configuración de precios (por empresa) y márgenes por familia
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.crm_config_precios (
  empresa_id              integer PRIMARY KEY REFERENCES public.empresa_config(id) ON DELETE CASCADE,
  margen_objetivo_pct     numeric NOT NULL DEFAULT 20 CHECK (margen_objetivo_pct >= 0 AND margen_objetivo_pct < 95),
  margen_minimo_pct       numeric NOT NULL DEFAULT 15 CHECK (margen_minimo_pct   >= 0 AND margen_minimo_pct   < 95),
  incluir_despacho        boolean NOT NULL DEFAULT true,           -- sumar el despacho al costo
  despacho_base           varchar NOT NULL DEFAULT 'kg' CHECK (despacho_base IN ('kg','despacho')),
  periodo_dias            integer NOT NULL DEFAULT 90 CHECK (periodo_dias BETWEEN 7 AND 730),
  flete_kg_max            numeric NOT NULL DEFAULT 1000,           -- sobre esto: "cotizar aparte"
  updated_at              timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.crm_config_precios (empresa_id)
SELECT e.id FROM public.empresa_config e ON CONFLICT (empresa_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.crm_margen_familia (
  empresa_id           integer NOT NULL REFERENCES public.empresa_config(id) ON DELETE CASCADE,
  categoria_id         bigint  NOT NULL REFERENCES public.categorias(id)     ON DELETE CASCADE,
  margen_objetivo_pct  numeric NOT NULL CHECK (margen_objetivo_pct >= 0 AND margen_objetivo_pct < 95),
  margen_minimo_pct    numeric NOT NULL CHECK (margen_minimo_pct   >= 0 AND margen_minimo_pct   < 95),
  PRIMARY KEY (empresa_id, categoria_id)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- §4 · Flete por distrito
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_crm_norm(t text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(regexp_replace(translate(lower(COALESCE(t,'')), 'áéíóúüñ.', 'aeiouun '), '\s+', ' ', 'g'))
$$;

CREATE TABLE IF NOT EXISTS public.crm_flete_zonas (
  id        serial PRIMARY KEY,
  distrito  varchar NOT NULL,
  km        numeric NOT NULL CHECK (km >= 0),     -- km en línea recta desde San Juan de Lurigancho (aprox.)
  alias     text[]  NOT NULL DEFAULT '{}',
  activo    boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_flete_zona ON public.crm_flete_zonas (public.fn_crm_norm(distrito));

CREATE TABLE IF NOT EXISTS public.crm_flete_reglas (
  id           serial PRIMARY KEY,
  hasta_km     numeric NOT NULL UNIQUE CHECK (hasta_km >= 0),
  recargo_pen  numeric NOT NULL DEFAULT 0 CHECK (recargo_pen >= 0),
  etiqueta     varchar
);
INSERT INTO public.crm_flete_reglas (hasta_km, recargo_pen, etiqueta) VALUES
  (0, 0,  'Incluido (San Juan de Lurigancho)'),
  (10, 50, 'Hasta 10 km'),
  (20, 80, 'Hasta 20 km')
ON CONFLICT (hasta_km) DO NOTHING;

-- Distancias APROXIMADAS (centroide del distrito, línea recta desde SJL). Revisar/ajustar en el Panel.
INSERT INTO public.crm_flete_zonas (distrito, km, alias) VALUES
    ('Lima (Cercado)', 5.5, ARRAY['cercado de lima','lima cercado','lima']::text[]),
    ('Ancón', 31.1, ARRAY[]::text[]),
    ('Ate', 10.3, ARRAY[]::text[]),
    ('Barranco', 16.2, ARRAY[]::text[]),
    ('Breña', 7.7, ARRAY[]::text[]),
    ('Carabayllo', 15.2, ARRAY[]::text[]),
    ('Chaclacayo', 26.1, ARRAY[]::text[]),
    ('Chorrillos', 18.6, ARRAY[]::text[]),
    ('Cieneguilla', 27.5, ARRAY[]::text[]),
    ('Comas', 8.7, ARRAY[]::text[]),
    ('El Agustino', 5.0, ARRAY[]::text[]),
    ('Independencia', 5.0, ARRAY[]::text[]),
    ('Jesús María', 9.0, ARRAY[]::text[]),
    ('La Molina', 14.1, ARRAY[]::text[]),
    ('La Victoria', 7.2, ARRAY[]::text[]),
    ('Lince', 9.7, ARRAY[]::text[]),
    ('Los Olivos', 7.5, ARRAY[]::text[]),
    ('Lurigancho-Chosica', 34.2, ARRAY['lurigancho','chosica']::text[]),
    ('Lurín', 34.1, ARRAY[]::text[]),
    ('Magdalena del Mar', 12.1, ARRAY['magdalena']::text[]),
    ('Miraflores', 13.4, ARRAY[]::text[]),
    ('Pachacámac', 30.2, ARRAY[]::text[]),
    ('Pucusana', 57.9, ARRAY[]::text[]),
    ('Pueblo Libre', 10.1, ARRAY[]::text[]),
    ('Puente Piedra', 16.8, ARRAY[]::text[]),
    ('Punta Hermosa', 42.4, ARRAY[]::text[]),
    ('Punta Negra', 46.7, ARRAY[]::text[]),
    ('Rímac', 4.0, ARRAY[]::text[]),
    ('San Bartolo', 49.4, ARRAY[]::text[]),
    ('San Borja', 11.1, ARRAY[]::text[]),
    ('San Isidro', 11.2, ARRAY[]::text[]),
    ('San Juan de Lurigancho', 0.0, ARRAY['sjl','s.j.l.','s j l']::text[]),
    ('San Juan de Miraflores', 17.9, ARRAY['sjm']::text[]),
    ('San Luis', 8.4, ARRAY[]::text[]),
    ('San Martín de Porres', 8.3, ARRAY['smp']::text[]),
    ('San Miguel', 11.9, ARRAY[]::text[]),
    ('Santa Anita', 6.4, ARRAY[]::text[]),
    ('Santa María del Mar', 51.1, ARRAY[]::text[]),
    ('Santa Rosa', 28.4, ARRAY[]::text[]),
    ('Santiago de Surco', 16.1, ARRAY['surco']::text[]),
    ('Surquillo', 12.1, ARRAY[]::text[]),
    ('Villa El Salvador', 24.9, ARRAY['ves']::text[]),
    ('Villa María del Triunfo', 19.9, ARRAY['vmt']::text[]),
    ('Callao', 13.4, ARRAY[]::text[]),
    ('Bellavista', 12.5, ARRAY[]::text[]),
    ('Carmen de la Legua Reynoso', 9.7, ARRAY['carmen de la legua']::text[]),
    ('La Perla', 13.9, ARRAY[]::text[]),
    ('La Punta', 18.8, ARRAY[]::text[]),
    ('Ventanilla', 20.0, ARRAY[]::text[]),
    ('Mi Perú', 19.8, ARRAY[]::text[])
ON CONFLICT (public.fn_crm_norm(distrito)) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- §5 · Costos congelados por cotización (solo gestor)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.crm_cotizacion_costos (
  detalle_id         bigint PRIMARY KEY REFERENCES public.crm_cotizacion_detalle(id) ON DELETE CASCADE,
  cotizacion_id      uuid   NOT NULL REFERENCES public.crm_cotizaciones(id) ON DELETE CASCADE,
  costo_kg           numeric,     -- PEN/kg: costo comercial + despacho (según config), SIN IGV
  precio_sin_igv_kg  numeric,
  margen_pct         numeric,
  semaforo           varchar,     -- verde | amarillo | rojo | sin_costo
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_cot_costos ON public.crm_cotizacion_costos (cotizacion_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- §6 · RLS de las tablas nuevas (anon: nada; vendedor: nada de costos)
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['crm_config_precios','crm_margen_familia','crm_flete_zonas','crm_flete_reglas','crm_cotizacion_costos'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, PUBLIC', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated, service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_gestor', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.fn_crm_gestor()) WITH CHECK (public.fn_crm_gestor())', t || '_gestor', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE public.crm_flete_zonas_id_seq, public.crm_flete_reglas_id_seq TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_crm_touch ON public.crm_config_precios;
CREATE TRIGGER trg_crm_touch BEFORE UPDATE ON public.crm_config_precios
  FOR EACH ROW EXECUTE FUNCTION public.fn_crm_touch();

-- El vendedor no debe leer los gastos de Tesorería (hoy la política del ERP es abierta).
DO $$
BEGIN
  IF to_regclass('public.gastos') IS NOT NULL THEN
    DROP POLICY IF EXISTS gastos_no_vendedor ON public.gastos;
    CREATE POLICY gastos_no_vendedor ON public.gastos AS RESTRICTIVE FOR SELECT TO authenticated
      USING (NOT public.fn_tiene_rol('vendedor'));
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- §7 · Funciones internas de cálculo (NO ejecutables desde el navegador)
-- ═══════════════════════════════════════════════════════════════════════════

-- Tipo de cambio de venta más reciente (USD→PEN)
CREATE OR REPLACE FUNCTION public.fn_crm_tc()
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.venta FROM public.tipos_cambio t WHERE COALESCE(t.moneda,'USD') = 'USD' ORDER BY t.fecha DESC LIMIT 1
$$;

-- Precio desde costo y margen sobre el precio.  incluido=true → devuelve con IGV.
CREATE OR REPLACE FUNCTION public.fn_crm_precio_calc(p_costo numeric, p_margen numeric, p_igv numeric, p_incluido boolean)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_costo IS NULL OR p_costo <= 0 OR p_margen IS NULL OR p_margen >= 100 THEN NULL
              ELSE round((p_costo / (1 - p_margen / 100)) * CASE WHEN p_incluido THEN 1 + COALESCE(p_igv,18)/100 ELSE 1 END, 2) END
$$;

-- Margen real (sobre el precio) de un precio dado frente a un costo
CREATE OR REPLACE FUNCTION public.fn_crm_margen_calc(p_precio numeric, p_costo numeric, p_igv numeric, p_incluido boolean)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_precio IS NULL OR p_precio <= 0 OR p_costo IS NULL THEN NULL
              ELSE round(((p_precio / CASE WHEN p_incluido THEN 1 + COALESCE(p_igv,18)/100 ELSE 1 END) - p_costo)
                         / (p_precio / CASE WHEN p_incluido THEN 1 + COALESCE(p_igv,18)/100 ELSE 1 END) * 100, 2) END
$$;

CREATE OR REPLACE FUNCTION public.fn_crm_semaforo(p_margen numeric, p_objetivo numeric, p_minimo numeric)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_margen IS NULL THEN 'sin_costo'
              WHEN p_margen >= p_objetivo THEN 'verde'
              WHEN p_margen >= p_minimo   THEN 'amarillo'
              ELSE 'rojo' END
$$;

-- Costo de despacho real de la empresa en el periodo, con las dos lecturas.
--   · con guía  : gastos enlazados a una guía (gastos.guia_despacho_id) de ese periodo
--   · sin guía  : gastos de categoría "costo de despacho" que aún no se enlazaron a una guía
--   · *_estricto: solo los enlazados a guía (la lectura más conservadora)
CREATE OR REPLACE FUNCTION public.fn_crm_despacho(p_emp integer, p_dias integer DEFAULT NULL)
RETURNS TABLE (n_guias integer, kg numeric, gasto_con_guia numeric, gasto_sin_guia numeric,
               por_despacho numeric, por_kg numeric, por_despacho_estricto numeric, por_kg_estricto numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH par AS (
    SELECT current_date - COALESCE(p_dias, (SELECT periodo_dias FROM public.crm_config_precios WHERE empresa_id = p_emp), 90) AS desde
  ),
  g AS (
    SELECT gd.id, COALESCE(SUM(dg.cantidad), 0) AS kg
      FROM public.guias_despacho_venta gd
      JOIN public.ventas v ON v.id = gd.venta_id
      LEFT JOIN public.detalle_guias_despacho_venta dg ON dg.guia_id = gd.id
     WHERE v.empresa_id = p_emp AND gd.estado <> 'anulada' AND gd.fecha_guia >= (SELECT desde FROM par)
     GROUP BY gd.id
  ),
  gx AS (
    SELECT x.guia_despacho_id, x.empresa_id,
           x.monto * CASE WHEN x.moneda = 'USD' THEN x.tipo_cambio ELSE 1 END AS pen
      FROM public.gastos x
     WHERE NOT x.anulado AND x.fecha >= (SELECT desde FROM par)
       AND ( x.guia_despacho_id IS NOT NULL
             OR x.categoria_gasto_id IN (SELECT id FROM public.categorias_gasto WHERE es_costo_despacho) )
  ),
  r AS (
    SELECT (SELECT count(*) FROM g)::integer AS n,
           (SELECT COALESCE(SUM(kg),0) FROM g) AS kg,
           (SELECT COALESCE(SUM(pen),0) FROM gx WHERE guia_despacho_id IN (SELECT id FROM g)) AS con,
           (SELECT COALESCE(SUM(pen),0) FROM gx WHERE guia_despacho_id IS NULL AND empresa_id = p_emp) AS sin
  )
  SELECT r.n, r.kg, round(r.con,2), round(r.sin,2),
         round((r.con + r.sin) / NULLIF(r.n,0), 2),
         round((r.con + r.sin) / NULLIF(r.kg,0), 4),
         round(r.con / NULLIF(r.n,0), 2),
         round(r.con / NULLIF(r.kg,0), 4)
    FROM r
$$;

-- Margen objetivo/mínimo que aplican a un artículo (familia → general)
CREATE OR REPLACE FUNCTION public.fn_crm_margenes(p_emp integer, p_item bigint)
RETURNS TABLE (objetivo numeric, minimo numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(f.margen_objetivo_pct, c.margen_objetivo_pct, 20),
         COALESCE(f.margen_minimo_pct,   c.margen_minimo_pct,   15)
    FROM (SELECT 1) z
    LEFT JOIN public.crm_config_precios c ON c.empresa_id = p_emp
    LEFT JOIN public.items i ON i.id = p_item
    LEFT JOIN public.crm_margen_familia f ON f.empresa_id = p_emp AND f.categoria_id = i.categoria_id
$$;

-- Costo base PEN/kg (costo comercial, o contable si falta) del lote vigente del artículo
CREATE OR REPLACE FUNCTION public.fn_crm_costo_item(p_emp integer, p_item bigint)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(l.costo_comercial, l.costo_real) * public.fn_crm_tc()
    FROM public.lotes l
   WHERE l.item_id = p_item AND l.empresa_id = p_emp AND COALESCE(l.costo_comercial, l.costo_real) > 0
   ORDER BY (COALESCE((SELECT SUM(su.cantidad) FROM public.stock_ubicaciones su WHERE su.lote_id = l.id), 0) > 0) DESC,
            l.fecha_ingreso DESC NULLS LAST, l.id DESC
   LIMIT 1
$$;

-- Flete: km desde SJL según distrito + reglas. Devuelve estado incluido | recargo | cotizar
CREATE OR REPLACE FUNCTION public.fn_crm_flete(p_emp integer, p_distrito text, p_kg numeric)
RETURNS TABLE (km numeric, recargo numeric, estado text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_km numeric; v_rec numeric; v_max numeric;
BEGIN
  SELECT z.km INTO v_km FROM public.crm_flete_zonas z
   WHERE z.activo AND (public.fn_crm_norm(z.distrito) = public.fn_crm_norm(p_distrito)
          OR public.fn_crm_norm(p_distrito) = ANY (SELECT public.fn_crm_norm(a) FROM unnest(z.alias) a))
   LIMIT 1;
  SELECT COALESCE(c.flete_kg_max, 1000) INTO v_max FROM public.crm_config_precios c WHERE c.empresa_id = p_emp;
  v_max := COALESCE(v_max, 1000);
  IF v_km IS NULL THEN RETURN QUERY SELECT NULL::numeric, NULL::numeric, 'cotizar'::text; RETURN; END IF;
  IF p_kg > v_max THEN RETURN QUERY SELECT v_km, NULL::numeric, 'cotizar'::text; RETURN; END IF;
  SELECT r.recargo_pen INTO v_rec FROM public.crm_flete_reglas r WHERE v_km <= r.hasta_km ORDER BY r.hasta_km LIMIT 1;
  IF v_rec IS NULL THEN RETURN QUERY SELECT v_km, NULL::numeric, 'cotizar'::text; RETURN; END IF;
  RETURN QUERY SELECT v_km, v_rec, (CASE WHEN v_rec = 0 THEN 'incluido' ELSE 'recargo' END)::text;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- §8 · v_datos_crm — costo ya calculado por lote (precio de lista sale de la columna de lotes)
--      Sin ningún GRANT: la leen solo las funciones de gestor de abajo.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.v_datos_crm AS
WITH d AS (
  SELECT e.id AS empresa_id, x.por_kg, x.por_despacho
    FROM public.empresa_config e CROSS JOIN LATERAL public.fn_crm_despacho(e.id) x
),
st AS (
  SELECT su.lote_id, SUM(su.cantidad) AS kg FROM public.stock_ubicaciones su GROUP BY su.lote_id
)
SELECT l.id                                         AS lote_id,
       l.item_id,
       l.empresa_id,
       i.nombre::text                               AS item_nombre,
       i.categoria_id,
       ca.nombre::text                              AS categoria,
       l.numero_lote::text                          AS numero_lote,
       l.fecha_ingreso,
       COALESCE(st.kg, 0)                           AS stock_kg,
       l.costo_comercial                            AS costo_comercial_usd,
       l.costo_real                                 AS costo_real_usd,
       public.fn_crm_tc()                           AS tc,
       COALESCE(l.costo_comercial, l.costo_real) * public.fn_crm_tc()  AS costo_base_pen,
       CASE WHEN COALESCE(cp.incluir_despacho, true) THEN COALESCE(d.por_kg, 0) ELSE 0 END AS despacho_kg_pen,
       COALESCE(l.costo_comercial, l.costo_real) * public.fn_crm_tc()
         + CASE WHEN COALESCE(cp.incluir_despacho, true) THEN COALESCE(d.por_kg, 0) ELSE 0 END AS costo_total_pen,
       l.margen_lista_pct,
       l.precio_lista,
       l.precio_lista_moneda,
       l.precio_lista_at
  FROM public.lotes l
  JOIN public.items i            ON i.id = l.item_id
  LEFT JOIN public.categorias ca ON ca.id = i.categoria_id
  LEFT JOIN st                   ON st.lote_id = l.id
  LEFT JOIN d                    ON d.empresa_id = l.empresa_id
  LEFT JOIN public.crm_config_precios cp ON cp.empresa_id = l.empresa_id;

REVOKE ALL ON public.v_datos_crm FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_datos_crm TO service_role;
COMMENT ON VIEW public.v_datos_crm IS 'Costo por lote ya calculado (USD→PEN + despacho real). Solo lectura interna: se consulta mediante crm_datos().';

-- ═══════════════════════════════════════════════════════════════════════════
-- §9 · Funciones del Panel CRM (solo admin/oficina)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.crm_datos(p_empresa integer, p_solo_stock boolean DEFAULT true)
RETURNS SETOF public.v_datos_crm
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.fn_crm_gestor() THEN RAISE EXCEPTION 'Solo administración puede ver costos.' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT v.* FROM public.v_datos_crm v
    WHERE v.empresa_id = p_empresa AND (NOT p_solo_stock OR v.stock_kg > 0)
    ORDER BY v.categoria, v.item_nombre, v.fecha_ingreso DESC;
END $$;

-- Resumen del despacho real (para la pantalla que compara "por despacho" y "por kg")
CREATE OR REPLACE FUNCTION public.crm_despacho_resumen(p_empresa integer, p_dias integer DEFAULT NULL)
RETURNS TABLE (n_guias integer, kg numeric, gasto_con_guia numeric, gasto_sin_guia numeric,
               por_despacho numeric, por_kg numeric, por_despacho_estricto numeric, por_kg_estricto numeric, dias integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.fn_crm_gestor() THEN RAISE EXCEPTION 'Solo administración puede ver costos.' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT d.*, COALESCE(p_dias, (SELECT periodo_dias FROM public.crm_config_precios WHERE empresa_id = p_empresa), 90)
                 FROM public.fn_crm_despacho(p_empresa, p_dias) d;
END $$;

-- Detalle por guía: cada despacho con su gasto enlazado (guia_id) y su costo por kg
CREATE OR REPLACE FUNCTION public.crm_despacho_por_guia(p_empresa integer, p_dias integer DEFAULT NULL)
RETURNS TABLE (guia_id bigint, numero_guia text, fecha_guia date, venta_id bigint, kg numeric, gasto_pen numeric, pen_por_kg numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_desde date;
BEGIN
  IF NOT public.fn_crm_gestor() THEN RAISE EXCEPTION 'Solo administración puede ver costos.' USING ERRCODE = '42501'; END IF;
  v_desde := current_date - COALESCE(p_dias, (SELECT periodo_dias FROM public.crm_config_precios WHERE empresa_id = p_empresa), 90);
  RETURN QUERY
  SELECT gd.id, gd.numero_guia::text, gd.fecha_guia, gd.venta_id,
         COALESCE((SELECT SUM(dg.cantidad) FROM public.detalle_guias_despacho_venta dg WHERE dg.guia_id = gd.id), 0),
         COALESCE((SELECT SUM(x.monto * CASE WHEN x.moneda = 'USD' THEN x.tipo_cambio ELSE 1 END)
                     FROM public.gastos x WHERE x.guia_despacho_id = gd.id AND NOT x.anulado), 0),
         round(COALESCE((SELECT SUM(x.monto * CASE WHEN x.moneda = 'USD' THEN x.tipo_cambio ELSE 1 END)
                     FROM public.gastos x WHERE x.guia_despacho_id = gd.id AND NOT x.anulado), 0)
               / NULLIF((SELECT SUM(dg.cantidad) FROM public.detalle_guias_despacho_venta dg WHERE dg.guia_id = gd.id), 0), 4)
    FROM public.guias_despacho_venta gd
    JOIN public.ventas v ON v.id = gd.venta_id
   WHERE v.empresa_id = p_empresa AND gd.estado <> 'anulada' AND gd.fecha_guia >= v_desde
   ORDER BY gd.fecha_guia DESC, gd.id DESC;
END $$;

-- Propuesta de precios por lote: costo, margen que aplica, precio sugerido, precio vigente y semáforo
CREATE OR REPLACE FUNCTION public.crm_precios_sugeridos(p_empresa integer, p_solo_stock boolean DEFAULT true)
RETURNS TABLE (
  lote_id bigint, item_id bigint, item_nombre text, categoria_id bigint, categoria text, numero_lote text,
  fecha_ingreso date, stock_kg numeric, costo_comercial_usd numeric, tc numeric, costo_base numeric,
  despacho_kg numeric, costo_total numeric, margen_objetivo_pct numeric, margen_minimo_pct numeric,
  margen_lista_pct numeric, margen_aplicado_pct numeric, precio_sugerido numeric, precio_actual numeric,
  margen_real_pct numeric, semaforo text, moneda text, igv_incluido boolean, publicado boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.fn_crm_gestor() THEN RAISE EXCEPTION 'Solo administración puede ver costos.' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  WITH cfg AS (
    SELECT c.moneda_precio::text AS moneda, c.igv_incluido, COALESCE(e.igv_porcentaje, 18) AS igv
      FROM public.crm_config c JOIN public.empresa_config e ON e.id = c.empresa_id WHERE c.empresa_id = p_empresa
  ),
  b AS (
    SELECT v.*, cfg.moneda, cfg.igv_incluido, cfg.igv,
           CASE WHEN cfg.moneda = 'USD' THEN v.costo_base_pen  / NULLIF(v.tc,0) ELSE v.costo_base_pen  END AS cb,
           CASE WHEN cfg.moneda = 'USD' THEN v.despacho_kg_pen / NULLIF(v.tc,0) ELSE v.despacho_kg_pen END AS dk,
           CASE WHEN cfg.moneda = 'USD' THEN v.costo_total_pen / NULLIF(v.tc,0) ELSE v.costo_total_pen END AS ct,
           m.objetivo, m.minimo
      FROM public.v_datos_crm v CROSS JOIN cfg
      CROSS JOIN LATERAL public.fn_crm_margenes(p_empresa, v.item_id) m
     WHERE v.empresa_id = p_empresa AND (NOT p_solo_stock OR v.stock_kg > 0)
  )
  SELECT b.lote_id, b.item_id, b.item_nombre, b.categoria_id, b.categoria, b.numero_lote, b.fecha_ingreso, b.stock_kg,
         b.costo_comercial_usd, b.tc, round(b.cb,4), round(b.dk,4), round(b.ct,4),
         b.objetivo, b.minimo, b.margen_lista_pct,
         COALESCE(b.margen_lista_pct, b.objetivo),
         public.fn_crm_precio_calc(b.ct, COALESCE(b.margen_lista_pct, b.objetivo), b.igv, b.igv_incluido),
         b.precio_lista,
         public.fn_crm_margen_calc(b.precio_lista, b.ct, b.igv, b.igv_incluido),
         public.fn_crm_semaforo(public.fn_crm_margen_calc(b.precio_lista, b.ct, b.igv, b.igv_incluido), b.objetivo, b.minimo),
         b.moneda, b.igv_incluido,
         EXISTS (SELECT 1 FROM public.crm_catalogo_config cc WHERE cc.empresa_id = p_empresa AND cc.item_id = b.item_id AND cc.publicado)
    FROM b
   ORDER BY b.categoria, b.item_nombre, b.fecha_ingreso DESC;
END $$;

-- Aplicar: recalcula en el SERVIDOR (el navegador nunca manda un precio, solo un margen).
--   p_lotes = [{"lote_id":12,"margen_pct":22}, ...]   (margen_pct null → usa el que ya hereda)
--   p_lotes = null → recalcula todos los lotes con stock con su margen vigente.
CREATE OR REPLACE FUNCTION public.crm_aplicar_precios(p_empresa integer, p_lotes jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record; j jsonb; v_m numeric; v_precio numeric; v_ok integer := 0; v_sc integer := 0; v_explicit boolean;
BEGIN
  IF NOT public.fn_crm_gestor() THEN RAISE EXCEPTION 'Solo administración puede cambiar precios.' USING ERRCODE = '42501'; END IF;
  IF p_lotes IS NOT NULL AND jsonb_typeof(p_lotes) <> 'array' THEN RAISE EXCEPTION 'Formato inválido.'; END IF;

  FOR r IN SELECT * FROM public.crm_precios_sugeridos(p_empresa, p_lotes IS NULL) LOOP
    v_explicit := false; v_m := r.margen_aplicado_pct;
    IF p_lotes IS NOT NULL THEN
      SELECT x INTO j FROM jsonb_array_elements(p_lotes) x WHERE (x->>'lote_id')::bigint = r.lote_id LIMIT 1;
      CONTINUE WHEN j IS NULL;
      IF NULLIF(j->>'margen_pct','') IS NOT NULL THEN
        v_m := (j->>'margen_pct')::numeric; v_explicit := true;
        IF v_m < 0 OR v_m >= 95 THEN RAISE EXCEPTION 'Margen fuera de rango (0–94.9).'; END IF;
      END IF;
    END IF;
    -- precio con el margen decidido (misma fórmula que la propuesta)
    v_precio := public.fn_crm_precio_calc(r.costo_total, v_m,
                   (SELECT COALESCE(igv_porcentaje,18) FROM public.empresa_config WHERE id = p_empresa), r.igv_incluido);
    IF v_precio IS NULL THEN v_sc := v_sc + 1; CONTINUE; END IF;

    UPDATE public.lotes SET precio_lista = v_precio, precio_lista_moneda = r.moneda, precio_lista_at = now(),
                            margen_lista_pct = CASE WHEN v_explicit THEN v_m ELSE margen_lista_pct END
     WHERE id = r.lote_id;
    -- el precio manual viejo del catálogo dejaría de mandar: se limpia para que gobierne el lote
    UPDATE public.crm_catalogo_config SET precio_lista = NULL WHERE empresa_id = p_empresa AND item_id = r.item_id;
    v_ok := v_ok + 1;
  END LOOP;
  RETURN jsonb_build_object('aplicados', v_ok, 'sin_costo', v_sc);
END $$;

-- Margen por familia y config general: se editan con update directo a las tablas (RLS gestor).

-- Costos y margen de UNA cotización (gestor)
CREATE OR REPLACE FUNCTION public.crm_cotizacion_margen(p_cot uuid)
RETURNS TABLE (detalle_id bigint, producto_nombre text, cantidad_kg numeric, precio_kg numeric,
               costo_kg numeric, margen_pct numeric, semaforo text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.fn_crm_gestor() THEN RAISE EXCEPTION 'Solo administración puede ver costos.' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT d.id, d.producto_nombre::text, d.cantidad_kg, d.precio_unitario, k.costo_kg, k.margen_pct, k.semaforo::text
    FROM public.crm_cotizacion_detalle d LEFT JOIN public.crm_cotizacion_costos k ON k.detalle_id = d.id
   WHERE d.cotizacion_id = p_cot ORDER BY d.orden_linea;
END $$;

-- Semáforo por cotización (staff). Sin números: el vendedor solo ve el color.
CREATE OR REPLACE FUNCTION public.crm_cotizaciones_semaforo(p_empresa integer)
RETURNS TABLE (cotizacion_id uuid, semaforo text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.fn_es_staff_crm() THEN RAISE EXCEPTION 'Sin permiso.' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT c.id,
         (CASE WHEN bool_or(k.semaforo = 'rojo') THEN 'rojo'
               WHEN bool_or(k.semaforo = 'amarillo') THEN 'amarillo'
               WHEN bool_or(k.semaforo = 'sin_costo') THEN 'sin_costo'
               WHEN bool_or(k.semaforo = 'verde') THEN 'verde' ELSE 'sin_costo' END)::text
    FROM public.crm_cotizaciones c
    LEFT JOIN public.crm_cotizacion_costos k ON k.cotizacion_id = c.id
   WHERE c.empresa_id = p_empresa
     AND (public.fn_crm_gestor() OR c.vendedor_id = public.fn_usuario_id() OR c.vendedor_id IS NULL)
   GROUP BY c.id;
END $$;

-- Flete de una dirección (para que el Panel lo simule o lo recalcule)
CREATE OR REPLACE FUNCTION public.crm_flete_calcular(p_empresa integer, p_distrito text, p_kg numeric)
RETURNS TABLE (km numeric, recargo numeric, estado text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.fn_es_staff_crm() THEN RAISE EXCEPTION 'Sin permiso.' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT * FROM public.fn_crm_flete(p_empresa, p_distrito, p_kg);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- §10 · Reemplazo de las dos funciones públicas del CRM (misma firma, mismos permisos)
-- ═══════════════════════════════════════════════════════════════════════════

-- Precio público: manual del catálogo → precio_lista del lote vigente → items.precio_venta
CREATE OR REPLACE FUNCTION public.crm_catalogo(p_empresa integer DEFAULT NULL)
RETURNS TABLE (
  id bigint, item_id bigint, empresa_id integer, nombre text, grupo text,
  color_nombre text, color_no text, color_hex text, fotos jsonb,
  descripcion text, aplicaciones text, precio numeric, moneda text,
  igv_incluido boolean, peso_caja_kg numeric, conos_por_caja integer,
  semaforo text, orden_display integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH stock AS (
    SELECT l.item_id, su.empresa_id, SUM(su.cantidad) AS kg
      FROM public.stock_ubicaciones su
      JOIN public.lotes l ON l.id = su.lote_id
     GROUP BY l.item_id, su.empresa_id
  )
  SELECT cc.id, cc.item_id, cc.empresa_id,
         COALESCE(NULLIF(cc.nombre_web, ''), i.nombre)::text,
         COALESCE(NULLIF(cc.grupo, ''), ca.nombre, 'General')::text,
         cc.color_nombre::text, cc.color_no::text, cc.color_hex::text, cc.fotos,
         cc.descripcion_web, cc.aplicaciones,
         CASE WHEN cfg.mostrar_precios
              THEN COALESCE(NULLIF(cc.precio_lista, 0), lp.precio, NULLIF(i.precio_venta, 0)) END,
         cfg.moneda_precio::text, cfg.igv_incluido,
         COALESCE(cc.peso_caja_kg, (
           SELECT l2.peso_por_unidad FROM public.lotes l2
            WHERE l2.item_id = cc.item_id AND l2.empresa_id = cc.empresa_id AND l2.peso_por_unidad > 0
            GROUP BY l2.peso_por_unidad ORDER BY count(*) DESC, l2.peso_por_unidad LIMIT 1
         )),
         cc.conos_por_caja,
         (CASE
            WHEN COALESCE(s.kg, 0) <= 0 THEN 'agotado'
            WHEN s.kg < COALESCE(cc.stock_minimo_kg, cfg.semaforo_poco_kg, 100) THEN 'poco'
            ELSE 'disponible'
          END)::text,
         cc.orden_display
    FROM public.crm_catalogo_config cc
    JOIN public.items i            ON i.id = cc.item_id AND i.activo IS NOT FALSE
    JOIN public.crm_config cfg     ON cfg.empresa_id = cc.empresa_id
    LEFT JOIN public.categorias ca ON ca.id = i.categoria_id
    LEFT JOIN stock s              ON s.item_id = cc.item_id AND s.empresa_id = cc.empresa_id
    LEFT JOIN LATERAL (
      SELECT l.precio_lista AS precio FROM public.lotes l
       WHERE l.item_id = cc.item_id AND l.empresa_id = cc.empresa_id
         AND l.precio_lista > 0 AND l.precio_lista_moneda = cfg.moneda_precio
       ORDER BY (COALESCE((SELECT SUM(su.cantidad) FROM public.stock_ubicaciones su WHERE su.lote_id = l.id), 0) > 0) DESC,
                l.fecha_ingreso DESC NULLS LAST, l.id DESC
       LIMIT 1
    ) lp ON true
   WHERE cc.publicado
     AND (p_empresa IS NULL OR cc.empresa_id = p_empresa)
   ORDER BY cc.orden_display, 5, 2
$$;

-- Crear cotización: igual que 131 + flete por distrito + costo/margen congelados (solo gestor los lee)
CREATE OR REPLACE FUNCTION public.crm_crear_cotizacion(
  p_cliente  jsonb,
  p_entrega  jsonb,
  p_lineas   jsonb,
  p_notas    text DEFAULT NULL,
  p_empresa  integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_staff    boolean := COALESCE(public.fn_es_staff_crm(), false);
  v_uid      bigint  := public.fn_usuario_id();
  v_ruc      text    := btrim(COALESCE(p_cliente->>'ruc', ''));
  v_razon    text    := btrim(COALESCE(p_cliente->>'razon_social', ''));
  v_nombre   text    := btrim(COALESCE(p_cliente->>'nombre_contacto', ''));
  v_email    text    := lower(btrim(COALESCE(p_cliente->>'email', '')));
  v_tel      text    := btrim(COALESCE(p_cliente->>'telefono', ''));
  v_dirfis   text    := btrim(COALESCE(p_cliente->>'direccion_fiscal', ''));
  v_dirent   text    := btrim(COALESCE(p_entrega->>'dir_entrega', ''));
  v_distrito text    := btrim(COALESCE(p_entrega->>'distrito_entrega', ''));
  v_ref      text    := btrim(COALESCE(p_entrega->>'referencia_entrega', ''));
  v_cfg      public.crm_config%ROWTYPE;
  v_cli      uuid;
  v_cot      uuid;
  v_num      text;
  v_total    numeric;
  v_n        integer;
  l          jsonb;
  r          record;
  d          record;
  v_kg       numeric;
  v_kgtot    numeric := 0;
  v_orden    integer := 0;
  v_igv      numeric;
  v_cp       public.crm_config_precios%ROWTYPE;
  v_desp     record;
  v_costo    numeric; v_costo_cfg numeric; v_psin numeric; v_marg numeric; v_dk numeric;
  v_mg       record;
  v_fl       record;
BEGIN
  -- Validación de datos
  IF v_ruc !~ '^[0-9]{8}$' AND v_ruc !~ '^[0-9]{11}$' THEN RAISE EXCEPTION 'Documento inválido: usa DNI (8) o RUC (11 dígitos).'; END IF;
  IF length(v_razon) < 3     THEN RAISE EXCEPTION 'La razón social / nombre es obligatoria.'; END IF;
  IF length(v_nombre) < 2    THEN RAISE EXCEPTION 'El nombre de contacto es obligatorio.'; END IF;
  IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN RAISE EXCEPTION 'Correo electrónico inválido.'; END IF;
  IF length(v_dirent) < 5    THEN RAISE EXCEPTION 'La dirección de entrega es obligatoria.'; END IF;
  IF length(v_distrito) < 2  THEN RAISE EXCEPTION 'El distrito de entrega es obligatorio.'; END IF;
  IF length(v_razon) > 200 OR length(v_nombre) > 120 OR length(v_dirent) > 250
     OR length(COALESCE(p_notas, '')) > 1500 THEN RAISE EXCEPTION 'Algún campo excede el largo permitido.'; END IF;

  IF p_lineas IS NULL OR jsonb_typeof(p_lineas) <> 'array' THEN RAISE EXCEPTION 'La cotización no tiene productos.'; END IF;
  v_n := jsonb_array_length(p_lineas);
  IF v_n < 1 OR v_n > 40 THEN RAISE EXCEPTION 'La cotización debe tener entre 1 y 40 productos.'; END IF;

  -- Empresa: debe tener CRM configurado
  IF p_empresa IS NULL THEN RAISE EXCEPTION 'Falta la empresa.'; END IF;
  SELECT * INTO v_cfg FROM public.crm_config WHERE empresa_id = p_empresa;
  IF NOT FOUND THEN RAISE EXCEPTION 'La empresa no tiene catálogo.'; END IF;

  -- Anti-spam (solo visitantes; el staff no tiene tope)
  IF NOT v_staff THEN
    IF (SELECT count(*) FROM public.crm_cotizaciones c
         WHERE c.created_at > now() - interval '24 hours'
           AND (lower(c.contacto_email) = v_email OR c.cliente_id IN (SELECT k.id FROM public.crm_clientes k WHERE k.ruc = v_ruc))) >= 5 THEN
      RAISE EXCEPTION 'Ya enviaste varias cotizaciones hoy. Escríbenos por WhatsApp para atenderte.';
    END IF;
    IF (SELECT count(*) FROM public.crm_cotizaciones c WHERE c.created_at > now() - interval '1 hour' AND c.origen = 'web') >= 200 THEN
      RAISE EXCEPTION 'Estamos recibiendo muchas solicitudes. Intenta en unos minutos.';
    END IF;
  END IF;

  -- Cliente: se crea una vez; NO se sobrescribe si el RUC ya existe
  SELECT id INTO v_cli FROM public.crm_clientes WHERE ruc = v_ruc;
  IF v_cli IS NULL THEN
    INSERT INTO public.crm_clientes (ruc, razon_social, nombre_contacto, email, telefono,
                                     direccion_fiscal, distrito, contact_id, origen, vendedor_id)
    VALUES (v_ruc, v_razon, v_nombre, v_email, NULLIF(v_tel, ''), NULLIF(v_dirfis, ''), NULLIF(v_distrito, ''),
            (SELECT c.id FROM public.contacts c WHERE c.nro_documento = v_ruc LIMIT 1),
            CASE WHEN v_staff THEN 'vendedor' ELSE 'web' END,
            CASE WHEN v_staff AND NOT public.fn_crm_gestor() THEN v_uid ELSE NULL END)
    RETURNING id INTO v_cli;
  END IF;

  -- Cabecera
  INSERT INTO public.crm_cotizaciones (
    empresa_id, cliente_id, vendedor_id, origen, razon_social, contacto_nombre, contacto_email,
    contacto_telefono, direccion_fiscal, dir_entrega, distrito_entrega, referencia_entrega,
    notas_cliente, moneda, igv_incluido)
  VALUES (
    p_empresa, v_cli, CASE WHEN v_staff THEN v_uid ELSE NULL END,
    CASE WHEN v_staff THEN 'vendedor' ELSE 'web' END,
    v_razon, v_nombre, v_email, NULLIF(v_tel, ''), NULLIF(v_dirfis, ''), v_dirent, v_distrito, NULLIF(v_ref, ''),
    NULLIF(btrim(COALESCE(p_notas, '')), ''), v_cfg.moneda_precio, v_cfg.igv_incluido)
  RETURNING id, numero INTO v_cot, v_num;

  -- Líneas: precio y nombre salen de la BD
  FOR l IN SELECT * FROM jsonb_array_elements(p_lineas) LOOP
    BEGIN
      v_kg := (l->>'cantidad_kg')::numeric;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Cantidad inválida en un producto.';
    END;
    IF v_kg IS NULL OR v_kg <= 0 OR v_kg > 200000 THEN RAISE EXCEPTION 'Cantidad inválida (máx. 200 000 kg por línea).'; END IF;

    SELECT * INTO r FROM public.crm_catalogo(p_empresa) c WHERE c.id = (l->>'catalogo_id')::bigint;
    IF NOT FOUND THEN RAISE EXCEPTION 'Un producto ya no está disponible en el catálogo.'; END IF;
    IF r.semaforo = 'agotado' AND NOT v_staff THEN
      RAISE EXCEPTION 'Producto agotado: %. Consúltanos por WhatsApp.', r.nombre;
    END IF;

    v_orden := v_orden + 1;
    v_kgtot := v_kgtot + v_kg;
    INSERT INTO public.crm_cotizacion_detalle (cotizacion_id, catalogo_id, item_id, producto_nombre,
           producto_categoria, color_nombre, cantidad_kg, peso_x_caja, precio_unitario, orden_linea)
    VALUES (v_cot, r.id, r.item_id, r.nombre, r.grupo, r.color_nombre, v_kg, r.peso_caja_kg,
            COALESCE(r.precio, 0), v_orden);
  END LOOP;

  -- Flete por distrito (se muestra aparte del total de mercadería)
  SELECT * INTO v_fl FROM public.fn_crm_flete(p_empresa, v_distrito, v_kgtot);
  UPDATE public.crm_cotizaciones SET km_aprox = v_fl.km, flete_soles = v_fl.recargo, flete_estado = v_fl.estado
   WHERE id = v_cot;

  -- Costo y margen CONGELADOS por línea (solo el gestor los puede leer)
  SELECT COALESCE(igv_porcentaje, 18) INTO v_igv FROM public.empresa_config WHERE id = p_empresa;
  SELECT * INTO v_cp FROM public.crm_config_precios WHERE empresa_id = p_empresa;
  SELECT * INTO v_desp FROM public.fn_crm_despacho(p_empresa);
  FOR d IN SELECT * FROM public.crm_cotizacion_detalle WHERE cotizacion_id = v_cot LOOP
    v_costo := public.fn_crm_costo_item(p_empresa, d.item_id);                 -- PEN/kg o NULL
    IF v_costo IS NOT NULL AND COALESCE(v_cp.incluir_despacho, true) THEN
      v_dk := CASE WHEN COALESCE(v_cp.despacho_base, 'kg') = 'despacho'
                   THEN COALESCE(v_desp.por_despacho, 0) / NULLIF(v_kgtot, 0)  -- el viaje se reparte entre los kg del pedido
                   ELSE COALESCE(v_desp.por_kg, 0) END;
      v_costo := v_costo + COALESCE(v_dk, 0);
    END IF;
    v_costo_cfg := CASE WHEN v_cfg.moneda_precio = 'USD' THEN v_costo / NULLIF(public.fn_crm_tc(), 0) ELSE v_costo END;
    v_psin := CASE WHEN v_cfg.igv_incluido THEN d.precio_unitario / (1 + v_igv / 100) ELSE d.precio_unitario END;
    v_marg := CASE WHEN v_costo_cfg IS NULL OR v_psin <= 0 THEN NULL ELSE round((v_psin - v_costo_cfg) / v_psin * 100, 2) END;
    SELECT * INTO v_mg FROM public.fn_crm_margenes(p_empresa, d.item_id);
    INSERT INTO public.crm_cotizacion_costos (detalle_id, cotizacion_id, costo_kg, precio_sin_igv_kg, margen_pct, semaforo)
    VALUES (d.id, v_cot, round(v_costo_cfg, 4), round(v_psin, 4), v_marg,
            public.fn_crm_semaforo(v_marg, v_mg.objetivo, v_mg.minimo));
  END LOOP;

  SELECT total INTO v_total FROM public.crm_cotizaciones WHERE id = v_cot;
  RETURN jsonb_build_object('id', v_cot, 'numero', v_num, 'total', v_total,
                            'flete', v_fl.recargo, 'flete_estado', v_fl.estado, 'km', v_fl.km);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- §11 · Permisos: internas cerradas; panel solo authenticated (cada una valida el rol por dentro)
-- ═══════════════════════════════════════════════════════════════════════════
REVOKE EXECUTE ON FUNCTION
  public.fn_crm_tc(), public.fn_crm_despacho(integer, integer), public.fn_crm_margenes(integer, bigint),
  public.fn_crm_costo_item(integer, bigint), public.fn_crm_flete(integer, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.fn_crm_tc(), public.fn_crm_despacho(integer, integer), public.fn_crm_margenes(integer, bigint),
  public.fn_crm_costo_item(integer, bigint), public.fn_crm_flete(integer, text, numeric) TO service_role;

REVOKE EXECUTE ON FUNCTION
  public.crm_datos(integer, boolean), public.crm_despacho_resumen(integer, integer),
  public.crm_despacho_por_guia(integer, integer), public.crm_precios_sugeridos(integer, boolean),
  public.crm_aplicar_precios(integer, jsonb), public.crm_cotizacion_margen(uuid),
  public.crm_cotizaciones_semaforo(integer), public.crm_flete_calcular(integer, text, numeric)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.crm_datos(integer, boolean), public.crm_despacho_resumen(integer, integer),
  public.crm_despacho_por_guia(integer, integer), public.crm_precios_sugeridos(integer, boolean),
  public.crm_aplicar_precios(integer, jsonb), public.crm_cotizacion_margen(uuid),
  public.crm_cotizaciones_semaforo(integer), public.crm_flete_calcular(integer, text, numeric)
  TO authenticated, service_role;

-- crm_catalogo / crm_crear_cotizacion conservan los permisos que les dio el 131 (anon + authenticated).
COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Verificación (debe devolver "OK" en las dos filas)
-- ═══════════════════════════════════════════════════════════════════════════
SELECT CASE WHEN count(*) = 6 THEN 'OK · anon sigue ejecutando solo las 6 funciones públicas' ELSE 'REVISAR · anon ejecuta ' || count(*) || ' funciones' END AS control
  FROM information_schema.routine_privileges
 WHERE grantee = 'anon' AND routine_schema = 'public' AND privilege_type = 'EXECUTE'
UNION ALL
SELECT CASE WHEN has_table_privilege('anon','public.v_datos_crm','SELECT') OR has_table_privilege('authenticated','public.v_datos_crm','SELECT')
            THEN 'REVISAR · v_datos_crm es legible desde el navegador' ELSE 'OK · v_datos_crm cerrada al navegador' END;
