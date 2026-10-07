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
  getCuentaCobrarById, getCuentaPagarById, getBancoById,
  getMovimientosBanco, deleteMovimientoBanco, updateMovimientoBanco, crearAsientoContable,
  getJournalEntryByReferencia, getJournalEntryLinesByEntry, eliminarAsientoContable, getAccounts,
  getContacts,
  getBancos, updateBanco, addMovimientoBanco,
  getLetrasCambio, addLetraCambio, updateLetraCambio, deleteLetraCambio,
  getSuppliers, getCuentasGasto, addCompra, addCompraDetalle, addCuentaPagar,
  generarAsientoCobroCliente, generarAsientoPagoProveedor, crearAsientoCancelacionME,
  subirAdjuntos, getAdjuntos, getConteoAdjuntos, getUrlAdjunto, eliminarAdjunto, eliminarAdjuntosDe, ADJ_CONCEPTOS
} from './supabase-data.js'
import { showToast, formatNumber, fechaDMY, hacerTablaOrdenable } from './helpers.js'
import { initModuleNavDropdowns, initSubtabs } from './main.js'
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
  invalidarVarios(['cuentas_cobrar', 'cuentas_pagar', 'cobros', 'pagos_proveedores', 'bancos', 'cuotas_cobrar', 'cuotas_pagar', 'letras_cambio'])
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
      const pendiente = total + notasDb - notasCr - cobrado - retenido - anticipoAp
      const vencida   = cxc.estado !== 'cobrado' && cxc.fecha_vencimiento && cxc.fecha_vencimiento < hoy
      const dias      = cxc.fecha_vencimiento ? diasVencidos(cxc.fecha_vencimiento) : null
      const retPendienteSustentar = retencionPendientePorCxc[cxc.id] || 0
      tTotal += total; tCobrado += cobrado + retenido; tPend += pendiente

      const badge = cxc.estado === 'cobrado' ? 'badge-success'
                  : cxc.estado === 'parcial' ? 'badge-warning'
                  : vencida ? 'badge-danger' : 'badge-secondary'

      return `<tr ${vencida ? 'style="background:rgba(239,68,68,.06);"' : ''}>
        <td>${_esc(_nombreContacto(cxc.contact_id))}</td>
        <td>${_esc(`${cxc.tipo_comprobante || ''} ${cxc.serie || ''}-${cxc.numero_comprobante || ''}`)}${_htmlCuotas(cxc.id)}</td>
        <td>${fechaDMY(cxc.fecha_emision, '-')}</td>
        <td>${fechaDMY(cxc.fecha_vencimiento, '—')}</td>
        <td>${dias === null ? '—' : (dias > 0 ? `<span class="badge badge-vencido">+${dias}</span>` : `<span class="badge badge-alcorriente">${dias}</span>`)}</td>
        <td>${cxc.moneda || 'PEN'}</td>
        <td style="text-align:right;">${formatNumber(total)}</td>
        <td style="text-align:right;">${formatNumber(cobrado)}${retenido > 0 ? `<br><small style="color:var(--color-warning);">+ret. ${formatNumber(retenido)}</small>` : ''}${notasCr > 0 ? `<br><small style="color:var(--color-danger);">−NC ${formatNumber(notasCr)}</small>` : ''}${notasDb > 0 ? `<br><small style="color:var(--color-success);">+ND ${formatNumber(notasDb)}</small>` : ''}${retPendienteSustentar > 0 ? `<br><span class="badge badge-warning" title="Retención de ${formatNumber(retPendienteSustentar)} aplicada al cobrar, sin N° de comprobante de retención del cliente todavía">⚠ pendiente sustentar ret.</span>` : ''}</td>
        <td style="text-align:right; font-weight:bold;">${formatNumber(pendiente)}</td>
        <td><span class="badge ${badge}">${cxc.estado}</span></td>
        <td style="white-space:nowrap;">${cxc.estado !== 'cobrado' ? `<button class="btn btn-small btn-primary" onclick="window.irARegistrarCobro(${cxc.id})">Cobrar</button> ` : ''}${_botonesDocCP('cxc', cxc.id)}</td>
      </tr>`
    }).join('')

    if (tfoot) tfoot.innerHTML = `
      <td colspan="6"><strong>TOTAL (${lista.length} documentos)</strong></td>
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
      const pend   = total + nDb - nCr - pagado - antAp
      const dias   = cxp.fecha_vencimiento ? diasVencidos(cxp.fecha_vencimiento) : null
      tTotal += total; tPagado += pagado; tPend += pend

      const badge = cxp.estado === 'pagado' ? 'badge-success'
                  : cxp.estado === 'parcial' ? 'badge-warning' : 'badge-secondary'

      return `<tr>
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
        <td style="white-space:nowrap;">${cxp.estado !== 'pagado' ? `<button class="btn btn-small btn-primary" onclick="window.irARegistrarPago(${cxp.id})">Pagar</button> ` : ''}${_botonesDocCP('cxp', cxp.id)}</td>
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

  if (panelId === 'rep-cobros') {
    const datos = _cobrosList.map(c => ({
      cliente: _nombreContacto(c.contact_id),
      mes: nombreMes((c.fecha || '').slice(0, 7)),
      medio: c.medio_pago || '(sin medio)',
      banco: _bancosMap[c.banco_id]?.nombre || '(sin banco)',
      moneda: c.moneda || 'PEN',
      fecha: c.fecha || '',
      monto: parseFloat(c.monto || 0),
      retencion: parseFloat(c.monto_retencion || 0),
      total_aplicado: parseFloat(c.monto || 0) + parseFloat(c.monto_retencion || 0)
    }))

    crearReporte('rep-cobros', {
      id: 'rep-cobros',
      titulo: 'Cobranza recibida',
      descripcion: 'Todo lo cobrado, cruzable por mes, cliente, medio de pago o banco.',
      datos,
      dimensiones: [
        { key: 'mes', label: 'Fecha', tipo: 'fecha', campo: 'fecha' }, { key: 'cliente', label: 'Cliente' },
        { key: 'medio', label: 'Medio de pago' }, { key: 'banco', label: 'Banco' },
        { key: 'moneda', label: 'Moneda' }
      ],
      medidas: [
        { key: 'monto', label: 'Cobrado en efectivo', agg: 'sum', formato: 'money' },
        { key: 'retencion', label: 'Retención IGV', agg: 'sum', formato: 'money' },
        { key: 'total_aplicado', label: 'Total aplicado', agg: 'sum', formato: 'money' }
      ],
      filtros: [
        { key: 'cliente', label: 'Cliente', tipo: 'texto', campos: ['cliente'], placeholder: 'Buscar...' },
        { key: 'medio', label: 'Medio', tipo: 'select', opciones: ['transferencia', 'deposito', 'efectivo', 'cheque', 'detraccion', 'otro'] },
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
  }

  if (panelId === 'rep-pagos') {
    const datos = _pagosList.map(p => ({
      proveedor: _nombreContacto(p.contact_id),
      mes: nombreMes((p.fecha || '').slice(0, 7)),
      medio: p.medio_pago || '(sin medio)',
      banco: _bancosMap[p.banco_id]?.nombre || '(sin banco)',
      moneda: p.moneda || 'PEN',
      fecha: p.fecha || '',
      monto: parseFloat(p.monto || 0)
    }))

    crearReporte('rep-pagos', {
      id: 'rep-pagos',
      titulo: 'Pagos a proveedores',
      descripcion: 'Salidas de caja hacia proveedores, por mes, proveedor, medio o banco.',
      datos,
      dimensiones: [
        { key: 'mes', label: 'Fecha', tipo: 'fecha', campo: 'fecha' }, { key: 'proveedor', label: 'Proveedor' },
        { key: 'medio', label: 'Medio de pago' }, { key: 'banco', label: 'Banco' },
        { key: 'moneda', label: 'Moneda' }
      ],
      medidas: [{ key: 'monto', label: 'Pagado', agg: 'sum', formato: 'money' }],
      filtros: [
        { key: 'proveedor', label: 'Proveedor', tipo: 'texto', campos: ['proveedor'], placeholder: 'Buscar...' },
        { key: 'medio', label: 'Medio', tipo: 'select', opciones: ['transferencia', 'cheque', 'efectivo', 'deposito', 'detraccion', 'otro'] },
        { key: 'rango', label: 'Fecha', tipo: 'rango', campo: 'fecha' }
      ],
      agruparPorDefecto: ['mes'],
      kpis: (filas) => [
        { label: 'Total pagado', valor: filas.reduce((s, f) => s + f.monto, 0), formato: 'money', color: 'var(--color-danger)' },
        { label: 'N° de pagos', valor: filas.length, formato: 'int' },
        { label: 'Pago promedio', valor: filas.length ? filas.reduce((s, f) => s + f.monto, 0) / filas.length : 0, formato: 'money' }
      ]
    })
  }

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
      .filter(l => (!tipoF || l.tipo === tipoF) && (!estadoF || l.estado === estadoF))
      .sort((a, b) => String(a.fecha_vencimiento || '').localeCompare(String(b.fecha_vencimiento || '')))

    const tbody = document.getElementById('tbody-letras')
    if (!tbody) return

    if (lista.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;">Sin letras registradas</td></tr>'
      return
    }

    const badgeEstado = {
      cartera: 'badge-secondary', banco: 'badge-info', cobranza: 'badge-warning',
      cobrada: 'badge-success', protestada: 'badge-danger',
      refinanciada: 'badge-warning', anulada: 'badge-secondary'
    }

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

      return `<tr>
        <td>${_esc(l.numero_letra)}</td>
        <td>${l.tipo === 'emitida' ? 'Por Cobrar' : 'Por Pagar'}</td>
        <td>${_esc(_nombreContacto(l.contact_id))}</td>
        <td>${_esc(comprobante)}${cuota ? ` <small style="color:var(--text-secondary);">(cuota ${cuota.numero_cuota})</small>` : ''}</td>
        <td>${fechaDMY(l.fecha_emision, '-')}</td>
        <td>${fechaDMY(l.fecha_vencimiento, '-')}</td>
        <td style="text-align:right;">${formatNumber(parseFloat(l.monto || 0))} ${l.moneda || 'PEN'}</td>
        <td>${banco}</td>
        <td><span class="badge ${badgeEstado[l.estado] || 'badge-secondary'}">${l.estado}</span></td>
        <td style="white-space:nowrap;">${_accionesLetra(l)}</td>
      </tr>`
    }).join('')
  } catch (e) {
    console.error('cargarLetras:', e)
    showToast('Error al cargar letras: ' + e.message, 'danger')
  }
}

