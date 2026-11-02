// ============================================================================
// TESORERIA.JS — Caja chica, gastos, entregas a rendir y reposiciones
// ----------------------------------------------------------------------------
// Reemplaza el Excel "SISTEMA DE CONTROL DE CAJA CHICA" de la tesorera.
//
// LOS TRES EJES (ver claude/mapa_tesoreria_rrhh.md §4):
//   caja   → de dónde salió la plata      (bancos: efectivo, yape, banco)
//   ambito → para quién fue               (empresa + empresa_id | familiar + NULL)
//   destino→ cómo se trata                (operativo / costo de venta / viático / …)
//
// El ámbito NO es atributo de la caja: en el Excel real, la misma caja y el
// mismo día pagan "COMBUSTIBLE CRISTIAN - FACTURA" (empresa) y "VITAMINAS
// MARINA" (familiar). Por eso vive en cada movimiento.
//
// Requiere: SQL 123 (cimientos) y SQL 124 (gastos/entregas/reposiciones).
// ⚠ CONTABILIDAD FUERA DE ALCANCE — ver los bloques marcados "PENDIENTE contable".
// ============================================================================

import { supabase, insert, update, deleteRecord, ultimoErrorInsert, esperarContextoEmpresa } from './supabase-client.js'
import { getCurrentUser } from './auth-supabase.js'
import { getContacts } from './supabase-data.js'
import { subirAdjuntos, getAdjuntos, validarArchivoAdjunto } from './supabase-data.js'
import { showToast, formatNumber, fechaDMY } from './helpers.js'
import { initModuleNavDropdowns, menuAccionesFila } from './main.js'
import { renderConfiguracionTab } from './config-modulo.js'
import { crearReporte, descargarCSV } from './reportes.js'
import { empresasDisponibles, empresasActivas, empresaTrabajo, ambitoFamiliarActivo } from './empresa.js'
import { abrirVisor } from './shared/adj-preview.js'
import { montarLibroCaja } from './tesoreria/libro-caja.js?v=19'

const MODULO = 'tesoreria'

// ── Estado en memoria ───────────────────────────────────────────────────────
let _cajas = []
let _categorias = []
let _contactos = []
let _gastos = []
let _entregas = []
let _reposiciones = []
let _editGastoId = null
let _modoVistaGasto = false
let _adjuntosPendientes = []     // [{ file }] antes de guardar
let _repCalc = null

const MAX_ADJUNTOS = 5

const DESTINOS = {
  gasto_operativo:      'Gasto operativo',
  costo_venta:          'Costo de venta',
  viatico_reembolsable: 'Viático reembolsable',
  gasto_personal:       'Gasto de personal',
  no_deducible:         'No deducible'
}
const SUSTENTOS = {
  factura:            'Factura',
  boleta:             'Boleta',
  recibo_honorarios:  'Recibo por honorarios',
  vale:               'Vale',
  sin_documento:      'Sin documento'
}

// ── Utilidades ──────────────────────────────────────────────────────────────
function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function _g(id) { const el = document.getElementById(id); return el ? el.value.trim() : '' }
function _v(id, val) { const el = document.getElementById(id); if (el) el.value = val ?? '' }
function _chk(id) { const el = document.getElementById(id); return !!(el && el.checked) }
function _setChk(id, val) { const el = document.getElementById(id); if (el) el.checked = !!val }
function _show(id, mostrar) { const el = document.getElementById(id); if (el) el.style.display = mostrar ? '' : 'none' }
function _hoyISO() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' }) }
function _simbolo(m) { return m === 'USD' ? '$' : 'S/' }
function _money(v, m = 'PEN') { return `${_simbolo(m)} ${formatNumber(v || 0)}` }
function _cajaById(id) { return _cajas.find(c => c.id === Number(id)) || null }
function _catById(id) { return _categorias.find(c => c.id === Number(id)) || null }
function _contactoById(id) { return _contactos.find(c => c.id === Number(id)) || null }

/** Etiqueta del ámbito, lista para mostrar. */
function _etiquetaAmbito(fila) {
  if (fila.ambito === 'familiar') return 'FAMILIAR'
  const e = empresasDisponibles().find(x => x.id === Number(fila.empresa_id))
  return e?.codigo || e?.nombre_comercial || '—'
}

// ============================================================================
// CANDADO DE CORRELATIVO (mismo patrón que ventas/venta-nueva.js)
// ============================================================================
// Se redefine aquí porque venta-nueva.js no se carga en esta página.
if (!window.toggleCandado) {
  window.toggleCandado = function (idInput, idBoton, idAviso) {
    const input = document.getElementById(idInput)
    const boton = document.getElementById(idBoton)
    const aviso = document.getElementById(idAviso)
    if (!input || !boton) return
    const abierto = input.readOnly === false
    if (abierto) {
      input.readOnly = true
      boton.textContent = '🔒'
      if (aviso) aviso.style.display = 'none'
      if (input.dataset.valorAutomatico) input.value = input.dataset.valorAutomatico
    } else {
      input.dataset.valorAutomatico = input.value
      input.readOnly = false
      boton.textContent = '🔓'
      if (aviso) aviso.style.display = ''
      input.focus()
    }
  }
}
if (!window.irAPagina) {
  window.irAPagina = function (href, tab) {
    try { if (tab) sessionStorage.setItem('tab_destino', tab) } catch {}
    window.location.href = href
  }
}

// ============================================================================
// NAVEGACIÓN DE TABS
// ============================================================================
window.irATabTes = function (tab) {
  document.querySelectorAll('#tesoreriaTabs .tab-btn').forEach(b => b.classList.remove('active'))
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'))
  const btn = document.querySelector(`#tesoreriaTabs .tab-btn[data-tab="${tab}"]`)
  const cont = document.getElementById(`tab-${tab}`)
  if (btn) btn.classList.add('active')
  if (cont) cont.classList.add('active')
  _alEntrarTab(tab)
}

function _alEntrarTab(tab) {
  if (tab === 'libro')         montarLibroCaja()
  if (tab === 'gastos')        window.cargarGastos()
  if (tab === 'entregas')      window.cargarEntregas()
  if (tab === 'reposiciones')  window.cargarReposiciones()
  if (tab === 'cajas')         _pintarCajas()
  if (tab === 'configuracion') { _pintarCategorias(); renderConfiguracionTab(MODULO, 'tes-config-container') }
}

// ============================================================================
// CARGA DE CATÁLOGOS
// ============================================================================
async function _cargarCatalogos() {
  // El filtro multiempresa "falla cerrado": sin contexto devuelve vacío, no todo.
  // Hay que esperar el semáforo antes de la primera lectura o salen 0 cajas.
  await esperarContextoEmpresa()

  const [cajasRes, catsRes, contactos] = await Promise.all([
    supabase.from('bancos').select('*').neq('activo', false).order('nombre'),
    supabase.from('categorias_gasto').select('*').neq('activo', false).order('orden'),
    getContacts()
  ])

  if (cajasRes.error) { console.error('cajas:', cajasRes.error.message); showToast('No se pudieron cargar las cajas', 'error') }
  _cajas = cajasRes.data || []

  if (catsRes.error) {
    console.error('categorias_gasto:', catsRes.error.message)
    showToast('Falta correr assets/sql/123_tesoreria_cimientos.sql', 'error', 6000)
  }
  _categorias = catsRes.data || []
  _contactos = contactos || []

  _llenarSelectoresCatalogo()
}

function _llenarSelectoresCatalogo() {
  // Cajas: se muestran agrupadas por ámbito para no confundir la familiar
  const optCajas = _cajas.map(c =>
    `<option value="${c.id}">${_esc(c.nombre)} · ${_esc(c.moneda)}${c.ambito === 'familiar' ? ' · FAMILIAR' : ''}</option>`
  ).join('')

  for (const id of ['gasCaja', 'entCaja', 'repCaja', 'repOrigen']) {
    const el = document.getElementById(id)
    if (el) el.innerHTML = `<option value="">-- Seleccione --</option>${optCajas}`
  }
  for (const id of ['gasFiltroCaja', 'entFiltroCaja']) {
    const el = document.getElementById(id)
    if (el) el.innerHTML = `<option value="">-- Todas las cajas --</option>${optCajas}`
  }

  const optCats = _categorias.map(c => `<option value="${c.id}">${_esc(c.nombre)}</option>`).join('')
  const gc = document.getElementById('gasCategoria')
  if (gc) gc.innerHTML = `<option value="">-- Seleccione --</option>${optCats}`
  const fc = document.getElementById('gasFiltroCategoria')
  if (fc) fc.innerHTML = `<option value="">Todas las categorías</option>${optCats}`

  const optCont = _contactos.map(c => `<option value="${c.id}">${_esc(c.nombre)}</option>`).join('')
  const gr = document.getElementById('gasResponsable')
  if (gr) gr.innerHTML = `<option value="">-- Sin responsable --</option>${optCont}`
  const ec = document.getElementById('entContacto')
  if (ec) ec.innerHTML = `<option value="">-- Seleccione --</option>${optCont}`

  const optEmp = empresasDisponibles().map(e =>
    `<option value="${e.id}">${_esc(e.codigo || e.nombre_comercial)}</option>`).join('')
  const ge = document.getElementById('gasEmpresa')
  if (ge) ge.innerHTML = `<option value="">-- Seleccione --</option>${optEmp}`
}

