-- ============================================================================
-- 161_tareas.sql — Módulo TAREAS: «quién le debe qué a quién» (2026-11-20)   [Nº PROVISIONAL: revisar assets/sql antes de subir]
-- Requiere: SQL 05 (users, fn_is_admin), 134 (empleados), empresa_config, contacts.
--
-- Diseño:
--  · solicitante = usuario (users.id, integer) · responsable y «bloqueada por» = FICHA de empleado
--    (empleados.id): así una persona SIN cuenta también puede tener tareas, que administra su jefe.
--  · Privacidad REAL en el servidor (no solo en la pantalla): un colaborador solo ve las tareas donde es
--    solicitante, responsable o quien lo bloquea; el jefe de área ve las de su área; el admin ve todas.
--  · Toda escritura pasa por funciones (SECURITY DEFINER) que validan permisos y dejan la bitácora.
--    Las tablas no tienen políticas de INSERT/UPDATE/DELETE: el navegador no puede escribir directo.
--  · Jefe de área = casilla en la ficha (empleados.es_jefe_area + empleados.area).
--  · Recurrentes: se generan al abrir el módulo (idempotente por recurrente+periodo); sirve también con pg_cron.
-- ============================================================================

-- 0) Organigrama mínimo en la ficha del empleado
ALTER TABLE public.empleados ADD COLUMN IF NOT EXISTS area         varchar;
ALTER TABLE public.empleados ADD COLUMN IF NOT EXISTS es_jefe_area boolean NOT NULL DEFAULT false;

-- 1) Ayudantes de identidad (siempre desde el token, nunca desde lo que mande el navegador)
CREATE OR REPLACE FUNCTION public.fn_user_id() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM public.users WHERE auth_id = auth.uid() AND active LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.fn_areas_jefe() RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(DISTINCT lower(btrim(e.area))), '{}'::text[])
    FROM public.empleados e
   WHERE e.user_id = public.fn_user_id() AND e.es_jefe_area AND e.estado = 'activo' AND e.area IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION public.fn_es_jefe() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT cardinality(public.fn_areas_jefe()) > 0
$$;

