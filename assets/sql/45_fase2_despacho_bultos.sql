-- ============================================================================
-- 45_FASE2_DESPACHO_BULTOS.SQL — Fase 2: venta + guía de despacho con
-- selección de bultos (peso variable). Aprobado por el usuario:
--   1) Selección de bultos SOLO en Guía de Despacho (la venta sigue siendo
--      informativa, igual que hoy).
--   2) Corregir ahora el mismo patrón de FK sin ON DELETE que causó el bug
--      real en compras (ver 43_lote_bultos.sql / fix de _eliminarGuiaIngresoCore
--      en compras.js): un lote_id o detalle_id sin acción de borrado definida
--      bloquea el DELETE si algo todavía lo referencia, y si el código no
--      revisa el resultado, el error se traga en silencio.
--   3) Alcance: solo venta + despacho. Traslados de zona, devoluciones y NC
--      quedan para la siguiente fase — no se toca nada de eso aquí.
--
-- Qué hace este script:
--   A) detalle_ventas.lote_id -> lotes(id): pasa a ON DELETE SET NULL.
--      Antes no tenía acción (NO ACTION/RESTRICT): si alguna vez se intenta
--      borrar un lote que ya fue vendido, el borrado se rechaza en vez de
--      simplemente perder la referencia. SET NULL (no CASCADE) porque
--      borrar un lote NUNCA debe borrar el historial de venta.
--   B) detalle_guias_despacho_venta.lote_id -> lotes(id): mismo fix, mismo
--      motivo (no borrar el historial de despacho si el lote desaparece).
--   C) lote_bultos.detalle_venta_id -> detalle_ventas(id): ON DELETE SET NULL.
--      Defensivo: el código de reversión de la guía de despacho (Fase 2e)
--      debe limpiar esto explícitamente ANTES de borrar, pero si algo se
--      escapa, es preferible perder la referencia a que el bulto físico se
--      borre en cascada (el bulto sigue existiendo en el almacén aunque se
--      deshaga la venta) o que el borrado quede bloqueado.
--   D) lote_bultos.detalle_guia_despacho_id -> detalle_guias_despacho_venta(id):
--      mismo fix C, mismo motivo. Este es el que SÍ se dispara en la
--      práctica: al eliminar una guía de despacho, detalle_guias_despacho_
--      venta se borra en cascada (guia_id ya tiene ON DELETE CASCADE) — si
--      quedó algún lote_bultos apuntando a esa fila sin haberse revertido
--      antes, el cascade fallaría sin este SET NULL.
--
-- No se agregan tablas ni columnas nuevas: lote_bultos.detalle_venta_id y
-- detalle_guia_despacho_id ya existían desde 43_lote_bultos.sql, sin usarse
-- todavía (Fase 2 recién las empieza a llenar).
--
-- Idempotente: usa pg_constraint para encontrar el nombre real del FK
-- (nunca se nombraron explícitamente, Postgres les puso el nombre por
-- defecto) en vez de asumirlo, así que correrlo dos veces no falla.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_conname text;
BEGIN
  -- A) detalle_ventas.lote_id -> lotes(id)
  SELECT conname INTO v_conname FROM pg_constraint
    WHERE conrelid = 'public.detalle_ventas'::regclass
      AND confrelid = 'public.lotes'::regclass AND contype = 'f';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.detalle_ventas DROP CONSTRAINT %I', v_conname);
  END IF;
  ALTER TABLE public.detalle_ventas
    ADD CONSTRAINT detalle_ventas_lote_id_fkey
    FOREIGN KEY (lote_id) REFERENCES public.lotes(id) ON DELETE SET NULL;

  -- B) detalle_guias_despacho_venta.lote_id -> lotes(id)
  SELECT conname INTO v_conname FROM pg_constraint
    WHERE conrelid = 'public.detalle_guias_despacho_venta'::regclass
      AND confrelid = 'public.lotes'::regclass AND contype = 'f';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.detalle_guias_despacho_venta DROP CONSTRAINT %I', v_conname);
  END IF;
  ALTER TABLE public.detalle_guias_despacho_venta
    ADD CONSTRAINT detalle_guias_despacho_venta_lote_id_fkey
    FOREIGN KEY (lote_id) REFERENCES public.lotes(id) ON DELETE SET NULL;

  -- C) lote_bultos.detalle_venta_id -> detalle_ventas(id)
  SELECT conname INTO v_conname FROM pg_constraint
    WHERE conrelid = 'public.lote_bultos'::regclass
      AND confrelid = 'public.detalle_ventas'::regclass AND contype = 'f';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.lote_bultos DROP CONSTRAINT %I', v_conname);
  END IF;
  ALTER TABLE public.lote_bultos
    ADD CONSTRAINT lote_bultos_detalle_venta_id_fkey
    FOREIGN KEY (detalle_venta_id) REFERENCES public.detalle_ventas(id) ON DELETE SET NULL;

  -- D) lote_bultos.detalle_guia_despacho_id -> detalle_guias_despacho_venta(id)
  SELECT conname INTO v_conname FROM pg_constraint
    WHERE conrelid = 'public.lote_bultos'::regclass
      AND confrelid = 'public.detalle_guias_despacho_venta'::regclass AND contype = 'f';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.lote_bultos DROP CONSTRAINT %I', v_conname);
  END IF;
  ALTER TABLE public.lote_bultos
    ADD CONSTRAINT lote_bultos_detalle_guia_despacho_id_fkey
    FOREIGN KEY (detalle_guia_despacho_id) REFERENCES public.detalle_guias_despacho_venta(id) ON DELETE SET NULL;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
-- SELECT conname, confrelid::regclass, confdeltype
--   FROM pg_constraint
--   WHERE conrelid IN ('public.detalle_ventas'::regclass, 'public.detalle_guias_despacho_venta'::regclass, 'public.lote_bultos'::regclass)
--     AND contype = 'f';
-- confdeltype: 'a'=NO ACTION, 'n'=SET NULL, 'c'=CASCADE — deben quedar 4 filas en 'n'.
