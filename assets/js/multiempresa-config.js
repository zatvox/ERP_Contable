// ============================================================================
// MULTIEMPRESA-CONFIG.JS — Configuración → 🏢 Multiempresa
// ============================================================================
// Dos cosas en una pantalla, porque son las dos caras del mismo problema:
//
//   1. LAS EMPRESAS — datos de cada RUC (razón social, domicilio fiscal,
//      tributación, NUBEFACT propio, color del switch). Vive en
//      `empresa_config`, que desde el SQL 87 dejó de ser una fila única.
//
//   2. QUIÉN VE QUÉ — matriz usuario × empresa. Todo está en el mismo
//      proyecto de Supabase, así que el permiso no lo da la base de datos
//      separada: lo da `users.empresas_permitidas`. NULL = ve todas.
//
// Estándar seguido: tabla operativa (card-header + acciones por fila) y modal
// patrón "Nueva Venta" (secciones en MAYÚSCULAS, info-card al editar,
// footer Cancelar + 💾 Guardar). Ver [[estandar-diseno-tablas]] y
// [[estandar-diseno-modales]].
// ============================================================================
import { supabase, insert, update, fromSinFiltro } from './supabase-client.js'
import { getCurrentUser } from './auth-supabase.js'
import { showToast } from './helpers.js'
import { empresasActivas, empresaTrabajo } from './empresa.js'

let _empresas = []
let _usuarios = []
let _resumen  = {}      // empresa_id → { almacenes, zonas, series, lotes, ventas }
let _editId   = null
let _esAdmin  = false

