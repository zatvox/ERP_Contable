// ============================================================================
// DASHBOARD-INIT.JS — Panel gerencial con dos vistas y filtros
// ============================================================================
//   Vista 1 (por defecto): Financiero / Contable — liquidez, cobranza, IGV.
//   Vista 2:               Ventas / Inventario  — comercial y operativo.
//
// Todo se calcula en el navegador sobre datasets ya cacheados (data-cache.js),
// así que cambiar el período o la moneda es instantáneo y no vuelve a
// consultar Supabase. Cada tarjeta y cada botón "Ver detalle →" navega al
// módulo y tab correspondiente vía ?tab=..., que cada módulo lee al arrancar.
// ============================================================================

import { getCurrentUser } from './auth-supabase.js'
import {
  getVentas, getCompras, getContacts, getItems, getLotes,
  getCuentasCobrar, getCuentasPagar, getCobros, getPagosProveedores,
  getBancos, getDetalleVentas
} from './supabase-data.js'
import { showToast, formatNumber } from './helpers.js'
import { initModuleNavDropdowns } from './main.js'
import { getModuloConfig, renderConfiguracionTab, aplicarPreferenciasVista } from './config-modulo.js'
import { cacheado, invalidarTodo } from './data-cache.js'
import { nombreMes, diasVencidos, tramoAntiguedad } from './reportes.js'
import { estaAnulado } from './anulacion.js'
import { signoDocumento, esNota } from './notas.js'

const MODULO = 'dashboard'
let _cfg = getModuloConfig(MODULO)

const D = {
  ventas: [], compras: [], contactos: [], items: [], lotes: [],
  cxc: [], cxp: [], cobros: [], pagos: [], bancos: [], detalleVentas: []
}
let _contactoMap = {}
let _itemMap = {}
let _timerAuto = null

// ============================================================================
// INIT
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  try {
    aplicarPreferenciasVista(MODULO)
    _cfg = getModuloConfig(MODULO)

    const user = getCurrentUser()
    const ud = document.getElementById('userDisplay')
    if (ud && user) ud.textContent = user.nombre || user.email

    initTabs()
    initModuleNavDropdowns('#dashTabs')

    // Vista y período por defecto vienen de Configuración.
    _valor('dashPeriodo', _cfg.periodo || 'mes')
    if ((_cfg.vista || 'financiero') === 'comercial') {
      document.querySelector('#dashTabs .tab-btn[data-tab="comercial"]')?.click()
    }

    renderConfiguracionTab(MODULO, 'dash-config-container', {
      onGuardar: () => { _cfg = getModuloConfig(MODULO); programarAutoRefresco(); showToast('Configuración guardada ✅', 'success') }
    })

    await cargarDatos()
    window.refrescarDashboard()
    programarAutoRefresco()
  } catch (e) {
    console.error('dashboard DOMContentLoaded:', e)
    showToast('Error al cargar el dashboard: ' + e.message, 'danger')
  }
})

function initTabs() {
  const btns     = document.querySelectorAll('#dashTabs .tab-btn')
  const contents = document.querySelectorAll('.tab-content')
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      btns.forEach(b => b.classList.remove('active'))
      contents.forEach(c => c.classList.remove('active'))
      btn.classList.add('active')
      document.getElementById(`tab-${btn.getAttribute('data-tab')}`)?.classList.add('active')
    })
  })
}

function programarAutoRefresco() {
  if (_timerAuto) clearInterval(_timerAuto)
  const min = parseInt(_cfg.autoRefrescar) || 0
  if (min > 0) _timerAuto = setInterval(() => window.recargarDashboard(true), min * 60000)
}

async function cargarDatos() {
  const [ventas, compras, contactos, items, lotes, cxc, cxp, cobros, pagos, bancos, detalleVentas] = await Promise.all([
    cacheado('ventas', getVentas),
    cacheado('compras', getCompras),
    cacheado('contactos', getContacts),
    cacheado('items', getItems),
    cacheado('lotes', getLotes),
    cacheado('cuentas_cobrar', getCuentasCobrar),
    cacheado('cuentas_pagar', getCuentasPagar),
    cacheado('cobros', getCobros),
    cacheado('pagos_proveedores', getPagosProveedores),
    cacheado('bancos', getBancos),
    cacheado('detalle_ventas', getDetalleVentas)
  ])
  Object.assign(D, { ventas, compras, contactos, items, lotes, cxc, cxp, cobros, pagos, bancos, detalleVentas })

  _contactoMap = {}; (contactos || []).forEach(c => { _contactoMap[c.id] = c })
  _itemMap = {};     (items || []).forEach(i => { _itemMap[i.id] = i })

  _set('dash-ultima-act', `Datos actualizados: ${new Date().toLocaleString('es-PE')}`)
}

