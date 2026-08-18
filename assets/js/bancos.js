// ============================================================================
// BANCOS.JS — Tesorería: cuentas bancarias, movimientos, transferencias,
// conciliación, reportes y configuración.
// ============================================================================
// Fase 2: el saldo de cada cuenta se mantiene al día tanto por los
// movimientos registrados aquí como por los cobros/pagos hechos en el módulo
// Cuentas x Cobrar/Pagar (que ahora sí escriben en `movimientos_banco`).
// ============================================================================

import { getCurrentUser } from './auth-supabase.js'
import {
  getBancos, addBanco, updateBanco, deleteBanco,
  getMovimientosBanco, addMovimientoBanco, updateMovimientoBanco, deleteMovimientoBanco,
  getCuentasCobrar, getCuentasPagar, getAccounts
} from './supabase-data.js'
import { showToast, formatNumber } from './helpers.js'
import { initModuleNavDropdowns, initSubtabs } from './main.js'
import { getModuloConfig, renderConfiguracionTab, aplicarPreferenciasVista } from './config-modulo.js'
import { cacheado, invalidarVarios } from './data-cache.js'
import { crearReporte, nombreMes, descargarCSV } from './reportes.js'
import { convertirVarios, refrescarBuscador } from './buscador-select.js'

const MODULO = 'bancos'

// Lista fija en JS (no en Supabase): bancos, financieras y cajas municipales
// que operan en Perú, para el datalist del campo "Banco" en Nueva Cuenta.
// El campo sigue siendo texto libre (autocompletar, no obliga a elegir de
// aquí) por si aparece uno nuevo o el usuario prefiere escribir distinto.
const BANCOS_PERU = [
  'Banco de Crédito del Perú (BCP)',
  'BBVA Perú',
  'Interbank',
  'Scotiabank Perú',
  'BanBif',
  'Banco Pichincha',
  'Banco GNB Perú',
  'Banco Falabella Perú',
  'Banco Ripley',
  'Banco Santander Perú',
  'Mibanco',
  'Banco de Comercio',
  'Citibank Perú',
  'Banco ICBC Perú',
  'Alfin Banco',
  'Banco de la Nación',
  'COFIDE',
  'Financiera Confianza',
  'Financiera Efectiva',
  'Financiera OH!',
  'Financiera Proempresa',
  'Financiera Qapaq',
  'Compartamos Financiera',
  'Caja Municipal de Ahorro y Crédito de Arequipa (Caja Arequipa)',
  'Caja Municipal de Ahorro y Crédito de Trujillo (Caja Trujillo)',
  'Caja Municipal de Ahorro y Crédito de Piura (Caja Piura)',
  'Caja Municipal de Ahorro y Crédito de Cusco (Caja Cusco)',
  'Caja Municipal de Ahorro y Crédito de Sullana (Caja Sullana)',
  'Caja Municipal de Ahorro y Crédito de Huancayo (Caja Huancayo)',
  'Caja Municipal de Ahorro y Crédito de Ica (Caja Ica)',
  'Caja Municipal de Ahorro y Crédito de Maynas (Caja Maynas)',
  'Caja Municipal de Ahorro y Crédito de Tacna (Caja Tacna)',
  'Caja Municipal de Ahorro y Crédito de Paita (Caja Paita)',
  'Caja Municipal de Crédito Popular de Lima (Caja Metropolitana)',
  'Caja Rural de Ahorro y Crédito Los Andes',
  'Caja Rural de Ahorro y Crédito Prymera',
  'Caja Rural de Ahorro y Crédito Incasur',
  'Caja Rural de Ahorro y Crédito Raíz',
  'Edpyme Acceso Crediticio',
  'Edpyme Alternativa',
  'Edpyme Marcimex',
  'Edpyme Santander Consumo Perú'
]

function _poblarListaBancosPeru() {
  const dl = document.getElementById('listaBancosPeru')
  if (!dl) return
  dl.innerHTML = BANCOS_PERU.map(b => `<option value="${b.replace(/"/g, '&quot;')}"></option>`).join('')
}

let _cfg        = getModuloConfig(MODULO)
let _bancos     = []
let _bancosMap  = {}
let _movimientos = []        // todos los movimientos (para reportes y KPIs)
let _movFiltrados = []
let _reportesListos = {}
let _editandoBancoId = null
let _planCuentas = []

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
    initModuleNavDropdowns('#bancosTabs')
    initSubtabs('#banco-subtabs-reportes', (panel) => construirReporte(panel))
    convertirVarios([
      { id: 'movBancoSelect',    placeholder: 'Todas las cuentas — escribe para filtrar...', sinResultados: 'Sin cuentas' },
      { id: 'concBancoSelect',   placeholder: 'Escribe el banco o N° de cuenta...',          sinResultados: 'Sin cuentas' },
      { id: 'movBancoId',        placeholder: 'Escribe el banco o N° de cuenta...',          sinResultados: 'Sin cuentas' },
      { id: 'trfOrigen',         placeholder: 'Cuenta de origen...',                         sinResultados: 'Sin cuentas' },
      { id: 'trfDestino',        placeholder: 'Cuenta de destino...',                        sinResultados: 'Sin cuentas' },
      { id: 'ncCuentaContable',  placeholder: 'Escribe el código o nombre de la cuenta...',  sinResultados: 'Sin cuentas contables' }
    ])
    await _cargarPlanCuentasParaBanco()
    _poblarListaBancosPeru()

    const hoy    = new Date().toISOString().split('T')[0]
    const hoyMes = hoy.slice(0, 7)
    _valor('movFecha', hoy)
    _valor('trfFecha', hoy)
    _valor('movFiltroMes', hoyMes)
    _valor('concFiltroMes', hoyMes)

    renderConfiguracionTab(MODULO, 'banco-config-container', {
      onGuardar: () => { _cfg = getModuloConfig(MODULO); showToast('Configuración guardada ✅', 'success') }
    })

    await cargarCuentasBancarias()
    await cargarTodosLosMovimientos()
    window.cargarMovimientos()
    calcularKPIs()
  } catch (e) {
    console.error('bancos DOMContentLoaded:', e)
    showToast('Error al cargar módulo de bancos: ' + e.message, 'danger')
  }
})

