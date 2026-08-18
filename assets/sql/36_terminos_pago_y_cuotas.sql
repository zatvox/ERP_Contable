-- ============================================================================
-- 36_TERMINOS_PAGO_Y_CUOTAS.SQL
-- ============================================================================
-- Etapa A del rediseño de Cuentas por Cobrar/Pagar.
--
-- PROBLEMA QUE RESUELVE
--   Hoy `cuentas_cobrar` tiene UNA sola `fecha_vencimiento`. Eso alcanza para
--   "contado" o "crédito 30", pero es imposible representar un 30/70 (30% al
--   emitir el comercial invoice, 70% al llegar el contenedor) ni un
--   30/45/60. Sin cronograma tampoco hay antigüedad de saldos real: si te
--   deben 100 con 30 vencido y 70 por vencer, el reporte hoy dice "100
--   vencido" o "100 por vencer", y ninguna de las dos es cierta.
--
-- DECISIÓN DE DISEÑO
--   Se agrega una tabla HIJA de cuotas. `cuentas_cobrar` sigue siendo EL
--   COMPROBANTE (uno por factura, con su serie y número); las cuotas son EL
--   CRONOGRAMA. Se descartó crear varias filas de `cuentas_cobrar` por venta
--   porque duplicaría `numero_comprobante`, rompería el Registro de Ventas y
--   descuadraría todo reporte que cuente documentos.
--
--   La migración es no destructiva: cada CxC/CxP existente genera UNA cuota
--   con su fecha y monto actuales. Todo sigue funcionando igual y, a partir
--   de ahí, quien quiera fracciona.
--
-- Idempotente: se puede correr varias veces.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1) CATÁLOGO DE TÉRMINOS DE PAGO
-- ────────────────────────────────────────────────────────────────────────────
-- Un término define CÓMO se fracciona el total, no fechas concretas: guarda
-- porcentajes y días, y las fechas se calculan al aplicarlo sobre una venta.
-- Así "Crédito 30/45/60" sirve igual para cualquier factura de cualquier mes.

