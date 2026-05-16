// ============================================================================
// DASHBOARD-INIT.JS - Inicialización del Dashboard
// ============================================================================

import { getCurrentUser } from './auth-supabase.js'
import { getPurchaseOrders, getSalesQuotes, getJournalEntries, getAccounts, getContacts } from './supabase-data.js'
import { initTheme, initMenu } from './main.js'

document.addEventListener('DOMContentLoaded', async () => {
  try {
    // Inicializar tema y menú
    initTheme()
    initMenu()

    // Obtener usuario actual
    const user = getCurrentUser()
    if (user) {
      const userDisplay = document.getElementById('userDisplay')
      if (userDisplay) {
        userDisplay.textContent = user.nombre || user.username
      }
    }

    // Cargar datos del dashboard
    const oc = await getPurchaseOrders()
    const cot = await getSalesQuotes()
    const entries = await getJournalEntries()
    const accounts = await getAccounts()

    // KPIs
    const kpiOC = document.getElementById('kpi-oc')
    const kpiCot = document.getElementById('kpi-cot')
    const kpiAsientos = document.getElementById('kpi-asientos')
    const kpiCaja = document.getElementById('kpi-caja')

    if (kpiOC) kpiOC.textContent = oc.length || 0
    if (kpiCot) kpiCot.textContent = cot.length || 0
    if (kpiAsientos) kpiAsientos.textContent = entries.length || 0

    // Calcular saldo caja
    if (accounts && accounts.length > 0) {
      const caja = accounts.find(c => c.code === '101111')
      if (kpiCaja) {
        kpiCaja.textContent = 'S/. ' + ((caja?.balance || 0).toFixed(2))
      }
    }

    // Resumen financiero
    if (accounts && accounts.length > 0) {
      const activos = accounts
        .filter(c => c.type === 'activo')
        .reduce((s, c) => s + (c.balance || 0), 0)
      const pasivos = accounts
        .filter(c => c.type === 'pasivo')
        .reduce((s, c) => s + (c.balance || 0), 0)
      const patrimonio = accounts
        .filter(c => c.type === 'patrimonio')
        .reduce((s, c) => s + (c.balance || 0), 0)

      const totalActivos = document.getElementById('total-activos')
      const totalPasivos = document.getElementById('total-pasivos')
      const totalPatrimonio = document.getElementById('total-patrimonio')

      if (totalActivos) totalActivos.textContent = 'S/. ' + activos.toFixed(2)
      if (totalPasivos) totalPasivos.textContent = 'S/. ' + pasivos.toFixed(2)
      if (totalPatrimonio) totalPatrimonio.textContent = 'S/. ' + patrimonio.toFixed(2)
    }

    // Últimas OC
    const ultimasOC = document.getElementById('ultimas-oc')
    if (ultimasOC && oc.length > 0) {
      const contacts = await getContacts()
      let html = '<table><thead><tr><th>Número</th><th>Proveedor</th><th>Total</th><th>Usuario</th><th>Estado</th></tr></thead><tbody>'
      oc.slice(-3)
        .reverse()
        .forEach(o => {
          const prov = contacts.find(c => c.id === o.supplier_id)
          html += `<tr><td>${o.numero || o.id}</td><td>${prov?.name || '-'}</td><td>${o.currency || 'PEN'} ${(o.total || 0).toFixed(2)}</td><td>${o.user || '-'}</td><td><span class="badge badge-${o.status || 'pending'}">${o.status || 'pending'}</span></td></tr>`
        })
      html += '</tbody></table>'
      ultimasOC.innerHTML = html
    }

    // Últimas COT
    const ultimasCOT = document.getElementById('ultimas-cot')
    if (ultimasCOT && cot.length > 0) {
      const contacts = await getContacts()
      let html = '<table><thead><tr><th>Número</th><th>Cliente</th><th>Total</th><th>Usuario</th><th>Estado</th></tr></thead><tbody>'
      cot.slice(-3)
        .reverse()
        .forEach(c => {
          const cli = contacts.find(ct => ct.id === c.customer_id)
          html += `<tr><td>${c.numero || c.id}</td><td>${cli?.name || '-'}</td><td>${c.currency || 'PEN'} ${(c.total || 0).toFixed(2)}</td><td>${c.user || '-'}</td><td><span class="badge badge-${c.status || 'pending'}">${c.status || 'pending'}</span></td></tr>`
        })
      html += '</tbody></table>'
      ultimasCOT.innerHTML = html
    }
  } catch (error) {
    console.error('Error al cargar dashboard:', error)
  }
})
