// ============================================================================
// shared/pdf-documento.js — helpers COMPARTIDOS para PDF de documentos (A4)
// Extraídos tal cual de ventas/packing.js (mismo diseño): emisor multiempresa
// (logo + color de marca), tintes, número en letras y descarga html2canvas+jsPDF.
// Los usa compras/oc-pdf.js. (packing.js conserva su copia; migrarlo a este módulo es un paso futuro.)
// ============================================================================
import { empresaById } from '../empresa.js'
import { supabase } from '../supabase-client.js'
import { showToast } from '../helpers.js'

// Datos del emisor para el PDF (mismos del PDF de Odoo). Logo: assets/img/logo-jhiro.png
const EMPRESA = {
  nombre: 'JHIRO PERU S.A.C.', ruc: '20600842995',
  direccion: 'AV. SANTA ROSA LT. 15 MZ. S URB. SAN GABRIEL - LIMA - LIMA - SAN JUAN DE LURIGANCHO',
  email: 'gerencia@jhiroperu.com', telefono: '979050317', web: 'https://jhiroperu.com',
  logo: 'assets/img/logo-jhiro.png',          // logotipo completo (PDF)
  isotipo: 'assets/img/isotipo-jhiro.png'     // solo el símbolo (usos futuros)
}


/** Datos del EMISOR para el PDF según la empresa del PK (multiempresa):
 *  antes todo PK salía con los datos de JHIRO, incluso los de BENJI. */
export async function emisorPDF(pk) {
  // empresa_config completa (el contexto multiempresa solo trae id/ruc/color/logo)
  let ec = empresaById(pk?.empresa_id) || null
  if (pk?.empresa_id) {
    try { const { data } = await supabase.from('empresa_config').select('*').eq('id', pk.empresa_id).single(); if (data) ec = { ...ec, ...data } } catch { /* usa el contexto */ }
  }
  const esJhiro = !ec || String(ec.ruc) === EMPRESA.ruc
  const color = /^#[0-9a-f]{6}$/i.test(ec?.color || '') ? ec.color : '#2f6db5'
  return esJhiro
    ? { ...EMPRESA, logo: ec?.logo_url || EMPRESA.logo, color, corto: ec?.nombre_comercial || 'JHIRO' }
    : { nombre: ec.razon_social, ruc: ec.ruc, direccion: ec.direccion || '', email: ec.email || '', telefono: ec.telefono || '', web: ec.web || '',
        logo: ec.logo_url || null, color, corto: ec.nombre_comercial || ec.codigo || '' }
}
/** Texto legible sobre un fondo: oscuro si el color es claro (luminancia WCAG). */
export function textoSobre(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.45 ? '#111827' : '#ffffff'
}
/** Mezcla el color con blanco (p: 0..1 del color) → tonos suaves para filas/etiquetas. */
export function tinte(hex, p) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).map(v => Math.round(v * p + 255 * (1 - p)))
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('')
}

export const _esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const _U = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE', 'VEINTIUNO', 'VEINTIDÓS', 'VEINTITRÉS', 'VEINTICUATRO', 'VEINTICINCO', 'VEINTISÉIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE']
const _D = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA']
const _C = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS']
function _menorMil(n) {
  if (n === 0) return ''
  if (n === 100) return 'CIEN'
  const c = Math.floor(n / 100), r = n % 100
  const dec = r < 30 ? _U[r] : _D[Math.floor(r / 10)] + (r % 10 ? ' Y ' + _U[r % 10] : '')
  return [_C[c], dec].filter(Boolean).join(' ')
}
export function numeroALetras(monto, moneda = 'PEN') {
  const redondo = Math.round((+monto || 0) * 100)
  const entero = Math.floor(redondo / 100), cent = redondo % 100
  const mill = Math.floor(entero / 1e6), miles = Math.floor((entero % 1e6) / 1000), resto = entero % 1000
  const partes = []
  if (mill) partes.push(mill === 1 ? 'UN MILLÓN' : `${_menorMil(mill).replace(/UNO$/, 'UN')} MILLONES`)
  if (miles) partes.push(miles === 1 ? 'MIL' : `${_menorMil(miles).replace(/UNO$/, 'UN')} MIL`)
  if (resto) partes.push(_menorMil(resto))
  const mon = moneda === 'USD' ? 'DÓLARES' : 'SOLES'
  return `${partes.join(' ') || 'CERO'} ${mon} Y ${cent ? _menorMil(cent) : 'CERO'} CENTAVOS`
}