-- 2) Tablas
CREATE TABLE IF NOT EXISTS public.tareas_recurrentes (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id               integer     NOT NULL REFERENCES public.empresa_config(id) ON DELETE CASCADE,
  titulo                   text        NOT NULL CHECK (length(btrim(titulo)) >= 3),
  detalle                  text,
  area                     text,
  responsable_empleado_id  integer     REFERENCES public.empleados(id),
  solicitante_id           integer     NOT NULL REFERENCES public.users(id),
  prioridad                text        NOT NULL DEFAULT 'normal' CHECK (prioridad IN ('baja','normal','alta','urgente')),
  periodicidad             text        NOT NULL CHECK (periodicidad IN ('diaria','semanal','quincenal','mensual')),
  dia_referencia           integer,    -- FECHA LÍMITE: semanal = día de la semana (1=Lun…7=Dom); mensual = día del mes (si el mes es más corto, el último día)
  activa                   boolean     NOT NULL DEFAULT true,
  ultimo_periodo           text,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tareas (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id                 integer     NOT NULL REFERENCES public.empresa_config(id) ON DELETE CASCADE,
  titulo                     text        NOT NULL CHECK (length(btrim(titulo)) >= 3),
  detalle                    text,
  area                       text,
  modulo_ref                 text,       -- 'cobranzas', 'compras'… para enlazar al módulo
  registro_ref               text,       -- id del documento relacionado
  registro_etiqueta          text,       -- cómo se muestra: «Letra 0042»
  solicitante_id             integer     NOT NULL REFERENCES public.users(id),
  responsable_empleado_id    integer     REFERENCES public.empleados(id),
  prioridad                  text        NOT NULL DEFAULT 'normal' CHECK (prioridad IN ('baja','normal','alta','urgente')),
  estado                     text        NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','en_proceso','bloqueada','en_revision','hecha','anulada')),
  -- el campo que desactiva las discusiones: quién frena y desde cuándo (puede ser externo → solo motivo)
  bloqueada_por_empleado_id  integer     REFERENCES public.empleados(id),
  bloqueo_motivo             text,
  bloqueada_desde            timestamptz,
  fecha_limite               date,
  fecha_inicio               timestamptz,
  fecha_hecha                timestamptz,
  visto_resp_at              timestamptz, -- cuándo la abrió el responsable (para avisar «te asignaron»)
  recurrente_id              uuid        REFERENCES public.tareas_recurrentes(id) ON DELETE SET NULL,
  periodo                    text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_tarea_bloqueo CHECK (estado <> 'bloqueada' OR (bloqueo_motivo IS NOT NULL AND bloqueada_desde IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.tareas_bitacora (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tarea_id       uuid        NOT NULL REFERENCES public.tareas(id) ON DELETE CASCADE,
  usuario_id     integer     NOT NULL REFERENCES public.users(id),
  tipo           text        NOT NULL CHECK (tipo IN ('creacion','comentario','cambio_estado','reasignacion','bloqueo','desbloqueo','edicion')),
  detalle        text,
  estado_antes   text,
  estado_despues text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Índices (la RLS evalúa fila por fila; sin índice el módulo se arrastra)
CREATE INDEX IF NOT EXISTS idx_tareas_empresa      ON public.tareas(empresa_id);
CREATE INDEX IF NOT EXISTS idx_tareas_responsable  ON public.tareas(responsable_empleado_id);
CREATE INDEX IF NOT EXISTS idx_tareas_solicitante  ON public.tareas(solicitante_id);
CREATE INDEX IF NOT EXISTS idx_tareas_bloqueador   ON public.tareas(bloqueada_por_empleado_id) WHERE estado = 'bloqueada';
CREATE INDEX IF NOT EXISTS idx_tareas_estado       ON public.tareas(estado);
CREATE INDEX IF NOT EXISTS idx_tareas_fecha_limite ON public.tareas(fecha_limite);
CREATE INDEX IF NOT EXISTS idx_tareas_area         ON public.tareas(lower(area));
CREATE UNIQUE INDEX IF NOT EXISTS uq_tareas_recurrente_periodo ON public.tareas(recurrente_id, periodo) WHERE recurrente_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tareas_bitacora     ON public.tareas_bitacora(tarea_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tareas_rec_empresa  ON public.tareas_recurrentes(empresa_id);

-- 3) Quién puede ver / hacer qué (UNA sola fuente de verdad: la usan las políticas y las funciones)
CREATE OR REPLACE FUNCTION public.fn_puede_ver_tarea(t public.tareas) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.fn_user_id() IS NOT NULL AND (
       public.fn_is_admin()
    OR t.solicitante_id = public.fn_user_id()
    OR EXISTS (SELECT 1 FROM public.empleados e
                WHERE e.user_id = public.fn_user_id() AND e.id IN (t.responsable_empleado_id, t.bloqueada_por_empleado_id))
    OR (t.area IS NOT NULL AND lower(btrim(t.area)) = ANY (public.fn_areas_jefe()))
  )
$$;

CREATE OR REPLACE FUNCTION public.fn_tarea_permisos(t public.tareas) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me integer := public.fn_user_id();
  es_sol boolean; es_resp boolean; es_blq boolean; es_jefe boolean; abierta boolean;
BEGIN
  es_sol  := t.solicitante_id = v_me;
  es_resp := EXISTS (SELECT 1 FROM public.empleados e WHERE e.id = t.responsable_empleado_id AND e.user_id = v_me);
  es_blq  := EXISTS (SELECT 1 FROM public.empleados e WHERE e.id = t.bloqueada_por_empleado_id AND e.user_id = v_me);
  es_jefe := public.fn_is_admin() OR (t.area IS NOT NULL AND lower(btrim(t.area)) = ANY (public.fn_areas_jefe()));
  abierta := t.estado NOT IN ('hecha','anulada');
  RETURN jsonb_build_object(
    'es_sol', es_sol, 'es_resp', es_resp, 'es_blq', es_blq, 'es_jefe', es_jefe,
    'cambiar_estado', (es_resp OR es_sol OR es_jefe),
    'bloquear',       abierta AND t.estado <> 'bloqueada' AND (es_resp OR es_jefe),
    'desbloquear',    t.estado = 'bloqueada' AND (es_resp OR es_blq OR es_sol OR es_jefe),
    'reasignar',      abierta AND (es_sol OR es_jefe),
    'editar',         abierta AND (es_sol OR es_jefe),
    'anular',         abierta AND (es_sol OR es_jefe));
END $$;

-- 4) RLS: solo lectura, y solo lo que corresponde. Sin políticas de escritura = el navegador no puede escribir directo.
ALTER TABLE public.tareas             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tareas_bitacora    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tareas_recurrentes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tareas_ver ON public.tareas;
CREATE POLICY tareas_ver ON public.tareas FOR SELECT TO authenticated USING (public.fn_puede_ver_tarea(tareas));

DROP POLICY IF EXISTS tareas_bitacora_ver ON public.tareas_bitacora;
CREATE POLICY tareas_bitacora_ver ON public.tareas_bitacora FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.tareas t WHERE t.id = tareas_bitacora.tarea_id));        -- hereda la RLS de tareas

DROP POLICY IF EXISTS tareas_rec_ver ON public.tareas_recurrentes;
CREATE POLICY tareas_rec_ver ON public.tareas_recurrentes FOR SELECT TO authenticated
  USING (public.fn_is_admin() OR solicitante_id = public.fn_user_id() OR (area IS NOT NULL AND lower(btrim(area)) = ANY (public.fn_areas_jefe())));

-- Supabase da todos los privilegios por defecto: se quitan y se deja solo SELECT
REVOKE ALL ON public.tareas, public.tareas_bitacora, public.tareas_recurrentes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tareas, public.tareas_bitacora, public.tareas_recurrentes TO authenticated;

-- 5) Funciones de ESCRITURA (validan permisos y dejan bitácora)
CREATE OR REPLACE FUNCTION public.tareas_crear(
  p_empresa_id integer, p_titulo text, p_responsable_empleado_id integer, p_fecha_limite date,
  p_detalle text DEFAULT NULL, p_area text DEFAULT NULL, p_prioridad text DEFAULT 'normal',
  p_modulo_ref text DEFAULT NULL, p_registro_ref text DEFAULT NULL, p_registro_etiqueta text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me integer := public.fn_user_id();
  v_area text := NULLIF(btrim(COALESCE(p_area, '')), '');
  v_id uuid;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Sesión no válida'; END IF;
  IF length(btrim(COALESCE(p_titulo, ''))) < 3 THEN RAISE EXCEPTION 'Escribe qué hay que hacer (mínimo 3 letras)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.empresa_config WHERE id = p_empresa_id) THEN RAISE EXCEPTION 'Empresa no válida'; END IF;
  IF p_responsable_empleado_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.empleados WHERE id = p_responsable_empleado_id AND estado = 'activo') THEN
      RAISE EXCEPTION 'El responsable no existe o no está activo';
    END IF;
    IF v_area IS NULL THEN SELECT area INTO v_area FROM public.empleados WHERE id = p_responsable_empleado_id; END IF;   -- semi-automático: hereda el área del responsable
  END IF;
  INSERT INTO public.tareas (empresa_id, titulo, detalle, area, modulo_ref, registro_ref, registro_etiqueta, solicitante_id,
                             responsable_empleado_id, prioridad, fecha_limite)
  VALUES (p_empresa_id, btrim(p_titulo), NULLIF(btrim(COALESCE(p_detalle, '')), ''), v_area, p_modulo_ref, p_registro_ref, p_registro_etiqueta,
          v_me, p_responsable_empleado_id, COALESCE(p_prioridad, 'normal'), p_fecha_limite)
  RETURNING id INTO v_id;
  INSERT INTO public.tareas_bitacora (tarea_id, usuario_id, tipo, detalle, estado_despues) VALUES (v_id, v_me, 'creacion', 'Tarea creada', 'pendiente');
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION public.tareas_cambiar_estado(p_tarea_id uuid, p_estado text, p_nota text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me integer := public.fn_user_id();
  v_t  public.tareas%ROWTYPE;
  v_p  jsonb;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Sesión no válida'; END IF;
  SELECT * INTO v_t FROM public.tareas WHERE id = p_tarea_id FOR UPDATE;
  IF NOT FOUND OR NOT public.fn_puede_ver_tarea(v_t) THEN RAISE EXCEPTION 'Tarea no encontrada'; END IF;
  v_p := public.fn_tarea_permisos(v_t);
  IF p_estado NOT IN ('pendiente','en_proceso','en_revision','hecha','anulada') THEN
    RAISE EXCEPTION 'Para bloquear una tarea usa «Estoy esperando a…»';
  END IF;
  IF v_t.estado = 'bloqueada' THEN RAISE EXCEPTION 'La tarea está bloqueada: primero desbloquéala'; END IF;
  IF p_estado = v_t.estado THEN RAISE EXCEPTION 'La tarea ya está en ese estado'; END IF;
  IF NOT (v_p->>'cambiar_estado')::boolean THEN RAISE EXCEPTION 'No tienes permiso para cambiar esta tarea'; END IF;
  IF p_estado = 'anulada' AND NOT (v_p->>'anular')::boolean THEN RAISE EXCEPTION 'Solo quien la pidió o un jefe puede anularla'; END IF;
  IF v_t.estado IN ('hecha','anulada') AND NOT ((v_p->>'es_sol')::boolean OR (v_p->>'es_jefe')::boolean) THEN
    RAISE EXCEPTION 'Solo quien la pidió o un jefe puede reabrirla';
  END IF;

  UPDATE public.tareas SET
         estado = p_estado,
         fecha_inicio = CASE WHEN p_estado = 'en_proceso' AND fecha_inicio IS NULL THEN now() ELSE fecha_inicio END,
         fecha_hecha  = CASE WHEN p_estado = 'hecha' THEN now() ELSE NULL END,
         updated_at = now()
   WHERE id = p_tarea_id;
  INSERT INTO public.tareas_bitacora (tarea_id, usuario_id, tipo, detalle, estado_antes, estado_despues)
  VALUES (p_tarea_id, v_me, 'cambio_estado', NULLIF(btrim(COALESCE(p_nota, '')), ''), v_t.estado, p_estado);
  RETURN jsonb_build_object('ok', true, 'estado', p_estado);
END $$;

CREATE OR REPLACE FUNCTION public.tareas_bloquear(p_tarea_id uuid, p_bloqueada_por_empleado_id integer, p_motivo text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me integer := public.fn_user_id();
  v_t  public.tareas%ROWTYPE;
  v_nom text;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Sesión no válida'; END IF;
  SELECT * INTO v_t FROM public.tareas WHERE id = p_tarea_id FOR UPDATE;
  IF NOT FOUND OR NOT public.fn_puede_ver_tarea(v_t) THEN RAISE EXCEPTION 'Tarea no encontrada'; END IF;
  IF NOT (public.fn_tarea_permisos(v_t)->>'bloquear')::boolean THEN
    RAISE EXCEPTION 'No puedes marcar esta tarea como bloqueada (solo su responsable o un jefe, y si sigue abierta)';
  END IF;
  IF length(btrim(COALESCE(p_motivo, ''))) < 3 THEN RAISE EXCEPTION 'Cuenta en una línea por qué estás esperando'; END IF;
  IF p_bloqueada_por_empleado_id IS NOT NULL THEN
    IF p_bloqueada_por_empleado_id = v_t.responsable_empleado_id THEN RAISE EXCEPTION 'No puedes estar esperando a la misma persona responsable'; END IF;
    SELECT c.nombre INTO v_nom FROM public.empleados e JOIN public.contacts c ON c.id = e.contact_id WHERE e.id = p_bloqueada_por_empleado_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'La persona indicada no existe'; END IF;
  END IF;
  UPDATE public.tareas SET estado = 'bloqueada', bloqueada_por_empleado_id = p_bloqueada_por_empleado_id, bloqueo_motivo = btrim(p_motivo),
         bloqueada_desde = now(), updated_at = now() WHERE id = p_tarea_id;
  INSERT INTO public.tareas_bitacora (tarea_id, usuario_id, tipo, detalle, estado_antes, estado_despues)
  VALUES (p_tarea_id, v_me, 'bloqueo', 'Esperando a ' || COALESCE(v_nom, 'un tercero externo') || ': ' || btrim(p_motivo), v_t.estado, 'bloqueada');
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION public.tareas_desbloquear(p_tarea_id uuid, p_nota text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me integer := public.fn_user_id();
  v_t  public.tareas%ROWTYPE;
  v_dias integer;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Sesión no válida'; END IF;
  SELECT * INTO v_t FROM public.tareas WHERE id = p_tarea_id FOR UPDATE;
  IF NOT FOUND OR NOT public.fn_puede_ver_tarea(v_t) THEN RAISE EXCEPTION 'Tarea no encontrada'; END IF;
  IF NOT (public.fn_tarea_permisos(v_t)->>'desbloquear')::boolean THEN RAISE EXCEPTION 'No puedes desbloquear esta tarea'; END IF;
  v_dias := GREATEST(0, (now()::date - v_t.bloqueada_desde::date));
  UPDATE public.tareas SET estado = 'en_proceso', bloqueada_por_empleado_id = NULL, bloqueo_motivo = NULL, bloqueada_desde = NULL,
         fecha_inicio = COALESCE(fecha_inicio, now()), updated_at = now() WHERE id = p_tarea_id;
  INSERT INTO public.tareas_bitacora (tarea_id, usuario_id, tipo, detalle, estado_antes, estado_despues)
  VALUES (p_tarea_id, v_me, 'desbloqueo', 'Estuvo bloqueada ' || v_dias || ' día(s)' || COALESCE('. ' || NULLIF(btrim(COALESCE(p_nota, '')), ''), ''), 'bloqueada', 'en_proceso');
  RETURN jsonb_build_object('ok', true, 'dias_bloqueada', v_dias);
END $$;

CREATE OR REPLACE FUNCTION public.tareas_reasignar(p_tarea_id uuid, p_responsable_empleado_id integer, p_nota text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me integer := public.fn_user_id();
  v_t  public.tareas%ROWTYPE;
  v_ant text; v_nuevo text;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Sesión no válida'; END IF;
  SELECT * INTO v_t FROM public.tareas WHERE id = p_tarea_id FOR UPDATE;
  IF NOT FOUND OR NOT public.fn_puede_ver_tarea(v_t) THEN RAISE EXCEPTION 'Tarea no encontrada'; END IF;
  IF NOT (public.fn_tarea_permisos(v_t)->>'reasignar')::boolean THEN RAISE EXCEPTION 'Solo quien la pidió o un jefe puede reasignarla'; END IF;
  IF p_responsable_empleado_id IS NOT DISTINCT FROM v_t.responsable_empleado_id THEN RAISE EXCEPTION 'Ya es de esa persona'; END IF;
  SELECT c.nombre INTO v_nuevo FROM public.empleados e JOIN public.contacts c ON c.id = e.contact_id WHERE e.id = p_responsable_empleado_id AND e.estado = 'activo';
  IF NOT FOUND THEN RAISE EXCEPTION 'La persona no existe o no está activa'; END IF;
  SELECT c.nombre INTO v_ant FROM public.empleados e JOIN public.contacts c ON c.id = e.contact_id WHERE e.id = v_t.responsable_empleado_id;
  UPDATE public.tareas SET responsable_empleado_id = p_responsable_empleado_id, visto_resp_at = NULL, updated_at = now() WHERE id = p_tarea_id;
  INSERT INTO public.tareas_bitacora (tarea_id, usuario_id, tipo, detalle)
  VALUES (p_tarea_id, v_me, 'reasignacion', COALESCE(v_ant, 'sin responsable') || ' → ' || v_nuevo || COALESCE('. ' || NULLIF(btrim(COALESCE(p_nota, '')), ''), ''));
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION public.tareas_editar(p_tarea_id uuid, p_titulo text, p_detalle text, p_fecha_limite date, p_prioridad text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me integer := public.fn_user_id();
  v_t  public.tareas%ROWTYPE;
  v_cambios text[] := '{}';
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Sesión no válida'; END IF;
  SELECT * INTO v_t FROM public.tareas WHERE id = p_tarea_id FOR UPDATE;
  IF NOT FOUND OR NOT public.fn_puede_ver_tarea(v_t) THEN RAISE EXCEPTION 'Tarea no encontrada'; END IF;
  IF NOT (public.fn_tarea_permisos(v_t)->>'editar')::boolean THEN RAISE EXCEPTION 'Solo quien la pidió o un jefe puede editarla'; END IF;
  IF length(btrim(COALESCE(p_titulo, ''))) < 3 THEN RAISE EXCEPTION 'Escribe qué hay que hacer (mínimo 3 letras)'; END IF;
  IF btrim(p_titulo) <> v_t.titulo THEN v_cambios := v_cambios || ('Título: «' || v_t.titulo || '» → «' || btrim(p_titulo) || '»'); END IF;
  IF p_fecha_limite IS DISTINCT FROM v_t.fecha_limite THEN
    v_cambios := v_cambios || ('Fecha límite: ' || COALESCE(to_char(v_t.fecha_limite, 'DD/MM/YYYY'), 'sin fecha') || ' → ' || COALESCE(to_char(p_fecha_limite, 'DD/MM/YYYY'), 'sin fecha'));
  END IF;
  IF COALESCE(p_prioridad, v_t.prioridad) <> v_t.prioridad THEN v_cambios := v_cambios || ('Prioridad: ' || v_t.prioridad || ' → ' || p_prioridad); END IF;
  IF COALESCE(NULLIF(btrim(COALESCE(p_detalle, '')), ''), '') IS DISTINCT FROM COALESCE(v_t.detalle, '') THEN v_cambios := v_cambios || 'Detalle modificado'; END IF;
  IF cardinality(v_cambios) = 0 THEN RETURN jsonb_build_object('ok', true, 'sin_cambios', true); END IF;
  UPDATE public.tareas SET titulo = btrim(p_titulo), detalle = NULLIF(btrim(COALESCE(p_detalle, '')), ''), fecha_limite = p_fecha_limite,
         prioridad = COALESCE(p_prioridad, prioridad), updated_at = now() WHERE id = p_tarea_id;
  INSERT INTO public.tareas_bitacora (tarea_id, usuario_id, tipo, detalle) VALUES (p_tarea_id, v_me, 'edicion', array_to_string(v_cambios, ' · '));
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION public.tareas_comentar(p_tarea_id uuid, p_texto text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me integer := public.fn_user_id();
  v_t  public.tareas%ROWTYPE;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Sesión no válida'; END IF;
  SELECT * INTO v_t FROM public.tareas WHERE id = p_tarea_id;
  IF NOT FOUND OR NOT public.fn_puede_ver_tarea(v_t) THEN RAISE EXCEPTION 'Tarea no encontrada'; END IF;
  IF length(btrim(COALESCE(p_texto, ''))) < 1 THEN RAISE EXCEPTION 'Escribe el comentario'; END IF;
  INSERT INTO public.tareas_bitacora (tarea_id, usuario_id, tipo, detalle) VALUES (p_tarea_id, v_me, 'comentario', btrim(p_texto));
  UPDATE public.tareas SET updated_at = now() WHERE id = p_tarea_id;
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION public.tareas_marcar_vista(p_tarea_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.tareas t SET visto_resp_at = now()
   WHERE t.id = p_tarea_id AND t.visto_resp_at IS NULL
     AND EXISTS (SELECT 1 FROM public.empleados e WHERE e.id = t.responsable_empleado_id AND e.user_id = public.fn_user_id());
  RETURN jsonb_build_object('ok', true);
END $$;

-- 6) Funciones de LECTURA (devuelven nombres y permisos ya calculados; los colaboradores no pueden leer users/empleados directamente)
CREATE OR REPLACE FUNCTION public.tareas_perfil() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_me integer := public.fn_user_id(); v_u public.users%ROWTYPE;
BEGIN
  IF v_me IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_u FROM public.users WHERE id = v_me;
  RETURN jsonb_build_object(
    'user_id', v_me, 'nombre', v_u.nombre, 'role', v_u.role,
    'es_admin', public.fn_is_admin(), 'es_jefe', public.fn_es_jefe(), 'areas', to_jsonb(public.fn_areas_jefe()),
    've_gerencia', public.fn_is_admin() OR public.fn_es_jefe(),
    'empleados', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'empresa_id', e.empresa_id, 'area', e.area)) FROM public.empleados e WHERE e.user_id = v_me AND e.estado = 'activo'), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION public.tareas_personas(p_empresas integer[] DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.fn_user_id() IS NULL THEN RAISE EXCEPTION 'Sesión no válida'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', e.id, 'nombre', c.nombre, 'empresa_id', e.empresa_id, 'area', e.area,
                                         'tiene_cuenta', e.user_id IS NOT NULL, 'es_yo', e.user_id = public.fn_user_id()) ORDER BY c.nombre)
      FROM public.empleados e JOIN public.contacts c ON c.id = e.contact_id
     WHERE e.estado = 'activo' AND (p_empresas IS NULL OR e.empresa_id = ANY (p_empresas))), '[]'::jsonb);   -- nunca sueldos ni datos de planilla
END $$;

CREATE OR REPLACE FUNCTION public.tareas_listar(p_modo text, p_empresas integer[] DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me  integer := public.fn_user_id();
  v_hoy date := (now() AT TIME ZONE 'America/Lima')::date;
  v_res jsonb;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Sesión no válida'; END IF;
  IF p_modo NOT IN ('mias','pedidas','gerencia') THEN RAISE EXCEPTION 'Vista no válida'; END IF;
  IF p_modo = 'gerencia' AND NOT (public.fn_is_admin() OR public.fn_es_jefe()) THEN RAISE EXCEPTION 'Esta vista es solo para gerencia y jefes de área'; END IF;

  SELECT COALESCE(jsonb_agg(f.x ORDER BY f.ord_atraso DESC NULLS LAST, f.ord_limite NULLS LAST, f.ord_creada), '[]'::jsonb) INTO v_res
  FROM (
    SELECT
      (to_jsonb(t) - 'visto_resp_at') || jsonb_build_object(
        'solicitante_nombre', us.nombre,
        'responsable_nombre', cr.nombre, 'responsable_tiene_cuenta', er.user_id IS NOT NULL, 'responsable_es_yo', er.user_id = v_me,
        'bloqueada_por_nombre', cb.nombre,
        'dias_atraso', CASE WHEN t.estado IN ('pendiente','en_proceso','bloqueada','en_revision') AND t.fecha_limite < v_hoy THEN v_hoy - t.fecha_limite ELSE 0 END,
        'dias_bloqueada', CASE WHEN t.estado = 'bloqueada' THEN GREATEST(0, v_hoy - (t.bloqueada_desde AT TIME ZONE 'America/Lima')::date) ELSE NULL END,
        'nueva', (er.user_id = v_me AND t.visto_resp_at IS NULL AND t.estado = 'pendiente'),
        'permisos', public.fn_tarea_permisos(t)) AS x,
      CASE WHEN t.estado IN ('pendiente','en_proceso','bloqueada','en_revision') AND t.fecha_limite < v_hoy THEN v_hoy - t.fecha_limite END AS ord_atraso,
      t.fecha_limite AS ord_limite, t.created_at AS ord_creada
    FROM public.tareas t
    LEFT JOIN public.users     us ON us.id = t.solicitante_id
    LEFT JOIN public.empleados er ON er.id = t.responsable_empleado_id
    LEFT JOIN public.contacts  cr ON cr.id = er.contact_id
    LEFT JOIN public.empleados eb ON eb.id = t.bloqueada_por_empleado_id
    LEFT JOIN public.contacts  cb ON cb.id = eb.contact_id
    WHERE public.fn_puede_ver_tarea(t)
      AND (p_empresas IS NULL OR t.empresa_id = ANY (p_empresas))
      AND CASE p_modo
            WHEN 'mias'   THEN er.user_id = v_me
            WHEN 'pedidas' THEN t.solicitante_id = v_me
            ELSE (public.fn_is_admin() OR (t.area IS NOT NULL AND lower(btrim(t.area)) = ANY (public.fn_areas_jefe())))
                 AND t.estado IN ('pendiente','en_proceso','bloqueada','en_revision')
          END
      AND (p_modo = 'gerencia' OR t.estado NOT IN ('hecha','anulada') OR (t.estado = 'hecha' AND t.fecha_hecha > now() - interval '7 days'))
  ) f;
  RETURN v_res;
END $$;

CREATE OR REPLACE FUNCTION public.tareas_kpis(p_empresas integer[] DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_hoy date := (now() AT TIME ZONE 'America/Lima')::date;
  v_ini timestamptz := date_trunc('week', now() AT TIME ZONE 'America/Lima') AT TIME ZONE 'America/Lima';
BEGIN
  IF NOT (public.fn_is_admin() OR public.fn_es_jefe()) THEN RAISE EXCEPTION 'Esta vista es solo para gerencia y jefes de área'; END IF;
  RETURN (
    SELECT jsonb_build_object(
      'pendientes',  count(*) FILTER (WHERE t.estado IN ('pendiente','en_proceso','bloqueada','en_revision')),
      'vencidas',    count(*) FILTER (WHERE t.estado IN ('pendiente','en_proceso','bloqueada','en_revision') AND t.fecha_limite < v_hoy),
      'bloqueadas',  count(*) FILTER (WHERE t.estado = 'bloqueada'),
      'cerradas_semana', count(*) FILTER (WHERE t.estado = 'hecha' AND t.fecha_hecha >= v_ini))
    FROM public.tareas t
   WHERE (public.fn_is_admin() OR (t.area IS NOT NULL AND lower(btrim(t.area)) = ANY (public.fn_areas_jefe())))
     AND (p_empresas IS NULL OR t.empresa_id = ANY (p_empresas)));
END $$;

CREATE OR REPLACE FUNCTION public.tareas_bitacora_de(p_tarea_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_t public.tareas%ROWTYPE;
BEGIN
  SELECT * INTO v_t FROM public.tareas WHERE id = p_tarea_id;
  IF NOT FOUND OR NOT public.fn_puede_ver_tarea(v_t) THEN RAISE EXCEPTION 'Tarea no encontrada'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', b.id, 'tipo', b.tipo, 'detalle', b.detalle, 'estado_antes', b.estado_antes,
                                                       'estado_despues', b.estado_despues, 'created_at', b.created_at, 'usuario_nombre', u.nombre,
                                                       'es_yo', b.usuario_id = public.fn_user_id()) ORDER BY b.created_at)
                     FROM public.tareas_bitacora b LEFT JOIN public.users u ON u.id = b.usuario_id WHERE b.tarea_id = p_tarea_id), '[]'::jsonb);
END $$;

-- Para el dashboard («Tienes N pendientes, M vencidos») y la campanita
CREATE OR REPLACE FUNCTION public.tareas_mis_numeros() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_me integer := public.fn_user_id(); v_hoy date := (now() AT TIME ZONE 'America/Lima')::date;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('pendientes', 0, 'vencidas', 0, 'te_bloquean', 0); END IF;
  RETURN (SELECT jsonb_build_object(
      'pendientes',  count(*) FILTER (WHERE er.user_id = v_me AND t.estado IN ('pendiente','en_proceso','bloqueada','en_revision')),
      'vencidas',    count(*) FILTER (WHERE er.user_id = v_me AND t.estado IN ('pendiente','en_proceso','bloqueada','en_revision') AND t.fecha_limite < v_hoy),
      'te_bloquean', count(*) FILTER (WHERE eb.user_id = v_me AND t.estado = 'bloqueada'))
    FROM public.tareas t
    LEFT JOIN public.empleados er ON er.id = t.responsable_empleado_id
    LEFT JOIN public.empleados eb ON eb.id = t.bloqueada_por_empleado_id);
END $$;

CREATE OR REPLACE FUNCTION public.tareas_avisos() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_me integer := public.fn_user_id(); v_hoy date := (now() AT TIME ZONE 'America/Lima')::date; v_res jsonb;
BEGIN
  IF v_me IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT COALESCE(jsonb_agg(a ORDER BY (a->>'prioridad')::int, a->>'fecha' DESC), '[]'::jsonb) INTO v_res FROM (
    -- 1) te asignaron (aún no la abriste)
    SELECT jsonb_build_object('tipo', 'tarea_asignada', 'prioridad', 2, 'tarea_id', t.id, 'titulo', t.titulo,
             'detalle', 'Te la pidió ' || COALESCE(us.nombre, '—'), 'fecha', t.created_at) AS a
      FROM public.tareas t JOIN public.empleados er ON er.id = t.responsable_empleado_id AND er.user_id = v_me
      LEFT JOIN public.users us ON us.id = t.solicitante_id
     WHERE t.visto_resp_at IS NULL AND t.estado = 'pendiente'
    UNION ALL
    -- 2) venció
    SELECT jsonb_build_object('tipo', 'tarea_vencida', 'prioridad', 1, 'tarea_id', t.id, 'titulo', t.titulo,
             'detalle', 'Venció hace ' || (v_hoy - t.fecha_limite) || ' día(s)', 'fecha', t.fecha_limite)
      FROM public.tareas t JOIN public.empleados er ON er.id = t.responsable_empleado_id AND er.user_id = v_me
     WHERE t.estado IN ('pendiente','en_proceso','en_revision','bloqueada') AND t.fecha_limite < v_hoy
    UNION ALL
    -- 3) alguien está esperando por ti
    SELECT jsonb_build_object('tipo', 'tarea_te_bloquea', 'prioridad', 0, 'tarea_id', t.id, 'titulo', t.titulo,
             'detalle', COALESCE(cr.nombre, '—') || ' te está esperando hace ' || GREATEST(0, v_hoy - (t.bloqueada_desde AT TIME ZONE 'America/Lima')::date) || ' día(s)', 'fecha', t.bloqueada_desde)
      FROM public.tareas t JOIN public.empleados eb ON eb.id = t.bloqueada_por_empleado_id AND eb.user_id = v_me
      LEFT JOIN public.empleados er ON er.id = t.responsable_empleado_id LEFT JOIN public.contacts cr ON cr.id = er.contact_id
     WHERE t.estado = 'bloqueada'
  ) q;
  RETURN v_res;
