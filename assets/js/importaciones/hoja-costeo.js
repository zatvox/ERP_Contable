// ============================================================================
// HOJA-COSTEO.JS — Hoja de costeo de la carpeta, en el formato del Excel
// ============================================================================
// Se muestra arriba de la primera pantalla de la carpeta. Mismo orden que la
// hoja de Luis:
//   Cabecera (proveedor, producto y subpartida, CI, DAM, canal y BL)
//   1. Descripción     FOB unit · kg · FOB $ · FOB S/
//   2. Valor de aduana FOB + flete + seguro = CIF  (USD y S/) · adelanto / balance
//      Tributos de despacho: Ad valorem, IGV, IPM, Percepción
//   3. Gastos de cadena local   (ledger: despacho + nacionalización)
//   4. Gastos financieros       (ledger: financiero)
//   5. Factor de distribución y Costo Perú por artículo
// Cada sección sin datos dice «Sin registros». Todo sale de lo ya registrado
// (CI, DAM, ledger de costos, pagos); si todavía no hay CI, la sección 1 se
// arma con las líneas de la Proforma, marcadas como estimado.
//
// Factor de distribución (igual que el Excel):
//   numerador = CIF + costos que entran al costo (ad valorem, gastos locales
//   sin IGV, gastos financieros)  ÷  FOB.   IGV, IPM y percepción NO entran.
// ============================================================================

import { query, esperarContextoEmpresa } from '../supabase-client.js'
import { getItems, getAdjuntos, getConteoAdjuntos, subirAdjuntos } from '../supabase-data.js'
import { getCurrentUser } from '../auth-supabase.js'
import { formatNumber, fechaDMY, showToast } from '../helpers.js'
import { ojoBtn } from '../shared/ver-editar.js'
import { CONCEPTOS_CARPETA } from './adjuntos-carpeta.js'

const num = v => parseFloat(v) || 0
const n2 = v => formatNumber(num(v), 2)
const n3 = v => formatNumber(num(v), 3)
const n4 = v => formatNumber(num(v), 4)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const dash = '<span style="color:var(--text-secondary);">—</span>'

const CONCEPTOS_TRIB = { ad_valorem: 'Ad Valorem', igv: 'IGV', ipm: 'IPM', percepcion: 'Percepción' }
const esAdic = c => /adicional/i.test(c.concepto || '') || c.concepto_codigo === 'ad_valorem_adic'

const TH = 'padding:6px 10px; background:var(--bg-tertiary, #2a3447); color:var(--text-primary); font-size:0.78rem; text-transform:uppercase; letter-spacing:0.02em; text-align:right;'
const TD = 'padding:6px 10px; border-bottom:1px solid var(--border-color); text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap;'
const TDL = TD.replace('text-align:right;', 'text-align:left;').replace('white-space:nowrap;', 'white-space:normal;')
const TOT = 'font-weight:700; background:var(--bg-secondary, #1f2937);'

const seccion = (titulo, cuerpo, ajustada = false, acciones = '') => `
  <div style="margin-top:14px;${ajustada ? ' width:fit-content; max-width:100%;' : ''}">
    <div style="font-weight:700; padding:6px 10px; background:var(--color-primary-soft, rgba(59,130,246,.18)); border-radius:6px 6px 0 0; white-space:nowrap;${acciones ? ' display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;' : ''}"><span>${titulo}</span>${acciones}</div>
    ${cuerpo}
  </div>`
const sinRegistros = (cols = 1) => `<div style="padding:12px; text-align:center; color:var(--text-secondary); border:1px dashed var(--border-color); border-top:0; border-radius:0 0 6px 6px;">Sin registros</div>`
const tabla = (head, filas, pie = '', ajustada = false) => `
  <div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse;">
    <thead><tr>${head.map((h, i) => `<th style="${TH}${i === 0 ? 'text-align:left;' : ''}">${h}</th>`).join('')}</tr></thead>
    <tbody>${filas}</tbody>${pie ? `<tfoot>${pie}</tfoot>` : ''}
  </table></div>`

let _modoFD = 'comercial'
try { _modoFD = localStorage.getItem('hojaCosteoModoFD') === 'contable' ? 'contable' : 'comercial' } catch { /* sin storage */ }
let _sec5 = null
// Globo de ayuda (position:fixed para que no lo recorte el scroll de las tablas)
if (!window.__hcTipInit) {
  window.__hcTipInit = true
  let box = null
  const quitar = () => { box?.remove(); box = null }
  document.addEventListener('mouseover', e => {
    const t = e.target.closest?.('.hc-tip')
    if (!t) { if (box && !e.target.closest?.('.hc-tip-box')) quitar(); return }
    quitar()
    box = document.createElement('div'); box.className = 'hc-tip-box'; box.innerHTML = t.dataset.tip
    document.body.appendChild(box)
    const r = t.getBoundingClientRect(), b = box.getBoundingClientRect()
    let x = Math.min(Math.max(8, r.right - b.width), window.innerWidth - b.width - 8)
    let y = r.bottom + 8; if (y + b.height > window.innerHeight - 8) y = Math.max(8, r.top - b.height - 8)
    box.style.left = x + 'px'; box.style.top = y + 'px'
  })
  document.addEventListener('scroll', quitar, true)
}
window.hcModoFD = m => {
  _modoFD = m === 'contable' ? 'contable' : 'comercial'
  try { localStorage.setItem('hojaCosteoModoFD', _modoFD) } catch { /* */ }
  const h = document.getElementById('hc-sec5')
  if (h && _sec5) h.innerHTML = _sec5()      // solo la sección 5
  else window.renderHojaCosteo?.()
}

// ─── Datos ──────────────────────────────────────────────────────────────────
async function _cargar() {
  await esperarContextoEmpresa()
  const carpeta = window.carpetaActual || null
  const ci = window.costeoActual?.id ? window.costeoActual : null
  if (!carpeta) return null
  const carpetaId = carpeta.id
  // Ola 1: TODO lo que depende solo de la carpeta/CI, en paralelo (antes eran ~25 viajes uno tras otro).
  const [pi, costos, pagos, dams, bls, items, prov, adjs, liqs, guias, estRows, lotesC, lineasRaw, docsAll, vDam, vAut, vDoc] = await Promise.all([
    carpeta.orden_compra_id ? query('orden_compra', { id: carpeta.orden_compra_id }) : [],
    query('importacion_costos', { carpeta_importacion_id: carpetaId }),
    query('importacion_pagos', { carpeta_importacion_id: carpetaId }),
    ci ? query('dams', { importacion_id: ci.id }) : [],
    ci ? query('bill_of_ladings', { importacion_id: ci.id }) : [],
    getItems(),
    carpeta.proveedor_id ? query('contacts', { id: carpeta.proveedor_id }) : [],
    getAdjuntos('carpeta_importacion', carpetaId),
    query('importacion_liquidaciones_agente', { carpeta_importacion_id: carpetaId }),
    query('guias_ingreso_compra', { carpeta_importacion_id: carpetaId }),
    query('importacion_estadia', { carpeta_importacion_id: carpetaId }),
    query('lotes', { carpeta_importacion_id: carpetaId }),
    ci ? query('detalle_comercial_invoice', { comercial_invoice_id: ci.id })
       : (carpeta.orden_compra_id ? query('detalle_orden_compra', { orden_compra_id: carpeta.orden_compra_id }) : []),
    query('documentos_importacion', {}),
    getConteoAdjuntos('dam'), getConteoAdjuntos('autoliquidacion'), getConteoAdjuntos('documento_importacion')
  ])
  const damRow = (dams || [])[0] || null
  const piRow = (pi || [])[0] || null
  const liq = (liqs || [])[0] || null
  const estadia = (estRows || [])[0] || null
  // Ola 2: lo que depende de la DAM o de la liquidación
  const [ajustesR, abonosR, adjLiqR] = await Promise.all([
    damRow ? query('dam_autoliquidaciones', { dam_id: damRow.id }) : [],
    liq ? query('importacion_liquidacion_abonos', { liquidacion_agente_id: liq.id }) : [],
    liq ? getAdjuntos('liquidacion_agente', liq.id) : []
  ])
  const ajustes = ajustesR || [], abonosAg = abonosR || [], adjLiq = adjLiqR || []
  // T.C. (soles por USD): SOLO el de la DAM (T.C. venta SUNAT de la fecha de pago de tributos).
  // Sin DAM no se inventa un tipo de cambio: las columnas en soles quedan en "—".
  const tcDam = num((dams || [])[0]?.tipo_cambio)
  const tcInfo = tcDam ? { tc: tcDam, origen: 'DAM', ref: false } : null
  const lineas = lineasRaw
  const costosOk = (costos || []).filter(c => !c.anulado && !c.castigada)
  const docIds = new Set(costosOk.map(c => c.documento_id).filter(Boolean))
  const docs = {}
  for (const d of docsAll || []) if (docIds.has(d.id)) docs[d.id] = d
  const mapaItems = {}; for (const i of items || []) mapaItems[i.id] = i
  const vouchers = { dam: vDam, aut: vAut, doc: vDoc }
  return { tcInfo, carpeta, ci, pi: piRow, costos: costosOk, pagos: pagos || [], dam: damRow, ajustes, liq, abonosAg, guias, lotesC, estadia, bls: bls || [], lineas: lineas || [], docs, mapaItems, adjuntos: [...(adjs || []), ...(adjLiq || [])], vouchers, proveedor: (prov || [])[0] || null, estimado: !ci }
}

