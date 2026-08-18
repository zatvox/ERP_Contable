-- ============================================================
-- JHIRO ERP v2 — FUNCIONES Y TRIGGERS PostgreSQL
-- Archivo: 02_functions.sql
-- Ejecutar DESPUÉS de 01_schema.sql
-- ============================================================

-- ============================================================
-- F1. TRIGGER: PARTIDA DOBLE — validar debe = haber al confirmar
-- Solo aplica cuando status cambia a 'confirmado'.
-- Principio 3.1 del Prompt Maestro.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_validar_partida_doble()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_suma_debe  numeric;
  v_suma_haber numeric;
  v_diff       numeric;
BEGIN
  -- Solo validar al confirmar (no en borrador)
  IF NEW.status <> 'confirmado' THEN
    RETURN NEW;
  END IF;

  SELECT
    COALESCE(SUM(CASE WHEN tipo = 'debe'  THEN importe ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN tipo = 'haber' THEN importe ELSE 0 END), 0)
  INTO v_suma_debe, v_suma_haber
  FROM public.journal_entry_lines
  WHERE entry_id = NEW.id;

  v_diff := ABS(v_suma_debe - v_suma_haber);

  IF v_diff > 0.005 THEN  -- tolerancia de medio centavo por redondeos
    RAISE EXCEPTION
      'PARTIDA DOBLE: El asiento % no cuadra. Debe=% Haber=% Diferencia=%',
      NEW.numero, v_suma_debe, v_suma_haber, (v_suma_debe - v_suma_haber)
      USING ERRCODE = 'P0001';
  END IF;

  -- Actualizar totales en cabecera
  NEW.total_debe  := v_suma_debe;
  NEW.total_haber := v_suma_haber;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_partida_doble ON public.journal_entries;
CREATE TRIGGER trg_partida_doble
  BEFORE UPDATE OF status ON public.journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_validar_partida_doble();

COMMENT ON FUNCTION public.fn_validar_partida_doble() IS
  'Valida partida doble antes de confirmar un asiento. Principio 3.1 Prompt Maestro.';


-- ============================================================
-- F2. TRIGGER: BLOQUEO DE PERÍODOS CERRADOS
-- Impide INSERT/UPDATE de asientos en periodos cerrados.
-- Principio 3.6 del Prompt Maestro.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_bloquear_periodo_cerrado()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_periodo  varchar(7);
  v_estado   varchar;
BEGIN
  -- Solo aplica a asientos confirmados nuevos o a cambios de fecha
  IF TG_OP = 'INSERT' THEN
    v_periodo := NEW.periodo_contable;
  ELSIF TG_OP = 'UPDATE' THEN
    v_periodo := NEW.periodo_contable;
    -- Si solo cambia el status a 'reversado', permitir
    IF OLD.status = 'confirmado' AND NEW.status = 'reversado' THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT estado INTO v_estado
  FROM public.periodos_contables
  WHERE periodo = v_periodo;

  IF v_estado = 'cerrado' THEN
    RAISE EXCEPTION
      'PERIODO CERRADO: No se puede registrar asientos en el periodo %. Declare una rectificación en el periodo actual.',
      v_periodo
      USING ERRCODE = 'P0002';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bloquear_periodo_cerrado ON public.journal_entries;
CREATE TRIGGER trg_bloquear_periodo_cerrado
  BEFORE INSERT OR UPDATE ON public.journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_bloquear_periodo_cerrado();

COMMENT ON FUNCTION public.fn_bloquear_periodo_cerrado() IS
  'Bloquea INSERT/UPDATE de asientos en periodos cerrados. Principio 3.6 Prompt Maestro.';


