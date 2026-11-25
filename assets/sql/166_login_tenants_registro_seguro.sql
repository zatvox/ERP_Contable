-- 166_login_tenants_registro_seguro.sql  (2026-11-25) — login/registro con tenants
-- Requiere 164 y 165. Una transacción: si algo falla no se aplica nada.
--
-- 1) REGISTRO SEGURO. El trigger anterior (05_usuarios.sql) tomaba el ROL desde lo que escribía quien se registra
--    (raw_user_meta_data.role) → cualquiera podía registrarse como admin. Además, con 2+ tenants el default de tenant
--    habría hecho fallar todo alta de usuario. Ahora:
--      · el rol SIEMPRE es 'user' y la cuenta queda INACTIVA hasta que un admin la apruebe;
--      · se asigna al tenant cuyo código se escribió en el registro (metadata.tenant_codigo);
--      · sin código válido NO se crea fila en users (el superadmin lo vincula con vincular_usuario_tenant).
-- 2) tenants.supabase_anon_key (para clientes premium con proyecto propio) y tenant_login_info() actualizado.
-- 3) Tú como superadmin (id 2 = 'Luis Paz', confirmado por el resumen del 165). El tenant 1 sigue como JHIRO-GROUP / Grupo Jhiro.
-- 4) La secuencia de tenants vuelve a max(id): el próximo tenant será el 2 (la prueba T5 consumió un número).

begin;

create or replace function public.fn_on_auth_user_created() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_t int;
begin
  select id into v_t from public.tenants
   where codigo = upper(btrim(coalesce(new.raw_user_meta_data->>'tenant_codigo', ''))) and estado = 'activo';
  if v_t is null then return new; end if;          -- sin código válido: queda solo en Auth, sin acceso a datos
  insert into public.users (auth_id, username, email, nombre, role, password_hash, active, tenant_id)
  values (new.id, coalesce(new.email, new.id::text), new.email,
          coalesce(new.raw_user_meta_data->>'nombre', split_part(new.email, '@', 1)),
          'user', '', false, v_t)                  -- rol fijo + pendiente de aprobación
  on conflict (auth_id) do nothing;
  return new;
end $$;

alter table public.tenants add column if not exists supabase_anon_key text;

create or replace function public.tenant_login_info(p_codigo text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('nombre', nombre, 'plan', plan, 'estado', estado,
                            'supabase_url', supabase_url, 'supabase_anon_key', supabase_anon_key)
    from public.tenants where codigo = upper(btrim(p_codigo)) and estado = 'activo'
$$;
grant execute on function public.tenant_login_info(text) to anon, authenticated;

update public.users set es_superadmin = true where id = 2 and nombre = 'Luis Paz';
select setval(pg_get_serial_sequence('public.tenants','id'), (select max(id) from public.tenants));

commit;

select (select count(*) from public.users where es_superadmin) as superadmins,
       (select string_agg(id || ':' || codigo || ':' || nombre, ', ') from public.tenants) as tenants,
       (select string_agg(codigo, ', ' order by id) from public.empresa_config where tenant_id = 1) as empresas_tenant_1;
