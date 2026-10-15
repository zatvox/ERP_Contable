-- ============================================================================
-- 87 · MULTIEMPRESA — empresa_id, almacenes por empresa y candados (2026-10-14)
-- ----------------------------------------------------------------------------
-- Método: "kardex combinado". UNA sola base de datos, UN solo set de tablas,
-- y una columna `empresa_id` que actúa como el RUC impreso en cada caja del
-- almacén: la caja es física y está en el mismo galpón, pero se sabe de quién
-- es. Si una venta de Jhiro intenta sacar una caja de Benji, suena el candado.
--
-- DECISIONES DE LUIS (sesión 2026-10-13/14):
--   1. Switch estilo Odoo en la cabecera: varias empresas activas para LEER
--      (reportes combinados), UNA sola empresa de trabajo para ESCRIBIR.
--   2. Almacenes POR EMPRESA (opción 2): cada empresa tiene sus propios
--      almacenes y sus propias zonas. Con el switch en Benji, los selectores
--      de almacén/zona y de lote/stock sólo muestran lo de Benji.
--   3. items / contacts / plan_cuentas / tipos_cambio = CATÁLOGO COMPARTIDO.
--      Un solo menú de restaurante, tres despensas distintas. Es lo que
--      permite comparar costos y precios entre las 3 empresas.
--   4. Contabilidad queda en STAND BY: este modelo sirve para gestión
--      administrativa; los libros salen filtrados, no separados.
--
-- IDEMPOTENTE: se puede correr más de una vez. Tolera que el SQL 86
-- (ledger de importaciones) no se haya ejecutado todavía: las tablas que
-- no existen se saltan con NOTICE.
--
-- ⚠️ ANTES DE CORRER: edita los 3 RUC de la PARTE 0.
-- ============================================================================

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 0 · (YA NO APLICA — 2026-10-14)
-- ════════════════════════════════════════════════════════════════════════════
-- Aquí vivía una tabla de parámetros con los 3 RUC. Se eliminó: las empresas
-- JHIRO, BENJI y RAMA ya están creadas en `empresa_config`, y de aquí en
-- adelante los datos maestros de cada una se administran desde
-- Configuración → 🏢 Multiempresa (con validación de RUC y de duplicados),
-- no desde SQL.

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 1 · empresa_config pasa a ser LA TABLA DE EMPRESAS
-- ════════════════════════════════════════════════════════════════════════════
-- No se crea tabla nueva: `empresa_config` ya nació con todo lo que distingue
-- a una empresa de otra (RUC único, razón social, logo, token NUBEFACT propio,
-- series por defecto, cuentas contables, régimen). Era una tabla multiempresa
-- esperando filas. `empresa_config.id` ES el `empresa_id` de todo el sistema.

ALTER TABLE public.empresa_config
  ADD COLUMN IF NOT EXISTS codigo varchar,
  ADD COLUMN IF NOT EXISTS color  varchar NOT NULL DEFAULT '#2563eb',
  ADD COLUMN IF NOT EXISTS orden  integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS activo boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.empresa_config.codigo IS
  'Código corto de la empresa (JHIRO/BENJI/RAMA). Se usa en la UI y en los códigos de almacén.';
COMMENT ON COLUMN public.empresa_config.color IS
  'Color del badge en la cabecera. Truco antierror: con 2 empresas activas, el color es lo que evita emitir un documento en la empresa equivocada.';

-- Las filas de las empresas NO se crean aquí (ver PARTE 0): se administran
-- desde Configuración → 🏢 Multiempresa. Esta parte sólo deja la ESTRUCTURA
-- que el multiempresa necesita en la tabla.

CREATE UNIQUE INDEX IF NOT EXISTS idx_empresa_config_codigo
  ON public.empresa_config (codigo) WHERE codigo IS NOT NULL;

-- Limpieza por si una corrida anterior dejó la tabla de apoyo.
DROP TABLE IF EXISTS public._mx_param;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 2 · PERMISOS POR USUARIO (quién puede ver qué empresa)
-- ════════════════════════════════════════════════════════════════════════════
-- NULL en `empresas_permitidas` = ve todas (no rompe al admin actual).
-- Un array con ids = sólo esas. Ej. Lorena = {1} para que sólo vea Jhiro.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS empresas_permitidas integer[],
  ADD COLUMN IF NOT EXISTS empresa_id_default  integer REFERENCES public.empresa_config(id);

COMMENT ON COLUMN public.users.empresas_permitidas IS
  'ids de empresa_config que este usuario puede ver. NULL = todas. Se gestiona desde Configuración → Multiempresa.';
COMMENT ON COLUMN public.users.empresa_id_default IS
  'Empresa con la que arranca su sesión. NULL = la primera permitida.';

UPDATE public.users
   SET empresa_id_default = (SELECT id FROM public.empresa_config WHERE codigo = 'JHIRO')
 WHERE empresa_id_default IS NULL;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 3 · empresa_id EN LAS TABLAS DUEÑAS
-- ════════════════════════════════════════════════════════════════════════════
-- Tres categorías, y acertar aquí es el 80 % del éxito:
--
--   DUEÑAS      → columna propia. Son documentos o cosas físicas: pertenecen
--                 a UN RUC (ventas, compras, lotes, kardex, almacenes, CxC…).
--   HIJAS       → SIN columna, heredan por FK (detalle_*, lote_bultos,
--                 cuotas_*, diario_lineas, contenedores…). Preguntarle la
--                 empresa al padre es imposible de descuadrar; una columna
--                 propia SÍ se puede descuadrar.
--   COMPARTIDAS → SIN columna (items, contacts, plan_cuentas, tipos_cambio,
--                 terminos_pago, motivos_nota, partidas, categorias, marcas).
--
-- NOT NULL **SIN DEFAULT** a propósito: si un INSERT del JS se olvida de
-- empresa_id, queremos que REVIENTE y se vea, no que caiga en Jhiro en
-- silencio. Un dato mezclado que nadie nota es exactamente el problema de
-- Odoo que estamos huyendo.

BEGIN;

DO $$
DECLARE
  v_jhiro integer;
  t       text;
  n       bigint;
  faltan  bigint;
  -- Tablas DUEÑAS. Las de importaciones (SQL 86) se saltan solas si aún no existen.
  tablas  text[] := ARRAY[
    -- Ventas y compras
    'ventas','compras','packing','orden_compra','sales_quotes',
    'guias_ingreso_compra','guias_despacho_venta','guias_devolucion_compra','guias_remision',
    -- Inventario
    'lotes','kardex','almacenes','familias',
    -- Cobranzas / tesorería
    'cuentas_cobrar','cuentas_pagar','cobros','cobros_lote','pagos','pagos_proveedores',
    'letras_cambio','letras_refinanciacion','bancos','movimientos_banco',
    -- Documentos y correlativos
    'series_documentos','secuencias_documentos',
    -- Contabilidad (stand by, pero el dato nace con dueño)
    'journal_entries','diarios','periodos_contables','pdt621_declaraciones',
    -- Importaciones (SQL 86)
    'carpetas_importacion','comercial_invoices','bill_of_ladings','dams',
    'documentos_importacion','gastos_locales','importacion_parametros'
  ];
BEGIN
  -- Empresa base: la que tenga codigo 'JHIRO' y, si ninguna lo tiene, la de id menor.
  SELECT COALESCE(
           (SELECT id FROM public.empresa_config WHERE codigo = 'JHIRO'),
           (SELECT MIN(id) FROM public.empresa_config)
         ) INTO v_jhiro;
  IF v_jhiro IS NULL THEN
    RAISE EXCEPTION 'empresa_config está vacía: crea al menos la empresa base antes de correr este script.';
  END IF;
  RAISE NOTICE 'Empresa base (JHIRO) = id %', v_jhiro;

  FOREACH t IN ARRAY tablas LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema='public' AND table_name=t) THEN
      RAISE NOTICE '  — %: no existe todavía (¿SQL 86 sin correr?), se salta', t;
      CONTINUE;
    END IF;

    -- 1) columna
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS empresa_id integer REFERENCES public.empresa_config(id)', t);

    -- 2) backfill: todo lo que existe hoy es de Jhiro
    EXECUTE format('UPDATE public.%I SET empresa_id = $1 WHERE empresa_id IS NULL', t) USING v_jhiro;
    GET DIAGNOSTICS n = ROW_COUNT;

    -- 3) NOT NULL (sin default) + índice de filtrado
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN empresa_id SET NOT NULL', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_empresa ON public.%I (empresa_id)', t, t);

    RAISE NOTICE '  ✓ %: % fila(s) asignada(s) a JHIRO', t, n;
  END LOOP;

  -- Control: ninguna tabla dueña debe quedar sin la columna
  SELECT COUNT(*) INTO faltan
    FROM unnest(tablas) AS x(t)
    JOIN information_schema.tables it
      ON it.table_schema='public' AND it.table_name = x.t
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns c
                      WHERE c.table_schema='public' AND c.table_name=x.t AND c.column_name='empresa_id');
  RAISE NOTICE 'Tablas dueñas existentes SIN empresa_id: %  (debe ser 0)', faltan;