-- ============================================================
-- F3. FUNCIÓN: REVERSAR ASIENTO
-- Crea el asiento inverso exacto (debe↔haber invertidos).
-- Principio 3.3 del Prompt Maestro.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_reversar_asiento(
  p_asiento_id   bigint,
  p_user_id      bigint   DEFAULT NULL,
  p_motivo       text     DEFAULT 'Reversión manual'
)
RETURNS bigint    -- retorna el ID del asiento de reversión
LANGUAGE plpgsql
AS $$
DECLARE
  v_asiento       public.journal_entries%ROWTYPE;
  v_nuevo_id      bigint;
  v_nuevo_numero  varchar;
  v_linea         public.journal_entry_lines%ROWTYPE;
BEGIN
  -- Obtener asiento original
  SELECT * INTO v_asiento FROM public.journal_entries WHERE id = p_asiento_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asiento % no encontrado', p_asiento_id;
  END IF;

  IF v_asiento.status = 'reversado' THEN
    RAISE EXCEPTION 'El asiento % ya fue reversado', p_asiento_id;
  END IF;

  IF v_asiento.status <> 'confirmado' THEN
    RAISE EXCEPTION 'Solo se pueden reversar asientos confirmados. Estado actual: %', v_asiento.status;
  END IF;

  -- Generar número del asiento de reversión
  SELECT 'REV-' || LPAD(CAST(COALESCE(MAX(CAST(SUBSTRING(numero FROM '\d+$') AS integer)), 0) + 1 AS text), 6, '0')
  INTO v_nuevo_numero
  FROM public.journal_entries
  WHERE numero LIKE 'REV-%';

  -- Crear cabecera del asiento de reversión
  INSERT INTO public.journal_entries (
    numero, fecha, periodo_contable, descripcion,
    documento_referencia, tipo_movimiento, tipo_documento,
    moneda, tipo_cambio, contact_id, status,
    origen_tipo, asiento_origen_id, created_by
  ) VALUES (
    v_nuevo_numero,
    CURRENT_DATE,
    TO_CHAR(CURRENT_DATE, 'YYYY-MM'),
    'REVERSIÓN: ' || v_asiento.descripcion || ' — ' || p_motivo,
    v_asiento.numero,
    'Reversión',
    v_asiento.tipo_documento,
    v_asiento.moneda,
    v_asiento.tipo_cambio,
    v_asiento.contact_id,
    'borrador',
    'reversion',
    p_asiento_id,
    p_user_id
  )
  RETURNING id INTO v_nuevo_id;

  -- Invertir líneas (debe↔haber)
  FOR v_linea IN
    SELECT * FROM public.journal_entry_lines WHERE entry_id = p_asiento_id
  LOOP
    INSERT INTO public.journal_entry_lines (
      entry_id, account_id, tipo, importe,
      importe_original, moneda_original, tipo_cambio, descripcion, fecha
    ) VALUES (
      v_nuevo_id,
      v_linea.account_id,
      CASE WHEN v_linea.tipo = 'debe' THEN 'haber' ELSE 'debe' END,
      v_linea.importe,
      v_linea.importe_original,
      v_linea.moneda_original,
      v_linea.tipo_cambio,
      'REV: ' || COALESCE(v_linea.descripcion, ''),
      CURRENT_DATE
    );
  END LOOP;

  -- Marcar asiento original como reversado
  UPDATE public.journal_entries
  SET status = 'reversado', updated_at = now()
  WHERE id = p_asiento_id;

  -- Confirmar el asiento de reversión (activa el trigger de partida doble)
  UPDATE public.journal_entries
  SET status = 'confirmado', updated_at = now()
  WHERE id = v_nuevo_id;

  RETURN v_nuevo_id;
END;
$$;

COMMENT ON FUNCTION public.fn_reversar_asiento IS
  'Genera asiento de reversión (debe↔haber invertidos). Principio 3.3 Prompt Maestro.';


-- ============================================================
-- F4. FUNCIÓN: ACTUALIZAR SALDOS PLAN DE CUENTAS
-- Vista materializada-like: recalcula saldo_debe/saldo_haber
-- desde journal_entry_lines filtrando asientos confirmados.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_actualizar_saldos_plan_cuentas()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.plan_cuentas pc
  SET
    saldo_debe  = COALESCE(agg.total_debe, 0),
    saldo_haber = COALESCE(agg.total_haber, 0),
    updated_at  = now()
  FROM (
    SELECT
      jel.account_id,
      SUM(jel.debe) AS total_debe,
      SUM(jel.haber) AS total_haber
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.status = 'confirmado'
    GROUP BY jel.account_id
  ) agg
  WHERE pc.id = agg.account_id;