function initTabs() {
  const btns     = document.querySelectorAll('#bancosTabs .tab-btn')
  const contents = document.querySelectorAll('.tab-content')
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      btns.forEach(b => b.classList.remove('active'))
      contents.forEach(c => c.classList.remove('active'))
      btn.classList.add('active')
      const nombre = btn.getAttribute('data-tab')
      document.getElementById(`tab-${nombre}`)?.classList.add('active')
      if (nombre === 'reportes') {
        const activo = document.querySelector('#banco-subtabs-reportes .subtab.active')?.getAttribute('data-sub') || 'repb-flujo'
        construirReporte(activo)
      }
    })
  })
}

window.irATabBanco = function(nombre) {
  document.querySelector(`#bancosTabs .tab-btn[data-tab="${nombre}"]`)?.click()
}

function _valor(id, v) { const el = document.getElementById(id); if (el) el.value = v }
function _set(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt }
function _simbolo(moneda) { return moneda === 'USD' ? '$' : 'S/' }
function _saldo(b) { return parseFloat(b.saldo_actual ?? b.saldo_inicial ?? 0) }

// ============================================================================
// CUENTAS BANCARIAS
// ============================================================================

/**
 * Plan de cuentas para el selector "Cuenta Contable" del formulario. Antes
 * ese campo era texto libre (`cuenta_contable_codigo`) sin validar contra
 * nada — con el plan de cuentas real ya cargado (script 06), eso permitía
 * escribir cualquier código inexistente o el genérico del grupo (104) en vez
 * de la subcuenta específica de ESE banco (1041120, 1041121, etc.).
 * Solo cuentas de tipo Activo (las de banco/caja lo son) para no mezclar con
 * gastos o ingresos en el selector.
 */
async function _cargarPlanCuentasParaBanco() {
  try {
    const todas = await cacheado('plan_cuentas', getAccounts)
    _planCuentas = (todas || [])
      .filter(c => c.activo !== false && c.tipo === 'Activo')
      .sort((a, b) => String(a.codigo).localeCompare(String(b.codigo)))

    _html('ncCuentaContable', '<option value="">-- Sin asignar --</option>' +
      _planCuentas.map(c => `<option value="${c.id}">${_esc(c.codigo)} — ${_esc(c.nombre)}</option>`).join(''))
    refrescarBuscador('ncCuentaContable')
  } catch (e) {
    console.warn('_cargarPlanCuentasParaBanco:', e.message)
  }
}

async function cargarCuentasBancarias() {
  try {
    _bancos = await cacheado('bancos', getBancos)
    _bancosMap = {}
    _bancos.forEach(b => { _bancosMap[b.id] = b })

    const opts = _bancos.map(b =>
      `<option value="${b.id}">${_esc(b.nombre)} — ${_esc(b.numero_cuenta)} (${b.moneda})</option>`
    ).join('')

    _html('movBancoSelect',  '<option value="">-- Todas las cuentas --</option>' + opts)
    _html('concBancoSelect', '<option value="">-- Seleccione cuenta --</option>' + opts)
    _html('movBancoId',      '<option value="">-- Seleccione --</option>' + opts)
    _html('trfOrigen',       '<option value="">-- Seleccione --</option>' + opts)
    _html('trfDestino',      '<option value="">-- Seleccione --</option>' + opts)
    ;['movBancoSelect','concBancoSelect','movBancoId','trfOrigen','trfDestino'].forEach(refrescarBuscador)

    const container = document.getElementById('content-cuentas-banco')
    if (!container) return

    if (_bancos.length === 0) {
      container.innerHTML = `
        <div style="text-align:center; padding:40px;">
          <p style="color:var(--text-secondary);">No hay cuentas bancarias registradas.</p>
          <button class="btn btn-primary" onclick="window.irATabBanco('nueva-cuenta')">+ Agregar primera cuenta</button>
        </div>`
      return
    }

    const alerta = parseFloat(_cfg.alertaSaldoBajo) || 0

    container.innerHTML = `
      <div class="card-header">
        <h3 class="card-title">Cuentas Bancarias (${_bancos.length})</h3>
        <button class="btn btn-primary btn-small" onclick="window.irATabBanco('nueva-cuenta')">+ Nueva Cuenta</button>
      </div>
      <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(290px,1fr)); gap:15px; padding:15px;">
        ${_bancos.map(b => {
          const saldo = _saldo(b)
          const bajo  = alerta > 0 && saldo < alerta
          const color = saldo < 0 ? 'var(--color-danger)' : (bajo ? 'var(--color-warning)' : 'var(--color-success)')
          const movs  = _movimientos.filter(m => m.banco_id === b.id).length
          return `
            <div class="card" style="padding:15px; cursor:pointer; ${bajo ? 'border-left:3px solid var(--color-warning);' : ''}" onclick="window.verMovimientosBanco(${b.id})">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
                <div>
                  <strong style="font-size:1rem;">${_esc(b.nombre)}</strong>
                  <div style="font-size:0.8rem; color:var(--text-secondary);">${_esc(b.banco)}</div>
                </div>
                <span class="badge badge-info">${b.moneda}</span>
              </div>
              <div style="font-size:0.8rem; color:var(--text-secondary); line-height:1.5;">
                Cta: ${_esc(b.numero_cuenta)}<br>
                ${b.cci ? `CCI: ${_esc(b.cci)}<br>` : ''}
                Tipo: ${_esc(b.tipo_cuenta || '-')} · ${movs} movimiento(s)
              </div>
              <div style="font-size:1.35rem; font-weight:bold; color:${color}; margin-top:10px;">
                ${_simbolo(b.moneda)} ${formatNumber(saldo)}
              </div>
              ${bajo ? `<div style="font-size:0.72rem; color:var(--color-warning);">⚠ Saldo bajo (alerta: ${formatNumber(alerta)})</div>` : ''}
              ${b.cuenta_contable_codigo ? `<div style="font-size:0.75rem; color:var(--text-secondary);">Cuenta contable: ${_esc(b.cuenta_contable_codigo)}</div>` : ''}
              ${b.saldo_inicial_fecha ? `<div style="font-size:0.72rem; color:var(--text-secondary);">Saldo inicial al ${_esc(b.saldo_inicial_fecha)}</div>` : ''}
              <div style="margin-top:10px; display:flex; gap:5px; flex-wrap:wrap;">
                <button class="btn btn-small btn-secondary" onclick="event.stopPropagation(); window.verMovimientosBanco(${b.id})">Movimientos</button>
                <button class="btn btn-small btn-warning"   onclick="event.stopPropagation(); window.editarBanco(${b.id})">Editar</button>
                <button class="btn btn-small btn-danger"    onclick="event.stopPropagation(); window.eliminarBanco(${b.id})">Eliminar</button>
              </div>
            </div>`
        }).join('')}
      </div>`
  } catch (e) {
    console.error('cargarCuentasBancarias:', e)
    showToast('Error al cargar cuentas bancarias: ' + e.message, 'danger')
  }
}