// ─── Cálculo ────────────────────────────────────────────────────────────────
function _calcular(d) {
  const { ci, pi, costos, dam, lineas, estimado } = d
  const tc = d.tcInfo?.tc || null
  // Las líneas del CI traen el precio de la factura (con flete y seguro incluidos si es CIF/CFR…).
  // FOB real = línea × (FOB del CI ÷ suma de líneas), con tope 1. Sin CI no hay factor.
  const sumaLineas = ci ? lineas.reduce((t, l) => t + (num(l.costo_total ?? l.subtotal)), 0) : 0
  const kFob = ci && num(ci.valor_total_final_fob) > 0 && sumaLineas > 0 ? Math.min(1, num(ci.valor_total_final_fob) / sumaLineas) : 1
  const art = lineas.map(l => {
    const kg = num(l.cantidad_neto ?? l.cantidad)
    const unit = num(l.costo_unitario ?? l.precio_unitario) * kFob
    const fobUsd = (num(l.costo_total ?? l.subtotal) || kg * num(l.costo_unitario ?? l.precio_unitario)) * kFob
    const it = d.mapaItems[l.product_id ?? l.item_id]
    return { itemId: l.product_id ?? l.item_id, nombre: it ? (it.sku ? `(${it.sku}) ${it.nombre}` : it.nombre) : (l.descripcion || '—'), partida: l.partida_arancelaria || it?.partida_arancelaria || '', kg, unit, fobUsd, fobPenUnit: tc ? unit * tc : null }
  })
  const fobUsd = art.reduce((t, a) => t + a.fobUsd, 0)
  const sumaLedger = cod => costos.filter(c => c.concepto_codigo === cod || (cod === 'ad_valorem' && c.concepto_codigo === 'ad_valorem_adic'))
  const usd = arr => arr.reduce((t, c) => t + num(c.monto_usd), 0)
  const pen = arr => arr.reduce((t, c) => t + num(c.monto_pen), 0)

  // Flete y seguro: ledger si hay líneas (FOB/EXW); si no, lo que declara la DAM o el CI (CIF/CFR…)
  const fleteUsd = sumaLedger('flete').length ? usd(sumaLedger('flete')) : (num(dam?.flete_maritimo) || num(ci?.costo_flete))
  const seguroUsd = sumaLedger('seguro').length ? usd(sumaLedger('seguro')) : (num(dam?.seguro_maritimo) || num(ci?.costo_seguro))
  const cifUsd = fobUsd + fleteUsd + seguroUsd

  // Tributos: del ledger; si aún no están cargados, los de la DAM
  const trib = Object.entries(CONCEPTOS_TRIB).map(([cod, nombre]) => {
    const l = sumaLedger(cod)
    const extra = l.filter(esAdic), propias = l.filter(c => !esAdic(c))
    // Original: lo del ledger; si aún no se envió, lo que dice la DAM. Los ajustes (adicionales) se suman aparte.
    let u = usd(propias), p = pen(propias)
    if (!propias.length && dam) {
      const delDam = { ad_valorem: dam.ad_valorem_usd, igv: dam.igv_usd, ipm: dam.imp_usd, percepcion: dam.percepcion }[cod]
      if (num(delDam)) { u = cod === 'percepcion' && tc ? num(delDam) / tc : num(delDam); p = cod === 'percepcion' ? num(delDam) : (tc ? u * tc : 0) }
    }
    const uAd = usd(extra), pAd = pen(extra)
    return { cod, nombre, u: u + uAd, p: p + pAd, adicional: uAd, hay: !!(l.length || u) }
  }).filter(t => t.hay)

  const locales = costos.filter(c => c.grupo === 'despacho' || c.grupo === 'nacionalizacion')
  const financ = costos.filter(c => c.grupo === 'financiero')
  const entra = c => c.entra_costo_gestion === true
  const costoUsd = usd(costos.filter(c => entra(c) && !['flete', 'seguro'].includes(c.concepto_codigo)))
  const costoPen = pen(costos.filter(c => entra(c) && !['flete', 'seguro'].includes(c.concepto_codigo)))
  const contUsd = usd(costos.filter(c => c.entra_costo_contable === true && !['flete', 'seguro'].includes(c.concepto_codigo)))
  const contPen = pen(costos.filter(c => c.entra_costo_contable === true && !['flete', 'seguro'].includes(c.concepto_codigo)))
  // Subtotales por sección de la hoja (para el globito del numerador)
  const detalle = filtro => {
    const grupos = [['3.- Tributos de despacho', 0, 0], ['4.- Gastos de cadena local', 0, 0], ['5.- Gastos financieros', 0, 0]]
    for (const c of costos.filter(c => filtro(c) && !['flete', 'seguro'].includes(c.concepto_codigo))) {
      const g = grupos[c.concepto_codigo in CONCEPTOS_TRIB || c.concepto_codigo === 'ad_valorem_adic' ? 0 : c.grupo === 'financiero' ? 2 : 1]
      g[1] += num(c.monto_usd); g[2] += num(c.monto_pen)
    }
    return grupos.filter(g => Math.abs(g[1]) > 0.0001).map(g => ({ nombre: g[0], usd: g[1], pen: g[2] }))
  }
  const detCom = detalle(c => c.entra_costo_gestion === true), detCont = detalle(c => c.entra_costo_contable === true)
  const fobPen = tc ? fobUsd * tc : null
  const cifPen = tc ? cifUsd * tc : null
  const numUsd = cifUsd + costoUsd
  const numPen = cifPen != null ? cifPen + costoPen : null
  const fdUsd = fobUsd > 0 ? numUsd / fobUsd : null
  const fdPen = fobPen > 0 && numPen != null ? numPen / fobPen : null
  const numUsdC = cifUsd + contUsd
  const numPenC = cifPen != null ? cifPen + contPen : null
  const fdUsdC = fobUsd > 0 ? numUsdC / fobUsd : null
  const fdPenC = fobPen > 0 && numPenC != null ? numPenC / fobPen : null
  const sinDesglose = !!ci && kFob === 1 && ['CIF', 'CFR', 'CIP', 'CPT', 'DAP', 'DDP'].includes(String(ci.terminos_delivery || '').toUpperCase()) && !fleteUsd && !seguroUsd
  return { tc, kFob, sinDesglose, art, fobUsd, fobPen, fleteUsd, seguroUsd, cifUsd, cifPen, trib, locales, financ, numUsd, numPen, fdUsd, fdPen, numUsdC, numPenC, fdUsdC, fdPenC, detCom, detCont, estimado }
}


// ─── Cronograma de pagos (Anticipo → Embarque → Saldo) ────────────────────────
const _sumaDias = (iso, dias) => {
  if (!iso || dias == null || dias === '' || isNaN(dias)) return null
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + parseInt(dias))
  return d.toISOString().slice(0, 10)
}
const _hoy = () => new Date().toISOString().slice(0, 10)

/** Fechas y montos del cronograma. Embarque estimado = fecha del anticipo (pagado o límite) + días de embarque de la PI. */
export function calcularCronograma(d) {
  const pi = d.pi
  if (!pi || !num(pi.total_oc)) return null
  const mon = pi.currency || 'USD'
  const pct = pi.anticipo_porcentaje != null ? num(pi.anticipo_porcentaje) : 0
  const total = num(pi.total_oc)
  const ok = d.pagos.filter(p => p.estado !== 'observado' && p.moneda === mon)
  const antPags = ok.filter(p => p.tipo === 'anticipo').sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)))
  const salPags = ok.filter(p => p.tipo === 'saldo' || p.tipo === 'pago_total')
  const antPag = antPags.reduce((t, p) => t + num(p.monto_transferido), 0)
  const salPag = salPags.reduce((t, p) => t + num(p.monto_transferido), 0)
  const antEsp = total * pct / 100, salEsp = total - antEsp
  const antLimite = _sumaDias(pi.fecha, pi.dias_validez_anticipo)
  const antFecha = antPags[0]?.fecha || null
  const base = antFecha || antLimite
  const embEst = _sumaDias(base, pi.dias_embarque)
  const blFechas = (d.bls || []).map(b => b.fecha).filter(Boolean).sort()
  const embReal = blFechas[0] || null
  const embFecha = embReal || embEst
  const salLimite = _sumaDias(embFecha, pi.dias_saldo_desde_bl)
  const estado = (pag, esp, limite) => pag >= esp - 0.01 && esp > 0 ? 'pagado' : pag > 0 ? 'parcial' : (limite && limite < _hoy() ? 'vencido' : 'pendiente')
  return {
    mon, pct, total, antEsp, salEsp, antPag, salPag, antLimite, antFecha, embEst, embReal, embFecha, salLimite,
    salProyectado: !embReal, antEstado: estado(antPag, antEsp, antLimite), salEstado: estado(salPag, salEsp, salLimite),
    base: antFecha ? 'anticipo pagado' : 'límite del anticipo', diasEmb: pi.dias_embarque, diasSaldo: pi.dias_saldo_desde_bl
  }
}

const CHIP = { pagado: ['Pagado', '#10b981'], parcial: ['Parcial', '#f59e0b'], vencido: ['Vencido', '#ef4444'], pendiente: ['Pendiente', '#6b7280'], hecho: ['Embarcado', '#10b981'], estimado: ['Estimado', '#3b82f6'] }
const chip = k => `<span class="cr-chip" style="--c:${CHIP[k][1]};">${CHIP[k][0]}</span>`