END;
$$;

COMMENT ON FUNCTION public.fn_actualizar_saldos_plan_cuentas IS
  'Recalcula saldo_debe/saldo_haber en plan_cuentas desde los apuntes confirmados.';


-- ============================================================
-- F6. FUNCIÓN: KARDEX — registrar movimiento y actualizar saldos
-- Usa método promedio ponderado para costo_unitario.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_registrar_kardex(
  p_item_id           bigint,
  p_lote_id           bigint        DEFAULT NULL,
  p_fecha             date          DEFAULT CURRENT_DATE,
  p_tipo_movimiento   varchar       DEFAULT 'entrada',
  p_concepto          varchar       DEFAULT '',
  p_documento_ref     varchar       DEFAULT NULL,
  p_cantidad_entrada  numeric       DEFAULT 0,
  p_cantidad_salida   numeric       DEFAULT 0,
  p_costo_unitario    numeric       DEFAULT 0,
  p_asiento_id        bigint        DEFAULT NULL,
  p_compra_id         bigint        DEFAULT NULL,
  p_venta_id          bigint        DEFAULT NULL,
  p_user_id           bigint        DEFAULT NULL
)
RETURNS bigint   -- retorna el ID del movimiento kardex creado
LANGUAGE plpgsql
AS $$
DECLARE
  v_saldo_anterior_qty   numeric := 0;
  v_saldo_anterior_val   numeric := 0;
  v_costo_promedio_ant   numeric := 0;
  v_costo_unitario_calc  numeric := 0;
  v_saldo_nuevo_qty      numeric := 0;
  v_saldo_nuevo_val      numeric := 0;
  v_costo_promedio_nuevo numeric := 0;
  v_costo_total          numeric := 0;
  v_kardex_id            bigint;
BEGIN
  -- Obtener saldo anterior del item
  SELECT
    COALESCE(saldo_cantidad, 0),
    COALESCE(saldo_valor, 0),
    COALESCE(costo_promedio, 0)
  INTO v_saldo_anterior_qty, v_saldo_anterior_val, v_costo_promedio_ant
  FROM public.kardex
  WHERE item_id = p_item_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  -- Si no hay historial, verificar items.costo_promedio
  IF v_saldo_anterior_qty = 0 AND v_costo_promedio_ant = 0 THEN
    SELECT COALESCE(costo_promedio, 0), COALESCE(stock_actual, 0)
    INTO v_costo_promedio_ant, v_saldo_anterior_qty
    FROM public.items WHERE id = p_item_id;
    v_saldo_anterior_val := v_saldo_anterior_qty * v_costo_promedio_ant;
  END IF;

  IF p_tipo_movimiento IN ('entrada','ajuste_entrada','devolucion_venta') THEN
    -- Promedio ponderado en entrada
    v_costo_total := p_cantidad_entrada * p_costo_unitario;
    v_saldo_nuevo_qty := v_saldo_anterior_qty + p_cantidad_entrada;
    v_saldo_nuevo_val := v_saldo_anterior_val + v_costo_total;

    IF v_saldo_nuevo_qty > 0 THEN
      v_costo_promedio_nuevo := ROUND(v_saldo_nuevo_val / v_saldo_nuevo_qty, 6);
    ELSE
      v_costo_promedio_nuevo := p_costo_unitario;
    END IF;
    v_costo_unitario_calc := p_costo_unitario;

  ELSIF p_tipo_movimiento IN ('salida','ajuste_salida','devolucion_compra') THEN
    -- Salida al costo promedio anterior
    v_costo_unitario_calc := COALESCE(v_costo_promedio_ant, p_costo_unitario);
    v_costo_total := ROUND(p_cantidad_salida * v_costo_unitario_calc, 2);
    v_saldo_nuevo_qty := v_saldo_anterior_qty - p_cantidad_salida;
    v_saldo_nuevo_val := GREATEST(0, v_saldo_anterior_val - v_costo_total);

    IF v_saldo_nuevo_qty > 0 THEN
      v_costo_promedio_nuevo := ROUND(v_saldo_nuevo_val / v_saldo_nuevo_qty, 6);
    ELSE
      v_costo_promedio_nuevo := v_costo_promedio_ant;
    END IF;
  END IF;

  -- Insertar movimiento kardex
  INSERT INTO public.kardex (
    item_id, lote_id, fecha, tipo_movimiento, concepto,
    documento_referencia, cantidad_entrada, cantidad_salida,
    costo_unitario, costo_total,
    saldo_cantidad, saldo_valor, costo_promedio,
    asiento_id, compra_id, venta_id, created_by
  ) VALUES (
    p_item_id, p_lote_id, p_fecha, p_tipo_movimiento, p_concepto,
    p_documento_ref, p_cantidad_entrada, p_cantidad_salida,
    v_costo_unitario_calc, v_costo_total,
    v_saldo_nuevo_qty, ROUND(v_saldo_nuevo_val, 2), v_costo_promedio_nuevo,
    p_asiento_id, p_compra_id, p_venta_id, p_user_id
  )
  RETURNING id INTO v_kardex_id;

  -- Actualizar items con saldo actualizado
  UPDATE public.items
  SET
    stock_actual    = v_saldo_nuevo_qty,
    costo_promedio  = v_costo_promedio_nuevo,
    updated_at      = now()
  WHERE id = p_item_id;

  RETURN v_kardex_id;