window.recargarDashboard = async function(silencioso) {
  try {
    invalidarTodo()
    await cargarDatos()
    window.refrescarDashboard()
    if (!silencioso) showToast('Dashboard actualizado ✅', 'success')
  } catch (e) {
    showToast('Error al recargar: ' + e.message, 'danger')
  }
}

// ============================================================================
// PERÍODO
// ============================================================================

window.onCambiarPeriodoDash = function() {
  const p = document.getElementById('dashPeriodo')?.value
  const caja = document.getElementById('dash-rango-personalizado')
  if (caja) caja.style.display = p === 'personalizado' ? '' : 'none'
  window.refrescarDashboard()
}

function rangoPeriodo() {
  const p = document.getElementById('dashPeriodo')?.value || 'mes'
  const hoy = new Date()
  const iso = (d) => d.toISOString().slice(0, 10)
  const primerDia = (y, m) => iso(new Date(Date.UTC(y, m, 1)))
  const ultimoDia = (y, m) => iso(new Date(Date.UTC(y, m + 1, 0)))
  const y = hoy.getUTCFullYear(), m = hoy.getUTCMonth()

  switch (p) {
    case 'mes':          return { desde: primerDia(y, m), hasta: ultimoDia(y, m), etiqueta: 'Mes actual' }
    case 'mes_anterior': return { desde: primerDia(y, m - 1), hasta: ultimoDia(y, m - 1), etiqueta: 'Mes anterior' }
    case 'trimestre':    return { desde: primerDia(y, m - 2), hasta: ultimoDia(y, m), etiqueta: 'Últimos 3 meses' }
    case 'anio':         return { desde: primerDia(y, 0), hasta: ultimoDia(y, 11), etiqueta: `Año ${y}` }
    case '12m':          return { desde: primerDia(y, m - 11), hasta: ultimoDia(y, m), etiqueta: 'Últimos 12 meses' }
    case 'todo':         return { desde: '0000-01-01', hasta: '9999-12-31', etiqueta: 'Todo el historial' }
    case 'personalizado':
      return {
        desde: document.getElementById('dashDesde')?.value || '0000-01-01',
        hasta: document.getElementById('dashHasta')?.value || '9999-12-31',
        etiqueta: 'Rango personalizado'
      }
    default: return { desde: primerDia(y, m), hasta: ultimoDia(y, m), etiqueta: 'Mes actual' }
  }
}

function monedaFiltro() { return document.getElementById('dashMoneda')?.value || '' }

function enRango(fecha, r) {
  const f = String(fecha || '')
  return f >= r.desde && f <= r.hasta
}

function coincideMoneda(m) {
  const f = monedaFiltro()
  return !f || (m || 'PEN') === f
}

// ============================================================================
// REFRESCO PRINCIPAL
// ============================================================================

window.refrescarDashboard = function() {
  const r = rangoPeriodo()
  _set('dash-rango-texto', r.desde === '0000-01-01' && r.hasta === '9999-12-31'
    ? `${r.etiqueta}`
    : `${r.etiqueta}: ${r.desde} → ${r.hasta}`)
  try {
    pintarFinanciero(r)
    pintarComercial(r)
  } catch (e) {
    console.error('refrescarDashboard:', e)
    showToast('Error al calcular indicadores: ' + e.message, 'danger')
  }
}

// ============================================================================
// VISTA FINANCIERO / CONTABLE
// ============================================================================

// Misma fórmula que en Cobranzas: las notas de crédito/débito ajustan el
// importe exigible sin mover dinero, así que forman parte del saldo.
function _saldoCxC(c) {
  return parseFloat(c.monto_total || 0) + parseFloat(c.monto_notas_debito || 0)
       - parseFloat(c.monto_notas_credito || 0) - parseFloat(c.monto_cobrado || 0)
       - parseFloat(c.monto_retenido || 0)
}
function _saldoCxP(c) {
  return parseFloat(c.monto_total || 0) + parseFloat(c.monto_notas_debito || 0)
       - parseFloat(c.monto_notas_credito || 0) - parseFloat(c.monto_pagado || 0)
}