function _accionesLetra(l) {
  // Estándar del sistema: acción principal del estado (Cobrar/Pagar) + 👁 ✏️ ✕.
  // "A banco" y "Protestar" viven dentro del Ver detalle.
  const abierta = ['cartera', 'banco', 'cobranza'].includes(l.estado)
  const principal = abierta
    ? `<button class="btn btn-small btn-primary" onclick="window.abrirCancelarLetra(${l.id})">${l.tipo === 'recibida' ? 'Pagar' : 'Cobrar'}</button> `
    : ''
  return principal + _botonesLetra(l.id)
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
  document.getElementById('letNumero').value = ''
  document.getElementById('letMonto').value = ''
  document.getElementById('letObservaciones').value = ''
  document.getElementById('letFechaEmision').value = hoy
  document.getElementById('letFechaVencimiento').value = ''
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

  document.getElementById('letMonto').value = ''
  document.getElementById('letCuotaAviso').textContent = opciones.length === 0
    ? 'No hay cuotas con saldo pendiente para este tipo.'
    : ''
}

window.onCambiarCuotaLetra = function () {
  const opt = document.getElementById('letCuota')?.selectedOptions[0]
  if (!opt || !opt.value) return
  const saldo = parseFloat(opt.getAttribute('data-saldo') || 0)
  const moneda = opt.getAttribute('data-moneda') || 'PEN'
  document.getElementById('letMonto').value = saldo.toFixed(2)
  document.getElementById('letCuotaAviso').textContent = `Saldo disponible: ${formatNumber(saldo)} ${moneda}`
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

    const numero = document.getElementById('letNumero')?.value?.trim()
    if (!numero) { showToast('Ingresa el N° de letra', 'warning'); return }

    const saldo = parseFloat(opt.getAttribute('data-saldo') || 0)
    const monto = parseFloat(document.getElementById('letMonto')?.value || 0)
    if (!monto || monto <= 0) { showToast('Ingresa un monto válido', 'warning'); return }
    if (monto > saldo + 0.01) {
      showToast(`El monto (${formatNumber(monto)}) supera el saldo de la cuota (${formatNumber(saldo)})`, 'warning')
      return
    }

    const fechaEmision = document.getElementById('letFechaEmision')?.value
    const fechaVencimiento = document.getElementById('letFechaVencimiento')?.value
    if (!fechaEmision || !fechaVencimiento) { showToast('Ingresa ambas fechas', 'warning'); return }

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
      monto: parseFloat(monto.toFixed(2)),
      fecha_emision: fechaEmision,
      fecha_vencimiento: fechaVencimiento,
      estado: 'cartera',
      observaciones,
      created_by: user.db_id
    })

    if (!letra?.id) {
      showToast('No se pudo registrar la letra (¿número duplicado?)', 'danger')
      return
    }

    // Consume el saldo de la cuota: monto_canjeado sube y el estado se
    // recalcula con el mismo helper que usan los cobros/pagos.
    const nuevoCanjeado = parseFloat(((parseFloat(cuota.monto_canjeado) || 0) + monto).toFixed(2))
    const cuotaActualizada = { ...cuota, monto_canjeado: nuevoCanjeado }
    if (tipo === 'emitida') {
      await updateCuotaCobrar(cuota.id, { monto_canjeado: nuevoCanjeado, estado: estadoCuota(cuotaActualizada, true) })
    } else {
      await updateCuotaPagar(cuota.id, { monto_canjeado: nuevoCanjeado, estado: estadoCuota(cuotaActualizada, false) })
    }

    // El canje también baja el saldo del DOCUMENTO (CxC/CxP), no solo de la cuota.
    await _aplicarCanjeDoc(tipo, tipo === 'emitida' ? cuota.cxc_id : cuota.cxp_id, monto)
    const asCanje = await _asientoLetra('canje', letra, null)
    if (asCanje?.id) await updateLetraCambio(letra.id, { asiento_emision_id: asCanje.id })

    showToast(`Letra ${numero} registrada ✅${asCanje?.id ? ` — asiento ${asCanje.numero_asiento}` : ''}`, 'success')
    window.closeModal('modal-nueva-letra')
    _refrescarTodo()
    await window.cargarLetras()
  } catch (e) {
    console.error('guardarLetra:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

// ── Cambios de estado ──

window.abrirModalLetraBanco = async function (id) {
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
  const etiquetas = { cartera: 'Cartera', banco: 'En banco', cobranza: 'En cobranza', cobrada: 'Cobrada', protestada: 'Protestada', refinanciada: 'Refinanciada', anulada: 'Anulada' }
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
  const cobrada = letra.estado === 'cobrada'
  if (!confirm(`¿Eliminar la letra ${letra.numero_letra}?\n\n${cobrada ? 'Primero se revierte su cobro/pago (movimiento bancario + asiento) y luego ' : ''}se libera el monto canjeado al saldo de la cuota y del documento, y se borra el asiento de canje.`)) return

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
        cuentaDebe: emitida ? '12131' : (usd ? '42122' : '42111'), cuentaHaber: emitida ? (usd ? '12112' : '12111') : '42131',
        tcDebe: tcDoc, tcHaber: tcDoc,
        descDebe: emitida ? 'Letras por cobrar' : 'Canje de factura', descHaber: emitida ? 'Canje de factura' : 'Letras por pagar'
      })
    }
    // Cobro/pago de la letra: banco al T.C. del día, letra al T.C. de la factura → 776/676
    const banco = bancoId ? await getBancoById(bancoId) : null
    const ctaBanco = banco?.cuenta_contable_codigo || '10411'
    const tcC = parseFloat(tcCancel) || tcDoc
    return await crearAsientoCancelacionME({
      ...base, descripcion: `${emitida ? 'Cobro' : 'Pago'} letra ${letra.numero_letra}`,
      documentoReferencia: `LETRA-CANC-${letra.id}`, tipoMovimiento: emitida ? 'Cobro Letra' : 'Pago Letra',
      cuentaDebe: emitida ? ctaBanco : '42131', cuentaHaber: emitida ? '12131' : ctaBanco,
      tcDebe: emitida ? tcC : tcDoc, tcHaber: emitida ? tcDoc : tcC,
      descDebe: emitida ? 'Cobro de letra' : 'Cancelación letra por pagar', descHaber: emitida ? 'Cancelación letra por cobrar' : 'Pago de letra'
    })
  } catch (e) {
    console.warn(`Asiento de letra (${etapa}) no generado:`, e.message)
    showToast(`⚠️ Asiento de ${etapa} no generado: ${e.message}`, 'warning', 6000)
    return null
  }
}

