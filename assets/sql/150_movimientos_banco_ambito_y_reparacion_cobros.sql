-- ============================================================================
-- 150_movimientos_banco_ambito_y_reparacion_cobros.sql  (2026-11-09)
-- Desde Tesorería (SQL 123) movimientos_banco.ambito es NOT NULL y Cobranzas no
-- lo enviaba → desde el 03/11 los cobros se grabaron SIN su movimiento bancario
-- (el cobro sí; el saldo de la cuenta no subió). El JS ya quedó corregido
-- (addMovimientoBanco hereda ámbito/empresa de la cuenta).
--
-- Este script:
--   A. Red de seguridad en la BD: si un insert llega sin ámbito, lo toma de la
--      cuenta (sirve para Bancos, Importaciones y cualquier módulo futuro).
--   B. Crea los movimientos que faltan: cobros con cuenta y sin movimiento
--      (fuera de cobro masivo) + depósitos de cobro masivo sin movimiento.
--      Monto en la MONEDA DE LA CUENTA (USD↔PEN con el T.C. del cobro), igual
--      que hace el sistema. El saldo de cada cuenta lo actualiza el trigger
--      trg_actualizar_saldo_banco al insertar.
-- No toca cobros, CxC, cuotas ni letras. Idempotente (solo crea lo que falta).
-- ============================================================================

-- ── 1) VISTA PREVIA: cobros sin movimiento ───────────────────────────────────
SELECT c.id AS cobro, c.fecha, cc.serie || '-' || cc.numero_comprobante AS doc,
       COALESCE(to_jsonb(ct) ->> 'razon_social', ct.nombre) AS cliente,
       c.moneda AS mon_cobro, c.monto, b.nombre AS cuenta, b.moneda AS mon_cuenta,
       CASE WHEN b.moneda = c.moneda THEN c.monto
            WHEN c.moneda = 'USD' AND b.moneda = 'PEN' THEN round(c.monto * c.tipo_cambio, 2)
            WHEN c.moneda = 'PEN' AND b.moneda = 'USD' THEN round(c.monto / NULLIF(c.tipo_cambio, 0), 2)
            ELSE c.monto END AS monto_en_cuenta
FROM public.cobros c
JOIN public.bancos b           ON b.id = c.banco_id
LEFT JOIN public.cuentas_cobrar cc ON cc.id = c.cxc_id
LEFT JOIN public.contacts ct   ON ct.id = c.contact_id
WHERE c.lote_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.movimientos_banco m WHERE m.cobro_id = c.id)
ORDER BY c.fecha, c.id;

-- ── 2) VISTA PREVIA: depósitos de cobro masivo sin movimiento ────────────────
SELECT l.id AS lote, l.fecha, l.monto_recibido, l.moneda, b.nombre AS cuenta,
       (SELECT count(*) FROM public.cobros c WHERE c.lote_id = l.id) AS cobros_del_lote
FROM public.cobros_lote l JOIN public.bancos b ON b.id = l.banco_id
WHERE l.movimiento_banco_id IS NULL;

-- ── 3) RED DE SEGURIDAD + REPARACIÓN (bloque único) ──────────────────────────
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_movbanco_ambito_por_cuenta()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_amb varchar; v_emp integer;
BEGIN
  IF NEW.ambito IS NULL AND NEW.banco_id IS NOT NULL THEN
    SELECT COALESCE(ambito, CASE WHEN empresa_id IS NOT NULL THEN 'empresa' ELSE 'familiar' END), empresa_id
      INTO v_amb, v_emp FROM public.bancos WHERE id = NEW.banco_id;
    NEW.ambito := v_amb;
    IF v_amb = 'familiar' THEN NEW.empresa_id := NULL;
    ELSIF NEW.empresa_id IS NULL THEN NEW.empresa_id := v_emp; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_movbanco_ambito_por_cuenta ON public.movimientos_banco;
CREATE TRIGGER trg_movbanco_ambito_por_cuenta BEFORE INSERT ON public.movimientos_banco
  FOR EACH ROW EXECUTE FUNCTION public.fn_movbanco_ambito_por_cuenta();

-- B1. Cobros sueltos
INSERT INTO public.movimientos_banco
  (banco_id, fecha, tipo, concepto, categoria, referencia, numero_operacion, monto, reconciliado, cobro_id, ambito, empresa_id)
