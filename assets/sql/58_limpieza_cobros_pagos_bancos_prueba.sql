-- ============================================================================
-- 58_limpieza_cobros_pagos_bancos_prueba.sql · 2026-09-30
-- Borra los datos de PRUEBA de Cobranzas y Bancos y deja todo como si nunca
-- se hubieran registrado. Revisado contra la BD real el 30/09:
--   · cobros:            1 fila  (id 1 → CxC 199 FFFI-00000260, USD 882.00)
--   · pagos_proveedores: 1 fila  (id 1 → CxP 161 F001-00040224, USD 6,199.25)
--   · movimientos_banco: 2 filas (id 1 ingreso 882 · id 2 egreso 6,199.25)
--   · journal_entries COBRO-1 / PAGO-1: ninguno (no se llegó a generar asiento)
--   · bancos:            2 cuentas (BCP Soles Jhiro, BCP Dólares Jhiro)
-- OJO: los "Pagado/Cobrado" parciales del resto de CxC/CxP NO son de este
-- módulo: vienen de la carga de apertura (10_apertura_cxc_cxp.sql) → no se tocan.
-- La CxP 190 (FFFI-00000192 BENJI) figura PAGADO por un ANTICIPO aplicado de
-- 20,007 — es un dato real, no se toca.
-- Cada UPDATE lleva guarda (valor esperado): si algo cambió, no toca nada.
-- ============================================================================
BEGIN;

-- 1) Revertir el cobro de prueba en la CxC y su cuota
UPDATE cuentas_cobrar SET monto_cobrado = 0, estado = 'pendiente', updated_at = now()
 WHERE id = 199 AND monto_cobrado = 882 AND monto_retenido = 0
   AND monto_canjeado = 0 AND monto_anticipo_aplicado = 0;
UPDATE cuotas_cobrar SET monto_cobrado = 0, estado = 'pendiente', updated_at = now()
 WHERE id = 62 AND cxc_id = 199 AND monto_cobrado = 882;

-- 2) Revertir el pago de prueba en la CxP (su cuota 155 ya estaba en 0)
UPDATE cuentas_pagar SET monto_pagado = 0, estado = 'pendiente', updated_at = now()
 WHERE id = 161 AND monto_pagado = 6199.25 AND monto_anticipo_aplicado = 0 AND monto_canjeado = 0;

-- 3) Movimientos bancarios, asientos (si hubiera), cobros y pagos
DELETE FROM movimientos_banco WHERE id IN (1, 2);
DELETE FROM journal_entries   WHERE documento_referencia IN ('COBRO-1', 'PAGO-1');
DELETE FROM cobros            WHERE id = 1;
DELETE FROM pagos_proveedores WHERE id = 1;

-- 4) Cuentas bancarias de prueba (si alguna otra tabla las referencia,
--    Postgres rechaza el DELETE y se deshace TODO el script: no queda a medias)
DELETE FROM bancos WHERE id IN (1, 2);

COMMIT;

-- ── VERIFICACIÓN: todo debe salir en 0 / pendiente ─────────────────────────
SELECT
  (SELECT COUNT(*) FROM cobros)            AS cobros,
  (SELECT COUNT(*) FROM pagos_proveedores) AS pagos,
  (SELECT COUNT(*) FROM movimientos_banco) AS movimientos_banco,
  (SELECT COUNT(*) FROM bancos)            AS bancos,
  (SELECT estado FROM cuentas_cobrar WHERE id = 199) AS cxc_199,
  (SELECT estado FROM cuentas_pagar  WHERE id = 161) AS cxp_161;
