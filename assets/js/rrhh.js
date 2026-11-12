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
import { abrirModalMarcar } from './shared/asistencia-boton.js'
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
  $('empBloqueRH').style.display = rh ? '' : 'none'
  $('empPasoTit4').textContent = rh ? 'Pago' : 'Pensión'
  $('empSueldoLbl').textContent = (rh ? 'Honorario mensual referencial' : 'Sueldo mensual') + ' *'
  window.empResumen()
}
window.empAlCambiarPension = function () {
  const afp = $('empPension').value === 'afp'
  document.querySelectorAll('.emp-afp').forEach(el => { el.style.display = afp ? '' : 'none' })
  window.empResumen()
}


// ============================================================================
// MODAL «NUEVO / EDITAR EMPLEADO» POR PASOS + HORARIO POR DÍA (SQL 159)
// ============================================================================
let _empPaso = 1
window._empPasoActual = () => _empPaso
const _STEP_DE = { empContacto: 1, empEmpresa: 1, empUsuario: 1, empVinculo: 2, empSueldo: 2, empIngreso: 2, empSemana: 3, empHoraEntrada: 3, empAfp: 4 }

window.empPaso = function (n) {
  _empPaso = Math.max(1, Math.min(4, Number(n) || 1))
  document.querySelectorAll('#modal-empleado .emp-paso').forEach(el => { el.style.display = Number(el.dataset.paso) === _empPaso ? '' : 'none' })
  document.querySelectorAll('#empPasos button').forEach(b => {
    const k = Number(b.dataset.paso); b.classList.toggle('activo', k === _empPaso); b.classList.toggle('hecho', k < _empPaso)
  })
  const at = $('empBtnAtras'), sg = $('empBtnSig'), gd = $('empBtnGuardar')
  if (at) at.style.visibility = _empPaso > 1 ? 'visible' : 'hidden'
  if (sg) sg.style.display = _empPaso < 4 ? '' : 'none'
  if (gd) gd.className = 'btn ' + (_empPaso === 4 ? 'btn-primary' : 'btn-secondary')
}
window.empSiguiente = function () {
  const falta = []
  if (_empPaso === 1) {
    if (!$('empContacto').value && !_usuarioPendiente) falta.push('empContacto')
    if (!$('empEmpresa').value) falta.push('empEmpresa')
  }
  if (_empPaso === 2 && !(parseFloat($('empSueldo').value || 0) > 0)) falta.push('empSueldo')
  if (_empPaso === 3 && _horarioInvalido()) falta.push('empSemana')
  if (falta.length) { _marcarInvalido(falta); showToast('Completa lo marcado en rojo para continuar', 'warning'); return }
  window.empPaso(_empPaso + 1)
}

// ── Horario semanal ─────────────────────────────────────────────────────────
const _DIAS = [[1, 'Lun'], [2, 'Mar'], [3, 'Mié'], [4, 'Jue'], [5, 'Vie'], [6, 'Sáb'], [0, 'Dom']]
const _t2m = t => t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null
const _m2t = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
const _filaSem = d => document.querySelector(`#empSemana .hs-fila[data-d="${d}"]`)

function _pintarSemana(hs, marcarManuales = false) {
  $('empSemana').innerHTML = _DIAS.map(([d, l]) => { const h = hs[d]; return `<div class="hs-fila${h ? '' : ' off'}" data-d="${d}">
      <label class="hs-dia"><input type="checkbox" ${h ? 'checked' : ''} onchange="window.empDiaToggle(${d}, this.checked)"> ${l}</label>
      <input type="time" class="hs-e" value="${h?.e || ''}" ${h ? '' : 'disabled'} oninput="window.empDiaEdit(${d})">
      <input type="time" class="hs-s" value="${h?.s || ''}" ${h ? '' : 'disabled'} oninput="window.empDiaEdit(${d})">
      <span class="hs-net">${h ? '' : 'Descanso'}</span></div>` }).join('')
  if (marcarManuales) {          // al editar: los días distintos del horario base se respetan al cambiar la base
    const be = $('empHoraEntrada').value, bs = $('empHoraSalida').value
    document.querySelectorAll('#empSemana .hs-fila:not(.off)').forEach(f => { if (f.querySelector('.hs-e').value !== be || f.querySelector('.hs-s').value !== bs) f.dataset.manual = '1' })
  }
  window.empHorarioCalc()
}
function _leerSemana() {
  const hs = {}
  document.querySelectorAll('#empSemana .hs-fila').forEach(f => { if (f.querySelector('input[type=checkbox]').checked) hs[f.dataset.d] = { e: f.querySelector('.hs-e').value, s: f.querySelector('.hs-s').value } })
  return hs
}
const _horarioInvalido = () => { const v = Object.values(_leerSemana()); return !v.length || v.some(h => !h.e || !h.s || _t2m(h.s) <= _t2m(h.e)) }

