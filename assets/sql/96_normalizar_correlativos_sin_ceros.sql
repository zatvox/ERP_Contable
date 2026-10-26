-- ============================================================================
-- 96_normalizar_correlativos_sin_ceros.sql  (2026-10-22)
-- Estándar: el N° de comprobante NUMÉRICO se guarda SIN ceros a la izquierda
-- ('00000448' → '448'). La vista lo muestra con o sin ceros según
-- ⚙️ Configuración → Apariencia → "N° de comprobante con 8 dígitos".
--
-- Alcance (solo números puros de 1 a 8 dígitos; NO se tocan textos como
-- 'HY7200251', 'LT.339-05' ni números de más de 8 dígitos tipo '0098100091'):
--   ventas.correlativo · cuentas_cobrar.numero_comprobante
--   compras.numero     · cuentas_pagar.numero_comprobante
-- ventas.numero ('FFFI-00000448', identificador SUNAT, UNIQUE) NO cambia.
-- Además deja un trigger para que todo lo nuevo (formularios, importación
-- masiva) entre ya normalizado.
-- ============================================================================

-- Función de normalización (reutilizable)
CREATE OR REPLACE FUNCTION public.fn_norm_correlativo(v text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v ~ '^[0-9]{1,8}$' THEN COALESCE(NULLIF(ltrim(v, '0'), ''), '0') ELSE v END
$$;

-- ── 1) VISTA PREVIA: cuántas filas cambian por tabla ─────────────────────────
SELECT 'ventas' AS tabla, count(*) AS filas FROM public.ventas WHERE correlativo <> public.fn_norm_correlativo(correlativo)
UNION ALL SELECT 'cuentas_cobrar', count(*) FROM public.cuentas_cobrar WHERE numero_comprobante <> public.fn_norm_correlativo(numero_comprobante)
UNION ALL SELECT 'compras', count(*) FROM public.compras WHERE numero <> public.fn_norm_correlativo(numero)
UNION ALL SELECT 'cuentas_pagar', count(*) FROM public.cuentas_pagar WHERE numero_comprobante <> public.fn_norm_correlativo(numero_comprobante);

-- ── 2) CHOQUES: mismo documento que quedaría repetido al quitar ceros ────────
--    (si sale alguna fila, NO corras el paso 3: avísame para revisarlas)
SELECT 'ventas' AS tabla, empresa_id, tipo_comprobante, serie, public.fn_norm_correlativo(correlativo) AS numero, count(*) AS veces, string_agg(id::text, ',') AS ids
FROM public.ventas GROUP BY 1,2,3,4,5 HAVING count(*) > 1 AND count(DISTINCT correlativo) > 1
UNION ALL
SELECT 'compras', empresa_id, tipo_comprobante, serie || ' / prov ' || contact_id, public.fn_norm_correlativo(numero), count(*), string_agg(id::text, ',')
FROM public.compras GROUP BY 1,2,3,4,5 HAVING count(*) > 1 AND count(DISTINCT numero) > 1
UNION ALL
SELECT 'cuentas_cobrar', empresa_id, tipo_comprobante, serie, public.fn_norm_correlativo(numero_comprobante), count(*), string_agg(id::text, ',')
FROM public.cuentas_cobrar GROUP BY 1,2,3,4,5 HAVING count(*) > 1 AND count(DISTINCT numero_comprobante) > 1
UNION ALL
SELECT 'cuentas_pagar', empresa_id, tipo_comprobante, serie || ' / prov ' || contact_id, public.fn_norm_correlativo(numero_comprobante), count(*), string_agg(id::text, ',')
FROM public.cuentas_pagar GROUP BY 1,2,3,4,5 HAVING count(*) > 1 AND count(DISTINCT numero_comprobante) > 1;

-- ── 3) NORMALIZAR + TRIGGER (bloque único) ───────────────────────────────────
BEGIN;

UPDATE public.ventas         SET correlativo        = public.fn_norm_correlativo(correlativo)        WHERE correlativo        <> public.fn_norm_correlativo(correlativo);
UPDATE public.cuentas_cobrar SET numero_comprobante = public.fn_norm_correlativo(numero_comprobante) WHERE numero_comprobante <> public.fn_norm_correlativo(numero_comprobante);
UPDATE public.compras        SET numero             = public.fn_norm_correlativo(numero)             WHERE numero             <> public.fn_norm_correlativo(numero);
UPDATE public.cuentas_pagar  SET numero_comprobante = public.fn_norm_correlativo(numero_comprobante) WHERE numero_comprobante <> public.fn_norm_correlativo(numero_comprobante);

-- Trigger: normaliza al insertar/editar (TG_ARGV[0] = columna)
CREATE OR REPLACE FUNCTION public.trg_norm_correlativo()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  v := to_jsonb(NEW) ->> TG_ARGV[0];
  IF v IS NOT NULL AND v <> public.fn_norm_correlativo(v) THEN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], public.fn_norm_correlativo(v)));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_norm_correlativo ON public.ventas;
CREATE TRIGGER trg_norm_correlativo BEFORE INSERT OR UPDATE OF correlativo ON public.ventas
  FOR EACH ROW EXECUTE FUNCTION public.trg_norm_correlativo('correlativo');
DROP TRIGGER IF EXISTS trg_norm_correlativo ON public.cuentas_cobrar;
CREATE TRIGGER trg_norm_correlativo BEFORE INSERT OR UPDATE OF numero_comprobante ON public.cuentas_cobrar
  FOR EACH ROW EXECUTE FUNCTION public.trg_norm_correlativo('numero_comprobante');
DROP TRIGGER IF EXISTS trg_norm_correlativo ON public.compras;
CREATE TRIGGER trg_norm_correlativo BEFORE INSERT OR UPDATE OF numero ON public.compras
  FOR EACH ROW EXECUTE FUNCTION public.trg_norm_correlativo('numero');
DROP TRIGGER IF EXISTS trg_norm_correlativo ON public.cuentas_pagar;
CREATE TRIGGER trg_norm_correlativo BEFORE INSERT OR UPDATE OF numero_comprobante ON public.cuentas_pagar
  FOR EACH ROW EXECUTE FUNCTION public.trg_norm_correlativo('numero_comprobante');

COMMIT;

-- ── 4) VERIFICACIÓN: debe dar 0 en las 4 tablas ──────────────────────────────
SELECT 'ventas' AS tabla, count(*) FROM public.ventas WHERE correlativo ~ '^0[0-9]{0,7}$' AND correlativo <> '0'
UNION ALL SELECT 'cuentas_cobrar', count(*) FROM public.cuentas_cobrar WHERE numero_comprobante ~ '^0[0-9]{0,7}$' AND numero_comprobante <> '0'
UNION ALL SELECT 'compras', count(*) FROM public.compras WHERE numero ~ '^0[0-9]{0,7}$' AND numero <> '0'
UNION ALL SELECT 'cuentas_pagar', count(*) FROM public.cuentas_pagar WHERE numero_comprobante ~ '^0[0-9]{0,7}$' AND numero_comprobante <> '0';
