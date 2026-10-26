-- ============================================================================
-- 97_cuotas_ajuste_por_notas.sql  (2026-10-22)
-- Bug: una Nota de Crédito/Débito cambia el saldo del DOCUMENTO
-- (cuentas_cobrar/pagar.monto_notas_credito/debito) pero NO las cuotas.
-- Ej. FFFI-290 Busatex: total 15,634.21 − NC 3,926.96 = 11,707.25, pero su
-- cuota seguía en 15,634.21 → el canje en letras y la imputación de cobros
-- tomaban el saldo de la cuota (equivocado).
--
-- Regla: Σ cuotas vigentes = total + ND − NC.
--   · Exceso (NC): se descuenta de la ÚLTIMA cuota hacia atrás, nunca por
--     debajo de lo ya aplicado (cobrado + retenido + canjeado). Si una cuota
--     sin nada aplicado queda en 0 → estado 'anulado' (CHECK monto > 0).
--   · Falta (ND o NC eliminada): se suma a la última cuota vigente.
-- Deja un trigger para que toda NC/ND futura ajuste las cuotas sola.
-- No toca cobros, letras, asientos ni bancos. Documentos anulados: no.
-- ============================================================================

-- ── 1) VISTA PREVIA: documentos cuyas cuotas no cuadran con el saldo ────────
SELECT 'CxC' AS lado, c.id, c.serie || '-' || c.numero_comprobante AS doc, c.moneda,
       c.monto_total + COALESCE(c.monto_notas_debito,0) - COALESCE(c.monto_notas_credito,0) AS neto_doc,
       SUM(q.monto) FILTER (WHERE q.estado <> 'anulado') AS suma_cuotas
FROM public.cuentas_cobrar c JOIN public.cuotas_cobrar q ON q.cxc_id = c.id
WHERE c.estado <> 'anulado'
GROUP BY c.id
HAVING abs(c.monto_total + COALESCE(c.monto_notas_debito,0) - COALESCE(c.monto_notas_credito,0)
           - COALESCE(SUM(q.monto) FILTER (WHERE q.estado <> 'anulado'),0)) > 0.01
UNION ALL
SELECT 'CxP', p.id, COALESCE(p.serie || '-', '') || p.numero_comprobante, p.moneda,
       p.monto_total + COALESCE(p.monto_notas_debito,0) - COALESCE(p.monto_notas_credito,0),
       SUM(q.monto) FILTER (WHERE q.estado <> 'anulado')
FROM public.cuentas_pagar p JOIN public.cuotas_pagar q ON q.cxp_id = p.id
WHERE p.estado <> 'anulado'
GROUP BY p.id
HAVING abs(p.monto_total + COALESCE(p.monto_notas_debito,0) - COALESCE(p.monto_notas_credito,0)
           - COALESCE(SUM(q.monto) FILTER (WHERE q.estado <> 'anulado'),0)) > 0.01;

-- ── 2) FUNCIONES + TRIGGERS + CORRECCIÓN (bloque único) ─────────────────────
BEGIN;

-- Estado de una cuota (mismo criterio que estadoCuota() en cronograma.js)
CREATE OR REPLACE FUNCTION public.fn_estado_cuota(p_monto numeric, p_aplicado numeric, p_canjeado numeric, p_cobrar boolean)
RETURNS varchar LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_monto - p_aplicado <= 0.01 THEN
      CASE WHEN p_canjeado >= p_monto - 0.01 THEN 'canjeado' WHEN p_cobrar THEN 'cobrado' ELSE 'pagado' END
    WHEN p_aplicado > 0.01 THEN 'parcial'
    ELSE 'pendiente' END
$$;