function _cronogramaHtml(c) {
  if (!c) return ''
  const monto = (m, v) => `${m} ${n2(v)}`
  const paso = (cls, ico, tit, big, sub, estado, boton) => `<div class="cr-paso ${cls}">
      <div class="cr-top"><span class="cr-ico">${ico}</span><span class="cr-tit">${tit}</span>${estado}</div>
      <div class="cr-big">${big}</div><div class="cr-sub">${sub}</div>${boton || ''}</div>`
  const btn = (t, txt) => `<button type="button" class="btn btn-primary btn-small cr-btn" onclick="window.abrirPagoRapido('${t}')">${txt}</button>`
  const falta = (!c.antLimite && !c.antFecha) || c.diasEmb == null
  const anticipo = paso(c.antEstado, '💳', `Anticipo ${n2(c.pct)}%`, monto(c.mon, c.antEsp),
    c.antFecha ? `Pagado el ${fechaDMY(c.antFecha)}${c.antPag ? ' · ' + monto(c.mon, c.antPag) : ''}` : (c.antLimite ? `Límite ${fechaDMY(c.antLimite)}` : 'Sin plazo en la PI'),
    chip(c.antEstado), c.antEstado === 'pagado' ? '' : btn('anticipo', c.antPag ? 'Completar anticipo' : 'Pagar anticipo'))
  const embarque = paso(c.embReal ? 'pagado' : 'estimado', '🚢', 'Embarque', c.embFecha ? fechaDMY(c.embFecha) : '—',
    c.embReal ? 'Fecha real del B/L' : (c.embEst ? `Estimada: ${c.base} + ${c.diasEmb} días` : (falta ? 'Falta plazo de embarque en la PI' : 'Se calcula al pagar el anticipo')),
    chip(c.embReal ? 'hecho' : 'estimado'), '')
  const saldo = paso(c.salEstado, '🏁', `Saldo ${n2(100 - c.pct)}%`, monto(c.mon, c.salEsp),
    c.salPag ? `Pagado ${monto(c.mon, c.salPag)}` : (c.salLimite ? `${c.salProyectado ? 'Vence aprox.' : 'Vence'} ${fechaDMY(c.salLimite)} · ${c.diasSaldo} días desde ${c.salProyectado ? 'el embarque est.' : 'el B/L'}` : 'Sin plazo de saldo en la PI'),
    chip(c.salEstado), c.salEstado === 'pagado' ? '' : btn('saldo', c.salPag ? 'Completar saldo' : 'Pagar saldo'))
  return `<div class="cr-wrap"><div class="cr-head">Cronograma de pagos <span>· PI ${c.mon} ${n2(c.total)}</span>
      <button type="button" class="btn btn-secondary btn-small" style="margin-left:auto;" onclick="window.abrirPagosProveedor()">Ver todos los pagos</button></div>
    <div class="cr-grid">${anticipo}<div class="cr-flecha">→</div>${embarque}<div class="cr-flecha">→</div>${saldo}</div></div>`
}


// ─── Línea de tiempo de la carpeta: en qué etapa voy y qué falta concluir ─────
function _timelineHtml(d, c) {
  const { pi, dam, bls, costos, ajustes, liq, abonosAg, carpeta } = d
  const vivos = (ajustes || []).filter(a => a.estado !== 'desestimada')
  const locales = costos.filter(k => k.grupo === 'despacho' || k.grupo === 'nacionalizacion')
  const provis = locales.filter(k => k.es_provisional).length
  const ult = tipos => d.pagos.filter(p => tipos.includes(p.tipo) && p.estado !== 'observado').map(p => p.fecha).sort().pop() || null
  const mon = c?.mon || 'USD'
  const btn = (t, f) => `<button type="button" class="btn btn-primary btn-small tl-btn" onclick="${f}">${t}</button>`
  const L = []
  L.push({ ico: '📄', tit: 'Proforma (PI)', ok: !!pi, fecha: pi?.fecha, sub: pi ? esc(pi.numero_proforma_proveedor || pi.numero || '') : 'Falta registrar la proforma' })
  if (c) {
    L.push({ ico: '💳', tit: `Anticipo ${n2(c.pct)}%`, ok: c.antEstado === 'pagado', warn: c.antEstado === 'vencido', fecha: c.antFecha || c.antLimite, est: !c.antFecha,
      sub: c.antFecha ? `${mon} ${n2(c.antPag)} pagado` : (c.antLimite ? 'Límite de pago' : 'Sin plazo en la PI'), btn: c.antEstado === 'pagado' ? '' : btn(c.antPag ? 'Completar' : 'Pagar', "window.abrirPagoRapido('anticipo')") })
    L.push({ ico: '🚢', tit: 'Embarque (B/L)', ok: !!c.embReal, fecha: c.embFecha, est: !c.embReal, sub: c.embReal ? 'Fecha real del B/L' : 'Fecha estimada' })
    L.push({ ico: '🏁', tit: `Saldo ${n2(100 - c.pct)}%`, ok: c.salEstado === 'pagado', warn: c.salEstado === 'vencido', fecha: c.salPag ? ult(['saldo', 'pago_total']) : c.salLimite, est: !c.salPag,
      sub: c.salPag ? `${mon} ${n2(c.salPag)} pagado` : (c.salLimite ? 'Vence' : 'Sin plazo de saldo'), btn: c.salEstado === 'pagado' ? '' : btn(c.salPag ? 'Completar' : 'Pagar', "window.abrirPagoRapido('saldo')") })
  }
  L.push({ ico: '📝', tit: 'Proforma del agente', ok: !!liq?.proforma_numero, fecha: liq?.proforma_fecha, sub: liq?.proforma_numero ? `N° ${esc(liq.proforma_numero)} · estimado para auditar` : 'Pre-liquidación de DESA: regístrala para auditar', btn: liq?.proforma_numero ? '' : btn('Registrar', 'window.abrirLiquidacionAgente()') })
  const canal = dam?.canal_aduanero ? (CANAL_E3[dam.canal_aduanero] || [dam.canal_aduanero])[0] : ''
  L.push({ ico: '🏛️', tit: 'DAM numerada', ok: !!dam, fecha: dam?.fecha_dam, sub: dam ? `Canal ${canal || 'sin indicar'}` : 'Falta registrar la DAM', btn: dam ? '' : btn('Registrar', 'window.abrirNuevaDAM()') })
  const pend = vivos.filter(a => a.estado === 'pendiente' || !a.numero).length
  L.push({ ico: '💰', tit: 'Tributos pagados', ok: dam?.estado === 'pagado' && !pend, fecha: dam?.fecha_pago, warn: !!pend,
    sub: pend ? `${pend} ajuste(s) por liquidar/pagar` : (dam?.estado === 'pagado' ? (vivos.length ? 'DAM + ajuste de valor' : 'DAM') : 'Falta pagar la DAM') })
  L.push({ ico: '✅', tit: 'Levante autorizado', ok: !!dam?.fecha_levante, fecha: dam?.fecha_levante ? String(dam.fecha_levante).slice(0, 10) : null, sub: dam?.fecha_levante ? 'Aduanas autorizó' : 'Pendiente de Aduanas' })
  const gs = d.guias || []
  L.push({ ico: '🚚', tit: 'Guía de ingreso al almacén', ok: gs.length > 0, fecha: gs.map(g => g.fecha_guia).sort().pop(), sub: gs.length ? `${gs.map(g => esc(g.numero_guia)).join(', ')} · lote vinculado` : 'Llegada de la mercadería: vincula la guía', btn: gs.length ? '' : btn('Vincular', 'window.abrirGuiaCarpeta()') })
  const rsE = window.estadiaResumen?.(d.estadia)
  L.push({ ico: '⏱️', tit: 'Control de estadía', ok: !!rsE?.cerrado && !rsE.exceso, warn: !!rsE?.alerta, fecha: d.estadia?.fecha_descarga, sub: rsE ? rsE.texto : 'Registra días libres (naviera y terminal) y la constancia', btn: btn(d.estadia ? 'Ver' : 'Registrar', 'window.abrirEstadia()') })
  L.push({ ico: '🧾', tit: 'Gastos locales', ok: locales.length > 0 && !provis, warn: false, sub: locales.length ? (provis ? `${provis} provisional(es): falta la factura real` : `${locales.length} registrados`) : 'Faltan las facturas' })
  const ab = abonosAg || []
  L.push({ ico: '💵', tit: 'Abonos al agente', ok: ab.length > 0, fecha: ab.map(a => a.fecha).sort().pop(), sub: ab.length ? `${ab.length} abono(s) registrado(s)` : 'Registra lo que le abonaste', btn: ab.length ? '' : btn('Registrar', 'window.abrirLiquidacionAgente()') })
  L.push({ ico: '📑', tit: 'Liquidación del agente', ok: !!liq?.numero, fecha: liq?.fecha, sub: liq?.numero ? `N° ${esc(liq.numero)}` : 'Falta registrar', btn: liq?.numero ? '' : btn('Registrar', 'window.abrirLiquidacionAgente()') })
  const dev = num(liq?.dev_monto_usd)
  L.push({ ico: '↩️', tit: 'Devolución de saldo', ok: !!liq?.numero && (!dev || liq.dev_estado === 'recibida'), fecha: liq?.dev_fecha, est: liq?.dev_estado === 'en_proceso',
    sub: !liq?.numero ? 'Después de la liquidación' : (!dev ? 'Sin saldo a devolver' : liq.dev_estado === 'recibida' ? `$ ${n2(dev)} recibido` : `$ ${n2(dev)} · ${liq.dev_estado === 'en_proceso' ? 'en proceso' : 'por registrar'}`) })
  const lc = d.lotesC || []
  const aplicado = lc.length > 0 && lc.every(l => l.costo_carpeta_id === carpeta?.id && l.costo_real != null)
  L.push({ ico: '📦', tit: 'Costo final al lote', ok: aplicado, sub: aplicado ? 'Costo real y comercial aplicados' : (lc.length ? 'Pendiente: aplicar al lote (recostea ventas)' : 'Requiere la guía vinculada'), btn: aplicado || !lc.length ? '' : btn('Revisar', 'window.abrirCostosLote()') })
  L.push({ ico: '🔒', tit: 'Cierre de carpeta', ok: carpeta?.estado === 'cerrada', sub: carpeta?.estado === 'cerrada' ? 'Costos definitivos' : 'Al final: costo definitivo' })
  // ── Agrupar los subpasos en 9 etapas (cada una con chips de subpasos) ──
  const sp = pref => L.find(x => String(x.tit).startsWith(pref))
  const conAsiento = costos.filter(k => k.asiento_id).length
  const G = [
    { ico: '📄', tit: 'PI y anticipo', subs: [sp('Proforma (PI)'), sp('Anticipo')] },
    { ico: '🚢', tit: 'Embarque y saldo', subs: [sp('Embarque'), sp('Saldo')] },
    { ico: '🏛️', tit: 'Despacho aduanero', subs: [sp('DAM'), sp('Tributos'), sp('Levante')] },
    { ico: '🚚', tit: 'Llegada al almacén', subs: [sp('Guía de ingreso'), sp('Control de estadía')] },
    { ico: '🧾', tit: 'Gastos locales', subs: [sp('Gastos locales')] },
    { ico: '🧑‍💼', tit: 'Agente aduanero (proforma, liquidación, abonos)', subs: [sp('Proforma del agente'), sp('Abonos'), sp('Liquidación'), sp('Devolución')] },
    { ico: '📦', tit: 'Costo al lote', subs: [sp('Costo final')] },
    { ico: '🔒', tit: 'Cierre', subs: [sp('Cierre')] },
    { ico: '📒', tit: 'Contabilización', subs: [{ tit: 'Asientos', ok: costos.length > 0 && conAsiento === costos.length, sub: costos.length ? `${conAsiento} de ${costos.length} movimientos con asiento` : 'Sin movimientos' }] }
  ].map(g => {
    g.subs = g.subs.filter(Boolean)
    g.ok = g.subs.length > 0 && g.subs.every(x => x.ok)
    g.warn = g.subs.some(x => x.warn)
    g.fecha = g.ok ? g.subs.map(x => x.fecha).filter(Boolean).sort().pop() : null
    const falta = g.subs.find(x => !x.ok)
    g.btn = falta?.btn || ''
    g.sub = g.ok ? 'Completo' : (falta ? `${esc(falta.tit)}: ${falta.sub || ''}` : '')
    return g
  })
  const chips = g => g.subs.length > 1 ? `<div class="tl-chips">${g.subs.map(x => `<span class="tl-chip${x.ok ? ' ok' : x.warn ? ' warn' : ''}" title="${esc(String(x.sub || '').replace(/<[^>]+>/g, ''))}">${x.ok ? '✓' : x.warn ? '!' : '○'} ${esc(x.tit)}</span>`).join('')}</div>` : ''
  const L9 = G
  const iAct = L9.findIndex(x => !x.ok)
  const hechos = L9.filter(x => x.ok).length
  const fila = (x, i) => {
    const cls = x.ok ? 'ok' : i === iAct ? 'act' : 'pen'
    const marca = x.ok ? '✓' : x.warn ? '!' : i + 1
    return `<li class="tl-it ${cls}${x.warn ? ' warn' : ''}"><span class="tl-dot">${marca}</span>
      <div class="tl-tx"><div class="tl-tit">${x.ico} ${x.tit}${x.fecha ? ` <span class="tl-f">${fechaDMY(x.fecha)}</span>` : ''}</div>${chips(x)}<div class="tl-sub">${x.sub || ''}</div></div>${x.btn || ''}</li>`
  }
  const sig = L9[iAct]
  return `<div class="cr-wrap tl-wrap"><div class="cr-head">Línea de tiempo <span>· ${hechos} de ${L9.length} pasos</span>
      <button type="button" class="btn btn-secondary btn-small" style="margin-left:auto;" onclick="window.abrirPagosProveedor()">Ver pagos</button></div>
    <div class="tl-barra"><i style="width:${Math.round(hechos / L9.length * 100)}%"></i></div>
    <div class="tl-sig">${sig ? `👉 <b>Sigue:</b> ${sig.tit}${sig.sub ? ' — ' + sig.sub : ''}` : '🎉 Carpeta completa'}</div>
    <ol class="tl-lista">${L9.map(fila).join('')}</ol></div>`
}

