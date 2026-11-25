// ============================================================================
// tenants.js — Pestaña "Clientes" en Configuración (solo superadmin). SQL 165–167.
//  · Lista tenants (plan, estado, empresas, usuarios) y permite ENTRAR a uno
//  · Crea tenant (RPC crear_tenant) · Vincula usuario de Auth (RPC vincular_usuario_tenant)
//  · Premium: URL + anon key del proyecto propio
// Uso: renderTenants('contenedorId'); esSuperadmin() decide si se muestra el tab.
// ============================================================================
import { supabase } from './supabase-client.js'
import { showToast } from './helpers.js'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export async function esSuperadmin() {
  try { const { data, error } = await supabase.rpc('mx_es_superadmin'); return !error && data === true } catch { return false }
}

const CSS = `<style>
.tn-wrap{display:flex;flex-direction:column;gap:16px}
.tn-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}
.tn-wrap .card-title{margin:0}
.tn-sub{margin:2px 0 0;font-size:var(--font-size-xs);color:var(--text-secondary)}
.tn-pill{display:inline-block;white-space:nowrap;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;background:var(--bg-tertiary);color:var(--text-secondary)}
.tn-pill.premium{background:#f59e0b2b;color:#b45309}.tn-pill.ok{background:#10b9812b;color:#047857}.tn-pill.aqui{background:#3b82f633;color:#60a5fa;white-space:nowrap}
.tn-form .form-group{margin-bottom:10px}.tn-form label{display:block;font-size:var(--font-size-xs);color:var(--text-secondary);margin-bottom:3px}
.tn-form input,.tn-form select{width:100%}
.tn-acc{display:flex;gap:6px;justify-content:flex-end;align-items:center;white-space:nowrap}
.tn-wrap td,.tn-wrap th{vertical-align:middle}.tn-wrap .table td:last-child,.tn-wrap .table th:last-child{text-align:right;width:1%;white-space:nowrap}
.tn-nota{border-left:4px solid var(--color-success);}.tn-nota pre{margin:8px 0 0;white-space:pre-wrap;font-size:12px;background:var(--bg-tertiary);padding:10px;border-radius:8px}
.tn-res{white-space:pre-wrap;font-size:12px;background:var(--bg-tertiary);padding:10px;border-radius:8px;margin-top:10px}
</style>`