// ============================================================================
// KPIs Y BANDEJAS DE INICIO
// ============================================================================
async function _cargarInicio() {
  const mes = _hoyISO().slice(0, 7)
  const desde = `${mes}-01`

  const [gastosMes, entregas, gastosRecientes] = await Promise.all([
    supabase.from('gastos').select('*').gte('fecha', desde).eq('anulado', false),
    supabase.from('entregas_a_rendir').select('*').in('estado', ['abierta', 'parcial']),
    supabase.from('gastos').select('*').eq('anulado', false).order('fecha', { ascending: false }).limit(8)
  ])

  // ── KPI: saldo en cajas
  const saldoPen = _cajas.filter(c => c.tipo_cuenta === 'caja' && c.moneda === 'PEN')
    .reduce((s, c) => s + Number(c.saldo_actual || 0), 0)
  const el1 = document.getElementById('kpi-tes-caja-pen')
  if (el1) el1.textContent = _money(saldoPen)
  const sub1 = document.getElementById('kpi-tes-caja-pen-sub')
  if (sub1) sub1.textContent = `${_cajas.filter(c => c.tipo_cuenta === 'caja').length} cajas`

  // ── KPI: gastos del mes
  const gm = (gastosMes.data || [])
  const totalMes = gm.reduce((s, g) => s + Number(g.monto || 0), 0)
  const el2 = document.getElementById('kpi-tes-gastos-mes')
  if (el2) el2.textContent = _money(totalMes)
  const sub2 = document.getElementById('kpi-tes-gastos-mes-sub')
  if (sub2) sub2.textContent = `${gm.length} gastos`

  // ── KPI: sin rendir
  const ents = (entregas.data || [])
  const sinRendir = ents.reduce((s, e) =>
    s + (Number(e.monto_entregado || 0) - Number(e.monto_rendido || 0) - Number(e.monto_devuelto || 0)), 0)
  const el3 = document.getElementById('kpi-tes-sin-rendir')
  if (el3) el3.textContent = _money(sinRendir)
  const sub3 = document.getElementById('kpi-tes-sin-rendir-sub')
  if (sub3) sub3.textContent = `${ents.length} entrega(s) abierta(s)`

  // ── KPI: sin comprobante (lo que se pierde de deducción)
  const sinDoc = gm.filter(g => g.tipo_sustento === 'sin_documento')
    .reduce((s, g) => s + Number(g.monto || 0), 0)
  const el4 = document.getElementById('kpi-tes-sin-doc')
  if (el4) el4.textContent = _money(sinDoc)

  _pintarBandejaEntregas(ents)
  _pintarBandejaFacturas()
  _pintarBandejaCajas()
  _pintarBandejaUltimos(gastosRecientes.data || [])
}

function _vacio(msg) {
  return `<p class="reporte-vacio" style="padding:14px 16px; color:var(--text-secondary);">${_esc(msg)}</p>`
}

function _pintarBandejaEntregas(ents) {
  const cont = document.getElementById('tes-bandeja-entregas')
  if (!cont) return
  if (!ents.length) { cont.innerHTML = _vacio('Nada pendiente. Todo el efectivo entregado está rendido. ✔'); return }

  cont.innerHTML = `<div class="table-container"><table><thead><tr>
      <th>Persona</th><th>Entregado</th><th>Pendiente</th><th>Días</th><th></th>
    </tr></thead><tbody>${
    ents.sort((a, b) => a.fecha_entrega.localeCompare(b.fecha_entrega)).map(e => {
      const pend = Number(e.monto_entregado || 0) - Number(e.monto_rendido || 0) - Number(e.monto_devuelto || 0)
      const dias = Math.round((Date.now() - new Date(e.fecha_entrega + 'T12:00:00').getTime()) / 86400000)
      const alerta = dias >= 3 ? ' style="color:var(--color-warning); font-weight:600;"' : ''
      return `<tr>
        <td>${_esc(_contactoById(e.contact_id)?.nombre || '—')}</td>
        <td>${_money(e.monto_entregado, e.moneda)}</td>
        <td style="font-weight:600;">${_money(pend, e.moneda)}</td>
        <td${alerta}>${dias}</td>
        <td><button class="btn btn-secondary btn-small" onclick="window.abrirModalRendir(${e.id})">Rendir</button></td>
      </tr>`
    }).join('')}</tbody></table></div>`
}

async function _pintarBandejaFacturas() {
  const cont = document.getElementById('tes-bandeja-facturas')
  if (!cont) return
  const { data, error } = await supabase.from('gastos').select('*')
    .eq('estado_sustento', 'pendiente').eq('anulado', false).order('fecha')
  if (error) { cont.innerHTML = _vacio('No se pudo consultar.'); return }
  if (!data?.length) { cont.innerHTML = _vacio('No hay gastos esperando su comprobante. ✔'); return }

  cont.innerHTML = `<div class="table-container"><table><thead><tr>
      <th>Recibo</th><th>Fecha</th><th>Detalle</th><th>Monto</th><th></th>
    </tr></thead><tbody>${data.map(g => `<tr>
      <td>${_esc(g.numero_recibo)}</td>
      <td>${fechaDMY(g.fecha)}</td>
      <td>${_esc(g.detalle)}</td>
      <td>${_money(g.monto, g.moneda)}</td>
      <td><button class="btn btn-secondary btn-small" onclick="window.abrirModalGasto(${g.id})">Cargar factura</button></td>
    </tr>`).join('')}</tbody></table></div>`
}

function _pintarBandejaCajas() {
  const cont = document.getElementById('tes-bandeja-cajas')
  if (!cont) return
  const cajas = _cajas.filter(c => c.tipo_cuenta === 'caja')
  if (!cajas.length) { cont.innerHTML = _vacio('No hay cajas registradas.'); return }

  cont.innerHTML = `<div class="table-container"><table><thead><tr>
      <th>Caja</th><th>Ámbito</th><th>Saldo</th><th>Fondo fijo</th><th>Estado</th>
    </tr></thead><tbody>${cajas.map(c => {
      const saldo = Number(c.saldo_actual || 0)
      const minimo = Number(c.saldo_minimo || 0)
      const fondo = Number(c.monto_fondo_fijo || 0)
      let estado = '<span style="color:var(--color-success);">OK</span>'
      if (saldo < 0) estado = '<span style="color:var(--color-danger); font-weight:600;">NEGATIVO</span>'
      else if (c.es_fondo_fijo && minimo > 0 && saldo <= minimo) estado = '<span style="color:var(--color-warning); font-weight:600;">Reponer</span>'
      else if (!c.es_fondo_fijo) estado = '<span style="color:var(--text-secondary);">Sin fondo fijo</span>'
      return `<tr>
        <td>${_esc(c.nombre)}</td>
        <td>${_etiquetaAmbito(c)}</td>
        <td style="font-weight:600;">${_money(saldo, c.moneda)}</td>
        <td>${c.es_fondo_fijo ? _money(fondo, c.moneda) : '—'}</td>
        <td>${estado}</td>
      </tr>`
    }).join('')}</tbody></table></div>`
}

function _pintarBandejaUltimos(gastos) {
  const cont = document.getElementById('tes-bandeja-ultimos')
  if (!cont) return
  if (!gastos.length) { cont.innerHTML = _vacio('Todavía no hay gastos registrados.'); return }
  cont.innerHTML = `<div class="table-container"><table><thead><tr>
      <th>Recibo</th><th>Fecha</th><th>Categoría</th><th>Detalle</th><th>Monto</th>
    </tr></thead><tbody>${gastos.map(g => `<tr>
      <td>${_esc(g.numero_recibo)}</td>
      <td>${fechaDMY(g.fecha)}</td>
      <td>${_esc(_catById(g.categoria_gasto_id)?.nombre || '—')}</td>
      <td>${_esc(g.detalle)}</td>
      <td>${_money(g.monto, g.moneda)}</td>
    </tr>`).join('')}</tbody></table></div>`
}

// ============================================================================
// TAB GASTOS — tabla operativa
// ============================================================================
const GAS_COLS = [
  { k: 'recibo',      t: 'N° Recibo' },
  { k: 'fecha',       t: 'Fecha' },
  { k: 'caja',        t: 'Caja' },
  { k: 'ambito',      t: 'Ámbito' },
  { k: 'categoria',   t: 'Categoría' },
  { k: 'responsable', t: 'Responsable' },
  { k: 'detalle',     t: 'Detalle' },
  { k: 'destino',     t: 'Destino' },
  { k: 'sustento',    t: 'Sustento' },
  { k: 'monto',       t: 'Monto' }
]
const LS_GAS_COLS = 'tesoreriaGastosColumnasVisibles'

function _gasColsVisibles() {
  try {
    const g = JSON.parse(localStorage.getItem(LS_GAS_COLS) || 'null')
    if (Array.isArray(g)) return new Set(g)
  } catch {}
  return new Set(GAS_COLS.map(c => c.k))
}

window.toggleMenuColumnasGastos = function (ev) {
  if (ev) ev.stopPropagation()
  const menu = document.getElementById('gastosColMenu')
  if (!menu) return
  const abierto = menu.classList.contains('open')
  document.querySelectorAll('.col-menu.open').forEach(m => m.classList.remove('open'))
  if (!abierto) { _pintarMenuColumnasGastos(); menu.classList.add('open') }
}

function _pintarMenuColumnasGastos() {
  const dd = document.getElementById('gastosColMenuDropdown')
  if (!dd) return
  const vis = _gasColsVisibles()
  dd.innerHTML = GAS_COLS.map(c => `
    <label><input type="checkbox" ${vis.has(c.k) ? 'checked' : ''}
      onchange="window._toggleColumnaGasto('${c.k}', this.checked)"> ${_esc(c.t)}</label>`).join('')
}

window._toggleColumnaGasto = function (clave, visible) {
  const vis = _gasColsVisibles()
  visible ? vis.add(clave) : vis.delete(clave)
  try { localStorage.setItem(LS_GAS_COLS, JSON.stringify([...vis])) } catch {}
  window.cargarGastos()
}

window.limpiarBusquedaGastos = function () { _v('gasBuscar', ''); window.cargarGastos() }