// ─── Documentos de la carpeta (lista de control + botones de registro) ───────
window.abrirNuevaDAM = () => window.abrirDAM?.()   // modal único de la DAM (dam-modal.js)

const _btnReg = (txt, fn) => `<button type="button" class="btn btn-secondary btn-small dc-btn" onclick="${fn}">${txt}</button>`
/** Tipos de documento esperados en el expediente, con su estado de registro en el ERP. */
function _slotsDocs(d) {
  const { ci, pi, bls, dam } = d
  const bl = (bls || [])[0]
  const car = c => a => a.entidad === 'carpeta_importacion' && (Array.isArray(c) ? c : [c]).includes(a.concepto)
  const gs = d.guias || []
  // Pago relacionado con el documento: resalta el icono y deja un botón oculto (aparece al pasar el mouse)
  const pgs = tipos => (d.pagos || []).filter(p => tipos.includes(p.tipo) && p.estado !== 'observado')
  const pagoDe = (tipos, rot) => {
    const a = pgs(tipos); if (!a.length) return null
    const mon = a[0].moneda || 'USD', tot = a.reduce((t, p) => t + num(p.monto_transferido), 0)
    return { txt: `${rot}: ${mon} ${n2(tot)} · ${fechaDMY(a.map(p => p.fecha).sort().pop())}`, fn: 'window.abrirPagosProveedor()' }
  }
  const costosDe = cod => (d.costos || []).filter(k => k.concepto_codigo === cod)
  const bolP = costosDe('boletin_quimico')
  const abAg = d.abonosAg || []
  return [
    { ico: '📄', tit: 'Proforma (PI)', sube: 'proforma', ok: !!pi, pago: pagoDe(['anticipo', 'pago_total'], 'Anticipo pagado'), match: car('proforma'), sub: pi ? `${esc(pi.numero_proforma_proveedor || pi.numero)} · ${fechaDMY(pi.fecha)}` : 'Sin registrar', reg: pi ? _btnReg('👁 Registro', `window.verPI(${pi.id})`) : '' },
    { ico: '🧾', tit: 'Commercial Invoice', sube: 'invoice', ok: !!ci, pago: pagoDe(['saldo'], 'Saldo pagado'), match: car('invoice'), sub: ci ? `${esc(ci.invoice_number)} · ${fechaDMY(ci.fecha)}` : 'Aún no registrado', reg: ci ? _btnReg('👁 Registro', 'window.verCI()') : '' },
    { ico: '📦', tit: 'Packing list', sube: 'packing', match: car('packing') },
    { ico: '🚢', tit: 'Bill of Lading', sube: 'bl', ok: !!bl, match: car('bl'),
      sub: bl ? `${esc(bl.nro_bill_lading)} · ${bl.fecha ? 'embarque ' + fechaDMY(bl.fecha) : 'sin fecha'}${bl.fecha_eta ? ' · ETA ' + fechaDMY(bl.fecha_eta) : ''}` : (ci ? 'Sin registrar' : 'Requiere el CI'),
      reg: bl ? _btnReg('👁 Registro', `window.abrirBL(${bl.id})`) + `<a class="btn btn-secondary btn-small dc-btn" href="${esc(window.urlRastreoBL?.(bl) || '#')}" target="_blank" rel="noopener">🔎 Rastrear</a>` : (ci ? _btnReg('+ Registrar', 'window.abrirBL()') : '') },
    { ico: '🛡️', tit: 'Seguro (póliza)', sube: 'poliza', match: car('poliza') },
    { ico: '🌏', tit: 'Certificado de origen', sube: 'certificado_origen', match: car('certificado_origen') },
    { ico: '🧪', tit: 'Ficha técnica', sube: 'ficha_tecnica', match: car('ficha_tecnica') },
    { ico: '🏛️', tit: 'DAM y despacho', sube: 'dam_completa', ok: !!dam, pago: dam?.estado === 'pagado' ? { txt: `Tributos pagados · ${fechaDMY(dam.fecha_pago)}`, fn: `window.editarDAM('${dam.id}')` } : null, match: car(['dam', 'dam_completa', 'notificacion_aduana', 'garantia', 'autoliquidacion']),
      sub: dam ? `${esc(dam.numero_dam)} · ${fechaDMY(dam.fecha_dam)}` : (ci ? 'Sin registrar' : 'Requiere el CI'),
      reg: dam ? _btnReg('👁 Registro', `window.editarDAM('${dam.id}')`) : (ci ? _btnReg('+ Registrar', 'window.abrirNuevaDAM()') : '') },
    { ico: '⚗️', tit: 'Boletín químico', sube: 'boletin', opcional: true, pago: bolP.length ? { txt: `Pagado · S/ ${n2(bolP.reduce((t, k) => t + num(k.monto_pen), 0))}`, fn: `window.abrirBoletinQuimico(${bolP[0].id})` } : null, match: car('boletin') },
    { ico: '🏦', tit: 'Constancias de pago', sube: 'voucher', match: a => ['voucher', 'swift', 'correo'].includes(a.concepto) && a.entidad === 'carpeta_importacion' },
    { ico: '🚚', tit: 'Guía de ingreso', sube: 'guia', ok: gs.length > 0, match: car('guia'), sub: gs.length ? gs.map(g => esc(g.numero_guia)).join(', ') : 'Sin vincular', reg: _btnReg(gs.length ? '👁 Registro' : '🔗 Vincular', 'window.abrirGuiaCarpeta()') },
    { ico: '⏱️', tit: 'Constancia de estadía', sube: 'estadia', opcional: true, ok: !!d.estadia, match: car('estadia'), sub: d.estadia ? 'Días libres registrados' : '', reg: _btnReg(d.estadia ? '👁 Registro' : '+ Registrar', 'window.abrirEstadia()') },
    { ico: '📝', tit: 'Proforma del agente', subeFn: 'window.abrirLiquidacionAgente()', ok: !!d.liq?.proforma_numero, match: a => a.entidad === 'liquidacion_agente' && a.concepto === 'proforma', sub: d.liq?.proforma_numero ? `N° ${esc(d.liq.proforma_numero)}` : '', reg: _btnReg('👁 Registro', 'window.abrirLiquidacionAgente()') },
    { ico: '📑', tit: 'Liquidación del agente', subeFn: 'window.abrirLiquidacionAgente()', pago: abAg.length ? { txt: `${abAg.length} abono(s) al agente · ${fechaDMY(abAg.map(a => a.fecha).sort().pop())}`, fn: 'window.abrirLiquidacionAgente()' } : null, ok: !!d.liq?.numero, match: a => a.concepto === 'liquidacion', sub: d.liq?.numero ? `N° ${esc(d.liq.numero)}` : '', reg: _btnReg('👁 Registro', 'window.abrirLiquidacionAgente()') },
    { ico: '🧾', tit: 'Facturas de gastos', sube: 'factura_gasto', match: a => ['factura_gasto', 'rh', 'recibo'].includes(a.concepto) }
  ]
}
window.hcDocSlots = _slotsDocs