export async function renderTenants(id, nota) {
  const root = document.getElementById(id)
  if (!root) return
  root.innerHTML = '<p style="padding:12px">Cargando…</p>'
  if (!(await esSuperadmin())) { root.innerHTML = ''; return }

  const { data: pn, error: ePn } = await supabase.rpc('panel_tenants')
  if (ePn) { root.innerHTML = '<div class="card"><p>No se pudo cargar: ' + esc(ePn.message) + '<br>¿Corriste el SQL 168?</p></div>'; return }
  const tenants = pn.tenants || [], actual = pn.actual
  const tpl = tenants.filter(x => x.id === 1).flatMap(x => x.empresas).concat(tenants.filter(x => x.id === actual && x.id !== 1).flatMap(x => x.empresas))

  const filas = tenants.map(x => {
    const ne = (x.empresas || []).map(y => esc(y.codigo)).join(', ') || '—'
    const nu = x.usuarios
    return `<tr>
      <td><b>${esc(x.codigo)}</b><br><small style="color:var(--text-secondary)">${esc(x.nombre)}</small></td>
      <td><span class="tn-pill ${x.plan === 'premium' ? 'premium' : ''}">${esc(x.plan)}</span></td>
      <td><span class="tn-pill ${x.estado === 'activo' ? 'ok' : ''}">${esc(x.estado)}</span></td>
      <td>${ne}</td><td style="text-align:center">${nu}</td>
      <td><div class="tn-acc">${x.id === actual ? '<span class="tn-pill aqui">Estás aquí</span>' : `<button class="btn btn-small" data-ir="${x.id}">Entrar</button>`}
        <button class="btn btn-small btn-secondary" data-url="${x.id}" title="${esc(x.supabase_url || 'Sin proyecto propio')}">Premium</button></div></td></tr>`
  }).join('')

  root.innerHTML = CSS + `<div class="tn-wrap">
    ${nota ? `<div class="card tn-nota"><b>${esc(nota.titulo)}</b><pre>${esc(nota.texto)}</pre></div>` : ''}
    <div class="card"><div class="card-header"><div><h3 class="card-title">🏢 Clientes (tenants)</h3>
      <p class="tn-sub">Cada cliente tiene sus empresas, usuarios y datos aislados. Trabajas en uno a la vez.</p></div></div>
      <div class="table-container"><table class="table"><thead><tr><th>Cliente</th><th>Plan</th><th>Estado</th><th>Empresas</th><th style="text-align:center">Usuarios</th><th></th></tr></thead><tbody>${filas}</tbody></table></div></div>
    <div class="tn-grid">
      <div class="card tn-form"><div class="card-header"><h3 class="card-title">➕ Nuevo cliente</h3></div>
        <div class="form-group"><label>Código (ej. ACME)</label><input id="ntCodigo" maxlength="20"></div>
        <div class="form-group"><label>Nombre del cliente</label><input id="ntNombre"></div>
        <div class="form-group"><label>Plan</label><select id="ntPlan"><option value="base">Base (este proyecto)</option><option value="premium">Premium (proyecto propio)</option></select></div>
        <div class="form-group"><label>RUC de su 1ª empresa</label><input id="ntRuc" maxlength="11"></div>
        <div class="form-group"><label>Razón social</label><input id="ntRazon"></div>
        <div class="form-group"><label>Empresa plantilla (copia config, almacenes y series)</label>
          <select id="ntTpl">${tpl.map(y => `<option value="${y.id}">${esc(y.codigo)} — ${esc(y.razon_social || '')}</option>`).join('')}</select></div>
        <button class="btn btn-primary" id="ntCrear">Crear cliente</button><div class="tn-res" id="ntRes" hidden></div></div>
      <div class="card tn-form"><div class="card-header"><h3 class="card-title">🔗 Dar acceso a un usuario</h3></div>
        <p class="tn-sub" style="margin-bottom:10px">1) Crea el usuario en Supabase → Authentication → Users y copia su UUID. 2) Pégalo aquí. Un contador puede tener acceso a varios clientes.</p>
        <div class="form-group"><label>UUID de Auth</label><input id="vuAuth" placeholder="xxxxxxxx-xxxx-…"></div>
        <div class="form-group"><label>Email</label><input id="vuEmail" type="email"></div>
        <div class="form-group"><label>Nombre</label><input id="vuNombre"></div>
        <div class="form-group"><label>Cliente</label><select id="vuTenant">${tenants.map(x => `<option value="${x.id}">${esc(x.codigo)}</option>`).join('')}</select></div>
        <div class="form-group"><label>Rol</label><select id="vuRol"><option>admin</option><option>contador</option><option>vendedor</option><option>almacen</option><option>oficina</option></select></div>
        <div class="form-group"><label>Empresas permitidas (IDs separados por coma; vacío = todas)</label><input id="vuEmp" placeholder="ej. 4,5"></div>
        <button class="btn btn-primary" id="vuVincular">Dar acceso</button></div>
    </div></div>`

  const $ = i => root.querySelector('#' + i)
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
    showToast('Cliente creado', 'success')
    const av = (data?.avisos || []).length ? '\nAvisos:\n- ' + data.avisos.join('\n- ') : ''
    renderTenants(id, { titulo: `✅ Cliente "${codigo.toUpperCase()}" creado (tenant ${data?.tenant_id})`, texto: JSON.stringify(data, null, 2) + av })
  }
  $('vuVincular').onclick = async () => {
    const emp2 = $('vuEmp').value.split(',').map(s => parseInt(s, 10)).filter(Number.isFinite)
    const { data, error } = await supabase.rpc('vincular_usuario_tenant', {
      p_auth_id: $('vuAuth').value.trim(), p_email: $('vuEmail').value.trim(), p_nombre: $('vuNombre').value.trim(),
      p_tenant: Number($('vuTenant').value), p_role: $('vuRol').value, p_empresas: emp2.length ? emp2 : null
    })
    if (error) return showToast('No se pudo dar acceso: ' + error.message, 'danger', 7000)
    showToast(`Acceso otorgado (usuario ${data})`, 'success'); renderTenants(id)
  }
  root.querySelectorAll('[data-ir]').forEach(b => b.onclick = async () => {
    b.disabled = true
    const { error } = await supabase.rpc('cambiar_tenant', { p_tenant: Number(b.dataset.ir) })
    if (error) { b.disabled = false; return showToast(error.message, 'danger', 6000) }
    const ts = await import('./shared/tenant-switch.js'); ts.limpiarContextoLocal()
    location.href = 'dashboard.html'
  })
  root.querySelectorAll('[data-url]').forEach(b => b.onclick = async () => {
    const url = prompt('URL del proyecto Supabase propio de este cliente (vacío = quitar):')
    if (url === null) return
    let key = ''
    if (url.trim()) { key = prompt('Anon key (publishable) de ese proyecto:'); if (key === null) return }
    const { error } = await supabase.from('tenants').update({
      supabase_url: url.trim() || null, supabase_anon_key: url.trim() ? key.trim() : null, plan: url.trim() ? 'premium' : 'base'
    }).eq('id', Number(b.dataset.url))
    if (error) return showToast(error.message, 'danger')
    renderTenants(id)
  })
}
