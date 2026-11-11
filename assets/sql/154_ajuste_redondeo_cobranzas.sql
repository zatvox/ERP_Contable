-- ============================================================================
-- 154_ajuste_redondeo_cobranzas.sql  (2026-11-10)
-- AJUSTE POR REDONDEO en el Cobro masivo / Cobro por recibo.
--
-- Caso: el cliente paga céntimos de más o de menos (ej. PEN 7,330.00 por una
-- factura de 7,329.95). Por debajo de una TOLERANCIA (⚙️ Configuración →
-- Cobranzas, por defecto S/ 1.00 · USD 0.30) el sistema deja cerrarlo como
-- ajuste en vez de saldo a favor / saldo pendiente.
--
-- CONTABILIDAD (para cuando se reactiven los asientos de Cobranzas):
--   • SOBRANTE (pagó de más) → OTROS INGRESOS DE GESTIÓN (7599 por defecto)
--       D 104x Bancos ........ recibido completo
--       H 121x CxC ............ saldo de la factura
--       H 7599 Otros ingresos . sobrante
--     Se guarda en cobros_lote.monto_ajuste (+), tipo_ajuste='redondeo_ingreso'.
--   • FALTANTE (pagó de menos) → OTROS GASTOS DE GESTIÓN (6599 por defecto)
--       D 104x Bancos ........ recibido
--       D 6599 Otros gastos .. faltante
--       H 121x CxC ............ saldo completo (la factura queda CANCELADA)
--     Se guarda como un cobro SIN banco, medio_pago='ajuste_redondeo', con
--     cuenta_ajuste (así el trigger de CxC lo suma y la factura cierra).
--   El banco SIEMPRE recibe el importe real del voucher (conciliación intacta).
--   Rastreo: vista v_ajustes_redondeo_cobranza (una fila por ajuste).
--
-- No borra nada. Corre todo el archivo.
-- ============================================================================

-- 1) Columnas
ALTER TABLE public.cobros_lote ADD COLUMN IF NOT EXISTS monto_ajuste  numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE public.cobros_lote ADD COLUMN IF NOT EXISTS tipo_ajuste   text;
ALTER TABLE public.cobros_lote ADD COLUMN IF NOT EXISTS cuenta_ajuste text;
ALTER TABLE public.cobros      ADD COLUMN IF NOT EXISTS cuenta_ajuste text;

ALTER TABLE public.cobros_lote DROP CONSTRAINT IF EXISTS cobros_lote_tipo_ajuste_check;
ALTER TABLE public.cobros_lote ADD CONSTRAINT cobros_lote_tipo_ajuste_check
  CHECK (tipo_ajuste IS NULL OR tipo_ajuste IN ('redondeo_ingreso', 'redondeo_gasto'));

COMMENT ON COLUMN public.cobros_lote.monto_ajuste  IS 'Sobrante del voucher llevado a otros ingresos por redondeo (SQL 154). Moneda = cobros_lote.moneda.';
COMMENT ON COLUMN public.cobros_lote.cuenta_ajuste IS 'Cuenta contable del ajuste (por defecto 7599 Otros ingresos de gestión).';
COMMENT ON COLUMN public.cobros.cuenta_ajuste      IS 'Solo medio_pago=ajuste_redondeo: cuenta del gasto (por defecto 6599 Otros gastos de gestión).';

-- 2) medio_pago: + ajuste_redondeo (se conserva lo del SQL 151)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.cobros'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%medio_pago%' LOOP
    EXECUTE format('ALTER TABLE public.cobros DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE public.cobros ADD CONSTRAINT cobros_medio_pago_check
  CHECK (medio_pago IN ('transferencia','cheque','efectivo','deposito','detraccion','yape_plin','saldo_favor','ajuste_redondeo','otro'));

-- 3) Rastreo: todos los ajustes por redondeo
CREATE OR REPLACE VIEW public.v_ajustes_redondeo_cobranza WITH (security_invoker = true) AS
  SELECT 'ingreso'::text AS tipo, l.empresa_id, l.contact_id, l.fecha, l.moneda,
         l.monto_ajuste AS monto, COALESCE(l.cuenta_ajuste, '7599') AS cuenta,
         l.numero_recibo, l.id AS lote_id, NULL::bigint AS cobro_id, NULL::bigint AS cxc_id,
         l.numero_operacion, l.banco_id
    FROM public.cobros_lote l
   WHERE l.tipo_ajuste = 'redondeo_ingreso' AND l.monto_ajuste <> 0
  UNION ALL
  SELECT 'gasto', c.empresa_id, c.contact_id, c.fecha, c.moneda,
         c.monto, COALESCE(c.cuenta_ajuste, '6599'),
         c.numero_recibo, c.lote_id, c.id, c.cxc_id,
         l.numero_operacion, l.banco_id
    FROM public.cobros c LEFT JOIN public.cobros_lote l ON l.id = c.lote_id
   WHERE c.medio_pago = 'ajuste_redondeo';

-- 4) VERIFICACIÓN: las 4 columnas deben dar 1
SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='cobros_lote' AND column_name='monto_ajuste') AS lote_monto_ajuste,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='cobros' AND column_name='cuenta_ajuste') AS cobros_cuenta_ajuste,
  (SELECT count(*) FROM pg_constraint WHERE conname='cobros_medio_pago_check' AND pg_get_constraintdef(oid) ILIKE '%ajuste_redondeo%') AS medio_ok,
  (SELECT count(*) FROM information_schema.views WHERE table_schema='public' AND table_name='v_ajustes_redondeo_cobranza') AS vista_ok;
