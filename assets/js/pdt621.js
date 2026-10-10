// ============================================================================
// PDT621.JS — Detalle PDT 621 (IGV – Renta mensual) armado desde el ERP
// (2026-10-09). Contabilidad → Reportes → "PDT 621".
// ----------------------------------------------------------------------------
// Calcula las casillas del Formulario 621 con ventas y compras del período,
// las compara con lo DECLARADO (tabla pdt621_declaraciones, SQL 82), lista
// alertas (correlativos faltantes, T.C. distinto a SUNAT, importaciones sin
// DUA…) y exporta PDF / Excel.
//
// Reglas (todas en soles, casillas redondeadas a enteros como SUNAT):
//   Ventas (por fecha de emisión, sin anuladas):
//     01/03/08 con IGV → 100/101 · NC 07 → 102/103 · sin IGV a cliente del
//     exterior → 106 · sin IGV local → 105.   131 = 101 − 103
//   Compras (por período de registro periodo_ano/mes, sin anuladas, NC restan):
//     local con IGV → 107/108 · local no gravada/exonerada → 120 ·
//     DUA (tipo 50) → 114/115 · factura del exterior (91 / sin RUC) → NO se
//     declara (informativa: su IGV va con la DUA).   178 = 108 + 115
//   Renta: 301 = 100 − 102 + 105 + 106 · 312 = 301 × (coef. 380 ó % 315)
//   Determinación: 140 = 131 − 178 · 184 = 140 − 145 · luego percepciones
//   (168+171) y retenciones (176+179) solo si hay tributo a pagar.
// ============================================================================
import { supabase } from './supabase-client.js'
import { showToast } from './helpers.js'
import { estaAnulado } from './anulacion.js'
import { getSeries } from './series.js'

const EMPRESA = { nombre: 'JHIRO PERU S.A.C.', ruc: '20600842995' }
const MANUALES = ['145', '168', '171', '176', '179', '303', '315', '380']
const AYUDA_MANUAL = {
  '145': 'Saldo a favor del período anterior (casilla 184 negativa del mes pasado)',
  '168': 'Saldo de percepciones de períodos anteriores (casilla 164 del mes pasado)',
  '171': 'Percepciones que te practicaron en el período',
  '176': 'Saldo de retenciones de períodos anteriores (casilla 165 del mes pasado)',
  '179': 'Retenciones de IGV que te practicaron en el período',
  '303': 'Saldo a favor de Renta del período anterior',
  '315': 'Porcentaje de pago a cuenta (%)',
  '380': 'Coeficiente (si aplica; 0 = usa el porcentaje)'
}
const SECCIONES = [
  { titulo: 'IGV — Ventas', filas: [
    ['100', 'Ventas netas gravadas — base'], ['101', 'Ventas netas gravadas — IGV'],
    ['102', 'Descuentos concedidos y/o devoluciones (NC) — base'], ['103', 'Descuentos y/o devoluciones (NC) — IGV'],
    ['106', 'Exportaciones facturadas en el período'], ['105', 'Ventas no gravadas (sin exportaciones)'],
    ['131', 'Total IGV ventas']
  ] },
  { titulo: 'IGV — Compras', filas: [
    ['107', 'Compras nacionales destinadas a ventas gravadas — base'], ['108', 'Compras nacionales gravadas — IGV'],
    ['114', 'Importaciones gravadas (DUA) — base'], ['115', 'Importaciones gravadas (DUA) — IGV'],
    ['120', 'Compras internas no gravadas'], ['122', 'Compras importadas no gravadas'],
    ['178', 'Total IGV compras (crédito fiscal)']
  ] },
  { titulo: 'Renta', filas: [
    ['301', 'Ingresos netos'], ['380', 'Coeficiente'], ['315', 'Porcentaje (%)'],
    ['894', 'Coeficiente / % aplicado'], ['312', 'Pago a cuenta de Renta']
  ] },
  { titulo: 'Determinación de la deuda — IGV', filas: [
    ['140', 'Impuesto resultante o saldo a favor'], ['145', 'Saldo a favor del período anterior'],
    ['184', 'Tributo a pagar o saldo a favor'],
    ['171', 'Percepciones declaradas en el período'], ['168', 'Saldo de percepciones de períodos anteriores'],
    ['164', 'Saldo de percepciones no aplicadas'],
    ['179', 'Retenciones declaradas en el período'], ['176', 'Saldo de retenciones de períodos anteriores'],
    ['165', 'Saldo de retenciones no aplicadas'],
    ['681', 'Sub total IGV a pagar'], ['188', 'Total deuda tributaria IGV']
  ] },
  { titulo: 'Determinación de la deuda — Renta', filas: [
    ['302', 'Impuesto resultante'], ['303', 'Saldo a favor del período anterior'],
    ['304', 'Tributo a pagar o saldo a favor'], ['682', 'Sub total Renta a pagar'], ['324', 'Total deuda tributaria Renta']
  ] }
]
const DECIMALES = { '315': 2, '380': 4, '894': 4 }

const S = { panelId: null, periodo: null, r: null, manual: {}, declarado: {}, info: {}, tablaOk: true, vista: 'form', filtroCas: null }

// PDTs del selector: solo el 621 está implementado; el resto se habilita al confirmar que aplican.
const PDTS = [
  { cod: '0621', nombre: 'PDT 621 — IGV / Renta mensual', listo: true },
  { cod: '0601', nombre: 'PDT 601 — PLAME (requiere módulo de planilla)', listo: false },
  { cod: '0617', nombre: 'PDT 617 — Otras retenciones (no domiciliados)', listo: false },
  { cod: '0626', nombre: 'PDT 626 — Agente de retención IGV', listo: false },
  { cod: '0634', nombre: 'PDT 634 — Agente de percepción', listo: false },
  { cod: '0648', nombre: 'PDT 648 — ITAN (anual)', listo: false }
]

