-- ============================================================================
-- 21_kardex_origen_destino_partners.sql
-- Etapa 4 de Almacenes: Kardex completo (compra + venta + traslado interno),
-- siguiendo el modelo de Odoo (stock.move con location_id / location_dest_id):
--   - Ubicaciones INTERNAS reales: Almacén/Zona (ej. "SJLP/Zona A").
--   - Ubicaciones VIRTUALES de terceros: "Partners/Vendors" (proveedores) y
--     "Partners/Customers" (clientes), para que TODO movimiento de stock
--     (no solo los traslados internos) tenga un origen y un destino.
--
--   Compra  -> origen = Partners/Vendors,   destino = tu Zona real.
--   Venta   -> origen = tu Zona real,       destino = Partners/Customers.
--   Traslado interno -> origen = Zona real, destino = Zona real (sin cambios).
-- ============================================================================

-- 1) Renombrar kardex.ubicacion_id -> ubicacion_origen_id para que el
--    nombre sea simétrico con ubicacion_destino_id (ya existente desde
--    19_traslados_internos_y_vendedor.sql) y refleje su uso real: origen
--    del movimiento, no solo "la zona" a secas.
ALTER TABLE public.kardex RENAME COLUMN ubicacion_id TO ubicacion_origen_id;

-- 2) Marcar qué almacenes son virtuales (no son una ubicación física real,
--    no deben aparecer como opción al recibir mercadería, vender o
--    trasladar stock — solo existen para que el Kardex tenga un origen/
--    destino externo consistente).
ALTER TABLE public.almacenes
  ADD COLUMN IF NOT EXISTS es_virtual boolean NOT NULL DEFAULT false;

-- 3) Crear el almacén virtual "Partners" y sus dos zonas Vendors/Customers,
--    si no existen todavía (idempotente).
INSERT INTO public.almacenes (codigo, nombre, direccion, es_principal, activo, es_virtual)
SELECT 'PARTNERS', 'Partners', 'Ubicación virtual — terceros (no es una dirección física)', false, true, true
WHERE NOT EXISTS (SELECT 1 FROM public.almacenes WHERE codigo = 'PARTNERS');

INSERT INTO public.ubicaciones (almacen_id, codigo, nombre, tipo, activo)
SELECT a.id, 'VENDORS', 'Vendors', 'otro', true
FROM public.almacenes a
WHERE a.codigo = 'PARTNERS'
  AND NOT EXISTS (
    SELECT 1 FROM public.ubicaciones u WHERE u.almacen_id = a.id AND u.codigo = 'VENDORS'
  );

INSERT INTO public.ubicaciones (almacen_id, codigo, nombre, tipo, activo)
SELECT a.id, 'CUSTOMERS', 'Customers', 'otro', true
FROM public.almacenes a
WHERE a.codigo = 'PARTNERS'
  AND NOT EXISTS (
    SELECT 1 FROM public.ubicaciones u WHERE u.almacen_id = a.id AND u.codigo = 'CUSTOMERS'
  );

-- Verificación
SELECT a.codigo AS almacen, a.nombre AS almacen_nombre, a.es_virtual, u.codigo AS zona, u.nombre AS zona_nombre
FROM public.almacenes a
LEFT JOIN public.ubicaciones u ON u.almacen_id = a.id
WHERE a.codigo = 'PARTNERS'
ORDER BY u.codigo;
