-- ============================================================================
-- 33_retencion_y_cuentas_pagar.sql
--
-- Dos cosas independientes, juntas en un solo script porque se piden juntas:
--
-- PARTE 1) Retención IGV (Régimen de Retenciones, agente retenedor descuenta
--   3% del total al pagar y te da un "Comprobante de Retención" que luego se
--   usa para deducir ese monto de tu IGV por pagar del periodo). Se agregan
--   solo las columnas necesarias para los puntos 1 y 2 (aviso al facturar +
--   aplicar el neto al cobrar) — el 3% queda fijo en el código (constante
--   RETENCION_IGV_PCT), no en BD, porque es una tasa legal única que rara vez
--   cambia; lo que SÍ hay que guardar es el monto ya calculado en cada cobro
--   (foto histórica: si el % legal cambia en el futuro, los cobros viejos no
--   deben recalcularse solos).
--
-- PARTE 2) Corrige la asimetría Compras/Ventas: hoy, al registrar una VENTA
--   con comprobante 01 (factura), se crea automáticamente su fila en
--   cuentas_cobrar (ventas.js). Al registrar una COMPRA con comprobante 01,
--   NUNCA se crea su fila en cuentas_pagar (la tabla existe desde 01_schema.sql
--   pero ninguna función la escribe) — cobranzas.js terminó leyendo
--   directamente de `compras.estado_pago`/`compras.monto_pagado`, columnas que
--   además nunca se actualizan al pagar. Esta parte 2 solo agrega el backfill
--   histórico; la función addCuentaPagar() y el cambio en compras.js van en
--   código (no en SQL) — ver notas al final del script.
--
-- Las Guías (de Remisión / Despacho) NO tocan cuentas_cobrar ni cuentas_pagar
-- en ningún punto de este cambio — eso ya estaba correcto y se mantiene así:
-- ambas tablas se llenan únicamente al registrar el COMPROBANTE (factura),
-- nunca al mover stock.
-- ============================================================================


-- ── PARTE 1: Retención IGV ──────────────────────────────────────────────────

-- Monto de retención aplicado en ESTE cobro puntual (0 si el cliente no es
-- agente de retención o si el usuario no marcó "aplicar retención"). Es un
-- monto histórico congelado, no un porcentaje — por eso no se recalcula.
ALTER TABLE public.cobros
  ADD COLUMN IF NOT EXISTS monto_retencion numeric NOT NULL DEFAULT 0
    CHECK (monto_retencion >= 0);

-- N° del "Comprobante de Retención" (tipo doc '20') que el cliente te entrega
-- por esta retención — opcional, se completa cuando el cliente lo envía
-- (normalmente después del cobro, no en el momento). Sirve de base para el
-- reporte de deducción de IGV (UI en el punto 4, función aún en desarrollo).
ALTER TABLE public.cobros
  ADD COLUMN IF NOT EXISTS numero_comprobante_retencion varchar;

COMMENT ON COLUMN public.cobros.monto_retencion IS
  'Monto retenido por el cliente (agente de retención IGV) en este cobro puntual. 0 si no aplica. Histórico: no se recalcula si cambia la tasa legal.';
COMMENT ON COLUMN public.cobros.numero_comprobante_retencion IS
  'N° del Comprobante de Retención (tipo 20) que el cliente entrega por este monto retenido. Se completa cuando llega, no es obligatorio al momento del cobro.';

-- Total retenido acumulado de la CxC (denormalizado, mismo patrón que
-- monto_cobrado — se mantiene en sync desde código cada vez que se registra
-- un cobro con retención). Sin esto, saber "cuánto de esta factura ya quedó
-- cubierto por retenciones" obligaría a sumar cobros.monto_retencion en cada
-- pantalla en vez de leer un solo campo ya calculado.
ALTER TABLE public.cuentas_cobrar
  ADD COLUMN IF NOT EXISTS monto_retenido numeric NOT NULL DEFAULT 0
    CHECK (monto_retenido >= 0);

COMMENT ON COLUMN public.cuentas_cobrar.monto_retenido IS
  'Suma de cobros.monto_retencion aplicados a esta CxC. Junto con monto_cobrado determina si la CxC quedó saldada (monto_cobrado + monto_retenido >= monto_total).';


-- ── Corrección de bug encontrado de paso: pagos_proveedores.medio_pago no
-- incluía 'deposito' en su CHECK, pero el <select> de "Registrar Pago a
-- Proveedor" (cobranzas.html) sí ofrece la opción "Depósito" — elegirla
-- hacía fallar el INSERT en seco. Se alinea con el CHECK de cobros.medio_pago,
-- que sí la tiene.
ALTER TABLE public.pagos_proveedores DROP CONSTRAINT IF EXISTS pagos_proveedores_medio_pago_check;
ALTER TABLE public.pagos_proveedores
  ADD CONSTRAINT pagos_proveedores_medio_pago_check
  CHECK (medio_pago IN ('transferencia','cheque','efectivo','deposito','detraccion','otro'));


-- ── PARTE 2: cuentas_pagar — backfill histórico ─────────────────────────────
-- A partir de hoy, compras.js crea la fila en cuentas_pagar en el momento de
-- registrar la factura (código, no SQL). Este INSERT es el "ponerse al día"
-- de una sola vez para las compras que ya estaban cargadas ANTES de ese
-- cambio de código. Idempotente: si se corre dos veces no duplica (usa
-- NOT EXISTS sobre compra_id, que es la relación 1 a 1 real).
INSERT INTO public.cuentas_pagar (
  contact_id, compra_id, tipo_comprobante, serie, numero_comprobante,
  fecha_emision, fecha_vencimiento, moneda, tipo_cambio,
  monto_total, monto_pagado, estado, created_by
)
SELECT
  c.contact_id,
  c.id,
  c.tipo_comprobante,
  c.serie,
  c.numero,
  c.fecha_emision,
  NULL,                    -- compras nunca guardó fecha de vencimiento; queda editable a futuro
  COALESCE(c.currency, 'PEN'),
  COALESCE(c.tipo_cambio, 1),
  c.total,
  0,                        -- monto_pagado arranca en 0: compras.monto_pagado nunca se mantuvo al día,
                             -- no es una fuente confiable para heredar montos ya pagados
  CASE WHEN c.estado_pago = 'pagado' THEN 'pagado' ELSE 'pendiente' END,
  c.created_by
FROM public.compras c
WHERE c.tipo_comprobante = '01'   -- mismo criterio que ventas: solo factura genera CxC/CxP
  AND NOT EXISTS (
    SELECT 1 FROM public.cuentas_pagar cp WHERE cp.compra_id = c.id
  );

-- ── Verificación ─────────────────────────────────────────────────────────
SELECT count(*) AS compras_factura_total,
       (SELECT count(*) FROM public.cuentas_pagar) AS cuentas_pagar_total
FROM public.compras WHERE tipo_comprobante = '01';

-- ============================================================================
-- NOTA IMPORTANTE (no ejecuta nada acá, es para el desarrollador):
-- Si alguna compra tipo '01' tenía estado_pago = 'pagado' o 'parcial' de forma
-- confiable (verificado a mano, no solo el default 'pendiente' de siempre),
-- avísame el/los ID de compra y corrijo esa fila puntual con un UPDATE aparte
-- — el backfill de arriba, a propósito, no asume pagos históricos que no se
-- puedan verificar contra un pago real registrado en pagos_proveedores.
-- ============================================================================
