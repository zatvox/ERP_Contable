-- ============================================================================
-- 77_letras_abonos_refinanciacion.sql  (2026-10-07)
-- Letras: abonos (pagos totales/parciales) + refinanciación (renovar/unificar).
--
--  • letras_abonos: CADA pago de una letra (total, parcial en cartera, cobro
--    en banco con gastos, abono dentro de una renovación/unificación). Lleva
--    su N° de recibo de cobranza → junto con cobros.numero_recibo arma el
--    correlativo de recibos. Guarda su asiento y su movimiento bancario.
--  • letras_refinanciacion (+ _origen): una o varias letras con saldo se
--    cierran ('refinanciada') y nacen una o varias letras nuevas por el saldo
--    (− abono en el acto + interés de refinanciación).
--  • letras_cambio: estado 'parcial', monto_pagado, refinanciacion_id.
-- Requiere SQL 75. Idempotente.
-- ============================================================================
BEGIN;

-- 1) Estado 'parcial' y acumulado pagado ---------------------------------------
ALTER TABLE public.letras_cambio DROP CONSTRAINT IF EXISTS letras_cambio_estado_check;
ALTER TABLE public.letras_cambio ADD CONSTRAINT letras_cambio_estado_check
  CHECK (estado IN ('cartera','banco','cobranza','parcial','cobrada','protestada','refinanciada','anulada'));

ALTER TABLE public.letras_cambio
  ADD COLUMN IF NOT EXISTS monto_pagado numeric DEFAULT 0;

