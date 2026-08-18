// ============================================================================
// CONTABILIDAD.JS - Módulo Contabilidad (Versión Async/Await)
// ============================================================================

import { getCurrentUser } from './auth-supabase.js'
import {
  getJournalEntries, getJournalEntryById, getAccounts, getAccountByCode, calcularBalancesCuentas,
  getJournalEntryLinesByEntry, agregarLineaManualAsiento, eliminarLineaAsiento, cerrarPeriodoContable,
  getDiarios, getDiarioById, addDiario, updateDiario, deleteDiario,
  getDiarioLineas, addDiarioLinea, updateDiarioLinea, deleteDiarioLinea,
  crearAsientoContable, getCustomers, getSuppliers, aplicarModelo,
  getJournalEntryLines,
  getContacts,
  getContactsByType,
  getContactById,
  getTipoDocumentosMap, getNombreTipoDocumentoSync, cargarSelectTipoDocumentos,
  // Nuevas funciones
  getPeriodosContables, addPeriodoContable, updatePeriodoContable,
  getCuentasCobrar, getCobros,
  getPagosProveedores,
  getBancos, getMovimientosBanco,
  getKardexByItem,
  reversarAsiento,
  getBalanceComprobacionVista,
  getLibroMayor,
  getRegistroCompras,
  getRegistroVentas,
  generarNumeroAsiento,
  asegurarPeriodoAbierto
} from './supabase-data.js'
import { showToast, formatNumber } from './helpers.js'
import { initModuleNavDropdowns, initSubtabs } from './main.js'
import { renderConfiguracionTab, aplicarPreferenciasVista, getModuloConfig } from './config-modulo.js'
import { cacheado, invalidarTodo } from './data-cache.js'
import { crearReporte, nombreMes, mesActual } from './reportes.js'

const MODULO_CONTA = 'contabilidad'
let _cfgConta = getModuloConfig(MODULO_CONTA)
let _reportesContaListos = {}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    aplicarPreferenciasVista(MODULO_CONTA)
    _cfgConta = getModuloConfig(MODULO_CONTA)

    const user = await getCurrentUser()
    const userDisplay = document.getElementById('userDisplay')
    if (userDisplay && user) {
      userDisplay.textContent = user.nombre || user.email
    }

    initTabsContabilidad()
    initModuleNavDropdowns('#contaTabs')
    initSubtabs('#conta-subtabs-reportes', (panel) => construirReporteConta(panel))

    renderConfiguracionTab(MODULO_CONTA, 'conta-config-container', {
      onGuardar: () => { _cfgConta = getModuloConfig(MODULO_CONTA); showToast('Configuración guardada ✅', 'success') }
    })

    await getTipoDocumentosMap()   // precarga cache para getNombreTipoDocumentoSync
    await renderPlanCuentas()
  } catch (error) {
    console.error('Error en DOMContentLoaded:', error)
    showToast('Error al cargar el módulo de contabilidad', 'danger')
  }
})

function initTabsContabilidad() {
  const btns = document.querySelectorAll('#contaTabs .tab-btn')
  const contents = document.querySelectorAll('.tab-content')

  btns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const tab = btn.getAttribute('data-tab')

      btns.forEach(b => b.classList.remove('active'))
      contents.forEach(c => c.classList.remove('active'))

      btn.classList.add('active')
      const tabContent = document.getElementById(`tab-${tab}`)
      if (tabContent) {
        tabContent.classList.add('active')
      }

      if (tab === 'cuentas')     await renderPlanCuentas()
      if (tab === 'diario')      await renderLibroDiario()
      if (tab === 'balance')     await renderBalanceComprobacion()
      if (tab === 'resultado')   await renderEstadoResultados()
      if (tab === 'general')     await renderBalanceGeneral()
      if (tab === 'mayor')       await renderLibroMayor()
      if (tab === 'diarios')     await renderDiarios()
      if (tab === 'asientos')    await renderAsientosContables()
      if (tab === 'apuntes')     await renderApuntesContables()
      if (tab === 'periodos')    await renderPeriodosContables()
      if (tab === 'cobrospagos') await renderCobrosPagos()
      if (tab === 'reportes') {
        const activo = document.querySelector('#conta-subtabs-reportes .subtab.active')?.getAttribute('data-sub') || 'repc-cuentas'
        await construirReporteConta(activo)
      }
    })
  })
}

// ============================================================================
// REPORTES GERENCIALES (tablas dinámicas) — Fase 2
// ============================================================================
// Se construyen sobre los asientos y sus líneas ya registrados. Las lecturas
// pasan por data-cache.js para no golpear Supabase cada vez que se mueve un
// filtro (el libro de asientos es la tabla más pesada del sistema).

