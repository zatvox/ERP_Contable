-- ============================================================================
-- 39_SEED_BANCOS_APERTURA.SQL
-- ============================================================================
-- Da de alta las 4 cuentas bancarias que YA tienen saldo en el asiento de
-- apertura AP-2026-001 (07_apertura_asiento_julio2026.sql, "SALDOS AL
-- 30/06/2026"), con el mismo saldo, la misma fecha de corte, y enlazadas a
-- su cuenta específica del plan de cuentas (no al código genérico del grupo).
--
-- ⚠ REVISA ANTES DE EJECUTAR:
--   - BCP CC MN (soles) y BCP CC ME (dólares) tienen su número de cuenta real
--     (confirmado: 191-7078530-0-01 y 191-7078532-1-31).
--   - BANCO DE LA NACIÓN y CUENTA TRANSITORIA BCP NO tienen número de cuenta
--     conocido todavía — quedan con un placeholder '(pendiente)'. Complétalo
--     editando la cuenta desde Bancos → Editar antes de operar con ella, o
--     dime el número y te lo dejo aquí directo.
--   - Si "CUENTA TRANSITORIA BCP" es en realidad una cuenta puente contable
--     (no un banco físico donde se puedan registrar movimientos reales),
--     dímelo y la saco de este script — no tiene sentido tratarla como una
--     cuenta bancaria operativa en Tesorería.
--
-- Idempotente por numero_cuenta (no vuelve a insertar si ya existe).
-- ============================================================================

BEGIN;

INSERT INTO public.bancos (
  nombre, banco, numero_cuenta, cci, tipo_cuenta, moneda,
  saldo_inicial, saldo_actual, saldo_inicial_fecha,
  cuenta_contable_id, cuenta_contable_codigo, activo
)
SELECT 'BCP Soles', 'BCP', '191-7078530-0-01', NULL, 'corriente', 'PEN',
       121547.29, 121547.29, '2026-06-30',
       pc.id, pc.codigo, true
FROM public.plan_cuentas pc WHERE pc.codigo = '1041120'
AND NOT EXISTS (SELECT 1 FROM public.bancos WHERE numero_cuenta = '191-7078530-0-01');

INSERT INTO public.bancos (
  nombre, banco, numero_cuenta, cci, tipo_cuenta, moneda,
  saldo_inicial, saldo_actual, saldo_inicial_fecha,
  cuenta_contable_id, cuenta_contable_codigo, activo
)
SELECT 'BCP Dólares', 'BCP', '191-7078532-1-31', NULL, 'corriente', 'USD',
       309425.98, 309425.98, '2026-06-30',
       pc.id, pc.codigo, true
FROM public.plan_cuentas pc WHERE pc.codigo = '1041121'
AND NOT EXISTS (SELECT 1 FROM public.bancos WHERE numero_cuenta = '191-7078532-1-31');

INSERT INTO public.bancos (
  nombre, banco, numero_cuenta, cci, tipo_cuenta, moneda,
  saldo_inicial, saldo_actual, saldo_inicial_fecha,
  cuenta_contable_id, cuenta_contable_codigo, activo
)
SELECT 'Banco de la Nación', 'Banco de la Nación', '(pendiente)', NULL, 'corriente', 'PEN',
       55.40, 55.40, '2026-06-30',
       pc.id, pc.codigo, true
FROM public.plan_cuentas pc WHERE pc.codigo = '1041109'
AND NOT EXISTS (SELECT 1 FROM public.bancos WHERE nombre = 'Banco de la Nación');

INSERT INTO public.bancos (
  nombre, banco, numero_cuenta, cci, tipo_cuenta, moneda,
  saldo_inicial, saldo_actual, saldo_inicial_fecha,
  cuenta_contable_id, cuenta_contable_codigo, activo
)
SELECT 'Cuenta Transitoria BCP', 'BCP', '(pendiente)', NULL, 'corriente', 'PEN',
       19135.41, 19135.41, '2026-06-30',
       pc.id, pc.codigo, true
FROM public.plan_cuentas pc WHERE pc.codigo = '1041002'
AND NOT EXISTS (SELECT 1 FROM public.bancos WHERE nombre = 'Cuenta Transitoria BCP');

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
-- SELECT nombre, numero_cuenta, moneda, saldo_inicial, saldo_inicial_fecha, cuenta_contable_codigo FROM public.bancos ORDER BY id;
