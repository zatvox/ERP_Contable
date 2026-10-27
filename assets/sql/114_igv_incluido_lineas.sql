-- ============================================================================
-- 114 · Guardar las líneas "Gravada 18% (incluido)" TAL CUAL se registraron
-- (2026-10-27). Aplica a detalle_packing y detalle_ventas.
--
--   precio_unitario  → se mantiene SIN IGV (base). Lo usan facturación SUNAT,
--                      reportes, asientos, rentabilidad: no cambia nada ahí.
--   igv_incluido     → true si el usuario ingresó el precio CON IGV.
--   precio_con_igv   → el precio exacto que escribió el usuario (6 dec).
--
-- Vistas, modales y PDFs muestran precio_con_igv + "Gravada 18% (incluido)"
-- cuando igv_incluido = true. Solo de ahora en adelante (no se recuperan
-- líneas antiguas).
-- ============================================================================
DO $$
BEGIN
  ALTER TABLE public.detalle_packing ADD COLUMN IF NOT EXISTS igv_incluido   boolean NOT NULL DEFAULT false;
  ALTER TABLE public.detalle_packing ADD COLUMN IF NOT EXISTS precio_con_igv numeric(18,6);
  ALTER TABLE public.detalle_ventas  ADD COLUMN IF NOT EXISTS igv_incluido   boolean NOT NULL DEFAULT false;
  ALTER TABLE public.detalle_ventas  ADD COLUMN IF NOT EXISTS precio_con_igv numeric(18,6);

  COMMENT ON COLUMN public.detalle_packing.igv_incluido   IS 'Precio ingresado con IGV incluido (Gravada 18% incluido). precio_unitario sigue siendo la base sin IGV.';
  COMMENT ON COLUMN public.detalle_packing.precio_con_igv IS 'Precio unitario CON IGV tal como lo ingresó el usuario (solo si igv_incluido).';
  COMMENT ON COLUMN public.detalle_ventas.igv_incluido    IS 'Precio ingresado con IGV incluido (Gravada 18% incluido). precio_unitario sigue siendo la base sin IGV.';
  COMMENT ON COLUMN public.detalle_ventas.precio_con_igv  IS 'Precio unitario CON IGV tal como lo ingresó el usuario (solo si igv_incluido).';
END $$;

NOTIFY pgrst, 'reload schema';