async function construirReporteConta(panelId) {
  if (_reportesContaListos[panelId]) return
  _reportesContaListos[panelId] = true
  const cont = document.getElementById(panelId)
  if (cont) cont.innerHTML = '<div class="card"><p class="reporte-vacio">Calculando reporte…</p></div>'

  try {
    const [asientos, lineas, cuentas] = await Promise.all([
      cacheado('asientos', getJournalEntries),
      cacheado('asiento_lineas', getJournalEntryLines),
      cacheado('plan_cuentas', getAccounts)
    ])

    const asientoMap = {}
    ;(asientos || []).forEach(a => { asientoMap[a.id] = a })
    const cuentaMap = {}
    ;(cuentas || []).forEach(c => { cuentaMap[c.codigo] = c; cuentaMap[c.id] = c })

    // Normaliza cada línea a una fila plana con su asiento y su cuenta.
    const filas = (lineas || []).map(l => {
      const a  = asientoMap[l.asiento_id || l.entry_id || l.journal_entry_id] || {}
      const cod = l.cuenta_codigo || l.codigo_cuenta || cuentaMap[l.cuenta_id]?.codigo || ''
      const cta = cuentaMap[cod] || cuentaMap[l.cuenta_id] || {}
      const debe  = parseFloat(l.debe  ?? l.monto_debe  ?? 0) || 0
      const haber = parseFloat(l.haber ?? l.monto_haber ?? 0) || 0
      const fecha = a.fecha || l.fecha || ''
      return {
        cuenta: cod ? `${cod} — ${cta.nombre || cta.descripcion || ''}`.trim() : '(sin cuenta)',
        codigo: cod,
        elemento: cod ? `${cod.charAt(0)} · ${_nombreElementoPcge(cod.charAt(0))}` : '(sin clasificar)',
        tipo_cuenta: cta.tipo || cta.tipo_cuenta || '(sin tipo)',
        asiento: a.numero || a.numero_asiento || `#${l.asiento_id || ''}`,
        tipo_asiento: a.tipo || a.tipo_movimiento || '(manual)',
        estado: a.estado || 'registrado',
        mes: nombreMes((fecha || '').slice(0, 7)),
        periodo: (fecha || '').slice(0, 7),
        fecha,
        glosa: a.descripcion || a.glosa || l.descripcion || '',
        debe, haber, saldo: debe - haber
      }
    }).filter(f => f.debe !== 0 || f.haber !== 0)

    if (panelId === 'repc-cuentas') {
      crearReporte('repc-cuentas', {
        id: 'repc-cuentas',
        titulo: 'Saldos por cuenta contable',
        descripcion: 'Balance de comprobación dinámico: agrupa por elemento del PCGE, cuenta o período y filtra por rango de fechas.',
        datos: filas,
        dimensiones: [
          { key: 'elemento', label: 'Elemento PCGE' }, { key: 'cuenta', label: 'Cuenta' },
          { key: 'tipo_cuenta', label: 'Tipo' }, { key: 'mes', label: 'Mes' }
        ],
        medidas: [
          { key: 'debe',  label: 'Debe',  agg: 'sum', formato: 'money' },
          { key: 'haber', label: 'Haber', agg: 'sum', formato: 'money' },
          { key: 'saldo', label: 'Saldo', agg: 'sum', formato: 'money', semaforo: true }
        ],
        filtros: [
          { key: 'cuenta', label: 'Buscar cuenta', tipo: 'texto', campos: ['cuenta', 'codigo'], placeholder: 'Código o nombre...' },
          { key: 'rango',  label: 'Fecha', tipo: 'rango', campo: 'fecha' }
        ],
        agruparPorDefecto: ['elemento'], orden: { key: '_etiqueta', dir: 'asc' },
        kpis: (f) => {
          const d = f.reduce((s, x) => s + x.debe, 0)
          const h = f.reduce((s, x) => s + x.haber, 0)
          return [
            { label: 'Total Debe', valor: d, formato: 'money' },
            { label: 'Total Haber', valor: h, formato: 'money' },
            { label: 'Diferencia', valor: d - h, formato: 'money', color: Math.abs(d - h) < 0.01 ? 'var(--color-success)' : 'var(--color-danger)', sub: Math.abs(d - h) < 0.01 ? 'Cuadrado ✅' : 'Revisar asientos' },
            { label: 'Movimientos', valor: f.length, formato: 'int' }
          ]
        }
      })
    }

    if (panelId === 'repc-movimiento') {
      crearReporte('repc-movimiento', {
        id: 'repc-movimiento',
        titulo: 'Movimiento contable por período y origen',
        descripcion: 'Cuánto contabilizó cada tipo de asiento (ventas, compras, cobros, pagos, manuales) mes a mes.',
        datos: filas,
        dimensiones: [
          { key: 'mes', label: 'Mes' }, { key: 'tipo_asiento', label: 'Tipo de asiento' },
          { key: 'estado', label: 'Estado' }, { key: 'elemento', label: 'Elemento PCGE' }
        ],
        medidas: [
          { key: 'debe',  label: 'Debe',  agg: 'sum', formato: 'money' },
          { key: 'haber', label: 'Haber', agg: 'sum', formato: 'money' }
        ],
        filtros: [
          { key: 'tipo_asiento', label: 'Tipo', tipo: 'texto', campos: ['tipo_asiento'], placeholder: 'Filtrar tipo...' },
          { key: 'glosa', label: 'Glosa', tipo: 'texto', campos: ['glosa', 'asiento'], placeholder: 'Buscar en la glosa...' },
          { key: 'rango', label: 'Fecha', tipo: 'rango', campo: 'fecha' }
        ],
        agruparPorDefecto: ['mes'], orden: { key: '_etiqueta', dir: 'asc' }
      })
    }

    if (panelId === 'repc-igv') {
      // El IGV se identifica por las cuentas configuradas en el tab de
      // Configuración (por defecto 40111 ventas / compras y 40114 retenciones).
      const cIgvV = String(_cfgConta.cuentaIgvVentas || '40111')
      const cIgvC = String(_cfgConta.cuentaIgvCompras || '40111')
      const cRet  = String(_cfgConta.cuentaRetencion || '40114')

      const igv = filas
        .filter(f => f.codigo.startsWith(cIgvV) || f.codigo.startsWith(cIgvC) || f.codigo.startsWith(cRet))
        .map(f => ({
          ...f,
          concepto: f.codigo.startsWith(cRet) ? '3 · Retenciones'
                  : (f.haber > 0 ? '1 · IGV ventas (por pagar)' : '2 · IGV compras (crédito fiscal)'),
          igv_debito:  f.haber, igv_credito: f.debe, igv_neto: f.haber - f.debe
        }))

      crearReporte('repc-igv', {
        id: 'repc-igv',
        titulo: 'IGV del período',
        descripcion: `Débito fiscal (ventas) menos crédito fiscal (compras) y retenciones, según las cuentas configuradas (${cIgvV} / ${cIgvC} / ${cRet}). Ajústalas en ⚙️ Configuración si tu plan usa otras.`,
        datos: igv,
        dimensiones: [
          { key: 'mes', label: 'Mes' }, { key: 'concepto', label: 'Concepto' }, { key: 'cuenta', label: 'Cuenta' }
        ],
        medidas: [
          { key: 'igv_debito',  label: 'Débito (ventas)', agg: 'sum', formato: 'money' },
          { key: 'igv_credito', label: 'Crédito (compras)', agg: 'sum', formato: 'money' },
          { key: 'igv_neto',    label: 'IGV a pagar', agg: 'sum', formato: 'money', semaforo: true }
        ],
        filtros: [{ key: 'rango', label: 'Fecha', tipo: 'rango', campo: 'fecha' }],
        agruparPorDefecto: ['mes'], orden: { key: '_etiqueta', dir: 'asc' },
        kpis: (f) => [
          { label: 'Débito fiscal', valor: f.reduce((s, x) => s + x.igv_debito, 0), formato: 'money' },
          { label: 'Crédito fiscal', valor: f.reduce((s, x) => s + x.igv_credito, 0), formato: 'money' },
          { label: 'IGV neto', valor: f.reduce((s, x) => s + x.igv_neto, 0), formato: 'money', color: 'var(--color-warning)' }
        ]
      })
    }

    if (panelId === 'repc-descuadres') {
      // Un asiento correcto tiene debe = haber. Este reporte los agrupa por
      // asiento para que salte a la vista cualquiera que no cuadre.
      const porAsiento = {}
      filas.forEach(f => {
        const k = f.asiento
        if (!porAsiento[k]) porAsiento[k] = { asiento: k, fecha: f.fecha, mes: f.mes, tipo_asiento: f.tipo_asiento, estado: f.estado, glosa: f.glosa, debe: 0, haber: 0, lineas: 0 }
        porAsiento[k].debe  += f.debe
        porAsiento[k].haber += f.haber
        porAsiento[k].lineas++
      })
      const datos = Object.values(porAsiento).map(a => ({
        ...a,
        diferencia: parseFloat((a.debe - a.haber).toFixed(2)),
        salud: Math.abs(a.debe - a.haber) < 0.01 ? '1 · Cuadrado' : '0 · DESCUADRADO'
      }))

      crearReporte('repc-descuadres', {
        id: 'repc-descuadres',
        titulo: 'Control de asientos (partida doble)',
        descripcion: 'Todo asiento debe cumplir Debe = Haber. Filtra por "DESCUADRADO" para encontrar los que necesitan corrección.',
        datos,
        dimensiones: [
          { key: 'salud', label: 'Estado del cuadre' }, { key: 'asiento', label: 'N° de asiento' },
          { key: 'tipo_asiento', label: 'Tipo' }, { key: 'mes', label: 'Mes' }
        ],
        medidas: [
          { key: 'debe', label: 'Debe', agg: 'sum', formato: 'money' },
          { key: 'haber', label: 'Haber', agg: 'sum', formato: 'money' },
          { key: 'diferencia', label: 'Diferencia', agg: 'sum', formato: 'money', semaforo: true },
          { key: 'lineas', label: 'Líneas', agg: 'sum', formato: 'int' }
        ],
        filtros: [
          { key: 'salud', label: 'Cuadre', tipo: 'select', opciones: ['1 · Cuadrado', '0 · DESCUADRADO'] },
          { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['asiento', 'glosa'], placeholder: 'N° o glosa...' },
          { key: 'rango', label: 'Fecha', tipo: 'rango', campo: 'fecha' }
        ],
        agruparPorDefecto: ['salud'], orden: { key: '_etiqueta', dir: 'asc' },
        kpis: (f) => {
          const malos = f.filter(x => x.salud.startsWith('0'))
          return [
            { label: 'Asientos', valor: f.length, formato: 'int' },
            { label: 'Descuadrados', valor: malos.length, formato: 'int', color: malos.length ? 'var(--color-danger)' : 'var(--color-success)' },
            { label: 'Descuadre total', valor: malos.reduce((s, x) => s + Math.abs(x.diferencia), 0), formato: 'money', color: 'var(--color-danger)' }
          ]
        }
      })
    }
  } catch (e) {
    console.error('construirReporteConta:', e)
    _reportesContaListos[panelId] = false
    if (cont) cont.innerHTML = `<div class="card"><p class="reporte-vacio">No se pudo construir el reporte: ${e.message}<br><button class="btn btn-secondary btn-small" style="margin-top:10px;" onclick="window.reintentarReporteConta('${panelId}')">Reintentar</button></p></div>`
  }
}

window.reintentarReporteConta = function(panelId) {
  invalidarTodo()
  _reportesContaListos[panelId] = false
  construirReporteConta(panelId)
}