function pintarFinanciero(r) {
  const hoy = new Date().toISOString().slice(0, 10)

  // --- CxC / CxP abiertas (no dependen del rango: son saldos "a hoy")
  const cxcAbiertas = D.cxc.filter(c => c.estado !== 'cobrado' && c.estado !== 'anulado' && coincideMoneda(c.moneda) && _saldoCxC(c) > 0.01)
  const cxpAbiertas = D.cxp.filter(c => c.estado !== 'pagado' && c.estado !== 'anulado' && coincideMoneda(c.moneda) && _saldoCxP(c) > 0.01)

  const totalCxC = cxcAbiertas.reduce((s, c) => s + _saldoCxC(c), 0)
  const totalCxP = cxpAbiertas.reduce((s, c) => s + _saldoCxP(c), 0)
  const vencCxC  = cxcAbiertas.filter(c => c.fecha_vencimiento && c.fecha_vencimiento < hoy).reduce((s, c) => s + _saldoCxC(c), 0)
  const vencCxP  = cxpAbiertas.filter(c => c.fecha_vencimiento && c.fecha_vencimiento < hoy).reduce((s, c) => s + _saldoCxP(c), 0)

  _set('f-kpi-cxc', `S/ ${formatNumber(totalCxC)}`)
  _set('f-kpi-cxc-sub', `${cxcAbiertas.length} doc. · vencido S/ ${formatNumber(vencCxC)}`)
  _set('f-kpi-cxp', `S/ ${formatNumber(totalCxP)}`)
  _set('f-kpi-cxp-sub', `${cxpAbiertas.length} doc. · vencido S/ ${formatNumber(vencCxP)}`)

  // --- Bancos
  const bancos = D.bancos.filter(b => coincideMoneda(b.moneda))
  const disponible = bancos.reduce((s, b) => s + parseFloat(b.saldo_actual ?? b.saldo_inicial ?? 0), 0)
  _set('f-kpi-bancos', `S/ ${formatNumber(disponible)}`)
  _set('f-kpi-bancos-sub', `${bancos.length} cuenta(s)`)

  const posicion = disponible + totalCxC - totalCxP
  const elPos = document.getElementById('f-kpi-posicion')
  if (elPos) {
    elPos.textContent = `S/ ${formatNumber(posicion)}`
    elPos.style.color = posicion >= 0 ? 'var(--color-success)' : 'var(--color-danger)'
  }

  // --- Cobros / pagos del período
  const cobrosP = D.cobros.filter(c => enRango(c.fecha, r) && coincideMoneda(c.moneda))
  const pagosP  = D.pagos.filter(p => enRango(p.fecha, r) && coincideMoneda(p.moneda))
  const totCobrado = cobrosP.reduce((s, c) => s + parseFloat(c.monto || 0), 0)
  const totRetenido = cobrosP.reduce((s, c) => s + parseFloat(c.monto_retencion || 0), 0)
  const totPagado  = pagosP.reduce((s, p) => s + parseFloat(p.monto || 0), 0)

  _set('f-kpi-cobrado', `S/ ${formatNumber(totCobrado)}`)
  _set('f-kpi-cobrado-sub', `${cobrosP.length} cobro(s)${totRetenido > 0 ? ` · ret. S/ ${formatNumber(totRetenido)}` : ''}`)
  _set('f-kpi-pagado', `S/ ${formatNumber(totPagado)}`)
  _set('f-kpi-pagado-sub', `${pagosP.length} pago(s)`)

  // --- IGV estimado: débito de ventas menos crédito de compras del período.
  // Los comprobantes anulados no generan ni débito ni crédito fiscal.
  const ventasP  = D.ventas.filter(v => enRango(v.fecha_emision, r) && coincideMoneda(v.moneda) && !estaAnulado(v))
  const comprasP = D.compras.filter(c => enRango(c.fecha_emision, r) && coincideMoneda(c.currency || c.moneda) && !estaAnulado(c))
  // Las notas de crédito restan del débito/crédito fiscal del periodo.
  const igvVentas  = ventasP.reduce((s, v) => s + (parseFloat(v.igv || 0) || 0) * signoDocumento(v.tipo_comprobante), 0)
  const igvCompras = comprasP.reduce((s, c) => s + (parseFloat(c.igv_gravado || c.igv || 0) || 0) * signoDocumento(c.tipo_comprobante), 0)
  const igvNeto = igvVentas - igvCompras
  const elIgv = document.getElementById('f-kpi-igv')
  if (elIgv) {
    elIgv.textContent = `S/ ${formatNumber(igvNeto)}`
    elIgv.style.color = igvNeto > 0 ? 'var(--color-warning)' : 'var(--color-success)'
  }
  _set('f-kpi-igv-sub', `Débito ${formatNumber(igvVentas)} − Crédito ${formatNumber(igvCompras)}`)

  // --- Retenciones sin comprobante
  const retSin = D.cobros.filter(c => (parseFloat(c.monto_retencion) || 0) > 0 && !c.numero_comprobante_retencion)
  _set('f-kpi-retenciones', `S/ ${formatNumber(retSin.reduce((s, c) => s + parseFloat(c.monto_retencion || 0), 0))}`)
  _set('f-kpi-retenciones-sub', `${retSin.length} cobro(s) sin N° de comprobante`)

  // --- Antigüedad
  const tramos = {}
  cxcAbiertas.forEach(c => {
    const t = tramoAntiguedad(c.fecha_vencimiento ? diasVencidos(c.fecha_vencimiento) : 0)
    tramos[t] = (tramos[t] || 0) + _saldoCxC(c)
  })
  _html('f-aging', _barras(Object.entries(tramos).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => ({ label: k, valor: v })), 'Sin cuentas por cobrar abiertas.'))

  // --- Flujo cobros vs pagos por mes (últimos 6 meses del rango)
  const porMes = {}
  D.cobros.filter(c => enRango(c.fecha, r)).forEach(c => {
    const k = (c.fecha || '').slice(0, 7); if (!k) return
    porMes[k] = porMes[k] || { cobros: 0, pagos: 0 }
    porMes[k].cobros += parseFloat(c.monto || 0)
  })
  D.pagos.filter(p => enRango(p.fecha, r)).forEach(p => {
    const k = (p.fecha || '').slice(0, 7); if (!k) return
    porMes[k] = porMes[k] || { cobros: 0, pagos: 0 }
    porMes[k].pagos += parseFloat(p.monto || 0)
  })
  _html('f-flujo', _barrasDobles(
    Object.entries(porMes).sort().slice(-6).map(([k, v]) => ({ label: nombreMes(k), a: v.cobros, b: v.pagos })),
    'Cobros', 'Pagos', 'Sin cobros ni pagos en el período.'))

  // --- Top deudores
  const deuda = {}
  cxcAbiertas.forEach(c => {
    const n = _nombre(c.contact_id)
    deuda[n] = (deuda[n] || 0) + _saldoCxC(c)
  })
  _html('f-top-deudores', _tabla(
    ['Cliente', 'Saldo'],
    Object.entries(deuda).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([n, v]) => [_esc(n), `<span style="font-weight:600;">${formatNumber(v)}</span>`]),
    'Sin deudores pendientes ✅'))

  // --- Próximos vencimientos
  const en30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
  const prox = cxcAbiertas
    .filter(c => c.fecha_vencimiento && c.fecha_vencimiento >= hoy && c.fecha_vencimiento <= en30)
    .sort((a, b) => a.fecha_vencimiento.localeCompare(b.fecha_vencimiento)).slice(0, 8)
  _html('f-vencimientos', _tabla(
    ['Vence', 'Cliente', 'Saldo'],
    prox.map(c => [c.fecha_vencimiento, _esc(_nombre(c.contact_id)), formatNumber(_saldoCxC(c))]),
    'Sin vencimientos en los próximos 30 días.'))

  // --- Alertas
  const alertas = []
  if (vencCxC > 0) alertas.push({ t: 'danger', txt: `S/ ${formatNumber(vencCxC)} en cuentas por cobrar ya vencidas`, href: 'cobranzas.html', tab: 'cxc' })
  if (vencCxP > 0) alertas.push({ t: 'warning', txt: `S/ ${formatNumber(vencCxP)} en cuentas por pagar vencidas`, href: 'cobranzas.html', tab: 'cxp' })
  if (retSin.length > 0) alertas.push({ t: 'info', txt: `${retSin.length} retención(es) sin comprobante que sustente la deducción del IGV`, href: 'cobranzas.html', tab: 'retenciones' })

  const sinVenc = D.cxc.filter(c => c.estado !== 'cobrado' && !c.fecha_vencimiento).length
  if (sinVenc > 0) alertas.push({ t: 'warning', txt: `${sinVenc} cuenta(s) por cobrar sin fecha de vencimiento — no aparecen en el flujo proyectado`, href: 'cobranzas.html', tab: 'cxc' })

  const bancosNeg = D.bancos.filter(b => parseFloat(b.saldo_actual ?? b.saldo_inicial ?? 0) < 0)
  if (bancosNeg.length > 0) alertas.push({ t: 'danger', txt: `${bancosNeg.length} cuenta(s) bancaria(s) en saldo negativo`, href: 'bancos.html', tab: 'cuentas-banco' })

  _html('f-alertas', alertas.length === 0
    ? '<p style="color:var(--color-success); padding:8px 0;">✅ Todo en orden: sin vencidos, sin saldos negativos y sin retenciones pendientes de sustento.</p>'
    : alertas.map(a => `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; padding:9px 0; border-bottom:1px solid var(--border-color);">
          <span><span class="badge badge-${a.t}">${a.t === 'danger' ? 'Urgente' : a.t === 'warning' ? 'Atención' : 'Aviso'}</span> ${a.txt}</span>
          <button class="btn btn-small btn-secondary" onclick="window.irA('${a.href}','${a.tab}')">Ir →</button>
        </div>`).join(''))
}

