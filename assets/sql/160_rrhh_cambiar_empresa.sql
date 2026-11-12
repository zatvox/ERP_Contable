-- ============================================================================
-- 160_rrhh_cambiar_empresa.sql — RRHH · cambiar la empresa de una ficha (2026-11-12)
-- Requiere SQL 134, 135, 137, 158 y 159. Solo administrador; motivo obligatorio.
--  A) rrhh_empleado_mover_empresa  → CORREGIR: la ficha se creó en la empresa equivocada.
--     Mueve la ficha con TODAS sus asistencias, marcas e historial a la otra empresa.
--  B) rrhh_empleado_transferir     → CAMBIO REAL de empleador: cesa la ficha actual (queda su
--     historial en la empresa de origen) y crea una ficha nueva en la otra con los mismos datos.
-- Validaciones: destino distinto; la persona no puede tener ya ficha en el destino; la cuenta de
-- usuario no puede repetirse en el destino; la sede se conserva solo si pertenece al destino;
-- la transferencia exige una fecha posterior a la última asistencia de la ficha vieja.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rrhh_empleado_mover_empresa(p_empleado_id integer, p_empresa_id integer, p_motivo text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_e      public.empleados%ROWTYPE;
  v_orig   text; v_dest text;
  v_n_asis integer;
BEGIN
  IF NOT public.fn_is_admin() THEN RAISE EXCEPTION 'Solo el administrador puede cambiar la empresa de una ficha'; END IF;
  IF length(btrim(COALESCE(p_motivo, ''))) < 3 THEN RAISE EXCEPTION 'El motivo es obligatorio'; END IF;
  SELECT * INTO v_e FROM public.empleados WHERE id = p_empleado_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Empleado no encontrado'; END IF;
  IF v_e.empresa_id = p_empresa_id THEN RAISE EXCEPTION 'La ficha ya está en esa empresa'; END IF;
  SELECT nombre_comercial INTO v_dest FROM public.empresa_config WHERE id = p_empresa_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'La empresa destino no existe'; END IF;
  SELECT nombre_comercial INTO v_orig FROM public.empresa_config WHERE id = v_e.empresa_id;
  IF EXISTS (SELECT 1 FROM public.empleados WHERE contact_id = v_e.contact_id AND empresa_id = p_empresa_id) THEN
    RAISE EXCEPTION 'Esa persona ya tiene una ficha en %: usa «Transferir» o edita esa ficha', v_dest;
  END IF;
  IF v_e.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.empleados WHERE user_id = v_e.user_id AND empresa_id = p_empresa_id) THEN
    RAISE EXCEPTION 'Ese usuario ya está vinculado a otra ficha de %', v_dest;
  END IF;

  SELECT count(*) INTO v_n_asis FROM public.asistencias WHERE empleado_id = p_empleado_id;
  UPDATE public.asistencias       SET empresa_id = p_empresa_id WHERE empleado_id = p_empleado_id;
  UPDATE public.asistencia_marcas SET empresa_id = p_empresa_id WHERE empleado_id = p_empleado_id;
  UPDATE public.asistencias_log   SET empresa_id = p_empresa_id WHERE empleado_id = p_empleado_id;
  UPDATE public.empleados
     SET empresa_id = p_empresa_id,
         sede_id = (SELECT s.id FROM public.sedes s WHERE s.id = v_e.sede_id AND s.empresa_id = p_empresa_id),
         notas = btrim(COALESCE(notas, '') || ' [' || to_char(now() AT TIME ZONE 'America/Lima', 'DD/MM/YYYY') || ' movida de ' || v_orig || ' a ' || v_dest || ': ' || btrim(p_motivo) || ']'),
         updated_at = now()
   WHERE id = p_empleado_id;
  RETURN jsonb_build_object('ok', true, 'de', v_orig, 'a', v_dest, 'asistencias_movidas', v_n_asis);
END $$;

CREATE OR REPLACE FUNCTION public.rrhh_empleado_transferir(p_empleado_id integer, p_empresa_id integer, p_fecha date, p_motivo text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_e      public.empleados%ROWTYPE;
  v_orig   text; v_dest text;
  v_ultima date;
  v_nuevo  integer;
BEGIN
  IF NOT public.fn_is_admin() THEN RAISE EXCEPTION 'Solo el administrador puede transferir empleados'; END IF;
  IF length(btrim(COALESCE(p_motivo, ''))) < 3 THEN RAISE EXCEPTION 'El motivo es obligatorio'; END IF;
  IF p_fecha IS NULL THEN RAISE EXCEPTION 'Indica la fecha de ingreso a la nueva empresa'; END IF;
  SELECT * INTO v_e FROM public.empleados WHERE id = p_empleado_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Empleado no encontrado'; END IF;
  IF v_e.estado = 'cesado' THEN RAISE EXCEPTION 'La ficha ya está cesada: reactívala o crea una ficha nueva'; END IF;
  IF v_e.empresa_id = p_empresa_id THEN RAISE EXCEPTION 'La ficha ya está en esa empresa'; END IF;
  SELECT nombre_comercial INTO v_dest FROM public.empresa_config WHERE id = p_empresa_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'La empresa destino no existe'; END IF;
  SELECT nombre_comercial INTO v_orig FROM public.empresa_config WHERE id = v_e.empresa_id;
  IF EXISTS (SELECT 1 FROM public.empleados WHERE contact_id = v_e.contact_id AND empresa_id = p_empresa_id) THEN
    RAISE EXCEPTION 'Esa persona ya tiene una ficha en %: reactívala en vez de transferir', v_dest;
  END IF;
  SELECT max(fecha) INTO v_ultima FROM public.asistencias WHERE empleado_id = p_empleado_id;
  IF v_ultima IS NOT NULL AND p_fecha <= v_ultima THEN
    RAISE EXCEPTION 'La ficha actual tiene asistencias hasta el %: elige una fecha posterior (o usa «Mover» si fue un error de registro)', to_char(v_ultima, 'DD/MM/YYYY');
  END IF;

  INSERT INTO public.empleados (empresa_id, contact_id, user_id, vinculo, cargo, sede_id, fecha_ingreso, estado, sueldo_mensual,
                                asignacion_familiar, sistema_pensiones, afp_id, cuspp, tipo_comision_afp, jornada_horas,
                                hora_entrada, hora_salida, tolerancia_min, notas, horario_semanal, almuerzo_min)
  SELECT p_empresa_id, contact_id, user_id, vinculo, cargo,
         (SELECT s.id FROM public.sedes s WHERE s.empresa_id = p_empresa_id AND s.es_principal AND s.activo LIMIT 1),
         p_fecha, 'activo', sueldo_mensual, asignacion_familiar, sistema_pensiones, afp_id, cuspp, tipo_comision_afp, jornada_horas,
         hora_entrada, hora_salida, tolerancia_min,
         btrim('Transferido desde ' || v_orig || ': ' || btrim(p_motivo)), horario_semanal, almuerzo_min
    FROM public.empleados WHERE id = p_empleado_id
  RETURNING id INTO v_nuevo;

  UPDATE public.empleados
     SET estado = 'cesado', fecha_cese = p_fecha - 1, motivo_cese = 'Transferido a ' || v_dest, updated_at = now()
   WHERE id = p_empleado_id;
  RETURN jsonb_build_object('ok', true, 'de', v_orig, 'a', v_dest, 'ficha_nueva', v_nuevo);
END $$;

GRANT EXECUTE ON FUNCTION public.rrhh_empleado_mover_empresa(integer, integer, text)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.rrhh_empleado_transferir(integer, integer, date, text)    TO authenticated;
SELECT 'ok' AS resultado;