window.abrirCancelarLetra = function (id) {
  const l = _letrasCache.find(x => x.id === id)
  if (!l) return
  const emitida = l.tipo === 'emitida'
  document.getElementById('clet-titulo').textContent = `${emitida ? 'Cobrar' : 'Pagar'} letra ${l.numero_letra}`
  document.getElementById('clet-info').innerHTML = `
    <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">${emitida ? 'Letra por cobrar' : 'Letra por pagar'}</div>
    <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${_esc(l.numero_letra)} — ${l.moneda || 'PEN'} ${formatNumber(l.monto)}</div>
    <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">${_esc(_nombreContacto(l.contact_id))} · Vence ${fechaDMY(l.fecha_vencimiento)}</div>`
  document.getElementById('cletId').value = id
  document.getElementById('cletFecha').value = new Date().toISOString().split('T')[0]
  document.getElementById('cletNumOp').value = ''
  const sel = document.getElementById('cletBanco')
  sel.innerHTML = '<option value="">-- Selecciona --</option>' + _bancos
    .map(b => `<option value="${b.id}">${_esc(b.nombre)} — ${_esc(b.numero_cuenta || '')} (${b.moneda || ''})</option>`).join('')
  // Sugerir la cuenta de la misma moneda (o la del banco donde está la letra)
  sel.value = l.banco_id || (_bancos.find(b => b.moneda === (l.moneda || 'PEN'))?.id ?? '')
  const g = document.getElementById('cletTCGroup')
  if (g) g.style.display = (l.moneda || 'PEN') === 'USD' ? '' : 'none'
  document.getElementById('cletTC').value = l.tipo_cambio || ''
  window._tcDefaultLetra(l)
  window.openModal('modal-cancelar-letra')
}