-- CxC
CREATE OR REPLACE FUNCTION public.fn_ajustar_cuotas_cxc(p_cxc bigint)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_neto numeric; v_suma numeric; v_dif numeric; q record; v_ap numeric; v_quita numeric; v_nuevo numeric;
BEGIN
  SELECT monto_total + COALESCE(monto_notas_debito,0) - COALESCE(monto_notas_credito,0) INTO v_neto
    FROM public.cuentas_cobrar WHERE id = p_cxc AND estado <> 'anulado';
  IF v_neto IS NULL THEN RETURN; END IF;
  SELECT COALESCE(SUM(monto),0) INTO v_suma FROM public.cuotas_cobrar WHERE cxc_id = p_cxc AND estado <> 'anulado';
  IF NOT EXISTS (SELECT 1 FROM public.cuotas_cobrar WHERE cxc_id = p_cxc) THEN RETURN; END IF;
  v_dif := round(v_suma - v_neto, 2);
  IF v_dif > 0.01 THEN                                   -- NC: bajar desde la última
    FOR q IN SELECT * FROM public.cuotas_cobrar WHERE cxc_id = p_cxc AND estado <> 'anulado' ORDER BY numero_cuota DESC LOOP
      EXIT WHEN v_dif <= 0.01;
      v_ap := q.monto_cobrado + q.monto_retenido + q.monto_canjeado;
      v_quita := least(v_dif, q.monto - v_ap);
      CONTINUE WHEN v_quita <= 0.004;
      v_nuevo := round(q.monto - v_quita, 2);
      IF v_nuevo <= 0.004 THEN
        UPDATE public.cuotas_cobrar SET estado = 'anulado', observaciones = trim(COALESCE(observaciones,'') || ' [anulada por NC]'), updated_at = now() WHERE id = q.id;
      ELSE
        UPDATE public.cuotas_cobrar SET monto = v_nuevo, estado = public.fn_estado_cuota(v_nuevo, v_ap, q.monto_canjeado, true), updated_at = now() WHERE id = q.id;
      END IF;
      v_dif := round(v_dif - v_quita, 2);
    END LOOP;
  ELSIF v_dif < -0.01 THEN                               -- ND / NC eliminada: subir la última
    SELECT * INTO q FROM public.cuotas_cobrar WHERE cxc_id = p_cxc AND estado <> 'anulado' ORDER BY numero_cuota DESC LIMIT 1;
    IF FOUND THEN
      v_ap := q.monto_cobrado + q.monto_retenido + q.monto_canjeado;
      v_nuevo := round(q.monto - v_dif, 2);
      UPDATE public.cuotas_cobrar SET monto = v_nuevo, estado = public.fn_estado_cuota(v_nuevo, v_ap, q.monto_canjeado, true), updated_at = now() WHERE id = q.id;
    ELSE   -- todas anuladas: revive la última
      UPDATE public.cuotas_cobrar SET monto = round(-v_dif, 2), monto_cobrado = 0, monto_retenido = 0, monto_canjeado = 0, estado = 'pendiente', updated_at = now()
       WHERE id = (SELECT id FROM public.cuotas_cobrar WHERE cxc_id = p_cxc ORDER BY numero_cuota DESC LIMIT 1);
    END IF;
  END IF;
END;
$$;