window.cargarGastos = async function () {
  const cont = document.getElementById('gastos-tabla-cont')
  if (!cont) return

  let q = supabase.from('gastos').select('*').eq('anulado', false).order('fecha', { ascending: false }).order('id', { ascending: false })

  const caja = _g('gasFiltroCaja')
  if (caja) q = q.eq('caja_id', Number(caja))
  const ambito = _g('gasFiltroAmbito')
  if (ambito) q = q.eq('ambito', ambito)
  const cat = _g('gasFiltroCategoria')
  if (cat) q = q.eq('categoria_gasto_id', Number(cat))
  const mes = _g('gasFiltroMes')
  if (mes) {
    const ini = `${mes}-01`
    const fin = new Date(new Date(ini + 'T12:00:00').getFullYear(), new Date(ini + 'T12:00:00').getMonth() + 1, 0)
      .toLocaleDateString('en-CA')
    q = q.gte('fecha', ini).lte('fecha', fin)
  }
  const sus = _g('gasFiltroSustento')
  if (sus === 'pendiente') q = q.eq('estado_sustento', 'pendiente')
  else if (sus === 'sin_documento') q = q.eq('tipo_sustento', 'sin_documento')
  else if (sus === 'con_doc') q = q.neq('tipo_sustento', 'sin_documento')

  const { data, error } = await q
  if (error) {
    cont.innerHTML = _vacio(/relation .* does not exist/i.test(error.message)
      ? 'Falta correr assets/sql/124_tesoreria_gastos.sql'
      : `No se pudieron cargar los gastos: ${error.message}`)
    return
  }
  _gastos = data || []

  // Búsqueda libre: AND de palabras sobre todas las columnas visibles
  const texto = _g('gasBuscar').toLowerCase()
  let filas = _gastos
  if (texto) {
    const palabras = texto.split(/\s+/).filter(Boolean)
    filas = filas.filter(g => {
      const blob = [
        g.numero_recibo, fechaDMY(g.fecha), _cajaById(g.caja_id)?.nombre, _etiquetaAmbito(g),
        _catById(g.categoria_gasto_id)?.nombre, _contactoById(g.responsable_contact_id)?.nombre,
        g.detalle, DESTINOS[g.destino_costo], SUSTENTOS[g.tipo_sustento], g.monto
      ].join(' ').toLowerCase()
      return palabras.every(p => blob.includes(p))
    })
  }

  if (!filas.length) { cont.innerHTML = _vacio('No hay gastos con esos filtros.'); return }

  const vis = _gasColsVisibles()
  const th = GAS_COLS.filter(c => vis.has(c.k)).map(c => `<th data-col="${c.k}">${_esc(c.t)}</th>`).join('')
  const total = filas.reduce((s, g) => s + Number(g.monto || 0), 0)

  cont.innerHTML = `<table><thead><tr>${th}<th>Acciones</th></tr></thead><tbody>${
    filas.map(g => {
      const celdas = {
        recibo:      _esc(g.numero_recibo),
        fecha:       fechaDMY(g.fecha),
        caja:        _esc(_cajaById(g.caja_id)?.nombre || '—'),
        ambito:      `<span class="badge">${_etiquetaAmbito(g)}</span>`,
        categoria:   _esc(_catById(g.categoria_gasto_id)?.nombre || '—'),
        responsable: _esc(_contactoById(g.responsable_contact_id)?.nombre || '—'),
        detalle:     _esc(g.detalle),
        destino:     _esc(DESTINOS[g.destino_costo] || g.destino_costo),
        sustento:    _celdaSustento(g),
        monto:       `<strong>${_money(g.monto, g.moneda)}</strong>`
      }
      const tds = GAS_COLS.filter(c => vis.has(c.k)).map(c => `<td data-col="${c.k}">${celdas[c.k]}</td>`).join('')
      return `<tr>${tds}<td>${menuAccionesFila([
        { icono: '👁', label: 'Ver detalle', onclick: `window.abrirModalGasto(${g.id})` },
        { icono: '✏️', label: 'Editar',      onclick: `window.abrirModalGasto(${g.id}, true)` },
        { icono: '✕',  label: 'Eliminar',    onclick: `window.eliminarGasto(${g.id})`, peligro: true }
      ])}</td></tr>`
    }).join('')}</tbody>
    <tfoot><tr style="background:var(--bg-secondary); font-weight:700;">
      <td colspan="${GAS_COLS.filter(c => vis.has(c.k)).length}">${filas.length} gasto(s)</td>
      <td>${_money(total)}</td>
    </tr></tfoot></table>`
}

function _celdaSustento(g) {
  if (g.estado_sustento === 'pendiente')
    return `<span class="badge" style="background:var(--color-warning); color:#fff;">Falta factura</span>`
  if (g.tipo_sustento === 'sin_documento')
    return `<span class="badge" style="background:var(--color-danger); color:#fff;">Sin doc.</span>`
  return `<span class="badge" style="background:var(--color-success); color:#fff;">${_esc(SUSTENTOS[g.tipo_sustento])}</span>`
}

window.exportarGastosCSV = function () {
  const vis = _gasColsVisibles()
  const cols = GAS_COLS.filter(c => vis.has(c.k))
  const filas = _gastos.map(g => {
    const o = {}
    for (const c of cols) {
      o[c.t] = {
        recibo: g.numero_recibo, fecha: fechaDMY(g.fecha),
        caja: _cajaById(g.caja_id)?.nombre, ambito: _etiquetaAmbito(g),
        categoria: _catById(g.categoria_gasto_id)?.nombre,
        responsable: _contactoById(g.responsable_contact_id)?.nombre,
        detalle: g.detalle, destino: DESTINOS[g.destino_costo],
        sustento: SUSTENTOS[g.tipo_sustento], monto: g.monto
      }[c.k] ?? ''
    }
    return o
  })
  descargarCSV(filas, `gastos_${_hoyISO()}.csv`)
}

// ============================================================================
// MODAL DE GASTO
// ============================================================================
window.abrirModalGasto = async function (id = null, editar = false) {
  if (!_cajas.length) await _cargarCatalogos()

  _editGastoId = id ? Number(id) : null
  _modoVistaGasto = !!id && !editar
  _adjuntosPendientes = []

  document.getElementById('gasModalTitulo').textContent = id ? `Gasto ${id}` : 'Nuevo Gasto'
  _show('gasAvisoLectura', _modoVistaGasto)
  _show('gasBtnEditar', _modoVistaGasto)
  _show('gasBtnGuardar', !_modoVistaGasto)

  if (id) {
    const { data, error } = await supabase.from('gastos').select('*').eq('id', id).maybeSingle()
    if (error || !data) { showToast('No se encontró el gasto', 'error'); return }
    _pintarGastoEnModal(data)
    await _pintarAdjuntos(id)
  } else {
    _limpiarModalGasto()
    await _pintarAdjuntos(null)
  }

  await _cargarEntregasDelSelect()
  _aplicarModoVistaGasto()
  _actualizarResumenGasto()
  window.openModal('modal-gasto')
}

function _limpiarModalGasto() {
  _v('gasCaja', ''); _v('gasNumeroRecibo', ''); _v('gasFecha', _hoyISO())
  _v('gasMoneda', 'PEN'); _v('gasMonto', ''); _v('gasDetalle', ''); _v('gasObservaciones', '')
  _v('gasAmbito', ambitoFamiliarActivo() && !empresasActivas().length ? 'familiar' : 'empresa')
  _v('gasEmpresa', empresaTrabajo() || '')
  _v('gasCategoria', ''); _v('gasResponsable', '')
  _v('gasDestino', 'gasto_operativo'); _v('gasSustento', 'sin_documento')
  _setChk('gasDeducible', false); _setChk('gasFacturaPendiente', false)
  _v('gasGuiaDespacho', ''); _v('gasEntrega', '')
  const inp = document.getElementById('gasNumeroRecibo')
  if (inp) { inp.readOnly = true; delete inp.dataset.valorAutomatico }
  const btn = document.getElementById('gasNumeroReciboBtn')
  if (btn) btn.textContent = '🔒'
  _show('gasNumeroReciboAviso', false)
  window.onCambiarAmbitoGasto()
  window.onCambiarDestinoGasto()
  window.onCambiarSustentoGasto()
}

function _pintarGastoEnModal(g) {
  _v('gasCaja', g.caja_id); _v('gasNumeroRecibo', g.numero_recibo); _v('gasFecha', g.fecha)
  _v('gasMoneda', g.moneda); _v('gasMonto', g.monto); _v('gasDetalle', g.detalle)
  _v('gasObservaciones', g.observaciones || '')
  _v('gasAmbito', g.ambito); _v('gasEmpresa', g.empresa_id || '')
  _v('gasCategoria', g.categoria_gasto_id); _v('gasResponsable', g.responsable_contact_id || '')
  _v('gasDestino', g.destino_costo); _v('gasSustento', g.tipo_sustento)
  _setChk('gasDeducible', g.deducible)
  _setChk('gasFacturaPendiente', g.estado_sustento === 'pendiente')
  _v('gasEntrega', g.entrega_id || '')
  window.onCambiarAmbitoGasto()
  window.onCambiarDestinoGasto()
  window.onCambiarSustentoGasto()
}

function _aplicarModoVistaGasto() {
  const ids = ['gasCaja','gasNumeroRecibo','gasFecha','gasMoneda','gasMonto','gasAmbito','gasEmpresa',
               'gasCategoria','gasResponsable','gasDetalle','gasDestino','gasSustento','gasDeducible',
               'gasGuiaDespacho','gasEntrega','gasObservaciones','gasFacturaPendiente']
  for (const id of ids) {
    const el = document.getElementById(id)
    if (el) el.disabled = _modoVistaGasto
  }
  const btnCandado = document.getElementById('gasNumeroReciboBtn')
  if (btnCandado) btnCandado.disabled = _modoVistaGasto
}

