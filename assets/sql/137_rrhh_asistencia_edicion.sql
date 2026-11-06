-- ============================================================================
-- 137_rrhh_asistencia_edicion.sql — RRHH · editar / registrar retroactivo / eliminar marcaciones (2026-11-06)
-- Requiere SQL 134 y 135. (136 es de otra sesión: packing/despacho.)
-- Reglas:
--   · Solo el ADMINISTRADOR edita, registra con fecha pasada o elimina marcaciones.
--   · Motivo obligatorio (mín. 3 caracteres). Quien marca su propia asistencia sigue usando
--     rrhh_marcar (hora del servidor): eso no cambia.
--   · Ventana retroactiva: hasta 31 días atrás; no se permite el futuro ni horas que aún no pasaron.
--   · Nada se pierde: cada cambio queda en asistencias_log con los valores anteriores.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.asistencias_log (
  id            serial      PRIMARY KEY,
  asistencia_id integer,
  empresa_id    integer     NOT NULL,
  empleado_id   integer     NOT NULL,
  fecha         date        NOT NULL,
  accion        varchar     NOT NULL CHECK (accion IN ('crear','editar','quitar_salida','eliminar')),
  entrada_ant   timestamptz,
  salida_ant    timestamptz,
  entrada_nueva timestamptz,
  salida_nueva  timestamptz,
  motivo        text        NOT NULL,
  por_user      integer     REFERENCES public.users(id),
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_asis_log_empleado ON public.asistencias_log(empleado_id, fecha);
ALTER TABLE public.asistencias_log ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='asistencias_log' AND policyname='rrhh_log_lectura') THEN
    CREATE POLICY rrhh_log_lectura ON public.asistencias_log FOR SELECT USING (true);   -- solo lectura: se escribe vía las funciones
  END IF;
END $$;

