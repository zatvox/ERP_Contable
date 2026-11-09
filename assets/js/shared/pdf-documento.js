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
  // 2026-11-09: TODO sale del perfil de la empresa (Perfil → Multiempresa).
  // Los datos fijos de JHIRO quedan solo como respaldo de campos vacíos.
  const base = esJhiro ? EMPRESA : {}
  const val = (k, kb) => (ec?.[k] != null && String(ec[k]).trim() !== '') ? ec[k] : (base[kb || k] || '')
  return {
    nombre: val('razon_social', 'nombre'), ruc: ec?.ruc || base.ruc || '',
    direccion: val('direccion'), email: val('email'), telefono: val('telefono'), web: val('web'),
    logo: val('logo_url', 'logo') || null, isotipo: base.isotipo || null,
    logoAlto: Math.min(150, Math.max(40, parseInt(ec?.logo_alto) || 70)),
    logoAlign: ['left', 'center', 'right'].includes(ec?.logo_align) ? ec.logo_align : 'left',
    color, corto: ec?.nombre_comercial || ec?.codigo || base.corto || 'JHIRO'
  }
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


/**
 * Pie "Cuentas para depósito" (2026-11-09): cuentas bancarias de la empresa
 * marcadas en su perfil (bancos.mostrar_en_pdf, SQL 147). '' si no hay.
 * color = color de la empresa (encabezado de la tablita).
 */