window.empDiaToggle = function (d, on) {
  const f = _filaSem(d); f.classList.toggle('off', !on)
  f.querySelectorAll('input[type=time]').forEach(i => { i.disabled = !on; if (on && !i.value) i.value = i.classList.contains('hs-e') ? $('empHoraEntrada').value : $('empHoraSalida').value })
  delete f.dataset.manual
  window.empHorarioCalc()
}
window.empDiaEdit = function (d) { _filaSem(d).dataset.manual = '1'; window.empHorarioCalc() }
window.empBaseCambio = function () {
  document.querySelectorAll('#empSemana .hs-fila:not(.off)').forEach(f => {
    if (f.dataset.manual !== '1') { f.querySelector('.hs-e').value = $('empHoraEntrada').value; f.querySelector('.hs-s').value = $('empHoraSalida').value }
  })
  window.empHorarioCalc()
}
window.empPreset = function (tipo) {
  const e = $('empHoraEntrada').value || '08:30', s = $('empHoraSalida').value || '18:00'
  const hs = {}; ;(tipo === 'ls' ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5]).forEach(d => { hs[d] = { e, s } })
  if (tipo === 'lvs') hs[6] = { e, s: _m2t(Math.min(_t2m(e) + 270, 24 * 60 - 1)) }      // sábado medio día = 4,5 h
  _pintarSemana(hs)
  if (tipo === 'lvs') _filaSem(6).dataset.manual = '1'
}
// Horas netas por día = salida − entrada − almuerzo (el almuerzo solo se descuenta en días de más de 5 h)
window.empHorarioCalc = function () {
  const alm = Number($('empAlmuerzo').value || 0)
  let tot = 0, n = 0
  document.querySelectorAll('#empSemana .hs-fila').forEach(f => {
    const span = f.querySelector('.hs-net')
    if (!f.querySelector('input[type=checkbox]').checked) { span.textContent = 'Descanso'; span.className = 'hs-net'; return }
    const t = _t2m(f.querySelector('.hs-s').value) - _t2m(f.querySelector('.hs-e').value)
    if (!(t > 0)) { span.textContent = '⚠ revisa'; span.className = 'hs-net mal'; return }
    const m = Math.max(t - (t > 300 ? alm : 0), 0)
    span.textContent = _fmtDur(m); span.className = 'hs-net'; tot += m; n++
  })
  $('empJornada').value = n ? (Math.round(tot / n / 60 * 2) / 2) : 8
  const box = $('empSemanaTot')
  box.innerHTML = n ? `📅 <strong>${n} día(s)</strong> · jornada semanal <strong>${_fmtDur(tot)}</strong> · promedio ${_fmtDur(Math.round(tot / n))}/día${alm ? ` · almuerzo de ${alm} min descontado` : ''}${tot > 48 * 60 ? ' · <strong style="color:var(--color-warning);">⚠ supera las 48 h semanales (tope legal)</strong>' : ''}`
    : '⚠ Marca al menos un día laborable.'
  window.empResumen()
}
function _textoHorario(hs) {
  const orden = [1, 2, 3, 4, 5, 6, 0], lab = Object.fromEntries(_DIAS), grupos = []
  orden.forEach(d => { const h = hs[d]; if (!h || !h.e || !h.s) return; const k = h.e + '–' + h.s; const g = grupos.find(x => x.k === k); g ? g.i.push(orden.indexOf(d)) : grupos.push({ k, i: [orden.indexOf(d)] }) })
  return grupos.map(g => {
    const partes = []; let i = 0
    while (i < g.i.length) { let j = i; while (j + 1 < g.i.length && g.i[j + 1] === g.i[j] + 1) j++; partes.push(i === j ? lab[orden[g.i[i]]] : lab[orden[g.i[i]]] + '–' + lab[orden[g.i[j]]]); i = j + 1 }
    return partes.join(', ') + ' ' + g.k
  }).join(' · ') || '—'
}