const _esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const _r2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const _fmt = (n, dec = 0) => (n === null || n === undefined || n === '' || isNaN(n)) ? '' :
  Number(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
const _mesAnterior = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7) }
const _ultimoDia = (p) => { const [y, m] = p.split('-').map(Number); return `${p}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` }
const _nombrePeriodo = (p) => { const M = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Setiembre', 'Octubre', 'Noviembre', 'Diciembre']; const [y, m] = p.split('-'); return `${M[+m - 1]} ${y}` }
const _periodoPrevio = (p) => { const [y, m] = p.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}` }

async function _todo(build) {
  let out = [], i = 0
  for (;;) {
    const { data, error } = await build().range(i, i + 999)
    if (error) throw error
    out = out.concat(data || [])
    if (!data || data.length < 1000) break
    i += 1000
  }
  return out
}

// ─── Montaje ────────────────────────────────────────────────────────────────
export async function renderPDT621(panelId) {
  S.panelId = panelId
  const cont = document.getElementById(panelId)
  if (!cont) return
  S.periodo = S.periodo || _mesAnterior()
  cont.innerHTML = `
    <div class="card">
      <div class="card-header" style="flex-direction:column; align-items:stretch; gap:10px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
          <div>
            <h3 class="card-title">Declaraciones (PDT)</h3>
            <small style="color:var(--text-secondary);">Borrador calculado desde el sistema con el formato de la constancia SUNAT. Pasa el mouse por un importe para ver de dónde sale.</small>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
            <select id="pdtTipo" style="width:auto;" onchange="window._pdtCambiarTipo(this)">
              ${PDTS.map(p => `<option value="${p.cod}" ${p.listo ? '' : 'disabled'}>${_esc(p.nombre)}${p.listo ? '' : ' · pendiente'}</option>`).join('')}
            </select>
            <label style="font-size:0.8rem; color:var(--text-secondary); margin:0;">Período</label>
            <input type="month" id="pdtPeriodo" value="${S.periodo}" style="width:auto;" onchange="window._pdt621Calcular()">
            <button class="btn btn-secondary btn-small" onclick="window._pdt621Calcular()">↻ Recalcular</button>
            <button class="btn btn-secondary btn-small" onclick="window._pdt621Guardar()" title="Guarda saldos manuales y lo declarado en SUNAT para este período">💾 Guardar datos</button>
            <button class="btn btn-secondary btn-small" onclick="window._pdt621Excel()">📊 Excel</button>
            <button class="btn btn-primary btn-small" onclick="window._pdt621PDF()">⬇ PDF</button>
          </div>
        </div>
      </div>
      <div id="pdtCuerpo"><p class="reporte-vacio" style="padding:20px;">Calculando…</p></div>
    </div>`
  await window._pdt621Calcular()
}

// ─── Cálculo ────────────────────────────────────────────────────────────────
async function _calcular(periodo) {
  const ini = `${periodo}-01`, fin = _ultimoDia(periodo)
  const [y, m] = periodo.split('-').map(Number)
  const [ventas, compras, tcs, series] = await Promise.all([
    _todo(() => supabase.from('ventas').select('id,serie,correlativo,numero,tipo_comprobante,fecha_emision,contact_id,moneda,tipo_cambio,base_imponible,igv,total,estado,estado_comprobante,comprobante_anulado,tipo_venta,doc_referencia_serie,doc_referencia_numero').gte('fecha_emision', ini).lte('fecha_emision', fin)),
    _todo(() => supabase.from('compras').select('id,serie,numero,tipo_comprobante,tipo_compra,fecha_emision,contact_id,proveedor_ruc,proveedor_nombre,proveedor_domiciliado,currency,tipo_cambio,base_imponible_gravada,base_imponible_no_gravada,monto_no_gravado,monto_exonerado,igv_gravado,total,estado_comprobante,comprobante_anulado').eq('periodo_ano', y).eq('periodo_mes', m)),
    _todo(() => supabase.from('tipos_cambio').select('fecha,venta,compra').gte('fecha', ini).lte('fecha', fin)).catch(() => []),
    getSeries().catch(() => [])
  ])
  const idsC = [...new Set([...ventas.map(v => v.contact_id), ...compras.map(c => c.contact_id)].filter(Boolean))]
  let contactos = []
  for (let i = 0; i < idsC.length; i += 300) {
    const { data } = await supabase.from('contacts').select('id,nombre,tipo_documento,nro_documento,pais').in('id', idsC.slice(i, i + 300))
    contactos = contactos.concat(data || [])
  }
  const ctMap = Object.fromEntries(contactos.map(c => [c.id, c]))
  const tcMap = Object.fromEntries((tcs || []).map(t => [t.fecha, t]))
  const fisicas = new Set((series || []).filter(s => s.es_cpe === false).map(s => s.serie))

  const c = {}
  const add = (k, v) => { c[k] = (c[k] || 0) + v }
  const alertas = []
  const detV = [], detC = []

  // ── Ventas
  let tcDifV = 0
  for (const v of ventas) {
    const ct = ctMap[v.contact_id] || {}
    const anul = estaAnulado(v)
    const usd = v.moneda === 'USD'
    const tc = usd ? (parseFloat(v.tipo_cambio) || 0) : 1
    const tcS = usd ? (parseFloat(tcMap[v.fecha_emision]?.venta) || null) : null
    const base = (parseFloat(v.base_imponible) || 0) * tc
    const igv = (parseFloat(v.igv) || 0) * tc
    const exterior = !!ct.pais && !/per[uú]/i.test(ct.pais) && !['RUC', 'DNI'].includes(String(ct.tipo_documento || '').toUpperCase())
    let cas
    if (anul) cas = 'Anulado'
    else if (v.tipo_comprobante === '07') { cas = '102/103'; add('102', Math.abs(base)); add('103', Math.abs(igv)) }
    else if (igv > 0) { cas = '100/101'; add('100', base); add('101', igv) }
    else if (exterior) { cas = '106'; add('106', base) }
    else { cas = '105'; add('105', base) }
    const obs = []
    if (usd && tcS && Math.abs(tc - tcS) > 0.0005) { obs.push(`T.C. ${tc} ≠ SUNAT ${tcS}`); tcDifV++ }
    if (usd && !tcS) obs.push('Sin T.C. SUNAT en caché')
    if (fisicas.has(v.serie)) obs.push('Serie física (no CPE)')
    if (v.tipo_venta === 'anticipo') obs.push('Anticipo')
    detV.push({
      doc: `${v.serie}-${String(v.correlativo || '').padStart(8, '0')}`, tipo: v.tipo_comprobante, fecha: v.fecha_emision,
      cliente: ct.nombre || '', docCli: ct.nro_documento || '', moneda: v.moneda, tc: usd ? tc : '', tcSunat: tcS || '',
      base: anul ? 0 : _r2(base), igv: anul ? 0 : _r2(igv), total: anul ? 0 : _r2((parseFloat(v.total) || 0) * tc),
      casilla: cas, obs: obs.join(' · ')
    })
  }
  detV.sort((a, b) => a.doc.localeCompare(b.doc))
  // correlativos faltantes por serie (dentro del mes)
  const porSerie = {}
  ventas.forEach(v => { (porSerie[v.serie] = porSerie[v.serie] || []).push(parseInt(v.correlativo, 10)) })
  for (const [serie, arr] of Object.entries(porSerie)) {
    const nums = arr.filter(n => !isNaN(n)).sort((a, b) => a - b)
    if (!nums.length) continue
    const falt = []
    for (let n = nums[0]; n <= nums[nums.length - 1]; n++) if (!nums.includes(n)) falt.push(n)
    if (falt.length) alertas.push({ nivel: 'danger', texto: `Serie ${serie}: faltan en el sistema los correlativos ${falt.join(', ')} (si se emitieron en SUNAT, las ventas del sistema están incompletas).` })
  }
  if (tcDifV) alertas.push({ nivel: 'warning', texto: `${tcDifV} venta(s) en USD con T.C. distinto al T.C. venta SUNAT de su fecha.` })
  const nAnulV = detV.filter(d => d.casilla === 'Anulado').length
  if (nAnulV) alertas.push({ nivel: 'info', texto: `${nAnulV} comprobante(s) de venta anulados: van en el registro con importe 0.` })
  if (detV.some(d => d.obs.includes('Serie física'))) alertas.push({ nivel: 'warning', texto: 'Hay ventas con serie física (no CPE): confirma con tu contador cómo se declaran.' })

  // ── Compras
  let tcDifC = 0, imp = 0, impN = 0
  for (const k of compras) {
    const anul = estaAnulado(k)
    const usd = k.currency === 'USD'
    const tc = usd ? (parseFloat(k.tipo_cambio) || 0) : 1
    const tcS = usd ? (parseFloat(tcMap[k.fecha_emision]?.venta) || null) : null
    const sg = k.tipo_comprobante === '07' ? -1 : 1
    const grav = sg * (parseFloat(k.base_imponible_gravada) || 0) * tc
    const igv = sg * (parseFloat(k.igv_gravado) || 0) * tc
    const nograv = sg * ((parseFloat(k.base_imponible_no_gravada) || 0) + (parseFloat(k.monto_no_gravado) || 0) + (parseFloat(k.monto_exonerado) || 0)) * tc
    const exterior = k.tipo_comprobante === '91' || k.proveedor_domiciliado === false || !/^\d{11}$/.test(String(k.proveedor_ruc || ''))
    const obs = []
    let cas
    if (anul) cas = 'Anulado'
    else if (k.tipo_comprobante === '50') { cas = '114/115'; add('114', grav); add('115', igv); add('122', nograv) }
    else if (exterior) { cas = 'Exterior (no se declara)'; imp += grav + nograv; impN++; obs.push('Factura del exterior: el IGV de importación va con la DUA') }
    else {
      if (igv !== 0) { add('107', grav); add('108', igv); cas = '107/108' }
      else if (grav !== 0) { add('120', grav); cas = '120'; obs.push('Base "gravada" sin IGV → se toma como no gravada') }
      if (nograv) { add('120', nograv); cas = cas ? cas + ' + 120' : '120' }
      if (!cas) cas = '—'
    }
    if (usd && tcS && Math.abs(tc - tcS) > 0.0005) { obs.push(`T.C. ${tc} ≠ SUNAT venta ${tcS}`); tcDifC++ }
    if (k.tipo_compra === 'anticipo') obs.push('Anticipo')
    detC.push({
      doc: `${k.serie || ''}-${k.numero || ''}`, tipo: k.tipo_comprobante, fecha: k.fecha_emision,
      proveedor: k.proveedor_nombre || ctMap[k.contact_id]?.nombre || '', ruc: k.proveedor_ruc || '',
      moneda: k.currency, tc: usd ? tc : '', tcSunat: tcS || '',
      grav: anul ? 0 : _r2(grav), igv: anul ? 0 : _r2(igv), nograv: anul ? 0 : _r2(nograv),
      total: anul ? 0 : _r2(sg * (parseFloat(k.total) || 0) * tc), casilla: cas, obs: obs.join(' · ')
    })
  }
  detC.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)))
  if (impN) {
    const duas = compras.filter(k => k.tipo_comprobante === '50' && !estaAnulado(k)).length
    alertas.push({ nivel: duas ? 'info' : 'warning', texto: `${impN} factura(s) del exterior por S/ ${_fmt(imp, 2)} no entran al 621.${duas ? '' : ' No hay DUA (tipo 50) registrada en el período: el IGV de importación (114/115) no está en el sistema.'}` })
  }
  if (tcDifC) alertas.push({ nivel: 'info', texto: `${tcDifC} compra(s) en USD con T.C. distinto al T.C. venta SUNAT (criterio pendiente con el contador).` })

  // ── Redondeo SUNAT (enteros) y totales
  const R = {}
  for (const k of ['100', '101', '102', '103', '105', '106', '107', '108', '114', '115', '120', '122']) R[k] = Math.round(c[k] || 0)
  R['131'] = R['101'] - R['103']
  R['178'] = R['108'] + R['115']
  const man = S.manual
  const num = (k, def = 0) => (man[k] === undefined || man[k] === '' || man[k] === null) ? def : Number(man[k])
  R['380'] = num('380', 0); R['315'] = num('315', 1.5)
  R['301'] = R['100'] - R['102'] + R['105'] + R['106']
  R['894'] = R['380'] > 0 ? R['380'] : R['315'] / 100
  R['312'] = Math.round(R['301'] * R['894'])
  R['140'] = R['131'] - R['178']
  R['145'] = num('145'); R['184'] = R['140'] - R['145']
  R['168'] = num('168'); R['171'] = num('171'); R['176'] = num('176'); R['179'] = num('179')
  let deuda = R['184']
  const P = R['168'] + R['171'], Rt = R['176'] + R['179']
  if (deuda > 0) {
    const aP = Math.min(deuda, P); deuda -= aP; R['164'] = P - aP
    const aR = Math.min(deuda, Rt); deuda -= aR; R['165'] = Rt - aR
    R['681'] = deuda
  } else { R['164'] = P; R['165'] = Rt; R['681'] = 0 }
  R['188'] = R['681']
  R['302'] = R['312']; R['303'] = num('303'); R['304'] = R['302'] - R['303']
  R['682'] = Math.max(0, R['304']); R['324'] = R['682']

  return { R, detV, detC, alertas, nV: ventas.length, nC: compras.length }
}

window._pdt621Calcular = async function () {
  const cuerpo = document.getElementById('pdtCuerpo')
  S.periodo = document.getElementById('pdtPeriodo')?.value || S.periodo
  if (cuerpo) cuerpo.innerHTML = '<p class="reporte-vacio" style="padding:20px;">Calculando…</p>'
  try {
    // Datos guardados del período (manual + declarado)
    S.tablaOk = true; S.manual = {}; S.declarado = {}; S.info = {}
    const { data, error } = await supabase.from('pdt621_declaraciones').select('*').eq('periodo', S.periodo).limit(1)
    if (error) S.tablaOk = false
    else if (data?.[0]) {
      S.manual = data[0].manual || {}
      S.declarado = data[0].declarado || {}
      S.info = { orden: data[0].numero_orden, fecha: data[0].fecha_presentacion }
    }
    // Arrastre automático desde el mes anterior si este período no tiene saldos guardados
    if (S.tablaOk && !Object.keys(S.manual).length) {
      const prev = _periodoPrevio(S.periodo)
      const { data: dp } = await supabase.from('pdt621_declaraciones').select('declarado').eq('periodo', prev).limit(1)
      const d = dp?.[0]?.declarado || {}
      if (Object.keys(d).length) {
        S.manual = {
          '145': d['184'] < 0 ? -d['184'] : 0, '168': d['164'] || 0, '176': d['165'] || 0,
          '303': d['304'] < 0 ? -d['304'] : 0, '315': d['315'] ?? 1.5, '380': d['380'] ?? 0
        }
        S.info.arrastre = prev
      }
    }
    S.r = await _calcular(S.periodo)
    _pintar()
  } catch (e) {
    console.error('PDT 621:', e)
    if (cuerpo) cuerpo.innerHTML = `<p style="padding:20px; color:var(--color-danger);">Error al calcular: ${_esc(e.message)}</p>`
  }
}

// ─── Pintado ────────────────────────────────────────────────────────────────
function _pintar() {
  const cuerpo = document.getElementById('pdtCuerpo')
  if (!cuerpo || !S.r) return
  const { R, alertas, detV, detC } = S.r
  const th = 'padding:7px 10px; font-size:0.78rem; text-transform:uppercase; letter-spacing:.03em; color:var(--text-secondary); text-align:right;'
  const fila = ([k, label]) => {
    const dec = DECIMALES[k] ?? 0
    const esManual = MANUALES.includes(k)
    const sis = esManual
      ? `<input type="number" step="${dec ? '0.0001' : '1'}" value="${_esc(S.manual[k] ?? (k === '315' ? 1.5 : 0))}" data-pdt-manual="${k}" title="${_esc(AYUDA_MANUAL[k] || '')}" style="width:120px; text-align:right; padding:3px 6px;" onchange="window._pdt621SetManual('${k}', this.value)">`
      : _fmt(R[k], dec)
    const d = S.declarado[k]
    const decl = `<input type="number" step="${dec ? '0.0001' : '1'}" value="${d ?? ''}" placeholder="—" data-pdt-decl="${k}" style="width:120px; text-align:right; padding:3px 6px;" onchange="window._pdt621SetDecl('${k}', this.value)">`
    const hay = !(d === undefined || d === '' || d === null)
    const dif = hay ? _r2(Number(R[k]) - Number(d)) : null
    const ok = hay && Math.abs(dif) < (dec ? 0.0001 : 1)
    const difHtml = !hay ? '' : `<span style="font-weight:600; color:${ok ? 'var(--color-success)' : 'var(--color-danger)'};">${ok ? '✓' : _fmt(dif, dec)}</span>`
    const total = ['131', '178', '184', '188', '304', '312', '324'].includes(k)
    return `<tr style="border-top:1px solid var(--border-color);${total ? ' font-weight:700; background:var(--bg-secondary);' : ''}">
      <td style="padding:6px 10px; width:60px;"><code>${k}</code></td>
      <td style="padding:6px 10px;">${_esc(label)}${esManual ? ' <small style="color:var(--color-info);">✏️ manual</small>' : ''}</td>
      <td style="padding:6px 10px; text-align:right; font-variant-numeric:tabular-nums;">${sis}</td>
      <td style="padding:6px 10px; text-align:right;">${decl}</td>
      <td style="padding:6px 10px; text-align:right; font-variant-numeric:tabular-nums;">${difHtml}</td>
    </tr>`
  }
  const colorNivel = { danger: 'var(--color-danger)', warning: 'var(--color-warning)', info: 'var(--color-info)' }
  const d100 = S.declarado['100']
  const difVentas = (d100 !== undefined && d100 !== '') ? R['100'] - Number(d100) : null
  const d107 = S.declarado['107']
  const difCompras = (d107 !== undefined && d107 !== '') ? R['107'] - Number(d107) : null
  const caja = (color, html) => `<div style="padding:8px 12px; border-left:3px solid ${color}; background:var(--bg-secondary); border-radius:6px; font-size:0.85rem;">${html}</div>`

  cuerpo.innerHTML = `
    <div style="padding:12px 16px;">
      <div style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info); font-size:0.88rem; line-height:1.6;">
        <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">Formulario 621 · ${_esc(EMPRESA.nombre)} · RUC ${EMPRESA.ruc}</div>
        <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">Período ${_nombrePeriodo(S.periodo)}</div>
        <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">
          ${S.r.nV} ventas · ${S.r.nC} compras en el sistema
          ${S.info.orden ? ` · Declarado: N° orden ${_esc(S.info.orden)} (${_esc(S.info.fecha || '')})` : ''}
          ${S.info.arrastre ? ` · Saldos manuales arrastrados de ${_esc(S.info.arrastre)}` : ''}
        </div>
      </div>
      ${!S.tablaOk ? '<p style="color:var(--color-warning); margin:10px 0;">⚠ Falta correr <code>assets/sql/82_pdt621_declaraciones.sql</code>: no se pueden guardar saldos ni lo declarado.</p>' : ''}
      <div style="margin-top:12px; display:flex; flex-direction:column; gap:6px;">
        ${difVentas !== null && Math.abs(difVentas) >= 1 ? caja('var(--color-danger)', `<strong>Ventas (100):</strong> el sistema tiene S/ ${_fmt(Math.abs(difVentas))} ${difVentas < 0 ? 'MENOS' : 'MÁS'} de base gravada que lo declarado.`) : ''}
        ${difCompras !== null && Math.abs(difCompras) >= 1 ? caja('var(--color-danger)', `<strong>Compras (107):</strong> el sistema tiene S/ ${_fmt(Math.abs(difCompras))} ${difCompras < 0 ? 'MENOS' : 'MÁS'} de base gravada que lo declarado.`) : ''}
        ${alertas.map(a => caja(colorNivel[a.nivel], _esc(a.texto))).join('')}
      </div>
      <div class="pdtf-vistas">
        <button type="button" class="reporte-chip ${S.vista === 'form' ? 'on' : ''}" onclick="window._pdtVista('form')">📄 Formulario</button>
        <button type="button" class="reporte-chip ${S.vista === 'comp' ? 'on' : ''}" onclick="window._pdtVista('comp')">⚖️ Sistema vs Declarado</button>
        <small style="color:var(--text-secondary);">${S.vista === 'form' ? 'Amarillo = casilla · azul = lo que la compone · clic en una base para ver sus comprobantes · ✏️ celdas editables' : 'Ingresa lo declarado para ver diferencias'}</small>
      </div>
      ${S.vista === 'form' ? _htmlFormulario() : SECCIONES.map(s => `
        <strong style="display:block; margin:18px 0 8px; color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase; letter-spacing:0.03em;">${s.titulo}</strong>
        <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; margin:0;">
            <thead><tr style="background:var(--bg-secondary);">
              <th style="${th} text-align:left;">Casilla</th><th style="${th} text-align:left;">Concepto</th>
              <th style="${th}">Sistema (S/)</th><th style="${th}">Declarado SUNAT</th><th style="${th}">Diferencia</th>
            </tr></thead>
            <tbody>${s.filas.map(fila).join('')}</tbody>
          </table>
        </div>`).join('')}
      ${S.filtroCas ? `<div id="pdtFiltro" style="margin-top:16px; display:flex; gap:8px; align-items:center;"><span class="reporte-chip on">Comprobantes de la casilla ${S.filtroCas}</span><button class="btn btn-small btn-secondary" onclick="window._pdtFiltrar(null)">✕ Quitar filtro</button></div>` : ''}
      <details id="pdtDetV" style="margin-top:18px;" ${S.filtroCas && _filtrar(detV).length ? 'open' : ''}><summary style="cursor:pointer; font-weight:600;">Detalle de ventas (${_filtrar(detV).length}${S.filtroCas ? ' de ' + detV.length : ''})</summary>${_tablaDetalle(_filtrar(detV), COLS_V)}</details>
      <details id="pdtDetC" style="margin-top:10px;" ${S.filtroCas && _filtrar(detC).length ? 'open' : ''}><summary style="cursor:pointer; font-weight:600;">Detalle de compras (${_filtrar(detC).length}${S.filtroCas ? ' de ' + detC.length : ''})</summary>${_tablaDetalle(_filtrar(detC), COLS_C)}</details>
    </div>`
  _activarInteraccion(cuerpo)
}

const COLS_V = [['doc', 'Comprobante'], ['tipo', 'Tipo'], ['fecha', 'Fecha'], ['cliente', 'Cliente'], ['docCli', 'RUC/DNI'], ['moneda', 'Mon.'], ['tc', 'T.C.'], ['tcSunat', 'T.C. SUNAT'], ['base', 'Base S/', 1], ['igv', 'IGV S/', 1], ['total', 'Total S/', 1], ['casilla', 'Casilla'], ['obs', 'Observación']]
const COLS_C = [['doc', 'Comprobante'], ['tipo', 'Tipo'], ['fecha', 'Fecha'], ['proveedor', 'Proveedor'], ['ruc', 'RUC'], ['moneda', 'Mon.'], ['tc', 'T.C.'], ['tcSunat', 'T.C. SUNAT'], ['grav', 'Gravada S/', 1], ['igv', 'IGV S/', 1], ['nograv', 'No grav. S/', 1], ['total', 'Total S/', 1], ['casilla', 'Casilla'], ['obs', 'Observación']]

function _tablaDetalle(filas, cols) {
  if (!filas.length) return '<p style="color:var(--text-secondary); padding:8px;">Sin registros</p>'
  return `<div class="table-container" style="margin-top:8px;"><table style="font-size:0.8rem;"><thead><tr>${cols.map(c => `<th style="${c[2] ? 'text-align:right;' : ''}">${c[1]}</th>`).join('')}</tr></thead>
    <tbody>${filas.map(f => `<tr${f.casilla === 'Anulado' ? ' style="opacity:.55;"' : ''}>${cols.map(c => `<td style="${c[2] ? 'text-align:right; font-variant-numeric:tabular-nums;' : ''}${c[0] === 'obs' && f.obs ? ' color:var(--color-warning);' : ''}">${c[2] ? _fmt(f[c[0]], 2) : _esc(f[c[0]])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
}

window._pdt621SetManual = async (k, v) => { S.manual[k] = v === '' ? '' : Number(v); S.r = await _calcular(S.periodo); _pintar() }
window._pdt621SetDecl = (k, v) => { if (v === '') delete S.declarado[k]; else S.declarado[k] = Number(v); _pintar() }

window._pdt621Guardar = async function () {
  if (!S.tablaOk) { showToast('Falta correr el SQL 82 (pdt621_declaraciones)', 'warning', 6000); return }
  const { error } = await supabase.from('pdt621_declaraciones').upsert({
    periodo: S.periodo, manual: S.manual, declarado: S.declarado, updated_at: new Date().toISOString()
  }, { onConflict: 'periodo' })
  if (error) { showToast('No se pudo guardar: ' + error.message, 'danger'); return }
  showToast(`Datos del PDT ${S.periodo} guardados ✓`, 'success')
}

// ─── Exportar ───────────────────────────────────────────────────────────────
function _filasCasillas() {
  const { R } = S.r
  const out = []
  for (const s of SECCIONES) {
    out.push({ seccion: s.titulo })
    for (const [k, label] of s.filas) {
      const dec = DECIMALES[k] ?? 0
      const d = S.declarado[k]
      const hay = !(d === undefined || d === '' || d === null)
      const dif = hay ? _r2(Number(R[k]) - Number(d)) : null
      out.push({ k, label, sis: _fmt(R[k], dec), decl: hay ? _fmt(d, dec) : '', dif: !hay ? '' : (Math.abs(dif) < (dec ? 0.0001 : 1) ? 'OK' : _fmt(dif, dec)) })
    }
  }
  return out
}

// PDF con la MISMA distribución de la constancia SUNAT (Pág. 1 y 2) + anexos.
function _bloquesPDT621(V) {
  const c = (k, dec) => [k, V[k], dec]
  const pag1 = [
    { titulo: 'IGV VENTAS', cabecera: 'IGV CUENTA PROPIA', columnas: ['BASE', 'TRIBUTO'], filas: [
      { grupo: 'Gravadas', label: 'Ventas Netas', celdas: [c('100'), c('101')] },
      { grupo: 'Gravadas', label: 'Ventas Netas Gravadas Ley N° 31556 y modificatorias', celdas: [c('154'), c('155')] },
      { grupo: 'Gravadas', label: 'Descuentos Concedidos y/o devoluciones de Ventas', celdas: [c('102'), c('103')] },
      { grupo: 'Gravadas', label: 'Ventas de bienes (ley 27037 inc. 11.1, 12.1, 12.3 y 12.4)', celdas: [c('160'), c('161')] },
      { grupo: 'Gravadas', label: 'Descuentos y devoluciones (ley 27037)', celdas: [c('162'), c('163')] },
      { sub: 'Exportaciones', subInicio: true, subFilas: 2, label: 'Facturadas en el período', celdas: [c('106'), null] },
      { sub: 'Exportaciones', label: 'Embarcadas en el período', celdas: [c('127'), null] },
      { label: 'Ventas no Gravadas (Sin Considerar exportaciones)', celdas: [c('105'), null] },
      { label: 'Ventas no Gravadas (Sin efecto en ratio)', celdas: [c('109'), null] },
      { label: 'Otras ventas (inciso ii), numeral 6.2 - art. 6 del Reglamento', celdas: [c('112'), null] },
      { label: 'Total', celdas: [null, c('131')] }
    ] },
    { titulo: 'IGV COMPRAS', cabecera: 'IGV CUENTA PROPIA', columnas: ['BASE', 'TRIBUTO'], filas: [
      { grupo: 'Nacionales', label: 'Compras netas destinada a ventas gravadas exclusivamente', celdas: [c('107'), c('108')] },
      { grupo: 'Nacionales', label: 'Compras Netas destinadas a Vtas Gravadas Ley N° 31556 y modificatorias', celdas: [c('156'), c('157')] },
      { grupo: 'Nacionales', label: 'Compras netas destinada a ventas gravadas y no gravadas', celdas: [c('110'), c('111')] },
      { grupo: 'Nacionales', label: 'Compras netas destinada a ventas no gravadas exclusivamente', celdas: [c('113'), null] },
      { grupo: 'Importadas', label: 'Compras netas destinada a ventas gravadas exclusivamente', celdas: [c('114'), c('115')] },
      { grupo: 'Importadas', label: 'Compras netas destinada a ventas gravadas y no gravadas', celdas: [c('116'), c('117')] },
      { grupo: 'Importadas', label: 'Compras netas destinada a ventas no gravadas exclusivamente', celdas: [c('119'), null] },
      { label: 'Compras internas no gravadas', celdas: [c('120'), null] },
      { label: 'Compras importadas no gravadas', celdas: [c('122'), null] },
      { label: 'TOTAL', celdas: [null, c('178')] },
      { label: 'CRÉDITO FISCAL ESPECIAL', celdas: [null, c('172')] },
      { label: 'COEFICIENTE', celdas: [c('173', 4), null] }
    ] },
    { titulo: 'IVAP', cabecera: 'IVAP', columnas: ['BASE', 'TRIBUTO'], filas: [
      { label: 'Ventas Gravadas', celdas: [c('340'), c('341')] },
      { label: 'Otros Créditos IVAP', celdas: [null, c('182')] }
    ] },
    { titulo: 'RENTA', cabecera: 'RENTA', columnas: ['BASE', 'TRIBUTO'], filas: [
      { label: 'Ingresos Netos', celdas: [c('301'), c('312')] },
      { label: 'Coeficiente', celdas: [c('380', 4), null] },
      { label: 'Porcentaje', celdas: [c('315', 1), null] },
      { label: 'Coeficiente Calculado (aplicado para el Cálculo de la Cas312)', celdas: [c('894', 4), null] },
      { label: 'Pagos a Cuenta en Exceso del Presente Ejercicio', celdas: [null, c('336')] }
    ] }
  ]
  const pag2 = [
    { titulo: 'DETERMINACIÓN DE LA DEUDA', cabecera: 'DETERMINACIÓN DE LA DEUDA', columnas: ['IGV', 'IVAP', 'RENTA'], anchoGrupo: 36, filas: [
      { label: 'Impuesto Resultante o Saldo a Favor', celdas: [c('140'), c('353'), c('302')] },
      { label: 'Saldo a Favor del Período anterior', celdas: [c('145'), c('351'), c('303')] },
      { label: 'Tributo a Pagar o Saldo a Favor', celdas: [c('184'), c('352'), c('304')] },
      { label: 'Percepciones declaradas en el período', celdas: [c('171'), null, null] },
      { label: 'Saldo de percepciones de periodos anteriores', celdas: [c('168'), null, null] },
      { label: 'Saldo de percepciones no aplicadas', celdas: [c('164'), null, null] },
      { label: 'Retenciones declaradas en el período', celdas: [c('179'), null, null] },
      { label: 'Saldo de retenciones de periodos anteriores', celdas: [c('176'), null, null] },
      { label: 'Saldo de Retenciones no aplicadas', celdas: [c('165'), null, null] },
      { label: 'Retenciones de tercera declaradas en período', celdas: [null, null, c('326')] },
      { label: 'Retenciones de tercera declaradas en periodos anteriores', celdas: [null, null, c('327')] },
      { label: 'Compensación Saldo a Favor del Exportador', celdas: [null, c('347'), c('305')] },
      { label: 'Impuesto Temporal a los Activos Netos', celdas: [null, null, c('328')] },
      { label: 'Sub Total', celdas: [c('681'), c('683'), c('682')] },
      { label: 'Pagos previos', celdas: [c('185'), c('342'), c('317')] },
      { label: 'Interés moratorio', celdas: [c('187'), c('343'), c('319')] },
      { label: 'Total deuda tributaria', celdas: [c('188'), c('344'), c('324')] }
    ] }
  ]
  return { pag1, pag2 }
}

window._pdt621PDF = async function () {
  if (!S.r) return
  try {
    const { nuevoDocPDT, dibujarPaginaPDT } = await import('./pdt-constancia.js')
    const { applyPlugin } = await import('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/+esm')
    const doc = await nuevoDocPDT()
    applyPlugin(doc.constructor)
    // Valores: casillas en 0 se dejan en blanco (como la constancia), salvo las que SUNAT siempre imprime
    const SIEMPRE = new Set(['380', '315', '894', '336', '681', '682', '683', '185', '187', '188', '317', '319', '324', '342', '343', '344'])
    const V = {}
    const base = { ...S.r.R, '336': 0, '185': 0, '187': 0, '317': 0, '319': 0 }
    for (const [k, v] of Object.entries(base)) V[k] = (Number(v) === 0 && !SIEMPRE.has(k)) ? null : v
    const fp = S.info.fecha ? String(S.info.fecha).slice(0, 10).split('-').reverse().join('/') : ''
    const cab = {
      formulario: '0621', titulo: 'PDT IGV - RENTA MENSUAL', ruc: EMPRESA.ruc, razon: EMPRESA.nombre,
      periodo: S.periodo.replace('-', ''), numeroOrden: S.info.orden || '', fechaPresentacion: fp,
      tipoDeclaracion: 'Original', moneda: 'Soles'
    }
    const { pag1, pag2 } = _bloquesPDT621(V)
    dibujarPaginaPDT(doc, cab, pag1, { pagina: 1 })
    doc.addPage(); dibujarPaginaPDT(doc, cab, pag2, { pagina: 2 })

    // ── Anexos (no forman parte del formulario)
    doc.addPage('a4', 'portrait')
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10)
    doc.text('ANEXO — Sistema vs Declarado y observaciones (no forma parte del formulario)', 12, 14)
    const body = []
    for (const f of _filasCasillas()) {
      if (f.seccion) body.push([{ content: f.seccion.toUpperCase(), colSpan: 5, styles: { fillColor: [230, 230, 230], fontStyle: 'bold' } }])
      else body.push([f.k, f.label, f.sis, f.decl, f.dif])
    }
    doc.autoTable({
      startY: 18, head: [['Casilla', 'Concepto', 'Sistema (S/)', 'Declarado', 'Diferencia']], body,
      margin: { left: 12, right: 12 }, styles: { fontSize: 7, cellPadding: 1.2 }, headStyles: { fillColor: [60, 60, 60] },
      columnStyles: { 0: { cellWidth: 14 }, 2: { halign: 'right', cellWidth: 26 }, 3: { halign: 'right', cellWidth: 26 }, 4: { halign: 'right', cellWidth: 22 } },
      didParseCell: (d) => { if (d.section === 'body' && d.column.index === 4 && d.cell.raw && d.cell.raw !== 'OK') d.cell.styles.textColor = [200, 30, 30] }
    })
    if (S.r.alertas.length) {
      let y = doc.lastAutoTable.finalY + 7
      const W = doc.internal.pageSize.getWidth()
      if (y > 262) { doc.addPage(); y = 16 }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text('Observaciones del sistema', 12, y)
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5)
      for (const a of S.r.alertas) {
        const lineas = doc.splitTextToSize('• ' + a.texto, W - 24)
        y += 4.5
        if (y > 282) { doc.addPage(); y = 16 }
        doc.text(lineas, 12, y); y += (lineas.length - 1) * 3.5
      }
    }
    const det = (titulo, filas, cols) => {
      doc.addPage('a4', 'landscape')
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text(titulo, 10, 12)
      doc.autoTable({
        startY: 16, head: [cols.map(c => c[1])],
        body: filas.map(f => cols.map(c => c[2] ? _fmt(f[c[0]], 2) : String(f[c[0]] ?? ''))),
        margin: { left: 8, right: 8 }, styles: { fontSize: 6.5, cellPadding: 1 }, headStyles: { fillColor: [60, 60, 60] },
        columnStyles: Object.fromEntries(cols.map((c, i) => [i, c[2] ? { halign: 'right' } : {}]))
      })
    }
    det(`ANEXO — Detalle de ventas ${_nombrePeriodo(S.periodo)}`, S.r.detV, COLS_V.filter(c => c[0] !== 'tcSunat'))
    det(`ANEXO — Detalle de compras ${_nombrePeriodo(S.periodo)}`, S.r.detC, COLS_C.filter(c => c[0] !== 'tcSunat'))
    doc.save(`PDT621_${EMPRESA.ruc}_${S.periodo.replace('-', '')}.pdf`)
    showToast('PDF generado ✓', 'success')
  } catch (e) {
    console.error('PDF PDT621:', e)
    showToast('Error al generar el PDF: ' + e.message, 'danger')
  }
}

