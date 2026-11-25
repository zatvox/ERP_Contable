-- 168_superadmin_un_tenant_a_la_vez.sql (2026-11-25)
-- Requiere 164–167. Una transacción.
-- Antes: el superadmin veía users/empresa_config de TODOS los tenants (para el panel) → estando en PRUEBA aparecían
-- los usuarios y empresas de Jhiro. Ahora TODO el ERP muestra solo el tenant activo, incluso para el superadmin.
-- El panel "Clientes" ya no lee esas tablas: usa panel_tenants() (solo superadmin) que devuelve el resumen de todos.
begin;

do $$ declare t text; begin
  foreach t in array array['users','empresa_config'] loop
    execute format('drop policy if exists mx_tenant_iso on public.%I', t);
    execute format('create policy mx_tenant_iso on public.%I as restrictive for all to public
      using (tenant_id = (select public.mx_tenant_id()))
      with check (tenant_id = (select public.mx_tenant_id()))', t);
  end loop;
end $$;

create or replace function public.panel_tenants() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.mx_es_superadmin() then raise exception 'Solo el superadmin'; end if;
  return jsonb_build_object(
    'actual', public.mx_tenant_id(),
    'tenants', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'codigo', t.codigo, 'nombre', t.nombre, 'plan', t.plan, 'estado', t.estado, 'supabase_url', t.supabase_url,
        'usuarios', (select count(*) from public.users u where u.tenant_id = t.id and u.active),
        'empresas', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'codigo', e.codigo, 'razon_social', e.razon_social) order by e.id), '[]'::jsonb)
                       from public.empresa_config e where e.tenant_id = t.id)
      ) order by t.id) from public.tenants t), '[]'::jsonb));
end $$;
grant execute on function public.panel_tenants() to authenticated;

commit;

select (select count(*) from pg_policies where policyname = 'mx_tenant_iso' and tablename in ('users','empresa_config')) as politicas_ok;