END $$;

-- El índice único de lotes incluye la empresa: dos empresas pueden tener el
-- mismo texto de lote del mismo fabricante sin chocar (pasa seguido con hilo
-- importado del mismo proveedor — justo el caso de Jhiro/Benji).
DROP INDEX IF EXISTS public.idx_lotes_item_numlote_compra;
CREATE UNIQUE INDEX IF NOT EXISTS idx_lotes_empresa_item_numlote_compra
  ON public.lotes (empresa_id, item_id, numero_lote, compra_id);
COMMENT ON INDEX public.idx_lotes_empresa_item_numlote_compra IS
  'Identificación específica por adquisición (LIR Art. 62 inc. c / NIC 2 párr. 24), ahora acotada a la empresa: el mismo numero_lote puede existir en Jhiro y en Benji como dos lotes distintos con su propio costo.';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 4 · detalle_packing.lote_id — el PK retroactivo trae producto + lote
-- ════════════════════════════════════════════════════════════════════════════
-- La importación masiva de packings de Benji es retroactiva: ya se sabe de
-- qué lote salió cada línea. Hoy `detalle_packing` sólo guarda item_id.

BEGIN;

ALTER TABLE public.detalle_packing
  ADD COLUMN IF NOT EXISTS lote_id bigint REFERENCES public.lotes(id);
CREATE INDEX IF NOT EXISTS idx_detalle_packing_lote ON public.detalle_packing(lote_id);
COMMENT ON COLUMN public.detalle_packing.lote_id IS
  'Lote de referencia de la línea (informativo, igual que en detalle_ventas: el PK no mueve stock). Lo usa la importación masiva retroactiva y la sugerencia de costo/unidades al facturar.';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 5 · ALMACENES Y ZONAS POR EMPRESA (opción 2 de Luis)
-- ════════════════════════════════════════════════════════════════════════════
-- El galpón de SJL es uno físico, pero cada empresa tiene su propio almacén
-- lógico con sus propias zonas (A, B, 90…). Así, con el switch en Benji los
-- selectores de almacén/zona muestran las zonas de Benji y no las de Jhiro.
-- Esto además respeta el establecimiento declarado por RUC ante SUNAT y deja
-- la puerta abierta a que cada empresa emita sus propias guías de remisión.
--
-- El código de almacén deja de ser único global y pasa a ser único POR
-- EMPRESA: las tres pueden tener su 'ALM-01' y su 'PARTNERS'.

BEGIN;

ALTER TABLE public.almacenes DROP CONSTRAINT IF EXISTS almacenes_codigo_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_almacenes_empresa_codigo
  ON public.almacenes (empresa_id, codigo);

DO $$
DECLARE
  v_jhiro integer;
  e       record;
  a       record;
  v_new   integer;
  n_alm   integer;
  n_zon   integer;
BEGIN
  -- Empresa base: la que tenga codigo 'JHIRO' y, si ninguna lo tiene, la de id menor.
  SELECT COALESCE(
           (SELECT id FROM public.empresa_config WHERE codigo = 'JHIRO'),
           (SELECT MIN(id) FROM public.empresa_config)
         ) INTO v_jhiro;

  FOR e IN SELECT id, codigo FROM public.empresa_config
            WHERE id <> v_jhiro AND activo ORDER BY orden LOOP
    n_alm := 0; n_zon := 0;

    -- Clona la estructura de almacenes de Jhiro (incluye el virtual PARTNERS,
    -- que es obligatorio: sin él el kardex de esa empresa no tiene un origen
    -- externo de dónde entrar la mercadería comprada).
    FOR a IN SELECT * FROM public.almacenes WHERE empresa_id = v_jhiro ORDER BY id LOOP
      SELECT id INTO v_new FROM public.almacenes
       WHERE empresa_id = e.id AND codigo = a.codigo;

      IF v_new IS NULL THEN
        INSERT INTO public.almacenes
          (codigo, nombre, direccion, ubigeo, establecimiento_sunat, es_principal, activo, es_virtual, empresa_id)
        VALUES
          (a.codigo, a.nombre, a.direccion, a.ubigeo, a.establecimiento_sunat,
           a.es_principal, a.activo, a.es_virtual, e.id)
        RETURNING id INTO v_new;
        n_alm := n_alm + 1;
      END IF;

      -- Clona las zonas de ese almacén (A, B, 90, VENDORS, CUSTOMERS…)
      INSERT INTO public.ubicaciones (almacen_id, codigo, nombre, tipo, activo)
      SELECT v_new, u.codigo, u.nombre, u.tipo, u.activo
        FROM public.ubicaciones u
       WHERE u.almacen_id = a.id
         AND NOT EXISTS (SELECT 1 FROM public.ubicaciones x
                          WHERE x.almacen_id = v_new AND x.codigo = u.codigo);
      n_zon := n_zon + (SELECT COUNT(*) FROM public.ubicaciones WHERE almacen_id = v_new);
    END LOOP;

    RAISE NOTICE '  ✓ %: % almacén(es) nuevo(s), % zona(s) en total', e.codigo, n_alm, n_zon;
  END LOOP;
END $$;

COMMENT ON COLUMN public.almacenes.empresa_id IS
  'Dueño del almacén. Un mismo galpón físico se modela como un almacén lógico por empresa (decisión 2026-10-14): los selectores de zona y de stock se filtran por la empresa de trabajo.';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 5.5 · ubicaciones.empresa_id — para que los SELECTORES de zona filtren
-- ════════════════════════════════════════════════════════════════════════════
-- `ubicaciones` es hija de `almacenes`, así que en teoría hereda la empresa por
-- FK y no necesita columna. En la práctica sí: los selectores de zona del ERP
-- leen `ubicaciones` directo, y sin columna propia el filtro central no puede
-- recortarlos → con el switch en Benji verías las zonas de Jhiro.
--
-- Se denormaliza, pero con trigger: la columna NO se puede escribir a mano,
-- siempre la calcula el almacén. Es un dato copiado que no puede desviarse —
-- el mismo criterio que `stock_ubicaciones` siendo vista del kardex.

BEGIN;

ALTER TABLE public.ubicaciones
  ADD COLUMN IF NOT EXISTS empresa_id integer REFERENCES public.empresa_config(id);

UPDATE public.ubicaciones u
   SET empresa_id = a.empresa_id
  FROM public.almacenes a
 WHERE a.id = u.almacen_id
   AND (u.empresa_id IS NULL OR u.empresa_id <> a.empresa_id);

ALTER TABLE public.ubicaciones ALTER COLUMN empresa_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ubicaciones_empresa ON public.ubicaciones (empresa_id);

CREATE OR REPLACE FUNCTION public.fn_mx_ubicacion_empresa()
RETURNS trigger AS $fn$
BEGIN
  SELECT empresa_id INTO NEW.empresa_id FROM public.almacenes WHERE id = NEW.almacen_id;
  IF NEW.empresa_id IS NULL THEN
    RAISE EXCEPTION 'MULTIEMPRESA: el almacén % no existe o no tiene empresa.', NEW.almacen_id;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mx_ubicacion_empresa ON public.ubicaciones;
CREATE TRIGGER trg_mx_ubicacion_empresa
  BEFORE INSERT OR UPDATE OF almacen_id, empresa_id ON public.ubicaciones
  FOR EACH ROW EXECUTE FUNCTION public.fn_mx_ubicacion_empresa();