// ============================================================================
// VISTA COMERCIAL / INVENTARIO
// ============================================================================

function pintarComercial(r) {
  const ventasP  = D.ventas.filter(v => enRango(v.fecha_emision, r) && coincideMoneda(v.moneda) && !estaAnulado(v))
  const comprasP = D.compras.filter(c => enRango(c.fecha_emision, r) && coincideMoneda(c.currency || c.moneda) && !estaAnulado(c))

  // Venta y compra NETAS: las notas de crédito se restan.
  const totVentas  = ventasP.reduce((s, v) => s + parseFloat(v.total || 0) * signoDocumento(v.tipo_comprobante), 0)
  const totCompras = comprasP.reduce((s, c) => s + parseFloat(c.total || 0) * signoDocumento(c.tipo_comprobante), 0)

  // Comparativo con el período anterior de igual longitud.
  const dias = Math.max(1, Math.round((new Date(r.hasta) - new Date(r.desde)) / 86400000) + 1)
  const rPrev = {
    desde: new Date(new Date(r.desde).getTime() - dias * 86400000).toISOString().slice(0, 10),
    hasta: new Date(new Date(r.desde).getTime() - 86400000).toISOString().slice(0, 10)
  }
  const ventasPrev = D.ventas.filter(v => enRango(v.fecha_emision, rPrev) && !estaAnulado(v))
    .reduce((s, v) => s + parseFloat(v.total || 0) * signoDocumento(v.tipo_comprobante), 0)
  const variacion = ventasPrev > 0 ? ((totVentas - ventasPrev) / ventasPrev * 100) : null

  _set('c-kpi-ventas', `S/ ${formatNumber(totVentas)}`)
  _set('c-kpi-ventas-sub', `${ventasP.length} comprobante(s)` +
    (variacion === null ? '' : ` · ${variacion >= 0 ? '▲' : '▼'} ${formatNumber(Math.abs(variacion), 1)}% vs período anterior`))
  _set('c-kpi-compras', `S/ ${formatNumber(totCompras)}`)
  _set('c-kpi-compras-sub', `${comprasP.length} documento(s)`)

  // Valor del inventario: cantidad × costo unitario de cada lote.
  const valorInv = D.lotes.reduce((s, l) => s + (parseFloat(l.cantidad) || 0) * (parseFloat(l.costo_unitario) || 0), 0)
  const lotesConStock = D.lotes.filter(l => (parseFloat(l.cantidad) || 0) > 0)
  _set('c-kpi-inventario', `S/ ${formatNumber(valorInv)}`)
  _set('c-kpi-inventario-sub', `${lotesConStock.length} lote(s) con stock`)

  // Pendiente de despacho
  const pendientes = D.ventas.filter(v => !estaAnulado(v) && !esNota(v.tipo_comprobante) && v.estado_despacho && v.estado_despacho !== 'despachado')
  _set('c-kpi-despacho', String(pendientes.length))
  _set('c-kpi-despacho-sub', `S/ ${formatNumber(pendientes.reduce((s, v) => s + parseFloat(v.total || 0), 0))} en ventas`)

  // Ventas por mes
  const vMes = {}
  ventasP.forEach(v => {
    const k = (v.fecha_emision || '').slice(0, 7); if (!k) return
    vMes[k] = (vMes[k] || 0) + parseFloat(v.total || 0) * signoDocumento(v.tipo_comprobante)
  })
  _html('c-ventas-mes', _barras(
    Object.entries(vMes).sort().slice(-12).map(([k, v]) => ({ label: nombreMes(k), valor: v })),
    'Sin ventas en el período seleccionado.'))

  // Compras vs Ventas
  const cvMes = {}
  ventasP.forEach(v => {
    const k = (v.fecha_emision || '').slice(0, 7); if (!k) return
    cvMes[k] = cvMes[k] || { a: 0, b: 0 }; cvMes[k].a += parseFloat(v.total || 0) * signoDocumento(v.tipo_comprobante)
  })
  comprasP.forEach(c => {
    const k = (c.fecha_emision || '').slice(0, 7); if (!k) return
    cvMes[k] = cvMes[k] || { a: 0, b: 0 }; cvMes[k].b += parseFloat(c.total || 0) * signoDocumento(c.tipo_comprobante)
  })
  _html('c-compras-ventas', _barrasDobles(
    Object.entries(cvMes).sort().slice(-6).map(([k, v]) => ({ label: nombreMes(k), a: v.a, b: v.b })),
    'Ventas', 'Compras', 'Sin movimientos en el período.'))

  // Top clientes
  const porCliente = {}
  ventasP.forEach(v => {
    const n = _nombre(v.contact_id)
    porCliente[n] = (porCliente[n] || 0) + parseFloat(v.total || 0) * signoDocumento(v.tipo_comprobante)
  })
  _html('c-top-clientes', _tabla(
    ['Cliente', 'Vendido', '% del total'],
    Object.entries(porCliente).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([n, v]) => [_esc(n), formatNumber(v), totVentas ? formatNumber(v / totVentas * 100, 1) + '%' : '—']),
    'Sin ventas en el período.'))

  // Top productos (a partir del detalle de las ventas del período)
  const idsVentas = new Set(ventasP.map(v => v.id))
  const porItem = {}
  D.detalleVentas.filter(d => idsVentas.has(d.venta_id)).forEach(d => {
    const nombre = _itemMap[d.item_id]?.nombre || d.descripcion || `Item ${d.item_id}`
    porItem[nombre] = porItem[nombre] || { cantidad: 0, monto: 0 }
    porItem[nombre].cantidad += parseFloat(d.cantidad || 0)
    porItem[nombre].monto    += parseFloat(d.total_linea || d.subtotal || 0)
  })
  _html('c-top-productos', _tabla(
    ['Producto', 'Cantidad', 'Monto'],
    Object.entries(porItem).sort((a, b) => b[1].monto - a[1].monto).slice(0, 8)
      .map(([n, v]) => [_esc(n), formatNumber(v.cantidad), formatNumber(v.monto)]),
    'Sin líneas de venta en el período.'))

  // Stock crítico (usa el umbral configurado en Inventario)
  const umbral = parseFloat(getModuloConfig('inventario').stockCritico) || 5
  const stockPorItem = {}
  D.lotes.forEach(l => {
    stockPorItem[l.item_id] = (stockPorItem[l.item_id] || 0) + (parseFloat(l.cantidad) || 0)
  })
  const criticos = Object.entries(stockPorItem)
    .filter(([, cant]) => cant <= umbral)
    .sort((a, b) => a[1] - b[1]).slice(0, 8)
  _html('c-stock-critico', _tabla(
    ['Producto', 'SKU', 'Stock'],
    criticos.map(([id, cant]) => [
      _esc(_itemMap[id]?.nombre || `Item ${id}`),
      _esc(_itemMap[id]?.sku || '—'),
      `<span style="color:var(--color-danger); font-weight:600;">${formatNumber(cant)}</span>`
    ]),
    `Ningún producto por debajo de ${umbral} unidades ✅`))

  // Ventas pendientes de despacho
  _html('c-pendientes-despacho', _tabla(
    ['Documento', 'Cliente', 'Estado', 'Total'],
    pendientes.slice(0, 8).map(v => [
      _esc(v.numero || '—'), _esc(_nombre(v.contact_id)),
      `<span class="badge badge-warning">${_esc(v.estado_despacho || 'pendiente')}</span>`,
      formatNumber(v.total)
    ]),
    'Todo despachado ✅'))
}