/** Núcleo: cobra/paga la letra (asiento banco↔letra + movimiento MB + estado). */
async function _aplicarCancelacionLetra(l, bancoId, fecha, numOp, tcCancel = null) {
  const emitida = l.tipo === 'emitida'
  const tcC = parseFloat(tcCancel) || parseFloat(l.tipo_cambio) || 1
  const asiento = await _asientoLetra('cancelacion', l, bancoId, fecha, tcC)
  const mov = await _registrarMovimientoBancario({
    bancoId, tipo: emitida ? 'ingreso' : 'egreso', fecha,
    concepto: `${emitida ? 'Cobro' : 'Pago'} letra ${l.numero_letra} — ${_nombreContacto(l.contact_id)}`,
    categoria: emitida ? 'Cobranza letras' : 'Pago letras',
    referencia: `LETRA ${l.numero_letra}`, numeroOperacion: numOp,
    monto: _r2(l.monto), asientoId: asiento?.id || null,
    monedaMonto: l.moneda || 'PEN', tc: tcC
  })
  const upd = await updateLetraCambio(l.id, {
    estado: 'cobrada', banco_id: bancoId, numero_operacion: numOp,
    asiento_cobro_id: asiento?.id || null, updated_at: new Date().toISOString()
  })
  if (!upd) throw new Error('No se pudo actualizar la letra')
  Object.assign(l, { estado: 'cobrada', banco_id: bancoId, numero_operacion: numOp, asiento_cobro_id: asiento?.id || null })
  return { mov, asiento }
}