COMMENT ON COLUMN public.ubicaciones.empresa_id IS
  'Copia de almacenes.empresa_id mantenida por trigger (nunca se escribe a mano). Existe sólo para que los selectores de zona se puedan filtrar por la empresa de trabajo.';

-- Si un almacén cambiara de empresa, sus zonas deben seguirlo.
CREATE OR REPLACE FUNCTION public.fn_mx_almacen_propaga_empresa()
RETURNS trigger AS $fn$
BEGIN
  IF NEW.empresa_id IS DISTINCT FROM OLD.empresa_id THEN
    UPDATE public.ubicaciones SET empresa_id = NEW.empresa_id WHERE almacen_id = NEW.id;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mx_almacen_propaga_empresa ON public.almacenes;
CREATE TRIGGER trg_mx_almacen_propaga_empresa
  AFTER UPDATE OF empresa_id ON public.almacenes
  FOR EACH ROW EXECUTE FUNCTION public.fn_mx_almacen_propaga_empresa();

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 6 · SERIES Y CORRELATIVOS POR EMPRESA
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠️ IMPORTANTE: hoy el correlativo PK es uno solo compartido (va en PK-018642
-- porque arrastra la numeración histórica de Jhiro). Con 3 empresas, Benji NO
-- puede seguir la numeración de Jhiro: cada empresa arranca su propia serie
-- desde 0. Si Benji debe continuar una numeración histórica propia, ajusta su
-- `ultimo_correlativo` desde Configuración → Series y correlativos.

BEGIN;

ALTER TABLE public.series_documentos
  DROP CONSTRAINT IF EXISTS series_documentos_tipo_documento_serie_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_series_empresa_tipo_serie
  ON public.series_documentos (empresa_id, tipo_documento, serie);

-- "Una sola serie por defecto" también era una regla GLOBAL, y hay que
-- soltarla ANTES de clonar: las series de Jhiro vienen con por_defecto = true,
-- así que al copiarlas a Benji el índice viejo las rechaza. Es el error
-- 23505 sobre ux_series_default.
--
-- Se conserva `COALESCE(aplica_a, '')` en la clave: NC y ND tienen DOS series
-- por defecto por tipo (una para Factura y otra para Boleta — FNC1/BBCC), y
-- sin esa parte de la clave sólo se podría marcar una.
DROP INDEX IF EXISTS public.ux_series_default;
CREATE UNIQUE INDEX IF NOT EXISTS ux_series_default_empresa
  ON public.series_documentos (empresa_id, tipo_documento, COALESCE(aplica_a, ''))
  WHERE por_defecto;
COMMENT ON INDEX public.ux_series_default_empresa IS
  'Una sola serie por defecto por empresa + tipo de documento (+ aplica_a para NC/ND). Reemplaza a ux_series_default, que era global y bloqueaba clonar las series a una segunda empresa.';

DO $$
DECLARE
  v_jhiro integer;
  e       record;
  n       integer;
BEGIN
  -- Empresa base: la que tenga codigo 'JHIRO' y, si ninguna lo tiene, la de id menor.
  SELECT COALESCE(
           (SELECT id FROM public.empresa_config WHERE codigo = 'JHIRO'),
           (SELECT MIN(id) FROM public.empresa_config)
         ) INTO v_jhiro;

  FOR e IN SELECT id, codigo FROM public.empresa_config
            WHERE id <> v_jhiro AND activo ORDER BY orden LOOP
    INSERT INTO public.series_documentos
      (tipo_documento, serie, descripcion, correlativo_inicial, ultimo_correlativo,
       digitos, es_cpe, aplica_a, dias_validez, por_defecto, activo, empresa_id)
    SELECT s.tipo_documento, s.serie, s.descripcion, 1, 0,
           s.digitos, s.es_cpe, s.aplica_a, s.dias_validez, s.por_defecto, s.activo, e.id
      FROM public.series_documentos s
     WHERE s.empresa_id = v_jhiro
       AND NOT EXISTS (SELECT 1 FROM public.series_documentos x
                        WHERE x.empresa_id = e.id
                          AND x.tipo_documento = s.tipo_documento
                          AND x.serie = s.serie);
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE '  ✓ %: % serie(s) creada(s) con correlativo en 0', e.codigo, n;
  END LOOP;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 6.5 · LOS UNIQUE GLOBALES PASAN A SER UNIQUE POR EMPRESA
-- ════════════════════════════════════════════════════════════════════════════
-- Esta es la trampa silenciosa de toda migración a multiempresa: el esquema
-- se diseñó para una sola empresa, así que "N° de documento único" significa
-- único en TODO el sistema. El día que Benji emita su FFFI-00000001, choca
-- con la de Jhiro y el error que ves es un genérico de duplicado, no un
-- "ya existe en otra empresa".
--
-- Es como tener un solo libro de actas para tres empresas: no hay dos actas
-- N° 1. La regla correcta es "único POR EMPRESA".

BEGIN;

DO $$
DECLARE
  r record;
  -- tabla, nombre del constraint actual, columnas que forman la clave
  reglas text[][] := ARRAY[
    ARRAY['ventas',               'ventas_numero_key',                'numero'],
    ARRAY['compras',              'compras_referencia_key',           'referencia'],
    ARRAY['packing',              'packing_numero_key',               'numero'],
    ARRAY['packing',              'packing_serie_correlativo_key',    'serie, correlativo'],
    ARRAY['orden_compra',         'orden_compra_numero_key',          'numero'],
    ARRAY['letras_cambio',        'letras_cambio_numero_letra_key',   'numero_letra'],
    ARRAY['periodos_contables',   'periodos_contables_periodo_key',   'periodo'],
    ARRAY['journal_entries',      'journal_entries_numero_asiento_key','numero_asiento'],
    ARRAY['familias',             'familias_nombre_key',              'nombre']
  ];
  i int;
  v_idx text;
BEGIN
  FOR i IN 1 .. array_length(reglas, 1) LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema='public' AND table_name = reglas[i][1]) THEN
      RAISE NOTICE '  — %: no existe, se salta', reglas[i][1];
      CONTINUE;
    END IF;

    -- Suelta el UNIQUE global (si todavía está)
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
                   reglas[i][1], reglas[i][2]);

    -- Y lo vuelve a crear acotado a la empresa
    v_idx := 'ux_' || reglas[i][1] || '_empresa_' ||
             replace(replace(reglas[i][3], ', ', '_'), ' ', '');
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I (empresa_id, %s)',
                   v_idx, reglas[i][1], reglas[i][3]);
    RAISE NOTICE '  ✓ %: único por (empresa_id, %)', reglas[i][1], reglas[i][3];
  END LOOP;
END $$;

-- (El índice ux_series_default se trata en la PARTE 6, antes de clonar las
--  series: si se hiciera aquí, la clonación de la PARTE 6 ya habría chocado.)

-- Referencias de apertura de Odoo: la misma referencia puede repetirse entre
-- empresas (cada una trae su propia apertura).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_cxc_asiento_odoo') THEN
    DROP INDEX public.idx_cxc_asiento_odoo;
    CREATE UNIQUE INDEX idx_cxc_asiento_odoo_empresa
      ON public.cuentas_cobrar (empresa_id, asiento_odoo) WHERE asiento_odoo IS NOT NULL;
    RAISE NOTICE '  ✓ cuentas_cobrar.asiento_odoo: único por empresa';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_cxp_asiento_contact_cuenta') THEN
    DROP INDEX public.idx_cxp_asiento_contact_cuenta;
    CREATE UNIQUE INDEX idx_cxp_asiento_contact_cuenta_empresa
      ON public.cuentas_pagar (empresa_id, asiento_odoo, contact_id, referencia_cuenta)
      WHERE asiento_odoo IS NOT NULL;
    RAISE NOTICE '  ✓ cuentas_pagar.asiento_odoo: único por empresa';
  END IF;
  -- SQL 86 (ledger de importaciones): comprobante único por proveedor
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_docimp_comprobante_uk') THEN
    RAISE NOTICE '  ⚠ idx_docimp_comprobante_uk existe: revísalo a mano al correr el SQL 86 (debe incluir empresa_id)';
  END IF;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 7 · LOS CANDADOS (lo que hace real al multiempresa)
-- ════════════════════════════════════════════════════════════════════════════
-- Mismo patrón que el trigger del ledger de importaciones (SQL 86): la regla
-- vive en la BD, no sólo en la pantalla. Sin esto el multiempresa es
-- decorativo — basta un bug en un selector para que Jhiro venda stock de
-- Benji y nadie se entere hasta el cierre.

