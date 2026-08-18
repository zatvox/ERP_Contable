-- ============================================================
-- JHIRO ERP v2 — ROW LEVEL SECURITY (v3 — 2026-07-06)
-- Archivo: 03_rls_policies.sql
-- Ejecutar DESPUÉS de 01_schema.sql y 02_functions.sql
-- ============================================================
-- ESTRATEGIA: política única por tabla para rol 'authenticated'.
-- Todo usuario con sesión Supabase válida tiene acceso total.
-- ============================================================

-- 1. HABILITAR RLS
ALTER TABLE public.empresa_config            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categorias                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marcas                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.items                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.almacenes                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ubicaciones               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lotes                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partidas                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_cuentas              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.periodos_contables        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diarios                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diario_lineas             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tipo_documentos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entry_lines       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orden_compra              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.detalle_orden_compra      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compras                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.detalle_compras           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ventas                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.detalle_ventas            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_quotes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cuentas_cobrar            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cobros                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cuentas_pagar             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pagos_proveedores         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.letras_cambio             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bancos                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.movimientos_banco         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kardex                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.carpetas_importacion      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comercial_invoices        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.detalle_comercial_invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bill_of_ladings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dams                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guias_remision            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gastos_locales            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pagos                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs                ENABLE ROW LEVEL SECURITY;

-- 2. LIMPIAR POLÍTICAS ANTERIORES (idempotente)
DO $$
DECLARE
  tablas text[] := ARRAY[
    'empresa_config','users','contacts','categorias','marcas','items',
    'almacenes','ubicaciones','lotes','partidas',
    'plan_cuentas','periodos_contables','diarios','diario_lineas','tipo_documentos',
    'journal_entries','journal_entry_lines',
    'orden_compra','detalle_orden_compra',
    'compras','detalle_compras',
    'ventas','detalle_ventas','sales_quotes',
    'cuentas_cobrar','cobros','cuentas_pagar','pagos_proveedores','letras_cambio',
    'bancos','movimientos_banco','kardex',
    'carpetas_importacion',
    'comercial_invoices','detalle_comercial_invoice',
    'bill_of_ladings','dams','guias_remision','gastos_locales','pagos',
    'audit_logs'
  ];
  t text; pol text;
BEGIN
  FOREACH t IN ARRAY tablas LOOP
    FOR pol IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol, t);
    END LOOP;
  END LOOP;
END $$;

-- 3. POLÍTICAS: authenticated tiene acceso total a todas las tablas

CREATE POLICY "authenticated_all" ON public.empresa_config            FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.users                     FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.contacts                  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.categorias                FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.marcas                    FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.items                     FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.almacenes                 FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.ubicaciones               FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.lotes                     FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.partidas                  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.plan_cuentas              FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.periodos_contables        FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.diarios                   FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.diario_lineas             FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.tipo_documentos           FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.journal_entries           FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.journal_entry_lines       FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.orden_compra              FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.detalle_orden_compra      FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.compras                   FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.detalle_compras           FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.ventas                    FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.detalle_ventas            FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.sales_quotes              FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.cuentas_cobrar            FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.cobros                    FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.cuentas_pagar             FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.pagos_proveedores         FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.letras_cambio             FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.bancos                    FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.movimientos_banco         FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.kardex                    FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.carpetas_importacion      FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.comercial_invoices        FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.detalle_comercial_invoice FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.bill_of_ladings           FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.dams                      FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.guias_remision            FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.gastos_locales            FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON public.pagos                     FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- audit_logs: INSERT libre, SELECT solo propio usuario (o admin)
CREATE POLICY "insert_audit" ON public.audit_logs
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "select_audit" ON public.audit_logs
  FOR SELECT TO authenticated USING (true);

-- 4. ROL ANON: lectura de catálogos públicos (antes del login)
CREATE POLICY "anon_read_tipo_docs" ON public.tipo_documentos
  FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_plan_cuentas" ON public.plan_cuentas
  FOR SELECT TO anon USING (true);