-- Crear o corregir la marcación de un empleado en una fecha (Lima). p_entrada / p_salida = 'HH:MM'.
CREATE OR REPLACE FUNCTION public.rrhh_asistencia_editar(
  p_empleado_id integer, p_fecha date, p_entrada text, p_salida text, p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user public.users%ROWTYPE;
  v_emp  public.empleados%ROWTYPE;
  v_old  public.asistencias%ROWTYPE;
  v_new  public.asistencias%ROWTYPE;
  v_hoy  date := (now() AT TIME ZONE 'America/Lima')::date;
  v_ent  timestamptz;
  v_sal  timestamptz;
  v_hay  boolean;
BEGIN
  IF NOT public.fn_is_admin() THEN RAISE EXCEPTION 'Solo el administrador puede editar marcaciones'; END IF;
  SELECT * INTO v_user FROM public.users WHERE auth_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Sesión no válida'; END IF;
  IF length(trim(coalesce(p_motivo, ''))) < 3 THEN RAISE EXCEPTION 'Escribe el motivo del cambio'; END IF;
  IF p_fecha > v_hoy THEN RAISE EXCEPTION 'No se puede registrar asistencia de una fecha futura'; END IF;
  IF p_fecha < v_hoy - 31 THEN RAISE EXCEPTION 'Solo se puede editar hasta 31 días atrás'; END IF;
  IF nullif(trim(coalesce(p_entrada, '')), '') IS NULL THEN RAISE EXCEPTION 'Indica la hora de ingreso (para borrar todo usa Eliminar marcación)'; END IF;
  SELECT * INTO v_emp FROM public.empleados WHERE id = p_empleado_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Empleado no encontrado'; END IF;

  v_ent := (p_fecha::timestamp + p_entrada::time) AT TIME ZONE 'America/Lima';
  v_sal := CASE WHEN nullif(trim(coalesce(p_salida, '')), '') IS NULL THEN NULL
                ELSE (p_fecha::timestamp + p_salida::time) AT TIME ZONE 'America/Lima' END;
  IF v_ent > now() THEN RAISE EXCEPTION 'La hora de ingreso aún no ha ocurrido'; END IF;
  IF v_sal IS NOT NULL AND v_sal > now() THEN RAISE EXCEPTION 'La hora de salida aún no ha ocurrido'; END IF;
  IF v_sal IS NOT NULL AND v_sal < v_ent THEN RAISE EXCEPTION 'La salida no puede ser anterior al ingreso'; END IF;

  SELECT * INTO v_old FROM public.asistencias WHERE empleado_id = p_empleado_id AND fecha = p_fecha FOR UPDATE;
  v_hay := FOUND;
  IF v_hay THEN
    UPDATE public.asistencias
       SET entrada = v_ent, salida = v_sal,
           origen_entrada = 'admin', origen_salida = CASE WHEN v_sal IS NULL THEN NULL ELSE 'admin' END,
           editado_por = v_user.id, motivo_edicion = trim(p_motivo), updated_at = now()
     WHERE id = v_old.id RETURNING * INTO v_new;
  ELSE
    INSERT INTO public.asistencias (empresa_id, empleado_id, fecha, entrada, salida, origen_entrada, origen_salida, marcado_por, editado_por, motivo_edicion)
    VALUES (v_emp.empresa_id, p_empleado_id, p_fecha, v_ent, v_sal, 'admin', CASE WHEN v_sal IS NULL THEN NULL ELSE 'admin' END, v_user.id, v_user.id, trim(p_motivo))
    RETURNING * INTO v_new;
  END IF;

  INSERT INTO public.asistencias_log (asistencia_id, empresa_id, empleado_id, fecha, accion, entrada_ant, salida_ant, entrada_nueva, salida_nueva, motivo, por_user)
  VALUES (v_new.id, v_new.empresa_id, p_empleado_id, p_fecha, CASE WHEN v_hay THEN 'editar' ELSE 'crear' END,
          CASE WHEN v_hay THEN v_old.entrada END, CASE WHEN v_hay THEN v_old.salida END, v_ent, v_sal, trim(p_motivo), v_user.id);
  RETURN to_jsonb(v_new);
END $$;

-- Quitar solo la salida (para volver a marcarla) o eliminar toda la marcación del día.
CREATE OR REPLACE FUNCTION public.rrhh_asistencia_eliminar(
  p_asistencia_id integer, p_parte text, p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user public.users%ROWTYPE;
  v_old  public.asistencias%ROWTYPE;
BEGIN
  IF NOT public.fn_is_admin() THEN RAISE EXCEPTION 'Solo el administrador puede eliminar marcaciones'; END IF;
  SELECT * INTO v_user FROM public.users WHERE auth_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Sesión no válida'; END IF;
  IF p_parte NOT IN ('salida', 'todo') THEN RAISE EXCEPTION 'Parte inválida'; END IF;
  IF length(trim(coalesce(p_motivo, ''))) < 3 THEN RAISE EXCEPTION 'Escribe el motivo del cambio'; END IF;
  SELECT * INTO v_old FROM public.asistencias WHERE id = p_asistencia_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La marcación ya no existe'; END IF;

  IF p_parte = 'salida' THEN
    IF v_old.salida IS NULL THEN RAISE EXCEPTION 'Esa marcación no tiene salida'; END IF;
    UPDATE public.asistencias SET salida = NULL, origen_salida = NULL, editado_por = v_user.id,
           motivo_edicion = trim(p_motivo), updated_at = now() WHERE id = v_old.id;
    INSERT INTO public.asistencias_log (asistencia_id, empresa_id, empleado_id, fecha, accion, entrada_ant, salida_ant, entrada_nueva, salida_nueva, motivo, por_user)
    VALUES (v_old.id, v_old.empresa_id, v_old.empleado_id, v_old.fecha, 'quitar_salida', v_old.entrada, v_old.salida, v_old.entrada, NULL, trim(p_motivo), v_user.id);
  ELSE
    INSERT INTO public.asistencias_log (asistencia_id, empresa_id, empleado_id, fecha, accion, entrada_ant, salida_ant, motivo, por_user)
    VALUES (v_old.id, v_old.empresa_id, v_old.empleado_id, v_old.fecha, 'eliminar', v_old.entrada, v_old.salida, trim(p_motivo), v_user.id);
    DELETE FROM public.asistencias WHERE id = v_old.id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'parte', p_parte);
END $$;

GRANT EXECUTE ON FUNCTION public.rrhh_asistencia_editar(integer, date, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rrhh_asistencia_eliminar(integer, text, text) TO authenticated;

-- Verificación (se ve en el panel de resultados)
SELECT proname AS funcion FROM pg_proc WHERE proname IN ('rrhh_asistencia_editar', 'rrhh_asistencia_eliminar') ORDER BY 1;
SELECT count(*) AS filas_log FROM public.asistencias_log;
