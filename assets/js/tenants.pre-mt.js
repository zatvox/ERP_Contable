// ============================================================================
// tenants.js — Panel superadmin (T4). Solo para users.es_superadmin = true.
//  · Lista tenants (plan, estado, empresas, usuarios, partición de kardex)
//  · Crea tenant (RPC crear_tenant: partición kardex + 1ª empresa + almacenes/series/catálogos)
//  · Vincula un usuario de Supabase Auth (UUID) a un tenant (RPC vincular_usuario_tenant)
//  · Premium: guarda la URL del proyecto propio (runbook en claude/mapa_tenants_y_app_movil)
// Requiere SQL 165. La RLS ya limita qué ve cada quien; este panel solo lo usa el superadmin.
// ============================================================================
import { supabase } from './supabase-client.js'
import { showToast } from './helpers.js'

const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

async function esSuper() {
  const { data, error } = await supabase.rpc('mx_es_superadmin')
  return !error && data === true
}

async function cargar() {
  const root = $('tnRoot')
  if (!(await esSuper())) {
    root.innerHTML = '<div class="tn-card"><h3>Acceso restringido</h3><p>Este panel es solo para el superadmin. Si eres tú, corre en Supabase:<br><code>update public.users set es_superadmin = true where id = &lt;TU_ID&gt;;</code></p></div>'
    return
  }
  const [t, e, u] = await Promise.all([
    supabase.from('tenants').select('*').order('id'),
    supabase.from('empresa_config').select('id,codigo,razon_social,tenant_id').order('id'),
    supabase.from('users').select('id,nombre,email,role,active,tenant_id,empresas_permitidas').order('id')
  ])
  const tenants = t.data || [], emp = e.data || [], usr = u.data || []
  const filas = tenants.map(x => {
    const ne = emp.filter(y => y.tenant_id === x.id), nu = usr.filter(y => y.tenant_id === x.id && y.active)
    return `<tr><td>${x.id}</td><td><b>${esc(x.codigo)}</b><br><small>${esc(x.nombre)}</small></td>
      <td><span class="tn-pill ${esc(x.plan)}">${esc(x.plan)}</span></td><td><span class="tn-pill ${x.estado === 'activo' ? 'activo' : ''}">${esc(x.estado)}</span></td>
      <td>${ne.map(y => esc(y.codigo)).join(', ') || '—'}</td><td>${nu.length}</td><td><small>${esc(x.supabase_url || '')}</small></td>
      <td><button class="btn btn-sm" data-url="${x.id}">URL premium</button></td></tr>`
  }).join('')
  root.innerHTML = `
    <div class="tn-card" style="margin-bottom:16px"><h3>Tenants</h3>
      <div style="overflow:auto"><table class="tn-tabla"><thead><tr><th>ID</th><th>Cliente</th><th>Plan</th><th>Estado</th><th>Empresas</th><th>Usuarios</th><th>Proyecto propio</th><th></th></tr></thead><tbody>${filas}</tbody></table></div></div>
    <div class="tn-grid">
      <div class="tn-card"><h3>➕ Nuevo tenant</h3>
        <label>Código (ej. ACME)</label><input id="ntCodigo" maxlength="20">
        <label>Nombre del cliente</label><input id="ntNombre">
        <label>Plan</label><select id="ntPlan"><option value="base">Base (este proyecto)</option><option value="premium">Premium (proyecto propio)</option></select>
        <label>RUC de su 1ª empresa</label><input id="ntRuc" maxlength="11">
        <label>Razón social</label><input id="ntRazon">
        <label>Empresa plantilla (copia config, almacenes y series)</label>
        <select id="ntTpl">${emp.filter(y => y.tenant_id === 1).map(y => `<option value="${y.id}">${esc(y.codigo)} — ${esc(y.razon_social || '')}</option>`).join('')}</select>
        <button class="btn btn-primary" id="ntCrear" style="margin-top:12px">Crear tenant</button>
        <div class="tn-res" id="ntRes" hidden></div></div>
      <div class="tn-card"><h3>🔗 Vincular usuario a un tenant</h3>
        <p style="font-size:.8rem;color:var(--text-secondary)">1) Crea el usuario en Supabase → Authentication → Users y copia su UUID. 2) Pégalo aquí.</p>
        <label>UUID de Auth</label><input id="vuAuth" placeholder="xxxxxxxx-xxxx-…">
        <label>Email</label><input id="vuEmail" type="email">
        <label>Nombre</label><input id="vuNombre">
        <label>Tenant</label><select id="vuTenant">${tenants.map(x => `<option value="${x.id}">${esc(x.codigo)}</option>`).join('')}</select>
        <label>Rol</label><select id="vuRol"><option>admin</option><option>contador</option><option>vendedor</option><option>almacen</option><option>oficina</option></select>
        <label>Empresas permitidas (IDs separados por coma; vacío = todas del tenant)</label><input id="vuEmp" placeholder="ej. 4,5">
        <button class="btn btn-primary" id="vuVincular" style="margin-top:12px">Vincular</button></div>
    </div>`

  $('ntCrear').onclick = async () => {
    const codigo = $('ntCodigo').value.trim(), nombre = $('ntNombre').value.trim()
    if (!codigo || !nombre) return showToast('Código y nombre son obligatorios', 'warning')
    $('ntCrear').disabled = true
    const { data, error } = await supabase.rpc('crear_tenant', {
      p_codigo: codigo, p_nombre: nombre, p_plan: $('ntPlan').value,
      p_ruc: $('ntRuc').value.trim() || null, p_razon: $('ntRazon').value.trim() || null, p_plantilla_empresa: Number($('ntTpl').value) || null
    })
    $('ntCrear').disabled = false
    if (error) return showToast('No se pudo crear: ' + error.message, 'danger', 7000)
    $('ntRes').hidden = false; $('ntRes').textContent = JSON.stringify(data, null, 2)
    showToast('Tenant creado', 'success'); setTimeout(cargar, 1800)
  }
  $('vuVincular').onclick = async () => {
    const emp2 = $('vuEmp').value.split(',').map(s => parseInt(s, 10)).filter(Number.isFinite)
    const { data, error } = await supabase.rpc('vincular_usuario_tenant', {
      p_auth_id: $('vuAuth').value.trim(), p_email: $('vuEmail').value.trim(), p_nombre: $('vuNombre').value.trim(),
      p_tenant: Number($('vuTenant').value), p_role: $('vuRol').value, p_empresas: emp2.length ? emp2 : null
    })
    if (error) return showToast('No se pudo vincular: ' + error.message, 'danger', 7000)
    showToast(`Usuario vinculado (id ${data})`, 'success'); cargar()
  }
  root.querySelectorAll('[data-url]').forEach(b => b.onclick = async () => {
    const url = prompt('URL del proyecto Supabase propio de este cliente (vacío = quitar):')
    if (url === null) return
    const key = url.trim() ? prompt('ANON KEY (pública) de ese proyecto — Settings → API:') : ''
    if (url.trim() && !key) return showToast('Sin anon key no se puede usar el proyecto propio', 'warning')
    const { error } = await supabase.from('tenants').update({ supabase_url: url.trim() || null, supabase_anon_key: (key || '').trim() || null, plan: url.trim() ? 'premium' : 'base' }).eq('id', Number(b.dataset.url))
    if (error) return showToast(error.message, 'danger')
    cargar()
  })
}
cargar()