/** Convierte el HTML del documento en un PDF A4 y lo DESCARGA (sin abrir
 *  ventana ni diálogo de impresión). html2canvas + jsPDF, mismas librerías
 *  que el estado de cuenta. Si el contenido pasa de una hoja, se corta en
 *  varias páginas y la firma "by: ZatVox" se repite en cada una. */
export async function descargarPDFDesdeHTML(html, nombreArchivo) {
  const ifr = document.createElement('iframe')
  ifr.style.cssText = 'position:fixed; left:-10000px; top:0; width:794px; height:1123px; border:0; visibility:hidden;'
  document.body.appendChild(ifr)
  try {
    const doc = ifr.contentDocument
    doc.open(); doc.write(html); doc.close()
    doc.body.style.margin = '0'; doc.body.style.padding = '38px 40px'; doc.body.style.background = '#fff'
    // Esperar fuentes e imágenes (logo)
    await new Promise(r => setTimeout(r, 120))
    await Promise.all([...doc.images].map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r })))
    const [{ jsPDF }, h2c] = await Promise.all([
      import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm'),
      import('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/+esm')
    ])
    const html2canvas = h2c.default || h2c
    const zv = doc.querySelector('.zv'); if (zv) zv.style.position = 'absolute'   // en canvas va en la 1ra hoja; luego se repite con jsPDF
    // Alto REAL del contenido (no el del iframe): evita una 2da hoja en blanco
    const alto = Math.ceil(Math.max(...[...doc.body.children].map(el => el.getBoundingClientRect().bottom + (doc.defaultView.scrollY || 0)))) + 38
    const canvas = await html2canvas(doc.body, { scale: 2, backgroundColor: '#ffffff', useCORS: true, windowWidth: 794, height: alto, windowHeight: alto })
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    const W = 210, H = 297
    const mm = canvas.width / W                      // px de canvas por mm
    const hPag = Math.floor(H * mm), mTop = Math.round(12 * mm), mBot = Math.round(10 * mm)
    // Saltos de página LIMPIOS: solo se corta entre filas (tr) o entre bloques, nunca a mitad de una fila.
    const S = canvas.width / 794                     // escala real del canvas (px css → px canvas)
    const pos = el => { const r = el.getBoundingClientRect(); return { t: Math.round(r.top * S), b: Math.round(r.bottom * S) } }
    const cortes = new Set()
    doc.querySelectorAll('tr').forEach(tr => cortes.add(pos(tr).b))
    ;[...doc.body.children].forEach(el => cortes.add(pos(el).b))
    const thead = doc.querySelector('thead'), tbl = thead?.closest('table')
    const th = thead ? pos(thead) : null, tbEnd = tbl ? pos(tbl).b : 0
    let y = 0, pag = 0
    while (canvas.height - y > 24) {   // ignora restos de pocos px (redondeo)
      const conCab = pag > 0 && th && y > th.b && y < tbEnd          // la hoja empieza dentro de la tabla → repite el encabezado
      const offTop = pag === 0 ? 0 : mTop + (conCab ? th.b - th.t : 0)
      const util = hPag - offTop - mBot
      let fin = y + util
      if (fin >= canvas.height) fin = canvas.height
      else { const cand = [...cortes].filter(c => c > y + util * 0.3 && c <= fin); if (cand.length) fin = Math.max(...cand) }
      const alto = fin - y
      const trozo = document.createElement('canvas')
      trozo.width = canvas.width; trozo.height = hPag
      const ctx = trozo.getContext('2d')
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, trozo.width, trozo.height)
      if (conCab) ctx.drawImage(canvas, 0, th.t, canvas.width, th.b - th.t, 0, mTop, canvas.width, th.b - th.t)
      ctx.drawImage(canvas, 0, y, canvas.width, alto, 0, offTop, canvas.width, alto)
      if (pag > 0) pdf.addPage()
      pdf.addImage(trozo.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, W, H)
      if (pag > 0) {   // firma del autor en hojas siguientes
        pdf.setFont('helvetica', 'italic').setFontSize(7).setTextColor(17, 24, 39)
        pdf.text('by: ZV', W - 10.6, 6, { align: 'right' })
      }
      y = fin; pag++
    }
    pdf.save(nombreArchivo)
    showToast('PDF descargado ✅', 'success')
  } finally { ifr.remove() }
}

