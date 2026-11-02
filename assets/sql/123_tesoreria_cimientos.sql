-- ============================================================================
-- 123 · TESORERÍA — Cimientos (Etapa T0)  ·  2026-10-31
-- ----------------------------------------------------------------------------
-- Qué hace, en una línea: le pone a cada caja y a cada movimiento los tres ejes
-- que hoy no existen (ÁMBITO, CATEGORÍA real y SEDE) para poder separar lo de
-- la empresa de lo familiar sin que un filtro mal escrito lo mezcle en silencio.
--
-- Analogía: hoy el libro de caja es una sola bolsa. Esto no crea bolsas nuevas,
-- le pone etiqueta a cada billete que entra y sale: de dónde salió (caja),
-- para quién fue (ámbito) y de qué fue (categoría).
--
-- DECISIONES APLICADAS (ver claude/mapa_tesoreria_rrhh.md §4.1):
--   · "Familia" NO se crea como empresa. empresa_config tiene ruc NOT NULL
--     UNIQUE y alimenta NUBEFACT/series/PDT: meter un RUC ficticio ahí es
--     contaminar la tabla más sensible del sistema.
--   · En su lugar: columna `ambito` explícita + CHECK que hace IMPOSIBLE
--     guardar un registro inválido. Los filtros preguntan ambito='familiar'
--     (explícito), nunca empresa_id IS NULL (ambiguo: en SQL NULL = "no sé").
--   · Adjuntos: NO se crea tabla ni bucket. Se reutiliza `adjuntos` con
--     entidad='gasto' (convención existente {entidad}-{id}/, límite 10 MB,
--     ejecutables bloqueados). El máximo de 5 archivos se valida en la UI.
--   · Contabilidad FUERA DE ALCANCE: las cuentas contables quedan como
--     columna + comentario, sin lógica de asientos.
--
-- IDEMPOTENTE: se puede correr más de una vez sin duplicar nada.
-- NO BORRA NADA. Solo agrega columnas, tablas y filas de catálogo.
-- ============================================================================

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 0 · Chequeo previo — avisa si hay datos que impedirían los CHECK
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_bancos int; v_movs int;
BEGIN
  SELECT count(*) INTO v_bancos FROM public.bancos          WHERE empresa_id IS NULL;
  SELECT count(*) INTO v_movs   FROM public.movimientos_banco WHERE empresa_id IS NULL;
  IF v_bancos > 0 THEN
    RAISE NOTICE '⚠ % cuenta(s) en `bancos` sin empresa_id. Quedarán como ambito=''familiar''. Revísalas al final.', v_bancos;
  END IF;
  IF v_movs > 0 THEN
    RAISE NOTICE '⚠ % movimiento(s) sin empresa_id. Quedarán como ambito=''familiar''. Revísalos al final.', v_movs;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 1 · SEDES — multisede listo, aunque hoy haya una sola
