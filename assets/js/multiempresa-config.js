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
import { cssCabeceraPDF, htmlCabeceraPDF, ANCHO_PAPEL_PDF } from './shared/pdf-documento.js'

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
  // Rediseño 2026-11-09: tarjetas por sección + vista previa EN VIVO de cómo
  // sale la empresa en el PDF (Packing / Cotización / OC) + logo en Storage.
  const card = (icono, titulo, cuerpo, extra = '') => `
    <section class="emp-card">
      <header><span>${icono}</span><strong>${titulo}</strong>${extra}</header>
      ${cuerpo}
    </section>`
  const div = document.createElement('div')
  div.id = 'modal-empresa'
  div.className = 'modal'
  div.innerHTML = `
    <style>
      #modal-empresa .emp-card { background:var(--bg-secondary); border:1px solid var(--border-color); border-radius:var(--radius-md, 10px); padding:14px 16px; margin-bottom:14px; }
      #modal-empresa .emp-card > header { display:flex; align-items:center; gap:8px; margin-bottom:10px; color:var(--text-secondary); font-size:0.82rem; text-transform:uppercase; letter-spacing:.04em; }
      #modal-empresa .emp-card > header strong { color:var(--text-primary); }
      #modal-empresa .emp-card > header .emp-acc { margin-left:auto; text-transform:none; letter-spacing:0; }
      #modal-empresa .form-group { margin-bottom:10px; }
      #modal-empresa .emp-g { display:grid; gap:12px; }
      #modal-empresa .emp-top { display:grid; grid-template-columns:1fr; gap:14px; margin-bottom:14px; }   /* vista previa a todo el ancho = casi tamaño real */
      #modal-empresa .emp-prev { background:#fff; border-radius:var(--radius-md, 10px); padding:12px; box-shadow:0 4px 18px rgba(0,0,0,.18); overflow:hidden; }
      #modal-empresa .emp-logo { display:flex; flex-direction:column; gap:8px; }
      #modal-empresa .emp-drop { border:2px dashed var(--border-color); border-radius:var(--radius-md, 10px); padding:12px; text-align:center; cursor:pointer; font-size:0.82rem; color:var(--text-secondary); transition:border-color .15s, background .15s; }
      #modal-empresa .emp-drop:hover, #modal-empresa .emp-drop.sobre { border-color:var(--emp, #2563eb); background:rgba(37,99,235,.06); }
      #modal-empresa .emp-color { display:flex; gap:8px; align-items:center; }
      #modal-empresa .emp-color input[type=color] { width:46px; height:38px; padding:2px; flex:none; }
      #modal-empresa .emp-seg { display:inline-flex; border:1px solid var(--border-color); border-radius:8px; overflow:hidden; }
      #modal-empresa .emp-seg button { border:0; background:transparent; color:var(--text-secondary); padding:5px 10px; font-size:0.78rem; cursor:pointer; }
      #modal-empresa .emp-seg button + button { border-left:1px solid var(--border-color); }
      #modal-empresa .emp-seg button.on { background:var(--emp, #2563eb); color:#fff; font-weight:600; }
      #modal-empresa .emp-sugerido { font-size:0.75rem; color:var(--color-info); }
      @media (max-width:760px) { #modal-empresa .emp-top { grid-template-columns:1fr; } #modal-empresa .emp-g { grid-template-columns:1fr !important; } }
    </style>
    <div class="modal-content" style="width:min(94vw, 1020px); max-width:min(94vw, 1020px); max-height:calc(100vh - 48px); overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title" id="empModalTitulo">Nueva empresa</h3>
        <button class="modal-close" onclick="window.closeModal('modal-empresa')">&times;</button>
      </div>
      <div style="padding:16px 20px 0;">
        <div id="empInfoCard" style="margin-bottom:14px;"></div>

        <!-- Vista previa del PDF + logo y color -->
        <div class="emp-top">
          <div>
            <div class="emp-prev" id="empPrev">
            </div>
            <div style="font-size:0.72rem; color:var(--text-secondary); margin-top:6px;">👁 Vista previa EXACTA (mismo código que el PDF de Packing, Cotización y Orden de Compra), a escala.</div>
          </div>
          ${card('🎨', 'Logo y color', `
            <div class="emp-logo">
              <label class="emp-drop" id="empDrop" for="empLogoFile">
                <div id="empLogoNombre">Arrastra el logo aquí o <u>elige un archivo</u></div>
                <small>PNG, JPG, WebP o SVG · máx. 2 MB · fondo transparente ideal</small>
              </label>
              <input type="file" id="empLogoFile" accept="image/png,image/jpeg,image/webp,image/svg+xml" style="display:none;" onchange="window._empLogoElegido(this.files[0])">
              <div style="display:flex; gap:8px; align-items:center;">
                <input type="text" id="empLogoUrl" placeholder="o pega la URL / ruta del logo" style="flex:1;" oninput="window._empPreview()">
                <button type="button" class="btn btn-small btn-secondary" onclick="window._empQuitarLogo()" title="Quitar logo (el PDF muestra el nombre en un recuadro de color)">✕</button>
              </div>
              <div class="emp-color">
                <input type="color" id="empColor" value="#16a34a" oninput="window._empPreview()">
                <div style="font-size:0.8rem; color:var(--text-secondary);">Color de la empresa<br><small>Switch, cintillo y encabezados del PDF</small></div>
              </div>
              <div>
                <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.8rem; color:var(--text-secondary);">
                  <span>Tamaño del logo en el PDF: <b id="empLogoAltoTxt">70 px</b></span>
                  <button type="button" class="btn btn-small btn-secondary" onclick="window._empLogoAuto()" title="El más grande que entra en el espacio del logo (200 px de ancho)">⤢ Máximo</button>
                </div>
                <input type="range" id="empLogoAlto" min="40" max="150" step="2" value="70" style="width:100%;" oninput="window._empPreview()">
              </div>
              <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:0.8rem; color:var(--text-secondary);">
                <span>Posición del logo</span>
                <input type="hidden" id="empLogoAlign" value="left">
                <div class="emp-seg" role="group" aria-label="Posición del logo">
                  <button type="button" data-al="left" onclick="window._empAlign('left')" title="Izquierda">⇤ Izq.</button>
                  <button type="button" data-al="center" onclick="window._empAlign('center')" title="Centro">↔ Centro</button>
                  <button type="button" data-al="right" onclick="window._empAlign('right')" title="Derecha">Der. ⇥</button>
                </div>
              </div>
            </div>`)}
        </div>

        ${card('🪪', 'Identificación', `
          <div class="emp-g" style="grid-template-columns:1fr 0.7fr 2fr 1.3fr;">
            <div class="form-group"><label>RUC *</label>
              <input type="text" id="empRuc" maxlength="11" inputmode="numeric" placeholder="20123456789" oninput="window._empRucCambio()"></div>
            <div class="form-group"><label>Código *</label>
              <input type="text" id="empCodigo" maxlength="12" placeholder="BENJI" style="text-transform:uppercase;" oninput="window._empPreview()"></div>
            <div class="form-group"><label>Razón social *</label>
              <input type="text" id="empRazon" placeholder="BENJI BILLION E.I.R.L." oninput="window._empPreview()"></div>
            <div class="form-group"><label>Nombre comercial</label>
              <input type="text" id="empComercial" placeholder="BENJI" oninput="window._empPreview()"></div>
          </div>
          <div id="empSugerencia" class="emp-sugerido"></div>`,
          `<button type="button" class="btn btn-small btn-secondary emp-acc" onclick="window._empTraerDeContactos(true)" title="Completa los campos vacíos con los datos del contacto que tiene este RUC">🔎 Traer de Contactos</button>`)}

        ${card('📞', 'Contacto (sale en el PDF)', `
          <div class="emp-g" style="grid-template-columns:1fr 1.4fr 1.4fr;">
            <div class="form-group"><label>Teléfono</label><input type="text" id="empTelefono" oninput="window._empPreview()"></div>
            <div class="form-group"><label>Email</label><input type="email" id="empEmail" oninput="window._empPreview()"></div>
            <div class="form-group"><label>Sitio web</label><input type="url" id="empWeb" placeholder="https://..." oninput="window._empPreview()"></div>
          </div>`)}

        ${card('🏦', 'Cuentas para depósito (salen al pie del PDF)', `
          <div id="empCuentas" style="display:flex; flex-direction:column; gap:6px; font-size:0.85rem;"></div>
          <small style="display:block; margin-top:6px; color:var(--text-secondary);">Marca las cuentas que el cliente debe ver en el Packing / Cotización impreso. Las cuentas se crean en Tesorería → Bancos.</small>`)}

        ${card('📍', 'Domicilio fiscal', `
          <div class="emp-g" style="grid-template-columns:2.4fr 0.8fr;">
            <div class="form-group"><label>Dirección *</label><input type="text" id="empDireccion" oninput="window._empPreview()"></div>
            <div class="form-group"><label>Ubigeo</label><input type="text" id="empUbigeo" maxlength="6"></div>
          </div>
          <div class="emp-g" style="grid-template-columns:1fr 1fr 1fr 0.6fr;">
            <div class="form-group"><label>Distrito</label><input type="text" id="empDistrito"></div>
            <div class="form-group"><label>Provincia</label><input type="text" id="empProvincia"></div>
            <div class="form-group"><label>Departamento</label><input type="text" id="empDepartamento"></div>
            <div class="form-group"><label>País</label><input type="text" id="empPais" value="PE" maxlength="2"></div>
          </div>`)}

        ${card('🧾', 'Tributación', `
          <div class="emp-g" style="grid-template-columns:1.2fr 1fr 0.7fr 0.7fr 1.3fr;">
            <div class="form-group"><label>Régimen</label>
              <select id="empRegimen">${Object.entries(REGIMENES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
            <div class="form-group"><label>Tipo de contribuyente</label><input type="text" id="empTipoContrib"></div>
            <div class="form-group"><label>IGV %</label><input type="number" id="empIgv" step="0.01" value="18"></div>
            <div class="form-group"><label>Moneda base</label>
              <select id="empMoneda"><option value="PEN">PEN</option><option value="USD">USD</option></select></div>
            <div class="form-group"><label>Método de valuación</label>
              <select id="empValuacion">${Object.entries(VALUACION).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          </div>`)}

        ${card('⚡', 'Facturación electrónica (NUBEFACT)', `
          <small style="display:block; margin:-2px 0 10px; color:var(--text-secondary);">
            Cada empresa factura con su propio token y RUC emisor. Las <strong>series y correlativos</strong> viven en
            Ventas → Configuración → Series y correlativos (ya son por empresa).
          </small>
          <div class="emp-g" style="grid-template-columns:2fr 0.8fr 1fr;">
            <div class="form-group"><label>Token</label><input type="password" id="empNubeToken" autocomplete="off" placeholder="••••••••"></div>
            <div class="form-group"><label>Ambiente</label>
              <select id="empNubeAmbiente"><option value="demo">demo</option><option value="produccion">producción</option></select></div>
            <div class="form-group"><label>RUC emisor</label><input type="text" id="empNubeRuc" maxlength="11"></div>
          </div>`)}

        ${card('⚙️', 'Sistema', `
          <div class="emp-g" style="grid-template-columns:0.4fr 1.6fr;">
            <div class="form-group"><label>Orden en el switch</label><input type="number" id="empOrden" min="1" value="2"></div>
            <small style="align-self:center; color:var(--text-secondary);">Posición de la empresa en el selector de la cabecera.</small>
          </div>`)}

        <div id="empAvisoProvision" style="margin:4px 0 12px;"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="window.closeModal('modal-empresa')">Cancelar</button>
        <button class="btn btn-primary" id="empBtnGuardar" onclick="window.guardarEmpresa()">💾 Guardar empresa</button>
      </div>
    </div>`
  document.body.appendChild(div)
  // Arrastrar y soltar el logo
  const drop = document.getElementById('empDrop')
  ;['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('sobre') }))
  ;['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('sobre') }))
  drop.addEventListener('drop', e => { const f = e.dataTransfer?.files?.[0]; if (f) window._empLogoElegido(f) })
}

// ── Vista previa, logo y autocompletado (2026-11-09) ─────────────────────────
let _empLogoArchivo = null      // File pendiente de subir al guardar
let _empLogoObjUrl = null

function _textoSobreColor(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return '#fff'
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.45 ? '#111827' : '#ffffff'
}

window._empPreview = function () {
  const color = document.getElementById('empColor')?.value || '#2563eb'
  const prev = document.getElementById('empPrev'); if (!prev) return
  document.getElementById('modal-empresa')?.style.setProperty('--emp', color)
  const logo = _empLogoObjUrl || _g('empLogoUrl')
  const alto = parseInt(document.getElementById('empLogoAlto')?.value) || 70
  const align = _g('empLogoAlign') || 'left'
  document.querySelectorAll('#modal-empresa .emp-seg button').forEach(b => b.classList.toggle('on', b.dataset.al === align))
  const tAlto = document.getElementById('empLogoAltoTxt'); if (tAlto) tAlto.textContent = `${alto} px`
  const E = {
    nombre: _g('empRazon') || 'Razón social', ruc: _g('empRuc'), direccion: _g('empDireccion') || 'Dirección fiscal',
    email: _g('empEmail'), telefono: _g('empTelefono'), web: _g('empWeb'),
    logo: logo || null, corto: _g('empComercial') || _g('empCodigo') || 'EMPRESA', logoAlto: alto, logoAlign: align
  }
  const ct = _textoSobreColor(color)
  // Shadow DOM: el CSS del PDF (.top, .doc…) no choca con el del ERP
  const host = prev.shadowRoot || prev.attachShadow({ mode: 'open' })
  host.innerHTML = `<style>
      :host { display:block; }
      .papel { width:${ANCHO_PAPEL_PDF}px; transform-origin:0 0; font-family:Arial, Helvetica, sans-serif; font-size:11px; color:#111; }
      ${cssCabeceraPDF(color, ct)}
    </style>
    <div class="wrap"><div class="papel">${htmlCabeceraPDF(E, { colorTitulo: ct === '#ffffff' ? color : '#111827', titulo: 'Cotización', numero: 'COT-0001' })}</div></div>`
  const papel = host.querySelector('.papel'), wrap = host.querySelector('.wrap')
  const ajustar = () => {
    const ancho = prev.clientWidth - 24
    if (ancho <= 0) return                       // modal aún oculto: lo ajusta el ResizeObserver
    const esc = Math.min(1, ancho / ANCHO_PAPEL_PDF)
    papel.style.transform = `scale(${esc})`
    wrap.style.height = `${papel.offsetHeight * esc}px`
  }
  prev._ajustar = ajustar
  if (!prev._ro && window.ResizeObserver) { prev._ro = new ResizeObserver(() => prev._ajustar?.()); prev._ro.observe(prev) }
  ajustar()
  const img = host.querySelector('.logo img')
  if (img) img.addEventListener('load', () => { window._empLogoRatio = img.naturalWidth / img.naturalHeight; ajustar() }, { once: true })
}

window._empLogoElegido = function (file) {
  if (!file) return
  if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) { showToast('El logo debe ser PNG, JPG, WebP o SVG', 'warning'); return }
  if (file.size > 2 * 1024 * 1024) { showToast('El logo supera 2 MB', 'warning'); return }
  _empLogoArchivo = file
  if (_empLogoObjUrl) URL.revokeObjectURL(_empLogoObjUrl)
  _empLogoObjUrl = URL.createObjectURL(file)
  document.getElementById('empLogoNombre').innerHTML = `📎 <b>${_esc(file.name)}</b> — se sube al guardar`
  window._empPreview()
}

window._empQuitarLogo = function () {
  _empLogoArchivo = null
  if (_empLogoObjUrl) { URL.revokeObjectURL(_empLogoObjUrl); _empLogoObjUrl = null }
  _v('empLogoUrl', '')
  const f = document.getElementById('empLogoFile'); if (f) f.value = ''
  document.getElementById('empLogoNombre').innerHTML = 'Arrastra el logo aquí o <u>elige un archivo</u>'
  window._empPreview()
}

async function _empSubirLogo(ruc) {
  if (!_empLogoArchivo) return null
  const ext = (_empLogoArchivo.name.split('.').pop() || 'png').toLowerCase()
  const path = `${ruc}/logo-${Date.now()}.${ext}`
  const { error } = await supabase.storage.from('empresa-logos').upload(path, _empLogoArchivo, { upsert: true, contentType: _empLogoArchivo.type })
  if (error) throw new Error(/bucket not found/i.test(error.message) ? 'Falta correr assets/sql/147_empresa_perfil_logo_web.sql (bucket de logos)' : 'No se pudo subir el logo: ' + error.message)
  return supabase.storage.from('empresa-logos').getPublicUrl(path).data?.publicUrl || null
}

/** Datos del contacto con este RUC (tabla Contactos) → completa los campos VACÍOS. */
window._empTraerDeContactos = async function (manual = false) {
  const ruc = _g('empRuc')
  const sug = document.getElementById('empSugerencia')
  if (!/^\d{11}$/.test(ruc)) { if (manual) showToast('Escribe un RUC de 11 dígitos', 'warning'); if (sug) sug.textContent = ''; return }
  const { data, error } = await fromSinFiltro('contacts').select('nombre, direccion, distrito, telefono, email').eq('nro_documento', ruc).limit(1)
  if (error) { if (manual) showToast('No se pudo leer Contactos: ' + error.message, 'danger'); return }
  const c = data?.[0]
  if (!c) { if (sug) sug.textContent = manual ? 'No hay ningún contacto con ese RUC en Contactos.' : ''; if (manual) showToast('Ese RUC no está en Contactos', 'info'); return }
  const campos = [['empRazon', c.nombre, 'razón social'], ['empDireccion', c.direccion, 'dirección'], ['empDistrito', c.distrito, 'distrito'],
                  ['empTelefono', c.telefono, 'teléfono'], ['empEmail', c.email, 'email']]
  // Automático (al abrir / escribir el RUC): solo campos VACÍOS.
  // Botón "Traer de Contactos": también reemplaza lo distinto, previa confirmación.
  const vacios = campos.filter(([id, v]) => v && !_g(id))
  const distintos = campos.filter(([id, v]) => v && _g(id) && _g(id) !== String(v).trim())
  let aplicar = vacios
  if (manual && distintos.length && confirm(`Contacto ${c.nombre}:\n\n` + distintos.map(([id, v, et]) => `• ${et}: "${_g(id)}" → "${v}"`).join('\n') + '\n\n¿Reemplazar con los datos de Contactos?')) aplicar = [...vacios, ...distintos]
  aplicar.forEach(([id, v]) => _v(id, String(v).trim()))
  if (!_g('empComercial') && c.nombre) _v('empComercial', String(c.nombre).split(/\s+/)[0])
  window._empPreview()
  if (sug) sug.textContent = aplicar.length ? `✔ Desde Contactos (${c.nombre}): ${aplicar.map(x => x[2]).join(', ')}.`
    : (distintos.length ? `Contacto ${c.nombre} encontrado: tiene datos distintos (${distintos.map(x => x[2]).join(', ')}). Usa "🔎 Traer de Contactos" para reemplazarlos.` : `Contacto ${c.nombre}: los datos ya coinciden.`)
}

window._empAlign = function (al) { _v('empLogoAlign', al); window._empPreview() }

/** Alto máximo que entra en el espacio del logo del PDF (200 px de ancho, tope 150 px). */
window._empLogoAuto = function () {
  const r = window._empLogoRatio || 1
  const alto = Math.max(40, Math.min(150, Math.floor(210 / r)))
  _v('empLogoAlto', alto)
  window._empPreview()
  showToast(`Logo al máximo: ${alto} px de alto${alto >= 150 ? ' (tope del formato)' : ''}`, 'info')
}

let _empRucTimer = null
window._empRucCambio = function () {
  window._empPreview()
  clearTimeout(_empRucTimer)
  _empRucTimer = setTimeout(() => window._empTraerDeContactos(false), 400)
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
  _v('empWeb', e?.web); _v('empLogoUrl', e?.logo_url); _v('empLogoAlto', e?.logo_alto || 70); _v('empLogoAlign', e?.logo_align || 'left'); window._empLogoRatio = null
  window._empQuitarLogo && (_empLogoArchivo = null)
  if (_empLogoObjUrl) { URL.revokeObjectURL(_empLogoObjUrl); _empLogoObjUrl = null }
  const _f = document.getElementById('empLogoFile'); if (_f) _f.value = ''
  document.getElementById('empLogoNombre').innerHTML = 'Arrastra el logo aquí o <u>elige un archivo</u>'
  document.getElementById('empSugerencia').textContent = ''
  window._empPreview()
  await _empPintarCuentas(e?.id || null)
  // Empresa con datos vacíos: se intenta completar desde Contactos (solo campos vacíos)
  if (e && (!e.telefono || !e.email || !e.direccion)) window._empTraerDeContactos(false)

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
      web: _g('empWeb') || null,
      logo_alto: parseInt(_g('empLogoAlto')) || 70,
      logo_align: _g('empLogoAlign') || 'left',
      logo_url: (await _empSubirLogo(ruc)) || _g('empLogoUrl') || null,
      updated_at: new Date().toISOString()
    }

    if (_editId) {
      const r = await update('empresa_config', _editId, payload)
      if (!r) throw new Error('No se pudo guardar')
      await _empGuardarCuentas()
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


// ── Cuentas bancarias que salen en el PDF (bancos.mostrar_en_pdf, SQL 147) ──
let _empCuentasIni = {}
async function _empPintarCuentas(empresaId) {
  const cont = document.getElementById('empCuentas')
  if (!cont) return
  _empCuentasIni = {}
  if (!empresaId) { cont.innerHTML = '<span style="color:var(--text-secondary);">Guarda la empresa primero; luego crea sus cuentas en Tesorería → Bancos.</span>'; return }
  const { data, error } = await fromSinFiltro('bancos')
    .select('id, nombre, banco, numero_cuenta, cci, moneda, tipo_cuenta, medio, activo, mostrar_en_pdf')
    .eq('empresa_id', empresaId).order('moneda').order('banco')
  if (error) { cont.innerHTML = `<span style="color:var(--color-warning);">⚠ ${/mostrar_en_pdf/.test(error.message) ? 'Falta correr assets/sql/147_empresa_perfil_logo_web.sql' : _esc(error.message)}</span>`; return }
  const cuentas = (data || []).filter(c => c.activo !== false && (!c.medio || c.medio === 'banco') && c.numero_cuenta)
  if (!cuentas.length) { cont.innerHTML = '<span style="color:var(--text-secondary);">Esta empresa no tiene cuentas bancarias registradas.</span>'; return }
  cont.innerHTML = cuentas.map(c => {
    _empCuentasIni[c.id] = !!c.mostrar_en_pdf
    return `<label style="display:flex; align-items:center; gap:10px; padding:6px 8px; border:1px solid var(--border-color); border-radius:8px; cursor:pointer;">
      <input type="checkbox" class="emp-cta" value="${c.id}" ${c.mostrar_en_pdf ? 'checked' : ''} style="width:auto; margin:0;">
      <span><b>${_esc(c.banco || c.nombre)}</b> · ${c.moneda === 'USD' ? 'US$' : 'S/'} · <code>${_esc(c.numero_cuenta)}</code>${c.cci ? ` · CCI <code>${_esc(c.cci)}</code>` : ''}
      <small style="color:var(--text-secondary);">${_esc(c.nombre || '')}</small></span></label>`
  }).join('')
}
async function _empGuardarCuentas() {
  const cambios = [...document.querySelectorAll('#empCuentas .emp-cta')].filter(cb => (_empCuentasIni[cb.value] ?? false) !== cb.checked)
  for (const cb of cambios) {
    const { error } = await fromSinFiltro('bancos').update({ mostrar_en_pdf: cb.checked }).eq('id', parseInt(cb.value))
    if (error) showToast('No se pudo actualizar una cuenta: ' + error.message, 'warning')
  }
}
