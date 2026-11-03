-- ============================================================================
-- 131_crm_catalogo_rls.sql  (2026-11-03)
-- GENKO · Módulo CRM + catálogo público conectado al ERP + cierre de seguridad
--
-- UN SOLO ARCHIVO, en orden de ejecución. Idempotente: se puede correr de nuevo.
-- Ejecutar completo en Supabase → SQL Editor (proyecto del ERP).
--
--   §1  Cerrar el rol `anon` en todo el esquema public           (lo más urgente)
--   §2  Roles: 'oficina' + registro que ya no acepta 'admin' desde el navegador
--   §3  Funciones de rol (fn_rol_actual, fn_es_staff_crm, ...)
--   §4  Tablas CRM (crm_*) + índices + triggers
--   §5  RLS de las tablas CRM (vendedor ve lo suyo, oficina/admin ven todo)
--   §6  Funciones públicas (catálogo, cotizar) y de staff (stock por lote)
--   §7  Storage: comprobantes (privado) y fotos del catálogo (público)
--   §8  Realtime
--   §9  Endurecimiento OPCIONAL de las 43+ policies `USING (true)` (apagado)
--   §10 Verificación: una sola consulta que lista lo que siga abierto
--
-- Principio de diseño: el CRM es una VISTA de solo lectura de la BD real.
-- El visitante (anon) NO toca ninguna tabla: solo llama funciones que devuelven
-- columnas seguras (sin costo, margen ni proveedor) y stock como semáforo.
--
-- NOTA sobre el anexo A del .md: allí se pide `v_catalogo_publico` con
-- security_invoker=on. Eso es incompatible con cerrar `anon`: la vista correría
-- con los permisos del visitante, que ya no puede leer `items` ni `lotes`, y
-- devolvería vacío. Por eso el catálogo público se sirve con funciones
-- SECURITY DEFINER (search_path fijo, columnas explícitas, precio leído de la BD).
-- ============================================================================
BEGIN;

-- ============================================================================
-- §1 · CERRAR `anon`
-- ----------------------------------------------------------------------------
-- Hallazgo: 00_grants.sql dejó `ALTER DEFAULT PRIVILEGES ... GRANT SELECT ON
-- TABLES TO anon`. Toda tabla/vista nueva nació legible para el público; las
-- tablas con RLS quedaban protegidas, pero las VISTAS (stock_ubicaciones,
-- vistas contables, etc.) corren con permisos del dueño y se saltan la RLS.
-- Con la ANON_KEY (que está en GitHub) cualquiera podía leerlas.
-- ============================================================================
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;

-- Por defecto Postgres da EXECUTE a PUBLIC en toda función nueva: quitarlo.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT  EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;

-- Que lo que se cree desde hoy NO nazca abierto al público.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

DO $$
BEGIN
  -- Supabase crea objetos también como supabase_admin; si el rol del editor
  -- no puede tocar ese default, se ignora (no es crítico).
  BEGIN
    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'No se pudo ajustar default privileges de supabase_admin (%). Continúa.', SQLERRM;
  END;
END $$;

-- Policies que dejaban entrar a `anon` (o a PUBLIC, que lo incluye):
--   · solo-anon  → se eliminan
--   · mixtas     → se reasignan a `authenticated` (no se pierde acceso a usuarios)
DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, roles
      FROM pg_policies
     WHERE schemaname = 'public'
       AND ('anon' = ANY(roles) OR 'public' = ANY(roles))
  LOOP
    IF p.roles = ARRAY['anon']::name[] THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
    ELSE
      EXECUTE format('ALTER POLICY %I ON %I.%I TO authenticated', p.policyname, p.schemaname, p.tablename);
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- §2 · ROLES
-- ----------------------------------------------------------------------------
-- Roles de uso libre al registrarse: 'oficina' | 'vendedor'.
-- 'admin' (y 'contador', 'almacen') SOLO se asignan desde la BD:
--     UPDATE public.users SET role = 'admin' WHERE email = 'tu@correo';
-- Antes el trigger copiaba el `role` que mandara el navegador en user_metadata:
-- cualquiera podía registrarse con role:'admin' llamando a la API directamente.
-- ============================================================================
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.users'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE public.users DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE public.users
    ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin','contador','vendedor','almacen','user','oficina'));
END $$;

CREATE OR REPLACE FUNCTION public.fn_on_auth_user_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_rol text;
BEGIN
  v_rol := lower(COALESCE(NEW.raw_user_meta_data->>'role', ''));
  IF v_rol NOT IN ('oficina','vendedor') THEN
    v_rol := 'user';          -- 'admin' u otros: nunca desde el navegador
  END IF;

  INSERT INTO public.users (auth_id, username, email, nombre, role, password_hash, active)
  VALUES (
    NEW.id,
    COALESCE(NEW.email, NEW.id::text),
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'nombre', split_part(NEW.email, '@', 1)),
    v_rol,
    '',
    true
  )
  ON CONFLICT (auth_id) DO UPDATE SET
    email  = EXCLUDED.email,
    nombre = EXCLUDED.nombre;      -- el rol NO se pisa en un conflicto
  RETURN NEW;
END;
$$;

-- ============================================================================
-- §3 · FUNCIONES DE ROL (las usan las policies; SECURITY DEFINER evita
--      recursión al leer public.users desde una policy)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fn_rol_actual()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.role::text FROM public.users u
   WHERE u.auth_id = auth.uid() AND COALESCE(u.active, true)
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.fn_usuario_id()
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id FROM public.users u
   WHERE u.auth_id = auth.uid() AND COALESCE(u.active, true)
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.fn_usuario_activo()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.users u WHERE u.auth_id = auth.uid() AND COALESCE(u.active, true))
$$;

