-- 164_tenants_modelo.sql  (2026-11-25) — T1 del plan multi-tenant
-- Tenant = cliente del SaaS (grupo de empresas). Empresa = un RUC dentro de un tenant.
-- Decisiones de Luis (2026-11-25): rol POR TENANT + empresas permitidas (users.empresas_permitidas);
-- kardex particionado por tenant (SQL 166); plan premium = proyecto Supabase propio (runbook T6).
--
-- Qué hace:
--   1) tabla `tenants` (plan base/premium, estado, URL del proyecto si es premium)
--   2) empresa_config.tenant_id y users.tenant_id (backfill: todo lo actual = tenant 1)
--   3) users.es_superadmin (solo Luis: crea tenants desde el panel)
--   4) funciones de contexto para RLS: mx_tenant_id(), mx_es_superadmin(), mx_empresas_ids()
-- NO cambia ninguna política existente (eso es el SQL 165 / T2, después de revisar el diagnóstico 163).
-- Idempotente. Un inicio de sesión sin fila en `users` (auth_id) obtiene tenant NULL = ve nada.

begin;

-- 1) Tenants ────────────────────────────────────────────────────────────────────
create table if not exists public.tenants (
  id            serial primary key,
  codigo        text    not null unique,
  nombre        text    not null,
  plan          text    not null default 'base'   check (plan   in ('base','premium')),
  estado        text    not null default 'activo' check (estado in ('activo','suspendido','migrado')),
  supabase_url  text,                                  -- solo premium: proyecto propio
  notas         text,
  created_at    timestamptz not null default now()
);
comment on table public.tenants is 'Clientes del SaaS. Un tenant agrupa N empresas (empresa_config). Premium = proyecto Supabase propio (supabase_url).';

insert into public.tenants (id, codigo, nombre)
values (1, 'JHIRO-GROUP', 'Grupo Jhiro')
on conflict (id) do nothing;
select setval(pg_get_serial_sequence('public.tenants','id'), greatest((select max(id) from public.tenants), 1));

-- 2) tenant_id en empresas y usuarios ───────────────────────────────────────────
alter table public.empresa_config add column if not exists tenant_id int references public.tenants(id);
update public.empresa_config set tenant_id = 1 where tenant_id is null;
alter table public.empresa_config alter column tenant_id set not null;
create index if not exists idx_empresa_config_tenant on public.empresa_config(tenant_id);

alter table public.users add column if not exists tenant_id int references public.tenants(id);
alter table public.users add column if not exists es_superadmin boolean not null default false;
update public.users set tenant_id = 1 where tenant_id is null;
alter table public.users alter column tenant_id set not null;
create index if not exists idx_users_tenant on public.users(tenant_id);

-- 3) Funciones de contexto (SECURITY DEFINER para no recursar en las RLS de users/empresa_config) ──
create or replace function public.mx_tenant_id() returns int
language sql stable security definer set search_path = public as $$
  select tenant_id from public.users where auth_id = auth.uid() and active limit 1
$$;

create or replace function public.mx_es_superadmin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select es_superadmin from public.users where auth_id = auth.uid() and active limit 1), false)
$$;

-- Empresas que el usuario puede ver: las de SU tenant, filtradas por empresas_permitidas (NULL = todas del tenant)
create or replace function public.mx_empresas_ids() returns int[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(e.id), '{}')
    from public.empresa_config e
    join public.users u on u.tenant_id = e.tenant_id
   where u.auth_id = auth.uid() and u.active
     and (u.empresas_permitidas is null or e.id = any (u.empresas_permitidas))
$$;

grant execute on function public.mx_tenant_id(), public.mx_es_superadmin(), public.mx_empresas_ids() to authenticated;

-- Altas desde la UI (modal de empresas, usuarios) heredan el tenant del que las crea
alter table public.empresa_config alter column tenant_id set default public.mx_tenant_id();
alter table public.users          alter column tenant_id set default public.mx_tenant_id();

-- 4) RLS de la propia tabla tenants: cada usuario ve solo su tenant; escribe solo el superadmin ──
alter table public.tenants enable row level security;
drop policy if exists tenants_select on public.tenants;
create policy tenants_select on public.tenants for select to authenticated
  using (id = public.mx_tenant_id() or public.mx_es_superadmin());
drop policy if exists tenants_write on public.tenants;
create policy tenants_write on public.tenants for all to authenticated
  using (public.mx_es_superadmin()) with check (public.mx_es_superadmin());

commit;

-- ── Después de correr: marcar a Luis como superadmin (cambiar el id/email) ──
-- update public.users set es_superadmin = true where id = <TU_ID>;

-- ── Verificación ──
-- select id, codigo, plan, estado from public.tenants;
-- select tenant_id, count(*) from public.empresa_config group by 1;
-- select tenant_id, role, count(*) from public.users group by 1,2;

-- ── Rollback ──
-- alter table public.empresa_config alter column tenant_id drop default; alter table public.users alter column tenant_id drop default;
-- drop function if exists public.mx_empresas_ids(), public.mx_es_superadmin(), public.mx_tenant_id();
-- alter table public.users drop column if exists es_superadmin, drop column if exists tenant_id;
-- alter table public.empresa_config drop column if exists tenant_id;
-- drop table if exists public.tenants;