BEGIN;

-- ── 7.1 · Candado maestro: el kardex no cruza empresas ──────────────────────
CREATE OR REPLACE FUNCTION public.fn_mx_kardex_coherente()
RETURNS trigger AS $fn$
DECLARE
  v_emp_lote integer;
  v_emp_ori  integer;
  v_emp_des  integer;
BEGIN
  IF NEW.lote_id IS NOT NULL THEN
    SELECT empresa_id INTO v_emp_lote FROM public.lotes WHERE id = NEW.lote_id;
    IF v_emp_lote IS DISTINCT FROM NEW.empresa_id THEN
      RAISE EXCEPTION
        'MULTIEMPRESA: el movimiento de kardex es de la empresa % pero el lote % pertenece a la empresa %.',
        NEW.empresa_id, NEW.lote_id, v_emp_lote
        USING HINT = 'Un documento sólo puede mover lotes de su propia empresa. Revisa el switch de empresa en la cabecera.';
    END IF;
  END IF;

  IF NEW.ubicacion_origen_id IS NOT NULL THEN
    SELECT a.empresa_id INTO v_emp_ori
      FROM public.ubicaciones u JOIN public.almacenes a ON a.id = u.almacen_id
     WHERE u.id = NEW.ubicacion_origen_id;
    IF v_emp_ori IS DISTINCT FROM NEW.empresa_id THEN
      RAISE EXCEPTION
        'MULTIEMPRESA: la zona de origen % pertenece a la empresa % y el movimiento es de la empresa %.',
        NEW.ubicacion_origen_id, v_emp_ori, NEW.empresa_id
        USING HINT = 'Cada empresa tiene sus propios almacenes y zonas (incluido su Partners/Vendors).';
    END IF;
  END IF;

  IF NEW.ubicacion_destino_id IS NOT NULL THEN
    SELECT a.empresa_id INTO v_emp_des
      FROM public.ubicaciones u JOIN public.almacenes a ON a.id = u.almacen_id
     WHERE u.id = NEW.ubicacion_destino_id;
    IF v_emp_des IS DISTINCT FROM NEW.empresa_id THEN
      RAISE EXCEPTION
        'MULTIEMPRESA: la zona de destino % pertenece a la empresa % y el movimiento es de la empresa %.',
        NEW.ubicacion_destino_id, v_emp_des, NEW.empresa_id
        USING HINT = 'Cada empresa tiene sus propios almacenes y zonas (incluido su Partners/Vendors).';
    END IF;
  END IF;

  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mx_kardex_coherente ON public.kardex;
CREATE TRIGGER trg_mx_kardex_coherente
  BEFORE INSERT OR UPDATE ON public.kardex
  FOR EACH ROW EXECUTE FUNCTION public.fn_mx_kardex_coherente();

COMMENT ON FUNCTION public.fn_mx_kardex_coherente() IS
  'Candado maestro del multiempresa: kardex.empresa_id debe coincidir con la empresa del lote movido y con la de las zonas de origen/destino. Es el equivalente del candado de clasificación del ledger de importaciones (SQL 86).';

-- ── 7.2 · Candado genérico de líneas: la hija no cruza a la empresa del padre ──
-- Un solo trigger reutilizable. Recibe (tabla_padre, columna_fk) y valida el
-- lote_id y/o ubicacion_id que traiga la línea contra la empresa del padre.
CREATE OR REPLACE FUNCTION public.fn_mx_linea_coherente()
RETURNS trigger AS $fn$
DECLARE
  j           jsonb   := to_jsonb(NEW);
  v_padre_tab text    := TG_ARGV[0];
  v_padre_fk  text    := TG_ARGV[1];
  v_padre_id  bigint;
  v_emp_padre integer;
  v_lote_id   bigint;
  v_emp_lote  integer;
  v_ubic_id   bigint;
  v_emp_ubic  integer;
BEGIN
  v_padre_id := NULLIF(j ->> v_padre_fk, '')::bigint;
  IF v_padre_id IS NULL THEN RETURN NEW; END IF;

  EXECUTE format('SELECT empresa_id FROM public.%I WHERE id = $1', v_padre_tab)
     INTO v_emp_padre USING v_padre_id;
  IF v_emp_padre IS NULL THEN RETURN NEW; END IF;

  -- La hija que TIENE su propio empresa_id (cobros, pagos_proveedores,
  -- cuotas_*) debe coincidir con el del padre. Sin esto un cobro podría
  -- quedar registrado en Benji contra una factura de Jhiro.
  IF (j ? 'empresa_id') AND NULLIF(j ->> 'empresa_id','')::integer IS DISTINCT FROM v_emp_padre THEN
    RAISE EXCEPTION
      'MULTIEMPRESA: el registro de % es de la empresa % pero el documento %.% al que se aplica es de la empresa %.',
      TG_TABLE_NAME, (j ->> 'empresa_id'), v_padre_tab, v_padre_id, v_emp_padre
      USING HINT = 'Un cobro/pago/cuota pertenece a la misma empresa que el documento que liquida.';
  END IF;

  v_lote_id := NULLIF(j ->> 'lote_id', '')::bigint;
  IF v_lote_id IS NOT NULL THEN
    SELECT empresa_id INTO v_emp_lote FROM public.lotes WHERE id = v_lote_id;
    IF v_emp_lote IS DISTINCT FROM v_emp_padre THEN
      RAISE EXCEPTION
        'MULTIEMPRESA: una línea de % apunta al lote % (empresa %) pero el documento es de la empresa %.',
        TG_TABLE_NAME, v_lote_id, v_emp_lote, v_emp_padre
        USING HINT = 'El selector de lotes debe mostrar sólo el stock de la empresa de trabajo.';
    END IF;
  END IF;

  v_ubic_id := NULLIF(j ->> 'ubicacion_id', '')::bigint;
  IF v_ubic_id IS NOT NULL THEN
    SELECT a.empresa_id INTO v_emp_ubic
      FROM public.ubicaciones u JOIN public.almacenes a ON a.id = u.almacen_id
     WHERE u.id = v_ubic_id;
    IF v_emp_ubic IS DISTINCT FROM v_emp_padre THEN
      RAISE EXCEPTION
        'MULTIEMPRESA: una línea de % apunta a la zona % (empresa %) pero el documento es de la empresa %.',
        TG_TABLE_NAME, v_ubic_id, v_emp_ubic, v_emp_padre;
    END IF;
  END IF;

  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

DO $$
DECLARE
  r record;
  pares text[][] := ARRAY[
    ARRAY['detalle_ventas',                  'ventas',                   'venta_id'],
    ARRAY['detalle_compras',                 'compras',                  'compra_id'],
    ARRAY['detalle_packing',                 'packing',                  'packing_id'],
    ARRAY['detalle_guias_ingreso_compra',    'guias_ingreso_compra',     'guia_id'],
    ARRAY['detalle_guias_despacho_venta',    'guias_despacho_venta',     'guia_id'],
    ARRAY['detalle_guias_devolucion_compra', 'guias_devolucion_compra',  'guia_id'],
    ARRAY['cuotas_cobrar',                   'cuentas_cobrar',           'cxc_id'],
    ARRAY['cuotas_pagar',                    'cuentas_pagar',            'cxp_id'],
    ARRAY['cobros',                          'cuentas_cobrar',           'cxc_id'],
    ARRAY['pagos_proveedores',               'cuentas_pagar',            'cxp_id']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(pares, 1) LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema='public' AND table_name = pares[i][1]) THEN
      RAISE NOTICE '  — %: no existe, se salta', pares[i][1];
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name = pares[i][1]
                      AND column_name = pares[i][3]) THEN
      RAISE NOTICE '  — %: no tiene la columna %, se salta', pares[i][1], pares[i][3];
      CONTINUE;
    END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS trg_mx_linea_coherente ON public.%I', pares[i][1]);
    EXECUTE format(
      'CREATE TRIGGER trg_mx_linea_coherente BEFORE INSERT OR UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.fn_mx_linea_coherente(%L, %L)',
      pares[i][1], pares[i][2], pares[i][3]);
    RAISE NOTICE '  ✓ candado en % (padre: %.%)', pares[i][1], pares[i][2], pares[i][3];
  END LOOP;
