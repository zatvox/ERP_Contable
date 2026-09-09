-- ============================================================================
-- 55_ANTICIPOS_PROVEEDOR_CLIENTE.SQL — Soporte de anticipos (100% o parciales)
-- tanto a proveedores (Compras) como de clientes (Ventas).
-- ============================================================================
-- Contexto (caso real: factura FFFI-00000185 de BENJI BILLION E.I.R.L.,
-- anticipo del 100% por Spun 20/1 RW en proceso de importación, referenciada
-- luego en la factura FFFI-00000192 que sí trae el detalle de mercadería):
--
-- Por el Art. 5 del Reglamento de Comprobantes de Pago, el pago anticipado
-- (total o parcial) de una compra/venta obliga a emitir el comprobante en ese
-- momento, ANTES de que exista mercadería que recibir/despachar. Esa factura
-- de anticipo:
--   * SÍ es una compra/venta real para SUNAT (Registro de Compras/Ventas,
--     IGV, CxP/CxC) — por eso sigue viviendo en `compras`/`ventas`.
--   * NO tiene mercadería real detrás todavía — por eso NO debe aparecer en
--     los selectores de "Nueva Guía de Ingreso" / "Nueva Guía de Despacho".
--   * Más adelante se "aplica" contra la factura real (con productos),
--     reduciendo el saldo por pagar/cobrar de esa factura — SIN tocar el
--     monto de la operación en sí (compras.total/ventas.total deben seguir
--     reflejando el monto real facturado a SUNAT, nunca lo que falta pagar).
--
-- Decisiones confirmadas con Luis (2026-09-07):
--   1) Un solo modal de registro por módulo, con selector de Tipo
--      (Compras: Mercadería/Servicio/Anticipo — Ventas: Mercadería/Anticipo)
--      que cambia la sección de detalle. NUNCA se mezclan líneas de producto
--      y líneas libres en un mismo comprobante.
--   2) La aplicación del anticipo es un DESCUENTO APARTE en Cuentas por
--      Pagar/Cobrar (mismo patrón que ya usan las Notas de Crédito con
--      `monto_notas_credito`) — NO una línea negativa dentro de la tabla de
--      productos. Así `detalle_compras`/`detalle_ventas` quedan 100% reales
--      y todo lo que ya depende de esas tablas (Guía de Ingreso/Despacho,
--      reportes, kardex) sigue funcionando sin casos especiales.
--   3) Normalmente el mismo proveedor/cliente que recibe el anticipo es
--      quien factura/despacha la mercadería después. Si hay un intermediario
--      distinto, se maneja aparte manualmente (fuera de alcance por ahora).
--
-- Idempotente.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1) COMPRAS — tipo_compra ya es varchar libre (01_schema.sql lo documentaba
--    con 'mercaderia','servicio','activo_fijo','importacion'), así que 'anticipo'
--    no necesita ALTER, solo se documenta aquí. tipo_compra='anticipo' ya queda
--    excluido de "Nueva Guía de Ingreso" porque ese selector solo lista
--    tipo_compra='mercaderia' (ver _cargarComprasSelectGuia en compras.js).
-- ────────────────────────────────────────────────────────────────────────────

COMMENT ON COLUMN compras.tipo_compra IS
  'mercaderia | servicio | activo_fijo | importacion | anticipo. anticipo = factura de anticipo a proveedor (sin mercadería real todavía); nunca aparece en el selector de Nueva Guía de Ingreso.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2) VENTAS — SÍ necesita columna nueva: a diferencia de compras, ventas no
--    tenía ningún campo que distinguiera "venta de mercadería real" de otro
--    tipo de comprobante. estado_despacho por sí solo no alcanza (una Nota de
--    Crédito, tipo_comprobante 07/08, hereda 'pendiente' por defecto y por
--    eso aparecía por error en el selector de Guía de Despacho — bug corregido
--    aparte en ventas.js filtrando 07/08). El mismo problema se repetiría con
--    un anticipo si solo se mirara estado_despacho, así que se agrega la
--    columna explícita.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE ventas ADD COLUMN IF NOT EXISTS tipo_venta varchar NOT NULL DEFAULT 'mercaderia';

COMMENT ON COLUMN ventas.tipo_venta IS
  'mercaderia | anticipo. anticipo = factura/boleta de anticipo de cliente (sin mercadería real todavía); nunca debe aparecer en el selector de Nueva Guía de Despacho.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3) CUENTAS POR PAGAR / COBRAR — nueva columna monto_anticipo_aplicado,
--    mismo patrón que monto_notas_credito (migración 35). El saldo pendiente
--    pasa a ser: monto_total - monto_pagado - monto_notas_credito - monto_anticipo_aplicado.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE cuentas_pagar  ADD COLUMN IF NOT EXISTS monto_anticipo_aplicado numeric NOT NULL DEFAULT 0;
ALTER TABLE cuentas_cobrar ADD COLUMN IF NOT EXISTS monto_anticipo_aplicado numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN cuentas_pagar.monto_anticipo_aplicado IS
  'Suma de compras_anticipos_aplicados.monto_aplicado para esta CxP. Reduce el saldo pendiente igual que monto_notas_credito, sin tocar monto_total.';
COMMENT ON COLUMN cuentas_cobrar.monto_anticipo_aplicado IS
  'Suma de ventas_anticipos_aplicados.monto_aplicado para esta CxC. Reduce el saldo pendiente igual que monto_notas_credito, sin tocar monto_total.';

