// ============================================================================
// RESUMEN-ANALISIS.JS — Tab 7 "Resumen Final" (FASE C)
// ============================================================================
// Replica en pantalla el Excel "Jhiro & Benji — Análisis general", con sus dos
// bloques y sus columnas en el mismo orden:
//
//   Estado de contenedores
//     IMP. · CONT. · ARTICULO · COSTO · % UTILIDAD · UTI POR KG ·
//     VALOR VENTA · PRECIO · STOCK · UTILIDAD REC. · VENTA
//   Datos de contenedores pendientes
//     IMP. · CONT. · ARTICULO · ETA · DIAS · MES
//
// El margen es SOBRE LA VENTA, igual que la hoja original:
//   uti/kg = costo × m/(1−m)   ·   valor venta = costo/(1−m)   ·   precio = ×1.18
//
// El COSTO sale del prorrateo del ledger (v_importacion_costo_detalle, SQL 89),
// no de un número escrito a mano: cambiar una factura en el tab 5 mueve este
// reporte sin tocar nada más.
//
// Descargas: PDF (A4 VERTICAL, columnas ajustadas al ancho de la hoja) y XLSX
// con la misma estructura de la hoja original.
// ============================================================================

import { supabase, update, query, esperarContextoEmpresa } from '../supabase-client.js'
import { showToast, formatNumber, fechaDMY } from '../helpers.js'
import { columnasAuto } from '../col-menu.js'

const n2 = v => formatNumber(parseFloat(v) || 0, 2)
const n4 = v => formatNumber(parseFloat(v) || 0, 4)
const n0 = v => formatNumber(parseFloat(v) || 0, 0)
const num = v => parseFloat(v) || 0

const LS_ALCANCE = 'impResumenAlcance'
let _filas = []
let _cuadre = []
let _empresas = []
let _alcance = localStorage.getItem(LS_ALCANCE) || 'consolidado'  // 'consolidado' | 'carpeta'
let _orden = { campo: 'articulo', dir: 'asc' }

const carpetaActual = () => window.costeoActual?.carpeta_importacion_id || null

// ─────────────────────────────────────────────────────────────────────────────
// DATOS
// ─────────────────────────────────────────────────────────────────────────────
export async function getAnalisisGeneral(carpetaId = null) {
  let q = supabase.from('v_importacion_analisis_general').select('*')
  if (carpetaId) q = q.eq('carpeta_id', carpetaId)
  const { data, error } = await q
  if (error) {
    console.warn('getAnalisisGeneral:', error.message)
    if (/does not exist|relation/i.test(error.message)) return { falta_sql: true, filas: [] }
    return { filas: [] }
  }
  return { filas: data || [] }
}