END $$;

-- 7) Recurrentes
CREATE OR REPLACE FUNCTION public.tareas_recurrente_guardar(
  p_id uuid, p_empresa_id integer, p_titulo text, p_detalle text, p_area text, p_responsable_empleado_id integer,
  p_periodicidad text, p_dia_referencia integer, p_prioridad text DEFAULT 'normal'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me integer := public.fn_user_id();
  v_area text := NULLIF(btrim(COALESCE(p_area, '')), '');
  v_id uuid := p_id;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Sesión no válida'; END IF;
  IF v_area IS NULL AND p_responsable_empleado_id IS NOT NULL THEN SELECT area INTO v_area FROM public.empleados WHERE id = p_responsable_empleado_id; END IF;
  IF NOT (public.fn_is_admin() OR (v_area IS NOT NULL AND lower(btrim(v_area)) = ANY (public.fn_areas_jefe()))) THEN
    RAISE EXCEPTION 'Solo gerencia o el jefe del área puede crear tareas recurrentes';
  END IF;
  IF length(btrim(COALESCE(p_titulo, ''))) < 3 THEN RAISE EXCEPTION 'Escribe el título (mínimo 3 letras)'; END IF;
  IF p_responsable_empleado_id IS NULL THEN RAISE EXCEPTION 'Elige al responsable'; END IF;
  IF p_periodicidad = 'semanal' AND COALESCE(p_dia_referencia, 0) NOT BETWEEN 1 AND 7 THEN RAISE EXCEPTION 'Elige el día de la semana límite'; END IF;
  IF p_periodicidad = 'mensual' AND COALESCE(p_dia_referencia, 0) NOT BETWEEN 1 AND 31 THEN RAISE EXCEPTION 'Elige el día del mes límite'; END IF;
  IF v_id IS NULL THEN
    INSERT INTO public.tareas_recurrentes (empresa_id, titulo, detalle, area, responsable_empleado_id, solicitante_id, prioridad, periodicidad, dia_referencia)
    VALUES (p_empresa_id, btrim(p_titulo), NULLIF(btrim(COALESCE(p_detalle, '')), ''), v_area, p_responsable_empleado_id, v_me, COALESCE(p_prioridad, 'normal'), p_periodicidad, p_dia_referencia)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.tareas_recurrentes SET empresa_id = p_empresa_id, titulo = btrim(p_titulo), detalle = NULLIF(btrim(COALESCE(p_detalle, '')), ''), area = v_area,
           responsable_empleado_id = p_responsable_empleado_id, prioridad = COALESCE(p_prioridad, 'normal'), periodicidad = p_periodicidad, dia_referencia = p_dia_referencia
     WHERE id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Recurrente no encontrada'; END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION public.tareas_recurrente_toggle(p_id uuid, p_activa boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_r public.tareas_recurrentes%ROWTYPE;
BEGIN
  SELECT * INTO v_r FROM public.tareas_recurrentes WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recurrente no encontrada'; END IF;
  IF NOT (public.fn_is_admin() OR (v_r.area IS NOT NULL AND lower(btrim(v_r.area)) = ANY (public.fn_areas_jefe()))) THEN RAISE EXCEPTION 'No tienes permiso'; END IF;
  UPDATE public.tareas_recurrentes SET activa = p_activa WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION public.tareas_recurrentes_listar() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.fn_is_admin() OR public.fn_es_jefe()) THEN RAISE EXCEPTION 'Solo gerencia o jefes de área'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(to_jsonb(r) || jsonb_build_object('responsable_nombre', c.nombre) ORDER BY r.activa DESC, r.titulo)
                     FROM public.tareas_recurrentes r
                     LEFT JOIN public.empleados e ON e.id = r.responsable_empleado_id LEFT JOIN public.contacts c ON c.id = e.contact_id
                    WHERE public.fn_is_admin() OR (r.area IS NOT NULL AND lower(btrim(r.area)) = ANY (public.fn_areas_jefe()))), '[]'::jsonb);
