-- ============================================================
-- JHIRO ERP v2 — VINCULACIÓN auth.users ↔ public.users
-- Archivo: 05_usuarios.sql
-- Ejecutar después de 00_grants.sql y 01_schema.sql
-- ============================================================

-- 1. Agregar columna auth_id a public.users (vincula con auth.users)
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS auth_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE;

-- 2. Trigger: al crear un usuario en auth.users, insertar automáticamente
--    en public.users con nombre y role desde user_metadata
CREATE OR REPLACE FUNCTION public.fn_on_auth_user_created()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (auth_id, username, email, nombre, role, password_hash, active)
  VALUES (
    NEW.id,
    COALESCE(NEW.email, NEW.id::text),
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'nombre', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'role', 'user'),
    '',      -- no almacenamos hash, Supabase Auth maneja la contraseña
    true
  )
  ON CONFLICT (auth_id) DO UPDATE SET
    email  = EXCLUDED.email,
    nombre = EXCLUDED.nombre;
  RETURN NEW;
END;
$$;

-- Eliminar trigger anterior si existe
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- Crear trigger en auth.users
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.fn_on_auth_user_created();

-- 3. GRANT para que el trigger (SECURITY DEFINER) pueda insertar
GRANT INSERT, UPDATE ON public.users TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.users_id_seq TO service_role;

-- 4. Función auxiliar SECURITY DEFINER para evitar recursión en RLS
--    (corre como el dueño de la función, saltea RLS — sin bucle infinito)
CREATE OR REPLACE FUNCTION public.fn_is_admin()
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_id = auth.uid() AND role = 'admin'
  )
$$;

-- Política RLS: cada usuario ve solo su propio perfil
DROP POLICY IF EXISTS erp_auth_all   ON public.users;
DROP POLICY IF EXISTS erp_users_self ON public.users;
DROP POLICY IF EXISTS erp_users_admin ON public.users;

CREATE POLICY erp_users_self ON public.users
  FOR SELECT TO authenticated
  USING (auth_id = auth.uid());

-- Admins ven y editan todos los registros
-- NOTA: usa fn_is_admin() (SECURITY DEFINER) para evitar recursión 500
CREATE POLICY erp_users_admin ON public.users
  FOR ALL TO authenticated
  USING (public.fn_is_admin())
  WITH CHECK (public.fn_is_admin());

-- 5. Sincronizar usuarios auth existentes que ya no tienen registro en public.users
INSERT INTO public.users (auth_id, username, email, nombre, role, password_hash, active)
SELECT
  au.id,
  au.email,
  au.email,
  COALESCE(au.raw_user_meta_data->>'nombre', split_part(au.email, '@', 1)),
  COALESCE(au.raw_user_meta_data->>'role', 'admin'),
  '',
  true
FROM auth.users au
WHERE NOT EXISTS (
  SELECT 1 FROM public.users pu WHERE pu.auth_id = au.id
)
ON CONFLICT (email) DO UPDATE SET
  auth_id = EXCLUDED.auth_id,
  nombre  = EXCLUDED.nombre;