END $$;

-- ── 7.3 · El lote vive en un almacén de su propia empresa ───────────────────
CREATE OR REPLACE FUNCTION public.fn_mx_lote_coherente()
RETURNS trigger AS $fn$
DECLARE v_emp integer;
BEGIN
  IF NEW.ubicacion_id IS NOT NULL THEN
    SELECT a.empresa_id INTO v_emp
      FROM public.ubicaciones u JOIN public.almacenes a ON a.id = u.almacen_id
     WHERE u.id = NEW.ubicacion_id;
    IF v_emp IS DISTINCT FROM NEW.empresa_id THEN
      RAISE EXCEPTION 'MULTIEMPRESA: el lote es de la empresa % pero su zona pertenece a la empresa %.',
        NEW.empresa_id, v_emp;
    END IF;
  END IF;
  IF NEW.almacen_id IS NOT NULL THEN
    SELECT empresa_id INTO v_emp FROM public.almacenes WHERE id = NEW.almacen_id;
    IF v_emp IS DISTINCT FROM NEW.empresa_id THEN
      RAISE EXCEPTION 'MULTIEMPRESA: el lote es de la empresa % pero su almacén pertenece a la empresa %.',
        NEW.empresa_id, v_emp;
    END IF;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mx_lote_coherente ON public.lotes;
CREATE TRIGGER trg_mx_lote_coherente
  BEFORE INSERT OR UPDATE ON public.lotes
  FOR EACH ROW EXECUTE FUNCTION public.fn_mx_lote_coherente();

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 8 · VISTAS CON empresa_id
-- ════════════════════════════════════════════════════════════════════════════
-- Una vista no hereda columnas nuevas de su tabla base: hay que exponerlas.
-- Se recrean las 8 vistas que el JS realmente consume.
--
-- ⚠️ REGLA DE POSTGRES: `CREATE OR REPLACE VIEW` sólo admite columnas nuevas
-- AL FINAL. Meter `empresa_id` en medio de la lista renombra la columna que
-- estaba en esa posición y Postgres lo rechaza con
--   42P16: cannot change name of view column "created_at" to "empresa_id"
-- Por eso `empresa_id` va SIEMPRE como última columna de cada vista, aunque se
-- lea raro. La alternativa sería DROP + CREATE, pero eso arrastra cualquier
-- objeto que dependa de la vista; reemplazar en sitio no toca nada.
--
-- El cambio es puramente ADITIVO: todo lo que cada pantalla ya leía sigue
-- estando, con el mismo nombre y en la misma posición.

BEGIN;

-- 8.1 · stock_ubicaciones — la vista más usada del sistema (105 llamadas).
--       El dueño del stock es el LOTE, así que la empresa sale de ahí.
CREATE OR REPLACE VIEW public.stock_ubicaciones AS
WITH mov AS (
  SELECT lote_id, ubicacion_destino_id AS ubicacion_id,
         cantidad_entrada AS cant, cantidad_unidades_entrada AS uni
    FROM public.kardex WHERE ubicacion_destino_id IS NOT NULL
  UNION ALL
  SELECT lote_id, ubicacion_origen_id AS ubicacion_id,
         -cantidad_salida AS cant, -cantidad_unidades_salida AS uni
    FROM public.kardex WHERE ubicacion_origen_id IS NOT NULL
),
calc AS (
  SELECT mov.lote_id, mov.ubicacion_id,
         SUM(mov.cant) AS cantidad, SUM(mov.uni) AS cantidad_unidades
    FROM mov
    JOIN public.ubicaciones u ON u.id = mov.ubicacion_id
    JOIN public.almacenes   a ON a.id = u.almacen_id
   WHERE a.es_virtual = false
   GROUP BY mov.lote_id, mov.ubicacion_id
  HAVING ROUND(SUM(mov.cant)::numeric, 4) > 0
)
SELECT
  row_number() OVER (ORDER BY calc.lote_id, calc.ubicacion_id)::bigint AS id,
  calc.lote_id,
  calc.ubicacion_id,
  ROUND(calc.cantidad::numeric, 4)                       AS cantidad,
  GREATEST(ROUND(calc.cantidad_unidades::numeric, 4), 0) AS cantidad_unidades,
  now() AS created_at,
  now() AS updated_at,
  l.empresa_id
FROM calc
JOIN public.lotes l ON l.id = calc.lote_id;

COMMENT ON VIEW public.stock_ubicaciones IS
  'Stock por lote y zona calculado desde el kardex (nunca se desincroniza). Multiempresa: empresa_id viene del lote, que es el dueño del stock.';

-- 8.2 · Stock por bultos
CREATE OR REPLACE VIEW public.v_stock_bultos_zona AS
SELECT b.lote_id, b.ubicacion_id,
       COUNT(*)      AS cantidad_unidades,
       SUM(b.peso)   AS cantidad,
       l.empresa_id
  FROM public.lote_bultos b
  JOIN public.lotes l ON l.id = b.lote_id
 WHERE b.estado IN ('disponible','custodiado')
 GROUP BY b.lote_id, b.ubicacion_id, l.empresa_id;

-- 8.3 · Registro de Ventas (Formato 14.1). Ahora se emite POR EMPRESA.
CREATE OR REPLACE VIEW public.v_registro_ventas AS
SELECT
  v.id,
  REPLACE(v.periodo_contable, '-', '')  AS periodo,
  v.fecha_emision, v.tipo_comprobante, v.serie, v.correlativo, v.numero,
  ct.tipo_documento                     AS tipo_doc_cliente,
  ct.nro_documento                      AS nro_doc_cliente,
  ct.nombre                             AS razon_social_cliente,
  COALESCE(v.base_imponible, 0)         AS base_imponible_gravada,
  COALESCE(v.igv, 0)                    AS igv,
  COALESCE(v.total, 0)                  AS total,
  v.moneda,
  COALESCE(v.tipo_cambio, 1)            AS tipo_cambio,
  v.estado, v.cpe_estado,
  v.empresa_id
FROM public.ventas v
JOIN public.contacts ct ON ct.id = v.contact_id
ORDER BY v.empresa_id, v.fecha_emision, v.numero;

COMMENT ON VIEW public.v_registro_ventas IS
  'Registro de Ventas — base del Formato 14.1 SUNAT. MULTIEMPRESA: filtrar SIEMPRE por empresa_id además del periodo. Los libros salen filtrados, no separados: por eso la contabilidad formal queda en stand by hasta validar el candado.';

-- 8.4 · Registro de Compras (Formato 8.1)
CREATE OR REPLACE VIEW public.v_registro_compras AS
SELECT
  c.id,
  LPAD(c.periodo_ano::text, 4, '0') || LPAD(c.periodo_mes::text, 2, '0') AS periodo,
  c.fecha_emision, c.fecha_recepcion, c.tipo_comprobante, c.serie, c.numero,
  c.proveedor_ruc                            AS ruc_proveedor,
  c.proveedor_nombre                         AS razon_social_proveedor,
  COALESCE(c.base_imponible_gravada, 0)      AS base_imponible_gravada,
  COALESCE(c.base_imponible_no_gravada, 0)   AS base_no_gravada,
  COALESCE(c.igv_gravado, 0)                 AS igv,
  COALESCE(c.total, 0)                       AS total,
  c.currency                                 AS moneda,
  COALESCE(c.tipo_cambio, 1)                 AS tipo_cambio,
  c.tipo_compra,
  c.estado_comprobante                       AS estado,
  c.empresa_id
FROM public.compras c
ORDER BY c.empresa_id, c.fecha_emision, c.numero;

COMMENT ON VIEW public.v_registro_compras IS
  'Registro de Compras — base del Formato 8.1 SUNAT. MULTIEMPRESA: filtrar SIEMPRE por empresa_id además del periodo.';