function _html(id, contenido) { const el = document.getElementById(id); if (el) el.innerHTML = contenido }

window.guardarNuevaCuenta = async function() {
  try {
    const nombre       = document.getElementById('ncNombre')?.value?.trim()
    const banco        = document.getElementById('ncBanco')?.value?.trim()
    const numeroCuenta = document.getElementById('ncNumeroCuenta')?.value?.trim()
    const cci          = document.getElementById('ncCCI')?.value?.trim()
    const tipoCuenta   = document.getElementById('ncTipoCuenta')?.value
    const moneda       = document.getElementById('ncMoneda')?.value
    const saldoInicial = parseFloat(document.getElementById('ncSaldoInicial')?.value || 0)
    const saldoInicialFecha = document.getElementById('ncSaldoInicialFecha')?.value || null
    const cuentaContableId = parseInt(document.getElementById('ncCuentaContable')?.value || 0) || null
    const cuentaContable = cuentaContableId ? _planCuentas.find(c => c.id === cuentaContableId) : null

    if (!nombre || !banco || !numeroCuenta) {
      showToast('Nombre, banco y número de cuenta son requeridos', 'warning'); return
    }
    if (saldoInicial !== 0 && !saldoInicialFecha) {
      showToast('Ingresa la fecha de corte del saldo inicial (ej. la de tu asiento de apertura)', 'warning'); return
    }

    if (_editandoBancoId) {
      // Al editar NO se toca saldo_actual desde el saldo inicial: se corregiría
      // solo con un movimiento de ajuste, para no romper la trazabilidad.
      await updateBanco(_editandoBancoId, {
        nombre, banco, numero_cuenta: numeroCuenta, cci: cci || null,
        tipo_cuenta: tipoCuenta, moneda, saldo_inicial: saldoInicial,
        saldo_inicial_fecha: saldoInicialFecha,
        cuenta_contable_id: cuentaContableId,
        cuenta_contable_codigo: cuentaContable?.codigo || null
      })
      showToast('Cuenta bancaria actualizada ✅', 'success')
    } else {
      await addBanco({
        nombre, banco, numero_cuenta: numeroCuenta, cci: cci || null,
        tipo_cuenta: tipoCuenta, moneda, saldo_inicial: saldoInicial,
        saldo_actual: saldoInicial, saldo_inicial_fecha: saldoInicialFecha,
        cuenta_contable_id: cuentaContableId,
        cuenta_contable_codigo: cuentaContable?.codigo || null
      })
      showToast('Cuenta bancaria creada ✅', 'success')
    }

    window.cancelarEdicionBanco()
    invalidarVarios(['bancos'])
    await cargarCuentasBancarias()
    calcularKPIs()
    window.irATabBanco('cuentas-banco')
  } catch (e) {
    showToast('Error: ' + e.message, 'danger')
  }
}

window.editarBanco = function(id) {
  const b = _bancosMap[id]
  if (!b) return
  _editandoBancoId = id
  _valor('ncId', id)
  _valor('ncNombre', b.nombre || '')
  _valor('ncBanco', b.banco || '')
  _valor('ncNumeroCuenta', b.numero_cuenta || '')
  _valor('ncCCI', b.cci || '')
  _valor('ncTipoCuenta', b.tipo_cuenta || 'corriente')
  _valor('ncMoneda', b.moneda || 'PEN')
  _valor('ncSaldoInicial', b.saldo_inicial ?? 0)
  _valor('ncSaldoInicialFecha', b.saldo_inicial_fecha || '')
  _valor('ncCuentaContable', b.cuenta_contable_id || '')
  refrescarBuscador('ncCuentaContable')
  _set('nc-titulo', `Editar cuenta: ${b.nombre}`)
  const btnC = document.getElementById('ncBtnCancelar'); if (btnC) btnC.style.display = ''
  window.irATabBanco('nueva-cuenta')
}

window.cancelarEdicionBanco = function() {
  _editandoBancoId = null
  ;['ncId', 'ncNombre', 'ncBanco', 'ncNumeroCuenta', 'ncCCI', 'ncCuentaContable', 'ncSaldoInicialFecha'].forEach(id => _valor(id, ''))
  refrescarBuscador('ncCuentaContable')
  _valor('ncSaldoInicial', 0)
  _set('nc-titulo', 'Nueva Cuenta Bancaria')
  const btnC = document.getElementById('ncBtnCancelar'); if (btnC) btnC.style.display = 'none'
}