CREATE OR REPLACE FUNCTION public.fn_tiene_rol(VARIADIC p_roles text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(public.fn_rol_actual() = ANY (p_roles), false)
$$;

-- Quién entra al CRM interno: admin, oficina y vendedor.
CREATE OR REPLACE FUNCTION public.fn_es_staff_crm()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.fn_tiene_rol('admin', 'oficina', 'vendedor')
$$;

-- Quién ve TODA la cartera y configura el catálogo: admin y oficina.
CREATE OR REPLACE FUNCTION public.fn_crm_gestor()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.fn_tiene_rol('admin', 'oficina')
$$;

GRANT EXECUTE ON FUNCTION public.fn_rol_actual(), public.fn_usuario_id(), public.fn_usuario_activo(),
                          public.fn_es_staff_crm(), public.fn_crm_gestor()
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_tiene_rol(text[]) TO authenticated, service_role;

-- ============================================================================
-- §4 · TABLAS CRM
-- Nombres snake_case con prefijo crm_ (el catálogo viejo era camelCase).
-- Equivalencias con el proyecto del catálogo:
--   productosPaginaWeb   → crm_catalogo_config  (+ items/lotes del ERP, que ya NO se duplican)
--   registroClientesWeb  → crm_clientes
--   cotizacionesWeb      → crm_cotizaciones
--   detalleCotizacionWeb → crm_cotizacion_detalle
--   (nueva)              → crm_config, crm_seguimiento
-- ============================================================================

-- 4.1 Configuración del CRM por empresa -------------------------------------
CREATE TABLE IF NOT EXISTS public.crm_config (
  empresa_id          integer PRIMARY KEY REFERENCES public.empresa_config(id) ON DELETE CASCADE,
  whatsapp            varchar,                    -- solo dígitos con código de país: 51956217972
  titulo              varchar,                    -- titular del catálogo
  mensaje             text,                       -- bajada / bienvenida
  mostrar_precios     boolean NOT NULL DEFAULT true,   -- precios públicos (decisión de Luis)
  igv_incluido        boolean NOT NULL DEFAULT true,   -- el precio de lista ya incluye IGV
  moneda_precio       varchar NOT NULL DEFAULT 'PEN' CHECK (moneda_precio IN ('PEN','USD')),
  semaforo_poco_kg    numeric NOT NULL DEFAULT 100,    -- debajo de esto: "Poco stock"
  cuentas_bancarias   jsonb   NOT NULL DEFAULT '[]'::jsonb,  -- [{banco,tipo,numero,cci,titular}]
  updated_at          timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.crm_config (empresa_id)
SELECT e.id FROM public.empresa_config e
ON CONFLICT (empresa_id) DO NOTHING;

-- WhatsApp que ya publicaba el catálogo viejo (solo si es la empresa JHIRO).
UPDATE public.crm_config c
   SET whatsapp = '51956217972'
  FROM public.empresa_config e
 WHERE e.id = c.empresa_id AND c.whatsapp IS NULL
   AND e.nombre_comercial ILIKE '%jhiro%';

-- 4.2 Qué artículos del ERP se publican y cómo se ven ------------------------
CREATE TABLE IF NOT EXISTS public.crm_catalogo_config (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id       integer NOT NULL REFERENCES public.empresa_config(id) ON DELETE CASCADE,
  item_id          bigint  NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  publicado        boolean NOT NULL DEFAULT false,
  nombre_web       varchar,           -- NULL → usa items.nombre
  grupo            varchar,           -- categoría web / familia de colores. NULL → categorias.nombre
  color_nombre     varchar,
  color_no         varchar,
  color_hex        varchar CHECK (color_hex IS NULL OR color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  descripcion_web  text,
  aplicaciones     text,
  fotos            jsonb   NOT NULL DEFAULT '[]'::jsonb,   -- ["crm/assets/fotos/x.webp", "https://.../storage/..."]
  precio_lista     numeric CHECK (precio_lista IS NULL OR precio_lista >= 0),   -- NULL → items.precio_venta
  peso_caja_kg     numeric CHECK (peso_caja_kg IS NULL OR peso_caja_kg > 0),    -- NULL → deducido de los lotes
  conos_por_caja   integer CHECK (conos_por_caja IS NULL OR conos_por_caja > 0),
  stock_minimo_kg  numeric,           -- NULL → crm_config.semaforo_poco_kg
  orden_display    integer NOT NULL DEFAULT 100,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_catalogo_unico UNIQUE (empresa_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_crm_catalogo_pub  ON public.crm_catalogo_config (empresa_id) WHERE publicado;
CREATE INDEX IF NOT EXISTS idx_crm_catalogo_item ON public.crm_catalogo_config (item_id);

-- 4.3 Clientes del CRM (enlazados al contacto del ERP por RUC) ---------------
CREATE TABLE IF NOT EXISTS public.crm_clientes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ruc               varchar NOT NULL UNIQUE CHECK (ruc ~ '^[0-9]{8}$' OR ruc ~ '^[0-9]{11}$'),
  razon_social      varchar NOT NULL,
  nombre_contacto   varchar,
  email             varchar,
  telefono          varchar,
  direccion_fiscal  varchar,
  distrito          varchar,
  contact_id        bigint REFERENCES public.contacts(id) ON DELETE SET NULL,  -- mismo cliente que en el ERP
  origen            varchar NOT NULL DEFAULT 'web' CHECK (origen IN ('web','vendedor','mostrador')),
  vendedor_id       bigint REFERENCES public.users(id) ON DELETE SET NULL,     -- NULL = sin asignar
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_clientes_vendedor ON public.crm_clientes (vendedor_id);
CREATE INDEX IF NOT EXISTS idx_crm_clientes_contact  ON public.crm_clientes (contact_id);

-- 4.4 Cotizaciones -----------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.crm_cotizacion_seq;

CREATE TABLE IF NOT EXISTS public.crm_cotizaciones (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero              varchar UNIQUE,
  empresa_id          integer NOT NULL REFERENCES public.empresa_config(id),
  cliente_id          uuid    NOT NULL REFERENCES public.crm_clientes(id),
  vendedor_id         bigint  REFERENCES public.users(id) ON DELETE SET NULL,
  origen              varchar NOT NULL DEFAULT 'web' CHECK (origen IN ('web','vendedor','mostrador')),
  estado              varchar NOT NULL DEFAULT 'enviada'
                        CHECK (estado IN ('enviada','en_revision','cotizada','aceptada','pagada','convertida','perdida','cancelada')),
  estado_pago         varchar NOT NULL DEFAULT 'pendiente' CHECK (estado_pago IN ('pendiente','parcial','pagado')),
  -- Datos del contacto TAL COMO los escribió el visitante en esa cotización
  -- (no pisan los del cliente: nadie puede cambiar los datos de un RUC ajeno)
  razon_social        varchar,
  contacto_nombre     varchar,
  contacto_email      varchar,
  contacto_telefono   varchar,
  direccion_fiscal    varchar,
  dir_entrega         varchar,
  distrito_entrega    varchar,
  referencia_entrega  varchar,
  notas_cliente       text,
  notas_internas      text,
  moneda              varchar NOT NULL DEFAULT 'PEN',
  igv_incluido        boolean NOT NULL DEFAULT true,
  subtotal            numeric NOT NULL DEFAULT 0,
  igv                 numeric NOT NULL DEFAULT 0,
  total               numeric NOT NULL DEFAULT 0,
  comprobante_path    text,          -- ruta en el bucket privado crm-comprobantes
  comprobante_nombre  varchar,
  comprobante_fecha   timestamptz,
  venta_id            bigint,        -- cuando se convierte en venta del ERP
  proxima_accion      date,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_cot_empresa   ON public.crm_cotizaciones (empresa_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_cot_vendedor  ON public.crm_cotizaciones (vendedor_id);
CREATE INDEX IF NOT EXISTS idx_crm_cot_cliente   ON public.crm_cotizaciones (cliente_id);
CREATE INDEX IF NOT EXISTS idx_crm_cot_estado    ON public.crm_cotizaciones (estado);

-- 4.5 Detalle ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crm_cotizacion_detalle (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cotizacion_id       uuid    NOT NULL REFERENCES public.crm_cotizaciones(id) ON DELETE CASCADE,
  catalogo_id         bigint  REFERENCES public.crm_catalogo_config(id) ON DELETE SET NULL,
  item_id             bigint  REFERENCES public.items(id) ON DELETE SET NULL,
  producto_nombre     varchar NOT NULL,
  producto_categoria  varchar,
  color_nombre        varchar,
  cantidad_kg         numeric NOT NULL CHECK (cantidad_kg > 0),
  peso_x_caja         numeric,
  precio_unitario     numeric NOT NULL DEFAULT 0 CHECK (precio_unitario >= 0),   -- por kg, tomado de la BD
  descuento_pct       numeric NOT NULL DEFAULT 0 CHECK (descuento_pct >= 0 AND descuento_pct <= 100),
  importe             numeric GENERATED ALWAYS AS
                        (round(cantidad_kg * precio_unitario * (1 - descuento_pct / 100), 2)) STORED,
  notas               text,
  orden_linea         integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_crm_det_cot ON public.crm_cotizacion_detalle (cotizacion_id);

-- 4.6 Seguimiento (bitácora) -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crm_seguimiento (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cotizacion_id   uuid REFERENCES public.crm_cotizaciones(id) ON DELETE CASCADE,
  cliente_id      uuid REFERENCES public.crm_clientes(id) ON DELETE CASCADE,
  tipo            varchar NOT NULL DEFAULT 'nota'
                    CHECK (tipo IN ('llamada','whatsapp','correo','visita','nota','cambio_estado','pago')),
  detalle         text NOT NULL,
  user_id         bigint REFERENCES public.users(id) ON DELETE SET NULL,
  proxima_accion  date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_seg_destino CHECK (cotizacion_id IS NOT NULL OR cliente_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_crm_seg_cot     ON public.crm_seguimiento (cotizacion_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_seg_cliente ON public.crm_seguimiento (cliente_id, created_at DESC);

-- 4.7 Triggers ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_crm_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_crm_touch ON public.crm_config;
CREATE TRIGGER trg_crm_touch BEFORE UPDATE ON public.crm_config
  FOR EACH ROW EXECUTE FUNCTION public.fn_crm_touch();
DROP TRIGGER IF EXISTS trg_crm_touch ON public.crm_catalogo_config;
CREATE TRIGGER trg_crm_touch BEFORE UPDATE ON public.crm_catalogo_config
  FOR EACH ROW EXECUTE FUNCTION public.fn_crm_touch();
DROP TRIGGER IF EXISTS trg_crm_touch ON public.crm_clientes;
CREATE TRIGGER trg_crm_touch BEFORE UPDATE ON public.crm_clientes
  FOR EACH ROW EXECUTE FUNCTION public.fn_crm_touch();
DROP TRIGGER IF EXISTS trg_crm_touch ON public.crm_cotizaciones;
CREATE TRIGGER trg_crm_touch BEFORE UPDATE ON public.crm_cotizaciones
  FOR EACH ROW EXECUTE FUNCTION public.fn_crm_touch();

-- Número correlativo COT-26-00001
CREATE OR REPLACE FUNCTION public.fn_crm_cot_numero()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.numero IS NULL THEN
    NEW.numero := 'COT-' || to_char(now(), 'YY') || '-' || lpad(nextval('public.crm_cotizacion_seq')::text, 5, '0');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_crm_cot_numero ON public.crm_cotizaciones;
CREATE TRIGGER trg_crm_cot_numero BEFORE INSERT ON public.crm_cotizaciones
  FOR EACH ROW EXECUTE FUNCTION public.fn_crm_cot_numero();

-- Totales de la cotización a partir de las líneas
CREATE OR REPLACE FUNCTION public.fn_crm_recalcular_totales()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id   uuid := COALESCE(NEW.cotizacion_id, OLD.cotizacion_id);
  v_sum  numeric;
  v_inc  boolean;
  v_pct  numeric;
  v_emp  integer;
BEGIN
  SELECT c.igv_incluido, c.empresa_id INTO v_inc, v_emp FROM public.crm_cotizaciones c WHERE c.id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(e.igv_porcentaje, 18) INTO v_pct FROM public.empresa_config e WHERE e.id = v_emp;
  v_pct := COALESCE(v_pct, 18);
  SELECT COALESCE(SUM(d.importe), 0) INTO v_sum FROM public.crm_cotizacion_detalle d WHERE d.cotizacion_id = v_id;

  IF v_inc THEN
    UPDATE public.crm_cotizaciones
       SET total    = round(v_sum, 2),
           subtotal = round(v_sum / (1 + v_pct / 100), 2),
           igv      = round(v_sum - v_sum / (1 + v_pct / 100), 2)
     WHERE id = v_id;
  ELSE
    UPDATE public.crm_cotizaciones
       SET subtotal = round(v_sum, 2),
           igv      = round(v_sum * v_pct / 100, 2),
           total    = round(v_sum + v_sum * v_pct / 100, 2)
     WHERE id = v_id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_crm_totales ON public.crm_cotizacion_detalle;
CREATE TRIGGER trg_crm_totales AFTER INSERT OR UPDATE OR DELETE ON public.crm_cotizacion_detalle
  FOR EACH ROW EXECUTE FUNCTION public.fn_crm_recalcular_totales();

-- Cada cambio de estado queda en la bitácora
CREATE OR REPLACE FUNCTION public.fn_crm_log_estado()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.estado IS DISTINCT FROM OLD.estado THEN
    INSERT INTO public.crm_seguimiento (cotizacion_id, tipo, detalle, user_id)
    VALUES (NEW.id, 'cambio_estado', OLD.estado || ' → ' || NEW.estado, public.fn_usuario_id());
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_crm_log_estado ON public.crm_cotizaciones;
CREATE TRIGGER trg_crm_log_estado AFTER UPDATE OF estado ON public.crm_cotizaciones
  FOR EACH ROW EXECUTE FUNCTION public.fn_crm_log_estado();

-- ============================================================================
-- §5 · RLS DE LAS TABLAS CRM
-- Regla madre: "si alguien copia la ANON_KEY y consulta directo, ¿qué se lleva?"
-- Respuesta aquí: NADA. anon no tiene GRANT ni policy sobre ninguna crm_*.
-- ============================================================================
ALTER TABLE public.crm_config            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_catalogo_config   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_clientes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_cotizaciones      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_cotizacion_detalle ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_seguimiento       ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.crm_config, public.crm_catalogo_config, public.crm_clientes,
  public.crm_cotizaciones, public.crm_cotizacion_detalle, public.crm_seguimiento
  TO authenticated;
GRANT ALL ON
  public.crm_config, public.crm_catalogo_config, public.crm_clientes,
  public.crm_cotizaciones, public.crm_cotizacion_detalle, public.crm_seguimiento
  TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.crm_cotizacion_seq TO authenticated, service_role;

-- Limpieza para poder re-ejecutar el archivo
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname, tablename FROM pg_policies
            WHERE schemaname = 'public' AND tablename LIKE 'crm\_%'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.policyname, p.tablename);
  END LOOP;
END $$;

-- crm_config · lee el staff, escribe admin/oficina
CREATE POLICY crm_config_sel ON public.crm_config FOR SELECT TO authenticated
  USING ((SELECT public.fn_es_staff_crm()));
CREATE POLICY crm_config_ins ON public.crm_config FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.fn_crm_gestor()));
CREATE POLICY crm_config_upd ON public.crm_config FOR UPDATE TO authenticated
  USING ((SELECT public.fn_crm_gestor())) WITH CHECK ((SELECT public.fn_crm_gestor()));
CREATE POLICY crm_config_del ON public.crm_config FOR DELETE TO authenticated
  USING ((SELECT public.fn_crm_gestor()));

-- crm_catalogo_config · igual
CREATE POLICY crm_catcfg_sel ON public.crm_catalogo_config FOR SELECT TO authenticated
  USING ((SELECT public.fn_es_staff_crm()));
CREATE POLICY crm_catcfg_ins ON public.crm_catalogo_config FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.fn_crm_gestor()));
CREATE POLICY crm_catcfg_upd ON public.crm_catalogo_config FOR UPDATE TO authenticated
  USING ((SELECT public.fn_crm_gestor())) WITH CHECK ((SELECT public.fn_crm_gestor()));
CREATE POLICY crm_catcfg_del ON public.crm_catalogo_config FOR DELETE TO authenticated
  USING ((SELECT public.fn_crm_gestor()));

-- crm_clientes · el vendedor ve los suyos y los SIN ASIGNAR (para tomarlos);
--                nunca la cartera de otro vendedor.
CREATE POLICY crm_cli_sel ON public.crm_clientes FOR SELECT TO authenticated
  USING ((SELECT public.fn_es_staff_crm())
         AND ((SELECT public.fn_crm_gestor())
              OR vendedor_id IS NULL
              OR vendedor_id = (SELECT public.fn_usuario_id())));
CREATE POLICY crm_cli_ins ON public.crm_clientes FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.fn_es_staff_crm())
              AND ((SELECT public.fn_crm_gestor()) OR vendedor_id = (SELECT public.fn_usuario_id())));
CREATE POLICY crm_cli_upd ON public.crm_clientes FOR UPDATE TO authenticated
  USING ((SELECT public.fn_es_staff_crm())
         AND ((SELECT public.fn_crm_gestor())
              OR vendedor_id IS NULL
              OR vendedor_id = (SELECT public.fn_usuario_id())))
  WITH CHECK ((SELECT public.fn_crm_gestor()) OR vendedor_id = (SELECT public.fn_usuario_id()));
CREATE POLICY crm_cli_del ON public.crm_clientes FOR DELETE TO authenticated
  USING ((SELECT public.fn_crm_gestor()));

-- crm_cotizaciones · misma regla
CREATE POLICY crm_cot_sel ON public.crm_cotizaciones FOR SELECT TO authenticated
  USING ((SELECT public.fn_es_staff_crm())
         AND ((SELECT public.fn_crm_gestor())
              OR vendedor_id IS NULL
              OR vendedor_id = (SELECT public.fn_usuario_id())));
CREATE POLICY crm_cot_ins ON public.crm_cotizaciones FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.fn_es_staff_crm())
              AND ((SELECT public.fn_crm_gestor()) OR vendedor_id = (SELECT public.fn_usuario_id())));
CREATE POLICY crm_cot_upd ON public.crm_cotizaciones FOR UPDATE TO authenticated
  USING ((SELECT public.fn_es_staff_crm())
         AND ((SELECT public.fn_crm_gestor())
              OR vendedor_id IS NULL
              OR vendedor_id = (SELECT public.fn_usuario_id())))
  WITH CHECK ((SELECT public.fn_crm_gestor()) OR vendedor_id = (SELECT public.fn_usuario_id()));
CREATE POLICY crm_cot_del ON public.crm_cotizaciones FOR DELETE TO authenticated
  USING ((SELECT public.fn_crm_gestor()));

-- crm_cotizacion_detalle · hereda la visibilidad de su cotización
CREATE POLICY crm_det_sel ON public.crm_cotizacion_detalle FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.crm_cotizaciones c WHERE c.id = cotizacion_id));
CREATE POLICY crm_det_ins ON public.crm_cotizacion_detalle FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.crm_cotizaciones c WHERE c.id = cotizacion_id
                      AND ((SELECT public.fn_crm_gestor()) OR c.vendedor_id = (SELECT public.fn_usuario_id()))));