-- 8.5 · CxC / CxP pendientes
CREATE OR REPLACE VIEW public.v_cxc_pendientes AS
SELECT
  cc.id,
  c.nombre                                        AS cliente,
  c.nro_documento                                 AS ruc_dni,
  cc.tipo_comprobante,
  cc.serie || '-' || cc.numero_comprobante        AS comprobante,
  cc.asiento_odoo                                 AS referencia,
  cc.fecha_emision, cc.fecha_vencimiento,
  COALESCE(cc.moneda, 'PEN')                      AS moneda,
  COALESCE(cc.tipo_cambio, 1)                     AS tc,
  cc.monto_total,
  COALESCE(cc.monto_cobrado, 0)                   AS monto_cobrado,
  cc.monto_total - COALESCE(cc.monto_cobrado, 0)  AS saldo_mn,
  COALESCE(cc.saldo_me, 0)                        AS saldo_me,
  cc.estado,
  CASE WHEN cc.fecha_vencimiento IS NULL THEN NULL
       ELSE CURRENT_DATE - cc.fecha_vencimiento END AS dias_mora,
  cc.updated_at,
  cc.empresa_id
FROM public.cuentas_cobrar cc
JOIN public.contacts c ON c.id = cc.contact_id
WHERE cc.estado IN ('pendiente', 'parcial');

CREATE OR REPLACE VIEW public.v_cxp_pendientes AS
SELECT
  cp.id,
  c.nombre                                        AS proveedor,
  c.nro_documento                                 AS ruc_dni,
  cp.tipo_comprobante,
  COALESCE(cp.serie, '') || '-' || COALESCE(cp.numero_comprobante, '') AS comprobante,
  cp.asiento_odoo                                 AS referencia,
  cp.referencia_cuenta                            AS cuenta_contable,
  cp.fecha_emision, cp.fecha_vencimiento,
  COALESCE(cp.moneda, 'PEN')                      AS moneda,
  COALESCE(cp.tipo_cambio, 1)                     AS tc,
  cp.monto_total,
  COALESCE(cp.monto_pagado, 0)                    AS monto_pagado,
  cp.monto_total - COALESCE(cp.monto_pagado, 0)   AS saldo_mn,
  CASE WHEN cp.fecha_vencimiento IS NULL THEN NULL
       ELSE CURRENT_DATE - cp.fecha_vencimiento END AS dias_mora,
  cp.estado, cp.updated_at,
  cp.empresa_id
FROM public.cuentas_pagar cp
JOIN public.contacts c ON c.id = cp.contact_id
WHERE cp.estado IN ('pendiente', 'parcial');

-- 8.6 · Antigüedad CxC por cliente (pivote)
CREATE OR REPLACE VIEW public.v_antiguedad_cxc_cliente AS
SELECT
  c.nombre                                               AS cliente,
  SUM(cc.monto_total - COALESCE(cc.monto_cobrado, 0))    AS saldo_total,
  SUM(CASE WHEN cc.fecha_vencimiento IS NULL OR CURRENT_DATE <= cc.fecha_vencimiento
           THEN cc.monto_total - COALESCE(cc.monto_cobrado, 0) ELSE 0 END) AS corriente,
  SUM(CASE WHEN cc.fecha_vencimiento IS NOT NULL AND CURRENT_DATE - cc.fecha_vencimiento BETWEEN 1 AND 30
           THEN cc.monto_total - COALESCE(cc.monto_cobrado, 0) ELSE 0 END) AS vencido_1_30,
  SUM(CASE WHEN cc.fecha_vencimiento IS NOT NULL AND CURRENT_DATE - cc.fecha_vencimiento BETWEEN 31 AND 60
           THEN cc.monto_total - COALESCE(cc.monto_cobrado, 0) ELSE 0 END) AS vencido_31_60,
  SUM(CASE WHEN cc.fecha_vencimiento IS NOT NULL AND CURRENT_DATE - cc.fecha_vencimiento BETWEEN 61 AND 90
           THEN cc.monto_total - COALESCE(cc.monto_cobrado, 0) ELSE 0 END) AS vencido_61_90,
  SUM(CASE WHEN cc.fecha_vencimiento IS NOT NULL AND CURRENT_DATE - cc.fecha_vencimiento > 90
           THEN cc.monto_total - COALESCE(cc.monto_cobrado, 0) ELSE 0 END) AS vencido_mas_90,
  cc.empresa_id
FROM public.cuentas_cobrar cc
JOIN public.contacts c ON c.id = cc.contact_id
WHERE cc.estado IN ('pendiente', 'parcial')
GROUP BY c.id, c.nombre, cc.empresa_id;

-- 8.7 · Libro mayor y balance de comprobación (contabilidad en stand by,
--       pero el dato ya nace con dueño para no migrar dos veces).
CREATE OR REPLACE VIEW public.v_libro_mayor AS
SELECT
  je.fecha                                       AS fecha,
  je.numero_asiento, je.descripcion, je.tipo_movimiento,
  pc.codigo                                      AS cuenta_codigo,
  pc.nombre                                      AS cuenta_nombre,
  jel.debe, jel.haber,
  jel.debe - jel.haber                           AS movimiento,
  c.nombre                                       AS contacto,
  jel.referencia_doc, jel.fecha_vencimiento,
  COALESCE(jel.moneda_original, 'PEN')           AS moneda,
  COALESCE(jel.tipo_cambio, 1)                   AS tc,
  jel.importe_original,
  jel.descripcion                                AS glosa_linea,
  je.id                                          AS journal_entry_id,
  jel.id                                         AS journal_entry_line_id,
  je.empresa_id
FROM public.journal_entry_lines jel
JOIN public.journal_entries je ON je.id = jel.journal_entry_id
JOIN public.plan_cuentas pc    ON pc.id = jel.account_id
LEFT JOIN public.contacts c    ON c.id  = jel.contact_id
ORDER BY je.empresa_id, je.fecha, je.numero_asiento, jel.id;

-- El balance es POR EMPRESA: se cruza el plan de cuentas (compartido) con cada
-- empresa activa, para que toda cuenta aparezca en las 3 aunque no tenga
-- movimiento en alguna.
CREATE OR REPLACE VIEW public.v_balance_comprobacion AS
SELECT
  pc.codigo, pc.nombre, pc.tipo, pc.naturaleza_saldo,
  COALESCE(SUM(jel.debe),  0)  AS total_debe,
  COALESCE(SUM(jel.haber), 0)  AS total_haber,
  COALESCE(SUM(jel.debe), 0) - COALESCE(SUM(jel.haber), 0)              AS saldo_deudor,
  GREATEST(COALESCE(SUM(jel.haber), 0) - COALESCE(SUM(jel.debe), 0), 0) AS saldo_acreedor,
  e.id                         AS empresa_id
FROM public.plan_cuentas pc
CROSS JOIN public.empresa_config e
LEFT JOIN public.journal_entries je
       ON je.empresa_id = e.id AND je.status = 'confirmado'
LEFT JOIN public.journal_entry_lines jel
       ON jel.journal_entry_id = je.id AND jel.account_id = pc.id
WHERE e.activo
GROUP BY e.id, pc.id, pc.codigo, pc.nombre, pc.tipo, pc.naturaleza_saldo
ORDER BY e.id, pc.codigo;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 8.5 · OBJETOS DEL SQL 86 (ledger de importaciones)
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠️ ORDEN: corre el SQL 86 ANTES de este script. Si lo corres después, las
-- tablas del ledger quedan sin empresa_id (la PARTE 3 las salta con NOTICE) y
-- este bloque entero no hace nada. Primero se construye la habitación, después
-- se le pone la cerradura.
--
-- Todo este bloque se auto-salta si el 86 no se ha ejecutado.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='importacion_costos') THEN
    RAISE NOTICE 'PARTE 8.5 omitida: el SQL 86 no se ha ejecutado. Córrelo y vuelve a correr este script (es idempotente).';
  END IF;
