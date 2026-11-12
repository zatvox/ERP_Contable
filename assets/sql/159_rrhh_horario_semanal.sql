-- ============================================================================
-- 159_rrhh_horario_semanal.sql — RRHH · horario por día de la semana (2026-11-12)
-- Requiere SQL 134, 135 y 158.
-- empleados.horario_semanal = {"1":{"e":"08:30","s":"18:00"}, ... "6":{...}}  (1=Lun … 6=Sáb, 0=Dom)
--   · Un día que NO está en el objeto es de descanso (no cuenta como falta en la asistencia).
--   · hora_entrada / hora_salida se mantienen = primer día laborable (compatibilidad).
-- empleados.almuerzo_min = minutos de almuerzo que se descuentan de la jornada (días > 5 h).
-- ============================================================================
ALTER TABLE public.empleados ADD COLUMN IF NOT EXISTS horario_semanal jsonb;
ALTER TABLE public.empleados ADD COLUMN IF NOT EXISTS almuerzo_min integer NOT NULL DEFAULT 60;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_emp_almuerzo') THEN
    ALTER TABLE public.empleados ADD CONSTRAINT ck_emp_almuerzo CHECK (almuerzo_min BETWEEN 0 AND 180);
  END IF;
END $$;

-- Fichas existentes: se escribe explícito lo que hoy se asume (Lun–Vie con su hora de entrada/salida)
UPDATE public.empleados e
   SET horario_semanal = (SELECT jsonb_object_agg(d::text, jsonb_build_object('e', to_char(e.hora_entrada, 'HH24:MI'), 's', to_char(e.hora_salida, 'HH24:MI')))
                            FROM generate_series(1, 5) d)
 WHERE e.horario_semanal IS NULL;

-- El botón «Marcar» necesita el horario del día (sugerir salida de labores)
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
           'horario_semanal', e.horario_semanal, 'almuerzo_min', e.almuerzo_min,
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
GRANT EXECUTE ON FUNCTION public.rrhh_mi_estado() TO authenticated;

SELECT count(*) AS fichas_con_horario FROM public.empleados WHERE horario_semanal IS NOT NULL;

-- ============================================================================
-- Cambiar el rol de un usuario (dar / quitar Administrador desde RRHH → Usuarios y accesos)
-- Reglas en el servidor (no solo en la pantalla): solo un administrador; no puedes quitarte
-- tu propio rol; siempre debe quedar al menos un administrador activo.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rrhh_usuario_rol(p_user_id integer, p_rol text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_yo     public.users%ROWTYPE;
  v_obj    public.users%ROWTYPE;
  v_admins integer;
BEGIN
  IF NOT public.fn_is_admin() THEN RAISE EXCEPTION 'Solo un administrador puede cambiar roles'; END IF;
  SELECT * INTO v_yo  FROM public.users WHERE auth_id = auth.uid();
  SELECT * INTO v_obj FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Usuario no encontrado'; END IF;
  IF v_obj.role = p_rol THEN RETURN jsonb_build_object('ok', true, 'sin_cambio', true); END IF;
  IF v_obj.id = v_yo.id AND p_rol <> 'admin' THEN RAISE EXCEPTION 'No puedes quitarte tu propio rol de administrador'; END IF;
  IF v_obj.role = 'admin' AND p_rol <> 'admin' THEN
    SELECT count(*) INTO v_admins FROM public.users WHERE role = 'admin' AND active;
    IF v_admins <= 1 THEN RAISE EXCEPTION 'Debe quedar al menos un administrador activo'; END IF;
  END IF;
  IF p_rol = 'admin' AND NOT v_obj.active THEN RAISE EXCEPTION 'Activa primero el acceso del usuario'; END IF;
  UPDATE public.users SET role = p_rol WHERE id = p_user_id;     -- el CHECK de users.role valida el valor
  RETURN jsonb_build_object('ok', true, 'usuario', p_user_id, 'rol_anterior', v_obj.role, 'rol_nuevo', p_rol);
END $$;
GRANT EXECUTE ON FUNCTION public.rrhh_usuario_rol(integer, text) TO authenticated;
