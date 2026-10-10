// ============================================================================
// PDT-CONSTANCIA.JS — Dibuja un formulario PDT con la MISMA distribución de la
// constancia SUNAT (cabecera con recuadros, secciones con casilla + importe,
// columnas BASE / TRIBUTO o IGV / IVAP / RENTA). 2026-10-09.
// Lo reutilizan todos los PDT del ERP (621 hoy; 601, 617, 626, 648… después).
//
// IMPORTANTE: es un BORRADOR para revisar antes de declarar. La leyenda de la
// esquina dice "Borrador generado por el ERP — no es constancia SUNAT" y el
// N° de orden solo aparece si el usuario registró el de su declaración real.
//
// Uso:
//   const doc = await nuevoDocPDT()
//   dibujarPaginaPDT(doc, cab, bloques, { pagina: 1 })
//   doc.addPage(); dibujarPaginaPDT(doc, cab, bloques2, { pagina: 2 })
//   doc.save('...pdf')
//
//   cab = { formulario:'0621', titulo:'PDT IGV - RENTA MENSUAL', ruc, razon,
//           periodo:'202607', numeroOrden, fechaPresentacion, tipoDeclaracion, moneda }
//   bloque = { titulo:'IGV VENTAS', cabecera:'IGV CUENTA PROPIA',
//              columnas:['BASE','TRIBUTO'],          // 1 a 3 grupos casilla+importe
//              anchoLabel: 104,                       // mm de la zona de conceptos (opcional)
//              filas:[ { label:'Ventas Netas', grupo:'Gravadas', sub:null,
//                        celdas:[['100', 484137], ['101', 87145]] },
//                      { label:'Total', celdas:[null, ['131', 87145]] } ] }
//   celda = null (vacía, sin recuadro) | ['casilla', valor, decimales?]
// ============================================================================

const X0 = 14            // margen izquierdo (mm)
const X1 = 196           // margen derecho
const H = 4.2            // alto de fila
const FS = 6.2           // tamaño de letra de filas

export async function nuevoDocPDT() {
  const { jsPDF } = await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm')
  return new jsPDF({ orientation: 'portrait', format: 'a4', unit: 'mm' })
}

export function fmtPDT(v, dec = 2) {
  if (v === null || v === undefined || v === '' || isNaN(v)) return ''
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
}

function _caja(doc, x, y, w, h, texto = '', { align = 'left', bold = false, size = FS, fill = null } = {}) {
  if (fill) { doc.setFillColor(...fill); doc.rect(x, y, w, h, 'FD') } else doc.rect(x, y, w, h)
  if (texto === '' || texto === null || texto === undefined) return
  doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size)
  const ty = y + h / 2 + size * 0.13
  if (align === 'right') doc.text(String(texto), x + w - 1, ty, { align: 'right' })
  else if (align === 'center') doc.text(String(texto), x + w / 2, ty, { align: 'center' })
  else doc.text(String(texto), x + 1, ty)
}

/** Cabecera idéntica en distribución a la constancia (recuadro SUNAT + datos). */
export function dibujarCabeceraPDT(doc, cab, pagina = 1) {
  doc.setDrawColor(0); doc.setLineWidth(0.2)
  const y = 10
  // Recuadro izquierdo
  doc.rect(X0, y, 36, 25)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('SUNAT', X0 + 18, y + 6, { align: 'center' })
  doc.line(X0, y + 8, X0 + 36, y + 8)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.text('DECLARACIÓN PAGO', X0 + 18, y + 13, { align: 'center' })
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text(cab.formulario || '', X0 + 18, y + 20, { align: 'center' })
  // Título central
  _caja(doc, X0 + 36, y, 122, 5, cab.titulo || '', { align: 'center', bold: true, size: 7 })
  // Esquina derecha (leyenda de borrador)
  doc.rect(X0 + 158, y, 24, 25)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(4.6)
  doc.text(['Borrador generado', 'por el ERP — no es', 'constancia SUNAT', `(Pag. ${pagina})`], X0 + 170, y + 8, { align: 'center' })
  // Filas de datos
  const filas = [
    ['RUC', cab.ruc, '', ''],
    ['Razón Social', cab.razon, 'Período', cab.periodo],
    ['Número de Orden', cab.numeroOrden || '—', 'Fecha de Presentación', cab.fechaPresentacion || '—'],
    ['Tipo de Declaración', cab.tipoDeclaracion || 'Original', 'Tipo de Moneda', cab.moneda || 'Soles']
  ]
  filas.forEach((f, i) => {
    const yy = y + 5 + i * 5
    _caja(doc, X0 + 36, yy, 20, 5, f[0], { size: 5.8 })
    if (i === 0) { _caja(doc, X0 + 56, yy, 102, 5, f[1], { size: 5.8 }); return }
    _caja(doc, X0 + 56, yy, 46, 5, f[1], { size: 5.8 })
    _caja(doc, X0 + 102, yy, 30, 5, f[2], { size: 5.8 })
    _caja(doc, X0 + 132, yy, 26, 5, f[3], { size: 5.8, align: 'center' })
  })
  return y + 25 + 8
}

