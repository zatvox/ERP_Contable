-- ============================================================================
-- 100_prorrateo_fob_real_en_cif.sql  (2026-10-23)
-- Problema: en una Commercial Invoice con incoterm CIF/CFR/CIP/CPT/DAP/DDP las
-- líneas del detalle traen el precio de la factura (flete y seguro ya
-- incluidos), pero la vista de prorrateo/análisis las leía como FOB, así que
-- el FOB por línea y por kg salía inflado (USD 34,263 en vez de 30,131.97).
-- Arreglo: v_importacion_costo_detalle lleva fob_usd y fob_unitario a FOB real
-- multiplicando por (valor_total_final_fob del CI ÷ suma de sus líneas), con
-- tope 1. Sin flete/seguro el factor es 1 (no cambia nada). El reparto
-- "valor_fob" no se altera (todas las líneas de un CI se escalan igual).
-- Solo redefine la vista (mismas columnas). No toca datos.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW public.v_importacion_costo_detalle AS
WITH base AS (
  SELECT
    d.id                                               AS detalle_id,
    d.comercial_invoice_id,
    ci.carpeta_importacion_id                          AS carpeta_id,
    ci.empresa_id,
    d.product_id AS item_id,   -- la columna real se llama product_id
    d.lote, d.lote_id, d.partida_arancelaria,
    COALESCE(d.inventariable, true)                    AS inventariable,
    d.margen_objetivo,
    COALESCE(d.cantidad_recibida, d.cantidad_neto, 0)  AS peso_neto,
    COALESCE(d.cantidad_gross, d.cantidad_neto, 0)     AS peso_bruto,
    COALESCE(d.cantidad_unid, 0)                       AS bultos,
    -- FOB REAL: en una factura CIF/CFR las líneas traen el precio con flete y
    -- seguro incluidos; se llevan a FOB con el factor FOB/total del CI.
    COALESCE(d.costo_total, 0) * kf.k                  AS fob_usd,
    d.costo_unitario * kf.k                            AS fob_unitario
  FROM public.detalle_comercial_invoice d
  JOIN public.comercial_invoices ci ON ci.id = d.comercial_invoice_id
  CROSS JOIN LATERAL (
    SELECT CASE WHEN COALESCE(ci.valor_total_final_fob, 0) > 0 AND s.suma > 0
                THEN LEAST(1::numeric, ci.valor_total_final_fob / s.suma)
                ELSE 1::numeric END AS k
    FROM (SELECT SUM(x.costo_total) AS suma
          FROM public.detalle_comercial_invoice x
          WHERE x.comercial_invoice_id = d.comercial_invoice_id) s
  ) kf
  WHERE ci.carpeta_importacion_id IS NOT NULL
),
-- Los totales incluyen las líneas NO inventariables a propósito: una muestra
-- consume flete y tributos, así que debe absorber su parte en vez de que la
-- mercadería vendible cargue con ella.
tot AS (
  SELECT carpeta_id,
         SUM(fob_usd)    AS fob_t,
         SUM(peso_neto)  AS pn_t,
         SUM(peso_bruto) AS pb_t,
         SUM(bultos)     AS b_t
  FROM base GROUP BY carpeta_id
),
reparto AS (
  SELECT
    b.detalle_id,
    SUM(k.monto_usd * w.peso) FILTER (WHERE k.entra_costo_contable) AS costo_contable_usd,
    SUM(k.monto_pen * w.peso) FILTER (WHERE k.entra_costo_contable) AS costo_contable_pen,
    SUM(k.monto_usd * w.peso) FILTER (WHERE k.entra_costo_gestion)  AS costo_gestion_usd,
    SUM(k.monto_pen * w.peso) FILTER (WHERE k.entra_costo_gestion)  AS costo_gestion_pen,
    SUM(k.monto_usd * w.peso) FILTER (WHERE k.grupo = 'cif')        AS cif_usd,
    -- Líneas de costo que no se pudieron repartir porque su base está en 0
    COUNT(*) FILTER (WHERE w.peso IS NULL)                          AS lineas_sin_base
  FROM base b
  JOIN tot t                       ON t.carpeta_id = b.carpeta_id
  JOIN public.importacion_costos k ON k.carpeta_importacion_id = b.carpeta_id AND NOT k.anulado
  CROSS JOIN LATERAL (
    SELECT CASE k.base_prorrateo
             WHEN 'directo'    THEN CASE WHEN k.detalle_ci_id = b.detalle_id THEN 1::numeric ELSE 0::numeric END
             WHEN 'peso_neto'  THEN b.peso_neto  / NULLIF(t.pn_t,  0)
             WHEN 'peso_bruto' THEN b.peso_bruto / NULLIF(t.pb_t,  0)
             WHEN 'bultos'     THEN b.bultos     / NULLIF(t.b_t,   0)
             ELSE                   b.fob_usd    / NULLIF(t.fob_t, 0)
           END AS peso
  ) w
  GROUP BY b.detalle_id
)
SELECT
  b.detalle_id, b.carpeta_id, b.comercial_invoice_id,
  b.item_id, b.lote, b.lote_id, b.partida_arancelaria, b.inventariable,
  b.peso_neto, b.peso_bruto, b.bultos, b.fob_usd, b.fob_unitario, b.margen_objetivo,
  COALESCE(r.cif_usd, 0)            AS cif_usd,
  COALESCE(r.costo_contable_usd, 0) AS costo_contable_usd,
  COALESCE(r.costo_contable_pen, 0) AS costo_contable_pen,
  COALESCE(r.costo_gestion_usd, 0)  AS costo_gestion_usd,
  COALESCE(r.costo_gestion_pen, 0)  AS costo_gestion_pen,
  COALESCE(r.lineas_sin_base, 0)    AS lineas_sin_base,
  CASE WHEN b.peso_neto > 0 THEN round(COALESCE(r.costo_contable_usd, 0) / b.peso_neto, 6) END AS costo_contable_kg,
  CASE WHEN b.peso_neto > 0 THEN round(COALESCE(r.costo_gestion_usd,  0) / b.peso_neto, 6) END AS costo_gestion_kg,
  CASE WHEN b.peso_neto > 0 THEN round(COALESCE(r.costo_contable_pen, 0) / b.peso_neto, 6) END AS costo_contable_kg_pen,
  -- empresa_id va al FINAL, igual que en las vistas del 87, para que un
  -- CREATE OR REPLACE futuro pueda seguir agregando columnas sin romperla.
  b.empresa_id
FROM base b
LEFT JOIN reparto r ON r.detalle_id = b.detalle_id;;

COMMIT;

-- Verificación (resultado visible en el panel): FOB del CI vs suma de líneas ya escalada
SELECT ci.id AS ci_id, ci.invoice_number, ci.terminos_delivery,
       ci.valor_total_final_ci AS total_factura, ci.costo_flete, ci.costo_seguro,
       ci.valor_total_final_fob AS fob_ci,
       round(SUM(cd.fob_usd), 2) AS fob_lineas_vista
FROM public.comercial_invoices ci
JOIN public.v_importacion_costo_detalle cd ON cd.comercial_invoice_id = ci.id
GROUP BY ci.id, ci.invoice_number, ci.terminos_delivery, ci.valor_total_final_ci,
         ci.costo_flete, ci.costo_seguro, ci.valor_total_final_fob
ORDER BY ci.id;
