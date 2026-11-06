  -- ============================================================================
  -- 136 · Packing: término y lugar de despacho, origen COT, avisos (campanita) y bandeja CRM
  -- 2026-11-05 · Requiere SQL 115 (cotizaciones en packing), 131/133 (CRM, precios, flete).
  -- ----------------------------------------------------------------------------
  -- QUÉ AGREGA:
  --   1. packing.cot_numero            → el N° de COT que sigue a la operación de punta a punta
  --                                      (COT-0012 del ERP, o COT-26-00001 si nació en la web).
  --   2. packing.termino_despacho      → 'recoge_cliente' | 'despacho'. Si es 'despacho' se guarda
  --      + lugar (dirección, distrito, link de Maps), km y COSTO INTERNO de despacho (S/), que el
  --      modal del PK resta al margen. Ese costo NO se cobra aparte: va dentro del precio de venta.
  --   3. packing.bajo_pv_lista         → la cotización se guardó por debajo del PV de lista (aviso).
  --   4. guias_despacho_venta.punto_llegada_*  → dirección de entrega de la guía (editable; SUNAT
  --      pide "dirección del punto de llegada", no el domicilio fiscal del destinatario).
  --   5. crm_cotizaciones.packing_id   → cotización web convertida en cotización ERP.
  --   6. notificaciones                → alimenta la campanita (avisos guardados).
  --   7. v_packing_despacho            → por PK: facturado vs despachado → sin_guia | guia_parcial | con_guia.
  --   8. crm_bandeja()                 → una sola lista de seguimiento por COT (web + ERP + PK por despachar).
  --   9. avisos_por_despachar()        → recordatorio amigable: PK facturados cuyo día ya pasó y sin guía.
  --  10. crm_pv_lista_items(), crm_flete_distritos(), crm_convertir_a_packing().
  --
  -- NO BORRA NADA. IDEMPOTENTE. Anon no recibe ningún permiso nuevo.
  -- ============================================================================
  BEGIN;

  -- ═══ §1 · packing ══════════════════════════════════════════════════════════
  ALTER TABLE public.packing
    ADD COLUMN IF NOT EXISTS cot_numero              varchar,
    ADD COLUMN IF NOT EXISTS crm_cotizacion_id       uuid REFERENCES public.crm_cotizaciones(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS termino_despacho        varchar,
    ADD COLUMN IF NOT EXISTS despacho_usa_dir_cliente boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS despacho_direccion      varchar,
    ADD COLUMN IF NOT EXISTS despacho_distrito       varchar,
    ADD COLUMN IF NOT EXISTS despacho_maps_url       text,
    ADD COLUMN IF NOT EXISTS despacho_km             numeric,
    ADD COLUMN IF NOT EXISTS despacho_costo          numeric,
    ADD COLUMN IF NOT EXISTS despacho_costo_manual   boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS bajo_pv_lista           boolean NOT NULL DEFAULT false;

  ALTER TABLE public.packing DROP CONSTRAINT IF EXISTS packing_termino_despacho_check;
  ALTER TABLE public.packing ADD CONSTRAINT packing_termino_despacho_check
    CHECK (termino_despacho IS NULL OR termino_despacho IN ('recoge_cliente', 'despacho'));
  ALTER TABLE public.packing DROP CONSTRAINT IF EXISTS packing_despacho_costo_check;
  ALTER TABLE public.packing ADD CONSTRAINT packing_despacho_costo_check
    CHECK (despacho_costo IS NULL OR despacho_costo >= 0);

  COMMENT ON COLUMN public.packing.cot_numero IS 'N° de COT que acompaña a la operación (ERP: COT-0012; web: COT-26-00001). Se conserva al confirmar el PK y al duplicar.';
  COMMENT ON COLUMN public.packing.despacho_costo IS 'Costo INTERNO estimado de despacho (S/) según la tabla de flete. No se cobra aparte: se resta al margen del PK.';

  -- Los PK que ya nacieron de una cotización ERP conservan su COT
  UPDATE public.packing SET cot_numero = 'COT-' || lpad(cot_correlativo::text, 4, '0')
  WHERE cot_numero IS NULL AND cot_correlativo IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_packing_cot_numero ON public.packing (cot_numero) WHERE cot_numero IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_packing_crm_cot    ON public.packing (crm_cotizacion_id) WHERE crm_cotizacion_id IS NOT NULL;

  -- ═══ §2 · cotización web ↔ packing ═════════════════════════════════════════
  ALTER TABLE public.crm_cotizaciones
    ADD COLUMN IF NOT EXISTS packing_id bigint REFERENCES public.packing(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_crm_cot_packing ON public.crm_cotizaciones (packing_id) WHERE packing_id IS NOT NULL;

  -- ═══ §3 · guía de despacho: dirección de entrega (punto de llegada) ════════
  ALTER TABLE public.guias_despacho_venta
    ADD COLUMN IF NOT EXISTS punto_llegada_direccion varchar,
    ADD COLUMN IF NOT EXISTS punto_llegada_distrito  varchar,
    ADD COLUMN IF NOT EXISTS punto_llegada_maps_url  text;
  COMMENT ON COLUMN public.guias_despacho_venta.punto_llegada_direccion IS 'Dirección donde llega la mercadería. Puede ser distinta del domicilio fiscal del cliente (RCP art. 19.2: se exige la dirección del punto de llegada).';

  -- ═══ §4 · notificaciones (campanita) ═══════════════════════════════════════
  CREATE TABLE IF NOT EXISTS public.notificaciones (
    id          bigserial PRIMARY KEY,
    empresa_id  integer REFERENCES public.empresa_config(id) ON DELETE CASCADE,
    tipo        varchar NOT NULL,                       -- p.ej. 'cot_bajo_pv_lista'
    severidad   varchar NOT NULL DEFAULT 'aviso' CHECK (severidad IN ('info', 'aviso', 'alerta')),
    titulo      varchar NOT NULL,
    detalle     text,
    url         varchar,                                -- enlace al módulo, ya con ?q=<cliente>
    ref_tabla   varchar,
    ref_id      varchar,
    created_by  bigint,
    created_at  timestamptz NOT NULL DEFAULT now(),
    leida_at    timestamptz,
    leida_por   bigint
  );
  -- Un aviso abierto por documento y tipo: al editar el PK se reemplaza, no se duplica
  CREATE UNIQUE INDEX IF NOT EXISTS uq_notif_abierta ON public.notificaciones (tipo, ref_tabla, ref_id)
    WHERE leida_at IS NULL AND ref_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_notif_emp ON public.notificaciones (empresa_id, created_at DESC);

  ALTER TABLE public.notificaciones ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.notificaciones FROM anon, PUBLIC;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.notificaciones TO authenticated, service_role;
  GRANT USAGE, SELECT ON SEQUENCE public.notificaciones_id_seq TO authenticated, service_role;
  DROP POLICY IF EXISTS notificaciones_auth ON public.notificaciones;
  CREATE POLICY notificaciones_auth ON public.notificaciones FOR ALL TO authenticated USING (true) WITH CHECK (true);

  -- ═══ §5 · v_packing_despacho — facturado vs despachado por PK ══════════════
  -- Solo cuentan facturas/boletas VIGENTES (01/03) y guías no anuladas.
  CREATE OR REPLACE VIEW public.v_packing_despacho AS
  WITH fv AS (
    SELECT v.packing_id, v.id AS venta_id, v.serie, v.correlativo, v.fecha_emision
      FROM public.ventas v
    WHERE v.packing_id IS NOT NULL
      AND v.tipo_comprobante IN ('01', '03')
      AND COALESCE(v.estado, '') <> 'anulada'
      AND COALESCE((to_jsonb(v) ->> 'comprobante_anulado')::boolean, false) = false
      AND COALESCE(to_jsonb(v) ->> 'estado_comprobante', '1') <> '0'
  ),
  fk AS (
    SELECT fv.packing_id, SUM(dv.cantidad) AS kg
      FROM fv JOIN public.detalle_ventas dv ON dv.venta_id = fv.venta_id GROUP BY fv.packing_id
  ),
  gv AS (
    SELECT fv.packing_id, g.id AS guia_id, g.numero_guia, g.fecha_guia
      FROM fv JOIN public.guias_despacho_venta g ON g.venta_id = fv.venta_id
    WHERE COALESCE(g.estado, 'emitida') <> 'anulada'
  ),
  gk AS (
    SELECT gv.packing_id, SUM(dg.cantidad) AS kg
      FROM gv JOIN public.detalle_guias_despacho_venta dg ON dg.guia_id = gv.guia_id GROUP BY gv.packing_id
  ),
  uf AS (
    SELECT DISTINCT ON (fv.packing_id) fv.packing_id, fv.venta_id,
          (COALESCE(fv.serie, '') || '-' || lpad(COALESCE(fv.correlativo, ''), 8, '0')) AS numero, fv.fecha_emision
      FROM fv ORDER BY fv.packing_id, fv.fecha_emision DESC, fv.venta_id DESC
  ),
  ug AS (
    SELECT DISTINCT ON (gv.packing_id) gv.packing_id, gv.numero_guia, gv.fecha_guia
      FROM gv ORDER BY gv.packing_id, gv.fecha_guia DESC, gv.guia_id DESC
  )
  SELECT p.id AS packing_id, p.empresa_id,
        COALESCE(fk.kg, 0) AS facturado_kg,
        COALESCE(gk.kg, 0) AS despachado_kg,
        (CASE WHEN fk.kg IS NULL THEN 'sin_factura'
              WHEN COALESCE(gk.kg, 0) <= 0.0005 THEN 'sin_guia'
              WHEN gk.kg < fk.kg - 0.01 THEN 'guia_parcial'
              ELSE 'con_guia' END)::text AS estado_despacho,
        uf.numero AS ultima_factura, uf.fecha_emision AS fecha_ultima_factura,
        ug.numero_guia AS ultima_guia, ug.fecha_guia AS fecha_ultima_guia
    FROM public.packing p
    LEFT JOIN fk ON fk.packing_id = p.id
    LEFT JOIN gk ON gk.packing_id = p.id
    LEFT JOIN uf ON uf.packing_id = p.id
    LEFT JOIN ug ON ug.packing_id = p.id;

  REVOKE ALL ON public.v_packing_despacho FROM PUBLIC, anon;
  GRANT SELECT ON public.v_packing_despacho TO authenticated, service_role;

  -- ═══ §6 · Bandeja CRM: una fila por COT, mostrando el ÚLTIMO documento emitido ═
  -- estado_flujo: cotizacion | pk | por_retirar | facturado_sin_guia | guia_parcial | despachado
  -- p_todo=false → solo lo accionable (oculta despachados y PK directos sin factura).
  CREATE OR REPLACE FUNCTION public.crm_bandeja(p_empresa integer, p_todo boolean DEFAULT false)
  RETURNS TABLE (
    origen text, ref_id text, cot_numero text, doc_actual text, doc_tipo text, fecha_doc date,
    cliente text, contact_id bigint, total numeric, moneda text, estado_flujo text,
    termino_despacho text, distrito text, maps_url text, bajo_pv_lista boolean,
    dias_espera integer, vendedor_id bigint, semaforo text, packing_id bigint, crm_cotizacion_id uuid
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
  DECLARE v_uid bigint := public.fn_usuario_id();
  BEGIN
    IF NOT public.fn_es_staff_crm() THEN RAISE EXCEPTION 'Sin permiso.' USING ERRCODE = '42501'; END IF;
    RETURN QUERY
    -- (a) cotizaciones de la web aún no convertidas
    SELECT 'web'::text, c.id::text, c.numero::text, c.numero::text, 'COT web'::text, c.created_at::date,
          c.razon_social::text, k.contact_id, c.total, c.moneda::text, 'cotizacion'::text,
          NULL::text, c.distrito_entrega::text, NULL::text, false,
          NULL::integer, c.vendedor_id,
          (SELECT (CASE WHEN bool_or(x.semaforo = 'rojo') THEN 'rojo' WHEN bool_or(x.semaforo = 'amarillo') THEN 'amarillo'
                        WHEN bool_or(x.semaforo = 'verde') THEN 'verde' ELSE 'sin_costo' END)::text
              FROM public.crm_cotizacion_costos x WHERE x.cotizacion_id = c.id),
          NULL::bigint, c.id
      FROM public.crm_cotizaciones c
      LEFT JOIN public.crm_clientes k ON k.id = c.cliente_id
    WHERE c.empresa_id = p_empresa AND c.packing_id IS NULL
      AND c.estado NOT IN ('perdida', 'cancelada', 'convertida')
      AND (public.fn_crm_gestor() OR c.vendedor_id = v_uid OR c.vendedor_id IS NULL)
    UNION ALL
    -- (b) cotizaciones y packings del ERP
    SELECT 'erp'::text, p.id::text,
          COALESCE(p.cot_numero, CASE WHEN p.estado = 'cotizacion' THEN p.numero END)::text,
          (CASE WHEN d.ultima_guia IS NOT NULL THEN d.ultima_guia
                WHEN d.ultima_factura IS NOT NULL THEN d.ultima_factura
                ELSE p.numero END)::text,
          (CASE WHEN d.ultima_guia IS NOT NULL THEN 'Guía'
                WHEN d.ultima_factura IS NOT NULL THEN 'Factura'
                WHEN p.estado = 'cotizacion' THEN 'COT' ELSE 'PK' END)::text,
          COALESCE(d.fecha_ultima_guia, d.fecha_ultima_factura, p.fecha_emision),
          ct.nombre::text, p.contact_id, p.total, p.moneda::text,
          (CASE WHEN p.estado = 'cotizacion' THEN 'cotizacion'
                WHEN d.estado_despacho = 'sin_factura' THEN 'pk'
                WHEN d.estado_despacho = 'sin_guia' THEN
                      CASE WHEN p.termino_despacho = 'recoge_cliente' THEN 'por_retirar' ELSE 'facturado_sin_guia' END
                WHEN d.estado_despacho = 'guia_parcial' THEN 'guia_parcial'
                ELSE 'despachado' END)::text,
          p.termino_despacho::text, p.despacho_distrito::text, p.despacho_maps_url, p.bajo_pv_lista,
          (CASE WHEN d.estado_despacho IN ('sin_guia', 'guia_parcial') THEN (current_date - d.fecha_ultima_factura) END)::integer,
          p.vendedor_id, NULL::text, p.id, p.crm_cotizacion_id
      FROM public.packing p
      JOIN public.v_packing_despacho d ON d.packing_id = p.id
      LEFT JOIN public.contacts ct ON ct.id = p.contact_id
    WHERE p.empresa_id = p_empresa AND p.estado <> 'anulado' AND COALESCE(p.tipo, 'venta') = 'venta'
      AND (public.fn_crm_gestor() OR p.vendedor_id = v_uid OR p.vendedor_id IS NULL)
      AND ( p_todo
            OR p.estado = 'cotizacion'
            OR d.estado_despacho IN ('sin_guia', 'guia_parcial')
            OR (d.estado_despacho = 'sin_factura' AND p.cot_numero IS NOT NULL) )
    ORDER BY 6 DESC NULLS LAST;
  END $$;

  -- ═══ §7 · Recordatorio amigable: facturado, día vencido y sin guía (para la campanita) ═
  CREATE OR REPLACE FUNCTION public.avisos_por_despachar(p_empresas integer[])
  RETURNS TABLE (packing_id bigint, empresa_id integer, numero text, cot_numero text, cliente text,
                ultima_factura text, fecha_ultima_factura date, dias integer, estado_despacho text, termino_despacho text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
  BEGIN
    -- Solo staff (admin/oficina/vendedor): para el resto la campanita queda vacía, sin error
    IF NOT public.fn_es_staff_crm() THEN RETURN; END IF;
    RETURN QUERY
    SELECT p.id, p.empresa_id, p.numero::text, p.cot_numero::text, ct.nombre::text,
          d.ultima_factura::text, d.fecha_ultima_factura, (current_date - d.fecha_ultima_factura)::integer,
          d.estado_despacho, p.termino_despacho::text
      FROM public.packing p
      JOIN public.v_packing_despacho d ON d.packing_id = p.id
      LEFT JOIN public.contacts ct ON ct.id = p.contact_id
    WHERE p.estado <> 'anulado' AND p.empresa_id = ANY (p_empresas)
      AND d.estado_despacho IN ('sin_guia', 'guia_parcial')
      AND d.fecha_ultima_factura < current_date
    ORDER BY d.fecha_ultima_factura
    LIMIT 100;
  END $$;

  -- ═══ §8 · Apoyo del modal del PK ═══════════════════════════════════════════
  -- PV de lista vigente y umbrales de margen por artículo (precio de lista es público; no hay costos aquí)
  CREATE OR REPLACE FUNCTION public.crm_pv_lista_items(p_empresa integer, p_items bigint[])
  RETURNS TABLE (item_id bigint, precio_lista numeric, moneda text, igv_incluido boolean, igv_pct numeric,
                margen_objetivo numeric, margen_minimo numeric)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT i.id,
          (SELECT l.precio_lista FROM public.lotes l
            WHERE l.item_id = i.id AND l.empresa_id = p_empresa AND l.precio_lista > 0
            ORDER BY (COALESCE((SELECT SUM(su.cantidad) FROM public.stock_ubicaciones su WHERE su.lote_id = l.id), 0) > 0) DESC,
                      l.fecha_ingreso DESC NULLS LAST, l.id DESC LIMIT 1),
          cfg.moneda_precio::text, cfg.igv_incluido, COALESCE(e.igv_porcentaje, 18),
          m.objetivo, m.minimo
      FROM public.items i
      CROSS JOIN public.crm_config cfg
      JOIN public.empresa_config e ON e.id = cfg.empresa_id
      CROSS JOIN LATERAL public.fn_crm_margenes(p_empresa, i.id) m
    WHERE cfg.empresa_id = p_empresa AND i.id = ANY (p_items)
  $$;

  CREATE OR REPLACE FUNCTION public.crm_flete_distritos()
  RETURNS TABLE (distrito text, km numeric)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT z.distrito::text, z.km FROM public.crm_flete_zonas z WHERE z.activo ORDER BY z.distrito
  $$;

  -- Costo interno de despacho para un PK (S/). Usa la misma tabla del CRM; no depende del rol.
  CREATE OR REPLACE FUNCTION public.packing_flete_calcular(p_empresa integer, p_distrito text, p_kg numeric)
  RETURNS TABLE (km numeric, costo numeric, estado text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT f.km, f.recargo, f.estado FROM public.fn_crm_flete(p_empresa, p_distrito, p_kg) f
  $$;

  -- ═══ §9 · Cotización web → cotización ERP (COT-000N) ═══════════════════════
  CREATE OR REPLACE FUNCTION public.crm_convertir_a_packing(p_cot uuid)
  RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  DECLARE
    c public.crm_cotizaciones%ROWTYPE; k public.crm_clientes%ROWTYPE;
    v_contact bigint; v_n integer; v_pk bigint; v_igv numeric; v_tc numeric := 1;
    d record; v_sin numeric; v_sub numeric; v_igvm numeric; v_tot numeric;
    t_sub numeric := 0; t_igv numeric := 0; t_tot numeric := 0; v_ord integer := 0;
  BEGIN
    IF NOT public.fn_es_staff_crm() THEN RAISE EXCEPTION 'Sin permiso.' USING ERRCODE = '42501'; END IF;
    SELECT * INTO c FROM public.crm_cotizaciones WHERE id = p_cot;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cotización no encontrada.'; END IF;
    IF c.packing_id IS NOT NULL THEN RAISE EXCEPTION 'Esta cotización ya fue convertida.'; END IF;
    IF NOT (public.fn_crm_gestor() OR c.vendedor_id = public.fn_usuario_id() OR c.vendedor_id IS NULL) THEN
      RAISE EXCEPTION 'No es tu cotización.' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO k FROM public.crm_clientes WHERE id = c.cliente_id;
    v_contact := COALESCE(k.contact_id, (SELECT ct.id FROM public.contacts ct WHERE ct.nro_documento = k.ruc LIMIT 1));
    IF v_contact IS NULL THEN
      RAISE EXCEPTION 'El cliente (RUC %) aún no existe en Contactos del ERP. Créalo allí y vuelve a convertir.', k.ruc;
    END IF;
    SELECT COALESCE(igv_porcentaje, 18) INTO v_igv FROM public.empresa_config WHERE id = c.empresa_id;
    IF c.moneda = 'USD' THEN v_tc := COALESCE(public.fn_crm_tc(), 1); END IF;

    SELECT COALESCE(MAX(cot_correlativo), 0) + 1 INTO v_n FROM public.packing WHERE empresa_id = c.empresa_id AND cot_correlativo IS NOT NULL;

    INSERT INTO public.packing (tipo, serie, correlativo, cot_correlativo, numero, cot_numero, contact_id, fecha_emision, fecha_validez,
                                moneda, tipo_cambio, vendedor_id, observaciones, subtotal, igv, total, estado, empresa_id,
                                crm_cotizacion_id, despacho_direccion, despacho_distrito, despacho_usa_dir_cliente, created_by)
    VALUES ('venta', 'PK', NULL, v_n, 'COT-' || lpad(v_n::text, 4, '0'), c.numero, v_contact, current_date, current_date + 15,
            c.moneda, v_tc, c.vendedor_id, c.notas_cliente, 0, 0, 0, 'cotizacion', c.empresa_id,
            c.id, NULLIF(c.dir_entrega, ''), NULLIF(c.distrito_entrega, ''), false, public.fn_usuario_id())
    RETURNING id INTO v_pk;

    FOR d IN SELECT * FROM public.crm_cotizacion_detalle WHERE cotizacion_id = c.id ORDER BY orden_linea LOOP
      v_ord := v_ord + 1;
      v_sin := CASE WHEN c.igv_incluido THEN d.precio_unitario / (1 + v_igv / 100) ELSE d.precio_unitario END;
      v_sub := round(d.cantidad_kg * v_sin * (1 - d.descuento_pct / 100), 2);
      v_igvm := round(v_sub * v_igv / 100, 2);
      v_tot := v_sub + v_igvm;
      INSERT INTO public.detalle_packing (packing_id, orden, item_id, descripcion, nota, cantidad, unidad_medida, cantidad_unidades,
                                          precio_unitario, tipo_base, igv_porcentaje, subtotal, igv_monto, total_linea, igv_incluido, precio_con_igv)
      VALUES (v_pk, v_ord, d.item_id, left(d.producto_nombre || COALESCE(' ' || d.color_nombre, ''), 250), NULL, d.cantidad_kg, 'KG', 0,
              round(v_sin, 6), 'gravada', v_igv, v_sub, v_igvm, v_tot, c.igv_incluido,
              CASE WHEN c.igv_incluido THEN d.precio_unitario END);
      t_sub := t_sub + v_sub; t_igv := t_igv + v_igvm; t_tot := t_tot + v_tot;
    END LOOP;
    UPDATE public.packing SET subtotal = t_sub, igv = t_igv, total = t_tot WHERE id = v_pk;

    UPDATE public.crm_cotizaciones SET packing_id = v_pk,
          estado = CASE WHEN estado IN ('enviada', 'en_revision') THEN 'cotizada' ELSE estado END
    WHERE id = c.id;
    INSERT INTO public.crm_seguimiento (cotizacion_id, tipo, detalle, user_id)
    VALUES (c.id, 'nota', 'Convertida en cotización ERP COT-' || lpad(v_n::text, 4, '0'), public.fn_usuario_id());
    RETURN v_pk;
  END $$;

  -- ═══ §10 · Permisos ═══════════════════════════════════════════════════════
  REVOKE EXECUTE ON FUNCTION
    public.crm_bandeja(integer, boolean), public.avisos_por_despachar(integer[]),
    public.crm_pv_lista_items(integer, bigint[]), public.crm_flete_distritos(),
    public.packing_flete_calcular(integer, text, numeric), public.crm_convertir_a_packing(uuid)
    FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION
    public.crm_bandeja(integer, boolean), public.avisos_por_despachar(integer[]),
    public.crm_pv_lista_items(integer, bigint[]), public.crm_flete_distritos(),
    public.packing_flete_calcular(integer, text, numeric), public.crm_convertir_a_packing(uuid)
    TO authenticated, service_role;

  NOTIFY pgrst, 'reload schema';
  COMMIT;

  -- Verificación (debe devolver OK en las 3 filas)
  SELECT CASE WHEN count(*) = 6 THEN 'OK · anon sigue ejecutando solo las 6 funciones públicas' ELSE 'REVISAR · anon ejecuta ' || count(*) END AS control
    FROM information_schema.routine_privileges
  WHERE grantee = 'anon' AND routine_schema = 'public' AND privilege_type = 'EXECUTE'
  UNION ALL
  SELECT CASE WHEN has_table_privilege('anon', 'public.notificaciones', 'SELECT') OR has_table_privilege('anon', 'public.v_packing_despacho', 'SELECT')
              THEN 'REVISAR · anon puede leer notificaciones o la vista' ELSE 'OK · notificaciones y vista cerradas a anon' END
  UNION ALL
  SELECT 'INFO · PK con COT de origen: ' || count(*) FROM public.packing WHERE cot_numero IS NOT NULL;
