-- ============================================================================
-- 135_rrhh_asistencia.sql — RRHH · etapa R1 (2026-11-05)
-- Requiere SQL 134. La hora SIEMPRE la pone el servidor (now()); el navegador no
-- puede falsearla. La fecha de la jornada es la de Lima, no la UTC.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.asistencias (
  id              serial      PRIMARY KEY,
  empresa_id      integer     NOT NULL REFERENCES public.empresa_config(id),
  empleado_id     integer     NOT NULL REFERENCES public.empleados(id),
  fecha           date        NOT NULL,                 -- día en Lima
  entrada         timestamptz,
  salida          timestamptz,
  origen_entrada  varchar     CHECK (origen_entrada IN ('autoservicio','admin')),
  origen_salida   varchar     CHECK (origen_salida  IN ('autoservicio','admin')),
  marcado_por     integer     REFERENCES public.users(id),
  editado_por     integer     REFERENCES public.users(id),
  motivo_edicion  text,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  UNIQUE (empleado_id, fecha),
  CONSTRAINT ck_asis_orden CHECK (salida IS NULL OR entrada IS NULL OR salida >= entrada)
);
CREATE INDEX IF NOT EXISTS idx_asistencias_empresa_fecha ON public.asistencias(empresa_id, fecha);

ALTER TABLE public.asistencias ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='asistencias' AND policyname='rrhh_all') THEN
    CREATE POLICY rrhh_all ON public.asistencias FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Hora del servidor en UTC y en Lima (para la prueba de hora obligatoria)
CREATE OR REPLACE FUNCTION public.rrhh_hora_lima() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'utc',        to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
    'lima',       to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI:SS'),
    'fecha_lima', (now() AT TIME ZONE 'America/Lima')::date,
    'epoch_ms',   (extract(epoch FROM now()) * 1000)::bigint)
$$;

-- Marcar ingreso/salida. Autoservicio: solo el dueño de la cuenta. Admin: cualquiera.
CREATE OR REPLACE FUNCTION public.rrhh_marcar(p_empleado_id integer, p_tipo text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user   public.users%ROWTYPE;
  v_emp    public.empleados%ROWTYPE;
  v_asis   public.asistencias%ROWTYPE;
  v_hoy    date := (now() AT TIME ZONE 'America/Lima')::date;
  v_origen text;
BEGIN
  IF p_tipo NOT IN ('entrada','salida') THEN RAISE EXCEPTION 'Tipo de marca inválido'; END IF;
  SELECT * INTO v_user FROM public.users WHERE auth_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Sesión no válida'; END IF;
  SELECT * INTO v_emp FROM public.empleados WHERE id = p_empleado_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Empleado no encontrado'; END IF;
  IF v_emp.estado <> 'activo' THEN RAISE EXCEPTION 'El empleado no está activo'; END IF;
  IF NOT public.fn_is_admin() AND v_emp.user_id IS DISTINCT FROM v_user.id THEN
    RAISE EXCEPTION 'Solo puedes marcar tu propia asistencia';
  END IF;
  v_origen := CASE WHEN v_emp.user_id = v_user.id THEN 'autoservicio' ELSE 'admin' END;

  SELECT * INTO v_asis FROM public.asistencias WHERE empleado_id = p_empleado_id AND fecha = v_hoy FOR UPDATE;

  IF p_tipo = 'entrada' THEN
    IF FOUND AND v_asis.entrada IS NOT NULL THEN
      RAISE EXCEPTION 'Ya hay un ingreso hoy a las %', to_char(v_asis.entrada AT TIME ZONE 'America/Lima', 'HH24:MI');
    END IF;
    IF FOUND THEN
      UPDATE public.asistencias SET entrada = now(), origen_entrada = v_origen, marcado_por = v_user.id, updated_at = now()
       WHERE id = v_asis.id RETURNING * INTO v_asis;
    ELSE
      INSERT INTO public.asistencias (empresa_id, empleado_id, fecha, entrada, origen_entrada, marcado_por)
      VALUES (v_emp.empresa_id, p_empleado_id, v_hoy, now(), v_origen, v_user.id) RETURNING * INTO v_asis;
    END IF;
  ELSE
    IF NOT FOUND OR v_asis.entrada IS NULL THEN RAISE EXCEPTION 'Primero hay que marcar el ingreso'; END IF;
    IF v_asis.salida IS NOT NULL THEN
      RAISE EXCEPTION 'Ya hay una salida hoy a las %', to_char(v_asis.salida AT TIME ZONE 'America/Lima', 'HH24:MI');
    END IF;
    UPDATE public.asistencias SET salida = now(), origen_salida = v_origen, marcado_por = v_user.id, updated_at = now()
     WHERE id = v_asis.id RETURNING * INTO v_asis;
  END IF;

  RETURN to_jsonb(v_asis) || jsonb_build_object(
    'hora_lima', to_char(now() AT TIME ZONE 'America/Lima', 'HH24:MI:SS'));
END $$;

-- Estado de HOY del usuario logueado (alimenta el botón de la cabecera)
CREATE OR REPLACE FUNCTION public.rrhh_mi_estado() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user public.users%ROWTYPE;
  v_hoy  date := (now() AT TIME ZONE 'America/Lima')::date;
  v_res  jsonb;
BEGIN
  SELECT * INTO v_user FROM public.users WHERE auth_id = auth.uid();
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT jsonb_build_object(
           'empleado_id', e.id, 'empresa_id', e.empresa_id,
           'entrada', a.entrada, 'salida', a.salida,
           'hora_entrada', e.hora_entrada, 'tolerancia_min', e.tolerancia_min,
           'hora_lima', to_char(now() AT TIME ZONE 'America/Lima', 'HH24:MI:SS'))
    INTO v_res
    FROM public.empleados e
    LEFT JOIN public.asistencias a ON a.empleado_id = e.id AND a.fecha = v_hoy
   WHERE e.user_id = v_user.id AND e.estado = 'activo'
   ORDER BY e.id LIMIT 1;
  RETURN v_res;
END $$;

GRANT EXECUTE ON FUNCTION public.rrhh_hora_lima()           TO authenticated;
GRANT EXECUTE ON FUNCTION public.rrhh_marcar(integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rrhh_mi_estado()           TO authenticated;