CREATE TABLE IF NOT EXISTS public.terminos_pago (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre       varchar NOT NULL UNIQUE,
  descripcion  text,
  -- 'contado'  → una sola cuota a 0 días
  -- 'credito'  → una o más cuotas a X días de la fecha de emisión
  -- 'hito'     → las fechas NO dependen de la emisión sino de un evento
  --              (ej. importaciones: 30% al comercial invoice, 70% a la
  --              llegada del contenedor a Callao). Los días son estimados y
  --              se espera que el usuario ajuste la fecha real.
  tipo         varchar NOT NULL DEFAULT 'credito'
                 CHECK (tipo IN ('contado', 'credito', 'hito')),
  aplica_a     varchar NOT NULL DEFAULT 'ambos'
                 CHECK (aplica_a IN ('venta', 'compra', 'ambos')),
  activo       boolean NOT NULL DEFAULT true,
  orden        integer NOT NULL DEFAULT 0,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

COMMENT ON TABLE public.terminos_pago IS
  'Catálogo de condiciones de pago. Las cuotas concretas de cada documento viven en cuotas_cobrar/cuotas_pagar.';

CREATE TABLE IF NOT EXISTS public.terminos_pago_cuotas (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  termino_id   bigint NOT NULL REFERENCES public.terminos_pago(id) ON DELETE CASCADE,
  orden        integer NOT NULL,
  porcentaje   numeric NOT NULL CHECK (porcentaje > 0 AND porcentaje <= 100),
  dias         integer NOT NULL DEFAULT 0 CHECK (dias >= 0),
  -- Solo para tipo 'hito': describe el evento que dispara el vencimiento.
  hito         varchar,
  created_at   timestamptz DEFAULT now(),
  UNIQUE (termino_id, orden)
);

COMMENT ON COLUMN public.terminos_pago_cuotas.porcentaje IS
  'Porcentaje del total del documento. La suma de las cuotas de un término debe dar 100.';

CREATE INDEX IF NOT EXISTS idx_terminos_cuotas_termino ON public.terminos_pago_cuotas(termino_id);

-- ── Términos iniciales ──────────────────────────────────────────────────────
INSERT INTO public.terminos_pago (nombre, descripcion, tipo, aplica_a, orden) VALUES
  ('Contado',                'Pago al momento de la entrega.',                       'contado', 'ambos', 1),
  ('Crédito 30 días',        'Pago único a 30 días de la fecha de emisión.',         'credito', 'ambos', 2),
  ('Crédito 45 días',        'Pago único a 45 días de la fecha de emisión.',         'credito', 'ambos', 3),
  ('Crédito 60 días',        'Pago único a 60 días de la fecha de emisión.',         'credito', 'ambos', 4),
  ('Crédito 30/45',          'Dos cuotas iguales a 30 y 45 días.',                   'credito', 'ambos', 5),
  ('Crédito 30/60',          'Dos cuotas iguales a 30 y 60 días.',                   'credito', 'ambos', 6),
  ('Crédito 30/45/60',       'Tres cuotas iguales a 30, 45 y 60 días.',              'credito', 'ambos', 7),
  ('Importación 30/70',      '30% contra comercial invoice, 70% a la llegada del contenedor a Callao.', 'hito', 'compra', 8)
ON CONFLICT (nombre) DO NOTHING;

-- ── Cuotas de cada término ──────────────────────────────────────────────────
-- Se insertan por nombre para no depender de ids, y solo si el término aún no
-- tiene cuotas (así re-correr el script no las duplica).
DO $$
DECLARE
  v_id bigint;
BEGIN
  -- Contado
  SELECT id INTO v_id FROM public.terminos_pago WHERE nombre = 'Contado';
  IF v_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.terminos_pago_cuotas WHERE termino_id = v_id) THEN
    INSERT INTO public.terminos_pago_cuotas (termino_id, orden, porcentaje, dias) VALUES (v_id, 1, 100, 0);
  END IF;

  -- Crédito 30 / 45 / 60 (una sola cuota)
  SELECT id INTO v_id FROM public.terminos_pago WHERE nombre = 'Crédito 30 días';
  IF v_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.terminos_pago_cuotas WHERE termino_id = v_id) THEN
    INSERT INTO public.terminos_pago_cuotas (termino_id, orden, porcentaje, dias) VALUES (v_id, 1, 100, 30);
  END IF;

  SELECT id INTO v_id FROM public.terminos_pago WHERE nombre = 'Crédito 45 días';
  IF v_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.terminos_pago_cuotas WHERE termino_id = v_id) THEN
    INSERT INTO public.terminos_pago_cuotas (termino_id, orden, porcentaje, dias) VALUES (v_id, 1, 100, 45);
  END IF;

  SELECT id INTO v_id FROM public.terminos_pago WHERE nombre = 'Crédito 60 días';
  IF v_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.terminos_pago_cuotas WHERE termino_id = v_id) THEN
    INSERT INTO public.terminos_pago_cuotas (termino_id, orden, porcentaje, dias) VALUES (v_id, 1, 100, 60);
  END IF;

  -- Combinaciones: se reparte 50/50 y 33.34/33.33/33.33 para que sume 100
  -- exacto; el redondeo fino del importe lo ajusta la aplicación en la última
  -- cuota, para que la suma de cuotas sea siempre igual al total del documento.
  SELECT id INTO v_id FROM public.terminos_pago WHERE nombre = 'Crédito 30/45';
  IF v_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.terminos_pago_cuotas WHERE termino_id = v_id) THEN
    INSERT INTO public.terminos_pago_cuotas (termino_id, orden, porcentaje, dias) VALUES
      (v_id, 1, 50, 30), (v_id, 2, 50, 45);
  END IF;

  SELECT id INTO v_id FROM public.terminos_pago WHERE nombre = 'Crédito 30/60';
  IF v_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.terminos_pago_cuotas WHERE termino_id = v_id) THEN
    INSERT INTO public.terminos_pago_cuotas (termino_id, orden, porcentaje, dias) VALUES
      (v_id, 1, 50, 30), (v_id, 2, 50, 60);
  END IF;

  SELECT id INTO v_id FROM public.terminos_pago WHERE nombre = 'Crédito 30/45/60';
  IF v_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.terminos_pago_cuotas WHERE termino_id = v_id) THEN
    INSERT INTO public.terminos_pago_cuotas (termino_id, orden, porcentaje, dias) VALUES
      (v_id, 1, 33.34, 30), (v_id, 2, 33.33, 45), (v_id, 3, 33.33, 60);
  END IF;

  -- Importación 30/70: los días son una estimación (el hito real es la
  -- llegada del contenedor, que el usuario confirma después).
  SELECT id INTO v_id FROM public.terminos_pago WHERE nombre = 'Importación 30/70';
  IF v_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.terminos_pago_cuotas WHERE termino_id = v_id) THEN
    INSERT INTO public.terminos_pago_cuotas (termino_id, orden, porcentaje, dias, hito) VALUES
      (v_id, 1, 30, 0,  'Emisión del Comercial Invoice'),
      (v_id, 2, 70, 45, 'Llegada del contenedor a puerto Callao');
  END IF;