function _nombreElementoPcge(digito) {
  return ({
    '1': 'Activo disponible y exigible', '2': 'Activo realizable', '3': 'Activo inmovilizado',
    '4': 'Pasivo', '5': 'Patrimonio neto', '6': 'Gastos por naturaleza',
    '7': 'Ingresos', '8': 'Saldos intermediarios', '9': 'Contabilidad analítica', '0': 'Cuentas de orden'
  })[digito] || 'Sin clasificar'
}

void formatNumber; void mesActual

// ============================================================================
// CLASIFICACIÓN DE CUENTAS (Plan de Cuentas PCGE)
// ============================================================================

function clasificarCuenta(c) {
  const grupo = (c.grupo_reporte || '').toLowerCase()
  const tipo = (c.tipo || '').toLowerCase()
  const codigo = String(c.codigo || '')
  const primerDigito = codigo.charAt(0)

  if (grupo.includes('resultado') || ['6', '7', '9'].includes(primerDigito)) {
    if (primerDigito === '7' || tipo.includes('ingreso')) return 'ingreso'
    if (codigo.startsWith('69') || tipo.includes('costo')) return 'costo'
    return 'gasto'
  }

  if (primerDigito === '5' || tipo.includes('patrimonio') || grupo.includes('patrimonio')) return 'patrimonio'
  if (primerDigito === '4' || tipo.includes('pasivo') || grupo.includes('pasivo')) return 'pasivo'
  return 'activo'
}

// ============================================================================
// 1. PLAN DE CUENTAS
// ============================================================================

async function renderPlanCuentas() {
  try {
    const cuentas = await calcularBalancesCuentas()
    const container = document.getElementById('content-cuentas')

    if (!container) return

    let html = `
      <div class="card-header">
        <h3 class="card-title">Plan de Cuentas</h3>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Código</th>
              <th>Nombre</th>
              <th>Tipo</th>
              <th>Débito</th>
              <th>Crédito</th>
              <th>Saldo</th>
            </tr>
          </thead>
          <tbody>
    `

    if (cuentas && cuentas.length > 0) {
      cuentas.forEach(c => {
        const debe = c.saldo_debe || c.debe || 0
        const haber = c.saldo_haber || c.haber || 0
        const balance = debe - haber
        const saldoColor = balance > 0 ? 'color: var(--color-success)' : ''
        html += `
          <tr>
            <td><strong>${c.codigo || c.numero}</strong></td>
            <td>${c.name || c.nombre}</td>
            <td>${c.type || c.tipo}</td>
            <td>${(debe).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td>${(haber).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td style="${saldoColor}; font-weight: bold;">${(balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          </tr>
        `
      })
    } else {
      html += `<tr><td colspan="6" style="text-align: center;">Sin cuentas: ${cuentas}</td></tr>`
    }

    html += '</tbody></table></div>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderPlanCuentas:', error)
    showToast('Error al cargar plan de cuentas', 'danger')
  }
}

async function renderAsientosContables() {
  try {
    const asientos = await getJournalEntries()
    const container = document.getElementById('content-asientos')

    const contactos = await getContacts()
    const contactosMap = {}
    if (contactos && contactos.length > 0) {
      contactos.forEach(c => {
        contactosMap[c.id] = c.nombre || 'Sin nombre'
      })
    }
    if (!container) return

    let html = `
      <div class="card-header">
        <h3 class="card-title">Asientos Contables</h3>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Código</th>
              <th>Contacto</th>
              <th>Fecha</th>
              <th>Periodo Contable</th>
              <th>Numero</th>
              <th>Doc Referencia</th>
              <th>Descripcion</th>
              <th>Tipo Movimiento</th>
              <th>Tipo Documento</th>
              <th>Moneda</th>
              <th>Débito</th>
              <th>Crédito</th>
              <th>Saldo</th>
              <th>Estatus</th>
            </tr>
          </thead>
          <tbody>
    `

    if (asientos && asientos.length > 0) {
      asientos.forEach(a => {
        const debe = a.total_debe || a.debe || 0
        const haber = a.total_haber || a.haber || 0
        const balance = debe - haber
        const saldoColor = balance > 0 ? 'color: var(--color-success)' : ''
        html += `
          <tr>
            <td><strong>${a.id}</strong></td>
            <td>${contactosMap[a.contact_id] || 'Sin nombre'}</td>
            <td>${a.fecha}</td>
            <td>${a.periodo_contable}</td>
            <td>${a.numero_asiento || '-'}</td>
            <td>${a.documento_referencia || '-'}</td>
            <td>${a.descripcion}</td>
            <td>${a.tipo_movimiento}</td>
            <td>${a.tipo_documento ? `${a.tipo_documento} - ${getNombreTipoDocumentoSync(a.tipo_documento)}` : '-'}</td>
            <td>${a.moneda}</td>
            <td>${(debe).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td>${(haber).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td style="${saldoColor}; font-weight: bold;">${(balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td>${a.status}</td>
          </tr>
        `
      })
    } else {
      html += `<tr><td colspan="6" style="text-align: center;">Sin Asientos: ${asientos}</td></tr>`
    }

    html += '</tbody></table></div>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderAsientosContables:', error)
    showToast('Error al cargar asientos contables', 'danger')
  }
}

async function renderApuntesContables() {
  try {
    const apuntesContables = await getJournalEntryLines()
    const container = document.getElementById('content-apuntes')

    if (!container) return

    // Obtener todos los asientos y cuentas para crear mapas
    const asientos = await getJournalEntries()
    const cuentas = await getAccounts()
    
    const asientosMap = {}
    const cuentasMap = {}
    
    if (asientos && asientos.length > 0) {
      asientos.forEach(a => {
        asientosMap[a.id] = a
      })
    }
    
    if (cuentas && cuentas.length > 0) {
      cuentas.forEach(c => {
        cuentasMap[c.id] = c
      })
    }

    let html = `
      <div class="card-header">
        <h3 class="card-title">Apuntes Contables</h3>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Código Apunte</th>
              <th>Asiento</th>
              <th>Cuenta</th>
              <th>Descripción</th>
              <th>Tipo Cambio</th>
              <th>Debe</th>
              <th>Haber</th>
              <th>Fecha</th>
            </tr>
          </thead>
          <tbody>
    `

    if (apuntesContables && apuntesContables.length > 0) {
      apuntesContables.forEach(apunte => {
        // Obtener datos del asiento contable asociado
        const asiento = asientosMap[apunte.journal_entry_id]
        const cuenta = cuentasMap[apunte.account_id]
        
        const descripcionAsiento = asiento ? asiento.descripcion : '-'
        const nombreCuenta = cuenta ? `${cuenta.codigo} - ${cuenta.nombre}` : '-'
        const fechaAsiento = asiento ? asiento.fecha : '-'
        
        html += `
          <tr>
            <td><strong>${apunte.id}</strong></td>
            <td>${asiento?.numero_asiento || '-'}</td>
            <td>${nombreCuenta}</td>
            <td>${apunte.descripcion || '-'}</td>
            <td>${(parseFloat(apunte.tipo_cambio) || 1).toFixed(3)}</td>
            <td>${(parseFloat(apunte.debe) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td>${(parseFloat(apunte.haber) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td>${fechaAsiento}</td>
          </tr>
        `
      })
    } else {
      html += `<tr><td colspan="8" style="text-align: center;">Sin apuntes contables</td></tr>`
    }

    html += '</tbody></table></div>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderApuntesContables:', error)
    showToast('Error al cargar apuntes contables', 'danger')
  }
}
// ============================================================================
// 2. LIBRO DIARIO
// ============================================================================