window.eliminarBanco = async function(id) {
  const movs = _movimientos.filter(m => m.banco_id === id).length
  if (movs > 0) {
    showToast(`No se puede eliminar: la cuenta tiene ${movs} movimiento(s) registrado(s).`, 'warning')
    return
  }
  if (!confirm('¿Eliminar esta cuenta bancaria? Esta acción no se puede deshacer.')) return
  try {
    await deleteBanco(id)
    invalidarVarios(['bancos'])
    showToast('Cuenta eliminada', 'success')
    await cargarCuentasBancarias()
    calcularKPIs()
  } catch (e) { showToast('Error: ' + e.message, 'danger') }
}

// ============================================================================
// MOVIMIENTOS
// ============================================================================

async function cargarTodosLosMovimientos() {
  _movimientos = await cacheado('movimientos_banco', () => getMovimientosBanco())
  // Datalist de categorías ya usadas, para no escribirlas distinto cada vez.
  const cats = Array.from(new Set(_movimientos.map(m => m.categoria).filter(Boolean))).sort()
  _html('lista-categorias-banco', cats.map(c => `<option value="${_esc(c)}">`).join(''))
}

window.verMovimientosBanco = function(bancoId) {
  window.irATabBanco('movimientos')
  const sel = document.getElementById('movBancoSelect')
  if (sel) { sel.value = bancoId; window.cargarMovimientos() }
}

window.cargarMovimientos = function() {
  const bancoId  = document.getElementById('movBancoSelect')?.value
  const mes      = document.getElementById('movFiltroMes')?.value
  const tipo     = document.getElementById('movFiltroTipo')?.value
  const conc     = document.getElementById('movFiltroConc')?.value
  const buscar   = (document.getElementById('movBuscar')?.value || '').toLowerCase().trim()
  const container = document.getElementById('content-movimientos')
  if (!container) return

  let movs = [..._movimientos]
  if (bancoId) movs = movs.filter(m => m.banco_id === parseInt(bancoId))
  if (mes)     movs = movs.filter(m => (m.fecha || '').startsWith(mes))
  if (tipo)    movs = movs.filter(m => m.tipo === tipo)
  if (conc)    movs = movs.filter(m => conc === 'si' ? !!m.reconciliado : !m.reconciliado)
  if (buscar)  movs = movs.filter(m => `${m.concepto || ''} ${m.categoria || ''} ${m.referencia || ''}`.toLowerCase().includes(buscar))

  movs.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || b.id - a.id)
  _movFiltrados = movs

  const banco = bancoId ? _bancosMap[parseInt(bancoId)] : null
  const ingresos = movs.filter(m => m.tipo === 'ingreso').reduce((s, m) => s + parseFloat(m.monto || 0), 0)
  const egresos  = movs.filter(m => m.tipo === 'egreso').reduce((s, m) => s + parseFloat(m.monto || 0), 0)

  container.innerHTML = `
    <div class="card-header">
      <h3 class="card-title">${_esc(banco?.nombre || 'Todas las cuentas')} — ${movs.length} movimiento(s) ${mes || ''}</h3>
      <div style="display:flex; gap:14px; font-size:0.85rem; flex-wrap:wrap;">
        <span style="color:var(--color-success);">Ingresos: ${formatNumber(ingresos)}</span>
        <span style="color:var(--color-danger);">Egresos: ${formatNumber(egresos)}</span>
        <span style="color:var(--color-info); font-weight:bold;">Neto: ${formatNumber(ingresos - egresos)}</span>
      </div>
    </div>
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Fecha</th>${bancoId ? '' : '<th>Cuenta</th>'}<th>Tipo</th><th>Concepto</th><th>Categoría</th>
            <th>Referencia</th>
            <th style="text-align:right;">Ingreso</th>
            <th style="text-align:right;">Egreso</th>
            <th style="text-align:right;">Saldo Post.</th>
            <th style="text-align:center;">Conc.</th><th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${movs.length === 0
            ? `<tr><td colspan="${bancoId ? 10 : 11}" style="text-align:center; padding:30px; color:var(--text-secondary);">Sin movimientos para estos filtros.</td></tr>`
            : movs.map(m => {
                const esIngreso = m.tipo === 'ingreso'
                return `<tr>
                  <td>${m.fecha || '-'}</td>
                  ${bancoId ? '' : `<td>${_esc(_bancosMap[m.banco_id]?.nombre || '—')}</td>`}
                  <td><span class="badge ${esIngreso ? 'badge-success' : 'badge-danger'}">${m.tipo}</span></td>
                  <td>${_esc(m.concepto || '-')}</td>
                  <td>${_esc(m.categoria || '-')}</td>
                  <td>${_esc(m.referencia || '-')}</td>
                  <td style="text-align:right; color:var(--color-success);">${esIngreso ? formatNumber(m.monto) : ''}</td>
                  <td style="text-align:right; color:var(--color-danger);">${!esIngreso ? formatNumber(m.monto) : ''}</td>
                  <td style="text-align:right; font-weight:bold;">${m.saldo_posterior !== null && m.saldo_posterior !== undefined ? formatNumber(m.saldo_posterior) : '—'}</td>
                  <td style="text-align:center;">${m.reconciliado ? '✅' : '—'}</td>
                  <td style="white-space:nowrap;">
                    ${!m.reconciliado ? `<button class="btn btn-small btn-secondary" onclick="window.reconciliarMovimiento(${m.id})">Conciliar</button>` : ''}
                    <button class="btn btn-small btn-danger" onclick="window.eliminarMovimiento(${m.id})">✕</button>
                  </td>
                </tr>`
              }).join('')}
        </tbody>
      </table>
    </div>`
}