-- 2) Refinanciación (renovación = 1 origen; unificación = varios) --------------
CREATE TABLE IF NOT EXISTS public.letras_refinanciacion (
  id                 bigserial   PRIMARY KEY,
  tipo               varchar     NOT NULL CHECK (tipo IN ('emitida','recibida')),
  modalidad          varchar     NOT NULL DEFAULT 'unificacion' CHECK (modalidad IN ('renovacion','unificacion')),
  contact_id         bigint      NOT NULL REFERENCES public.contacts(id),
  fecha              date        NOT NULL,
  moneda             varchar     DEFAULT 'PEN',
  tipo_cambio        numeric,                 -- T.C. de las letras nuevas (promedio ponderado, editable)
  total_saldos       numeric     NOT NULL DEFAULT 0,  -- suma de saldos de las letras de origen
  monto_abono        numeric     NOT NULL DEFAULT 0,  -- amortización pagada en el acto
  interes_refin      numeric     NOT NULL DEFAULT 0,  -- interés sumado a las letras nuevas
  total_nuevas       numeric     NOT NULL DEFAULT 0,
  asiento_id         bigint      REFERENCES public.journal_entries(id),
  observaciones      text,
  created_by         bigint      REFERENCES public.users(id),
  created_at         timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.letras_refinanciacion_origen (
  id                 bigserial   PRIMARY KEY,
  refinanciacion_id  bigint      NOT NULL REFERENCES public.letras_refinanciacion(id) ON DELETE CASCADE,
  letra_id           bigint      NOT NULL REFERENCES public.letras_cambio(id),
  saldo              numeric     NOT NULL,     -- saldo que tenía al refinanciarse
  estado_previo      varchar     NOT NULL,     -- para deshacer
  monto_pagado_previo numeric    DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lro_refin ON public.letras_refinanciacion_origen(refinanciacion_id);
CREATE INDEX IF NOT EXISTS idx_lro_letra ON public.letras_refinanciacion_origen(letra_id);

ALTER TABLE public.letras_cambio
  ADD COLUMN IF NOT EXISTS refinanciacion_id bigint REFERENCES public.letras_refinanciacion(id);

-- 3) Abonos (todos los pagos de letras) ----------------------------------------
CREATE TABLE IF NOT EXISTS public.letras_abonos (
  id                  bigserial   PRIMARY KEY,
  letra_id            bigint      REFERENCES public.letras_cambio(id),          -- null si es el abono de una unificación
  refinanciacion_id   bigint      REFERENCES public.letras_refinanciacion(id) ON DELETE CASCADE,
  tipo                varchar     NOT NULL CHECK (tipo IN ('emitida','recibida')),
  contact_id          bigint      REFERENCES public.contacts(id),
  tipo_abono          varchar     NOT NULL CHECK (tipo_abono IN ('total','parcial','renovacion','unificacion')),
  ubicacion           varchar     NOT NULL DEFAULT 'cartera' CHECK (ubicacion IN ('cartera','banco')),
  medio               varchar,    -- transferencia | deposito | efectivo | cheque | banco_letra | yape_plin | otro
  fecha               date        NOT NULL,
  banco_id            integer     REFERENCES public.bancos(id),
  moneda              varchar     DEFAULT 'PEN',
  tipo_cambio         numeric,    -- T.C. del día del abono
  monto_amortizado    numeric     NOT NULL DEFAULT 0,  -- parte del capital de la letra
  interes             numeric     NOT NULL DEFAULT 0,  -- moratorio
  gasto_portes        numeric     NOT NULL DEFAULT 0,
  gasto_comision      numeric     NOT NULL DEFAULT 0,
  gasto_otros         numeric     NOT NULL DEFAULT 0,
  monto_neto          numeric,    -- lo que entró/salió del banco
  numero_operacion    varchar,
  numero_recibo       varchar,    -- recibo de cobranza (correlativo junto con cobros.numero_recibo)
  estado_previo       varchar,    -- estado de la letra antes del abono (para deshacer)
  asiento_id          bigint      REFERENCES public.journal_entries(id),
  movimiento_banco_id bigint      REFERENCES public.movimientos_banco(id) ON DELETE SET NULL,
  observaciones       text,
  created_by          bigint      REFERENCES public.users(id),
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now(),
  CONSTRAINT letras_abonos_destino_chk CHECK (letra_id IS NOT NULL OR refinanciacion_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_letras_abonos_letra  ON public.letras_abonos(letra_id);
CREATE INDEX IF NOT EXISTS idx_letras_abonos_recibo ON public.letras_abonos(numero_recibo);

COMMENT ON TABLE public.letras_abonos IS 'Pagos de letras (total/parcial/renovación/unificación). numero_recibo + cobros.numero_recibo = correlativo de recibos de cobranza.';

-- 4) RLS + grants (mismo patrón del módulo) ------------------------------------
ALTER TABLE public.letras_abonos                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.letras_refinanciacion        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.letras_refinanciacion_origen ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_all" ON public.letras_abonos;
DROP POLICY IF EXISTS "authenticated_all" ON public.letras_refinanciacion;
DROP POLICY IF EXISTS "authenticated_all" ON public.letras_refinanciacion_origen;
CREATE POLICY "authenticated_all" ON public.letras_abonos                FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.letras_refinanciacion        FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.letras_refinanciacion_origen FOR ALL TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.letras_abonos, public.letras_refinanciacion, public.letras_refinanciacion_origen TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.letras_abonos_id_seq, public.letras_refinanciacion_id_seq, public.letras_refinanciacion_origen_id_seq TO authenticated;

-- 5) Letras ya cobradas con el flujo anterior (sin abono) → 1 abono 'total' ----
INSERT INTO public.letras_abonos (letra_id, tipo, contact_id, tipo_abono, ubicacion, medio, fecha, banco_id, moneda,
  tipo_cambio, monto_amortizado, interes, gasto_portes, gasto_comision, gasto_otros, monto_neto,
  numero_operacion, numero_recibo, estado_previo, asiento_id, observaciones)
SELECT l.id, l.tipo, l.contact_id, 'total', 'banco', 'banco_letra',
       COALESCE(l.fecha_cobro, l.updated_at::date), l.banco_id, l.moneda, l.tipo_cambio, l.monto,
       COALESCE(l.interes_cobrado,0), COALESCE(l.gasto_portes,0), COALESCE(l.gasto_comision,0), COALESCE(l.gasto_otros,0),
       COALESCE(l.monto_neto, l.monto), l.numero_operacion, l.numero_recibo, 'banco', l.asiento_cobro_id,
       'Migrado (SQL 77) desde el cobro anterior'
FROM public.letras_cambio l
WHERE l.estado = 'cobrada'
  AND NOT EXISTS (SELECT 1 FROM public.letras_abonos a WHERE a.letra_id = l.id);

UPDATE public.letras_cambio SET monto_pagado = monto WHERE estado = 'cobrada' AND COALESCE(monto_pagado,0) = 0;

COMMIT;
