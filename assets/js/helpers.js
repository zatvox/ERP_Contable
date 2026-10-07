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
/** Precio / costo UNITARIO: estándar del sistema = hasta 4 decimales
 *  (mínimo 2 para que 5.5 se vea 5.50). Totales siguen con formatNumber (2). */
export function formatPrecio(value) {
  const num = parseFloat(value)
  return (isNaN(num) ? 0 : num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}
window.formatPrecio = formatPrecio

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
// DOCUMENTO DE CONTACTO (RUC / DNI) — texto reutilizable para cualquier
// selector de Cliente/Proveedor en el sistema: una vez elegido el contacto,
// se muestra su RUC o DNI debajo del selector. Si el contacto no tiene
// ninguno guardado en su ficha, se avisa en vez de dejarlo en blanco.
// ============================================================================

export function textoDocumentoContacto(contacto) {
  // El contacto guarda un solo documento genérico (tipo_documento +
  // nro_documento: 'RUC'/'DNI'/'CE'/etc.), no columnas separadas ruc/dni.
  const numero = (contacto?.nro_documento || '').toString().trim()
  const tipo = (contacto?.tipo_documento || '').toString().trim().toUpperCase()
  if (!numero) return '\u26a0 Sin RUC/DNI registrado'
  return tipo ? `${tipo}: ${numero}` : numero
}

/** Pinta (o limpia, si `contacto` es null) el <small> de documento debajo de
 * un selector de contacto. `elementoId` es el id de ese <small>. */
export function pintarDocumentoContacto(elementoId, contacto) {
  const el = document.getElementById(elementoId)
  if (!el) return
  if (!contacto) {
    el.style.display = 'none'
    el.textContent = ''
    return
  }
  el.textContent = textoDocumentoContacto(contacto)
  el.style.display = 'block'
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

// ============================================================================
// BOTÓN GUARDAR CON CARGA (estándar 2026-10-01 — ver DISENO_ESTANDAR.md §4.2)
// ============================================================================
// Uso en HTML:  onclick="window.conCarga(this, window.guardarX)"
// Mientras corre la función: el botón queda bloqueado (no acepta 2° clic),
// muestra una rueda de carga + "Guardando…" y al terminar (bien o con error)
// vuelve a su estado original. Evita registros duplicados por doble clic.
// No usa el atributo `disabled` a propósito: varias funciones guardarX ya
// revisan `if (btn.disabled) return` y se bloquearían a sí mismas.
export async function conCarga(btn, fn, texto = 'Guardando…') {
  if (!btn || typeof fn !== 'function') return
  if (btn.dataset.cargando === '1') return          // 2° clic ignorado
  btn.dataset.cargando = '1'
  const html = btn.innerHTML
  btn.classList.add('btn-cargando')
  btn.setAttribute('aria-busy', 'true')
  btn.innerHTML = `<span class="spinner-btn" aria-hidden="true"></span>${texto}`
  try {
    return await fn()
  } finally {
    btn.innerHTML = html
    btn.classList.remove('btn-cargando')
    btn.removeAttribute('aria-busy')
    delete btn.dataset.cargando
  }
}
window.conCarga = conCarga


// ============================================================================
// FECHA DD/MM/AAAA (estándar de visualización 2026-10-03)
// ============================================================================
/** 'YYYY-MM-DD' (o ISO con hora) → 'DD/MM/AAAA'. Vacío → '—'. */
export function fechaDMY(v, vacio = '—') {
  if (!v) return vacio
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v)
}

// ============================================================================
// TABLA ORDENABLE (clic en el encabezado: asc → desc) — DISENO_ESTANDAR §1.2
// ============================================================================
// Ordena las filas ya pintadas (no vuelve a pedir datos). Entiende números
// ("1,234.50", "USD 12.00", "+11"), fechas DD/MM/AAAA y texto. Una celda
// puede forzar su valor de orden con data-sort="...". Si la tabla se vuelve a
// pintar (filtros, recarga), se re-aplica el último orden elegido.
function _valorOrden(td) {
  if (!td) return ''
  if (td.dataset.sort !== undefined) {
    const n = parseFloat(td.dataset.sort)
    return isNaN(n) ? td.dataset.sort.toLowerCase() : n
  }
  // textContent (no innerText): innerText fuerza un recálculo de layout por
  // celda y con cientos de filas congelaba la pantalla (2026-10-07).
  const t = (td.textContent || '').replace(/\s+/g, ' ').trim()
  const f = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/)
  if (f) return `${f[3]}-${f[2]}-${f[1]}`
  const limpio = t.replace(/^(S\/|\$|USD|PEN)\s*/i, '')
  if (/^[+-]?[\d,]+(\.\d+)?%?$/.test(limpio)) return parseFloat(limpio.replace(/[,%]/g, ''))
  return t.toLowerCase()
}