window.confirmarCancelarLetra = async function () {
  const id = parseInt(document.getElementById('cletId').value || 0)
  const l = _letrasCache.find(x => x.id === id)
  if (!l) return
  const bancoId = parseInt(document.getElementById('cletBanco').value || 0)
  const fecha = document.getElementById('cletFecha').value
  const numOp = document.getElementById('cletNumOp').value.trim() || null
  if (!bancoId) { showToast('Selecciona la cuenta bancaria', 'warning'); return }
  if (!fecha)   { showToast('Ingresa la fecha', 'warning'); return }
  const btn = document.getElementById('cletBtnOk')
  if (btn.disabled) return
  btn.disabled = true
  try {
    const tcC = parseFloat(document.getElementById('cletTC')?.value) || parseFloat(l.tipo_cambio) || 1
    const { mov, asiento } = await _aplicarCancelacionLetra(l, bancoId, fecha, numOp, tcC)
    window.closeModal('modal-cancelar-letra')
    showToast(`Letra ${l.numero_letra} ${l.tipo === 'emitida' ? 'cobrada' : 'pagada'} ✅${mov?.id ? ` — ${_numMB(mov.id)}` : ''}${asiento?.id ? ` / ${asiento.numero_asiento}` : ''}`, 'success', 6000)
    _refrescarTodo()
    await _recargarTrasLetra()
  } catch (e) {
    console.error('confirmarCancelarLetra:', e)
    showToast('Error: ' + e.message, 'danger')
  } finally { btn.disabled = false }
}

