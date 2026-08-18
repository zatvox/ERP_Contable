// ============================================================================
// COBRANZAS.JS — Cuentas por Cobrar / por Pagar, Cobros, Pagos, Retenciones
// ============================================================================
// Fase 2: menú por grupos, filtros avanzados en los listados, tab de Reportes
// con tablas dinámicas, tab de Configuración e integración con Bancos
// (cada cobro/pago genera opcionalmente su movimiento bancario y actualiza el
// saldo de la cuenta).
// ============================================================================

import { getCurrentUser } from './auth-supabase.js'
import {
  getCuentasCobrar, updateCuentaCobrar,
  getCuotasCobrar, updateCuotaCobrar, getAntiguedadCxC,
  getCuotasPagar, updateCuotaPagar,
  addTerminoPago, updateTerminoPago, deleteTerminoPago,
  addTerminoPagoCuota, deleteTerminoPagoCuota, getTerminosPagoCuotas,
  getCuentasPagar, updateCuentaPagar,
  getCobros, addCobro, updateCobro,
  getPagosProveedores, addPagoProveedor,
  getContacts,
  getBancos, updateBanco, addMovimientoBanco,
  getLetrasCambio, addLetraCambio, updateLetraCambio, deleteLetraCambio,
  getSuppliers, getCuentasGasto, addCompra, addCompraDetalle, addCuentaPagar,
  generarAsientoCobroCliente, generarAsientoPagoProveedor
} from './supabase-data.js'
import { showToast, formatNumber } from './helpers.js'
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
      if (nombre === 'terminos') renderTerminosPago()
      if (nombre === 'letras') window.cargarLetras()
      if (nombre === 'reportes') {
        const activo = document.querySelector('#cob-subtabs-reportes .subtab.active')?.getAttribute('data-sub') || 'rep-antiguedad-cxc'
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
}
function _saldoCxP(c) {
  return parseFloat(c.monto_total || 0)
       + parseFloat(c.monto_notas_debito || 0)
       - parseFloat(c.monto_notas_credito || 0)
       - parseFloat(c.monto_pagado || 0)
       - parseFloat(c.monto_canjeado || 0)
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
    await _cargarCuotas()
    const lista = _filtrarCxC().sort((a, b) => (a.fecha_vencimiento || 'zzzz').localeCompare(b.fecha_vencimiento || 'zzzz'))
    const hoy = new Date().toISOString().split('T')[0]

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
      const pendiente = total + notasDb - notasCr - cobrado - retenido
      const vencida   = cxc.estado !== 'cobrado' && cxc.fecha_vencimiento && cxc.fecha_vencimiento < hoy
      const dias      = cxc.fecha_vencimiento ? diasVencidos(cxc.fecha_vencimiento) : null
      tTotal += total; tCobrado += cobrado + retenido; tPend += pendiente

      const badge = cxc.estado === 'cobrado' ? 'badge-success'
                  : cxc.estado === 'parcial' ? 'badge-warning'
                  : vencida ? 'badge-danger' : 'badge-secondary'

      return `<tr ${vencida ? 'style="background:rgba(239,68,68,.06);"' : ''}>
        <td>${_esc(_nombreContacto(cxc.contact_id))}</td>
        <td>${_esc(`${cxc.tipo_comprobante || ''} ${cxc.serie || ''}-${cxc.numero_comprobante || ''}`)}${_htmlCuotas(cxc.id)}</td>
        <td>${cxc.fecha_emision || '-'}</td>
        <td>${cxc.fecha_vencimiento || '—'}</td>
        <td>${dias === null ? '—' : (dias > 0 ? `<span class="badge badge-vencido">+${dias}</span>` : `<span class="badge badge-alcorriente">${dias}</span>`)}</td>
        <td>${cxc.moneda || 'PEN'}</td>
        <td style="text-align:right;">${formatNumber(total)}</td>
        <td style="text-align:right;">${formatNumber(cobrado)}${retenido > 0 ? `<br><small style="color:var(--color-warning);">+ret. ${formatNumber(retenido)}</small>` : ''}${notasCr > 0 ? `<br><small style="color:var(--color-danger);">−NC ${formatNumber(notasCr)}</small>` : ''}${notasDb > 0 ? `<br><small style="color:var(--color-success);">+ND ${formatNumber(notasDb)}</small>` : ''}</td>
        <td style="text-align:right; font-weight:bold;">${formatNumber(pendiente)}</td>
        <td><span class="badge ${badge}">${cxc.estado}</span></td>
        <td>${cxc.estado !== 'cobrado' ? `<button class="btn btn-small btn-primary" onclick="window.irARegistrarCobro(${cxc.id})">Cobrar</button>` : ''}</td>
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

window.irARegistrarCobro = function(cxcId) {
  window.irATab('cobros')
  const sel = document.getElementById('cobroSelectCxC')
  if (sel) { sel.value = cxcId; window.onSelectCxC() }
}

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
    if (info) info.textContent = ''
    if (bloqueRet) bloqueRet.style.display = 'none'
    _cobroRetencionPendiente = 0
    return
  }

  const cxc = _cxcList.find(c => c.id === cxcId)
  if (!cxc) return
  const contacto  = _contactsMap[cxc.contact_id]
  const total     = parseFloat(cxc.monto_total || 0)
  const saldoTotal = Math.max(0, _saldoCxC(cxc))
  const moneda    = cxc.moneda || 'PEN'

  if (info) {
    const venc = cxc.fecha_vencimiento ? ` · Vence ${cxc.fecha_vencimiento}` : ''
    info.textContent = `Pendiente: ${moneda} ${formatNumber(saldoTotal)}${venc}`
  }

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
}

function _actualizarMontoCobroConRetencion(saldoTotal) {
  const montoInput = document.getElementById('cobroMonto')
  if (!montoInput) return
  const chkRet = document.getElementById('cobroAplicarRetencion')
  const aplica = chkRet && chkRet.checked && _cobroRetencionPendiente > 0
  montoInput.value = Math.max(0, aplica ? saldoTotal - _cobroRetencionPendiente : saldoTotal).toFixed(2)
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

async function _registrarMovimientoBancario({ bancoId, tipo, fecha, concepto, referencia, monto, categoria }) {
  if (!_cfg.autoMovBanco || !bancoId || !(monto > 0)) return
  try {
    const banco = _bancosMap[bancoId]
    const saldoPrevio = parseFloat(banco?.saldo_actual ?? banco?.saldo_inicial ?? 0)
    const saldoNuevo  = tipo === 'ingreso' ? saldoPrevio + monto : saldoPrevio - monto

    await addMovimientoBanco({
      banco_id: bancoId, fecha, tipo, concepto,
      categoria: categoria || (tipo === 'ingreso' ? 'Cobranza clientes' : 'Pago proveedores'),
      referencia: referencia || null,
      monto,
      saldo_posterior: parseFloat(saldoNuevo.toFixed(2)),
      reconciliado: !!_cfg.autoConciliar
    })
    await updateBanco(bancoId, { saldo_actual: parseFloat(saldoNuevo.toFixed(2)) })
    if (banco) banco.saldo_actual = parseFloat(saldoNuevo.toFixed(2))
    invalidarVarios(['bancos', 'movimientos_banco'])
  } catch (e) {
    console.warn('Movimiento bancario no registrado:', e.message)
    showToast('⚠️ El movimiento bancario no se registró: ' + e.message, 'warning')
  }
}

// ============================================================================
// REGISTRAR COBRO
// ============================================================================

window.registrarCobro = async function() {
  const btnTexto = '✅ Registrar Cobro y Generar Asiento'
  try {
    const user       = getCurrentUser()
    const cxcId      = parseInt(document.getElementById('cobroSelectCxC')?.value || 0)
    const fecha      = document.getElementById('cobroFecha')?.value
    const monto      = parseFloat(document.getElementById('cobroMonto')?.value || 0)
    const medioPago  = document.getElementById('cobroMedioPago')?.value
    const bancoId    = document.getElementById('cobroBanco')?.value
    const referencia = document.getElementById('cobroReferencia')?.value?.trim()
    const tipoCambio = parseFloat(document.getElementById('cobroTipoCambio')?.value || 1)

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

    const cobro = await addCobro({
      cxc_id: cxcId, contact_id: cxc.contact_id, fecha, monto,
      moneda: cxc.moneda || 'PEN', tipo_cambio: tipoCambio,
      medio_pago: medioPago, referencia: referencia || null,
      banco_id: bancoId ? parseInt(bancoId) : null,
      numero_operacion: referencia || null,
      monto_retencion: montoRetencion
    })

    if (cobro?.id) {
      const descripcion = `Cobro ${cxc.tipo_comprobante || ''} ${cxc.serie || ''}-${cxc.numero_comprobante || ''}`
      try {
        await generarAsientoCobroCliente({
          cobroId: cobro.id, monto, cxcId,
          bancoId: bancoId ? parseInt(bancoId) : null,
          medioPago, fecha, descripcion, userId: user?.id
        })
      } catch (eAsiento) {
        console.warn('Cobro insertado pero asiento falló:', eAsiento.message)
        showToast('Cobro registrado ⚠️ Asiento no generado: ' + eAsiento.message, 'warning')
      }

      await _registrarMovimientoBancario({
        bancoId: bancoId ? parseInt(bancoId) : null,
        tipo: 'ingreso', fecha,
        concepto: `${descripcion} — ${_nombreContacto(cxc.contact_id)}`,
        referencia, monto
      })

      const nuevoCobrado  = parseFloat((parseFloat(cxc.monto_cobrado || 0) + monto).toFixed(2))
      const nuevoRetenido = parseFloat((parseFloat(cxc.monto_retenido || 0) + montoRetencion).toFixed(2))
      const total = parseFloat(cxc.monto_total || 0)
        + parseFloat(cxc.monto_notas_debito || 0) - parseFloat(cxc.monto_notas_credito || 0)
      const aplicado = nuevoCobrado + nuevoRetenido + parseFloat(cxc.monto_canjeado || 0)
      const nuevoEstado = aplicado >= total - 0.01
        ? 'cobrado'
        : (aplicado > 0 ? 'parcial' : 'pendiente')
      await updateCuentaCobrar(cxcId, { monto_cobrado: nuevoCobrado, monto_retenido: nuevoRetenido, estado: nuevoEstado })

      // Imputación a cuotas: el cobro se reparte de la cuota más antigua a la
      // más reciente. Sin esto, un 30/70 con la primera cuota pagada seguiría
      // mostrando ambas como pendientes y la antigüedad seguiría mal.
      await _cargarCuotas(true)
      var _imputacion = await _imputarACuotas(cxcId, monto, montoRetencion)
    }

    const detalleCuotas = _describirImputacion(typeof _imputacion !== 'undefined' ? _imputacion.aplicaciones : [])
    showToast(montoRetencion > 0
      ? `Cobro registrado ✅${detalleCuotas} — incluye S/ ${formatNumber(montoRetencion)} de retención IGV`
      : `Cobro registrado ✅${detalleCuotas}`, 'success')

    document.getElementById('cobroSelectCxC').value  = ''
    document.getElementById('cobroMonto').value      = ''
    document.getElementById('cobroReferencia').value = ''
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
    window.filtrarCobrosRecientes()
  } catch (e) { console.error('cargarCobrosRecientes:', e) }
}

window.filtrarCobrosRecientes = function() {
  const tbody = document.getElementById('tbody-cobros-recientes')
  if (!tbody) return
  const q = (document.getElementById('buscarCobro')?.value || '').toLowerCase().trim()

  let lista = [..._cobrosList].sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || b.id - a.id)
  if (q) lista = lista.filter(c => `${_nombreContacto(c.contact_id)} ${c.referencia || ''} ${c.medio_pago || ''}`.toLowerCase().includes(q))
  lista = lista.slice(0, 50)

  if (lista.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;">Sin cobros registrados</td></tr>'
    return
  }

  tbody.innerHTML = lista.map(c => `<tr>
    <td>${c.fecha || '-'}</td>
    <td>${_esc(_nombreContacto(c.contact_id))}</td>
    <td style="text-align:right; font-weight:bold;">${formatNumber(c.monto)}</td>
    <td style="text-align:right; color:var(--color-warning);">${parseFloat(c.monto_retencion || 0) > 0 ? formatNumber(c.monto_retencion) : '—'}</td>
    <td>${c.medio_pago || '-'}</td>
    <td>${_esc(_bancosMap[c.banco_id]?.nombre || '—')}</td>
    <td>${_esc(c.referencia || '-')}</td>
    <td>${c.asiento_id ? `AS-${String(c.asiento_id).padStart(6, '0')}` : '—'}</td>
    <td></td>
  </tr>`).join('')
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
      const pend   = total + nDb - nCr - pagado
      const dias   = cxp.fecha_vencimiento ? diasVencidos(cxp.fecha_vencimiento) : null
      tTotal += total; tPagado += pagado; tPend += pend

      const badge = cxp.estado === 'pagado' ? 'badge-success'
                  : cxp.estado === 'parcial' ? 'badge-warning' : 'badge-secondary'

      return `<tr>
        <td>${_esc(_nombreContacto(cxp.contact_id))}</td>
        <td>${_esc(`${cxp.tipo_comprobante || ''} ${cxp.serie || ''}-${cxp.numero_comprobante || ''}`)}</td>
        <td>${cxp.fecha_emision || '-'}</td>
        <td>${cxp.fecha_vencimiento || '—'}</td>
        <td>${dias === null ? '—' : (dias > 0 ? `<span class="badge badge-vencido">+${dias}</span>` : `<span class="badge badge-alcorriente">${dias}</span>`)}</td>
        <td>${cxp.moneda || 'PEN'}</td>
        <td style="text-align:right;">${formatNumber(total)}</td>
        <td style="text-align:right;">${formatNumber(pagado)}${nCr > 0 ? `<br><small style="color:var(--color-danger);">−NC ${formatNumber(nCr)}</small>` : ''}${nDb > 0 ? `<br><small style="color:var(--color-success);">+ND ${formatNumber(nDb)}</small>` : ''}</td>
        <td style="text-align:right; font-weight:bold;">${formatNumber(pend)}</td>
        <td><span class="badge ${badge}">${cxp.estado || 'pendiente'}</span></td>
        <td>${cxp.estado !== 'pagado' ? `<button class="btn btn-small btn-primary" onclick="window.irARegistrarPago(${cxp.id})">Pagar</button>` : ''}</td>
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

window.irARegistrarPago = function(cxpId) {
  window.irATab('pagos-prov')
  const sel = document.getElementById('pagoSelectCompra')
  if (sel) { sel.value = cxpId; window.onSelectCompra() }
}

window.onSelectCompra = function() {
  const sel  = document.getElementById('pagoSelectCompra')
  const opt  = sel?.selectedOptions[0]
  const info = document.getElementById('pago-compra-info')
  if (!opt || !opt.value) { if (info) info.textContent = ''; return }

  const pendiente = opt.getAttribute('data-pendiente')
  const moneda    = opt.getAttribute('data-moneda') || 'PEN'
  if (info) info.textContent = `Saldo pendiente: ${moneda} ${formatNumber(pendiente)}`

  const montoInput = document.getElementById('pagoMonto')
  if (montoInput) montoInput.value = pendiente
  const monedaSelect = document.getElementById('pagoMoneda')
  if (monedaSelect) monedaSelect.value = moneda
}

// ============================================================================
// REGISTRAR PAGO A PROVEEDOR
// ============================================================================

window.registrarPagoProveedor = async function() {
  try {
    const user       = getCurrentUser()
    const cxpId      = parseInt(document.getElementById('pagoSelectCompra')?.value || 0)
    const fecha      = document.getElementById('pagoFecha')?.value
    const monto      = parseFloat(document.getElementById('pagoMonto')?.value || 0)
    const moneda     = document.getElementById('pagoMoneda')?.value || 'PEN'
    const tipoCambio = parseFloat(document.getElementById('pagoTipoCambio')?.value || 1)
    const medioPago  = document.getElementById('pagoMedioPago')?.value
    const bancoId    = document.getElementById('pagoBanco')?.value
    const referencia = document.getElementById('pagoReferencia')?.value?.trim()

    if (!cxpId)     { showToast('Selecciona una Cuenta por Pagar', 'warning'); return }
    if (!fecha)     { showToast('Ingresa la fecha del pago', 'warning'); return }
    if (monto <= 0) { showToast('El monto debe ser mayor a 0', 'warning'); return }

    const cxp = _cxpList.find(c => c.id === cxpId)
    if (!cxp) { showToast('Cuenta por Pagar no encontrada', 'danger'); return }

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
      const descripcion = `Pago proveedor ${cxp.tipo_comprobante || ''} ${cxp.serie || ''}-${cxp.numero_comprobante || ''}`
      try {
        await generarAsientoPagoProveedor({
          pagoId: pago.id, monto, compraId: cxp.compra_id,
          bancoId: bancoId ? parseInt(bancoId) : null,
          moneda, fecha, descripcion, userId: user?.id
        })
      } catch (eAsiento) {
        console.warn('Pago insertado pero asiento falló:', eAsiento.message)
        showToast('Pago registrado ⚠️ Asiento no generado: ' + eAsiento.message, 'warning')
      }

      await _registrarMovimientoBancario({
        bancoId: bancoId ? parseInt(bancoId) : null,
        tipo: 'egreso', fecha,
        concepto: `${descripcion} — ${_nombreContacto(cxp.contact_id)}`,
        referencia, monto
      })

      const nuevoPagado = parseFloat((parseFloat(cxp.monto_pagado || 0) + monto).toFixed(2))
      const nuevoEstado = nuevoPagado >= parseFloat(cxp.monto_total || 0) - 0.01
        ? 'pagado' : (nuevoPagado > 0 ? 'parcial' : 'pendiente')
      await updateCuentaPagar(cxpId, { monto_pagado: nuevoPagado, estado: nuevoEstado })
    }

    showToast('Pago a proveedor registrado ✅', 'success')

    document.getElementById('pagoSelectCompra').value = ''
    document.getElementById('pagoMonto').value        = ''
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
    <td>${p.fecha || '-'}</td>
    <td>${_esc(_nombreContacto(p.contact_id))}</td>
    <td style="text-align:right; font-weight:bold;">${formatNumber(p.monto)}</td>
    <td>${p.moneda || 'PEN'}</td>
    <td>${p.medio_pago || '-'}</td>
    <td>${_esc(_bancosMap[p.banco_id]?.nombre || '—')}</td>
    <td>${_esc(p.referencia || '-')}</td>
    <td></td>
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
        <td>${c.fecha || '-'}</td>
        <td>${_esc(_nombreContacto(c.contact_id))}</td>
        <td>${_esc(comprobante)}</td>
        <td style="text-align:right; font-weight:bold;">${formatNumber(monto)}</td>
        <td><input type="text" id="ret-comp-${c.id}" value="${_esc(c.numero_comprobante_retencion || '')}" placeholder="Ej: R001-00001" style="width:150px;"></td>
        <td><button class="btn btn-small btn-secondary" onclick="window.guardarComprobanteRetencion(${c.id})">Guardar N°</button></td>
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
        { key: 'mes', label: 'Mes emisión' }
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
        { key: 'mes', label: 'Mes emisión' }
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
        { key: 'mes', label: 'Mes' }, { key: 'cliente', label: 'Cliente' },
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
        { key: 'mes', label: 'Mes' }, { key: 'proveedor', label: 'Proveedor' },
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
        { key: 'mes', label: 'Mes' }, { key: 'cliente', label: 'Cliente' },
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
    return `<span class="badge badge-cuota" style="color:${color};" title="${q.hito ? _esc(q.hito) + ' — ' : ''}vence ${q.fecha_vencimiento}">
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
        { key: 'mes_venc', label: 'Mes de vencimiento' },
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
                <button class="btn btn-small btn-secondary" onclick="window.abrirModalTerminoPago(${t.id})">Editar</button>
                <button class="btn btn-small btn-danger" onclick="window.eliminarTerminoPago(${t.id})">✕</button>
              </td>
            </tr>`
          }).join('')}
        </tbody>
      </table>`
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
        <td>${l.fecha_emision || '-'}</td>
        <td>${l.fecha_vencimiento || '-'}</td>
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
  if (l.estado === 'cartera') {
    return `<button class="btn btn-small btn-secondary" onclick="window.abrirModalLetraBanco(${l.id})">A banco</button>
            <button class="btn btn-small btn-primary" onclick="window.cambiarEstadoLetra(${l.id},'cobrada')">Cobrada</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarLetra(${l.id})">✕</button>`
  }
  if (l.estado === 'banco' || l.estado === 'cobranza') {
    return `<button class="btn btn-small btn-primary" onclick="window.cambiarEstadoLetra(${l.id},'cobrada')">Cobrada</button>
            <button class="btn btn-small btn-danger" onclick="window.cambiarEstadoLetra(${l.id},'protestada')">Protestar</button>`
  }
  return '' // cobrada / protestada / refinanciada / anulada: histórico, sin acciones
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

    showToast(`Letra ${numero} registrada ✅`, 'success')
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
  if (letra.estado === 'cobrada') {
    showToast('No se puede eliminar una letra ya cobrada.', 'warning')
    return
  }
  if (!confirm(`¿Eliminar la letra ${letra.numero_letra}?\n\nEsto libera de vuelta el monto canjeado al saldo de la cuota.`)) return

  try {
    await deleteLetraCambio(id)

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

    showToast(`Letra ${letra.numero_letra} eliminada`, 'success')
    _refrescarTodo()
    await window.cargarLetras()
  } catch (e) {
    showToast('Error: ' + e.message, 'danger')
  }
}