function _documentosHtml(d) {
  const slots = _slotsDocs(d), adjs = d.adjuntos || []
  const hechos = slots.filter(sl => sl.ok || adjs.some(a => sl.match(a))).length
  return `<div class="cr-wrap"><div class="cr-head">Documentos de la carpeta <span>· ${hechos} de ${slots.length} tipos · 📎 ${adjs.length} archivo${adjs.length === 1 ? '' : 's'}</span>
      <button type="button" class="btn btn-secondary btn-small" style="margin-left:auto;" onclick="window.abrirAdjuntosCarpeta()" title="Ver en grande, descargar, subir, reclasificar o quitar">⚙ Gestionar</button></div>
    ${window.acTarjetas ? window.acTarjetas(slots, adjs, { compacto: true }) : ''}</div>`
}


// ─── Etapa 3: despacho en Aduanas y contingencias ───────────────────────────────
const CANAL_E3 = { verde: ['Verde', '#10b981'], naranja: ['Naranja', '#f59e0b'], rojo: ['Rojo', '#ef4444'] }
const MOTIVO_E3 = { duda_razonable: 'Duda razonable', ajuste_valor: 'Ajuste de valor', error_clasificacion: 'Error de clasificación', otro: 'Otro ajuste' }

function _etapa3Html(d) {
  const { dam, ci, costos, ajustes } = d
  if (!ci) return ''
  const head = (extra = '') => `<div class="cr-head">Etapa 3 · Despacho en Aduanas ${extra}</div>`
  if (!dam) return `<div class="cr-wrap">${head('<span>· sin DAM registrada</span>')}
    <div class="e3-vacio">Cuando tu agente te entregue la DAM, regístrala aquí para controlar canal, levante, tributos y contingencias.
      <button type="button" class="btn btn-primary btn-small" onclick="window.abrirNuevaDAM()">+ Registrar DAM</button></div></div>`
  const vivos = (ajustes || []).filter(a => a.estado !== 'desestimada')
  const tribA = a => num(a.ad_valorem_usd) + num(a.ipm_usd) + num(a.igv_usd) + num(a.intereses_usd)
  const cifOrig = num(dam.valor_cif) || (num(dam.valor_fob) + num(dam.flete_maritimo) + num(dam.seguro_maritimo))
  const adic = vivos.reduce((t, a) => t + num(a.valor_adicional_usd), 0)
  const sum = k => vivos.reduce((t, a) => t + num(a[k]), 0)
  const tribOrig = num(dam.ad_valorem_usd) + num(dam.imp_usd) + num(dam.igv_usd)
  const tribAdic = vivos.reduce((t, a) => t + tribA(a), 0)
  const pendientes = vivos.filter(a => a.estado === 'pendiente')
  const por = (cod) => costos.filter(c => c.concepto_codigo === cod)
  const bol = por('boletin_quimico'), sob = por('sobreestadia')
  const tieneBolAdj = (d.adjuntos || []).some(a => a.concepto === 'boletin')
  const [cn, cc] = CANAL_E3[dam.canal_aduanero] || ['Sin canal', '#6b7280']
  const lev = dam.fecha_levante ? new Date(dam.fecha_levante) : null
  const paso = (ico, tit, big, sub, color) => `<div class="e3-paso"><div class="e3-top"><span class="cr-ico">${ico}</span><span class="cr-tit">${tit}</span></div>
      <div class="cr-big" style="${color ? 'color:' + color + ';' : ''}">${big}</div><div class="cr-sub">${sub}</div></div>`
  const pasos = `<div class="e3-grid">
    ${paso('🏛️', 'Numeración', fechaDMY(dam.fecha_dam), esc(dam.modalidad_despacho || 'Modalidad sin indicar'))}
    ${paso('🚦', 'Canal', cn, dam.canal_aduanero === 'verde' ? 'Sin revisión' : dam.canal_aduanero ? 'Con revisión de Aduanas' : 'Indícalo en la DAM', cc)}
    ${paso('⚖️', 'Contingencias', vivos.length ? `${vivos.length} ajuste${vivos.length > 1 ? 's' : ''}` : 'Ninguna', vivos.length ? (pendientes.length ? `${pendientes.length} por pagar` : 'Todas pagadas') : 'No hubo duda razonable ni ajustes', vivos.length ? (pendientes.length ? '#f59e0b' : '') : '')}
    ${paso('✅', 'Levante', lev ? fechaDMY(lev.toISOString().slice(0, 10)) : 'Pendiente', lev ? 'Levante autorizado' : 'Aún sin levante', lev ? '#10b981' : '#f59e0b')}
  </div>`
  const fila = (cols, extra = '') => `<tr style="${extra}">${cols.map((c, i) => `<td style="${i === 0 ? TDL : TD}">${c}</td>`).join('')}</tr>`
  const mas = v => v ? '<span style="color:#f59e0b;">+ $ ' + n2(v) + '</span>' : dash
  const valores = tabla(['Valor y tributos (USD)', 'DAM original', 'Ajustes', 'Total final'], [
      fila(['Valor en aduana (CIF)', '$ ' + n2(cifOrig), mas(adic), '<strong>$ ' + n2(cifOrig + adic) + '</strong>']),
      fila(['Ad valorem', '$ ' + n2(dam.ad_valorem_usd), mas(sum('ad_valorem_usd')), '$ ' + n2(num(dam.ad_valorem_usd) + sum('ad_valorem_usd'))]),
      fila(['IPM', '$ ' + n2(dam.imp_usd), mas(sum('ipm_usd')), '$ ' + n2(num(dam.imp_usd) + sum('ipm_usd'))]),
      fila(['IGV', '$ ' + n2(dam.igv_usd), mas(sum('igv_usd')), '$ ' + n2(num(dam.igv_usd) + sum('igv_usd'))]),
      sum('intereses_usd') ? fila(['Intereses', dash, mas(sum('intereses_usd')), '$ ' + n2(sum('intereses_usd'))]) : '',
      fila(['Total pagado a Aduanas', '$ ' + n2(tribOrig), mas(tribAdic), '$ ' + n2(tribOrig + tribAdic)], TOT)].join(''), '', true)
  const itemCont = (ico, tit, sub, monto, btn = '') => `<div class="e3-item"><span class="dc-ico">${ico}</span><div class="dc-txt"><div class="dc-tit">${tit}</div><div class="dc-sub">${sub}</div></div><div class="e3-monto">${monto}</div>${btn}</div>`
  const items = [
    ...(ajustes || []).map(a => {
      const [et, col] = { pendiente: ['Por pagar', '#f59e0b'], pagada: ['Pagada', '#10b981'], desestimada: ['Desestimada', '#6b7280'] }[a.estado] || ['—', '#6b7280']
      const sub = `${a.numero_notificacion ? 'Notif. ' + esc(a.numero_notificacion) + ' · ' : ''}${a.numero ? 'Liq. ' + esc(a.numero) : '<b>Falta registrar la liquidación de cobranza</b>'}${a.fecha_notificacion ? ' · notificada ' + fechaDMY(a.fecha_notificacion) : ''}${a.fecha_pago ? ' · pagada ' + fechaDMY(a.fecha_pago) : ''}`
      const exp = num(a.fob_unitario_declarado) && num(a.fob_unitario_referencia) ? ` · SUNAT usó $ ${n3(a.fob_unitario_referencia)}/kg en vez de $ ${n3(a.fob_unitario_declarado)}/kg` : ''
      return itemCont('⚖️', `${MOTIVO_E3[a.motivo] || a.motivo} <span class="cr-chip" style="--c:${col};">${et}</span>${a.enviada_costeo ? ' <span class="cr-chip" style="--c:#3b82f6;">En costeo</span>' : ''}`, sub + exp,
        '$ ' + n2(tribA(a)), `<button type="button" class="btn btn-secondary btn-small dc-btn" onclick="window.abrirAjusteValor(${a.id})">👁 Ver</button>`)
    }),
    ...bol.map(c => itemCont('🧪', 'Boletín químico', 'Liquidación de cobranza · registrado en el costeo', 'S/ ' + n2(num(c.monto_pen)), `<button type="button" class="btn btn-secondary btn-small dc-btn" onclick="window.abrirBoletinQuimico(${c.id})">👁 Ver</button>`)),
    !bol.length ? itemCont('🧪', 'Boletín químico', tieneBolAdj ? 'Hay documento adjunto, pero falta registrar la liquidación' : 'Si Aduanas te lo cobró, regístralo aquí', dash, '<button type="button" class="btn btn-primary btn-small dc-btn" onclick="window.abrirBoletinQuimico()">+ Registrar boletín</button>') : '',
    sob.length ? itemCont('⏱️', 'Sobreestadía', 'Registrada en el costeo', '$ ' + n2(sob.reduce((t, c) => t + num(c.monto_usd), 0))) : ''
  ].filter(Boolean).join('')

  // ── Pagos a Aduanas y su voucher + «qué sigue» ──────────────────────────────
  const vc = d.vouchers || { dam: {}, aut: {}, doc: {} }
  const pagos3 = []
  if (dam.estado === 'pagado') pagos3.push({ tit: 'Tributos de la DAM', sub: `Pagado ${fechaDMY(dam.fecha_pago)} · $ ${n2(tribOrig)}${num(dam.percepcion) ? ' + percepción S/ ' + n2(dam.percepcion) : ''}`, ent: 'dam', id: dam.id, n: vc.dam[dam.id] || 0 })
  else pagos3.push({ tit: 'Tributos de la DAM', sub: `Por pagar · $ ${n2(tribOrig)}`, porPagar: true })
  for (const a of vivos) {
    if (a.estado === 'pagada') pagos3.push({ tit: `Ajuste de valor · liquidación ${esc(a.numero || '—')}`, sub: `Pagado ${fechaDMY(a.fecha_pago)} · $ ${n2(tribA(a))}`, ent: 'autoliquidacion', id: a.id, n: vc.aut[a.id] || 0 })
    else if (a.estado === 'pendiente') pagos3.push({ tit: `Ajuste de valor · liquidación ${esc(a.numero || '—')}`, sub: `Por pagar · $ ${n2(tribA(a))}`, porPagar: true })
  }
  for (const c of bol) pagos3.push({ tit: 'Boletín químico', sub: `Pagado · S/ ${n2(num(c.monto_pen))}`, ent: 'documento_importacion', id: c.documento_id, n: vc.doc[c.documento_id] || 0 })
  const sinVoucher = pagos3.filter(p => !p.porPagar && !p.n)
  const filaPago = p => `<div class="e3-item"><span class="dc-ico">💳</span><div class="dc-txt"><div class="dc-tit">${p.tit}</div><div class="dc-sub">${p.sub}</div></div>
      <div class="e3-monto">${p.porPagar ? '<span class="cr-chip" style="--c:#f59e0b;">Por pagar</span>' : p.n ? `<span class="cr-chip" style="--c:#10b981;">✔ Voucher (${p.n})</span>` : '<span class="cr-chip" style="--c:#ef4444;">⏳ Falta voucher</span>'}</div>
      ${p.porPagar ? '' : `<button type="button" class="btn btn-secondary btn-small dc-btn" onclick="window.subirVoucherPago('${p.ent}', ${p.id})">📎 ${p.n ? 'Agregar' : 'Subir voucher'}</button>`}</div>`
  const enCosteoTrib = costos.some(c => c.concepto_codigo === 'ad_valorem' && !/adicional/i.test(c.concepto || ''))
  const ajPorPagar = vivos.find(a => a.estado === 'pendiente')
  const ajSinCosteo = vivos.find(a => a.estado === 'pagada' && !a.enviada_costeo)
  const ajSinLiq = vivos.find(a => !a.numero)
  const siguiente = ajSinLiq ? `Registra la <b>liquidación de cobranza</b> de la notificación ${esc(ajSinLiq.numero_notificacion || '')} (abre el ajuste → Editar → N° de liquidación). Es lo que se paga en el banco.`
    : ajPorPagar ? `Paga la liquidación <b>${esc(ajPorPagar.numero)}</b> en el banco (BCP) y márcala como pagada en «Ajustar valor».`
    : (dam.estado !== 'pagado' ? 'Registra el pago de los tributos de la DAM (fecha de pago y T.C.).'
    : (sinVoucher.length ? `Sube el voucher de: <b>${sinVoucher.map(p => p.tit).join(', ')}</b>.`
    : (!enCosteoTrib && tribOrig > 0 ? 'Envía los tributos de la DAM al costeo (botón «➡ Tributos al costeo» dentro de la DAM).'
    : (ajSinCosteo ? `Envía el ajuste <b>${esc(ajSinCosteo.numero)}</b> al costeo (Ver ajuste → «➡ Enviar al costeo»).`
    : (!lev ? 'Todo registrado: falta el levante autorizado de Aduanas.' : '✅ Etapa 3 completa. Sigue la Etapa 4: facturas de gastos locales y liquidación del agente aduanero.')))))
  const bloquePagos = `<div class="e3-sig">👉 <b>Siguiente paso:</b> ${siguiente}</div>
    <div class="e3-lista"><div class="e3-sub">Pagos a Aduanas y sus vouchers</div>${pagos3.map(filaPago).join('')}</div>`
  const decl = dam.declaracion_confirmada_at ? '<span class="cr-chip" style="--c:#10b981;">Declaración confirmada</span>' : '<span class="cr-chip" style="--c:#6b7280;">Declaración sin confirmar</span>'
  return `<div class="cr-wrap">${head(`<span>· DAM ${esc(dam.numero_dam)}</span>`)}
    ${pasos}
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin:10px 0;">
      <button type="button" class="btn btn-secondary btn-small" onclick="window.editarDAM('${dam.id}')">👁 Ver DAM</button>
      <button type="button" class="btn btn-primary btn-small" onclick="window.abrirAjusteValor()">⚖️ Ajustar valor</button>
      <button type="button" class="btn btn-secondary btn-small" onclick="window.abrirDeclaracionDAM('${dam.id}')">📋 Declaración completa</button>
      <button type="button" class="btn btn-secondary btn-small" onclick="window.abrirBoletinQuimico()">🧪 Boletín químico</button> ${decl}
    </div>
    ${items ? `<div class="e3-lista">${items}</div>` : ''}
    ${bloquePagos}
    ${adic ? `<div class="e3-nota">ℹ️ El valor adicional ($ ${n2(adic)}) solo aumenta la base de tributos de Aduanas: no se le paga al proveedor. Lo que entra al costeo son los tributos adicionales pagados.</div>` : ''}
  </div>`
}

