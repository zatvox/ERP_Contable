-- 167_usuarios_multi_tenant.sql  (2026-11-25) — un mismo usuario en varios tenants (contador, superadmin)
-- Requiere 164, 165 y 166. Una transacción: si algo falla no se aplica nada.
--
-- MODELO
--  · user_tenants = "accesos" de una cuenta: (auth_id, tenant_id, role, empresas_permitidas, activo).
--  · users.* sigue siendo el espejo del tenant ACTIVO (todo el RLS del 165 sigue igual: un solo tenant por sesión).
--  · cambiar_tenant(id) cambia el tenant activo de la cuenta (valida acceso). Cambiar = recargar el ERP en ese tenant.
--  · superadmin: puede entrar a CUALQUIER tenant base como admin, sin que lo vinculen.
--  · Un trigger mantiene sincronizado el acceso del tenant activo cuando un admin edita rol/empresas/activo en la app.
--  · Los tenants premium (proyecto propio) no aparecen aquí: se entra con su código en el login.

begin;

create table if not exists public.user_tenants (
  id                  serial primary key,
  auth_id             uuid    not null,
  tenant_id           int     not null references public.tenants(id) on delete cascade,
  role                varchar not null default 'user',
  empresas_permitidas int[],
  activo              boolean not null default true,
  created_at          timestamptz not null default now(),
  unique (auth_id, tenant_id)
);
create index if not exists idx_user_tenants_auth on public.user_tenants (auth_id);
comment on table public.user_tenants is 'Accesos de una cuenta de Auth a tenants (contador, superadmin). users.* refleja el tenant activo.';

alter table public.user_tenants enable row level security;
drop policy if exists user_tenants_select on public.user_tenants;
create policy user_tenants_select on public.user_tenants for select to authenticated
  using (auth_id = auth.uid() or (select public.mx_es_superadmin()));
revoke all on public.user_tenants from anon;
revoke insert, update, delete on public.user_tenants from authenticated;   -- solo por funciones

-- Accesos actuales = el tenant en el que ya está cada usuario
insert into public.user_tenants (auth_id, tenant_id, role, empresas_permitidas, activo)
select auth_id, tenant_id, coalesce(role, 'user'), empresas_permitidas, coalesce(active, true)
  from public.users where auth_id is not null
on conflict (auth_id, tenant_id) do nothing;

-- Si un admin edita rol / empresas / activo (RRHH → Usuarios), el acceso del tenant activo se mantiene al día
create or replace function public.fn_users_sync_acceso() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.auth_id is not null and new.tenant_id is not null then
    insert into public.user_tenants (auth_id, tenant_id, role, empresas_permitidas, activo)
    values (new.auth_id, new.tenant_id, coalesce(new.role, 'user'), new.empresas_permitidas, coalesce(new.active, true))
    on conflict (auth_id, tenant_id) do update
      set role = excluded.role, empresas_permitidas = excluded.empresas_permitidas, activo = excluded.activo;
  end if;
  return new;
end $$;
drop trigger if exists trg_users_sync_acceso on public.users;
create trigger trg_users_sync_acceso after insert or update of role, empresas_permitidas, active, tenant_id on public.users
  for each row execute function public.fn_users_sync_acceso();

-- Tenants a los que puedo entrar (para el selector del login y el botón "Cambiar de empresa")
create or replace function public.mis_tenants() returns table (tenant_id int, codigo text, nombre text, plan text, role text, activo boolean, actual boolean)
language sql stable security definer set search_path = public as $$
  with yo as (select id, tenant_id as actual_id, es_superadmin from public.users where auth_id = auth.uid() limit 1)
  select t.id, t.codigo, t.nombre, t.plan,
         coalesce(a.role, 'admin')::text,
         (yo.es_superadmin or coalesce(a.activo, false)),
         (t.id = yo.actual_id)
    from yo
    join public.tenants t on t.estado = 'activo' and t.supabase_url is null
    left join public.user_tenants a on a.auth_id = auth.uid() and a.tenant_id = t.id
   where yo.es_superadmin or a.id is not null
   order by t.id