window._pdt621Excel = async function () {
  if (!S.r) return
  try {
    const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm')
    const wb = XLSX.utils.book_new()
    const cas = [['Casilla', 'Concepto', 'Sistema (S/)', 'Declarado', 'Diferencia']]
    for (const f of _filasCasillas()) cas.push(f.seccion ? [f.seccion] : [f.k, f.label, Number(S.r.R[f.k]), S.declarado[f.k] ?? '', f.dif])
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cas), 'Casillas')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(S.r.detV), 'Ventas')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(S.r.detC), 'Compras')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Observación'], ...S.r.alertas.map(a => [a.texto])]), 'Observaciones')
    XLSX.writeFile(wb, `PDT621_${EMPRESA.ruc}_${S.periodo.replace('-', '')}.xlsx`)
  } catch (e) { showToast('Error al exportar: ' + e.message, 'danger') }
}

// ─── Vista FORMULARIO interactiva (2026-10-09) ──────────────────────────────
// Mismo diseño que el PDF (pdt-constancia.js → htmlPaginaPDT). Al pasar el
// mouse por un importe: la casilla se pinta amarillo, las que la componen en
// azul y un globito muestra la operación con los números. Clic en una casilla
// "base" (100, 107, 120…) filtra el detalle de comprobantes de abajo.
const SIEMPRE_PDF = new Set(['380', '315', '894', '336', '681', '682', '683', '185', '187', '188', '317', '319', '324', '342', '343', '344'])
const BASES = new Set(['100', '101', '102', '103', '105', '106', '107', '108', '114', '115', '120', '122'])

