// ============================================================================
// SUPABASE-DATA.JS - Gestión de datos con Supabase
// ============================================================================

import { supabase, getAll, getById, insert, update, deleteRecord, query } from './supabase-client.js'

// ============================================================================
// PRODUCTOS
// ============================================================================

export async function getProducts() {
  return await getAll('products')
}

export async function getProductById(id) {
  return await getById('products', id)
}

export async function addProduct(product) {
  return await insert('products', product)
}

export async function updateProduct(id, data) {
  return await update('products', id, data)
}

export async function deleteProduct(id) {
  return await deleteRecord('products', id)
}

// ============================================================================
// LOTES
// ============================================================================

export async function getLotes() {
  return await getAll('lotes')
}

export async function getLoteById(id) {
  return await getById('lotes', id)
}

export async function getLotesByProductId(productId) {
  return await query('lotes', { product_id: productId })
}

export async function addLote(lote) {
  return await insert('lotes', lote)
}

export async function updateLote(id, data) {
  return await update('lotes', id, data)
}

export async function deleteLote(id) {
  return await deleteRecord('lotes', id)
}

// ============================================================================
// CONTACTOS (Proveedores, Clientes, Vendedores)
// ============================================================================

export async function getContacts() {
  return await getAll('contacts')
}

export async function getContactById(id) {
  return await getById('contacts', id)
}

export async function getContactsByType(tipoContacto) {
  return await query('contacts', { tipo_contacto: tipoContacto })
}

export async function getSuppliers() {
  return await getContactsByType('Proveedor')
}

export async function getCustomers() {
  return await getContactsByType('Cliente')
}

export async function addContact(contact) {
  return await insert('contacts', contact)
}

export async function updateContact(id, data) {
  return await update('contacts', id, data)
}

export async function deleteContact(id) {
  return await deleteRecord('contacts', id)
}

// ============================================================================
// PLAN DE CUENTAS
// ============================================================================

export async function getAccounts() {
  return await getAll('accounts')
}

export async function getAccountById(id) {
  return await getById('accounts', id)
}

export async function getAccountByCode(code) {
  const accounts = await getAccounts()
  return accounts.find(a => a.code === code)
}

// ============================================================================
// ÓRDENES DE COMPRA
// ============================================================================

export async function getPurchaseOrders() {
  return await getAll('purchase_orders')
}

export async function getPurchaseOrderById(id) {
  return await getById('purchase_orders', id)
}

export async function addPurchaseOrder(order) {
  return await insert('purchase_orders', order)
}

export async function updatePurchaseOrder(id, data) {
  return await update('purchase_orders', id, data)
}

// ============================================================================
// COTIZACIONES DE VENTA
// ============================================================================

export async function getSalesQuotes() {
  return await getAll('sales_quotes')
}

export async function getSalesQuoteById(id) {
  return await getById('sales_quotes', id)
}

export async function addSalesQuote(quote) {
  return await insert('sales_quotes', quote)
}

export async function updateSalesQuote(id, data) {
  return await update('sales_quotes', id, data)
}

// ============================================================================
// ASIENTOS CONTABLES
// ============================================================================

export async function getJournalEntries() {
  return await getAll('journal_entries')
}

export async function getJournalEntryById(id) {
  return await getById('journal_entries', id)
}

export async function getJournalEntriesByType(tipoMovimiento) {
  return await query('journal_entries', { tipo_movimiento: tipoMovimiento })
}

export async function getJournalEntriesByDocument(tipoDocumento) {
  return await query('journal_entries', { tipo_documento: tipoDocumento })
}

export async function addJournalEntry(entry) {
  return await insert('journal_entries', entry)
}

export async function updateJournalEntry(id, data) {
  return await update('journal_entries', id, data)
}

// ============================================================================
// LÍNEAS DE ASIENTOS CONTABLES
// ============================================================================

export async function getJournalEntryLines() {
  return await getAll('journal_entry_lines')
}

export async function addJournalEntryLine(line) {
  return await insert('journal_entry_lines', line)
}

// ============================================================================
// COSTEO DE IMPORTACIONES
// ============================================================================

export async function getCosteoImportaciones() {
  return await getAll('costeo_importaciones')
}

export async function getCosteoImportacionById(id) {
  return await getById('costeo_importaciones', id)
}

export async function addCosteoImportacion(costeo) {
  return await insert('costeo_importaciones', costeo)
}

export async function updateCosteoImportacion(id, data) {
  return await update('costeo_importaciones', id, data)
}

// ============================================================================
// CONTENEDORES
// ============================================================================

export async function getCosteoContenedores() {
  return await getAll('costeo_contenedores')
}

export async function addCosteoContenedor(contenedor) {
  return await insert('costeo_contenedores', contenedor)
}

// ============================================================================
// CÁLCULOS Y HELPERS
// ============================================================================

export function calcularTotalesLinea(linea) {
  const subtotal = (linea.cantidad || 0) * (linea.precio_unitario || 0)
  const igvAmount = subtotal * ((linea.igv || 0) / 100)
  return {
    subtotal: parseFloat(subtotal.toFixed(2)),
    igv_amount: parseFloat(igvAmount.toFixed(2)),
    total: parseFloat((subtotal + igvAmount).toFixed(2))
  }
}

export function calcularTotalesDocumento(lineas) {
  let subtotal = 0, igv = 0
  lineas.forEach(linea => {
    const calc = calcularTotalesLinea(linea)
    subtotal += calc.subtotal
    igv += calc.igv_amount
  })
  return {
    subtotal: parseFloat(subtotal.toFixed(2)),
    igv: parseFloat(igv.toFixed(2)),
    total: parseFloat((subtotal + igv).toFixed(2))
  }
}

export function formatCurrency(value, currency = 'PEN') {
  const num = parseFloat(value) || 0
  const symbol = currency === 'USD' ? '$' : 'S/.'
  return `${symbol} ${num.toFixed(2)}`
}

export function formatDate(dateStr) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  return date.toLocaleDateString('es-PE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
}

export function formatNumber(value) {
  return parseFloat(value || 0).toFixed(2)
}

// ============================================================================
// HELPERS - Búsqueda por referencia
// ============================================================================

export async function getSupplierById(id) {
  if (!id) return null
  const contacts = await getContacts()
  return contacts.find(c => c.id === id && c.tipo_contacto === 'Proveedor')
}

export async function getCustomerById(id) {
  if (!id) return null
  const contacts = await getContacts()
  return contacts.find(c => c.id === id && c.tipo_contacto === 'Cliente')
}

// ======================gi======================================================
// CONTABILIDAD HELPERS
// ============================================================================

export async function calcularBalancesCuentas() {
  try {
    const accounts = await getAccounts()
    const entries = await getJournalEntryLines()
    
    return accounts.map(account => {
      let debit = 0, credit = 0
      entries.forEach(entry => {
        if (entry.account_id === account.id) {
          debit += entry.debit_amount || 0
          credit += entry.credit_amount || 0
        }
      })
      return {
        ...account,
        debit: parseFloat(debit.toFixed(2)),
        credit: parseFloat(credit.toFixed(2)),
        balance: parseFloat((debit - credit).toFixed(2))
      }
    })
  } catch (error) {
    console.error('Error en calcularBalancesCuentas:', error)
    return []
  }
}
/*
export async function getProductById(id) {
  if (!id) return null
  return await getById('products', id)
}*/