window.habilitarEdicionGasto = function () {
  _modoVistaGasto = false
  _show('gasAvisoLectura', false)
  _show('gasBtnEditar', false)
  _show('gasBtnGuardar', true)
  _aplicarModoVistaGasto()
}

window.onCambiarCajaGasto = async function () {
  const caja = _cajaById(_g('gasCaja'))
  const hint = document.getElementById('gasCajaHint')
  if (!caja) { if (hint) hint.textContent = ''; _actualizarResumenGasto(); return }

  if (hint) hint.textContent = `Saldo: ${_money(caja.saldo_actual, caja.moneda)}`

  // La moneda y el ámbito siguen a la caja (se pueden cambiar a mano después)
  _v('gasMoneda', caja.moneda)
  if (!_editGastoId) {
    _v('gasAmbito', caja.ambito)
    _v('gasEmpresa', caja.empresa_id || '')
    window.onCambiarAmbitoGasto()
  }

  // Correlativo sugerido de esta caja
  if (!_editGastoId) {
    const { data, error } = await supabase.rpc('siguiente_numero_recibo', { p_caja_id: caja.id })
    if (!error && data) {
      const inp = document.getElementById('gasNumeroRecibo')
      if (inp && inp.readOnly) { inp.value = data; inp.dataset.valorAutomatico = data }
    }
  }
  _actualizarResumenGasto()
}

window.onCambiarAmbitoGasto = function () {
  const familiar = _g('gasAmbito') === 'familiar'
  _show('gasGrupoEmpresa', !familiar)
  if (familiar) _v('gasEmpresa', '')
  else if (!_g('gasEmpresa')) _v('gasEmpresa', empresaTrabajo() || '')
  _actualizarResumenGasto()
}

window.onCambiarCategoriaGasto = function () {
  const cat = _catById(_g('gasCategoria'))
  if (!cat) return
  // La categoría PRECARGA, no impone: el usuario puede cambiarlo.
  if (cat.destino_sugerido) _v('gasDestino', cat.destino_sugerido)
  if (cat.ambito_sugerido && !_editGastoId) { _v('gasAmbito', cat.ambito_sugerido); window.onCambiarAmbitoGasto() }
  _setChk('gasDeducible', !!cat.deducible_defecto && _g('gasSustento') !== 'sin_documento')
  window.onCambiarDestinoGasto()
  window.onCambiarSustentoGasto()
}

window.onCambiarDestinoGasto = async function () {
  const esCostoVenta = _g('gasDestino') === 'costo_venta'
  _show('gasGrupoGuia', esCostoVenta)
  if (esCostoVenta) await _cargarGuiasDespacho()
  _actualizarResumenGasto()
}

window.onCambiarSustentoGasto = function () {
  const sinDoc = _g('gasSustento') === 'sin_documento'
  // Candado de la BD: un gasto sin documento NO puede ser deducible (LIR 44-j).
  const chk = document.getElementById('gasDeducible')
  const hint = document.getElementById('gasDeducibleHint')
  if (sinDoc) {
    _setChk('gasDeducible', false)
    if (chk) chk.disabled = true
    if (hint) hint.textContent = 'Sin comprobante no hay deducción (LIR 44-j).'
  } else {
    if (chk && !_modoVistaGasto) chk.disabled = false
    if (hint) hint.textContent = ''
  }
  _show('gasAvisoFactura', !sinDoc)
  if (sinDoc) _setChk('gasFacturaPendiente', false)
  _actualizarResumenGasto()
}

window.onCambiarMonedaGasto = function () { _actualizarResumenGasto() }

function _actualizarResumenGasto() {
  const caja = _cajaById(_g('gasCaja'))
  const t = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v }
  t('gasResumenCaja', caja ? caja.nombre : '—')
  t('gasResumenAmbito', _g('gasAmbito') === 'familiar'
    ? 'FAMILIAR'
    : (empresasDisponibles().find(e => e.id === Number(_g('gasEmpresa')))?.codigo || '—'))
  const ded = _chk('gasDeducible') ? 'deducible' : 'no deducible'
  t('gasResumenTrato', `${DESTINOS[_g('gasDestino')] || '—'} · ${ded}`)
  t('gasResumenMonto', _money(Number(_g('gasMonto') || 0), _g('gasMoneda')))
}

async function _cargarGuiasDespacho() {
  const sel = document.getElementById('gasGuiaDespacho')
  if (!sel || sel.dataset.cargado === '1') return
  const { data, error } = await supabase.from('guias_despacho_venta').select('*')
    .order('fecha', { ascending: false }).limit(200)
  if (error) { console.warn('guias_despacho_venta:', error.message); return }
  sel.innerHTML = `<option value="">-- Sin asignar --</option>` + (data || []).map(gu =>
    `<option value="${gu.id}">${_esc(gu.numero_guia || gu.id)} · ${fechaDMY(gu.fecha)}</option>`).join('')
  sel.dataset.cargado = '1'
}

async function _cargarEntregasDelSelect() {
  const sel = document.getElementById('gasEntrega')
  if (!sel) return
  const { data } = await supabase.from('entregas_a_rendir').select('*').in('estado', ['abierta', 'parcial'])
  sel.innerHTML = `<option value="">-- No aplica --</option>` + (data || []).map(e => {
    const pend = Number(e.monto_entregado || 0) - Number(e.monto_rendido || 0) - Number(e.monto_devuelto || 0)
    return `<option value="${e.id}">${_esc(_contactoById(e.contact_id)?.nombre || '—')} · pendiente ${_money(pend, e.moneda)}</option>`
  }).join('')
}

// ── Adjuntos ────────────────────────────────────────────────────────────────
async function _pintarAdjuntos(gastoId) {
  const cont = document.getElementById('gasAdjuntosCont')
  if (!cont) return
  const guardados = gastoId ? await getAdjuntos('gasto', gastoId) : []

  cont.innerHTML = `
    <div id="gasAdjLista" style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:8px;"></div>
    ${_modoVistaGasto ? '' : `
      <input type="file" id="gasAdjInput" multiple accept=".pdf,image/*" style="display:none"
             onchange="window._agregarAdjuntosGasto(this)">
      <button type="button" class="btn btn-secondary btn-small" id="gasAdjBtn"
              onclick="document.getElementById('gasAdjInput').click()">📎 Agregar archivo</button>
      <small id="gasAdjContador" style="margin-left:10px; color:var(--text-secondary);"></small>`}`

  _renderListaAdjuntos(guardados)
}

function _renderListaAdjuntos(guardados = []) {
  const lista = document.getElementById('gasAdjLista')
  if (!lista) return
  const chips = []
  for (const a of guardados) {
    chips.push(`<span class="badge" style="display:inline-flex; gap:6px; align-items:center;">
      <a href="#" onclick="window._verAdjuntoGasto('${_esc(a.path)}','${_esc(a.mime || '')}','${_esc(a.nombre)}'); return false;">${_esc(a.nombre)}</a>
      ${_modoVistaGasto ? '' : `<button type="button" onclick="window._quitarAdjuntoGuardado(${a.id})"
        style="background:none; border:none; cursor:pointer; color:var(--color-danger);">✕</button>`}
    </span>`)
  }
  _adjuntosPendientes.forEach((a, i) => {
    chips.push(`<span class="badge" style="display:inline-flex; gap:6px; align-items:center; opacity:.75;">
      ${_esc(a.file.name)} <em style="font-size:.72rem;">(por subir)</em>
      <button type="button" onclick="window._quitarAdjuntoPendiente(${i})"
        style="background:none; border:none; cursor:pointer; color:var(--color-danger);">✕</button>
    </span>`)
  })
  lista.innerHTML = chips.join('') || `<small style="color:var(--text-secondary);">Sin adjuntos.</small>`

  const cont = document.getElementById('gasAdjContador')
  const total = guardados.length + _adjuntosPendientes.length
  if (cont) cont.textContent = `${total} / ${MAX_ADJUNTOS}`
  const btn = document.getElementById('gasAdjBtn')
  if (btn) btn.disabled = total >= MAX_ADJUNTOS
  lista.dataset.guardados = JSON.stringify(guardados.map(a => a.id))
  window._adjGuardados = guardados
}

window._agregarAdjuntosGasto = function (input) {
  const yaHay = (window._adjGuardados || []).length + _adjuntosPendientes.length
  const libres = MAX_ADJUNTOS - yaHay
  if (libres <= 0) { showToast(`Máximo ${MAX_ADJUNTOS} archivos por gasto`, 'warning'); input.value = ''; return }

  for (const file of [...input.files].slice(0, libres)) {
    const err = validarArchivoAdjunto(file)
    if (err) { showToast(err, 'error'); continue }
    _adjuntosPendientes.push({ file })
  }
  if (input.files.length > libres) showToast(`Solo caben ${libres} archivo(s) más`, 'warning')
  input.value = ''
  _renderListaAdjuntos(window._adjGuardados || [])
}

window._quitarAdjuntoPendiente = function (i) {
  _adjuntosPendientes.splice(i, 1)
  _renderListaAdjuntos(window._adjGuardados || [])
}

window._quitarAdjuntoGuardado = async function (id) {
  if (!confirm('¿Quitar este adjunto?')) return
  const ok = await deleteRecord('adjuntos', id)
  if (!ok) { showToast('No se pudo quitar el adjunto', 'error'); return }
  showToast('Adjunto quitado', 'success')
  await _pintarAdjuntos(_editGastoId)
}

