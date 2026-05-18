// ============================================================================
// CONTABILIDAD.JS - Módulo Contabilidad (Versión Async/Await)
// ============================================================================

import { getCurrentUser } from './auth-supabase.js'
import { getJournalEntries, getAccounts, calcularBalancesCuentas } from './supabase-data.js'
import { showToast } from './helpers.js'

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const user = getCurrentUser()
    const userDisplay = document.getElementById('userDisplay')
    if (userDisplay && user) {
      userDisplay.textContent = user.nombre || user.username
    }

    initTabsContabilidad()
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

      if (tab === 'cuentas') await renderPlanCuentas()
      if (tab === 'diario') await renderLibroDiario()
      if (tab === 'balance') await renderBalanceComprobacion()
      if (tab === 'resultado') await renderEstadoResultados()
      if (tab === 'general') await renderBalanceGeneral()
    })
  })
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
        const saldoColor = c.balance > 0 ? 'color: var(--color-success)' : ''
        html += `
          <tr>
            <td><strong>${c.code || c.numero}</strong></td>
            <td>${c.name || c.nombre}</td>
            <td>${c.type || c.tipo}</td>
            <td>${(c.debit || c.debe || 0).toFixed(2)}</td>
            <td>${(c.credit || c.haber || 0).toFixed(2)}</td>
            <td style="${saldoColor}; font-weight: bold;">${(c.balance || 0).toFixed(2)}</td>
          </tr>
        `
      })
    } else {
      html += '<tr><td colspan="6" style="text-align: center;">Sin cuentas</td></tr>'
    }

    html += '</tbody></table></div>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderPlanCuentas:', error)
    showToast('Error al cargar plan de cuentas', 'danger')
  }
}

// ============================================================================
// 2. LIBRO DIARIO
// ============================================================================

