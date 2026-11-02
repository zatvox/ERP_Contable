-- ============================================================================
-- 129 · FIX de fondo — el ámbito FAMILIAR era imposible  ·  2026-11-01
-- ----------------------------------------------------------------------------
-- SÍNTOMA: al cargar el Excel, las filas de la categoría ANN (familiares) no
-- se insertaban. Los ids de `movimientos_banco` saltaban (263…264, luego 265,
-- 266, 267, 268, 269, **270 falta**, 271…): el INSERT se intentaba y moría.
--
-- CAUSA: dos reglas que se contradicen.
--   · SQL 87 (multiempresa): `empresa_id SET NOT NULL` en bancos y
--     movimientos_banco — "todo documento tiene dueño".
--   · SQL 123 (ámbito): CHECK que exige `empresa_id IS NULL` cuando
--     ambito = 'familiar' — "lo familiar no tiene dueño fiscal".
--   Con las dos a la vez, una fila familiar no puede existir: el CHECK pide
--   NULL y el NOT NULL lo prohíbe. La caja familiar tampoco se habría podido
--   crear nunca.
--
-- SOLUCIÓN: se quita el NOT NULL **solo** en las tablas que tienen ámbito.
-- No se pierde integridad: el CHECK compuesto es MÁS estricto que el NOT NULL
-- suelto, porque además ata el valor al ámbito —
--   (ambito='empresa' AND empresa_id IS NOT NULL) OR
--   (ambito='familiar' AND empresa_id IS NULL)
-- Un NULL suelto sigue siendo imposible: necesita ambito='familiar' explícito.
--
-- El resto del ERP (ventas, compras, lotes, kardex…) conserva su NOT NULL
-- intacto: ahí no existe el ámbito familiar y un documento sin dueño sería
-- un error de verdad.
--
-- IDEMPOTENTE. NO BORRA NADA.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  t text;
  v_tablas text[] := ARRAY['bancos', 'movimientos_banco', 'gastos',
                           'entregas_a_rendir', 'reposiciones_caja'];
  v_tiene_check boolean;
BEGIN
  FOREACH t IN ARRAY v_tablas LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'No existe la tabla % — se omite', t;
      CONTINUE;
    END IF;

    -- Red de seguridad: sólo se afloja el NOT NULL si la tabla YA tiene el
    -- CHECK de ámbito. Sin él, quitarlo sí dejaría documentos huérfanos.
    SELECT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = ('public.' || t)::regclass
         AND contype = 'c'
         AND pg_get_constraintdef(oid) ILIKE '%ambito%empresa_id%'
    ) INTO v_tiene_check;

    IF NOT v_tiene_check THEN
      RAISE WARNING '% no tiene el CHECK de ámbito: NO se toca su NOT NULL. ¿Falta correr el SQL 123/124/128?', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN empresa_id DROP NOT NULL', t);
    RAISE NOTICE '✔ % : empresa_id ya admite NULL (protegido por el CHECK de ámbito)', t;
  END LOOP;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
SELECT '1. NULLABLE' AS bloque, table_name, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public' AND column_name = 'empresa_id'
   AND table_name IN ('bancos','movimientos_banco','gastos','entregas_a_rendir',
                      'reposiciones_caja','ventas','compras','lotes','kardex')
 ORDER BY is_nullable DESC, table_name;

SELECT '2. CHECKS DE ÁMBITO' AS bloque, conrelid::regclass AS tabla, conname
  FROM pg_constraint
 WHERE contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%ambito%empresa_id%'
 ORDER BY 2;

-- Prueba real: una fila familiar tiene que poder existir
DO $$
DECLARE v_id bigint; v_caja integer;
BEGIN
  SELECT id INTO v_caja FROM public.bancos WHERE tipo_cuenta = 'caja' LIMIT 1;
  INSERT INTO public.movimientos_banco (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id)
  VALUES (v_caja, CURRENT_DATE, 'egreso', '__prueba ámbito familiar__', 1, 'familiar', NULL)
  RETURNING id INTO v_id;
  DELETE FROM public.movimientos_banco WHERE id = v_id;
  RAISE NOTICE '✔ PRUEBA OK: una fila familiar (empresa_id NULL) se puede insertar y se borró la de prueba.';
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '✗ PRUEBA FALLIDA: %', SQLERRM;
END $$;