/** Dibuja un bloque (sección) y devuelve la Y siguiente. */
export function dibujarBloquePDT(doc, y, b) {
  const nGr = (b.columnas || []).length || 1
  const anchoGrupo = b.anchoGrupo || (nGr === 3 ? 34 : 40)
  const wCas = 10, wVal = anchoGrupo - wCas
  const xGr = X1 - nGr * anchoGrupo                 // inicio de columnas numéricas
  const xLab = X0, wLab = xGr - X0 - 2
  // Título de sección
  doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.text(b.titulo || '', xLab, y + 3)
  // Cabecera de columnas
  if (b.cabecera) _caja(doc, xGr, y, nGr * anchoGrupo, H, b.cabecera, { align: 'center', size: 5.8 })
  ;(b.columnas || []).forEach((c, i) => _caja(doc, xGr + i * anchoGrupo, y + H, anchoGrupo, H, c, { align: 'center', size: 5.8 }))
  y += H * 2 + 1
  // Agrupar filas por "grupo" (etiqueta vertical) para dibujar su recuadro
  const yIni = y
  const grupos = []
  b.filas.forEach((f, i) => {
    const yy = yIni + i * H
    if (f.grupo) {
      const g = grupos[grupos.length - 1]
      if (g && g.nombre === f.grupo && g.hasta === i - 1) g.hasta = i
      else grupos.push({ nombre: f.grupo, desde: i, hasta: i })
    }
    const off = f.grupo ? 6 : 0
    if (f.sub) {
      // concepto partido: [rotulo (sub) | detalle]
      if (f.subInicio) _caja(doc, xLab + off, yy, 26, H * (f.subFilas || 1), f.sub, { size: FS })
      _caja(doc, xLab + off + 26, yy, wLab - off - 26, H, f.label, { size: FS })
    } else {
      _caja(doc, xLab + off, yy, wLab - off, H, f.label, { size: FS, bold: !!f.bold })
    }
    ;(f.celdas || []).forEach((c, gi) => {
      if (!c) return
      const x = xGr + gi * anchoGrupo
      _caja(doc, x, yy, wCas, H, c[0], { size: FS })
      const dec = c[2] ?? 2
      _caja(doc, x + wCas, yy, wVal, H, c[1] === null || c[1] === undefined ? '' : fmtPDT(c[1], dec), { size: FS, align: dec === 'txt' ? 'center' : 'center' })
    })
  })
  // etiquetas verticales
  grupos.forEach(g => {
    const yy = yIni + g.desde * H, hh = (g.hasta - g.desde + 1) * H
    doc.rect(xLab, yy, 6, hh)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(5.5)
    doc.text(g.nombre, xLab + 4, yy + hh / 2 + doc.getTextWidth(g.nombre) / 2, { angle: 90 })
  })
  return yIni + b.filas.length * H + 6
}

/** Página completa: cabecera + bloques. */
export function dibujarPaginaPDT(doc, cab, bloques, { pagina = 1 } = {}) {
  let y = dibujarCabeceraPDT(doc, cab, pagina)
  for (const b of bloques) {
    if (y + (b.filas.length + 3) * H > 285) { doc.addPage(); y = dibujarCabeceraPDT(doc, cab, pagina + 1) }
    y = dibujarBloquePDT(doc, y, b)
  }
  return y
}

