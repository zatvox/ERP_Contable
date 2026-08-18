-- ============================================================================
-- 41_FIX_DIARIO_COMPRA_DUPLICADO.SQL
-- ============================================================================
-- 04_seed_data.sql insertó "Compra nacional mercadería" DOS veces: una vez
-- suelta (INSERT ... RETURNING id; sin capturar el id, líneas 227-229) y otra
-- dentro del bloque DO $$ que sí guarda el id y le crea sus 3 líneas
-- (601111/40111C/42111). Quedó un diario huérfano SIN líneas.
--
-- getDiarioByModelo()/aplicarModeloDiarioPorNombre() tomaban el PRIMERO que
-- encontraban (el huérfano), generando un asiento con 0 líneas y el error
-- "El asiento contable no tiene líneas" al intentar registrar la primera
-- compra doméstica de prueba (2026-08-15).
--
-- El código ya se corrigió para tolerar este caso (usa el primer diario CON
-- líneas, no el primero a secas), pero igual conviene limpiar el duplicado:
-- deja el plan de cuentas/diarios en el estado que debió tener desde el inicio.
--
-- Verificado antes de escribir este script: el diario huérfano (id más bajo
-- de los dos "Compra nacional mercadería") no tiene diario_lineas asociadas,
-- por lo que borrarlo no afecta ningún asiento ya generado (los asientos
-- contables no referencian `diarios`, solo usan tipo_movimiento/tipo_documento
-- como texto).
--
-- Idempotente: si ya no hay duplicados, no borra nada.
-- ============================================================================

BEGIN;

DELETE FROM public.diarios d
WHERE d.nombre = 'Compra nacional mercadería'
  AND d.tipo_movimiento = 'Compra'
  AND d.tipo_documento = '01'
  AND d.moneda = 'PEN'
  AND NOT EXISTS (SELECT 1 FROM public.diario_lineas dl WHERE dl.diario_id = d.id)
  AND EXISTS (
    -- Solo borra si queda al menos otro diario igual CON líneas (evita
    -- dejar la operación sin ningún diario configurado por error).
    SELECT 1 FROM public.diarios d2
    JOIN public.diario_lineas dl2 ON dl2.diario_id = d2.id
    WHERE d2.nombre = d.nombre AND d2.id <> d.id
  );

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
-- SELECT id, nombre, tipo_movimiento, tipo_documento, moneda FROM public.diarios WHERE nombre = 'Compra nacional mercadería';
-- Debe devolver una sola fila.
