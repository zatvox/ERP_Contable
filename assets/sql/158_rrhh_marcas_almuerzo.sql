-- ============================================================================
-- 158_rrhh_marcas_almuerzo.sql — RRHH · marcas de almuerzo y "otro" (2026-11-11)
-- Requiere SQL 134, 135 y 137.
-- Modelo: asistencias.entrada / salida siguen siendo el ingreso y la salida de labores
-- (todo lo anterior —edición, historial, tabla— sigue funcionando). Las marcas
-- intermedias van en asistencia_marcas: almuerzo_salida, almuerzo_regreso, otro (nota).
-- Horas trabajadas = salida − ingreso − (regreso − salida de almuerzo). "otro" es solo informativo.
-- La hora SIEMPRE es la del servidor (now()).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.asistencia_marcas (
  id            serial      PRIMARY KEY,
  asistencia_id integer     NOT NULL REFERENCES public.asistencias(id) ON DELETE CASCADE,
  empresa_id    integer     NOT NULL,
  empleado_id   integer     NOT NULL,
  fecha         date        NOT NULL,
  tipo          varchar     NOT NULL CHECK (tipo IN ('almuerzo_salida','almuerzo_regreso','otro')),
  hora          timestamptz NOT NULL DEFAULT now(),
  origen        varchar     CHECK (origen IN ('autoservicio','admin')),
  nota          text,
  marcado_por   integer     REFERENCES public.users(id),
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_asis_marcas_asis  ON public.asistencia_marcas(asistencia_id);
CREATE INDEX IF NOT EXISTS idx_asis_marcas_fecha ON public.asistencia_marcas(empresa_id, fecha);
ALTER TABLE public.asistencia_marcas ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='asistencia_marcas' AND policyname='rrhh_marcas_lectura') THEN
    CREATE POLICY rrhh_marcas_lectura ON public.asistencia_marcas FOR SELECT USING (true);  -- solo lectura: se escribe vía funciones
  END IF;
END $$;

-- La firma cambia (nuevo parámetro p_nota): se elimina la anterior para evitar ambigüedad
DROP FUNCTION IF EXISTS public.rrhh_marcar(integer, text);