function _valoresV() {
  const V = {}
  const base = { ...S.r.R, '336': 0, '185': 0, '187': 0, '317': 0, '319': 0 }
  for (const [k, v] of Object.entries(base)) V[k] = (Number(v) === 0 && !SIEMPRE_PDF.has(k)) ? null : v
  return V
}
function _cab() {
  const fp = S.info.fecha ? String(S.info.fecha).slice(0, 10).split('-').reverse().join('/') : ''
  return { formulario: '0621', titulo: 'PDT IGV - RENTA MENSUAL', ruc: EMPRESA.ruc, razon: EMPRESA.nombre,
    periodo: S.periodo.replace('-', ''), numeroOrden: S.info.orden || '', fechaPresentacion: fp, tipoDeclaracion: 'Original', moneda: 'Soles' }
}
let _constancia = null   // módulo pdt-constancia.js (se carga una vez)

function _htmlFormulario() {
  if (!_constancia) return '<p class="reporte-vacio" style="padding:20px;">Cargando formulario…</p>'
  const { pag1, pag2 } = _bloquesPDT621(_valoresV())
  const opts = {
    celda: (k, v, dec) => {
      if (MANUALES.includes(k)) {
        const val = S.manual[k] ?? (k === '315' ? 1.5 : 0)
        return `<input type="number" class="pdtf-input" step="${(DECIMALES[k] ?? 0) ? '0.0001' : '1'}" value="${_esc(val)}" onchange="window._pdt621SetManual('${k}', this.value)" title="✏️ ${_esc(AYUDA_MANUAL[k] || 'Editable')}">`
      }
      return (v === null || v === undefined) ? '' : _constancia.fmtPDT(v, dec)
    },
    claseCelda: (k) => {
      const d = S.declarado[k]
      if (d === undefined || d === null || d === '') return ''
      return Math.abs(Number(S.r.R[k] ?? 0) - Number(d)) >= ((DECIMALES[k] ?? 0) ? 0.0001 : 1) ? 'pdt-difiere' : 'pdt-cuadra'
    }
  }
  return `<div class="pdtf-papel">
    ${_constancia.htmlPaginaPDT(_cab(), pag1, { ...opts, pagina: 1 })}
    ${_constancia.htmlPaginaPDT(_cab(), pag2, { ...opts, pagina: 2 })}
  </div>`
}