END $$;

ALTER TABLE public.terminos_pago        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.terminos_pago_cuotas ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'terminos_pago' AND policyname = 'terminos_pago_all') THEN
    CREATE POLICY terminos_pago_all ON public.terminos_pago FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'terminos_pago_cuotas' AND policyname = 'terminos_pago_cuotas_all') THEN
    CREATE POLICY terminos_pago_cuotas_all ON public.terminos_pago_cuotas FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) TÉRMINO SUGERIDO POR CLIENTE / PROVEEDOR
-- ────────────────────────────────────────────────────────────────────────────
-- Es solo una SUGERENCIA que precarga el selector en Nueva Venta. La condición
-- real se negocia por operación (un cliente con crédito 30 puede conseguir 90
-- para una venta puntual), así que la venta guarda su propio término y jamás
-- se reescribe la ficha del contacto desde una venta.

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS termino_pago_id bigint REFERENCES public.terminos_pago(id),
  ADD COLUMN IF NOT EXISTS linea_credito   numeric NOT NULL DEFAULT 0 CHECK (linea_credito >= 0),
  ADD COLUMN IF NOT EXISTS moneda_credito  varchar NOT NULL DEFAULT 'PEN';

COMMENT ON COLUMN public.contacts.termino_pago_id IS
  'Condición de pago habitual. Solo precarga el formulario; la venta guarda la suya.';
COMMENT ON COLUMN public.contacts.linea_credito IS
  'Tope de crédito. 0 = sin límite definido. El sistema AVISA al superarlo, no bloquea (configurable).';

-- ────────────────────────────────────────────────────────────────────────────
-- 3) TÉRMINO USADO EN CADA DOCUMENTO
-- ────────────────────────────────────────────────────────────────────────────
-- `cronograma_personalizado` existe para no ensuciar el catálogo: si el
-- gerente negocia un 37/64/83 puntual, NO se crea un término nuevo — se marca
-- la venta como personalizada y las fechas viven solo en sus cuotas. El
-- termino_pago_id queda como referencia de lo que se pactó de origen.

ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS termino_pago_id          bigint REFERENCES public.terminos_pago(id),
  ADD COLUMN IF NOT EXISTS cronograma_personalizado boolean NOT NULL DEFAULT false;

ALTER TABLE public.compras
  ADD COLUMN IF NOT EXISTS termino_pago_id          bigint REFERENCES public.terminos_pago(id),
  ADD COLUMN IF NOT EXISTS cronograma_personalizado boolean NOT NULL DEFAULT false;

ALTER TABLE public.cuentas_cobrar
  ADD COLUMN IF NOT EXISTS termino_pago_id          bigint REFERENCES public.terminos_pago(id),
  ADD COLUMN IF NOT EXISTS cronograma_personalizado boolean NOT NULL DEFAULT false;