END $$;

-- Genera las tareas que toca crear HOY. Idempotente: el índice único (recurrente_id, periodo) impide duplicar.
-- Se llama al abrir el módulo; también se puede programar con pg_cron:  SELECT cron.schedule('tareas-recurrentes','5 5 * * *','SELECT public.tareas_generar_recurrentes_job()');
CREATE OR REPLACE FUNCTION public.tareas_generar_recurrentes_job() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_hoy date := (now() AT TIME ZONE 'America/Lima')::date;
  r public.tareas_recurrentes%ROWTYPE;
  v_periodo text; v_limite date; v_ini_mes date := date_trunc('month', (now() AT TIME ZONE 'America/Lima'))::date;
  v_ultimo_dia integer := extract(day FROM (date_trunc('month', (now() AT TIME ZONE 'America/Lima')) + interval '1 month - 1 day'))::integer;
  v_id uuid; v_n integer := 0;
BEGIN
  FOR r IN SELECT * FROM public.tareas_recurrentes WHERE activa LOOP
    IF r.periodicidad = 'diaria' THEN
      v_periodo := to_char(v_hoy, 'YYYY-MM-DD'); v_limite := v_hoy;
    ELSIF r.periodicidad = 'semanal' THEN
      v_periodo := to_char(v_hoy, 'IYYY"-W"IW'); v_limite := date_trunc('week', v_hoy)::date + (COALESCE(r.dia_referencia, 5) - 1);
    ELSIF r.periodicidad = 'quincenal' THEN
      IF extract(day FROM v_hoy) <= 15 THEN v_periodo := to_char(v_hoy, 'YYYY-MM') || '-Q1'; v_limite := v_ini_mes + 14;
      ELSE v_periodo := to_char(v_hoy, 'YYYY-MM') || '-Q2'; v_limite := v_ini_mes + (v_ultimo_dia - 1); END IF;
    ELSE
      v_periodo := to_char(v_hoy, 'YYYY-MM'); v_limite := v_ini_mes + (LEAST(COALESCE(r.dia_referencia, v_ultimo_dia), v_ultimo_dia) - 1);
    END IF;
    v_id := NULL;
    INSERT INTO public.tareas (empresa_id, titulo, detalle, area, solicitante_id, responsable_empleado_id, prioridad, fecha_limite, recurrente_id, periodo)
    VALUES (r.empresa_id, r.titulo, r.detalle, r.area, r.solicitante_id, r.responsable_empleado_id, r.prioridad, v_limite, r.id, v_periodo)
    ON CONFLICT (recurrente_id, periodo) WHERE recurrente_id IS NOT NULL DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      INSERT INTO public.tareas_bitacora (tarea_id, usuario_id, tipo, detalle, estado_despues)
      VALUES (v_id, r.solicitante_id, 'creacion', 'Generada automáticamente (' || r.periodicidad || ', periodo ' || v_periodo || ')', 'pendiente');
      UPDATE public.tareas_recurrentes SET ultimo_periodo = v_periodo WHERE id = r.id;
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION public.tareas_generar_recurrentes() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.fn_user_id() IS NULL THEN RAISE EXCEPTION 'Sesión no válida'; END IF;
  RETURN jsonb_build_object('ok', true, 'generadas', public.tareas_generar_recurrentes_job());
END $$;

-- 8) Permisos de ejecución: solo usuarios con sesión (nada para anon). El job queda solo para pg_cron / servidor.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS f, p.proname AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
            WHERE ns.nspname = 'public' AND (p.proname LIKE 'tareas\_%' OR p.proname IN ('fn_user_id','fn_areas_jefe','fn_es_jefe','fn_puede_ver_tarea','fn_tarea_permisos'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.f);
    IF r.n <> 'tareas_generar_recurrentes_job' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.f); END IF;
  END LOOP;
END $$;

-- Verificación (resultados visibles en el panel de Supabase)
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('tareas','tareas_bitacora','tareas_recurrentes')) AS tablas_creadas,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public' AND p.proname LIKE 'tareas\_%') AS funciones_tareas;