// Fórmulas: casillas que dependen de otras (deps) y el texto con números.
function _n(k) { const d = DECIMALES[k] ?? 0; return _fmt(S.r.R[k] ?? 0, d) }
const FORMULAS = {
  '131': { deps: ['101', '103'], f: () => `131 = 101 − 103<br>= ${_n('101')} − ${_n('103')} = <b>${_n('131')}</b>` },
  '178': { deps: ['108', '115'], f: () => `178 = 108 + 115<br>= ${_n('108')} + ${_n('115')} = <b>${_n('178')}</b>` },
  '301': { deps: ['100', '102', '105', '106'], f: () => `301 = 100 − 102 + 105 + 106<br>= ${_n('100')} − ${_n('102')} + ${_n('105')} + ${_n('106')} = <b>${_n('301')}</b>` },
  '894': { deps: ['380', '315'], f: () => S.r.R['380'] > 0 ? `894 = coeficiente 380 = <b>${_n('894')}</b>` : `894 = 315 ÷ 100 (sin coeficiente)<br>= ${_n('315')} ÷ 100 = <b>${_n('894')}</b>` },
  '312': { deps: ['301', '894'], f: () => `312 = 301 × 894<br>= ${_n('301')} × ${_n('894')} = <b>${_n('312')}</b>` },
  '140': { deps: ['131', '178'], f: () => `140 = 131 − 178 (IGV ventas − crédito fiscal)<br>= ${_n('131')} − ${_n('178')} = <b>${_n('140')}</b>` },
  '184': { deps: ['140', '145'], f: () => `184 = 140 − 145<br>= ${_n('140')} − ${_n('145')} = <b>${_n('184')}</b>${S.r.R['184'] < 0 ? '<br><i>Negativo = saldo a favor que pasa al mes siguiente (145)</i>' : ''}` },
  '164': { deps: ['168', '171', '184'], f: () => `164 = 168 + 171 − percepciones aplicadas<br>= ${_n('168')} + ${_n('171')} − ${_fmt(S.r.R['168'] + S.r.R['171'] - S.r.R['164'])} = <b>${_n('164')}</b><br><i>Solo se aplican si 184 es positivo</i>` },
  '165': { deps: ['176', '179', '184'], f: () => `165 = 176 + 179 − retenciones aplicadas<br>= ${_n('176')} + ${_n('179')} − ${_fmt(S.r.R['176'] + S.r.R['179'] - S.r.R['165'])} = <b>${_n('165')}</b><br><i>Solo se aplican si 184 es positivo</i>` },
  '681': { deps: ['184', '168', '171', '176', '179'], f: () => `681 = 184 − percepciones − retenciones (mín. 0)<br>= <b>${_n('681')}</b>` },
  '188': { deps: ['681', '185', '187'], f: () => `188 = 681 − 185 + 187<br>= ${_n('681')} − 0 + 0 = <b>${_n('188')}</b>` },
  '302': { deps: ['312'], f: () => `302 = 312 (pago a cuenta del mes) = <b>${_n('302')}</b>` },
  '304': { deps: ['302', '303'], f: () => `304 = 302 − 303<br>= ${_n('302')} − ${_n('303')} = <b>${_n('304')}</b>${S.r.R['304'] < 0 ? '<br><i>Negativo = saldo a favor de Renta</i>' : ''}` },
  '682': { deps: ['304'], f: () => `682 = 304 si es positivo, si no 0 = <b>${_n('682')}</b>` },
  '324': { deps: ['682', '317', '319'], f: () => `324 = 682 − 317 + 319<br>= ${_n('682')} − 0 + 0 = <b>${_n('324')}</b>` },
  '101': { deps: ['100'], f: () => `101 = Σ IGV de ${_docsDe('101').length} comprobante(s)<br>≈ 18% × 100 = ${_fmt(S.r.R['100'] * 0.18)} → <b>${_n('101')}</b>` },
  '108': { deps: ['107'], f: () => `108 = Σ IGV de ${_docsDe('108').length} compra(s)<br>≈ 18% × 107 = ${_fmt(S.r.R['107'] * 0.18)} → <b>${_n('108')}</b>` }
}
const NOMBRE_BASE = { '100': 'ventas gravadas', '102': 'notas de crédito', '103': 'notas de crédito', '105': 'ventas no gravadas', '106': 'exportaciones', '107': 'compras gravadas', '114': 'DUAs', '115': 'DUAs', '120': 'compras no gravadas', '122': 'importaciones no gravadas' }