async function renderLibroDiario(filtroMes = null) {
  try {
    let entries = await getJournalEntries()
    const container = document.getElementById('content-diario')

    if (!container) return

    // Aplicar filtro por mes si viene
    if (filtroMes) {
      entries = entries.filter(e => (e.periodo_contable || e.fecha || '').startsWith(filtroMes))
    }

    if (!entries || entries.length === 0) {
      container.innerHTML = '<p style="padding:20px; text-align:center; color:var(--text-secondary);">Sin asientos contables para el período seleccionado.</p>'
      return
    }

    const statusBadge = s => {
      const map = { confirmado: 'badge-success', borrador: 'badge-warning', reversado: 'badge-danger' }
      return `<span class="badge ${map[s] || 'badge-secondary'}">${s}</span>`
    }

    let html = `
      <div class="card-header">
        <h3 class="card-title">Libro Diario${filtroMes ? ` — ${filtroMes}` : ''}</h3>
        <small style="color:var(--text-secondary);">${entries.length} asientos</small>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>N°</th><th>Fecha</th><th>Descripción</th>
              <th>Doc. Referencia</th><th>Tipo</th><th>Estado</th>
              <th style="text-align:right;">Debe</th>
              <th style="text-align:right;">Haber</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
    `

    for (const entry of entries.sort((a, b) => new Date(b.fecha || 0) - new Date(a.fecha || 0))) {
      const debe  = parseFloat(entry.total_debe  || entry.debe  || 0)
      const haber = parseFloat(entry.total_haber || entry.haber || 0)
      const esReversable = entry.status === 'confirmado'

      html += `
        <tr style="border-bottom:1px solid var(--border-color); background:var(--bg-secondary); font-weight:600;">
          <td>${entry.numero_asiento || entry.id}</td>
          <td>${entry.fecha || '-'}</td>
          <td>${entry.descripcion || '-'}</td>
          <td>${entry.documento_referencia || '-'}</td>
          <td style="font-size:0.82rem;">${entry.tipo_movimiento || '-'} ${entry.tipo_documento ? `<br><small>${getNombreTipoDocumentoSync(entry.tipo_documento)}</small>` : ''}</td>
          <td>${statusBadge(entry.status || 'borrador')}</td>
          <td style="text-align:right;">${debe.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td style="text-align:right;">${haber.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td style="white-space:nowrap;">
            <button class="btn btn-small btn-secondary" onclick="window.toggleLineasAsiento(${entry.id})">Detalle</button>
            ${entry.status !== 'reversado' ? `<button class="btn btn-small btn-primary" onclick="window.abrirModalLineaManual(${entry.id})">+ Línea</button>` : ''}
            ${esReversable ? `<button class="btn btn-small btn-warning" onclick="window.reversarAsientoUI(${entry.id})" title="Reversar asiento">↩</button>` : ''}
          </td>
        </tr>
        <tr id="lineas-asiento-${entry.id}" style="display:none;">
          <td colspan="9" style="padding:0;">
            <div id="lineas-asiento-body-${entry.id}" style="padding:10px 20px; background:var(--bg-primary);">
              Cargando líneas...
            </div>
          </td>
        </tr>
      `
    }

    html += '</tbody></table></div>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderLibroDiario:', error)
    showToast('Error al cargar libro diario', 'danger')
  }
}

window.filtrarDiario = async function() {
  const mes = document.getElementById('diarioFiltroMes')?.value
  await renderLibroDiario(mes || null)
}

// ============================================================================
// LÍNEAS DE ASIENTO (Detalle + Agregar línea manual)
// ============================================================================

window.toggleLineasAsiento = async function (entryId) {
  try {
    const row = document.getElementById(`lineas-asiento-${entryId}`)
    if (!row) return

    if (row.style.display === 'none') {
      row.style.display = 'table-row'
      await renderLineasAsiento(entryId)
    } else {
      row.style.display = 'none'
    }
  } catch (error) {
    console.error('Error en toggleLineasAsiento:', error)
  }
}

