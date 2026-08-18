-- ============================================================
-- JHIRO ERP v2 — GRANTS DE PERMISOS (v3 — 2026-07-06)
-- Archivo: 00_grants.sql
-- Ejecutar PRIMERO, antes de todos los demás SQLs.
-- ============================================================

-- 1. USAGE en el schema public (obligatorio)
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- 2. TABLAS MAESTRAS
GRANT SELECT, INSERT, UPDATE, DELETE ON public.empresa_config            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users                     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contacts                  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.categorias                TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marcas                    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.items                     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.almacenes                 TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ubicaciones               TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lotes                     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.partidas                  TO authenticated;

-- 3. CONTABILIDAD
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plan_cuentas              TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.periodos_contables        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.diarios                   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.diario_lineas             TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tipo_documentos           TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.journal_entries           TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.journal_entry_lines       TO authenticated;

-- 4. COMPRAS
GRANT SELECT, INSERT, UPDATE, DELETE ON public.orden_compra              TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.detalle_orden_compra      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.compras                   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.detalle_compras           TO authenticated;

-- 5. VENTAS
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ventas                    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.detalle_ventas            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales_quotes              TO authenticated;

-- 6. CXC / CXP / COBRANZAS / PAGOS
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cuentas_cobrar            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cobros                    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cuentas_pagar             TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pagos_proveedores         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.letras_cambio             TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.terminos_pago             TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.terminos_pago_cuotas      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cuotas_cobrar             TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cuotas_pagar              TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.motivos_nota              TO authenticated;

-- 7. BANCOS
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bancos                    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.movimientos_banco         TO authenticated;

-- 8. KARDEX
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kardex                    TO authenticated;

-- 9. IMPORTACIONES
GRANT SELECT, INSERT, UPDATE, DELETE ON public.carpetas_importacion      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.comercial_invoices        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.detalle_comercial_invoice TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bill_of_ladings           TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dams                      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.guias_remision            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gastos_locales            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pagos                     TO authenticated;

-- 10. AUDITORIA (solo INSERT/SELECT)
GRANT SELECT, INSERT ON public.audit_logs                                TO authenticated;

-- 11. SECUENCIAS
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated;

-- 12. VISTAS
GRANT SELECT ON public.v_cxc_pendientes       TO authenticated;
GRANT SELECT ON public.v_cxp_pendientes       TO authenticated;
GRANT SELECT ON public.v_antiguedad_cxc         TO authenticated;
GRANT SELECT ON public.v_antiguedad_cxc_cliente TO authenticated;
GRANT SELECT ON public.v_antiguedad_cxp       TO authenticated;
GRANT SELECT ON public.v_libro_mayor          TO authenticated;
GRANT SELECT ON public.v_balance_cxc_cxp      TO authenticated;
GRANT SELECT ON public.v_balance_comprobacion TO authenticated;
GRANT SELECT ON public.v_registro_compras     TO authenticated;
GRANT SELECT ON public.v_registro_ventas      TO authenticated;

-- 13. FUNCIONES (RPC)
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS func_sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'fn_reversar_asiento','fn_cerrar_periodo','fn_asegurar_periodo_abierto',
        'fn_generar_numero_asiento','fn_actualizar_saldos_plan_cuentas',
        'fn_registrar_kardex','fn_actualizar_saldo_banco',
        'fn_actualizar_estado_cxc','fn_erp_audit',
        'fn_validar_partida_doble','fn_bloquear_periodo_cerrado',
        'fn_calcular_factor_carpeta'
      )
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.func_sig);
  END LOOP;
END $$;

-- 14. ROL ANON — solo catálogos antes del login
GRANT SELECT ON public.tipo_documentos TO anon;
GRANT SELECT ON public.plan_cuentas    TO anon;

-- 15. DEFAULT PRIVILEGES para tablas futuras
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO anon;