function _docsDe(k) {
  const all = [...(S.r?.detV || []), ...(S.r?.detC || [])]
  return all.filter(d => d.casilla !== 'Anulado' && String(d.casilla).split(/[\s/+]+/).includes(k))
}
function _filtrar(filas) {
  if (!S.filtroCas) return filas
  return filas.filter(d => String(d.casilla).split(/[\s/+]+/).includes(S.filtroCas))
}
function _textoTip(k) {
  let html = ''
  if (FORMULAS[k]) html = FORMULAS[k].f()
  else if (BASES.has(k)) {
    const docs = _docsDe(k)
    html = `${k} = suma de ${docs.length} ${NOMBRE_BASE[k] || 'comprobante(s)'} del período en S/ = <b>${_n(k)}</b>${docs.length ? '<br><i>Clic para ver los comprobantes</i>' : ''}`
  } else if (MANUALES.includes(k)) html = `✏️ ${AYUDA_MANUAL[k] || 'Dato manual'}<br>Valor: <b>${_n(k)}</b>`
  else html = `Casilla ${k}: <b>${_n(k)}</b>`
  const d = S.declarado[k]
  if (d !== undefined && d !== null && d !== '') {
    const dif = _r2(Number(S.r.R[k] ?? 0) - Number(d))
    html += `<hr>Declarado SUNAT: <b>${_fmt(d, DECIMALES[k] ?? 0)}</b>${Math.abs(dif) >= ((DECIMALES[k] ?? 0) ? 0.0001 : 1) ? ` · <span style="color:#fca5a5;">dif. ${_fmt(dif, DECIMALES[k] ?? 0)}</span>` : ' · ✓ cuadra'}`
  }
  return html
}