ALTER TABLE public.cuentas_pagar
  ADD COLUMN IF NOT EXISTS termino_pago_id          bigint REFERENCES public.terminos_pago(id),
  ADD COLUMN IF NOT EXISTS cronograma_personalizado boolean NOT NULL DEFAULT false;

-- ────────────────────────────────────────────────────────────────────────────
-- 4) CUOTAS — el cronograma real de cada documento
-- ────────────────────────────────────────────────────────────────────────────
-- `monto_canjeado` se agrega desde ya (aunque las letras son la Etapa B)
-- porque forma parte de la fórmula del saldo y es mejor que el cálculo nazca
-- completo que tener que reescribirlo después en cinco sitios.

CREATE TABLE IF NOT EXISTS public.cuotas_cobrar (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cxc_id            bigint  NOT NULL REFERENCES public.cuentas_cobrar(id) ON DELETE CASCADE,
  numero_cuota      integer NOT NULL,
  fecha_vencimiento date    NOT NULL,
  monto             numeric NOT NULL CHECK (monto > 0),
  monto_cobrado     numeric NOT NULL DEFAULT 0 CHECK (monto_cobrado >= 0),
  monto_retenido    numeric NOT NULL DEFAULT 0 CHECK (monto_retenido >= 0),
  monto_canjeado    numeric NOT NULL DEFAULT 0 CHECK (monto_canjeado >= 0),
  estado            varchar NOT NULL DEFAULT 'pendiente'
                      CHECK (estado IN ('pendiente', 'parcial', 'cobrado', 'canjeado', 'anulado')),
  -- Copiado del término al generar el cronograma; sirve para mostrar
  -- "70% - Llegada del contenedor" en el listado sin volver a cruzar tablas.
  hito              varchar,
  observaciones     text,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  UNIQUE (cxc_id, numero_cuota)
);

COMMENT ON TABLE public.cuotas_cobrar IS
  'Cronograma de una cuenta por cobrar. Saldo de la cuota = monto − cobrado − retenido − canjeado.';

CREATE INDEX IF NOT EXISTS idx_cuotas_cobrar_cxc    ON public.cuotas_cobrar(cxc_id);
CREATE INDEX IF NOT EXISTS idx_cuotas_cobrar_venc   ON public.cuotas_cobrar(fecha_vencimiento);
CREATE INDEX IF NOT EXISTS idx_cuotas_cobrar_estado ON public.cuotas_cobrar(estado);

CREATE TABLE IF NOT EXISTS public.cuotas_pagar (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cxp_id            bigint  NOT NULL REFERENCES public.cuentas_pagar(id) ON DELETE CASCADE,
  numero_cuota      integer NOT NULL,
  fecha_vencimiento date    NOT NULL,
  monto             numeric NOT NULL CHECK (monto > 0),
  monto_pagado      numeric NOT NULL DEFAULT 0 CHECK (monto_pagado >= 0),
  monto_canjeado    numeric NOT NULL DEFAULT 0 CHECK (monto_canjeado >= 0),
  estado            varchar NOT NULL DEFAULT 'pendiente'
                      CHECK (estado IN ('pendiente', 'parcial', 'pagado', 'canjeado', 'anulado')),
  hito              varchar,
  observaciones     text,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  UNIQUE (cxp_id, numero_cuota)
);

CREATE INDEX IF NOT EXISTS idx_cuotas_pagar_cxp  ON public.cuotas_pagar(cxp_id);
CREATE INDEX IF NOT EXISTS idx_cuotas_pagar_venc ON public.cuotas_pagar(fecha_vencimiento);

ALTER TABLE public.cuotas_cobrar ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cuotas_pagar  ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cuotas_cobrar' AND policyname = 'cuotas_cobrar_all') THEN
    CREATE POLICY cuotas_cobrar_all ON public.cuotas_cobrar FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cuotas_pagar' AND policyname = 'cuotas_pagar_all') THEN
    CREATE POLICY cuotas_pagar_all ON public.cuotas_pagar FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5) COBROS Y PAGOS APUNTAN A LA CUOTA
