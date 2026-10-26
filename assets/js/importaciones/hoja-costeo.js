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
import { getItems, getAdjuntos } from '../supabase-data.js'
import { formatNumber, fechaDMY } from '../helpers.js'
import { ojoBtn } from '../shared/ver-editar.js'

const num = v => parseFloat(v) || 0
const n2 = v => formatNumber(num(v), 2)
const n3 = v => formatNumber(num(v), 3)
const n4 = v => formatNumber(num(v), 4)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const dash = '<span style="color:var(--text-secondary);">—</span>'

const CONCEPTOS_TRIB = { ad_valorem: 'Ad Valorem', igv: 'IGV', ipm: 'IPM', percepcion: 'Percepción' }
const esAdic = c => /adicional/i.test(c.concepto || '') || c.concepto_codigo === 'ad_valorem_adic'

const TH = 'padding:6px 10px; background:var(--bg-tertiary, #2a3447); color:var(--text-primary); font-size:0.78rem; text-transform:uppercase; letter-spacing:0.02em; text-align:right;'
const TD = 'padding:6px 10px; border-bottom:1px solid var(--border-color); text-align:right; font-variant-numeric:tabular-nums;'
const TDL = TD.replace('text-align:right;', 'text-align:left;')
const TOT = 'font-weight:700; background:var(--bg-secondary, #1f2937);'

const seccion = (titulo, cuerpo, ajustada = false) => `
  <div style="margin-top:14px;${ajustada ? ' width:fit-content; max-width:100%;' : ''}">
    <div style="font-weight:700; padding:6px 10px; background:var(--color-primary-soft, rgba(59,130,246,.18)); border-radius:6px 6px 0 0; white-space:nowrap;">${titulo}</div>
    ${cuerpo}
  </div>`
const sinRegistros = (cols = 1) => `<div style="padding:12px; text-align:center; color:var(--text-secondary); border:1px dashed var(--border-color); border-top:0; border-radius:0 0 6px 6px;">Sin registros</div>`
const tabla = (head, filas, pie = '', ajustada = false) => `
  <div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse;">
    <thead><tr>${head.map((h, i) => `<th style="${TH}${i === 0 ? 'text-align:left;' : ''}">${h}</th>`).join('')}</tr></thead>
    <tbody>${filas}</tbody>${pie ? `<tfoot>${pie}</tfoot>` : ''}
  </table></div>`

