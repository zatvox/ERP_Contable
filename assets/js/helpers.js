// ============================================================================
// HELPERS.JS - Funciones auxiliares globales
// ============================================================================

import { 
  getSupplierById as getSupplierByIdAsync,
  getCustomerById as getCustomerByIdAsync,
  getItemById as getItemByIdAsync,
  getContacts,
  tiposDeContacto,
  getOrderCompras as getOrderComprasAsync,
  getOrderCompraById as getOrderCompraByIdAsync,
  getSalesQuotes as getSalesQuotesAsync,
  getSalesQuoteById as getSalesQuoteByIdAsync,
  getJournalEntries as getJournalEntriesAsync,
  getLotes as getLotesAsync,
  getLoteById as getLoteByIdAsync,
  getLotesByItemId as getLotesByItemIdAsync,
  getItems as getItemsAsync,
  formatDate as formatDateFn,
  formatCurrency as formatCurrencyFn
} from './supabase-data.js'

// ============================================================================
// TOAST NOTIFICATIONS
// ============================================================================

export function showToast(message, type = 'info', duration = 3000) {
  const toast = document.createElement('div')
  toast.className = `toast ${type}`
  toast.textContent = message
  document.body.appendChild(toast)
  
  // Agregar estilos si no existen
  if (!document.getElementById('toast-styles')) {
    const styles = document.createElement('style')
    styles.id = 'toast-styles'
    styles.textContent = `
      .toast {
        position: fixed;
        bottom: 20px;
        right: 20px;
        padding: 15px 20px;
        border-radius: 8px;
        color: white;
        font-weight: 500;
        z-index: 10000;
        animation: slideInUp 0.3s ease;
        max-width: 300px;
        word-wrap: break-word;
      }
      .toast.info { background-color: #3b82f6; }
      .toast.success { background-color: #10b981; }
      .toast.warning { background-color: #f59e0b; }
      .toast.danger { background-color: #ef4444; }
      @keyframes slideInUp {
        from { transform: translateY(100px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
    `
    document.head.appendChild(styles)
  }
  
  setTimeout(() => {
    toast.remove()
  }, duration)
}

// ============================================================================
// FORMATEO
// ============================================================================

export function formatDate(dateStr) {
  return formatDateFn(dateStr)
}

export function formatCurrency(value, currency = 'PEN') {
  return formatCurrencyFn(value, currency)
}

// Helper único de formato numérico para todo el sistema: separador de
// miles + decimales fijos (para montos/precios/costos). decimals=2 por
// defecto; usar 4 para costos unitarios (S/. 0.xxxx), etc.
export function formatNumber(value, decimals = 2) {
  const num = parseFloat(value)
  return (isNaN(num) ? 0 : num).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

// Igual que formatNumber pero SIN decimales forzados — para cantidades/
// stock/unidades, donde un entero debe verse "24,500" y no "24,500.00".
export function formatQty(value, maxDecimals = 2) {
  const num = parseFloat(value)
  return (isNaN(num) ? 0 : num).toLocaleString('en-US', { maximumFractionDigits: maxDecimals })
}

// ============================================================================
// MODAL HELPERS (Global)
// ============================================================================

export function openModalGlobal(id) {
  const modal = document.getElementById(id)
  if (modal) {
    modal.classList.add('show')
    document.body.style.overflow = 'hidden'
  }
}

export function closeModalGlobal(id) {
  const modal = document.getElementById(id)
  if (modal) {
    modal.classList.remove('show')
    document.body.style.overflow = 'auto'
  }
}

// ============================================================================
// DATA FETCHERS - Funciones que cachean datos localmente
// ============================================================================

let cache = {
  suppliers: null,
  customers: null,
  products: null,
  purchaseOrders: null,
  salesQuotes: null,
  lotes: null,
  journalEntries: null,
  lastUpdate: {}
}

export async function getSupplierById(id) {
  if (!id) return null
  try {
    return await getSupplierByIdAsync(id)
  } catch (error) {
    console.error('Error en getSupplierById:', error)
    return null
  }
}

export async function getCustomerById(id) {
  if (!id) return null
  try {
    return await getCustomerByIdAsync(id)
  } catch (error) {
    console.error('Error en getCustomerById:', error)
    return null
  }
}

export async function getItemById(id) {
  if (!id) return null
  try {
    return await getItemByIdAsync(id)
  } catch (error) {
    console.error('Error en getItemById:', error)
    return null
  }
}

export async function getPurchaseOrders() {
  try {
    return await getPurchaseOrdersAsync()
  } catch (error) {
    console.error('Error en getPurchaseOrders:', error)
    return []
  }
}

export async function getPurchaseOrderById(id) {
  if (!id) return null
  try {
    return await getPurchaseOrderByIdAsync(id)
  } catch (error) {
    console.error('Error en getPurchaseOrderById:', error)
    return null
  }
}

export async function getSalesQuotes() {
  try {
    return await getSalesQuotesAsync()
  } catch (error) {
    console.error('Error en getSalesQuotes:', error)
    return []
  }
}

export async function getSalesQuoteById(id) {
  if (!id) return null
  try {
    return await getSalesQuoteByIdAsync(id)
  } catch (error) {
    console.error('Error en getSalesQuoteById:', error)
    return null
  }
}

export async function getJournalEntries() {
  try {
    return await getJournalEntriesAsync()
  } catch (error) {
    console.error('Error en getJournalEntries:', error)
    return []
  }
}

export async function getLotes() {
  try {
    return await getLotesAsync()
  } catch (error) {
    console.error('Error en getLotes:', error)
    return []
  }
}

export async function getLoteById(id) {
  if (!id) return null
  try {
    return await getLoteByIdAsync(id)
  } catch (error) {
    console.error('Error en getLoteById:', error)
    return null
  }
}

export async function getLotesByItemId(itemId) {
  if (!itemId) return []
  try {
    return await getLotesByItemIdAsync(itemId)
  } catch (error) {
    console.error('Error en getLotesByItemId:', error)
    return []
  }
}

export async function getItems() {
  try {
    return await getItemsAsync()
  } catch (error) {
    console.error('Error en getItems:', error)
    return []
  }
}

export async function getSuppliers() {
  try {
    const contacts = await getContacts()
    // tipo_contacto es text[] en la BD, ej: ['cliente','proveedor']
    return contacts.filter(c => tiposDeContacto(c).includes('proveedor'))
  } catch (error) {
    console.error('Error en getSuppliers:', error)
    return []
  }
}

export async function getCustomers() {
  try {
    const contacts = await getContacts()
    return contacts.filter(c => tiposDeContacto(c).includes('cliente'))
  } catch (error) {
    console.error('Error en getCustomers:', error)
    return []
  }
}

// ============================================================================
// DISPONIBILIZAR GLOBALMENTE
// ============================================================================

window.showToast = showToast
window.formatDate = formatDate
window.formatCurrency = formatCurrency
window.formatNumber = formatNumber
window.formatQty = formatQty
window.openModal = openModalGlobal
window.closeModal = closeModalGlobal