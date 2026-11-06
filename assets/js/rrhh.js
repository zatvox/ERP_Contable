// ============================================================================
// RRHH.JS — Módulo de Recursos Humanos (R0/R1, rediseño 2026-11-05)
// Absorbe la antigua página «Gestión de Usuarios» como tab «Usuarios y accesos».
//
// Modelo (una sola persona, tres capas — sin doble registro):
//   · PERSONA  = contacto (contacts) con rol «empleado». Es la única ficha de datos personales.
//   · EMPLEADO = vínculo laboral de esa persona con UNA empresa (empleados). Cada empresa
//                tiene su propia planilla; una persona puede tener varias fichas (una por empresa).
//   · USUARIO  = acceso al sistema (users). Opcional: hay personal sin cuenta.
// Los usuarios sin ficha aparecen en «Empleados» con «Completar datos»; al guardar, el
// contacto se reutiliza (por correo o nombre) o se crea solo, con rol «empleado».
// Ningún porcentaje legal está en el código: viven en rrhh_parametros / rrhh_afp.
// Todo el módulo es solo admin por ahora; cada tab declara su rol en data-rol.
// ============================================================================
import { supabase, insert, update, deleteRecord, fromSinFiltro, esperarContextoEmpresa } from './supabase-client.js'
import { getCurrentUser } from './auth-supabase.js'
import { getContacts, tiposDeContacto, updateContact, addContact } from './supabase-data.js'
import { showToast, fechaDMY } from './helpers.js'
import { initModuleNavDropdowns } from './main.js'
import { empresasDisponibles, empresaTrabajo, badgeEmpresa } from './empresa.js'
import { montarTabla, confirmarPequeno, esc as _esc } from './rrhh/tabla.js'
import { montarSelectorCargos } from './rrhh/cargos.js'
import { convertirEnBuscador, refrescarBuscador } from './buscador-select.js'
import './usuarios.js'

const $ = id => document.getElementById(id)
const _money = n => 'S/ ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const GUION = '<span style="color:var(--text-secondary);">—</span>'
const _iniciales = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()
const _norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

const REGIMENES = { general: 'General', mype_micro: 'Microempresa (MYPE)', mype_pequena: 'Pequeña empresa (MYPE)' }
const REGIMEN_AYUDA = {
  general:      'Todos los beneficios: CTS, 2 gratificaciones, utilidades, EsSalud.',
  mype_micro:   'Sin CTS, gratificaciones ni utilidades. Salud vía SIS (semicontributivo).',
  mype_pequena: 'CTS y gratificación al 50%, utilidades; salud EsSalud.'
}
const ROLES_USUARIO = { admin: 'Administrador', oficina: 'Oficina', vendedor: 'Vendedor', contador: 'Contador', almacen: 'Almacén', user: 'Usuario' }

let _contactos = [], _empleados = [], _afps = [], _usuarios = [], _sedes = [], _params = {}, _empresasCfg = []
let _usuarioPendiente = null   // usuario al que se le está «completando datos»

// ── Navegación + candado por rol ────────────────────────────────────────────
const _esAdmin = () => String(getCurrentUser()?.role || '').toLowerCase() === 'admin'

window.irATabRRHH = function (tab) {
  document.querySelectorAll('#rrhhTabs .tab-btn').forEach(b => b.classList.remove('active'))
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'))
  $('rrhhTabs')?.querySelector(`.tab-btn[data-tab="${tab}"]`)?.classList.add('active')
  $(`tab-${tab}`)?.classList.add('active')
  _alEntrarTab(tab)
}
function _alEntrarTab(tab) {
  if (tab === 'empleados') window.cargarEmpleados()
  if (tab === 'asistencia') window.cargarAsistencia()
  if (tab === 'regimen')   _pintarRegimen()
  if (tab === 'usuarios')  window.cargarUsuarios?.()
}
function _denegar() {
  document.querySelector('.content').innerHTML = `
    <div class="card" style="padding:40px; text-align:center;">
      <h2 style="color:var(--color-danger)">Acceso restringido</h2>
      <p>Solo el administrador puede gestionar RRHH.</p>
      <a href="dashboard.html" class="btn btn-primary" style="margin-top:16px;">Ir al Dashboard</a>
    </div>`
  document.querySelectorAll('#rrhhTabs .tab-btn').forEach(b => { b.style.display = 'none' })
}

document.addEventListener('DOMContentLoaded', async () => {
  let user = getCurrentUser()
  for (let i = 0; i < 40 && !user; i++) { await new Promise(r => setTimeout(r, 120)); user = getCurrentUser() }
  if (!user || !_esAdmin()) { _denegar(); return }
  await esperarContextoEmpresa()
  initModuleNavDropdowns('#rrhhTabs')
  document.querySelectorAll('#rrhhTabs .tab-btn').forEach(btn => {
    const rol = btn.dataset.rol
    if (rol && rol !== 'todos' && String(user.role || '').toLowerCase() !== rol) { btn.style.display = 'none'; return }
    btn.addEventListener('click', () => window.irATabRRHH(btn.dataset.tab))
  })
  await _cargarCatalogos()
  const t = new URLSearchParams(location.search).get('tab')
  window.irATabRRHH(['empleados', 'asistencia', 'regimen', 'usuarios'].includes(t) ? t : 'empleados')
})

// ── Catálogos ───────────────────────────────────────────────────────────────
async function _cargarCatalogos() {
  const [contactos, afps, usuarios, sedes, params, cfg] = await Promise.all([
    getContacts(true),
    supabase.from('rrhh_afp').select('*').eq('activo', true).order('nombre'),
    supabase.from('users').select('id, email, nombre, role, active, created_at').order('id'),
    supabase.from('sedes').select('id, nombre, empresa_id').neq('activo', false),
    supabase.from('rrhh_parametros').select('codigo, valor').is('vigente_hasta', null),
    fromSinFiltro('empresa_config').select('*').order('id')
  ])
  _contactos = contactos || []
  _afps = afps.data || []
  _usuarios = usuarios.data || []
  _sedes = sedes.data || []
  _params = Object.fromEntries((params.data || []).map(p => [p.codigo, Number(p.valor)]))
  _empresasCfg = cfg.data || []
}
const _contactoById = id => _contactos.find(c => c.id === Number(id)) || null
const _usuarioById = id => _usuarios.find(u => u.id === Number(id)) || null
const _regimenDe = empresaId => _empresasCfg.find(e => e.id === Number(empresaId))?.regimen_laboral || 'general'

// Contacto que corresponde a un usuario: primero por correo, luego por nombre.
function _contactoDeUsuario(u) {
  if (!u) return null
  const mail = _norm(u.email)
  return _contactos.find(c => mail && _norm(c.email) === mail)
    || _contactos.find(c => u.nombre && _norm(c.nombre) === _norm(u.nombre))
    || (() => {   // coincidencia flexible: «Cristian Paz» ⊂ «CRISTIAN ARON PAZ VILCA» (solo si hay UNA)
      const toks = _norm(u.nombre).split(' ').filter(Boolean)
      if (toks.length < 2) return null
      const m = _contactos.filter(c => { const n = ' ' + _norm(c.nombre) + ' '; return toks.every(t => n.includes(' ' + t + ' ')) })
      return m.length === 1 ? m[0] : null
    })()
}

// ============================================================================
// EMPLEADOS — lista unificada: fichas de empleado + usuarios sin ficha
// ============================================================================
let _empFiltro = 'activo'
let _empFiltroElegido = false
window.rrEmpFiltro = v => { _empFiltro = v; _empFiltroElegido = true; window.cargarEmpleados(false) }

const _pensionTxt = e => e.vinculo === 'rh_prestador' ? '—'
  : e.sistema_pensiones === 'afp' ? `AFP ${_afps.find(a => a.id === e.afp_id)?.nombre || ''}`.trim()
  : e.sistema_pensiones === 'onp' ? 'ONP' : 'Sin aporte'