END $$;

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='importacion_costos') THEN
    RETURN;
  END IF;

  -- 1) El comprobante único por proveedor pasa a ser único POR EMPRESA.
  --    Jhiro y Benji pueden recibir la misma factura del mismo agente de
  --    aduana en el mismo mes y son dos documentos distintos.
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_docimp_comprobante_uk') THEN
    DROP INDEX public.idx_docimp_comprobante_uk;
  END IF;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_docimp_comprobante_empresa_uk
    ON public.documentos_importacion(empresa_id, proveedor_id, tipo_comprobante, serie, numero)
    WHERE proveedor_id IS NOT NULL AND serie IS NOT NULL AND numero IS NOT NULL;
  RAISE NOTICE '  ✓ documentos_importacion: comprobante único por (empresa, proveedor, serie, número)';

  -- 2) Candado: una línea del ledger no puede sustentarse con un documento de
  --    otra empresa. `importacion_costos` no tiene empresa_id propio (es hija
  --    de la carpeta), así que el cruce se valida contra la carpeta.
  CREATE OR REPLACE FUNCTION public.fn_mx_impcosto_coherente()
  RETURNS trigger AS $fn$
  DECLARE v_emp_carpeta integer; v_emp_doc integer; v_emp_cont integer;
  BEGIN
    SELECT empresa_id INTO v_emp_carpeta
      FROM public.carpetas_importacion WHERE id = NEW.carpeta_importacion_id;

    IF NEW.documento_id IS NOT NULL THEN
      SELECT empresa_id INTO v_emp_doc
        FROM public.documentos_importacion WHERE id = NEW.documento_id;
      IF v_emp_doc IS DISTINCT FROM v_emp_carpeta THEN
        RAISE EXCEPTION
          'MULTIEMPRESA: la línea de costo cuelga de una carpeta de la empresa % pero el documento que la sustenta es de la empresa %.',
          v_emp_carpeta, v_emp_doc
          USING HINT = 'Un comprobante se reparte entre carpetas de LA MISMA empresa. Para otra empresa, registra su propio documento.';
      END IF;
    END IF;

    IF NEW.contenedor_id IS NOT NULL THEN
      SELECT c.empresa_id INTO v_emp_cont
        FROM public.contenedores ct
        JOIN public.carpetas_importacion c ON c.id = ct.carpeta_importacion_id
       WHERE ct.id = NEW.contenedor_id;
      IF v_emp_cont IS DISTINCT FROM v_emp_carpeta THEN
        RAISE EXCEPTION 'MULTIEMPRESA: el contenedor pertenece a una carpeta de la empresa % y esta línea es de la empresa %.',
          v_emp_cont, v_emp_carpeta;
      END IF;
    END IF;

    RETURN NEW;
  END $fn$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_mx_impcosto_coherente ON public.importacion_costos;
  CREATE TRIGGER trg_mx_impcosto_coherente
    BEFORE INSERT OR UPDATE ON public.importacion_costos
    FOR EACH ROW EXECUTE FUNCTION public.fn_mx_impcosto_coherente();
  RAISE NOTICE '  ✓ candado en importacion_costos (carpeta ↔ documento ↔ contenedor)';

  -- 3) Los documentos operativos que el 86 colgó de la carpeta deben ser de la
  --    misma empresa que la carpeta. Se reutiliza el candado genérico.
  DECLARE
    t text;
  BEGIN
    FOREACH t IN ARRAY ARRAY['bill_of_ladings','dams','guias_remision','gastos_locales','comercial_invoices'] LOOP
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name=t AND column_name='carpeta_importacion_id')
         AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name=t AND column_name='empresa_id') THEN
        EXECUTE format('DROP TRIGGER IF EXISTS trg_mx_linea_coherente ON public.%I', t);
        EXECUTE format(
          'CREATE TRIGGER trg_mx_linea_coherente BEFORE INSERT OR UPDATE ON public.%I '
          'FOR EACH ROW EXECUTE FUNCTION public.fn_mx_linea_coherente(%L, %L)',
          t, 'carpetas_importacion', 'carpeta_importacion_id');
        RAISE NOTICE '  ✓ candado en % (padre: carpetas_importacion)', t;
      END IF;
    END LOOP;
  END;
END $$;

COMMIT;

-- 4) Las 3 vistas del 86 exponen empresa_id. Se agrega como ÚLTIMA columna a
--    propósito: CREATE OR REPLACE VIEW sólo admite columnas nuevas al final.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.views
                  WHERE table_schema='public' AND table_name='v_importacion_costos') THEN
    RAISE NOTICE 'Vistas del 86 no presentes: se omite el paso 4 de la PARTE 8.5.';
    RETURN;
  END IF;

  EXECUTE $v$
    CREATE OR REPLACE VIEW public.v_importacion_costos AS
    SELECT
      k.id, k.carpeta_importacion_id, c.numero_carpeta, c.estado AS carpeta_estado,
      k.grupo, k.concepto, k.concepto_codigo, k.clasificacion,
      k.entra_costo_contable, k.entra_costo_gestion,
      k.moneda, k.tipo_cambio, k.monto_moneda, k.monto_usd, k.monto_pen, k.igv_monto,
      k.base_prorrateo, k.detalle_ci_id,
      k.es_provisional, k.provisional_de_id, k.castigada, k.anulado,
      k.observaciones, k.created_at,
      d.id AS documento_id, d.tipo AS documento_tipo, d.tipo_comprobante,
      NULLIF(TRIM(CONCAT_WS('-', d.serie, d.numero)), '') AS documento_numero,
      d.fecha_emision, d.estado_pago, d.sustentado, d.compra_id, d.cxp_id,
      p.id AS proveedor_id, p.nombre AS proveedor_nombre, p.nro_documento AS proveedor_documento,
      ct.id AS contenedor_id, ct.numero AS contenedor_numero,
      c.empresa_id
    FROM public.importacion_costos k
    JOIN public.carpetas_importacion c        ON c.id  = k.carpeta_importacion_id
    LEFT JOIN public.documentos_importacion d ON d.id  = k.documento_id
    LEFT JOIN public.contacts p               ON p.id  = d.proveedor_id
    LEFT JOIN public.contenedores ct          ON ct.id = k.contenedor_id
  $v$;

  EXECUTE $v$
    CREATE OR REPLACE VIEW public.v_importacion_doc_cuadre AS
    SELECT
      d.id AS documento_id,
      d.tipo, d.tipo_comprobante, d.serie, d.numero, d.fecha_emision,
      d.proveedor_id, d.moneda, d.tipo_cambio, d.monto_total,
      COALESCE(SUM(k.monto_moneda) FILTER (WHERE NOT k.anulado), 0)  AS monto_asignado,
      COALESCE(SUM(k.igv_monto)    FILTER (WHERE NOT k.anulado), 0)  AS igv_asignado,
      d.monto_total - COALESCE(SUM(k.monto_moneda + k.igv_monto) FILTER (WHERE NOT k.anulado), 0) AS pendiente_asignar,
      COUNT(k.id) FILTER (WHERE NOT k.anulado)                              AS lineas,
      COUNT(DISTINCT k.carpeta_importacion_id) FILTER (WHERE NOT k.anulado) AS carpetas,
      d.empresa_id
    FROM public.documentos_importacion d
    LEFT JOIN public.importacion_costos k ON k.documento_id = d.id
    GROUP BY d.id
  $v$;

  RAISE NOTICE '  ✓ v_importacion_costos y v_importacion_doc_cuadre con empresa_id';

  -- v_importacion_resumen: mismo cuerpo del 86 con empresa_id al final.
  EXECUTE $v$
    CREATE OR REPLACE VIEW public.v_importacion_resumen AS
    WITH pesos AS (
      SELECT ci.carpeta_importacion_id AS carpeta_id,
             SUM(COALESCE(d.cantidad_recibida, d.cantidad_neto)) AS peso_neto,
             SUM(d.cantidad_gross)                               AS peso_bruto,
             SUM(d.cantidad_unid)                                AS bultos,
             SUM(d.costo_total)                                  AS fob_detalle
      FROM public.detalle_comercial_invoice d
      JOIN public.comercial_invoices ci ON ci.id = d.comercial_invoice_id
      WHERE COALESCE(d.inventariable, true) AND ci.carpeta_importacion_id IS NOT NULL
      GROUP BY ci.carpeta_importacion_id
    ),
    ledger AS (
      SELECT k.carpeta_importacion_id AS carpeta_id,
             SUM(k.monto_usd) FILTER (WHERE k.entra_costo_contable)               AS costo_contable_usd,
             SUM(k.monto_pen) FILTER (WHERE k.entra_costo_contable)               AS costo_contable_pen,
             SUM(k.monto_usd) FILTER (WHERE k.entra_costo_gestion)                AS costo_gestion_usd,
             SUM(k.monto_pen) FILTER (WHERE k.entra_costo_gestion)                AS costo_gestion_pen,
             SUM(k.monto_usd) FILTER (WHERE k.grupo = 'cif')                      AS cif_usd,
             SUM(k.monto_usd) FILTER (WHERE k.clasificacion = 'credito_fiscal')    AS credito_fiscal_usd,
             SUM(k.monto_usd) FILTER (WHERE k.clasificacion = 'percepcion')        AS percepcion_usd,
             SUM(k.monto_usd) FILTER (WHERE k.clasificacion = 'gasto_financiero')  AS financiero_usd,
             SUM(k.monto_usd) FILTER (WHERE k.clasificacion = 'solo_gestion')      AS solo_gestion_usd,
             SUM(k.monto_usd)                                                      AS desembolso_usd,
             COUNT(*) FILTER (WHERE k.es_provisional AND NOT k.castigada)           AS lineas_provisionales,
             COUNT(*) FILTER (WHERE NOT COALESCE(d.sustentado, true))               AS lineas_sin_sustento
      FROM public.importacion_costos k
      LEFT JOIN public.documentos_importacion d ON d.id = k.documento_id
      WHERE NOT k.anulado
      GROUP BY k.carpeta_importacion_id
    )
    SELECT
      c.id AS carpeta_id, c.numero_carpeta, c.descripcion, c.estado,
      c.proveedor_id, c.fecha_apertura, c.fecha_cierre, c.numero_dam,
      c.moneda_costeo, c.parametros_snapshot,
      COALESCE(p.peso_neto, 0)  AS peso_neto,
      COALESCE(p.peso_bruto, 0) AS peso_bruto,
      COALESCE(p.bultos, 0)     AS bultos,
      COALESCE(p.fob_detalle, c.fob_total_usd, 0) AS fob_usd,
      COALESCE(l.cif_usd, 0)              AS cif_usd,
      COALESCE(l.costo_contable_usd, 0)   AS costo_contable_usd,
      COALESCE(l.costo_contable_pen, 0)   AS costo_contable_pen,
      COALESCE(l.costo_gestion_usd, 0)    AS costo_gestion_usd,
      COALESCE(l.costo_gestion_pen, 0)    AS costo_gestion_pen,
      COALESCE(l.credito_fiscal_usd, 0)   AS credito_fiscal_usd,
      COALESCE(l.percepcion_usd, 0)       AS percepcion_usd,
      COALESCE(l.financiero_usd, 0)       AS financiero_usd,
      COALESCE(l.solo_gestion_usd, 0)     AS solo_gestion_usd,
      COALESCE(l.desembolso_usd, 0)       AS desembolso_usd,
      COALESCE(l.lineas_provisionales, 0) AS lineas_provisionales,
      COALESCE(l.lineas_sin_sustento, 0)  AS lineas_sin_sustento,
      CASE WHEN COALESCE(p.peso_neto, 0) > 0
           THEN round(COALESCE(l.costo_contable_usd, 0) / p.peso_neto, 6) END AS costo_contable_kg,
      CASE WHEN COALESCE(p.peso_neto, 0) > 0
           THEN round(COALESCE(l.costo_gestion_usd, 0)  / p.peso_neto, 6) END AS costo_gestion_kg,
      CASE WHEN COALESCE(p.fob_detalle, c.fob_total_usd, 0) > 0
           THEN round(COALESCE(l.costo_contable_usd, 0) / COALESCE(p.fob_detalle, c.fob_total_usd), 6) END AS factor_contable_calc,
      CASE WHEN COALESCE(p.fob_detalle, c.fob_total_usd, 0) > 0
           THEN round(COALESCE(l.costo_gestion_usd, 0)  / COALESCE(p.fob_detalle, c.fob_total_usd), 6) END AS factor_gestion_calc,
      c.empresa_id
    FROM public.carpetas_importacion c
    LEFT JOIN pesos  p ON p.carpeta_id = c.id
    LEFT JOIN ledger l ON l.carpeta_id = c.id
  $v$;

  RAISE NOTICE '  ✓ v_importacion_resumen con empresa_id';
