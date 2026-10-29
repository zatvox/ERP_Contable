-- ============================================================================
-- 117_bl_contenedores_lineas.sql  (2026-10-28)
-- BL → CONTENEDORES → LÍNEAS DEL CI
--   · bill_of_ladings pasa a ser la CABECERA del BL (1 fila por BL). Sus campos
--     bultos / peso_bruto / volumen_cbm son los TOTALES que declara el BL (así la
--     DAM y las sumas actuales siguen cuadrando). contenedor_number queda como
--     resumen de texto («WHSU5068632, WHSU8223310») para los lectores antiguos.
--   · bl_contenedores: cada contenedor del BL (n°, tipo, precinto, bultos, kg, CBM).
--   · bl_contenedor_lineas: qué línea del CI (producto) va en qué contenedor y
--     cuánto (kg / bultos). Permite 2 contenedores del mismo artículo + 1 de otro,
--     o un contenedor mixto.
-- Aditivo e idempotente. Migra los BL actuales (1 contenedor cada uno).
-- ============================================================================
BEGIN;

-- 1) Contenedores del BL ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bl_contenedores (
  id            bigserial PRIMARY KEY,
  bl_id         bigint  NOT NULL REFERENCES public.bill_of_ladings(id) ON DELETE CASCADE,
  numero        varchar NOT NULL,
  tipo          varchar,
  precinto      varchar,
  bultos        integer,
  peso_bruto    numeric,
  volumen_cbm   numeric,
  fecha_llegada date,
  orden         integer NOT NULL DEFAULT 1,
  created_at    timestamptz DEFAULT now(),
  UNIQUE (bl_id, numero)
);
CREATE INDEX IF NOT EXISTS idx_blcont_bl ON public.bl_contenedores(bl_id);

-- 2) Qué va dentro de cada contenedor (líneas del CI) -------------------------
CREATE TABLE IF NOT EXISTS public.bl_contenedor_lineas (
  id              bigserial PRIMARY KEY,
  contenedor_id   bigint  NOT NULL REFERENCES public.bl_contenedores(id) ON DELETE CASCADE,
  detalle_ci_id   bigint  NOT NULL REFERENCES public.detalle_comercial_invoice(id) ON DELETE CASCADE,
  cantidad_neto   numeric NOT NULL DEFAULT 0 CHECK (cantidad_neto >= 0),   -- misma unidad que la línea del CI (kg)
  cantidad_gross  numeric,
  bultos          integer,
  created_at      timestamptz DEFAULT now(),
  UNIQUE (contenedor_id, detalle_ci_id)
);
CREATE INDEX IF NOT EXISTS idx_blcontlin_cont ON public.bl_contenedor_lineas(contenedor_id);
CREATE INDEX IF NOT EXISTS idx_blcontlin_det  ON public.bl_contenedor_lineas(detalle_ci_id);

-- 3) RLS / permisos (mismo criterio que el resto de importaciones) -------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bl_contenedores','bl_contenedor_lineas'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "authenticated_all" ON public.%I', t);
    EXECUTE format('CREATE POLICY "authenticated_all" ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I_id_seq TO authenticated', t);
  END LOOP;
END $$;

COMMENT ON TABLE public.bl_contenedores IS 'Contenedores de un BL. bill_of_ladings.bultos/peso_bruto/volumen_cbm = totales declarados por el BL.';
COMMENT ON TABLE public.bl_contenedor_lineas IS 'Reparto de las líneas del CI por contenedor (cantidad en la unidad del CI).';

-- 4) Migración: cada BL actual = 1 contenedor ---------------------------------
INSERT INTO public.bl_contenedores (bl_id, numero, tipo, precinto, bultos, peso_bruto, volumen_cbm, fecha_llegada, orden)
SELECT b.id, b.contenedor_number, b.tipo_contenedor, b.numero_precinto, b.bultos, b.peso_bruto, b.volumen_cbm, b.fecha_llegada, 1
  FROM public.bill_of_ladings b
 WHERE b.contenedor_number IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.bl_contenedores c WHERE c.bl_id = b.id);

-- Si el CI tiene UN solo BL con UN solo contenedor, todas sus líneas van en ese contenedor.
INSERT INTO public.bl_contenedor_lineas (contenedor_id, detalle_ci_id, cantidad_neto, cantidad_gross)
SELECT c.id, d.id, COALESCE(d.cantidad_neto, 0), d.cantidad_gross
  FROM public.bl_contenedores c
  JOIN public.bill_of_ladings b ON b.id = c.bl_id
  JOIN public.detalle_comercial_invoice d ON d.comercial_invoice_id = b.importacion_id
 WHERE (SELECT COUNT(*) FROM public.bill_of_ladings x WHERE x.importacion_id = b.importacion_id) = 1
   AND (SELECT COUNT(*) FROM public.bl_contenedores y WHERE y.bl_id = b.id) = 1
   AND NOT EXISTS (SELECT 1 FROM public.bl_contenedor_lineas l WHERE l.contenedor_id = c.id AND l.detalle_ci_id = d.id);

COMMIT;

-- VERIFICACIÓN (contenedores y líneas por BL)
SELECT b.id AS bl, b.nro_bill_lading, COUNT(DISTINCT c.id) AS contenedores, COUNT(l.id) AS lineas
  FROM public.bill_of_ladings b
  LEFT JOIN public.bl_contenedores c ON c.bl_id = b.id
  LEFT JOIN public.bl_contenedor_lineas l ON l.contenedor_id = c.id
 GROUP BY b.id, b.nro_bill_lading ORDER BY b.id;