window._verAdjuntoGasto = async function (path, mime, nombre) {
  const { data, error } = await supabase.storage.from('tesoreria-adjuntos').createSignedUrl(path, 120)
  if (error || !data?.signedUrl) { showToast('No se pudo abrir el archivo', 'error'); return }
  abrirVisor(data.signedUrl, mime, nombre)
}

// ── Guardar gasto ───────────────────────────────────────────────────────────
window.guardarGasto = async function () {
  const cajaId = Number(_g('gasCaja'))
  const ambito = _g('gasAmbito')
  const empresaId = ambito === 'familiar' ? null : Number(_g('gasEmpresa')) || null
  const monto = Number(_g('gasMonto'))
  const sustento = _g('gasSustento')

  // ── Validaciones
  if (!cajaId)            return showToast('Elige la caja', 'warning')
  if (!_g('gasNumeroRecibo')) return showToast('Falta el N° de recibo', 'warning')
  if (!_g('gasFecha'))    return showToast('Falta la fecha', 'warning')
  if (!(monto > 0))       return showToast('El monto debe ser mayor a 0', 'warning')
  if (!_g('gasCategoria'))return showToast('Elige la categoría', 'warning')
  if (!_g('gasDetalle'))  return showToast('Escribe el detalle', 'warning')
  if (ambito === 'empresa' && !empresaId) return showToast('Elige la empresa', 'warning')

  const caja = _cajaById(cajaId)
  if (caja && caja.ambito !== ambito) {
    const ok = confirm(
      `Ojo: la caja "${caja.nombre}" es de ámbito ${caja.ambito.toUpperCase()} y este gasto es ${ambito.toUpperCase()}.\n\n` +
      `Es válido (la plata sale de donde hay), pero el gasto se reportará en el ámbito ${ambito.toUpperCase()}.\n\n¿Continuar?`)
    if (!ok) return
  }

  const deducible = _chk('gasDeducible') && sustento !== 'sin_documento'
  const entregaId = Number(_g('gasEntrega')) || null

  const payload = {
    numero_recibo: _g('gasNumeroRecibo'),
    fecha: _g('gasFecha'),
    caja_id: cajaId,
    ambito,
    empresa_id: empresaId,
    sede_id: caja?.sede_id || null,
    destino_costo: _g('gasDestino'),
    categoria_gasto_id: Number(_g('gasCategoria')),
    responsable_contact_id: Number(_g('gasResponsable')) || null,
    detalle: _g('gasDetalle'),
    moneda: _g('gasMoneda'),
    monto,
    tipo_sustento: sustento,
    estado_sustento: (sustento !== 'sin_documento' && _chk('gasFacturaPendiente')) ? 'pendiente' : null,
    deducible,
    guia_despacho_id: _g('gasDestino') === 'costo_venta' ? (Number(_g('gasGuiaDespacho')) || null) : null,
    entrega_id: entregaId,
    observaciones: _g('gasObservaciones') || null
  }

  let gastoId = _editGastoId

  if (_editGastoId) {
    const ok = await update('gastos', _editGastoId, payload)
    if (!ok) { showToast(`No se pudo guardar: ${ultimoErrorInsert()?.message || 'error'}`, 'error'); return }
  } else {
    const user = getCurrentUser()
    payload.created_by = user?.db_id || user?.id || null

    const fila = await insert('gastos', payload)
    // insert() devuelve null en error SIN lanzar excepción → hay que chequearlo
    // antes de seguir con efectos secundarios (movimiento de caja, adjuntos).
    if (!fila) {
      const e = ultimoErrorInsert()
      showToast(/ux_gastos_recibo_caja/.test(e?.message || '')
        ? 'Ese N° de recibo ya existe en esta caja'
        : `No se pudo registrar el gasto: ${e?.message || 'error'}`, 'error', 6000)
      return
    }
    gastoId = fila.id

    // ── Movimiento de caja
    // Si el gasto se descuenta de una entrega a rendir, el dinero YA salió de
    // la caja cuando se hizo la entrega: generar otro egreso lo contaría dos
    // veces. Es justo el neteo que distorsiona el saldo en el Excel.
    if (!entregaId) {
      const mov = await insert('movimientos_banco', {
        banco_id: cajaId,
        fecha: payload.fecha,
        tipo: 'egreso',
        concepto: payload.detalle,
        monto,
        ambito,
        empresa_id: empresaId,
        categoria_gasto_id: payload.categoria_gasto_id,
        responsable_contact_id: payload.responsable_contact_id,
        sede_id: payload.sede_id,
        referencia: payload.numero_recibo,
        created_by: payload.created_by
      })
      if (mov) await update('gastos', gastoId, { movimiento_id: mov.id })
      else showToast('El gasto se guardó pero NO se registró el movimiento de caja. Revísalo.', 'warning', 7000)
    } else {
      await _sumarRendicion(entregaId, monto)
    }
  }

  // ── Adjuntos
  if (_adjuntosPendientes.length) {
    const user = getCurrentUser()
    const items = _adjuntosPendientes.map(a => ({
      file: a.file,
      concepto: sustento === 'factura' ? 'factura_gasto' : (sustento === 'recibo_honorarios' ? 'rh' : 'recibo')
    }))
    const res = await subirAdjuntos('gasto', gastoId, items, user?.db_id || null)
    if (res.errores?.length) showToast(res.errores.join(' · '), 'warning', 6000)
    _adjuntosPendientes = []
  }

  // PENDIENTE contable: aquí iría generarAsientoGasto(gastoId) —
  // D 63/65 según categoría / H 101 (caja) o 104 (banco). Hoy no se genera
  // ningún asiento: el módulo contable está fuera del alcance de T1–T5.

  showToast(_editGastoId ? 'Gasto actualizado' : 'Gasto registrado', 'success')
  window.closeModal('modal-gasto')
  await _cargarCatalogos()
  await _cargarInicio()
  window.cargarGastos()
}

/** Suma lo rendido a la entrega y la cierra si ya no queda saldo. */
async function _sumarRendicion(entregaId, monto) {
  const { data: e } = await supabase.from('entregas_a_rendir').select('*').eq('id', entregaId).maybeSingle()
  if (!e) return
  const rendido = Number(e.monto_rendido || 0) + Number(monto)
  const pendiente = Number(e.monto_entregado || 0) - rendido - Number(e.monto_devuelto || 0)
  await update('entregas_a_rendir', entregaId, {
    monto_rendido: rendido,
    estado: pendiente <= 0.01 ? 'rendida' : 'parcial',
    fecha_rendicion: pendiente <= 0.01 ? _hoyISO() : null
  })
}

window.eliminarGasto = async function (id) {
  const g = _gastos.find(x => x.id === Number(id))
  if (!g) return
  if (!confirm(`¿Eliminar el gasto ${g.numero_recibo} por ${_money(g.monto, g.moneda)}?\n\nTambién se revierte su movimiento de caja.`)) return

  // El movimiento se borra primero: si falla, el gasto sigue ahí y el saldo
  // cuadra. Al revés quedaría un egreso huérfano sin dueño.
  if (g.movimiento_id) {
    const ok = await deleteRecord('movimientos_banco', g.movimiento_id)
    if (!ok) { showToast('No se pudo revertir el movimiento de caja. El gasto NO se eliminó.', 'error', 6000); return }
  }
  const ok = await update('gastos', id, { anulado: true, motivo_anulacion: 'Eliminado desde Tesorería' })
  if (!ok) { showToast('No se pudo eliminar el gasto', 'error'); return }

  showToast('Gasto eliminado', 'success')
  await _cargarCatalogos(); await _cargarInicio(); window.cargarGastos()
}

// ============================================================================
// ENTREGAS A RENDIR
// ============================================================================
window.limpiarBusquedaEntregas = function () { _v('entBuscar', ''); window.cargarEntregas() }

window.abrirModalEntrega = async function () {
  if (!_cajas.length) await _cargarCatalogos()
  _v('entCaja', ''); _v('entContacto', ''); _v('entFecha', _hoyISO())
  _v('entMoneda', 'PEN'); _v('entMonto', ''); _v('entConcepto', '')
  window.openModal('modal-entrega')
}

window.guardarEntrega = async function () {
  const cajaId = Number(_g('entCaja'))
  const contactId = Number(_g('entContacto'))
  const monto = Number(_g('entMonto'))
  if (!cajaId)      return showToast('Elige la caja', 'warning')
  if (!contactId)   return showToast('Elige la persona', 'warning')
  if (!(monto > 0)) return showToast('El monto debe ser mayor a 0', 'warning')

  const caja = _cajaById(cajaId)
  const user = getCurrentUser()
  const payload = {
    caja_id: cajaId,
    contact_id: contactId,
    ambito: caja?.ambito || 'empresa',
    empresa_id: caja?.ambito === 'familiar' ? null : (caja?.empresa_id || null),
    fecha_entrega: _g('entFecha'),
    concepto: _g('entConcepto') || null,
    moneda: _g('entMoneda'),
    monto_entregado: monto,
    estado: 'abierta',
    created_by: user?.db_id || null
  }

  const fila = await insert('entregas_a_rendir', payload)
  if (!fila) { showToast(`No se pudo registrar: ${ultimoErrorInsert()?.message || 'error'}`, 'error'); return }

  // La entrega SÍ saca plata de la caja (aunque todavía no sea gasto)
  const mov = await insert('movimientos_banco', {
    banco_id: cajaId,
    fecha: payload.fecha_entrega,
    tipo: 'egreso',
    concepto: `Entrega a rendir · ${_contactoById(contactId)?.nombre || ''}`,
    monto,
    ambito: payload.ambito,
    empresa_id: payload.empresa_id,
    sede_id: caja?.sede_id || null,
    created_by: payload.created_by
  })
  if (mov) await update('entregas_a_rendir', fila.id, { movimiento_salida_id: mov.id })
  else showToast('La entrega se guardó pero NO salió de la caja. Revísalo.', 'warning', 7000)

  showToast('Entrega registrada', 'success')
  window.closeModal('modal-entrega')
  await _cargarCatalogos(); await _cargarInicio(); window.cargarEntregas()
}