END $$;
-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 9 · VERIFICACIÓN — revisa estos resultados antes de usar el sistema
-- ════════════════════════════════════════════════════════════════════════════

-- 9.1 · Las empresas quedaron creadas
SELECT id, codigo, ruc, razon_social, color, activo
  FROM public.empresa_config ORDER BY orden, id;

-- 9.2 · Tablas que quedaron con empresa_id (debe listar ~33)
SELECT table_name
  FROM information_schema.columns
 WHERE table_schema = 'public' AND column_name = 'empresa_id'
 ORDER BY table_name;

-- 9.3 · Nada debe quedar huérfano (todas las filas deben ser de JHIRO)
SELECT 'ventas' t, empresa_id, COUNT(*) FROM public.ventas GROUP BY 2
UNION ALL SELECT 'compras', empresa_id, COUNT(*) FROM public.compras GROUP BY 2
UNION ALL SELECT 'lotes',   empresa_id, COUNT(*) FROM public.lotes   GROUP BY 2
UNION ALL SELECT 'kardex',  empresa_id, COUNT(*) FROM public.kardex  GROUP BY 2
ORDER BY 1, 2;

-- 9.4 · Cada empresa tiene sus almacenes, sus zonas y su Partners/Vendors
SELECT e.codigo AS empresa, a.codigo AS almacen, a.es_virtual,
       COUNT(u.id) AS zonas
  FROM public.empresa_config e
  JOIN public.almacenes   a ON a.empresa_id = e.id
  LEFT JOIN public.ubicaciones u ON u.almacen_id = a.id
 GROUP BY e.codigo, e.orden, a.codigo, a.es_virtual
 ORDER BY e.orden, a.codigo;

-- 9.5 · Cada empresa tiene su juego de series con su propio correlativo
SELECT e.codigo AS empresa, s.tipo_documento, s.serie, s.ultimo_correlativo
  FROM public.series_documentos s
  JOIN public.empresa_config e ON e.id = s.empresa_id
 ORDER BY e.orden, s.tipo_documento, s.serie;

-- 9.6 · Los candados están montados (debe listar 13 triggers trg_mx_*)
SELECT c.relname AS tabla, t.tgname AS trigger
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
 WHERE t.tgname LIKE 'trg_mx_%' AND NOT t.tgisinternal
 ORDER BY 1, 2;

-- 9.7 · PRUEBA DEL CANDADO (opcional, descomenta para verlo fallar a propósito).
--       Debe lanzar: "MULTIEMPRESA: el movimiento de kardex es de la empresa 2
--       pero el lote N pertenece a la empresa 1."
-- DO $$
-- DECLARE v_lote bigint; v_benji integer;
-- BEGIN
--   SELECT id INTO v_lote  FROM public.lotes LIMIT 1;
--   SELECT id INTO v_benji FROM public.empresa_config WHERE codigo = 'BENJI';
--   UPDATE public.kardex SET empresa_id = v_benji WHERE lote_id = v_lote;
-- END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK (sólo si algo sale mal — borra la separación por empresa)
-- ════════════════════════════════════════════════════════════════════════════
-- Los datos NO se pierden: todo lo existente quedó en JHIRO, así que quitar
-- la columna devuelve el sistema exactamente al estado de antes.
--
-- DROP TRIGGER IF EXISTS trg_mx_kardex_coherente ON public.kardex;
-- DROP TRIGGER IF EXISTS trg_mx_lote_coherente   ON public.lotes;
-- DO $$ DECLARE r record; BEGIN
--   FOR r IN SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
--             WHERE t.tgname = 'trg_mx_linea_coherente' AND NOT t.tgisinternal LOOP
--     EXECUTE format('DROP TRIGGER IF EXISTS trg_mx_linea_coherente ON public.%I', r.relname);
--   END LOOP;
-- END $$;
-- DROP FUNCTION IF EXISTS public.fn_mx_kardex_coherente() CASCADE;
-- DROP FUNCTION IF EXISTS public.fn_mx_linea_coherente()  CASCADE;
-- DROP FUNCTION IF EXISTS public.fn_mx_lote_coherente()   CASCADE;
-- DO $$ DECLARE r record; BEGIN
--   FOR r IN SELECT table_name FROM information_schema.columns
--             WHERE table_schema='public' AND column_name='empresa_id'
--               AND table_name <> 'empresa_config' LOOP
--     EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS empresa_id CASCADE', r.table_name);
--   END LOOP;
-- END $$;
-- DELETE FROM public.empresa_config WHERE codigo IN ('BENJI','RAMA');
-- -- y volver a correr los scripts 43 (índice de lotes), 52 (stock_ubicaciones)
-- -- y 12 (vistas contables) para restaurar las versiones sin empresa_id.