window.exportarMovimientos = function() {
  descargarCSV(`movimientos_bancarios_${new Date().toISOString().slice(0, 10)}.csv`, [
    ['Fecha', 'Cuenta', 'Tipo', 'Concepto', 'Categoría', 'Referencia', 'Monto', 'Saldo posterior', 'Conciliado'],
    ..._movFiltrados.map(m => [
      m.fecha || '', _bancosMap[m.banco_id]?.nombre || '', m.tipo || '',
      m.concepto || '', m.categoria || '', m.referencia || '',
      parseFloat(m.monto || 0).toFixed(2),
      m.saldo_posterior != null ? parseFloat(m.saldo_posterior).toFixed(2) : '',
      m.reconciliado ? 'Sí' : 'No'
    ])
  ])
}

window.abrirModalMovimiento = function() {
  const bancoId = document.getElementById('movBancoSelect')?.value
  if (bancoId) _valor('movBancoId', bancoId)
  _valor('movFecha', new Date().toISOString().split('T')[0])
  window.openModal('modal-movimiento-banco')
}

window.guardarMovimiento = async function() {
  try {
    const bancoId    = parseInt(document.getElementById('movBancoId')?.value || 0)
    const fecha      = document.getElementById('movFecha')?.value
    const tipo       = document.getElementById('movTipo')?.value
    const concepto   = document.getElementById('movConcepto')?.value?.trim()
    const categoria  = document.getElementById('movCategoria')?.value?.trim()
    const referencia = document.getElementById('movReferencia')?.value?.trim()
    const monto      = parseFloat(document.getElementById('movMonto')?.value || 0)

    if (!bancoId)   { showToast('Selecciona una cuenta bancaria', 'warning'); return }
    if (!fecha || !concepto || monto <= 0) { showToast('Fecha, concepto y monto son requeridos', 'warning'); return }

    const banco = _bancosMap[bancoId]
    const saldoPrevio = _saldo(banco)
    const saldoNuevo  = tipo === 'ingreso' ? saldoPrevio + monto : saldoPrevio - monto

    await addMovimientoBanco({
      banco_id: bancoId, fecha, tipo, concepto,
      categoria: categoria || null, referencia: referencia || null,
      monto, saldo_posterior: parseFloat(saldoNuevo.toFixed(2)),
      reconciliado: !!_cfg.autoConciliar
    })
    await updateBanco(bancoId, { saldo_actual: parseFloat(saldoNuevo.toFixed(2)) })

    showToast('Movimiento registrado ✅', 'success')
    window.closeModal('modal-movimiento-banco')
    ;['movConcepto', 'movCategoria', 'movReferencia', 'movMonto'].forEach(id => _valor(id, ''))

    await _recargarDatos()
  } catch (e) {
    showToast('Error: ' + e.message, 'danger')
  }
}

window.reconciliarMovimiento = async function(movId) {
  try {
    await updateMovimientoBanco(movId, { reconciliado: true })
    showToast('Movimiento conciliado ✅', 'success')
    await _recargarDatos()
  } catch (e) { showToast('Error: ' + e.message, 'danger') }
}

window.eliminarMovimiento = async function(movId) {
  const mov = _movimientos.find(m => m.id === movId)
  if (!mov) return
  if (!confirm(`¿Eliminar el movimiento "${mov.concepto}" de ${formatNumber(mov.monto)}?\n\nEl saldo de la cuenta se ajustará en sentido contrario.`)) return
  try {
    const banco = _bancosMap[mov.banco_id]
    if (banco) {
      const ajuste = mov.tipo === 'ingreso' ? -parseFloat(mov.monto || 0) : parseFloat(mov.monto || 0)
      await updateBanco(mov.banco_id, { saldo_actual: parseFloat((_saldo(banco) + ajuste).toFixed(2)) })
    }
    await deleteMovimientoBanco(movId)
    showToast('Movimiento eliminado', 'success')
    await _recargarDatos()
  } catch (e) { showToast('Error: ' + e.message, 'danger') }
}

async function _recargarDatos() {
  invalidarVarios(['bancos', 'movimientos_banco'])
  _reportesListos = {}
  await cargarCuentasBancarias()
  await cargarTodosLosMovimientos()
  window.cargarMovimientos()
  calcularKPIs()
}

// ============================================================================
// TRANSFERENCIAS ENTRE CUENTAS PROPIAS
// ============================================================================

window.onCambiarCuentaTransferencia = function() {
  const origenId  = parseInt(document.getElementById('trfOrigen')?.value || 0)
  const destinoId = parseInt(document.getElementById('trfDestino')?.value || 0)
  const o = _bancosMap[origenId], d = _bancosMap[destinoId]

  _set('trf-origen-info',  o ? `Saldo: ${_simbolo(o.moneda)} ${formatNumber(_saldo(o))}` : '')
  _set('trf-destino-info', d ? `Saldo: ${_simbolo(d.moneda)} ${formatNumber(_saldo(d))}` : '')

  const aviso = document.getElementById('trf-aviso')
  if (!aviso) return
  if (o && d && o.moneda !== d.moneda) {
    aviso.style.display = 'block'
    aviso.textContent = `⚠ Las cuentas tienen monedas distintas (${o.moneda} → ${d.moneda}). El monto se registrará tal cual en ambas; si necesitas conversión, registra dos movimientos manuales con el tipo de cambio correcto.`
  } else if (o && d && o.id === d.id) {
    aviso.style.display = 'block'
    aviso.textContent = '⚠ La cuenta origen y destino son la misma.'
  } else {
    aviso.style.display = 'none'
  }
}