// ─── Render ─────────────────────────────────────────────────────────────────
function _html(d, r) {
  const { carpeta, ci, pi, dam, bls, pagos, docs } = d
  const tc = r.tc
  const cr = calcularCronograma(d)
  const fila = (cols, extra = '') => `<tr style="${extra}">${cols.map((c, i) => `<td style="${i === 0 ? TDL : TD}">${c}</td>`).join('')}</tr>`
  // Cabecera compacta: celdas etiqueta-arriba / valor-abajo en 2 columnas (span=2 ocupa todo el ancho)
  const cab = (k, v, ojo = '', span = 1) => `<div style="grid-column:${span > 1 ? '1 / -1' : 'auto'}; display:flex; align-items:center; gap:8px; padding:6px 12px; border-bottom:1px solid var(--border-color); min-width:0;">
      <div style="flex:1; min-width:0;"><div style="font-size:0.76rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-secondary); line-height:1.2;">${k}</div>
      <div style="font-size:1rem; line-height:1.35;">${v || dash}</div></div>${ojo || ''}</div>`

  const productos = r.art.length
    ? r.art.map(a => `${esc(a.nombre)}${a.partida ? ` <span style="color:var(--text-secondary);">· ${esc(a.partida)}</span>` : ''}`).join('<br>') : ''
  const cabecera = `<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(250px, 1fr)); border:1px solid var(--border-color); border-bottom:0; border-radius:6px; overflow:hidden;">
      ${cab('Proveedor', esc(d.proveedor?.nombre), '', 2)}
      ${cab('Producto y subpartida', productos, '', 2)}
      ${cab('Proforma (PI)', pi ? `${esc(pi.numero_proforma_proveedor || pi.numero)} · ${fechaDMY(pi.fecha)}${pi.incoterm ? ' · ' + esc(pi.incoterm) : ''}` : '', pi ? ojoBtn(`window.verPI(${pi.id})`, 'Ver / editar la Proforma') : '')}
      ${cab('Commercial invoice', ci ? `${esc(ci.invoice_number)} · ${fechaDMY(ci.fecha)}` : '', ci ? ojoBtn('window.verCI()', 'Ver / editar el Commercial Invoice') : '')}
      ${cab('Términos', [ci?.terminos_delivery || pi?.incoterm, ci?.terminos_payment].filter(Boolean).map(esc).join(' · '))}
      ${cab('Embarque y origen', [ci?.puerto_embarque || pi?.puerto_embarque, ci?.pais_origen || pi?.pais_origen].filter(Boolean).map(esc).join(' → '))}
      ${cab('Fecha de embarque', cr?.embFecha ? `${fechaDMY(cr.embFecha)} <span style="color:var(--text-secondary); font-size:0.8rem;">${cr.embReal ? '(B/L)' : '(estimada)'}</span>${bls[0]?.fecha_eta ? ` · ETA ${fechaDMY(bls[0].fecha_eta)}` : ''}` : '')}
      ${cab('Estado', ci?.status ? esc(ci.status) : '')}
      ${cab('DAM', dam ? `${esc(dam.numero_dam)} · ${fechaDMY(dam.fecha_dam)}` : '')}
      ${cab('Canal y BL', [dam?.canal_aduanero ? `<span class="cr-chip" style="--c:${(CANAL_E3[dam.canal_aduanero] || [])[1] || '#6b7280'};">Canal ${(CANAL_E3[dam.canal_aduanero] || [dam.canal_aduanero])[0]}</span>` : '', bls.length ? [...new Set(bls.map(b => esc(b.nro_bill_lading)))].join(' · ') : ''].filter(Boolean).join(' ') )}
    </div>`

  // 1. Descripción
  const totKg = r.art.reduce((t, a) => t + a.kg, 0)
  const s1 = r.art.length ? tabla(
    ['Descripción', 'FOB unit.', 'Cantidad kg', 'FOB $', 'FOB S/ (unit.)'],
    r.art.map(a => fila([esc(a.nombre), n3(a.unit), n2(a.kg), '$ ' + n2(a.fobUsd), a.fobPenUnit != null ? 'S/ ' + n3(a.fobPenUnit) : dash])).join(''),
    fila(['TOTAL', '', n2(totKg), '$ ' + n2(r.fobUsd), ''], TOT), true) : sinRegistros()
  const tit1 = `1.- Descripción${r.estimado && r.art.length ? ' <span style="font-weight:400; color:var(--color-warning,#b45309);">(estimado según la Proforma — aún no hay CI)</span>' : ''}`

  // 2. Valor de aduana + adelanto/balance
  const hayAduana = r.fobUsd > 0
  const pagoProv = t => pagos.filter(p => p.tipo === t && p.estado !== 'observado')
  // Pagos al proveedor: cada uno con SU T.C. (el de su fecha de pago), nunca el de la DAM
  const pagosFilas = [['Adelanto', 'anticipo'], ['Balance', 'saldo']].flatMap(([lbl, t]) => pagoProv(t).map(p => {
    const usdP = p.moneda === 'USD' ? num(p.monto_transferido) : (num(p.tipo_cambio) > 0 ? num(p.monto_transferido) / num(p.tipo_cambio) : 0)
    const penP = p.moneda === 'PEN' ? num(p.monto_transferido) : num(p.monto_transferido) * num(p.tipo_cambio)
    return fila([`${lbl} <span style="color:var(--text-secondary);">${fechaDMY(p.fecha)} · T.C. ${n3(p.tipo_cambio)}</span>`, '$ ' + n2(usdP), 'S/ ' + n2(penP)])
  }))
  const notaTC = !tc && hayAduana ? `<div style="font-size:0.78rem; color:var(--text-secondary); padding:6px 2px;">Soles: se calculan con el T.C. de la DAM (venta SUNAT a la fecha de pago de tributos). Aún no hay DAM registrada.</div>` : ''
  const avisoFob = r.sinDesglose ? `<div style="padding:8px 12px; border-left:3px solid var(--color-warning); background:var(--bg-secondary); font-size:0.85rem;">El CI es ${esc(ci.terminos_delivery)}: el precio ya incluye flete y seguro. Registra ambos (👁 CI → Editar) para obtener el FOB real; mientras tanto FOB = total de la factura.</div>` : ''
  const vivosAj = (d.ajustes || []).filter(a => a.estado !== 'desestimada')
  const adicVal = vivosAj.reduce((t, a) => t + num(a.valor_adicional_usd), 0)
  const cifDam = d.dam ? (num(d.dam.valor_cif) || (num(d.dam.valor_fob) + num(d.dam.flete_maritimo) + num(d.dam.seguro_maritimo))) : 0
  const sol = x => tc ? 'S/ ' + n2(x * tc) : dash
  const MUTE = 'color:var(--text-secondary); font-style:italic;'
  const damCifFilas = d.dam && cifDam ? [
    fila(['Valor declarado en la DAM (CIF)', '$ ' + n2(cifDam), sol(cifDam)]),
    adicVal ? fila([`<span style="${MUTE}">Valor reajustado por Aduanas <small>(+ $ ${n2(adicVal)} solo como base para recalcular tributos · no se paga)</small></span>`, `<span style="${MUTE}">$ ${n2(cifDam + adicVal)}</span>`, `<span style="${MUTE}">${sol(cifDam + adicVal)}</span>`]) : ''
  ].join('') : ''
  const s2 = hayAduana ? avisoFob + tabla(['Valor de aduana (OMC)', 'Dólares', 'Soles' + (tc ? ` (T.C. DAM ${n3(tc)})` : '')], [
      fila(['Fob', '$ ' + n2(r.fobUsd), r.fobPen != null ? 'S/ ' + n2(r.fobPen) : dash]),
      fila(['Flete', r.fleteUsd ? '$ ' + n2(r.fleteUsd) : dash, r.fleteUsd && tc ? 'S/ ' + n2(r.fleteUsd * tc) : dash]),
      fila(['Seguro', r.seguroUsd ? '$ ' + n2(r.seguroUsd) : dash, r.seguroUsd && tc ? 'S/ ' + n2(r.seguroUsd * tc) : dash]),
      fila(['CIF (base imponible)', '$ ' + n2(r.cifUsd), r.cifPen != null ? 'S/ ' + n2(r.cifPen) : dash], TOT),
      damCifFilas,
      pagosFilas.join('')].join(''), '', true) + notaTC : sinRegistros()

  const tribFis = r.trib.filter(t => t.cod !== 'percepcion'), percep = r.trib.find(t => t.cod === 'percepcion')
  const intUsd = vivosAj.reduce((t, a) => t + num(a.intereses_usd), 0)
  const intPen = vivosAj.reduce((t, a) => t + num(a.intereses_usd) * (num(a.tipo_cambio) || tc || 0), 0)
  const masU = x => x ? '<span style="color:#f59e0b;">+ $ ' + n2(x) + '</span>' : dash
  const totOrig = tribFis.reduce((t, x) => t + (x.u - x.adicional), 0)
  const totAdj = tribFis.reduce((t, x) => t + x.adicional, 0) + intUsd
  const totPen = tribFis.reduce((t, x) => t + x.p, 0) + intPen
  const tcsAj = [...new Set(vivosAj.filter(a => a.estado === 'pagada' && num(a.tipo_cambio) > 0 && num(a.tipo_cambio) !== tc).map(a => num(a.tipo_cambio)))]
  const s2b = r.trib.length ? tabla(['Derechos e impuestos', 'DAM original $', 'Ajuste de valor $', 'Total $', 'Soles' + (tc ? ` (T.C. venta · DAM ${n3(tc)}${tcsAj.length ? ' · ajuste ' + tcsAj.map(n3).join('/') : ''})` : '')],
      tribFis.map(t => fila([t.nombre, '$ ' + n2(t.u - t.adicional), masU(t.adicional), '$ ' + n2(t.u), t.p ? 'S/ ' + n2(t.p) : dash])).join('')
      + (intUsd ? fila(['Intereses de la liquidación', dash, masU(intUsd), '$ ' + n2(intUsd), 'S/ ' + n2(intPen)]) : '')
      + fila(['Total pagado a Aduanas', '$ ' + n2(totOrig), masU(totAdj), '$ ' + n2(totOrig + totAdj), 'S/ ' + n2(totPen)], TOT)
      + (percep ? fila(['Percepción IGV <span style="color:var(--text-secondary); font-size:.78rem;">(anticipo, se recupera)</span>', dash, dash, '$ ' + n2(percep.u), percep.p ? 'S/ ' + n2(percep.p) : dash]) : '')) : sinRegistros()

  // 3. Gastos de cadena local
  const docNum = c => { const x = docs[c.documento_id]; return x ? esc([x.serie, x.numero].filter(Boolean).join('-')) || dash : dash }
  const docFecha = c => { const x = docs[c.documento_id]; return x?.fecha_emision ? fechaDMY(x.fecha_emision) : dash }
  // El IGV de cada línea está en la moneda ORIGINAL de la factura (igv_monto): se convierte a $ y a S/ para no mezclar monedas.
  const igvUsd = c => c.moneda === 'PEN' ? num(c.igv_monto) / (num(c.tipo_cambio) || 1) : num(c.igv_monto)
  const igvPen = c => c.moneda === 'PEN' ? num(c.igv_monto) : num(c.igv_monto) * (num(c.tipo_cambio) || 1)
  const orig = c => c.moneda === 'PEN' ? ' <span class="cr-chip" style="--c:#6b7280;" title="Factura emitida en soles">S/</span>' : ''
  const filaGasto = c => fila([esc(c.concepto) + orig(c), docNum(c), docFecha(c), n3(c.tipo_cambio), '$ ' + n2(c.monto_usd), '$ ' + n2(igvUsd(c)), 'S/ ' + n2(c.monto_pen), 'S/ ' + n2(igvPen(c))])
  const sumL = f => r.locales.reduce((t, c) => t + f(c), 0)
  const s3 = r.locales.length ? tabla(['Concepto', 'N° doc.', 'Fecha', 'T.C.', 'Costo $', 'IGV $', 'Costo S/', 'IGV S/'],
      r.locales.map(filaGasto).join(''),
      fila(['TOTAL', '', '', '', '$ ' + n2(sumL(c => num(c.monto_usd))), '$ ' + n2(sumL(igvUsd)), 'S/ ' + n2(sumL(c => num(c.monto_pen))), 'S/ ' + n2(sumL(igvPen))], TOT)) : sinRegistros()

  // 4. Gastos financieros
  const s4 = r.financ.length ? tabla(['Concepto', 'N° doc.', 'Fecha', 'T.C.', 'Costo $', 'Costo S/'],
      r.financ.map(c => fila([esc(c.concepto), docNum(c), docFecha(c), n3(c.tipo_cambio), '$ ' + n2(c.monto_usd), 'S/ ' + n2(c.monto_pen)])).join(''),
      fila(['TOTAL', '', '', '', '$ ' + n2(r.financ.reduce((t, c) => t + num(c.monto_usd), 0)), 'S/ ' + n2(r.financ.reduce((t, c) => t + num(c.monto_pen), 0))], TOT)) : sinRegistros()

  // 5. Factor de distribución
  const hayFactor = r.fdUsd != null && r.art.length && !r.estimado && (r.locales.length || r.financ.length || r.trib.length)
  // Sección 5 como función: el botón contable/comercial solo la vuelve a pintar (sin recargar la hoja)
  const sec5 = () => {
  const cont = _modoFD === 'contable'
  const fdU = cont ? r.fdUsdC : r.fdUsd, fdP = cont ? r.fdPenC : r.fdPen
  const numU = cont ? r.numUsdC : r.numUsd, numP = cont ? r.numPenC : r.numPen
  const det = cont ? r.detCont : r.detCom
  const tip = (mon, txt) => {
    const pen = mon === 'PEN', f = x => (pen ? 'S/ ' : '$ ') + n2(x)
    const filas = [[`2.- Valor de aduana (CIF = FOB + flete + seguro)${pen && tc ? ' · $ ' + n2(r.cifUsd) + ' × ' + n3(tc) : ''}`, pen ? r.cifPen : r.cifUsd], ...det.map(x => [x.nombre, pen ? x.pen : x.usd])]
    const total = filas.reduce((t, x) => t + num(x[1]), 0)
    const html = `<div class="hc-tip-t">Numerador · ${cont ? 'costo contable' : 'costo comercial'} (${pen ? 'soles' : 'dólares'})</div>` +
      filas.map(([n, v]) => `<div class="hc-tip-r"><span>${esc(n)}</span><b>${f(v)}</b></div>`).join('') +
      `<div class="hc-tip-r hc-tip-tot"><span>Numerador</span><b>${f(total)}</b></div>`
    return `<span class="hc-tip" data-tip="${esc(html)}">${txt}</span>`
  }
  const HL = 'background:color-mix(in srgb, #3b82f6 16%, transparent);'
  const th = (t, hl) => `<th style="${TH}${hl ? HL : ''}">${t}</th>`
  const td = (t, hl, first) => `<td style="${first ? TDL : TD}${hl ? HL : ''}">${t}</td>`
  const btnFD = `<span style="display:inline-flex; gap:0; border:1px solid var(--border-color); border-radius:999px; overflow:hidden; font-size:.74rem; font-weight:600;">
      <button type="button" onclick="window.hcModoFD('contable')" title="Factor sin crédito fiscal ni conceptos que no son costo según NIC 2" style="padding:3px 12px; border:0; cursor:pointer; ${cont ? 'background:#3b82f6; color:#fff;' : 'background:transparent; color:var(--text-secondary);'}">Costo contable (NIC 2)</button>
      <button type="button" onclick="window.hcModoFD('comercial')" title="Factor con todo lo que se pagó (costo para gerencia)" style="padding:3px 12px; border:0; cursor:pointer; ${!cont ? 'background:#3b82f6; color:#fff;' : 'background:transparent; color:var(--text-secondary);'}">Costo comercial</button></span>`
  const s5 = hayFactor ? `
    ${tabla([`Factor de distribución · ${cont ? 'costo contable' : 'costo comercial'}`, 'Numerador', 'FOB', 'F.D.'], [
      fila(['S/' + (tc ? ` (T.C. DAM ${n3(tc)})` : ''), numP != null ? tip('PEN', 'S/ ' + n2(numP)) : dash, r.fobPen != null ? 'S/ ' + n2(r.fobPen) : dash, fdP != null ? `<strong>${n3(fdP)}</strong>` : dash]),
      fila(['$', tip('USD', '$ ' + n2(numU)), '$ ' + n2(r.fobUsd), `<strong>${n3(fdU)}</strong>`])].join(''))}
    <div style="height:8px;"></div>
    <div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse;"><thead><tr>
      ${th('Artículo', false).replace('text-align:right;', 'text-align:left;')}${th('Costo FOB unit. S/')}${th('Costo FOB unit. $')}${th('Costo contable S/', cont)}${th('Costo contable $', cont)}${th('Costo comercial S/', !cont)}${th('Costo comercial $', !cont)}
    </tr></thead><tbody>${r.art.map(a => `<tr>${td(esc(a.nombre), false, true)}${td(a.fobPenUnit != null ? n3(a.fobPenUnit) : dash)}${td(n3(a.unit))}
      ${td(a.fobPenUnit != null && r.fdPenC != null ? `<strong>S/ ${n2(a.fobPenUnit * r.fdPenC)}</strong>` : dash, cont)}${td(`<strong>$ ${n2(a.unit * r.fdUsdC)}</strong>`, cont)}
      ${td(a.fobPenUnit != null && r.fdPen != null ? `<strong>S/ ${n2(a.fobPenUnit * r.fdPen)}</strong>` : dash, !cont)}${td(`<strong>$ ${n2(a.unit * r.fdUsd)}</strong>`, !cont)}</tr>`).join('')}</tbody></table></div>
    <div style="font-size:0.78rem; color:var(--text-secondary); padding:6px 2px;">${cont
      ? 'Costo contable (NIC 2): CIF + solo lo que forma parte del costo del inventario (ad valorem, boletín químico, gastos locales sin IGV). No entran IGV, IPM, percepción ni gastos financieros.'
      : 'Costo comercial (gerencia): CIF + todo lo pagado que se considera costo (ad valorem, gastos locales, financieros, IGV, IPM y percepción).'}</div>` : sinRegistros()
    return seccion('6.- Factor de distribución y costo Perú', s5, false, hayFactor ? btnFD : '')
  }
  _sec5 = sec5

  return `<div class="card" style="margin-bottom:16px;">
    <div class="card-header"><h3 class="card-title">Hoja de costeo — Carpeta ${esc(carpeta.numero_carpeta)}</h3>
      <div class="card-header-actions">
        <button class="btn btn-primary btn-small" onclick="window.prepararModalNuevaImportacion()">+ Nueva</button>
        ${ci ? '<button class="btn btn-danger btn-small" onclick="eliminarImportacion()" title="Elimina el Commercial Invoice y sus detalles">🗑️ Eliminar CI</button>' : ''}
      </div></div>
    <div style="padding:0 16px 16px;">
      <div class="hc-top"><div class="hc-cab">${cabecera}
      ${_documentosHtml(d)}</div>${_timelineHtml(d, cr)}</div>
      <div class="hc-grid">
        <div class="hc-formato">
          ${seccion(tit1, s1, true)}
          ${seccion('2.- Valor de aduana (OMC)', s2, true)}
          ${seccion('3.- Tributos de despacho', s2b)}
          ${seccion('4.- Gastos de cadena local', s3)}
          ${seccion('5.- Gastos financieros', s4)}
          <div id="hc-sec5">${sec5()}</div>
        </div>
        <aside class="hc-e3">
          ${_etapa3Html(d)}
          <div id="e4-liq-host"></div>
          <div id="e4-lote-host"></div>
        </aside>
      </div>
    </div></div>`
}