const REGIMENES = { RG: 'Régimen General', RMT: 'Régimen MYPE Tributario', RER: 'Régimen Especial', NRUS: 'Nuevo RUS' }
const VALUACION = {
  identificacion_especifica: 'Identificación específica',
  promedio_ponderado: 'Promedio ponderado',
  peps: 'PEPS',
  ueps: 'UEPS'
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function _v(id, val) { const el = document.getElementById(id); if (el) el.value = val ?? '' }
function _g(id) { const el = document.getElementById(id); return el ? el.value.trim() : '' }

// ── Carga ────────────────────────────────────────────────────────────────────

async function _cargar() {
  const user = getCurrentUser()
  _esAdmin = (user?.role || '').toLowerCase() === 'admin'

  const [{ data: emp }, { data: usr }] = await Promise.all([
    supabase.from('empresa_config').select('*').order('orden', { ascending: true }),
    supabase.from('users').select('id, username, nombre, email, role, active, empresas_permitidas, empresa_id_default').order('nombre')
  ])
  _empresas = emp || []
  _usuarios = usr || []

  // Resumen por empresa. Se consulta SIN el filtro de empresa activa (son
  // conteos de administración: hay que poder ver lo de las 3 aunque el switch
  // tenga una sola marcada), así que se piden por empresa_id explícito.
  _resumen = {}
  await Promise.all(_empresas.map(async e => {
    // fromSinFiltro: el `from` normal agrega `.in('empresa_id', activas)` y,
    // sumado a nuestro `.eq`, daría 0 para toda empresa que no esté marcada en
    // el switch — justo las que esta pantalla necesita poder contar.
    const cuenta = async (tabla, extra = null) => {
      let q = fromSinFiltro(tabla).select('id', { count: 'exact', head: true }).eq('empresa_id', e.id)
      if (extra) q = extra(q)
      const { count } = await q
      return count || 0
    }
    _resumen[e.id] = {
      almacenes: await cuenta('almacenes', q => q.eq('es_virtual', false)),
      zonas:     await cuenta('ubicaciones'),
      series:    await cuenta('series_documentos'),
      lotes:     await cuenta('lotes'),
      ventas:    await cuenta('ventas')
    }
  }))
}

// ── Pantalla ─────────────────────────────────────────────────────────────────

export async function renderMultiempresa(contId = 'perfil-multiempresa-container') {
  const cont = document.getElementById(contId)
  if (!cont) return
  cont.innerHTML = '<div class="card" style="padding:18px; color:var(--text-secondary);">Cargando empresas...</div>'
  try {
    await _cargar()
  } catch (e) {
    cont.innerHTML = `<div class="card" style="padding:18px; color:var(--color-danger);">
      No se pudo cargar: ${_esc(e.message)}<br><small>¿Corriste <code>assets/sql/87_multiempresa_empresa_id.sql</code>?</small></div>`
    return
  }

  const activas = new Set(empresasActivas())
  const trabajo = empresaTrabajo()

  const filas = _empresas.map(e => {
    const r = _resumen[e.id] || {}
    return `
      <tr${e.activo ? '' : ' style="opacity:.55;"'}>
        <td><span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${_esc(e.color || '#2563eb')}; margin-right:7px;"></span><strong>${_esc(e.codigo || '—')}</strong></td>
        <td>${_esc(e.razon_social)}<br><small style="color:var(--text-secondary);">${_esc(e.nombre_comercial || '')}</small></td>
        <td>${_esc(e.ruc)}</td>
        <td>${_esc(REGIMENES[e.regimen_tributario] || e.regimen_tributario || '—')}</td>
        <td style="text-align:center;">${r.almacenes ?? 0} / ${r.zonas ?? 0}</td>
        <td style="text-align:center;">${r.series ?? 0}</td>
        <td style="text-align:center;">${r.lotes ?? 0}</td>
        <td style="text-align:center;">${r.ventas ?? 0}</td>
        <td>
          ${e.id === trabajo ? '<span title="Empresa de trabajo: aquí se guardan los documentos nuevos">✍️ Trabajo</span>'
            : activas.has(e.id) ? '<span style="color:var(--text-secondary);" title="Visible en reportes">✔ Activa</span>'
            : '<span style="color:var(--text-secondary);">—</span>'}
          ${e.activo ? '' : '<br><small style="color:var(--color-warning);">Desactivada</small>'}
        </td>
        <td style="white-space:nowrap;">
          <button class="btn btn-small" onclick="window.abrirModalEmpresa(${e.id})" title="Ver / editar">✏️</button>
          ${_esAdmin ? `<button class="btn btn-small" onclick="window.toggleEmpresaHabilitada(${e.id})"
             title="${e.activo ? 'Desactivar (deja de aparecer en el switch)' : 'Reactivar'}">${e.activo ? '🚫' : '✅'}</button>` : ''}
        </td>
      </tr>`
  }).join('')

  // ── Matriz usuario × empresa ──────────────────────────────────────────────
  const cabeceraEmp = _empresas.map(e =>
    `<th style="text-align:center;" title="${_esc(e.razon_social)}">${_esc(e.codigo || e.ruc)}</th>`).join('')

  const filasUsr = _usuarios.map(u => {
    const permitidas = Array.isArray(u.empresas_permitidas) ? u.empresas_permitidas.map(Number) : null
    const todas = !permitidas || !permitidas.length
    const checks = _empresas.map(e => `
      <td style="text-align:center;">
        <input type="checkbox" ${todas || permitidas.includes(e.id) ? 'checked' : ''}
               ${_esAdmin ? '' : 'disabled'}
               onchange="window.togglePermisoEmpresa(${u.id}, ${e.id}, this.checked)">
      </td>`).join('')
    const opcionesDef = _empresas
      .filter(e => todas || permitidas.includes(e.id))
      .map(e => `<option value="${e.id}" ${Number(u.empresa_id_default) === e.id ? 'selected' : ''}>${_esc(e.codigo || e.ruc)}</option>`)
      .join('')
    return `
      <tr${u.active === false ? ' style="opacity:.55;"' : ''}>
        <td><strong>${_esc(u.nombre)}</strong><br><small style="color:var(--text-secondary);">${_esc(u.username || u.email || '')} · ${_esc(u.role || 'user')}</small></td>
        ${checks}
        <td>
          <select onchange="window.cambiarEmpresaDefault(${u.id}, this.value)" ${_esAdmin ? '' : 'disabled'} style="min-width:92px;">
            <option value="">—</option>${opcionesDef}
          </select>
        </td>
        <td style="text-align:center; color:var(--text-secondary); font-size:0.8rem;">
          ${todas ? 'todas' : `${permitidas.length} de ${_empresas.length}`}
        </td>
      </tr>`
  }).join('')

  cont.innerHTML = `
    <div class="card" style="margin-bottom:18px;">
      <div class="card-header" style="padding-right:34px;">
        <div>
          <h3 class="card-title">🏢 Empresas</h3>
          <small style="color:var(--text-secondary);">Cada fila es un RUC con su propio domicilio fiscal, tributación y facturación electrónica. Los almacenes, zonas, series, lotes y documentos son de la empresa; los productos y contactos son compartidos por las tres.</small>
        </div>
        ${_esAdmin ? '<button class="btn btn-primary btn-small" onclick="window.abrirModalEmpresa()">+ Nueva empresa</button>' : ''}
      </div>
      <div class="table-container"><table>
        <thead><tr>
          <th>Código</th><th>Razón social</th><th>RUC</th><th>Régimen</th>
          <th style="text-align:center;" title="Almacenes reales / zonas (incluye las del Partners virtual)">Alm. / Zonas</th>
          <th style="text-align:center;">Series</th>
          <th style="text-align:center;">Lotes</th>
          <th style="text-align:center;">Ventas</th>
          <th>En el switch</th><th>Acciones</th>
        </tr></thead>
        <tbody>${filas || '<tr><td colspan="10" style="text-align:center;">Sin empresas. Corre el SQL 87.</td></tr>'}</tbody>
      </table></div>
    </div>

    <div class="card">
      <div class="card-header" style="flex-direction:column; align-items:flex-start; gap:4px;">
        <h3 class="card-title">👤 Qué empresas ve cada usuario</h3>
        <small style="color:var(--text-secondary);">
          Todo vive en el mismo proyecto de Supabase, así que el permiso no lo da una base separada: lo da esta matriz.
          Destildar una empresa la saca del switch de ese usuario y, con ella, de todo lo que puede leer.
          Sin ninguna marcada se entiende <em>todas</em> (es el estado de los usuarios creados antes del SQL 87).
          ${_esAdmin ? '' : '<strong>Solo un administrador puede cambiar esto.</strong>'}
        </small>
      </div>
      <div class="table-container"><table>
        <thead><tr><th>Usuario</th>${cabeceraEmp}<th>Empresa inicial</th><th style="text-align:center;">Acceso</th></tr></thead>
        <tbody>${filasUsr || '<tr><td colspan="99" style="text-align:center;">Sin usuarios.</td></tr>'}</tbody>
      </table></div>
    </div>`
}

// ── Permisos ─────────────────────────────────────────────────────────────────

window.togglePermisoEmpresa = async function (userId, empresaId, marcado) {
  const u = _usuarios.find(x => x.id === userId)
  if (!u) return
  const todas = !Array.isArray(u.empresas_permitidas) || !u.empresas_permitidas.length
  // Si hoy "ve todas" y se destilda una, la lista pasa a ser explícita con el resto.
  let lista = todas ? _empresas.map(e => e.id) : u.empresas_permitidas.map(Number)
  lista = marcado ? [...new Set([...lista, Number(empresaId)])] : lista.filter(id => id !== Number(empresaId))

  if (!lista.length) {
    showToast('Un usuario necesita al menos una empresa. Deja marcada una.', 'warning', 6000)
    await renderMultiempresa()
    return
  }

  // Si la empresa inicial quedó fuera de su acceso, se corrige en el mismo
  // guardado: un default que el usuario no puede ver lo dejaría sin arranque.
  const payload = { empresas_permitidas: lista, updated_at: new Date().toISOString() }
  if (u.empresa_id_default && !lista.includes(Number(u.empresa_id_default))) payload.empresa_id_default = lista[0]

  const r = await update('users', userId, payload)
  if (!r) { showToast('No se pudo guardar el permiso', 'danger'); return }
  showToast(`Permisos de ${u.nombre} actualizados`, 'success')
  await renderMultiempresa()
}

window.cambiarEmpresaDefault = async function (userId, empresaId) {
  const r = await update('users', userId, {
    empresa_id_default: empresaId ? Number(empresaId) : null,
    updated_at: new Date().toISOString()
  })
  if (!r) { showToast('No se pudo guardar', 'danger'); return }
  showToast('Empresa inicial actualizada', 'success')
  await renderMultiempresa()
}

window.toggleEmpresaHabilitada = async function (id) {
  const e = _empresas.find(x => x.id === id)
  if (!e) return
  if (e.activo) {
    const r = _resumen[id] || {}
    const msg = `Desactivar ${e.codigo || e.razon_social}?\n\n` +
      `Deja de aparecer en el switch y nadie podrá crear documentos en ella.\n` +
      `NO se borra nada: sus ${r.lotes || 0} lote(s) y ${r.ventas || 0} venta(s) quedan intactos y vuelven al reactivarla.`
    if (!confirm(msg)) return
  }
  const r = await update('empresa_config', id, { activo: !e.activo, updated_at: new Date().toISOString() })
  if (!r) { showToast('No se pudo cambiar el estado', 'danger'); return }
  showToast(`${e.codigo || e.razon_social} ${e.activo ? 'desactivada' : 'reactivada'}`, 'success')
  await renderMultiempresa()
}

// ── Modal de empresa (patrón "Nueva Venta") ─────────────────────────────────

function _asegurarModalEmpresa() {
  if (document.getElementById('modal-empresa')) return
  const sec = (t) => `<strong style="display:block; margin:16px 0 8px; color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase; letter-spacing:0.03em;">${t}</strong>`
  const div = document.createElement('div')
  div.id = 'modal-empresa'
  div.className = 'modal'
  div.innerHTML = `
    <div class="modal-content" style="width:min(94vw, 980px); max-width:min(94vw, 980px); max-height:calc(100vh - 48px); overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title" id="empModalTitulo">Nueva empresa</h3>
        <button class="modal-close" onclick="window.closeModal('modal-empresa')">&times;</button>
      </div>
      <div style="padding:16px 20px 0;">
        <div id="empInfoCard"></div>

        ${sec('Identificación')}
        <div style="display:grid; grid-template-columns:0.7fr 1fr 2fr 1.4fr; gap:12px;">
          <div class="form-group"><label>Código *</label>
            <input type="text" id="empCodigo" maxlength="12" placeholder="BENJI" style="text-transform:uppercase;"></div>
          <div class="form-group"><label>RUC *</label>
            <input type="text" id="empRuc" maxlength="11" inputmode="numeric" placeholder="20123456789"></div>
          <div class="form-group"><label>Razón social *</label>
            <input type="text" id="empRazon" placeholder="BENJI BILLION E.I.R.L."></div>
          <div class="form-group"><label>Nombre comercial</label>
            <input type="text" id="empComercial" placeholder="BENJI"></div>
        </div>
        <div style="display:grid; grid-template-columns:0.8fr 0.6fr 1fr 1fr; gap:12px;">
          <div class="form-group"><label>Color del switch</label>
            <input type="color" id="empColor" value="#16a34a" style="height:38px; padding:3px;"></div>
          <div class="form-group"><label>Orden</label>
            <input type="number" id="empOrden" min="1" value="2"></div>
          <div class="form-group"><label>Teléfono</label><input type="text" id="empTelefono"></div>
          <div class="form-group"><label>Email</label><input type="email" id="empEmail"></div>
        </div>

        ${sec('Domicilio fiscal')}
        <div style="display:grid; grid-template-columns:2.4fr 0.8fr; gap:12px;">
          <div class="form-group"><label>Dirección *</label><input type="text" id="empDireccion"></div>
          <div class="form-group"><label>Ubigeo</label><input type="text" id="empUbigeo" maxlength="6"></div>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr 0.6fr; gap:12px;">
          <div class="form-group"><label>Distrito</label><input type="text" id="empDistrito"></div>
          <div class="form-group"><label>Provincia</label><input type="text" id="empProvincia"></div>
          <div class="form-group"><label>Departamento</label><input type="text" id="empDepartamento"></div>
          <div class="form-group"><label>País</label><input type="text" id="empPais" value="PE" maxlength="2"></div>
        </div>

        ${sec('Tributación')}
        <div style="display:grid; grid-template-columns:1.2fr 1fr 0.7fr 0.7fr 1.3fr; gap:12px;">
          <div class="form-group"><label>Régimen</label>
            <select id="empRegimen">${Object.entries(REGIMENES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          <div class="form-group"><label>Tipo de contribuyente</label><input type="text" id="empTipoContrib"></div>
          <div class="form-group"><label>IGV %</label><input type="number" id="empIgv" step="0.01" value="18"></div>
          <div class="form-group"><label>Moneda base</label>
            <select id="empMoneda"><option value="PEN">PEN</option><option value="USD">USD</option></select></div>
          <div class="form-group"><label>Método de valuación</label>
            <select id="empValuacion">${Object.entries(VALUACION).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        </div>

        ${sec('Facturación electrónica (NUBEFACT)')}
        <small style="display:block; margin:-4px 0 10px; color:var(--text-secondary);">
          Cada empresa factura con su propio token y su propio RUC emisor. Las <strong>series y correlativos</strong> no se configuran aquí:
          viven en Ventas → Configuración → Series y correlativos, que ya es por empresa.
        </small>
        <div style="display:grid; grid-template-columns:2fr 0.8fr 1fr; gap:12px;">
          <div class="form-group"><label>Token</label><input type="text" id="empNubeToken" autocomplete="off"></div>
          <div class="form-group"><label>Ambiente</label>
            <select id="empNubeAmbiente"><option value="demo">demo</option><option value="produccion">producción</option></select></div>
          <div class="form-group"><label>RUC emisor</label><input type="text" id="empNubeRuc" maxlength="11"></div>
        </div>

        <div id="empAvisoProvision" style="margin:4px 0 12px;"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="window.closeModal('modal-empresa')">Cancelar</button>
        <button class="btn btn-primary" id="empBtnGuardar" onclick="window.guardarEmpresa()">💾 Guardar empresa</button>
      </div>
    </div>`
  document.body.appendChild(div)
}

window.abrirModalEmpresa = async function (id = null) {
  _asegurarModalEmpresa()
  _editId = id
  const e = id ? _empresas.find(x => x.id === id) : null
  document.getElementById('empModalTitulo').textContent = e ? `Empresa ${e.codigo || e.razon_social}` : 'Nueva empresa'

  // Info-card de contexto, igual que #nota-origen en notas.js
  const r = e ? (_resumen[e.id] || {}) : null
  document.getElementById('empInfoCard').innerHTML = e
    ? `<div style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md);
                  border-left:3px solid ${_esc(e.color || '#2563eb')}; font-size:0.88rem; line-height:1.6;">
         <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">Modifica la empresa</div>
         <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${_esc(e.razon_social)}</div>
         <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">
           RUC ${_esc(e.ruc)} · ${r.almacenes || 0} almacén(es), ${r.zonas || 0} zona(s), ${r.series || 0} serie(s),
           ${r.lotes || 0} lote(s), ${r.ventas || 0} venta(s)
         </div>
       </div>`
    : ''

  _v('empCodigo', e?.codigo); _v('empRuc', e?.ruc); _v('empRazon', e?.razon_social)
  _v('empComercial', e?.nombre_comercial)
  document.getElementById('empColor').value = e?.color || '#16a34a'
  _v('empOrden', e?.orden ?? (_empresas.length + 1))
  _v('empTelefono', e?.telefono); _v('empEmail', e?.email)
  _v('empDireccion', e?.direccion); _v('empUbigeo', e?.ubigeo)
  _v('empDistrito', e?.distrito); _v('empProvincia', e?.provincia)
  _v('empDepartamento', e?.departamento); _v('empPais', e?.pais || 'PE')
  _v('empRegimen', e?.regimen_tributario || 'RG'); _v('empTipoContrib', e?.tipo_contribuyente)
  _v('empIgv', e?.igv_porcentaje ?? 18); _v('empMoneda', e?.moneda_base || 'PEN')
  _v('empValuacion', e?.metodo_valuacion || 'identificacion_especifica')
  _v('empNubeToken', e?.nubefact_token); _v('empNubeAmbiente', e?.nubefact_ambiente || 'demo')
  _v('empNubeRuc', e?.nubefact_ruc)

  // Una empresa nueva no sirve de nada sin almacén ni series: se avisa antes.
  document.getElementById('empAvisoProvision').innerHTML = e ? '' : `
    <div style="padding:10px 12px; background:var(--bg-secondary); border-left:3px solid var(--color-info);
                border-radius:var(--radius-md); font-size:0.85rem; line-height:1.5;">
      Al crearla se le arma también su propio juego de arranque, copiado de la primera empresa:
      <strong>almacén principal</strong>, el <strong>Partners/Vendors</strong> virtual (sin él el kardex no tiene por dónde
      ingresar mercadería comprada), las <strong>zonas</strong> y las <strong>series</strong> con el correlativo en 0.
    </div>`

  // Solo lectura si no es admin (ver sin pasar por el candado de edición)
  const soloVer = !_esAdmin
  document.querySelectorAll('#modal-empresa input, #modal-empresa select').forEach(el => { el.disabled = soloVer })
  document.getElementById('empBtnGuardar').style.display = soloVer ? 'none' : ''

  window.openModal('modal-empresa')
}

window.guardarEmpresa = async function () {
  const btn = document.getElementById('empBtnGuardar')
  if (btn.disabled) return
  btn.disabled = true
  try {
    const codigo = _g('empCodigo').toUpperCase()
    const ruc    = _g('empRuc')
    const razon  = _g('empRazon')
    const dir    = _g('empDireccion')

    if (!codigo) throw new Error('El código es obligatorio (ej. BENJI)')
    if (!/^\d{11}$/.test(ruc)) throw new Error('El RUC debe tener exactamente 11 dígitos')
    if (!razon) throw new Error('La razón social es obligatoria')
    if (!dir) throw new Error('La dirección del domicilio fiscal es obligatoria')

    const choqueCod = _empresas.find(x => (x.codigo || '').toUpperCase() === codigo && x.id !== _editId)
    if (choqueCod) throw new Error(`El código "${codigo}" ya lo usa ${choqueCod.razon_social}`)
    const choqueRuc = _empresas.find(x => x.ruc === ruc && x.id !== _editId)
    if (choqueRuc) throw new Error(`El RUC ${ruc} ya está registrado como ${choqueRuc.razon_social}`)

    const payload = {
      codigo, ruc, razon_social: razon,
      nombre_comercial: _g('empComercial') || codigo,
      direccion: dir,
      ubigeo: _g('empUbigeo') || null,
      distrito: _g('empDistrito') || null,
      provincia: _g('empProvincia') || null,
      departamento: _g('empDepartamento') || null,
      pais: _g('empPais') || 'PE',
      telefono: _g('empTelefono') || null,
      email: _g('empEmail') || null,
      color: document.getElementById('empColor').value || '#2563eb',
      orden: parseInt(_g('empOrden')) || (_empresas.length + 1),
      regimen_tributario: _g('empRegimen') || 'RG',
      tipo_contribuyente: _g('empTipoContrib') || null,
      igv_porcentaje: parseFloat(_g('empIgv')) || 18,
      moneda_base: _g('empMoneda') || 'PEN',
      metodo_valuacion: _g('empValuacion') || 'identificacion_especifica',
      nubefact_token: _g('empNubeToken') || null,
      nubefact_ambiente: _g('empNubeAmbiente') || 'demo',
      nubefact_ruc: _g('empNubeRuc') || null,
      updated_at: new Date().toISOString()
    }

    if (_editId) {
      const r = await update('empresa_config', _editId, payload)
      if (!r) throw new Error('No se pudo guardar')
      showToast(`${codigo} actualizada ✅`, 'success')
    } else {
      const nueva = await insert('empresa_config', { ...payload, activo: true })
      if (!nueva) throw new Error('No se pudo crear la empresa')
      const prov = await _provisionarEmpresa(nueva.id)
      showToast(`${codigo} creada ✅ — ${prov.almacenes} almacén(es), ${prov.zonas} zona(s), ${prov.series} serie(s)`, 'success', 7000)
    }
    window.closeModal('modal-empresa')
    await renderMultiempresa()
  } catch (e) {
    showToast('Error: ' + e.message, 'danger', 7000)
  } finally { btn.disabled = false }
}

/**
 * Juego de arranque de una empresa nueva: misma lógica que las PARTES 5 y 6
 * del SQL 87, pero para una empresa creada después, desde la UI.
 *
 * Sin esto la empresa nace inservible: no tendría dónde guardar stock, y
 * sobre todo no tendría su Partners/Vendors, que es el origen externo que el
 * kardex necesita para que entre una compra. El trigger del SQL 87 rechaza un
 * movimiento cuyo origen sea la zona de otra empresa, así que no se puede
 * "prestar" el de Jhiro.
 */
async function _provisionarEmpresa(empresaId) {
  const resultado = { almacenes: 0, zonas: 0, series: 0 }
  const base = _empresas[0]
  if (!base) return resultado

  const { data: almBase } = await fromSinFiltro('almacenes').select('*').eq('empresa_id', base.id).order('id')
  for (const a of (almBase || [])) {
    const nuevo = await insert('almacenes', {
      codigo: a.codigo, nombre: a.nombre, direccion: a.direccion,
      ubigeo: a.ubigeo, establecimiento_sunat: a.establecimiento_sunat,
      es_principal: a.es_principal, activo: a.activo, es_virtual: a.es_virtual,
      empresa_id: empresaId
    })
    if (!nuevo) continue
    resultado.almacenes++
    const { data: zonas } = await fromSinFiltro('ubicaciones').select('*').eq('almacen_id', a.id).order('id')
    for (const z of (zonas || [])) {
      // ubicaciones.empresa_id la pone el trigger desde el almacén: no se manda.
      const r = await insert('ubicaciones', { almacen_id: nuevo.id, codigo: z.codigo, nombre: z.nombre, tipo: z.tipo, activo: z.activo })
      if (r) resultado.zonas++
    }
  }

  const { data: serBase } = await fromSinFiltro('series_documentos').select('*').eq('empresa_id', base.id).order('id')
  for (const s of (serBase || [])) {
    // Correlativo en 0: una empresa nueva no hereda la numeración histórica de otra.
    const r = await insert('series_documentos', {
      tipo_documento: s.tipo_documento, serie: s.serie, descripcion: s.descripcion,
      correlativo_inicial: 1, ultimo_correlativo: 0, digitos: s.digitos,
      es_cpe: s.es_cpe, aplica_a: s.aplica_a, dias_validez: s.dias_validez,
      por_defecto: s.por_defecto, activo: s.activo, empresa_id: empresaId
    })
    if (r) resultado.series++
  }
  return resultado
}