-- ────────────────────────────────────────────────────────────────────────────
-- 4) TABLAS DE APLICACIÓN — trazabilidad de qué factura de anticipo canceló
--    qué factura real, y por cuánto (permite aplicar un mismo anticipo
--    parcialmente a varias facturas, o varios anticipos a una sola).
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS compras_anticipos_aplicados (
  id                 bigserial PRIMARY KEY,
  compra_anticipo_id bigint NOT NULL REFERENCES compras(id) ON DELETE RESTRICT,
  compra_destino_id  bigint NOT NULL REFERENCES compras(id) ON DELETE RESTRICT,
  monto_aplicado     numeric NOT NULL CHECK (monto_aplicado > 0),
  moneda             varchar,
  tipo_cambio        numeric,
  created_by         bigint,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_caa_anticipo ON compras_anticipos_aplicados(compra_anticipo_id);
CREATE INDEX IF NOT EXISTS idx_caa_destino  ON compras_anticipos_aplicados(compra_destino_id);
COMMENT ON TABLE compras_anticipos_aplicados IS
  'Cada fila = "la factura de anticipo X canceló $Y de la factura real Z". Saldo disponible de un anticipo = compras.total del anticipo - SUM(monto_aplicado) de sus filas aquí.';

CREATE TABLE IF NOT EXISTS ventas_anticipos_aplicados (
  id                bigserial PRIMARY KEY,
  venta_anticipo_id bigint NOT NULL REFERENCES ventas(id) ON DELETE RESTRICT,
  venta_destino_id  bigint NOT NULL REFERENCES ventas(id) ON DELETE RESTRICT,
  monto_aplicado    numeric NOT NULL CHECK (monto_aplicado > 0),
  moneda            varchar,
  tipo_cambio       numeric,
  created_by        bigint,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vaa_anticipo ON ventas_anticipos_aplicados(venta_anticipo_id);
CREATE INDEX IF NOT EXISTS idx_vaa_destino  ON ventas_anticipos_aplicados(venta_destino_id);
COMMENT ON TABLE ventas_anticipos_aplicados IS
  'Espejo de compras_anticipos_aplicados, para anticipos de clientes.';

-- ────────────────────────────────────────────────────────────────────────────
-- 5) RLS — mismo criterio que el resto de tablas del ERP (ver
--    project_pendiente_rls_testing_preproduccion en memoria: USING(true)
--    provisional hasta hacer el endurecimiento real). Ajustar si tus otras
--    tablas ya tienen políticas más finas.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE compras_anticipos_aplicados ENABLE ROW LEVEL SECURITY;
ALTER TABLE ventas_anticipos_aplicados  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS allow_all_caa ON compras_anticipos_aplicados;
CREATE POLICY allow_all_caa ON compras_anticipos_aplicados FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS allow_all_vaa ON ventas_anticipos_aplicados;
CREATE POLICY allow_all_vaa ON ventas_anticipos_aplicados FOR ALL USING (true) WITH CHECK (true);

COMMIT;

-- ============================================================================
-- TODO CONTABILIDAD (módulo en standby — NO codificar asientos todavía,
-- solo referencia para cuando se active):
--
-- Cuentas ya existentes en el plan (ver 06_apertura_plan_cuentas.sql /
-- 07_apertura_asiento_julio2026.sql):
--   - 281111 ANTICIPO DE MERCADERIA (existencias por recibir, lado compras)
--   - 422112 ANTICIPOS A PROVEEDORES ME (transitoria, lado compras)
-- Cuenta que FALTA crear en el plan cuando se active Contabilidad:
--   - Anticipos de CLIENTES (lado ventas): PCGE sugiere "1222 Anticipos de
--     Clientes" bajo "12 Cuentas por Cobrar Comerciales - Terceros"
--     (contra-cuenta, saldo acreedor). No existe todavía en el plan de
--     cuentas de este ERP — crearla antes de generar el primer asiento de
--     anticipo de venta.
--
-- Asiento 1 — al REGISTRAR la factura de anticipo (compra o venta):
--   Compras:  Debe 281111 (o 422112) + 40111 IGV / Haber Bancos o CxP
--   Ventas:   Debe Bancos o CxC / Haber 1222 Anticipos de Clientes + 40111 IGV
--
-- Asiento 2 — al APLICAR el anticipo contra la factura real (cuando se
-- registra `compras_anticipos_aplicados` / `ventas_anticipos_aplicados`):
--   Compras:  Debe 60/20 Mercaderías (ya cubierto por el asiento normal de la
--             factura real) / Haber 281111-422112 por el monto aplicado
--             (reclasifica el anticipo, YA NO es un asiento de pago nuevo).
--   Ventas:   Debe 1222 Anticipos de Clientes / Haber 70 Ventas (reclasifica).
--
-- Ambos asientos deben ir detrás del mismo candado de desarrollo que ya usan
-- generarAsientoGuiaRemision/generarAsientoPagoProveedor
-- (ASIENTOS_AUTO_COMPRAS_ACTIVO) — ver comentarios puntuales dejados en
-- compras.js/ventas.js en las funciones guardarCompraAnticipo,
-- _aplicarAnticiposSeleccionados, guardarVentaAnticipo y
-- _aplicarAnticiposVentaSeleccionados.
-- ============================================================================