CREATE OR REPLACE FUNCTION public.rrhh_marcar(p_empleado_id integer, p_tipo text, p_nota text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user   public.users%ROWTYPE;
  v_emp    public.empleados%ROWTYPE;
  v_asis   public.asistencias%ROWTYPE;
  v_hoy    date := (now() AT TIME ZONE 'America/Lima')::date;
  v_origen text;
  v_nota   text := NULLIF(btrim(COALESCE(p_nota, '')), '');
  v_alm_s  integer;
  v_alm_r  integer;
BEGIN
  IF p_tipo NOT IN ('entrada','almuerzo_salida','almuerzo_regreso','salida','otro') THEN RAISE EXCEPTION 'Tipo de marca inválido'; END IF;
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
      RAISE EXCEPTION 'La jornada de hoy ya terminó (salida a las %)', to_char(v_asis.salida AT TIME ZONE 'America/Lima', 'HH24:MI');
    END IF;
    SELECT count(*) FILTER (WHERE tipo = 'almuerzo_salida'), count(*) FILTER (WHERE tipo = 'almuerzo_regreso')
      INTO v_alm_s, v_alm_r FROM public.asistencia_marcas WHERE asistencia_id = v_asis.id;

    IF p_tipo = 'almuerzo_salida' THEN
      IF v_alm_s > 0 THEN RAISE EXCEPTION 'Ya marcaste tu salida a almuerzo hoy'; END IF;
      INSERT INTO public.asistencia_marcas (asistencia_id, empresa_id, empleado_id, fecha, tipo, origen, nota, marcado_por)
      VALUES (v_asis.id, v_asis.empresa_id, p_empleado_id, v_hoy, 'almuerzo_salida', v_origen, v_nota, v_user.id);
    ELSIF p_tipo = 'almuerzo_regreso' THEN
      IF v_alm_s = 0 THEN RAISE EXCEPTION 'Primero marca la salida a almuerzo'; END IF;
      IF v_alm_r > 0 THEN RAISE EXCEPTION 'Ya marcaste tu regreso de almuerzo hoy'; END IF;
      INSERT INTO public.asistencia_marcas (asistencia_id, empresa_id, empleado_id, fecha, tipo, origen, nota, marcado_por)
      VALUES (v_asis.id, v_asis.empresa_id, p_empleado_id, v_hoy, 'almuerzo_regreso', v_origen, v_nota, v_user.id);
    ELSIF p_tipo = 'otro' THEN
      IF v_nota IS NULL OR length(v_nota) < 3 THEN RAISE EXCEPTION 'Escribe una nota para la marca «Otro»'; END IF;
      INSERT INTO public.asistencia_marcas (asistencia_id, empresa_id, empleado_id, fecha, tipo, origen, nota, marcado_por)
      VALUES (v_asis.id, v_asis.empresa_id, p_empleado_id, v_hoy, 'otro', v_origen, v_nota, v_user.id);
    ELSE  -- salida de labores
      IF v_alm_s > 0 AND v_alm_r = 0 THEN RAISE EXCEPTION 'Estás en almuerzo: primero marca el regreso'; END IF;
      UPDATE public.asistencias SET salida = now(), origen_salida = v_origen, marcado_por = v_user.id, updated_at = now()
       WHERE id = v_asis.id RETURNING * INTO v_asis;
    END IF;
  END IF;

  RETURN to_jsonb(v_asis) || jsonb_build_object(
    'hora_lima', to_char(now() AT TIME ZONE 'America/Lima', 'HH24:MI:SS'), 'tipo', p_tipo);
END $$;

-- Estado de HOY del usuario logueado (alimenta el botón y el modal de la cabecera)
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
           'nombre', c.nombre, 'tipo_documento', c.tipo_documento, 'nro_documento', c.nro_documento,
           'entrada', a.entrada, 'salida', a.salida,
           'hora_entrada', e.hora_entrada, 'hora_salida', e.hora_salida, 'tolerancia_min', e.tolerancia_min,
           'marcas', COALESCE((SELECT jsonb_agg(jsonb_build_object('tipo', m.tipo, 'hora', m.hora, 'nota', m.nota) ORDER BY m.hora)
                                 FROM public.asistencia_marcas m WHERE m.asistencia_id = a.id), '[]'::jsonb),
           'epoch_ms', (extract(epoch FROM now()) * 1000)::bigint,
           'hora_lima', to_char(now() AT TIME ZONE 'America/Lima', 'HH24:MI:SS'))
    INTO v_res
    FROM public.empleados e
    LEFT JOIN public.contacts c ON c.id = e.contact_id
    LEFT JOIN public.asistencias a ON a.empleado_id = e.id AND a.fecha = v_hoy
   WHERE e.user_id = v_user.id AND e.estado = 'activo'
   ORDER BY e.id LIMIT 1;
  RETURN v_res;
END $$;

