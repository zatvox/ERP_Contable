-- ============================================================================
-- 138 · Punto 1: vouchers por etapa del agente + flete/seguro por incoterm (2026-11-06)
-- ============================================================================
-- PARTE A — CONSULTA (solo lectura): corre esto primero y revisa el resultado
-- ============================================================================
SELECT conrelid::regclass AS tabla, conname, pg_get_constraintdef(oid) AS definicion
  FROM pg_constraint
 WHERE contype = 'c'
   AND ( conname IN ('adjuntos_entidad_check', 'adjuntos_concepto_check')
      OR conrelid IN ('public.importacion_pago_aplicaciones'::regclass, 'public.importacion_pagos'::regclass) )
 ORDER BY 1, 2;
-- Debe mostrar: adjuntos_entidad_check SIN 'liq_abono_proforma' y la de doc_tipo SIN 'flete'/'seguro'.

-- ============================================================================
-- PARTE B — CÓDIGO A EJECUTAR (modifica constraints; es idempotente)
-- ============================================================================
BEGIN;

-- B1 · adjuntos.entidad: agrega los vouchers por etapa del agente (conserva lo que ya aceptaba)
DO $$
DECLARE v_def text; v_vals text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'adjuntos_entidad_check';
  IF v_def IS NULL THEN
    RAISE NOTICE '⚠ No existe adjuntos_entidad_check (¿falta el SQL 60/86?). Se omite.';
  ELSIF v_def LIKE '%liq_abono_proforma%' THEN
    RAISE NOTICE '✔ adjuntos ya acepta liq_abono_*.';
  ELSE
    v_vals := (regexp_match(v_def, 'ARRAY\[(.*?)\]'))[1];
    v_vals := replace(v_vals, '::character varying', '');
    v_vals := replace(v_vals, '::text', '');
    EXECUTE 'ALTER TABLE public.adjuntos DROP CONSTRAINT adjuntos_entidad_check';
    EXECUTE 'ALTER TABLE public.adjuntos ADD CONSTRAINT adjuntos_entidad_check '
         || 'CHECK (entidad IN (' || v_vals || ', ''liq_abono_proforma'', ''liq_abono_liquidacion''))';
    RAISE NOTICE '✔ liq_abono_proforma y liq_abono_liquidacion agregadas.';
  END IF;
END $$;

-- B2 · importacion_pago_aplicaciones.doc_tipo: agrega flete y seguro (FOB/CFR: los factura el proveedor externo)
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.importacion_pago_aplicaciones'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%oc_anticipo%'
  LOOP
    EXECUTE format('ALTER TABLE public.importacion_pago_aplicaciones DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE public.importacion_pago_aplicaciones
    ADD CONSTRAINT importacion_pago_aplicaciones_doc_tipo_check
    CHECK (doc_tipo IN ('oc_anticipo','ci_saldo','dam_tributos','dam_percepcion','ajuste_valor','agente','flete','seguro','otro'));
END $$;

COMMIT;

-- ============================================================================
-- PARTE C — VERIFICACIÓN (solo lectura)
-- ============================================================================
SELECT conname, pg_get_constraintdef(oid) LIKE '%liq_abono_proforma%' AS acepta_vouchers_agente
  FROM pg_constraint WHERE conname = 'adjuntos_entidad_check';
SELECT conname, pg_get_constraintdef(oid) LIKE '%flete%' AS acepta_flete
  FROM pg_constraint WHERE conrelid = 'public.importacion_pago_aplicaciones'::regclass AND contype = 'c' AND conname ILIKE '%doc_tipo%';