/** Deshace el cobro/pago de una letra (mov. bancario + saldo + asiento) y la deja en cartera. */
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
  invalidarVarios(['letras_cambio', 'cuentas_cobrar', 'cuentas_pagar', 'cuotas_cobrar', 'cuotas_pagar', 'movimientos_banco', 'bancos'])
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
    const abierta = ['cartera', 'banco', 'cobranza'].includes(l.estado)
    document.getElementById('detalle-cp-titulo').textContent = `Letra ${l.numero_letra}`
    document.getElementById('detalle-cp-acciones').innerHTML = `
      <button class="btn btn-secondary" onclick="window.closeModal('modal-detalle-cp')">Cerrar</button>
      ${l.estado === 'cartera' ? `<button class="btn btn-secondary" onclick="window.closeModal('modal-detalle-cp'); window.abrirModalLetraBanco(${id})">A banco</button>` : ''}
      ${(l.estado === 'banco' || l.estado === 'cobranza') ? `<button class="btn btn-secondary" onclick="window.closeModal('modal-detalle-cp'); window.cambiarEstadoLetra(${id},'protestada')">Protestar</button>` : ''}
      ${abierta ? `<button class="btn btn-primary" onclick="window.closeModal('modal-detalle-cp'); window.abrirCancelarLetra(${id})">${emitida ? 'Cobrar' : 'Pagar'}</button>` : ''}
      <button class="btn btn-secondary" onclick="window.closeModal('modal-detalle-cp'); window.abrirEditarLetra(${id})">✏️ Editar</button>
      <button class="btn btn-danger" onclick="window.eliminarLetra(${id})">✕ Eliminar</button>`

    const doc = emitida ? (l.cxc_id ? await getCuentaCobrarById(l.cxc_id) : null) : (l.cxp_id ? await getCuentaPagarById(l.cxp_id) : null)
    const [mov, asCanje, asCobro] = await Promise.all([_movDeLetra(l), _numeroAsiento(l.asiento_emision_id), _numeroAsiento(l.asiento_cobro_id)])
    const fila = (k, v) => `<tr><td style="color:var(--text-secondary); width:40%;">${k}</td><td>${v}</td></tr>`

    body.innerHTML = `
      <div style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info); font-size:0.88rem; line-height:1.6;">
        <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">${emitida ? 'Letra por cobrar' : 'Letra por pagar'} · ${l.estado}</div>
        <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${_esc(l.numero_letra)} — ${l.moneda || 'PEN'} ${formatNumber(l.monto)}</div>
        <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">${_esc(_nombreContacto(l.contact_id))} · Canjea ${_esc(doc ? _descDocCP(doc) : '—')}</div>
      </div>
      <table class="table-compact" style="width:100%; margin-top:10px;">
        ${fila('F. Emisión', fechaDMY(l.fecha_emision))}
        ${fila('F. Vencimiento', fechaDMY(l.fecha_vencimiento))}
        ${fila('Banco', _esc(l.banco_id ? (_bancosMap[l.banco_id]?.nombre || l.banco_id) : '—'))}
        ${fila('N° Operación', _esc(l.numero_operacion || '—'))}
        ${fila('Asiento de canje', asCanje)}
        ${fila(emitida ? 'Asiento de cobro' : 'Asiento de pago', asCobro)}
        ${fila('Observaciones', _esc(l.observaciones || '—'))}
      </table>
      <h4 style="margin:16px 0 6px;">Movimiento bancario</h4>
      ${mov ? `<table class="table-compact" style="width:100%;">
        ${fila('N° Registro', `<b>${_numMB(mov.id)}</b>`)}
        ${fila('Fecha', fechaDMY(mov.fecha))}
        ${fila('Cuenta', _esc(_bancosMap[mov.banco_id]?.nombre || mov.banco_id))}
        ${fila('Monto', `${mov.tipo} ${formatNumber(mov.monto)}`)}
        ${fila('Saldo posterior', mov.saldo_posterior != null ? formatNumber(mov.saldo_posterior) : '—')}
      </table>` : `<p style="color:var(--text-secondary);">${l.estado === 'cobrada' ? 'No se encontró el movimiento.' : 'Aún no cobrada/pagada.'}</p>`}`
  } catch (e) {
    console.error('verDetalleLetra:', e)
    body.innerHTML = `<p style="color:var(--color-danger);">Error: ${_esc(e.message)}</p>`
  }
}