window.cargarEmpleados = async function (recargar = true) {
  if (recargar || !$('card-emp').dataset.listo) {
    const [{ data, error }, us] = await Promise.all([
      supabase.from('empleados').select('*').order('id'),
      supabase.from('users').select('id, email, nombre, role, active, created_at').order('id')
    ])
    if (error) {
      $('card-emp').innerHTML = `<p style="padding:16px; color:var(--color-danger);">${_esc(error.message)}${/does not exist|schema cache/.test(error.message) ? '<br>Ejecuta el SQL 134_rrhh_cimientos.sql.' : ''}</p>`; return
    }
    _empleados = data || []; _usuarios = us.data || _usuarios
    $('card-emp').dataset.listo = '1'
  }
  const conFicha = new Set(_empleados.map(e => e.user_id).filter(Boolean))
  const pendientes = _usuarios.filter(u => u.active && !conFicha.has(u.id))
  const filas = []
  _empleados.forEach(e => { filas.push({ k: 'e', e, c: _contactoById(e.contact_id), u: _usuarioById(e.user_id), empresa_id: e.empresa_id }) })
  pendientes.forEach(u => filas.push({ k: 'p', u, c: _contactoDeUsuario(u), e: null, empresa_id: null }))

  const act = _empleados.filter(e => e.estado === 'activo')
  const planilla = act.filter(e => e.vinculo === 'planilla')
  const costo = planilla.reduce((t, e) => {
    const asig = e.asignacion_familiar ? (_params.RMV || 0) * (_params.ASIG_FAM_PCT || 0) / 100 : 0
    const base = Number(e.sueldo_mensual || 0) + asig
    return t + base + (_regimenDe(e.empresa_id) === 'mype_micro' ? 0 : Math.max(base, _params.RMV || 0) * (_params.ESSALUD_PCT || 0) / 100)
  }, 0)
  $('emp-kpis').innerHTML = `
    <div class="rr-kpi"><small>Activos</small><strong>${act.length}</strong></div>
    <div class="rr-kpi"><small>En planilla</small><strong>${planilla.length}</strong></div>
    <div class="rr-kpi"><small>Prestadores (RH)</small><strong>${act.length - planilla.length}</strong></div>
    <div class="rr-kpi ${pendientes.length ? 'alerta' : ''}"><small>Usuarios sin ficha</small><strong>${pendientes.length}</strong></div>
    <div class="rr-kpi"><small>Costo mensual planilla (aprox.)</small><strong>${_money(costo)}</strong></div>`

  if (!_empFiltroElegido && !act.length && pendientes.length) _empFiltro = 'todos'   // primera vez: que se vean los pendientes
  const vis = filas.filter(f => {
    if (_empFiltro === 'activo') return f.k === 'e' && f.e.estado === 'activo'
    if (_empFiltro === 'cesado') return f.k === 'e' && f.e.estado !== 'activo'
    if (_empFiltro === 'pendiente') return f.k === 'p'
    return true
  })
  const nombre = f => f.c?.nombre || f.u?.nombre || f.u?.email || '—'
  montarTabla('card-emp', {
    nombre: 'rrhh-empleados', titulo: '👥 Equipo', placeholder: 'Buscar por nombre, documento, cargo, empresa…',
    botones: `<select onchange="window.rrEmpFiltro(this.value)" style="width:auto;">
        ${[['activo', 'Activos'], ['pendiente', 'Usuarios sin ficha'], ['cesado', 'Cesados'], ['todos', 'Todos']].map(([v, l]) => `<option value="${v}" ${_empFiltro === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn btn-primary btn-small" onclick="window.abrirModalEmpleado()">+ Nuevo empleado</button>`,
    sort: { col: 'nombre', dir: 'asc' },
    filas: vis,
    vacio: _empFiltro === 'pendiente' ? '✔ Todos los usuarios ya tienen su ficha.' : 'Aún no hay personas en esta vista. Usa «+ Nuevo empleado». Si esperabas ver a alguien, revisa el filtro de empresa de la cabecera.',
    estiloFila: f => f.k === 'e' && f.e.estado !== 'activo' ? 'opacity:0.6;' : '',
    dobleClic: f => f.k === 'e' ? `window.abrirModalEmpleado(${f.e.id})` : `window.abrirModalEmpleado(null, ${f.u.id})`,
    cols: [
      { key: 'empresa', label: 'Empresa', val: f => f.empresa_id ? _empresasCfg.find(x => x.id === f.empresa_id)?.nombre_comercial || '' : 'zzz', html: f => f.empresa_id ? badgeEmpresa(f.empresa_id) : GUION },
      { key: 'nombre', label: 'Nombre', val: f => nombre(f).toLowerCase(), html: f => `<span class="rr-avatar">${_esc(_iniciales(nombre(f)))}</span><strong>${_esc(nombre(f))}</strong>${f.k === 'p' ? ' <span class="badge badge-warning">Sin ficha</span>' : ''}` },
      { key: 'doc', label: 'Documento', val: f => f.c?.nro_documento || '', html: f => _esc([f.c?.tipo_documento, f.c?.nro_documento].filter(Boolean).join(' ')) || GUION },
      { key: 'vinculo', label: 'Vínculo', val: f => f.e?.vinculo || '', html: f => !f.e ? GUION : f.e.vinculo === 'planilla' ? 'Planilla' : '<span class="badge badge-info">RH</span>' },
      { key: 'cargo', label: 'Cargo(s)', val: f => (f.e?.cargo || '').toLowerCase(), html: f => _esc(f.e?.cargo || '') || GUION },
      { key: 'ingreso', label: 'Ingreso', val: f => f.e?.fecha_ingreso || '', html: f => f.e?.fecha_ingreso ? fechaDMY(f.e.fecha_ingreso) : GUION },
      { key: 'sueldo', label: 'Sueldo', der: true, val: f => Number(f.e?.sueldo_mensual || 0), html: f => f.e ? _money(f.e.sueldo_mensual) : GUION },
      { key: 'pension', label: 'Pensión', val: f => f.e ? _pensionTxt(f.e) : '', html: f => f.e ? _esc(_pensionTxt(f.e)) : GUION },
      { key: 'acceso', label: 'Acceso', val: f => f.u?.email || '', html: f => f.u ? `<span class="badge badge-success" title="${_esc(f.u.email)}">${_esc(ROLES_USUARIO[f.u.role] || f.u.role)}</span>` : '<span class="badge badge-secondary">Sin cuenta</span>' },
      { key: 'contacto', label: 'Contacto', oculta: true, val: f => f.c ? 0 : 1, html: f => f.c ? '<span class="badge badge-success">✔ Empleado</span>' : '<span class="badge badge-secondary">Se creará</span>' },
      { key: 'estado', label: 'Estado', val: f => f.e?.estado || 'pendiente', html: f => f.k === 'p' ? '<span class="badge badge-warning">Por completar</span>' : f.e.estado === 'activo' ? '<span class="badge badge-success">Activo</span>' : `<span class="badge badge-danger">${_esc(f.e.estado)}</span>` }
    ],
    acciones: f => f.k === 'p' ? [
      { icono: '📝', label: 'Completar datos', onclick: `window.abrirModalEmpleado(null, ${f.u.id})` },
      { separador: true },
      { icono: '✕', label: 'Eliminar usuario', peligro: true, onclick: `window.eliminarUsuario(${f.u.id})` }
    ] : [
      { icono: '✏️', label: 'Editar', onclick: `window.abrirModalEmpleado(${f.e.id})` },
      f.e.estado === 'activo'
        ? { icono: '⏹', label: 'Registrar cese', onclick: `window.cesarEmpleado(${f.e.id})` }
        : { icono: '↩', label: 'Reactivar', onclick: `window.reactivarEmpleado(${f.e.id})` },
      { separador: true },
      { icono: '✕', label: 'Eliminar ficha', peligro: true, onclick: `window.eliminarEmpleado(${f.e.id})` }
    ]
  })
}

// ── Modal empleado ──────────────────────────────────────────────────────────
function _llenarSelects() {
  const sel = (id, html) => { const el = $(id); if (el) el.innerHTML = html }
  sel('empContacto', '<option value="">— Elige una persona —</option>' +
    [..._contactos].sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
      .map(c => `<option value="${c.id}">${_esc(c.nombre)}${c.nro_documento ? ' · ' + _esc(c.nro_documento) : ''}</option>`).join(''))
  sel('empEmpresa', empresasDisponibles().map(e => `<option value="${e.id}">${_esc(e.nombre_comercial || e.razon_social)}</option>`).join(''))
  sel('empAfp', '<option value="">—</option>' + _afps.map(a => `<option value="${a.id}">${_esc(a.nombre)} (flujo ${a.comision_flujo_pct}%)</option>`).join(''))
  const cargos = [...new Set(_empleados.flatMap(e => String(e.cargo || '').split(',').map(x => x.trim()).filter(Boolean)))]
  montarSelectorCargos('empCargo', cargos)
  const bp = convertirEnBuscador('empContacto', { placeholder: 'Escribe el nombre o documento…', sinResultados: 'Ninguna persona coincide', alCrearNuevo: { label: 'Crear persona nueva', onClick: () => window.empNuevaPersona() } })
  refrescarBuscador('empContacto')
}
function _llenarUsuarios(actualId) {
  $('empUsuario').innerHTML = '<option value="">Sin cuenta (la asistencia la marca el admin)</option>' +
    _usuarios.filter(u => u.active || u.id === actualId)
      .map(u => `<option value="${u.id}">${_esc(u.nombre || u.email)} · ${_esc(u.email)}</option>`).join('')
}
function _llenarSedes() {
  const emp = Number($('empEmpresa')?.value || 0)
  const sedes = _sedes.filter(s => !emp || s.empresa_id === emp)
  const el = $('empSede'); if (!el) return
  el.innerHTML = '<option value="">—</option>' + sedes.map(s => `<option value="${s.id}">${_esc(s.nombre)}</option>`).join('')
  if (sedes.length === 1) el.value = sedes[0].id    // semi-automático: una sola sede → se elige sola
}

window.empAlCambiarEmpresa = function () { _llenarSedes(); window.empResumen() }
window.empAlCambiarVinculo = function () {
  const rh = $('empVinculo').value === 'rh_prestador'
  $('empBloquePlanilla').style.display = rh ? 'none' : ''
  $('empSueldoLbl').textContent = (rh ? 'Honorario mensual referencial' : 'Sueldo mensual') + ' *'
  window.empResumen()
}
window.empAlCambiarPension = function () {
  const afp = $('empPension').value === 'afp'
  document.querySelectorAll('.emp-afp').forEach(el => { el.style.display = afp ? '' : 'none' })
  window.empResumen()
}

// Al elegir persona: muestra sus datos, avisa si ya trabaja en otra empresa y (si es ficha nueva)
// copia sus datos de planilla (pensión/AFP/asig. familiar son de la persona, no de la empresa).
window.empAlElegirPersona = function () {
  const c = _contactoById($('empContacto').value)
  const info = $('empPersonaInfo')
  if (!c) { info.innerHTML = ''; window.empResumen(); return }
  const otras = _empleados.filter(e => e.contact_id === c.id && String(e.id) !== $('empId').value)
  info.innerHTML = [c.nro_documento ? `${c.tipo_documento || 'Doc.'} ${_esc(c.nro_documento)}` : '', c.telefono || c.celular || '', c.email || '']
    .filter(Boolean).map(t => `<span>${t}</span>`).join('') +
    (otras.length ? `<span style="background:rgba(59,130,246,.18);">Ya trabaja en: ${otras.map(o => `${_esc(_empresasCfg.find(x => x.id === o.empresa_id)?.nombre_comercial || '')} (${_esc(o.cargo || 'sin cargo')})`).join(', ')}</span>` : '')
  if (!$('empId').value && otras.length) {
    const o = otras[0]
    $('empPension').value = o.sistema_pensiones || 'onp'; $('empAfp').value = o.afp_id || ''
    $('empComision').value = o.tipo_comision_afp || 'flujo'; $('empCuspp').value = o.cuspp || ''
    $('empAsigFam').value = o.asignacion_familiar ? '1' : '0'
    window.empAlCambiarPension()
  }
  // Si esa persona ya tiene cuenta de usuario con su correo, se sugiere sola
  if (!$('empUsuario').value) {
    const u = _usuarios.find(x => x.active && c.email && _norm(x.email) === _norm(c.email))
    if (u) $('empUsuario').value = u.id
  }
  window.empResumen()
}

window.abrirModalEmpleado = function (id = null, usuarioId = null) {
  window.cerrarMenuAcciones?.()
  _llenarSelects()
  const e = id ? _empleados.find(x => x.id === id) : null
  const u = usuarioId ? _usuarioById(usuarioId) : null
  _usuarioPendiente = u
  _llenarUsuarios(e?.user_id || null)
  $('empId').value = e?.id || ''
  $('empModalTitulo').textContent = e ? 'Editar empleado' : (u ? `Completar datos de ${u.nombre || u.email}` : 'Nuevo empleado')
  const c = e ? _contactoById(e.contact_id) : _contactoDeUsuario(u)
  $('empContacto').value = c?.id || ''
  $('empContacto').disabled = !!e
  const bq = document.querySelector('#empContacto')?.closest('.bsq-caja')?.querySelector('.bsq-input'); if (bq) bq.disabled = !!e
  refrescarBuscador('empContacto')
  $('empEmpresa').value = e?.empresa_id || empresaTrabajo() || ''
  $('empEmpresa').disabled = !!e
  _llenarSedes()
  $('empVinculo').value = e?.vinculo || 'planilla'
  $('empCargo').value = e?.cargo || ''
  montarSelectorCargos('empCargo').refrescar()
  $('empIngreso').value = e?.fecha_ingreso || ''
  $('empSueldo').value = e?.sueldo_mensual ?? ''
  if (e?.sede_id) $('empSede').value = e.sede_id
  $('empPension').value = e?.sistema_pensiones || 'onp'
  $('empAfp').value = e?.afp_id || ''
  $('empComision').value = e?.tipo_comision_afp || 'flujo'
  $('empCuspp').value = e?.cuspp || ''
  $('empAsigFam').value = e?.asignacion_familiar ? '1' : '0'
  $('empHoraEntrada').value = (e?.hora_entrada || '08:30').slice(0, 5)
  $('empHoraSalida').value = (e?.hora_salida || '18:00').slice(0, 5)
  $('empJornada').value = e?.jornada_horas ?? 8
  $('empTolerancia').value = e?.tolerancia_min ?? 10
  $('empUsuario').value = e?.user_id || u?.id || ''
  $('empNotas').value = e?.notas || ''
  document.querySelectorAll('#modal-empleado .invalido').forEach(x => x.classList.remove('invalido'))
  const av = $('empAviso')
  if (u && !c) { av.style.display = ''; av.innerHTML = `ℹ️ No hay un contacto para <strong>${_esc(u.nombre || u.email)}</strong>. Al guardar se creará solo con rol <strong>Empleado</strong> (nombre y correo del usuario). Si ya existe con otro nombre, elígelo en «Persona» para no duplicarlo.` }
  else if (u && c) { av.style.display = ''; av.innerHTML = `✔ Se encontró el contacto <strong>${_esc(c.nombre)}</strong> y se usará (sin duplicar). Verifica que sea la misma persona; si no, elige otra en «Persona».` }
  else av.style.display = 'none'
  window.empAlCambiarVinculo(); window.empAlCambiarPension(); window.empAlElegirPersona()
  window.openModal('modal-empleado')
}

// Resumen automático (costos y descuentos estimados con los parámetros vigentes)
window.empResumen = function () {
  const box = $('empResumen'); if (!box) return
  const S = parseFloat($('empSueldo').value || 0)
  const rh = $('empVinculo').value === 'rh_prestador'
  const empId = Number($('empEmpresa').value || 0)
  const reg = _regimenDe(empId)
  const c = _contactoById($('empContacto').value)
  const u = _usuarioById($('empUsuario').value)
  const fila = (t, v, cls = '') => `<tr class="${cls}"><td>${t}</td><td>${v}</td></tr>`
  let cuerpo = ''
  if (rh) {
    cuerpo = `${fila('Honorario mensual', _money(S))}${fila('Se paga contra Recibo por Honorarios', '')}
      <tr><td colspan="2" style="color:var(--text-secondary); font-size:0.8rem; padding-top:6px;">Sin EsSalud ni pensión de la empresa. Va a Tesorería como pago a prestador.</td></tr>`
  } else if (!(S > 0)) {
    cuerpo = '<tr><td colspan="2" style="color:var(--text-secondary);">Ingresa el sueldo para ver el cálculo.</td></tr>'
  } else {
    const asig = $('empAsigFam').value === '1' ? (_params.RMV || 0) * (_params.ASIG_FAM_PCT || 0) / 100 : 0
    const base = S + asig
    const pen = $('empPension').value
    let descPct = 0, penTxt = 'Sin descuento de pensión'
    if (pen === 'onp') { descPct = _params.ONP_PCT || 0; penTxt = `ONP ${descPct}%` }
    if (pen === 'afp') {
      const a = _afps.find(x => x.id === Number($('empAfp').value))
      const com = $('empComision').value === 'flujo' ? Number(a?.comision_flujo_pct || 0) : 0
      descPct = (_params.AFP_APORTE_PCT || 0) + (_params.AFP_PRIMA_PCT || 0) + com
      penTxt = `AFP ${a?.nombre || ''} ${descPct.toFixed(2)}%`
    }
    const desc = Math.min(base, pen === 'afp' ? (_params.AFP_TOPE || base) : base) * descPct / 100
    const ess = reg === 'mype_micro' ? 0 : Math.max(base, _params.RMV || 0) * (_params.ESSALUD_PCT || 0) / 100
    cuerpo = `${fila('Sueldo básico', _money(S))}${asig ? fila('Asignación familiar', _money(asig)) : ''}
      ${fila('Remuneración bruta', _money(base), 'tot')}
      ${fila(_esc(penTxt), '− ' + _money(desc))}
      ${fila('Neto aprox. (antes de renta 5ta y vales)', _money(base - desc), 'tot')}
      ${fila('EsSalud empresa ' + (reg === 'mype_micro' ? '(SIS: no aplica)' : (_params.ESSALUD_PCT || 9) + '%'), _money(ess))}
      ${fila('Costo mensual para la empresa', _money(base + ess), 'tot')}`
  }
  box.innerHTML = `<h4>📊 Resumen automático</h4><table><tbody>${cuerpo}</tbody></table>
    <div style="margin-top:10px; font-size:0.8rem; color:var(--text-secondary); line-height:1.5;">
      <div>Régimen laboral de la empresa: <strong>${_esc(REGIMENES[reg] || reg)}</strong></div>
      <div>Persona: ${c ? '✔ ' + _esc(c.nombre) : '—'}</div>
      <div>Acceso: ${u ? '✔ ' + _esc(u.email) : 'sin cuenta'}</div>
      <div style="margin-top:6px;">Los vales de caja del mes se descontarán completos en la siguiente planilla.</div>
    </div>`
}

window.empNuevaPersona = async function () {
  const { abrirModalContacto } = await import('./shared/contacto-modal.js')
  const alGuardar = async ev => {
    window.removeEventListener('contacto-guardado', alGuardar)
    _contactos = await getContacts(true)
    _llenarSelects()
    $('empContacto').value = ev.detail?.contacto?.id || ''
    refrescarBuscador('empContacto')
    window.empAlElegirPersona()
  }
  window.addEventListener('contacto-guardado', alGuardar)
  abrirModalContacto({ roles: ['empleado'] })
}

// ── Guardar / cesar / reactivar / eliminar ──────────────────────────────────
const _marcarInvalido = (ids) => {
  document.querySelectorAll('#modal-empleado .invalido').forEach(x => x.classList.remove('invalido'))
  ids.forEach(id => $(id)?.classList.add('invalido'))
  $(ids[0])?.focus()
}

window.guardarEmpleado = async function () {
  const id = Number($('empId').value || 0)
  let contactId = Number($('empContacto').value || 0)
  const empresaId = Number($('empEmpresa').value || 0)
  const vinculo = $('empVinculo').value
  const sueldo = parseFloat($('empSueldo').value || 0)
  const planilla = vinculo === 'planilla'
  const pension = planilla ? $('empPension').value : 'sin_aporte'
  const userId = Number($('empUsuario').value || 0) || null
  const faltan = []
  if (!contactId && !_usuarioPendiente) faltan.push('empContacto')
  if (!empresaId) faltan.push('empEmpresa')
  if (!(sueldo > 0)) faltan.push('empSueldo')
  if (planilla && pension === 'afp' && !$('empAfp').value) faltan.push('empAfp')
  if (faltan.length) { _marcarInvalido(faltan); showToast('Completa los campos marcados en rojo (*)', 'warning'); return }
  if (contactId && _empleados.find(e => e.contact_id === contactId && e.empresa_id === empresaId && e.id !== id)) {
    _marcarInvalido(['empContacto']); showToast('Esa persona ya tiene ficha en esa empresa', 'warning'); return
  }
  const btn = $('empBtnGuardar'); btn.disabled = true
  try {
    // 1) Contacto: se reutiliza o se crea solo (rol «empleado») — nunca se duplica
    if (!contactId) {
      const u = _usuarioPendiente
      const nuevo = await addContact({ nombre: u.nombre || u.email, email: u.email, tipo_contacto: ['empleado'], activo: true })
      if (!nuevo) throw new Error('no se pudo crear el contacto')
      contactId = nuevo.id
    }
    const payload = {
      empresa_id: empresaId, contact_id: contactId, vinculo, user_id: userId,
      cargo: $('empCargo').value.trim() || null,
      sede_id: Number($('empSede').value || 0) || null,
      fecha_ingreso: $('empIngreso').value || null,
      sueldo_mensual: sueldo,
      asignacion_familiar: planilla && $('empAsigFam').value === '1',
      sistema_pensiones: pension,
      afp_id: planilla && pension === 'afp' ? Number($('empAfp').value) : null,
      tipo_comision_afp: planilla && pension === 'afp' ? $('empComision').value : null,
      cuspp: planilla && pension === 'afp' ? ($('empCuspp').value.trim() || null) : null,
      hora_entrada: $('empHoraEntrada').value || '08:30',
      hora_salida: $('empHoraSalida').value || '18:00',
      jornada_horas: parseFloat($('empJornada').value || 8),
      tolerancia_min: parseInt($('empTolerancia').value || 10),
      notas: $('empNotas').value.trim() || null,
      updated_at: new Date().toISOString()
    }
    const ok = id ? await update('empleados', id, payload) : await insert('empleados', payload)
    if (!ok) throw new Error('no se pudo guardar la ficha')      // insert() devuelve null en error
    // 2) El contacto queda con rol «empleado» (sin quitar los demás) y completa su correo si faltaba
    await _asegurarRolEmpleado(contactId, userId)
    showToast('Empleado guardado ✔', 'success')
    window.closeModal('modal-empleado')
    _usuarioPendiente = null
    await window.cargarEmpleados()
  } catch (e) {
    console.error('guardarEmpleado:', e)
    showToast('Error al guardar: ' + e.message, 'danger')
  } finally { btn.disabled = false }
}

async function _asegurarRolEmpleado(contactId, userId) {
  _contactos = await getContacts(true)
  const c = _contactoById(contactId); if (!c) return
  const cambios = {}
  if (!tiposDeContacto(c).includes('empleado')) cambios.tipo_contacto = [...new Set([...tiposDeContacto(c), 'empleado'])]
  const u = _usuarioById(userId)
  if (u && !c.email) cambios.email = u.email
  if (Object.keys(cambios).length) { await updateContact(c.id, cambios); _contactos = await getContacts(true) }
}

window.cesarEmpleado = async function (id) {
  const e = _empleados.find(x => x.id === id); if (!e) return
  const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Lima' })
  const r = await confirmarPequeno({
    titulo: 'Registrar cese', okLabel: 'Registrar cese', peligro: true,
    texto: `¿Cesar a <strong>${_esc(_contactoById(e.contact_id)?.nombre || '')}</strong>? Su ficha se conserva (historial); solo deja de salir en planilla y asistencia.`,
    campo: { label: 'Fecha de cese', type: 'date', valor: hoy }, campo2: { label: 'Motivo (opcional)', placeholder: 'Renuncia, fin de contrato…' }
  })
  if (!r.ok || !r.valor) return
  if (!await update('empleados', id, { estado: 'cesado', fecha_cese: r.valor, motivo_cese: r.valor2 || null, updated_at: new Date().toISOString() })) { showToast('No se pudo registrar el cese', 'danger'); return }
  showToast('Cese registrado', 'success'); await window.cargarEmpleados()
}
window.reactivarEmpleado = async function (id) {
  const r = await confirmarPequeno({ titulo: 'Reactivar empleado', texto: 'Volverá a salir en planilla y asistencia.', okLabel: 'Reactivar' })
  if (!r.ok) return
  if (!await update('empleados', id, { estado: 'activo', fecha_cese: null, motivo_cese: null, updated_at: new Date().toISOString() })) { showToast('No se pudo reactivar', 'danger'); return }
  await window.cargarEmpleados()
}
window.eliminarEmpleado = async function (id) {
  const e = _empleados.find(x => x.id === id); if (!e) return
  const { count } = await supabase.from('asistencias').select('id', { count: 'exact', head: true }).eq('empleado_id', id)
  if (count) { showToast(`Tiene ${count} asistencia(s) registrada(s): usa «Registrar cese» para conservar el historial`, 'warning'); return }
  const r = await confirmarPequeno({ titulo: 'Eliminar ficha', peligro: true, okLabel: 'Eliminar',
    texto: `Se elimina la ficha de <strong>${_esc(_contactoById(e.contact_id)?.nombre || '')}</strong> en esta empresa. La persona (contacto) y su usuario no se tocan.` })
  if (!r.ok) return
  if (!await deleteRecord('empleados', id)) { showToast('No se pudo eliminar', 'danger'); return }
  // Si ya no tiene ninguna ficha, el contacto pierde el rol «empleado»
  if (!_empleados.some(x => x.contact_id === e.contact_id && x.id !== id)) {
    const c = _contactoById(e.contact_id)
    if (c) await updateContact(c.id, { tipo_contacto: tiposDeContacto(c).filter(r2 => r2 !== 'empleado') })
  }
  showToast('Ficha eliminada', 'success'); await window.cargarEmpleados()
}

// ============================================================================
// USUARIOS Y ACCESOS (tabla estándar)
// ============================================================================
let _usuFiltro = 'activo'
window.rrUsuFiltro = v => { _usuFiltro = v; window.cargarUsuarios(false) }

window.cargarUsuarios = async function (recargar = true) {
  if (recargar) {
    const [us, em] = await Promise.all([
      supabase.from('users').select('id, email, nombre, role, active, created_at').order('id'),
      supabase.from('empleados').select('id, user_id, empresa_id, estado')
    ])
    if (us.error) { $('card-usu').innerHTML = `<p style="padding:16px; color:var(--color-danger);">${_esc(us.error.message)}</p>`; return }
    _usuarios = us.data || []
    window._rrFichasPorUsuario = em.data || []
  }
  const fichas = window._rrFichasPorUsuario || []
  const yo = String(getCurrentUser()?.email || '').toLowerCase()
  const filas = _usuarios.filter(u => _usuFiltro === 'todos' || (_usuFiltro === 'activo' ? u.active : !u.active))
  montarTabla('card-usu', {
    nombre: 'rrhh-usuarios', titulo: '🔐 Usuarios del sistema', placeholder: 'Buscar por nombre, correo o rol…',
    botones: `<select onchange="window.rrUsuFiltro(this.value)" style="width:auto;">
        ${[['activo', 'Activos'], ['inactivo', 'Inactivos'], ['todos', 'Todos']].map(([v, l]) => `<option value="${v}" ${_usuFiltro === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn btn-secondary btn-small" onclick="window.openModal('modal-password')">🔒 Mi contraseña</button>
      <button class="btn btn-primary btn-small" onclick="window.abrirModalUsuario()">+ Nuevo usuario</button>`,
    sub: '<p class="rr-nota" style="padding:0;">El usuario es solo el <strong>acceso</strong>. Los datos laborales viven en «Empleados»: quien aún no tiene ficha sale allí con «Completar datos».</p>',
    sort: { col: 'id', dir: 'asc' },
    filas, vacio: 'No hay usuarios en esta vista.',
    estiloFila: u => u.active ? '' : 'opacity:0.6;',
    dobleClic: u => `window.abrirModalUsuario(${u.id})`,
    cols: [
      { key: 'id', label: '#', val: u => u.id, html: u => u.id },
      { key: 'nombre', label: 'Nombre', val: u => (u.nombre || '').toLowerCase(), html: u => `<span class="rr-avatar">${_esc(_iniciales(u.nombre || u.email))}</span><strong>${_esc(u.nombre || '—')}</strong>${String(u.email).toLowerCase() === yo ? ' <span class="badge badge-info">Tú</span>' : ''}` },
      { key: 'email', label: 'Email', val: u => (u.email || '').toLowerCase(), html: u => _esc(u.email || '—') },
      { key: 'rol', label: 'Rol', val: u => u.role || '', html: u => `<span class="badge badge-${u.role === 'admin' ? 'primary' : 'secondary'}">${_esc(ROLES_USUARIO[u.role] || u.role || 'Usuario')}</span>` },
      { key: 'ficha', label: 'Ficha de empleado', val: u => fichas.filter(f => f.user_id === u.id).length, html: u => {
          const fs = fichas.filter(f => f.user_id === u.id)
          return fs.length ? fs.map(f => badgeEmpresa(f.empresa_id)).join(' ') : '<span class="badge badge-warning">Sin ficha</span>' } },
      { key: 'estado', label: 'Estado', val: u => u.active ? 0 : 1, html: u => u.active ? '<span class="badge badge-success">Activo</span>' : '<span class="badge badge-danger">Inactivo</span>' },
      { key: 'creado', label: 'Creado', val: u => u.created_at || '', html: u => u.created_at ? fechaDMY(String(u.created_at).slice(0, 10)) : GUION }
    ],
    acciones: u => {
      const tieneFicha = fichas.some(f => f.user_id === u.id)
      const esYo = String(u.email).toLowerCase() === yo
      return [
        { icono: '✏️', label: 'Editar', onclick: `window.abrirModalUsuario(${u.id})` },
        !tieneFicha && u.active ? { icono: '📝', label: 'Completar datos (ficha)', onclick: `window.irCompletarFicha(${u.id})` } : null,
        !esYo ? (u.active ? { icono: '⏸', label: 'Desactivar acceso', onclick: `window.activarUsuario(${u.id}, false)` } : { icono: '▶', label: 'Reactivar acceso', onclick: `window.activarUsuario(${u.id}, true)` }) : null,
        !esYo ? { separador: true } : null,
        !esYo ? { icono: '✕', label: 'Eliminar usuario', peligro: true, onclick: `window.eliminarUsuario(${u.id})` } : null
      ]
    }
  })
}

window.irCompletarFicha = function (usuarioId) { window.irATabRRHH('empleados'); setTimeout(() => window.abrirModalEmpleado(null, usuarioId), 300) }

window.activarUsuario = async function (id, activo) {
  const u = _usuarioById(id); if (!u) return
  const r = await confirmarPequeno({ titulo: activo ? 'Reactivar acceso' : 'Desactivar acceso', okLabel: activo ? 'Reactivar' : 'Desactivar', peligro: !activo,
    texto: activo ? `<strong>${_esc(u.nombre || u.email)}</strong> podrá volver a entrar al sistema.` : `<strong>${_esc(u.nombre || u.email)}</strong> ya no podrá entrar. Sus registros históricos se conservan.` })
  if (!r.ok) return
  if (!await update('users', id, { active: activo })) { showToast('No se pudo cambiar el acceso', 'danger'); return }
  showToast(activo ? 'Acceso reactivado' : 'Acceso desactivado', 'success')
  await window.cargarUsuarios(); if ($('tab-empleados').classList.contains('active')) window.cargarEmpleados()
}

// «Eliminar» = quitar el acceso y sacarlo de las listas (active=false). El borrado real de la cuenta
// en Supabase Auth se hace a mano: así los vales, gastos y documentos que firmó no quedan huérfanos.
window.eliminarUsuario = async function (id) {
  const u = _usuarioById(id); if (!u) return
  if (String(u.email).toLowerCase() === String(getCurrentUser()?.email || '').toLowerCase()) { showToast('No puedes eliminar tu propio usuario', 'warning'); return }
  const { data: fichas } = await supabase.from('empleados').select('id').eq('user_id', id)
  if (fichas?.length) { showToast('Este usuario está vinculado a una ficha de empleado: edita la ficha y quítale el acceso primero', 'warning'); return }
  const r = await confirmarPequeno({ titulo: 'Eliminar usuario', okLabel: 'Eliminar', peligro: true,
    texto: `Se quita el acceso de <strong>${_esc(u.nombre || u.email)}</strong> (${_esc(u.email)}). Sus registros históricos se conservan. Para borrar la cuenta del todo, hazlo en Supabase → Authentication.` })
  if (!r.ok) return
  if (!await update('users', id, { active: false })) { showToast('No se pudo eliminar', 'danger'); return }
  showToast('Usuario eliminado del sistema (acceso desactivado)', 'success')
  await window.cargarUsuarios(); if ($('tab-empleados').classList.contains('active')) window.cargarEmpleados()
}

// ============================================================================
// RÉGIMEN Y PARÁMETROS (tablas estándar)
// ============================================================================
async function _pintarRegimen() { await Promise.all([_pintarRegimenEmpresas(), _pintarParametros(), _pintarAfp()]) }
const _errTabla = (id, msg) => { $(id).innerHTML = `<p style="padding:16px; color:var(--color-danger);">${_esc(msg)}</p>` }

async function _pintarRegimenEmpresas() {
  const { data, error } = await fromSinFiltro('empresa_config').select('*').order('id')
  if (error) return _errTabla('card-reg-emp', error.message)
  if (!(data?.length && 'regimen_laboral' in data[0])) { $('card-reg-emp').innerHTML = '<p style="padding:16px; color:var(--color-warning);">Falta ejecutar el SQL 134_rrhh_cimientos.sql.</p>'; return }
  _empresasCfg = data
  montarTabla('card-reg-emp', {
    nombre: 'rrhh-reg-empresas', titulo: '⚖️ Régimen laboral por empresa', buscar: false,
    sub: '<p class="rr-nota" style="padding:0;">Es distinto del régimen tributario: define CTS, gratificaciones y utilidades. Cada empresa tiene su propia planilla.</p>',
    filas: data, sort: { col: 'empresa', dir: 'asc' },
    cols: [
      { key: 'empresa', label: 'Razón social', val: e => (e.nombre_comercial || e.razon_social || '').toLowerCase(), html: e => `<strong>${_esc(e.nombre_comercial || e.razon_social)}</strong><br><small style="color:var(--text-secondary);">${_esc(e.ruc || '')}</small>` },
      { key: 'trib', label: 'Régimen tributario', val: e => e.regimen_tributario || '', html: e => _esc(e.regimen_tributario || '—') },
      { key: 'lab', label: 'Régimen laboral', val: e => e.regimen_laboral || '', html: e => `<select style="width:auto;" onchange="window.rrhhGuardarRegimen(${e.id}, 'regimen_laboral', this.value)">${Object.entries(REGIMENES).map(([k, v]) => `<option value="${k}" ${e.regimen_laboral === k ? 'selected' : ''}>${v}</option>`).join('')}</select>` },
      { key: 'remype', label: 'REMYPE', val: e => e.remype_inscrito ? 0 : 1, html: e => `<input type="checkbox" style="width:auto; margin:0;" ${e.remype_inscrito ? 'checked' : ''} onchange="window.rrhhGuardarRegimen(${e.id}, 'remype_inscrito', this.checked)">` },
      { key: 'impl', label: 'Qué implica', val: e => e.regimen_laboral || '', html: e => `<span style="font-size:0.85rem; color:var(--text-secondary);">${_esc(REGIMEN_AYUDA[e.regimen_laboral] || '')}</span>` }
    ]
  })
}
window.rrhhGuardarRegimen = async function (empresaId, campo, valor) {
  if (!await update('empresa_config', empresaId, { [campo]: valor })) { showToast('No se pudo guardar', 'danger'); return }
  showToast('Régimen actualizado ✔', 'success'); _pintarRegimenEmpresas()
}

async function _pintarParametros() {
  const { data, error } = await supabase.from('rrhh_parametros').select('*').is('vigente_hasta', null).order('id')
  if (error) return _errTabla('card-reg-par', error.message)
  montarTabla('card-reg-par', {
    nombre: 'rrhh-parametros', titulo: '📐 Parámetros legales (con vigencia)', placeholder: 'Buscar concepto…',
    sub: '<p class="rr-nota" style="padding:0;">Ningún porcentaje está fijo en el código. Para un cambio de ley, edita el valor y listo (cambia el costo estimado al instante).</p>',
    filas: data || [], sort: { col: 'id', dir: 'asc' },
    cols: [
      { key: 'id', label: '#', val: p => p.id, html: p => p.id },
      { key: 'concepto', label: 'Concepto', val: p => p.nombre.toLowerCase(), html: p => `${_esc(p.nombre)}<br><small style="color:var(--text-secondary);">${_esc(p.codigo)}</small>` },
      { key: 'valor', label: 'Valor', der: true, val: p => Number(p.valor), html: p => `<input type="number" step="0.0001" value="${p.valor}" style="width:130px; text-align:right;" onchange="window.rrhhGuardarParametro(${p.id}, this.value)">` },
      { key: 'unidad', label: 'Unidad', val: p => p.unidad, html: p => ({ pct: '%', soles: 'S/', uit: 'UIT', veces: '×' }[p.unidad] || _esc(p.unidad)) },
      { key: 'desde', label: 'Vigente desde', val: p => p.vigente_desde, html: p => fechaDMY(p.vigente_desde) },
      { key: 'nota', label: 'Nota', val: p => p.nota || '', html: p => `<span style="font-size:0.85rem; ${/VERIFICAR/.test(p.nota || '') ? 'color:var(--color-warning); font-weight:600;' : 'color:var(--text-secondary);'}">${_esc(p.nota || '')}</span>` }
    ]
  })
}
window.rrhhGuardarParametro = async function (id, valor) {
  const v = parseFloat(valor)
  if (isNaN(v) || v < 0) { showToast('Valor inválido', 'warning'); return }
  if (!await update('rrhh_parametros', id, { valor: v })) { showToast('No se pudo guardar', 'danger'); return }
  showToast('Parámetro actualizado ✔', 'success')
  const { data } = await supabase.from('rrhh_parametros').select('codigo, valor').is('vigente_hasta', null)
  _params = Object.fromEntries((data || []).map(p => [p.codigo, Number(p.valor)]))
}

async function _pintarAfp() {
  const { data, error } = await supabase.from('rrhh_afp').select('*').order('nombre')
  if (error) return _errTabla('card-reg-afp', error.message)
  montarTabla('card-reg-afp', {
    nombre: 'rrhh-afp', titulo: '🏦 AFP: comisiones vigentes', buscar: false,
    filas: data || [], sort: { col: 'afp', dir: 'asc' },
    cols: [
      { key: 'afp', label: 'AFP', val: a => a.nombre.toLowerCase(), html: a => `<strong>${_esc(a.nombre)}</strong>` },
      { key: 'flujo', label: 'Comisión sobre flujo (%)', der: true, val: a => Number(a.comision_flujo_pct), html: a => `<input type="number" step="0.001" value="${a.comision_flujo_pct}" style="width:110px; text-align:right;" onchange="window.rrhhGuardarAfp(${a.id}, 'comision_flujo_pct', this.value)">` },
      { key: 'mixta', label: 'Comisión mixta sobre saldo anual (%)', der: true, val: a => Number(a.comision_mixta_saldo_pct), html: a => `<input type="number" step="0.001" value="${a.comision_mixta_saldo_pct}" style="width:110px; text-align:right;" onchange="window.rrhhGuardarAfp(${a.id}, 'comision_mixta_saldo_pct', this.value)">` }
    ]
  })
}
window.rrhhGuardarAfp = async function (id, campo, valor) {
  const v = parseFloat(valor)
  if (isNaN(v) || v < 0) { showToast('Valor inválido', 'warning'); return }
  if (!await update('rrhh_afp', id, { [campo]: v })) { showToast('No se pudo guardar', 'danger'); return }
  showToast('AFP actualizada ✔', 'success')
  _afps = (await supabase.from('rrhh_afp').select('*').eq('activo', true).order('nombre')).data || _afps
}

// ============================================================================
// ASISTENCIA — la hora la pone el servidor; aquí solo se muestra en Lima
// ============================================================================
const _hmLima = iso => iso ? new Date(iso).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Lima' }) : ''
const _minLima = iso => { const [h, m] = _hmLima(iso).split(':').map(Number); return h * 60 + m }

let _asisFecha = null            // null = hoy (Lima)
let _asisHoy = null
let _asisFilas = []
window.cargarAsistenciaHoy = () => { _asisFecha = null; return window.cargarAsistencia() }

const _hhmm = iso => iso ? _hmLima(iso) : ''
const _difMin = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000)
const _fmtDur = min => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`
const _sumaDias = (f, d) => { const x = new Date(f + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10) }

window.asisFecha = function (v) {
  if (v === 'hoy') _asisFecha = null
  else if (v === -1 || v === 1) _asisFecha = _sumaDias(_asisFecha || _asisHoy, v)
  else if (v) _asisFecha = v
  if (_asisFecha && _asisHoy && _asisFecha > _asisHoy) _asisFecha = null      // no hay futuro
  return window.cargarAsistencia()
}

window.cargarAsistencia = async function () {
  const { data: reloj, error: eReloj } = await supabase.rpc('rrhh_hora_lima')
  if (eReloj) { $('card-asis').innerHTML = `<p style="padding:16px; color:var(--color-warning);">Falta ejecutar el SQL 135_rrhh_asistencia.sql (${_esc(eReloj.message)}).</p>`; return }
  _asisHoy = reloj.fecha_lima
  const fecha = _asisFecha || _asisHoy
  const esHoy = fecha === _asisHoy
  const [emps, asis, cts] = await Promise.all([
    supabase.from('empleados').select('*').order('id'),
    supabase.from('asistencias').select('*').eq('fecha', fecha),
    getContacts()
  ])
  if (emps.error || asis.error) return _errTabla('card-asis', (emps.error || asis.error).message)
  _contactos = cts || _contactos
  const porEmp = Object.fromEntries((asis.data || []).map(a => [a.empleado_id, a]))
  // Se listan los activos (que ya habían ingresado ese día) y cualquiera que tenga marcación ese día
  const filas = (emps.data || [])
    .filter(e => porEmp[e.id] || (e.estado === 'activo' && (!e.fecha_ingreso || e.fecha_ingreso <= fecha)))
    .map(e => ({ e, a: porEmp[e.id], c: _contactoById(e.contact_id) }))
  _asisFilas = filas
  const tarde = f => f.a?.entrada ? _minLima(f.a.entrada) - (Number(f.e.hora_entrada.slice(0, 2)) * 60 + Number(f.e.hora_entrada.slice(3, 5)) + f.e.tolerancia_min) : null
  const marcados = filas.filter(f => f.a?.entrada).length
  montarTabla('card-asis', {
    nombre: 'rrhh-asistencia', titulo: `🕐 Asistencia · ${fechaDMY(fecha)}${esHoy ? ' (hoy)' : ''} <small style="color:var(--text-secondary); font-weight:normal;">· ${marcados}/${filas.length} marcaron${esHoy ? ' · ' + _esc(reloj.lima.slice(11, 16)) + ' (Lima)' : ''}</small>`,
    placeholder: 'Buscar persona o empresa…',
    botones: `<button class="btn btn-secondary btn-small" onclick="window.asisFecha(-1)" title="Día anterior">‹</button>
      <input type="date" value="${fecha}" max="${_asisHoy}" onchange="window.asisFecha(this.value)" style="width:auto;">
      <button class="btn btn-secondary btn-small" onclick="window.asisFecha(1)" title="Día siguiente" ${esHoy ? 'disabled' : ''}>›</button>
      ${esHoy ? '' : '<button class="btn btn-secondary btn-small" onclick="window.asisFecha(\'hoy\')">Hoy</button>'}
      <button class="btn btn-secondary btn-small" onclick="window.cargarAsistencia()">↺</button>`,
    sub: `<p class="rr-nota" style="padding:0;">${esHoy ? 'Quien tiene cuenta marca con el botón de la cabecera (hora del servidor, Lima). ' : ''}Con el menú ⋮ de cada fila puedes <strong>registrar o corregir</strong> la marcación (también de días anteriores, hasta 31 días), quitar solo la salida o eliminarla. Todo cambio pide un <strong>motivo</strong> y queda en el historial.</p>`,
    sort: { col: 'nombre', dir: 'asc' }, filas, vacio: 'No hay empleados para esta fecha.',
    cols: [
      { key: 'empresa', label: 'Empresa', val: f => _empresasCfg.find(x => x.id === f.e.empresa_id)?.nombre_comercial || '', html: f => badgeEmpresa(f.e.empresa_id) },
      { key: 'nombre', label: 'Nombre', val: f => (f.c?.nombre || '').toLowerCase(), html: f => `<span class="rr-avatar">${_esc(_iniciales(f.c?.nombre))}</span><strong>${_esc(f.c?.nombre || '—')}</strong>${f.e.vinculo === 'rh_prestador' ? ' <span class="badge badge-info">RH</span>' : ''}${f.e.estado !== 'activo' ? ' <span class="badge badge-danger">cesado</span>' : ''}` },
      { key: 'cuenta', label: 'Cuenta', oculta: true, val: f => f.e.user_id ? 0 : 1, html: f => f.e.user_id ? 'Con cuenta' : 'Sin cuenta' },
      { key: 'horario', label: 'Horario', val: f => f.e.hora_entrada, html: f => `${f.e.hora_entrada.slice(0, 5)} – ${f.e.hora_salida.slice(0, 5)}` },
      { key: 'ingreso', label: 'Ingreso', val: f => f.a?.entrada || '', html: f => (_hhmm(f.a?.entrada) || '—') + (f.a?.origen_entrada === 'admin' ? ' <small title="Registrado/editado por el administrador">(admin)</small>' : '') },
      { key: 'salida', label: 'Salida', val: f => f.a?.salida || '', html: f => (_hhmm(f.a?.salida) || '—') + (f.a?.origen_salida === 'admin' ? ' <small title="Registrado/editado por el administrador">(admin)</small>' : '') },
      { key: 'horas', label: 'Horas', der: true, val: f => f.a?.entrada && f.a?.salida ? _difMin(f.a.entrada, f.a.salida) : -1, html: f => f.a?.entrada && f.a?.salida ? _fmtDur(_difMin(f.a.entrada, f.a.salida)) : GUION },
      { key: 'estado', label: 'Estado', val: f => f.a?.entrada ? (tarde(f) > 0 ? 1 : 0) : 2, html: f => {
          if (!f.a?.entrada) return '<span class="badge badge-secondary">Sin marcar</span>'
          const t = tarde(f)
          let h = t > 0 ? `<span class="badge badge-warning">Tardanza ${t} min</span>` : '<span class="badge badge-success">A tiempo</span>'
          if (f.a.salida) {
            const sched = Number(f.e.hora_salida.slice(0, 2)) * 60 + Number(f.e.hora_salida.slice(3, 5)), real = _minLima(f.a.salida)
            h += real - sched >= 15 ? ` <span class="badge badge-info">+${_fmtDur(real - sched)} extra</span>`
              : sched - real >= 15 ? ' <span class="badge badge-warning">Salida anticipada</span>' : ' <span class="badge badge-info">Jornada completa</span>'
          }
          if (f.a.motivo_edicion) h += ` <span class="badge badge-secondary" title="${_esc(f.a.motivo_edicion)}">✎ editada</span>`
          return h } }
    ],
    acciones: f => [
      esHoy && !f.a?.entrada ? { icono: '🟢', label: 'Marcar ingreso ahora', onclick: `window.rrhhMarcar(${f.e.id}, 'entrada')` } : null,
      esHoy && f.a?.entrada && !f.a.salida ? { icono: '🔴', label: 'Marcar salida ahora', onclick: `window.rrhhMarcar(${f.e.id}, 'salida')` } : null,
      { icono: '✏️', label: f.a ? 'Editar marcación' : 'Registrar marcación (con horas)', onclick: `window.asisEditar(${f.e.id})` },
      f.a?.salida ? { icono: '↩', label: 'Quitar salida', onclick: `window.asisEliminar(${f.a.id}, 'salida')` } : null,
      f.a ? { separador: true } : null,
      f.a ? { icono: '✕', label: 'Eliminar marcación', peligro: true, onclick: `window.asisEliminar(${f.a.id}, 'todo')` } : null,
      { separador: true },
      { icono: '👤', label: 'Editar ficha', onclick: `window.irATabRRHH('empleados'); setTimeout(() => window.abrirModalEmpleado(${f.e.id}), 300)` }
    ]
  })
}

// ── Editar / registrar marcación (solo admin; motivo obligatorio) ───────────
window.asisEditar = function (empleadoId) {
  window.cerrarMenuAcciones?.()
  const f = _asisFilas.find(x => x.e.id === empleadoId); if (!f) return
  const fecha = _asisFecha || _asisHoy
  $('asisEmpId').value = empleadoId
  $('asisFechaVal').value = fecha
  $('asisTitulo').textContent = f.a ? 'Editar marcación' : 'Registrar marcación'
  $('asisQuien').innerHTML = `<strong>${_esc(f.c?.nombre || '—')}</strong> · ${fechaDMY(fecha)} · horario ${f.e.hora_entrada.slice(0, 5)}–${f.e.hora_salida.slice(0, 5)}`
  $('asisEntrada').value = f.a?.entrada ? _hhmm(f.a.entrada) : f.e.hora_entrada.slice(0, 5)
  $('asisSalida').value = f.a?.salida ? _hhmm(f.a.salida) : ''
  $('asisMotivo').value = ''
  ;['asisEntrada', 'asisMotivo'].forEach(i => $(i).classList.remove('invalido'))
  $('asisAyuda').innerHTML = f.a ? `Marcación actual: ${_hhmm(f.a.entrada) || '—'} → ${_hhmm(f.a.salida) || 'sin salida'}. Se guarda el valor anterior en el historial.`
    : 'No hay marcación ese día: se creará con las horas que indiques (queda como «admin»). La salida puede quedar vacía si aún no sale.'
  window.openModal('modal-asistencia')
}

window.asisGuardar = async function () {
  const ent = $('asisEntrada').value, sal = $('asisSalida').value, motivo = $('asisMotivo').value.trim()
  const faltan = []
  if (!ent) faltan.push('asisEntrada')
  if (motivo.length < 3) faltan.push('asisMotivo')
  ;['asisEntrada', 'asisMotivo'].forEach(i => $(i).classList.remove('invalido'))
  if (faltan.length) { faltan.forEach(i => $(i).classList.add('invalido')); showToast('Completa la hora de ingreso y el motivo', 'warning'); return }
  if (sal && sal < ent) { $('asisSalida').classList.add('invalido'); showToast('La salida no puede ser anterior al ingreso', 'warning'); return }
  const btn = $('asisBtnGuardar'); btn.disabled = true
  const { error } = await supabase.rpc('rrhh_asistencia_editar', { p_empleado_id: Number($('asisEmpId').value), p_fecha: $('asisFechaVal').value, p_entrada: ent, p_salida: sal || null, p_motivo: motivo })
  btn.disabled = false
  if (error) { showToast(/does not exist|schema cache/.test(error.message) ? 'Falta ejecutar el SQL 137_rrhh_asistencia_edicion.sql' : error.message, 'danger'); return }
  showToast('Marcación guardada ✔', 'success'); window.closeModal('modal-asistencia'); window.cargarAsistencia()
}

window.asisEliminar = async function (asistenciaId, parte) {
  window.cerrarMenuAcciones?.()
  const f = _asisFilas.find(x => x.a?.id === asistenciaId); if (!f) return
  const r = await confirmarPequeno({
    titulo: parte === 'salida' ? 'Quitar salida' : 'Eliminar marcación', okLabel: parte === 'salida' ? 'Quitar salida' : 'Eliminar', peligro: true,
    texto: parte === 'salida'
      ? `Se quita la salida (${_hhmm(f.a.salida)}) de <strong>${_esc(f.c?.nombre || '')}</strong>; podrá volver a marcarla. Queda en el historial.`
      : `Se elimina toda la marcación de <strong>${_esc(f.c?.nombre || '')}</strong> de ese día (${_hhmm(f.a.entrada) || '—'} → ${_hhmm(f.a.salida) || 'sin salida'}). Queda registrada en el historial.`,
    campo: { label: 'Motivo (obligatorio)', placeholder: 'Ej: marcó por error / prueba' }
  })
  if (!r.ok) return
  if ((r.valor || '').trim().length < 3) { showToast('Escribe el motivo', 'warning'); return }
  const { error } = await supabase.rpc('rrhh_asistencia_eliminar', { p_asistencia_id: asistenciaId, p_parte: parte, p_motivo: r.valor.trim() })
  if (error) { showToast(/does not exist|schema cache/.test(error.message) ? 'Falta ejecutar el SQL 137_rrhh_asistencia_edicion.sql' : error.message, 'danger'); return }
  showToast(parte === 'salida' ? 'Salida quitada' : 'Marcación eliminada', 'success'); window.cargarAsistencia()
}

window.rrhhMarcar = async function (empleadoId, tipo) {
  const { data, error } = await supabase.rpc('rrhh_marcar', { p_empleado_id: empleadoId, p_tipo: tipo })
  if (error) { showToast(error.message || 'No se pudo marcar', 'danger'); return }
  showToast(`${tipo === 'entrada' ? 'Ingreso' : 'Salida'} registrado a las ${data.hora_lima} (Lima) ✔`, 'success')
  window.cargarAsistencia()
}

// PRUEBA OBLIGATORIA: la hora que guarda el sistema debe calzar con la de Lima.
window.verificarHoraLima = async function () {
  const out = $('asis-prueba-res')
  out.innerHTML = 'Midiendo…'
  const t0 = Date.now()
  const { data, error } = await supabase.rpc('rrhh_hora_lima')
  const t1 = Date.now()
  if (error) { out.innerHTML = `<span style="color:var(--color-danger);">${_esc(error.message)} — ¿ejecutaste el SQL 135?</span>`; return }
  const fmt = ms => new Date(ms).toLocaleString('sv-SE', { timeZone: 'America/Lima' }).replace('T', ' ')
  const navegador = fmt((t0 + t1) / 2)
  const limaDelEpoch = fmt(Number(data.epoch_ms))
  const difSeg = Math.round((Number(data.epoch_ms) - (t0 + t1) / 2) / 1000)
  const zonaOk = data.lima.slice(0, 16) === limaDelEpoch.slice(0, 16)
  const relojOk = Math.abs(difSeg) <= 120
  out.innerHTML = `<table style="max-width:560px;"><tbody>
    <tr><td>Hora que guardará el sistema (servidor, Lima)</td><td><strong>${_esc(data.lima)}</strong></td></tr>
    <tr><td>Hora de este equipo, convertida a Lima</td><td><strong>${_esc(navegador)}</strong></td></tr>
    <tr><td>Diferencia servidor ↔ equipo</td><td><strong>${difSeg} s</strong> ${relojOk ? '✔' : '✖ (revisa la hora de tu equipo)'}</td></tr>
    <tr><td>Conversión UTC → Lima correcta</td><td>${zonaOk ? '✔' : '✖'}</td></tr>
    </tbody></table>
    <p style="margin-top:10px; font-weight:600; color:var(--color-${zonaOk && relojOk ? 'success' : 'danger'});">
      ${zonaOk && relojOk ? '✔ La hora de asistencia calza con la hora real de Lima.' : '✖ La hora NO calza. No uses asistencia hasta corregirlo.'}</p>`
}
