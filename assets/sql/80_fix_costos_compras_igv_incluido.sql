-- ============================================================================
-- 80 — Corrige costos inflados por compras registradas con "18% (IGV incluido)"
-- (2026-10-09)
-- ----------------------------------------------------------------------------
-- Problema: con IGV incluido, detalle_compras.precio_unitario se guardó CON IGV
-- (ej. 2.60) aunque subtotal/IGV/total salieron bien (55.08 + 9.92 = 65.00).
-- La Guía de Ingreso usa ese precio como costo → lote, kardex y costo de las
-- ventas quedaron inflados +18%. (El código ya quedó corregido: ahora se
-- guarda el precio SIN IGV y el costo del lote = subtotal / cantidad.)
--
-- Detección (línea con IGV incluido):
--   cantidad × precio_unitario ≈ total_linea   y   ≠ subtotal   (igv > 0)
-- Precio correcto = subtotal / cantidad (moneda de la compra).
-- Lotes: solo los de esa compra+producto cuyo costo sigue siendo exactamente
--   precio_con_IGV × T.C. (si el costo fue reajustado por costeo de
--   importación u otro proceso, NO se toca).
--
-- NO toca asientos contables (se revisarán en el módulo contable).
--
-- USO:  1) Correr SOLO el bloque "PASO 1 — VISTA PREVIA" y revisar.
--       2) Correr el bloque "PASO 2 — APLICAR" (DO $$ … END $$) y luego la verificación.
--       Para revertir: bloque "REVERTIR" al final (usa los respaldos _bk80_*).
-- ============================================================================

-- ════════════════════════════════════════════════════════════════════════════
-- PASO 1 — VISTA PREVIA (no modifica nada)
-- ════════════════════════════════════════════════════════════════════════════
WITH lineas AS (
  SELECT d.id AS detalle_id, d.compra_id, d.item_id, d.cantidad,
         d.precio_unitario AS precio_con_igv,
         ROUND(d.subtotal / d.cantidad, 6) AS precio_neto
  FROM public.detalle_compras d
  WHERE d.igv_porcentaje > 0 AND d.cantidad > 0 AND d.subtotal > 0
    AND ABS(d.cantidad * d.precio_unitario - d.subtotal)    > 0.05
    AND ABS(d.cantidad * d.precio_unitario - d.total_linea) <= 0.05
),
lotes_fix AS (
  SELECT l.id AS lote_id, l.numero_lote, l.moneda, li.compra_id,
         CASE WHEN l.moneda = 'USD' THEN COALESCE(l.tipo_cambio, 1) ELSE 1 END AS tc,
         l.costo_unit_original AS orig_antes, li.precio_neto AS orig_nuevo,
         l.costo_unitario AS pen_antes
  FROM public.lotes l
  JOIN lineas li ON li.compra_id = l.compra_id AND li.item_id = l.item_id
  WHERE ABS(l.costo_unit_original - li.precio_con_igv) < 0.0005
    AND ABS(l.costo_unitario - l.costo_unit_original * CASE WHEN l.moneda = 'USD' THEN COALESCE(l.tipo_cambio, 1) ELSE 1 END) < 0.01
)
SELECT f.numero_lote, c.serie || '-' || c.numero AS compra, f.moneda,
       f.orig_antes, f.orig_nuevo,
       f.pen_antes, ROUND(f.orig_nuevo * f.tc, 4) AS pen_nuevo,
       (SELECT COUNT(*) FROM public.kardex k WHERE k.lote_id = f.lote_id)                AS filas_kardex,
       (SELECT COUNT(*) FROM public.kardex k WHERE k.lote_id = f.lote_id AND k.venta_id IS NOT NULL) AS kardex_ventas,
       (SELECT COUNT(*) FROM public.detalle_ventas dv WHERE dv.lote_id = f.lote_id)      AS lineas_venta
FROM lotes_fix f JOIN public.compras c ON c.id = f.compra_id
ORDER BY compra, f.numero_lote;