async function renderLineasAsiento(entryId) {
  try {
    const body = document.getElementById(`lineas-asiento-body-${entryId}`)
    if (!body) return

    const [lineas, cuentas] = await Promise.all([getJournalEntryLinesByEntry(entryId), getAccounts()])
    const cuentasMap = {}
    cuentas.forEach(c => { cuentasMap[c.id] = c })

    if (!lineas || lineas.length === 0) {
      body.innerHTML = '<p style="color: var(--text-secondary);">Sin líneas registradas</p>'
      return
    }

    let html = `
      <table style="width: 100%;">
        <thead>
          <tr>
            <th>Cuenta</th>
            <th>Descripción</th>
            <th>Fecha</th>
            <th style="text-align:right;">T. Cambio</th>
            <th style="text-align: right;">Debe</th>
            <th style="text-align: right;">Haber</th>
            <th style="text-align: center;">Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    lineas.forEach(linea => {
      const cuenta = cuentasMap[linea.account_id]
      html += `
        <tr>
          <td>${cuenta ? `${cuenta.codigo} - ${cuenta.nombre}` : `Cuenta #${linea.account_id}`}</td>
          <td>${linea.descripcion || '-'}</td>
          <td>${linea.fecha || '-'}</td>
          <td style="text-align:right;">${linea.tipo_cambio ? parseFloat(linea.tipo_cambio).toFixed(3) : '-'}</td>
          <td style="text-align: right;">${parseFloat(linea.debe || 0) > 0 ? parseFloat(linea.debe).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''}</td>
          <td style="text-align: right;">${parseFloat(linea.haber || 0) > 0 ? parseFloat(linea.haber).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''}</td>
          <td style="text-align: center;">
            <button class="btn btn-small btn-danger" onclick="window.eliminarLineaManual(${linea.id}, ${entryId})">Eliminar</button>
          </td>
        </tr>
      `
    })

    html += '</tbody></table>'
    body.innerHTML = html
  } catch (error) {
    console.error('Error en renderLineasAsiento:', error)
  }
}

window.abrirModalLineaManual = async function (entryId) {
  try {
    const cuentas = await getAccounts()
    const select = document.getElementById('lineaManualCuenta')
    if (select) {
      select.innerHTML = '<option value="">-- Selecciona cuenta --</option>'
      cuentas
        .sort((a, b) => String(a.codigo).localeCompare(String(b.codigo)))
        .forEach(c => {
          select.innerHTML += `<option value="${c.id}">${c.codigo} - ${c.nombre}</option>`
        })
    }

    const form = document.getElementById('formLineaManual')
    if (form) form.reset()

    document.getElementById('lineaManualEntryId').value = entryId
    window.openModal('modal-linea-manual')
  } catch (error) {
    console.error('Error en abrirModalLineaManual:', error)
    showToast('Error al abrir el formulario de línea manual', 'danger')
  }
}

window.guardarLineaManual = async function () {
  try {
    const entryId = parseInt(document.getElementById('lineaManualEntryId')?.value || 0)
    const accountId = parseInt(document.getElementById('lineaManualCuenta')?.value || 0)
    const tipo = document.getElementById('lineaManualTipo')?.value || 'debe'
    const importe = parseFloat(document.getElementById('lineaManualImporte')?.value || 0)
    const descripcion = document.getElementById('lineaManualDescripcion')?.value || ''

    if (!entryId || !accountId || !importe) {
      showToast('Complete cuenta e importe', 'warning')
      return
    }

    await agregarLineaManualAsiento(entryId, { account_id: accountId, tipo, importe, descripcion })

    showToast('Línea agregada al asiento', 'success')
    window.closeModal('modal-linea-manual')
    const form = document.getElementById('formLineaManual')
    if (form) form.reset()

    await renderLibroDiario()
    await renderPlanCuentas()
  } catch (error) {
    console.error('Error en guardarLineaManual:', error)
    showToast(error.message || 'Error al agregar la línea', 'danger')
  }
}

window.eliminarLineaManual = async function (lineaId, entryId) {
  try {
    if (!confirm('¿Eliminar esta línea del asiento?')) return
    await eliminarLineaAsiento(lineaId)
    showToast('Línea eliminada', 'success')
    await renderLibroDiario()
    await renderPlanCuentas()
  } catch (error) {
    console.error('Error en eliminarLineaManual:', error)
    showToast(error.message || 'Error al eliminar la línea', 'danger')
  }
}

// ============================================================================
// CIERRE PERIÓDICO
// ============================================================================

window.ejecutarCierre = async function () {
  try {
    const periodo = document.getElementById('cierrePeriodo')?.value || new Date().toISOString().slice(0, 7)
    if (!confirm(`¿Ejecutar el cierre contable del periodo ${periodo}? Esta acción generará un asiento de cierre.`)) return

    const user = await getCurrentUser()
    await cerrarPeriodoContable(periodo, user?.id)

    showToast(`Cierre del periodo ${periodo} realizado`, 'success')
    await renderLibroDiario()
    await renderPlanCuentas()
    await renderEstadoResultados()
  } catch (error) {
    console.error('Error en ejecutarCierre:', error)
    showToast(error.message || 'Error al ejecutar el cierre', 'danger')
  }
}

// ============================================================================
// 3. BALANCE DE COMPROBACIÓN
// ============================================================================

async function renderBalanceComprobacion() {
  try {
    const cuentas = await calcularBalancesCuentas()
    const container = document.getElementById('content-balance')

    if (!container) return

    let totalDebe = 0
    let totalHaber = 0

    let html = `
      <div class="card-header">
        <h3 class="card-title">Balance de Comprobación</h3>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Código</th>
              <th>Nombre Cuenta</th>
              <th>Debe</th>
              <th>Haber</th>
            </tr>
          </thead>
          <tbody>
    `

    if (cuentas && cuentas.length > 0) {
      cuentas.forEach(c => {
        const debe = c.saldo_debe || c.debe || 0
        const haber = c.saldo_haber || c.haber || 0
        totalDebe += debe
        totalHaber += haber

        html += `
          <tr>
            <td><strong>${c.codigo || c.numero}</strong></td>
            <td>${c.name || c.nombre}</td>
            <td style="text-align: right;">${debe.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td style="text-align: right;">${haber.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          </tr>
        `
      })
    }

    html += `
        </tbody>
        <tfoot>
          <tr style="border-top: 2px solid var(--border-color); font-weight: bold;">
            <td colspan="2">TOTALES</td>
            <td style="text-align: right;">${totalDebe.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td style="text-align: right;">${totalHaber.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          </tr>
        </tfoot>
      </table></div>
    `

    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderBalanceComprobacion:', error)
    showToast('Error al cargar balance de comprobación', 'danger')
  }
}

// ============================================================================
// 4. ESTADO DE RESULTADOS
// ============================================================================

async function renderEstadoResultados() {
  try {
    const cuentas = await calcularBalancesCuentas()
    const container = document.getElementById('content-resultado')

    if (!container) return

    // Clasificar cuentas de resultado: ingresos, costos y gastos
    const ingresos = cuentas.filter(c => clasificarCuenta(c) === 'ingreso')
    const costos = cuentas.filter(c => clasificarCuenta(c) === 'costo')
    const gastos = cuentas.filter(c => clasificarCuenta(c) === 'gasto')

    const totalIngresos = ingresos.reduce((sum, c) => sum + (c.balance || 0), 0)
    const totalCostos = costos.reduce((sum, c) => sum + (c.balance || 0), 0)
    const totalGastosOperativos = gastos.reduce((sum, c) => sum + (c.balance || 0), 0)
    const totalGastos = totalCostos + totalGastosOperativos
    const utilidad = totalIngresos - totalGastos

    let html = `
      <div class="card-header">
        <h3 class="card-title">Estado de Resultados</h3>
      </div>
      <div class="table-container">
        <table>
          <tbody>
            <tr style="border-bottom: 1px solid var(--border-color); font-weight: bold;">
              <td colspan="2">INGRESOS</td>
            </tr>
    `

    if (ingresos.length > 0) {
      ingresos.forEach(c => {
        html += `
          <tr>
            <td style="padding-left: 20px;">${c.nombre || c.name}</td>
            <td style="text-align: right;">${(c.balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          </tr>
        `
      })
    }

    html += `
            <tr style="border-bottom: 1px solid var(--border-color); background-color: var(--bg-secondary);">
              <td><strong>Total Ingresos</strong></td>
              <td style="text-align: right;"><strong>${totalIngresos.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td>
            </tr>
            <tr style="border-bottom: 1px solid var(--border-color); font-weight: bold;">
              <td colspan="2">COSTO DE VENTAS</td>
            </tr>
    `

    if (costos.length > 0) {
      costos.forEach(c => {
        html += `
          <tr>
            <td style="padding-left: 20px;">${c.nombre || c.name}</td>
            <td style="text-align: right;">${(c.balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          </tr>
        `
      })
    }

    html += `
            <tr style="border-bottom: 1px solid var(--border-color); background-color: var(--bg-secondary);">
              <td><strong>Total Costo de Ventas</strong></td>
              <td style="text-align: right;"><strong>${totalCostos.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td>
            </tr>
            <tr style="border-bottom: 1px solid var(--border-color); font-weight: bold;">
              <td colspan="2">GASTOS OPERATIVOS</td>
            </tr>
    `

    if (gastos.length > 0) {
      gastos.forEach(c => {
        html += `
          <tr>
            <td style="padding-left: 20px;">${c.nombre || c.name}</td>
            <td style="text-align: right;">${(c.balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          </tr>
        `
      })
    }

    html += `
            <tr style="border-bottom: 1px solid var(--border-color); background-color: var(--bg-secondary);">
              <td><strong>Total Gastos Operativos</strong></td>
              <td style="text-align: right;"><strong>${totalGastosOperativos.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td>
            </tr>
            <tr style="border-top: 2px solid var(--border-color); background-color: ${utilidad > 0 ? '#d1f2d1' : '#ffd1d1'}; font-weight: bold;">
              <td>UTILIDAD NETA</td>
              <td style="text-align: right;">${utilidad.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            </tr>
          </tbody>
        </table></div>
    `

    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderEstadoResultados:', error)
    showToast('Error al cargar estado de resultados', 'danger')
  }
}

// ============================================================================
// 5. BALANCE GENERAL (Activo = Pasivo + Patrimonio)
// ============================================================================

async function renderBalanceGeneral() {
  try {
    let cuentas
    try {
      cuentas = await getBalanceComprobacionVista()
    } catch {
      cuentas = await calcularBalancesCuentas()
    }
    const container = document.getElementById('content-general')
    if (!container) return

    const activos    = cuentas.filter(c => c.grupo_reporte === 'Activo')
    const pasivos    = cuentas.filter(c => c.grupo_reporte === 'Pasivo')
    const patrimonio = cuentas.filter(c => c.grupo_reporte === 'Patrimonio')

    const calcSaldo = c => {
      const debe  = parseFloat(c.total_debe  || c.saldo_debe  || 0)
      const haber = parseFloat(c.total_haber || c.saldo_haber || 0)
      const nat   = c.naturaleza_saldo || 'deudor'
      return nat === 'deudor' ? debe - haber : haber - debe
    }

    const sumGroup = arr => arr.reduce((s, c) => s + calcSaldo(c), 0)

    const totalActivo    = sumGroup(activos)
    const totalPasivo    = sumGroup(pasivos)
    const totalPatrimonio = sumGroup(patrimonio)

    const renderGroup = (title, items) => {
      let html = `<tr class="group-header"><td colspan="2"><strong>${title}</strong></td></tr>`
      items.filter(c => Math.abs(calcSaldo(c)) >= 0.01).forEach(c => {
        html += `<tr>
          <td style="padding-left:20px;">${c.nombre}</td>
          <td style="text-align:right;">${calcSaldo(c).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        </tr>`
      })
      return html
    }

    container.innerHTML = `
      <div class="card-header">
        <h3 class="card-title">Balance General</h3>
        <small style="color:var(--text-secondary);">
          ${totalActivo.toFixed(2) === (totalPasivo + totalPatrimonio).toFixed(2)
            ? '✅ Balance cuadrado'
            : `⚠️ Diferencia: ${(totalActivo - totalPasivo - totalPatrimonio).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
        </small>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px; padding:15px;">
        <div>
          <table style="width:100%;">
            <tbody>
              ${renderGroup('ACTIVO CORRIENTE', activos.filter(c => c.subgrupo === 'Activo Corriente'))}
              ${renderGroup('ACTIVO NO CORRIENTE', activos.filter(c => c.subgrupo === 'Activo No Corriente'))}
              <tr style="border-top:2px solid var(--border-color); font-weight:bold;">
                <td>TOTAL ACTIVO</td>
                <td style="text-align:right;">${totalActivo.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          <table style="width:100%;">
            <tbody>
              ${renderGroup('PASIVO CORRIENTE', pasivos.filter(c => c.subgrupo === 'Pasivo Corriente'))}
              ${renderGroup('PASIVO NO CORRIENTE', pasivos.filter(c => c.subgrupo === 'Pasivo No Corriente'))}
              <tr style="border-top:1px solid var(--border-color); font-weight:bold; background:var(--bg-secondary);">
                <td>TOTAL PASIVO</td>
                <td style="text-align:right;">${totalPasivo.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              </tr>
              ${renderGroup('PATRIMONIO', patrimonio)}
              <tr style="border-top:1px solid var(--border-color); font-weight:bold; background:var(--bg-secondary);">
                <td>TOTAL PATRIMONIO</td>
                <td style="text-align:right;">${totalPatrimonio.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              </tr>
              <tr style="border-top:2px solid var(--border-color); font-weight:bold;">
                <td>TOTAL PASIVO + PATRIMONIO</td>
                <td style="text-align:right;">${(totalPasivo + totalPatrimonio).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `
  } catch (error) {
    console.error('Error en renderBalanceGeneral:', error)
    showToast('Error al cargar balance general', 'danger')
  }
}

// ============================================================================
// 6. LIBRO MAYOR (cuenta individual)
// ============================================================================

async function renderLibroMayor() {
  try {
    const container = document.getElementById('content-mayor')
    if (!container) return

    const cuentas = await getAccounts()
    const selectHtml = cuentas
      .sort((a, b) => String(a.codigo).localeCompare(String(b.codigo)))
      .map(c => `<option value="${c.codigo}">${c.codigo} - ${c.nombre}</option>`)
      .join('')

    container.innerHTML = `
      <div class="card-header">
        <h3 class="card-title">Libro Mayor</h3>
        <div style="display:flex; gap:10px; align-items:center;">
          <select id="mayorCuentaSelect" style="min-width:300px;">
            <option value="">-- Seleccione cuenta --</option>
            ${selectHtml}
          </select>
          <button class="btn btn-primary btn-small" onclick="window.cargarMayor()">Ver Mayor</button>
        </div>
      </div>
      <div id="mayor-body" style="padding:10px;"></div>
    `
  } catch (e) {
    console.error('renderLibroMayor:', e)
  }
}

window.cargarMayor = async function() {
  const codigo = document.getElementById('mayorCuentaSelect')?.value
  if (!codigo) { showToast('Selecciona una cuenta', 'warning'); return }

  const body = document.getElementById('mayor-body')
  if (body) body.innerHTML = 'Cargando...'

  try {
    const lineas = await getLibroMayor(codigo)

    if (!lineas || lineas.length === 0) {
      body.innerHTML = '<p style="text-align:center; padding:20px; color:var(--text-secondary);">Sin movimientos para esta cuenta.</p>'
      return
    }

    let saldo = 0
    let html = `<table style="width:100%;">
      <thead>
        <tr>
          <th>Fecha</th><th>Asiento</th><th>Descripción</th>
          <th style="text-align:right;">Debe</th>
          <th style="text-align:right;">Haber</th>
          <th style="text-align:right;">Saldo</th>
        </tr>
      </thead><tbody>`

    lineas.forEach(l => {
      const debe  = parseFloat(l.debe  || 0)
      const haber = parseFloat(l.haber || 0)
      saldo += debe - haber
      html += `<tr>
        <td>${l.fecha || '-'}</td>
        <td>${l.numero_asiento || '-'}</td>
        <td>${l.descripcion || l.glosa_linea || '-'}</td>
        <td style="text-align:right;">${debe  > 0 ? debe.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })  : ''}</td>
        <td style="text-align:right;">${haber > 0 ? haber.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''}</td>
        <td style="text-align:right; font-weight:bold;">${saldo.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      </tr>`
    })

    html += '</tbody></table>'
    body.innerHTML = html
  } catch (e) {
    console.error('cargarMayor:', e)
    body.innerHTML = `<p style="color:var(--color-danger);">Error al cargar mayor: ${e.message}</p>`
  }
}

// ============================================================================
// 7. DIARIOS (plantillas de asientos automáticos)
// ============================================================================

async function renderDiarios() {
  try {
    const diarios = await getDiarios()
    const container = document.getElementById('content-diarios')
    if (!container) return

    let html = `
      <div class="card-header">
        <h3 class="card-title">Plantillas de Diarios</h3>
        <button class="btn btn-primary btn-small" onclick="window.abrirModalNuevoDiario()">+ Nuevo Diario</button>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>ID</th><th>Nombre</th><th>Tipo Movimiento</th>
              <th>Tipo Documento</th><th>Moneda</th><th>Activo</th><th>Acciones</th>
            </tr>
          </thead>
          <tbody>
    `

    if (diarios && diarios.length > 0) {
      for (const d of diarios) {
        html += `
          <tr>
            <td>${d.id}</td>
            <td><strong>${d.nombre}</strong></td>
            <td>${d.tipo_movimiento}</td>
            <td>${d.tipo_documento ? getNombreTipoDocumentoSync(d.tipo_documento) || d.tipo_documento : '—'}</td>
            <td>${d.moneda || '—'}</td>
            <td>${d.activo ? '✅' : '❌'}</td>
            <td>
              <button class="btn btn-small btn-secondary" onclick="window.verLineasDiario(${d.id}, '${d.nombre}')">Líneas</button>
              <button class="btn btn-small btn-warning"   onclick="window.editarDiario(${d.id})">Editar</button>
            </td>
          </tr>
        `
      }
    } else {
      html += '<tr><td colspan="7" style="text-align:center;">Sin diarios configurados</td></tr>'
    }

    html += '</tbody></table></div>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderDiarios:', error)
    showToast('Error al cargar diarios', 'danger')
  }
}

window.verLineasDiario = async function(diarioId, nombreDiario) {
  try {
    const lineas = await getDiarioLineas(diarioId)
    const cuentas = await getAccounts()
    const cuentasMap = {}
    cuentas.forEach(c => { cuentasMap[c.codigo] = c.nombre })

    let html = `<h4 style="margin-bottom:10px;">Líneas: ${nombreDiario}</h4>
      <table style="width:100%;">
        <thead><tr>
          <th>Orden</th><th>Cuenta</th><th>Tipo</th><th>Fórmula</th>
          <th>Condición</th><th>Descripción</th><th>Acciones</th>
        </tr></thead><tbody>`

    if (lineas.length === 0) {
      html += '<tr><td colspan="7" style="text-align:center;">Sin líneas</td></tr>'
    } else {
      lineas.forEach(l => {
        const nomCuenta = cuentasMap[l.cuenta_codigo] || ''
        html += `<tr>
          <td>${l.orden}</td>
          <td>${l.cuenta_codigo} ${nomCuenta ? `<small>${nomCuenta}</small>` : ''}</td>
          <td><span class="${l.tipo === 'debe' ? 'badge badge-info' : 'badge badge-secondary'}">${l.tipo}</span></td>
          <td><code>${l.formula || '—'}</code></td>
          <td>${l.condicion || '—'}</td>
          <td>${l.descripcion || '—'}</td>
          <td>
            <button class="btn btn-small btn-danger" onclick="window.eliminarLineaDiario(${l.id}, ${diarioId}, '${nombreDiario}')">Eliminar</button>
          </td>
        </tr>`
      })
    }

    html += `</tbody></table>
      <div style="margin-top:15px; padding:15px; background:var(--bg-secondary); border-radius:8px;">
        <strong>Agregar línea al diario ${nombreDiario}:</strong>
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:8px; margin-top:10px;">
          <select id="dlCuenta" style="grid-column:span 2;">
            <option value="">-- Cuenta --</option>
            ${cuentas.sort((a,b)=>String(a.codigo).localeCompare(String(b.codigo)))
              .map(c => `<option value="${c.codigo}">${c.codigo} - ${c.nombre}</option>`).join('')}
          </select>
          <select id="dlTipo"><option value="debe">Debe</option><option value="haber">Haber</option></select>
          <input id="dlFormula"    type="text" placeholder="Fórmula: %total%">
          <input id="dlCondicion"  type="text" placeholder="Condición (opcional)">
          <input id="dlDesc"       type="text" placeholder="Descripción">
          <input id="dlOrden"      type="number" placeholder="Orden" value="1">
          <button class="btn btn-primary btn-small" onclick="window.agregarLineaDiario(${diarioId}, '${nombreDiario}')">Agregar</button>
        </div>
      </div>`

    document.getElementById('modal-lineas-diario-body').innerHTML = html
    window.openModal('modal-lineas-diario')
  } catch (e) {
    console.error('verLineasDiario:', e)
    showToast('Error al cargar líneas del diario', 'danger')
  }
}

window.agregarLineaDiario = async function(diarioId, nombreDiario) {
  const cuenta    = document.getElementById('dlCuenta')?.value
  const tipo      = document.getElementById('dlTipo')?.value || 'debe'
  const formula   = document.getElementById('dlFormula')?.value || ''
  const condicion = document.getElementById('dlCondicion')?.value || ''
  const desc      = document.getElementById('dlDesc')?.value || ''
  const orden     = parseInt(document.getElementById('dlOrden')?.value || '1', 10)

  if (!cuenta) { showToast('Selecciona una cuenta', 'warning'); return }
  if (!formula) { showToast('Ingresa la fórmula (ej: %total%)', 'warning'); return }

  try {
    await addDiarioLinea({ diario_id: diarioId, orden, cuenta_codigo: cuenta, tipo, formula, condicion: condicion || null, descripcion: desc || null })
    showToast('Línea agregada', 'success')
    await window.verLineasDiario(diarioId, nombreDiario)
    await renderDiarios()
  } catch (e) {
    showToast('Error al agregar línea: ' + e.message, 'danger')
  }
}

window.eliminarLineaDiario = async function(lineaId, diarioId, nombreDiario) {
  if (!confirm('¿Eliminar esta línea del diario?')) return
  try {
    await deleteDiarioLinea(lineaId)
    showToast('Línea eliminada', 'success')
    await window.verLineasDiario(diarioId, nombreDiario)
    await renderDiarios()
  } catch (e) {
    showToast('Error: ' + e.message, 'danger')
  }
}

// El mismo modal sirve para crear y para editar: cuando _diarioEnEdicion
// tiene un id, se hace update en vez de insert. Antes el botón "Editar" de
// la tabla de Diarios llamaba a una función que no existía (TypeError).
let _diarioEnEdicion = null

window.editarDiario = async function(diarioId) {
  try {
    const d = await getDiarioById(diarioId)
    if (!d) { showToast('Diario no encontrado', 'danger'); return }

    _diarioEnEdicion = diarioId
    _valorConta('nuevoDiarioNombre',  d.nombre || '')
    _valorConta('nuevoDiarioTipoMov', d.tipo_movimiento || '')
    _valorConta('nuevoDiarioTipoDoc', d.tipo_documento || '')
    _valorConta('nuevoDiarioMoneda',  d.moneda || '')

    const titulo = document.querySelector('#modal-nuevo-diario .modal-header h3')
    if (titulo) titulo.textContent = `Editar plantilla: ${d.nombre}`
    window.openModal('modal-nuevo-diario')
  } catch (e) {
    showToast('Error al abrir el diario: ' + e.message, 'danger')
  }
}

window.abrirModalNuevoDiario = function() {
  _diarioEnEdicion = null
  ;['nuevoDiarioNombre', 'nuevoDiarioTipoMov'].forEach(id => _valorConta(id, ''))
  const titulo = document.querySelector('#modal-nuevo-diario .modal-header h3')
  if (titulo) titulo.textContent = 'Nueva Plantilla de Diario'
  window.openModal('modal-nuevo-diario')
}

window.guardarNuevoDiario = async function() {
  const nombre   = document.getElementById('nuevoDiarioNombre')?.value?.trim()
  const tipoMov  = document.getElementById('nuevoDiarioTipoMov')?.value?.trim()
  const tipoDoc  = document.getElementById('nuevoDiarioTipoDoc')?.value
  const moneda   = document.getElementById('nuevoDiarioMoneda')?.value

  if (!nombre || !tipoMov) { showToast('Nombre y tipo de movimiento son requeridos', 'warning'); return }

  try {
    const datos = { nombre, tipo_movimiento: tipoMov, tipo_documento: tipoDoc || null, moneda: moneda || null }
    if (_diarioEnEdicion) {
      await updateDiario(_diarioEnEdicion, datos)
      showToast('Diario actualizado ✅', 'success')
    } else {
      await addDiario({ ...datos, activo: true })
      showToast('Diario creado ✅', 'success')
    }
    _diarioEnEdicion = null
    window.closeModal('modal-nuevo-diario')
    await renderDiarios()
  } catch (e) {
    showToast('Error al guardar el diario: ' + e.message, 'danger')
  }
}

function _valorConta(id, v) { const el = document.getElementById(id); if (el) el.value = v }

// ============================================================================
// 8. ASIENTOS CONTABLES — NUEVO MANUAL + REVERSAR
// ============================================================================

window.abrirModalNuevoAsiento = async function() {
  try {
    const cuentas = await getAccounts()
    const periodo = await asegurarPeriodoAbierto()

    document.getElementById('nuevoAsientoFecha').value = new Date().toISOString().split('T')[0]
    document.getElementById('nuevoAsientoPeriodo').value = periodo

    const select = document.getElementById('nuevoAsientoCuenta')
    if (select) {
      select.innerHTML = '<option value="">-- Cuenta --</option>'
      cuentas.sort((a,b) => String(a.codigo).localeCompare(String(b.codigo)))
        .forEach(c => { select.innerHTML += `<option value="${c.codigo}">${c.codigo} - ${c.nombre}</option>` })
    }

    // Limpiar líneas previas
    document.getElementById('nuevoAsientoLineas').innerHTML = ''
    window._asientoLineas = []
    await window.agregarFilaLinea()
    await window.agregarFilaLinea()

    window.openModal('modal-nuevo-asiento')
  } catch (e) {
    showToast('Error al abrir modal: ' + e.message, 'danger')
  }
}

window._asientoLineas = []

window.agregarFilaLinea = async function() {
  const cuentas = await getAccounts()
  const idx = window._asientoLineas.length
  window._asientoLineas.push({ id: idx })

  const container = document.getElementById('nuevoAsientoLineas')
  const div = document.createElement('div')
  div.id = `fila-linea-${idx}`
  div.style.cssText = 'display:grid; grid-template-columns:2fr 1fr 1fr 1fr auto; gap:6px; margin-bottom:6px;'
  div.innerHTML = `
    <select id="linea-cuenta-${idx}">
      <option value="">-- Cuenta --</option>
      ${cuentas.sort((a,b)=>String(a.codigo).localeCompare(String(b.codigo)))
        .map(c=>`<option value="${c.codigo}">${c.codigo} - ${c.nombre}</option>`).join('')}
    </select>
    <select id="linea-tipo-${idx}">
      <option value="debe">Debe</option>
      <option value="haber">Haber</option>
    </select>
    <input id="linea-importe-${idx}" type="number" step="0.01" placeholder="Importe" min="0">
    <input id="linea-desc-${idx}" type="text" placeholder="Descripción">
    <button class="btn btn-small btn-danger" onclick="window.eliminarFilaLinea(${idx})">✕</button>
  `
  container.appendChild(div)
  actualizarTotalesAsiento()
}

window.eliminarFilaLinea = function(idx) {
  document.getElementById(`fila-linea-${idx}`)?.remove()
  actualizarTotalesAsiento()
}

function actualizarTotalesAsiento() {
  let debe = 0, haber = 0
  window._asientoLineas.forEach((l, idx) => {
    const fila = document.getElementById(`fila-linea-${idx}`)
    if (!fila) return
    const tipo   = document.getElementById(`linea-tipo-${idx}`)?.value
    const imp    = parseFloat(document.getElementById(`linea-importe-${idx}`)?.value || 0)
    if (tipo === 'debe')  debe  += imp
    if (tipo === 'haber') haber += imp
  })
  const totDebe  = document.getElementById('asiento-total-debe')
  const totHaber = document.getElementById('asiento-total-haber')
  const dif      = document.getElementById('asiento-diferencia')
  if (totDebe)  totDebe.textContent  = debe.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (totHaber) totHaber.textContent = haber.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (dif) {
    const diff = debe - haber
    dif.textContent = diff.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    dif.style.color = Math.abs(diff) < 0.01 ? 'var(--color-success)' : 'var(--color-danger)'
  }
}

window.guardarNuevoAsiento = async function() {
  try {
    const user    = await getCurrentUser()
    const fecha   = document.getElementById('nuevoAsientoFecha')?.value
    const desc    = document.getElementById('nuevoAsientoDesc')?.value?.trim()
    const periodo = document.getElementById('nuevoAsientoPeriodo')?.value
    const docRef  = document.getElementById('nuevoAsientoDocRef')?.value?.trim()

    if (!fecha || !desc) { showToast('Fecha y descripción son requeridos', 'warning'); return }

    const lineas = []
    let debe = 0, haber = 0

    for (let idx = 0; idx < 50; idx++) {
      const fila = document.getElementById(`fila-linea-${idx}`)
      if (!fila) continue
      const cuenta = document.getElementById(`linea-cuenta-${idx}`)?.value
      const tipo   = document.getElementById(`linea-tipo-${idx}`)?.value
      const imp    = parseFloat(document.getElementById(`linea-importe-${idx}`)?.value || 0)
      const descL  = document.getElementById(`linea-desc-${idx}`)?.value || ''
      if (!cuenta || !tipo || imp <= 0) continue
      lineas.push({ cuenta_codigo: cuenta, tipo, importe: imp, descripcion: descL || desc })
      if (tipo === 'debe')  debe  += imp
      if (tipo === 'haber') haber += imp
    }

    if (lineas.length < 2) { showToast('El asiento debe tener al menos 2 líneas', 'warning'); return }
    if (Math.abs(debe - haber) > 0.01) {
      showToast(`El asiento no cuadra. Debe: ${debe.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / Haber: ${haber.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 'danger')
      return
    }

    await crearAsientoContable({
      fecha, descripcion: desc, periodo_contable: periodo || fecha.slice(0,7),
      tipo_movimiento: 'Manual', tipo_documento: null,
      documento_referencia: docRef || null,
      origen_tipo: 'manual',
      created_by: user?.id, lineas
    })

    showToast('Asiento creado y confirmado', 'success')
    window.closeModal('modal-nuevo-asiento')
    window._asientoLineas = []
    await renderLibroDiario()
    await renderPlanCuentas()
  } catch (e) {
    console.error('guardarNuevoAsiento:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

// Escuchar cambios de importe para actualizar totales en tiempo real
document.addEventListener('input', e => {
  if (e.target?.id?.startsWith('linea-importe-') || e.target?.id?.startsWith('linea-tipo-')) {
    actualizarTotalesAsiento()
  }
})

window.reversarAsientoUI = async function(entryId) {
  const motivo = prompt('Motivo de la reversión:')
  if (motivo === null) return
  if (!motivo.trim()) { showToast('Ingresa un motivo', 'warning'); return }

  try {
    const user   = await getCurrentUser()
    const newId  = await reversarAsiento(entryId, user?.id, motivo)
    showToast(`Reversión creada: asiento AS-${String(newId).padStart(6,'0')}`, 'success')
    await renderLibroDiario()
    await renderPlanCuentas()
  } catch (e) {
    showToast('Error al reversar: ' + e.message, 'danger')
  }
}

// ============================================================================
// 9. COBROS Y PAGOS (resumen para la pestaña)
// ============================================================================

async function renderCobrosPagos() {
  try {
    const container = document.getElementById('content-cobrospagos')
    if (!container) return

    const [cxcList, pagosProv] = await Promise.all([
      getCuentasCobrar(),
      getPagosProveedores()
    ])

    const pendCxC = cxcList.filter(c => c.estado === 'pendiente' || c.estado === 'parcial')
    const totalCxC = pendCxC.reduce((s, c) => s + parseFloat(c.monto_total || 0) - parseFloat(c.monto_cobrado || 0), 0)

    container.innerHTML = `
      <div class="card-header">
        <h3 class="card-title">Cobros y Pagos</h3>
        <a href="cobranzas.html" class="btn btn-primary btn-small">Ir a Cobranzas →</a>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px; padding:15px;">
        <div class="card" style="padding:15px;">
          <h4>Cuentas por Cobrar (pendientes)</h4>
          <p style="font-size:1.5rem; font-weight:bold; color:var(--color-success);">S/ ${totalCxC.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
          <p style="color:var(--text-secondary);">${pendCxC.length} documentos pendientes</p>
        </div>
        <div class="card" style="padding:15px;">
          <h4>Últimos Pagos a Proveedores</h4>
          ${pagosProv.slice(-5).reverse().map(p => `
            <div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid var(--border-color);">
              <span>${p.fecha} — ${p.medio_pago}</span>
              <strong>S/ ${parseFloat(p.monto).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
            </div>
          `).join('') || '<p style="color:var(--text-secondary);">Sin pagos registrados</p>'}
        </div>
      </div>
    `
  } catch (error) {
    console.error('Error en renderCobrosPagos:', error)
    showToast('Error al cargar cobros y pagos', 'danger')
  }
}

// ============================================================================
// 10. PERIODOS CONTABLES
// ============================================================================

async function renderPeriodosContables() {
  try {
    const periodos  = await getPeriodosContables()
    const container = document.getElementById('content-periodos')
    if (!container) return

    let html = `
      <div class="card-header">
        <h3 class="card-title">Períodos Contables</h3>
        <button class="btn btn-primary btn-small" onclick="window.abrirPeriodo()">+ Abrir Período</button>
      </div>
      <div class="table-container">
        <table>
          <thead><tr>
            <th>Período</th><th>Año</th><th>Mes</th><th>Estado</th>
            <th>Fecha Cierre</th><th>Acciones</th>
          </tr></thead>
          <tbody>
    `

    const meses = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']

    periodos.sort((a,b) => b.periodo.localeCompare(a.periodo)).forEach(p => {
      html += `
        <tr>
          <td><strong>${p.periodo}</strong></td>
          <td>${p.ano}</td>
          <td>${meses[p.mes] || p.mes}</td>
          <td><span class="badge badge-${p.estado === 'abierto' ? 'success' : 'danger'}">${p.estado}</span></td>
          <td>${p.fecha_cierre || '—'}</td>
          <td>
            ${p.estado === 'abierto'
              ? `<button class="btn btn-small btn-warning" onclick="window.cerrarPeriodoUI('${p.periodo}', ${p.id})">Cerrar</button>`
              : `<button class="btn btn-small btn-secondary" onclick="window.reabrirPeriodoUI('${p.periodo}', ${p.id})">Re-abrir</button>`}
          </td>
        </tr>
      `
    })

    html += '</tbody></table></div>'
    container.innerHTML = html
  } catch (error) {
    console.error('renderPeriodosContables:', error)
    showToast('Error al cargar períodos', 'danger')
  }
}

window.cerrarPeriodoUI = async function(periodo, id) {
  if (!confirm(`¿Cerrar el período ${periodo}? No se podrán registrar más asientos en este período.`)) return
  try {
    const user = await getCurrentUser()
    await updatePeriodoContable(id, {
      estado: 'cerrado',
      fecha_cierre: new Date().toISOString().split('T')[0],
      cerrado_por: user?.id
    })
    showToast(`Período ${periodo} cerrado`, 'success')
    await renderPeriodosContables()
  } catch (e) { showToast('Error: ' + e.message, 'danger') }
}

window.reabrirPeriodoUI = async function(periodo, id) {
  if (!confirm(`¿Re-abrir el período ${periodo}? Solo hazlo si tienes autorización.`)) return
  try {
    await updatePeriodoContable(id, { estado: 'abierto', fecha_cierre: null, cerrado_por: null })
    showToast(`Período ${periodo} re-abierto`, 'success')
    await renderPeriodosContables()
  } catch (e) { showToast('Error: ' + e.message, 'danger') }
}

window.abrirPeriodo = async function() {
  const periodo = prompt('Ingresa el período a abrir (YYYY-MM):',
    new Date().toISOString().slice(0,7))
  if (!periodo || !/^\d{4}-\d{2}$/.test(periodo)) {
    showToast('Formato inválido. Usa YYYY-MM', 'warning')
    return
  }
  const [ano, mes] = periodo.split('-').map(Number)
  try {
    await addPeriodoContable({ periodo, ano, mes, estado: 'abierto' })
    showToast(`Período ${periodo} abierto`, 'success')
    await renderPeriodosContables()
  } catch (e) { showToast('Error: ' + e.message, 'danger') }
}