// ============================================================================
// VERSIÓN HTML (pantalla) — misma distribución que el PDF, para la vista
// interactiva. Cada celda de casilla/importe lleva data-cas="NNN" para que el
// módulo que la usa agregue resaltado de dependencias y globitos.
//   opts.celda(k, v, dec) → HTML del importe (p.ej. un <input> en casillas manuales)
//   opts.claseCelda(k)    → clases extra para la celda (p.ej. 'pdt-difiere')
// Estilos: .pdtf-* en styles.css
// ============================================================================
const _e = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export function htmlCabeceraPDT(cab, pagina = 1) {
  return `<table class="pdtf-cab">
    <tr>
      <td rowspan="5" class="b pdtf-logo"><div class="pdtf-sunat">SUNAT</div><div class="pdtf-decl">DECLARACIÓN PAGO</div><div class="pdtf-form">${_e(cab.formulario)}</div></td>
      <td colspan="4" class="b pdtf-tit">${_e(cab.titulo)}</td>
      <td rowspan="5" class="b pdtf-esq">Borrador generado por el ERP<br>— no es constancia SUNAT<br>(Pag. ${pagina})</td>
    </tr>
    <tr><td class="b pdtf-k">RUC</td><td class="b" colspan="3">${_e(cab.ruc)}</td></tr>
    <tr><td class="b pdtf-k">Razón Social</td><td class="b">${_e(cab.razon)}</td><td class="b pdtf-k">Período</td><td class="b c">${_e(cab.periodo)}</td></tr>
    <tr><td class="b pdtf-k">Número de Orden</td><td class="b">${_e(cab.numeroOrden || '—')}</td><td class="b pdtf-k">Fecha de Presentación</td><td class="b c">${_e(cab.fechaPresentacion || '—')}</td></tr>
    <tr><td class="b pdtf-k">Tipo de Declaración</td><td class="b">${_e(cab.tipoDeclaracion || 'Original')}</td><td class="b pdtf-k">Tipo de Moneda</td><td class="b c">${_e(cab.moneda || 'Soles')}</td></tr>
  </table>`
}

export function htmlBloquePDT(b, opts = {}) {
  const n = (b.columnas || []).length || 1
  const celda = opts.celda || ((k, v, dec) => (v === null || v === undefined) ? '' : fmtPDT(v, dec))
  const clase = opts.claseCelda || (() => '')
  // rowspans de grupo (vertical) y sub (Exportaciones)
  const spanG = {}, spanS = {}
  b.filas.forEach((f, i) => {
    if (f.grupo && (i === 0 || b.filas[i - 1].grupo !== f.grupo)) {
      let j = i; while (j + 1 < b.filas.length && b.filas[j + 1].grupo === f.grupo) j++
      spanG[i] = j - i + 1
    }
    if (f.sub && f.subInicio) spanS[i] = f.subFilas || 1
  })
  const filas = b.filas.map((f, i) => {
    let lab = ''
    if (f.grupo) {
      if (spanG[i]) lab += `<td class="b pdtf-vert" rowspan="${spanG[i]}"><span>${_e(f.grupo)}</span></td>`
      lab += `<td class="b" colspan="2">${_e(f.label)}</td>`
    } else if (f.sub) {
      if (spanS[i]) lab += `<td class="b" colspan="2" rowspan="${spanS[i]}">${_e(f.sub)}</td>`
      lab += `<td class="b">${_e(f.label)}</td>`
    } else lab = `<td class="b" colspan="3">${_e(f.label)}</td>`
    const cels = (f.celdas || []).map(c => {
      if (!c) return '<td class="sin" colspan="2"></td>'
      const [k, v, dec] = c
      return `<td class="b pdtf-cas" data-cas="${k}">${k}</td><td class="b pdtf-val ${clase(k)}" data-cas="${k}">${celda(k, v, dec ?? 2)}</td>`
    }).join('')
    return `<tr>${lab}<td class="sin"></td>${cels}</tr>`
  }).join('')
  const cols = Array.from({ length: n }, () => '<col class="pdtf-ccas"><col class="pdtf-cval">').join('')
  return `<div class="pdtf-bloque">
    <table class="pdtf-tabla">
      <colgroup><col class="pdtf-cg"><col class="pdtf-cs"><col><col class="pdtf-csp">${cols}</colgroup>
      <thead>
        <tr><th colspan="4" class="sin pdtf-btit">${_e(b.titulo)}</th><th colspan="${n * 2}" class="b">${_e(b.cabecera || '')}</th></tr>
        <tr><th colspan="4" class="sin"></th>${(b.columnas || []).map(c => `<th colspan="2" class="b">${_e(c)}</th>`).join('')}</tr>
      </thead>
      <tbody>${filas}</tbody>
    </table>
  </div>`
}

export function htmlPaginaPDT(cab, bloques, opts = {}) {
  return `<div class="pdtf-hoja">${htmlCabeceraPDT(cab, opts.pagina || 1)}${bloques.map(b => htmlBloquePDT(b, opts)).join('')}</div>`
}
