-- ============================================================================
-- 46_NOTA_CREDITO_DEVOLUCION_STOCK.SQL — Fase siguiente anunciada en
-- 45_fase2_despacho_bultos.sql ("devoluciones y NC quedan para la siguiente
-- fase"): Nota de Crédito de venta con devolución física de mercadería.
-- ============================================================================
-- Contexto (decidido con el usuario):
--   Hoy la NC (ventas.js:_abrirNotaVenta) es solo un ajuste monetario global
--   sobre la venta origen — no sabe qué ítem/cantidad/lote se devolvió, ni
--   valida si la venta fue despachada, ni toca Kardex/lotes/bultos.
--
--   Caso real: factura 100% despachada, cliente devuelve PARTE de los ítems
--   (cajas de peso variable). La NC debe cubrir esa parte del monto (el
--   cliente paga solo la diferencia — la fórmula de saldo de cuentas_cobrar
--   ya soporta esto sin cambios: saldo = total + ND − NC − cobrado − retenido)
--   Y ADEMÁS reingresar el stock devuelto.
--
-- Decisiones de diseño (confirmadas con el usuario):
--   1) Nueva tabla nota_credito_detalle: una fila por ítem/lote devuelto,
--      ligada a la fila de NC (ventas.id con tipo_comprobante='07') y a la
--      venta origen + su detalle_venta_id. Sirve tanto para productos con
--      peso variable (bultos) como sin él — para bultos, cada fila apunta al
--      BULTO NUEVO creado al reingresar (ver punto 3).
--   2) La NC solo exige seleccionar bultos/cantidad a reingresar cuando la
--      venta SÍ tiene guía de despacho (algo realmente salió). Si no hay
--      guía, la devolución es un ajuste de la venta — nunca salió mercadería,
--      no hay nada que reingresar a Kardex.
--   3) Reingreso de bultos: NO se reactiva el bulto vendido tal cual (ese
--      registro es el historial de LA venta que se está corrigiendo). Se seguía
--      ya el patrón previsto desde 43_lote_bultos.sql: el bulto vendido pasa a
--      estado='devuelto_cliente' (cierra su ciclo, con nota_credito_venta_id
--      apuntando a esta NC) y se crea un BULTO NUEVO en estado='disponible'
--      con bulto_origen_id -> el bulto vendido, para permitir repesar en
--      recepción (una devolución casi nunca pesa exactamente igual que la
--      venta original) sin perder trazabilidad. lote_bultos ya tenía TODAS
--      las columnas necesarias para esto desde la Fase 1 (nota_credito_
--      venta_id, bulto_origen_id) — no se modifica lote_bultos aquí.
--
-- Alcance: solo la tabla de detalle de NC + RLS. La función de reingreso de
-- bultos (JS) y la UI del modal de NC se implementan aparte en
-- supabase-data.js / ventas.js / notas.js.
--
-- Idempotente.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.nota_credito_detalle (
  id                    bigserial   PRIMARY KEY,
  -- Fila de la NC misma: una venta con tipo_comprobante='07' y
  -- venta_referencia_id = venta_origen_id.
  nota_venta_id         bigint      NOT NULL REFERENCES public.ventas(id) ON DELETE CASCADE,
  venta_origen_id       bigint      NOT NULL REFERENCES public.ventas(id),
  detalle_venta_id      bigint      REFERENCES public.detalle_ventas(id) ON DELETE SET NULL,
  item_id               bigint      NOT NULL REFERENCES public.items(id),
  lote_id               bigint      REFERENCES public.lotes(id) ON DELETE SET NULL,
  cantidad              numeric     NOT NULL CHECK (cantidad > 0),
  unidad_medida         varchar,
  -- Solo aplica a productos con peso variable: el bulto NUEVO (repesado) que
  -- quedó 'disponible' en Inventario tras esta devolución. NULL si el
  -- producto no maneja bultos, o si reingresa_stock=false.
  lote_bulto_nuevo_id   bigint      REFERENCES public.lote_bultos(id) ON DELETE SET NULL,
  -- false cuando la venta origen NO tenía guía de despacho: la NC es un
  -- ajuste monetario puro porque nunca salió mercadería físicamente.
  reingresa_stock       boolean     NOT NULL DEFAULT false,
  created_by            bigint      REFERENCES public.users(id),
  created_at            timestamptz DEFAULT now()
);

COMMENT ON TABLE public.nota_credito_detalle IS
  'Detalle por ítem/lote de una Nota de Crédito de venta (devolución). Una fila por producto devuelto en una NC. Para productos con peso variable, lote_bulto_nuevo_id apunta al bulto repesado creado en Inventario (estado=disponible, bulto_origen_id -> el bulto vendido que ahora queda estado=devuelto_cliente).';
COMMENT ON COLUMN public.nota_credito_detalle.reingresa_stock IS
  'false si la venta origen no tenía guía de despacho (nunca salió mercadería): la NC es solo un ajuste monetario, sin efecto en Kardex/lotes/bultos.';

CREATE INDEX IF NOT EXISTS idx_ncd_nota_venta   ON public.nota_credito_detalle(nota_venta_id);
CREATE INDEX IF NOT EXISTS idx_ncd_venta_origen ON public.nota_credito_detalle(venta_origen_id);
CREATE INDEX IF NOT EXISTS idx_ncd_detalle_venta ON public.nota_credito_detalle(detalle_venta_id);
CREATE INDEX IF NOT EXISTS idx_ncd_lote          ON public.nota_credito_detalle(lote_id);

ALTER TABLE public.nota_credito_detalle ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nota_credito_detalle_select_auth ON public.nota_credito_detalle;
DROP POLICY IF EXISTS nota_credito_detalle_insert_auth ON public.nota_credito_detalle;
DROP POLICY IF EXISTS nota_credito_detalle_update_auth ON public.nota_credito_detalle;
DROP POLICY IF EXISTS nota_credito_detalle_delete_auth ON public.nota_credito_detalle;

CREATE POLICY nota_credito_detalle_select_auth ON public.nota_credito_detalle FOR SELECT TO authenticated USING (true);
CREATE POLICY nota_credito_detalle_insert_auth ON public.nota_credito_detalle FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY nota_credito_detalle_update_auth ON public.nota_credito_detalle FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY nota_credito_detalle_delete_auth ON public.nota_credito_detalle FOR DELETE TO authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.nota_credito_detalle TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'nota_credito_detalle' ORDER BY ordinal_position;
-- SELECT polname FROM pg_policies WHERE tablename = 'nota_credito_detalle';