-- ════════════════════════════════════════════════════════════════════════════
-- PASO 2 — APLICAR (un solo bloque DO: todo o nada)
-- v2: el editor SQL de Supabase no conserva tablas TEMP entre sentencias
-- (error 42P01 "_f80_lineas does not exist"), por eso ahora va en un DO.
-- Es seguro re-ejecutar si la v1 falló: no alcanzó a modificar datos.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE n_lin int; n_lot int; n_kx int; n_dv int;
BEGIN
  CREATE TEMP TABLE _f80_lineas ON COMMIT DROP AS
    SELECT d.id AS detalle_id, d.compra_id, d.item_id,
           d.precio_unitario AS precio_con_igv,
           ROUND(d.subtotal / d.cantidad, 6) AS precio_neto
    FROM public.detalle_compras d
    WHERE d.igv_porcentaje > 0 AND d.cantidad > 0 AND d.subtotal > 0
      AND ABS(d.cantidad * d.precio_unitario - d.subtotal)    > 0.05
      AND ABS(d.cantidad * d.precio_unitario - d.total_linea) <= 0.05;

  CREATE TEMP TABLE _f80_lotes ON COMMIT DROP AS
    SELECT l.id AS lote_id,
           l.costo_unitario AS pen_antes,
           li.precio_neto AS orig_nuevo,
           ROUND(li.precio_neto * CASE WHEN l.moneda = 'USD' THEN COALESCE(l.tipo_cambio, 1) ELSE 1 END, 4) AS pen_nuevo
    FROM public.lotes l
    JOIN _f80_lineas li ON li.compra_id = l.compra_id AND li.item_id = l.item_id
    WHERE ABS(l.costo_unit_original - li.precio_con_igv) < 0.0005
      AND ABS(l.costo_unitario - l.costo_unit_original * CASE WHEN l.moneda = 'USD' THEN COALESCE(l.tipo_cambio, 1) ELSE 1 END) < 0.01;

  -- Respaldos permanentes (para revertir). No borrar sin confirmar con Luis.
  CREATE TABLE IF NOT EXISTS public._bk80_detalle_compras AS SELECT * FROM public.detalle_compras WHERE false;
  CREATE TABLE IF NOT EXISTS public._bk80_lotes          AS SELECT * FROM public.lotes          WHERE false;
  CREATE TABLE IF NOT EXISTS public._bk80_kardex         AS SELECT * FROM public.kardex         WHERE false;
  CREATE TABLE IF NOT EXISTS public._bk80_detalle_ventas AS SELECT * FROM public.detalle_ventas WHERE false;
  INSERT INTO public._bk80_detalle_compras SELECT d.* FROM public.detalle_compras d WHERE d.id IN (SELECT detalle_id FROM _f80_lineas);
  INSERT INTO public._bk80_lotes          SELECT l.* FROM public.lotes l          WHERE l.id IN (SELECT lote_id FROM _f80_lotes);
  INSERT INTO public._bk80_kardex         SELECT k.* FROM public.kardex k         WHERE k.lote_id IN (SELECT lote_id FROM _f80_lotes);
  INSERT INTO public._bk80_detalle_ventas SELECT v.* FROM public.detalle_ventas v WHERE v.lote_id IN (SELECT lote_id FROM _f80_lotes);

  -- 1) Precio de compra sin IGV
  UPDATE public.detalle_compras d
  SET precio_unitario = li.precio_neto, updated_at = now()
  FROM _f80_lineas li WHERE d.id = li.detalle_id;
  GET DIAGNOSTICS n_lin = ROW_COUNT;

  -- 2) Costo del lote (moneda original + soles)
  UPDATE public.lotes l
  SET costo_unit_original = f.orig_nuevo, costo_unitario = f.pen_nuevo, updated_at = now()
  FROM _f80_lotes f WHERE l.id = f.lote_id;
  GET DIAGNOSTICS n_lot = ROW_COUNT;

  -- 3) Kardex: solo filas con el costo inflado del lote
  UPDATE public.kardex k
  SET costo_unitario      = f.pen_nuevo,
      costo_unit_original = f.orig_nuevo,
      valor_entrada = CASE WHEN COALESCE(k.valor_entrada, 0) <> 0 THEN ROUND(k.cantidad_entrada * f.pen_nuevo, 2) ELSE k.valor_entrada END,
      valor_salida  = CASE WHEN COALESCE(k.valor_salida, 0)  <> 0 THEN ROUND(k.cantidad_salida  * f.pen_nuevo, 2) ELSE k.valor_salida  END,
      saldo_valor   = ROUND(COALESCE(k.saldo_cantidad, 0) * f.pen_nuevo, 2)
  FROM _f80_lotes f
  WHERE k.lote_id = f.lote_id AND ABS(COALESCE(k.costo_unitario, 0) - f.pen_antes) < 0.01;
  GET DIAGNOSTICS n_kx = ROW_COUNT;

  -- 4) Costo de las líneas de venta
  UPDATE public.detalle_ventas v
  SET costo_unitario = f.pen_nuevo
  FROM _f80_lotes f
  WHERE v.lote_id = f.lote_id AND ABS(COALESCE(v.costo_unitario, 0) - f.pen_antes) < 0.01;
  GET DIAGNOSTICS n_dv = ROW_COUNT;

  RAISE NOTICE 'SQL 80 aplicado: % líneas de compra, % lotes, % filas kardex, % líneas de venta', n_lin, n_lot, n_kx, n_dv;
END $$;

-- Verificación (correr después del DO): los 17 lotes ya con costo sin IGV
SELECT l.numero_lote, l.moneda, l.costo_unit_original, l.costo_unitario, b.costo_unit_original AS antes
FROM public.lotes l JOIN public._bk80_lotes b ON b.id = l.id
ORDER BY l.numero_lote;


-- ════════════════════════════════════════════════════════════════════════════
-- REVERTIR (solo si algo salió mal) — restaura los valores respaldados
-- ════════════════════════════════════════════════════════════════════════════
-- BEGIN;
-- UPDATE public.detalle_compras d SET precio_unitario = b.precio_unitario FROM public._bk80_detalle_compras b WHERE d.id = b.id;
-- UPDATE public.lotes l SET costo_unit_original = b.costo_unit_original, costo_unitario = b.costo_unitario FROM public._bk80_lotes b WHERE l.id = b.id;
-- UPDATE public.kardex k SET costo_unitario = b.costo_unitario, costo_unit_original = b.costo_unit_original,
--        valor_entrada = b.valor_entrada, valor_salida = b.valor_salida, saldo_valor = b.saldo_valor
--   FROM public._bk80_kardex b WHERE k.id = b.id;
-- UPDATE public.detalle_ventas v SET costo_unitario = b.costo_unitario FROM public._bk80_detalle_ventas b WHERE v.id = b.id;
-- COMMIT;