export function hacerTablaOrdenable(table) {
  if (!table || table.dataset.ordenable === '1' || !table.tHead || !table.tBodies[0]) return
  table.dataset.ordenable = '1'
  const tbody = table.tBodies[0]
  const ths = [...table.tHead.rows[0].cells]
  let col = -1, dir = 1
  const coll = new Intl.Collator('es', { numeric: true })

  // FIX 2026-10-07 — se congelaba la pantalla al ordenar: el MutationObserver
  // (que re-aplica el orden cuando la tabla se repinta) se disparaba con los
  // propios appendChild del orden → ordenar() → más mutaciones → bucle
  // infinito. Ahora se desconecta el observer mientras se reordena y se
  // descartan sus registros pendientes. Además la clave de orden se calcula
  // UNA vez por fila (antes en cada comparación) y se mueve todo en un solo
  // fragmento.
  const ordenar = () => {
    if (col < 0) return
    obs.disconnect()
    const filas = [...tbody.rows].filter(r => !r.querySelector('td[colspan]'))
    const conClave = filas.map(f => ({ f, v: _valorOrden(f.cells[col]) }))
    conClave.sort((a, b) => {
      const va = a.v, vb = b.v
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
      return coll.compare(String(va), String(vb)) * dir
    })
    const frag = document.createDocumentFragment()
    conClave.forEach(x => frag.appendChild(x.f))
    tbody.appendChild(frag)
    obs.takeRecords()
    obs.observe(tbody, { childList: true })
  }
  // Re-aplicar el orden cuando la tabla se vuelve a pintar (filtros/recarga)
  const obs = new MutationObserver(() => ordenar())

  ths.forEach((th, i) => {
    const txt = th.textContent.trim()
    if (!txt || /^acciones$/i.test(txt)) return
    th.classList.add('th-ordenable')
    const ind = document.createElement('span')
    ind.className = 'th-orden-ind'
    ind.textContent = ' ⇅'
    th.appendChild(ind)
    th.addEventListener('click', () => {
      dir = col === i ? -dir : 1
      col = i
      ths.forEach(h => { const s = h.querySelector('.th-orden-ind'); if (s) s.textContent = ' ⇅' })
      ind.textContent = dir === 1 ? ' ▲' : ' ▼'
      ordenar()
    })
  })
  obs.observe(tbody, { childList: true })
}
window.hacerTablaOrdenable = hacerTablaOrdenable

// ============================================================================
// PDF de tabla con cada celda en UNA sola línea (2026-10-06)
// ============================================================================
// Mide el texto más largo de cada columna y elige el tamaño de letra más
// grande (8 → 5 pt) con el que toda la tabla entra en el ancho de la hoja,
// sin partir ningún texto. Si ni en 5 pt entra en A4 horizontal, pasa a A3
// horizontal. Cada columna toma exactamente el ancho de su texto más largo.
//   doc        : instancia jsPDF ya creada SIN página especial (se recrea)
//   opts       : { jsPDF, titulo, subtitulo, head:[...], body:[[...]], derecha:Set(idx), archivo }
export function pdfTablaUnaLinea({ jsPDF, titulo, subtitulo = '', head, body, derecha = new Set(), archivo }) {
  const MARGEN = 10, PAD = 1.4, startY = subtitulo ? 22 : 17
  const medir = (doc, fs) => {
    doc.setFontSize(fs)
    return head.map((h, c) => {
      doc.setFont('helvetica', 'bold')
      let w = doc.getTextWidth(String(h ?? ''))
      doc.setFont('helvetica', 'normal')
      for (const fila of body) w = Math.max(w, doc.getTextWidth(String(fila[c] ?? '')))
      return w + PAD * 2 + 0.6
    })
  }
  let elegido = null
  for (const formato of ['a4', 'a3']) {
    const doc = new jsPDF({ orientation: 'landscape', format: formato, unit: 'mm' })
    const disponible = doc.internal.pageSize.getWidth() - MARGEN * 2
    for (let fs = 8; fs >= 5; fs -= 0.5) {
      const anchos = medir(doc, fs)
      if (anchos.reduce((a, b) => a + b, 0) <= disponible) { elegido = { doc, fs, anchos }; break }
    }
    if (elegido) break
  }
  if (!elegido) {   // ni en A3 a 5 pt: A3 y se reparte proporcional (último recurso)
    const doc = new jsPDF({ orientation: 'landscape', format: 'a3', unit: 'mm' })
    const anchos = medir(doc, 5)
    const disponible = doc.internal.pageSize.getWidth() - MARGEN * 2
    const k = disponible / anchos.reduce((a, b) => a + b, 0)
    elegido = { doc, fs: 5, anchos: anchos.map(w => w * k) }
  }
  const { doc, fs, anchos } = elegido
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(12); doc.text(titulo || 'Reporte', MARGEN, 12)
  if (subtitulo) { doc.setFontSize(9); doc.text(subtitulo, MARGEN, 18) }
  const columnStyles = {}
  anchos.forEach((w, i) => { columnStyles[i] = { cellWidth: w, halign: derecha.has(i) ? 'right' : 'left' } })
  doc.autoTable({
    head: [head], body, startY,
    margin: { left: MARGEN, right: MARGEN },
    styles: { fontSize: fs, cellPadding: PAD, overflow: 'visible', valign: 'middle' },
    headStyles: { fontStyle: 'bold' },
    columnStyles,
    didParseCell: (d) => { if (d.section === 'head') d.cell.styles.halign = derecha.has(d.column.index) ? 'right' : 'left' }
  })
  doc.save(archivo)
  return doc
}