window.cargarEntregas = async function () {
  const cont = document.getElementById('entregas-tabla-cont')
  if (!cont) return

  let q = supabase.from('entregas_a_rendir').select('*').order('fecha_entrega', { ascending: false })
  const estado = _g('entFiltroEstado')
  if (estado === 'pendientes') q = q.in('estado', ['abierta', 'parcial'])
  else if (estado) q = q.eq('estado', estado)
  const caja = _g('entFiltroCaja')
  if (caja) q = q.eq('caja_id', Number(caja))

  const { data, error } = await q
  if (error) {
    cont.innerHTML = _vacio(/relation .* does not exist/i.test(error.message)
      ? 'Falta correr assets/sql/124_tesoreria_gastos.sql'
      : `No se pudieron cargar las entregas: ${error.message}`)
    return
  }
  _entregas = data || []

  const texto = _g('entBuscar').toLowerCase()
  let filas = _entregas
  if (texto) {
    const palabras = texto.split(/\s+/).filter(Boolean)
    filas = filas.filter(e => {
      const blob = [_contactoById(e.contact_id)?.nombre, e.concepto, _cajaById(e.caja_id)?.nombre].join(' ').toLowerCase()
      return palabras.every(p => blob.includes(p))
    })
  }

  if (!filas.length) { cont.innerHTML = _vacio('No hay entregas con esos filtros.'); return }

  cont.innerHTML = `<table><thead><tr>
      <th>Fecha</th><th>Persona</th><th>Caja</th><th>Concepto</th>
      <th>Entregado</th><th>Rendido</th><th>Devuelto</th><th>Pendiente</th><th>Estado</th><th>Acciones</th>
    </tr></thead><tbody>${filas.map(e => {
      const pend = Number(e.monto_entregado || 0) - Number(e.monto_rendido || 0) - Number(e.monto_devuelto || 0)
      const badge = { abierta: 'warning', parcial: 'info', rendida: 'success', anulada: 'danger' }[e.estado] || 'info'
      return `<tr>
        <td>${fechaDMY(e.fecha_entrega)}</td>
        <td>${_esc(_contactoById(e.contact_id)?.nombre || '—')}</td>
        <td>${_esc(_cajaById(e.caja_id)?.nombre || '—')}</td>
        <td>${_esc(e.concepto || '—')}</td>
        <td>${_money(e.monto_entregado, e.moneda)}</td>
        <td>${_money(e.monto_rendido, e.moneda)}</td>
        <td>${_money(e.monto_devuelto, e.moneda)}</td>
        <td style="font-weight:600;">${_money(pend, e.moneda)}</td>
        <td><span class="badge" style="background:var(--color-${badge}); color:#fff;">${_esc(e.estado)}</span></td>
        <td>${menuAccionesFila([
          { icono: '✔', label: 'Rendir',   onclick: `window.abrirModalRendir(${e.id})` },
          { icono: '✕', label: 'Anular',   onclick: `window.anularEntrega(${e.id})`, peligro: true }
        ])}</td>
      </tr>`
    }).join('')}</tbody></table>`
}

window.abrirModalRendir = async function (id) {
  const { data: e } = await supabase.from('entregas_a_rendir').select('*').eq('id', id).maybeSingle()
  if (!e) { showToast('No se encontró la entrega', 'error'); return }
  window._entregaRindiendo = e

  const { data: gastos } = await supabase.from('gastos').select('*').eq('entrega_id', id).eq('anulado', false)
  const pend = Number(e.monto_entregado || 0) - Number(e.monto_rendido || 0) - Number(e.monto_devuelto || 0)

  document.getElementById('renInfo').innerHTML = `
    <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">Entrega a rendir</div>
    <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${_esc(_contactoById(e.contact_id)?.nombre || '—')}</div>
    <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">
      ${_esc(_cajaById(e.caja_id)?.nombre || '')} · ${fechaDMY(e.fecha_entrega)} · ${_esc(e.concepto || 'sin concepto')}</div>`

  document.getElementById('renGastos').innerHTML = (gastos || []).length
    ? `<table style="width:100%; border-collapse:collapse; margin:0;">
        <thead><tr style="background:var(--bg-secondary);">
          <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Recibo</th>
          <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Detalle</th>
          <th style="text-align:right; padding:8px 10px; font-size:0.78rem;">Monto</th>
        </tr></thead><tbody>${gastos.map(g => `
          <tr style="border-top:1px solid var(--border-color);">
            <td style="padding:8px 10px;">${_esc(g.numero_recibo)}</td>
            <td style="padding:8px 10px;">${_esc(g.detalle)}</td>
            <td style="padding:8px 10px; text-align:right;">${_money(g.monto, g.moneda)}</td>
          </tr>`).join('')}</tbody></table>`
    : `<p style="padding:12px 14px; color:var(--text-secondary); margin:0;">
         Todavía no hay gastos cargados contra esta entrega. Regístralos con <strong>+ Gasto</strong>
         eligiendo esta entrega en "Descontar de una entrega a rendir".</p>`

  document.getElementById('renEntregado').textContent = _money(e.monto_entregado, e.moneda)
  document.getElementById('renRendido').textContent = _money(e.monto_rendido, e.moneda)
  document.getElementById('renVuelto').textContent = _money(pend, e.moneda)
  _v('renMontoDevuelto', pend > 0 ? pend.toFixed(2) : '0')

  window.openModal('modal-rendir')
}

window.cerrarRendicion = async function () {
  const e = window._entregaRindiendo
  if (!e) return
  const devuelto = Number(_g('renMontoDevuelto') || 0)
  const pend = Number(e.monto_entregado || 0) - Number(e.monto_rendido || 0) - Number(e.monto_devuelto || 0)

  if (devuelto < 0) return showToast('El vuelto no puede ser negativo', 'warning')
  if (devuelto > pend + 0.01) return showToast(`El vuelto no puede superar lo pendiente (${_money(pend, e.moneda)})`, 'warning')

  const totalDevuelto = Number(e.monto_devuelto || 0) + devuelto
  const nuevoPend = Number(e.monto_entregado || 0) - Number(e.monto_rendido || 0) - totalDevuelto

  if (devuelto > 0) {
    const mov = await insert('movimientos_banco', {
      banco_id: e.caja_id,
      fecha: _hoyISO(),
      tipo: 'ingreso',
      concepto: `Vuelto de entrega a rendir · ${_contactoById(e.contact_id)?.nombre || ''}`,
      monto: devuelto,
      ambito: e.ambito,
      empresa_id: e.empresa_id,
      created_by: getCurrentUser()?.db_id || null
    })
    if (!mov) { showToast('No se pudo registrar el vuelto en la caja', 'error'); return }
    await update('entregas_a_rendir', e.id, { movimiento_vuelto_id: mov.id })
  }

  const ok = await update('entregas_a_rendir', e.id, {
    monto_devuelto: totalDevuelto,
    estado: nuevoPend <= 0.01 ? 'rendida' : 'parcial',
    fecha_rendicion: nuevoPend <= 0.01 ? _hoyISO() : null
  })
  if (!ok) { showToast('No se pudo cerrar la rendición', 'error'); return }

  showToast(nuevoPend <= 0.01 ? 'Entrega rendida ✔' : 'Rendición parcial guardada', 'success')
  window.closeModal('modal-rendir')
  await _cargarCatalogos(); await _cargarInicio(); window.cargarEntregas()
}

window.anularEntrega = async function (id) {
  const e = _entregas.find(x => x.id === Number(id))
  if (!e) return
  if (Number(e.monto_rendido || 0) > 0) {
    showToast('Esta entrega ya tiene gastos rendidos: elimina primero esos gastos.', 'warning', 6000); return
  }
  if (!confirm(`¿Anular la entrega de ${_money(e.monto_entregado, e.moneda)}?\n\nSe revierte el egreso de la caja.`)) return

  if (e.movimiento_salida_id) {
    const ok = await deleteRecord('movimientos_banco', e.movimiento_salida_id)
    if (!ok) { showToast('No se pudo revertir el egreso. La entrega NO se anuló.', 'error', 6000); return }
  }
  await update('entregas_a_rendir', id, { estado: 'anulada' })
  showToast('Entrega anulada', 'success')
  await _cargarCatalogos(); await _cargarInicio(); window.cargarEntregas()
}

// ============================================================================
// REPOSICIONES Y ARQUEO
// ============================================================================
window.abrirModalReposicion = async function () {
  if (!_cajas.length) await _cargarCatalogos()
  const hoy = _hoyISO()
  const hace7 = new Date(Date.now() - 7 * 86400000).toLocaleDateString('en-CA')
  _v('repCaja', ''); _v('repDesde', hace7); _v('repHasta', hoy)
  _v('repFisico', ''); _v('repDiferencia', ''); _v('repMonto', ''); _v('repOrigen', ''); _v('repObservaciones', '')
  document.getElementById('repResumen').innerHTML = 'Elige una caja y un periodo.'
  _repCalc = null
  window.openModal('modal-reposicion')
}