-- ────────────────────────────────────────────────────────────────────────────
-- Nullable a propósito: los cobros históricos no tienen cuota, y un cobro
-- puede seguir aplicándose "a la cuenta" cuando el cliente paga sin decir a
-- qué cuota imputarlo (la aplicación lo reparte de la más antigua a la más
-- reciente, que es la práctica estándar de cobranza).

ALTER TABLE public.cobros
  ADD COLUMN IF NOT EXISTS cuota_id bigint REFERENCES public.cuotas_cobrar(id);

ALTER TABLE public.pagos_proveedores
  ADD COLUMN IF NOT EXISTS cuota_id bigint REFERENCES public.cuotas_pagar(id);

CREATE INDEX IF NOT EXISTS idx_cobros_cuota ON public.cobros(cuota_id);
CREATE INDEX IF NOT EXISTS idx_pagos_cuota  ON public.pagos_proveedores(cuota_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 6) CANJE POR LETRAS — se prepara el campo (la lógica es la Etapa B)
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.cuentas_cobrar
  ADD COLUMN IF NOT EXISTS monto_canjeado numeric NOT NULL DEFAULT 0 CHECK (monto_canjeado >= 0);

ALTER TABLE public.cuentas_pagar
  ADD COLUMN IF NOT EXISTS monto_canjeado numeric NOT NULL DEFAULT 0 CHECK (monto_canjeado >= 0);

COMMENT ON COLUMN public.cuentas_cobrar.monto_canjeado IS
  'Importe reemplazado por letras de cambio. La deuda no desaparece: se muda de 121 (facturas) a 123 (letras). Saldo = total + ND − NC − cobrado − retenido − canjeado.';

-- ────────────────────────────────────────────────────────────────────────────
-- 7) BACKFILL — una cuota por cada documento existente
-- ────────────────────────────────────────────────────────────────────────────
-- Migración no destructiva: se conserva el vencimiento actual. Si la CxC no
-- tenía fecha (muchos documentos históricos de la migración de Odoo), se usa
-- la fecha de emisión, de modo que la antigüedad refleje la realidad —
-- una deuda de 2025 sin vencimiento NO es "por vencer", está vencidísima.

INSERT INTO public.cuotas_cobrar (cxc_id, numero_cuota, fecha_vencimiento, monto, monto_cobrado, monto_retenido, estado, observaciones)
SELECT
  c.id, 1,
  COALESCE(c.fecha_vencimiento, c.fecha_emision, CURRENT_DATE),
  c.monto_total,
  LEAST(COALESCE(c.monto_cobrado, 0), c.monto_total),
  LEAST(COALESCE(c.monto_retenido, 0), c.monto_total),
  CASE
    WHEN c.estado = 'anulado' THEN 'anulado'
    WHEN COALESCE(c.monto_cobrado, 0) + COALESCE(c.monto_retenido, 0) >= c.monto_total - 0.01 THEN 'cobrado'
    WHEN COALESCE(c.monto_cobrado, 0) + COALESCE(c.monto_retenido, 0) > 0 THEN 'parcial'
    ELSE 'pendiente'
  END,
  CASE WHEN c.fecha_vencimiento IS NULL
       THEN 'Cuota generada en la migración: el documento no tenía fecha de vencimiento, se usó la de emisión.'
       ELSE NULL END
FROM public.cuentas_cobrar c
WHERE NOT EXISTS (SELECT 1 FROM public.cuotas_cobrar q WHERE q.cxc_id = c.id);