let _edicionLetra = null   // { letra, mov, maxMonto }

window.abrirEditarLetra = async function (id) {
  try {
    const l = await _getLetra(id)
    if (!l) { showToast('Letra no encontrada', 'danger'); return }
    const emitida = l.tipo === 'emitida'
    await _refrescarCuotasDoc(emitida, emitida ? l.cxc_id : l.cxp_id)
    const cuota = emitida ? _cuotasCache.find(q => q.id === l.cuota_cobrar_id) : _cuotasPagarCache.find(q => q.id === l.cuota_pagar_id)
    const maxMonto = _r2((cuota ? saldoCuota(cuota) : 0) + parseFloat(l.monto || 0))
    const mov = l.estado === 'cobrada' ? await _movDeLetra(l) : null
    _edicionLetra = { letra: l, mov, maxMonto }

    const $ = i => document.getElementById(i)
    $('elet-titulo').textContent = `Editar letra ${l.numero_letra}`
    $('eletNumero').value = l.numero_letra
    $('eletFechaEmision').value = l.fecha_emision || ''
    $('eletFechaVenc').value = l.fecha_vencimiento || ''
    $('eletMonto').value = l.monto
    $('eletObs').value = l.observaciones || ''
    $('elet-info').textContent = `Canjea la cuota ${cuota?.numero_cuota ?? '—'} — monto máximo: ${l.moneda || 'PEN'} ${formatNumber(maxMonto)}`
    const cobrada = l.estado === 'cobrada'
    $('elet-cobro').style.display = cobrada ? '' : 'none'
    $('elet-cobro-titulo').textContent = emitida ? 'Cobro de la letra' : 'Pago de la letra'
    if (cobrada) {
      $('eletBanco').innerHTML = '<option value="">-- Selecciona --</option>' + _bancos.map(b => `<option value="${b.id}">${_esc(b.nombre)} (${b.moneda || ''})</option>`).join('')
      $('eletBanco').value = l.banco_id || ''
      $('eletFechaCobro').value = mov?.fecha || ''
      $('eletNumOp').value = l.numero_operacion || ''
      $('eletTC').value = await _tcCancelLetra(l)
    }
    $('eletTCGroup').style.display = cobrada && (l.moneda || 'PEN') === 'USD' ? '' : 'none'
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
    if (nuevo.monto > _edicionLetra.maxMonto + 0.01) { showToast(`El monto supera el máximo de la cuota (${formatNumber(_edicionLetra.maxMonto)})`, 'warning'); return }

    const cobrada = l.estado === 'cobrada'
    const cobro = cobrada ? { bancoId: parseInt($('eletBanco').value || 0), fecha: $('eletFechaCobro').value, numOp: $('eletNumOp').value.trim() || null, tc: parseFloat($('eletTC').value) || parseFloat(l.tipo_cambio) || 1 } : null
    const tcCancelPrevio = cobrada ? parseFloat(await _tcCancelLetra(l)) || 0 : 0
    if (cobrada && (!cobro.bancoId || !cobro.fecha)) { showToast('Indica banco y fecha del cobro/pago', 'warning'); return }

    const delta = _r2(nuevo.monto - parseFloat(l.monto || 0))
    const cambioCanje = delta !== 0 || nuevo.numero_letra !== l.numero_letra || nuevo.fecha_emision !== l.fecha_emision
    const cambioCobro = cobrada && (cambioCanje
      || cobro.bancoId !== Number(l.banco_id) || cobro.fecha !== (_edicionLetra.mov?.fecha || '') || (cobro.numOp || null) !== (l.numero_operacion || null)
      || Math.abs(cobro.tc - tcCancelPrevio) > 1e-9)

    if ((cambioCanje || cambioCobro) && !confirm('Este cambio regenera los asientos de la letra' + (cambioCobro ? ' y su movimiento bancario' : '') + (delta ? ' y ajusta el canje de la cuota y del documento' : '') + '.\n\n¿Continuar?')) return

    // 1) Cobrada + cambio contable: deshacer el cobro/pago (mov. MB + saldo + asiento)
    if (cambioCobro) {
      const av = await _revertirCancelacionLetraCore(l)
      if (av.length) showToast('⚠️ ' + av.join('; '), 'warning')
    }
    // 2) Canje: ajustar cuota + documento y rehacer el asiento de canje
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
    // 3) Datos de la letra
    const upd = await updateLetraCambio(l.id, { ...nuevo, updated_at: new Date().toISOString() })
    if (!upd) throw new Error('No se pudo actualizar la letra (¿N° de letra duplicado?)')
    const lNueva = { ...l, ...nuevo }
    if (cambioCanje) {
      const as = await _asientoLetra('canje', lNueva, null)
      if (as?.id) await updateLetraCambio(l.id, { asiento_emision_id: as.id })
    }
    // 4) Rehacer el cobro/pago con los datos nuevos
    if (cambioCobro) await _aplicarCancelacionLetra(lNueva, cobro.bancoId, cobro.fecha, cobro.numOp, cobro.tc)

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
    for (const l of (_letrasCache || [])) {
      if (l.estado === 'anulada') continue
      const emitida = l.tipo === 'emitida'
      const c = emitida ? cxcMap[l.cxc_id] : cxpMap[l.cxp_id]; if (!c) continue
      const lado = emitida ? 'Por cobrar' : 'Por pagar'
      const m = parseFloat(l.monto || 0)
      push(lado, l.contact_id, l.moneda || c.moneda, l.fecha_emision, '7 · Canje a letra', _descDocCP(c), l.numero_letra, 0, m)
      push(lado, l.contact_id, l.moneda || c.moneda, l.fecha_emision, '8 · Letra', `Letra ${l.numero_letra}`, `Vence ${fechaDMY(l.fecha_vencimiento)} · ${l.estado}`, m, 0)
      if (l.estado === 'cobrada') push(lado, l.contact_id, l.moneda || c.moneda, String(l.updated_at || l.fecha_vencimiento).slice(0, 10),
        emitida ? '9 · Cobro de letra' : '9 · Pago de letra', `Letra ${l.numero_letra}`, l.numero_operacion, 0, m)
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
const _adjPendientes = { cobro: [], pago: [], ecp: [] }
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
    _adjPendientes[pref].push({ file: f, concepto: /recib/.test(n) ? 'recibo' : (/vouch|constan|transf|deposit/.test(n) ? 'voucher' : 'voucher') })
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

window.quitarAdjunto = async function (entidad, id, adjId) {
  if (!confirm('¿Quitar este archivo adjunto?')) return
  try {
    await eliminarAdjunto(adjId)
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

window._tcDefaultLetra = async function (l) {
  if ((l.moneda || 'PEN') !== 'USD') return
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