export async function cuentasDepositoPDF(empresaId, color = '#2f6db5') {
  if (!empresaId) return ''
  let cuentas = []
  try {
    const { data, error } = await supabase.from('bancos')
      .select('nombre, banco, numero_cuenta, cci, moneda, tipo_cuenta, mostrar_en_pdf, activo, empresa_id')
      .eq('empresa_id', empresaId).eq('mostrar_en_pdf', true).order('moneda').order('banco')
    if (error) return ''          // sin SQL 147 todavía: el PDF sale igual, sin cuentas
    cuentas = (data || []).filter(c => c.activo !== false)
  } catch { return '' }
  if (!cuentas.length) return ''
  const mon = m => m === 'USD' ? 'Dólares (US$)' : 'Soles (S/)'
  const tipo = t => ({ corriente: 'Cta. corriente', ahorro: 'Cta. ahorros', detracciones: 'Detracciones', cuentas_recaudacion: 'Recaudación' }[t] || '')
  return `
  <div style="margin-top:18px; page-break-inside:avoid;">
    <div style="font-weight:700; font-size:11px; letter-spacing:.04em; color:${color}; margin-bottom:4px;">CUENTAS PARA DEPÓSITO</div>
    <table style="width:100%; border-collapse:collapse; font-size:10.5px;">
      <thead><tr style="background:${tinte(color, 0.12)};">
        <th style="text-align:left; padding:5px 8px; border:1px solid #d1d5db;">Banco</th>
        <th style="text-align:left; padding:5px 8px; border:1px solid #d1d5db;">Moneda</th>
        <th style="text-align:left; padding:5px 8px; border:1px solid #d1d5db;">N° de cuenta</th>
        <th style="text-align:left; padding:5px 8px; border:1px solid #d1d5db;">CCI</th>
      </tr></thead>
      <tbody>${cuentas.map(c => `<tr>
        <td style="padding:5px 8px; border:1px solid #d1d5db;"><b>${_esc(c.banco || c.nombre)}</b>${tipo(c.tipo_cuenta) ? ` <span style="color:#6b7280;">· ${tipo(c.tipo_cuenta)}</span>` : ''}</td>
        <td style="padding:5px 8px; border:1px solid #d1d5db;">${mon(c.moneda)}</td>
        <td style="padding:5px 8px; border:1px solid #d1d5db; font-family:monospace;">${_esc(c.numero_cuenta || '')}</td>
        <td style="padding:5px 8px; border:1px solid #d1d5db; font-family:monospace;">${_esc(c.cci || '—')}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>`
}

// ════════════════════════════════════════════════════════════════════════════
// Cabecera ÚNICA de los PDF (Packing, Cotización, OC) y de la vista previa del
// perfil de empresa — 2026-11-09. Un solo código = lo que ves es lo que sale.
//   · El logo arranca arriba de todo (sin la franja vacía del "by: ZV").
//   · RUC de la empresa debajo de su razón social.
//   · Alineación izq.: la columna del logo mide lo que mide el logo (más
//     espacio para los datos). Centro/der.: columna fija de 210 px.
// ════════════════════════════════════════════════════════════════════════════
export const ANCHO_PAPEL_PDF = 714   // ancho útil del lienzo del PDF (794 px − 40 px por lado)

export function cssCabeceraPDF(C, CT) {
  return `
  .top { display:flex; align-items:flex-start; gap:16px; }
  .logo { flex:none; display:flex; align-items:flex-start; }
  .logo img { display:block; object-fit:contain; }
  .emp { flex:1; min-width:0; font-size:10px; line-height:1.45; padding-top:2px; }
  .emp .rz { font-size:12px; font-weight:bold; }
  .emp .ruc { font-size:10.5px; font-weight:bold; color:#374151; }
  .doc { flex:none; margin-top:26px; border:1.5px solid ${C}; border-radius:10px; padding:10px 16px; text-align:center; min-width:170px; font-size:12px; }
  .doc b { display:block; font-size:13px; }
  .logo-txt { display:inline-flex; align-items:center; justify-content:center; min-width:120px; height:64px; padding:0 16px; border-radius:14px; background:${C}; color:${CT}; font-size:26px; font-weight:800; letter-spacing:3px; }
  .zv { position:absolute; top:0; right:0; display:flex; pointer-events:none; z-index:0; }
  .zv-in { display:inline-flex; align-items:center; gap:6px; opacity:.8; }
  .zv-mono { width:16px; height:16px; border-radius:5px; display:inline-flex; align-items:center; justify-content:center; background:#111827; color:#fff; font:800 8px/1 Arial, sans-serif; letter-spacing:-.3px; }
  .zv-txt { font:italic 400 9px/1 Georgia, 'Times New Roman', serif; color:#6b7280; letter-spacing:.4px; }`
}

export function htmlCabeceraPDF(E, { colorTitulo, titulo, numero, lblTelefono = 'Teléfono', lblWeb = 'Sitio web' } = {}) {
  const alto = E.logoAlto || 70
  const align = E.logoAlign || 'left'
  const colW = align === 'left' ? 'auto' : '210px'
  const just = ({ left: 'flex-start', center: 'center', right: 'flex-end' })[align] || 'flex-start'
  const logo = E.logo
    ? `<img src="${_esc(E.logo)}" alt="${_esc(E.corto)}" style="height:${alto}px; max-width:210px;" onerror="this.outerHTML='<span class=&quot;logo-txt&quot;>${_esc(E.corto)}</span>'">`
    : `<span class="logo-txt">${_esc(E.corto || E.nombre)}</span>`
  const l = (k, v) => v ? `<br><b>${k}:</b> ${_esc(v)}` : ''
  return `
  <div style="position:relative;">
    <div class="zv"><span class="zv-in"><span class="zv-txt">by:</span><span class="zv-mono">ZV</span></span></div>
    <div class="top">
      <div class="logo" style="width:${colW}; justify-content:${just};">${logo}</div>
      <div class="emp"><span class="rz">${_esc(E.nombre)}</span>${E.ruc ? `<br><span class="ruc">RUC ${_esc(E.ruc)}</span>` : ''}${E.direccion ? '<br>' + _esc(E.direccion) : ''}${l('Email', E.email)}${l(lblTelefono, E.telefono)}${l(lblWeb, E.web)}</div>
      <div class="doc"><b style="color:${colorTitulo || '#111'};">${_esc(titulo)}</b><span style="font-size:14px;">${_esc(numero)}</span></div>
    </div>
  </div>`
}