INSERT INTO public.cuotas_pagar (cxp_id, numero_cuota, fecha_vencimiento, monto, monto_pagado, estado, observaciones)
SELECT
  p.id, 1,
  COALESCE(p.fecha_vencimiento, p.fecha_emision, CURRENT_DATE),
  p.monto_total,
  LEAST(COALESCE(p.monto_pagado, 0), p.monto_total),
  CASE
    WHEN p.estado = 'anulado' THEN 'anulado'
    WHEN COALESCE(p.monto_pagado, 0) >= p.monto_total - 0.01 THEN 'pagado'
    WHEN COALESCE(p.monto_pagado, 0) > 0 THEN 'parcial'
    ELSE 'pendiente'
  END,
  CASE WHEN p.fecha_vencimiento IS NULL
       THEN 'Cuota generada en la migración: el documento no tenía fecha de vencimiento, se usó la de emisión.'
       ELSE NULL END
FROM public.cuentas_pagar p
WHERE NOT EXISTS (SELECT 1 FROM public.cuotas_pagar q WHERE q.cxp_id = p.id);

-- Rellenar la fecha de vencimiento del documento cuando estaba vacía, para
-- que la cabecera y su cuota digan lo mismo.
UPDATE public.cuentas_cobrar SET fecha_vencimiento = COALESCE(fecha_emision, CURRENT_DATE)
WHERE fecha_vencimiento IS NULL;

UPDATE public.cuentas_pagar SET fecha_vencimiento = COALESCE(fecha_emision, CURRENT_DATE)
WHERE fecha_vencimiento IS NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 8) VISTA DE ANTIGÜEDAD POR CUOTA
-- ────────────────────────────────────────────────────────────────────────────
-- El reporte de antigüedad se calcula sobre ESTA vista y no sobre la cabecera:
-- es lo que permite que un 30/70 aparezca partido en dos tramos distintos.

-- OJO: ya existía una `v_antiguedad_cxc` (script 12) que agrupaba POR CLIENTE
-- con columnas en formato pivote (corriente, vencido_1_30, ...). Esta nueva es
-- por CUOTA y con otras columnas, y `CREATE OR REPLACE VIEW` no permite
-- cambiar nombres ni orden de columnas — de ahí el error 42P16. Hay que
-- borrarla primero.
--
-- La vista vieja se conserva bajo otro nombre (`v_antiguedad_cxc_cliente`)
-- porque el resumen por cliente sigue siendo útil y hay reportes que podrían
-- estar apoyándose en ese formato pivote.
CREATE OR REPLACE VIEW public.v_antiguedad_cxc_cliente AS
SELECT
  c.nombre                                               AS cliente,
  SUM(cc.monto_total - COALESCE(cc.monto_cobrado, 0))    AS saldo_total,
  SUM(CASE WHEN cc.fecha_vencimiento IS NULL OR CURRENT_DATE <= cc.fecha_vencimiento
           THEN cc.monto_total - COALESCE(cc.monto_cobrado, 0) ELSE 0 END) AS corriente,
  SUM(CASE WHEN cc.fecha_vencimiento IS NOT NULL AND CURRENT_DATE - cc.fecha_vencimiento BETWEEN 1 AND 30
           THEN cc.monto_total - COALESCE(cc.monto_cobrado, 0) ELSE 0 END) AS vencido_1_30,
  SUM(CASE WHEN cc.fecha_vencimiento IS NOT NULL AND CURRENT_DATE - cc.fecha_vencimiento BETWEEN 31 AND 60
           THEN cc.monto_total - COALESCE(cc.monto_cobrado, 0) ELSE 0 END) AS vencido_31_60,
  SUM(CASE WHEN cc.fecha_vencimiento IS NOT NULL AND CURRENT_DATE - cc.fecha_vencimiento BETWEEN 61 AND 90
           THEN cc.monto_total - COALESCE(cc.monto_cobrado, 0) ELSE 0 END) AS vencido_61_90,
  SUM(CASE WHEN cc.fecha_vencimiento IS NOT NULL AND CURRENT_DATE - cc.fecha_vencimiento > 90
           THEN cc.monto_total - COALESCE(cc.monto_cobrado, 0) ELSE 0 END) AS vencido_mas_90
FROM public.cuentas_cobrar cc
JOIN public.contacts c ON c.id = cc.contact_id
WHERE cc.estado IN ('pendiente', 'parcial')
GROUP BY c.id, c.nombre;