-- ════════════════════════════════════════════════════════════════════════════
-- Luis: "este cliente solo tiene una sede, pero puedo tener otro con multisede
-- y no quiero desarrollar para ese caso". Patrón: campo listo, UI condicional.
-- Con una sola sede por empresa, el selector de sede NO se muestra.
CREATE TABLE IF NOT EXISTS public.sedes (
  id          serial      PRIMARY KEY,
  empresa_id  integer     NOT NULL REFERENCES public.empresa_config(id),
  codigo      varchar,
  nombre      varchar     NOT NULL,
  direccion   varchar,
  distrito    varchar,
  es_principal boolean    NOT NULL DEFAULT false,
  activo      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sedes_empresa ON public.sedes(empresa_id);

COMMENT ON TABLE  public.sedes IS 'Sedes/locales por empresa. Con una sola sede la UI oculta el selector.';
COMMENT ON COLUMN public.sedes.es_principal IS 'La sede por defecto al crear cajas y gastos.';

-- Una sede principal por empresa activa (idempotente)
INSERT INTO public.sedes (empresa_id, codigo, nombre, direccion, distrito, es_principal)
SELECT e.id, e.codigo, 'Sede principal', e.direccion, e.distrito, true
  FROM public.empresa_config e
 WHERE e.activo = true
   AND NOT EXISTS (SELECT 1 FROM public.sedes s WHERE s.empresa_id = e.id);

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 2 · BANCOS/CAJAS — ámbito, medio, fondo fijo, custodio, sede
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.bancos
  ADD COLUMN IF NOT EXISTS ambito             varchar,
  ADD COLUMN IF NOT EXISTS medio              varchar,
  ADD COLUMN IF NOT EXISTS sede_id            integer REFERENCES public.sedes(id),
  ADD COLUMN IF NOT EXISTS custodio_contact_id bigint REFERENCES public.contacts(id),
  ADD COLUMN IF NOT EXISTS es_fondo_fijo      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS monto_fondo_fijo   numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS saldo_minimo       numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.bancos.ambito IS
  'empresa | familiar. NO usar empresa_id IS NULL para detectar lo familiar: NULL en SQL significa "no sé", no "familia".';
COMMENT ON COLUMN public.bancos.medio IS
  'efectivo | yape | plin | banco. Yape es una caja más: se transfiere contra la caja efectivo sin tocar el banco.';
COMMENT ON COLUMN public.bancos.es_fondo_fijo IS
  'true = caja chica con monto asignado. La reposición repone HASTA monto_fondo_fijo. Evita el saldo negativo del Excel.';
COMMENT ON COLUMN public.bancos.saldo_minimo IS
  'Umbral de alerta: por debajo de esto, el sistema avisa que toca reponer.';

-- Backfill: lo que ya existe tiene empresa_id → es de empresa
UPDATE public.bancos SET ambito = CASE WHEN empresa_id IS NOT NULL THEN 'empresa' ELSE 'familiar' END
 WHERE ambito IS NULL;
UPDATE public.bancos SET medio = CASE WHEN tipo_cuenta = 'caja' THEN 'efectivo' ELSE 'banco' END
 WHERE medio IS NULL;
-- Las cajas existentes son caja chica solo si tú lo decides; se deja en false.
UPDATE public.bancos b SET sede_id = s.id
  FROM public.sedes s
 WHERE b.sede_id IS NULL AND s.empresa_id = b.empresa_id AND s.es_principal = true;

ALTER TABLE public.bancos ALTER COLUMN ambito SET NOT NULL;
ALTER TABLE public.bancos ALTER COLUMN medio  SET NOT NULL;

-- ★ EL CANDADO: hace imposible un registro en estado inválido.
--   La base rechaza el error en vez de producir un reporte mal en silencio.
ALTER TABLE public.bancos DROP CONSTRAINT IF EXISTS ck_bancos_ambito;
ALTER TABLE public.bancos ADD CONSTRAINT ck_bancos_ambito CHECK (
  (ambito = 'empresa'  AND empresa_id IS NOT NULL) OR
  (ambito = 'familiar' AND empresa_id IS NULL)
);
ALTER TABLE public.bancos DROP CONSTRAINT IF EXISTS ck_bancos_medio;
ALTER TABLE public.bancos ADD CONSTRAINT ck_bancos_medio
  CHECK (medio IN ('efectivo','yape','plin','banco'));

CREATE INDEX IF NOT EXISTS idx_bancos_ambito ON public.bancos(ambito);

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 3 · CATEGORÍAS DE GASTO — catálogo real (hoy es texto libre)
-- ════════════════════════════════════════════════════════════════════════════
-- En el Excel de la tesorera, "Categoría" y "Responsable" son el mismo dato
-- (ANN, OFICINA aparecen en ambas columnas) → hoy no se puede reportar por
-- ninguno de los dos. Aquí se separan: la categoría es DE QUÉ fue el gasto,
-- el responsable (contacts) es QUIÉN lo hizo o para quién fue.
CREATE TABLE IF NOT EXISTS public.categorias_gasto (
  id                  serial      PRIMARY KEY,
  codigo              varchar     NOT NULL UNIQUE,
  nombre              varchar     NOT NULL,
  ambito_sugerido     varchar,    -- empresa | familiar | NULL (sirve para ambos)
  destino_sugerido    varchar,    -- precarga el destino de costo en el modal
  deducible_defecto   boolean     NOT NULL DEFAULT true,
  cuenta_contable_id  integer     REFERENCES public.plan_cuentas(id),  -- ⚠ contabilidad fuera de alcance: columna lista, sin lógica
  orden               integer     NOT NULL DEFAULT 100,
  activo              boolean     NOT NULL DEFAULT true,
  created_at          timestamptz DEFAULT now()
);

COMMENT ON TABLE  public.categorias_gasto IS 'Catálogo de categorías de gasto. Reemplaza movimientos_banco.categoria (texto libre).';
COMMENT ON COLUMN public.categorias_gasto.destino_sugerido IS
  'Precarga el destino de costo. Clave del caso gasolina: misma categoría COMBUSTIBLE, distinto destino según el vehículo.';
COMMENT ON COLUMN public.categorias_gasto.cuenta_contable_id IS
  'PENDIENTE módulo contable. Columna creada para no migrar después; hoy nadie la lee.';

ALTER TABLE public.categorias_gasto DROP CONSTRAINT IF EXISTS ck_catgasto_ambito;
ALTER TABLE public.categorias_gasto ADD CONSTRAINT ck_catgasto_ambito
  CHECK (ambito_sugerido IS NULL OR ambito_sugerido IN ('empresa','familiar'));

ALTER TABLE public.categorias_gasto DROP CONSTRAINT IF EXISTS ck_catgasto_destino;
ALTER TABLE public.categorias_gasto ADD CONSTRAINT ck_catgasto_destino
  CHECK (destino_sugerido IS NULL OR destino_sugerido IN
    ('gasto_operativo','costo_venta','viatico_reembolsable','gasto_personal','no_deducible'));

-- Semilla tomada del Excel real de la tesorera (octubre 2026)
INSERT INTO public.categorias_gasto (codigo, nombre, ambito_sugerido, destino_sugerido, deducible_defecto, orden) VALUES
  ('OFICINA',     'Oficina y útiles',               'empresa',  'gasto_operativo',       true,  10),
  ('FERRETERIA',  'Ferretería y mantenimiento',     'empresa',  'gasto_operativo',       true,  20),
  ('SERVICIOS',   'Servicios (luz, agua, internet)','empresa',  'gasto_operativo',       true,  30),
  ('SUNAT_MUNI',  'SUNAT / Municipalidad / tasas',  'empresa',  'gasto_operativo',       true,  40),
  ('LEGAL',       'Legal y notarial',               'empresa',  'gasto_operativo',       true,  50),
  ('COMBUSTIBLE', 'Combustible',                    'empresa',  NULL,                    true,  60),
  ('CARGADORES',  'Personal de carga y estiba',     'empresa',  'costo_venta',           false, 70),
  ('PEAJES',      'Peajes y fletes de despacho',    'empresa',  'costo_venta',           true,  80),
  ('PASAJE',      'Pasajes y movilidad',            'empresa',  'viatico_reembolsable',  true,  90),
  ('ALIMENTACION','Alimentación del personal',      'empresa',  'gasto_personal',        false, 100),
  ('MERCADO',     'Mercado y abarrotes',            NULL,       'no_deducible',          false, 110),
  ('VALES',       'Vales y adelantos',              'empresa',  'gasto_operativo',       true,  120),
  ('REEMBOLSO',   'Reembolso a personal',           'empresa',  'viatico_reembolsable',  true,  130),
  ('SALUD_FAM',   'Salud familiar',                 'familiar', 'no_deducible',          false, 200),
  ('EDUCACION',   'Educación / colegio',            'familiar', 'no_deducible',          false, 210),
  ('HOGAR',       'Hogar y personales',             'familiar', 'no_deducible',          false, 220),
  ('OTROS',       'Otros',                          NULL,       'gasto_operativo',       true,  900)
ON CONFLICT (codigo) DO NOTHING;

COMMENT ON COLUMN public.categorias_gasto.deducible_defecto IS
  'false en CARGADORES/ALIMENTACION/MERCADO: sin comprobante de pago no hay gasto deducible (LIR art. 44 inc. j), da igual cómo se clasifique. El sistema igual registra el costo para gestión y lo reporta aparte.';

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 4 · MOVIMIENTOS_BANCO — los mismos tres ejes
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.movimientos_banco
  ADD COLUMN IF NOT EXISTS ambito                varchar,
  ADD COLUMN IF NOT EXISTS categoria_gasto_id    integer REFERENCES public.categorias_gasto(id),
  ADD COLUMN IF NOT EXISTS responsable_contact_id bigint REFERENCES public.contacts(id),
  ADD COLUMN IF NOT EXISTS sede_id               integer REFERENCES public.sedes(id);

COMMENT ON COLUMN public.movimientos_banco.categoria_gasto_id IS
  'Reemplaza gradualmente a `categoria` (texto libre). La columna vieja se mantiene por compatibilidad.';

UPDATE public.movimientos_banco
   SET ambito = CASE WHEN empresa_id IS NOT NULL THEN 'empresa' ELSE 'familiar' END
 WHERE ambito IS NULL;

ALTER TABLE public.movimientos_banco ALTER COLUMN ambito SET NOT NULL;

ALTER TABLE public.movimientos_banco DROP CONSTRAINT IF EXISTS ck_movbanco_ambito;
ALTER TABLE public.movimientos_banco ADD CONSTRAINT ck_movbanco_ambito CHECK (
  (ambito = 'empresa'  AND empresa_id IS NOT NULL) OR
  (ambito = 'familiar' AND empresa_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_movbanco_ambito    ON public.movimientos_banco(ambito);
CREATE INDEX IF NOT EXISTS idx_movbanco_categoria ON public.movimientos_banco(categoria_gasto_id);
CREATE INDEX IF NOT EXISTS idx_movbanco_fecha     ON public.movimientos_banco(fecha);

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 5 · ADJUNTOS — habilitar entidad 'gasto'
-- ════════════════════════════════════════════════════════════════════════════
-- No se crea tabla ni bucket: se reutiliza `adjuntos` (bucket tesoreria-adjuntos,
-- carpeta gasto-{id}/, 10 MB, ejecutables bloqueados). Máx. 5 archivos = UI.
--
-- OJO (corregido 2026-10-31): parchear el TEXTO del CHECK es frágil. Postgres
-- lo guarda reescrito como `= ANY (ARRAY[...]::character varying[])`, así que
-- pegar un valor al final lo deja FUERA del array y falla con
-- "argument of CHECK must be type boolean, not type record".
-- Solución: EXTRAER los valores actuales del ARRAY y reconstruir el CHECK
-- limpio. Así no se pisa lo que agregaron los SQL 94/116/122.
DO $$
DECLARE v_def text; v_vals text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint WHERE conname = 'adjuntos_entidad_check';

  IF v_def IS NULL THEN
    RAISE NOTICE '⚠ No existe adjuntos_entidad_check. ¿Falta correr el SQL 60/86? Se omite.';
  ELSIF v_def LIKE '%''gasto''%' THEN
    RAISE NOTICE '✔ adjuntos ya acepta entidad ''gasto''.';
  ELSE
    v_vals := (regexp_match(v_def, 'ARRAY\[(.*?)\]'))[1];
    v_vals := replace(v_vals, '::character varying', '');
    EXECUTE 'ALTER TABLE public.adjuntos DROP CONSTRAINT adjuntos_entidad_check';
    EXECUTE 'ALTER TABLE public.adjuntos ADD CONSTRAINT adjuntos_entidad_check '
         || 'CHECK (entidad IN (' || v_vals || ', ''gasto''))';
    RAISE NOTICE '✔ entidad ''gasto'' agregada a adjuntos.';
  END IF;
END $$;

-- Conceptos nuevos para el gasto (misma técnica)
DO $$
DECLARE v_def text; v_vals text;
        v_nuevos text[] := ARRAY['factura_gasto','boleta','vale','sin_documento'];
        v_c text; v_add text := '';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint WHERE conname = 'adjuntos_concepto_check';
  IF v_def IS NULL THEN
    RAISE NOTICE '⚠ No existe adjuntos_concepto_check. Se omite.';
    RETURN;
  END IF;

  FOREACH v_c IN ARRAY v_nuevos LOOP
    IF position('''' || v_c || '''' in v_def) = 0 THEN
      v_add := v_add || ', ''' || v_c || '''';
    END IF;
  END LOOP;

  IF v_add = '' THEN
    RAISE NOTICE '✔ adjuntos_concepto_check ya tiene los conceptos de gasto.';
  ELSE
    v_vals := (regexp_match(v_def, 'ARRAY\[(.*?)\]'))[1];
    v_vals := replace(v_vals, '::character varying', '');
    EXECUTE 'ALTER TABLE public.adjuntos DROP CONSTRAINT adjuntos_concepto_check';
    EXECUTE 'ALTER TABLE public.adjuntos ADD CONSTRAINT adjuntos_concepto_check '
         || 'CHECK (concepto IN (' || v_vals || v_add || '))';
    RAISE NOTICE '✔ conceptos de gasto agregados:%', v_add;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 6 · FIX de dato — BCP BENJI DOLARES está marcado en PEN
-- ════════════════════════════════════════════════════════════════════════════
-- Detectado en el diagnóstico del 2026-10-31. Solo corrige si sigue mal y
-- la cuenta no tiene movimientos (si los tiene, avisa y no toca nada).
DO $$
DECLARE v_movs int;
BEGIN
  IF EXISTS (SELECT 1 FROM public.bancos WHERE id = 10 AND nombre ILIKE '%BENJI%DOLARES%' AND moneda = 'PEN') THEN
    SELECT count(*) INTO v_movs FROM public.movimientos_banco WHERE banco_id = 10;
    IF v_movs = 0 THEN
      UPDATE public.bancos SET moneda = 'USD' WHERE id = 10;
      RAISE NOTICE '✔ BCP BENJI DOLARES corregido a USD (no tenía movimientos).';
    ELSE
      RAISE NOTICE '⚠ BCP BENJI DOLARES está en PEN pero tiene % movimiento(s). NO se tocó: corrígelo desde la UI revisando cada movimiento.', v_movs;
    END IF;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 7 · RLS (permisiva, igual que el resto del ERP)
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ PENDIENTE PRE-PRODUCCIÓN: endurecer junto con el resto (ver memoria
--   project_pendiente_rls_testing_preproduccion). Hoy se replica el patrón
--   vigente para no romper el acceso.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sedes','categorias_gasto'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL USING (true) WITH CHECK (true)', t || '_all', t);
  END LOOP;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN — pégame el resultado de estos 4 bloques
-- ════════════════════════════════════════════════════════════════════════════
SELECT '1. SEDES' AS bloque, s.id, e.codigo AS empresa, s.nombre, s.es_principal
  FROM public.sedes s JOIN public.empresa_config e ON e.id = s.empresa_id ORDER BY s.id;

SELECT '2. CAJAS Y BANCOS' AS bloque, id, nombre, tipo_cuenta, medio, ambito,
       empresa_id, sede_id, moneda, saldo_actual, es_fondo_fijo, monto_fondo_fijo
  FROM public.bancos ORDER BY ambito, medio, nombre;

SELECT '3. CATEGORÍAS' AS bloque, codigo, nombre, ambito_sugerido, destino_sugerido, deducible_defecto
  FROM public.categorias_gasto ORDER BY orden;

SELECT '4. CANDADOS' AS bloque, conname, pg_get_constraintdef(oid) AS definicion
  FROM pg_constraint
 WHERE conname IN ('ck_bancos_ambito','ck_movbanco_ambito','ck_bancos_medio','adjuntos_entidad_check')
 ORDER BY conname;