window.calcularReposicion = async function () {
  const cajaId = Number(_g('repCaja'))
  const desde = _g('repDesde'), hasta = _g('repHasta')
  const cont = document.getElementById('repResumen')
  if (!cajaId || !desde || !hasta) { cont.innerHTML = 'Elige una caja y un periodo.'; return }

  const caja = _cajaById(cajaId)
  const { data, error } = await supabase.from('movimientos_banco').select('*')
    .eq('banco_id', cajaId).gte('fecha', desde).lte('fecha', hasta)
  if (error) { cont.innerHTML = `<span style="color:var(--color-danger);">${_esc(error.message)}</span>`; return }

  const ingresos = (data || []).filter(m => m.tipo === 'ingreso').reduce((s, m) => s + Number(m.monto || 0), 0)
  const egresos  = (data || []).filter(m => m.tipo === 'egreso').reduce((s, m) => s + Number(m.monto || 0), 0)
  const saldoFinal = Number(caja?.saldo_actual || 0)
  const saldoInicial = saldoFinal - ingresos + egresos
  const fondo = Number(caja?.monto_fondo_fijo || 0)
  const sugerido = caja?.es_fondo_fijo ? Math.max(0, fondo - saldoFinal) : egresos

  _repCalc = { cajaId, caja, desde, hasta, ingresos, egresos, saldoInicial, saldoFinal, movimientos: data || [] }

  const fisico = _g('repFisico') === '' ? null : Number(_g('repFisico'))
  const dif = fisico === null ? 0 : fisico - saldoFinal
  _v('repDiferencia', fisico === null ? '— (no se contó)' :
    `${dif >= 0 ? '+' : ''}${formatNumber(dif)} ${dif === 0 ? '✔ cuadra' : (dif < 0 ? '⚠ faltante' : '⚠ sobrante')}`)

  if (!_g('repMonto')) _v('repMonto', sugerido.toFixed(2))

  cont.innerHTML = `
    <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:12px; font-size:0.88rem;">
      <div><div style="color:var(--text-secondary); font-size:0.72rem;">SALDO INICIAL</div>
           <div style="font-weight:600;">${_money(saldoInicial, caja?.moneda)}</div></div>
      <div><div style="color:var(--text-secondary); font-size:0.72rem;">INGRESOS</div>
           <div style="font-weight:600; color:var(--color-success);">${_money(ingresos, caja?.moneda)}</div></div>
      <div><div style="color:var(--text-secondary); font-size:0.72rem;">EGRESOS</div>
           <div style="font-weight:600; color:var(--color-danger);">${_money(egresos, caja?.moneda)}</div></div>
      <div><div style="color:var(--text-secondary); font-size:0.72rem;">SALDO SEGÚN SISTEMA</div>
           <div style="font-weight:700;">${_money(saldoFinal, caja?.moneda)}</div></div>
    </div>
    <div style="margin-top:10px; font-size:0.82rem; color:var(--text-secondary);">
      ${(data || []).length} movimiento(s) en el periodo ·
      ${caja?.es_fondo_fijo
        ? `fondo fijo ${_money(fondo, caja?.moneda)} → reponer <strong>${_money(sugerido, caja?.moneda)}</strong>`
        : `<span style="color:var(--color-warning);">esta caja no tiene fondo fijo configurado</span>`}
    </div>`
}

window.guardarReposicion = async function () {
  if (!_repCalc) return showToast('Calcula primero el periodo', 'warning')
  const monto = Number(_g('repMonto') || 0)
  const fisico = _g('repFisico') === '' ? null : Number(_g('repFisico'))
  const origenId = Number(_g('repOrigen')) || null

  const user = getCurrentUser()
  const c = _repCalc
  const payload = {
    caja_id: c.cajaId,
    fecha: _hoyISO(),
    periodo_desde: c.desde,
    periodo_hasta: c.hasta,
    saldo_inicial: c.saldoInicial,
    total_ingresos: c.ingresos,
    total_egresos: c.egresos,
    saldo_final_sistema: c.saldoFinal,
    saldo_fisico_contado: fisico,
    monto_repuesto: monto,
    origen_banco_id: origenId,
    estado: 'cerrada',
    observaciones: _g('repObservaciones') || null,
    created_by: user?.db_id || null
  }

  const fila = await insert('reposiciones_caja', payload)
  if (!fila) { showToast(`No se pudo guardar: ${ultimoErrorInsert()?.message || 'error'}`, 'error'); return }

  // La reposición es una transferencia: sale de la cuenta origen y entra a la caja
  if (monto > 0 && origenId) {
    const caja = c.caja
    const movIn = await insert('movimientos_banco', {
      banco_id: c.cajaId, fecha: payload.fecha, tipo: 'ingreso',
      concepto: `Reposición de caja ${c.desde} a ${c.hasta}`, monto,
      ambito: caja?.ambito || 'empresa',
      empresa_id: caja?.ambito === 'familiar' ? null : (caja?.empresa_id || null),
      created_by: payload.created_by
    })
    const origen = _cajaById(origenId)
    const movOut = await insert('movimientos_banco', {
      banco_id: origenId, fecha: payload.fecha, tipo: 'egreso',
      concepto: `Reposición a ${caja?.nombre || 'caja'}`, monto,
      ambito: origen?.ambito || 'empresa',
      empresa_id: origen?.ambito === 'familiar' ? null : (origen?.empresa_id || null),
      created_by: payload.created_by
    })
    if (movIn) await update('reposiciones_caja', fila.id, { movimiento_ingreso_id: movIn.id })
    if (!movIn || !movOut) showToast('La reposición se guardó pero un movimiento falló. Revisa los saldos.', 'warning', 7000)
  }

  // Marca los gastos del periodo como incluidos en esta reposición
  await supabase.from('gastos').update({ reposicion_id: fila.id })
    .eq('caja_id', c.cajaId).gte('fecha', c.desde).lte('fecha', c.hasta)
    .is('reposicion_id', null).eq('anulado', false)

  showToast('Reposición cerrada', 'success')
  window.closeModal('modal-reposicion')
  await _cargarCatalogos(); await _cargarInicio(); window.cargarReposiciones()
}

window.cargarReposiciones = async function () {
  const cont = document.getElementById('reposiciones-tabla-cont')
  if (!cont) return
  const { data, error } = await supabase.from('reposiciones_caja').select('*').order('fecha', { ascending: false })
  if (error) {
    cont.innerHTML = _vacio(/relation .* does not exist/i.test(error.message)
      ? 'Falta correr assets/sql/124_tesoreria_gastos.sql'
      : `No se pudieron cargar: ${error.message}`)
    return
  }
  _reposiciones = data || []
  if (!_reposiciones.length) { cont.innerHTML = _vacio('Todavía no hay reposiciones.'); return }

  cont.innerHTML = `<table><thead><tr>
      <th>Fecha</th><th>Caja</th><th>Periodo</th><th>Egresos</th>
      <th>Saldo sistema</th><th>Arqueo</th><th>Diferencia</th><th>Repuesto</th><th>Estado</th>
    </tr></thead><tbody>${_reposiciones.map(r => {
      const caja = _cajaById(r.caja_id)
      const dif = Number(r.diferencia || 0)
      const color = dif === 0 ? 'var(--text-primary)' : (dif < 0 ? 'var(--color-danger)' : 'var(--color-warning)')
      return `<tr>
        <td>${fechaDMY(r.fecha)}</td>
        <td>${_esc(caja?.nombre || '—')}</td>
        <td>${fechaDMY(r.periodo_desde)} → ${fechaDMY(r.periodo_hasta)}</td>
        <td>${_money(r.total_egresos, caja?.moneda)}</td>
        <td>${_money(r.saldo_final_sistema, caja?.moneda)}</td>
        <td>${r.saldo_fisico_contado == null ? '—' : _money(r.saldo_fisico_contado, caja?.moneda)}</td>
        <td style="color:${color}; font-weight:600;">${r.saldo_fisico_contado == null ? '—' : _money(dif, caja?.moneda)}</td>
        <td><strong>${_money(r.monto_repuesto, caja?.moneda)}</strong></td>
        <td><span class="badge">${_esc(r.estado)}</span></td>
      </tr>`
    }).join('')}</tbody></table>`
}

window.descargarRendicionPDF = function () {
  // PENDIENTE T3: PDF de rendición con jsPDF + autotable, siguiendo el modelo
  // de assets/js/estado-cuenta.js (filas compartidas HTML/PDF).
  showToast('El PDF de rendición llega en la etapa T3', 'info')
}

// ============================================================================
// TAB CAJAS
// ============================================================================
function _pintarCajas() {
  const cont = document.getElementById('cajas-tabla-cont')
  if (!cont) return
  if (!_cajas.length) { cont.innerHTML = _vacio('No hay cuentas registradas.'); return }

  cont.innerHTML = `<table><thead><tr>
      <th>Nombre</th><th>Tipo</th><th>Medio</th><th>Ámbito</th><th>Moneda</th>
      <th>Saldo</th><th>Fondo fijo</th><th>Mínimo</th><th>Acciones</th>
    </tr></thead><tbody>${_cajas.map(c => `<tr>
      <td>${_esc(c.nombre)}</td>
      <td>${_esc(c.tipo_cuenta)}</td>
      <td>${_esc(c.medio || '—')}</td>
      <td><span class="badge">${_etiquetaAmbito(c)}</span></td>
      <td>${_esc(c.moneda)}</td>
      <td style="font-weight:600; ${Number(c.saldo_actual) < 0 ? 'color:var(--color-danger);' : ''}">${_money(c.saldo_actual, c.moneda)}</td>
      <td>${c.es_fondo_fijo ? _money(c.monto_fondo_fijo, c.moneda) : '—'}</td>
      <td>${c.es_fondo_fijo ? _money(c.saldo_minimo, c.moneda) : '—'}</td>
      <td><button class="btn btn-secondary btn-small" onclick="window.editarFondoFijo(${c.id})">Fondo fijo</button></td>
    </tr>`).join('')}</tbody></table>`
}

