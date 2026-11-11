-- ============================================================================
-- 155 · CRM · Documentos formato (Orden de Producción y Solicitud de Línea de Crédito)
-- 2026-11-11 · Requiere SQL 131 (fn_es_staff_crm, fn_usuario_id) y empresa_config.
-- ----------------------------------------------------------------------------
--   · crm_documentos_formato: historial de cada documento emitido (número correlativo SIMPLE por
--     empresa y tipo: OP-0001, SLC-0001) + copia de los datos para reabrirlo y editarlo.
--   · crm_doc_emitir(): asigna el siguiente número de forma segura (sin duplicados) y guarda el documento.
-- NO BORRA NADA. IDEMPOTENTE. Sin política de DELETE (nadie borra documentos desde la app).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.crm_documentos_formato (
  id             bigserial   PRIMARY KEY,
  empresa_id     integer     NOT NULL REFERENCES public.empresa_config(id),
  tipo           text        NOT NULL CHECK (tipo IN ('OP', 'SLC')),   -- OP = Orden de Producción · SLC = Solicitud de Línea de Crédito
  numero         text        NOT NULL,
  contact_id     bigint      REFERENCES public.contacts(id),
  cliente_nombre text,
  datos          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_by     bigint      REFERENCES public.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_doc_formato_uq UNIQUE (empresa_id, tipo, numero)
);
CREATE INDEX IF NOT EXISTS idx_crm_doc_formato_emp ON public.crm_documentos_formato (empresa_id, created_at DESC);
COMMENT ON TABLE public.crm_documentos_formato IS 'Documentos formales generados desde CRM → Documentos (OP/SLC) con su número y los datos tal como se imprimieron.';

ALTER TABLE public.crm_documentos_formato ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_doc_formato_lee ON public.crm_documentos_formato;
CREATE POLICY crm_doc_formato_lee ON public.crm_documentos_formato FOR SELECT TO authenticated USING (public.fn_es_staff_crm());
DROP POLICY IF EXISTS crm_doc_formato_edita ON public.crm_documentos_formato;
CREATE POLICY crm_doc_formato_edita ON public.crm_documentos_formato FOR UPDATE TO authenticated USING (public.fn_es_staff_crm()) WITH CHECK (public.fn_es_staff_crm());
REVOKE ALL ON public.crm_documentos_formato FROM anon;

CREATE OR REPLACE FUNCTION public.crm_doc_emitir(p_empresa integer, p_tipo text, p_contact_id bigint, p_cliente text, p_datos jsonb)
RETURNS TABLE (doc_id bigint, doc_numero text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer; v_num text; v_id bigint;
BEGIN
  IF NOT public.fn_es_staff_crm() THEN RAISE EXCEPTION 'Sin permiso.' USING ERRCODE = '42501'; END IF;
  IF p_tipo NOT IN ('OP', 'SLC') THEN RAISE EXCEPTION 'Tipo de documento inválido: %', p_tipo; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('crm_doc_formato_' || p_empresa::text || p_tipo));
  SELECT COALESCE(max(NULLIF(substring(d.numero FROM '[0-9]+$'), '')::integer), 0) + 1 INTO v_n
    FROM public.crm_documentos_formato d WHERE d.empresa_id = p_empresa AND d.tipo = p_tipo;
  v_num := p_tipo || '-' || lpad(v_n::text, 4, '0');
  INSERT INTO public.crm_documentos_formato (empresa_id, tipo, numero, contact_id, cliente_nombre, datos, created_by)
  VALUES (p_empresa, p_tipo, v_num, p_contact_id, NULLIF(btrim(p_cliente), ''), COALESCE(p_datos, '{}'::jsonb), public.fn_usuario_id())
  RETURNING crm_documentos_formato.id INTO v_id;
  RETURN QUERY SELECT v_id, v_num;
END $$;
REVOKE EXECUTE ON FUNCTION public.crm_doc_emitir(integer, text, bigint, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_doc_emitir(integer, text, bigint, text, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;

SELECT 'OK · tabla crm_documentos_formato: ' || count(*) AS control FROM public.crm_documentos_formato
UNION ALL SELECT 'OK · anon sin acceso a crm_doc_emitir: ' || (NOT has_function_privilege('anon', 'public.crm_doc_emitir(integer,text,bigint,text,jsonb)', 'EXECUTE'))::text;
