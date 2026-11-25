-- 165_tenants_rls_kardex_particionado.sql  (2026-11-25) — T2 + T3 + T5 en UN archivo
-- Requiere: 164_tenants_modelo.sql ya corrido.  Todo va en UNA transacción: si algo falla, NO se aplica nada.
--
-- QUÉ HACE
--  T2  Aislamiento por tenant con políticas RESTRICTIVAS (se suman a las actuales, no las reemplazan):
--        · tablas con empresa_id        → empresa_id ∈ mx_empresas_ids()   (tu tenant + empresas_permitidas)
--        · empresa_id NULL (familiar)   → + tenant_id propio
--        · catálogos / hijas sin empresa→ tenant_id propio (columna nueva, todo lo actual = tenant 1)
--        · tablas de referencia SUNAT/AFP (lista v_global) → lectura para todos, escritura solo superadmin
--        · únicos globales (ej. contacts.nro_documento) → únicos por tenant
--        · vistas public → security_invoker (si no, saltarían el RLS)
--  T3  kardex particionado por tenant_id (1 tabla física por tenant, el código sigue viendo `kardex`):
--        PK (id, tenant_id), triggers y vistas recreados, copia verificada por sumas, respaldo en _bk165_kardex.
--  T4  Funciones para el panel: crear_tenant(), vincular_usuario_tenant(), tenant_login_info() (para el login).
--  T5  Pruebas automáticas al final (dentro de la transacción): un usuario sin tenant ve 0 filas, tu usuario ve todo,
--        crear_tenant() crea su partición y su empresa y no es visible para el tenant 1. Si falla → rollback total.
--
-- RESPALDOS: _bk165_policies (políticas originales), _bk165_kardex (kardex original).
-- DESPUÉS: select * from public._bk165_reporte;  (resumen) y marcar superadmin:
--          update public.users set es_superadmin = true where id = <TU_ID>;

begin;

-- ══ 0) Preflight ═══════════════════════════════════════════════════════════════
do $$ begin
  if to_regclass('public.tenants') is null or to_regprocedure('public.mx_tenant_id()') is null then
    raise exception 'Falta correr 164_tenants_modelo.sql';
  end if;
end $$;

create table if not exists public._bk165_reporte (k text, v text);
truncate public._bk165_reporte;
create table if not exists public._bk165_policies as select now() as bk_at, p.* from pg_policies p where p.schemaname = 'public';
alter table public._bk165_policies enable row level security;
revoke all on public._bk165_policies, public._bk165_reporte from anon, authenticated;

-- ══ 1) Tenant "por defecto" para columnas tenant_id ════════════════════════════
-- Usuario logueado → su tenant. Sin sesión (SQL Editor / cron): app.tenant_id si lo defines; si no, solo si hay UN tenant activo.
create or replace function public.mx_tenant_default() returns int
language plpgsql stable security definer set search_path = public as $$
declare t int;
begin
  t := public.mx_tenant_id();
  if t is not null then return t; end if;
  t := nullif(current_setting('app.tenant_id', true), '')::int;
  if t is not null then return t; end if;
  if (select count(*) from public.tenants where estado = 'activo') = 1 then
    return (select id from public.tenants where estado = 'activo');
  end if;
  raise exception 'Sin tenant: ejecuta antes  select set_config(''app.tenant_id'',''<id>'',false);';
end $$;
revoke all on function public.mx_tenant_default() from public, anon;
grant execute on function public.mx_tenant_default() to authenticated, service_role;

alter table public.users          alter column tenant_id set default public.mx_tenant_default();
alter table public.empresa_config alter column tenant_id set default public.mx_tenant_default();

-- ══ 2) T2 · Aislamiento por tenant ═════════════════════════════════════════════
do $$
declare
  r record;
  v_global text[] := array['detraccion_tasas','parametros_renta4ta','rrhh_afp','rrhh_parametros','distritos_lima_centroide','motivos_nota'];
  v_skip   text[] := array['tenants','empresa_config','users','kardex'];
  has_emp boolean; emp_null boolean; v_cond text; n_perm int;
  n_emp int := 0; n_emp_null int := 0; n_ten int := 0; n_glob int := 0; n_bk int := 0;