CREATE POLICY crm_det_upd ON public.crm_cotizacion_detalle FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.crm_cotizaciones c WHERE c.id = cotizacion_id
                 AND ((SELECT public.fn_crm_gestor()) OR c.vendedor_id = (SELECT public.fn_usuario_id()))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.crm_cotizaciones c WHERE c.id = cotizacion_id
                      AND ((SELECT public.fn_crm_gestor()) OR c.vendedor_id = (SELECT public.fn_usuario_id()))));
CREATE POLICY crm_det_del ON public.crm_cotizacion_detalle FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.crm_cotizaciones c WHERE c.id = cotizacion_id
                 AND ((SELECT public.fn_crm_gestor()) OR c.vendedor_id = (SELECT public.fn_usuario_id()))));

-- crm_seguimiento · se ve si se ve su cotización o su cliente
CREATE POLICY crm_seg_sel ON public.crm_seguimiento FOR SELECT TO authenticated
  USING ((cotizacion_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.crm_cotizaciones c WHERE c.id = cotizacion_id))
      OR (cliente_id    IS NOT NULL AND EXISTS (SELECT 1 FROM public.crm_clientes k WHERE k.id = cliente_id)));
CREATE POLICY crm_seg_ins ON public.crm_seguimiento FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.fn_es_staff_crm())
              AND user_id = (SELECT public.fn_usuario_id())
              AND ((cotizacion_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.crm_cotizaciones c WHERE c.id = cotizacion_id))
                OR (cliente_id    IS NOT NULL AND EXISTS (SELECT 1 FROM public.crm_clientes k WHERE k.id = cliente_id))));
