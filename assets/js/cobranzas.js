// ============================================================================
// COBRANZAS.JS — Cuentas por Cobrar / por Pagar, Cobros, Pagos, Retenciones
// ============================================================================
// Fase 2: menú por grupos, filtros avanzados en los listados, tab de Reportes
// con tablas dinámicas, tab de Configuración e integración con Bancos
// (cada cobro/pago genera opcionalmente su movimiento bancario y actualiza el
// saldo de la cuenta).
// ============================================================================

import { getCurrentUser } from './auth-supabase.js'
import { supabase } from './supabase-client.js'
import { getTipoCambioDia } from './sunat-api.js'
import {
  getCuentasCobrar, updateCuentaCobrar,
  getCuotasCobrar, updateCuotaCobrar, getAntiguedadCxC,
  getCuotasPagar, updateCuotaPagar, deleteCuotaCobrar, deleteCuotaPagar,
  addTerminoPago, updateTerminoPago, deleteTerminoPago,
  addTerminoPagoCuota, deleteTerminoPagoCuota, getTerminosPagoCuotas,
  getCuentasPagar, updateCuentaPagar,
  getCobros, addCobro, updateCobro, deleteCobro, getCobroById,
  getPagosProveedores, addPagoProveedor, updatePagoProveedor, deletePagoProveedor, getPagoProveedorById,
  getCuentaCobrarById, getCuentaPagarById, getBancoById, deleteCuentaCobrar, deleteCuentaPagar,
  getMovimientosBanco, deleteMovimientoBanco, updateMovimientoBanco, crearAsientoContable,
  getJournalEntryByReferencia, getJournalEntryLinesByEntry, eliminarAsientoContable, getAccounts,
  getContacts,
  getBancos, updateBanco, addMovimientoBanco,
  getLetrasCambio, addLetraCambio, updateLetraCambio, deleteLetraCambio,
  getSuppliers, getCuentasGasto, addCompra, addCompraDetalle, addCuentaPagar,
  generarAsientoCobroCliente, generarAsientoPagoProveedor, crearAsientoCancelacionME, crearAsientoMultiME, ctaCob,
  subirAdjuntos, getAdjuntos, getConteoAdjuntos, getUrlAdjunto, eliminarAdjunto, eliminarAdjuntosDe, ADJ_CONCEPTOS
} from './supabase-data.js'
import { showToast, formatNumber, fechaDMY, hacerTablaOrdenable } from './helpers.js'
import { initModuleNavDropdowns, initSubtabs, menuAccionesFila } from './main.js'
import { getModuloConfig, renderConfiguracionTab, aplicarPreferenciasVista } from './config-modulo.js'
import { cacheado, invalidarVarios } from './data-cache.js'
import { crearReporte, diasVencidos, tramoAntiguedad, nombreMes, mesActual, descargarCSV } from './reportes.js'
import { convertirVarios, refrescarBuscador } from './buscador-select.js'
import { saldoCuota, estadoCuota, repartirEntreCuotas, getTerminosConCuotas, invalidarCacheTerminos } from './cronograma.js'

const MODULO = 'cobranzas'

let _cfg          = getModuloConfig(MODULO)
let _contactsMap  = {}
let _bancosMap    = {}
let _bancos       = []
let _cxcList      = []
let _cxpList      = []
let _cobrosList   = []
let _pagosList    = []
let _letrasCache  = []
let _cobroRetencionPendiente = 0
let _reportesListos = {}

/** Tasa de retención configurable (Configuración → Retención de IGV %). */
function tasaRetencion() { return (parseFloat(_cfg.retencionIgvPct) || 3) / 100 }

// ============================================================================
// INIT
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  try {
    aplicarPreferenciasVista(MODULO)
    _cfg = getModuloConfig(MODULO)

    const user = getCurrentUser()
    const userDisplay = document.getElementById('userDisplay')
    if (userDisplay && user) userDisplay.textContent = user.nombre || user.email

    initTabs()
    initModuleNavDropdowns('#cobTabs')
    initSubtabs('#cob-subtabs-reportes', (panel) => construirReporte(panel))

    // Los selects de CxC/CxP listan un documento por línea y crecen rápido.
    document.getElementById('cobroBanco')?.addEventListener('change', () => window._cpRecalc('cobro', 'banco'))
    document.getElementById('pagoBanco')?.addEventListener('change', () => window._cpRecalc('pago', 'banco'))
    convertirVarios([
      { id: 'cobroSelectCxC',   placeholder: 'Escribe el cliente o el N° de comprobante...',   sinResultados: 'Sin cuentas por cobrar pendientes' },
      { id: 'pagoSelectCompra', placeholder: 'Escribe el proveedor o el N° de comprobante...', sinResultados: 'Sin cuentas por pagar pendientes' },
      { id: 'cobroBanco',       placeholder: 'Escribe el banco o N° de cuenta...',             sinResultados: 'Sin cuentas bancarias' },
      { id: 'pagoBanco',        placeholder: 'Escribe el banco o N° de cuenta...',             sinResultados: 'Sin cuentas bancarias' }
    ])

    const [contactos, bancos] = await Promise.all([
      cacheado('contactos', getContacts),
      cacheado('bancos', getBancos)
    ])
    contactos.forEach(c => { _contactsMap[c.id] = c })
    _bancos = bancos
    bancos.forEach(b => { _bancosMap[b.id] = b })

    const optBancos = bancos.map(b =>
      `<option value="${b.id}">${b.nombre} — ${b.numero_cuenta} (${b.moneda})</option>`
    ).join('')
    const selCobro = document.getElementById('cobroBanco')
    const selPago  = document.getElementById('pagoBanco')
    if (selCobro) selCobro.innerHTML = '<option value="">-- Seleccione banco --</option>' + optBancos
    if (selPago)  selPago.innerHTML  = '<option value="">-- Seleccione banco --</option>' + optBancos

    const avisoBanco = _cfg.autoMovBanco
      ? 'Se registrará el movimiento bancario automáticamente.'
      : 'El movimiento bancario NO se registra automáticamente (ver Configuración).'
    const ab1 = document.getElementById('cobro-banco-aviso'); if (ab1) ab1.textContent = avisoBanco
    const ab2 = document.getElementById('pago-banco-aviso');  if (ab2) ab2.textContent = avisoBanco

    const periodoEl = document.getElementById('retencionesPeriodo')
    if (periodoEl) periodoEl.value = mesActual()

    renderConfiguracionTab(MODULO, 'cob-config-container', {
      onGuardar: () => { _cfg = getModuloConfig(MODULO); showToast('Configuración guardada. Algunos cambios requieren recargar.', 'success') }
    })

    await Promise.all([
      cargarCxC(), cargarCxP(), cargarCobrosRecientes(), cargarPagosRecientes(), cargarRetenciones()
    ])
    // Columnas ordenables asc/desc en todos los listados del módulo
    document.querySelectorAll('.tab-content:not(#tab-reportes) table').forEach(hacerTablaOrdenable)
    calcularKPIs()
  } catch (e) {
    console.error('cobranzas DOMContentLoaded:', e)
    showToast('Error al cargar el módulo: ' + e.message, 'danger')
  }
})

function initTabs() {
  const btns     = document.querySelectorAll('#cobTabs .tab-btn')
  const contents = document.querySelectorAll('.tab-content')
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      btns.forEach(b => b.classList.remove('active'))
      contents.forEach(c => c.classList.remove('active'))
      btn.classList.add('active')
      const nombre = btn.getAttribute('data-tab')
      document.getElementById(`tab-${nombre}`)?.classList.add('active')
      if (nombre === 'terminos' || nombre === 'configuracion') renderTerminosPago()
      if (nombre === 'letras') {
        // "Letras por Cobrar" / "Letras por Pagar" comparten la vista; el botón fija el filtro.
        const f = document.getElementById('let-filtro-tipo')
        if (f && btn.dataset.letraTipo !== undefined) f.value = btn.dataset.letraTipo
        window.cargarLetras()
      }
      if (nombre === 'recibos') window.cargarRecibos()
      if (nombre === 'reportes') {
        const activo = document.querySelector('#cob-subtabs-reportes .subtab.active')?.getAttribute('data-sub') || 'rep-estado-cuenta'
        construirReporte(activo)
      }
    })
  })
  const hoy = new Date().toISOString().split('T')[0]
  const f1 = document.getElementById('cobroFecha'); if (f1) f1.value = hoy
  const f2 = document.getElementById('pagoFecha');  if (f2) f2.value = hoy
}

window.irATab = function(nombre) {
  document.querySelector(`#cobTabs .tab-btn[data-tab="${nombre}"]`)?.click()
}

function _refrescarTodo() {
  invalidarVarios(['cuentas_cobrar', 'cuentas_pagar', 'cobros', 'pagos_proveedores', 'bancos', 'cuotas_cobrar', 'cuotas_pagar', 'letras_cambio', 'letras_abonos'])
  _cuotasCache = []
  _cuotasPagarCache = []
  _reportesListos = {}
}

function _nombreContacto(id) {
  const c = _contactsMap[id]
  return c?.razon_social || c?.nombre || `ID ${id}`
}

// ============================================================================
// KPIs
// ============================================================================

function calcularKPIs() {
  try {
    const hoy = new Date().toISOString().split('T')[0]
    let cxcPend = 0, cxcVenc = 0, cxcVencDocs = 0, cxpPend = 0, cxpVenc = 0

    _cxcList.forEach(c => {
      if (c.estado === 'cobrado' || c.estado === 'anulado') return
      const saldo = _saldoCxC(c)
      if (saldo <= 0.01) return
      cxcPend += saldo
      if (c.fecha_vencimiento && c.fecha_vencimiento < hoy) { cxcVenc += saldo; cxcVencDocs++ }
    })

    _cxpList.forEach(c => {
      if (c.estado === 'pagado' || c.estado === 'anulado') return
      const saldo = _saldoCxP(c)
      if (saldo <= 0.01) return
      cxpPend += saldo
      if (c.fecha_vencimiento && c.fecha_vencimiento < hoy) cxpVenc += saldo
    })

    _set('kpi-cxc-pendiente', `S/ ${formatNumber(cxcPend)}`)
    _set('kpi-cxc-vencida',   `S/ ${formatNumber(cxcVenc)}`)
    _set('kpi-cxp-pendiente', `S/ ${formatNumber(cxpPend)}`)

    const neta = cxcPend - cxpPend
    const elNeta = document.getElementById('kpi-posicion-neta')
    if (elNeta) {
      elNeta.textContent = `S/ ${formatNumber(neta)}`
      elNeta.style.color = neta >= 0 ? 'var(--color-success)' : 'var(--color-danger)'
    }

    _set('kpi-cxc-pendiente-sub', `${_cxcList.filter(c => c.estado !== 'cobrado').length} documentos`)
    _set('kpi-cxc-vencida-sub',   cxcVencDocs ? `${cxcVencDocs} documento(s) vencido(s)` : 'Sin vencidos ✅')
    _set('kpi-cxp-pendiente-sub', cxpVenc > 0 ? `S/ ${formatNumber(cxpVenc)} vencido` : 'Sin vencidos ✅')
  } catch (e) { console.error('calcularKPIs:', e) }
}

function _set(id, texto) { const el = document.getElementById(id); if (el) el.textContent = texto }

// Saldo exigible real. Fórmula completa:
//   total + notas de débito − notas de crédito − cobrado − retenido
// Las notas ajustan el importe del comprobante sin que haya movido dinero,
// así que tienen que entrar aquí o el saldo mostraría una deuda que ya no
// existe (NC) o se quedaría corta (ND).
function _saldoCxC(c) {
  return parseFloat(c.monto_total || 0)
       + parseFloat(c.monto_notas_debito || 0)
       - parseFloat(c.monto_notas_credito || 0)
       - parseFloat(c.monto_cobrado || 0)
       - parseFloat(c.monto_retenido || 0)
       - parseFloat(c.monto_canjeado || 0)
       - parseFloat(c.monto_anticipo_aplicado || 0)
}
function _saldoCxP(c) {
  return parseFloat(c.monto_total || 0)
       + parseFloat(c.monto_notas_debito || 0)
       - parseFloat(c.monto_notas_credito || 0)
       - parseFloat(c.monto_pagado || 0)
       - parseFloat(c.monto_canjeado || 0)
       - parseFloat(c.monto_anticipo_aplicado || 0)
}

// ============================================================================
// CxC — LISTADO
// ============================================================================

function _filtrarCxC() {
  const buscar  = (document.getElementById('cxc-buscar')?.value || '').toLowerCase().trim()
  const estado  = document.getElementById('cxc-filtro-estado')?.value || ''
  const venc    = document.getElementById('cxc-filtro-venc')?.value || ''
  const moneda  = document.getElementById('cxc-filtro-moneda')?.value || ''
  const desde   = document.getElementById('cxc-filtro-desde')?.value || ''
  const hasta   = document.getElementById('cxc-filtro-hasta')?.value || ''
  const hoy     = new Date().toISOString().split('T')[0]
  const diasAviso = parseInt(_cfg.diasAlertaVenc) || 7

  return _cxcList.filter(c => {
    if (estado && c.estado !== estado) return false
    if (moneda && (c.moneda || 'PEN') !== moneda) return false
    if (desde && (c.fecha_emision || '') < desde) return false
    if (hasta && (c.fecha_emision || '') > hasta) return false
    if (venc) {
      const fv = c.fecha_vencimiento
      const dias = fv ? diasVencidos(fv) : -9999
      if (venc === 'vencido'    && !(fv && fv < hoy && c.estado !== 'cobrado')) return false
      if (venc === 'porvencer'  && !(fv && dias <= 0 && dias > -diasAviso - 1 && c.estado !== 'cobrado')) return false
      if (venc === 'alcorriente'&& (fv && fv < hoy && c.estado !== 'cobrado')) return false
    }
    if (buscar) {
      const txt = `${_nombreContacto(c.contact_id)} ${c.tipo_comprobante || ''} ${c.serie || ''} ${c.numero_comprobante || ''}`.toLowerCase()
      if (!txt.includes(buscar)) return false
    }
    return true
  })
}

window.cargarCxC = async function() {
  try {
    _cxcList = await cacheado('cuentas_cobrar', getCuentasCobrar)
    _cobrosList = await cacheado('cobros', getCobros)   // para los botones 👁 ✏️ ✕ de cada fila
    _letrasCache = await cacheado('letras_cambio', getLetrasCambio)
    await _cargarCuotas()
    const lista = _filtrarCxC().sort((a, b) => (a.fecha_vencimiento || 'zzzz').localeCompare(b.fecha_vencimiento || 'zzzz'))
    const hoy = new Date().toISOString().split('T')[0]

    // Retención pendiente de sustentar: mismo criterio que el reporte
    // "Retenciones IGV" (monto_retencion > 0 y sin numero_comprobante_retencion
    // todavía) — acá se agrupa por CxC para poder avisarlo también en el
    // listado principal, no solo en el reporte aparte. Contablemente esa
    // porción retenida ya "salda" la CxC en el sistema (ver monto_retenido),
    // pero hasta que el cliente entregue su comprobante de retención, no hay
    // sustento documentario formal ante SUNAT — de ahí el aviso.
    const cobrosTodos = await cacheado('cobros', getCobros)
    const retencionPendientePorCxc = {}
    for (const co of (cobrosTodos || [])) {
      const montoRet = parseFloat(co.monto_retencion) || 0
      if (montoRet > 0 && !co.numero_comprobante_retencion) {
        retencionPendientePorCxc[co.cxc_id] = (retencionPendientePorCxc[co.cxc_id] || 0) + montoRet
      }
    }

    const tbody = document.getElementById('tbody-cxc')
    const tfoot = document.getElementById('tfoot-cxc')
    if (!tbody) return

    if (lista.length === 0) {
      tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;">Sin registros para los filtros seleccionados</td></tr>'
      if (tfoot) tfoot.innerHTML = ''
      _poblarSelectCxC([])
      calcularKPIs()
      return
    }

    let tTotal = 0, tCobrado = 0, tPend = 0
    tbody.innerHTML = lista.map(cxc => {
      const total     = parseFloat(cxc.monto_total || 0)
      const cobrado   = parseFloat(cxc.monto_cobrado || 0)
      const retenido  = parseFloat(cxc.monto_retenido || 0)
      const notasCr   = parseFloat(cxc.monto_notas_credito || 0)
      const notasDb   = parseFloat(cxc.monto_notas_debito || 0)
      const anticipoAp = parseFloat(cxc.monto_anticipo_aplicado || 0)
      // Anulado: la deuda deja de existir (pendiente 0, fuera de los totales)
      const anulado   = cxc.estado === 'anulado'
      const pendiente = anulado ? 0 : _saldoCxC(cxc)
      const vencida   = !anulado && cxc.estado !== 'cobrado' && pendiente > 0.01 && cxc.fecha_vencimiento && cxc.fecha_vencimiento < hoy
      const dias      = anulado || cxc.estado === 'cobrado' ? null : (cxc.fecha_vencimiento ? diasVencidos(cxc.fecha_vencimiento) : null)
      const retPendienteSustentar = retencionPendientePorCxc[cxc.id] || 0
      if (!anulado) { tTotal += total; tCobrado += cobrado + retenido; tPend += pendiente }

      const badge = anulado ? 'badge-danger'
                  : cxc.estado === 'cobrado' ? 'badge-success'
                  : cxc.estado === 'parcial' ? 'badge-warning'
                  : vencida ? 'badge-danger' : 'badge-secondary'

      return `<tr ${anulado ? 'style="opacity:.55; text-decoration:line-through;" title="Comprobante anulado: no genera deuda"' : (vencida ? 'style="background:rgba(239,68,68,.06);"' : '')}>
        <td>${_esc(_nombreContacto(cxc.contact_id))}</td>
        <td>${_esc(`${cxc.tipo_comprobante || ''} ${cxc.serie || ''}-${cxc.numero_comprobante || ''}`)}${_htmlCuotas(cxc.id)}</td>
        <td>${fechaDMY(cxc.fecha_emision, '-')}</td>
        <td>${fechaDMY(cxc.fecha_vencimiento, '—')}</td>
        <td>${dias === null ? '—' : (dias > 0 ? `<span class="badge badge-vencido">+${dias}</span>` : `<span class="badge badge-alcorriente">${dias}</span>`)}</td>
        <td>${cxc.moneda || 'PEN'}</td>
        <td style="text-align:right;">${formatNumber(total)}</td>
        <td style="text-align:right;">${formatNumber(cobrado)}${retenido > 0 ? `<br><small style="color:var(--color-warning);">+ret. ${formatNumber(retenido)}</small>` : ''}${notasCr > 0 ? `<br><small style="color:var(--color-danger);">−NC ${formatNumber(notasCr)}</small>` : ''}${notasDb > 0 ? `<br><small style="color:var(--color-success);">+ND ${formatNumber(notasDb)}</small>` : ''}${parseFloat(cxc.monto_canjeado || 0) > 0 ? `<br><small style="color:var(--color-info);" title="Canjeado en letras: la deuda sigue en las letras">⇄ letras ${formatNumber(cxc.monto_canjeado)}</small>` : ''}${retPendienteSustentar > 0 ? `<br><span class="badge badge-warning" title="Retención de ${formatNumber(retPendienteSustentar)} aplicada al cobrar, sin N° de comprobante de retención del cliente todavía">⚠ pendiente sustentar ret.</span>` : ''}</td>
        <td style="text-align:right; font-weight:bold;">${formatNumber(pendiente)}</td>
        <td><span class="badge ${badge}">${cxc.estado}</span></td>
        <td style="white-space:nowrap;">${_menuDocCP('cxc', cxc)}</td>
      </tr>`
    }).join('')

    if (tfoot) tfoot.innerHTML = `
      <td colspan="6"><strong>TOTAL (${lista.filter(c => c.estado !== 'anulado').length} documentos${lista.some(c => c.estado === 'anulado') ? ` · ${lista.filter(c => c.estado === 'anulado').length} anulado(s) sin sumar` : ''})</strong></td>
      <td style="text-align:right;"><strong>${formatNumber(tTotal)}</strong></td>
      <td style="text-align:right;"><strong>${formatNumber(tCobrado)}</strong></td>
      <td style="text-align:right;"><strong>${formatNumber(tPend)}</strong></td>
      <td colspan="2"></td>`

    _poblarSelectCxC(_cxcList.filter(c => c.estado !== 'cobrado' && c.estado !== 'anulado'))
    calcularKPIs()
  } catch (e) {
    console.error('cargarCxC:', e)
    showToast('Error al cargar CxC: ' + e.message, 'danger')
  }
}

window.exportarCxC = function() {
  const lista = _filtrarCxC()
  descargarCSV(`cuentas_por_cobrar_${new Date().toISOString().slice(0, 10)}.csv`, [
    ['Cliente', 'Comprobante', 'F. Emisión', 'F. Vencimiento', 'Días', 'Moneda', 'Total', 'Cobrado', 'Retenido', 'Pendiente', 'Estado'],
    ...lista.map(c => [
      _nombreContacto(c.contact_id),
      `${c.tipo_comprobante || ''} ${c.serie || ''}-${c.numero_comprobante || ''}`,
      c.fecha_emision || '', c.fecha_vencimiento || '',
      c.fecha_vencimiento ? diasVencidos(c.fecha_vencimiento) : '',
      c.moneda || 'PEN',
      parseFloat(c.monto_total || 0).toFixed(2),
      parseFloat(c.monto_cobrado || 0).toFixed(2),
      parseFloat(c.monto_retenido || 0).toFixed(2),
      _saldoCxC(c).toFixed(2), c.estado || ''
    ])
  ])
}

function _poblarSelectCxC(lista) {
  const sel = document.getElementById('cobroSelectCxC')
  if (!sel) return
  sel.innerHTML = '<option value="">-- Seleccione CxC --</option>' + lista.map(cxc => {
    const pend = _saldoCxC(cxc).toFixed(2)
    return `<option value="${cxc.id}">${_esc(_nombreContacto(cxc.contact_id))} — ${_esc(`${cxc.tipo_comprobante || ''} ${cxc.serie || ''}-${cxc.numero_comprobante || ''}`)} (Pend: ${formatNumber(pend)} ${cxc.moneda || 'PEN'})</option>`
  }).join('')
  refrescarBuscador(sel)
}

// Registrar Cobro es un MODAL que flota sobre la tabla (patrón Nueva Venta).
window.abrirRegistrarCobro = function(cxcId = null) {
  const sel = document.getElementById('cobroSelectCxC')
  if (sel) { sel.value = cxcId || ''; refrescarBuscador('cobroSelectCxC'); window.onSelectCxC() }
  const f = document.getElementById('cobroFecha'); if (f && !f.value) f.value = new Date().toISOString().split('T')[0]
  _adjPendientes.cobro = []; _pintarAdjPendientes('cobro')
  window.openModal('modal-registrar-cobro')
}
window.irARegistrarCobro = function(cxcId) { window.abrirRegistrarCobro(cxcId) }

// ============================================================================
// RETENCIÓN EN EL COBRO
// ============================================================================

function _calcularRetencionPendiente(cxc) {
  const total    = parseFloat(cxc.monto_total || 0)
  const retenido = parseFloat(cxc.monto_retenido || 0)
  const saldoTotal = Math.max(0, _saldoCxC(cxc))
  const teorica = parseFloat((total * tasaRetencion()).toFixed(2))
  return Math.max(0, Math.min(teorica - retenido, saldoTotal))
}

window.onSelectCxC = function() {
  const cxcId = parseInt(document.getElementById('cobroSelectCxC')?.value || 0)
  const info      = document.getElementById('cobro-cxc-info')
  const bloqueRet = document.getElementById('cobro-retencion-block')
  const infoRet   = document.getElementById('cobro-retencion-info')
  const chkRet    = document.getElementById('cobroAplicarRetencion')

  if (!cxcId) {
    if (info) { info.innerHTML = ''; info.style.display = 'none' }
    if (bloqueRet) bloqueRet.style.display = 'none'
    _cobroRetencionPendiente = 0
    window._cpRecalc('cobro', 'doc')
    return
  }

  const cxc = _cxcList.find(c => c.id === cxcId)
  if (!cxc) return
  const contacto  = _contactsMap[cxc.contact_id]
  const total     = parseFloat(cxc.monto_total || 0)
  const saldoTotal = Math.max(0, _saldoCxC(cxc))
  const moneda    = cxc.moneda || 'PEN'

  if (info) { info.innerHTML = _cardDocCP(cxc, true, saldoTotal); info.style.display = 'block' }

  _cobroRetencionPendiente = contacto?.sujeto_retencion ? _calcularRetencionPendiente(cxc) : 0

  if (contacto?.sujeto_retencion && _cobroRetencionPendiente > 0) {
    if (bloqueRet) bloqueRet.style.display = 'block'
    if (infoRet) infoRet.textContent = `Retención ${(tasaRetencion() * 100).toFixed(0)}% sobre ${moneda} ${formatNumber(total)} = ${moneda} ${formatNumber(_cobroRetencionPendiente)}`
    if (chkRet) chkRet.checked = true
  } else {
    if (bloqueRet) bloqueRet.style.display = 'none'
    _cobroRetencionPendiente = 0
  }

  _actualizarMontoCobroConRetencion(saldoTotal)
  window._tcDefaultCP('cobro')
}

function _actualizarMontoCobroConRetencion(saldoTotal) {
  const montoInput = document.getElementById('cobroMonto')
  if (!montoInput) return
  const chkRet = document.getElementById('cobroAplicarRetencion')
  const aplica = chkRet && chkRet.checked && _cobroRetencionPendiente > 0
  montoInput.value = Math.max(0, aplica ? saldoTotal - _cobroRetencionPendiente : saldoTotal).toFixed(2)
  window._cpRecalc('cobro', 'doc')
}

window.onToggleRetencionCobro = function() {
  const cxcId = parseInt(document.getElementById('cobroSelectCxC')?.value || 0)
  const cxc = _cxcList.find(c => c.id === cxcId)
  if (!cxc) return
  _actualizarMontoCobroConRetencion(Math.max(0, _saldoCxC(cxc)))
}

// ============================================================================
// INTEGRACIÓN CON BANCOS
// ============================================================================
// Antes, elegir un banco al cobrar/pagar solo servía para el asiento contable:
// el saldo de la cuenta bancaria y sus movimientos quedaban desincronizados y
// había que digitarlos otra vez en el módulo Bancos. Ahora, si la opción está
// activa en Configuración, cada cobro/pago crea su movimiento y ajusta el
// saldo. Si el registro del movimiento falla, el cobro NO se revierte (el
// documento contable es lo crítico): solo se avisa.

async function _registrarMovimientoBancario({ bancoId, tipo, fecha, concepto, referencia, monto, categoria, cobroId = null, pagoId = null, asientoId = null, numeroOperacion = null, monedaMonto = null, tc = 1 }) {
  if (!_cfg.autoMovBanco || !bancoId || !(monto > 0)) return null
  try {
    // Saldo fresco desde BD: el mapa en memoria puede estar desactualizado
    // si otro cobro/pago o el módulo Bancos movió la cuenta.
    const banco = (await getBancoById(bancoId)) || _bancosMap[bancoId]
    // El movimiento va SIEMPRE en la moneda de la cuenta bancaria: una factura
    // en USD cobrada en la cuenta de soles entra como soles (monto × T.C.).
    if (monedaMonto && banco?.moneda && monedaMonto !== banco.moneda) {
      const original = monto
      monto = _r2(_convMoneda(monto, monedaMonto, banco.moneda, tc))
      concepto = `${concepto} (${monedaMonto} ${formatNumber(original)} × T.C. ${tc})`
    }
    const saldoPrevio = parseFloat(banco?.saldo_actual ?? banco?.saldo_inicial ?? 0)
    const saldoNuevo  = tipo === 'ingreso' ? saldoPrevio + monto : saldoPrevio - monto

    const mov = await addMovimientoBanco({
      banco_id: bancoId, fecha, tipo, concepto,
      categoria: categoria || (tipo === 'ingreso' ? 'Cobranza clientes' : 'Pago proveedores'),
      referencia: referencia || null,
      monto,
      saldo_posterior: parseFloat(saldoNuevo.toFixed(2)),
      reconciliado: !!_cfg.autoConciliar,
      cobro_id: cobroId,
      pago_proveedor_id: pagoId,
      asiento_id: asientoId,
      numero_operacion: numeroOperacion || referencia || null
    })
    // insert() devuelve null en error sin lanzar: no tocar el saldo si no se grabó.
    if (!mov?.id) throw new Error('no se pudo insertar el movimiento')
    // El saldo lo actualiza el TRIGGER trg_actualizar_saldo_banco (02_functions.sql)
    // al insertar/borrar el movimiento. NO tocar saldo_actual aquí: se duplicaba.
    const bFresco = await getBancoById(bancoId)
    if (bFresco && _bancosMap[bancoId]) _bancosMap[bancoId].saldo_actual = bFresco.saldo_actual
    invalidarVarios(['bancos', 'movimientos_banco'])
    return mov
  } catch (e) {
    console.warn('Movimiento bancario no registrado:', e.message)
    showToast('⚠️ El movimiento bancario no se registró: ' + e.message, 'warning')
    return null
  }
}

/** N° único de registro del movimiento bancario (enlace Bancos ↔ Contabilidad). */
const _numMB = id => `MB-${String(id).padStart(6, '0')}`

// ============================================================================
// REGISTRAR COBRO
// ============================================================================

window.registrarCobro = async function() {
  const btnTexto = '✅ Registrar Cobro y Generar Asiento'
  try {
    const cxcId      = parseInt(document.getElementById('cobroSelectCxC')?.value || 0)
    const fecha      = document.getElementById('cobroFecha')?.value
    const monto      = parseFloat(document.getElementById('cobroMonto')?.value || 0)
    const medioPago  = document.getElementById('cobroMedioPago')?.value
    const bancoId    = document.getElementById('cobroBanco')?.value
    const referencia = document.getElementById('cobroReferencia')?.value?.trim()
    const numeroRecibo = document.getElementById('cobroNumeroRecibo')?.value?.trim() || null
    const tipoCambio = _tcEfectivoCP('cobro')   // 8 decimales: reproduce exacto el importe recibido

    if (!cxcId)     { showToast('Selecciona una Cuenta por Cobrar', 'warning'); return }
    if (!fecha)     { showToast('Ingresa la fecha del cobro', 'warning'); return }
    if (monto <= 0) { showToast('El importe debe ser mayor a 0', 'warning'); return }

    const cxc = _cxcList.find(c => c.id === cxcId)
    if (!cxc) { showToast('Cuenta por Cobrar no encontrada', 'danger'); return }

    const contacto = _contactsMap[cxc.contact_id]
    const chkRet   = document.getElementById('cobroAplicarRetencion')
    const aplicaRet = !!(contacto?.sujeto_retencion && chkRet?.checked && _cobroRetencionPendiente > 0)
    const montoRetencion = aplicaRet ? _cobroRetencionPendiente : 0

    // Validación de sobre-cobro: no permitir cobrar más de lo pendiente.
    const saldo = _saldoCxC(cxc)
    if (monto + montoRetencion > saldo + 0.01) {
      showToast(`El cobro (${formatNumber(monto + montoRetencion)}) supera el saldo pendiente (${formatNumber(saldo)})`, 'warning')
      return
    }

    if (!_reciboValidoParaCliente(numeroRecibo, cxc.contact_id, null)) return

    const cobro = await addCobro({
      numero_recibo: numeroRecibo,
      cxc_id: cxcId, contact_id: cxc.contact_id, fecha, monto,
      moneda: cxc.moneda || 'PEN', tipo_cambio: tipoCambio,
      medio_pago: medioPago, referencia: referencia || null,
      banco_id: bancoId ? parseInt(bancoId) : null,
      numero_operacion: referencia || null,
      monto_retencion: montoRetencion
    })

    if (cobro?.id) {
      // Asiento + movimiento bancario + CxC + cuotas (misma rutina que usa Editar)
      var _imputacion = await _aplicarEfectosCobro(cobro, cxc)
      await _subirAdjuntosPendientes('cobro', 'cobro', cobro.id)
    }

    const detalleCuotas = _describirImputacion(typeof _imputacion !== 'undefined' ? _imputacion.aplicaciones : [])
    showToast(montoRetencion > 0
      ? `Cobro registrado ✅${detalleCuotas} — incluye S/ ${formatNumber(montoRetencion)} de retención IGV`
      : `Cobro registrado ✅${detalleCuotas}`, 'success')

    window.closeModal('modal-registrar-cobro')
    document.getElementById('cobroSelectCxC').value  = ''
    document.getElementById('cobroMonto').value      = ''
    document.getElementById('cobroMontoRecibido').value = ''
    document.getElementById('cobroReferencia').value = ''
    document.getElementById('cobroNumeroRecibo').value = ''
    document.getElementById('cobro-cxc-info').textContent = ''
    document.getElementById('cobro-retencion-block').style.display = 'none'
    _cobroRetencionPendiente = 0

    _refrescarTodo()
    await Promise.all([cargarCxC(), cargarCobrosRecientes(), cargarRetenciones()])
  } catch (e) {
    console.error('registrarCobro:', e)
    showToast('Error al registrar cobro: ' + e.message, 'danger')
  }
  void btnTexto
}

// ============================================================================
// COBROS RECIENTES
// ============================================================================

async function cargarCobrosRecientes() {
  try {
    _cobrosList = await cacheado('cobros', getCobros)
    _adjConteo.cobro = await getConteoAdjuntos('cobro')
    window.filtrarCobrosRecientes()
  } catch (e) { console.error('cargarCobrosRecientes:', e) }
}

window.filtrarCobrosRecientes = function() {
  const tbody = document.getElementById('tbody-cobros-recientes')
  if (!tbody) return
  const q = (document.getElementById('buscarCobro')?.value || '').toLowerCase().trim()

  let lista = [..._cobrosList].sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || b.id - a.id)
  if (q) lista = lista.filter(c => `${c.numero_recibo || ''} ${_nombreContacto(c.contact_id)} ${c.referencia || ''} ${c.medio_pago || ''}`.toLowerCase().includes(q))
  lista = lista.slice(0, 50)

  if (lista.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;">Sin cobros registrados</td></tr>'
    return
  }

  tbody.innerHTML = lista.map(c => `<tr>
    <td data-sort="${_esc(c.numero_recibo || '')}"><input type="text" class="input-recibo" value="${_esc(c.numero_recibo || '')}" placeholder="—"
        title="N° del recibo de cobranza físico — escribe y presiona Enter"
        onkeydown="if(event.key==='Enter'){this.blur()} else if(event.key==='Escape'){this.value=this.defaultValue; this.blur()}"
        onchange="window.guardarNumeroRecibo(${c.id}, this)"></td>
    <td>${fechaDMY(c.fecha, '-')}</td>
    <td>${_esc(_nombreContacto(c.contact_id))}</td>
    <td style="text-align:right; font-weight:bold;">${formatNumber(c.monto)}</td>
    <td style="text-align:right; color:var(--color-warning);">${parseFloat(c.monto_retencion || 0) > 0 ? formatNumber(c.monto_retencion) : '—'}</td>
    <td>${c.medio_pago || '-'}</td>
    <td>${_esc(_bancosMap[c.banco_id]?.nombre || '—')}</td>
    <td>${_esc(c.referencia || '-')}${_clipAdjunto('cobro', c.id)}</td>
    <td>${c.asiento_id ? `AS-${String(c.asiento_id).padStart(6, '0')}` : '—'}</td>
    <td style="white-space:nowrap;">${_botonesCP('cobro', c.id)}</td>
  </tr>`).join('')
}

// Un N° de recibo puede repetirse en vouchers del MISMO cliente (un recibo,
// varios vouchers). Si ya está en un cobro de OTRO cliente → confirmar.
function _reciboValidoParaCliente(numero, contactId, excluirId) {
  const n = (numero || '').trim().toLowerCase()
  if (!n) return true
  const otro = _cobrosList.find(x => x.id !== excluirId && (x.numero_recibo || '').trim().toLowerCase() === n && x.contact_id !== contactId)
  if (!otro) return true
  return confirm(`El recibo N° ${numero} ya está en un cobro de OTRO cliente (${fechaDMY(otro.fecha)} — ${_nombreContacto(otro.contact_id)}, ${formatNumber(otro.monto)}).\n\n¿Guardar igual?`)
}

// Cobros (vouchers) que comparten el N° de recibo de `reg` — desde BD para
// que funcione aunque el tab Cobros no se haya cargado. 2026-10-07
async function _cobrosDelRecibo(reg) {
  const n = (reg?.numero_recibo || '').trim()
  if (!n) return []
  try {
    const { data, error } = await supabase.from('cobros').select('*').ilike('numero_recibo', n)
    if (error) throw error
    return (data || []).sort((a, b) => (a.fecha || '').localeCompare(b.fecha || '') || a.id - b.id)
  } catch (e) {
    console.warn('_cobrosDelRecibo:', e.message)
    return _cobrosList.filter(x => (x.numero_recibo || '').trim().toLowerCase() === n.toLowerCase())
  }
}

function _htmlSeccionRecibo(reg, lista) {
  if (!reg?.numero_recibo || !lista?.length) return ''
  const total = lista.reduce((s, x) => s + (parseFloat(x.monto) || 0), 0)
  const otroCli = lista.some(x => x.contact_id !== reg.contact_id)
  return `<h4 style="margin:16px 0 6px;">🧾 Recibo N° ${_esc(reg.numero_recibo)} — ${lista.length} voucher(s)</h4>
    ${otroCli ? '<div style="padding:6px 10px; border-left:3px solid var(--color-danger); background:var(--bg-secondary); font-size:0.82rem; margin-bottom:6px;">⚠ Este N° de recibo también está en cobros de otro cliente: revisa si es un error de tipeo.</div>' : ''}
    <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); overflow:hidden; overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; margin:0;">
        <thead><tr style="background:var(--bg-secondary);"><th>Fecha</th><th>Cliente</th><th>Documento</th><th>Banco</th><th>Referencia</th><th style="text-align:right;">Monto</th><th></th></tr></thead>
        <tbody>${lista.map(x => {
          const cxc = _cxcList.find(d => d.id === x.cxc_id)
          const docTxt = cxc ? `${cxc.serie ? cxc.serie + '-' : ''}${cxc.numero_comprobante || ''}` : '—'
          const actual = x.id === reg.id
          return `<tr style="border-top:1px solid var(--border-color);${actual ? ' background:rgba(59,130,246,0.08); font-weight:600;' : ''}${x.contact_id !== reg.contact_id ? ' color:var(--color-danger);' : ''}">
            <td>${fechaDMY(x.fecha)}</td><td>${_esc(_nombreContacto(x.contact_id))}</td><td>${_esc(docTxt)}</td>
            <td>${_esc(_bancosMap[x.banco_id]?.nombre || '—')}</td><td>${_esc(x.referencia || '—')}${_clipAdjunto('cobro', x.id)}</td>
            <td style="text-align:right;">${formatNumber(x.monto)}</td>
            <td style="white-space:nowrap;">${actual ? '<small style="color:var(--text-secondary);">este</small>' : _botonesCP('cobro', x.id)}</td></tr>`
        }).join('')}</tbody>
        <tfoot><tr style="border-top:2px solid var(--border-color); font-weight:bold;"><td colspan="5">Total del recibo</td><td style="text-align:right;">${formatNumber(total)}</td><td></td></tr></tfoot>
      </table>
    </div>`
}

// N° de recibo de cobranza físico, editable en la celda (2026-10-07, SQL 74).
// Se guarda al salir del campo / Enter; avisa si ese N° ya está en otro cobro.
window.guardarNumeroRecibo = async function (cobroId, input) {
  const nuevo = (input.value || '').trim()
  const c = _cobrosList.find(x => x.id === cobroId)
  if (!c) return
  const anterior = c.numero_recibo || ''
  if (nuevo === anterior) return
  // Un recibo puede agrupar VARIOS vouchers (cobros) del MISMO cliente: eso
  // es válido y no pregunta. Solo avisa si el N° ya está en un cobro de OTRO
  // cliente (casi seguro un error de tipeo). 2026-10-07
  let mismos = []
  if (nuevo) {
    const conN = _cobrosList.filter(x => x.id !== cobroId && (x.numero_recibo || '').trim().toLowerCase() === nuevo.toLowerCase())
    const otroCli = conN.find(x => x.contact_id !== c.contact_id)
    if (otroCli && !confirm(`El recibo N° ${nuevo} ya está en un cobro de OTRO cliente (${fechaDMY(otroCli.fecha)} — ${_nombreContacto(otroCli.contact_id)}, ${formatNumber(otroCli.monto)}).\n\n¿Guardar igual?`)) {
      input.value = anterior; return
    }
    mismos = conN.filter(x => x.contact_id === c.contact_id)
  }
  input.disabled = true
  try {
    const r = await updateCobro(cobroId, { numero_recibo: nuevo || null })
    if (!r) throw new Error('¿ya corriste el SQL 74?')
    c.numero_recibo = nuevo || null
    input.defaultValue = nuevo
    input.closest('td')?.setAttribute('data-sort', nuevo)
    input.style.borderColor = 'var(--color-success)'
    setTimeout(() => { input.style.borderColor = '' }, 1200)
    if (!nuevo) showToast('N° de recibo borrado', 'success')
    else if (mismos.length) {
      const total = [c, ...mismos].reduce((s, x) => s + (parseFloat(x.monto) || 0), 0)
      showToast(`Recibo ${nuevo}: ${mismos.length + 1} vouchers, total ${formatNumber(total)}`, 'success', 4500)
    } else showToast(`Recibo N° ${nuevo} guardado`, 'success')
  } catch (e) {
    input.value = anterior
    showToast('No se pudo guardar el N° de recibo: ' + e.message, 'danger')
  } finally {
    input.disabled = false
  }
}

// ============================================================================
// CxP — LISTADO
// ============================================================================

function _filtrarCxP() {
  const buscar = (document.getElementById('cxp-buscar')?.value || '').toLowerCase().trim()
  const estado = document.getElementById('cxp-filtro-estado')?.value || ''
  const moneda = document.getElementById('cxp-filtro-moneda')?.value || ''
  const desde  = document.getElementById('cxp-filtro-desde')?.value || ''
  const hasta  = document.getElementById('cxp-filtro-hasta')?.value || ''

  return _cxpList.filter(c => {
    if (!estado) { if (c.estado === 'pagado' || c.estado === 'anulado') return false }
    else if (estado !== '_todos' && c.estado !== estado) return false
    if (moneda && (c.moneda || 'PEN') !== moneda) return false
    if (desde && (c.fecha_emision || '') < desde) return false
    if (hasta && (c.fecha_emision || '') > hasta) return false
    if (buscar) {
      const txt = `${_nombreContacto(c.contact_id)} ${c.tipo_comprobante || ''} ${c.serie || ''} ${c.numero_comprobante || ''}`.toLowerCase()
      if (!txt.includes(buscar)) return false
    }
    return true
  })
}

window.cargarCxP = async function() {
  try {
    _cxpList = await cacheado('cuentas_pagar', getCuentasPagar)
    _pagosList = await cacheado('pagos_proveedores', getPagosProveedores)
    _letrasCache = await cacheado('letras_cambio', getLetrasCambio)
    const lista = _filtrarCxP().sort((a, b) => (a.fecha_emision || '').localeCompare(b.fecha_emision || ''))

    const tbody = document.getElementById('tbody-cxp')
    const tfoot = document.getElementById('tfoot-cxp')
    if (!tbody) return

    if (lista.length === 0) {
      tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;">Sin cuentas por pagar para los filtros seleccionados</td></tr>'
      if (tfoot) tfoot.innerHTML = ''
      _poblarSelectCxP([])
      calcularKPIs()
      return
    }

    let tTotal = 0, tPagado = 0, tPend = 0
    tbody.innerHTML = lista.map(cxp => {
      const total  = parseFloat(cxp.monto_total || 0)
      const pagado = parseFloat(cxp.monto_pagado || 0)
      const nCr    = parseFloat(cxp.monto_notas_credito || 0)
      const nDb    = parseFloat(cxp.monto_notas_debito || 0)
      const antAp  = parseFloat(cxp.monto_anticipo_aplicado || 0)
      const anulado = cxp.estado === 'anulado'
      const pend   = anulado ? 0 : _saldoCxP(cxp)
      const dias   = anulado || cxp.estado === 'pagado' ? null : (cxp.fecha_vencimiento ? diasVencidos(cxp.fecha_vencimiento) : null)
      if (!anulado) { tTotal += total; tPagado += pagado; tPend += pend }

      const badge = anulado ? 'badge-danger'
                  : cxp.estado === 'pagado' ? 'badge-success'
                  : cxp.estado === 'parcial' ? 'badge-warning' : 'badge-secondary'

      return `<tr ${anulado ? 'style="opacity:.55; text-decoration:line-through;" title="Comprobante anulado: no genera deuda"' : ''}>
        <td>${_esc(_nombreContacto(cxp.contact_id))}</td>
        <td>${_esc(`${cxp.tipo_comprobante || ''} ${cxp.serie || ''}-${cxp.numero_comprobante || ''}`)}</td>
        <td>${fechaDMY(cxp.fecha_emision, '-')}</td>
        <td>${fechaDMY(cxp.fecha_vencimiento, '—')}</td>
        <td>${dias === null ? '—' : (dias > 0 ? `<span class="badge badge-vencido">+${dias}</span>` : `<span class="badge badge-alcorriente">${dias}</span>`)}</td>
        <td>${cxp.moneda || 'PEN'}</td>
        <td style="text-align:right;">${formatNumber(total)}</td>
        <td style="text-align:right;">${formatNumber(pagado)}${nCr > 0 ? `<br><small style="color:var(--color-danger);">−NC ${formatNumber(nCr)}</small>` : ''}${nDb > 0 ? `<br><small style="color:var(--color-success);">+ND ${formatNumber(nDb)}</small>` : ''}</td>
        <td style="text-align:right; font-weight:bold;">${formatNumber(pend)}</td>
        <td><span class="badge ${badge}">${cxp.estado || 'pendiente'}</span></td>
        <td style="white-space:nowrap;">${_menuDocCP('cxp', cxp)}</td>
      </tr>`
    }).join('')

    if (tfoot) tfoot.innerHTML = `
      <td colspan="6"><strong>TOTAL (${lista.length} documentos)</strong></td>
      <td style="text-align:right;"><strong>${formatNumber(tTotal)}</strong></td>
      <td style="text-align:right;"><strong>${formatNumber(tPagado)}</strong></td>
      <td style="text-align:right;"><strong>${formatNumber(tPend)}</strong></td>
      <td colspan="2"></td>`

    _poblarSelectCxP(_cxpList.filter(c => c.estado !== 'pagado' && c.estado !== 'anulado'))
    calcularKPIs()
  } catch (e) {
    console.error('cargarCxP:', e)
    showToast('Error al cargar CxP: ' + e.message, 'danger')
  }
}

window.exportarCxP = function() {
  const lista = _filtrarCxP()
  descargarCSV(`cuentas_por_pagar_${new Date().toISOString().slice(0, 10)}.csv`, [
    ['Proveedor', 'Comprobante', 'F. Emisión', 'F. Vencimiento', 'Moneda', 'Total', 'Pagado', 'Pendiente', 'Estado'],
    ...lista.map(c => [
      _nombreContacto(c.contact_id),
      `${c.tipo_comprobante || ''} ${c.serie || ''}-${c.numero_comprobante || ''}`,
      c.fecha_emision || '', c.fecha_vencimiento || '', c.moneda || 'PEN',
      parseFloat(c.monto_total || 0).toFixed(2),
      parseFloat(c.monto_pagado || 0).toFixed(2),
      _saldoCxP(c).toFixed(2), c.estado || ''
    ])
  ])
}

function _poblarSelectCxP(lista) {
  const sel = document.getElementById('pagoSelectCompra')
  if (!sel) return
  sel.innerHTML = '<option value="">-- Seleccione Compra --</option>' + lista.map(cxp => {
    const pend = _saldoCxP(cxp).toFixed(2)
    return `<option value="${cxp.id}" data-pendiente="${pend}" data-moneda="${cxp.moneda || 'PEN'}">${_esc(_nombreContacto(cxp.contact_id))} — ${_esc(`${cxp.tipo_comprobante || ''} ${cxp.serie || ''}-${cxp.numero_comprobante || ''}`)} (Pend: ${formatNumber(pend)} ${cxp.moneda || 'PEN'})</option>`
  }).join('')
  refrescarBuscador(sel)
}

window.abrirRegistrarPago = function(cxpId = null) {
  const sel = document.getElementById('pagoSelectCompra')
  if (sel) { sel.value = cxpId || ''; refrescarBuscador('pagoSelectCompra'); window.onSelectCompra() }
  const f = document.getElementById('pagoFecha'); if (f && !f.value) f.value = new Date().toISOString().split('T')[0]
  _adjPendientes.pago = []; _pintarAdjPendientes('pago')
  window.openModal('modal-registrar-pago')
}
window.irARegistrarPago = function(cxpId) { window.abrirRegistrarPago(cxpId) }

window.onSelectCompra = function() {
  const cxpId = parseInt(document.getElementById('pagoSelectCompra')?.value || 0)
  const info  = document.getElementById('pago-compra-info')
  const cxp   = _cxpList.find(c => c.id === cxpId)
  if (!cxp) {
    if (info) { info.innerHTML = ''; info.style.display = 'none' }
    window._cpRecalc('pago', 'doc')
    return
  }
  const pendiente = Math.max(0, _saldoCxP(cxp))
  if (info) { info.innerHTML = _cardDocCP(cxp, false, pendiente); info.style.display = 'block' }
  document.getElementById('pagoMonto').value = pendiente.toFixed(2)
  window._cpRecalc('pago', 'doc')
  window._tcDefaultCP('pago')
}

// ============================================================================
// REGISTRAR PAGO A PROVEEDOR
// ============================================================================

window.registrarPagoProveedor = async function() {
  try {
    const cxpId      = parseInt(document.getElementById('pagoSelectCompra')?.value || 0)
    const fecha      = document.getElementById('pagoFecha')?.value
    const monto      = parseFloat(document.getElementById('pagoMonto')?.value || 0)
    const tipoCambio = _tcEfectivoCP('pago')
    const medioPago  = document.getElementById('pagoMedioPago')?.value
    const bancoId    = document.getElementById('pagoBanco')?.value
    const referencia = document.getElementById('pagoReferencia')?.value?.trim()

    if (!cxpId)     { showToast('Selecciona una Cuenta por Pagar', 'warning'); return }
    if (!fecha)     { showToast('Ingresa la fecha del pago', 'warning'); return }
    if (monto <= 0) { showToast('El monto debe ser mayor a 0', 'warning'); return }

    const cxp = _cxpList.find(c => c.id === cxpId)
    if (!cxp) { showToast('Cuenta por Pagar no encontrada', 'danger'); return }
    const moneda = cxp.moneda || 'PEN'   // monto = importe aplicado en la moneda de la factura

    const saldo = _saldoCxP(cxp)
    if (monto > saldo + 0.01) {
      showToast(`El pago (${formatNumber(monto)}) supera el saldo pendiente (${formatNumber(saldo)})`, 'warning')
      return
    }

    const pago = await addPagoProveedor({
      cxp_id: cxpId, compra_id: cxp.compra_id, contact_id: cxp.contact_id,
      fecha, monto, moneda, tipo_cambio: tipoCambio,
      medio_pago: medioPago, referencia: referencia || null,
      banco_id: bancoId ? parseInt(bancoId) : null
    })

    if (pago?.id) {
      // Asiento + movimiento bancario + CxP + cuotas (misma rutina que usa Editar)
      await _aplicarEfectosPago(pago, cxp)
      await _subirAdjuntosPendientes('pago', 'pago', pago.id)
    }

    showToast('Pago a proveedor registrado ✅', 'success')

    window.closeModal('modal-registrar-pago')
    document.getElementById('pagoSelectCompra').value = ''
    document.getElementById('pagoMonto').value        = ''
    document.getElementById('pagoMontoMoneda').value  = ''
    document.getElementById('pagoReferencia').value   = ''
    document.getElementById('pago-compra-info').textContent = ''

    _refrescarTodo()
    await Promise.all([cargarCxP(), cargarPagosRecientes()])
  } catch (e) {
    console.error('registrarPagoProveedor:', e)
    showToast('Error al registrar pago: ' + e.message, 'danger')
  }
}

async function cargarPagosRecientes() {
  try {
    _pagosList = await cacheado('pagos_proveedores', getPagosProveedores)
    _adjConteo.pago = await getConteoAdjuntos('pago')
    window.filtrarPagosRecientes()
  } catch (e) { console.error('cargarPagosRecientes:', e) }
}

window.filtrarPagosRecientes = function() {
  const tbody = document.getElementById('tbody-pagos-recientes')
  if (!tbody) return
  const q = (document.getElementById('buscarPago')?.value || '').toLowerCase().trim()

  let lista = [..._pagosList].sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || b.id - a.id)
  if (q) lista = lista.filter(p => `${_nombreContacto(p.contact_id)} ${p.referencia || ''} ${p.medio_pago || ''}`.toLowerCase().includes(q))
  lista = lista.slice(0, 50)

  if (lista.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;">Sin pagos registrados</td></tr>'
    return
  }

  tbody.innerHTML = lista.map(p => `<tr>
    <td>${fechaDMY(p.fecha, '-')}</td>
    <td>${_esc(_nombreContacto(p.contact_id))}</td>
    <td style="text-align:right; font-weight:bold;">${formatNumber(p.monto)}</td>
    <td>${p.moneda || 'PEN'}</td>
    <td>${p.medio_pago || '-'}</td>
    <td>${_esc(_bancosMap[p.banco_id]?.nombre || '—')}</td>
    <td>${_esc(p.referencia || '-')}${_clipAdjunto('pago', p.id)}</td>
    <td style="white-space:nowrap;">${_botonesCP('pago', p.id)}</td>
  </tr>`).join('')
}

// ============================================================================
// RETENCIONES IGV
// ============================================================================

window.cargarRetenciones = async function() {
  try {
    const periodo = document.getElementById('retencionesPeriodo')?.value
    const [cobros, cxcList] = await Promise.all([
      cacheado('cobros', getCobros), cacheado('cuentas_cobrar', getCuentasCobrar)
    ])
    const cxcMap = {}
    for (const c of (cxcList || [])) cxcMap[c.id] = c

    let retenciones = (cobros || []).filter(c => (parseFloat(c.monto_retencion) || 0) > 0)
    if (periodo) retenciones = retenciones.filter(c => (c.fecha || '').startsWith(periodo))
    retenciones.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''))

    const tbody   = document.getElementById('tbody-retenciones')
    const totalEl = document.getElementById('retenciones-total')
    if (!tbody) return

    if (retenciones.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Sin retenciones en el periodo</td></tr>'
      if (totalEl) totalEl.textContent = 'S/ 0.00'
      return
    }

    let total = 0
    tbody.innerHTML = retenciones.map(c => {
      const cxc = cxcMap[c.cxc_id]
      const comprobante = cxc ? `${cxc.tipo_comprobante || ''} ${cxc.serie || ''}-${cxc.numero_comprobante || ''}` : '-'
      const monto = parseFloat(c.monto_retencion) || 0
      total += monto
      return `<tr>
        <td>${fechaDMY(c.fecha, '-')}</td>
        <td>${_esc(_nombreContacto(c.contact_id))}</td>
        <td>${_esc(comprobante)}</td>
        <td style="text-align:right; font-weight:bold;">${formatNumber(monto)}</td>
        <td>${c.numero_comprobante_retencion ? _esc(c.numero_comprobante_retencion) : '<span class="badge badge-warning" title="Edita el cobro (✏️) para registrar el N° del comprobante de retención">⚠ pendiente</span>'}</td>
        <td style="white-space:nowrap;">${_botonesCP('cobro', c.id)}</td>
      </tr>`
    }).join('')

    if (totalEl) totalEl.textContent = `S/ ${formatNumber(total)}`
  } catch (e) {
    console.error('cargarRetenciones:', e)
    showToast('Error al cargar retenciones: ' + e.message, 'danger')
  }
}

window.guardarComprobanteRetencion = async function(cobroId) {
  try {
    const valor = document.getElementById(`ret-comp-${cobroId}`)?.value?.trim() || null
    await updateCobro(cobroId, { numero_comprobante_retencion: valor })
    invalidarVarios(['cobros'])
    showToast('N° de comprobante de retención guardado ✅', 'success')
  } catch (e) {
    showToast('Error al guardar: ' + e.message, 'danger')
  }
}

window.exportarRetenciones = async function() {
  const periodo = document.getElementById('retencionesPeriodo')?.value
  const [cobros, cxcList] = await Promise.all([cacheado('cobros', getCobros), cacheado('cuentas_cobrar', getCuentasCobrar)])
  const cxcMap = {}; (cxcList || []).forEach(c => { cxcMap[c.id] = c })
  let rows = (cobros || []).filter(c => (parseFloat(c.monto_retencion) || 0) > 0)
  if (periodo) rows = rows.filter(c => (c.fecha || '').startsWith(periodo))
  descargarCSV(`retenciones_igv_${periodo || 'todas'}.csv`, [
    ['Fecha', 'Cliente', 'Comprobante', 'Monto retenido', 'N° Comprobante Retención'],
    ...rows.map(c => {
      const cxc = cxcMap[c.cxc_id]
      return [c.fecha || '', _nombreContacto(c.contact_id),
        cxc ? `${cxc.tipo_comprobante || ''} ${cxc.serie || ''}-${cxc.numero_comprobante || ''}` : '',
        parseFloat(c.monto_retencion || 0).toFixed(2), c.numero_comprobante_retencion || '']
    })
  ])
}

// Pendiente por diseño: el cruce contra el IGV por pagar del periodo depende
// de cómo se cierre el Registro de Ventas en Contabilidad (etapa siguiente).
window.aplicarDeduccionRetenciones = function() {
  showToast('Función en desarrollo: por ahora usa esta lista y el CSV para tu control del IGV del periodo.', 'info')
}

// ============================================================================
// REPORTES (tablas dinámicas) — se construyen al abrir cada sub-tab
// ============================================================================

/** Todos los abonos de letras (cacheado). Vacío si aún no se corre el SQL 77. */
async function _abonosTodosCache() {
  try {
    return await cacheado('letras_abonos', async () => {
      const { data, error } = await supabase.from('letras_abonos').select('*').order('fecha')
      if (error) throw error
      return data || []
    })
  } catch (e) { console.warn('letras_abonos:', e.message); return [] }
}

/** Fila de reporte de cobranza/pagos a partir de un abono de letra. */
function _filaReporteAbono(a, campoContacto) {
  const l = _letrasCache.find(x => x.id === a.letra_id)
  const neto = Math.abs(parseFloat(a.monto_neto || 0))
  return {
    origen: 'Letra',
    documento: l ? `Letra ${l.numero_letra}` : (a.refinanciacion_id ? `Refinanciación #${a.refinanciacion_id}` : 'Letra'),
    recibo: a.numero_recibo || '(sin recibo)',
    [campoContacto]: _nombreContacto(a.contact_id ?? l?.contact_id),
    mes: nombreMes((a.fecha || '').slice(0, 7)),
    medio: a.medio || '(sin medio)',
    banco: _bancosMap[a.banco_id]?.nombre || '(sin banco)',
    moneda: a.moneda || l?.moneda || 'PEN',
    fecha: a.fecha || '',
    monto: neto,
    retencion: 0,
    interes: parseFloat(a.interes || 0),
    gastos: _r2((parseFloat(a.gasto_portes) || 0) + (parseFloat(a.gasto_comision) || 0) + (parseFloat(a.gasto_otros) || 0)),
    total_aplicado: parseFloat(a.monto_amortizado || 0)
  }
}

function construirReporte(panelId) {
  if (_reportesListos[panelId]) return
  _reportesListos[panelId] = true

  const hoy = new Date().toISOString().split('T')[0]

  if (panelId === 'rep-estado-cuenta') { construirEstadoCuenta(); return }
  if (panelId === 'rep-antiguedad-cxc') { construirAntiguedadCxC(); return }
  if (panelId === '__rep-antiguedad-cxc-viejo') {
    const datos = _cxcList
      .filter(c => c.estado !== 'anulado')
      .map(c => {
        const saldo = _saldoCxC(c)
        const dias  = c.fecha_vencimiento ? diasVencidos(c.fecha_vencimiento) : 0
        return {
          cliente: _nombreContacto(c.contact_id),
          tramo: c.estado === 'cobrado' ? '5 · Cobrado' : tramoAntiguedad(dias),
          estado: c.estado, moneda: c.moneda || 'PEN',
          mes: nombreMes((c.fecha_emision || '').slice(0, 7)),
          comprobante: `${c.tipo_comprobante || ''} ${c.serie || ''}-${c.numero_comprobante || ''}`,
          fecha_emision: c.fecha_emision || '', fecha_vencimiento: c.fecha_vencimiento || '',
          total: parseFloat(c.monto_total || 0),
          cobrado: parseFloat(c.monto_cobrado || 0),
          retenido: parseFloat(c.monto_retenido || 0),
          notas: parseFloat(c.monto_notas_debito || 0) - parseFloat(c.monto_notas_credito || 0),
          pendiente: saldo,
          vencido: (c.estado !== 'cobrado' && c.fecha_vencimiento && c.fecha_vencimiento < hoy) ? saldo : 0
        }
      })

    crearReporte('rep-antiguedad-cxc', {
      id: 'rep-antiguedad-cxc',
      titulo: 'Antigüedad de saldos — Cuentas por Cobrar',
      descripcion: 'Cuánto te deben y hace cuánto. Agrupa por cliente, tramo de mora o mes para ver dónde está atorada la cobranza.',
      datos,
      dimensiones: [
        { key: 'tramo', label: 'Tramo de mora' }, { key: 'cliente', label: 'Cliente' },
        { key: 'estado', label: 'Estado' }, { key: 'moneda', label: 'Moneda' },
        { key: 'mes', label: 'Fecha emisión', tipo: 'fecha', campo: 'fecha_emision' }
      ],
      medidas: [
        { key: 'total', label: 'Facturado', agg: 'sum', formato: 'money' },
        { key: 'cobrado', label: 'Cobrado', agg: 'sum', formato: 'money' },
        { key: 'retenido', label: 'Retenido', agg: 'sum', formato: 'money' },
        { key: 'notas', label: 'Notas (ND−NC)', agg: 'sum', formato: 'money', semaforo: true },
        { key: 'pendiente', label: 'Pendiente', agg: 'sum', formato: 'money' },
        { key: 'vencido', label: 'Vencido', agg: 'sum', formato: 'money' }
      ],
      filtros: [
        { key: 'cliente', label: 'Cliente', tipo: 'texto', campos: ['cliente', 'comprobante'], placeholder: 'Buscar...' },
        { key: 'estado', label: 'Estado', tipo: 'select', opciones: ['pendiente', 'parcial', 'cobrado'] },
        { key: 'moneda', label: 'Moneda', tipo: 'select', opciones: ['PEN', 'USD'] },
        { key: 'rango', label: 'Emisión', tipo: 'rango', campo: 'fecha_emision' }
      ],
      agruparPorDefecto: ['tramo'],
      medidasPorDefecto: ['total', 'cobrado', 'pendiente', 'vencido'],
      kpis: (filas) => {
        const pend = filas.reduce((s, f) => s + f.pendiente, 0)
        const venc = filas.reduce((s, f) => s + f.vencido, 0)
        return [
          { label: 'Facturado', valor: filas.reduce((s, f) => s + f.total, 0), formato: 'money' },
          { label: 'Pendiente', valor: pend, formato: 'money', color: 'var(--color-warning)' },
          { label: 'Vencido', valor: venc, formato: 'money', color: 'var(--color-danger)' },
          { label: '% vencido', valor: pend ? (venc / pend * 100) : 0, formato: 'pct' },
          { label: 'Documentos', valor: filas.length, formato: 'int' }
        ]
      }
    })
  }

  if (panelId === 'rep-antiguedad-cxp') {
    const datos = _cxpList
      .filter(c => c.estado !== 'anulado')
      .map(c => {
        const saldo = _saldoCxP(c)
        const dias  = c.fecha_vencimiento ? diasVencidos(c.fecha_vencimiento) : 0
        return {
          proveedor: _nombreContacto(c.contact_id),
          tramo: c.estado === 'pagado' ? '5 · Pagado' : tramoAntiguedad(dias),
          estado: c.estado, moneda: c.moneda || 'PEN',
          mes: nombreMes((c.fecha_emision || '').slice(0, 7)),
          comprobante: `${c.tipo_comprobante || ''} ${c.serie || ''}-${c.numero_comprobante || ''}`,
          fecha_emision: c.fecha_emision || '',
          total: parseFloat(c.monto_total || 0),
          pagado: parseFloat(c.monto_pagado || 0),
          notas: parseFloat(c.monto_notas_debito || 0) - parseFloat(c.monto_notas_credito || 0),
          pendiente: saldo
        }
      })

    crearReporte('rep-antiguedad-cxp', {
      id: 'rep-antiguedad-cxp',
      titulo: 'Antigüedad de saldos — Cuentas por Pagar',
      descripcion: 'Cuánto debes y a quién. Útil para priorizar pagos y proyectar salidas de caja.',
      datos,
      dimensiones: [
        { key: 'tramo', label: 'Tramo' }, { key: 'proveedor', label: 'Proveedor' },
        { key: 'estado', label: 'Estado' }, { key: 'moneda', label: 'Moneda' },
        { key: 'mes', label: 'Fecha emisión', tipo: 'fecha', campo: 'fecha_emision' }
      ],
      medidas: [
        { key: 'total', label: 'Comprado', agg: 'sum', formato: 'money' },
        { key: 'pagado', label: 'Pagado', agg: 'sum', formato: 'money' },
        { key: 'notas', label: 'Notas (ND−NC)', agg: 'sum', formato: 'money', semaforo: true },
        { key: 'pendiente', label: 'Pendiente', agg: 'sum', formato: 'money' }
      ],
      filtros: [
        { key: 'proveedor', label: 'Proveedor', tipo: 'texto', campos: ['proveedor', 'comprobante'], placeholder: 'Buscar...' },
        { key: 'estado', label: 'Estado', tipo: 'select', opciones: ['pendiente', 'parcial', 'pagado'] },
        { key: 'moneda', label: 'Moneda', tipo: 'select', opciones: ['PEN', 'USD'] },
        { key: 'rango', label: 'Emisión', tipo: 'rango', campo: 'fecha_emision' }
      ],
      agruparPorDefecto: ['proveedor'],
      kpis: (filas) => [
        { label: 'Comprado', valor: filas.reduce((s, f) => s + f.total, 0), formato: 'money' },
        { label: 'Pagado', valor: filas.reduce((s, f) => s + f.pagado, 0), formato: 'money', color: 'var(--color-success)' },
        { label: 'Por pagar', valor: filas.reduce((s, f) => s + f.pendiente, 0), formato: 'money', color: 'var(--color-danger)' },
        { label: 'Documentos', valor: filas.length, formato: 'int' }
      ]
    })
  }

  if (panelId === 'rep-cobros') { (async () => {
    // Cobros de facturas + abonos de letras emitidas (cobro total, parcial, en banco, renovación…)
    const abonos = (await _abonosTodosCache()).filter(a => a.tipo === 'emitida')
    if (!_letrasCache.length) _letrasCache = await cacheado('letras_cambio', getLetrasCambio)
    const datos = [
      ..._cobrosList.map(c => {
        const cxc = _cxcList.find(d => d.id === c.cxc_id)
        return {
          origen: 'Factura', documento: cxc ? _descDocCP(cxc) : '—', recibo: c.numero_recibo || '(sin recibo)',
          cliente: _nombreContacto(c.contact_id),
          mes: nombreMes((c.fecha || '').slice(0, 7)),
          medio: c.medio_pago || '(sin medio)',
          banco: _bancosMap[c.banco_id]?.nombre || '(sin banco)',
          moneda: c.moneda || 'PEN',
          fecha: c.fecha || '',
          monto: parseFloat(c.monto || 0),
          retencion: parseFloat(c.monto_retencion || 0),
          interes: 0, gastos: 0,
          total_aplicado: parseFloat(c.monto || 0) + parseFloat(c.monto_retencion || 0)
        }
      }),
      ...abonos.map(a => _filaReporteAbono(a, 'cliente'))
    ]

    crearReporte('rep-cobros', {
      id: 'rep-cobros',
      titulo: 'Cobranza recibida',
      descripcion: 'Todo lo cobrado (facturas y letras), cruzable por mes, cliente, medio de pago, banco o recibo. En letras: efectivo = neto que entró al banco; total aplicado = capital de la letra cancelado.',
      datos,
      dimensiones: [
        { key: 'mes', label: 'Fecha', tipo: 'fecha', campo: 'fecha' }, { key: 'cliente', label: 'Cliente' },
        { key: 'origen', label: 'Origen' }, { key: 'documento', label: 'Documento' }, { key: 'recibo', label: 'N° Recibo' },
        { key: 'medio', label: 'Medio de pago' }, { key: 'banco', label: 'Banco' },
        { key: 'moneda', label: 'Moneda' }
      ],
      medidas: [
        { key: 'monto', label: 'Cobrado en efectivo', agg: 'sum', formato: 'money' },
        { key: 'retencion', label: 'Retención IGV', agg: 'sum', formato: 'money' },
        { key: 'interes', label: 'Intereses', agg: 'sum', formato: 'money' },
        { key: 'gastos', label: 'Gastos bancarios', agg: 'sum', formato: 'money' },
        { key: 'total_aplicado', label: 'Total aplicado', agg: 'sum', formato: 'money' }
      ],
      filtros: [
        { key: 'cliente', label: 'Cliente', tipo: 'texto', campos: ['cliente', 'documento', 'recibo'], placeholder: 'Cliente, documento o recibo...' },
        { key: 'origen', label: 'Origen', tipo: 'select', opciones: ['Factura', 'Letra'] },
        { key: 'medio', label: 'Medio', tipo: 'select', opciones: ['transferencia', 'deposito', 'efectivo', 'cheque', 'detraccion', 'banco_letra', 'yape_plin', 'otro'] },
        { key: 'rango', label: 'Fecha', tipo: 'rango', campo: 'fecha' }
      ],
      agruparPorDefecto: ['mes'],
      kpis: (filas) => [
        { label: 'Total cobrado', valor: filas.reduce((s, f) => s + f.monto, 0), formato: 'money', color: 'var(--color-success)' },
        { label: 'Retenciones', valor: filas.reduce((s, f) => s + f.retencion, 0), formato: 'money', color: 'var(--color-warning)' },
        { label: 'N° de cobros', valor: filas.length, formato: 'int' },
        { label: 'Cobro promedio', valor: filas.length ? filas.reduce((s, f) => s + f.monto, 0) / filas.length : 0, formato: 'money' }
      ]
    })
  })().catch(e => { console.error('rep-cobros:', e); showToast('Error en reporte de cobranza: ' + e.message, 'danger') }) }

  if (panelId === 'rep-pagos') { (async () => {
    const abonosP = (await _abonosTodosCache()).filter(a => a.tipo === 'recibida')
    if (!_letrasCache.length) _letrasCache = await cacheado('letras_cambio', getLetrasCambio)
    const datos = [..._pagosList.map(p => ({ origen: 'Factura',
      proveedor: _nombreContacto(p.contact_id),
      mes: nombreMes((p.fecha || '').slice(0, 7)),
      medio: p.medio_pago || '(sin medio)',
      banco: _bancosMap[p.banco_id]?.nombre || '(sin banco)',
      moneda: p.moneda || 'PEN',
      fecha: p.fecha || '',
      monto: parseFloat(p.monto || 0)
    })), ...abonosP.map(a => _filaReporteAbono(a, 'proveedor'))]

    crearReporte('rep-pagos', {
      id: 'rep-pagos',
      titulo: 'Pagos a proveedores',
      descripcion: 'Salidas de caja hacia proveedores, por mes, proveedor, medio o banco.',
      datos,
      dimensiones: [
        { key: 'mes', label: 'Fecha', tipo: 'fecha', campo: 'fecha' }, { key: 'proveedor', label: 'Proveedor' }, { key: 'origen', label: 'Origen' },
        { key: 'medio', label: 'Medio de pago' }, { key: 'banco', label: 'Banco' },
        { key: 'moneda', label: 'Moneda' }
      ],
      medidas: [{ key: 'monto', label: 'Pagado', agg: 'sum', formato: 'money' }],
      filtros: [
        { key: 'proveedor', label: 'Proveedor', tipo: 'texto', campos: ['proveedor'], placeholder: 'Buscar...' },
        { key: 'medio', label: 'Medio', tipo: 'select', opciones: ['transferencia', 'cheque', 'efectivo', 'deposito', 'detraccion', 'banco_letra', 'otro'] },
        { key: 'rango', label: 'Fecha', tipo: 'rango', campo: 'fecha' }
      ],
      agruparPorDefecto: ['mes'],
      kpis: (filas) => [
        { label: 'Total pagado', valor: filas.reduce((s, f) => s + f.monto, 0), formato: 'money', color: 'var(--color-danger)' },
        { label: 'N° de pagos', valor: filas.length, formato: 'int' },
        { label: 'Pago promedio', valor: filas.length ? filas.reduce((s, f) => s + f.monto, 0) / filas.length : 0, formato: 'money' }
      ]
    })
  })().catch(e => { console.error('rep-pagos:', e); showToast('Error en reporte de pagos: ' + e.message, 'danger') }) }


  if (panelId === 'rep-retenciones') {
    const datos = _cobrosList
      .filter(c => (parseFloat(c.monto_retencion) || 0) > 0)
      .map(c => ({
        cliente: _nombreContacto(c.contact_id),
        mes: nombreMes((c.fecha || '').slice(0, 7)),
        fecha: c.fecha || '',
        estado_comprobante: c.numero_comprobante_retencion ? 'Con comprobante' : 'Falta comprobante',
        retencion: parseFloat(c.monto_retencion || 0),
        base: parseFloat(c.monto || 0) + parseFloat(c.monto_retencion || 0)
      }))

    crearReporte('rep-retenciones', {
      id: 'rep-retenciones',
      titulo: 'Retenciones de IGV aplicadas',
      descripcion: 'Base para deducir del IGV por pagar. Revisa el tramo "Falta comprobante": son retenciones que aún no puedes sustentar.',
      datos,
      dimensiones: [
        { key: 'mes', label: 'Fecha', tipo: 'fecha', campo: 'fecha' }, { key: 'cliente', label: 'Cliente' },
        { key: 'estado_comprobante', label: 'Sustento' }
      ],
      medidas: [
        { key: 'retencion', label: 'Retenido', agg: 'sum', formato: 'money' },
        { key: 'base', label: 'Base aplicada', agg: 'sum', formato: 'money' }
      ],
      filtros: [
        { key: 'cliente', label: 'Cliente', tipo: 'texto', campos: ['cliente'], placeholder: 'Buscar...' },
        { key: 'estado_comprobante', label: 'Sustento', tipo: 'select', opciones: ['Con comprobante', 'Falta comprobante'] },
        { key: 'rango', label: 'Fecha', tipo: 'rango', campo: 'fecha' }
      ],
      agruparPorDefecto: ['mes'],
      kpis: (filas) => {
        const sin = filas.filter(f => f.estado_comprobante === 'Falta comprobante')
        return [
          { label: 'Total retenido', valor: filas.reduce((s, f) => s + f.retencion, 0), formato: 'money' },
          { label: 'Sin comprobante', valor: sin.reduce((s, f) => s + f.retencion, 0), formato: 'money', color: 'var(--color-danger)', sub: `${sin.length} cobro(s)` },
          { label: 'N° retenciones', valor: filas.length, formato: 'int' }
        ]
      }
    })
  }

  if (panelId === 'rep-flujo') {
    // Proyección simple: agrupa los saldos abiertos por semana de vencimiento.
    const filas = []
    _cxcList.filter(c => c.estado !== 'cobrado' && c.estado !== 'anulado').forEach(c => {
      const saldo = _saldoCxC(c); if (saldo <= 0.01) return
      filas.push({
        origen: 'Entrada (cobros)', contraparte: _nombreContacto(c.contact_id),
        periodo: _periodoProyeccion(c.fecha_vencimiento),
        fecha: c.fecha_vencimiento || '', moneda: c.moneda || 'PEN',
        entrada: saldo, salida: 0, neto: saldo
      })
    })
    _cxpList.filter(c => c.estado !== 'pagado' && c.estado !== 'anulado').forEach(c => {
      const saldo = _saldoCxP(c); if (saldo <= 0.01) return
      filas.push({
        origen: 'Salida (pagos)', contraparte: _nombreContacto(c.contact_id),
        periodo: _periodoProyeccion(c.fecha_vencimiento),
        fecha: c.fecha_vencimiento || '', moneda: c.moneda || 'PEN',
        entrada: 0, salida: saldo, neto: -saldo
      })
    })

    crearReporte('rep-flujo', {
      id: 'rep-flujo',
      titulo: 'Flujo de caja proyectado (CxC vs CxP)',
      descripcion: 'Qué entra y qué sale según fechas de vencimiento. Los documentos sin fecha de vencimiento caen en "Sin fecha" — conviene completarlos.',
      datos: filas,
      dimensiones: [
        { key: 'periodo', label: 'Período' }, { key: 'origen', label: 'Tipo' },
        { key: 'contraparte', label: 'Cliente / Proveedor' }, { key: 'moneda', label: 'Moneda' }
      ],
      medidas: [
        { key: 'entrada', label: 'Entradas', agg: 'sum', formato: 'money' },
        { key: 'salida', label: 'Salidas', agg: 'sum', formato: 'money' },
        { key: 'neto', label: 'Neto', agg: 'sum', formato: 'money', semaforo: true }
      ],
      filtros: [
        { key: 'origen', label: 'Tipo', tipo: 'select', opciones: ['Entrada (cobros)', 'Salida (pagos)'] },
        { key: 'contraparte', label: 'Buscar', tipo: 'texto', campos: ['contraparte'], placeholder: 'Cliente o proveedor...' },
        { key: 'rango', label: 'Vencimiento', tipo: 'rango', campo: 'fecha' }
      ],
      agruparPorDefecto: ['periodo'],
      orden: { key: '_etiqueta', dir: 'asc' },
      kpis: (f) => {
        const ent = f.reduce((s, x) => s + x.entrada, 0)
        const sal = f.reduce((s, x) => s + x.salida, 0)
        return [
          { label: 'Entradas esperadas', valor: ent, formato: 'money', color: 'var(--color-success)' },
          { label: 'Salidas esperadas', valor: sal, formato: 'money', color: 'var(--color-danger)' },
          { label: 'Flujo neto', valor: ent - sal, formato: 'money', color: (ent - sal) >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }
        ]
      }
    })
  }
}

function _periodoProyeccion(fechaVenc) {
  if (!fechaVenc) return '9 · Sin fecha de vencimiento'
  const dias = diasVencidos(fechaVenc)
  if (dias > 0)   return '0 · Ya vencido'
  const faltan = -dias
  if (faltan <= 7)  return '1 · Esta semana'
  if (faltan <= 15) return '2 · En 8-15 días'
  if (faltan <= 30) return '3 · En 16-30 días'
  if (faltan <= 60) return '4 · En 31-60 días'
  if (faltan <= 90) return '5 · En 61-90 días'
  return '6 · Más de 90 días'
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// ============================================================================
// IMPUTACIÓN DE COBROS A CUOTAS
// ============================================================================
// Un cobro ya no solo baja el total de la CxC: también se imputa a sus cuotas,
// de la más antigua a la más reciente. Es la práctica estándar de cobranza —
// si el cliente paga sin decir a qué cuota, se salda primero lo más vencido.
//
// Sin esto, un 30/70 con la primera cuota pagada seguiría mostrando ambas
// cuotas como pendientes y la antigüedad seguiría mintiendo.

let _cuotasCache = []

async function _cargarCuotas(forzar = false) {
  if (_cuotasCache.length && !forzar) return _cuotasCache
  _cuotasCache = await cacheado('cuotas_cobrar', getCuotasCobrar)
  return _cuotasCache
}

/**
 * Refresca en caché SOLO las cuotas de un documento (1 consulta chica) en vez
 * de descargar toda la tabla de cuotas en cada cobro/pago/letra.
 */
async function _refrescarCuotasDoc(esCobrar, docId) {
  if (!docId) return
  const tabla = esCobrar ? 'cuotas_cobrar' : 'cuotas_pagar'
  const campo = esCobrar ? 'cxc_id' : 'cxp_id'
  const { data, error } = await supabase.from(tabla).select('*').eq(campo, docId)
  if (error) { console.warn('_refrescarCuotasDoc:', error.message); return }
  const cache = esCobrar ? _cuotasCache : _cuotasPagarCache
  const resto = cache.filter(q => Number(q[campo]) !== Number(docId))
  const nuevo = resto.concat(data || [])
  if (esCobrar) _cuotasCache = nuevo; else _cuotasPagarCache = nuevo
  invalidarVarios([tabla])   // la próxima carga general trae la tabla actualizada
}

/** Cuotas de una CxC, ordenadas por vencimiento. */
function _cuotasDe(cxcId) {
  return _cuotasCache
    .filter(q => q.cxc_id === cxcId)
    .sort((a, b) => String(a.fecha_vencimiento).localeCompare(String(b.fecha_vencimiento)) || a.numero_cuota - b.numero_cuota)
}

// Espejo de _cuotasCache/_cuotasDe pero del lado CxP — lo necesita el tab de
// Letras para armar el selector de "letras recibidas" (a proveedores).
let _cuotasPagarCache = []

async function _cargarCuotasPagar(forzar = false) {
  if (_cuotasPagarCache.length && !forzar) return _cuotasPagarCache
  _cuotasPagarCache = await cacheado('cuotas_pagar', getCuotasPagar)
  return _cuotasPagarCache
}

function _cuotasPagarDe(cxpId) {
  return _cuotasPagarCache
    .filter(q => q.cxp_id === cxpId)
    .sort((a, b) => String(a.fecha_vencimiento).localeCompare(String(b.fecha_vencimiento)) || a.numero_cuota - b.numero_cuota)
}

/**
 * Aplica un cobro (efectivo + retención) sobre las cuotas de una CxC.
 * Devuelve el detalle de lo imputado, para poder mostrarlo al usuario.
 */
async function _imputarACuotas(cxcId, montoEfectivo, montoRetencion) {
  const cuotas = _cuotasDe(cxcId)
  if (cuotas.length === 0) return { aplicaciones: [], sobrante: montoEfectivo + montoRetencion }

  const total = parseFloat(montoEfectivo || 0) + parseFloat(montoRetencion || 0)
  const { aplicaciones, sobrante } = repartirEntreCuotas(cuotas, total)

  // La retención se imputa primero (es lo que legalmente ya está aplicado),
  // y el resto se cubre con el efectivo.
  let retenPorAplicar = parseFloat(montoRetencion || 0)

  for (const { cuota, aplicado } of aplicaciones) {
    const aRetencion = Math.min(retenPorAplicar, aplicado)
    const aEfectivo  = parseFloat((aplicado - aRetencion).toFixed(2))
    retenPorAplicar  = parseFloat((retenPorAplicar - aRetencion).toFixed(2))

    const nuevaCuota = {
      ...cuota,
      monto_cobrado:  parseFloat(((parseFloat(cuota.monto_cobrado) || 0) + aEfectivo).toFixed(2)),
      monto_retenido: parseFloat(((parseFloat(cuota.monto_retenido) || 0) + aRetencion).toFixed(2))
    }

    try {
      await updateCuotaCobrar(cuota.id, {
        monto_cobrado: nuevaCuota.monto_cobrado,
        monto_retenido: nuevaCuota.monto_retenido,
        estado: estadoCuota(nuevaCuota, true)
      })
    } catch (e) {
      console.warn(`Cuota ${cuota.numero_cuota} no actualizada:`, e.message)
    }
  }

  return { aplicaciones, sobrante }
}

/** Texto legible de a qué cuotas se imputó el cobro (para el toast). */
function _describirImputacion(aplicaciones) {
  if (!aplicaciones?.length) return ''
  if (aplicaciones.length === 1) return ` (cuota ${aplicaciones[0].cuota.numero_cuota})`
  return ` (cuotas ${aplicaciones.map(a => a.cuota.numero_cuota).join(', ')})`
}

/** Cuotas de una CxC formateadas para mostrar bajo la fila del listado. */
function _htmlCuotas(cxcId) {
  const cuotas = _cuotasDe(cxcId)
  if (cuotas.length <= 1) return ''   // una sola cuota no aporta información
  const hoy = new Date().toISOString().slice(0, 10)
  return `<div style="margin-top:4px;">` + cuotas.map(q => {
    const saldo = saldoCuota(q)
    const vencida = saldo > 0.01 && q.fecha_vencimiento < hoy
    const color = saldo <= 0.01 ? 'var(--color-success)' : (vencida ? 'var(--color-danger)' : 'var(--text-secondary)')
    return `<span class="badge badge-cuota" style="color:${color};" title="${q.hito ? _esc(q.hito) + ' — ' : ''}vence ${fechaDMY(q.fecha_vencimiento)}">
      ${q.numero_cuota}/${cuotas.length}: ${formatNumber(saldo)} ${saldo <= 0.01 ? '✓' : ''}
    </span>`
  }).join(' ') + `</div>`
}

// ============================================================================
// ANTIGÜEDAD DE SALDOS — POR CUOTA
// ============================================================================
// Lee la vista `v_antiguedad_cxc` en vez de recalcular sobre la cabecera. Es
// el cambio que hace que el reporte por fin diga la verdad: una factura 30/70
// con la primera cuota vencida y la segunda por vencer aparece PARTIDA en dos
// tramos, no como un bloque en uno solo.
//
// El cálculo pesado (tramo, días de mora) lo hace Postgres, que además tiene
// los índices por fecha de vencimiento — con miles de cuotas eso importa.

async function construirAntiguedadCxC() {
  const cont = document.getElementById('rep-antiguedad-cxc')
  if (cont) cont.innerHTML = '<div class="card"><p class="reporte-vacio">Calculando antigüedad…</p></div>'

  try {
    const filas = await cacheado('antiguedad_cxc', getAntiguedadCxC)

    if (!filas?.length) {
      if (cont) {
        cont.innerHTML = `<div class="card"><p class="reporte-vacio">
          Sin datos de antigüedad.<br>
          <small>Si acabas de correr el script 36, recarga la página. Si el error persiste, la vista <code>v_antiguedad_cxc</code> puede no existir todavía.</small>
        </p></div>`
      }
      return
    }

    const datos = filas.map(f => ({
      cliente: f.cliente || `ID ${f.contact_id}`,
      tramo: f.tramo,
      comprobante: `${f.tipo_comprobante || ''} ${f.serie || ''}-${f.numero_comprobante || ''}`.trim(),
      cuota: f.numero_cuota,
      // Etiqueta legible del hito: "2/2 · Llegada del contenedor"
      cuota_etiqueta: f.hito ? `Cuota ${f.numero_cuota} · ${f.hito}` : `Cuota ${f.numero_cuota}`,
      estado: f.estado,
      moneda: f.moneda || 'PEN',
      fecha_emision: f.fecha_emision || '',
      fecha_vencimiento: f.fecha_vencimiento || '',
      mes_venc: nombreMes(String(f.fecha_vencimiento || '').slice(0, 7)),
      dias_vencido: parseInt(f.dias_vencido) || 0,
      monto: parseFloat(f.monto_cuota) || 0,
      cobrado: parseFloat(f.monto_cobrado) || 0,
      retenido: parseFloat(f.monto_retenido) || 0,
      canjeado: parseFloat(f.monto_canjeado) || 0,
      saldo: parseFloat(f.saldo) || 0,
      vencido: (parseFloat(f.saldo) || 0) > 0.01 && (parseInt(f.dias_vencido) || 0) > 0 ? (parseFloat(f.saldo) || 0) : 0
    }))

    crearReporte('rep-antiguedad-cxc', {
      id: 'rep-antiguedad-cxc',
      titulo: 'Antigüedad de saldos — Cuentas por Cobrar (por cuota)',
      descripcion: 'Cada fila es una CUOTA, no un documento: una factura 30/70 aparece en dos tramos distintos según el vencimiento de cada parte. Es la vista real de la cartera.',
      datos,
      dimensiones: [
        { key: 'tramo', label: 'Tramo de mora' },
        { key: 'cliente', label: 'Cliente' },
        { key: 'moneda', label: 'Moneda' },
        { key: 'mes_venc', label: 'Fecha vencimiento', tipo: 'fecha', campo: 'fecha_vencimiento' },
        { key: 'cuota_etiqueta', label: 'Cuota / hito' },
        { key: 'estado', label: 'Estado' }
      ],
      medidas: [
        { key: 'monto', label: 'Importe cuota', agg: 'sum', formato: 'money' },
        { key: 'cobrado', label: 'Cobrado', agg: 'sum', formato: 'money' },
        { key: 'retenido', label: 'Retenido', agg: 'sum', formato: 'money' },
        { key: 'canjeado', label: 'Canjeado (letras)', agg: 'sum', formato: 'money' },
        { key: 'saldo', label: 'Saldo', agg: 'sum', formato: 'money' },
        { key: 'vencido', label: 'Vencido', agg: 'sum', formato: 'money' },
        { key: 'dias_vencido', label: 'Días mora (prom.)', agg: 'avg', formato: 'int' }
      ],
      filtros: [
        { key: 'buscar', label: 'Cliente o comprobante', tipo: 'texto', campos: ['cliente', 'comprobante'], placeholder: 'Buscar...' },
        { key: 'tramo', label: 'Tramo', tipo: 'select', opciones: ['0 · Por vencer', '1 · 1-30 días', '2 · 31-60 días', '3 · 61-90 días', '4 · Más de 90 días', '5 · Sin saldo'] },
        { key: 'moneda', label: 'Moneda', tipo: 'select', opciones: ['PEN', 'USD'] },
        { key: 'rango', label: 'Vencimiento', tipo: 'rango', campo: 'fecha_vencimiento' }
      ],
      agruparPorDefecto: ['tramo'],
      medidasPorDefecto: ['monto', 'cobrado', 'saldo', 'vencido'],
      orden: { key: '_etiqueta', dir: 'asc' },
      kpis: (f) => {
        const saldo = f.reduce((s, x) => s + x.saldo, 0)
        const venc  = f.reduce((s, x) => s + x.vencido, 0)
        const conSaldo = f.filter(x => x.saldo > 0.01)
        // Mora promedio ponderada por importe: un atraso de 200 días sobre
        // S/ 50 no debe pesar lo mismo que uno de 5 días sobre S/ 100,000.
        const moraPonderada = saldo > 0
          ? conSaldo.reduce((s, x) => s + (x.dias_vencido > 0 ? x.dias_vencido * x.saldo : 0), 0) / saldo
          : 0
        return [
          { label: 'Saldo total', valor: saldo, formato: 'money', color: 'var(--color-warning)' },
          { label: 'Vencido', valor: venc, formato: 'money', color: 'var(--color-danger)', sub: saldo ? `${(venc / saldo * 100).toFixed(1)}% de la cartera` : '' },
          { label: 'Mora promedio', valor: moraPonderada, formato: 'int', sub: 'días, ponderada por importe' },
          { label: 'Cuotas con saldo', valor: conSaldo.length, formato: 'int', sub: `${new Set(conSaldo.map(x => x.cliente)).size} cliente(s)` }
        ]
      }
    })
  } catch (e) {
    console.error('construirAntiguedadCxC:', e)
    _reportesListos['rep-antiguedad-cxc'] = false
    if (cont) {
      cont.innerHTML = `<div class="card"><p class="reporte-vacio">
        No se pudo construir la antigüedad: ${_esc(e.message)}<br>
        <small>Verifica que el script <code>36_terminos_pago_y_cuotas.sql</code> se haya ejecutado.</small>
      </p></div>`
    }
  }
}

// ============================================================================
// TÉRMINOS DE PAGO — catálogo editable
// ============================================================================
// Un término define porcentajes y días, no fechas: por eso "Crédito 30/45/60"
// sirve para cualquier factura de cualquier mes. Las condiciones negociadas
// una sola vez NO van aquí: para eso está la opción "Personalizado" en el
// cronograma del documento.

let _tpCuotas = []   // cuotas del término en edición

async function renderTerminosPago() {
  const cont = document.getElementById('tabla-terminos')
  if (!cont) return
  try {
    const terminos = await getTerminosConCuotas(true)
    if (!terminos.length) {
      cont.innerHTML = '<p class="reporte-vacio">No hay términos definidos. Corre el script 36 o crea uno nuevo.</p>'
      return
    }

    cont.innerHTML = `
      <table>
        <thead>
          <tr><th>Nombre</th><th>Tipo</th><th>Aplica a</th><th>Cronograma</th><th style="text-align:center;">Cuotas</th><th></th></tr>
        </thead>
        <tbody>
          ${terminos.map(t => {
            const suma = t.cuotas.reduce((s, c) => s + (parseFloat(c.porcentaje) || 0), 0)
            const cuadra = Math.abs(suma - 100) < 0.02
            return `<tr>
              <td><strong>${_esc(t.nombre)}</strong>${t.descripcion ? `<div style="font-size:0.78rem; color:var(--text-secondary);">${_esc(t.descripcion)}</div>` : ''}</td>
              <td><span class="badge ${t.tipo === 'contado' ? 'badge-success' : t.tipo === 'hito' ? 'badge-warning' : 'badge-info'}">${t.tipo}</span></td>
              <td>${t.aplica_a === 'ambos' ? 'Ventas y compras' : t.aplica_a === 'venta' ? 'Solo ventas' : 'Solo compras'}</td>
              <td>${t.cuotas.map(c =>
                `<span class="badge badge-cuota" title="${c.hito ? _esc(c.hito) : `a ${c.dias} días`}">${parseFloat(c.porcentaje)}% · ${c.dias}d</span>`
              ).join(' ') || '<span style="color:var(--color-danger);">sin cuotas</span>'}
              ${!cuadra ? `<div style="font-size:0.75rem; color:var(--color-danger);">⚠ suma ${suma}% en vez de 100%</div>` : ''}</td>
              <td style="text-align:center;">${t.cuotas.length}</td>
              <td style="white-space:nowrap;">
                <button class="btn btn-small btn-secondary" title="Ver detalle" onclick="window.verDetalleTerminoPago(${t.id})">👁</button>
                <button class="btn btn-small btn-secondary" title="Editar" onclick="window.abrirModalTerminoPago(${t.id})">✏️</button>
                <button class="btn btn-small btn-danger" title="Eliminar" onclick="window.eliminarTerminoPago(${t.id})">✕</button>
              </td>
            </tr>`
          }).join('')}
        </tbody>
      </table>`
    hacerTablaOrdenable(cont.querySelector('table'))
  } catch (e) {
    cont.innerHTML = `<p class="reporte-vacio">No se pudieron cargar los términos: ${_esc(e.message)}<br><small>¿Corriste el script 36?</small></p>`
  }
}

window.abrirModalTerminoPago = async function (id) {
  const terminos = await getTerminosConCuotas()
  const t = id ? terminos.find(x => x.id === id) : null

  document.getElementById('tp-titulo').textContent = t ? `Editar: ${t.nombre}` : 'Nuevo Término de Pago'
  document.getElementById('tpId').value = t?.id || ''
  document.getElementById('tpNombre').value = t?.nombre || ''
  document.getElementById('tpTipo').value = t?.tipo || 'credito'
  document.getElementById('tpAplicaA').value = t?.aplica_a || 'ambos'
  document.getElementById('tpDescripcion').value = t?.descripcion || ''

  _tpCuotas = t?.cuotas?.length
    ? t.cuotas.map(c => ({ porcentaje: parseFloat(c.porcentaje), dias: parseInt(c.dias) || 0, hito: c.hito || '' }))
    : [{ porcentaje: 100, dias: 30, hito: '' }]

  _pintarCuotasTermino()
  window.openModal('modal-termino-pago')
}

function _pintarCuotasTermino() {
  const body = document.getElementById('tp-cuotas-body')
  if (!body) return
  body.innerHTML = _tpCuotas.map((c, i) => `
    <tr>
      <td style="text-align:center;">${i + 1}</td>
      <td><input type="number" step="0.01" min="0.01" max="100" value="${c.porcentaje}" data-tp="pct" data-i="${i}"></td>
      <td><input type="number" step="1" min="0" value="${c.dias}" data-tp="dias" data-i="${i}"></td>
      <td><input type="text" value="${_esc(c.hito || '')}" placeholder="Ej: Llegada a puerto Callao" data-tp="hito" data-i="${i}"></td>
      <td>${_tpCuotas.length > 1 ? `<button type="button" class="btn btn-small btn-danger" data-tp="quitar" data-i="${i}">✕</button>` : ''}</td>
    </tr>`).join('')

  const suma = _tpCuotas.reduce((s, c) => s + (parseFloat(c.porcentaje) || 0), 0)
  const cuadra = Math.abs(suma - 100) < 0.02
  document.getElementById('tp-suma-pct').textContent = suma.toFixed(2)
  const aviso = document.getElementById('tp-aviso-pct')
  if (aviso) {
    aviso.textContent = cuadra ? '✓ Los porcentajes suman 100%' : `Debe sumar 100% (faltan ${(100 - suma).toFixed(2)}%)`
    aviso.style.color = cuadra ? 'var(--color-success)' : 'var(--color-danger)'
  }

  body.querySelectorAll('[data-tp]').forEach(el => {
    const i = parseInt(el.getAttribute('data-i'))
    const campo = el.getAttribute('data-tp')
    if (campo === 'quitar') {
      el.addEventListener('click', () => { _tpCuotas.splice(i, 1); _pintarCuotasTermino() })
    } else {
      el.addEventListener('change', () => {
        if (campo === 'pct') _tpCuotas[i].porcentaje = parseFloat(el.value) || 0
        else if (campo === 'dias') _tpCuotas[i].dias = parseInt(el.value) || 0
        else _tpCuotas[i].hito = el.value.trim()
        _pintarCuotasTermino()
      })
    }
  })
}

window.agregarCuotaTermino = function () {
  const ultima = _tpCuotas[_tpCuotas.length - 1]
  _tpCuotas.push({ porcentaje: 0, dias: (ultima?.dias || 0) + 30, hito: '' })
  _pintarCuotasTermino()
}

window.guardarTerminoPago = async function () {
  try {
    const id = parseInt(document.getElementById('tpId')?.value || 0) || null
    const nombre = document.getElementById('tpNombre')?.value?.trim()
    const tipo = document.getElementById('tpTipo')?.value
    const aplicaA = document.getElementById('tpAplicaA')?.value
    const descripcion = document.getElementById('tpDescripcion')?.value?.trim() || null

    if (!nombre) { showToast('El nombre es obligatorio', 'warning'); return }
    if (_tpCuotas.length === 0) { showToast('Agrega al menos una cuota', 'warning'); return }

    const suma = _tpCuotas.reduce((s, c) => s + (parseFloat(c.porcentaje) || 0), 0)
    if (Math.abs(suma - 100) > 0.02) {
      showToast(`Los porcentajes deben sumar 100% (suman ${suma.toFixed(2)}%)`, 'warning')
      return
    }
    if (_tpCuotas.some(c => (parseFloat(c.porcentaje) || 0) <= 0)) {
      showToast('Ninguna cuota puede ser 0%', 'warning'); return
    }

    let terminoId = id
    if (id) {
      await updateTerminoPago(id, { nombre, tipo, aplica_a: aplicaA, descripcion })
      // Las cuotas se reemplazan enteras: es más simple y seguro que
      // reconciliar altas, bajas y cambios de orden una por una.
      const previas = await getTerminosPagoCuotas(id)
      for (const c of (previas || [])) await deleteTerminoPagoCuota(c.id)
    } else {
      const nuevo = await addTerminoPago({ nombre, tipo, aplica_a: aplicaA, descripcion, activo: true, orden: 99 })
      if (!nuevo?.id) throw new Error('no se pudo crear el término (¿nombre duplicado?)')
      terminoId = nuevo.id
    }

    for (let i = 0; i < _tpCuotas.length; i++) {
      const c = _tpCuotas[i]
      await addTerminoPagoCuota({
        termino_id: terminoId, orden: i + 1,
        porcentaje: parseFloat(c.porcentaje), dias: parseInt(c.dias) || 0,
        hito: c.hito || null
      })
    }

    invalidarCacheTerminos()
    showToast(`Término "${nombre}" guardado ✅`, 'success')
    window.closeModal('modal-termino-pago')
    await renderTerminosPago()
  } catch (e) {
    console.error('guardarTerminoPago:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

window.eliminarTerminoPago = async function (id) {
  const terminos = await getTerminosConCuotas()
  const t = terminos.find(x => x.id === id)
  if (!t) return
  // No se borra físicamente si ya se usó: los documentos que lo referencian
  // perderían el dato de qué se pactó. Se desactiva y deja de aparecer en los
  // selectores, pero el histórico sigue leyéndose.
  if (!confirm(`¿Desactivar el término "${t.nombre}"?\n\nDejará de aparecer al crear ventas y compras, pero los documentos que ya lo usan lo conservan.`)) return
  try {
    await updateTerminoPago(id, { activo: false })
    invalidarCacheTerminos()
    showToast('Término desactivado', 'success')
    await renderTerminosPago()
  } catch (e) {
    showToast('Error: ' + e.message, 'danger')
  }
}

void deleteTerminoPago

// ============================================================================
// LETRAS DE CAMBIO — Etapa B
// ============================================================================
// Una letra canjea el saldo de UNA cuota (nunca varias, nunca de facturas
// distintas) por un documento de crédito físico. Emitida = de un cliente
// (nace de una cuota de cuotas_cobrar). Recibida = a un proveedor (nace de
// una cuota de cuotas_pagar). El canje consume saldo igual que un cobro:
// sube `monto_canjeado` en la cuota y su estado se recalcula con el mismo
// estadoCuota() que usan los cobros — así "canjeado" es un estado más,
// coherente con "cobrado"/"pagado"/"parcial".
//
// Flujo de estados (PCGE): cartera (en poder de la empresa) → banco
// (en descuento o custodia bancaria) → cobrada, o protestada si no paga.
// "cobranza" es un estado intermedio (banco la tiene en gestión de cobro,
// sin descontarla) — mismas acciones que "banco" desde la UI.

window.cargarLetras = async function () {
  try {
    await Promise.all([_cargarCuotas(), _cargarCuotasPagar()])
    _letrasCache = await cacheado('letras_cambio', getLetrasCambio)

    const tipoF   = document.getElementById('let-filtro-tipo')?.value || ''
    const estadoF = document.getElementById('let-filtro-estado')?.value || ''
    const lista = _letrasCache
      .filter(l => (!tipoF || l.tipo === tipoF) && (!estadoF || (estadoF === '_abiertas' ? _letraAbierta(l) : l.estado === estadoF)))
      .sort((a, b) => String(a.fecha_vencimiento || '').localeCompare(String(b.fecha_vencimiento || '')))

    const tbody = document.getElementById('tbody-letras')
    if (!tbody) return

    if (lista.length === 0) {
      tbody.innerHTML = '<tr><td colspan="14" style="text-align:center;">Sin letras registradas</td></tr>'
      _letPintarBotonUnificar()
      return
    }

    const badgeEstado = {
      cartera: 'badge-secondary', banco: 'badge-info', cobranza: 'badge-warning',
      parcial: 'badge-warning', cobrada: 'badge-success', protestada: 'badge-danger',
      refinanciada: 'badge-info', anulada: 'badge-secondary'
    }
    // Quita de la selección las que ya no están abiertas
    for (const id of [..._letSel]) { const x = _letrasCache.find(z => z.id === id); if (!x || !_letraAbierta(x)) _letSel.delete(id) }

    tbody.innerHTML = lista.map(l => {
      const cuota = l.tipo === 'emitida'
        ? _cuotasCache.find(q => q.id === l.cuota_cobrar_id)
        : _cuotasPagarCache.find(q => q.id === l.cuota_pagar_id)
      const cabecera = l.tipo === 'emitida'
        ? _cxcList.find(c => c.id === l.cxc_id)
        : _cxpList.find(c => c.id === l.cxp_id)
      const comprobante = cabecera
        ? `${cabecera.tipo_comprobante || ''} ${cabecera.serie || ''}-${cabecera.numero_comprobante || ''}`
        : '—'
      const banco = l.banco_id ? (_bancosMap[l.banco_id]?.nombre || `Banco #${l.banco_id}`) : '—'

      const saldo = _saldoLetra(l)
      const puedeSel = _letraAbierta(l) && saldo > 0.005
      return `<tr>
        <td style="text-align:center;">${puedeSel ? `<input type="checkbox" style="width:auto; margin:0;" ${_letSel.has(l.id) ? 'checked' : ''} title="Marcar para unificar" onchange="window._letToggleSel(${l.id}, this.checked, this)">` : ''}</td>
        <td>${_esc(l.numero_letra)}${l.refinanciacion_id ? ' <span title="Nace de una refinanciación">🔗</span>' : ''}</td>
        <td>${l.tipo === 'emitida' ? 'Por Cobrar' : 'Por Pagar'}</td>
        <td>${_esc(_nombreContacto(l.contact_id))}</td>
        <td>${_esc(comprobante)}${cuota ? ` <small style="color:var(--text-secondary);">(cuota ${cuota.numero_cuota})</small>` : ''}</td>
        <td>${fechaDMY(l.fecha_emision, '-')}</td>
        <td>${fechaDMY(l.fecha_vencimiento, '-')}</td>
        <td><span class="badge ${_monedaLetra(l) === 'USD' ? 'badge-info' : 'badge-secondary'}">${_monedaLetra(l)}</span></td>
        <td style="text-align:right;">${formatNumber(parseFloat(l.monto || 0))}</td>
        <td style="text-align:right;">${_n(l.monto_pagado) ? formatNumber(l.monto_pagado) : '—'}</td>
        <td style="text-align:right; font-weight:600;${saldo > 0 ? '' : ' color:var(--text-secondary);'}">${formatNumber(saldo)}</td>
        <td>${banco}</td>
        <td><span class="badge ${badgeEstado[l.estado] || 'badge-secondary'}">${l.estado}</span></td>
        <td style="white-space:nowrap;">${_accionesLetra(l)}</td>
      </tr>`
    }).join('')
    _letPintarBotonUnificar()
  } catch (e) {
    console.error('cargarLetras:', e)
    showToast('Error al cargar letras: ' + e.message, 'danger')
  }
}

function _accionesLetra(l) {
  // Acción principal (Cobrar/Pagar) + menú ⋮ (estándar CxC/CxP).
  const abierta = _letraAbierta(l)
  const verbo = l.tipo === 'recibida' ? 'Pagar' : 'Cobrar'
  const principal = abierta
    ? `<button class="btn btn-small btn-primary" onclick="window.abrirCancelarLetra(${l.id})">${verbo}</button> `
    : ''
  const items = [
    abierta && { icono: '💵', label: `${verbo} / abonar`, onclick: `window.abrirCancelarLetra(${l.id})` },
    abierta && { icono: '🔄', label: 'Renovar (pago parcial + nueva letra)', onclick: `window.abrirRenovarLetra(${l.id})` },
    abierta && { icono: '🔗', label: 'Unificar con otras letras…', onclick: `window.abrirRefinanciar([${l.id}], 'unificacion')` },
    { icono: '👁', label: 'Ver detalle / abonos', onclick: `window.verDetalleLetra(${l.id})` },
    l.estado !== 'refinanciada' && { icono: '✏️', label: 'Editar', onclick: `window.abrirEditarLetra(${l.id})` },
    { separador: true },
    (l.refinanciacion_id || l.estado === 'refinanciada')
      ? { icono: '↩', label: 'Deshacer refinanciación', peligro: true, onclick: `window.eliminarLetra(${l.id})` }
      : { icono: '✕', label: 'Eliminar', peligro: true, onclick: `window.eliminarLetra(${l.id})` }
  ].filter(Boolean)
  return principal + menuAccionesFila(items)
}

function _botonesLetra(id) {
  return `<button class="btn btn-small btn-secondary" title="Ver detalle" onclick="window.verDetalleLetra(${id})">👁</button>
    <button class="btn btn-small btn-secondary" title="Editar" onclick="window.abrirEditarLetra(${id})">✏️</button>
    <button class="btn btn-small btn-danger" title="Eliminar" onclick="window.eliminarLetra(${id})">✕</button>`
}

// ── Nueva letra (canje de una cuota) ──

window.abrirModalNuevaLetra = async function () {
  await Promise.all([_cargarCuotas(), _cargarCuotasPagar()])
  const hoy = new Date().toISOString().split('T')[0]
  document.getElementById('letTipo').value = 'emitida'
  document.getElementById('letObservaciones').value = ''
  document.getElementById('letFechaEmision').value = hoy
  document.getElementById('letPrimerVenc').value = ''
  document.getElementById('letCantidad').value = 1
  document.getElementById('letIntervalo').value = 30
  document.getElementById('letPrefijo').value = ''
  _letFilas = []
  window.onCambiarTipoLetra()
  window.openModal('modal-nueva-letra')
}

window.onCambiarTipoLetra = function () {
  const tipo = document.getElementById('letTipo')?.value || 'emitida'
  const sel = document.getElementById('letCuota')
  if (!sel) return

  const fuente = tipo === 'emitida' ? _cuotasCache : _cuotasPagarCache
  const opciones = fuente
    .filter(q => saldoCuota(q) > 0.01 && q.estado !== 'anulado')
    .map(q => {
      const cabecera = tipo === 'emitida'
        ? _cxcList.find(c => c.id === q.cxc_id)
        : _cxpList.find(c => c.id === q.cxp_id)
      const saldo = saldoCuota(q)
      const label = `${_nombreContacto(cabecera?.contact_id)} — ${cabecera?.tipo_comprobante || ''} ${cabecera?.serie || ''}-${cabecera?.numero_comprobante || ''} — Cuota ${q.numero_cuota} — Saldo ${formatNumber(saldo)} ${cabecera?.moneda || 'PEN'}`
      return { id: q.id, label, saldo, contactId: cabecera?.contact_id || '', moneda: cabecera?.moneda || 'PEN', tipoCambio: cabecera?.tipo_cambio || 1 }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  sel.innerHTML = '<option value="">-- Selecciona --</option>' + opciones.map(o =>
    `<option value="${o.id}" data-saldo="${o.saldo}" data-contact="${o.contactId}" data-moneda="${o.moneda}" data-tc="${o.tipoCambio}">${_esc(o.label)}</option>`
  ).join('')

  _letFilas = []; _letPintar()
  const info = document.getElementById('letCuotaInfo'); if (info) info.style.display = 'none'
  document.getElementById('letCuotaAviso').textContent = opciones.length === 0
    ? 'No hay cuotas con saldo pendiente para este tipo.'
    : ''
}

// ── Canje en VARIAS letras (2026-10-07) ─────────────────────────────────────
// _letFilas = [{ numero, monto, venc }] — una fila por letra a crear.
let _letFilas = []
const _letCuotaSel = () => {
  const opt = document.getElementById('letCuota')?.selectedOptions[0]
  if (!opt || !opt.value) return null
  return { id: parseInt(opt.value), saldo: parseFloat(opt.getAttribute('data-saldo') || 0), moneda: opt.getAttribute('data-moneda') || 'PEN', opt }
}
const _sumarDias = (f, d) => { if (!f) return ''; const x = new Date(f + 'T00:00:00'); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10) }
const _diasEntre = (a, b) => (a && b) ? Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000) : null

window.onCambiarCuotaLetra = function () {
  const c = _letCuotaSel()
  const info = document.getElementById('letCuotaInfo')
  if (!c) { if (info) info.style.display = 'none'; _letFilas = []; _letPintar(); return }
  const tipo = document.getElementById('letTipo')?.value || 'emitida'
  const q = (tipo === 'emitida' ? _cuotasCache : _cuotasPagarCache).find(x => x.id === c.id)
  const cab = q ? (tipo === 'emitida' ? _cxcList.find(d => d.id === q.cxc_id) : _cxpList.find(d => d.id === q.cxp_id)) : null
  if (info) {
    info.style.display = ''
    info.innerHTML = `<div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">${tipo === 'emitida' ? 'Cliente' : 'Proveedor'}</div>
      <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${_esc(_nombreContacto(cab?.contact_id))}</div>
      <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">${_esc(_descDocCP(cab))} · Cuota ${q?.numero_cuota ?? '—'} · vence ${fechaDMY(q?.fecha_vencimiento, '—')} · <b style="color:var(--text-primary);">Saldo ${c.moneda} ${formatNumber(c.saldo)}</b></div>`
  }
  document.getElementById('letCuotaAviso').textContent = ''
  const pref = document.getElementById('letPrefijo')
  if (pref && !pref.value) pref.value = `LT.${String(cab?.numero_comprobante || '').replace(/^0+/, '')}-`
  const pv = document.getElementById('letPrimerVenc')
  if (pv && !pv.value) pv.value = _sumarDias(document.getElementById('letFechaEmision')?.value, parseInt(document.getElementById('letIntervalo')?.value || 30) || 30)
  window._letGenerar()
}

// Reparte el saldo en N letras iguales (la última absorbe los centavos).
window._letGenerar = function () {
  const c = _letCuotaSel()
  if (!c) { showToast('Primero elige la cuota a canjear', 'warning'); return }
  const n = Math.min(60, Math.max(1, parseInt(document.getElementById('letCantidad')?.value || 1) || 1))
  const pref = document.getElementById('letPrefijo')?.value?.trim() || 'LT-'
  const intervalo = Math.max(1, parseInt(document.getElementById('letIntervalo')?.value || 30) || 30)
  const emi = document.getElementById('letFechaEmision')?.value
  const primer = document.getElementById('letPrimerVenc')?.value || _sumarDias(emi, intervalo)
  const base = Math.floor((c.saldo / n) * 100) / 100
  _letFilas = Array.from({ length: n }, (_, i) => ({
    numero: `${pref}${String(i + 1).padStart(2, '0')}`,
    monto: i === n - 1 ? _r2(c.saldo - base * (n - 1)) : base,
    venc: _sumarDias(primer, i * intervalo)
  }))
  _letPintar()
}

window._letAgregarFila = function () {
  const c = _letCuotaSel()
  if (!c) { showToast('Primero elige la cuota a canjear', 'warning'); return }
  const usado = _letFilas.reduce((s, f) => s + (parseFloat(f.monto) || 0), 0)
  const ult = _letFilas[_letFilas.length - 1]
  const pref = document.getElementById('letPrefijo')?.value?.trim() || 'LT-'
  const intervalo = Math.max(1, parseInt(document.getElementById('letIntervalo')?.value || 30) || 30)
  _letFilas.push({
    numero: `${pref}${String(_letFilas.length + 1).padStart(2, '0')}`,
    monto: Math.max(0, _r2(c.saldo - usado)),
    venc: ult?.venc ? _sumarDias(ult.venc, intervalo) : (document.getElementById('letPrimerVenc')?.value || '')
  })
  _letPintar()
}
window._letPintarExt = () => _letPintar()
window._letQuitarFila = function (i) { _letFilas.splice(i, 1); _letPintar() }
window._letSet = function (i, campo, valor) {
  if (!_letFilas[i]) return
  _letFilas[i][campo] = campo === 'monto' ? parseFloat(valor) || 0 : valor
  if (campo === 'venc') {
    const td = document.getElementById(`letPlazo${i}`)
    if (td) td.textContent = (_diasEntre(document.getElementById('letFechaEmision')?.value, valor) ?? '—') + ' d'
  }
  _letResumen()
}

function _letPintar() {
  const tb = document.getElementById('letFilasBody')
  if (!tb) return
  const emi = document.getElementById('letFechaEmision')?.value
  const inp = 'style="width:100%; padding:6px 8px;"'
  tb.innerHTML = _letFilas.length ? _letFilas.map((f, i) => `<tr style="border-top:1px solid var(--border-color);">
      <td style="text-align:center; padding:6px 10px; color:var(--text-secondary);">${i + 1}</td>
      <td style="padding:6px 10px;"><input type="text" ${inp} value="${_esc(f.numero)}" oninput="window._letSet(${i}, 'numero', this.value)"></td>
      <td style="padding:6px 10px;"><input type="number" step="0.01" min="0.01" ${inp.replace('padding:6px 8px;', 'padding:6px 8px; text-align:right;')} value="${(parseFloat(f.monto) || 0).toFixed(2)}" oninput="window._letSet(${i}, 'monto', this.value)"></td>
      <td style="padding:6px 10px;"><input type="date" ${inp} value="${f.venc || ''}" onchange="window._letSet(${i}, 'venc', this.value)"></td>
      <td id="letPlazo${i}" style="text-align:right; padding:6px 10px; color:var(--text-secondary); font-size:0.85rem;">${_diasEntre(emi, f.venc) ?? '—'} d</td>
      <td style="text-align:center; padding:6px 6px;"><button type="button" class="btn btn-small btn-danger" title="Quitar letra" onclick="window._letQuitarFila(${i})">✕</button></td>
    </tr>`).join('')
    : '<tr><td colspan="6" style="text-align:center; padding:14px; color:var(--text-secondary);">Elige la cuota y pulsa ⚡ Generar (o + Agregar letra).</td></tr>'
  _letResumen()
}

function _letResumen() {
  const box = document.getElementById('letResumen')
  if (!box) return
  const c = _letCuotaSel()
  const mon = c?.moneda || ''
  const saldo = c?.saldo || 0
  const total = _r2(_letFilas.reduce((s, f) => s + (parseFloat(f.monto) || 0), 0))
  const queda = _r2(saldo - total)
  const color = queda < -0.009 ? 'var(--color-danger)' : (Math.abs(queda) < 0.01 ? 'var(--color-success)' : 'var(--color-warning)')
  const card = (lbl, val, st = '') => `<div><div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">${lbl}</div><div style="font-weight:700; font-size:1.1rem;${st}">${val}</div></div>`
  box.innerHTML = card('Saldo de la cuota', `${mon} ${formatNumber(saldo)}`) +
    card(`Total en ${_letFilas.length} letra(s)`, `${mon} ${formatNumber(total)}`) +
    card(queda < -0.009 ? 'Excede el saldo' : 'Queda sin canjear', `${mon} ${formatNumber(queda)}`, ` color:${color};`)
  const btn = document.getElementById('letBtnGuardar')
  if (btn && !btn.classList.contains('btn-cargando')) btn.textContent = `💾 Guardar ${_letFilas.length || ''} letra${_letFilas.length === 1 ? '' : 's'}`
}

window.guardarLetra = async function () {
  try {
    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    const tipo = document.getElementById('letTipo')?.value || 'emitida'
    const sel = document.getElementById('letCuota')
    const opt = sel?.selectedOptions[0]
    const cuotaId = parseInt(sel?.value || 0)
    if (!cuotaId) { showToast('Selecciona la cuota a canjear', 'warning'); return }
    if (!_letFilas.length) { showToast('Agrega al menos una letra (⚡ Generar o + Agregar letra)', 'warning'); return }

    const fechaEmision = document.getElementById('letFechaEmision')?.value
    if (!fechaEmision) { showToast('Ingresa la fecha de emisión', 'warning'); return }

    // Validación de TODAS las filas antes de crear nada
    const vistos = new Set()
    for (const [i, f] of _letFilas.entries()) {
      const n = (f.numero || '').trim()
      if (!n) { showToast(`Letra ${i + 1}: falta el N°`, 'warning'); return }
      if (vistos.has(n.toLowerCase())) { showToast(`N° de letra repetido: ${n}`, 'warning'); return }
      vistos.add(n.toLowerCase())
      if (_letrasCache?.some?.(l => (l.numero_letra || '').trim().toLowerCase() === n.toLowerCase())) { showToast(`Ya existe una letra con el N° ${n}`, 'warning'); return }
      if (!(parseFloat(f.monto) > 0)) { showToast(`Letra ${n}: monto inválido`, 'warning'); return }
      if (!f.venc) { showToast(`Letra ${n}: falta el vencimiento`, 'warning'); return }
      if (f.venc < fechaEmision) { showToast(`Letra ${n}: vence antes de la fecha de emisión`, 'warning'); return }
    }
    const saldo = parseFloat(opt.getAttribute('data-saldo') || 0)
    const totalLetras = _r2(_letFilas.reduce((s, f) => s + (parseFloat(f.monto) || 0), 0))
    if (totalLetras > saldo + 0.01) {
      showToast(`El total de las letras (${formatNumber(totalLetras)}) supera el saldo de la cuota (${formatNumber(saldo)})`, 'warning'); return
    }
    if (saldo - totalLetras > 0.01 && !confirm(`Las letras suman ${formatNumber(totalLetras)} y la cuota tiene ${formatNumber(saldo)}.\n\nQuedarán ${formatNumber(saldo - totalLetras)} sin canjear (canje parcial). ¿Continuar?`)) return

    const contactId = parseInt(opt.getAttribute('data-contact') || 0) || null
    const moneda = opt.getAttribute('data-moneda') || 'PEN'
    const tipoCambio = parseFloat(opt.getAttribute('data-tc') || 1) || 1
    const observaciones = document.getElementById('letObservaciones')?.value?.trim() || null

    const cuota = tipo === 'emitida'
      ? _cuotasCache.find(q => q.id === cuotaId)
      : _cuotasPagarCache.find(q => q.id === cuotaId)
    if (!cuota) { showToast('No se encontró la cuota seleccionada', 'danger'); return }
    const cabecera = tipo === 'emitida'
      ? _cxcList.find(c => c.id === cuota.cxc_id)
      : _cxpList.find(c => c.id === cuota.cxp_id)

    // Se crean una por una: si alguna falla, las anteriores quedan bien
    // registradas (cada una con su canje y asiento) y se avisa cuál falló.
    let canjeadoCuota = parseFloat(cuota.monto_canjeado) || 0
    const creadas = []
    for (const f of _letFilas) {
      const monto = _r2(f.monto)
      const numero = f.numero.trim()
      const letra = await addLetraCambio({
        numero_letra: numero,
        tipo,
        contact_id: contactId,
        venta_id:  tipo === 'emitida'  ? (cabecera?.venta_id  || null) : null,
        compra_id: tipo === 'recibida' ? (cabecera?.compra_id || null) : null,
        cxc_id: tipo === 'emitida'  ? cuota.cxc_id : null,
        cxp_id: tipo === 'recibida' ? cuota.cxp_id : null,
        cuota_cobrar_id: tipo === 'emitida'  ? cuota.id : null,
        cuota_pagar_id:  tipo === 'recibida' ? cuota.id : null,
        moneda,
        tipo_cambio: tipoCambio,
        monto,
        fecha_emision: fechaEmision,
        fecha_vencimiento: f.venc,
        estado: 'cartera',
        observaciones,
        created_by: user.db_id
      })
      if (!letra?.id) {
        showToast(`No se pudo registrar la letra ${numero} (¿N° duplicado?).${creadas.length ? ` Se registraron ${creadas.length}: ${creadas.join(', ')}` : ''}`, 'danger')
        break
      }
      // La cuota y el DOCUMENTO bajan su saldo con cada letra
      canjeadoCuota = _r2(canjeadoCuota + monto)
      const cuotaAct = { ...cuota, monto_canjeado: canjeadoCuota }
      if (tipo === 'emitida') await updateCuotaCobrar(cuota.id, { monto_canjeado: canjeadoCuota, estado: estadoCuota(cuotaAct, true) })
      else                    await updateCuotaPagar(cuota.id,  { monto_canjeado: canjeadoCuota, estado: estadoCuota(cuotaAct, false) })
      await _aplicarCanjeDoc(tipo, tipo === 'emitida' ? cuota.cxc_id : cuota.cxp_id, monto)
      const asCanje = await _asientoLetra('canje', letra, null)
      if (asCanje?.id) await updateLetraCambio(letra.id, { asiento_emision_id: asCanje.id })
      creadas.push(numero)
    }

    if (creadas.length === _letFilas.length) {
      showToast(`${creadas.length} letra(s) registrada(s) ✅ — ${creadas.join(', ')}`, 'success', 5000)
      window.closeModal('modal-nueva-letra')
    }
    _refrescarTodo()
    await window.cargarLetras()
  } catch (e) {
    console.error('guardarLetra:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

// ── Cambios de estado ──

window.abrirModalLetraBanco = async function (id) {
  const lx = _letrasCache.find(x => x.id === id)
  if (lx && (lx.estado !== 'cartera' || _n(lx.monto_pagado) > 0)) {
    showToast(lx.estado === 'parcial' || _n(lx.monto_pagado) > 0
      ? 'Una letra con abonos se gestiona en cartera: para llevarla al banco, primero renuévala o unifícala en una letra nueva por el saldo.'
      : `Solo se envían al banco letras en cartera (esta está ${lx.estado}).`, 'warning', 8000)
    return
  }
  document.getElementById('letBancoLetraId').value = id
  const sel = document.getElementById('letBancoSelect')
  const bancos = await cacheado('bancos', getBancos)
  sel.innerHTML = '<option value="">-- Selecciona --</option>' +
    bancos.filter(b => b.activo !== false).map(b => `<option value="${b.id}">${_esc(b.nombre)} (${_esc(b.banco)})</option>`).join('')
  document.getElementById('letBancoNumOp').value = ''
  document.getElementById('letBancoComision').value = ''

  const selProv = document.getElementById('letBancoComisionProv')
  const proveedores = await cacheado('suppliers', getSuppliers)
  selProv.innerHTML = '<option value="">-- Selecciona --</option>' +
    proveedores.map(p => `<option value="${p.id}">${_esc(p.razon_social || p.nombre)}</option>`).join('')
  window.onCambiarComisionLetra()

  window.openModal('modal-letra-banco')
}

/** Muestra/oculta el selector de proveedor(banco) según si se ingresó comisión. */
window.onCambiarComisionLetra = function () {
  const monto = parseFloat(document.getElementById('letBancoComision')?.value || 0)
  const grupo = document.getElementById('letBancoComisionProvGroup')
  if (grupo) grupo.style.display = monto > 0 ? '' : 'none'
}

window.confirmarLetraABanco = async function () {
  const id = parseInt(document.getElementById('letBancoLetraId')?.value || 0)
  const bancoId = parseInt(document.getElementById('letBancoSelect')?.value || 0)
  if (!bancoId) { showToast('Selecciona el banco', 'warning'); return }
  const numOp = document.getElementById('letBancoNumOp')?.value?.trim() || null
  const comision = parseFloat(document.getElementById('letBancoComision')?.value || 0)
  const proveedorId = parseInt(document.getElementById('letBancoComisionProv')?.value || 0)

  if (comision > 0 && !proveedorId) {
    showToast('Selecciona el proveedor (banco) para registrar la comisión', 'warning')
    return
  }

  try {
    const letra = _letrasCache.find(l => l.id === id)
    let comisionCompraId = null

    if (comision > 0) {
      comisionCompraId = await _registrarComisionBancariaLetra(letra, proveedorId, comision)
    }

    await updateLetraCambio(id, {
      estado: 'banco', banco_id: bancoId, numero_operacion: numOp,
      ...(comisionCompraId ? { comision_compra_id: comisionCompraId } : {})
    })
    showToast(`Letra enviada a banco ✅${comisionCompraId ? ' — comisión registrada como compra de servicio' : ''}`, 'success')
    window.closeModal('modal-letra-banco')
    _refrescarTodo()
    await window.cargarLetras()
  } catch (e) {
    showToast('Error: ' + e.message, 'danger')
  }
}

/**
 * Registra la comisión que cobra el banco por descontar/custodiar una letra
 * como una Compra de Servicio normal — mismo camino que cualquier otro
 * gasto (Compras → Registro → Cuenta por Pagar), para que aparezca en el
 * registro de compras y en la CxP del proveedor (el banco), no como un
 * número suelto.
 */
async function _registrarComisionBancariaLetra(letra, proveedorId, monto) {
  const user = await getCurrentUser()
  const prov = (await cacheado('suppliers', getSuppliers)).find(p => p.id === proveedorId)
  const hoy = new Date().toISOString().split('T')[0]

  // Cuenta 679218 "COMISIONES BANCARIAS" ya existe en el plan de cuentas
  // (con movimiento en la apertura) — se usa si está, si no queda sin
  // cuenta asignada (igual que cualquier compra de servicio sin cuenta).
  const cuentas = await getCuentasGasto()
  const cuenta = cuentas.find(c => c.codigo === '679218')

  const referencia = `COMBANC-${letra?.numero_letra || Date.now()}`
  const compra = await addCompra({
    referencia,
    tipo_referencia: 'compra_directa',
    tipo_comprobante: '01',
    serie: null,
    numero: referencia,
    periodo_mes: parseInt(hoy.slice(5, 7)),
    periodo_ano: parseInt(hoy.slice(0, 4)),
    fecha_emision: hoy,
    fecha_recepcion: hoy,
    contact_id: proveedorId,
    proveedor_ruc: prov?.nro_documento || '-',
    proveedor_nombre: prov?.nombre || prov?.razon_social || '-',
    tipo_compra: 'servicio',
    descripcion: `Comisión bancaria — letra ${letra?.numero_letra || ''} [Cuenta: ${cuenta ? `${cuenta.codigo} ${cuenta.nombre}` : 'sin asignar'}]`,
    unidad_medida: 'UND',
    cantidad: 1,
    precio_unitario: monto,
    // Los servicios financieros están exonerados de IGV (Ley del IGV) — la
    // comisión bancaria no lleva IGV.
    base_imponible_gravada: 0,
    monto_exonerado: monto,
    igv_gravado: 0,
    subtotal: monto,
    total: monto,
    currency: 'PEN',
    tipo_cambio: 1,
    estado_pago: 'pendiente',
    asiento_id: null,
    created_by: user?.db_id
  })

  if (!compra?.id) throw new Error('No se pudo registrar la compra de la comisión bancaria')

  await addCompraDetalle({
    compra_id: compra.id, item_id: null,
    descripcion: `Comisión bancaria — letra ${letra?.numero_letra || ''}`,
    unidad_medida: 'UND', cantidad: 1, precio_unitario: monto,
    subtotal: monto, tipo_base: 'exonerada', igv_porcentaje: 0, igv_monto: 0, total_linea: monto
  })

  try {
    await addCuentaPagar({
      contact_id: proveedorId, compra_id: compra.id,
      tipo_comprobante: '01', serie: null, numero_comprobante: referencia,
      fecha_emision: hoy, fecha_vencimiento: null,
      moneda: 'PEN', tipo_cambio: 1,
      monto_total: monto, monto_pagado: 0, estado: 'pendiente',
      created_by: user?.db_id
    })
  } catch (e) {
    console.warn('Comisión registrada pero la Cuenta por Pagar falló:', e.message)
  }

  return compra.id
}

window.cambiarEstadoLetra = async function (id, nuevoEstado) {
  const letra = _letrasCache.find(l => l.id === id)
  if (!letra) return
  const etiquetas = { cartera: 'Cartera', banco: 'En banco', cobranza: 'En cobranza', parcial: 'Parcial', cobrada: 'Cobrada', protestada: 'Protestada', refinanciada: 'Refinanciada', anulada: 'Anulada' }
  if (!confirm(`¿Cambiar la letra ${letra.numero_letra} a "${etiquetas[nuevoEstado] || nuevoEstado}"?`)) return

  try {
    await updateLetraCambio(id, { estado: nuevoEstado })
    showToast(`Letra ${letra.numero_letra} → ${etiquetas[nuevoEstado] || nuevoEstado}`, 'success')
    _refrescarTodo()
    await window.cargarLetras()
  } catch (e) {
    showToast('Error: ' + e.message, 'danger')
  }
}

window.eliminarLetra = async function (id) {
  const letra = _letrasCache.find(l => l.id === id)
  if (!letra) return
  // Refinanciación: se deshace completa (no letra por letra)
  if (letra.estado === 'refinanciada') {
    let refId = null
    try { refId = await _refinQueCerro(id) } catch (e) { showToast(e.message, 'danger'); return }
    if (!refId) { showToast('Letra refinanciada sin registro de refinanciación (flujo anterior): revísala en Supabase.', 'warning', 7000); return }
    return window.deshacerRefinanciacion(refId)
  }
  if (letra.refinanciacion_id) return window.deshacerRefinanciacion(letra.refinanciacion_id)
  // Con abonos (pagos totales o parciales): se revierten todos antes de eliminar
  let abonos = []
  try { abonos = await _abonosDeLetra(id) } catch (_) { abonos = [] }
  if (abonos.some(a => a.refinanciacion_id)) { showToast('La letra tiene un abono de renovación: deshaz la refinanciación.', 'warning'); return }
  if (abonos.length) {
    if (!confirm(`¿Eliminar la letra ${letra.numero_letra}?\n\nTiene ${abonos.length} abono(s) por ${formatNumber(abonos.reduce((t, a) => t + _n(a.monto_amortizado), 0))}: primero se revierten (movimientos bancarios + asientos) y luego se libera el canje de la cuota/documento y se borra el asiento de canje.`)) return
    try {
      for (const ab of abonos) {
        const av = await _revertirContableAbono(ab, letra)
        if (av.length) showToast('⚠️ ' + av.join('; '), 'warning')
        await _delAbono(ab.id)
      }
      await _updLetra(id, { estado: 'cartera', monto_pagado: 0, banco_id: null, asiento_cobro_id: null })
      letra.estado = 'cartera'; letra.monto_pagado = 0; letra.asiento_cobro_id = null
    } catch (e) { showToast('Error al revertir abonos: ' + e.message, 'danger'); return }
    return _eliminarLetraSinCobro(letra, true)
  }
  return _eliminarLetraSinCobro(letra, false)
}

async function _eliminarLetraSinCobro(letra, yaConfirmado) {
  const id = letra.id
  const cobrada = letra.estado === 'cobrada'
  if (!yaConfirmado && !confirm(`¿Eliminar la letra ${letra.numero_letra}?\n\n${cobrada ? 'Primero se revierte su cobro/pago (movimiento bancario + asiento) y luego ' : ''}se libera el monto canjeado al saldo de la cuota y del documento, y se borra el asiento de canje.`)) return

  try {
    if (cobrada) {
      const avisosRev = await _revertirCancelacionLetraCore(letra)
      if (avisosRev.length) showToast('⚠️ ' + avisosRev.join('; '), 'warning')
    }
    // Primero el asiento de canje (la letra lo referencia por FK)
    if (letra.asiento_emision_id) {
      await updateLetraCambio(id, { asiento_emision_id: null })
      try { await eliminarAsientoContable(letra.asiento_emision_id) } catch (e) { console.warn('Asiento de canje no eliminado:', e.message) }
    }
    const okDel = await deleteLetraCambio(id)
    if (okDel === false) throw new Error('No se pudo eliminar la letra')

    // Revertir el canje: la cuota recupera el saldo que esta letra consumía.
    const cuota = letra.tipo === 'emitida'
      ? _cuotasCache.find(q => q.id === letra.cuota_cobrar_id)
      : _cuotasPagarCache.find(q => q.id === letra.cuota_pagar_id)
    if (cuota) {
      const nuevoCanjeado = Math.max(0, parseFloat(((parseFloat(cuota.monto_canjeado) || 0) - parseFloat(letra.monto || 0)).toFixed(2)))
      const cuotaActualizada = { ...cuota, monto_canjeado: nuevoCanjeado }
      if (letra.tipo === 'emitida') {
        await updateCuotaCobrar(cuota.id, { monto_canjeado: nuevoCanjeado, estado: estadoCuota(cuotaActualizada, true) })
      } else {
        await updateCuotaPagar(cuota.id, { monto_canjeado: nuevoCanjeado, estado: estadoCuota(cuotaActualizada, false) })
      }
    }

    await _aplicarCanjeDoc(letra.tipo, letra.tipo === 'emitida' ? letra.cxc_id : letra.cxp_id, -parseFloat(letra.monto || 0))

    window.closeModal?.('modal-detalle-cp')
    showToast(`Letra ${letra.numero_letra} eliminada ✅`, 'success')
    _refrescarTodo()
    await _recargarTrasLetra()
  } catch (e) {
    showToast('Error: ' + e.message, 'danger')
  }
}

// ============================================================================
// VER DETALLE / EDITAR / ELIMINAR — COBROS Y PAGOS
// ============================================================================
// Un cobro/pago deja 5 huellas: (1) su fila, (2) el asiento contable
// (COBRO-{id} / PAGO-{id}), (3) el movimiento bancario + saldo de la cuenta,
// (4) importe y estado de la CxC/CxP y (5) la imputación a cuotas.
// Eliminar revierte las 5. Editar = revertir + volver a aplicar sobre la MISMA
// fila (el id no cambia, así la referencia del asiento sigue siendo válida).
// Analogía: es como anular un voucher y volver a emitirlo con el mismo número.

const _r2 = n => parseFloat((parseFloat(n) || 0).toFixed(2))

const _MEDIOS_CP = {
  cobro: [['transferencia', 'Transferencia'], ['deposito', 'Depósito'], ['efectivo', 'Efectivo'], ['cheque', 'Cheque'], ['detraccion', 'Detracción'], ['otro', 'Otro']],
  pago:  [['transferencia', 'Transferencia'], ['cheque', 'Cheque'], ['efectivo', 'Efectivo'], ['deposito', 'Depósito'], ['detraccion', 'Detracción'], ['otro', 'Otro']]
}

function _botonesCP(tipo, id) {
  return `<button class="btn btn-small btn-secondary" title="Ver detalle" onclick="window.verDetalleCP('${tipo}', ${id})">👁</button>
    <button class="btn btn-small btn-secondary" title="Editar" onclick="window.abrirEditarCP('${tipo}', ${id})">✏️</button>
    <button class="btn btn-small btn-danger" title="Eliminar" onclick="window.eliminarCP('${tipo}', ${id})">✕</button>`
}

function _estadoCxCCalc(cxc, cobrado, retenido) {
  const total = parseFloat(cxc.monto_total || 0) + parseFloat(cxc.monto_notas_debito || 0) - parseFloat(cxc.monto_notas_credito || 0)
  const aplicado = cobrado + retenido + parseFloat(cxc.monto_canjeado || 0) + parseFloat(cxc.monto_anticipo_aplicado || 0)
  return aplicado >= total - 0.01 ? 'cobrado' : (aplicado > 0.01 ? 'parcial' : 'pendiente')
}

function _estadoCxPCalc(cxp, pagado) {
  const total = parseFloat(cxp.monto_total || 0) + parseFloat(cxp.monto_notas_debito || 0) - parseFloat(cxp.monto_notas_credito || 0)
  const aplicado = pagado + parseFloat(cxp.monto_canjeado || 0) + parseFloat(cxp.monto_anticipo_aplicado || 0)
  return aplicado >= total - 0.01 ? 'pagado' : (aplicado > 0.01 ? 'parcial' : 'pendiente')
}

const _descDocCP = d => `${d?.tipo_comprobante || ''} ${d?.serie || ''}-${d?.numero_comprobante || ''}`.trim()

// ── Aplicar efectos ─────────────────────────────────────────────────────────

async function _aplicarEfectosCobro(cobro, cxc) {
  const user     = getCurrentUser()
  const monto    = _r2(cobro.monto)
  const ret      = _r2(cobro.monto_retencion)
  const bancoId  = cobro.banco_id ? parseInt(cobro.banco_id) : null
  const descripcion = `Cobro ${_descDocCP(cxc)}`

  let asientoId = null
  try {
    const asiento = await generarAsientoCobroCliente({
      cobroId: cobro.id, monto, cxcId: cxc.id, bancoId,
      medioPago: cobro.medio_pago, fecha: cobro.fecha, descripcion, userId: user?.db_id,
      monedaDoc: cxc.moneda || 'PEN', tcDoc: parseFloat(cxc.tipo_cambio) || 1,
      tcCobro: parseFloat(cobro.tipo_cambio) || parseFloat(cxc.tipo_cambio) || 1, contactId: cxc.contact_id
    })
    if (asiento?.id) { asientoId = asiento.id; await updateCobro(cobro.id, { asiento_id: asiento.id }) }
  } catch (e) {
    console.warn('Asiento de cobro no generado:', e.message)
    showToast('⚠️ Asiento no generado: ' + e.message, 'warning')
  }

  await _registrarMovimientoBancario({
    bancoId, tipo: 'ingreso', fecha: cobro.fecha,
    concepto: `${descripcion} — ${_nombreContacto(cxc.contact_id)}`,
    referencia: cobro.referencia, monto, cobroId: cobro.id, asientoId,
    monedaMonto: cxc.moneda || 'PEN', tc: parseFloat(cobro.tipo_cambio) || 1
  })

  const cobrado  = _r2(parseFloat(cxc.monto_cobrado || 0) + monto)
  const retenido = _r2(parseFloat(cxc.monto_retenido || 0) + ret)
  await updateCuentaCobrar(cxc.id, { monto_cobrado: cobrado, monto_retenido: retenido, estado: _estadoCxCCalc(cxc, cobrado, retenido) })

  await _refrescarCuotasDoc(true, cxc.id)
  return await _imputarACuotas(cxc.id, monto, ret)
}

async function _aplicarEfectosPago(pago, cxp) {
  const user     = getCurrentUser()
  const monto    = _r2(pago.monto)
  const bancoId  = pago.banco_id ? parseInt(pago.banco_id) : null
  const descripcion = `Pago proveedor ${_descDocCP(cxp)}`

  let asientoId = null
  try {
    const asiento = await generarAsientoPagoProveedor({
      pagoId: pago.id, monto, compraId: cxp.compra_id, bancoId,
      moneda: cxp.moneda || pago.moneda || 'PEN', fecha: pago.fecha, descripcion, userId: user?.db_id,
      tcDoc: parseFloat(cxp.tipo_cambio) || 1,
      tcPago: parseFloat(pago.tipo_cambio) || parseFloat(cxp.tipo_cambio) || 1, contactId: cxp.contact_id
    })
    if (asiento?.id) { asientoId = asiento.id; await updatePagoProveedor(pago.id, { asiento_id: asiento.id }) }
  } catch (e) {
    console.warn('Asiento de pago no generado:', e.message)
    showToast('⚠️ Asiento no generado: ' + e.message, 'warning')
  }

  await _registrarMovimientoBancario({
    bancoId, tipo: 'egreso', fecha: pago.fecha,
    concepto: `${descripcion} — ${_nombreContacto(cxp.contact_id)}`,
    referencia: pago.referencia, monto, pagoId: pago.id, asientoId,
    monedaMonto: cxp.moneda || 'PEN', tc: parseFloat(pago.tipo_cambio) || 1
  })

  const pagado = _r2(parseFloat(cxp.monto_pagado || 0) + monto)
  await updateCuentaPagar(cxp.id, { monto_pagado: pagado, estado: _estadoCxPCalc(cxp, pagado) })

  return await _imputarACuotasPagar(cxp.id, monto)
}

/** Espejo de _imputarACuotas del lado CxP (antes los pagos no tocaban cuotas_pagar). */
async function _imputarACuotasPagar(cxpId, monto) {
  await _refrescarCuotasDoc(false, cxpId)
  const cuotas = _cuotasPagarDe(cxpId)
  if (!cuotas.length) return { aplicaciones: [], sobrante: monto }
  const { aplicaciones, sobrante } = repartirEntreCuotas(cuotas, monto)
  for (const { cuota, aplicado } of aplicaciones) {
    const nueva = { ...cuota, monto_pagado: _r2(parseFloat(cuota.monto_pagado || 0) + aplicado) }
    try { await updateCuotaPagar(cuota.id, { monto_pagado: nueva.monto_pagado, estado: estadoCuota(nueva, false) }) }
    catch (e) { console.warn(`Cuota pagar ${cuota.numero_cuota} no actualizada:`, e.message) }
  }
  return { aplicaciones, sobrante }
}

// ── Buscar huellas ──────────────────────────────────────────────────────────

/** Asiento del cobro/pago: por asiento_id o por referencia COBRO-{id}/PAGO-{id}. */
async function _buscarAsientoCP(tipo, reg) {
  const a = await getJournalEntryByReferencia(tipo === 'cobro' ? 'Cobro' : 'Pago Proveedor', `${tipo === 'cobro' ? 'COBRO' : 'PAGO'}-${reg.id}`)
  if (a) return a
  return reg.asiento_id ? { id: reg.asiento_id, numero_asiento: `AS-${String(reg.asiento_id).padStart(6, '0')}` } : null
}

/**
 * Movimiento bancario del cobro/pago. Primero por vínculo (cobro_id /
 * pago_proveedor_id); para registros antiguos sin vínculo, por coincidencia
 * única de banco + fecha + tipo + monto + concepto.
 */
async function _buscarMovimientoCP(tipo, reg) {
  if (!reg.banco_id) return { mov: null, modo: null }
  const campo = tipo === 'cobro' ? 'cobro_id' : 'pago_proveedor_id'
  // Consulta puntual por el vínculo (antes descargaba todos los movimientos del banco)
  const { data: vincs } = await supabase.from('movimientos_banco').select('*').eq(campo, reg.id).limit(1)
  if (vincs?.[0]) return { mov: vincs[0], modo: 'vinculado' }
  // Registros antiguos sin vínculo: candidatos del mismo banco/fecha/monto
  const { data: movs0 } = await supabase.from('movimientos_banco').select('*')
    .eq('banco_id', reg.banco_id).eq('fecha', reg.fecha).eq('monto', reg.monto)
  const movs = movs0 || []

  const tipoMov = tipo === 'cobro' ? 'ingreso' : 'egreso'
  const prefijo = tipo === 'cobro' ? 'Cobro' : 'Pago proveedor'
  const cand = movs.filter(m => !m.cobro_id && !m.pago_proveedor_id
    && m.tipo === tipoMov && String(m.fecha) === String(reg.fecha)
    && Math.abs(parseFloat(m.monto) - parseFloat(reg.monto)) < 0.01
    && String(m.concepto || '').startsWith(prefijo))
  if (cand.length === 1) return { mov: cand[0], modo: 'coincidencia' }
  return { mov: null, modo: cand.length > 1 ? 'ambiguo' : null }
}

// ── Revertir efectos ────────────────────────────────────────────────────────

async function _eliminarMovimientoYSaldo(mov) {
  const ok = await deleteMovimientoBanco(mov.id)
  if (!ok) throw new Error('No se pudo eliminar el movimiento bancario')
  // El saldo lo actualiza el TRIGGER trg_actualizar_saldo_banco (02_functions.sql)
  // al insertar/borrar el movimiento. NO tocar saldo_actual aquí: se duplicaba.
  const banco = await getBancoById(mov.banco_id)
  if (banco && _bancosMap[mov.banco_id]) _bancosMap[mov.banco_id].saldo_actual = banco.saldo_actual
  invalidarVarios(['bancos', 'movimientos_banco'])
}

/** Quita lo imputado a cuotas, de la cuota más reciente a la más antigua. */
async function _desimputarCuotas(cuotas, efectivo, retencion, esCobrar) {
  const campoEf = esCobrar ? 'monto_cobrado' : 'monto_pagado'
  let restEf = _r2(efectivo), restRet = _r2(retencion)
  const orden = [...cuotas].filter(c => c.estado !== 'anulado')
    .sort((a, b) => String(b.fecha_vencimiento).localeCompare(String(a.fecha_vencimiento)) || b.numero_cuota - a.numero_cuota)

  for (const c of orden) {
    if (restEf <= 0.01 && restRet <= 0.01) break
    const quitaEf  = Math.min(parseFloat(c[campoEf] || 0), restEf)
    const quitaRet = esCobrar ? Math.min(parseFloat(c.monto_retenido || 0), restRet) : 0
    if (quitaEf <= 0 && quitaRet <= 0) continue
    restEf  = _r2(restEf - quitaEf)
    restRet = _r2(restRet - quitaRet)

    const nueva = { ...c, [campoEf]: _r2(parseFloat(c[campoEf] || 0) - quitaEf) }
    if (esCobrar) nueva.monto_retenido = _r2(parseFloat(c.monto_retenido || 0) - quitaRet)
    const datos = { [campoEf]: nueva[campoEf], estado: estadoCuota(nueva, esCobrar) }
    if (esCobrar) datos.monto_retenido = nueva.monto_retenido
    try { esCobrar ? await updateCuotaCobrar(c.id, datos) : await updateCuotaPagar(c.id, datos) }
    catch (e) { console.warn(`Cuota ${c.numero_cuota} no revertida:`, e.message) }
  }
}

/**
 * Revierte movimiento bancario, cuotas y CxC/CxP. El asiento se devuelve
 * (no se borra aquí) porque la fila lo referencia por FK: quien llama decide
 * si primero borra la fila (Eliminar) o la desvincula (Editar).
 */
async function _revertirEfectosCP(tipo, reg) {
  const avisos = []
  const esCobro = tipo === 'cobro'
  const monto = _r2(reg.monto)
  const ret   = esCobro ? _r2(reg.monto_retencion) : 0

  const { mov, modo } = await _buscarMovimientoCP(tipo, reg)
  if (mov) await _eliminarMovimientoYSaldo(mov)
  else if (reg.banco_id && _cfg.autoMovBanco) avisos.push(modo === 'ambiguo'
    ? 'hay varios movimientos bancarios parecidos: revisa el módulo Bancos'
    : 'no se encontró movimiento bancario')

  if (esCobro && reg.cxc_id) {
    await _refrescarCuotasDoc(true, reg.cxc_id)
    await _desimputarCuotas(_cuotasDe(reg.cxc_id), monto, ret, true)
    const cxc = await getCuentaCobrarById(reg.cxc_id)
    if (cxc) {
      const cobrado  = Math.max(0, _r2(parseFloat(cxc.monto_cobrado || 0) - monto))
      const retenido = Math.max(0, _r2(parseFloat(cxc.monto_retenido || 0) - ret))
      await updateCuentaCobrar(cxc.id, { monto_cobrado: cobrado, monto_retenido: retenido, estado: _estadoCxCCalc(cxc, cobrado, retenido) })
    }
  } else if (!esCobro && reg.cxp_id) {
    await _refrescarCuotasDoc(false, reg.cxp_id)
    await _desimputarCuotas(_cuotasPagarDe(reg.cxp_id), monto, 0, false)
    const cxp = await getCuentaPagarById(reg.cxp_id)
    if (cxp) {
      const pagado = Math.max(0, _r2(parseFloat(cxp.monto_pagado || 0) - monto))
      await updateCuentaPagar(cxp.id, { monto_pagado: pagado, estado: _estadoCxPCalc(cxp, pagado) })
    }
  }

  const asiento = await _buscarAsientoCP(tipo, reg)
  return { avisos, asiento }
}

async function _recargarTrasCambioCP() {
  _refrescarTodo()
  invalidarVarios(['movimientos_banco', 'journal_entries'])
  await Promise.all([cargarCxC(), cargarCxP(), cargarCobrosRecientes(), cargarPagosRecientes(), cargarRetenciones()])
  calcularKPIs()
}

async function _getRegCP(tipo, id) {
  return tipo === 'cobro' ? await getCobroById(id) : await getPagoProveedorById(id)
}

// ── ELIMINAR ────────────────────────────────────────────────────────────────

window.eliminarCP = async function(tipo, id) {
  try {
    const esCobro = tipo === 'cobro'
    const reg = await _getRegCP(tipo, id)
    if (!reg) { showToast('Registro no encontrado', 'danger'); return }

    const { mov } = await _buscarMovimientoCP(tipo, reg)
    const extras = []
    if (esCobro && reg.numero_comprobante_retencion) extras.push(`⚠️ Tiene comprobante de retención N° ${reg.numero_comprobante_retencion}.`)
    if (mov?.reconciliado) extras.push('⚠️ El movimiento bancario ya está CONCILIADO.')

    const msg = `¿Eliminar el ${esCobro ? 'cobro' : 'pago'} de ${formatNumber(reg.monto)} del ${fechaDMY(reg.fecha)} (${_nombreContacto(reg.contact_id)})?\n\n`
      + `Se revertirá:\n• ${esCobro ? 'CxC' : 'CxP'}: importe ${esCobro ? 'cobrado' : 'pagado'} y estado\n• Imputación a cuotas`
      + (esCobro && parseFloat(reg.monto_retencion || 0) > 0 ? `\n• Retención IGV de ${formatNumber(reg.monto_retencion)}` : '')
      + `\n• Movimiento bancario y saldo del banco\n• Asiento contable\n\n${extras.join('\n')}\nEsta acción no se puede deshacer.`
    if (!confirm(msg)) return

    const { avisos, asiento } = await _revertirEfectosCP(tipo, reg)
    const ok = esCobro ? await deleteCobro(id) : await deletePagoProveedor(id)
    if (!ok) throw new Error('Efectos revertidos, pero la fila no se pudo eliminar. NO reintentes: avisa para corregirlo por SQL.')
    await eliminarAdjuntosDe(tipo, id)
    if (asiento?.id) {
      try { await eliminarAsientoContable(asiento.id) }
      catch (e) { avisos.push('asiento no eliminado: ' + e.message) }
    }

    window.closeModal?.('modal-detalle-cp')
    showToast(`${esCobro ? 'Cobro' : 'Pago'} eliminado ✅${avisos.length ? ' — ⚠️ ' + avisos.join('; ') : ''}`, avisos.length ? 'warning' : 'success')
    await _recargarTrasCambioCP()
  } catch (e) {
    console.error('eliminarCP:', e)
    showToast('Error al eliminar: ' + e.message, 'danger')
  }
}

// ── VER DETALLE ─────────────────────────────────────────────────────────────

let _planCuentasMap = null

window.verDetalleCP = async function(tipo, id) {
  const body = document.getElementById('detalle-cp-body')
  if (!body) return
  const esCobro = tipo === 'cobro'
  document.getElementById('detalle-cp-titulo').textContent = esCobro ? `Detalle del Cobro #${id}` : `Detalle del Pago #${id}`
  document.getElementById('detalle-cp-acciones').innerHTML = `
    <button class="btn btn-secondary" onclick="window.closeModal('modal-detalle-cp')">Cerrar</button>
    <button class="btn btn-secondary" onclick="window.closeModal('modal-detalle-cp'); window.abrirEditarCP('${tipo}', ${id})">✏️ Editar</button>
    <button class="btn btn-danger" onclick="window.eliminarCP('${tipo}', ${id})">✕ Eliminar</button>`
  body.innerHTML = '<p style="text-align:center;">Cargando...</p>'
  window.openModal('modal-detalle-cp')

  try {
    const reg = await _getRegCP(tipo, id)
    if (!reg) { body.innerHTML = '<p>Registro no encontrado.</p>'; return }
    const doc = esCobro
      ? (reg.cxc_id ? await getCuentaCobrarById(reg.cxc_id) : null)
      : (reg.cxp_id ? await getCuentaPagarById(reg.cxp_id) : null)

    if (doc) await _refrescarCuotasDoc(esCobro, doc.id)
    const cuotas = doc ? (esCobro ? _cuotasDe(doc.id) : _cuotasPagarDe(doc.id)) : []

    const [asiento, movRes, adjuntos, delRecibo] = await Promise.all([_buscarAsientoCP(tipo, reg), _buscarMovimientoCP(tipo, reg), getAdjuntos(tipo, reg.id), esCobro ? _cobrosDelRecibo(reg) : []])
    let lineas = []
    if (asiento?.id) {
      lineas = (await getJournalEntryLinesByEntry(asiento.id)) || []
      if (!_planCuentasMap) {
        _planCuentasMap = {}
        ;((await cacheado('plan_cuentas', getAccounts)) || []).forEach(a => { _planCuentasMap[a.id] = a })
      }
    }

    const fila = (k, v) => `<tr><td style="color:var(--text-secondary); width:40%;">${k}</td><td>${v}</td></tr>`
    const saldoDoc = doc ? (esCobro ? _saldoCxC(doc) : _saldoCxP(doc)) : 0
    const mov = movRes.mov

    body.innerHTML = `
      <h4 style="margin:0 0 6px;">Datos del ${esCobro ? 'cobro' : 'pago'}</h4>
      <table class="table-compact" style="width:100%;">
        ${esCobro ? fila('N° Recibo', _esc(reg.numero_recibo || '—')) : ''}
        ${fila('Fecha', fechaDMY(reg.fecha))}
        ${fila(esCobro ? 'Cliente' : 'Proveedor', _esc(_nombreContacto(reg.contact_id)))}
        ${fila('Monto', `<b>${reg.moneda || 'PEN'} ${formatNumber(reg.monto)}</b>`)}
        ${esCobro ? fila('Retención IGV', parseFloat(reg.monto_retencion || 0) > 0 ? formatNumber(reg.monto_retencion) : '—') : ''}
        ${esCobro && reg.numero_comprobante_retencion ? fila('Comprobante retención', _esc(reg.numero_comprobante_retencion)) : ''}
        ${fila('Tipo de cambio', reg.tipo_cambio ?? '—')}
        ${fila('Medio de pago', reg.medio_pago || '—')}
        ${fila('Banco', _esc(_bancosMap[reg.banco_id]?.nombre || '—'))}
        ${fila('Referencia / N° operación', _esc(reg.referencia || reg.numero_operacion || '—'))}
        ${fila('Observaciones', _esc(reg.observaciones || '—'))}
        ${fila('📎 Archivos adjuntos', _htmlAdjuntos(tipo, reg.id, adjuntos, false))}
        ${fila('Registrado', reg.created_at ? new Date(reg.created_at).toLocaleString('es-PE') : '—')}
      </table>

      ${esCobro ? _htmlSeccionRecibo(reg, delRecibo) : ''}

      <h4 style="margin:16px 0 6px;">Documento ${esCobro ? 'CxC' : 'CxP'}</h4>
      ${doc ? `<table class="table-compact" style="width:100%;">
        ${fila('Comprobante', _esc(_descDocCP(doc)))}
        ${fila('Total', `${doc.moneda || 'PEN'} ${formatNumber(doc.monto_total)}`)}
        ${fila(esCobro ? 'Cobrado' : 'Pagado', formatNumber(esCobro ? doc.monto_cobrado : doc.monto_pagado))}
        ${esCobro ? fila('Retenido', formatNumber(doc.monto_retenido || 0)) : ''}
        ${fila('Saldo', `<b>${formatNumber(saldoDoc)}</b>`)}
        ${fila('Estado', doc.estado || '—')}
      </table>` : '<p style="color:var(--text-secondary);">Sin documento vinculado.</p>'}

      ${cuotas.length ? `<h4 style="margin:16px 0 6px;">Cuotas del documento</h4>
      <table class="table-compact" style="width:100%;">
        <thead><tr><th>N°</th><th>Vence</th><th style="text-align:right;">Monto</th><th style="text-align:right;">${esCobro ? 'Cobrado' : 'Pagado'}</th>${esCobro ? '<th style="text-align:right;">Retenido</th>' : ''}<th style="text-align:right;">Saldo</th><th>Estado</th></tr></thead>
        <tbody>${cuotas.map(q => `<tr><td>${q.numero_cuota}</td><td>${fechaDMY(q.fecha_vencimiento)}</td>
          <td style="text-align:right;">${formatNumber(q.monto)}</td>
          <td style="text-align:right;">${formatNumber(esCobro ? q.monto_cobrado : q.monto_pagado)}</td>
          ${esCobro ? `<td style="text-align:right;">${formatNumber(q.monto_retenido || 0)}</td>` : ''}
          <td style="text-align:right;">${formatNumber(saldoCuota(q))}</td><td>${q.estado}</td></tr>`).join('')}</tbody>
      </table>` : ''}

      <h4 style="margin:16px 0 6px;">Asiento contable</h4>
      ${asiento?.id ? `<p style="margin:0 0 6px;"><b>${_esc(asiento.numero_asiento || '')}</b> — ${_esc(asiento.descripcion || '')}</p>
      <table class="table-compact" style="width:100%;">
        <thead><tr><th>Cuenta</th><th style="text-align:right;">Debe</th><th style="text-align:right;">Haber</th></tr></thead>
        <tbody>${lineas.map(l => { const a = _planCuentasMap?.[l.account_id]; return `<tr>
          <td>${_esc(a ? `${a.codigo} ${a.nombre}` : (l.descripcion || l.account_id))}</td>
          <td style="text-align:right;">${parseFloat(l.debe || 0) ? formatNumber(l.debe) : ''}</td>
          <td style="text-align:right;">${parseFloat(l.haber || 0) ? formatNumber(l.haber) : ''}</td></tr>` }).join('')}</tbody>
      </table>` : '<p style="color:var(--text-secondary);">Sin asiento generado.</p>'}

      <h4 style="margin:16px 0 6px;">Movimiento bancario</h4>
      ${mov ? `<table class="table-compact" style="width:100%;">
        ${fila('N° Registro', `<b>${_numMB(mov.id)}</b>`)}
        ${fila('Cuenta', _esc(_bancosMap[mov.banco_id]?.nombre || mov.banco_id))}
        ${fila('Concepto', _esc(mov.concepto))}
        ${fila('Monto', `${mov.tipo} ${formatNumber(mov.monto)}`)}
        ${fila('Saldo posterior', mov.saldo_posterior != null ? formatNumber(mov.saldo_posterior) : '—')}
        ${fila('Conciliado', mov.reconciliado ? 'Sí' : 'No')}
        ${fila('Vínculo', movRes.modo === 'vinculado' ? 'Directo' : 'Por coincidencia (registro antiguo)')}
      </table>` : `<p style="color:var(--text-secondary);">${movRes.modo === 'ambiguo' ? 'Varios movimientos coinciden: revisa Bancos.' : 'Sin movimiento bancario.'}</p>`}`
  } catch (e) {
    console.error('verDetalleCP:', e)
    body.innerHTML = `<p style="color:var(--color-danger);">Error: ${_esc(e.message)}</p>`
  }
}

// ── EDITAR ──────────────────────────────────────────────────────────────────

let _edicionCP = null   // { tipo, reg, doc }

window.abrirEditarCP = async function(tipo, id) {
  try {
    const esCobro = tipo === 'cobro'
    const reg = await _getRegCP(tipo, id)
    if (!reg) { showToast('Registro no encontrado', 'danger'); return }
    const doc = esCobro
      ? (reg.cxc_id ? await getCuentaCobrarById(reg.cxc_id) : null)
      : (reg.cxp_id ? await getCuentaPagarById(reg.cxp_id) : null)
    _edicionCP = { tipo, reg, doc }

    const $ = i => document.getElementById(i)
    $('ecp-titulo').textContent = esCobro ? `Editar Cobro #${id}` : `Editar Pago #${id}`
    $('ecpFecha').value      = reg.fecha || ''
    $('ecpMonto').value      = reg.monto
    $('ecpRetencion').value  = reg.monto_retencion || 0
    $('ecpTC').value         = reg.tipo_cambio ?? 1
    $('ecpReferencia').value = reg.referencia || ''
    $('ecpNumeroRecibo').value = reg.numero_recibo || ''
    $('ecpObs').value        = reg.observaciones || ''
    $('ecpCompRet').value    = reg.numero_comprobante_retencion || ''
    $('ecpMedio').innerHTML  = _MEDIOS_CP[tipo].map(([v, t]) => `<option value="${v}">${t}</option>`).join('')
    $('ecpMedio').value      = reg.medio_pago || 'transferencia'
    $('ecpBanco').innerHTML  = '<option value="">-- Sin banco --</option>' + _bancos.map(b =>
      `<option value="${b.id}">${_esc(b.nombre)} — ${_esc(b.numero_cuenta || '')} (${b.moneda || ''})</option>`).join('')
    $('ecpBanco').value      = reg.banco_id || ''
    document.querySelectorAll('.ecp-solo-cobro').forEach(el => { el.style.display = esCobro ? '' : 'none' })
    $('ecpArchivo').value = ''
    _adjPendientes.ecp = []; _pintarAdjPendientes('ecp')
    $('ecp-adjunto').innerHTML = _htmlAdjuntos(tipo, reg.id, await getAdjuntos(tipo, reg.id), true)

    const disponible = doc ? _r2((esCobro ? _saldoCxC(doc) : _saldoCxP(doc)) + _r2(reg.monto) + (esCobro ? _r2(reg.monto_retencion) : 0)) : null
    $('ecp-info').textContent = doc
      ? `${_descDocCP(doc)} — máximo aplicable (saldo + este ${esCobro ? 'cobro' : 'pago'}): ${doc.moneda || 'PEN'} ${formatNumber(disponible)}`
      : 'Sin documento vinculado.'
    window.openModal('modal-editar-cp')
  } catch (e) {
    console.error('abrirEditarCP:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

window.guardarEdicionCP = async function() {
  if (!_edicionCP) return
  const { tipo } = _edicionCP
  const esCobro = tipo === 'cobro'
  const $ = i => document.getElementById(i)
  try {
    // Releer: el registro pudo cambiar desde que se abrió el modal.
    const reg = await _getRegCP(tipo, _edicionCP.reg.id)
    if (!reg) { showToast('El registro ya no existe', 'danger'); return }

    const nuevo = {
      fecha:        $('ecpFecha').value,
      monto:        _r2($('ecpMonto').value),
      medio_pago:   $('ecpMedio').value,
      banco_id:     $('ecpBanco').value ? parseInt($('ecpBanco').value) : null,
      tipo_cambio:  parseFloat($('ecpTC').value || 1),
      referencia:   $('ecpReferencia').value.trim() || null,
      numero_operacion: $('ecpReferencia').value.trim() || null,
      observaciones: $('ecpObs').value.trim() || null
    }
    if (esCobro) {
      nuevo.monto_retencion = _r2($('ecpRetencion').value)
      nuevo.numero_comprobante_retencion = $('ecpCompRet').value.trim() || null
      nuevo.numero_recibo = $('ecpNumeroRecibo').value.trim() || null
      if (!_reciboValidoParaCliente(nuevo.numero_recibo, reg.contact_id, reg.id)) return
    }
    if (!nuevo.fecha)      { showToast('Ingresa la fecha', 'warning'); return }
    if (nuevo.monto <= 0)  { showToast('El monto debe ser mayor a 0', 'warning'); return }
    if (esCobro && nuevo.monto_retencion < 0) { showToast('La retención no puede ser negativa', 'warning'); return }

    // ¿Cambió algo que afecta dinero/contabilidad? → revertir + re-aplicar.
    nuevo.tipo_cambio = Math.round((parseFloat(nuevo.tipo_cambio) || 1) * 1e8) / 1e8
    // Asiento generado antes del 2026-10-03 (documento en USD sin importe en
    // moneda extranjera) → se regenera aunque no cambies nada, para pasarlo a soles.
    const asientoViejo = await _asientoSinME(reg)
    const cambioMonetario = nuevo.fecha !== reg.fecha
      || nuevo.monto !== _r2(reg.monto)
      || (nuevo.banco_id || null) !== (reg.banco_id || null)
      || nuevo.medio_pago !== reg.medio_pago
      || Math.abs(nuevo.tipo_cambio - (parseFloat(reg.tipo_cambio) || 1)) > 1e-9
      || (esCobro && nuevo.monto_retencion !== _r2(reg.monto_retencion))
      || asientoViejo

    await _subirAdjuntosPendientes('ecp', tipo, reg.id)

    if (!cambioMonetario) {
      const r = esCobro ? await updateCobro(reg.id, nuevo) : await updatePagoProveedor(reg.id, nuevo)
      if (!r) throw new Error('No se pudo actualizar')
      window.closeModal('modal-editar-cp')
      showToast('Datos actualizados ✅', 'success')
      await _recargarTrasCambioCP()
      return
    }

    // Validación contra el saldo del documento (sumando lo que este registro ya aplicaba).
    const docId = esCobro ? reg.cxc_id : reg.cxp_id
    if (docId) {
      const doc = esCobro ? await getCuentaCobrarById(docId) : await getCuentaPagarById(docId)
      const disponible = _r2((esCobro ? _saldoCxC(doc) : _saldoCxP(doc)) + _r2(reg.monto) + (esCobro ? _r2(reg.monto_retencion) : 0))
      const aplica = nuevo.monto + (esCobro ? nuevo.monto_retencion : 0)
      if (aplica > disponible + 0.01) {
        showToast(`El nuevo importe (${formatNumber(aplica)}) supera lo disponible (${formatNumber(disponible)})`, 'warning')
        return
      }
    }

    if (!confirm('Este cambio afecta importes/banco/fecha.\n\nSe revertirán el asiento, el movimiento bancario, la CxC/CxP y las cuotas, y se volverán a generar con los nuevos datos.\n\n¿Continuar?')) return

    // 1) Revertir efectos (mov. banco, cuotas, CxC/CxP)
    const { avisos, asiento } = await _revertirEfectosCP(tipo, reg)
    // 2) Desvincular y borrar el asiento anterior
    const desvinc = esCobro ? await updateCobro(reg.id, { asiento_id: null }) : await updatePagoProveedor(reg.id, { asiento_id: null })
    if (!desvinc) avisos.push('no se pudo desvincular el asiento anterior')
    if (asiento?.id) {
      try { await eliminarAsientoContable(asiento.id) }
      catch (e) { avisos.push('asiento anterior no eliminado: ' + e.message) }
    }
    // 3) Guardar nuevos datos en la misma fila
    const actualizado = esCobro ? await updateCobro(reg.id, nuevo) : await updatePagoProveedor(reg.id, nuevo)
    if (!actualizado) throw new Error('Efectos revertidos pero la fila no se actualizó. Revisa el registro antes de reintentar.')
    const regNuevo = { ...reg, ...nuevo }

    // 4) Re-aplicar con el documento fresco
    if (docId) {
      const docFresco = esCobro ? await getCuentaCobrarById(docId) : await getCuentaPagarById(docId)
      if (esCobro) await _aplicarEfectosCobro(regNuevo, docFresco)
      else         await _aplicarEfectosPago(regNuevo, docFresco)
    }

    window.closeModal('modal-editar-cp')
    showToast(`${esCobro ? 'Cobro' : 'Pago'} actualizado ✅${avisos.length ? ' — ⚠️ ' + avisos.join('; ') : ''}`, avisos.length ? 'warning' : 'success')
    await _recargarTrasCambioCP()
  } catch (e) {
    console.error('guardarEdicionCP:', e)
    showToast('Error al editar: ' + e.message, 'danger')
  }
}

// ============================================================================
// ACCIONES EN LAS TABLAS CxC / CxP (2026-09-30)
// ============================================================================
// Cada fila es un DOCUMENTO que puede tener 0, 1 o varios cobros/pagos:
//  👁 Ver detalle → documento + lista de sus cobros/pagos (cada uno con 👁 ✏️ ✕).
//  ✏️ / ✕ → si hay 1 solo cobro/pago actúa directo; si hay varios abre el
//           detalle para elegir cuál; si no hay ninguno, avisa.

function _movsDeDoc(tipoDoc, docId) {
  return tipoDoc === 'cxc'
    ? _cobrosList.filter(c => Number(c.cxc_id) === Number(docId))
    : _pagosList.filter(p => Number(p.cxp_id) === Number(docId))
}

function _letrasDeDoc(tipoDoc, docId) {
  return (_letrasCache || []).filter(l => tipoDoc === 'cxc'
    ? l.tipo === 'emitida' && Number(l.cxc_id) === Number(docId)
    : l.tipo === 'recibida' && Number(l.cxp_id) === Number(docId))
}

function _botonesDocCP(tipoDoc, docId) {
  const n = _movsDeDoc(tipoDoc, docId).length + _letrasDeDoc(tipoDoc, docId).length
  const nombre = tipoDoc === 'cxc' ? 'cobro' : 'pago'
  const dis = n ? '' : `disabled title="Sin ${nombre}s ni letras registrados"`
  return `<button class="btn btn-small btn-secondary" title="Ver detalle" onclick="window.accionDocCP('${tipoDoc}', ${docId}, 'ver')">👁</button>
    <button class="btn btn-small btn-secondary" ${dis || `title="Editar ${nombre}"`} onclick="window.accionDocCP('${tipoDoc}', ${docId}, 'editar')">✏️</button>
    <button class="btn btn-small btn-danger" ${dis || `title="Eliminar ${nombre}"`} onclick="window.accionDocCP('${tipoDoc}', ${docId}, 'eliminar')">✕</button>`
}

// ── Menú ⋮ por fila de CxC / CxP (2026-10-07) ─────────────────────────────
// Agrupa en un solo menú: Cobrar/Pagar · Ver detalle · Editar/Eliminar el
// cobro o pago · Canjear en letras · Eliminar el documento. Esta última solo
// para documentos SIN venta/compra vinculada (apertura o manuales) y sin
// cobros/pagos/letras — p. ej. la CxC de apertura duplicada de una factura
// que luego se importó como venta.
function _menuDocCP(tipoDoc, doc) {
  const esCxC = tipoDoc === 'cxc'
  const nMov = _movsDeDoc(tipoDoc, doc.id).length, nLet = _letrasDeDoc(tipoDoc, doc.id).length
  const pendiente = esCxC ? doc.estado !== 'cobrado' && doc.estado !== 'anulado' : doc.estado !== 'pagado' && doc.estado !== 'anulado'
  const nombre = esCxC ? 'cobro' : 'pago'
  const vinculado = esCxC ? doc.venta_id : doc.compra_id
  return menuAccionesFila([
    pendiente && { label: esCxC ? 'Cobrar' : 'Pagar', icono: '💵', onclick: `window.${esCxC ? 'irARegistrarCobro' : 'irARegistrarPago'}(${doc.id})` },
    { label: 'Ver detalle', icono: '👁', onclick: `window.accionDocCP('${tipoDoc}', ${doc.id}, 'ver')` },
    pendiente && { label: 'Canjear en letras', icono: '🔁', onclick: `window.canjearDocEnLetras('${tipoDoc}', ${doc.id})` },
    (nMov + nLet) > 0 && { separador: true },
    (nMov + nLet) > 0 && { label: `Editar ${nombre}${nLet ? '/letra' : ''}`, icono: '✏️', onclick: `window.accionDocCP('${tipoDoc}', ${doc.id}, 'editar')` },
    (nMov + nLet) > 0 && { label: `Eliminar ${nombre}${nLet ? '/letra' : ''}`, icono: '✕', peligro: true, onclick: `window.accionDocCP('${tipoDoc}', ${doc.id}, 'eliminar')` },
    !vinculado && { separador: true },
    !vinculado && { label: `Eliminar ${esCxC ? 'cuenta por cobrar' : 'cuenta por pagar'}`, icono: '🗑', peligro: true, onclick: `window.eliminarDocCP('${tipoDoc}', ${doc.id})` }
  ])
}

window.eliminarDocCP = async function (tipoDoc, docId) {
  const esCxC = tipoDoc === 'cxc'
  const doc = (esCxC ? _cxcList : _cxpList).find(d => d.id === docId)
  if (!doc) { showToast('Documento no encontrado', 'danger'); return }
  if (esCxC ? doc.venta_id : doc.compra_id) {
    showToast(`Esta ${esCxC ? 'CxC está vinculada a una venta' : 'CxP está vinculada a una compra'}: se elimina desde ${esCxC ? 'Ventas' : 'Compras'}`, 'warning'); return
  }
  const nMov = _movsDeDoc(tipoDoc, docId).length, nLet = _letrasDeDoc(tipoDoc, docId).length
  if (nMov || nLet) {
    showToast(`Tiene ${nMov} ${esCxC ? 'cobro' : 'pago'}(s) y ${nLet} letra(s): elimínalos primero desde 👁 Ver detalle`, 'warning'); return
  }
  if (doc.asiento_id) { showToast('Tiene asiento contable vinculado: revísalo en Contabilidad antes de eliminar', 'warning'); return }
  await (esCxC ? _cargarCuotas() : _cargarCuotasPagar())
  const cuotas = esCxC ? _cuotasDe(docId) : _cuotasPagarDe(docId)
  if (cuotas.some(q => parseFloat(q.monto_canjeado || 0) > 0 || parseFloat((esCxC ? q.monto_cobrado : q.monto_pagado) || 0) > 0)) {
    showToast('Alguna cuota ya tiene cobros/pagos o canjes aplicados: no se puede eliminar', 'warning'); return
  }
  if (!confirm(`¿Eliminar la ${esCxC ? 'cuenta por cobrar' : 'cuenta por pagar'} ${_descDocCP(doc)}?\n\n${_nombreContacto(doc.contact_id)} — ${doc.moneda || 'PEN'} ${formatNumber(doc.monto_total)}\n(sin venta/compra vinculada, sin ${esCxC ? 'cobros' : 'pagos'} ni letras${cuotas.length ? `; se borran sus ${cuotas.length} cuota(s)` : ''})\n\nEsta acción no se puede deshacer.`)) return
  try {
    for (const q of cuotas) {
      const ok = await (esCxC ? deleteCuotaCobrar(q.id) : deleteCuotaPagar(q.id))
      if (!ok) throw new Error(`no se pudo borrar la cuota ${q.numero_cuota}`)
    }
    const ok = await (esCxC ? deleteCuentaCobrar(docId) : deleteCuentaPagar(docId))
    if (!ok) throw new Error('no se pudo eliminar el documento (¿permisos/RLS o referencias?)')
    invalidarVarios([esCxC ? 'cuentas_cobrar' : 'cuentas_pagar', esCxC ? 'cuotas_cobrar' : 'cuotas_pagar'])
    showToast(`${esCxC ? 'CxC' : 'CxP'} ${_descDocCP(doc)} eliminada ✅`, 'success')
    if (esCxC) { _cuotasCache = _cuotasCache.filter(q => q.cxc_id !== docId); await cargarCxC() }
    else { _cuotasPagarCache = _cuotasPagarCache.filter(q => q.cxp_id !== docId); await cargarCxP() }
  } catch (e) {
    console.error('eliminarDocCP:', e)
    showToast('Error al eliminar: ' + e.message, 'danger')
  }
}

// Canjear en letras desde la fila: abre "Nueva Letra" con el tipo correcto y
// el selector de cuota filtrado a ESTE documento (primera cuota con saldo).
window.canjearDocEnLetras = async function (tipoDoc, docId) {
  const esCxC = tipoDoc === 'cxc'
  await window.abrirModalNuevaLetra()
  const tipoSel = document.getElementById('letTipo')
  tipoSel.value = esCxC ? 'emitida' : 'recibida'
  window.onCambiarTipoLetra()
  await _refrescarCuotasDoc(esCxC, docId)
  window.onCambiarTipoLetra()
  const sel = document.getElementById('letCuota')
  const cuotasDoc = new Set((esCxC ? _cuotasDe(docId) : _cuotasPagarDe(docId)).filter(q => saldoCuota(q) > 0.01).map(q => String(q.id)))
  ;[...sel.options].forEach(o => { if (o.value && !cuotasDoc.has(o.value)) o.remove() })
  if (!cuotasDoc.size) {
    document.getElementById('letCuotaAviso').textContent = '⚠ Este documento no tiene cuotas con saldo: revisa su cronograma (👁 Ver detalle) antes de canjear.'
    return
  }
  sel.value = [...cuotasDoc][0]
  try { refrescarBuscador('letCuota') } catch (_) {}
  window.onCambiarCuotaLetra()
}

window.accionDocCP = async function(tipoDoc, docId, accion) {
  const lista = _movsDeDoc(tipoDoc, docId)
  const letras = _letrasDeDoc(tipoDoc, docId)
  const tipo = tipoDoc === 'cxc' ? 'cobro' : 'pago'
  const total = lista.length + letras.length
  if (accion !== 'ver' && total === 0) { showToast(`Este documento no tiene ${tipo}s ni letras registrados`, 'info'); return }
  if (total === 1 && accion === 'editar')   return lista.length ? window.abrirEditarCP(tipo, lista[0].id) : window.abrirEditarLetra(letras[0].id)
  if (total === 1 && accion === 'eliminar') return lista.length ? window.eliminarCP(tipo, lista[0].id) : window.eliminarLetra(letras[0].id)
  if (accion !== 'ver') showToast(`Tiene ${total} registros (${tipo}s/letras): elige cuál en el detalle`, 'info')
  await _verDetalleDocCP(tipoDoc, docId)
}

async function _verDetalleDocCP(tipoDoc, docId) {
  const esCxC = tipoDoc === 'cxc'
  const tipo  = esCxC ? 'cobro' : 'pago'
  const body  = document.getElementById('detalle-cp-body')
  if (!body) return
  body.innerHTML = '<p style="text-align:center;">Cargando...</p>'
  window.openModal('modal-detalle-cp')
  try {
    const doc = esCxC ? await getCuentaCobrarById(docId) : await getCuentaPagarById(docId)
    if (!doc) { body.innerHTML = '<p>Documento no encontrado.</p>'; return }
    const pendiente = esCxC ? _saldoCxC(doc) : _saldoCxP(doc)
    document.getElementById('detalle-cp-titulo').textContent = `${esCxC ? 'CxC' : 'CxP'} ${_descDocCP(doc)}`
    document.getElementById('detalle-cp-acciones').innerHTML = `
      <button class="btn btn-secondary" onclick="window.closeModal('modal-detalle-cp')">Cerrar</button>
      ${pendiente > 0.01 ? `<button class="btn btn-primary" onclick="window.closeModal('modal-detalle-cp'); window.${esCxC ? 'irARegistrarCobro' : 'irARegistrarPago'}(${docId})">${esCxC ? 'Cobrar' : 'Pagar'}</button>` : ''}`

    await _refrescarCuotasDoc(esCxC, docId)
    const cuotas = esCxC ? _cuotasDe(docId) : _cuotasPagarDe(docId)
    const movs = _movsDeDoc(tipoDoc, docId).sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || a.id - b.id)
    const letrasDoc = _letrasDeDoc(tipoDoc, docId).sort((a, b) => String(a.fecha_vencimiento).localeCompare(String(b.fecha_vencimiento)))
    const fila = (k, v) => `<tr><td style="color:var(--text-secondary); width:40%;">${k}</td><td>${v}</td></tr>`
    const aplicadoSinMov = (esCxC ? parseFloat(doc.monto_canjeado || 0) + parseFloat(doc.monto_anticipo_aplicado || 0)
                                  : parseFloat(doc.monto_canjeado || 0) + parseFloat(doc.monto_anticipo_aplicado || 0))

    body.innerHTML = `
      <div style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info); font-size:0.88rem; line-height:1.6;">
        <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">${esCxC ? 'Cuenta por cobrar' : 'Cuenta por pagar'}</div>
        <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${_esc(_descDocCP(doc))}</div>
        <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">${_esc(_nombreContacto(doc.contact_id))} · Emisión ${fechaDMY(doc.fecha_emision, '—')} · Vence ${fechaDMY(doc.fecha_vencimiento, '—')}</div>
      </div>
      <table class="table-compact" style="width:100%; margin-top:10px;">
        ${fila('Total', `${doc.moneda || 'PEN'} ${formatNumber(doc.monto_total)}`)}
        ${fila(esCxC ? 'Cobrado' : 'Pagado', formatNumber(esCxC ? doc.monto_cobrado : doc.monto_pagado))}
        ${esCxC ? fila('Retenido', formatNumber(doc.monto_retenido || 0)) : ''}
        ${aplicadoSinMov > 0 ? fila('Anticipo / canje aplicado', formatNumber(aplicadoSinMov)) : ''}
        ${fila('Pendiente', `<b>${formatNumber(pendiente)}</b>`)}
        ${fila('Estado', doc.estado || '—')}
      </table>

      <h4 style="margin:16px 0 6px;">${esCxC ? 'Cobros' : 'Pagos'} registrados (${movs.length})</h4>
      ${movs.length ? `<div style="border:1px solid var(--border-color); border-radius:var(--radius-md); overflow:hidden; overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; margin:0;">
          <thead><tr style="background:var(--bg-secondary);">${esCxC ? '<th>N° Recibo</th>' : ''}<th>Fecha</th><th style="text-align:right;">Monto</th>${esCxC ? '<th style="text-align:right;">Retención</th>' : ''}<th>Medio</th><th>Banco</th><th>Referencia</th><th></th></tr></thead>
          <tbody>${movs.map(m => `<tr style="border-top:1px solid var(--border-color);">
            ${esCxC ? `<td>${_esc(m.numero_recibo || '—')}</td>` : ''}<td>${fechaDMY(m.fecha)}</td><td style="text-align:right;">${formatNumber(m.monto)}</td>
            ${esCxC ? `<td style="text-align:right;">${parseFloat(m.monto_retencion || 0) > 0 ? formatNumber(m.monto_retencion) : '—'}</td>` : ''}
            <td>${m.medio_pago || '—'}</td><td>${_esc(_bancosMap[m.banco_id]?.nombre || '—')}</td><td>${_esc(m.referencia || '—')}</td>
            <td style="white-space:nowrap;">${_botonesCP(tipo, m.id)}</td></tr>`).join('')}</tbody>
        </table></div>`
      : `<p style="color:var(--text-secondary);">Sin ${tipo}s registrados.${(esCxC ? doc.estado === 'cobrado' : doc.estado === 'pagado') && aplicadoSinMov < 0.01 ? ` ⚠️ Figura como ${doc.estado} sin ${tipo}s: revisar el origen del estado.` : ''}</p>`}

      ${letrasDoc.length ? `<h4 style="margin:16px 0 6px;">Letras (canje) (${letrasDoc.length})</h4>
      <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); overflow:hidden; overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; margin:0;">
          <thead><tr style="background:var(--bg-secondary);"><th>N° Letra</th><th>Vence</th><th style="text-align:right;">Monto</th><th>Estado</th><th></th></tr></thead>
          <tbody>${letrasDoc.map(l => `<tr style="border-top:1px solid var(--border-color);">
            <td>${_esc(l.numero_letra)}</td><td>${fechaDMY(l.fecha_vencimiento)}</td><td style="text-align:right;">${formatNumber(l.monto)}</td><td>${l.estado}</td>
            <td style="white-space:nowrap;">${_botonesLetra(l.id)}</td></tr>`).join('')}</tbody>
        </table></div>` : ''}

      ${cuotas.length ? `<h4 style="margin:16px 0 6px;">Cuotas</h4>
      <table class="table-compact" style="width:100%;">
        <thead><tr><th>N°</th><th>Vence</th><th style="text-align:right;">Monto</th><th style="text-align:right;">Saldo</th><th>Estado</th><th></th></tr></thead>
        <tbody>${cuotas.map(q => `<tr><td>${q.numero_cuota}</td><td>${fechaDMY(q.fecha_vencimiento)}</td><td style="text-align:right;">${formatNumber(q.monto)}</td><td style="text-align:right;">${formatNumber(saldoCuota(q))}</td><td>${q.estado}</td>
          <td style="white-space:nowrap;">${_botonesCuota(tipoDoc, q.id)}</td></tr>`).join('')}</tbody>
      </table>` : ''}`
  } catch (e) {
    console.error('_verDetalleDocCP:', e)
    body.innerHTML = `<p style="color:var(--color-danger);">Error: ${_esc(e.message)}</p>`
  }
}

// ============================================================================
// LETRAS — CANJE Y CANCELACIÓN CON EFECTO EN DOCUMENTO, BANCO Y CONTABILIDAD
// ============================================================================
// Canje   : la letra reemplaza a la factura → baja el saldo de la CxC/CxP
//           (monto_canjeado) + asiento 12131↔1211x (emitida) / 4211x↔42131
//           (recibida). No mueve banco: no entra ni sale dinero.
// Cancelar: el cliente paga la letra (o le pagamos al proveedor) → movimiento
//           bancario con N° de registro MB-xxxxxx + asiento banco↔letra.
//           Referencia del movimiento = "LETRA <n°>" (n° de letra es UNIQUE)
//           para poder revertirlo exacto.

async function _aplicarCanjeDoc(tipoLetra, docId, delta) {
  if (!docId) return
  const esCxC = tipoLetra === 'emitida'
  const doc = esCxC ? await getCuentaCobrarById(docId) : await getCuentaPagarById(docId)
  if (!doc) return
  const canjeado = Math.max(0, _r2(parseFloat(doc.monto_canjeado || 0) + parseFloat(delta || 0)))
  const d2 = { ...doc, monto_canjeado: canjeado }
  if (esCxC) await updateCuentaCobrar(docId, { monto_canjeado: canjeado, estado: _estadoCxCCalc(d2, parseFloat(doc.monto_cobrado || 0), parseFloat(doc.monto_retenido || 0)) })
  else       await updateCuentaPagar(docId,  { monto_canjeado: canjeado, estado: _estadoCxPCalc(d2, parseFloat(doc.monto_pagado || 0)) })
}

/** Asiento de una letra. etapa: 'canje' | 'cancelacion'. Nunca lanza: avisa y devuelve null. */
async function _asientoLetra(etapa, letra, bancoId, fecha = null, tcCancel = null) {
  try {
    const user = getCurrentUser()
    const m = _r2(letra.monto)
    const moneda = letra.moneda || 'PEN'
    const usd = moneda === 'USD'
    const emitida = letra.tipo === 'emitida'
    const tcDoc = parseFloat(letra.tipo_cambio) || 1
    const base = {
      fecha: fecha || letra.fecha_emision, contactId: letra.contact_id, userId: user?.db_id || null,
      monto: m, moneda
    }
    if (etapa === 'canje') {
      // Canje: ambos lados al T.C. de la factura (no hay diferencia de cambio)
      return await crearAsientoCancelacionME({
        ...base, descripcion: `Canje ${emitida ? 'factura por letra' : 'letra aceptada'} ${letra.numero_letra}`,
        documentoReferencia: `LETRA-${letra.id}`, tipoMovimiento: 'Canje Letra',
        cuentaDebe: emitida ? ctaCob('ctaLetrasCobrar', '12131') : (usd ? ctaCob('ctaCxpME', '42122') : ctaCob('ctaCxpMN', '42111')),
        cuentaHaber: emitida ? (usd ? ctaCob('ctaCxcME', '12112') : ctaCob('ctaCxcMN', '12111')) : ctaCob('ctaLetrasPagar', '42131'),
        tcDebe: tcDoc, tcHaber: tcDoc,
        descDebe: emitida ? 'Letras por cobrar' : 'Canje de factura', descHaber: emitida ? 'Canje de factura' : 'Letras por pagar'
      })
    }
    // Cobro/pago de la letra: banco al T.C. del día, letra al T.C. de la factura → 776/676
    const banco = bancoId ? await getBancoById(bancoId) : null
    const ctaBanco = banco?.cuenta_contable_codigo || ctaCob('ctaBancoDefault', '10411')
    const tcC = parseFloat(tcCancel) || tcDoc
    return await crearAsientoCancelacionME({
      ...base, descripcion: `${emitida ? 'Cobro' : 'Pago'} letra ${letra.numero_letra}`,
      documentoReferencia: `LETRA-CANC-${letra.id}`, tipoMovimiento: emitida ? 'Cobro Letra' : 'Pago Letra',
      cuentaDebe: emitida ? ctaBanco : ctaCob('ctaLetrasPagar', '42131'), cuentaHaber: emitida ? ctaCob('ctaLetrasCobrar', '12131') : ctaBanco,
      tcDebe: emitida ? tcC : tcDoc, tcHaber: emitida ? tcDoc : tcC,
      descDebe: emitida ? 'Cobro de letra' : 'Cancelación letra por pagar', descHaber: emitida ? 'Cancelación letra por cobrar' : 'Pago de letra'
    })
  } catch (e) {
    console.warn(`Asiento de letra (${etapa}) no generado:`, e.message)
    showToast(`⚠️ Asiento de ${etapa} no generado: ${e.message}`, 'warning', 6000)
    return null
  }
}

/** Cuenta sugerida para letras: misma moneda y que sea banco (no caja/efectivo). */
const _bancoSugeridoLetra = mon => _bancos.find(b => b.moneda === mon && !/caja|efectivo/i.test(`${b.nombre} ${b.numero_cuenta || ''}`))
  || _bancos.find(b => b.moneda === mon)

// ============================================================================
// LETRAS — ABONOS (cobro total / parcial) Y REFINANCIACIÓN (renovar / unificar)
// ============================================================================
// Todo pago de una letra es un ABONO (tabla letras_abonos, SQL 77):
//   saldo de la letra = monto − monto_pagado
//   saldo 0 → 'cobrada' · saldo > 0 con abonos → 'parcial' (solo en cartera)
// Refinanciar = cerrar 1..N letras con saldo ('refinanciada') y crear 1..N
// letras nuevas por: saldos − abono en el acto + interés de refinanciación.
//   1 origen  → "renovación" (típico del banco: paga 50% + comisión)
//   N orígenes → "unificación" (varias letras chicas → una sola)
// Analogía: la letra es una alcancía al revés; cada abono le saca una parte
// y refinanciar es vaciar varias alcancías en una nueva.

const _n = v => _r2(parseFloat(v) || 0)
const _ESTADOS_ABIERTOS = ['cartera', 'banco', 'cobranza', 'parcial', 'protestada']
const _letraAbierta = l => _ESTADOS_ABIERTOS.includes(l?.estado)
const _saldoLetra = l => _letraAbierta(l) ? Math.max(0, _r2(_n(l.monto) - _n(l.monto_pagado))) : 0
const _hoyISO = () => new Date().toISOString().split('T')[0]
const _addDias = (iso, d) => { const f = new Date((iso || _hoyISO()) + 'T00:00:00'); f.setDate(f.getDate() + d); return f.toISOString().split('T')[0] }
const _diasAtraso = (venc, fecha) => { const d = _diasEntre(venc, fecha || _hoyISO()); return d && d > 0 ? d : 0 }
/** Moneda de la letra (y si faltara, la de su factura). Empresa bimoneda PEN/USD. */
const _monedaLetra = l => l?.moneda || (l?.tipo === 'recibida' ? _cxpList.find(c => c.id === l?.cxp_id) : _cxcList.find(c => c.id === l?.cxc_id))?.moneda || 'PEN'
const _monedaBanco = id => _bancosMap[id]?.moneda || _bancos.find(b => Number(b.id) === Number(id))?.moneda || null
const _SIMB = m => (m === 'USD' ? 'US$' : 'S/')
/** Badges "USD → PEN" en el modal; devuelve { monLetra, monCuenta, distinta }. */
function _pintarMonedas(contId, monLetra, bancoId) {
  const monCuenta = _monedaBanco(bancoId)
  const distinta = !!monCuenta && monCuenta !== monLetra
  const b = (m, t) => `<span class="badge ${m === 'USD' ? 'badge-info' : 'badge-secondary'}" title="${t}">${m}</span>`
  const c = document.getElementById(contId)
  if (c) c.innerHTML = b(monLetra, 'Moneda de la letra (de la factura original)') +
    (monCuenta ? ` → ${b(monCuenta, 'Moneda de la cuenta bancaria')}` : ' → <small style="color:var(--text-secondary);">elige cuenta</small>') +
    (distinta ? ` <small style="color:var(--color-warning);">⚠ se convierte al T.C.</small>` : '')
  return { monLetra, monCuenta, distinta }
}
const _ubicacionDeLetra = l => ['banco', 'cobranza'].includes(l?.estado) ? 'banco' : 'cartera'
const _MEDIOS_LETRA = {
  transferencia: 'Transferencia', deposito: 'Depósito en cuenta', efectivo: 'Efectivo', cheque: 'Cheque',
  yape_plin: 'Yape / Plin', banco_letra: 'Cobro de letra en banco', otro: 'Otro'
}
const _TIPOS_ABONO = { total: 'Cobro total', parcial: 'Abono parcial', renovacion: 'Renovación', unificacion: 'Unificación' }

function _errSQL77(e) {
  const m = e?.message || String(e)
  return /letras_abonos|letras_refinanciacion|monto_pagado|refinanciacion_id|schema cache|does not exist/i.test(m)
    ? new Error('Falta ejecutar el script SQL 77 (letras_abonos / refinanciación). Detalle: ' + m) : (e instanceof Error ? e : new Error(m))
}
async function _sb(q) { const { data, error } = await q; if (error) throw _errSQL77(error); return data }
const _abonosDeLetra = id => _sb(supabase.from('letras_abonos').select('*').eq('letra_id', id).order('fecha').order('id'))
const _insAbono = row => _sb(supabase.from('letras_abonos').insert(row).select().single())
const _updAbono = (id, d) => _sb(supabase.from('letras_abonos').update({ ...d, updated_at: new Date().toISOString() }).eq('id', id).select().single())
const _delAbono = id => _sb(supabase.from('letras_abonos').delete().eq('id', id))
async function _updLetra(id, d) {
  const r = await updateLetraCambio(id, { ...d, updated_at: new Date().toISOString() })
  if (!r) throw new Error('No se pudo actualizar la letra (¿ejecutaste el SQL 77?)')
  return r
}

// ── Recibos de cobranza: correlativo común a cobros y abonos de letras ──

/** Todos los recibos usados (cobros + abonos de letras emitidas). */
async function _todosLosRecibos() {
  const [cob, ab] = await Promise.all([
    supabase.from('cobros').select('id, numero_recibo, contact_id, fecha, monto, moneda, cxc_id, banco_id, medio_pago').not('numero_recibo', 'is', null),
    supabase.from('letras_abonos').select('id, numero_recibo, contact_id, fecha, monto_neto, monto_amortizado, interes, moneda, letra_id, refinanciacion_id, banco_id, medio, tipo_abono, tipo').not('numero_recibo', 'is', null)
  ])
  const out = (cob.data || []).filter(x => String(x.numero_recibo).trim()).map(x => ({ origen: 'cobro', ...x, importe: _n(x.monto) }))
  for (const a of (ab.data || [])) {
    if (a.tipo !== 'emitida' || !String(a.numero_recibo).trim()) continue
    out.push({ origen: 'abono', ...a, importe: _r2(_n(a.monto_amortizado) + _n(a.interes)) })
  }
  return out
}

/** Separa "001-000123" en { pref:'001-', num:123, ancho:6 }. */
function _partesRecibo(s) {
  const m = String(s || '').trim().match(/^(.*?)(\d+)$/)
  return m ? { pref: m[1], num: parseInt(m[2], 10), ancho: m[2].length } : null
}

/** Siguiente N° de recibo: el mayor usado + 1 (mismo prefijo y ancho). */
window._sugerirRecibo = async function (inputId) {
  const inp = document.getElementById(inputId)
  if (!inp) return
  try {
    const usados = (await _todosLosRecibos()).map(r => _partesRecibo(r.numero_recibo)).filter(Boolean)
    if (!usados.length) { showToast('Aún no hay recibos registrados: escribe el primero', 'info'); return }
    const mayor = usados.reduce((a, b) => (b.num > a.num ? b : a))
    inp.value = `${mayor.pref}${String(mayor.num + 1).padStart(mayor.ancho, '0')}`
    inp.dispatchEvent(new Event('input'))
  } catch (e) { showToast('No se pudo sugerir: ' + e.message, 'warning') }
}

/** Avisa si el N° de recibo ya está en un cobro/abono de OTRO cliente. */
async function _reciboLibreGlobal(numero, contactId, excluir = {}) {
  const n = (numero || '').trim().toLowerCase()
  if (!n) return true
  const todos = await _todosLosRecibos()
  const otro = todos.find(r => String(r.numero_recibo).trim().toLowerCase() === n
    && Number(r.contact_id) !== Number(contactId)
    && !(r.origen === excluir.origen && r.id === excluir.id))
  if (!otro) return true
  return confirm(`El recibo N° ${numero} ya está en un ${otro.origen === 'cobro' ? 'cobro' : 'abono de letra'} de OTRO cliente (${fechaDMY(otro.fecha)} — ${_nombreContacto(otro.contact_id)}).\n\n¿Guardar igual?`)
}

// ── Asiento genérico de letras ──
/**
 * origenes: [{ letra, monto }] → salen de 12131/42131 a su T.C. de origen.
 * nuevas:   [{ numero, monto }] → entran a 12131/42131 al tcNueva.
 * intRef:   interés de refinanciación (se suma a las nuevas).
 * abono:    { bancoId, amort, interes, portes, comision, otros, ubicacion, tcDia } | null
 * El banco va por el NETO; la diferencia de T.C. la cuadra 776/676.
 */
async function _asientoLetras({ ref, tipoMov, descripcion, fecha, l, origenes = [], nuevas = [], tcNueva = null, intRef = 0, abono = null, renov = false }) {
  try {
    const user = getCurrentUser()
    const emitida = l.tipo === 'emitida'
    const moneda = l.moneda || 'PEN'
    const ctaLetra = emitida ? ctaCob('ctaLetrasCobrar', '12131') : ctaCob('ctaLetrasPagar', '42131')
    const ladoOrig = emitida ? 'haber' : 'debe'
    const ladoNueva = emitida ? 'debe' : 'haber'
    const lineas = []
    for (const o of origenes) lineas.push({ cuenta: ctaLetra, lado: ladoOrig, monto: o.monto, tc: parseFloat(o.letra.tipo_cambio) || 1, desc: `Letra ${o.letra.numero_letra}` })
    for (const nv of nuevas) lineas.push({ cuenta: ctaLetra, lado: ladoNueva, monto: nv.monto, tc: tcNueva || 1, desc: `Nueva letra ${nv.numero}` })
    if (_n(intRef) > 0) lineas.push({
      cuenta: emitida ? ctaCob('ctaInteresRefin', ctaCob('ctaInteresCobrado', '772110')) : ctaCob('ctaInteresPagado', '679220'),
      lado: emitida ? 'haber' : 'debe', monto: intRef, tc: tcNueva || 1, desc: 'Interés de refinanciación'
    })
    let neto = 0
    if (abono) {
      const tcD = parseFloat(abono.tcDia) || parseFloat(l.tipo_cambio) || 1
      const banco = abono.bancoId ? await getBancoById(abono.bancoId) : null
      const ctaBanco = banco?.cuenta_contable_codigo || ctaCob('ctaBancoDefault', '10411')
      const ctaGastos = ctaCob('ctaGastosBancarios', '679218')
      const ctaComis = renov ? ctaCob('ctaComisionRenov', '679214') : ctaGastos
      neto = _calcLetraBanco(l, { base: abono.amort, intereses: abono.interes, portes: abono.portes, comision: abono.comision, otros: abono.otros }).neto
      lineas.push(
        { cuenta: emitida ? ctaCob('ctaInteresCobrado', '772110') : ctaCob('ctaInteresPagado', '679220'), lado: emitida ? 'haber' : 'debe', monto: abono.interes, tc: tcD, desc: emitida ? 'Interés moratorio cobrado' : 'Interés moratorio pagado' },
        { cuenta: ctaGastos, lado: 'debe', monto: _n(abono.portes) + _n(abono.otros), tc: tcD, desc: 'Portes y gastos bancarios' },
        { cuenta: ctaComis, lado: 'debe', monto: abono.comision, tc: tcD, desc: renov ? 'Comisión de renovación' : 'Comisión bancaria' },
        {
          cuenta: ctaBanco, lado: emitida ? (neto >= 0 ? 'debe' : 'haber') : (neto >= 0 ? 'haber' : 'debe'),
          // Cuenta en soles y letra en dólares: la línea de banco va en soles (sin importe ME)
          ...(banco?.moneda === 'PEN' && moneda === 'USD'
            ? { monto: _r2(Math.abs(neto) * tcD), tc: 1, moneda: 'PEN' }
            : { monto: Math.abs(neto), tc: tcD }),
          desc: (emitida ? 'Abono neto en cuenta' : 'Cargo neto en cuenta') + (banco?.moneda && banco.moneda !== moneda ? ` (${moneda}→${banco.moneda} T.C. ${tcD})` : '')
        }
      )
    }
    const tcRef = abono?.tcDia || tcNueva || parseFloat(l.tipo_cambio) || 1
    return await crearAsientoMultiME({ fecha, descripcion, documentoReferencia: ref, tipoMovimiento: tipoMov, contactId: l.contact_id, userId: user?.db_id || null, moneda, tcRef, lineas })
  } catch (e) {
    console.warn('Asiento de letras no generado:', e.message)
    showToast(`⚠️ Asiento no generado: ${e.message}`, 'warning', 7000)
    return null
  }
}

/** Neto que entra (emitida) o sale (recibida) del banco. */
function _calcLetraBanco(l, { base, intereses = 0, portes = 0, comision = 0, otros = 0 }) {
  const gastos = _r2(_n(portes) + _n(comision) + _n(otros))
  const neto = l.tipo === 'emitida' ? _r2(_n(base) + _n(intereses) - gastos) : _r2(_n(base) + _n(intereses) + gastos)
  return { gastos, neto }
}

async function _movPorId(id) {
  if (!id) return null
  const { data } = await supabase.from('movimientos_banco').select('*').eq('id', id).maybeSingle()
  return data || null
}

/** Revierte mov. bancario + asiento de un abono (no toca la letra ni borra la fila). */
async function _revertirContableAbono(ab, l) {
  const avisos = []
  let mov = await _movPorId(ab.movimiento_banco_id)
  if (!mov && ab.banco_id && l) {   // abonos migrados (SQL 77) sin vínculo directo
    const { data } = await supabase.from('movimientos_banco').select('*').eq('banco_id', ab.banco_id).eq('referencia', `LETRA ${l.numero_letra}`).limit(1)
    mov = data?.[0] || null
  }
  if (mov) await _eliminarMovimientoYSaldo(mov)
  else if (ab.banco_id) avisos.push('no se encontró el movimiento bancario del abono')
  const asId = ab.asiento_id
  if (asId) {
    await _updAbono(ab.id, { asiento_id: null, movimiento_banco_id: null })
    if (l && Number(l.asiento_cobro_id) === Number(asId)) await _updLetra(l.id, { asiento_cobro_id: null })
    try { await eliminarAsientoContable(asId) } catch (e) { avisos.push('asiento no eliminado: ' + e.message) }
  }
  return avisos
}

/** Recalcula monto_pagado y estado de la letra a partir de sus abonos. */
async function _recalcularLetra(l, estadoSiSinAbonos = null) {
  const abonos = await _abonosDeLetra(l.id)
  const pagado = _r2(abonos.reduce((s, a) => s + _n(a.monto_amortizado), 0))
  let estado
  if (pagado >= _n(l.monto) - 0.005) estado = 'cobrada'
  else if (pagado > 0.005) estado = 'parcial'
  else {
    const prev = estadoSiSinAbonos || abonos[0]?.estado_previo
    estado = prev && prev !== 'parcial' && prev !== 'cobrada' ? prev : 'cartera'
  }
  const ult = abonos[abonos.length - 1]
  const cambios = { monto_pagado: pagado, estado }
  if (estado === 'cobrada' && ult?.banco_id) cambios.banco_id = ult.banco_id
  if (estado === 'cartera' && l.estado === 'cobrada') cambios.banco_id = null
  await _updLetra(l.id, cambios)
  Object.assign(l, cambios)
  return { pagado, estado }
}

/**
 * Registra (o re-registra, si abonoId) un abono simple sobre UNA letra.
 * d = { ubicacion, medio, bancoId, fecha, numOp, recibo, tcDia, amort, interes, portes, comision, otros, obs }
 */
async function _registrarAbonoLetra(l, d, abonoId = null) {
  const emitida = l.tipo === 'emitida'
  const saldoAntes = _r2(_n(l.monto) - _n(l.monto_pagado))
  const tipoAbono = Math.abs(_n(d.amort) - saldoAntes) < 0.005 ? 'total' : 'parcial'
  const imp = { base: _n(d.amort), intereses: _n(d.interes), portes: _n(d.portes), comision: _n(d.comision), otros: _n(d.otros) }
  const { neto } = _calcLetraBanco(l, imp)
  const fila = {
    letra_id: l.id, tipo: l.tipo, contact_id: l.contact_id, tipo_abono: tipoAbono, ubicacion: d.ubicacion,
    medio: d.medio || null, fecha: d.fecha, banco_id: d.bancoId || null, moneda: l.moneda || 'PEN',
    tipo_cambio: d.tcDia || null, monto_amortizado: imp.base, interes: imp.intereses,
    gasto_portes: imp.portes, gasto_comision: imp.comision, gasto_otros: imp.otros, monto_neto: neto,
    numero_operacion: d.numOp || null, numero_recibo: d.recibo || null, observaciones: d.obs || null
  }
  const user = getCurrentUser()
  const ab = abonoId
    ? await _updAbono(abonoId, fila)
    : await _insAbono({ ...fila, estado_previo: l.estado, created_by: user?.db_id || null })
  const verbo = emitida ? 'Cobro' : 'Pago'
  const asiento = await _asientoLetras({
    ref: `LETRA-ABONO-${ab.id}`, tipoMov: emitida ? 'Cobro Letra' : 'Pago Letra', fecha: d.fecha, l,
    descripcion: `${tipoAbono === 'total' ? verbo : 'Abono'} letra ${l.numero_letra}`,
    origenes: [{ letra: l, monto: imp.base }],
    abono: { bancoId: d.bancoId, amort: imp.base, interes: imp.intereses, portes: imp.portes, comision: imp.comision, otros: imp.otros, tcDia: d.tcDia }
  })
  const mov = await _registrarMovimientoBancario({
    bancoId: d.bancoId, tipo: (emitida ? neto >= 0 : neto < 0) ? 'ingreso' : 'egreso', fecha: d.fecha,
    concepto: `${tipoAbono === 'total' ? verbo : 'Abono'} letra ${l.numero_letra} — ${_nombreContacto(l.contact_id)}${d.recibo ? ` (Rec. ${d.recibo})` : ''}`,
    categoria: emitida ? 'Cobranza letras' : 'Pago letras',
    referencia: `LETRA ${l.numero_letra}`, numeroOperacion: d.numOp,
    monto: Math.abs(neto), asientoId: asiento?.id || null, monedaMonto: l.moneda || 'PEN', tc: d.tcDia || 1
  })
  await _updAbono(ab.id, { asiento_id: asiento?.id || null, movimiento_banco_id: mov?.id || null })
  if (d.numOp) await _updLetra(l.id, { numero_operacion: d.numOp })
  const r = await _recalcularLetra(l)
  return { ab, asiento, mov, neto, ...r }
}

// ── Modal Cobrar / Abonar letra ──
let _clet = null   // { letra, abono (edición), ubicacion, modo }

function _segmento(contId, opciones, valor, onclick) {
  const c = document.getElementById(contId)
  if (!c) return
  const est = on => on
    ? 'background:var(--color-info, #3b82f6); color:#fff; border:1px solid var(--color-info, #3b82f6); font-weight:600; box-shadow:0 0 0 2px rgba(59,130,246,.25);'
    : 'background:var(--bg-secondary); color:var(--text-primary); border:1px solid var(--border-color);'
  c.innerHTML = opciones.map(o => `<button type="button" class="btn btn-small" ${o.disabled ? 'disabled' : ''}
    title="${_esc(o.title || '')}" onclick="${onclick}('${o.v}')" style="flex:1; min-width:120px; ${est(o.v === valor)}${o.disabled ? ' opacity:.45; cursor:not-allowed;' : ''}">${o.t}</button>`).join('')
}

function _optsBancos(sel, valor) {
  sel.innerHTML = '<option value="">-- Selecciona --</option>' + _bancos
    .map(b => `<option value="${b.id}">${_esc(b.nombre)} — ${_esc(b.numero_cuenta || '')} (${b.moneda || ''})</option>`).join('')
  sel.value = valor || ''
}

function _optsMedios(sel, valor) {
  sel.innerHTML = Object.entries(_MEDIOS_LETRA).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')
  sel.value = valor || 'transferencia'
}

window.abrirCancelarLetra = async function (id, abonoId = null) {
  const l = _letrasCache.find(x => x.id === id) || await _getLetra(id)
  if (!l) return
  let abono = null
  if (abonoId) {
    try { abono = (await _abonosDeLetra(id)).find(a => a.id === abonoId) } catch (e) { showToast(e.message, 'danger'); return }
    if (!abono) { showToast('Abono no encontrado', 'danger'); return }
    if (abono.refinanciacion_id) { showToast('Este abono es parte de una renovación/unificación: se deshace eliminando la refinanciación.', 'warning', 6000); return }
  } else if (!_letraAbierta(l)) { showToast(`La letra está ${l.estado}: no tiene saldo por ${l.tipo === 'emitida' ? 'cobrar' : 'pagar'}`, 'warning'); return }

  const $ = i => document.getElementById(i)
  const emitida = l.tipo === 'emitida'
  const mon = _monedaLetra(l)
  if (!l.moneda) l.moneda = mon
  const saldoDisp = _r2(_n(l.monto) - _n(l.monto_pagado) + (abono ? _n(abono.monto_amortizado) : 0))
  _clet = { letra: l, abono, saldoDisp, ubicacion: abono?.ubicacion || _ubicacionDeLetra(l), modo: abono ? (abono.tipo_abono === 'total' ? 'total' : 'parcial') : 'total' }

  $('clet-titulo').textContent = abono ? `Editar abono — letra ${l.numero_letra}` : `${emitida ? 'Cobrar / abonar' : 'Pagar / abonar'} letra ${l.numero_letra}`
  const atraso = _diasAtraso(l.fecha_vencimiento)
  $('clet-info').innerHTML = `
    <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap;">
      <div>
        <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">${emitida ? 'Letra por cobrar' : 'Letra por pagar'} · ${_esc(l.estado)}</div>
        <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${_esc(l.numero_letra)} — ${_esc(_nombreContacto(l.contact_id))}</div>
        <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">Vence ${fechaDMY(l.fecha_vencimiento)}${atraso ? ` · <b style="color:var(--color-danger);">${atraso} día(s) de atraso</b>` : ''}</div>
      </div>
      <div style="display:grid; grid-template-columns:repeat(3, auto); gap:4px 18px; text-align:right; font-size:0.85rem;">
        <span style="color:var(--text-secondary);">Monto</span><span style="color:var(--text-secondary);">Pagado</span><span style="color:var(--text-secondary);">Saldo</span>
        <b>${mon} ${formatNumber(l.monto)}</b><b>${mon} ${formatNumber(l.monto_pagado || 0)}</b><b style="color:var(--color-warning);">${mon} ${formatNumber(_saldoLetra(l))}</b>
      </div>
    </div>`
  $('cletId').value = id
  $('cletFecha').value = abono?.fecha || _hoyISO()
  $('cletNumOp').value = abono?.numero_operacion || ''
  $('cletRecibo').value = abono?.numero_recibo || ''
  $('cletObs').value = abono?.observaciones || ''
  $('cletTC').value = abono?.tipo_cambio || l.tipo_cambio || 1
  _optsBancos($('cletBanco'), abono?.banco_id || (_clet.ubicacion === 'banco' && l.banco_id) || _bancoSugeridoLetra(mon)?.id)
  _optsMedios($('cletMedio'), abono?.medio || (_clet.ubicacion === 'banco' ? 'banco_letra' : 'transferencia'))
  _pintarMonedas('cletMonedas', mon, $('cletBanco').value)
  $('cletMonto').value = (abono ? _n(abono.monto_amortizado) : saldoDisp).toFixed(2)
  const intAb = abono ? _n(abono.interes) : 0
  $('cletChkInteres').checked = intAb > 0
  $('cletInteres').value = intAb.toFixed(2)
  $('cletInteresBox').style.display = intAb > 0 ? '' : 'none'
  for (const [k, c] of [['cletPortes', 'gasto_portes'], ['cletComision', 'gasto_comision'], ['cletOtros', 'gasto_otros']]) $(k).value = _n(abono?.[c]).toFixed(2)
  $('cletChkGastos').checked = abono ? (_n(abono.gasto_portes) + _n(abono.gasto_comision) + _n(abono.gasto_otros)) > 0 : false
  $('cletMon').textContent = `(${mon})`
  $('cletLblRecibo').textContent = emitida ? 'N° Recibo de cobranza' : 'N° Recibo / constancia'
  $('cletLblInteres').textContent = emitida ? 'Cobrar interés moratorio' : 'Pagar interés moratorio'
  $('cletBtnOk').textContent = abono ? '💾 Guardar cambios' : '💾 Confirmar'
  _adjPendientes.clet = []; _pintarAdjPendientes('clet')
  _pintarAdjLetra(l.id)
  window._cletUbicacion(_clet.ubicacion, true)
  if (!abono) window._tcDefaultLetra(l).then(() => window._cletRecalc())
  window.openModal('modal-cancelar-letra')
}

window._cletCambioCuenta = function () {
  if (!_clet) return
  const m = _pintarMonedas('cletMonedas', _monedaLetra(_clet.letra), document.getElementById('cletBanco').value)
  // Letra en soles cobrada en cuenta en dólares (o al revés): hace falta el T.C. del día
  if (m.distinta && !(parseFloat(document.getElementById('cletTC').value) > 1)) window._tcDefaultLetra(_clet.letra, true).then(() => window._cletRecalc())
  else window._cletRecalc()
}

window._cletUbicacion = function (v, inicial = false) {
  if (!_clet) return
  _clet.ubicacion = v
  const l = _clet.letra
  const emitida = l.tipo === 'emitida'
  _segmento('cletUbicSeg', [
    { v: 'cartera', t: '📁 En cartera', title: 'El cliente paga directo (transferencia, depósito, efectivo…)' },
    { v: 'banco', t: '🏦 En banco', title: 'El banco cobró la letra (dietario): puede haber portes y comisión' }
  ], v, 'window._cletUbicacion')
  if (v === 'banco' && _clet.modo === 'parcial' && !_clet.abono) _clet.modo = 'total'
  if (!inicial) {
    const medio = document.getElementById('cletMedio')
    if (v === 'banco') medio.value = 'banco_letra'
    else if (medio.value === 'banco_letra') medio.value = 'transferencia'
    if (v === 'banco' && l.banco_id) document.getElementById('cletBanco').value = l.banco_id
    _pintarMonedas('cletMonedas', _monedaLetra(l), document.getElementById('cletBanco').value)
  }
  window._cletModo(_clet.modo, true)
}

window._cletModo = function (m, interno = false) {
  if (!_clet) return
  if (m === 'renovar') {
    const id = _clet.letra.id
    window.closeModal('modal-cancelar-letra')
    window.abrirRefinanciar([id], 'renovacion', _clet.ubicacion)
    return
  }
  _clet.modo = m
  const enBanco = _clet.ubicacion === 'banco'
  const emitida = _clet.letra.tipo === 'emitida'
  _segmento('cletModoSeg', [
    { v: 'total', t: emitida ? '✅ Cobro total' : '✅ Pago total' },
    { v: 'parcial', t: '➗ Abono parcial', disabled: enBanco && !_clet.abono, title: enBanco ? 'El banco no recibe pagos parciales: usa Renovar' : 'Paga una parte; la letra queda Parcial en cartera' },
    ...(_clet.abono ? [] : [{ v: 'renovar', t: '🔄 Renovar con nueva letra', title: 'Paga una parte y el saldo pasa a una letra nueva' }])
  ], m, 'window._cletModo')
  const inp = document.getElementById('cletMonto')
  if (m === 'total') { inp.value = _clet.saldoDisp.toFixed(2); inp.readOnly = true }
  else {
    inp.readOnly = false
    if (!interno && _n(inp.value) >= _clet.saldoDisp) inp.value = _r2(_clet.saldoDisp / 2).toFixed(2)
  }
  document.getElementById('cletHintModo').textContent = m === 'total'
    ? `Cancela el saldo completo (${formatNumber(_clet.saldoDisp)}). La letra queda ${emitida ? 'Cobrada' : 'Pagada'}.`
    : `Paga una parte (menos de ${formatNumber(_clet.saldoDisp)}). La letra sigue en cartera como Parcial hasta completar.`
  // Gastos: visibles en banco; en cartera solo si marcas "hubo gastos"
  document.getElementById('cletChkGastosWrap').style.display = enBanco ? 'none' : 'flex'
  const verGastos = enBanco || document.getElementById('cletChkGastos').checked
  document.getElementById('cletGastosBox').style.display = verGastos ? '' : 'none'
  window._cletRecalc()
}

window._cletToggleGastos = function () {
  document.getElementById('cletGastosBox').style.display = document.getElementById('cletChkGastos').checked ? '' : 'none'
  window._cletRecalc()
}

/** Interés moratorio sugerido: saldo × tasa/360 × días de atraso (⚙️ tasa anual). */
function _interesSugerido(saldo, venc, fecha) {
  const tasa = parseFloat(_cfgModuloLetras().tasaMoratoriaAnual) || 0
  const dias = _diasAtraso(venc, fecha)
  return { dias, tasa, monto: tasa > 0 && dias > 0 ? _r2(saldo * tasa / 100 / 360 * dias) : 0 }
}
const _cfgModuloLetras = () => { try { return getModuloConfig(MODULO) || {} } catch (_) { return {} } }

window._cletToggleInteres = function (forzarSugerido = false) {
  const chk = document.getElementById('cletChkInteres')
  const box = document.getElementById('cletInteresBox')
  box.style.display = chk.checked ? '' : 'none'
  if (chk.checked && (forzarSugerido || !_n(document.getElementById('cletInteres').value)) && _clet) {
    const s = _interesSugerido(_n(document.getElementById('cletMonto').value), _clet.letra.fecha_vencimiento, document.getElementById('cletFecha').value)
    document.getElementById('cletInteres').value = s.monto.toFixed(2)
  }
  window._cletRecalc()
}

function _impClet() {
  const v = id => _n(document.getElementById(id)?.value)
  const verGastos = _clet?.ubicacion === 'banco' || document.getElementById('cletChkGastos')?.checked
  return {
    base: v('cletMonto'),
    intereses: document.getElementById('cletChkInteres')?.checked ? v('cletInteres') : 0,
    portes: verGastos ? v('cletPortes') : 0, comision: verGastos ? v('cletComision') : 0, otros: verGastos ? v('cletOtros') : 0
  }
}

window._cletRecalc = function () {
  if (!_clet) return
  const l = _clet.letra
  const imp = _impClet()
  const s = _interesSugerido(imp.base, l.fecha_vencimiento, document.getElementById('cletFecha')?.value)
  const hint = document.getElementById('cletInteresHint')
  if (hint) hint.innerHTML = s.dias
    ? (s.tasa > 0 ? `${s.dias} día(s) de atraso × ${s.tasa}% anual = <b>${formatNumber(s.monto)}</b> sugerido · <a href="#" onclick="window._cletToggleInteres(true); return false;">usar sugerido</a>` : `${s.dias} día(s) de atraso. Configura la tasa moratoria en ⚙️ para sugerir el monto.`)
    : 'La letra no está vencida a esta fecha.'
  const queda = _r2(_clet.saldoDisp - imp.base)
  const neto = _pintarResumenLetra('cletResumen', l, imp, _clet.modo === 'total' ? 'Letra' : 'Amortiza', queda)
  _pintarConversion('cletResumen', _monedaLetra(l), document.getElementById('cletBanco')?.value, neto, parseFloat(document.getElementById('cletTC')?.value))
}

/** Agrega al resumen la caja "Entra/sale de la cuenta" cuando la cuenta es de otra moneda. */
function _pintarConversion(contId, monLetra, bancoId, neto, tc) {
  const cont = document.getElementById(contId)
  const monCuenta = _monedaBanco(bancoId)
  if (!cont || !monCuenta || monCuenta === monLetra) return
  const conv = _r2(_convMoneda(Math.abs(neto), monLetra, monCuenta, tc))
  cont.style.gridTemplateColumns = `repeat(${cont.children.length + 1}, 1fr)`
  cont.insertAdjacentHTML('beforeend', `<div title="${monLetra} ${formatNumber(Math.abs(neto))} ${monLetra === 'USD' ? '×' : '÷'} T.C. ${tc || '—'}"><div style="font-size:0.7rem; color:var(--text-secondary); text-transform:uppercase;">En la cuenta (${monCuenta})</div>
    <div style="font-weight:700; font-size:1.05rem; color:var(--color-info, #3b82f6);">${monCuenta} ${formatNumber(conv)}</div>
    <small style="color:var(--text-secondary); font-size:0.7rem;">T.C. ${tc || '—'}</small></div>`)
}

/** Resumen en cajas: capital, +intereses, ±gastos, neto (y saldo que queda). */
function _pintarResumenLetra(contId, l, imp, etiqueta = 'Letra', queda = null) {
  const { gastos, neto } = _calcLetraBanco(l, imp)
  const mon = l.moneda || 'PEN'
  const emitida = l.tipo === 'emitida'
  const caja = (t, v, fuerte, color) => `<div><div style="font-size:0.7rem; color:var(--text-secondary); text-transform:uppercase;">${t}</div>
    <div style="font-weight:${fuerte ? 700 : 500}; font-size:${fuerte ? '1.05rem' : '0.95rem'};${color ? ` color:${color};` : ''}">${mon} ${formatNumber(v)}</div></div>`
  const cont = document.getElementById(contId)
  if (!cont) return neto
  cont.style.gridTemplateColumns = `repeat(${queda == null ? 4 : 5}, 1fr)`
  cont.innerHTML = caja(etiqueta, imp.base) + caja('+ Intereses', imp.intereses) +
    caja(emitida ? '− Gastos' : '+ Gastos', gastos) +
    caja(emitida ? (neto >= 0 ? 'Neto que entra' : 'Neto que sale') : 'Neto que sale', Math.abs(neto), true, 'var(--color-success)') +
    (queda == null ? '' : caja('Saldo que queda', queda, false, queda < -0.009 ? 'var(--color-danger)' : (queda > 0.009 ? 'var(--color-warning)' : '')))
  return neto
}

window._tcDefaultLetraCanc = function () {
  if (_clet?.letra) window._tcDefaultLetra(_clet.letra).then(() => window._cletRecalc())
}

window.confirmarCancelarLetra = async function () {
  if (!_clet) return
  const $ = i => document.getElementById(i)
  const l = _clet.letra
  const editando = !!_clet.abono
  const d = {
    ubicacion: _clet.ubicacion, medio: $('cletMedio').value, bancoId: parseInt($('cletBanco').value || 0),
    fecha: $('cletFecha').value, numOp: $('cletNumOp').value.trim() || null, recibo: $('cletRecibo').value.trim() || null,
    tcDia: parseFloat($('cletTC').value) || parseFloat(l.tipo_cambio) || 1, obs: $('cletObs').value.trim() || null
  }
  const imp = _impClet()
  Object.assign(d, { amort: imp.base, interes: imp.intereses, portes: imp.portes, comision: imp.comision, otros: imp.otros })
  if (!d.bancoId) { showToast('Selecciona la cuenta (banco o caja)', 'warning'); return }
  if (!d.fecha) { showToast('Ingresa la fecha', 'warning'); return }
  if (!(d.amort > 0)) { showToast('El monto a amortizar debe ser mayor a 0', 'warning'); return }
  if (d.amort > _clet.saldoDisp + 0.005) { showToast(`El monto supera el saldo de la letra (${formatNumber(_clet.saldoDisp)})`, 'warning'); return }
  if (_clet.modo === 'parcial' && d.amort >= _clet.saldoDisp - 0.005) { showToast('Para pagar todo el saldo elige "Cobro total"', 'warning'); return }
  if (_clet.modo === 'parcial' && _clet.ubicacion === 'banco' && !editando) { showToast('En banco no hay abonos parciales: usa Renovar', 'warning'); return }
  const monCta = _monedaBanco(d.bancoId)
  const conv = monCta && monCta !== _monedaLetra(l)
  if (((l.moneda || 'PEN') === 'USD' || conv) && !(d.tcDia > 0)) { showToast('Ingresa el T.C. del día', 'warning'); return }
  if (conv && d.tcDia <= 1 && !confirm(`La letra está en ${_monedaLetra(l)} y la cuenta en ${monCta}, pero el T.C. es ${d.tcDia}.\n\n¿Seguro? (normalmente ~3.4)`)) return
  if (l.tipo === 'emitida' && !(await _reciboLibreGlobal(d.recibo, l.contact_id, editando ? { origen: 'abono', id: _clet.abono.id } : {}))) return
  if (editando && !confirm('Editar el abono regenera su asiento y su movimiento bancario.\n\n¿Continuar?')) return

  try {
    if (editando) {
      const av = await _revertirContableAbono(_clet.abono, l)
      if (av.length) showToast('⚠️ ' + av.join('; '), 'warning')
      // Quita temporalmente lo amortizado para validar contra el saldo correcto
      l.monto_pagado = _r2(_n(l.monto_pagado) - _n(_clet.abono.monto_amortizado))
    }
    const r = await _registrarAbonoLetra(l, d, editando ? _clet.abono.id : null)
    await _subirAdjuntosPendientes('clet', 'letra', l.id)
    window.closeModal('modal-cancelar-letra')
    const estadoTxt = r.estado === 'cobrada' ? (l.tipo === 'emitida' ? 'cobrada' : 'pagada') : `parcial — saldo ${formatNumber(_r2(_n(l.monto) - r.pagado))}`
    showToast(`Letra ${l.numero_letra} ${estadoTxt} ✅${r.mov?.id ? ` — ${_numMB(r.mov.id)}` : ''}${r.asiento?.id ? ` / ${r.asiento.numero_asiento}` : ''}`, 'success', 7000)
    _clet = null
    _refrescarTodo()
    await _recargarTrasLetra()
  } catch (e) {
    console.error('confirmarCancelarLetra:', e)
    showToast('Error: ' + e.message, 'danger', 8000)
  }
}

/** Elimina un abono simple: revierte banco + asiento y recalcula la letra. */
window.eliminarAbonoLetra = async function (letraId, abonoId) {
  try {
    const l = await _getLetra(letraId)
    const ab = (await _abonosDeLetra(letraId)).find(a => a.id === abonoId)
    if (!l || !ab) { showToast('Abono no encontrado', 'danger'); return }
    if (ab.refinanciacion_id) { showToast('Este abono es parte de una renovación/unificación: elimina la refinanciación.', 'warning', 6000); return }
    if (!confirm(`¿Eliminar el abono del ${fechaDMY(ab.fecha)} por ${formatNumber(ab.monto_amortizado)}${ab.numero_recibo ? ` (recibo ${ab.numero_recibo})` : ''}?\n\nSe borra su movimiento bancario y su asiento, y el saldo vuelve a la letra.`)) return
    const av = await _revertirContableAbono(ab, l)
    await _delAbono(ab.id)
    await _recalcularLetra(l, ab.estado_previo)
    if (av.length) showToast('⚠️ ' + av.join('; '), 'warning')
    showToast('Abono eliminado ✅', 'success')
    window.closeModal?.('modal-detalle-cp')
    _refrescarTodo()
    await _recargarTrasLetra()
  } catch (e) { showToast('Error: ' + e.message, 'danger', 8000) }
}

// ── Refinanciación: renovar (1 letra) o unificar (varias) ──
let _rfin = null   // { tipo, contactId, moneda, sel:Set, cand:[], ubicacion, filas:[] }

window.abrirRenovarLetra = id => window.abrirRefinanciar([id], 'renovacion')

window.abrirRefinanciar = async function (ids, modalidad = 'unificacion', ubicacion = null) {
  try {
    _letrasCache = await cacheado('letras_cambio', getLetrasCambio)
    const base = _letrasCache.find(x => x.id === ids[0])
    if (!base) return
    const cand = _letrasCache.filter(x => x.tipo === base.tipo && Number(x.contact_id) === Number(base.contact_id)
      && (x.moneda || 'PEN') === (base.moneda || 'PEN') && _letraAbierta(x) && _saldoLetra(x) > 0.005)
      .sort((a, b) => String(a.fecha_vencimiento).localeCompare(String(b.fecha_vencimiento)))
    const sel = new Set(ids.filter(id => cand.some(c => c.id === id)))
    if (!sel.size) { showToast('La letra no tiene saldo pendiente', 'warning'); return }
    const renov = modalidad === 'renovacion'
    _rfin = { tipo: base.tipo, contactId: base.contact_id, moneda: _monedaLetra(base), sel, cand, modalidad, ubicacion: ubicacion || _ubicacionDeLetra(base), filas: [], tcEditado: false }
    const $ = i => document.getElementById(i)
    const emitida = base.tipo === 'emitida'
    $('rfin-titulo').textContent = renov ? `Renovar letra ${base.numero_letra}` : `Unificar letras — ${_nombreContacto(base.contact_id)}`
    $('rfin-info').innerHTML = `<div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">${emitida ? 'Letras por cobrar' : 'Letras por pagar'} · ${_rfin.moneda}</div>
      <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${_esc(_nombreContacto(base.contact_id))}</div>
      <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">Marca las letras a refinanciar: sus saldos se cierran y nacen las letras nuevas de abajo.</div>`
    $('rfinFecha').value = _hoyISO()
    $('rfinChkAbono').checked = renov
    $('rfinChkIntRef').checked = false
    $('rfinIntRef').value = '0.00'
    for (const k of ['rfinInteres', 'rfinPortes', 'rfinComision', 'rfinOtros']) $(k).value = '0.00'
    $('rfinChkInteres').checked = false
    $('rfinChkGastos').checked = false
    $('rfinNumOp').value = ''; $('rfinRecibo').value = ''; $('rfinObs').value = ''
    $('rfinTCDia').value = base.tipo_cambio || 1
    _optsBancos($('rfinBanco'), (_rfin.ubicacion === 'banco' && base.banco_id) || _bancoSugeridoLetra(_rfin.moneda)?.id)
    _optsMedios($('rfinMedio'), _rfin.ubicacion === 'banco' ? 'banco_letra' : 'transferencia')
    _pintarMonedas('rfinMonedas', _rfin.moneda, $('rfinBanco').value)
    $('rfinPct').value = renov ? 50 : 0
    $('rfinCantidad').value = 1
    $('rfinIntervalo').value = 30
    $('rfinPrefijo').value = renov ? '' : `${String(base.numero_letra).replace(/-R\d*$/, '').replace(/-\d+$/, '')}-U`
    $('rfinPrimerVenc').value = _addDias(renov ? base.fecha_vencimiento : _hoyISO(), 30)
    $('rfinLblRecibo').textContent = emitida ? 'N° Recibo de cobranza' : 'N° Recibo / constancia'
    $('rfinMon').textContent = `(${_rfin.moneda})`
    $('rfinBtnOk').textContent = renov ? '💾 Renovar letra' : '💾 Unificar letras'
    _adjPendientes.rfin = []; _pintarAdjPendientes('rfin')
    _rfinPintarOrigenes()
    window._rfinUbicacion(_rfin.ubicacion, true)
    window._rfinToggleAbono()
    window._rfinTCSugerido()
    window._rfinGenerar()
    if (_rfin.moneda === 'USD') getTipoCambioDia($('rfinFecha').value, { permitirApi: false }).then(r => {
      const v = emitida ? r?.venta : r?.compra
      if (v > 0) { $('rfinTCDia').value = v; window._rfinRecalc() }
    }).catch(() => {})
    window.openModal('modal-refinanciar-letras')
  } catch (e) { console.error('abrirRefinanciar:', e); showToast('Error: ' + e.message, 'danger') }
}

const _rfinOrigenes = () => _rfin ? _rfin.cand.filter(c => _rfin.sel.has(c.id)) : []
const _rfinTotalSaldos = () => _r2(_rfinOrigenes().reduce((s, x) => s + _saldoLetra(x), 0))

function _rfinPintarOrigenes() {
  const tb = document.getElementById('rfinOrigenesBody')
  if (!tb || !_rfin) return
  const mon = _rfin.moneda
  tb.innerHTML = _rfin.cand.map(x => {
    const on = _rfin.sel.has(x.id)
    const atraso = _diasAtraso(x.fecha_vencimiento)
    return `<tr style="border-top:1px solid var(--border-color);${on ? ' background:rgba(59,130,246,0.07);' : ' opacity:.65;'}">
      <td style="text-align:center; padding:6px;"><input type="checkbox" style="width:auto; margin:0;" ${on ? 'checked' : ''} onchange="window._rfinToggleOrigen(${x.id}, this.checked)"></td>
      <td style="padding:6px 10px; font-weight:600;">${_esc(x.numero_letra)}</td>
      <td style="padding:6px 10px;">${fechaDMY(x.fecha_vencimiento)}${atraso ? ` <small style="color:var(--color-danger);">(${atraso} d)</small>` : ''}</td>
      <td style="padding:6px 10px;"><span class="badge ${x.estado === 'parcial' ? 'badge-warning' : (x.estado === 'banco' ? 'badge-info' : 'badge-secondary')}">${x.estado}</span></td>
      <td style="padding:6px 10px; text-align:right;">${formatNumber(x.monto)}</td>
      <td style="padding:6px 10px; text-align:right;">${formatNumber(x.monto_pagado || 0)}</td>
      <td style="padding:6px 10px; text-align:right; font-weight:600;">${formatNumber(_saldoLetra(x))}</td>
      <td style="padding:6px 10px; text-align:right; color:var(--text-secondary);">${mon === 'USD' ? (parseFloat(x.tipo_cambio) || 1).toFixed(3) : '—'}</td>
    </tr>`
  }).join('')
  const n = _rfin.sel.size
  document.getElementById('rfinOrigenesFoot').innerHTML = `<td></td><td colspan="5" style="padding:8px 10px;">${n} letra(s) seleccionada(s)</td>
    <td style="padding:8px 10px; text-align:right; font-weight:700;">${mon} ${formatNumber(_rfinTotalSaldos())}</td><td></td>`
}

window._rfinToggleOrigen = function (id, on) {
  if (!_rfin) return
  if (on) _rfin.sel.add(id); else _rfin.sel.delete(id)
  if (!_rfin.sel.size) { _rfin.sel.add(id); showToast('Debe quedar al menos una letra', 'warning') }
  _rfin.modalidad = _rfin.sel.size > 1 ? 'unificacion' : 'renovacion'
  document.getElementById('rfinBtnOk').textContent = _rfin.modalidad === 'renovacion' ? '💾 Renovar letra' : '💾 Unificar letras'
  _rfinPintarOrigenes()
  if (!_rfin.tcEditado) window._rfinTCSugerido()
  window._rfinGenerar()
}

/** T.C. de las letras nuevas = promedio ponderado (por saldo) de las originales. */
window._rfinTCSugerido = function () {
  if (!_rfin) return
  const o = _rfinOrigenes()
  const tot = o.reduce((s, x) => s + _saldoLetra(x), 0)
  const tc = tot > 0 ? o.reduce((s, x) => s + _saldoLetra(x) * (parseFloat(x.tipo_cambio) || 1), 0) / tot : 1
  const inp = document.getElementById('rfinTCNueva')
  inp.value = _rfin.moneda === 'USD' ? tc.toFixed(4) : '1'
  inp.dataset.sugerido = inp.value
  _rfin.tcEditado = false
  window._rfinRecalc()
}

window._rfinCambioCuenta = function () {
  if (!_rfin) return
  const m = _pintarMonedas('rfinMonedas', _rfin.moneda, document.getElementById('rfinBanco').value)
  if (m.distinta && !(parseFloat(document.getElementById('rfinTCDia').value) > 1)) {
    getTipoCambioDia(document.getElementById('rfinFecha').value, { permitirApi: false }).then(r => {
      const v = _rfin.tipo === 'emitida' ? r?.venta : r?.compra
      if (v > 0) document.getElementById('rfinTCDia').value = v
      window._rfinRecalc()
    }).catch(() => window._rfinRecalc())
  } else window._rfinRecalc()
}

window._rfinUbicacion = function (v, inicial = false) {
  if (!_rfin) return
  _rfin.ubicacion = v
  _segmento('rfinUbicSeg', [
    { v: 'cartera', t: '📁 En cartera', title: 'Paga directo al negocio' },
    { v: 'banco', t: '🏦 En banco', title: 'Operación en el banco: portes y comisión de renovación' }
  ], v, 'window._rfinUbicacion')
  if (!inicial) {
    const medio = document.getElementById('rfinMedio')
    if (v === 'banco') medio.value = 'banco_letra'
    else if (medio.value === 'banco_letra') medio.value = 'transferencia'
  }
  document.getElementById('rfinChkGastosWrap').style.display = v === 'banco' ? 'none' : 'flex'
  document.getElementById('rfinGastosBox').style.display = v === 'banco' || document.getElementById('rfinChkGastos').checked ? '' : 'none'
  window._rfinRecalc()
}

window._rfinTC_edit = function () { if (_rfin) _rfin.tcEditado = true; window._rfinRecalc() }

window._rfinToggleAbono = function () {
  const on = document.getElementById('rfinChkAbono').checked
  document.getElementById('rfinAbonoBox').style.display = on ? '' : 'none'
  if (on && !_n(document.getElementById('rfinAmort').value)) window._rfinDesdePct()
  else window._rfinGenerar()
}
window._rfinToggleGastos = function () {
  document.getElementById('rfinGastosBox').style.display = _rfin?.ubicacion === 'banco' || document.getElementById('rfinChkGastos').checked ? '' : 'none'
  window._rfinRecalc()
}
window._rfinToggleInteres = function () {
  const on = document.getElementById('rfinChkInteres').checked
  document.getElementById('rfinInteresBox').style.display = on ? '' : 'none'
  if (on && !_n(document.getElementById('rfinInteres').value)) {
    const fecha = document.getElementById('rfinFecha').value
    const s = _rfinOrigenes().reduce((t, x) => t + _interesSugerido(_saldoLetra(x), x.fecha_vencimiento, fecha).monto, 0)
    document.getElementById('rfinInteres').value = _r2(s).toFixed(2)
  }
  window._rfinRecalc()
}
window._rfinToggleIntRef = function () {
  document.getElementById('rfinIntRefBox').style.display = document.getElementById('rfinChkIntRef').checked ? '' : 'none'
  window._rfinGenerar()
}
window._rfinIntRefDesdePct = function () {
  const pct = _n(document.getElementById('rfinIntRefPct').value)
  const base = _r2(_rfinTotalSaldos() - _rfinAmort())
  document.getElementById('rfinIntRef').value = _r2(base * pct / 100).toFixed(2)
  window._rfinGenerar()
}
window._rfinDesdePct = function () {
  const pct = Math.min(99.99, Math.max(0, _n(document.getElementById('rfinPct').value)))
  document.getElementById('rfinAmort').value = _r2(_rfinTotalSaldos() * pct / 100).toFixed(2)
  window._rfinGenerar()
}
window._rfinDesdeMonto = function () {
  const tot = _rfinTotalSaldos()
  const a = _n(document.getElementById('rfinAmort').value)
  document.getElementById('rfinPct').value = tot > 0 ? +(a / tot * 100).toFixed(2) : 0
  window._rfinGenerar()
}

const _rfinAmort = () => document.getElementById('rfinChkAbono')?.checked ? _n(document.getElementById('rfinAmort').value) : 0
const _rfinIntRef = () => document.getElementById('rfinChkIntRef')?.checked ? _n(document.getElementById('rfinIntRef').value) : 0
const _rfinADocumentar = () => _r2(_rfinTotalSaldos() - _rfinAmort() + _rfinIntRef())

function _impRfin() {
  const v = id => _n(document.getElementById(id)?.value)
  const conAbono = document.getElementById('rfinChkAbono')?.checked
  const verGastos = _rfin?.ubicacion === 'banco' || document.getElementById('rfinChkGastos')?.checked
  if (!conAbono) return { base: 0, intereses: 0, portes: 0, comision: 0, otros: 0 }
  return {
    base: v('rfinAmort'),
    intereses: document.getElementById('rfinChkInteres')?.checked ? v('rfinInteres') : 0,
    portes: verGastos ? v('rfinPortes') : 0, comision: verGastos ? v('rfinComision') : 0, otros: verGastos ? v('rfinOtros') : 0
  }
}

/** Reparte el total a documentar en N letras (la última absorbe los centavos). */
window._rfinGenerar = function () {
  if (!_rfin) return
  const $ = i => document.getElementById(i)
  const total = _rfinADocumentar()
  const n = Math.min(60, Math.max(1, parseInt($('rfinCantidad').value || 1) || 1))
  const intervalo = Math.max(1, parseInt($('rfinIntervalo').value || 30) || 30)
  const primer = $('rfinPrimerVenc').value || _addDias($('rfinFecha').value, intervalo)
  const pref = $('rfinPrefijo').value.trim()
  const unica = _rfinOrigenes()[0]
  const base = Math.floor((total / n) * 100) / 100
  _rfin.filas = Array.from({ length: n }, (_, i) => ({
    numero: (n === 1 && _rfin.modalidad === 'renovacion' && !pref) ? _siguienteNumeroRenov(unica.numero_letra) : `${pref || 'LT-'}${String(i + 1).padStart(2, '0')}`,
    monto: i === n - 1 ? _r2(total - base * (n - 1)) : base,
    venc: _addDias(primer, i * intervalo)
  }))
  _rfinPintarFilas()
}
window._rfinAgregarFila = function () {
  if (!_rfin) return
  const usado = _rfin.filas.reduce((s, f) => s + _n(f.monto), 0)
  const ult = _rfin.filas[_rfin.filas.length - 1]
  const pref = document.getElementById('rfinPrefijo').value.trim() || 'LT-'
  _rfin.filas.push({ numero: `${pref}${String(_rfin.filas.length + 1).padStart(2, '0')}`, monto: Math.max(0, _r2(_rfinADocumentar() - usado)), venc: ult?.venc ? _addDias(ult.venc, 30) : document.getElementById('rfinPrimerVenc').value })
  _rfinPintarFilas()
}
window._rfinQuitarFila = function (i) { if (_rfin.filas.length > 1) { _rfin.filas.splice(i, 1); _rfinPintarFilas() } else showToast('Debe quedar al menos una letra nueva', 'warning') }
window._rfinSet = function (i, campo, valor) {
  if (!_rfin?.filas[i]) return
  _rfin.filas[i][campo] = campo === 'monto' ? _n(valor) : valor
  if (campo === 'venc') { const td = document.getElementById(`rfinPlazo${i}`); if (td) td.textContent = (_diasEntre(document.getElementById('rfinFecha').value, valor) ?? '—') + ' d' }
  window._rfinRecalc()
}

function _rfinPintarFilas() {
  const tb = document.getElementById('rfinFilasBody')
  if (!tb) return
  const fecha = document.getElementById('rfinFecha').value
  const inp = 'style="width:100%; padding:6px 8px;"'
  tb.innerHTML = _rfin.filas.map((f, i) => `<tr style="border-top:1px solid var(--border-color);">
      <td style="text-align:center; padding:6px 10px; color:var(--text-secondary);">${i + 1}</td>
      <td style="padding:6px 10px;"><input type="text" ${inp} value="${_esc(f.numero)}" oninput="window._rfinSet(${i}, 'numero', this.value)"></td>
      <td style="padding:6px 10px;"><input type="number" step="0.01" min="0.01" style="width:100%; padding:6px 8px; text-align:right;" value="${_n(f.monto).toFixed(2)}" oninput="window._rfinSet(${i}, 'monto', this.value)"></td>
      <td style="padding:6px 10px;"><input type="date" ${inp} value="${f.venc || ''}" onchange="window._rfinSet(${i}, 'venc', this.value)"></td>
      <td id="rfinPlazo${i}" style="text-align:right; padding:6px 10px; color:var(--text-secondary); font-size:0.85rem;">${_diasEntre(fecha, f.venc) ?? '—'} d</td>
      <td style="text-align:center; padding:6px;"><button type="button" class="btn btn-small btn-danger" title="Quitar" onclick="window._rfinQuitarFila(${i})">✕</button></td>
    </tr>`).join('')
  window._rfinRecalc()
}

window._rfinRecalc = function () {
  if (!_rfin) return
  const $ = i => document.getElementById(i)
  const mon = _rfin.moneda
  const saldos = _rfinTotalSaldos()
  const imp = _impRfin()
  const intRef = _rfinIntRef()
  const aDoc = _r2(saldos - imp.base + intRef)
  const enLetras = _r2(_rfin.filas.reduce((s, f) => s + _n(f.monto), 0))
  const dif = _r2(aDoc - enLetras)
  const lTipo = { tipo: _rfin.tipo }
  const { neto } = _calcLetraBanco(lTipo, imp)
  const tcN = $('rfinTCNueva')
  const tcAviso = $('rfinTCAviso')
  if (tcAviso) tcAviso.textContent = mon !== 'USD' ? '' : (Math.abs(_n(tcN.value) - _n(tcN.dataset.sugerido)) > 0.00005
    ? `⚠ Distinto del promedio ponderado (${tcN.dataset.sugerido}): generará diferencia de cambio.` : 'Promedio ponderado de las letras originales: sin diferencia de cambio.')
  const caja = (t, v, st = '') => `<div><div style="font-size:0.7rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">${t}</div><div style="font-weight:700; font-size:1.02rem;${st}">${mon} ${formatNumber(v)}</div></div>`
  const colorDif = Math.abs(dif) < 0.01 ? 'var(--color-success)' : 'var(--color-danger)'
  $('rfinResumen').innerHTML =
    caja('Saldos de origen', saldos) +
    caja('− Amortización', imp.base) +
    caja('+ Interés refinanc.', intRef) +
    caja('= A documentar', aDoc) +
    caja(`En ${_rfin.filas.length} letra(s) nueva(s)`, enLetras) +
    caja(Math.abs(dif) < 0.01 ? 'Cuadra ✔' : 'Diferencia', dif, ` color:${colorDif};`) +
    (document.getElementById('rfinChkAbono').checked ? caja(_rfin.tipo === 'emitida' ? 'Banco: neto que entra' : 'Banco: neto que sale', Math.abs(neto), ' color:var(--color-success);') : '')
  if (document.getElementById('rfinChkAbono').checked) _pintarConversion('rfinResumen', mon, $('rfinBanco').value, neto, parseFloat($('rfinTCDia').value))
  const btn = $('rfinBtnOk')
  if (btn && !btn.classList.contains('btn-cargando')) btn.disabled = Math.abs(dif) >= 0.01
}

window.confirmarRefinanciar = async function () {
  if (!_rfin) return
  const $ = i => document.getElementById(i)
  const origenes = _rfinOrigenes()
  const l0 = origenes[0]
  const emitida = _rfin.tipo === 'emitida'
  const fecha = $('rfinFecha').value
  const conAbono = $('rfinChkAbono').checked
  const imp = _impRfin()
  const intRef = _rfinIntRef()
  const saldos = _rfinTotalSaldos()
  const tcNueva = _rfin.moneda === 'USD' ? (parseFloat($('rfinTCNueva').value) || 0) : 1
  const filas = _rfin.filas.map(f => ({ ...f, numero: String(f.numero || '').trim(), monto: _n(f.monto) }))
  const ab = conAbono ? {
    ubicacion: _rfin.ubicacion, medio: $('rfinMedio').value, bancoId: parseInt($('rfinBanco').value || 0),
    numOp: $('rfinNumOp').value.trim() || null, recibo: $('rfinRecibo').value.trim() || null,
    tcDia: parseFloat($('rfinTCDia').value) || tcNueva || 1,
    amort: imp.base, interes: imp.intereses, portes: imp.portes, comision: imp.comision, otros: imp.otros
  } : null

  // ── Validaciones (de lo general a lo específico) ──
  if (!origenes.length) { showToast('Marca al menos una letra a refinanciar', 'warning'); return }
  if (!fecha) { showToast('Ingresa la fecha de la operación', 'warning'); return }
  if (_rfin.moneda === 'USD' && !(tcNueva > 0)) { showToast('Ingresa el T.C. de las letras nuevas', 'warning'); return }
  if (ab) {
    if (!ab.bancoId) { showToast('Selecciona la cuenta donde entra/sale el abono', 'warning'); return }
    const monCtaR = _monedaBanco(ab.bancoId)
    if (monCtaR && monCtaR !== _rfin.moneda && !(ab.tcDia > 1) && !confirm(`Letras en ${_rfin.moneda} y cuenta en ${monCtaR} con T.C. ${ab.tcDia}. ¿Seguro?`)) return
    if (ab.amort < 0) { showToast('La amortización no puede ser negativa', 'warning'); return }
    if (ab.amort >= saldos - 0.005) { showToast('Si paga todo el saldo no hay refinanciación: usa Cobrar/Pagar', 'warning'); return }
    if (!(ab.amort > 0 || ab.interes > 0 || ab.portes + ab.comision + ab.otros > 0)) { showToast('El abono está en 0: desmarca "Paga en el acto" o ingresa importes', 'warning'); return }
  }
  if (intRef < 0) { showToast('El interés de refinanciación no puede ser negativo', 'warning'); return }
  const aDoc = _r2(saldos - (ab?.amort || 0) + intRef)
  if (!filas.length) { showToast('Agrega al menos una letra nueva', 'warning'); return }
  const vistos = new Set()
  for (const [i, f] of filas.entries()) {
    if (!f.numero) { showToast(`Letra nueva ${i + 1}: falta el N°`, 'warning'); return }
    if (vistos.has(f.numero.toLowerCase())) { showToast(`N° repetido: ${f.numero}`, 'warning'); return }
    vistos.add(f.numero.toLowerCase())
    if (_letrasCache.some(x => String(x.numero_letra).toLowerCase() === f.numero.toLowerCase())) { showToast(`El N° ${f.numero} ya existe`, 'warning'); return }
    if (!(f.monto > 0)) { showToast(`Letra ${f.numero}: el monto debe ser mayor a 0`, 'warning'); return }
    if (!f.venc) { showToast(`Letra ${f.numero}: falta el vencimiento`, 'warning'); return }
    if (f.venc < fecha) { showToast(`Letra ${f.numero}: vence antes de la fecha de operación`, 'warning'); return }
  }
  const enLetras = _r2(filas.reduce((s, f) => s + f.monto, 0))
  if (Math.abs(enLetras - aDoc) >= 0.01) { showToast(`Las letras nuevas suman ${formatNumber(enLetras)} y deben sumar ${formatNumber(aDoc)}`, 'warning'); return }
  if (ab && emitida && !(await _reciboLibreGlobal(ab.recibo, _rfin.contactId))) return
  const modalidad = origenes.length > 1 ? 'unificacion' : 'renovacion'
  const neto = ab ? _calcLetraBanco({ tipo: _rfin.tipo }, { base: ab.amort, intereses: ab.interes, portes: ab.portes, comision: ab.comision, otros: ab.otros }).neto : 0
  if (!confirm(`${modalidad === 'renovacion' ? 'Renovar' : 'Unificar'} ${origenes.length} letra(s) (${origenes.map(x => x.numero_letra).join(', ')}):\n` +
    `• Saldos: ${formatNumber(saldos)}${ab ? `  • Amortiza: ${formatNumber(ab.amort)}` : ''}${intRef ? `  • Interés refinanc.: ${formatNumber(intRef)}` : ''}\n` +
    `• Nuevas: ${filas.map(f => `${f.numero} ${formatNumber(f.monto)} (${fechaDMY(f.venc)})`).join(', ')}\n` +
    (ab ? `• Banco: ${formatNumber(Math.abs(neto))} ${(emitida ? neto >= 0 : neto < 0) ? 'ingreso' : 'egreso'}\n` : '') + '\n¿Continuar?')) return

  const user = getCurrentUser()
  const creadas = []
  let refin = null
  let conAsiento = false
  try {
    // 1) Cabecera + orígenes
    refin = await _sb(supabase.from('letras_refinanciacion').insert({
      tipo: _rfin.tipo, modalidad, contact_id: _rfin.contactId, fecha, moneda: _rfin.moneda, tipo_cambio: tcNueva,
      total_saldos: saldos, monto_abono: ab?.amort || 0, interes_refin: intRef, total_nuevas: enLetras,
      observaciones: $('rfinObs').value.trim() || null, created_by: user?.db_id || null
    }).select().single())
    await _sb(supabase.from('letras_refinanciacion_origen').insert(origenes.map(x => ({
      refinanciacion_id: refin.id, letra_id: x.id, saldo: _saldoLetra(x), estado_previo: x.estado, monto_pagado_previo: _n(x.monto_pagado)
    }))))
    // 2) Letras nuevas (heredan documento/cuota si todas las de origen son del mismo)
    const comun = campo => { const v = origenes.map(x => x[campo] || null); return v.every(z => z === v[0]) ? v[0] : null }
    for (const f of filas) {
      const nueva = await addLetraCambio({
        numero_letra: f.numero, tipo: _rfin.tipo, contact_id: _rfin.contactId,
        venta_id: comun('venta_id'), compra_id: comun('compra_id'), cxc_id: comun('cxc_id'), cxp_id: comun('cxp_id'),
        cuota_cobrar_id: comun('cuota_cobrar_id'), cuota_pagar_id: comun('cuota_pagar_id'),
        moneda: _rfin.moneda, tipo_cambio: tcNueva, monto: f.monto, fecha_emision: fecha, fecha_vencimiento: f.venc,
        estado: 'cartera', refinanciacion_id: refin.id, letra_origen_id: origenes.length === 1 ? l0.id : null,
        observaciones: `${modalidad === 'renovacion' ? 'Renovación' : 'Unificación'} de ${origenes.map(x => x.numero_letra).join(', ')}`,
        created_by: user?.db_id || null
      })
      if (!nueva?.id) throw new Error(`No se pudo crear la letra ${f.numero} (¿N° duplicado o falta el SQL 77?)`)
      creadas.push(nueva)
    }
    // 3) Asiento único
    const asiento = await _asientoLetras({
      ref: `LETRA-REFIN-${refin.id}`, tipoMov: modalidad === 'renovacion' ? 'Renovación Letra' : 'Unificación Letras', fecha, l: l0,
      descripcion: `${modalidad === 'renovacion' ? 'Renovación' : 'Unificación'} ${origenes.map(x => x.numero_letra).join(', ')} → ${filas.map(f => f.numero).join(', ')}`,
      origenes: origenes.map(x => ({ letra: x, monto: _saldoLetra(x) })), nuevas: filas, tcNueva, intRef,
      abono: ab ? { ...ab } : null, renov: !!ab && ab.ubicacion === 'banco'
    })
    conAsiento = true
    await _sb(supabase.from('letras_refinanciacion').update({ asiento_id: asiento?.id || null }).eq('id', refin.id))
    // 4) Abono en el acto (banco + recibo)
    if (ab) {
      const fila = await _insAbono({
        letra_id: origenes.length === 1 ? l0.id : null, refinanciacion_id: refin.id, tipo: _rfin.tipo, contact_id: _rfin.contactId,
        tipo_abono: modalidad, ubicacion: ab.ubicacion, medio: ab.medio, fecha, banco_id: ab.bancoId, moneda: _rfin.moneda,
        tipo_cambio: ab.tcDia, monto_amortizado: ab.amort, interes: ab.interes, gasto_portes: ab.portes,
        gasto_comision: ab.comision, gasto_otros: ab.otros, monto_neto: neto, numero_operacion: ab.numOp,
        numero_recibo: ab.recibo, estado_previo: l0.estado, asiento_id: asiento?.id || null, created_by: user?.db_id || null
      })
      const mov = await _registrarMovimientoBancario({
        bancoId: ab.bancoId, tipo: (emitida ? neto >= 0 : neto < 0) ? 'ingreso' : 'egreso', fecha,
        concepto: `${modalidad === 'renovacion' ? 'Renovación' : 'Unificación'} letra(s) ${origenes.map(x => x.numero_letra).join(', ')} — ${_nombreContacto(_rfin.contactId)}${ab.recibo ? ` (Rec. ${ab.recibo})` : ''}`,
        categoria: emitida ? 'Cobranza letras' : 'Pago letras', referencia: `LETRA-REFIN ${refin.id}`, numeroOperacion: ab.numOp,
        monto: Math.abs(neto), asientoId: asiento?.id || null, monedaMonto: _rfin.moneda, tc: ab.tcDia
      })
      if (mov?.id) await _updAbono(fila.id, { movimiento_banco_id: mov.id })
    }
    // 5) Orígenes → refinanciada
    for (const x of origenes) await _updLetra(x.id, { estado: 'refinanciada' })
    await _subirAdjuntosPendientes('rfin', 'letra', creadas[0].id)
    window.closeModal('modal-refinanciar-letras')
    showToast(`${modalidad === 'renovacion' ? 'Renovación' : 'Unificación'} registrada ✅ — nuevas: ${creadas.map(c => c.numero_letra).join(', ')}${asiento?.numero_asiento ? ` / ${asiento.numero_asiento}` : ''}`, 'success', 8000)
    _rfin = null
    _letSel.clear()
    _refrescarTodo()
    await _recargarTrasLetra()
  } catch (e) {
    console.error('confirmarRefinanciar:', e)
    if (!conAsiento) {
      // Falló antes del asiento: se revierte todo lo creado (letras nuevas + cabecera)
      for (const c of creadas) { try { await deleteLetraCambio(c.id) } catch (_) {} }
      if (refin?.id) { try { await supabase.from('letras_refinanciacion').delete().eq('id', refin.id) } catch (_) {} }
      showToast('Error: ' + e.message + ' — no se guardó nada.', 'danger', 10000)
    } else {
      showToast(`Error a mitad de la refinanciación #${refin.id}: ${e.message}. Ábrela desde una letra nueva y usa "Deshacer refinanciación".`, 'danger', 12000)
      _refrescarTodo(); await _recargarTrasLetra()
    }
  }
}

function _siguienteNumeroRenov(numero) {
  const base = String(numero).replace(/-R\d*$/, '')
  const usados = new Set((_letrasCache || []).map(x => x.numero_letra))
  if (!usados.has(`${base}-R`)) return `${base}-R`
  let i = 2
  while (usados.has(`${base}-R${i}`)) i++
  return `${base}-R${i}`
}

/** Deshace una refinanciación completa (desde cualquiera de sus letras nuevas o de origen). */
async function _deshacerRefinanciacion(refId) {
  const refin = await _sb(supabase.from('letras_refinanciacion').select('*').eq('id', refId).single())
  const origen = await _sb(supabase.from('letras_refinanciacion_origen').select('*').eq('refinanciacion_id', refId))
  const nuevas = await _sb(supabase.from('letras_cambio').select('*').eq('refinanciacion_id', refId))
  const bloqueo = nuevas.find(x => x.estado !== 'cartera' || _n(x.monto_pagado) > 0)
  if (bloqueo) throw new Error(`La letra nueva ${bloqueo.numero_letra} ya tiene movimientos (${bloqueo.estado}${_n(bloqueo.monto_pagado) ? ', con abonos' : ''}). Revierte eso primero.`)
  const abonos = await _sb(supabase.from('letras_abonos').select('*').eq('refinanciacion_id', refId))
  const avisos = []
  for (const ab of abonos) {
    const mov = await _movPorId(ab.movimiento_banco_id)
    if (mov) await _eliminarMovimientoYSaldo(mov)
    else if (ab.banco_id) avisos.push('no se encontró el movimiento del abono')
    await _delAbono(ab.id)
  }
  for (const x of nuevas) {
    try { await eliminarAdjuntosDe('letra', x.id) } catch (_) {}
    const ok = await deleteLetraCambio(x.id)
    if (ok === false) throw new Error(`No se pudo eliminar la letra ${x.numero_letra}`)
  }
  for (const o of origen) await _updLetra(o.letra_id, { estado: o.estado_previo, monto_pagado: _n(o.monto_pagado_previo) })
  await _sb(supabase.from('letras_refinanciacion').delete().eq('id', refId))
  if (refin.asiento_id) { try { await eliminarAsientoContable(refin.asiento_id) } catch (e) { avisos.push('asiento no eliminado: ' + e.message) } }
  return { avisos, nuevas, origen }
}

window.deshacerRefinanciacion = async function (refId) {
  try {
    const origen = await _sb(supabase.from('letras_refinanciacion_origen').select('letra_id').eq('refinanciacion_id', refId))
    const nuevas = await _sb(supabase.from('letras_cambio').select('numero_letra').eq('refinanciacion_id', refId))
    const nom = id => _letrasCache.find(x => x.id === id)?.numero_letra || `#${id}`
    if (!confirm(`Deshacer la refinanciación #${refId}:\n• Se eliminan las letras nuevas: ${nuevas.map(x => x.numero_letra).join(', ')}\n• Se borran su asiento, el abono y el movimiento bancario (si hubo)\n• Vuelven a su estado anterior: ${origen.map(o => nom(o.letra_id)).join(', ')}\n\n¿Continuar?`)) return
    const r = await _deshacerRefinanciacion(refId)
    if (r.avisos.length) showToast('⚠️ ' + r.avisos.join('; '), 'warning')
    showToast('Refinanciación deshecha ✅', 'success')
    window.closeModal?.('modal-detalle-cp')
    _refrescarTodo()
    await _recargarTrasLetra()
  } catch (e) { showToast('Error: ' + e.message, 'danger', 9000) }
}

/** Id de la refinanciación que cerró una letra 'refinanciada'. */
async function _refinQueCerro(letraId) {
  const r = await _sb(supabase.from('letras_refinanciacion_origen').select('refinanciacion_id').eq('letra_id', letraId).order('id', { ascending: false }).limit(1))
  return r?.[0]?.refinanciacion_id || null
}

// ── Selección múltiple en la tabla de letras (para Unificar) ──
const _letSel = new Set()
window._letToggleSel = function (id, on, chk) {
  const l = _letrasCache.find(x => x.id === id)
  if (on && l) {
    const otra = _letrasCache.find(x => _letSel.has(x.id))
    if (otra && (otra.tipo !== l.tipo || Number(otra.contact_id) !== Number(l.contact_id) || (otra.moneda || 'PEN') !== (l.moneda || 'PEN'))) {
      showToast('Solo se unifican letras del mismo cliente/proveedor, tipo y moneda', 'warning')
      if (chk) chk.checked = false
      return
    }
    _letSel.add(id)
  } else _letSel.delete(id)
  _letPintarBotonUnificar()
}
function _letPintarBotonUnificar() {
  const b = document.getElementById('btnUnificarLetras')
  if (!b) return
  b.disabled = _letSel.size < 2
  b.textContent = `🔗 Unificar letras${_letSel.size ? ` (${_letSel.size})` : ''}`
  b.title = _letSel.size < 2 ? 'Marca 2 o más letras con saldo del mismo cliente y moneda' : ''
}
window.unificarSeleccionadas = function () {
  if (_letSel.size < 2) { showToast('Marca al menos 2 letras', 'warning'); return }
  window.abrirRefinanciar([..._letSel], 'unificacion')
}

/** Deshace el cobro/pago de una letra del flujo ANTERIOR (sin abonos, previo al SQL 77). */

async function _revertirCancelacionLetraCore(l) {
    const avisos = []
    if (l.banco_id) {
      const mov = await _movDeLetra(l)
      if (mov) await _eliminarMovimientoYSaldo(mov)
      else avisos.push('no se encontró el movimiento bancario')
    }
    const asId = l.asiento_cobro_id
    const upd = await updateLetraCambio(l.id, { estado: 'cartera', banco_id: null, numero_operacion: null, asiento_cobro_id: null, updated_at: new Date().toISOString() })
    if (!upd) throw new Error('No se pudo actualizar la letra')
    if (asId) { try { await eliminarAsientoContable(asId) } catch (e) { avisos.push('asiento no eliminado: ' + e.message) } }
    l.estado = 'cartera'; l.banco_id = null; l.asiento_cobro_id = null
    return avisos
}

// ============================================================================
// LETRAS — VER DETALLE / EDITAR (estándar 👁 ✏️ ✕)
// ============================================================================

async function _recargarTrasLetra() {
  invalidarVarios(['letras_cambio', 'letras_abonos', 'cuentas_cobrar', 'cuentas_pagar', 'cuotas_cobrar', 'cuotas_pagar', 'movimientos_banco', 'bancos'])
  await window.cargarLetras()
  await Promise.all([cargarCxC(), cargarCxP()])
  calcularKPIs()
}

async function _getLetra(id) {
  _letrasCache = await cacheado('letras_cambio', getLetrasCambio)
  return _letrasCache.find(x => Number(x.id) === Number(id))
}

async function _movDeLetra(l) {
  if (!l.banco_id) return null
  const { data } = await supabase.from('movimientos_banco').select('*')
    .eq('banco_id', l.banco_id).eq('referencia', `LETRA ${l.numero_letra}`).limit(1)
  return data?.[0] || null
}

async function _numeroAsiento(asId) {
  if (!asId) return '—'
  const { supabase } = await import('./supabase-client.js')
  const { data } = await supabase.from('journal_entries').select('numero_asiento').eq('id', asId).maybeSingle()
  return data?.numero_asiento || `#${asId}`
}

window.verDetalleLetra = async function (id) {
  const body = document.getElementById('detalle-cp-body')
  body.innerHTML = '<p style="text-align:center;">Cargando...</p>'
  window.openModal('modal-detalle-cp')
  try {
    const l = await _getLetra(id)
    if (!l) { body.innerHTML = '<p>Letra no encontrada.</p>'; return }
    const emitida = l.tipo === 'emitida'
    const abierta = _letraAbierta(l)
    const mon = l.moneda || 'PEN'
    const sinAbonos = _n(l.monto_pagado) <= 0
    let abonos = [], refinOrigen = null, refinCierre = null
    try { abonos = await _abonosDeLetra(id) } catch (_) {}
    try {
      if (l.refinanciacion_id) {
        const [ref, ori, hermanas] = await Promise.all([
          _sb(supabase.from('letras_refinanciacion').select('*').eq('id', l.refinanciacion_id).single()),
          _sb(supabase.from('letras_refinanciacion_origen').select('*').eq('refinanciacion_id', l.refinanciacion_id)),
          _sb(supabase.from('letras_cambio').select('id, numero_letra, monto, fecha_vencimiento, estado').eq('refinanciacion_id', l.refinanciacion_id))
        ])
        refinOrigen = { ref, ori, hermanas }
      }
      if (l.estado === 'refinanciada') {
        const rid = await _refinQueCerro(id)
        if (rid) {
          const [ref, nuevas] = await Promise.all([
            _sb(supabase.from('letras_refinanciacion').select('*').eq('id', rid).single()),
            _sb(supabase.from('letras_cambio').select('id, numero_letra, monto, fecha_vencimiento, estado').eq('refinanciacion_id', rid))
          ])
          refinCierre = { ref, nuevas }
        }
      }
    } catch (e) { console.warn('detalle refinanciación:', e.message) }

    document.getElementById('detalle-cp-titulo').textContent = `Letra ${l.numero_letra}`
    const btn = (txt, js, cls = 'btn-secondary') => `<button class="btn ${cls}" onclick="window.closeModal('modal-detalle-cp'); ${js}">${txt}</button>`
    document.getElementById('detalle-cp-acciones').innerHTML = `
      <button class="btn btn-secondary" onclick="window.closeModal('modal-detalle-cp')">Cerrar</button>
      ${l.estado === 'cartera' && sinAbonos ? btn('A banco', `window.abrirModalLetraBanco(${id})`) : ''}
      ${(l.estado === 'banco' || l.estado === 'cobranza') ? btn('Protestar', `window.cambiarEstadoLetra(${id},'protestada')`) : ''}
      ${abierta ? btn('🔄 Renovar', `window.abrirRenovarLetra(${id})`) : ''}
      ${abierta ? btn(emitida ? '💵 Cobrar / abonar' : '💵 Pagar / abonar', `window.abrirCancelarLetra(${id})`, 'btn-primary') : ''}
      ${l.estado !== 'refinanciada' ? btn('✏️ Editar', `window.abrirEditarLetra(${id})`) : ''}
      ${refinCierre ? btn('↩ Deshacer refinanciación', `window.deshacerRefinanciacion(${refinCierre.ref.id})`, 'btn-danger')
        : l.refinanciacion_id ? btn('↩ Deshacer refinanciación', `window.deshacerRefinanciacion(${l.refinanciacion_id})`, 'btn-danger')
        : `<button class="btn btn-danger" onclick="window.eliminarLetra(${id})">✕ Eliminar</button>`}`

    const doc = emitida ? (l.cxc_id ? await getCuentaCobrarById(l.cxc_id) : null) : (l.cxp_id ? await getCuentaPagarById(l.cxp_id) : null)
    const asCanje = await _numeroAsiento(l.asiento_emision_id || refinOrigen?.ref?.asiento_id)
    const fila = (k, v) => `<tr><td style="color:var(--text-secondary); width:40%;">${k}</td><td>${v}</td></tr>`
    const saldo = _saldoLetra(l)
    const asNums = await Promise.all(abonos.map(a => _numeroAsiento(a.asiento_id)))
    let adjLetra = []
    try { adjLetra = await getAdjuntos('letra', id) } catch (_) {}
    const tabla = (cab, filas, pie = '') => `<div style="border:1px solid var(--border-color); border-radius:var(--radius-md); overflow:hidden; overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; margin:0; font-size:0.85rem;"><thead><tr style="background:var(--bg-secondary);">${cab}</tr></thead><tbody>${filas}</tbody>${pie}</table></div>`
    const listaLetras = arr => arr.map(x => `<a href="#" onclick="window.verDetalleLetra(${x.id}); return false;">${_esc(x.numero_letra)}</a> <small style="color:var(--text-secondary);">${formatNumber(x.monto)} · ${x.estado}</small>`).join(' · ')

    body.innerHTML = `
      <div style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info); font-size:0.88rem; line-height:1.6; display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap;">
        <div>
          <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">${emitida ? 'Letra por cobrar' : 'Letra por pagar'} · ${l.estado}</div>
          <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${_esc(l.numero_letra)} — ${_esc(_nombreContacto(l.contact_id))}</div>
          <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">Canjea ${_esc(doc ? _descDocCP(doc) : (l.refinanciacion_id ? 'refinanciación de letras' : '—'))}</div>
        </div>
        <div style="display:grid; grid-template-columns:repeat(3, auto); gap:2px 18px; text-align:right;">
          <span style="color:var(--text-secondary); font-size:0.75rem;">MONTO</span><span style="color:var(--text-secondary); font-size:0.75rem;">PAGADO</span><span style="color:var(--text-secondary); font-size:0.75rem;">SALDO</span>
          <b>${mon} ${formatNumber(l.monto)}</b><b>${mon} ${formatNumber(l.monto_pagado || 0)}</b><b style="color:${saldo > 0 ? 'var(--color-warning)' : 'var(--color-success)'};">${mon} ${formatNumber(saldo)}</b>
        </div>
      </div>
      <table class="table-compact" style="width:100%; margin-top:10px;">
        ${fila('F. Emisión / Vencimiento', `${fechaDMY(l.fecha_emision)} → ${fechaDMY(l.fecha_vencimiento)}${abierta && _diasAtraso(l.fecha_vencimiento) ? ` <b style="color:var(--color-danger);">(${_diasAtraso(l.fecha_vencimiento)} d de atraso)</b>` : ''}`)}
        ${fila('Banco', _esc(l.banco_id ? (_bancosMap[l.banco_id]?.nombre || l.banco_id) : '—'))}
        ${mon === 'USD' ? fila('T.C. de la letra', parseFloat(l.tipo_cambio || 1).toFixed(4)) : ''}
        ${fila(l.refinanciacion_id ? 'Asiento de refinanciación' : 'Asiento de canje', asCanje)}
        ${fila('Observaciones', _esc(l.observaciones || '—'))}
        ${fila('📎 Archivos adjuntos', _htmlAdjuntos('letra', id, adjLetra, false))}
      </table>

      ${refinOrigen ? `<h4 style="margin:16px 0 6px;">🔗 Nace de la ${refinOrigen.ref.modalidad === 'renovacion' ? 'renovación' : 'unificación'} #${refinOrigen.ref.id} (${fechaDMY(refinOrigen.ref.fecha)})</h4>
        <div style="font-size:0.85rem; line-height:1.8;">
          <div><span style="color:var(--text-secondary);">Letras de origen:</span> ${listaLetras(refinOrigen.ori.map(o => ({ id: o.letra_id, numero_letra: _letrasCache.find(x => x.id === o.letra_id)?.numero_letra || '#' + o.letra_id, monto: o.saldo, estado: 'saldo' })))}</div>
          <div><span style="color:var(--text-secondary);">Letras nuevas:</span> ${listaLetras(refinOrigen.hermanas)}</div>
          <div><span style="color:var(--text-secondary);">Saldos ${formatNumber(refinOrigen.ref.total_saldos)} − abono ${formatNumber(refinOrigen.ref.monto_abono)} + interés ${formatNumber(refinOrigen.ref.interes_refin)} = </span><b>${mon} ${formatNumber(refinOrigen.ref.total_nuevas)}</b>${mon === 'USD' ? ` · T.C. ${parseFloat(refinOrigen.ref.tipo_cambio || 1).toFixed(4)}` : ''}</div>
        </div>` : ''}
      ${refinCierre ? `<h4 style="margin:16px 0 6px;">🔗 ${refinCierre.ref.modalidad === 'renovacion' ? 'Renovada' : 'Unificada'} en #${refinCierre.ref.id} (${fechaDMY(refinCierre.ref.fecha)})</h4>
        <div style="font-size:0.85rem;">Letras nuevas: ${listaLetras(refinCierre.nuevas)}</div>` : ''}

      <h4 style="margin:16px 0 6px;">💵 Abonos ${emitida ? '/ cobros' : '/ pagos'} (${abonos.length})</h4>
      ${abonos.length ? tabla(
        `<th>Fecha</th><th>Tipo</th><th>Medio / cuenta</th><th>Recibo</th><th>N° Op.</th><th style="text-align:right;">Amortiza (${mon})</th><th style="text-align:right;">Interés</th><th style="text-align:right;">Gastos</th><th style="text-align:right;">Neto (${mon})</th><th>Mov. / Asiento</th><th></th>`,
        abonos.map((a, i) => `<tr style="border-top:1px solid var(--border-color);">
          <td>${fechaDMY(a.fecha)}</td>
          <td><span class="badge ${a.tipo_abono === 'total' ? 'badge-success' : (a.tipo_abono === 'parcial' ? 'badge-warning' : 'badge-info')}">${_TIPOS_ABONO[a.tipo_abono] || a.tipo_abono}</span><br><small style="color:var(--text-secondary);">${a.ubicacion === 'banco' ? '🏦 banco' : '📁 cartera'}</small></td>
          <td>${_esc(_MEDIOS_LETRA[a.medio] || a.medio || '—')}<br><small style="color:var(--text-secondary);">${_esc(_bancosMap[a.banco_id]?.nombre || '—')}</small></td>
          <td><b>${_esc(a.numero_recibo || '—')}</b></td>
          <td>${_esc(a.numero_operacion || '—')}</td>
          <td style="text-align:right;">${formatNumber(a.monto_amortizado)}</td>
          <td style="text-align:right;">${formatNumber(a.interes || 0)}</td>
          <td style="text-align:right;">${formatNumber(_n(a.gasto_portes) + _n(a.gasto_comision) + _n(a.gasto_otros))}</td>
          <td style="text-align:right; font-weight:600;">${formatNumber(Math.abs(_n(a.monto_neto)))}</td>
          <td style="white-space:nowrap;">${a.movimiento_banco_id ? _numMB(a.movimiento_banco_id) : '—'}<br><small style="color:var(--text-secondary);">${asNums[i]}</small></td>
          <td>${a.refinanciacion_id ? '<small style="color:var(--text-secondary);">refinanc.</small>' : menuAccionesFila([
            { icono: '✏️', label: 'Editar abono', onclick: `window.closeModal('modal-detalle-cp'); window.abrirCancelarLetra(${id}, ${a.id})` },
            { separador: true },
            { icono: '✕', label: 'Eliminar abono', peligro: true, onclick: `window.eliminarAbonoLetra(${id}, ${a.id})` }
          ])}</td></tr>`).join(''),
        `<tfoot><tr style="border-top:2px solid var(--border-color); font-weight:bold;"><td colspan="5">Total</td>
          <td style="text-align:right;">${formatNumber(abonos.reduce((t, a) => t + _n(a.monto_amortizado), 0))}</td>
          <td style="text-align:right;">${formatNumber(abonos.reduce((t, a) => t + _n(a.interes), 0))}</td>
          <td style="text-align:right;">${formatNumber(abonos.reduce((t, a) => t + _n(a.gasto_portes) + _n(a.gasto_comision) + _n(a.gasto_otros), 0))}</td>
          <td style="text-align:right;">${formatNumber(abonos.reduce((t, a) => t + Math.abs(_n(a.monto_neto)), 0))}</td><td colspan="2"></td></tr></tfoot>`)
      : `<p style="color:var(--text-secondary);">${l.estado === 'refinanciada' ? 'Sin abonos directos: su saldo pasó a la refinanciación.' : 'Aún sin abonos.'}</p>`}`
  } catch (e) {
    console.error('verDetalleLetra:', e)
    body.innerHTML = `<p style="color:var(--color-danger);">Error: ${_esc(e.message)}</p>`
  }
}

let _edicionLetra = null   // { letra, maxMonto }

window.abrirEditarLetra = async function (id) {
  try {
    const l = await _getLetra(id)
    if (!l) { showToast('Letra no encontrada', 'danger'); return }
    if (l.estado === 'refinanciada') { showToast('Una letra refinanciada no se edita: deshaz la refinanciación desde Ver detalle.', 'warning', 6000); return }
    const emitida = l.tipo === 'emitida'
    await _refrescarCuotasDoc(emitida, emitida ? l.cxc_id : l.cxp_id)
    const cuota = emitida ? _cuotasCache.find(q => q.id === l.cuota_cobrar_id) : _cuotasPagarCache.find(q => q.id === l.cuota_pagar_id)
    const maxMonto = _r2((cuota ? saldoCuota(cuota) : 0) + parseFloat(l.monto || 0))
    _edicionLetra = { letra: l, maxMonto }

    const $ = i => document.getElementById(i)
    $('elet-titulo').textContent = `Editar letra ${l.numero_letra}`
    $('eletNumero').value = l.numero_letra
    $('eletFechaEmision').value = l.fecha_emision || ''
    $('eletFechaVenc').value = l.fecha_vencimiento || ''
    $('eletMonto').value = l.monto
    $('eletObs').value = l.observaciones || ''
    const pagado = _n(l.monto_pagado)
    const bloqueaMonto = pagado > 0 || !!l.refinanciacion_id
    $('eletMonto').readOnly = bloqueaMonto
    $('elet-info').textContent = l.refinanciacion_id
      ? `Letra de refinanciación #${l.refinanciacion_id}: el monto no se edita (deshaz la refinanciación para cambiarlo).`
      : pagado > 0
        ? `Tiene abonos por ${formatNumber(pagado)}: el monto no se edita. Los cobros/abonos se editan desde 👁 Ver detalle.`
        : `Canjea la cuota ${cuota?.numero_cuota ?? '—'} — monto máximo: ${l.moneda || 'PEN'} ${formatNumber(maxMonto)}`
    // Los cobros/abonos ya no se editan aquí (cada abono tiene su ⋮ en Ver detalle)
    $('elet-cobro').style.display = 'none'
    $('eletTCGroup').style.display = 'none'
    window.openModal('modal-editar-letra')
  } catch (e) {
    console.error('abrirEditarLetra:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

window.guardarEdicionLetra = async function () {
  if (!_edicionLetra) return
  const $ = i => document.getElementById(i)
  const btn = $('eletBtnOk')
  if (btn.disabled) return
  btn.disabled = true
  try {
    const l = await _getLetra(_edicionLetra.letra.id)
    if (!l) throw new Error('La letra ya no existe')
    const emitida = l.tipo === 'emitida'
    const nuevo = {
      numero_letra: $('eletNumero').value.trim(),
      fecha_emision: $('eletFechaEmision').value,
      fecha_vencimiento: $('eletFechaVenc').value,
      monto: _r2($('eletMonto').value),
      observaciones: $('eletObs').value.trim() || null
    }
    if (!nuevo.numero_letra) { showToast('Ingresa el N° de letra', 'warning'); return }
    if (!nuevo.fecha_emision || !nuevo.fecha_vencimiento) { showToast('Ingresa ambas fechas', 'warning'); return }
    if (!(nuevo.monto > 0)) { showToast('El monto debe ser mayor a 0', 'warning'); return }
    const delta = _r2(nuevo.monto - parseFloat(l.monto || 0))
    if (delta && (_n(l.monto_pagado) > 0 || l.refinanciacion_id)) { showToast('El monto no se edita en letras con abonos o de refinanciación', 'warning', 6000); return }
    if (!l.refinanciacion_id && nuevo.monto > _edicionLetra.maxMonto + 0.01) { showToast(`El monto supera el máximo de la cuota (${formatNumber(_edicionLetra.maxMonto)})`, 'warning'); return }

    // Letras de refinanciación: su asiento es el de la refinanciación (no se regenera)
    const cambioCanje = !l.refinanciacion_id && (delta !== 0 || nuevo.numero_letra !== l.numero_letra || nuevo.fecha_emision !== l.fecha_emision)
    if (cambioCanje && !confirm('Este cambio regenera el asiento de canje' + (delta ? ' y ajusta el canje de la cuota y del documento' : '') + '.\n\n¿Continuar?')) return

    if (cambioCanje) {
      if (l.asiento_emision_id) {
        await updateLetraCambio(l.id, { asiento_emision_id: null })
        try { await eliminarAsientoContable(l.asiento_emision_id) } catch (e) { console.warn('Asiento de canje no eliminado:', e.message) }
      }
      if (delta) {
        const cuota = emitida ? _cuotasCache.find(q => q.id === l.cuota_cobrar_id) : _cuotasPagarCache.find(q => q.id === l.cuota_pagar_id)
        if (cuota) {
          const canj = Math.max(0, _r2(parseFloat(cuota.monto_canjeado || 0) + delta))
          const qa = { ...cuota, monto_canjeado: canj }
          if (emitida) await updateCuotaCobrar(cuota.id, { monto_canjeado: canj, estado: estadoCuota(qa, true) })
          else         await updateCuotaPagar(cuota.id,  { monto_canjeado: canj, estado: estadoCuota(qa, false) })
        }
        await _aplicarCanjeDoc(l.tipo, emitida ? l.cxc_id : l.cxp_id, delta)
      }
    }
    const upd = await updateLetraCambio(l.id, { ...nuevo, updated_at: new Date().toISOString() })
    if (!upd) throw new Error('No se pudo actualizar la letra (¿N° de letra duplicado?)')
    if (cambioCanje) {
      const as = await _asientoLetra('canje', { ...l, ...nuevo }, null)
      if (as?.id) await updateLetraCambio(l.id, { asiento_emision_id: as.id })
    }
    window.closeModal('modal-editar-letra')
    showToast(`Letra ${nuevo.numero_letra} actualizada ✅`, 'success')
    _refrescarTodo()
    await _recargarTrasLetra()
  } catch (e) {
    console.error('guardarEdicionLetra:', e)
    showToast('Error al editar: ' + e.message, 'danger')
  } finally { btn.disabled = false }
}

// ============================================================================
// CUOTAS — VER DETALLE / EDITAR / ELIMINAR (estándar 👁 ✏️ ✕)
// ============================================================================
// Una cuota es una parte del cronograma del documento: la suma de cuotas debe
// seguir igual al total. Por eso:
//  ✏️ cambiar el monto compensa la diferencia en OTRA cuota (la última con
//     saldo suficiente); nunca por debajo de lo ya aplicado (cobrado/canjeado).
//  ✕ solo si la cuota no tiene nada aplicado ni letras; su monto pasa a la cuota
//     anterior (o a la siguiente si era la primera) y se renumeran.

const _esCxcDoc = t => t === 'cxc'

function _botonesCuota(tipoDoc, id) {
  return `<button class="btn btn-small btn-secondary" title="Ver detalle" onclick="window.verDetalleCuota('${tipoDoc}', ${id})">👁</button>
    <button class="btn btn-small btn-secondary" title="Editar" onclick="window.abrirEditarCuota('${tipoDoc}', ${id})">✏️</button>
    <button class="btn btn-small btn-danger" title="Eliminar" onclick="window.eliminarCuota('${tipoDoc}', ${id})">✕</button>`
}

/** Refresca SOLO las cuotas del documento de esa cuota (no toda la tabla). */
async function _cuotasFrescas(tipoDoc, cuotaId) {
  const esC = _esCxcDoc(tipoDoc)
  const { data } = await supabase.from(esC ? 'cuotas_cobrar' : 'cuotas_pagar').select(esC ? 'cxc_id' : 'cxp_id').eq('id', cuotaId).maybeSingle()
  const docId = data ? (esC ? data.cxc_id : data.cxp_id) : null
  if (docId) await _refrescarCuotasDoc(esC, docId)
  return esC ? _cuotasCache : _cuotasPagarCache
}
const _docIdDeCuota = (tipoDoc, q) => _esCxcDoc(tipoDoc) ? q.cxc_id : q.cxp_id
const _aplicadoCuota = (tipoDoc, q) => _r2(parseFloat(_esCxcDoc(tipoDoc) ? q.monto_cobrado : q.monto_pagado) + parseFloat(q.monto_retenido || 0) + parseFloat(q.monto_canjeado || 0))
const _updCuota = (tipoDoc, id, d) => _esCxcDoc(tipoDoc) ? updateCuotaCobrar(id, d) : updateCuotaPagar(id, d)
const _letrasDeCuota = (tipoDoc, qid) => (_letrasCache || []).filter(l => Number(_esCxcDoc(tipoDoc) ? l.cuota_cobrar_id : l.cuota_pagar_id) === Number(qid))

/** Vencimiento del documento = el de su última cuota (igual que al crear la venta/compra). */
async function _sincronizarVencimientoDoc(tipoDoc, docId) {
  const cuotas = (_esCxcDoc(tipoDoc) ? _cuotasCache : _cuotasPagarCache).filter(q => Number(_docIdDeCuota(tipoDoc, q)) === Number(docId) && q.estado !== 'anulado')
  if (!cuotas.length) return
  const ult = cuotas.map(q => String(q.fecha_vencimiento)).sort().pop()
  if (_esCxcDoc(tipoDoc)) await updateCuentaCobrar(docId, { fecha_vencimiento: ult })
  else                    await updateCuentaPagar(docId,  { fecha_vencimiento: ult })
}

window.verDetalleCuota = async function (tipoDoc, id) {
  const body = document.getElementById('detalle-cp-body')
  body.innerHTML = '<p style="text-align:center;">Cargando...</p>'
  window.openModal('modal-detalle-cp')
  try {
    const cuotas = await _cuotasFrescas(tipoDoc, id)
    const q = cuotas.find(x => Number(x.id) === Number(id))
    if (!q) { body.innerHTML = '<p>Cuota no encontrada.</p>'; return }
    const docId = _docIdDeCuota(tipoDoc, q)
    const doc = _esCxcDoc(tipoDoc) ? await getCuentaCobrarById(docId) : await getCuentaPagarById(docId)
    _letrasCache = await cacheado('letras_cambio', getLetrasCambio)
    const letras = _letrasDeCuota(tipoDoc, id)
    document.getElementById('detalle-cp-titulo').textContent = `Cuota ${q.numero_cuota} — ${_descDocCP(doc)}`
    document.getElementById('detalle-cp-acciones').innerHTML = `
      <button class="btn btn-secondary" onclick="window.accionDocCP('${tipoDoc}', ${docId}, 'ver')">← Documento</button>
      <button class="btn btn-secondary" onclick="window.closeModal('modal-detalle-cp'); window.abrirEditarCuota('${tipoDoc}', ${id})">✏️ Editar</button>
      <button class="btn btn-danger" onclick="window.eliminarCuota('${tipoDoc}', ${id})">✕ Eliminar</button>`
    const fila = (k, v) => `<tr><td style="color:var(--text-secondary); width:40%;">${k}</td><td>${v}</td></tr>`
    body.innerHTML = `
      <div style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info); font-size:0.88rem; line-height:1.6;">
        <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">Cuota del cronograma · ${q.estado}</div>
        <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">Cuota ${q.numero_cuota} — ${doc?.moneda || 'PEN'} ${formatNumber(q.monto)}</div>
        <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">${_esc(_descDocCP(doc))} · ${_esc(_nombreContacto(doc?.contact_id))}</div>
      </div>
      <table class="table-compact" style="width:100%; margin-top:10px;">
        ${fila('Vencimiento', fechaDMY(q.fecha_vencimiento))}
        ${fila(_esCxcDoc(tipoDoc) ? 'Cobrado' : 'Pagado', formatNumber(_esCxcDoc(tipoDoc) ? q.monto_cobrado : q.monto_pagado))}
        ${_esCxcDoc(tipoDoc) ? fila('Retenido', formatNumber(q.monto_retenido || 0)) : ''}
        ${fila('Canjeado en letras', formatNumber(q.monto_canjeado || 0))}
        ${fila('Saldo', `<b>${formatNumber(saldoCuota(q))}</b>`)}
        ${q.hito ? fila('Hito', _esc(q.hito)) : ''}
        ${fila('Observaciones', _esc(q.observaciones || '—'))}
      </table>
      ${letras.length ? `<h4 style="margin:16px 0 6px;">Letras que canjean esta cuota</h4>
      <table class="table-compact" style="width:100%;"><tbody>${letras.map(l => `<tr><td>${_esc(l.numero_letra)}</td><td>${fechaDMY(l.fecha_vencimiento)}</td><td style="text-align:right;">${formatNumber(l.monto)}</td><td>${l.estado}</td><td style="white-space:nowrap;">${_botonesLetra(l.id)}</td></tr>`).join('')}</tbody></table>` : ''}`
  } catch (e) {
    console.error('verDetalleCuota:', e)
    body.innerHTML = `<p style="color:var(--color-danger);">Error: ${_esc(e.message)}</p>`
  }
}

let _edicionCuota = null   // { tipoDoc, id }

window.abrirEditarCuota = async function (tipoDoc, id) {
  try {
    const cuotas = await _cuotasFrescas(tipoDoc, id)
    const q = cuotas.find(x => Number(x.id) === Number(id))
    if (!q) { showToast('Cuota no encontrada', 'danger'); return }
    const hermanas = cuotas.filter(x => Number(_docIdDeCuota(tipoDoc, x)) === Number(_docIdDeCuota(tipoDoc, q)) && x.id !== q.id && x.estado !== 'anulado')
    _edicionCuota = { tipoDoc, id }
    document.getElementById('ecu-titulo').textContent = `Editar cuota ${q.numero_cuota}`
    document.getElementById('ecuFecha').value = q.fecha_vencimiento || ''
    document.getElementById('ecuMonto').value = q.monto
    document.getElementById('ecuMonto').readOnly = hermanas.length === 0
    document.getElementById('ecuObs').value = q.observaciones || ''
    document.getElementById('ecu-info').textContent = hermanas.length
      ? `Ya aplicado: ${formatNumber(_aplicadoCuota(tipoDoc, q))} (mínimo). Si cambias el monto, la diferencia se compensa en otra cuota para que el total no cambie.`
      : 'Es la única cuota: su monto es el total del documento y no se puede cambiar aquí.'
    window.openModal('modal-editar-cuota')
  } catch (e) { showToast('Error: ' + e.message, 'danger') }
}

window.guardarEdicionCuota = async function () {
  if (!_edicionCuota) return
  const { tipoDoc, id } = _edicionCuota
  const btn = document.getElementById('ecuBtnOk')
  if (btn.disabled) return
  btn.disabled = true
  try {
    const cuotas = await _cuotasFrescas(tipoDoc, id)
    const q = cuotas.find(x => Number(x.id) === Number(id))
    if (!q) throw new Error('La cuota ya no existe')
    const docId = _docIdDeCuota(tipoDoc, q)
    const fecha = document.getElementById('ecuFecha').value
    const monto = _r2(document.getElementById('ecuMonto').value)
    const obs = document.getElementById('ecuObs').value.trim() || null
    if (!fecha) { showToast('Ingresa el vencimiento', 'warning'); return }
    if (!(monto > 0)) { showToast('El monto debe ser mayor a 0', 'warning'); return }
    const aplicado = _aplicadoCuota(tipoDoc, q)
    if (monto < aplicado - 0.01) { showToast(`El monto no puede ser menor a lo ya aplicado (${formatNumber(aplicado)})`, 'warning'); return }

    const delta = _r2(monto - parseFloat(q.monto))
    let compensa = null
    if (delta !== 0) {
      // La otra cuota que absorbe la diferencia: la de vencimiento más lejano que lo soporte.
      const hermanas = cuotas.filter(x => Number(_docIdDeCuota(tipoDoc, x)) === Number(docId) && x.id !== q.id && x.estado !== 'anulado')
        .sort((a, b) => String(b.fecha_vencimiento).localeCompare(String(a.fecha_vencimiento)) || b.numero_cuota - a.numero_cuota)
      compensa = hermanas.find(x => _r2(parseFloat(x.monto) - delta) >= _aplicadoCuota(tipoDoc, x) && _r2(parseFloat(x.monto) - delta) > 0)
      if (!compensa) { showToast('No hay otra cuota con saldo suficiente para compensar la diferencia', 'warning'); return }
      if (!confirm(`La cuota ${compensa.numero_cuota} pasará de ${formatNumber(compensa.monto)} a ${formatNumber(_r2(parseFloat(compensa.monto) - delta))} para que el total no cambie.\n\n¿Continuar?`)) return
    }

    const qNueva = { ...q, monto }
    const r = await _updCuota(tipoDoc, q.id, { fecha_vencimiento: fecha, monto, observaciones: obs, estado: estadoCuota(qNueva, _esCxcDoc(tipoDoc)) })
    if (!r) throw new Error('No se pudo actualizar la cuota')
    if (compensa) {
      const cNueva = { ...compensa, monto: _r2(parseFloat(compensa.monto) - delta) }
      await _updCuota(tipoDoc, compensa.id, { monto: cNueva.monto, estado: estadoCuota(cNueva, _esCxcDoc(tipoDoc)) })
    }
    await _refrescarCuotasDoc(_esCxcDoc(tipoDoc), docId)
    await _sincronizarVencimientoDoc(tipoDoc, docId)
    window.closeModal('modal-editar-cuota')
    showToast(`Cuota ${q.numero_cuota} actualizada ✅`, 'success')
    _refrescarTodo()
    await Promise.all([cargarCxC(), cargarCxP()])
  } catch (e) {
    console.error('guardarEdicionCuota:', e)
    showToast('Error: ' + e.message, 'danger')
  } finally { btn.disabled = false }
}

window.eliminarCuota = async function (tipoDoc, id) {
  try {
    const cuotas = await _cuotasFrescas(tipoDoc, id)
    const q = cuotas.find(x => Number(x.id) === Number(id))
    if (!q) return
    const docId = _docIdDeCuota(tipoDoc, q)
    const hermanas = cuotas.filter(x => Number(_docIdDeCuota(tipoDoc, x)) === Number(docId) && x.id !== q.id && x.estado !== 'anulado')
      .sort((a, b) => a.numero_cuota - b.numero_cuota)
    _letrasCache = await cacheado('letras_cambio', getLetrasCambio)
    if (!hermanas.length) { showToast('Es la única cuota del documento: no se puede eliminar.', 'warning'); return }
    if (_aplicadoCuota(tipoDoc, q) > 0.01 || _letrasDeCuota(tipoDoc, id).length) {
      showToast('La cuota tiene cobros/pagos o letras aplicados: elimínalos primero (o edita el monto).', 'warning', 6000); return
    }
    const destino = [...hermanas].reverse().find(x => x.numero_cuota < q.numero_cuota) || hermanas[0]
    if (!confirm(`¿Eliminar la cuota ${q.numero_cuota} (${formatNumber(q.monto)})?\n\nSu monto pasa a la cuota ${destino.numero_cuota} para que el total del documento no cambie, y las cuotas se renumeran.`)) return

    const dNueva = { ...destino, monto: _r2(parseFloat(destino.monto) + parseFloat(q.monto)) }
    await _updCuota(tipoDoc, destino.id, { monto: dNueva.monto, estado: estadoCuota(dNueva, _esCxcDoc(tipoDoc)) })
    const ok = _esCxcDoc(tipoDoc) ? await deleteCuotaCobrar(q.id) : await deleteCuotaPagar(q.id)
    if (ok === false) throw new Error('No se pudo eliminar la cuota')
    // Renumerar en orden ascendente (los números solo bajan: no chocan con el UNIQUE)
    let n = 1
    for (const x of hermanas) { if (x.numero_cuota !== n) await _updCuota(tipoDoc, x.id, { numero_cuota: n }); n++ }
    await _refrescarCuotasDoc(_esCxcDoc(tipoDoc), docId)
    await _sincronizarVencimientoDoc(tipoDoc, docId)
    window.closeModal?.('modal-detalle-cp')
    showToast(`Cuota eliminada ✅ — monto sumado a la cuota ${destino.numero_cuota < q.numero_cuota ? destino.numero_cuota : destino.numero_cuota - 1}`, 'success')
    _refrescarTodo()
    await Promise.all([cargarCxC(), cargarCxP()])
  } catch (e) {
    console.error('eliminarCuota:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

// ============================================================================
// TÉRMINOS DE PAGO — VER DETALLE (✏️ y ✕ ya existían)
// ============================================================================
window.verDetalleTerminoPago = async function (id) {
  const body = document.getElementById('detalle-cp-body')
  body.innerHTML = '<p style="text-align:center;">Cargando...</p>'
  window.openModal('modal-detalle-cp')
  try {
    const t = (await getTerminosConCuotas(true)).find(x => Number(x.id) === Number(id))
    if (!t) { body.innerHTML = '<p>Término no encontrado.</p>'; return }
    document.getElementById('detalle-cp-titulo').textContent = `Término: ${t.nombre}`
    document.getElementById('detalle-cp-acciones').innerHTML = `
      <button class="btn btn-secondary" onclick="window.closeModal('modal-detalle-cp')">Cerrar</button>
      <button class="btn btn-secondary" onclick="window.closeModal('modal-detalle-cp'); window.abrirModalTerminoPago(${id})">✏️ Editar</button>
      <button class="btn btn-danger" onclick="window.closeModal('modal-detalle-cp'); window.eliminarTerminoPago(${id})">✕ Eliminar</button>`
    const suma = t.cuotas.reduce((s, c) => s + (parseFloat(c.porcentaje) || 0), 0)
    body.innerHTML = `
      <div style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info); font-size:0.88rem; line-height:1.6;">
        <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">${t.tipo} · ${t.aplica_a === 'ambos' ? 'Ventas y compras' : t.aplica_a === 'venta' ? 'Solo ventas' : 'Solo compras'}</div>
        <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${_esc(t.nombre)}</div>
        <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">${_esc(t.descripcion || '')}</div>
      </div>
      <h4 style="margin:16px 0 6px;">Cronograma (${t.cuotas.length} cuota(s) · suma ${suma}%)</h4>
      <table class="table-compact" style="width:100%;">
        <thead><tr><th>Orden</th><th style="text-align:right;">%</th><th style="text-align:right;">Días</th><th>Hito</th></tr></thead>
        <tbody>${t.cuotas.map(c => `<tr><td>${c.orden}</td><td style="text-align:right;">${parseFloat(c.porcentaje)}%</td><td style="text-align:right;">${c.dias}</td><td>${_esc(c.hito || '—')}</td></tr>`).join('')}</tbody>
      </table>`
  } catch (e) { body.innerHTML = `<p style="color:var(--color-danger);">Error: ${_esc(e.message)}</p>` }
}

// ============================================================================
// REPORTE — ESTADO DE CUENTA POR CLIENTE / PROVEEDOR (motor crearReporte)
// ============================================================================
// Cada fila es un movimiento del documento: cargo (lo que aumenta la deuda) o
// abono (lo que la baja). Saldo = cargo − abono → agrupado por contacto da lo
// que te debe cada cliente (o lo que debes a cada proveedor).
//   Cargos : factura/boleta, ND, letra (al canjear, reemplaza a la factura)
//   Abonos : NC, cobro/pago, retención IGV, anticipo aplicado, canje a letra,
//            cobro/pago de letra.
// Canje = abono en la factura + cargo en la letra (neto 0): la deuda sigue
// hasta que la letra se cobra.
async function construirEstadoCuenta() {
  try {
    // Asegura datos frescos de las 5 fuentes (usa la caché compartida)
    ;[_cxcList, _cxpList, _cobrosList, _pagosList, _letrasCache] = await Promise.all([
      cacheado('cuentas_cobrar', getCuentasCobrar), cacheado('cuentas_pagar', getCuentasPagar),
      cacheado('cobros', getCobros), cacheado('pagos_proveedores', getPagosProveedores),
      cacheado('letras_cambio', getLetrasCambio)
    ])
    const filas = []
    const push = (lado, contactId, moneda, fecha, tipo, documento, referencia, cargo, abono) => {
      if (!(cargo > 0.004) && !(abono > 0.004)) return
      filas.push({
        lado, contacto: _nombreContacto(contactId), moneda: moneda || 'PEN',
        fecha: fecha || '', mes: nombreMes(String(fecha || '').slice(0, 7)),
        tipo, documento, referencia: referencia || '',
        cargo: _r2(cargo), abono: _r2(abono), saldo: _r2(cargo - abono)
      })
    }
    const cxcMap = {}, cxpMap = {}
    for (const c of _cxcList) {
      if (c.estado === 'anulado') continue
      cxcMap[c.id] = c
      const doc = _descDocCP(c)
      push('Por cobrar', c.contact_id, c.moneda, c.fecha_emision, '1 · Comprobante', doc, c.fecha_vencimiento ? `Vence ${fechaDMY(c.fecha_vencimiento)}` : '', parseFloat(c.monto_total || 0), 0)
      push('Por cobrar', c.contact_id, c.moneda, c.fecha_emision, '2 · Nota de débito', doc, '', parseFloat(c.monto_notas_debito || 0), 0)
      push('Por cobrar', c.contact_id, c.moneda, c.fecha_emision, '3 · Nota de crédito', doc, '', 0, parseFloat(c.monto_notas_credito || 0))
      push('Por cobrar', c.contact_id, c.moneda, c.fecha_emision, '6 · Anticipo aplicado', doc, '', 0, parseFloat(c.monto_anticipo_aplicado || 0))
    }
    for (const c of _cxpList) {
      if (c.estado === 'anulado') continue
      cxpMap[c.id] = c
      const doc = _descDocCP(c)
      push('Por pagar', c.contact_id, c.moneda, c.fecha_emision, '1 · Comprobante', doc, c.fecha_vencimiento ? `Vence ${fechaDMY(c.fecha_vencimiento)}` : '', parseFloat(c.monto_total || 0), 0)
      push('Por pagar', c.contact_id, c.moneda, c.fecha_emision, '2 · Nota de débito', doc, '', parseFloat(c.monto_notas_debito || 0), 0)
      push('Por pagar', c.contact_id, c.moneda, c.fecha_emision, '3 · Nota de crédito', doc, '', 0, parseFloat(c.monto_notas_credito || 0))
      push('Por pagar', c.contact_id, c.moneda, c.fecha_emision, '6 · Anticipo aplicado', doc, '', 0, parseFloat(c.monto_anticipo_aplicado || 0))
    }
    for (const k of _cobrosList) {
      const c = cxcMap[k.cxc_id]; if (!c) continue
      push('Por cobrar', k.contact_id, c.moneda, k.fecha, '4 · Cobro', _descDocCP(c), k.referencia, 0, parseFloat(k.monto || 0))
      push('Por cobrar', k.contact_id, c.moneda, k.fecha, '5 · Retención IGV', _descDocCP(c), k.numero_comprobante_retencion || 'sin comprobante', 0, parseFloat(k.monto_retencion || 0))
    }
    for (const p of _pagosList) {
      const c = cxpMap[p.cxp_id]; if (!c) continue
      push('Por pagar', p.contact_id, c.moneda, p.fecha, '4 · Pago', _descDocCP(c), p.referencia, 0, parseFloat(p.monto || 0))
    }
    // Letras: canje (factura → letra), cargo de la letra y sus abonos reales
    // (fecha y monto de cada abono). Las letras de refinanciación no tienen
    // factura: su cargo nace del saldo refinanciado de las letras de origen.
    const abonosLetra = await _abonosTodosCache()
    const abonosPorLetra = {}
    for (const a of abonosLetra) if (a.letra_id) (abonosPorLetra[a.letra_id] ||= []).push(a)
    // Lo que pasa a letras nuevas = saldo de cada origen − su parte del abono en el acto
    // (el abono ya figura como "Cobro de letra"; el interés de refinanciación va dentro del cargo de la letra nueva).
    let origRefin = []
    try {
      const [{ data: ori }, { data: refs }] = await Promise.all([
        supabase.from('letras_refinanciacion_origen').select('letra_id, saldo, refinanciacion_id'),
        supabase.from('letras_refinanciacion').select('id, total_saldos, monto_abono')
      ])
      const rmap = Object.fromEntries((refs || []).map(r => [r.id, r]))
      origRefin = (ori || []).map(o => {
        const r = rmap[o.refinanciacion_id]
        const parte = r && parseFloat(r.total_saldos) > 0 ? parseFloat(o.saldo) / parseFloat(r.total_saldos) * parseFloat(r.monto_abono || 0) : 0
        return { ...o, traspaso: _r2(parseFloat(o.saldo || 0) - parte) }
      })
    } catch (_) {}
    for (const l of (_letrasCache || [])) {
      if (l.estado === 'anulada') continue
      const emitida = l.tipo === 'emitida'
      const c = emitida ? cxcMap[l.cxc_id] : cxpMap[l.cxp_id]
      if (!c && !l.refinanciacion_id) continue
      const lado = emitida ? 'Por cobrar' : 'Por pagar'
      const mon = l.moneda || c?.moneda
      const m = parseFloat(l.monto || 0)
      if (!l.refinanciacion_id) push(lado, l.contact_id, mon, l.fecha_emision, '7 · Canje a letra', _descDocCP(c), l.numero_letra, 0, m)
      push(lado, l.contact_id, mon, l.fecha_emision, '8 · Letra', `Letra ${l.numero_letra}`, `Vence ${fechaDMY(l.fecha_vencimiento)} · ${l.estado}${l.refinanciacion_id ? ` · refinanc. #${l.refinanciacion_id}` : ''}`, m, 0)
      const abs = abonosPorLetra[l.id] || []
      for (const a of abs) {
        const ref = [a.numero_recibo ? `Rec. ${a.numero_recibo}` : '', a.numero_operacion ? `Op. ${a.numero_operacion}` : ''].filter(Boolean).join(' · ')
        push(lado, l.contact_id, mon, a.fecha, emitida ? '9 · Cobro de letra' : '9 · Pago de letra', `Letra ${l.numero_letra}`, ref, 0, parseFloat(a.monto_amortizado || 0))
      }
      // Sin abonos registrados (flujo anterior al SQL 77): usa el estado de la letra
      if (!abs.length && l.estado === 'cobrada') push(lado, l.contact_id, mon, l.fecha_cobro || String(l.updated_at || l.fecha_vencimiento).slice(0, 10),
        emitida ? '9 · Cobro de letra' : '9 · Pago de letra', `Letra ${l.numero_letra}`, l.numero_operacion, 0, m)
      // Saldo que pasó a letras nuevas (renovación / unificación)
      for (const o of origRefin.filter(o => Number(o.letra_id) === Number(l.id))) {
        push(lado, l.contact_id, mon, l.updated_at ? String(l.updated_at).slice(0, 10) : l.fecha_vencimiento, '10 · Pasa a letra nueva', `Letra ${l.numero_letra}`, `Refinanc. #${o.refinanciacion_id}`, 0, o.traspaso)
      }
    }
    // Abonos en el acto de una unificación (no pertenecen a una sola letra)
    for (const a of abonosLetra.filter(a => !a.letra_id && a.refinanciacion_id)) {
      push(a.tipo === 'emitida' ? 'Por cobrar' : 'Por pagar', a.contact_id, a.moneda, a.fecha, a.tipo === 'emitida' ? '9 · Cobro de letra' : '9 · Pago de letra',
        `Refinanciación #${a.refinanciacion_id}`, a.numero_recibo ? `Rec. ${a.numero_recibo}` : '', 0, parseFloat(a.monto_amortizado || 0))
    }
    filas.sort((a, b) => a.contacto.localeCompare(b.contacto) || a.fecha.localeCompare(b.fecha))

    crearReporte('rep-estado-cuenta', {
      id: 'rep-estado-cuenta',
      titulo: 'Estado de cuenta por cliente / proveedor',
      descripcion: 'Todos los movimientos de cada contacto: comprobantes, notas, cobros/pagos, retenciones y letras. Saldo = cargos − abonos. Filtra una moneda para que los totales no mezclen PEN y USD.',
      datos: filas,
      dimensiones: [
        { key: 'contacto', label: 'Cliente / Proveedor' }, { key: 'lado', label: 'Por cobrar / pagar' },
        { key: 'moneda', label: 'Moneda' }, { key: 'documento', label: 'Documento' },
        { key: 'tipo', label: 'Tipo de movimiento' }, { key: 'mes', label: 'Fecha', tipo: 'fecha', campo: 'fecha' }
      ],
      medidas: [
        { key: 'cargo', label: 'Cargos', agg: 'sum', formato: 'money' },
        { key: 'abono', label: 'Abonos', agg: 'sum', formato: 'money' },
        { key: 'saldo', label: 'Saldo', agg: 'sum', formato: 'money', semaforo: true }
      ],
      filtros: [
        { key: 'contacto', label: 'Cliente / Proveedor', tipo: 'texto', campos: ['contacto', 'documento', 'referencia'], placeholder: 'Nombre, comprobante o referencia...' },
        { key: 'lado', label: 'Lado', tipo: 'select', opciones: ['Por cobrar', 'Por pagar'] },
        { key: 'moneda', label: 'Moneda', tipo: 'select', opciones: ['PEN', 'USD'] },
        { key: 'tipo', label: 'Tipo', tipo: 'select', opciones: [...new Set(filas.map(f => f.tipo))].sort() },
        { key: 'rango', label: 'Fecha', tipo: 'rango', campo: 'fecha' }
      ],
      agruparPorDefecto: ['contacto', 'documento'],
      medidasPorDefecto: ['cargo', 'abono', 'saldo'],
      kpis: (fs) => {
        const cargo = fs.reduce((s, f) => s + f.cargo, 0)
        const abono = fs.reduce((s, f) => s + f.abono, 0)
        const monedas = new Set(fs.map(f => f.moneda))
        return [
          { label: 'Cargos', valor: cargo, formato: 'money' },
          { label: 'Abonos', valor: abono, formato: 'money', color: 'var(--color-success)' },
          { label: monedas.size > 1 ? 'Saldo (⚠ mezcla PEN+USD)' : 'Saldo', valor: cargo - abono, formato: 'money', color: 'var(--color-warning)' },
          { label: 'Contactos', valor: new Set(fs.map(f => f.contacto)).size, formato: 'int' },
          { label: 'Movimientos', valor: fs.length, formato: 'int' }
        ]
      }
    })
  } catch (e) {
    console.error('construirEstadoCuenta:', e)
    const el = document.getElementById('rep-estado-cuenta')
    if (el) el.innerHTML = `<p class="reporte-vacio">No se pudo armar el estado de cuenta: ${_esc(e.message)}</p>`
  }
}

// ============================================================================
// REGISTRAR COBRO / PAGO — MONEDAS (factura en una moneda, dinero en otra)
// ============================================================================
// "Se aplica a la factura" (cobroMonto / pagoMonto) es SIEMPRE la moneda del
// documento: es lo que baja el saldo de la CxC/CxP y de sus cuotas.
// "Importe recibido/pagado" es la moneda en que se movió el dinero (la de la
// cuenta bancaria). T.C. = soles por 1 dólar. Se puede digitar cualquiera de
// los dos importes y el otro se recalcula.

/** USD→PEN multiplica por T.C.; PEN→USD divide. Misma moneda: igual. */
function _convMoneda(monto, de, a, tc) {
  monto = parseFloat(monto) || 0
  if (!de || !a || de === a) return monto
  const t = parseFloat(tc) || 1
  return de === 'USD' ? monto * t : monto / t
}

const _CP_IDS = {
  cobro: { sel: 'cobroSelectCxC', banco: 'cobroBanco', moneda: 'cobroMonedaCobro', tc: 'cobroTipoCambio', tcGroup: 'cobroTCGroup',
           mov: 'cobroMontoRecibido', apl: 'cobroMonto', aplGroup: 'cobroAplicadoGroup', lblMov: 'cobroLblRecibido', lblApl: 'cobroLblAplicado',
           resumen: 'cobro-resumen', verbo: 'recibido', doc: () => _cxcList.find(c => c.id === parseInt(document.getElementById('cobroSelectCxC')?.value || 0)), saldo: d => _saldoCxC(d) },
  pago:  { sel: 'pagoSelectCompra', banco: 'pagoBanco', moneda: 'pagoMoneda', tc: 'pagoTipoCambio', tcGroup: 'pagoTCGroup',
           mov: 'pagoMontoMoneda', apl: 'pagoMonto', aplGroup: 'pagoAplicadoGroup', lblMov: 'pagoLblRecibido', lblApl: 'pagoLblAplicado',
           resumen: 'pago-resumen', verbo: 'pagado', doc: () => _cxpList.find(c => c.id === parseInt(document.getElementById('pagoSelectCompra')?.value || 0)), saldo: d => _saldoCxP(d) }
}

/** Tarjeta del documento (estándar info-card). */
function _cardDocCP(doc, esCxC, pendiente) {
  const m = doc.moneda || 'PEN'
  return `<div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">${esCxC ? 'Cliente' : 'Proveedor'} · Factura en ${m}</div>
    <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${_esc(_nombreContacto(doc.contact_id))}</div>
    <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">${_esc(_descDocCP(doc))} · Total ${m} ${formatNumber(doc.monto_total)} · <b style="color:var(--color-warning);">Pendiente ${m} ${formatNumber(pendiente)}</b>${doc.fecha_vencimiento ? ` · Vence ${fechaDMY(doc.fecha_vencimiento)}` : ''}</div>`
}

window._cpRecalc = function (tipo, origen) {
  const k = _CP_IDS[tipo]
  const $ = id => document.getElementById(id)
  const doc = k.doc()
  const monDoc = doc?.moneda || 'PEN'

  // La moneda del dinero la define la cuenta bancaria (si hay una elegida)
  const banco = _bancosMap[parseInt($(k.banco)?.value || 0)]
  if (banco?.moneda) { $(k.moneda).value = banco.moneda; $(k.moneda).disabled = true }
  else $(k.moneda).disabled = false
  if (origen === 'doc' && !banco) $(k.moneda).value = monDoc
  const monMov = $(k.moneda).value || monDoc
  const distinta = monMov !== monDoc

  // Editar el importe recibido/pagado recalcula el T.C. (el importe aplicado a
  // la factura se mantiene): T.C. = soles ÷ dólares. Así los 3 campos quedan
  // ligados en ambos sentidos — T.C. o aplicado → recalcula el recibido;
  // recibido → recalcula el T.C. Si aún no hay importe aplicado, se usa el T.C.
  const aplPrevio = parseFloat($(k.apl).value) || 0
  const movNuevo  = parseFloat($(k.mov).value) || 0
  if (origen === 'recibido' && distinta && aplPrevio > 0 && movNuevo > 0) {
    const tcCalc = monMov === 'PEN' ? movNuevo / aplPrevio : aplPrevio / movNuevo
    $(k.tc).value = tcCalc.toFixed(4)
    origen = 'tc-calculado'
  }
  const tc = parseFloat($(k.tc).value) || 0

  $(k.tcGroup).style.visibility = (distinta || monDoc === 'USD' || monMov === 'USD') ? 'visible' : 'hidden'
  $(k.aplGroup).style.display = distinta ? 'grid' : 'none'
  $(k.lblMov).textContent = `Importe ${k.verbo} (${monMov}) *`
  $(k.lblApl).textContent = `Se aplica a la factura (${monDoc})`

  if (distinta && !(tc > 0)) { $(k.resumen).innerHTML = '<span style="grid-column:1/-1; color:var(--color-warning);">Ingresa el tipo de cambio</span>'; return }

  // Recalcular el importe que NO se está digitando
  if (origen === 'tc-calculado') {
    // el T.C. ya se derivó de los dos importes: no se toca ninguno
  } else if (origen === 'recibido') {
    $(k.apl).value = $(k.mov).value === '' ? '' : _r2(_convMoneda($(k.mov).value, monMov, monDoc, tc)).toFixed(2)
  } else {
    $(k.mov).value = $(k.apl).value === '' ? '' : _r2(_convMoneda($(k.apl).value, monDoc, monMov, tc)).toFixed(2)
  }

  // Resumen: lo que entra/sale del banco, lo que se aplica y el saldo que queda
  const apl = parseFloat($(k.apl).value) || 0
  const mov = parseFloat($(k.mov).value) || 0
  const pend = doc ? Math.max(0, k.saldo(doc)) : 0
  const ret = tipo === 'cobro' && $('cobroAplicarRetencion')?.checked && _cobroRetencionPendiente > 0 ? _cobroRetencionPendiente : 0
  const queda = _r2(pend - apl - ret)
  const celda = (lbl, val, color = 'var(--text-primary)') => `<div><div style="font-size:11px; color:var(--text-secondary);">${lbl}</div><div style="font-size:16px; font-weight:600; color:${color};">${val}</div></div>`
  $(k.resumen).innerHTML = doc
    ? celda(tipo === 'cobro' ? 'Entra al banco' : 'Sale del banco', `${monMov} ${formatNumber(mov)}`)
      + celda('Se aplica a la factura', `${monDoc} ${formatNumber(apl + ret)}${ret ? ` <small style="font-size:11px;">(incl. ret. ${formatNumber(ret)})</small>` : ''}`)
      + celda('Saldo después', `${monDoc} ${formatNumber(queda)}`, queda < -0.01 ? 'var(--color-danger)' : (queda <= 0.01 ? 'var(--color-success)' : 'var(--color-warning)'))
    : '<span style="grid-column:1/-1; color:var(--text-secondary);">Selecciona el documento</span>'
}

// ============================================================================
// ARCHIVOS ADJUNTOS (voucher / recibo / otro) — tabla `adjuntos` (script 60)
// ============================================================================
// Hasta 3 archivos por vez, cada uno con su concepto. Se eligen en el modal
// (quedan "pendientes" en memoria) y se suben al guardar el cobro/pago.
const _adjPendientes = { cobro: [], pago: [], ecp: [], clet: [], rlet: [], rfin: [] }
const _adjConteo = { cobro: {}, pago: {} }
const _ADJ_MAX_VEZ = 3

window._adjSeleccionar = function (pref) {
  const input = document.getElementById(`${pref}Archivo`)
  const nuevos = [...(input?.files || [])]
  const libres = _ADJ_MAX_VEZ - _adjPendientes[pref].length
  if (nuevos.length > libres) showToast(`Máximo ${_ADJ_MAX_VEZ} archivos por vez: se tomaron los primeros ${Math.max(0, libres)}`, 'warning')
  for (const f of nuevos.slice(0, Math.max(0, libres))) {
    // Sugerencia de concepto por el nombre del archivo
    const n = f.name.toLowerCase()
    // Letras cobradas en banco (o nombre con "dietario") → Dietario del banco
    const enBanco = (pref === 'clet' && _clet?.ubicacion === 'banco') || (pref === 'rfin' && _rfin?.ubicacion === 'banco')
    _adjPendientes[pref].push({ file: f, concepto: /dietar/.test(n) ? 'dietario' : (/recib/.test(n) ? 'recibo' : (/vouch|constan|transf|deposit/.test(n) ? 'voucher' : (enBanco ? 'dietario' : 'voucher'))) })
  }
  input.value = ''   // permite volver a elegir el mismo archivo
  _pintarAdjPendientes(pref)
}

window._adjConcepto = function (pref, i, valor) { if (_adjPendientes[pref][i]) _adjPendientes[pref][i].concepto = valor }
window._adjQuitarPendiente = function (pref, i) { _adjPendientes[pref].splice(i, 1); _pintarAdjPendientes(pref) }

function _pintarAdjPendientes(pref) {
  const cont = document.getElementById(`${pref}-adj-lista`)
  if (!cont) return
  const opts = v => Object.entries(ADJ_CONCEPTOS).map(([k, t]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${t}</option>`).join('')
  cont.innerHTML = _adjPendientes[pref].map((a, i) => `
    <div style="display:grid; grid-template-columns:130px 1fr auto; gap:8px; align-items:center; padding:6px 8px; background:var(--bg-secondary); border-radius:var(--radius-sm);">
      <select onchange="window._adjConcepto('${pref}', ${i}, this.value)" style="padding:4px 6px;">${opts(a.concepto)}</select>
      <span style="font-size:0.82rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${_esc(a.file.name)}">📄 ${_esc(a.file.name)} <small style="color:var(--text-secondary);">(${(a.file.size / 1024).toFixed(0)} KB)</small></span>
      <button type="button" class="btn btn-small btn-danger" onclick="window._adjQuitarPendiente('${pref}', ${i})" title="Quitar">✕</button>
    </div>`).join('')
  const input = document.getElementById(`${pref}Archivo`)
  if (input) input.disabled = _adjPendientes[pref].length >= _ADJ_MAX_VEZ
}

/** Sube los pendientes del modal. Nunca rompe el registro: solo avisa si algo falla. */
async function _subirAdjuntosPendientes(pref, entidad, id) {
  const items = _adjPendientes[pref]
  if (!items.length) return
  try {
    const { ok, errores } = await subirAdjuntos(entidad, id, items, getCurrentUser()?.db_id || null)
    if (errores.length) showToast(`⚠️ ${ok} archivo(s) subido(s). No se subieron: ${errores.join(' · ')}`, 'warning', 8000)
  } catch (e) {
    showToast('⚠️ Registro guardado, pero los archivos no se subieron: ' + e.message, 'warning', 7000)
  } finally {
    _adjPendientes[pref] = []
    _pintarAdjPendientes(pref)
  }
}

function _htmlAdjuntos(entidad, id, adjuntos, conQuitar) {
  if (!adjuntos?.length) return '<span style="color:var(--text-secondary);">Sin archivos adjuntos.</span>'
  return adjuntos.map(a => `<div>
      <span class="badge badge-info" style="font-size:0.7rem;">${ADJ_CONCEPTOS[a.concepto] || a.concepto}</span>
      <a href="#" onclick="window.verAdjunto(${a.id}, '${a.path}'); return false;">${_esc(a.nombre)}</a>
      ${conQuitar ? `· <a href="#" style="color:var(--color-danger);" onclick="window.quitarAdjunto('${entidad}', ${id}, ${a.id}); return false;">Quitar</a>` : ''}
    </div>`).join('')
}

function _clipAdjunto(entidad, id) {
  const n = _adjConteo[entidad]?.[id] || 0
  return n ? ` <a href="#" title="${n} archivo(s) adjunto(s)" onclick="window.verDetalleCP('${entidad}', ${id}); return false;" style="text-decoration:none;">📎${n > 1 ? n : ''}</a>` : ''
}

window.verAdjunto = async function (adjId, path) {
  const w = window.open('', '_blank')   // antes del await: si no, el navegador lo bloquea
  try {
    const url = await getUrlAdjunto(path)
    if (!url) throw new Error('Archivo no encontrado')
    if (w) w.location.href = url; else window.open(url, '_blank')
  } catch (e) { if (w) w.close(); showToast('Error: ' + e.message, 'danger') }
}

/** Archivos ya guardados de la letra (en el modal Cobrar/abonar). */
async function _pintarAdjLetra(letraId) {
  const c = document.getElementById('clet-adjunto')
  if (!c) return
  c.innerHTML = '<span style="color:var(--text-secondary);">Cargando archivos…</span>'
  try {
    const adj = await getAdjuntos('letra', letraId)
    c.innerHTML = adj?.length
      ? `<div style="color:var(--text-secondary); font-size:0.75rem;">Ya guardados en la letra:</div>${_htmlAdjuntos('letra', letraId, adj, true)}`
      : ''
  } catch (e) { c.innerHTML = '' }
}

window.quitarAdjunto = async function (entidad, id, adjId) {
  if (!confirm('¿Quitar este archivo adjunto?')) return
  try {
    await eliminarAdjunto(adjId)
    if (entidad === 'letra') { await _pintarAdjLetra(id); showToast('Archivo eliminado', 'success'); return }
    document.getElementById('ecp-adjunto').innerHTML = _htmlAdjuntos(entidad, id, await getAdjuntos(entidad, id), true)
    showToast('Archivo eliminado', 'success')
    await Promise.all([cargarCobrosRecientes(), cargarPagosRecientes()])
  } catch (e) { showToast('Error: ' + e.message, 'danger') }
}

// ============================================================================
// TIPO DE CAMBIO — 8 decimales + valor por defecto (2026-10-03)
// ============================================================================
/**
 * T.C. que se GUARDA en el cobro/pago. Si el dinero entró en otra moneda, se
 * deriva de los dos importes (recibido ÷ aplicado) con 8 decimales, para que
 * el movimiento bancario reproduzca exacto el importe del voucher.
 */
function _tcEfectivoCP(tipo) {
  const k = _CP_IDS[tipo]
  const $ = id => document.getElementById(id)
  const doc = k.doc()
  const monDoc = doc?.moneda || 'PEN'
  const monMov = $(k.moneda).value || monDoc
  const apl = parseFloat($(k.apl).value) || 0
  const mov = parseFloat($(k.mov).value) || 0
  let tc = parseFloat($(k.tc).value) || parseFloat(doc?.tipo_cambio) || 1
  if (monMov !== monDoc && apl > 0 && mov > 0) tc = monMov === 'PEN' ? mov / apl : apl / mov
  return Math.round(tc * 1e8) / 1e8
}

/**
 * T.C. por defecto al elegir documento o cambiar la fecha: el de SUNAT del día
 * guardado en caché (sin gastar crédito de Decolecta) con el mismo criterio
 * del documento (cobros → venta, pagos → compra). Si no hay, el T.C. de la
 * factura → mismo día y mismo T.C. = sin diferencia de cambio.
 */
window._tcDefaultCP = async function (tipo) {
  const k = _CP_IDS[tipo]
  const $ = id => document.getElementById(id)
  const doc = k.doc()
  if (!doc) return
  const fecha = $(tipo === 'cobro' ? 'cobroFecha' : 'pagoFecha')?.value
  let tc = parseFloat(doc.tipo_cambio) || 0
  let fuente = 'T.C. de la factura'
  try {
    const r = await getTipoCambioDia(fecha, { permitirApi: false })
    const v = tipo === 'cobro' ? r?.venta : r?.compra
    if (v > 0) { tc = v; fuente = `SUNAT ${tipo === 'cobro' ? 'venta' : 'compra'} del ${fecha}` }
  } catch (e) { /* sin caché: queda el de la factura */ }
  if (tc > 0) {
    $(k.tc).value = tc
    $(k.tc).title = fuente
    window._cpRecalc(tipo, 'tc')
  }
}

/** T.C. con que se cobró/pagó una letra (lo guarda la línea de banco de su asiento). */
async function _tcCancelLetra(l) {
  if (!l.asiento_cobro_id) return l.tipo_cambio || ''
  const { data } = await supabase.from('journal_entry_lines').select('tipo_cambio, importe_original')
    .eq('journal_entry_id', l.asiento_cobro_id)
  const tcs = (data || []).map(x => parseFloat(x.tipo_cambio)).filter(v => v > 0)
  const distinto = tcs.find(v => Math.abs(v - parseFloat(l.tipo_cambio || 0)) > 1e-9)
  return distinto || tcs[0] || l.tipo_cambio || ''
}

window._tcDefaultLetra = async function (l, forzar = false) {
  const monCta = _monedaBanco(document.getElementById('cletBanco')?.value)
  if (!forzar && (l.moneda || 'PEN') !== 'USD' && !(monCta && monCta !== (l.moneda || 'PEN'))) return
  try {
    const fecha = document.getElementById('cletFecha')?.value
    const r = await getTipoCambioDia(fecha, { permitirApi: false })
    const v = l.tipo === 'emitida' ? r?.venta : r?.compra
    if (v > 0) document.getElementById('cletTC').value = v
  } catch (e) { /* queda el de la letra */ }
}

/** true si el registro es de un documento en USD y su asiento aún está en formato viejo (sin importe ME). */
async function _asientoSinME(reg) {
  if ((reg.moneda || 'PEN') !== 'USD' || !reg.asiento_id) return false
  const { data } = await supabase.from('journal_entry_lines').select('importe_original').eq('journal_entry_id', reg.asiento_id)
  return !(data || []).some(l => parseFloat(l.importe_original) > 0)
}


// ============================================================================
// RECIBOS DE COBRANZA — correlativo único (cobros de facturas + abonos de letras)
// ============================================================================
// Un recibo puede agrupar varios vouchers del MISMO cliente. La vista agrupa
// por N°, detecta HUECOS del correlativo (por prefijo) y N° repetidos en
// clientes distintos (casi siempre error de tipeo).
window.cargarRecibos = async function () {
  const tbody = document.getElementById('tbody-recibos')
  const avisos = document.getElementById('recibos-avisos')
  if (!tbody) return
  tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;">Cargando...</td></tr>'
  try {
    if (!_letrasCache.length) _letrasCache = await cacheado('letras_cambio', getLetrasCambio)
    if (!_cxcList.length) _cxcList = await cacheado('cuentas_cobrar', getCuentasCobrar)
    const q = (document.getElementById('rec-buscar')?.value || '').toLowerCase().trim()
    const desde = document.getElementById('rec-desde')?.value || ''
    const hasta = document.getElementById('rec-hasta')?.value || ''
    const todos = await _todosLosRecibos()
    // Agrupar por N°
    const grupos = new Map()
    for (const r of todos) {
      const k = String(r.numero_recibo).trim().toUpperCase()
      if (!grupos.has(k)) grupos.set(k, [])
      grupos.get(k).push(r)
    }
    const desc = r => {
      if (r.origen === 'cobro') {
        const cxc = _cxcList.find(d => d.id === r.cxc_id)
        return { txt: `Cobro ${cxc ? `${cxc.serie ? cxc.serie + '-' : ''}${cxc.numero_comprobante || ''}` : 'factura'}`, ver: `window.verDetalleCP('cobro', ${r.id})` }
      }
      const l = _letrasCache.find(x => x.id === r.letra_id)
      return { txt: `${_TIPOS_ABONO[r.tipo_abono] || 'Abono'} letra ${l?.numero_letra || (r.refinanciacion_id ? `(refinanc. #${r.refinanciacion_id})` : '')}`, ver: r.letra_id ? `window.verDetalleLetra(${r.letra_id})` : '' }
    }
    let filas = [...grupos.entries()].map(([num, items]) => {
      const clientes = [...new Set(items.map(i => Number(i.contact_id)))]
      const fecha = items.map(i => i.fecha).sort()[0]
      const monedas = [...new Set(items.map(i => i.moneda || 'PEN'))]
      return { num, items, clientes, fecha, monedas, total: _r2(items.reduce((t, i) => t + _n(i.importe), 0)), partes: _partesRecibo(num) }
    })
    // Huecos por prefijo (sobre TODOS, antes de filtrar)
    const porPref = {}
    for (const f of filas) if (f.partes) (porPref[f.partes.pref] ||= []).push(f.partes)
    const huecos = []
    for (const [pref, arr] of Object.entries(porPref)) {
      const nums = [...new Set(arr.map(a => a.num))].sort((a, b) => a - b)
      const ancho = arr[0].ancho
      for (let i = 1; i < nums.length; i++) {
        const salto = nums[i] - nums[i - 1]
        if (salto > 1 && salto <= 50) for (let n = nums[i - 1] + 1; n < nums[i]; n++) huecos.push(`${pref}${String(n).padStart(ancho, '0')}`)
        else if (salto > 50) huecos.push(`${pref}${String(nums[i - 1] + 1).padStart(ancho, '0')} … ${pref}${String(nums[i] - 1).padStart(ancho, '0')}`)
      }
    }
    const dup = filas.filter(f => f.clientes.length > 1)
    if (avisos) avisos.innerHTML = [
      huecos.length ? `<div style="padding:8px 12px; border-left:3px solid var(--color-warning); background:var(--bg-secondary); border-radius:var(--radius-sm);">⚠ <b>${huecos.length} N° faltante(s)</b> en el correlativo: ${huecos.slice(0, 30).map(_esc).join(', ')}${huecos.length > 30 ? '…' : ''}<br><small style="color:var(--text-secondary);">Pueden ser recibos anulados o aún no registrados en el ERP.</small></div>` : '',
      dup.length ? `<div style="padding:8px 12px; border-left:3px solid var(--color-danger); background:var(--bg-secondary); border-radius:var(--radius-sm);">⛔ <b>${dup.length} N° usado(s) en clientes distintos</b>: ${dup.map(d => _esc(d.num)).join(', ')}</div>` : '',
      !huecos.length && !dup.length && filas.length ? '<div style="padding:8px 12px; border-left:3px solid var(--color-success); background:var(--bg-secondary); border-radius:var(--radius-sm);">✅ Correlativo sin huecos ni duplicados.</div>' : ''
    ].join('')
    filas = filas.filter(f => (!desde || f.fecha >= desde) && (!hasta || f.fecha <= hasta)
      && (!q || `${f.num} ${f.clientes.map(c => _nombreContacto(c)).join(' ')} ${f.items.map(i => desc(i).txt).join(' ')}`.toLowerCase().includes(q)))
      .sort((a, b) => (b.partes?.pref || '').localeCompare(a.partes?.pref || '') || (b.partes?.num ?? 0) - (a.partes?.num ?? 0) || b.num.localeCompare(a.num))
    document.getElementById('recibos-total').textContent = `${filas.length} recibo(s)`
    if (!filas.length) { tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;">Sin recibos para los filtros</td></tr>'; return }
    tbody.innerHTML = filas.map(f => {
      const malo = f.clientes.length > 1
      return f.items.map((i, k) => {
        const d = desc(i)
        return `<tr style="${k ? '' : 'border-top:2px solid var(--border-color);'}${malo ? ' color:var(--color-danger);' : ''}">
          ${k ? '<td></td>' : `<td rowspan="1" style="font-weight:700;">${_esc(f.num)}${f.items.length > 1 ? ` <small class="badge badge-info">${f.items.length}</small>` : ''}</td>`}
          <td>${fechaDMY(i.fecha)}</td>
          <td>${_esc(_nombreContacto(i.contact_id))}</td>
          <td>${d.ver ? `<a href="#" onclick="${d.ver}; return false;">${_esc(d.txt)}</a>` : _esc(d.txt)}</td>
          <td>${_esc(i.origen === 'cobro' ? (i.medio_pago || '—') : (_MEDIOS_LETRA[i.medio] || i.medio || '—'))}<br><small style="color:var(--text-secondary);">${_esc(_bancosMap[i.banco_id]?.nombre || '')}</small></td>
          <td>${i.moneda || 'PEN'}</td>
          <td style="text-align:right;">${formatNumber(i.importe)}</td>
          <td style="text-align:right; font-weight:600;">${k === f.items.length - 1 && f.items.length > 1 ? formatNumber(f.total) : (f.items.length === 1 ? formatNumber(f.total) : '')}</td>
          <td><span class="badge ${i.origen === 'cobro' ? 'badge-secondary' : 'badge-warning'}">${i.origen === 'cobro' ? 'Factura' : 'Letra'}</span></td>
        </tr>`
      }).join('')
    }).join('')
  } catch (e) {
    console.error('cargarRecibos:', e)
    tbody.innerHTML = `<tr><td colspan="9" style="color:var(--color-danger);">Error: ${_esc(e.message)}</td></tr>`
  }
}

window.exportarRecibosCSV = async function () {
  try {
    const todos = await _todosLosRecibos()
    const filas = todos.sort((a, b) => String(a.numero_recibo).localeCompare(String(b.numero_recibo), undefined, { numeric: true }))
      .map(r => [r.numero_recibo, r.fecha, _nombreContacto(r.contact_id), r.origen === 'cobro' ? 'Cobro factura' : (_TIPOS_ABONO[r.tipo_abono] || 'Abono letra'), r.moneda || 'PEN', _n(r.importe)])
    descargarCSV(`recibos_cobranza_${_hoyISO()}.csv`, [['N° Recibo', 'Fecha', 'Cliente', 'Concepto', 'Moneda', 'Importe'], ...filas])
  } catch (e) { showToast('Error: ' + e.message, 'danger') }
}