// ============================================================================
// NAVEGACIÓN CRUZADA
// ============================================================================
// Abre el módulo destino ya posicionado en el tab correcto. Cada módulo lee
// ?tab= en su arranque (ver leerTabDeUrl en main.js).

window.irA = function(href, tab) {
  window.location.href = tab ? `${href}?tab=${encodeURIComponent(tab)}` : href
}

// ============================================================================
// COMPONENTES DE RENDER (sin librerías externas)
// ============================================================================

function _barras(filas, vacio) {
  if (!filas || filas.length === 0) return `<p class="reporte-vacio">${vacio}</p>`
  const max = Math.max(...filas.map(f => Math.abs(f.valor)), 1)
  return filas.map(f => `
    <div class="reporte-barra-fila">
      <div class="reporte-barra-label" title="${_esc(f.label)}">${_esc(f.label)}</div>
      <div class="reporte-barra-track"><div class="reporte-barra-fill" style="width:${(Math.abs(f.valor) / max * 100).toFixed(1)}%;"></div></div>
      <div class="reporte-barra-valor">${formatNumber(f.valor)}</div>
    </div>`).join('')
}

function _barrasDobles(filas, labelA, labelB, vacio) {
  if (!filas || filas.length === 0) return `<p class="reporte-vacio">${vacio}</p>`
  const max = Math.max(...filas.flatMap(f => [f.a, f.b]), 1)
  return `
    <div style="display:flex; gap:16px; font-size:0.75rem; color:var(--text-secondary); margin-bottom:10px;">
      <span><span style="display:inline-block; width:10px; height:10px; background:var(--color-success); border-radius:2px;"></span> ${labelA}</span>
      <span><span style="display:inline-block; width:10px; height:10px; background:var(--color-danger); border-radius:2px;"></span> ${labelB}</span>
    </div>
    ${filas.map(f => `
      <div style="margin-bottom:9px;">
        <div style="display:flex; justify-content:space-between; font-size:0.76rem; color:var(--text-secondary); margin-bottom:2px;">
          <span>${_esc(f.label)}</span>
          <span>${formatNumber(f.a)} / ${formatNumber(f.b)}</span>
        </div>
        <div class="reporte-barra-track" style="height:9px; margin-bottom:2px;">
          <div class="reporte-barra-fill" style="width:${(f.a / max * 100).toFixed(1)}%; background:var(--color-success);"></div>
        </div>
        <div class="reporte-barra-track" style="height:9px;">
          <div class="reporte-barra-fill" style="width:${(f.b / max * 100).toFixed(1)}%; background:var(--color-danger);"></div>
        </div>
      </div>`).join('')}`
}

function _tabla(cabeceras, filas, vacio) {
  if (!filas || filas.length === 0) return `<p class="reporte-vacio">${vacio}</p>`
  return `
    <table>
      <thead><tr>${cabeceras.map((c, i) => `<th${i > 0 && i === cabeceras.length - 1 ? ' style="text-align:right;"' : ''}>${c}</th>`).join('')}</tr></thead>
      <tbody>
        ${filas.map(f => `<tr>${f.map((c, i) => `<td${i > 0 && i === f.length - 1 ? ' style="text-align:right;"' : ''}>${c}</td>`).join('')}</tr>`).join('')}
      </tbody>
    </table>`
}

function _nombre(contactId) {
  const c = _contactoMap[contactId]
  return c?.razon_social || c?.nombre || `ID ${contactId}`
}

function _set(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt }
function _html(id, h)  { const el = document.getElementById(id); if (el) el.innerHTML = h }
function _valor(id, v) { const el = document.getElementById(id); if (el) el.value = v }
function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