async function renderLibroDiario() {
  try {
    const entries = await getJournalEntries()
    const container = document.getElementById('content-diario')

    if (!container) return

    if (!entries || entries.length === 0) {
      container.innerHTML = '<p style="padding: 20px; text-align: center; color: var(--text-secondary);">Sin asientos contables</p>'
      return
    }

    let html = `
      <div class="card-header">
        <h3 class="card-title">Libro Diario</h3>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Descripción</th>
              <th>Documento</th>
              <th>Debe</th>
              <th>Haber</th>
              <th>Usuario</th>
            </tr>
          </thead>
          <tbody>
    `

    for (const entry of entries) {
      html += `
        <tr style="border-bottom: 1px solid var(--border-color);">
          <td><strong>${window.formatDate(entry.fecha)}</strong></td>
          <td>${entry.descripcion || '-'}</td>
          <td>${entry.documento_referencia || '-'}</td>
          <td>${(entry.total_debe || 0).toFixed(2)}</td>
          <td>${(entry.total_haber || 0).toFixed(2)}</td>
          <td>${entry.user || '-'}</td>
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
        const debe = c.debit || c.debe || 0
        const haber = c.credit || c.haber || 0
        totalDebe += debe
        totalHaber += haber

        html += `
          <tr>
            <td><strong>${c.code || c.numero}</strong></td>
            <td>${c.name || c.nombre}</td>
            <td style="text-align: right;">${debe.toFixed(2)}</td>
            <td style="text-align: right;">${haber.toFixed(2)}</td>
          </tr>
        `
      })
    }

    html += `
        </tbody>
        <tfoot>
          <tr style="border-top: 2px solid var(--border-color); font-weight: bold;">
            <td colspan="2">TOTALES</td>
            <td style="text-align: right;">${totalDebe.toFixed(2)}</td>
            <td style="text-align: right;">${totalHaber.toFixed(2)}</td>
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

    // Filtrar cuentas de ingresos y gastos
    const ingresos = cuentas.filter(c => (c.type || c.tipo) === 'Ingreso') || []
    const gastos = cuentas.filter(c => (c.type || c.tipo) === 'Gasto') || []

    const totalIngresos = ingresos.reduce((sum, c) => sum + (c.credit || c.haber || 0), 0)
    const totalGastos = gastos.reduce((sum, c) => sum + (c.debit || c.debe || 0), 0)
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
            <td style="padding-left: 20px;">${c.name || c.nombre}</td>
            <td style="text-align: right;">${(c.credit || c.haber || 0).toFixed(2)}</td>
          </tr>
        `
      })
    }

    html += `
            <tr style="border-bottom: 1px solid var(--border-color); background-color: var(--bg-secondary);">
              <td><strong>Total Ingresos</strong></td>
              <td style="text-align: right;"><strong>${totalIngresos.toFixed(2)}</strong></td>
            </tr>
            <tr style="border-bottom: 1px solid var(--border-color); font-weight: bold;">
              <td colspan="2">GASTOS</td>
            </tr>
    `

    if (gastos.length > 0) {
      gastos.forEach(c => {
        html += `
          <tr>
            <td style="padding-left: 20px;">${c.name || c.nombre}</td>
            <td style="text-align: right;">${(c.debit || c.debe || 0).toFixed(2)}</td>
          </tr>
        `
      })
    }

    html += `
            <tr style="border-bottom: 1px solid var(--border-color); background-color: var(--bg-secondary);">
              <td><strong>Total Gastos</strong></td>
              <td style="text-align: right;"><strong>${totalGastos.toFixed(2)}</strong></td>
            </tr>
            <tr style="border-top: 2px solid var(--border-color); background-color: ${utilidad > 0 ? '#d1f2d1' : '#ffd1d1'}; font-weight: bold;">
              <td>UTILIDAD NETA</td>
              <td style="text-align: right;">${utilidad.toFixed(2)}</td>
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
// 5. BALANCE GENERAL
// ============================================================================

async function renderBalanceGeneral() {
  try {
    const cuentas = await calcularBalancesCuentas()
    const container = document.getElementById('content-general')

    if (!container) return

    // Filtrar tipos de cuentas
    const activos = cuentas.filter(c => (c.type || c.tipo) === 'Activo') || []
    const pasivos = cuentas.filter(c => (c.type || c.tipo) === 'Pasivo') || []
    const patrimonio = cuentas.filter(c => (c.type || c.tipo) === 'Patrimonio') || []

    const totalActivos = activos.reduce((sum, c) => sum + (c.debit || c.debe || 0), 0)
    const totalPasivos = pasivos.reduce((sum, c) => sum + (c.credit || c.haber || 0), 0)
    const totalPatrimonio = patrimonio.reduce((sum, c) => sum + (c.credit || c.haber || 0), 0)

    let html = `
      <div class="card-header">
        <h3 class="card-title">Balance General</h3>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
        <div>
          <div class="table-container">
            <table>
              <thead>
                <tr style="border-bottom: 2px solid var(--border-color);">
                  <th colspan="2">ACTIVOS</th>
                </tr>
              </thead>
              <tbody>
    `

    if (activos.length > 0) {
      activos.forEach(c => {
        html += `
          <tr>
            <td>${c.name || c.nombre}</td>
            <td style="text-align: right;">${(c.debit || c.debe || 0).toFixed(2)}</td>
          </tr>
        `
      })
    }

    html += `
                <tr style="background-color: var(--bg-secondary); font-weight: bold; border-top: 2px solid var(--border-color);">
                  <td>TOTAL ACTIVOS</td>
                  <td style="text-align: right;">${totalActivos.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <div class="table-container">
            <table>
              <thead>
                <tr style="border-bottom: 2px solid var(--border-color);">
                  <th colspan="2">PASIVO + PATRIMONIO</th>
                </tr>
              </thead>
              <tbody>
    `

    if (pasivos.length > 0) {
      html += '<tr style="font-weight: bold;"><td colspan="2">PASIVOS</td></tr>'
      pasivos.forEach(c => {
        html += `
          <tr>
            <td style="padding-left: 10px;">${c.name || c.nombre}</td>
            <td style="text-align: right;">${(c.credit || c.haber || 0).toFixed(2)}</td>
          </tr>
        `
      })
    }

    if (patrimonio.length > 0) {
      html += '<tr style="font-weight: bold; border-top: 1px solid var(--border-color);"><td colspan="2">PATRIMONIO</td></tr>'
      patrimonio.forEach(c => {
        html += `
          <tr>
            <td style="padding-left: 10px;">${c.name || c.nombre}</td>
            <td style="text-align: right;">${(c.credit || c.haber || 0).toFixed(2)}</td>
          </tr>
        `
      })
    }

    html += `
                <tr style="background-color: var(--bg-secondary); font-weight: bold; border-top: 2px solid var(--border-color);">
                  <td>TOTAL PASIVO + PATRIMONIO</td>
                  <td style="text-align: right;">${(totalPasivos + totalPatrimonio).toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `

    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderBalanceGeneral:', error)
    showToast('Error al cargar balance general', 'danger')
  }
}
// (Duplicated block removed - `renderLibroDiario` is defined earlier and used)

// ============================================================================
// 3. BALANCE DE COMPROBACIÓN
// ============================================================================
// ============================================================================
// 3. BALANCE DE COMPROBACIÓN
// ============================================================================
/*
function renderBalanceComprobacion() {
  const cuentas = calcularBalancesCuentas();
  
  let totalDebe = 0;
  let totalHaber = 0;
  
  let html = `
    <div class="card-header">
      <h3 class="card-title">Balance de Comprobación</h3>
    </div>
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Código</th>
            <th>Cuenta</th>
            <th>Tipo</th>
            <th>Debe</th>
            <th>Haber</th>
          </tr>
        </thead>
        <tbody>
  `;

  cuentas.forEach(c => {
    let debe = 0, haber = 0;
    
    if (['activo', 'gasto', 'costo'].includes(c.type)) {
      debe = c.balance > 0 ? c.balance : 0;
      haber = c.balance < 0 ? Math.abs(c.balance) : 0;
    } else {
      haber = c.balance > 0 ? c.balance : 0;
      debe = c.balance < 0 ? Math.abs(c.balance) : 0;
    }
    
    totalDebe += debe;
    totalHaber += haber;

    html += `
      <tr>
        <td>${c.code}</td>
        <td>${c.name}</td>
        <td>${c.type}</td>
        <td>${debe.toFixed(2)}</td>
        <td>${haber.toFixed(2)}</td>
      </tr>
    `;
  });

  const diferencia = Math.abs(totalDebe - totalHaber);
  const balanceado = diferencia < 0.01;

  html += `
      </tbody>
      <tfoot>
        <tr style="border-top: 2px solid var(--border-color); font-weight: bold;">
          <td colspan="3">TOTALES</td>
          <td>${totalDebe.toFixed(2)}</td>
          <td>${totalHaber.toFixed(2)}</td>
        </tr>
      </tfoot>
    </table>
  </div>
  <div style="margin-top: 20px; padding: 15px; background-color: ${balanceado ? '#dcfce7' : '#fee2e2'}; border-radius: 8px; color: ${balanceado ? '#166534' : '#991b1b'}; font-weight: bold;">
    ${balanceado ? '✓ Balance Balanceado' : '✗ Balance Desbalanceado (Diferencia: ' + diferencia.toFixed(2) + ')'}
  </div>
  `;

  document.getElementById('content-balance').innerHTML = html;
}

// ============================================================================
// 4. ESTADO DE RESULTADOS
// ============================================================================

function renderEstadoResultados() {
  const cuentas = calcularBalancesCuentas();
  
  const ingresos = cuentas.filter(c => c.type === 'ingreso').reduce((s, c) => s + c.balance, 0);
  const costos = cuentas.filter(c => c.type === 'costo').reduce((s, c) => s + c.balance, 0);
  const gastos = cuentas.filter(c => c.type === 'gasto').reduce((s, c) => s + c.balance, 0);
  
  const utilidadBruta = ingresos - costos;
  const utilidadFinal = utilidadBruta - gastos;

  let html = `
    <div style="padding: 20px;">
      <h3 style="margin-bottom: 20px;">ESTADO DE RESULTADOS</h3>
      
      <div style="margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid var(--border-color);">
        <p style="margin-bottom: 10px;"><strong>Ingresos por Ventas:</strong></p>
        <p style="margin-left: 20px; font-size: 18px; color: var(--color-success); font-weight: bold;">S/. ${ingresos.toFixed(2)}</p>
      </div>

      <div style="margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid var(--border-color);">
        <p style="margin-bottom: 10px;"><strong>(-) Costo de Ventas:</strong></p>
        <p style="margin-left: 20px; font-size: 18px; color: var(--color-danger); font-weight: bold;">S/. ${costos.toFixed(2)}</p>
      </div>

      <div style="margin-bottom: 20px; padding: 15px; background-color: var(--bg-secondary); border-radius: 8px;">
        <p style="margin-bottom: 10px;"><strong>= Utilidad Bruta:</strong></p>
        <p style="margin-left: 20px; font-size: 18px; font-weight: bold; color: ${utilidadBruta >= 0 ? 'var(--color-success)' : 'var(--color-danger)'};">S/. ${utilidadBruta.toFixed(2)}</p>
      </div>

      <div style="margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid var(--border-color);">
        <p style="margin-bottom: 10px;"><strong>(-) Gastos Operativos:</strong></p>
        <p style="margin-left: 20px; font-size: 18px; color: var(--color-danger); font-weight: bold;">S/. ${gastos.toFixed(2)}</p>
      </div>

      <div style="padding: 15px; background-color: var(--bg-secondary); border-radius: 8px; border: 2px solid var(--border-color);">
        <p style="margin-bottom: 10px;"><strong>= UTILIDAD NETA:</strong></p>
        <p style="margin-left: 20px; font-size: 20px; font-weight: bold; color: ${utilidadFinal >= 0 ? 'var(--color-success)' : 'var(--color-danger)'};">S/. ${utilidadFinal.toFixed(2)}</p>
      </div>
    </div>
  `;

  document.getElementById('content-resultado').innerHTML = html;
}*/
