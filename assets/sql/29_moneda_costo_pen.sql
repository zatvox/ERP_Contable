-- ============================================================================
-- 29_moneda_costo_pen.sql
-- Problema: en compras.js, el precio_unitario que se guarda en
-- lotes.costo_unitario / kardex.costo_unitario NUNCA se multiplica por el
-- tipo_cambio de la compra. Si la compra fue en USD, ese "costo_unitario"
-- queda literalmente en dólares, pero la UI (Kardex Valorizado, reportes,
-- etc.) lo muestra con prefijo "S/" como si ya estuviera en soles. Esto
-- rompe el costo promedio ponderado si mezclas lotes comprados en USD y PEN
-- del mismo item.
--
-- Solución: 4 columnas nuevas en lotes y kardex para dejar trazabilidad
-- completa de la conversión:
--   moneda               -> moneda original del documento de compra (PEN/USD/EUR)
--   tipo_cambio           -> tipo de cambio usado (PEN = 1 siempre)
--   costo_unit_original   -> precio tal cual venía en el documento, en su moneda original
--   costo_unit_pen         -> costo_unit_original x tipo_cambio (SIEMPRE en soles)
--
-- costo_unitario / costo_total / saldo_valor (columnas existentes) pasan a
-- ser, de aquí en adelante, el valor YA CONVERTIDO a soles (= costo_unit_pen).
-- Esto es aditivo y no rompe nada existente: solo agrega columnas.
-- ============================================================================

-- 1) Columnas nuevas en lotes
ALTER TABLE public.lotes
  ADD COLUMN IF NOT EXISTS moneda varchar DEFAULT 'PEN' CHECK (moneda IN ('PEN','USD','EUR')),
  ADD COLUMN IF NOT EXISTS tipo_cambio numeric DEFAULT 1,
  ADD COLUMN IF NOT EXISTS costo_unit_original numeric,
  ADD COLUMN IF NOT EXISTS costo_unit_pen numeric;

COMMENT ON COLUMN public.lotes.moneda IS 'Moneda original del documento de compra que originó este lote (PEN/USD/EUR).';
COMMENT ON COLUMN public.lotes.tipo_cambio IS 'Tipo de cambio usado para convertir a soles. PEN = 1 siempre.';
COMMENT ON COLUMN public.lotes.costo_unit_original IS 'Costo unitario tal cual venía en el documento, en su moneda original.';
COMMENT ON COLUMN public.lotes.costo_unit_pen IS 'costo_unit_original x tipo_cambio. Siempre en soles. costo_unitario debe ser igual a este valor de aquí en adelante.';

-- 2) Columnas nuevas en kardex
ALTER TABLE public.kardex
  ADD COLUMN IF NOT EXISTS moneda varchar DEFAULT 'PEN' CHECK (moneda IN ('PEN','USD','EUR')),
  ADD COLUMN IF NOT EXISTS tipo_cambio numeric DEFAULT 1,
  ADD COLUMN IF NOT EXISTS costo_unit_original numeric,
  ADD COLUMN IF NOT EXISTS costo_unit_pen numeric;

COMMENT ON COLUMN public.kardex.moneda IS 'Moneda original del documento que originó el movimiento (PEN/USD/EUR). Heredada del lote en salidas/traslados.';
COMMENT ON COLUMN public.kardex.tipo_cambio IS 'Tipo de cambio usado para convertir a soles. PEN = 1 siempre.';
COMMENT ON COLUMN public.kardex.costo_unit_original IS 'Costo unitario tal cual venía en el documento origen, en su moneda original.';
COMMENT ON COLUMN public.kardex.costo_unit_pen IS 'costo_unit_original x tipo_cambio. Siempre en soles. costo_unitario debe ser igual a este valor de aquí en adelante.';