begin
  for r in select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r','p') and not c.relispartition order by 1 loop
    if r.t = any (v_skip) then continue; end if;

    execute format('alter table public.%I enable row level security', r.t);
    execute format('drop policy if exists mx_tenant_iso on public.%I', r.t);

    -- respaldos manuales: RLS activo y sin política → la API no los ve
    if left(r.t, 3) = '_bk' or left(r.t, 3) = 'zz_' then n_bk := n_bk + 1; continue; end if;

    -- toda tabla necesita al menos 1 política permisiva (las restrictivas solo restan)
    select count(*) into n_perm from pg_policies where schemaname = 'public' and tablename = r.t and permissive = 'PERMISSIVE';
    if n_perm = 0 then
      execute format('create policy mx_auth_all on public.%I for all to authenticated using (true) with check (true)', r.t);
    end if;

    if r.t = any (v_global) then
      execute format('drop policy if exists mx_global_ins on public.%I', r.t);
      execute format('drop policy if exists mx_global_upd on public.%I', r.t);
      execute format('drop policy if exists mx_global_del on public.%I', r.t);
      execute format('create policy mx_global_ins on public.%I as restrictive for insert to public with check ((select public.mx_es_superadmin()))', r.t);
      execute format('create policy mx_global_upd on public.%I as restrictive for update to public using ((select public.mx_es_superadmin())) with check ((select public.mx_es_superadmin()))', r.t);
      execute format('create policy mx_global_del on public.%I as restrictive for delete to public using ((select public.mx_es_superadmin()))', r.t);
      n_glob := n_glob + 1; continue;
    end if;

    select true, (c.is_nullable = 'YES') into has_emp, emp_null
      from information_schema.columns c where c.table_schema = 'public' and c.table_name = r.t and c.column_name = 'empresa_id';
    has_emp := coalesce(has_emp, false);

    if has_emp and not emp_null then
      v_cond := 'empresa_id = any ((select public.mx_empresas_ids())::int[])';
      n_emp := n_emp + 1;
    else
      execute format('alter table public.%I add column if not exists tenant_id int not null default 1', r.t);
      execute format('alter table public.%I alter column tenant_id set default public.mx_tenant_default()', r.t);
      execute format('create index if not exists %I on public.%I (tenant_id)', 'idx_' || left(r.t, 50) || '_ten', r.t);
      if has_emp then
        v_cond := '(empresa_id = any ((select public.mx_empresas_ids())::int[]) or (empresa_id is null and tenant_id = (select public.mx_tenant_id())))';
        n_emp_null := n_emp_null + 1;
      else
        v_cond := 'tenant_id = (select public.mx_tenant_id())';
        n_ten := n_ten + 1;
      end if;
    end if;
    execute format('create policy mx_tenant_iso on public.%I as restrictive for all to public using (%s) with check (%s)', r.t, v_cond, v_cond);
  end loop;
  insert into public._bk165_reporte values ('t2_tablas_por_empresa', n_emp::text), ('t2_tablas_empresa_nullable', n_emp_null::text),
    ('t2_tablas_por_tenant_id', n_ten::text), ('t2_tablas_referencia_global', n_glob::text), ('t2_tablas_respaldo_bloqueadas', n_bk::text);
end $$;