CREATE POLICY crm_seg_upd ON public.crm_seguimiento FOR UPDATE TO authenticated
  USING ((SELECT public.fn_crm_gestor())) WITH CHECK ((SELECT public.fn_crm_gestor()));
CREATE POLICY crm_seg_del ON public.crm_seguimiento FOR DELETE TO authenticated
  USING ((SELECT public.fn_crm_gestor()));

-- ============================================================================
-- §6 · FUNCIONES
-- ----------------------------------------------------------------------------
-- 6.A  PÚBLICAS (anon + authenticated): solo devuelven columnas seguras.
--      Nunca salen: costo_promedio, costo_unitario, margen, proveedor_id,
--      numero de stock exacto (solo semáforo), ni datos de otras personas.
-- ============================================================================

-- 6.1 Empresas con catálogo publicado (nombre, color y datos para cotizar)
CREATE OR REPLACE FUNCTION public.crm_empresas_publicas()
RETURNS TABLE (
  id integer, codigo text, nombre_comercial text, color text, logo_url text,
  whatsapp text, titulo text, mensaje text, mostrar_precios boolean,
  igv_incluido boolean, moneda_precio text, cuentas_bancarias jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.id, e.codigo::text, e.nombre_comercial::text, e.color::text, e.logo_url::text,
         c.whatsapp::text, c.titulo::text, c.mensaje, c.mostrar_precios,
         c.igv_incluido, c.moneda_precio::text, c.cuentas_bancarias
    FROM public.empresa_config e
    JOIN public.crm_config c ON c.empresa_id = e.id
   WHERE e.activo IS NOT FALSE
     AND EXISTS (SELECT 1 FROM public.crm_catalogo_config cc WHERE cc.empresa_id = e.id AND cc.publicado)
   ORDER BY e.id
$$;

-- 6.2 Catálogo público. Stock = SEMÁFORO calculado aquí; el número no sale.
CREATE OR REPLACE FUNCTION public.crm_catalogo(p_empresa integer DEFAULT NULL)
RETURNS TABLE (
  id bigint, item_id bigint, empresa_id integer, nombre text, grupo text,
  color_nombre text, color_no text, color_hex text, fotos jsonb,
  descripcion text, aplicaciones text, precio numeric, moneda text,
  igv_incluido boolean, peso_caja_kg numeric, conos_por_caja integer,
  semaforo text, orden_display integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH stock AS (
    SELECT l.item_id, su.empresa_id, SUM(su.cantidad) AS kg
      FROM public.stock_ubicaciones su
      JOIN public.lotes l ON l.id = su.lote_id
     GROUP BY l.item_id, su.empresa_id
  )
  SELECT cc.id, cc.item_id, cc.empresa_id,
         COALESCE(NULLIF(cc.nombre_web, ''), i.nombre)::text,
         COALESCE(NULLIF(cc.grupo, ''), ca.nombre, 'General')::text,
         cc.color_nombre::text, cc.color_no::text, cc.color_hex::text, cc.fotos,
         cc.descripcion_web, cc.aplicaciones,
         CASE WHEN cfg.mostrar_precios
              THEN COALESCE(NULLIF(cc.precio_lista, 0), NULLIF(i.precio_venta, 0)) END,
         cfg.moneda_precio::text, cfg.igv_incluido,
         COALESCE(cc.peso_caja_kg, (
           SELECT l2.peso_por_unidad FROM public.lotes l2
            WHERE l2.item_id = cc.item_id AND l2.empresa_id = cc.empresa_id AND l2.peso_por_unidad > 0
            GROUP BY l2.peso_por_unidad ORDER BY count(*) DESC, l2.peso_por_unidad LIMIT 1
         )),
         cc.conos_por_caja,
         (CASE
            WHEN COALESCE(s.kg, 0) <= 0 THEN 'agotado'
            WHEN s.kg < COALESCE(cc.stock_minimo_kg, cfg.semaforo_poco_kg, 100) THEN 'poco'
            ELSE 'disponible'
          END)::text,
         cc.orden_display
    FROM public.crm_catalogo_config cc
    JOIN public.items i            ON i.id = cc.item_id AND i.activo IS NOT FALSE
    JOIN public.crm_config cfg     ON cfg.empresa_id = cc.empresa_id
    LEFT JOIN public.categorias ca ON ca.id = i.categoria_id
    LEFT JOIN stock s              ON s.item_id = cc.item_id AND s.empresa_id = cc.empresa_id
   WHERE cc.publicado
     AND (p_empresa IS NULL OR cc.empresa_id = p_empresa)
   ORDER BY cc.orden_display, 5, 2
$$;

-- (El detalle de un producto se resuelve en el front filtrando este mismo resultado:
--  el catálogo es chico y así hay una sola función pública que auditar.)

-- 6.3 Autocompletar por RUC: SOLO la razón social (dato público de SUNAT).
--     Nada de correo, teléfono ni dirección: eso sería filtrar datos de clientes.
CREATE OR REPLACE FUNCTION public.crm_buscar_ruc(p_ruc text)
RETURNS TABLE (razon_social text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT x.nombre FROM (
    SELECT k.razon_social::text AS nombre, 1 AS prio FROM public.crm_clientes k WHERE k.ruc = p_ruc
    UNION ALL
    SELECT c.nombre::text, 2 FROM public.contacts c WHERE c.nro_documento = p_ruc
  ) x
  WHERE p_ruc ~ '^[0-9]{8}$|^[0-9]{11}$'
  ORDER BY x.prio LIMIT 1
$$;

-- 6.4 ¿Esta cotización admite un comprobante todavía? (la usa la policy de storage)
CREATE OR REPLACE FUNCTION public.fn_crm_cotizacion_abierta(p_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.crm_cotizaciones c
     WHERE c.id = p_id AND c.created_at > now() - interval '7 days'
       AND c.estado NOT IN ('cancelada','perdida')
  )
$$;

-- 6.5 Crear cotización. El precio SIEMPRE se lee de la BD (si el front lo mandara,
--     alguien cotizaría a S/ 1). Valida, limita el spam y no pisa datos de clientes.
CREATE OR REPLACE FUNCTION public.crm_crear_cotizacion(
  p_cliente  jsonb,
  p_entrega  jsonb,
  p_lineas   jsonb,
  p_notas    text DEFAULT NULL,
  p_empresa  integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_staff    boolean := COALESCE(public.fn_es_staff_crm(), false);
  v_uid      bigint  := public.fn_usuario_id();
  v_ruc      text    := btrim(COALESCE(p_cliente->>'ruc', ''));
  v_razon    text    := btrim(COALESCE(p_cliente->>'razon_social', ''));
  v_nombre   text    := btrim(COALESCE(p_cliente->>'nombre_contacto', ''));
  v_email    text    := lower(btrim(COALESCE(p_cliente->>'email', '')));
  v_tel      text    := btrim(COALESCE(p_cliente->>'telefono', ''));
  v_dirfis   text    := btrim(COALESCE(p_cliente->>'direccion_fiscal', ''));
  v_dirent   text    := btrim(COALESCE(p_entrega->>'dir_entrega', ''));
  v_distrito text    := btrim(COALESCE(p_entrega->>'distrito_entrega', ''));
  v_ref      text    := btrim(COALESCE(p_entrega->>'referencia_entrega', ''));
  v_cfg      public.crm_config%ROWTYPE;
  v_cli      uuid;
  v_cot      uuid;
  v_num      text;
  v_total    numeric;
  v_n        integer;
  l          jsonb;
  r          record;
  v_kg       numeric;
  v_orden    integer := 0;
BEGIN
  -- Validación de datos
  IF v_ruc !~ '^[0-9]{8}$' AND v_ruc !~ '^[0-9]{11}$' THEN RAISE EXCEPTION 'Documento inválido: usa DNI (8) o RUC (11 dígitos).'; END IF;
  IF length(v_razon) < 3     THEN RAISE EXCEPTION 'La razón social / nombre es obligatoria.'; END IF;
  IF length(v_nombre) < 2    THEN RAISE EXCEPTION 'El nombre de contacto es obligatorio.'; END IF;
  IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN RAISE EXCEPTION 'Correo electrónico inválido.'; END IF;
  IF length(v_dirent) < 5    THEN RAISE EXCEPTION 'La dirección de entrega es obligatoria.'; END IF;
  IF length(v_distrito) < 2  THEN RAISE EXCEPTION 'El distrito de entrega es obligatorio.'; END IF;
  IF length(v_razon) > 200 OR length(v_nombre) > 120 OR length(v_dirent) > 250
     OR length(COALESCE(p_notas, '')) > 1500 THEN RAISE EXCEPTION 'Algún campo excede el largo permitido.'; END IF;

  IF p_lineas IS NULL OR jsonb_typeof(p_lineas) <> 'array' THEN RAISE EXCEPTION 'La cotización no tiene productos.'; END IF;
  v_n := jsonb_array_length(p_lineas);
  IF v_n < 1 OR v_n > 40 THEN RAISE EXCEPTION 'La cotización debe tener entre 1 y 40 productos.'; END IF;

  -- Empresa: la de las líneas; debe tener CRM configurado
  IF p_empresa IS NULL THEN RAISE EXCEPTION 'Falta la empresa.'; END IF;
  SELECT * INTO v_cfg FROM public.crm_config WHERE empresa_id = p_empresa;
  IF NOT FOUND THEN RAISE EXCEPTION 'La empresa no tiene catálogo.'; END IF;

  -- Anti-spam (solo visitantes; el staff no tiene tope)
  IF NOT v_staff THEN
    IF (SELECT count(*) FROM public.crm_cotizaciones c
         WHERE c.created_at > now() - interval '24 hours'
           AND (lower(c.contacto_email) = v_email OR c.cliente_id IN (SELECT k.id FROM public.crm_clientes k WHERE k.ruc = v_ruc))) >= 5 THEN
      RAISE EXCEPTION 'Ya enviaste varias cotizaciones hoy. Escríbenos por WhatsApp para atenderte.';
    END IF;
    IF (SELECT count(*) FROM public.crm_cotizaciones c WHERE c.created_at > now() - interval '1 hour' AND c.origen = 'web') >= 200 THEN
      RAISE EXCEPTION 'Estamos recibiendo muchas solicitudes. Intenta en unos minutos.';
    END IF;
  END IF;

  -- Cliente: se crea una vez; NO se sobrescribe si el RUC ya existe
  SELECT id INTO v_cli FROM public.crm_clientes WHERE ruc = v_ruc;
  IF v_cli IS NULL THEN
    INSERT INTO public.crm_clientes (ruc, razon_social, nombre_contacto, email, telefono,
                                     direccion_fiscal, distrito, contact_id, origen, vendedor_id)
    VALUES (v_ruc, v_razon, v_nombre, v_email, NULLIF(v_tel, ''), NULLIF(v_dirfis, ''), NULLIF(v_distrito, ''),
            (SELECT c.id FROM public.contacts c WHERE c.nro_documento = v_ruc LIMIT 1),
            CASE WHEN v_staff THEN 'vendedor' ELSE 'web' END,
            CASE WHEN v_staff AND NOT public.fn_crm_gestor() THEN v_uid ELSE NULL END)
    RETURNING id INTO v_cli;
  END IF;

  -- Cabecera
  INSERT INTO public.crm_cotizaciones (
    empresa_id, cliente_id, vendedor_id, origen, razon_social, contacto_nombre, contacto_email,
    contacto_telefono, direccion_fiscal, dir_entrega, distrito_entrega, referencia_entrega,
    notas_cliente, moneda, igv_incluido)
  VALUES (
    p_empresa, v_cli, CASE WHEN v_staff THEN v_uid ELSE NULL END,
    CASE WHEN v_staff THEN 'vendedor' ELSE 'web' END,
    v_razon, v_nombre, v_email, NULLIF(v_tel, ''), NULLIF(v_dirfis, ''), v_dirent, v_distrito, NULLIF(v_ref, ''),
    NULLIF(btrim(COALESCE(p_notas, '')), ''), v_cfg.moneda_precio, v_cfg.igv_incluido)
  RETURNING id, numero INTO v_cot, v_num;

  -- Líneas: precio y nombre salen de la BD
  FOR l IN SELECT * FROM jsonb_array_elements(p_lineas) LOOP
    BEGIN
      v_kg := (l->>'cantidad_kg')::numeric;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Cantidad inválida en un producto.';
    END;
    IF v_kg IS NULL OR v_kg <= 0 OR v_kg > 200000 THEN RAISE EXCEPTION 'Cantidad inválida (máx. 200 000 kg por línea).'; END IF;

    SELECT * INTO r FROM public.crm_catalogo(p_empresa) c WHERE c.id = (l->>'catalogo_id')::bigint;
    IF NOT FOUND THEN RAISE EXCEPTION 'Un producto ya no está disponible en el catálogo.'; END IF;
    IF r.semaforo = 'agotado' AND NOT v_staff THEN
      RAISE EXCEPTION 'Producto agotado: %. Consúltanos por WhatsApp.', r.nombre;
    END IF;

    v_orden := v_orden + 1;
    INSERT INTO public.crm_cotizacion_detalle (cotizacion_id, catalogo_id, item_id, producto_nombre,
           producto_categoria, color_nombre, cantidad_kg, peso_x_caja, precio_unitario, orden_linea)
    VALUES (v_cot, r.id, r.item_id, r.nombre, r.grupo, r.color_nombre, v_kg, r.peso_caja_kg,
            COALESCE(r.precio, 0), v_orden);
  END LOOP;

  SELECT total INTO v_total FROM public.crm_cotizaciones WHERE id = v_cot;
  RETURN jsonb_build_object('id', v_cot, 'numero', v_num, 'total', v_total);
END $$;

-- 6.6 Adjuntar el comprobante ya subido al bucket
CREATE OR REPLACE FUNCTION public.crm_adjuntar_comprobante(p_cotizacion uuid, p_path text, p_nombre text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_path IS NULL OR p_path NOT LIKE ('comprobantes/' || p_cotizacion::text || '/%') THEN
    RAISE EXCEPTION 'Ruta de comprobante inválida.';
  END IF;
  IF NOT public.fn_crm_cotizacion_abierta(p_cotizacion) THEN
    RAISE EXCEPTION 'Esta cotización ya no admite comprobantes.';
  END IF;
  UPDATE public.crm_cotizaciones
     SET comprobante_path = p_path,
         comprobante_nombre = left(p_nombre, 200),
         comprobante_fecha = now(),
         estado_pago = CASE WHEN estado_pago = 'pagado' THEN estado_pago ELSE 'parcial' END
   WHERE id = p_cotizacion;
  INSERT INTO public.crm_seguimiento (cotizacion_id, tipo, detalle)
  VALUES (p_cotizacion, 'pago', 'El cliente subió un comprobante de pago: ' || COALESCE(left(p_nombre, 120), 'archivo'));
  RETURN true;
END $$;

-- 6.B  STAFF (solo authenticated con rol admin/oficina/vendedor)
-- Stock real por lote y zona: kilos exactos, unidades, peso por unidad.
-- NUNCA devuelve costos.
CREATE OR REPLACE FUNCTION public.crm_stock_lotes(p_item_id bigint DEFAULT NULL, p_empresa integer DEFAULT NULL)
RETURNS TABLE (
  lote_id bigint, item_id bigint, empresa_id integer, item_nombre text, numero_lote text,
  kg numeric, unidades numeric, peso_por_unidad numeric, almacen text, ubicacion text,
  fecha_ingreso date
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.fn_es_staff_crm() THEN
    RAISE EXCEPTION 'Sin permiso para ver el stock por lote.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT l.id, l.item_id, su.empresa_id, i.nombre::text, l.numero_lote::text,
         su.cantidad, su.cantidad_unidades, l.peso_por_unidad,
         a.nombre::text, u.nombre::text, l.fecha_ingreso
    FROM public.stock_ubicaciones su
    JOIN public.lotes l        ON l.id = su.lote_id
    JOIN public.items i        ON i.id = l.item_id
    JOIN public.ubicaciones u  ON u.id = su.ubicacion_id
    JOIN public.almacenes a    ON a.id = u.almacen_id
   WHERE (p_item_id IS NULL OR l.item_id = p_item_id)
     AND (p_empresa IS NULL OR su.empresa_id = p_empresa)
   ORDER BY i.nombre, l.numero_lote;
END $$;

-- Grants de las funciones nuevas (el REVOKE de §1 ya quitó el EXECUTE a PUBLIC)
GRANT EXECUTE ON FUNCTION
  public.crm_empresas_publicas(),
  public.crm_catalogo(integer),
  public.crm_buscar_ruc(text),
  public.crm_crear_cotizacion(jsonb, jsonb, jsonb, text, integer),
  public.crm_adjuntar_comprobante(uuid, text, text),
  public.fn_crm_cotizacion_abierta(uuid)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crm_stock_lotes(bigint, integer) TO authenticated, service_role;

-- ============================================================================
-- §7 · STORAGE
--   crm-comprobantes  PRIVADO. El visitante solo puede SUBIR (sin leer, sin listar,
--                     sin pisar) y solo en la carpeta de una cotización abierta.
--   crm-catalogo      PÚBLICO de lectura (fotos del catálogo). Escribe admin/oficina.
-- ============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('crm-comprobantes', 'crm-comprobantes', false, 5242880,
        ARRAY['image/jpeg','image/png','image/webp','application/pdf'])
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = 5242880,
      allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','application/pdf'];

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('crm-catalogo', 'crm-catalogo', true, 3145728,
        ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = true, file_size_limit = 3145728,
      allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp'];

DROP POLICY IF EXISTS crm_comprobantes_subir    ON storage.objects;
DROP POLICY IF EXISTS crm_comprobantes_ver      ON storage.objects;
DROP POLICY IF EXISTS crm_comprobantes_borrar   ON storage.objects;
DROP POLICY IF EXISTS crm_catalogo_ver          ON storage.objects;
DROP POLICY IF EXISTS crm_catalogo_subir        ON storage.objects;
DROP POLICY IF EXISTS crm_catalogo_editar       ON storage.objects;
DROP POLICY IF EXISTS crm_catalogo_borrar       ON storage.objects;

CREATE POLICY crm_comprobantes_subir ON storage.objects FOR INSERT TO anon, authenticated
  WITH CHECK (
    bucket_id = 'crm-comprobantes'
    AND name ~ '^comprobantes/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+$'
    AND public.fn_crm_cotizacion_abierta(((storage.foldername(name))[2])::uuid)
  );
CREATE POLICY crm_comprobantes_ver ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'crm-comprobantes' AND public.fn_es_staff_crm());
CREATE POLICY crm_comprobantes_borrar ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'crm-comprobantes' AND public.fn_crm_gestor());

CREATE POLICY crm_catalogo_ver ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'crm-catalogo');
CREATE POLICY crm_catalogo_subir ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'crm-catalogo' AND public.fn_crm_gestor());
CREATE POLICY crm_catalogo_editar ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'crm-catalogo' AND public.fn_crm_gestor())
  WITH CHECK (bucket_id = 'crm-catalogo' AND public.fn_crm_gestor());
CREATE POLICY crm_catalogo_borrar ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'crm-catalogo' AND public.fn_crm_gestor());

-- ============================================================================
-- §8 · REALTIME (el panel interno se actualiza solo cuando entra una cotización)
-- ============================================================================
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['crm_cotizaciones','crm_cotizacion_detalle','crm_seguimiento','crm_clientes'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $$;

-- ============================================================================
-- §9 · ENDURECIMIENTO OPCIONAL — OFF por defecto
-- ----------------------------------------------------------------------------
-- Hoy `authenticated` = cualquiera con una cuenta (el registro es abierto) y las
-- 43+ policies dicen USING (true): una cuenta nueva ya puede leer/escribir TODO el ERP.
-- Poniendo v_endurecer := true, las policies USING (true) pasan a exigir un usuario
-- ACTIVO en public.users. No cambia nada para los usuarios actuales (todos activos).
-- PRUEBA primero: inicia sesión, abre 3 módulos. Para revertir:
--     (re-ejecuta 03_rls_policies.sql §3, o cambia fn_usuario_activo() a "SELECT true")
-- ============================================================================
DO $$
DECLARE
  v_endurecer boolean := false;     -- ← cambiar a true cuando quieras activarlo
  p record;
  v_expr text := '(SELECT public.fn_usuario_activo())';
BEGIN
  IF NOT v_endurecer THEN
    RAISE NOTICE '§9 omitido (v_endurecer = false).';
    RETURN;
  END IF;
  FOR p IN
    SELECT schemaname, tablename, policyname, cmd, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename NOT LIKE 'crm\_%'
       AND (btrim(COALESCE(qual, '')) = 'true' OR btrim(COALESCE(with_check, '')) = 'true')
  LOOP
    IF p.cmd IN ('SELECT','DELETE') THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)', p.policyname, p.schemaname, p.tablename, v_expr);
    ELSIF p.cmd = 'INSERT' THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I WITH CHECK (%s)', p.policyname, p.schemaname, p.tablename, v_expr);
    ELSE   -- ALL / UPDATE
      IF btrim(COALESCE(p.qual, '')) = 'true' AND btrim(COALESCE(p.with_check, '')) = 'true' THEN
        EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s) WITH CHECK (%s)', p.policyname, p.schemaname, p.tablename, v_expr, v_expr);
      ELSIF btrim(COALESCE(p.qual, '')) = 'true' THEN
        EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)', p.policyname, p.schemaname, p.tablename, v_expr);
      ELSE
        EXECUTE format('ALTER POLICY %I ON %I.%I WITH CHECK (%s)', p.policyname, p.schemaname, p.tablename, v_expr);
      END IF;
    END IF;
  END LOOP;
