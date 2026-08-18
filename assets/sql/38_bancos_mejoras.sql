-- ============================================================================
-- 38_BANCOS_MEJORAS.SQL
-- ============================================================================
-- El módulo de Bancos (Tesorería) quedó desactualizado frente al resto del
-- sistema en dos puntos concretos, encontrados al revisar el formulario
-- "Nueva Cuenta Bancaria":
--
-- 1) `bancos.cuenta_contable_id` YA EXISTÍA en el schema (FK a plan_cuentas)
--    pero el formulario nunca lo usaba — solo escribía el texto libre
--    `cuenta_contable_codigo`, sin validar contra el plan de cuentas real.
--    Con el Excel de apertura ya cargado (06_apertura_plan_cuentas.sql) hay
--    CUATRO cuentas de banco reales y específicas (1041002, 1041109, 1041120,
--    1041121), no una sola "10411" genérica — el texto libre no distinguía
--    entre ellas. Esto no necesita columna nueva, solo activar el selector
--    en el frontend (ver bancos.js/bancos.html).
--
-- 2) No existía dónde guardar la FECHA de corte del saldo inicial. Sin eso,
--    "saldo inicial" es ambiguo: ¿es de hoy? ¿del 1° del mes? La respuesta
--    correcta es que debe ser el mismo saldo y la misma fecha que ya declaró
--    el asiento de apertura AP-2026-001 (07_apertura_asiento_julio2026.sql,
--    "SALDOS AL 30/06/2026"). Se agrega `saldo_inicial_fecha` para dejar esa
--    fecha de corte explícita y evitar que alguien la reemplace por "hoy".
--
-- Idempotente.
-- ============================================================================

BEGIN;

ALTER TABLE public.bancos
  ADD COLUMN IF NOT EXISTS saldo_inicial_fecha date;

COMMENT ON COLUMN public.bancos.saldo_inicial_fecha IS
  'Fecha de corte del saldo_inicial (normalmente la misma del asiento de apertura contable, ej. 2026-06-30). NO es la fecha de creación del registro.';

-- Backfill: las 0 cuentas registradas hasta ahora vía UI (si las hay) no
-- tenían este dato — se deja NULL y el usuario lo completa al editar; no se
-- asume una fecha porque eso sería peor que dejarlo vacío.

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'bancos' ORDER BY ordinal_position;