-- users y empresa_config (ya tienen tenant_id desde el 164): el superadmin ve todos los tenants (panel)
do $$ declare t text; begin
  foreach t in array array['users','empresa_config'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists mx_tenant_iso on public.%I', t);
    execute format('create policy mx_tenant_iso on public.%I as restrictive for all to public
      using (tenant_id = (select public.mx_tenant_id()) or (select public.mx_es_superadmin()))
      with check (tenant_id = (select public.mx_tenant_id()) or (select public.mx_es_superadmin()))', t);
  end loop;
end $$;

-- ── Únicos globales → únicos por tenant (solo tablas con tenant_id; si una FK depende del índice, se omite y se reporta) ──
do $$
declare r record; v_def text; v_new text;
begin
  for r in
    select i.indexrelid, i.indrelid::regclass::text as tabla, ic.relname as idx, pg_get_indexdef(i.indexrelid) as def,
           (select conname from pg_constraint k where k.conindid = i.indexrelid and k.contype = 'u' and k.conrelid = i.indrelid limit 1) as cons,
           exists (select 1 from pg_constraint f where f.contype = 'f' and f.conindid = i.indexrelid) as con_fk
      from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_class tc on tc.oid = i.indrelid join pg_namespace n on n.oid = tc.relnamespace
     where n.nspname = 'public' and i.indisunique and not i.indisprimary and tc.relkind = 'r'
       and tc.relname not in ('users','empresa_config','tenants')
       and left(tc.relname,3) not in ('_bk','zz_')
       and exists (select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=tc.relname and c.column_name='tenant_id')
       and pg_get_indexdef(i.indexrelid) not like '%tenant_id%' and pg_get_indexdef(i.indexrelid) not like '%empresa_id%'
       and pg_get_indexdef(i.indexrelid) not like '%user_id%'   -- únicos por usuario (ej. preferencias_reporte) ya son por tenant
  loop
    if r.con_fk then
      insert into public._bk165_reporte values ('unico_omitido_por_fk', r.tabla || '.' || r.idx); continue;
    end if;
    v_new := regexp_replace(r.def, 'USING (\w+) \(', 'USING \1 (tenant_id, ');
    if r.cons is not null then execute format('alter table %s drop constraint %I', r.tabla, r.cons);
    else execute format('drop index public.%I', r.idx); end if;
    execute v_new;
    insert into public._bk165_reporte values ('unico_ahora_por_tenant', r.tabla || '.' || r.idx);
  end loop;
end $$;

-- ── Vistas: security_invoker (si no, corren como dueño y se saltan el RLS). Se omiten las que lee `anon`. ──
do $$ declare r record; begin
  for r in select c.relname, c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'v' loop
    if has_table_privilege('anon', r.oid, 'select') then
      insert into public._bk165_reporte values ('vista_anon_sin_invoker', r.relname); continue;
    end if;
    execute format('alter view public.%I set (security_invoker = true)', r.relname);
  end loop;
end $$;

-- ══ 3) T3 · kardex particionado por tenant ═════════════════════════════════════
create or replace function public.mx_particion_kardex(p_tenant int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if to_regclass(format('public.kardex_t%s', p_tenant)) is null then
    execute format('create table public.kardex_t%s partition of public.kardex for values in (%s)', p_tenant, p_tenant);
  end if;
end $$;
revoke all on function public.mx_particion_kardex(int) from public, anon;

do $$
declare
  r record; tx text; v_trg text[]; v_views jsonb := '[]'::jsonb; v_cols text; v_old numeric[]; v_new numeric[];
begin
  if (select relkind from pg_class where oid = 'public.kardex'::regclass) = 'p' then
    raise notice 'kardex ya está particionado: se omite T3'; return;
  end if;

  -- capturar triggers y vistas que dependen de kardex
  select array_agg(pg_get_triggerdef(oid)) into v_trg from pg_trigger where tgrelid = 'public.kardex'::regclass and not tgisinternal;
  for r in select distinct v.relname, pg_get_viewdef(v.oid, true) as def
             from pg_depend d join pg_rewrite rw on rw.oid = d.objid join pg_class v on v.oid = rw.ev_class
            where d.refobjid = 'public.kardex'::regclass and v.relkind = 'v' and v.relname <> 'kardex' loop
    v_views := v_views || jsonb_build_array(jsonb_build_object('n', r.relname, 'def', r.def));
  end loop;

  -- apartar la tabla vieja (y liberar los nombres de índices/PK)
  alter table public.kardex rename to kardex_old165;
  for r in select i.indexrelid, ic.relname as idx, k.conname
             from pg_index i join pg_class ic on ic.oid = i.indexrelid
             left join pg_constraint k on k.conindid = i.indexrelid and k.conrelid = i.indrelid and k.contype in ('p','u')
            where i.indrelid = 'public.kardex_old165'::regclass loop
    if r.conname is not null then execute format('alter table public.kardex_old165 rename constraint %I to %I', r.conname, r.conname || '_old165');
    else execute format('alter index public.%I rename to %I', r.idx, r.idx || '_old165'); end if;
  end loop;
  alter sequence public.kardex_id_seq owned by none;

  -- tabla nueva particionada (mismas columnas/defaults/CHECK + tenant_id)
  create table public.kardex (like public.kardex_old165 including defaults including constraints,
                              tenant_id int not null default public.mx_tenant_default()) partition by list (tenant_id);
  alter table public.kardex add constraint kardex_pkey primary key (id, tenant_id);
  for r in select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.kardex_old165'::regclass and contype = 'f' loop
    execute format('alter table public.kardex add constraint %I %s', r.conname, r.def);
  end loop;
  for r in select id from public.tenants loop perform public.mx_particion_kardex(r.id); end loop;

  -- copiar (sin triggers todavía → no se duplica el sync de lotes)
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_cols
    from information_schema.columns where table_schema = 'public' and table_name = 'kardex_old165';
  execute format('insert into public.kardex (%s, tenant_id) select k.%s, e.tenant_id from public.kardex_old165 k join public.empresa_config e on e.id = k.empresa_id',
                 v_cols, replace(v_cols, ', ', ', k.'));

  -- verificar por conteo y sumas
  select array[count(*), coalesce(sum(cantidad_entrada),0), coalesce(sum(cantidad_salida),0), coalesce(sum(valor_entrada),0), coalesce(sum(valor_salida),0),
               coalesce(sum(cantidad_unidades_entrada),0), coalesce(sum(cantidad_unidades_salida),0)] into v_old from public.kardex_old165;
  select array[count(*), coalesce(sum(cantidad_entrada),0), coalesce(sum(cantidad_salida),0), coalesce(sum(valor_entrada),0), coalesce(sum(valor_salida),0),
               coalesce(sum(cantidad_unidades_entrada),0), coalesce(sum(cantidad_unidades_salida),0)] into v_new from public.kardex;
  if v_old is distinct from v_new then raise exception 'T3: la copia del kardex no cuadra (% vs %). Rollback.', v_old, v_new; end if;
  insert into public._bk165_reporte values ('t3_kardex_filas_copiadas', v_new[1]::text);

  alter sequence public.kardex_id_seq owned by public.kardex.id;
  create index idx_kardex_item on public.kardex (item_id);
  create index idx_kardex_lote on public.kardex (lote_id);
  create index idx_kardex_fecha on public.kardex (fecha);
  create index idx_kardex_almacen on public.kardex (almacen_id);
  create index idx_kardex_numero_documento on public.kardex (numero_documento);
  create index idx_kardex_empresa on public.kardex (empresa_id);

  -- triggers originales sobre la tabla nueva (el texto capturado dice ON public.kardex)
  if v_trg is not null then foreach tx in array v_trg loop execute tx; end loop; end if;

  -- vistas: se reapuntan a la tabla nueva sin cambiar su OID (las vistas que dependen de ellas siguen funcionando)
  for r in select x->>'n' as n, x->>'def' as def from jsonb_array_elements(v_views) x loop
    execute format('create or replace view public.%I as %s', r.n, rtrim(r.def, E'; \n'));
    execute format('alter view public.%I set (security_invoker = true)', r.n);
  end loop;

  -- RLS + permisos
  alter table public.kardex enable row level security;
  create policy kardex_auth_all on public.kardex for all to authenticated using (true) with check (true);
  create policy mx_tenant_iso on public.kardex as restrictive for all to public
    using (tenant_id = (select public.mx_tenant_id()) and empresa_id = any ((select public.mx_empresas_ids())::int[]))
    with check (tenant_id = (select public.mx_tenant_id()) and empresa_id = any ((select public.mx_empresas_ids())::int[]));
  grant select, insert, update, delete on public.kardex to authenticated;
  grant all on public.kardex to service_role;
  grant usage, select on sequence public.kardex_id_seq to authenticated, service_role;

  -- la tabla vieja queda de respaldo, sin FKs (si no, bloquearía borrar ventas/lotes) y sin acceso por API
  for r in select conname from pg_constraint where conrelid = 'public.kardex_old165'::regclass and contype = 'f' loop
    execute format('alter table public.kardex_old165 drop constraint %I', r.conname);
  end loop;
  alter table public.kardex_old165 disable trigger user;
  alter table public.kardex_old165 rename to _bk165_kardex;
  alter table public._bk165_kardex enable row level security;
  revoke all on public._bk165_kardex from anon, authenticated;
end $$;

-- ══ 4) T4 · Funciones del panel superadmin y del login ═════════════════════════
create or replace function public.mx_clonar_catalogo(p_tabla text, p_from int, p_to int) returns int
language plpgsql security definer set search_path = public as $$
declare v_cols text; n int;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_cols
    from information_schema.columns where table_schema = 'public' and table_name = p_tabla and column_name not in ('id','tenant_id');
  execute format('insert into public.%I (%s, tenant_id) select %s, $2 from public.%I where tenant_id = $1', p_tabla, v_cols, v_cols, p_tabla) using p_from, p_to;
  get diagnostics n = row_count; return n;
end $$;
revoke all on function public.mx_clonar_catalogo(text,int,int) from public, anon, authenticated;

create or replace function public.crear_tenant(
  p_codigo text, p_nombre text, p_plan text default 'base', p_ruc text default null, p_razon text default null, p_plantilla_empresa int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_cod text := upper(btrim(coalesce(p_codigo,''))); v_t int; v_e int; v_tpl int; v_cols text; v_alm int; r record;
  v_av jsonb := '[]'::jsonb; v_cat jsonb := '{}'::jsonb; n_alm int := 0; n_ser int := 0; t text;
begin
  if auth.uid() is not null and not public.mx_es_superadmin() then raise exception 'Solo el superadmin puede crear tenants'; end if;
  if v_cod = '' then raise exception 'Código de tenant requerido'; end if;

  insert into public.tenants (codigo, nombre, plan) values (v_cod, p_nombre, coalesce(p_plan,'base')) returning id into v_t;
  perform public.mx_particion_kardex(v_t);

  -- 1ª empresa: clon de la empresa plantilla (misma config/colores/IGV), con sus datos propios
  v_tpl := coalesce(p_plantilla_empresa, (select min(id) from public.empresa_config where tenant_id = 1));
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_cols
    from information_schema.columns where table_schema = 'public' and table_name = 'empresa_config'
     and column_name not in ('id','tenant_id','codigo','ruc','razon_social','nombre_comercial','slug','logo_url','web','created_at','updated_at');
  execute format('insert into public.empresa_config (%s, tenant_id, codigo, ruc, razon_social, nombre_comercial)
                  select %s, $1, $2, $3, $4, $4 from public.empresa_config where id = $5 returning id', v_cols, v_cols)
    into v_e using v_t, v_cod, coalesce(p_ruc, 'S/N-' || v_cod), coalesce(p_razon, p_nombre), v_tpl;
  if v_e is null then raise exception 'No se encontró la empresa plantilla %', v_tpl; end if;

  -- almacenes + zonas
  begin
    for r in select * from public.almacenes where empresa_id = v_tpl order by id loop
      insert into public.almacenes (codigo, nombre, direccion, ubigeo, establecimiento_sunat, es_principal, activo, es_virtual, empresa_id)
      values (r.codigo, r.nombre, r.direccion, r.ubigeo, r.establecimiento_sunat, r.es_principal, r.activo, r.es_virtual, v_e) returning id into v_alm;
      insert into public.ubicaciones (almacen_id, codigo, nombre, tipo, activo)
        select v_alm, codigo, nombre, tipo, activo from public.ubicaciones where almacen_id = r.id;
      n_alm := n_alm + 1;
    end loop;
  exception when others then v_av := v_av || to_jsonb('almacenes: ' || sqlerrm); end;

  -- series (correlativo en 0)
  begin
    insert into public.series_documentos (tipo_documento, serie, descripcion, correlativo_inicial, ultimo_correlativo, digitos, es_cpe, aplica_a, dias_validez, por_defecto, activo, empresa_id)
      select tipo_documento, serie, descripcion, 1, 0, digitos, es_cpe, aplica_a, dias_validez, por_defecto, activo, v_e
        from public.series_documentos where empresa_id = v_tpl;
    get diagnostics n_ser = row_count;
  exception when others then v_av := v_av || to_jsonb('series: ' || sqlerrm); end;

  -- catálogos simples (plan de cuentas y términos de pago NO se clonan aquí: tienen jerarquía/hijas)
  foreach t in array array['tipo_documentos','tipos_documento_gasto','categorias_gasto','categorias','marcas'] loop
    begin
      v_cat := v_cat || jsonb_build_object(t, public.mx_clonar_catalogo(t, 1, v_t));
    exception when others then v_av := v_av || to_jsonb(t || ': ' || sqlerrm); end;
  end loop;

  return jsonb_build_object('tenant_id', v_t, 'empresa_id', v_e, 'almacenes', n_alm, 'series', n_ser, 'catalogos', v_cat, 'avisos', v_av);
end $$;
revoke all on function public.crear_tenant(text,text,text,text,text,int) from public, anon;
grant execute on function public.crear_tenant(text,text,text,text,text,int) to authenticated;

-- Vincula un usuario de Supabase Auth (creado antes en Authentication → Users) a un tenant
create or replace function public.vincular_usuario_tenant(
  p_auth_id uuid, p_email text, p_nombre text, p_tenant int, p_role text default 'admin', p_empresas int[] default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if auth.uid() is not null and not public.mx_es_superadmin() then raise exception 'Solo el superadmin puede vincular usuarios'; end if;
  select id into v_id from public.users where auth_id = p_auth_id;
  if v_id is null then
    insert into public.users (username, password_hash, nombre, email, role, active, auth_id, tenant_id, empresas_permitidas, empresa_id_default)
    values (lower(p_email), '', p_nombre, lower(p_email), p_role, true, p_auth_id, p_tenant, p_empresas,
            (select min(id) from public.empresa_config where tenant_id = p_tenant))
    returning id into v_id;
  else
    update public.users set tenant_id = p_tenant, role = p_role, empresas_permitidas = p_empresas, active = true,
           empresa_id_default = coalesce(empresa_id_default, (select min(id) from public.empresa_config where tenant_id = p_tenant)) where id = v_id;
  end if;
  return v_id;
end $$;
revoke all on function public.vincular_usuario_tenant(uuid,text,text,int,text,int[]) from public, anon;
grant execute on function public.vincular_usuario_tenant(uuid,text,text,int,text,int[]) to authenticated;

-- Para la pantalla de login (antes de iniciar sesión): ¿el código de empresa es premium (otro proyecto)?
create or replace function public.tenant_login_info(p_codigo text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('nombre', nombre, 'plan', plan, 'estado', estado, 'supabase_url', supabase_url)
    from public.tenants where codigo = upper(btrim(p_codigo))
$$;
grant execute on function public.tenant_login_info(text) to anon, authenticated;

-- ══ 5) T5 · Pruebas automáticas (si algo falla, TODO se revierte) ══════════════
do $$
declare
  v_auth uuid; v_ghost uuid := gen_random_uuid(); t text; n_real bigint; n_vis bigint; v_res jsonb;
  tablas text[] := array['ventas','compras','kardex','contacts','items','cuentas_cobrar','movimientos_banco','stock_ubicaciones'];
begin
  select auth_id into v_auth from public.users where active and auth_id is not null and empresas_permitidas is null and tenant_id = 1 order by id limit 1;
  if v_auth is null then raise exception 'T5: no hay usuario activo con auth_id para probar'; end if;

  -- A) tu usuario (tenant 1, todas las empresas) ve exactamente lo mismo que el dueño de la BD; un usuario sin tenant ve 0
  foreach t in array tablas loop
    execute format('select count(*) from public.%I', t) into n_real;
    perform set_config('request.jwt.claims', json_build_object('sub', v_auth, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_auth::text, true);
    execute 'set local role authenticated';
    execute format('select count(*) from public.%I', t) into n_vis;
    execute 'reset role';
    if n_vis <> n_real then raise exception 'T5-A: % — el usuario ve % de % filas', t, n_vis, n_real; end if;

    perform set_config('request.jwt.claims', json_build_object('sub', v_ghost, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_ghost::text, true);
    execute 'set local role authenticated';
    execute format('select count(*) from public.%I', t) into n_vis;
    execute 'reset role';
    if n_vis <> 0 then raise exception 'T5-B: % — un usuario sin tenant ve % filas (debería 0)', t, n_vis; end if;
  end loop;

  -- C) tenant de prueba: se crea con su partición y empresa, y el tenant 1 NO lo ve. Todo se revierte al final.
  begin
    perform set_config('request.jwt.claims', '', true);      -- sesión del dueño de la BD (sin usuario de la app)
    perform set_config('request.jwt.claim.sub', '', true);
    v_res := public.crear_tenant('TEST165', 'Tenant de prueba');
    if to_regclass('public.kardex_t' || (v_res->>'tenant_id')) is null then raise exception 'T5-C: no se creó la partición'; end if;
    perform set_config('request.jwt.claims', json_build_object('sub', v_auth, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_auth::text, true);
    execute 'set local role authenticated';
    select count(*) into n_vis from public.empresa_config where tenant_id <> 1;
    execute 'reset role';
    if n_vis <> 0 then raise exception 'T5-C: el tenant 1 ve % empresas de otro tenant', n_vis; end if;
    insert into public._bk165_reporte values ('t5_crear_tenant_prueba', v_res::text);
    raise exception 'ROLLBACK_TEST';
  exception when others then
    if sqlerrm <> 'ROLLBACK_TEST' then raise; end if;
  end;
  insert into public._bk165_reporte values ('t5_pruebas', 'OK: aislamiento, vistas, partición y crear_tenant verificados');
end $$;

-- ══ 6) Reporte ════════════════════════════════════════════════════════════════
insert into public._bk165_reporte
select 'politicas_mx_tenant_iso', count(*)::text from pg_policies where schemaname = 'public' and policyname = 'mx_tenant_iso'
union all select 'tablas_sin_aislamiento_(esperado: solo referencia/tenants)', coalesce(string_agg(c.relname, ', '), '-')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r','p') and not c.relispartition and left(c.relname,3) not in ('_bk','zz_')
   and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and p.policyname in ('mx_tenant_iso','mx_global_ins'))
union all select 'particiones_kardex', coalesce(string_agg(c.relname, ', '), '-')
  from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'public.kardex'::regclass
union all select 'admins_activos_(elige tu id para superadmin)', coalesce(string_agg(id || ':' || coalesce(nombre, username), ', '), '-')
  from public.users where active and role = 'admin' and auth_id is not null
union all select 'funciones_security_definer_a_auditar', count(*)::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef;

notify pgrst, 'reload schema';
commit;

select k, v from public._bk165_reporte order by k;

-- ── Rollback manual (solo si hiciera falta) ──
-- do $$ declare r record; begin for r in select tablename t, policyname p from pg_policies where schemaname='public' and policyname in ('mx_tenant_iso','mx_global_ins','mx_global_upd','mx_global_del','mx_auth_all') loop execute format('drop policy %I on public.%I', r.p, r.t); end loop; end $$;
-- do $$ declare r record; begin for r in select relname from pg_class where relkind='v' and relnamespace='public'::regnamespace loop execute format('alter view public.%I set (security_invoker=false)', r.relname); end loop; end $$;
-- kardex: el original está en public._bk165_kardex (sin FKs). Para volver: drop table public.kardex cascade; alter table public._bk165_kardex rename to kardex; + recrear FKs/triggers/vistas desde el 163 (D2).
