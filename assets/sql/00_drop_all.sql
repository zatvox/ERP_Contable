-- ============================================================
-- 00_drop_all.sql — DROP completo para migración limpia
-- ============================================================
-- ADVERTENCIA: Elimina TODOS los datos y tablas del ERP.
-- Ejecutar SOLO en entorno de construcción, NUNCA en producción.
-- Después de este script: ejecutar 00_grants → 01_schema → 02_functions
--                         → 03_rls_policies → 04_seed_data → apertura SQLs.
-- ============================================================

-- Orden: de hoja a raíz (respetar FK)
DROP TABLE IF EXISTS public.audit_logs                 CASCADE;
DROP TABLE IF EXISTS public.pagos                      CASCADE;
DROP TABLE IF EXISTS public.gastos_locales             CASCADE;
DROP TABLE IF EXISTS public.guias_remision             CASCADE;
DROP TABLE IF EXISTS public.dams                       CASCADE;
DROP TABLE IF EXISTS public.bill_of_ladings            CASCADE;
DROP TABLE IF EXISTS public.detalle_comercial_invoice  CASCADE;
DROP TABLE IF EXISTS public.comercial_invoices         CASCADE;
DROP TABLE IF EXISTS public.carpetas_importacion       CASCADE;
DROP TABLE IF EXISTS public.kardex                     CASCADE;
DROP TABLE IF EXISTS public.partidas                   CASCADE;
DROP TABLE IF EXISTS public.movimientos_banco          CASCADE;
DROP TABLE IF EXISTS public.bancos                     CASCADE;
DROP TABLE IF EXISTS public.letras_cambio              CASCADE;
DROP TABLE IF EXISTS public.pagos_proveedores          CASCADE;
DROP TABLE IF EXISTS public.cobros                     CASCADE;
DROP TABLE IF EXISTS public.cuentas_pagar              CASCADE;
DROP TABLE IF EXISTS public.cuentas_cobrar             CASCADE;
DROP TABLE IF EXISTS public.detalle_ventas             CASCADE;
DROP TABLE IF EXISTS public.ventas                     CASCADE;
DROP TABLE IF EXISTS public.sales_quotes               CASCADE;
DROP TABLE IF EXISTS public.detalle_compras            CASCADE;
DROP TABLE IF EXISTS public.compras                    CASCADE;
DROP TABLE IF EXISTS public.detalle_orden_compra       CASCADE;
DROP TABLE IF EXISTS public.orden_compra               CASCADE;
DROP TABLE IF EXISTS public.journal_entry_lines        CASCADE;
DROP TABLE IF EXISTS public.journal_entries            CASCADE;
DROP TABLE IF EXISTS public.tipo_documentos            CASCADE;
DROP TABLE IF EXISTS public.diario_lineas              CASCADE;
DROP TABLE IF EXISTS public.diarios                    CASCADE;
DROP TABLE IF EXISTS public.periodos_contables         CASCADE;
DROP TABLE IF EXISTS public.plan_cuentas               CASCADE;
DROP TABLE IF EXISTS public.lotes                      CASCADE;
DROP TABLE IF EXISTS public.ubicaciones                CASCADE;
DROP TABLE IF EXISTS public.almacenes                  CASCADE;
DROP TABLE IF EXISTS public.items                      CASCADE;
DROP TABLE IF EXISTS public.marcas                     CASCADE;
DROP TABLE IF EXISTS public.categorias                 CASCADE;
DROP TABLE IF EXISTS public.contacts                   CASCADE;
DROP TABLE IF EXISTS public.users                      CASCADE;
DROP TABLE IF EXISTS public.empresa_config             CASCADE;

-- Tablas obsoletas (si existían en versiones anteriores)
DROP TABLE IF EXISTS public.apertura_saldos_cxp        CASCADE;
DROP TABLE IF EXISTS public.costeo_gastos_despacho      CASCADE;
DROP TABLE IF EXISTS public.costeo_gastos_financieros   CASCADE;
DROP TABLE IF EXISTS public.costeo_productos_fob        CASCADE;

-- Vistas
DROP VIEW IF EXISTS public.v_cxc_pendientes   CASCADE;
DROP VIEW IF EXISTS public.v_cxp_pendientes   CASCADE;
DROP VIEW IF EXISTS public.v_antiguedad_cxc         CASCADE;
DROP VIEW IF EXISTS public.v_antiguedad_cxc_cliente CASCADE;
DROP VIEW IF EXISTS public.v_antiguedad_cxp   CASCADE;
DROP VIEW IF EXISTS public.v_libro_mayor      CASCADE;
DROP VIEW IF EXISTS public.v_balance_cxc_cxp  CASCADE;
DROP VIEW IF EXISTS public.v_balance_comprobacion CASCADE;
DROP VIEW IF EXISTS public.v_registro_compras  CASCADE;
DROP VIEW IF EXISTS public.v_registro_ventas   CASCADE;