-- ============================================================================
-- 3) DIAGNÓSTICO (solo lectura) — cuántos lotes/kardex existentes fueron
-- comprados en USD, para dimensionar el impacto ANTES de decidir si se
-- corrige retroactivamente costo_unitario de esos lotes (que cambiaría
-- valorización histórica de inventario, igual de delicado que la corrección
-- de ventas que ya hicimos - no se ejecuta ninguna corrección todavía).
-- ============================================================================
SELECT l.id AS lote_id, l.numero_lote, l.costo_unitario AS costo_actual_sin_convertir,
       c.currency AS moneda_compra, c.tipo_cambio AS tipo_cambio_compra,
       ROUND(l.costo_unitario * COALESCE(c.tipo_cambio, 1), 4) AS costo_unit_pen_correcto,
       l.cantidad, l.compra_id, l.guia_id, l.fecha_ingreso
FROM public.lotes l
LEFT JOIN public.compras c ON c.id = l.compra_id
WHERE c.currency = 'USD'
ORDER BY l.fecha_ingreso;

-- Lo mismo para kardex (movimientos de entrada ligados a esas compras)
SELECT k.id AS kardex_id, k.lote_id, l.numero_lote, k.tipo_movimiento,
       k.costo_unitario AS costo_actual_sin_convertir,
       c.currency AS moneda_compra, c.tipo_cambio AS tipo_cambio_compra,
       ROUND(k.costo_unitario * COALESCE(c.tipo_cambio, 1), 4) AS costo_unit_pen_correcto,
       k.fecha, k.compra_id
FROM public.kardex k
JOIN public.lotes l ON l.id = k.lote_id
LEFT JOIN public.compras c ON c.id = k.compra_id
WHERE c.currency = 'USD'
ORDER BY k.fecha;

-- ============================================================================
-- 4) BACKFILL de las columnas nuevas (NO toca costo_unitario existente,
-- solo llena moneda/tipo_cambio/costo_unit_original/costo_unit_pen para que
-- quede la trazabilidad completa de lo histórico). Es idempotente.
-- ============================================================================
UPDATE public.lotes l
SET moneda = COALESCE(c.currency, 'PEN'),
    tipo_cambio = COALESCE(c.tipo_cambio, 1),
    costo_unit_original = l.costo_unitario,
    costo_unit_pen = ROUND(l.costo_unitario * COALESCE(c.tipo_cambio, 1), 4)
FROM public.compras c
WHERE l.compra_id = c.id;

-- Lotes sin compra_id (legacy / ajustes manuales): se asume que ya estaban en soles.
UPDATE public.lotes
SET moneda = 'PEN', tipo_cambio = 1,
    costo_unit_original = costo_unitario,
    costo_unit_pen = costo_unitario
WHERE compra_id IS NULL AND costo_unit_pen IS NULL;

UPDATE public.kardex k
SET moneda = COALESCE(c.currency, 'PEN'),
    tipo_cambio = COALESCE(c.tipo_cambio, 1),
    costo_unit_original = k.costo_unitario,
    costo_unit_pen = ROUND(k.costo_unitario * COALESCE(c.tipo_cambio, 1), 4)
FROM public.compras c
WHERE k.compra_id = c.id;

UPDATE public.kardex
SET moneda = 'PEN', tipo_cambio = 1,
    costo_unit_original = costo_unitario,
    costo_unit_pen = costo_unitario
WHERE compra_id IS NULL AND costo_unit_pen IS NULL;

-- ============================================================================
-- 5) PENDIENTE A DECIDIR (no incluido aquí, revisar el diagnóstico del punto 3
-- primero): si quieres corregir retroactivamente costo_unitario / costo_total
-- / saldo_valor de los lotes y kardex en USD para que reflejen el valor real
-- en soles (costo_unit_pen), eso es un UPDATE aparte, similar en riesgo a la
-- corrección de ventas que ya hicimos (afecta valorización histórica y hay
-- que revisar si esos lotes ya tuvieron salidas/ventas encadenadas antes de
-- tocar saldo_valor). Avísame cuando revises el diagnóstico y lo armamos.
-- ============================================================================