export async function getCuadreProrrateo(carpetaId = null) {
  let q = supabase.from('v_importacion_prorrateo_cuadre').select('*')
  if (carpetaId) q = q.eq('carpeta_id', carpetaId)
  const { data, error } = await q
  if (error) { console.warn('getCuadreProrrateo:', error.message); return [] }
  return data || []
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────────────────────
export async function renderResumenFinal() {
  const host = document.getElementById('contenido-resumen')
  if (!host) return

  // Sin contexto de empresa el filtro devuelve vacio a proposito: esperarlo.
  await esperarContextoEmpresa()

  const carpetaId = _alcance === 'carpeta' ? carpetaActual() : null
  if (_alcance === 'carpeta' && !carpetaId) {
    host.innerHTML = _aviso('Selecciona una importación arriba, o cambia el alcance a “Consolidado”.')
    return
  }

  host.innerHTML = '<p style="text-align:center; padding:24px; color:var(--text-secondary);">Calculando costos y márgenes…</p>'

  const [an, cuadre] = await Promise.all([
    getAnalisisGeneral(carpetaId),
    getCuadreProrrateo(carpetaId)
  ])

  if (an.falta_sql) {
    host.innerHTML = _aviso(
      'Falta correr el script del prorrateo.',
      'Ejecuta <code>assets/sql/89_importaciones_prorrateo_y_analisis.sql</code> en Supabase: crea el prorrateo por artículo y las vistas de este reporte.'
    )
    return
  }

  _filas = an.filas
  _cuadre = cuadre
  if (!_empresas.length) _empresas = (await query('empresa_config', {})) || []

  _pintar()
}

function _aviso(titulo, detalle = '') {
  return `
    <div style="padding:14px 16px; background:var(--bg-secondary); border-radius:var(--radius-md);
                border-left:3px solid var(--color-warning); font-size:0.9rem; line-height:1.6;">
      <strong>${titulo}</strong>
      ${detalle ? `<div style="color:var(--text-secondary); margin-top:4px;">${detalle}</div>` : ''}
    </div>`
}

function _ordenadas() {
  const dir = _orden.dir === 'asc' ? 1 : -1
  return _filas.slice().sort((a, b) => {
    // Siempre agrupado por empresa primero, como en el Excel (J arriba, B abajo)
    const e = String(a.empresa_inicial || '').localeCompare(String(b.empresa_inicial || ''))
    if (e !== 0) return e
    const va = a[_orden.campo], vb = b[_orden.campo]
    if (typeof va === 'number' || typeof vb === 'number') return ((va || 0) - (vb || 0)) * dir
    return String(va ?? '').localeCompare(String(vb ?? ''), 'es', { numeric: true }) * dir
  })
}

function _totales(filas) {
  return filas.reduce((t, f) => ({
    stock: t.stock + num(f.stock),
    utilidad: t.utilidad + num(f.utilidad_recuperable),
    venta: t.venta + num(f.venta_potencial),
    inventario: t.inventario + num(f.inventario_valorizado)
  }), { stock: 0, utilidad: 0, venta: 0, inventario: 0 })
}

function _pintar() {
  const host = document.getElementById('contenido-resumen')
  const filas = _ordenadas()
  const t = _totales(filas)
  const descuadres = _cuadre.filter(c => c.cuadra === false)
  const sinBase = _cuadre.reduce((s, c) => s + num(c.lineas_sin_base), 0)

  if (!filas.length) {
    host.innerHTML = _aviso(
      'Todavía no hay artículos costeados.',
      'El reporte sale del detalle de la Commercial Invoice más los costos del tab 5. Registra el detalle de productos y al menos un costo.'
    )
    return
  }

  const th = (key, label, der = false) =>
    `<th style="cursor:pointer; ${der ? 'text-align:right;' : ''}" onclick="window.ordenarAnalisisGeneral('${key}')">${label} ${_orden.campo === key ? (_orden.dir === 'asc' ? '▲' : '▼') : '⇅'}</th>`

  host.innerHTML = `
    ${descuadres.length || sinBase ? _aviso(
      `${descuadres.length ? `${descuadres.length} carpeta(s) con el prorrateo descuadrado` : ''}${descuadres.length && sinBase ? ' · ' : ''}${sinBase ? `${sinBase} línea(s) de costo sin base para repartir` : ''}`,
      'Suele ser una línea de la Commercial Invoice sin peso o sin FOB: ese costo no se reparte y el costo por kg sale bajo. Revisa el tab 1 (detalle de productos).'
    ) : ''}

    <!-- KPIs -->
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(170px,1fr)); gap:10px; margin-bottom:14px;">
      ${_tile('Utilidad recuperable', '$ ' + n2(t.utilidad), 'si se vende todo el stock', 'success')}
      ${_tile('Venta potencial', '$ ' + n2(t.venta), 'sin IGV')}
      ${_tile('Inventario valorizado', '$ ' + n2(t.inventario), 'a costo de gestión')}
      ${_tile('Stock total', n2(t.stock) + ' kg', `${filas.length} artículo(s)`)}
    </div>

    <!-- BLOQUE A: ESTADO DE CONTENEDORES -->
    <strong style="display:block; margin:4px 0 8px; color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase; letter-spacing:0.03em;">Estado de contenedores</strong>
    <div class="table-container">
      <table class="table" id="tbl-analisis-general">
        <thead>
          <tr>
            ${th('empresa_inicial', 'IMP.')}
            ${th('contenedor', 'CONT.')}
            ${th('articulo', 'ARTICULO')}
            ${th('costo_kg', 'COSTO', true)}
            <th style="text-align:right">% UTILIDAD</th>
            ${th('utilidad_kg', 'UTI POR KG', true)}
            ${th('valor_venta_kg', 'VALOR VENTA', true)}
            ${th('precio_con_igv', 'PRECIO', true)}
            ${th('stock', 'STOCK', true)}
            ${th('utilidad_recuperable', 'UTILIDAD REC.', true)}
            ${th('venta_potencial', 'VENTA', true)}
          </tr>
        </thead>
        <tbody>
          ${filas.map(f => _filaA(f)).join('')}
        </tbody>
        <tfoot>
          <tr style="font-weight:700; background:var(--bg-secondary);">
            <td colspan="8">TOTAL — ${filas.length} artículo(s)</td>
            <td style="text-align:right">${n2(t.stock)}</td>
            <td style="text-align:right">${n2(t.utilidad)}</td>
            <td style="text-align:right">${n2(t.venta)}</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <!-- BLOQUE B: ANTIGÜEDAD -->
    <strong style="display:block; margin:18px 0 4px; color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase; letter-spacing:0.03em;">Datos de contenedores pendientes</strong>
    <small style="display:block; margin-bottom:8px; color:var(--text-secondary);">Días y meses desde el ETA — cuánto tiempo lleva esa mercadería en casa.</small>
    <div class="table-container">
      <table class="table" id="tbl-analisis-antiguedad">
        <thead>
          <tr>
            <th>IMP.</th><th>CONT.</th><th>ARTICULO</th>
            <th>ETA</th><th style="text-align:right">DIAS</th><th style="text-align:right">MES</th>
            <th>Llegada</th><th style="text-align:right">Stock</th>
          </tr>
        </thead>
        <tbody>
          ${filas.map(f => `
            <tr>
              <td>${f.empresa_inicial || '—'}</td>
              <td>${f.contenedor || '—'}</td>
              <td>${f.articulo}</td>
              <td>${f.fecha_eta ? fechaDMY(f.fecha_eta) : '—'}</td>
              <td style="text-align:right">${f.dias_desde_eta != null ? n0(f.dias_desde_eta) : '—'}</td>
              <td style="text-align:right">${f.meses_desde_eta != null ? n2(f.meses_desde_eta) : '—'}</td>
              <td>${f.fecha_llegada ? fechaDMY(f.fecha_llegada) : '<span class="badge badge-warning">en tránsito</span>'}</td>
              <td style="text-align:right">${n2(f.stock)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`

  columnasAuto(document.getElementById('tbl-analisis-general'), 'impAnalisis', {
    ocultas: [], card: host.closest('.card')
  })
}

function _tile(label, valor, sub = '', color = '') {
  return `
    <div style="padding:10px 12px; background:var(--bg-secondary); border-radius:var(--radius-md);">
      <div style="font-size:0.7rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">${label}</div>
      <div style="font-weight:700; font-size:1.05rem; ${color ? `color:var(--color-${color});` : ''}">${valor}</div>
      ${sub ? `<div style="font-size:0.78rem; color:var(--text-secondary);">${sub}</div>` : ''}
    </div>`
}

function _filaA(f) {
  const pct = (num(f.margen) * 100)
  const sinCosto = !num(f.costo_kg)
  return `
    <tr${sinCosto ? ' style="opacity:.6"' : ''}>
      <td><span class="badge">${f.empresa_inicial || '?'}</span></td>
      <td>${f.contenedor || '—'}</td>
      <td>${f.articulo}${f.inventariable === false ? ' <span class="badge badge-warning" title="No inventariable: muestra o embalaje">no vendible</span>' : ''}${f.lote_costo_provisional ? ' <span class="badge badge-warning" title="El lote tiene costo provisional">prov.</span>' : ''}</td>
      <td style="text-align:right">${sinCosto ? '—' : n4(f.costo_kg)}</td>
      <td style="text-align:right">
        <input type="number" value="${pct.toFixed(0)}" min="0" max="95" step="1"
               style="width:62px; text-align:right; padding:2px 4px;"
               onchange="window.guardarMargenArticulo(${f.detalle_id}, this.value)"
               title="Margen sobre la venta: precio = costo / (1 - m)">%
      </td>
      <td style="text-align:right">${n4(f.utilidad_kg)}</td>
      <td style="text-align:right">${n4(f.valor_venta_kg)}</td>
      <td style="text-align:right">${n4(f.precio_con_igv)}</td>
      <td style="text-align:right">${n2(f.stock)}</td>
      <td style="text-align:right">${n2(f.utilidad_recuperable)}</td>
      <td style="text-align:right">${n2(f.venta_potencial)}</td>
    </tr>`
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERACCIÓN
// ─────────────────────────────────────────────────────────────────────────────
window.ordenarAnalisisGeneral = function (campo) {
  if (_orden.campo === campo) _orden.dir = _orden.dir === 'asc' ? 'desc' : 'asc'
  else _orden = { campo, dir: 'asc' }
  _pintar()
}

window.cambiarAlcanceResumen = async function (alcance) {
  _alcance = alcance
  localStorage.setItem(LS_ALCANCE, alcance)
  document.querySelectorAll('#alcance-resumen .reporte-chip').forEach(b =>
    b.classList.toggle('on', b.dataset.alcance === alcance))
  await renderResumenFinal()
}

/** Guarda el % de utilidad del artículo (margen sobre la venta) y recalcula. */
window.guardarMargenArticulo = async function (detalleId, valorPct) {
  const pct = parseFloat(valorPct)
  if (!Number.isFinite(pct) || pct < 0 || pct >= 100) {
    showToast('El margen debe estar entre 0 y 95', 'warning')
    await renderResumenFinal()
    return
  }
  const ok = await update('detalle_comercial_invoice', detalleId, { margen_objetivo: pct / 100 })
  if (!ok) { showToast('No se pudo guardar el margen', 'danger'); return }
  showToast(`Margen actualizado a ${pct.toFixed(0)}%`, 'success')
  await renderResumenFinal()
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTAR — PDF A4 VERTICAL con las columnas ajustadas al ancho de la hoja
// ─────────────────────────────────────────────────────────────────────────────
const HEAD_A = ['IMP.', 'CONT.', 'ARTICULO', 'COSTO', '% UTIL.', 'UTI POR KG',
                'VALOR VENTA', 'PRECIO', 'STOCK', 'UTILIDAD REC.', 'VENTA']
const HEAD_B = ['IMP.', 'CONT.', 'ARTICULO', 'ETA', 'DIAS', 'MES']

function _tituloReporte() {
  const act = _empresas.filter(e => e.codigo).map(e => e.nombre_comercial || e.razon_social)
  const enFilas = [...new Set(_filas.map(f => f.empresa_nombre).filter(Boolean))]
  return (enFilas.length ? enFilas : act).join(' & ') || 'Análisis general'
}

function _cuerpoA(filas) {
  return filas.map(f => [
    f.empresa_inicial || '',
    f.contenedor || '',
    f.articulo || '',
    num(f.costo_kg) ? n4(f.costo_kg) : '-',
    (num(f.margen) * 100).toFixed(0) + '%',
    n4(f.utilidad_kg),
    n4(f.valor_venta_kg),
    n4(f.precio_con_igv),
    n2(f.stock),
    n2(f.utilidad_recuperable),
    n2(f.venta_potencial)
  ])
}

function _cuerpoB(filas) {
  return filas.map(f => [
    f.empresa_inicial || '',
    f.contenedor || '',
    f.articulo || '',
    f.fecha_eta ? fechaDMY(f.fecha_eta) : '-',
    f.dias_desde_eta != null ? n0(f.dias_desde_eta) : '-',
    f.meses_desde_eta != null ? n2(f.meses_desde_eta) : '-'
  ])
}

/** Ancho por columna: el del texto más largo, escalado para llenar la hoja. */
function _anchos(doc, head, body, fs, disponible) {
  doc.setFontSize(fs)
  const crudos = head.map((h, c) => {
    doc.setFont('helvetica', 'bold')
    let w = doc.getTextWidth(String(h ?? ''))
    doc.setFont('helvetica', 'normal')
    for (const fila of body) w = Math.max(w, doc.getTextWidth(String(fila[c] ?? '')))
    return w + 2.4
  })
  const suma = crudos.reduce((a, b) => a + b, 0)
  if (suma <= disponible) {
    // sobra espacio: se reparte el excedente en la columna de ARTICULO
    const extra = disponible - suma
    return crudos.map((w, i) => i === 2 ? w + extra : w)
  }
  // no entra: se achica proporcionalmente, pero ARTICULO absorbe más recorte
  const k = disponible / suma
  return crudos.map(w => w * k)
}

window.exportarAnalisisPDF = async function () {
  try {
    const filas = _ordenadas()
    if (!filas.length) { showToast('No hay datos para exportar', 'warning'); return }

    const { jsPDF } = await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm')
    const { applyPlugin } = await import('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/+esm')
    applyPlugin(jsPDF)

    const MARGEN = 8
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    const disponible = doc.internal.pageSize.getWidth() - MARGEN * 2   // 210 - 16 = 194 mm
    const t = _totales(filas)

    // Cabecera igual que la hoja: razón social + título + fecha
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12)
    doc.text(_tituloReporte(), MARGEN, 12)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9)
    doc.text('Costeo de importación — Análisis general', MARGEN, 17)
    doc.text(fechaDMY(new Date().toISOString().slice(0, 10)), disponible + MARGEN, 12, { align: 'right' })
    doc.setFontSize(8)
    doc.text(_alcance === 'carpeta' ? 'Alcance: carpeta seleccionada' : 'Alcance: consolidado (todas las carpetas)',
             disponible + MARGEN, 17, { align: 'right' })

    const derA = new Set([3, 4, 5, 6, 7, 8, 9, 10])
    const bodyA = _cuerpoA(filas)
    const fsA = bodyA.length > 40 ? 6 : 7
    const anchosA = _anchos(doc, HEAD_A, bodyA, fsA, disponible)
    const colA = {}
    anchosA.forEach((w, i) => { colA[i] = { cellWidth: w, halign: derA.has(i) ? 'right' : 'left' } })

    doc.setFontSize(9); doc.setFont('helvetica', 'bold')
    doc.text('Estado de contenedores', MARGEN, 24)
    doc.autoTable({
      head: [HEAD_A], body: bodyA,
      foot: [['TOTAL', '', `${filas.length} articulo(s)`, '', '', '', '', '',
              n2(t.stock), n2(t.utilidad), n2(t.venta)]],
      startY: 27,
      margin: { left: MARGEN, right: MARGEN },
      styles: { fontSize: fsA, cellPadding: 1.1, overflow: 'linebreak', valign: 'middle' },
      headStyles: { fontStyle: 'bold', fillColor: [230, 232, 236], textColor: 20 },
      footStyles: { fontStyle: 'bold', fillColor: [240, 241, 244], textColor: 20, halign: 'right' },
      columnStyles: colA,
      didParseCell: d => {
        if (d.section === 'head') d.cell.styles.halign = derA.has(d.column.index) ? 'right' : 'left'
        if (d.section === 'foot' && d.column.index < 8) d.cell.styles.halign = 'left'
      }
    })

    // Bloque B en la misma hoja si cabe, si no en la siguiente
    let y = doc.lastAutoTable.finalY + 8
    if (y > doc.internal.pageSize.getHeight() - 40) { doc.addPage(); y = 16 }
    const bodyB = _cuerpoB(filas)
    const derB = new Set([4, 5])
    const anchosB = _anchos(doc, HEAD_B, bodyB, fsA, disponible)
    const colB = {}
    anchosB.forEach((w, i) => { colB[i] = { cellWidth: w, halign: derB.has(i) ? 'right' : 'left' } })

    doc.setFontSize(9); doc.setFont('helvetica', 'bold')
    doc.text('Datos de contenedores pendientes', MARGEN, y)
    doc.autoTable({
      head: [HEAD_B], body: bodyB,
      startY: y + 3,
      margin: { left: MARGEN, right: MARGEN },
      styles: { fontSize: fsA, cellPadding: 1.1, overflow: 'linebreak', valign: 'middle' },
      headStyles: { fontStyle: 'bold', fillColor: [230, 232, 236], textColor: 20 },
      columnStyles: colB,
      didParseCell: d => { if (d.section === 'head') d.cell.styles.halign = derB.has(d.column.index) ? 'right' : 'left' }
    })

    // Pie con numeración
    const total = doc.internal.getNumberOfPages()
    for (let p = 1; p <= total; p++) {
      doc.setPage(p)
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7)
      doc.text(`Página ${p} de ${total}`, disponible + MARGEN,
               doc.internal.pageSize.getHeight() - 6, { align: 'right' })
      doc.text('Costo = costo de gestión por kg (CIF + nacionalización + reposición). Margen sobre la venta.',
               MARGEN, doc.internal.pageSize.getHeight() - 6)
    }

    doc.save(`Analisis_general_${new Date().toISOString().slice(0, 10)}.pdf`)
  } catch (e) {
    console.error('exportarAnalisisPDF:', e)
    showToast('No se pudo generar el PDF: ' + (e.message || e), 'danger')
  }
}

window.exportarAnalisisXLSX = async function () {
  try {
    const filas = _ordenadas()
    if (!filas.length) { showToast('No hay datos para exportar', 'warning'); return }

    let XLSX
    try { XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm') }
    catch (e) { showToast('No cargó SheetJS (sin internet). Usa el PDF.', 'warning'); return }

    const t = _totales(filas)
    const nd = v => num(v) || 0
    const aoa = [
      [_tituloReporte(), '', '', '', '', '', '', '', '', '', new Date().toISOString().slice(0, 10)],
      ['Costeo de importación — Análisis general', '', '',
       _alcance === 'carpeta' ? 'Alcance: carpeta seleccionada' : 'Alcance: consolidado'],
      [],
      ['Estado de contenedores'],
      HEAD_A,
      ...filas.map(f => [
        f.empresa_inicial || '', f.contenedor || '', f.articulo || '',
        nd(f.costo_kg), nd(f.margen), nd(f.utilidad_kg), nd(f.valor_venta_kg),
        nd(f.precio_con_igv), nd(f.stock), nd(f.utilidad_recuperable), nd(f.venta_potencial)
      ]),
      ['TOTAL', '', `${filas.length} articulo(s)`, '', '', '', '', '',
       t.stock, t.utilidad, t.venta],
      [],
      ['Datos de contenedores pendientes'],
      HEAD_B,
      ...filas.map(f => [
        f.empresa_inicial || '', f.contenedor || '', f.articulo || '',
        f.fecha_eta || '', f.dias_desde_eta ?? '', f.meses_desde_eta ?? ''
      ])
    ]

    const ws = XLSX.utils.aoa_to_sheet(aoa)
    const filaCabA = 4                       // 0-based: fila de HEAD_A
    const primera = filaCabA + 1
    const ultima = primera + filas.length - 1
    const fmt = { 3: '0.0000', 4: '0%', 5: '0.0000', 6: '0.0000', 7: '0.0000', 8: '#,##0.00', 9: '#,##0.00', 10: '#,##0.00' }
    for (let r = primera; r <= ultima + 1; r++) {
      for (const [c, z] of Object.entries(fmt)) {
        const ref = XLSX.utils.encode_cell({ r, c: +c })
        if (ws[ref] && typeof ws[ref].v === 'number') ws[ref].z = z
      }
    }
    ws['!cols'] = [
      { wch: 6 }, { wch: 10 }, { wch: 38 }, { wch: 10 }, { wch: 10 }, { wch: 11 },
      { wch: 12 }, { wch: 11 }, { wch: 11 }, { wch: 14 }, { wch: 14 }
    ]
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 9 } }]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Analisis General')
    XLSX.writeFile(wb, `Analisis_general_${new Date().toISOString().slice(0, 10)}.xlsx`)
  } catch (e) {
    console.error('exportarAnalisisXLSX:', e)
    showToast('No se pudo generar el Excel: ' + (e.message || e), 'danger')
  }
}

window.renderResumenFinal = renderResumenFinal

export default { renderResumenFinal, getAnalisisGeneral, getCuadreProrrateo }