COMMENT ON VIEW public.v_antiguedad_cxc_cliente IS
  'Antigüedad resumida POR CLIENTE (formato pivote). Antes se llamaba v_antiguedad_cxc; ese nombre ahora es el detalle por cuota.';

DROP VIEW IF EXISTS public.v_antiguedad_cxc CASCADE;

CREATE VIEW public.v_antiguedad_cxc AS
SELECT
  q.id                                        AS cuota_id,
  c.id                                        AS cxc_id,
  c.contact_id,
  ct.nombre                                   AS cliente,
  c.tipo_comprobante,
  c.serie,
  c.numero_comprobante,
  c.moneda,
  c.fecha_emision,
  q.numero_cuota,
  q.fecha_vencimiento,
  q.hito,
  q.monto                                     AS monto_cuota,
  q.monto_cobrado,
  q.monto_retenido,
  q.monto_canjeado,
  (q.monto - q.monto_cobrado - q.monto_retenido - q.monto_canjeado) AS saldo,
  q.estado,
  (CURRENT_DATE - q.fecha_vencimiento)        AS dias_vencido,
  CASE
    WHEN q.estado IN ('cobrado', 'canjeado', 'anulado')      THEN '5 · Sin saldo'
    WHEN q.fecha_vencimiento >= CURRENT_DATE                  THEN '0 · Por vencer'
    WHEN CURRENT_DATE - q.fecha_vencimiento <= 30             THEN '1 · 1-30 días'
    WHEN CURRENT_DATE - q.fecha_vencimiento <= 60             THEN '2 · 31-60 días'
    WHEN CURRENT_DATE - q.fecha_vencimiento <= 90             THEN '3 · 61-90 días'
    ELSE '4 · Más de 90 días'
  END                                         AS tramo
FROM public.cuotas_cobrar q
JOIN public.cuentas_cobrar c ON c.id = q.cxc_id
LEFT JOIN public.contacts  ct ON ct.id = c.contact_id
WHERE c.estado <> 'anulado';

COMMENT ON VIEW public.v_antiguedad_cxc IS
  'Antigüedad de saldos por CUOTA (no por documento). Base del reporte de Cuentas por Cobrar.';

-- Las vistas nuevas necesitan permiso explícito: los GRANT del script 00 solo
-- cubren los objetos que existían entonces.
GRANT SELECT ON public.v_antiguedad_cxc         TO authenticated;
GRANT SELECT ON public.v_antiguedad_cxc_cliente TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN — correr después
-- ════════════════════════════════════════════════════════════════════════════
-- 1) Términos cargados y sus cuotas:
-- SELECT t.nombre, t.tipo, c.orden, c.porcentaje, c.dias, c.hito
--   FROM public.terminos_pago t
--   LEFT JOIN public.terminos_pago_cuotas c ON c.termino_id = t.id
--  ORDER BY t.orden, c.orden;
--
-- 2) ¿Todas las CxC/CxP tienen su cuota?
-- SELECT 'cuentas_cobrar' AS tabla, COUNT(*) AS documentos,
--        (SELECT COUNT(*) FROM public.cuotas_cobrar) AS cuotas
--   FROM public.cuentas_cobrar
-- UNION ALL
-- SELECT 'cuentas_pagar', COUNT(*), (SELECT COUNT(*) FROM public.cuotas_pagar)
--   FROM public.cuentas_pagar;
--
-- 3) Antigüedad real de la cartera (esto reemplaza al reporte actual):
-- SELECT tramo, moneda, COUNT(*) AS cuotas, SUM(saldo) AS saldo
--   FROM public.v_antiguedad_cxc
--  WHERE saldo > 0.01
--  GROUP BY tramo, moneda
--  ORDER BY tramo, moneda;
--
-- 4) Cuántas cuotas se crearon SIN fecha de vencimiento original:
-- SELECT COUNT(*) FROM public.cuotas_cobrar WHERE observaciones IS NOT NULL;