let _hay159
function _checar159() {
  if (_hay159 !== undefined) return
  _hay159 = null
  supabase.from('empleados').select('horario_semanal').limit(1).then(r => {
    _hay159 = !r.error
    const a = $('empAviso159')
    if (a && !_hay159) { a.style.display = ''; a.textContent = '⚠ Falta ejecutar el SQL 159_rrhh_horario_semanal.sql: hasta entonces el horario por día no se guarda (solo la hora base).' }
  })
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
  $('empBtnCambiarEmpresa').style.display = e ? '' : 'none'      // en una ficha existente la empresa se cambia con el asistente (mover / transferir)
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
  const _be = (e?.hora_entrada || '08:30').slice(0, 5), _bs = (e?.hora_salida || '18:00').slice(0, 5)
  $('empHoraEntrada').value = _be; $('empHoraSalida').value = _bs
  $('empAlmuerzo').value = String(e?.almuerzo_min ?? 60)
  $('empTolerancia').value = e?.tolerancia_min ?? 10
  _pintarSemana(e?.horario_semanal ? { ...e.horario_semanal } : _semanaLV(_be, _bs), !!e)
  $('empUsuario').value = e?.user_id || u?.id || ''
  $('empNotas').value = e?.notas || ''
  document.querySelectorAll('#modal-empleado .invalido').forEach(x => x.classList.remove('invalido'))
  const av = $('empAviso')
  if (u && !c) { av.style.display = ''; av.innerHTML = `ℹ️ No hay un contacto para <strong>${_esc(u.nombre || u.email)}</strong>. Al guardar se creará solo con rol <strong>Empleado</strong> (nombre y correo del usuario). Si ya existe con otro nombre, elígelo en «Persona» para no duplicarlo.` }
  else if (u && c) { av.style.display = ''; av.innerHTML = `✔ Se encontró el contacto <strong>${_esc(c.nombre)}</strong> y se usará (sin duplicar). Verifica que sea la misma persona; si no, elige otra en «Persona».` }
  else av.style.display = 'none'
  window.empAlCambiarVinculo(); window.empAlCambiarPension(); window.empAlElegirPersona()
  _checar159()
  { const a = $('empAviso159'); if (a) a.style.display = _hay159 === false ? '' : 'none' }
  window.empPaso(1)
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
      <div>Horario: ${_esc(_textoHorario(_leerSemana()))}</div>
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

// ── Cambiar de empresa: MOVER (corregir un error) o TRANSFERIR (cambio real de empleador) — SQL 160 ──
window.empCambiarEmpresa = async function () {
  const id = Number($('empId').value || 0); const e = _empleados.find(x => x.id === id); if (!e) return
  const nombre = _contactoById(e.contact_id)?.nombre || '—'
  const origen = _empresasCfg.find(x => x.id === e.empresa_id)
  const destinos = _empresasCfg.filter(x => x.id !== e.empresa_id)
  if (!destinos.length) { showToast('No hay otra empresa a la cual cambiarla', 'warning'); return }
  const { count } = await supabase.from('asistencias').select('id', { count: 'exact', head: true }).eq('empleado_id', id)
  const hoy = _asisHoy || new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Lima' })
  const m = document.createElement('div'); m.className = 'modal show'; m.style.zIndex = 3100
  m.innerHTML = `<div class="modal-content ui-moderna" style="width:min(94vw,500px); max-width:min(94vw,500px); padding:20px;">
    <h3 style="margin:0 0 4px;">🔁 Cambiar de empresa</h3>
    <p style="margin:0 0 12px; color:var(--text-secondary); font-size:0.9rem;"><strong>${_esc(nombre)}</strong> · hoy en <strong>${_esc(origen?.nombre_comercial || '')}</strong> · ${count || 0} asistencia(s) registrada(s)</p>
    <div class="form-group"><label>Empresa destino *</label><select id="ceDestino">${destinos.map(d => `<option value="${d.id}">${_esc(d.nombre_comercial)}</option>`).join('')}</select></div>
    <div class="form-group" style="margin-top:10px;"><label>¿Qué pasó?</label>
      <label class="ce-op"><input type="radio" name="ceModo" value="mover" checked> <span><strong>Se registró en la empresa equivocada</strong><br><small>Se mueve la ficha con todas sus asistencias, marcas e historial. Nada queda en la empresa de origen.</small></span></label>
      <label class="ce-op"><input type="radio" name="ceModo" value="transferir"> <span><strong>Cambió de empleador</strong><br><small>La ficha actual se cesa (su historial se queda aquí) y se crea una ficha nueva en el destino con los mismos datos.</small></span></label></div>
    <div class="form-group" id="ceFechaBox" style="display:none;"><label>Fecha de ingreso a la nueva empresa *</label><input type="date" id="ceFecha" value="${hoy}"></div>
    <div class="form-group"><label>Motivo *</label><input type="text" id="ceMotivo" placeholder="Ej: error al registrar / pasó a planilla de Benji"></div>
    <div id="ceAviso" class="rr-aviso" style="margin:0 0 10px; display:none;"></div>
    <div style="display:flex; gap:8px; justify-content:flex-end;">
      <button class="btn btn-secondary btn-small" id="ceNo">Cancelar</button><button class="btn btn-primary btn-small" id="ceSi">Cambiar empresa</button></div></div>`
  document.body.appendChild(m)
  const cerrar = () => m.remove()
  m.querySelector('#ceNo').onclick = cerrar; m.addEventListener('click', ev => { if (ev.target === m) cerrar() })
  const aviso = (t) => { const a = m.querySelector('#ceAviso'); a.style.display = t ? '' : 'none'; a.innerHTML = t || '' }
  const modo = () => m.querySelector('input[name=ceModo]:checked').value
  const refrescar = () => {
    m.querySelector('#ceFechaBox').style.display = modo() === 'transferir' ? '' : 'none'
    const dest = Number(m.querySelector('#ceDestino').value)
    const dup = _empleados.find(x => x.contact_id === e.contact_id && x.empresa_id === dest)
    const dd = _empresasCfg.find(x => x.id === dest)?.nombre_comercial
    aviso(dup ? `⚠ ${_esc(nombre)} ya tiene una ficha en ${_esc(dd)} (${_esc(dup.estado)}). Edita o reactiva esa ficha en vez de cambiar esta.` : '')
    m.querySelector('#ceSi').disabled = !!dup
  }
  m.querySelectorAll('input[name=ceModo], #ceDestino').forEach(i => i.addEventListener('change', refrescar)); refrescar()
  m.querySelector('#ceSi').onclick = async () => {
    const motivo = m.querySelector('#ceMotivo').value.trim(), dest = Number(m.querySelector('#ceDestino').value), fecha = m.querySelector('#ceFecha').value
    if (motivo.length < 3) { m.querySelector('#ceMotivo').classList.add('invalido'); showToast('Escribe el motivo', 'warning'); return }
    if (modo() === 'transferir' && !fecha) { m.querySelector('#ceFecha').classList.add('invalido'); return }
    const b = m.querySelector('#ceSi'); b.disabled = true
    const { data, error } = modo() === 'mover'
      ? await supabase.rpc('rrhh_empleado_mover_empresa', { p_empleado_id: id, p_empresa_id: dest, p_motivo: motivo })
      : await supabase.rpc('rrhh_empleado_transferir', { p_empleado_id: id, p_empresa_id: dest, p_fecha: fecha, p_motivo: motivo })
    if (error) { b.disabled = false; aviso('⚠ ' + _esc(/does not exist|schema cache/.test(error.message) ? 'Falta ejecutar el SQL 160_rrhh_cambiar_empresa.sql' : error.message)); return }
    cerrar(); window.closeModal('modal-empleado')
    showToast(modo() === 'mover' ? `Ficha movida a ${data.a} (${data.asistencias_movidas} asistencias) ✔` : `Transferido a ${data.a}: ficha nueva creada y la anterior cesada ✔`, 'success', 7000)
    _empleados = (await supabase.from('empleados').select('*').order('id')).data || _empleados
    await window.cargarEmpleados?.()
  }
}

// ── Guardar / cesar / reactivar / eliminar ──────────────────────────────────
const _marcarInvalido = (ids) => {
  document.querySelectorAll('#modal-empleado .invalido').forEach(x => x.classList.remove('invalido'))
  ids.forEach(id => $(id)?.classList.add('invalido'))
  const _st = _STEP_DE[ids[0]]; if (_st && _st !== _empPaso) window.empPaso(_st)
  $(ids[0])?.focus?.()
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
  if (_horarioInvalido()) faltan.push('empSemana')
  if (faltan.length) { _marcarInvalido(faltan); showToast('Completa los campos marcados en rojo (*)', 'warning'); return }
  if (contactId && _empleados.find(e => e.contact_id === contactId && e.empresa_id === empresaId && e.id !== id)) {
    _marcarInvalido(['empContacto']); showToast('Esa persona ya tiene ficha en esa empresa', 'warning'); return
  }
  const hs = _leerSemana()
  const primerDia = hs[[1, 2, 3, 4, 5, 6, 0].find(d => hs[d])] || { e: '08:30', s: '18:00' }
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
      hora_entrada: primerDia.e, hora_salida: primerDia.s,
      jornada_horas: parseFloat($('empJornada').value || 8),
      ...(_hay159 === false ? {} : { horario_semanal: hs, almuerzo_min: Number($('empAlmuerzo').value || 0) }),
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
        !esYo && u.active && u.role !== 'admin' ? { icono: '🛡️', label: 'Dar rol Administrador', onclick: `window.usuarioCambiarRol(${u.id}, 'admin', ${JSON.stringify(u.nombre || u.email).replace(/"/g, '&quot;')}, '${u.role || ''}')` } : null,
        !esYo && u.role === 'admin' ? { icono: '🛡️', label: 'Quitar rol Administrador', onclick: `window.usuarioCambiarRol(${u.id}, 'oficina', ${JSON.stringify(u.nombre || u.email).replace(/"/g, '&quot;')}, 'admin')` } : null,
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

let _asisFecha = null            // null = hoy (Lima). En semana/mes es la fecha de referencia
let _asisHoy = null
let _asisFilas = []
let _asisVista = 'dia'           // 'dia' | 'semana' | 'mes'
window.cargarAsistenciaHoy = () => { _asisFecha = null; return window.cargarAsistencia() }

const _hhmm = iso => iso ? _hmLima(iso) : ''
const _difMin = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000)
const _fmtDur = min => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`
const _sumaDias = (f, d) => { const x = new Date(f + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10) }
const _sumaMeses = (f, n) => { const x = new Date(f + 'T12:00:00Z'); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10) }
const _DOW = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
const _MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
const _dowDe = f => new Date(f + 'T12:00:00Z').getUTCDay()
const _dd = f => f.slice(8, 10) + '/' + f.slice(5, 7)

function _rangoAsis(anchor, vista) {
  if (vista === 'dia') return { desde: anchor, hasta: anchor }
  if (vista === 'semana') { const dow = (_dowDe(anchor) + 6) % 7; return { desde: _sumaDias(anchor, -dow), hasta: _sumaDias(anchor, 6 - dow) } }
  const d = new Date(anchor + 'T12:00:00Z'), y = d.getUTCFullYear(), m = d.getUTCMonth()
  return { desde: new Date(Date.UTC(y, m, 1, 12)).toISOString().slice(0, 10), hasta: new Date(Date.UTC(y, m + 1, 0, 12)).toISOString().slice(0, 10) }
}
const _listaDias = (desde, hasta) => { const a = []; for (let f = desde; f <= hasta; f = _sumaDias(f, 1)) a.push(f); return a }

// Minutos trabajados netos = salida − ingreso − almuerzo (solo si hay salida de labores)
const _netoMin = (a, marcas) => {
  if (!a?.entrada || !a?.salida) return null
  let t = _difMin(a.entrada, a.salida)
  const s = (marcas || []).find(m => m.tipo === 'almuerzo_salida'), r = (marcas || []).find(m => m.tipo === 'almuerzo_regreso')
  if (s && r) t -= _difMin(s.hora, r.hora)
  return Math.max(t, 0)
}
const _hm2min = h => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5))
const _semanaLV = (ent, sal) => Object.fromEntries([1, 2, 3, 4, 5].map(d => [d, { e: ent, s: sal }]))
// Horario del empleado en una fecha: {e,s} o null si ese día es de descanso. Sin SQL 159: Lun–Vie con su hora de entrada/salida.
const _horDia = (e, fecha) => (e.horario_semanal || _semanaLV(e.hora_entrada.slice(0, 5), e.hora_salida.slice(0, 5)))[String(_dowDe(fecha))] || null
const _tardeMin = (e, a) => { if (!a?.entrada) return null; const h = _horDia(e, a.fecha); return h ? _minLima(a.entrada) - (_hm2min(h.e) + e.tolerancia_min) : null }

window.asisVista = function (v) { _asisVista = v; return window.cargarAsistencia() }
window.asisIrDia = function (f) { _asisVista = 'dia'; _asisFecha = f === _asisHoy ? null : f; return window.cargarAsistencia(); }

window.asisFecha = function (v) {
  if (v === 'hoy') _asisFecha = null
  else if (v === -1 || v === 1) {
    const base = _asisFecha || _asisHoy
    _asisFecha = _asisVista === 'dia' ? _sumaDias(base, v) : _asisVista === 'semana' ? _sumaDias(base, 7 * v) : _sumaMeses(base, v)
  } else if (v) _asisFecha = v
  if (_asisFecha && _asisHoy && _asisFecha > _asisHoy) _asisFecha = null      // no hay futuro
  return window.cargarAsistencia()
}

window.cargarAsistencia = async function () {
  const { data: reloj, error: eReloj } = await supabase.rpc('rrhh_hora_lima')
  if (eReloj) { $('card-asis').innerHTML = `<p style="padding:16px; color:var(--color-warning);">Falta ejecutar el SQL 135_rrhh_asistencia.sql (${_esc(eReloj.message)}).</p>`; return }
  _asisHoy = reloj.fecha_lima
  const fecha = _asisFecha || _asisHoy
  const esHoy = fecha === _asisHoy
  const { desde, hasta } = _rangoAsis(fecha, _asisVista)
  const [emps, asis, mar, cts] = await Promise.all([
    supabase.from('empleados').select('*').order('id'),
    supabase.from('asistencias').select('*').gte('fecha', desde).lte('fecha', hasta),
    supabase.from('asistencia_marcas').select('*').gte('fecha', desde).lte('fecha', hasta).order('hora'),
    getContacts()
  ])
  if (emps.error || asis.error) return _errTabla('card-asis', (emps.error || asis.error).message)
  const sin158 = !!mar.error         // sin SQL 158 la pantalla sigue funcionando (solo ingreso/salida)
  _contactos = cts || _contactos
  const marcasPorAsis = {}
  ;(mar.data || []).forEach(m => { (marcasPorAsis[m.asistencia_id] ||= []).push(m) })
  const porEmpDia = {}
  ;(asis.data || []).forEach(a => { (porEmpDia[a.empleado_id] ||= {})[a.fecha] = a })

  // Se listan los activos (que ya habían ingresado) y cualquiera que tenga marcación en el periodo
  const filas = (emps.data || [])
    .filter(e => porEmpDia[e.id] || (e.estado === 'activo' && (!e.fecha_ingreso || e.fecha_ingreso <= hasta) && (!e.fecha_cese || e.fecha_cese >= desde)))
    .map(e => {
      const dias = porEmpDia[e.id] || {}
      const a = dias[fecha]
      return { e, c: _contactoById(e.contact_id), dias, a, marcas: a ? (marcasPorAsis[a.id] || []) : [], marcasPorAsis }
    })
  _asisFilas = filas

  const toggle = ['dia', 'semana', 'mes'].map(v => `<button class="btn ${_asisVista === v ? 'btn-primary' : 'btn-secondary'} btn-small" onclick="window.asisVista('${v}')">${{ dia: 'Día', semana: 'Semana', mes: 'Mes' }[v]}</button>`).join('')
  const finActual = hasta >= _asisHoy
  const botones = `<span style="display:inline-flex; gap:4px; margin-right:8px;">${toggle}</span>
      <button class="btn btn-secondary btn-small" onclick="window.asisFecha(-1)" title="Anterior">‹</button>
      <input type="date" value="${fecha}" max="${_asisHoy}" onchange="window.asisFecha(this.value)" style="width:auto;">
      <button class="btn btn-secondary btn-small" onclick="window.asisFecha(1)" title="Siguiente" ${finActual ? 'disabled' : ''}>›</button>
      ${esHoy && _asisVista === 'dia' ? '' : '<button class="btn btn-secondary btn-small" onclick="window.asisFecha(\'hoy\')">Hoy</button>'}
      <button class="btn btn-secondary btn-small" onclick="window.cargarAsistencia()">↺</button>`
  const avisoSql = sin158 ? '<p class="rr-nota" style="color:var(--color-warning);">⚠ Falta ejecutar el SQL 158_rrhh_marcas_almuerzo.sql: hasta entonces solo se registran ingreso y salida.</p>' : ''

  if (_asisVista === 'dia') return _tablaAsisDia({ filas, fecha, esHoy, reloj, botones, avisoSql })
  return _tablaAsisPeriodo({ filas, desde, hasta, botones, avisoSql, compacto: _asisVista === 'mes' })
}

function _tablaAsisDia({ filas, fecha, esHoy, reloj, botones, avisoSql }) {
  const marcados = filas.filter(f => f.a?.entrada).length
  const almDe = f => ({ s: f.marcas.find(m => m.tipo === 'almuerzo_salida'), r: f.marcas.find(m => m.tipo === 'almuerzo_regreso') })
  montarTabla('card-asis', {
    nombre: 'rrhh-asistencia', titulo: `🕐 Asistencia · ${fechaDMY(fecha)}${esHoy ? ' (hoy)' : ''} <small style="color:var(--text-secondary); font-weight:normal;">· ${marcados}/${filas.length} marcaron${esHoy ? ' · ' + _esc(reloj.lima.slice(11, 16)) + ' (Lima)' : ''}</small>`,
    placeholder: 'Buscar persona o empresa…', botones,
    sub: `${avisoSql}<p class="rr-nota" style="padding:0;">${esHoy ? 'Quien tiene cuenta marca con el botón de la cabecera (hora del servidor, Lima). ' : ''}Con el menú ⋮ de cada fila puedes <strong>registrar o corregir</strong> la marcación (también de días anteriores, hasta 31 días), quitar solo la salida o eliminarla. Todo cambio pide un <strong>motivo</strong> y queda en el historial.</p>`,
    sort: { col: 'nombre', dir: 'asc' }, filas, vacio: 'No hay empleados para esta fecha.',
    cols: [
      { key: 'empresa', label: 'Empresa', val: f => _empresasCfg.find(x => x.id === f.e.empresa_id)?.nombre_comercial || '', html: f => badgeEmpresa(f.e.empresa_id) },
      { key: 'nombre', label: 'Nombre', val: f => (f.c?.nombre || '').toLowerCase(), html: f => `<span class="rr-avatar">${_esc(_iniciales(f.c?.nombre))}</span><strong>${_esc(f.c?.nombre || '—')}</strong>${f.e.vinculo === 'rh_prestador' ? ' <span class="badge badge-info">RH</span>' : ''}${f.e.estado !== 'activo' ? ' <span class="badge badge-danger">cesado</span>' : ''}` },
      { key: 'cuenta', label: 'Cuenta', oculta: true, val: f => f.e.user_id ? 0 : 1, html: f => f.e.user_id ? 'Con cuenta' : 'Sin cuenta' },
      { key: 'horario', label: 'Horario', val: f => _horDia(f.e, fecha)?.e || 'zz', html: f => { const h = _horDia(f.e, fecha); return h ? `${h.e} – ${h.s}` : '<span class="badge badge-secondary">Descanso</span>' } },
      { key: 'ingreso', label: 'Ingreso', val: f => f.a?.entrada || '', html: f => (_hhmm(f.a?.entrada) || '—') + (f.a?.origen_entrada === 'admin' ? ' <small title="Registrado/editado por el administrador">(admin)</small>' : '') },
      { key: 'almuerzo', label: 'Almuerzo', val: f => almDe(f).s?.hora || '', html: f => { const { s, r } = almDe(f); return !s ? GUION : r ? `${_hhmm(s.hora)} – ${_hhmm(r.hora)} <small>(${_difMin(s.hora, r.hora)} min)</small>` : `${_hhmm(s.hora)} – <span class="badge badge-warning">en almuerzo</span>` } },
      { key: 'salida', label: 'Salida', val: f => f.a?.salida || '', html: f => (_hhmm(f.a?.salida) || '—') + (f.a?.origen_salida === 'admin' ? ' <small title="Registrado/editado por el administrador">(admin)</small>' : '') },
      { key: 'horas', label: 'Horas netas', der: true, val: f => _netoMin(f.a, f.marcas) ?? -1, html: f => { const n = _netoMin(f.a, f.marcas); return n == null ? GUION : _fmtDur(n) } },
      { key: 'otras', label: 'Otras marcas', oculta: true, val: f => f.marcas.filter(m => m.tipo === 'otro').length, html: f => f.marcas.filter(m => m.tipo === 'otro').map(m => `${_hhmm(m.hora)} ${_esc(m.nota || '')}`).join('<br>') || GUION },
      { key: 'estado', label: 'Estado', val: f => f.a?.entrada ? (_tardeMin(f.e, f.a) > 0 ? 1 : 0) : 2, html: f => {
          if (!f.a?.entrada) return '<span class="badge badge-secondary">Sin marcar</span>'
          const t = _tardeMin(f.e, f.a)
          let h = t > 0 ? `<span class="badge badge-warning">Tardanza ${t} min</span>` : '<span class="badge badge-success">A tiempo</span>'
          if (f.a.salida) {
            const hd = _horDia(f.e, fecha), sched = _hm2min(hd ? hd.s : f.e.hora_salida.slice(0, 5)), real = _minLima(f.a.salida)
            h += real - sched >= 15 ? ` <span class="badge badge-info">+${_fmtDur(real - sched)} extra</span>`
              : sched - real >= 15 ? ' <span class="badge badge-warning">Salida anticipada</span>' : ' <span class="badge badge-info">Jornada completa</span>'
          }
          if (f.a.motivo_edicion) h += ` <span class="badge badge-secondary" title="${_esc(f.a.motivo_edicion)}">✎ editada</span>`
          return h } }
    ],
    acciones: f => [
      esHoy && f.e.estado === 'activo' && !f.a?.salida ? { icono: '🕐', label: 'Marcar ahora…', onclick: `window.rrhhMarcar(${f.e.id})` } : null,
      { icono: '✏️', label: f.a ? 'Editar marcación' : 'Registrar marcación (con horas)', onclick: `window.asisEditar(${f.e.id})` },
      f.a?.salida ? { icono: '↩', label: 'Quitar salida', onclick: `window.asisEliminar(${f.a.id}, 'salida')` } : null,
      f.a ? { separador: true } : null,
      f.a ? { icono: '✕', label: 'Eliminar marcación', peligro: true, onclick: `window.asisEliminar(${f.a.id}, 'todo')` } : null,
      { separador: true },
      { icono: '👤', label: 'Editar ficha', onclick: `window.irATabRRHH('empleados'); setTimeout(() => window.abrirModalEmpleado(${f.e.id}), 300)` }
    ]
  })
}

// Grilla empleados × días (semana o mes). Clic en una celda → abre ese día.
// Falta = día L–V pasado, dentro del periodo laboral del empleado, sin marcación. Sábado y domingo no cuentan como falta.
function _tablaAsisPeriodo({ filas, desde, hasta, botones, avisoSql, compacto }) {
  const dias = _listaDias(desde, hasta)
  const titulo = compacto
    ? `${_MESES[Number(desde.slice(5, 7)) - 1]} ${desde.slice(0, 4)}`
    : `Semana ${_dd(desde)} – ${_dd(hasta)}/${hasta.slice(0, 4)}`
  const celda = (f, d) => {
    const a = f.dias[d], dow = _dowDe(d)
    const link = (txt, tip, color) => `<a href="#" onclick="window.asisIrDia('${d}'); return false;" title="${_esc(tip)}" style="text-decoration:none; ${color ? 'color:' + color + ';' : ''}">${txt}</a>`
    if (!a) {
      if (d > _asisHoy || (f.e.fecha_ingreso && d < f.e.fecha_ingreso) || (f.e.fecha_cese && d > f.e.fecha_cese)) return ''
      if (!_horDia(f.e, d)) return '<span style="opacity:.35">·</span>'      // día de descanso del empleado
      return link('✖', 'Sin marcación (falta)', 'var(--color-danger)')
    }
    const t = _tardeMin(f.e, a), marcas = f.marcasPorAsis[a.id] || [], neto = _netoMin(a, marcas)
    const tip = `${_hhmm(a.entrada)} – ${_hhmm(a.salida) || 'sin salida'}${neto != null ? ' · ' + _fmtDur(neto) + ' netas' : ''}${t > 0 ? ' · tardanza ' + t + ' min' : ''}`
    const color = t > 0 ? 'var(--color-warning)' : 'var(--color-success)'
    if (compacto) return link(t > 0 ? '⏰' : '✔', tip, color)
    return link(`${_hhmm(a.entrada)}–${a.salida ? _hhmm(a.salida) : '…'}`, tip, color)
  }
  const totales = f => {
    let min = 0, tard = 0, falt = 0, pres = 0
    dias.forEach(d => {
      const a = f.dias[d], dow = _dowDe(d)
      if (a) { pres++; const n = _netoMin(a, f.marcasPorAsis[a.id] || []); if (n) min += n; if (_tardeMin(f.e, a) > 0) tard++ }
      else if (d < _asisHoy && _horDia(f.e, d) && !(f.e.fecha_ingreso && d < f.e.fecha_ingreso) && !(f.e.fecha_cese && d > f.e.fecha_cese)) falt++
    })
    return { min, tard, falt, pres }
  }
  const colsDias = dias.map((d, i) => ({
    key: compacto ? 'd' + d.slice(8) : 'w' + i, label: compacto ? d.slice(8) : `${_DOW[_dowDe(d)]} ${d.slice(8)}`, ancho: compacto ? '34px' : undefined,
    val: f => f.dias[d]?.entrada ? _minLima(f.dias[d].entrada) : (_dowDe(d) === 0 ? -2 : -1),
    html: f => celda(f, d)
  }))
  const totFaltas = filas.reduce((s, f) => s + totales(f).falt, 0), totTard = filas.reduce((s, f) => s + totales(f).tard, 0)
  montarTabla('card-asis', {
    nombre: 'rrhh-asistencia-' + (compacto ? 'mes' : 'semana'), claseTabla: 'rr-grid' + (compacto ? ' rr-grid-mes' : ''),
    titulo: `🕐 Asistencia · ${titulo} <small style="color:var(--text-secondary); font-weight:normal;">· ${filas.length} empleados · ${totTard} tardanzas · ${totFaltas} faltas</small>`,
    placeholder: 'Buscar persona o empresa…', botones,
    sub: `${avisoSql}<p class="rr-nota" style="padding:0;">${compacto ? '✔ a tiempo · ⏰ tardanza · ✖ falta (día laborable sin marcación) · · descanso. ' : 'Verde = a tiempo, ámbar = tardanza, ✖ = falta (día laborable sin marcación), · = descanso. '}Pasa el cursor para ver el detalle y haz clic en una celda para abrir ese día y corregirlo. Las horas son netas (sin almuerzo).</p>`,
    sort: { col: 'nombre', dir: 'asc' }, filas, vacio: 'No hay empleados para este periodo.',
    cols: [
      { key: 'empresa', label: 'Empresa', val: f => _empresasCfg.find(x => x.id === f.e.empresa_id)?.nombre_comercial || '', html: f => badgeEmpresa(f.e.empresa_id) },
      { key: 'nombre', label: 'Nombre', val: f => (f.c?.nombre || '').toLowerCase(), html: f => `<span class="rr-avatar">${_esc(_iniciales(f.c?.nombre))}</span><strong>${_esc(f.c?.nombre || '—')}</strong>${f.e.vinculo === 'rh_prestador' ? ' <span class="badge badge-info">RH</span>' : ''}${f.e.estado !== 'activo' ? ' <span class="badge badge-danger">cesado</span>' : ''}` },
      ...colsDias,
      { key: 'tot_dias', label: 'Días', der: true, val: f => totales(f).pres, html: f => totales(f).pres },
      { key: 'tot_horas', label: 'Horas netas', der: true, val: f => totales(f).min, html: f => totales(f).min ? _fmtDur(totales(f).min) : GUION },
      { key: 'tot_tard', label: 'Tardanzas', der: true, val: f => totales(f).tard, html: f => totales(f).tard ? `<span class="badge badge-warning">${totales(f).tard}</span>` : '0' },
      { key: 'tot_falt', label: 'Faltas', der: true, val: f => totales(f).falt, html: f => totales(f).falt ? `<span class="badge badge-danger">${totales(f).falt}</span>` : '0' }
    ],
    acciones: f => [
      { icono: '📅', label: 'Ver hoy', onclick: `window.asisIrDia('${_asisHoy}')` },
      { icono: '👤', label: 'Editar ficha', onclick: `window.irATabRRHH('empleados'); setTimeout(() => window.abrirModalEmpleado(${f.e.id}), 300)` }
    ]
  })
}

window.addEventListener('asistencia:marcada', () => {
  if (document.getElementById('tab-asistencia')?.classList.contains('active')) window.cargarAsistencia()
})

// ── Editar / registrar marcación (solo admin; motivo obligatorio) ───────────
window.asisEditar = function (empleadoId) {
  window.cerrarMenuAcciones?.()
  const f = _asisFilas.find(x => x.e.id === empleadoId); if (!f) return
  const fecha = _asisFecha || _asisHoy
  $('asisEmpId').value = empleadoId
  $('asisFechaVal').value = fecha
  $('asisTitulo').textContent = f.a ? 'Editar marcación' : 'Registrar marcación'
  $('asisQuien').innerHTML = `<strong>${_esc(f.c?.nombre || '—')}</strong> · ${fechaDMY(fecha)} · horario ${_horDia(f.e, fecha) ? _horDia(f.e, fecha).e + '–' + _horDia(f.e, fecha).s : 'descanso'}`
  $('asisEntrada').value = f.a?.entrada ? _hhmm(f.a.entrada) : (_horDia(f.e, fecha)?.e || f.e.hora_entrada.slice(0, 5))
  $('asisSalida').value = f.a?.salida ? _hhmm(f.a.salida) : ''
  const _alS = (f.marcas || []).find(m => m.tipo === 'almuerzo_salida'), _alR = (f.marcas || []).find(m => m.tipo === 'almuerzo_regreso')
  $('asisAlmSalida').value = _alS ? _hhmm(_alS.hora) : ''
  $('asisAlmRegreso').value = _alR ? _hhmm(_alR.hora) : ''
  $('asisAlmSalida').dataset.orig = $('asisAlmSalida').value; $('asisAlmRegreso').dataset.orig = $('asisAlmRegreso').value
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
  ;['asisEntrada', 'asisMotivo', 'asisSalida', 'asisAlmSalida', 'asisAlmRegreso'].forEach(i => $(i).classList.remove('invalido'))
  if (faltan.length) { faltan.forEach(i => $(i).classList.add('invalido')); showToast('Completa la hora de ingreso y el motivo', 'warning'); return }
  if (sal && sal < ent) { $('asisSalida').classList.add('invalido'); showToast('La salida no puede ser anterior al ingreso', 'warning'); return }
  const alS = $('asisAlmSalida').value, alR = $('asisAlmRegreso').value
  const alCambio = alS !== ($('asisAlmSalida').dataset.orig || '') || alR !== ($('asisAlmRegreso').dataset.orig || '')
  if (alR && !alS) { $('asisAlmSalida').classList.add('invalido'); showToast('Falta la hora de salida a almuerzo', 'warning'); return }
  if (alS && alS < ent) { $('asisAlmSalida').classList.add('invalido'); showToast('El almuerzo no puede empezar antes del ingreso', 'warning'); return }
  if (alS && alR && alR <= alS) { $('asisAlmRegreso').classList.add('invalido'); showToast('El regreso debe ser posterior a la salida a almuerzo', 'warning'); return }
  const btn = $('asisBtnGuardar'); btn.disabled = true
  const { error } = await supabase.rpc('rrhh_asistencia_editar', { p_empleado_id: Number($('asisEmpId').value), p_fecha: $('asisFechaVal').value, p_entrada: ent, p_salida: sal || null, p_motivo: motivo })
  if (error) { btn.disabled = false; showToast(/does not exist|schema cache/.test(error.message) ? 'Falta ejecutar el SQL 137_rrhh_asistencia_edicion.sql' : error.message, 'danger'); return }
  if (alCambio) {
    const r2 = await supabase.rpc('rrhh_asistencia_almuerzo', { p_empleado_id: Number($('asisEmpId').value), p_fecha: $('asisFechaVal').value, p_salida: alS || null, p_regreso: alR || null, p_motivo: motivo })
    if (r2.error) { btn.disabled = false; window.cargarAsistencia(); showToast('Ingreso/salida guardados, pero el almuerzo no: ' + (/does not exist|schema cache/.test(r2.error.message) ? 'falta ejecutar el SQL 158' : r2.error.message), 'warning', 7000); return }
  }
  btn.disabled = false
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

window.rrhhMarcar = function (empleadoId) {
  window.cerrarMenuAcciones?.()
  const f = _asisFilas.find(x => x.e.id === empleadoId); if (!f) return
  abrirModalMarcar({ empleado_id: f.e.id, nombre: f.c?.nombre, tipo_documento: f.c?.tipo_documento, nro_documento: f.c?.nro_documento,
    entrada: f.a?.entrada, salida: f.a?.salida, marcas: f.marcas || [], hora_entrada: f.e.hora_entrada, hora_salida: f.e.hora_salida, horario_semanal: f.e.horario_semanal })
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