// ─── Datos ──────────────────────────────────────────────────────────────────
async function _cargar() {
  await esperarContextoEmpresa()
  const carpeta = window.carpetaActual || null
  const ci = window.costeoActual?.id ? window.costeoActual : null
  if (!carpeta) return null
  const carpetaId = carpeta.id
  const [pi, costos, pagos, dams, bls, items, prov, adjs] = await Promise.all([
    carpeta.orden_compra_id ? query('orden_compra', { id: carpeta.orden_compra_id }) : [],
    query('importacion_costos', { carpeta_importacion_id: carpetaId }),
    query('importacion_pagos', { carpeta_importacion_id: carpetaId }),
    ci ? query('dams', { importacion_id: ci.id }) : [],
    ci ? query('bill_of_ladings', { importacion_id: ci.id }) : [],
    getItems(),
    carpeta.proveedor_id ? query('contacts', { id: carpeta.proveedor_id }) : [],
    getAdjuntos('carpeta_importacion', carpetaId)
  ])
  const damRow = (dams || [])[0] || null
  const ajustes = damRow ? ((await query('dam_autoliquidaciones', { dam_id: damRow.id })) || []) : []
  const piRow = (pi || [])[0] || null
  // T.C. (soles por USD): SOLO el de la DAM (T.C. venta SUNAT de la fecha de pago de tributos).
  // Sin DAM no se inventa un tipo de cambio: las columnas en soles quedan en "—".
  const tcDam = num((dams || [])[0]?.tipo_cambio)
  const tcInfo = tcDam ? { tc: tcDam, origen: 'DAM', ref: false } : null
  const lineas = ci ? await query('detalle_comercial_invoice', { comercial_invoice_id: ci.id })
    : (piRow ? await query('detalle_orden_compra', { orden_compra_id: piRow.id }) : [])
  const costosOk = (costos || []).filter(c => !c.anulado && !c.castigada)
  const docIds = [...new Set(costosOk.map(c => c.documento_id).filter(Boolean))]
  const docs = {}
  if (docIds.length) for (const d of (await query('documentos_importacion', {})) || []) if (docIds.includes(d.id)) docs[d.id] = d
  const mapaItems = {}; for (const i of items || []) mapaItems[i.id] = i
  return { tcInfo, carpeta, ci, pi: piRow, costos: costosOk, pagos: pagos || [], dam: damRow, ajustes, bls: bls || [], lineas: lineas || [], docs, mapaItems, adjuntos: adjs || [], proveedor: (prov || [])[0] || null, estimado: !ci }
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
    return { nombre: it ? (it.sku ? `(${it.sku}) ${it.nombre}` : it.nombre) : (l.descripcion || '—'), partida: l.partida_arancelaria || it?.partida_arancelaria || '', kg, unit, fobUsd, fobPenUnit: tc ? unit * tc : null }
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
  const fobPen = tc ? fobUsd * tc : null
  const cifPen = tc ? cifUsd * tc : null
  const numUsd = cifUsd + costoUsd
  const numPen = cifPen != null ? cifPen + costoPen : null
  const fdUsd = fobUsd > 0 ? numUsd / fobUsd : null
  const fdPen = fobPen > 0 && numPen != null ? numPen / fobPen : null
  const sinDesglose = !!ci && kFob === 1 && ['CIF', 'CFR', 'CIP', 'CPT', 'DAP', 'DDP'].includes(String(ci.terminos_delivery || '').toUpperCase()) && !fleteUsd && !seguroUsd
  return { tc, kFob, sinDesglose, art, fobUsd, fobPen, fleteUsd, seguroUsd, cifUsd, cifPen, trib, locales, financ, numUsd, numPen, fdUsd, fdPen, estimado }
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


// ─── Documentos de la carpeta (lista de control + botones de registro) ───────
window.abrirNuevaDAM = async function () {
  if (!window.costeoActual?.id) { window.showToast?.('Esta carpeta aún no tiene Commercial Invoice', 'warning'); return }
  window.openModal('modal-nuevo-dam')
  await window.cargarImportacionesEnSelect?.('newDAMImportacionSelector')
  const sel = document.getElementById('newDAMImportacionSelector'); if (sel) sel.value = String(window.costeoActual.id)
}

function _documentosHtml(d) {
  const { ci, pi, bls, dam } = d
  const adj = c => (d.adjuntos || []).filter(a => a.concepto === c).length
  const bl = (bls || [])[0]
  const adjFila = (ico, tit, concepto) => {
    const n = adj(concepto)
    return { ico, tit, ok: n > 0, sub: n ? `${n} archivo${n > 1 ? 's' : ''} adjunto${n > 1 ? 's' : ''}` : 'Sin adjuntar', btn: `<button type="button" class="btn btn-secondary btn-small dc-btn" onclick="window.abrirAdjuntosCarpeta()">📎 ${n ? 'Ver / agregar' : 'Adjuntar'}</button>` }
  }
  const filas = [
    { ico: '📄', tit: 'Proforma (PI)', ok: !!pi, sub: pi ? `${esc(pi.numero_proforma_proveedor || pi.numero)} · ${fechaDMY(pi.fecha)}` : 'Sin proforma', btn: pi ? `<button type="button" class="btn btn-secondary btn-small dc-btn" onclick="window.verPI(${pi.id})">👁 Ver</button>` : '' },
    { ico: '🧾', tit: 'Commercial Invoice', ok: !!ci, sub: ci ? `${esc(ci.invoice_number)} · ${fechaDMY(ci.fecha)}` : 'Aún no registrado', btn: ci ? `<button type="button" class="btn btn-secondary btn-small dc-btn" onclick="window.verCI()">👁 Ver</button>` : '' },
    adjFila('📦', 'Packing list', 'packing'),
    { ico: '🚢', tit: 'Bill of Lading', ok: !!bl, sub: bl ? `${esc(bl.nro_bill_lading)} · ${bl.fecha ? 'embarque ' + fechaDMY(bl.fecha) : 'sin fecha'}${bl.fecha_eta ? ' · ETA ' + fechaDMY(bl.fecha_eta) : ''}${bls.length > 1 ? ` · +${bls.length - 1} más` : ''}` : (ci ? 'Sin registrar' : 'Requiere el CI'),
      btn: bl ? `<button type="button" class="btn btn-secondary btn-small dc-btn" onclick="window.abrirBL(${bl.id})">👁 Ver</button><a class="btn btn-secondary btn-small dc-btn" href="${esc(window.urlRastreoBL?.(bl) || '#')}" target="_blank" rel="noopener">🔎 Rastrear</a>`
        : (ci ? `<button type="button" class="btn btn-primary btn-small dc-btn" onclick="window.abrirBL()">+ Registrar</button>` : '') },
    adjFila('🛡️', 'Seguro (póliza)', 'poliza'),
    adjFila('🌏', 'Certificado de origen', 'certificado_origen'),
    adjFila('🧪', 'Ficha técnica', 'ficha_tecnica'),
    { ico: '🏛️', tit: 'DAM', ok: !!dam, sub: dam ? `${esc(dam.numero_dam)} · ${fechaDMY(dam.fecha_dam)}` : (ci ? 'Sin registrar' : 'Requiere el CI'),
      btn: dam ? `<button type="button" class="btn btn-secondary btn-small dc-btn" onclick="window.editarDAM('${dam.id}')">👁 Ver</button>` : (ci ? `<button type="button" class="btn btn-primary btn-small dc-btn" onclick="window.abrirNuevaDAM()">+ Registrar</button>` : '') }
  ]
  const hechos = filas.filter(f => f.ok).length
  return `<div class="cr-wrap"><div class="cr-head">Documentos de la carpeta <span>· ${hechos} de ${filas.length} registrados</span></div>
    <div class="dc-grid">${filas.map(f => `<div class="dc-item ${f.ok ? 'ok' : ''}"><span class="dc-ico">${f.ico}</span>
      <div class="dc-txt"><div class="dc-tit">${f.tit} <span class="dc-estado">${f.ok ? '✔' : 'Pendiente'}</span></div><div class="dc-sub">${f.sub}</div></div>
      <div class="dc-acc">${f.btn || ''}</div></div>`).join('')}</div></div>`
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
      const sub = `${a.numero_notificacion ? 'Notif. ' + esc(a.numero_notificacion) + ' · ' : ''}Liq. ${esc(a.numero)}${a.fecha_notificacion ? ' · notificada ' + fechaDMY(a.fecha_notificacion) : ''}${a.fecha_pago ? ' · pagada ' + fechaDMY(a.fecha_pago) : ''}`
      const exp = num(a.fob_unitario_declarado) && num(a.fob_unitario_referencia) ? ` · SUNAT usó $ ${n3(a.fob_unitario_referencia)}/kg en vez de $ ${n3(a.fob_unitario_declarado)}/kg` : ''
      return itemCont('⚖️', `${MOTIVO_E3[a.motivo] || a.motivo} <span class="cr-chip" style="--c:${col};">${et}</span>${a.enviada_costeo ? ' <span class="cr-chip" style="--c:#3b82f6;">En costeo</span>' : ''}`, sub + exp,
        '$ ' + n2(tribA(a)), `<button type="button" class="btn btn-secondary btn-small dc-btn" onclick="window.abrirAjusteValor(${a.id})">👁 Ver</button>`)
    }),
    bol.length ? itemCont('🧪', 'Boletín químico', 'Registrado en el costeo', 'S/ ' + n2(bol.reduce((t, c) => t + num(c.monto_pen), 0))) : (tieneBolAdj ? itemCont('🧪', 'Boletín químico', 'Hay documento adjunto, pero falta registrar su gasto en Costos', dash, '<button type="button" class="btn btn-primary btn-small dc-btn" onclick="window.abrirModalLineaCosto?.()">+ Registrar gasto</button>') : ''),
    sob.length ? itemCont('⏱️', 'Sobreestadía', 'Registrada en el costeo', '$ ' + n2(sob.reduce((t, c) => t + num(c.monto_usd), 0))) : ''
  ].filter(Boolean).join('')
  const decl = dam.declaracion_confirmada_at ? '<span class="cr-chip" style="--c:#10b981;">Declaración confirmada</span>' : '<span class="cr-chip" style="--c:#6b7280;">Declaración sin confirmar</span>'
  return `<div class="cr-wrap">${head(`<span>· DAM ${esc(dam.numero_dam)}</span>`)}
    ${pasos}
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin:10px 0;">
      <button type="button" class="btn btn-secondary btn-small" onclick="window.editarDAM('${dam.id}')">👁 Ver DAM</button>
      <button type="button" class="btn btn-primary btn-small" onclick="window.abrirAjusteValor()">⚖️ Ajustar valor</button>
      <button type="button" class="btn btn-secondary btn-small" onclick="window.abrirDeclaracionDAM('${dam.id}')">📋 Declaración completa</button> ${decl}
    </div>
    ${valores}
    ${items ? `<div class="e3-lista">${items}</div>` : ''}
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
  const cab = (k, v, ojo = '', span = 1) => `<div style="grid-column:span ${span}; display:flex; align-items:center; gap:8px; padding:6px 12px; border-bottom:1px solid var(--border-color); min-width:0;">
      <div style="flex:1; min-width:0;"><div style="font-size:0.76rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-secondary); line-height:1.2;">${k}</div>
      <div style="font-size:1rem; line-height:1.35;">${v || dash}</div></div>${ojo || ''}</div>`

  const productos = r.art.length
    ? r.art.map(a => `${esc(a.nombre)}${a.partida ? ` <span style="color:var(--text-secondary);">· ${esc(a.partida)}</span>` : ''}`).join('<br>') : ''
  const cabecera = `<div style="display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); border:1px solid var(--border-color); border-bottom:0; border-radius:6px; overflow:hidden;">
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
  const s2 = hayAduana ? avisoFob + tabla(['Valor de aduana (OMC)', 'Dólares', 'Soles' + (tc ? ` (T.C. DAM ${n3(tc)})` : '')], [
      fila(['Fob', '$ ' + n2(r.fobUsd), r.fobPen != null ? 'S/ ' + n2(r.fobPen) : dash]),
      fila(['Flete', r.fleteUsd ? '$ ' + n2(r.fleteUsd) : dash, r.fleteUsd && tc ? 'S/ ' + n2(r.fleteUsd * tc) : dash]),
      fila(['Seguro', r.seguroUsd ? '$ ' + n2(r.seguroUsd) : dash, r.seguroUsd && tc ? 'S/ ' + n2(r.seguroUsd * tc) : dash]),
      fila(['CIF (base imponible)', '$ ' + n2(r.cifUsd), r.cifPen != null ? 'S/ ' + n2(r.cifPen) : dash], TOT),
      pagosFilas.join('')].join(''), '', true) + notaTC : sinRegistros()

  const s2b = r.trib.length ? tabla(['Derechos e impuestos', 'Dólares', 'Soles'],
      r.trib.map(t => fila([t.nombre + (t.adicional ? ` <span style="color:var(--text-secondary); font-size:.78rem;">(incluye $ ${n2(t.adicional)} de ajuste de valor)</span>` : ''), '$ ' + n2(t.u), t.p ? 'S/ ' + n2(t.p) : dash])).join('')) : sinRegistros()

  // 3. Gastos de cadena local
  const docNum = c => { const x = docs[c.documento_id]; return x ? esc([x.serie, x.numero].filter(Boolean).join('-')) || dash : dash }
  const docFecha = c => { const x = docs[c.documento_id]; return x?.fecha_emision ? fechaDMY(x.fecha_emision) : dash }
  const filaGasto = c => fila([esc(c.concepto), docNum(c), '$ ' + n2(c.monto_usd), n2(c.igv_monto), docFecha(c), n3(c.tipo_cambio), 'S/ ' + n2(c.monto_pen)])
  const s3 = r.locales.length ? tabla(['Concepto', 'N° doc.', 'Costo $', 'IGV', 'Fecha', 'T.C.', 'Costo S/'],
      r.locales.map(filaGasto).join(''),
      fila(['TOTAL', '', '$ ' + n2(r.locales.reduce((t, c) => t + num(c.monto_usd), 0)), n2(r.locales.reduce((t, c) => t + num(c.igv_monto), 0)), '', '', 'S/ ' + n2(r.locales.reduce((t, c) => t + num(c.monto_pen), 0))], TOT)) : sinRegistros()

  // 4. Gastos financieros
  const s4 = r.financ.length ? tabla(['Concepto', 'N° doc.', 'Costo $', 'Costo S/'],
      r.financ.map(c => fila([esc(c.concepto), docNum(c), '$ ' + n2(c.monto_usd), 'S/ ' + n2(c.monto_pen)])).join(''),
      fila(['TOTAL', '', '$ ' + n2(r.financ.reduce((t, c) => t + num(c.monto_usd), 0)), 'S/ ' + n2(r.financ.reduce((t, c) => t + num(c.monto_pen), 0))], TOT)) : sinRegistros()

  // 5. Factor de distribución
  const hayFactor = r.fdUsd != null && r.art.length && !r.estimado && (r.locales.length || r.financ.length || r.trib.length)
  const s5 = hayFactor ? `
    ${tabla(['Factor de distribución', 'Numerador', 'FOB', 'F.D.'], [
      fila(['S/', r.numPen != null ? 'S/ ' + n2(r.numPen) : dash, r.fobPen != null ? 'S/ ' + n2(r.fobPen) : dash, r.fdPen != null ? `<strong>${n3(r.fdPen)}</strong>` : dash]),
      fila(['$', '$ ' + n2(r.numUsd), '$ ' + n2(r.fobUsd), `<strong>${n3(r.fdUsd)}</strong>`])].join(''))}
    <div style="height:8px;"></div>
    ${tabla(['Artículo', 'FOB unit. S/', 'Factor', 'Costo Perú S/', 'FOB unit. $', 'Costo Perú $'], r.art.map(a => fila([
      esc(a.nombre), a.fobPenUnit != null ? n3(a.fobPenUnit) : dash, r.fdPen != null ? n3(r.fdPen) : dash,
      a.fobPenUnit != null && r.fdPen != null ? `<strong>S/ ${n2(a.fobPenUnit * r.fdPen)}</strong>` : dash,
      n3(a.unit), `<strong>$ ${n2(a.unit * r.fdUsd)}</strong>`])).join(''))}
    <div style="font-size:0.78rem; color:var(--text-secondary); padding:6px 2px;">Numerador = CIF + costos que entran al costo (ad valorem, gastos locales sin IGV, financieros). IGV, IPM y percepción no entran.</div>` : sinRegistros()

  return `<div class="card" style="margin-bottom:16px;">
    <div class="card-header"><h3 class="card-title">Hoja de costeo — Carpeta ${esc(carpeta.numero_carpeta)}</h3>
      <div class="card-header-actions">
        <button class="btn btn-primary btn-small" onclick="window.prepararModalNuevaImportacion()">+ Nueva</button>
        ${ci ? '<button class="btn btn-danger btn-small" onclick="eliminarImportacion()" title="Elimina el Commercial Invoice y sus detalles">🗑️ Eliminar CI</button>' : ''}
      </div></div>
    <div style="padding:0 16px 16px;">
      ${cabecera}
      ${_cronogramaHtml(cr)}
      ${_documentosHtml(d)}
      ${_etapa3Html(d)}
      ${seccion(tit1, s1, true)}
      ${seccion('2.- Valor de aduana (OMC)', s2, true)}
      ${seccion('Tributos de despacho', s2b)}
      ${seccion('3.- Gastos de cadena local', s3)}
      ${seccion('4.- Gastos financieros', s4)}
      ${seccion('5.- Factor de distribución y costo Perú', s5)}
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
    host.innerHTML = d ? _html(d, _calcular(d)) : ''
  } catch (e) {
    console.error('renderHojaCosteo:', e)
    host.innerHTML = '<p style="text-align:center; color:var(--color-danger); padding:14px;">No se pudo armar la hoja de costeo (revisa la consola).</p>'
  }
}

window.renderHojaCosteo = renderHojaCosteo
export default { renderHojaCosteo }