SELECT c.banco_id, c.fecha, 'ingreso',
       'Cobro ' || COALESCE(cc.tipo_comprobante || ' ', '') || COALESCE(cc.serie || '-', '') || COALESCE(cc.numero_comprobante, '')
         || ' — ' || COALESCE(to_jsonb(ct) ->> 'razon_social', ct.nombre, '')
         || CASE WHEN b.moneda <> c.moneda THEN ' (' || c.moneda || ' ' || to_char(c.monto, 'FM999G999G990D00') || ' × T.C. ' || c.tipo_cambio || ')' ELSE '' END
         || ' [reparado SQL 150]',
       'Cobranza clientes', c.referencia, COALESCE(c.numero_operacion, c.referencia),
       CASE WHEN b.moneda = c.moneda THEN c.monto
            WHEN c.moneda = 'USD' AND b.moneda = 'PEN' THEN round(c.monto * c.tipo_cambio, 2)
            WHEN c.moneda = 'PEN' AND b.moneda = 'USD' THEN round(c.monto / NULLIF(c.tipo_cambio, 0), 2)
            ELSE c.monto END,
       false, c.id,
       COALESCE(b.ambito, CASE WHEN b.empresa_id IS NOT NULL THEN 'empresa' ELSE 'familiar' END),
       CASE WHEN b.ambito = 'familiar' THEN NULL ELSE b.empresa_id END
FROM public.cobros c
JOIN public.bancos b           ON b.id = c.banco_id
LEFT JOIN public.cuentas_cobrar cc ON cc.id = c.cxc_id
LEFT JOIN public.contacts ct   ON ct.id = c.contact_id
WHERE c.lote_id IS NULL AND c.monto > 0
  AND NOT EXISTS (SELECT 1 FROM public.movimientos_banco m WHERE m.cobro_id = c.id)
ORDER BY c.fecha, c.id;

-- B2. Depósitos de cobro masivo (un movimiento por lote)
WITH nuevos AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, categoria, referencia, numero_operacion, monto, reconciliado, ambito, empresa_id)
  SELECT l.banco_id, l.fecha, 'ingreso',
         'Depósito ' || COALESCE(to_jsonb(ct) ->> 'razon_social', ct.nombre, '') || ' — cobro masivo L' || l.id
           || COALESCE(' Rec. ' || l.numero_recibo, '') || ' [reparado SQL 150]',
         'Cobranza clientes', COALESCE(l.numero_operacion, 'LOTE-COBRO ' || l.id), l.numero_operacion,
         l.monto_recibido, false,
         COALESCE(b.ambito, CASE WHEN b.empresa_id IS NOT NULL THEN 'empresa' ELSE 'familiar' END),
         CASE WHEN b.ambito = 'familiar' THEN NULL ELSE b.empresa_id END
  FROM public.cobros_lote l
  JOIN public.bancos b ON b.id = l.banco_id
  LEFT JOIN public.contacts ct ON ct.id = l.contact_id
  WHERE l.movimiento_banco_id IS NULL AND l.monto_recibido > 0
    AND EXISTS (SELECT 1 FROM public.cobros c WHERE c.lote_id = l.id)
  RETURNING id, referencia, fecha, banco_id, monto
)
UPDATE public.cobros_lote l SET movimiento_banco_id = n.id
FROM nuevos n
WHERE l.movimiento_banco_id IS NULL AND l.banco_id = n.banco_id AND l.fecha = n.fecha
  AND l.monto_recibido = n.monto AND COALESCE(l.numero_operacion, 'LOTE-COBRO ' || l.id) = n.referencia;

COMMIT;

-- ── 4) VERIFICACIÓN: las dos consultas deben dar 0 ───────────────────────────
SELECT 'cobros sin movimiento' AS que, count(*) FROM public.cobros c
 WHERE c.banco_id IS NOT NULL AND c.lote_id IS NULL AND c.monto > 0
   AND NOT EXISTS (SELECT 1 FROM public.movimientos_banco m WHERE m.cobro_id = c.id)
UNION ALL
SELECT 'lotes sin movimiento', count(*) FROM public.cobros_lote l
 WHERE l.movimiento_banco_id IS NULL AND EXISTS (SELECT 1 FROM public.cobros c WHERE c.lote_id = l.id);