-- Admin: registrar/corregir el almuerzo de un día (reemplaza las marcas de almuerzo de esa fecha).
-- p_salida / p_regreso = 'HH:MM' o NULL (NULL en ambos = quitar almuerzo). Motivo obligatorio.
CREATE OR REPLACE FUNCTION public.rrhh_asistencia_almuerzo(
  p_empleado_id integer, p_fecha date, p_salida text, p_regreso text, p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user public.users%ROWTYPE;
  v_asis public.asistencias%ROWTYPE;
  v_s timestamptz; v_r timestamptz;
  v_ant text;
BEGIN
  IF NOT public.fn_is_admin() THEN RAISE EXCEPTION 'Solo el administrador puede corregir marcaciones'; END IF;
  IF length(btrim(COALESCE(p_motivo, ''))) < 3 THEN RAISE EXCEPTION 'El motivo es obligatorio'; END IF;
  SELECT * INTO v_user FROM public.users WHERE auth_id = auth.uid();
  SELECT * INTO v_asis FROM public.asistencias WHERE empleado_id = p_empleado_id AND fecha = p_fecha FOR UPDATE;
  IF NOT FOUND OR v_asis.entrada IS NULL THEN RAISE EXCEPTION 'Primero registra el ingreso de ese día'; END IF;
  IF p_regreso IS NOT NULL AND p_salida IS NULL THEN RAISE EXCEPTION 'Falta la hora de salida a almuerzo'; END IF;
  IF p_salida IS NOT NULL THEN v_s := (p_fecha::timestamp + p_salida::time) AT TIME ZONE 'America/Lima'; END IF;
  IF p_regreso IS NOT NULL THEN v_r := (p_fecha::timestamp + p_regreso::time) AT TIME ZONE 'America/Lima'; END IF;
  IF v_s IS NOT NULL AND v_s < v_asis.entrada THEN RAISE EXCEPTION 'El almuerzo no puede empezar antes del ingreso'; END IF;
  IF v_r IS NOT NULL AND v_r <= v_s THEN RAISE EXCEPTION 'El regreso debe ser posterior a la salida a almuerzo'; END IF;
  IF v_asis.salida IS NOT NULL AND (COALESCE(v_r, v_s) > v_asis.salida) THEN RAISE EXCEPTION 'El almuerzo no puede ser posterior a la salida de labores'; END IF;
  IF COALESCE(v_r, v_s) > now() THEN RAISE EXCEPTION 'No se pueden registrar horas futuras'; END IF;

  SELECT string_agg(to_char(hora AT TIME ZONE 'America/Lima', 'HH24:MI'), '–' ORDER BY hora) INTO v_ant
    FROM public.asistencia_marcas WHERE asistencia_id = v_asis.id AND tipo IN ('almuerzo_salida','almuerzo_regreso');
  DELETE FROM public.asistencia_marcas WHERE asistencia_id = v_asis.id AND tipo IN ('almuerzo_salida','almuerzo_regreso');
  IF v_s IS NOT NULL THEN
    INSERT INTO public.asistencia_marcas (asistencia_id, empresa_id, empleado_id, fecha, tipo, hora, origen, nota, marcado_por)
    VALUES (v_asis.id, v_asis.empresa_id, p_empleado_id, p_fecha, 'almuerzo_salida', v_s, 'admin', 'Corregido: ' || btrim(p_motivo), v_user.id);
  END IF;
  IF v_r IS NOT NULL THEN
    INSERT INTO public.asistencia_marcas (asistencia_id, empresa_id, empleado_id, fecha, tipo, hora, origen, nota, marcado_por)
    VALUES (v_asis.id, v_asis.empresa_id, p_empleado_id, p_fecha, 'almuerzo_regreso', v_r, 'admin', 'Corregido: ' || btrim(p_motivo), v_user.id);
  END IF;
  -- Queda en el historial (valores anteriores en el motivo; las horas de ingreso/salida no cambian)
  INSERT INTO public.asistencias_log (asistencia_id, empresa_id, empleado_id, fecha, accion, entrada_ant, salida_ant, entrada_nueva, salida_nueva, motivo, por_user)
  VALUES (v_asis.id, v_asis.empresa_id, p_empleado_id, p_fecha, 'editar', v_asis.entrada, v_asis.salida, v_asis.entrada, v_asis.salida,
          'Almuerzo: ' || COALESCE(v_ant, 'sin marcas') || ' → ' || COALESCE(p_salida, '—') || COALESCE('–' || p_regreso, '') || ' · ' || btrim(p_motivo), v_user.id);
  RETURN jsonb_build_object('ok', true);
END $$;

GRANT EXECUTE ON FUNCTION public.rrhh_marcar(integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rrhh_mi_estado() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rrhh_asistencia_almuerzo(integer, date, text, text, text) TO authenticated;

SELECT 'asistencia_marcas' AS tabla, count(*) AS filas FROM public.asistencia_marcas;