export async function renderHojaCosteo() {
  const host = document.getElementById('hoja-costeo')
  if (!host) return
  try {
    if (!window.carpetaActual) {
      host.innerHTML = `<div class="card" style="margin-bottom:16px;"><div class="card-header"><h3 class="card-title">Hoja de costeo</h3>
        <div class="card-header-actions"><button class="btn btn-primary btn-small" onclick="window.prepararModalNuevaImportacion()">+ Nueva</button></div></div>
        <div style="padding:0 16px 16px;">${sinRegistros()}</div></div>`
      return
    }
    host.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:14px;">Armando la hoja de costeo…</p>'
    const d = await _cargar()
    const cal = d ? _calcular(d) : null
    window.hcUltimo = d ? { d, c: cal } : null
    host.innerHTML = d ? _html(d, cal) : ''
    if (d) { window.renderEtapa4Liquidacion?.(); window.renderCostosLote?.() }
  } catch (e) {
    console.error('renderHojaCosteo:', e)
    host.innerHTML = '<p style="text-align:center; color:var(--color-danger); padding:14px;">No se pudo armar la hoja de costeo (revisa la consola).</p>'
  }
}

window.renderHojaCosteo = renderHojaCosteo
export default { renderHojaCosteo }


// ── Subir el voucher de un pago de Aduanas (adjunto del propio pago) ──────────
window.subirVoucherPago = function (entidad, id) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/pdf,image/*'; inp.multiple = true
  inp.onchange = async () => {
    const files = [...inp.files]; if (!files.length) return
    const user = await getCurrentUser()
    const res = await subirAdjuntos(entidad, id, files.map(file => ({ file, concepto: 'voucher' })), user?.db_id)
    if (res.errores?.length) showToast(res.errores.join(' · '), 'danger')
    else showToast('Voucher guardado', 'success')
    window.renderHojaCosteo?.()
  }
  inp.click()
}