$$;
grant execute on function public.mis_tenants() to authenticated;

create or replace function public.cambiar_tenant(p_tenant int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u public.users%rowtype; a public.user_tenants%rowtype; t public.tenants%rowtype; v_emp int;
begin
  select * into u from public.users where auth_id = auth.uid() limit 1;
  if u.id is null then raise exception 'Tu cuenta no está vinculada a ninguna empresa'; end if;
  select * into t from public.tenants where id = p_tenant and estado = 'activo' and supabase_url is null;
  if t.id is null then raise exception 'Ese tenant no existe o usa un sistema propio'; end if;
  select * into a from public.user_tenants where auth_id = auth.uid() and tenant_id = p_tenant;
  if a.id is null and not u.es_superadmin then raise exception 'No tienes acceso a ese tenant'; end if;
  if a.id is not null and not a.activo and not u.es_superadmin then raise exception 'Tu acceso a ese tenant está pendiente de aprobación'; end if;

  select min(e.id) into v_emp from public.empresa_config e
   where e.tenant_id = p_tenant and (a.empresas_permitidas is null or e.id = any (a.empresas_permitidas));
  update public.users
     set tenant_id = p_tenant,
         role = coalesce(a.role, 'admin'),
         empresas_permitidas = a.empresas_permitidas,     -- sin acceso previo (superadmin) = NULL = todas las del tenant
         empresa_id_default = v_emp,
         active = true
   where id = u.id;
  return jsonb_build_object('tenant_id', t.id, 'codigo', t.codigo, 'nombre', t.nombre, 'role', coalesce(a.role, 'admin'));
end $$;
grant execute on function public.cambiar_tenant(int) to authenticated;

-- Vincular: ahora AGREGA un acceso (la cuenta puede tener varios). p_activar = además la deja trabajando en ese tenant.
drop function if exists public.vincular_usuario_tenant(uuid, text, text, int, text, int[]);
create or replace function public.vincular_usuario_tenant(
  p_auth_id uuid, p_email text, p_nombre text, p_tenant int, p_role text default 'admin', p_empresas int[] default null, p_activar boolean default false)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if auth.uid() is not null and not public.mx_es_superadmin() then raise exception 'Solo el superadmin puede vincular usuarios'; end if;
  insert into public.user_tenants (auth_id, tenant_id, role, empresas_permitidas, activo)
  values (p_auth_id, p_tenant, p_role, p_empresas, true)
  on conflict (auth_id, tenant_id) do update set role = excluded.role, empresas_permitidas = excluded.empresas_permitidas, activo = true;

  select id into v_id from public.users where auth_id = p_auth_id;
  if v_id is null then
    insert into public.users (username, password_hash, nombre, email, role, active, auth_id, tenant_id, empresas_permitidas, empresa_id_default)
    values (lower(p_email), '', p_nombre, lower(p_email), p_role, true, p_auth_id, p_tenant, p_empresas,
            (select min(id) from public.empresa_config where tenant_id = p_tenant))
    returning id into v_id;
  elsif p_activar then
    update public.users set tenant_id = p_tenant, role = p_role, empresas_permitidas = p_empresas, active = true,
           empresa_id_default = (select min(id) from public.empresa_config where tenant_id = p_tenant and (p_empresas is null or id = any (p_empresas)))
     where id = v_id;
  end if;
  return v_id;
end $$;
revoke all on function public.vincular_usuario_tenant(uuid,text,text,int,text,int[],boolean) from public, anon;
grant execute on function public.vincular_usuario_tenant(uuid,text,text,int,text,int[],boolean) to authenticated;

commit;

select (select count(*) from public.user_tenants) as accesos,
       (select string_agg(u.nombre || '→' || a.tenant_id || ':' || a.role, ', ') from public.user_tenants a join public.users u on u.auth_id = a.auth_id) as detalle;
