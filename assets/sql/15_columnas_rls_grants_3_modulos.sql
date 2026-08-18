-- ============================================================
-- 15_columnas_rls_grants_3_modulos.sql
-- Módulos activos: Compras, Ventas, Inventario (los demás en standby).
-- Este script:
--   1) Deja documentadas las columnas reales de las 10 tablas usadas
--      por estos 3 módulos (vía COMMENT ON COLUMN, no cambia tipos).
--   2) Re-crea policies RLS simples (cualquier usuario autenticado
--      del sistema puede leer/escribir — el control fino de roles
--      queda pendiente para cuando se implemente el módulo de
--      permisos; por ahora el filtro real es "sesión autenticada").
--   3) Otorga los GRANTs necesarios al rol authenticated.
-- Ejecutar en Supabase SQL Editor. Idempotente.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. DOCUMENTACIÓN DE COLUMNAS REALES (referencia rápida para JS)
-- ────────────────────────────────────────────────────────────

-- CONTACTS (proveedores y clientes)
COMMENT ON COLUMN public.contacts.tipo_contacto IS
  'text[]: cliente/proveedor/empleado/otro. Usar tiposDeContacto() en JS.';
COMMENT ON COLUMN public.contacts.nombre         IS 'Razón social o nombre completo.';
COMMENT ON COLUMN public.contacts.nro_documento  IS 'RUC/DNI/CE. Único.';
COMMENT ON COLUMN public.contacts.telefono       IS 'Teléfono principal (numero es legacy).';

-- ITEMS (productos)
COMMENT ON COLUMN public.items.categoria_id   IS 'FK obligatoria a categorias(id).';
COMMENT ON COLUMN public.items.marca_id       IS 'FK opcional a marcas(id).';
COMMENT ON COLUMN public.items.stock_actual   IS 'Cache de stock; la fuente real es SUM(lotes.cantidad) por item_id.';

-- CATEGORIAS / MARCAS: sin cambios, solo nombre/descripcion/activo.

-- LOTES (stock físico por lote)
COMMENT ON COLUMN public.lotes.item_id  IS 'FK a items(id). OJO: no existe columna product_id.';
COMMENT ON COLUMN public.lotes.cantidad IS 'Stock del lote en KG (u unidad base). OJO: no existe columna stock.';
COMMENT ON COLUMN public.lotes.cantidad_unidades IS 'Stock del lote en unidades (cajas, conos, etc).';

-- PARTIDAS (partida arancelaria por producto)
COMMENT ON COLUMN public.partidas.product_id IS 'FK a items(id). Aquí SÍ se llama product_id (a diferencia de lotes).';

-- COMPRAS / DETALLE_COMPRAS
COMMENT ON COLUMN public.compras.contact_id  IS 'FK a contacts(id), debe tener tipo_contacto que incluya proveedor.';
COMMENT ON COLUMN public.compras.asiento_id  IS 'Opcional: módulo de Contabilidad en standby, puede quedar NULL.';
COMMENT ON COLUMN public.detalle_compras.compra_id IS 'FK a compras(id) ON DELETE CASCADE.';

-- VENTAS / DETALLE_VENTAS
COMMENT ON COLUMN public.ventas.contact_id  IS 'FK a contacts(id), debe tener tipo_contacto que incluya cliente.';
COMMENT ON COLUMN public.ventas.asiento_id  IS 'Opcional: módulo de Contabilidad en standby, puede quedar NULL.';
COMMENT ON COLUMN public.detalle_ventas.lote_id IS 'FK opcional a lotes(id); se usa para trazabilidad FIFO al descontar stock.';

-- ────────────────────────────────────────────────────────────
-- 2. RLS — asegurar habilitado (ya lo estaba desde 03_rls_policies.sql)
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.contacts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categorias      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marcas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lotes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partidas        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compras         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.detalle_compras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ventas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.detalle_ventas  ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────
-- 3. POLICIES — limpiar anteriores y recrear (idempotente)
-- ────────────────────────────────────────────────────────────
DO $$
DECLARE
  tabla text;
  tablas text[] := ARRAY[
    'contacts','categorias','marcas','items','lotes','partidas',
    'compras','detalle_compras','ventas','detalle_ventas'
  ];
  pol record;
BEGIN
  FOREACH tabla IN ARRAY tablas LOOP
    FOR pol IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = tabla
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, tabla);
    END LOOP;
  END LOOP;
END $$;

-- Cualquier usuario autenticado puede SELECT/INSERT/UPDATE/DELETE.
-- (Consistente con el resto del sistema: el control de acceso real
--  se hace a nivel de aplicación / Supabase Auth, no por rol de negocio).
DO $$
DECLARE
  tabla text;
  tablas text[] := ARRAY[
    'contacts','categorias','marcas','items','lotes','partidas',
    'compras','detalle_compras','ventas','detalle_ventas'
  ];
BEGIN
  FOREACH tabla IN ARRAY tablas LOOP
    EXECUTE format($p$
      CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)
    $p$, tabla || '_select_auth', tabla);

    EXECUTE format($p$
      CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (true)
    $p$, tabla || '_insert_auth', tabla);

    EXECUTE format($p$
      CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (true) WITH CHECK (true)
    $p$, tabla || '_update_auth', tabla);

    EXECUTE format($p$
      CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (true)
    $p$, tabla || '_delete_auth', tabla);
  END LOOP;
END $$;

-- ────────────────────────────────────────────────────────────
-- 4. GRANTS explícitos al rol authenticated (Supabase los exige
--    además de las policies; sin esto, RLS nunca llega a evaluarse).
-- ────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contacts        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.categorias      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marcas          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.items           TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lotes           TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.partidas        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.compras         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.detalle_compras TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ventas          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.detalle_ventas  TO authenticated;

-- Secuencias (necesarias para INSERT con bigserial/IDENTITY vía PostgREST)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- ────────────────────────────────────────────────────────────
-- 5. Verificación
-- ────────────────────────────────────────────────────────────
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('contacts','categorias','marcas','items','lotes','partidas',
                     'compras','detalle_compras','ventas','detalle_ventas')
ORDER BY tablename, cmd;