-- CxP
CREATE OR REPLACE FUNCTION public.fn_ajustar_cuotas_cxp(p_cxp bigint)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_neto numeric; v_suma numeric; v_dif numeric; q record; v_ap numeric; v_quita numeric; v_nuevo numeric;
BEGIN
  SELECT monto_total + COALESCE(monto_notas_debito,0) - COALESCE(monto_notas_credito,0) INTO v_neto
    FROM public.cuentas_pagar WHERE id = p_cxp AND estado <> 'anulado';
  IF v_neto IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cuotas_pagar WHERE cxp_id = p_cxp) THEN RETURN; END IF;
  SELECT COALESCE(SUM(monto),0) INTO v_suma FROM public.cuotas_pagar WHERE cxp_id = p_cxp AND estado <> 'anulado';
  v_dif := round(v_suma - v_neto, 2);
  IF v_dif > 0.01 THEN
    FOR q IN SELECT * FROM public.cuotas_pagar WHERE cxp_id = p_cxp AND estado <> 'anulado' ORDER BY numero_cuota DESC LOOP
      EXIT WHEN v_dif <= 0.01;
      v_ap := q.monto_pagado + q.monto_canjeado;
      v_quita := least(v_dif, q.monto - v_ap);
      CONTINUE WHEN v_quita <= 0.004;
      v_nuevo := round(q.monto - v_quita, 2);
      IF v_nuevo <= 0.004 THEN
        UPDATE public.cuotas_pagar SET estado = 'anulado', observaciones = trim(COALESCE(observaciones,'') || ' [anulada por NC]'), updated_at = now() WHERE id = q.id;
      ELSE
        UPDATE public.cuotas_pagar SET monto = v_nuevo, estado = public.fn_estado_cuota(v_nuevo, v_ap, q.monto_canjeado, false), updated_at = now() WHERE id = q.id;
      END IF;
      v_dif := round(v_dif - v_quita, 2);
    END LOOP;
  ELSIF v_dif < -0.01 THEN
    SELECT * INTO q FROM public.cuotas_pagar WHERE cxp_id = p_cxp AND estado <> 'anulado' ORDER BY numero_cuota DESC LIMIT 1;
    IF FOUND THEN
      v_ap := q.monto_pagado + q.monto_canjeado;
      v_nuevo := round(q.monto - v_dif, 2);
      UPDATE public.cuotas_pagar SET monto = v_nuevo, estado = public.fn_estado_cuota(v_nuevo, v_ap, q.monto_canjeado, false), updated_at = now() WHERE id = q.id;
    ELSE
      UPDATE public.cuotas_pagar SET monto = round(-v_dif, 2), monto_pagado = 0, monto_canjeado = 0, estado = 'pendiente', updated_at = now()
       WHERE id = (SELECT id FROM public.cuotas_pagar WHERE cxp_id = p_cxp ORDER BY numero_cuota DESC LIMIT 1);
    END IF;
  END IF;
END;
$$;

-- Triggers: al cambiar total o notas del documento
CREATE OR REPLACE FUNCTION public.trg_cxc_ajustar_cuotas() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM public.fn_ajustar_cuotas_cxc(NEW.id); RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION public.trg_cxp_ajustar_cuotas() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM public.fn_ajustar_cuotas_cxp(NEW.id); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_cxc_ajustar_cuotas ON public.cuentas_cobrar;
CREATE TRIGGER trg_cxc_ajustar_cuotas AFTER UPDATE OF monto_notas_credito, monto_notas_debito ON public.cuentas_cobrar
  FOR EACH ROW WHEN (COALESCE(OLD.monto_notas_credito,0) IS DISTINCT FROM COALESCE(NEW.monto_notas_credito,0)
                  OR COALESCE(OLD.monto_notas_debito,0)  IS DISTINCT FROM COALESCE(NEW.monto_notas_debito,0))
  EXECUTE FUNCTION public.trg_cxc_ajustar_cuotas();
DROP TRIGGER IF EXISTS trg_cxp_ajustar_cuotas ON public.cuentas_pagar;
CREATE TRIGGER trg_cxp_ajustar_cuotas AFTER UPDATE OF monto_notas_credito, monto_notas_debito ON public.cuentas_pagar
  FOR EACH ROW WHEN (COALESCE(OLD.monto_notas_credito,0) IS DISTINCT FROM COALESCE(NEW.monto_notas_credito,0)
                  OR COALESCE(OLD.monto_notas_debito,0)  IS DISTINCT FROM COALESCE(NEW.monto_notas_debito,0))
  EXECUTE FUNCTION public.trg_cxp_ajustar_cuotas();

-- Corrección de lo existente (solo documentos no anulados que tienen notas)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.cuentas_cobrar WHERE estado <> 'anulado' AND (COALESCE(monto_notas_credito,0) <> 0 OR COALESCE(monto_notas_debito,0) <> 0) LOOP
    PERFORM public.fn_ajustar_cuotas_cxc(r.id);
  END LOOP;
  FOR r IN SELECT id FROM public.cuentas_pagar WHERE estado <> 'anulado' AND (COALESCE(monto_notas_credito,0) <> 0 OR COALESCE(monto_notas_debito,0) <> 0) LOOP
    PERFORM public.fn_ajustar_cuotas_cxp(r.id);
  END LOOP;
END $$;

COMMIT;

-- ── 3) VERIFICACIÓN: vuelve a correr el paso 1 → solo deben quedar documentos
--      SIN notas (descuadres de otro origen) o ninguno.