END;
$$;

COMMENT ON FUNCTION public.fn_registrar_kardex IS
  'Registra movimiento de inventario en kardex usando costo promedio ponderado.';


-- ============================================================
-- F7. FUNCIÓN: ABRIR PERÍODO AUTOMÁTICAMENTE
-- Si no existe el período actual, lo crea como abierto.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_asegurar_periodo_abierto(p_fecha date DEFAULT CURRENT_DATE)
RETURNS varchar
LANGUAGE plpgsql
AS $$
DECLARE
  v_periodo varchar(7);
BEGIN
  v_periodo := TO_CHAR(p_fecha, 'YYYY-MM');

  INSERT INTO public.periodos_contables (periodo, ano, mes, estado)
  VALUES (v_periodo, EXTRACT(YEAR FROM p_fecha)::integer, EXTRACT(MONTH FROM p_fecha)::integer, 'abierto')
  ON CONFLICT (periodo) DO NOTHING;

  RETURN v_periodo;
END;
$$;


-- ============================================================
-- F8. FUNCIÓN: CERRAR PERÍODO
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_cerrar_periodo(
  p_periodo   varchar(7),
  p_user_id   bigint DEFAULT NULL,
  p_notas     text   DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.periodos_contables
  SET
    estado       = 'cerrado',
    fecha_cierre = CURRENT_DATE,
    cerrado_por  = p_user_id,
    notas        = p_notas
  WHERE periodo = p_periodo;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Período % no encontrado en periodos_contables', p_periodo;
  END IF;
END;
$$;


-- ============================================================
-- F9. FUNCIÓN: GENERAR NÚMERO DE ASIENTO AUTOMÁTICO
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_generar_numero_asiento()
RETURNS varchar
LANGUAGE plpgsql
AS $$
DECLARE
  v_max integer;
  v_numero varchar;
BEGIN
  SELECT COALESCE(
    MAX(CAST(SUBSTRING(numero FROM '\d+$') AS integer)), 0
  ) + 1
  INTO v_max
  FROM public.journal_entries
  WHERE numero ~ '^AS-\d+$';

  v_numero := 'AS-' || LPAD(v_max::text, 6, '0');
  RETURN v_numero;
END;
$$;


-- ============================================================
-- F10. FUNCIÓN: ACTUALIZAR SALDO BANCO tras movimiento
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_actualizar_saldo_banco()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.bancos
    SET saldo_actual = saldo_actual + CASE WHEN NEW.tipo = 'ingreso' THEN NEW.monto ELSE -NEW.monto END,
        updated_at   = now()
    WHERE id = NEW.banco_id;

    -- Actualizar saldo_posterior del movimiento
    SELECT saldo_actual INTO NEW.saldo_posterior FROM public.bancos WHERE id = NEW.banco_id;

  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.bancos
    SET saldo_actual = saldo_actual - CASE WHEN OLD.tipo = 'ingreso' THEN OLD.monto ELSE -OLD.monto END,
        updated_at   = now()
    WHERE id = OLD.banco_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_actualizar_saldo_banco ON public.movimientos_banco;
CREATE TRIGGER trg_actualizar_saldo_banco
  AFTER INSERT OR DELETE ON public.movimientos_banco
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_actualizar_saldo_banco();


-- ============================================================
-- F11. FUNCIÓN: ACTUALIZAR ESTADO PAGO CxC
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_actualizar_estado_cxc()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_cxc_id        bigint;
  v_monto_total   numeric;
  v_monto_cobrado numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_cxc_id := NEW.cxc_id;
  ELSIF TG_OP = 'DELETE' THEN
    v_cxc_id := OLD.cxc_id;
  END IF;

  IF v_cxc_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  SELECT monto_total INTO v_monto_total FROM public.cuentas_cobrar WHERE id = v_cxc_id;

  SELECT COALESCE(SUM(monto), 0) INTO v_monto_cobrado
  FROM public.cobros WHERE cxc_id = v_cxc_id;

  UPDATE public.cuentas_cobrar
  SET
    monto_cobrado = v_monto_cobrado,
    estado = CASE
      WHEN v_monto_cobrado <= 0          THEN 'pendiente'
      WHEN v_monto_cobrado >= v_monto_total THEN 'cobrado'
      ELSE 'parcial'
    END,
    updated_at = now()
  WHERE id = v_cxc_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_actualizar_estado_cxc ON public.cobros;
CREATE TRIGGER trg_actualizar_estado_cxc
  AFTER INSERT OR DELETE ON public.cobros
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_actualizar_estado_cxc();


-- ============================================================
-- F12. TRIGGER: AUDITORÍA GENERAL ERP
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_erp_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_cambios jsonb;
BEGIN
  v_cambios := CASE TG_OP
    WHEN 'INSERT' THEN jsonb_build_object('after', to_jsonb(NEW))
    WHEN 'UPDATE' THEN jsonb_build_object('before', to_jsonb(OLD), 'after', to_jsonb(NEW))
    WHEN 'DELETE' THEN jsonb_build_object('before', to_jsonb(OLD))
  END;

  INSERT INTO public.audit_logs (auth_user_id, modulo, entidad_tipo, entidad_id, accion, cambios, timestamp)
  VALUES (
    auth.uid(),
    TG_TABLE_NAME,
    TG_TABLE_NAME,
    CASE TG_OP WHEN 'DELETE' THEN OLD.id::text ELSE NEW.id::text END,
    TG_OP,
    v_cambios,
    now()
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Aplicar audit trigger a tablas críticas del ERP
DO $$
DECLARE
  tablas text[] := ARRAY[
    'journal_entries','journal_entry_lines',
    'compras','detalle_compras',
    'ventas','detalle_ventas',
    'cobros','pagos_proveedores',
    'bancos','movimientos_banco',
    'cuentas_cobrar','kardex',
    'periodos_contables','plan_cuentas'
  ];
  t text;
BEGIN
  FOREACH t IN ARRAY tablas LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_erp_audit ON public.%I;
         CREATE TRIGGER trg_erp_audit
           AFTER INSERT OR UPDATE OR DELETE ON public.%I
           FOR EACH ROW EXECUTE FUNCTION public.fn_erp_audit();',
        t, t
      );
    END IF;
  END LOOP;
END $$;