window.registrarTransferencia = async function() {
  try {
    const origenId  = parseInt(document.getElementById('trfOrigen')?.value || 0)
    const destinoId = parseInt(document.getElementById('trfDestino')?.value || 0)
    const fecha     = document.getElementById('trfFecha')?.value
    const monto     = parseFloat(document.getElementById('trfMonto')?.value || 0)
    const concepto  = document.getElementById('trfConcepto')?.value?.trim() || 'Transferencia entre cuentas'
    const referencia = document.getElementById('trfReferencia')?.value?.trim()

    if (!origenId || !destinoId) { showToast('Selecciona cuenta origen y destino', 'warning'); return }
    if (origenId === destinoId)  { showToast('La cuenta origen y destino no pueden ser la misma', 'warning'); return }
    if (!fecha)     { showToast('Ingresa la fecha', 'warning'); return }
    if (monto <= 0) { showToast('El monto debe ser mayor a 0', 'warning'); return }

    const origen  = _bancosMap[origenId]
    const destino = _bancosMap[destinoId]
    const saldoOrigen = _saldo(origen)
    if (saldoOrigen < monto && !confirm(`La cuenta origen quedará en negativo (${formatNumber(saldoOrigen - monto)}). ¿Continuar?`)) return

    const nuevoOrigen  = parseFloat((saldoOrigen - monto).toFixed(2))
    const nuevoDestino = parseFloat((_saldo(destino) + monto).toFixed(2))

    await addMovimientoBanco({
      banco_id: origenId, fecha, tipo: 'egreso',
      concepto: `${concepto} → ${destino.nombre}`,
      categoria: 'Transferencia interna', referencia: referencia || null,
      monto, saldo_posterior: nuevoOrigen, reconciliado: !!_cfg.autoConciliar
    })
    await addMovimientoBanco({
      banco_id: destinoId, fecha, tipo: 'ingreso',
      concepto: `${concepto} ← ${origen.nombre}`,
      categoria: 'Transferencia interna', referencia: referencia || null,
      monto, saldo_posterior: nuevoDestino, reconciliado: !!_cfg.autoConciliar
    })
    await updateBanco(origenId,  { saldo_actual: nuevoOrigen })
    await updateBanco(destinoId, { saldo_actual: nuevoDestino })

    showToast('Transferencia registrada ✅', 'success')
    _valor('trfMonto', ''); _valor('trfConcepto', ''); _valor('trfReferencia', '')
    await _recargarDatos()
    window.onCambiarCuentaTransferencia()
  } catch (e) {
    console.error('registrarTransferencia:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

// ============================================================================
// KPIs
// ============================================================================

function calcularKPIs() {
  const pen = _bancos.filter(b => (b.moneda || 'PEN') === 'PEN')
  const usd = _bancos.filter(b => b.moneda === 'USD')
  _set('kpi-saldo-pen', `S/ ${formatNumber(pen.reduce((s, b) => s + _saldo(b), 0))}`)
  _set('kpi-saldo-usd', `$ ${formatNumber(usd.reduce((s, b) => s + _saldo(b), 0))}`)
  _set('kpi-saldo-pen-sub', `${pen.length} cuenta(s)`)
  _set('kpi-saldo-usd-sub', `${usd.length} cuenta(s)`)

  const mes = new Date().toISOString().slice(0, 7)
  const delMes = _movimientos.filter(m => (m.fecha || '').startsWith(mes))
  const ing = delMes.filter(m => m.tipo === 'ingreso').reduce((s, m) => s + parseFloat(m.monto || 0), 0)
  const egr = delMes.filter(m => m.tipo === 'egreso').reduce((s, m) => s + parseFloat(m.monto || 0), 0)
  _set('kpi-mov-mes', String(delMes.length))
  _set('kpi-mov-mes-sub', `+${formatNumber(ing)} / −${formatNumber(egr)}`)
  _set('kpi-sin-conciliar', String(_movimientos.filter(m => !m.reconciliado).length))
}

// ============================================================================
// CONCILIACIÓN
// ============================================================================

window.cargarConciliacion = function() {
  const bancoId    = document.getElementById('concBancoSelect')?.value
  const mes        = document.getElementById('concFiltroMes')?.value
  const saldoBanco = parseFloat(document.getElementById('concSaldoBanco')?.value || 0)
  const container  = document.getElementById('content-conciliacion')
  if (!container) return

  if (!bancoId) {
    container.innerHTML = '<p style="padding:30px; text-align:center; color:var(--text-secondary);">Selecciona una cuenta para conciliar.</p>'
    return
  }

  const banco = _bancosMap[parseInt(bancoId)]
  const todos = _movimientos.filter(m => m.banco_id === parseInt(bancoId))
  const movs  = mes ? todos.filter(m => (m.fecha || '').startsWith(mes)) : todos

  // El saldo del sistema para el mes se calcula sobre TODO el historial previo,
  // no solo el mes filtrado — de lo contrario el "saldo sistema" ignora los
  // meses anteriores y la diferencia siempre sale mal.
  const hastaFin = mes ? `${mes}-31` : '9999-12-31'
  const historicos = todos.filter(m => (m.fecha || '') <= hastaFin)
  const ingH = historicos.filter(m => m.tipo === 'ingreso').reduce((s, m) => s + parseFloat(m.monto || 0), 0)
  const egrH = historicos.filter(m => m.tipo === 'egreso').reduce((s, m) => s + parseFloat(m.monto || 0), 0)
  const saldoSistema = parseFloat(banco?.saldo_inicial || 0) + ingH - egrH
  const diferencia = saldoBanco - saldoSistema
  const cuadrado = Math.abs(diferencia) < 0.01

  const ingMes = movs.filter(m => m.tipo === 'ingreso').reduce((s, m) => s + parseFloat(m.monto || 0), 0)
  const egrMes = movs.filter(m => m.tipo === 'egreso').reduce((s, m) => s + parseFloat(m.monto || 0), 0)
  const sinConciliar = movs.filter(m => !m.reconciliado)

  container.innerHTML = `
    <div class="card-header">
      <h3 class="card-title">Conciliación — ${_esc(banco?.nombre || '')} ${mes || '(todo el historial)'}</h3>
      ${sinConciliar.length > 0 ? `<button class="btn btn-secondary btn-small" onclick="window.conciliarTodos()">✅ Conciliar todos (${sinConciliar.length})</button>` : ''}
    </div>
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px,1fr)); gap:14px; padding:15px;">
      ${_tarjeta('Saldo Inicial', formatNumber(banco?.saldo_inicial || 0))}
      ${_tarjeta('Ingresos del mes', '+' + formatNumber(ingMes), 'var(--color-success)')}
      ${_tarjeta('Egresos del mes', '−' + formatNumber(egrMes), 'var(--color-danger)')}
      ${_tarjeta('Saldo en Sistema', formatNumber(saldoSistema))}
      ${_tarjeta('Saldo según Banco', formatNumber(saldoBanco))}
      <div class="card" style="padding:12px; text-align:center; background:${cuadrado ? 'rgba(16,185,129,.1)' : 'rgba(239,68,68,.1)'};">
        <div style="font-size:0.75rem; color:var(--text-secondary);">Diferencia</div>
        <div style="font-size:1.3rem; font-weight:bold; color:${cuadrado ? 'var(--color-success)' : 'var(--color-danger)'};">
          ${cuadrado ? '✅ Cuadrado' : formatNumber(diferencia)}
        </div>
      </div>
    </div>
    ${sinConciliar.length > 0 ? `
      <div style="padding:0 15px 15px;">
        <h4 style="margin-bottom:8px;">Movimientos sin conciliar (${sinConciliar.length})</h4>
        <div class="table-container">
          <table>
            <thead><tr><th>Fecha</th><th>Tipo</th><th>Concepto</th><th style="text-align:right;">Monto</th><th>Acción</th></tr></thead>
            <tbody>
              ${sinConciliar.map(m => `<tr>
                <td>${m.fecha}</td>
                <td><span class="badge ${m.tipo === 'ingreso' ? 'badge-success' : 'badge-danger'}">${m.tipo}</span></td>
                <td>${_esc(m.concepto || '')}</td>
                <td style="text-align:right;">${formatNumber(m.monto)}</td>
                <td><button class="btn btn-small btn-secondary" onclick="window.reconciliarMovimiento(${m.id})">Conciliar</button></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`
    : '<p style="padding:20px; color:var(--color-success);">✅ Todos los movimientos del período están conciliados.</p>'}`
}

function _tarjeta(label, valor, color) {
  return `<div class="card" style="padding:12px; text-align:center;">
    <div style="font-size:0.75rem; color:var(--text-secondary);">${label}</div>
    <div style="font-size:1.2rem; font-weight:bold; ${color ? `color:${color};` : ''}">${valor}</div>
  </div>`
}

window.conciliarTodos = async function() {
  const bancoId = parseInt(document.getElementById('concBancoSelect')?.value || 0)
  const mes = document.getElementById('concFiltroMes')?.value
  let movs = _movimientos.filter(m => m.banco_id === bancoId && !m.reconciliado)
  if (mes) movs = movs.filter(m => (m.fecha || '').startsWith(mes))
  if (movs.length === 0) return
  if (!confirm(`¿Marcar ${movs.length} movimiento(s) como conciliados?`)) return
  try {
    for (const m of movs) await updateMovimientoBanco(m.id, { reconciliado: true })
    showToast(`${movs.length} movimiento(s) conciliados ✅`, 'success')
    await _recargarDatos()
    window.cargarConciliacion()
  } catch (e) { showToast('Error: ' + e.message, 'danger') }
}

// ============================================================================
// REPORTES
// ============================================================================

function construirReporte(panelId) {
  if (_reportesListos[panelId]) return
  _reportesListos[panelId] = true

  const base = _movimientos.map(m => ({
    mes: nombreMes((m.fecha || '').slice(0, 7)),
    cuenta: _bancosMap[m.banco_id]?.nombre || '(cuenta eliminada)',
    banco: _bancosMap[m.banco_id]?.banco || '—',
    moneda: _bancosMap[m.banco_id]?.moneda || 'PEN',
    tipo: m.tipo === 'ingreso' ? 'Ingreso' : 'Egreso',
    categoria: m.categoria || '(sin categoría)',
    concepto: m.concepto || '',
    conciliado: m.reconciliado ? 'Conciliado' : 'Sin conciliar',
    fecha: m.fecha || '',
    ingreso: m.tipo === 'ingreso' ? parseFloat(m.monto || 0) : 0,
    egreso:  m.tipo === 'egreso'  ? parseFloat(m.monto || 0) : 0,
    neto:    (m.tipo === 'ingreso' ? 1 : -1) * parseFloat(m.monto || 0)
  }))

  const medidasFlujo = [
    { key: 'ingreso', label: 'Ingresos', agg: 'sum', formato: 'money' },
    { key: 'egreso',  label: 'Egresos',  agg: 'sum', formato: 'money' },
    { key: 'neto',    label: 'Neto',     agg: 'sum', formato: 'money', semaforo: true }
  ]
  const filtrosComunes = [
    { key: 'cuenta', label: 'Cuenta', tipo: 'select', opciones: _bancos.map(b => b.nombre) },
    { key: 'tipo', label: 'Tipo', tipo: 'select', opciones: ['Ingreso', 'Egreso'] },
    { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['concepto', 'categoria'], placeholder: 'Concepto o categoría...' },
    { key: 'rango', label: 'Fecha', tipo: 'rango', campo: 'fecha' }
  ]
  const kpisFlujo = (f) => {
    const i = f.reduce((s, x) => s + x.ingreso, 0)
    const e = f.reduce((s, x) => s + x.egreso, 0)
    return [
      { label: 'Ingresos', valor: i, formato: 'money', color: 'var(--color-success)' },
      { label: 'Egresos', valor: e, formato: 'money', color: 'var(--color-danger)' },
      { label: 'Flujo neto', valor: i - e, formato: 'money', color: (i - e) >= 0 ? 'var(--color-success)' : 'var(--color-danger)' },
      { label: 'Movimientos', valor: f.length, formato: 'int' }
    ]
  }

  if (panelId === 'repb-flujo') {
    crearReporte('repb-flujo', {
      id: 'repb-flujo',
      titulo: 'Flujo de caja real por mes',
      descripcion: 'Entradas y salidas efectivamente registradas en las cuentas bancarias.',
      datos: base,
      dimensiones: [
        { key: 'mes', label: 'Mes' }, { key: 'cuenta', label: 'Cuenta' },
        { key: 'tipo', label: 'Tipo' }, { key: 'moneda', label: 'Moneda' }
      ],
      medidas: medidasFlujo, filtros: filtrosComunes,
      agruparPorDefecto: ['mes'], orden: { key: '_etiqueta', dir: 'asc' }, kpis: kpisFlujo
    })
  }

  if (panelId === 'repb-categorias') {
    crearReporte('repb-categorias', {
      id: 'repb-categorias',
      titulo: 'Movimientos por categoría',
      descripcion: 'En qué se va y de dónde entra el dinero. Usa categorías consistentes al registrar movimientos para que este reporte sirva.',
      datos: base,
      dimensiones: [
        { key: 'categoria', label: 'Categoría' }, { key: 'tipo', label: 'Tipo' },
        { key: 'mes', label: 'Mes' }, { key: 'cuenta', label: 'Cuenta' }
      ],
      medidas: medidasFlujo, filtros: filtrosComunes,
      agruparPorDefecto: ['categoria'], kpis: kpisFlujo
    })
  }

  if (panelId === 'repb-cuentas') {
    crearReporte('repb-cuentas', {
      id: 'repb-cuentas',
      titulo: 'Actividad por cuenta bancaria',
      descripcion: 'Compara el movimiento de cada cuenta y detecta cuáles están inactivas o sin conciliar.',
      datos: base,
      dimensiones: [
        { key: 'cuenta', label: 'Cuenta' }, { key: 'banco', label: 'Banco' },
        { key: 'conciliado', label: 'Conciliación' }, { key: 'mes', label: 'Mes' }
      ],
      medidas: medidasFlujo, filtros: filtrosComunes,
      agruparPorDefecto: ['cuenta'], kpis: kpisFlujo
    })
  }

  if (panelId === 'repb-posicion') construirPosicionTesoreria()
}

// Posición de tesorería: cruza el saldo real de bancos con lo que está por
// entrar (CxC abiertas) y por salir (CxP abiertas) para estimar la caja futura.
async function construirPosicionTesoreria() {
  try {
    const [cxc, cxp] = await Promise.all([
      cacheado('cuentas_cobrar', getCuentasCobrar),
      cacheado('cuentas_pagar', getCuentasPagar)
    ])

    const filas = []
    _bancos.forEach(b => filas.push({
      concepto: `Saldo en ${b.nombre}`, categoria: '1 · Disponible hoy',
      moneda: b.moneda || 'PEN', monto: _saldo(b), signo: 'Disponible'
    }))
    cxc.filter(c => c.estado !== 'cobrado' && c.estado !== 'anulado').forEach(c => {
      const saldo = parseFloat(c.monto_total || 0) - parseFloat(c.monto_cobrado || 0) - parseFloat(c.monto_retenido || 0)
      if (saldo > 0.01) filas.push({
        concepto: `Por cobrar ${c.serie || ''}-${c.numero_comprobante || ''}`, categoria: '2 · Por cobrar',
        moneda: c.moneda || 'PEN', monto: saldo, signo: 'Entrada'
      })
    })
    cxp.filter(c => c.estado !== 'pagado' && c.estado !== 'anulado').forEach(c => {
      const saldo = parseFloat(c.monto_total || 0) - parseFloat(c.monto_pagado || 0)
      if (saldo > 0.01) filas.push({
        concepto: `Por pagar ${c.serie || ''}-${c.numero_comprobante || ''}`, categoria: '3 · Por pagar',
        moneda: c.moneda || 'PEN', monto: -saldo, signo: 'Salida'
      })
    })

    crearReporte('repb-posicion', {
      id: 'repb-posicion',
      titulo: 'Posición de tesorería (disponible + por cobrar − por pagar)',
      descripcion: 'Foto de la caja: lo que hay hoy en bancos más lo que está por entrar, menos lo que está comprometido.',
      datos: filas,
      dimensiones: [
        { key: 'categoria', label: 'Concepto' }, { key: 'moneda', label: 'Moneda' }, { key: 'signo', label: 'Naturaleza' }
      ],
      medidas: [{ key: 'monto', label: 'Importe', agg: 'sum', formato: 'money', semaforo: true }],
      filtros: [
        { key: 'moneda', label: 'Moneda', tipo: 'select', opciones: ['PEN', 'USD'] },
        { key: 'signo', label: 'Naturaleza', tipo: 'select', opciones: ['Disponible', 'Entrada', 'Salida'] }
      ],
      agruparPorDefecto: ['categoria'], orden: { key: '_etiqueta', dir: 'asc' },
      kpis: (f) => {
        const disp = f.filter(x => x.signo === 'Disponible').reduce((s, x) => s + x.monto, 0)
        const ent  = f.filter(x => x.signo === 'Entrada').reduce((s, x) => s + x.monto, 0)
        const sal  = f.filter(x => x.signo === 'Salida').reduce((s, x) => s + x.monto, 0)
        return [
          { label: 'Disponible hoy', valor: disp, formato: 'money' },
          { label: 'Por cobrar', valor: ent, formato: 'money', color: 'var(--color-success)' },
          { label: 'Por pagar', valor: Math.abs(sal), formato: 'money', color: 'var(--color-danger)' },
          { label: 'Posición proyectada', valor: disp + ent + sal, formato: 'money', color: (disp + ent + sal) >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }
        ]
      }
    })
  } catch (e) {
    console.error('construirPosicionTesoreria:', e)
    const el = document.getElementById('repb-posicion')
    if (el) el.innerHTML = `<div class="card"><p class="reporte-vacio">No se pudo construir el reporte: ${_esc(e.message)}</p></div>`
  }
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
