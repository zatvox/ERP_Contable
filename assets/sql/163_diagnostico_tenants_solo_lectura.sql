-- 163_diagnostico_tenants_solo_lectura.sql  (2026-11-25)
-- SOLO LECTURA. No modifica nada. Insumo para diseñar los SQL de tenants (T1–T3).
-- Correr cada bloque por separado en el SQL Editor del proyecto del ERP y copiar el resultado (una sola celda JSON).

-- ═══ D1 · Resumen general y tablas sin empresa_id ═══════════════════════════════
select jsonb_build_object(
  'tablas',        (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')),
  'con_rls',       (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity),
  'politicas',     (select count(*) from pg_policies where schemaname='public'),
  'pol_abiertas',  (select count(*) from pg_policies where schemaname='public' and (qual='true' or with_check='true')),
  'con_empresa',   (select count(distinct table_name) from information_schema.columns where table_schema='public' and column_name='empresa_id'),
  'sin_empresa',   (select jsonb_agg(table_name order by table_name) from information_schema.tables t
                     where t.table_schema='public' and t.table_type='BASE TABLE'
                       and not exists (select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=t.table_name and c.column_name='empresa_id')),
  'top_tablas',    (select jsonb_agg(x) from (select c.relname t, c.reltuples::bigint filas, pg_size_pretty(pg_total_relation_size(c.oid)) peso
                     from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'
                     order by pg_total_relation_size(c.oid) desc limit 15) x)
) as d1;

-- ═══ D2 · Kardex: columnas, restricciones, índices, triggers, dependencias ══════
select jsonb_build_object(
  'columnas',  (select jsonb_agg(jsonb_build_object('c',column_name,'t',data_type,'null',is_nullable,'def',column_default) order by ordinal_position)
                from information_schema.columns where table_schema='public' and table_name='kardex'),
  'restricciones', (select jsonb_agg(jsonb_build_object('n',conname,'def',pg_get_constraintdef(oid))) from pg_constraint where conrelid='public.kardex'::regclass),
  'indices',   (select jsonb_agg(indexdef) from pg_indexes where schemaname='public' and tablename='kardex'),
  'triggers',  (select jsonb_agg(pg_get_triggerdef(oid)) from pg_trigger where tgrelid='public.kardex'::regclass and not tgisinternal),
  'fks_hacia_kardex', (select jsonb_agg(conrelid::regclass::text) from pg_constraint where confrelid='public.kardex'::regclass),
  'vistas_que_lo_usan', (select jsonb_agg(distinct v.relname) from pg_depend d
                          join pg_rewrite r on r.oid=d.objid join pg_class v on v.oid=r.ev_class
                         where d.refobjid='public.kardex'::regclass and v.relkind in ('v','m')),
  'funciones_que_lo_mencionan', (select jsonb_agg(p.proname order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                          where n.nspname='public' and p.prosrc ilike '%kardex%'),
  'filas',     (select count(*) from public.kardex),
  'por_empresa', (select jsonb_object_agg(empresa_id::text, n) from (select empresa_id, count(*) n from public.kardex group by 1) z)
) as d2;

-- ═══ D3 · Políticas RLS actuales (compactas) ═══════════════════════════════════
select jsonb_agg(jsonb_build_object('t',tablename,'p',policyname,'cmd',cmd,'roles',roles,'q',left(qual,140),'wc',left(with_check,140)) order by tablename, policyname) as d3
from pg_policies where schemaname='public';

-- ═══ D4 · Usuarios, Auth y permisos del rol anon ═══════════════════════════════
select jsonb_build_object(
  'usuarios', (select jsonb_agg(jsonb_build_object('id',id,'role',role,'active',active,'con_auth',auth_id is not null,'empresas',empresas_permitidas,'default',empresa_id_default,
                'pass_hash_lleno', coalesce(length(password_hash),0) > 0) order by id) from public.users),
  'auth_users', (select count(*) from auth.users),
  'empresas',   (select jsonb_agg(jsonb_build_object('id',id,'codigo',codigo) order by id) from public.empresa_config),
  'anon_tablas_con_select', (select count(distinct table_name) from information_schema.role_table_grants where table_schema='public' and grantee='anon' and privilege_type='SELECT'),
  'funciones_security_definer', (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef)
) as d4;