function _activarInteraccion(cuerpo) {
  if (S.vista !== 'form') return
  if (!_constancia) {
    import('./pdt-constancia.js').then(m => { _constancia = m; _pintar() })
    return
  }
  let tip = document.getElementById('pdtTip')
  if (!tip) { tip = document.createElement('div'); tip.id = 'pdtTip'; tip.className = 'pdt-tip'; document.body.appendChild(tip) }
  const papel = cuerpo.querySelector('.pdtf-papel')
  if (!papel) return
  const limpiar = () => { papel.querySelectorAll('.pdt-target,.pdt-dep').forEach(e => e.classList.remove('pdt-target', 'pdt-dep')); tip.style.display = 'none' }
  papel.addEventListener('mouseover', (ev) => {
    const td = ev.target.closest('[data-cas]')
    if (!td) return
    const k = td.dataset.cas
    limpiar()
    papel.querySelectorAll(`[data-cas="${k}"]`).forEach(e => e.classList.add('pdt-target'))
    ;(FORMULAS[k]?.deps || []).forEach(d => papel.querySelectorAll(`[data-cas="${d}"]`).forEach(e => e.classList.add('pdt-dep')))
    tip.innerHTML = _textoTip(k)
    tip.style.display = 'block'
    const r = td.getBoundingClientRect()
    const w = tip.offsetWidth, h = tip.offsetHeight
    let x = r.left + r.width / 2 - w / 2, y = r.top - h - 8
    if (y < 8) y = r.bottom + 8
    x = Math.max(8, Math.min(x, window.innerWidth - w - 8))
    tip.style.left = x + 'px'; tip.style.top = y + 'px'
  })
  papel.addEventListener('mouseleave', limpiar)
  papel.addEventListener('click', (ev) => {
    if (ev.target.closest('input')) return
    const td = ev.target.closest('[data-cas]')
    if (!td || !BASES.has(td.dataset.cas) || !_docsDe(td.dataset.cas).length) return
    window._pdtFiltrar(td.dataset.cas)
  })
}

window._pdtVista = (v) => { S.vista = v; _pintar() }
window._pdtFiltrar = (k) => {
  S.filtroCas = k
  document.getElementById('pdtTip')?.style.setProperty('display', 'none')
  _pintar()
  if (k) setTimeout(() => document.getElementById('pdtFiltro')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
}
window._pdtCambiarTipo = (sel) => {
  const p = PDTS.find(x => x.cod === sel.value)
  if (!p?.listo) { showToast(`${p?.nombre || sel.value}: pendiente de confirmar si aplica a JHIRO`, 'info'); sel.value = '0621' }
}