END $$;

COMMIT;

-- ============================================================================
-- §10 · VERIFICACIÓN — el resultado debe decir "OK" y nada más.
-- Si lista filas, cada una es algo que sigue abierto al público.
-- ============================================================================
WITH critico AS (
  -- tablas/vistas que `anon` todavía puede leer
  SELECT 'anon lee ' || c.relkind::text AS hallazgo, c.relname::text AS detalle
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p')
     AND has_table_privilege('anon', c.oid, 'SELECT')
  UNION ALL
  -- funciones que `anon` puede ejecutar (deben ser solo las 6 públicas del CRM)
  SELECT 'anon ejecuta función', p.proname::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE')
     AND p.prokind = 'f'
     AND p.proname NOT IN ('crm_empresas_publicas','crm_catalogo','crm_buscar_ruc',
                           'crm_crear_cotizacion','crm_adjuntar_comprobante','fn_crm_cotizacion_abierta')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')   -- ignora funciones de extensiones
  UNION ALL
  -- policies de public que aún nombran anon/public
  SELECT 'policy abierta a anon/public', tablename || '.' || policyname
    FROM pg_policies WHERE schemaname = 'public' AND ('anon' = ANY(roles) OR 'public' = ANY(roles))
),
aviso AS (
  -- storage: revisar a mano las que no sean del CRM
  SELECT 'REVISAR storage abierto a anon/public' AS hallazgo, policyname::text AS detalle
    FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
     AND ('anon' = ANY(roles) OR 'public' = ANY(roles))
     AND policyname NOT IN ('crm_comprobantes_subir','crm_catalogo_ver')
  UNION ALL
  -- informativo: tablas sin RLS (anon ya no las lee, pero conviene activarla)
  SELECT 'INFO tabla sin RLS', c.relname::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
)
SELECT * FROM critico
UNION ALL SELECT * FROM aviso
UNION ALL
SELECT 'OK', 'anon no lee tablas ni vistas y solo ejecuta las 6 funciones públicas del CRM.'
 WHERE NOT EXISTS (SELECT 1 FROM critico);