window.editarFondoFijo = async function (id) {
  const c = _cajaById(id)
  if (!c) return
  const actual = c.es_fondo_fijo ? Number(c.monto_fondo_fijo || 0) : 0
  const txt = prompt(
    `Fondo fijo de "${c.nombre}" (${c.moneda}).\n\n` +
    `Es el monto asignado a la caja: la reposición la devuelve a esta cifra.\n` +
    `Escribe 0 para quitarle el fondo fijo.`, String(actual))
  if (txt === null) return
  const monto = Number(txt)
  if (isNaN(monto) || monto < 0) { showToast('Monto inválido', 'warning'); return }

  const minTxt = monto > 0
    ? prompt(`Saldo mínimo de alerta para "${c.nombre}".\nPor debajo de esto el sistema avisa que toca reponer.`,
             String(Number(c.saldo_minimo || 0) || Math.round(monto * 0.2)))
    : '0'
  if (minTxt === null) return

  const ok = await update('bancos', id, {
    es_fondo_fijo: monto > 0,
    monto_fondo_fijo: monto,
    saldo_minimo: Number(minTxt) || 0
  })
  if (!ok) { showToast('No se pudo guardar', 'error'); return }
  showToast('Fondo fijo actualizado', 'success')
  await _cargarCatalogos(); _pintarCajas(); await _cargarInicio()
}

// ============================================================================
// CONFIGURACIÓN — categorías de gasto
// ============================================================================
function _pintarCategorias() {
  const cont = document.getElementById('categorias-tabla-cont')
  if (!cont) return
  if (!_categorias.length) {
    cont.innerHTML = _vacio('No hay categorías. ¿Corriste assets/sql/123_tesoreria_cimientos.sql?')
    return
  }
  cont.innerHTML = `<table><thead><tr>
      <th>Código</th><th>Nombre</th><th>Ámbito sugerido</th><th>Destino sugerido</th><th>Deducible</th><th>Acciones</th>
    </tr></thead><tbody>${_categorias.map(c => `<tr>
      <td><code>${_esc(c.codigo)}</code></td>
      <td>${_esc(c.nombre)}</td>
      <td>${_esc(c.ambito_sugerido || 'ambos')}</td>
      <td>${_esc(DESTINOS[c.destino_sugerido] || '— preguntar —')}</td>
      <td>${c.deducible_defecto ? '✔' : '✕'}</td>
      <td>${menuAccionesFila([
        { icono: '✏️', label: 'Editar',   onclick: `window.abrirModalCategoria(${c.id})` },
        { icono: '✕',  label: 'Desactivar', onclick: `window.desactivarCategoria(${c.id})`, peligro: true }
      ])}</td>
    </tr>`).join('')}</tbody></table>`
}

let _editCatId = null
window.abrirModalCategoria = function (id = null) {
  _editCatId = id ? Number(id) : null
  const c = id ? _catById(id) : null
  document.getElementById('catModalTitulo').textContent = c ? `Editar ${c.codigo}` : 'Nueva categoría de gasto'
  _v('catCodigo', c?.codigo || ''); _v('catNombre', c?.nombre || '')
  _v('catAmbito', c?.ambito_sugerido || ''); _v('catDestino', c?.destino_sugerido || '')
  _setChk('catDeducible', c ? c.deducible_defecto : true)
  const cod = document.getElementById('catCodigo')
  if (cod) cod.disabled = !!c
  window.openModal('modal-categoria-gasto')
}

window.guardarCategoriaGasto = async function () {
  const codigo = _g('catCodigo').toUpperCase().replace(/\s+/g, '_')
  const nombre = _g('catNombre')
  if (!codigo) return showToast('Falta el código', 'warning')
  if (!nombre) return showToast('Falta el nombre', 'warning')

  const payload = {
    codigo, nombre,
    ambito_sugerido: _g('catAmbito') || null,
    destino_sugerido: _g('catDestino') || null,
    deducible_defecto: _chk('catDeducible')
  }

  const ok = _editCatId
    ? await update('categorias_gasto', _editCatId, payload)
    : await insert('categorias_gasto', { ...payload, orden: 500 })
  if (!ok) { showToast(`No se pudo guardar: ${ultimoErrorInsert()?.message || 'error'}`, 'error'); return }

  showToast('Categoría guardada', 'success')
  window.closeModal('modal-categoria-gasto')
  await _cargarCatalogos(); _pintarCategorias()
}

window.desactivarCategoria = async function (id) {
  const c = _catById(id)
  if (!c) return
  if (!confirm(`¿Desactivar la categoría "${c.nombre}"?\n\nLos gastos ya registrados la conservan.`)) return
  const ok = await update('categorias_gasto', id, { activo: false })
  if (!ok) { showToast('No se pudo desactivar', 'error'); return }
  showToast('Categoría desactivada', 'success')
  await _cargarCatalogos(); _pintarCategorias()
}

// ============================================================================
// REPORTES — motor genérico crearReporte()
// ============================================================================
window.reporteTes = async function (tipo) {
  const cont = document.getElementById('tes-reporte-cont')
  if (!cont) return
  cont.innerHTML = 'Cargando...'

  const { data, error } = await supabase.from('gastos').select('*').eq('anulado', false)
  if (error) { cont.innerHTML = _vacio(error.message); return }

  const filas = (data || []).map(g => ({
    fecha: g.fecha,
    caja: _cajaById(g.caja_id)?.nombre || '\u2014',
    ambito: _etiquetaAmbito(g),
    categoria: _catById(g.categoria_gasto_id)?.nombre || '\u2014',
    responsable: _contactoById(g.responsable_contact_id)?.nombre || 'Sin responsable',
    destino: DESTINOS[g.destino_costo] || g.destino_costo,
    sustento: SUSTENTOS[g.tipo_sustento] || g.tipo_sustento,
    deducible: g.deducible ? 'Deducible' : 'No deducible',
    // Fijo vs. variable: lo operativo y de personal es el "piso" del mes; el
    // resto se mueve con la actividad. Es la base del presupuesto (etapa T6).
    tipo_costo: ['gasto_operativo', 'gasto_personal'].includes(g.destino_costo) ? 'Fijo' : 'Variable',
    detalle: g.detalle || '',
    monto: Number(g.monto || 0)
  }))

  const dimensiones = [
    { key: 'categoria',   label: 'Categor\u00eda' },
    { key: 'ambito',      label: '\u00c1mbito' },
    { key: 'responsable', label: 'Responsable' },
    { key: 'caja',        label: 'Caja' },
    { key: 'destino',     label: 'Destino' },
    { key: 'sustento',    label: 'Sustento' },
    { key: 'deducible',   label: 'Deducibilidad' },
    { key: 'tipo_costo',  label: 'Fijo / Variable' },
    { key: 'mes',         label: 'Fecha', tipo: 'fecha', campo: 'fecha' }
  ]
  const medidas = [{ key: 'monto', label: 'Total', agg: 'sum', formato: 'money' }]
  const filtros = [
    { key: 'rango',  label: 'Periodo',    tipo: 'rango',  campo: 'fecha' },
    { key: 'ambito', label: '\u00c1mbito', tipo: 'select', opciones: [...new Set(filas.map(f => f.ambito))] },
    { key: 'categoria', label: 'Categor\u00eda', tipo: 'select', opciones: [...new Set(filas.map(f => f.categoria))] },
    { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['detalle', 'responsable', 'categoria'], placeholder: 'Detalle, responsable...' }
  ]
  const kpis = (f) => {
    const total = f.reduce((s, x) => s + x.monto, 0)
    const ded   = f.filter(x => x.deducible === 'Deducible').reduce((s, x) => s + x.monto, 0)
    return [
      { label: 'Total gastado', valor: total, formato: 'money' },
      { label: 'Deducible',     valor: ded,   formato: 'money', color: 'var(--color-success)' },
      { label: 'No deducible',  valor: total - ded, formato: 'money', color: 'var(--color-danger)' },
      { label: 'Gastos',        valor: f.length, formato: 'int' }
    ]
  }

  const porTipo = {
    categoria:     { titulo: 'Gastos por categor\u00eda',        agrupar: ['categoria'] },
    responsable:   { titulo: 'Gastos por responsable',       agrupar: ['responsable'] },
    ambito:        { titulo: 'Empresa vs. Familiar',         agrupar: ['ambito', 'categoria'] },
    deducible:     { titulo: 'Deducible vs. no deducible',   agrupar: ['deducible', 'categoria'] },
    fijo_variable: { titulo: 'Costo fijo vs. variable',      agrupar: ['tipo_costo', 'categoria'] }
  }
  const cfg = porTipo[tipo] || porTipo.categoria

  crearReporte('tes-reporte-cont', {
    id: `tes-rep-${tipo}`,
    titulo: cfg.titulo,
    descripcion: 'Gastos registrados en Tesorer\u00eda. El filtro de empresa de la cabecera ya est\u00e1 aplicado.',
    datos: filas,
    dimensiones, medidas, filtros, kpis,
    agruparPorDefecto: cfg.agrupar
  })
}

// ============================================================================
// INIT
// ============================================================================
async function init() {
  await esperarContextoEmpresa()
  initModuleNavDropdowns('#tesoreriaTabs')

  document.querySelectorAll('#tesoreriaTabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => window.irATabTes(btn.dataset.tab))
  })

  _v('gasFiltroMes', _hoyISO().slice(0, 7))

  await _cargarCatalogos()
  await _cargarInicio()

  // Tab de destino si se llegó desde otro módulo
  try {
    const destino = sessionStorage.getItem('tab_destino')
    if (destino) { sessionStorage.removeItem('tab_destino'); window.irATabTes(destino) }
  } catch {}

  // Un solo listener global para cerrar los menús de columnas
  if (!window._tesColMenuListener) {
    document.addEventListener('click', e => {
      document.querySelectorAll('.col-menu.open').forEach(m => { if (!m.contains(e.target)) m.classList.remove('open') })
    })
    window._tesColMenuListener = true
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
else init()
