// ============================================================================
// observaciones-carpeta.js — Conclusiones y alertas de la carpeta (motor de reglas)
// Todo se CALCULA en vivo desde los datos registrados (d = datos de la hoja):
// cada importe/nombre es un enlace (.ob-ref) que abre el modal donde se origina.
// carpeta_observaciones guarda solo: notas manuales y el estado «resuelta» por regla (codigo).
// ============================================================================
import { supabase, esperarContextoEmpresa } from '../supabase-client.js'
import { showToast } from '../helpers.js'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const num = v => Number(v) || 0
const SEV = {
  critica: ['🔴', 'Crítica', '#ef4444'], alerta: ['🟠', 'Revisar', '#f59e0b'],
  info: ['🔵', 'Nota', '#3b82f6'], ok: ['🟢', 'Registrado', '#10b981']
}
const ORDEN = ['critica', 'alerta', 'info', 'ok']
let _filas = [], _carpetaId = null, _notaAbierta = false

const fmt = (v, d = 2) => num(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const usd = v => `US$ ${fmt(v)}`
const pen = v => `S/ ${fmt(v)}`
const kg = v => `${fmt(v, 1)} kg`
const fch = s => s ? String(s).slice(0, 10).split('-').reverse().join('/') : '—'
const dias = (a, b) => Math.round((new Date(String(b).slice(0, 10)) - new Date(String(a).slice(0, 10))) / 86400000)
/** Enlace clicable al origen del dato. js = código que abre el modal. */
const ref = (txt, js, tit) => `<a class="ob-ref" href="javascript:void(0)" title="${esc(tit || 'Ver el origen de este dato')}" onclick="${js}">${esc(txt)}</a>`

export async function cargarObservaciones(carpetaId) {
  _carpetaId = carpetaId; _filas = []
  if (!carpetaId) return
  try {
    await esperarContextoEmpresa?.()
    const { data, error } = await supabase.from('carpeta_observaciones').select('*').eq('carpeta_id', carpetaId).order('id')
    if (!error) _filas = data || []
  } catch (e) { /* sin tabla: las reglas igual se calculan, solo no se guarda «resuelta» */ }
}

// ── Reglas ──────────────────────────────────────────────────────────────────
function _reglas(d) {
  const R = []
  const add = (codigo, sev, cat, tit, det) => R.push({ codigo, sev, cat, tit, det })
  if (!d) return R
  const { dam, ci, pi, bls = [], pagos = [], apps = [], costos = [], lotesC = [], guias = [], liq, abonosAg = [], lineas = [] } = d
  const bl0 = bls[0]
  const rDAM = t => dam ? ref(t, `window.editarDAM('${dam.id}')`, 'Abrir la DAM') : esc(t)
  const rBL = t => bl0 ? ref(t, `window.abrirBL(${bl0.id})`, 'Abrir el B/L') : esc(t)
  const rCI = t => ref(t, 'window.verCI()', 'Abrir el Commercial Invoice')
  const rPagos = t => ref(t, 'window.abrirPagosProveedor()', 'Abrir pagos al proveedor')
  const rAd = t => ref(t, 'window.abrirAdjuntosCarpeta()', 'Documentos de la carpeta')
  const rLiq = t => ref(t, 'window.abrirLiquidacionAgente()', 'Abrir liquidación del agente')
  const rGuia = t => ref(t, 'window.abrirGuiaCarpeta()', 'Abrir guía de ingreso')
  const rCosto = (c, t) => ref(t, `window.verLineaCosto(${c.id})`, 'Abrir la línea de costo')
  const hoy = new Date().toISOString().slice(0, 10)

  // ---- ALERTAS ----
  if (dam) {
    // Plazo de pago de tributos
    if (dam.ultimo_dia_pago) {
      const fp = dam.fecha_pago ? String(dam.fecha_pago).slice(0, 10) : null
      const n = dias(dam.ultimo_dia_pago, fp || hoy)
      if (fp && n > 0) add('dam_pago_tarde', 'alerta', 'Aduanas', 'Tributos pagados fuera de plazo',
        `Último día de pago ${rDAM(fch(dam.ultimo_dia_pago))}; cancelación ${rPagos(fch(fp))} (${n} día${n > 1 ? 's' : ''} después). Verifica intereses o multa en la liquidación SUNAT.`)
      else if (!fp && n > 0) add('dam_pago_vencido', 'critica', 'Aduanas', 'Tributos vencidos sin pagar',
        `El plazo venció el ${rDAM(fch(dam.ultimo_dia_pago))} (${n} días). Registra el pago o revisa intereses.`)
      else if (!fp && n >= -3) add('dam_pago_proximo', 'alerta', 'Aduanas', 'Tributos por vencer',
        `Último día de pago ${rDAM(fch(dam.ultimo_dia_pago))} (${-n === 0 ? 'hoy' : `en ${-n} día${-n > 1 ? 's' : ''}`}).`)
    } else add('dam_sin_plazo', 'info', 'Aduanas', 'Falta el último día de pago de tributos',
      `Regístralo en la ${rDAM('DAM ' + (dam.numero_dam || ''))} para vigilar el vencimiento.`)

    const ob = window.hcObligacion?.('dam_tributos', dam.id)
    if (ob && ob.estado !== 'pagado') add('dam_trib_pend', 'alerta', 'Pagos', 'Tributos de la DAM pendientes de pago',
      `Tributos ${rDAM(usd(num(dam.ad_valorem_usd) + num(dam.imp_usd) + num(dam.igv_usd)))} sin pago aplicado. ${ref('Pagar', `window.pagarDocumento('dam_tributos','${dam.id}')`, 'Registrar el pago')}`)

    if (!dam.fecha_levante) add('dam_sin_levante', 'alerta', 'Aduanas', 'Levante sin fecha',
      `Falta la fecha de levante en la ${rDAM('DAM')}. Sin ella no se aplica el costo al lote.`)
    if (!num(dam.tipo_cambio)) add('dam_sin_tc', 'alerta', 'Aduanas', 'DAM sin tipo de cambio', `Registra el T.C. SUNAT en la ${rDAM('DAM')}.`)

    if (dam.tlc_aplica && num(dam.ad_valorem_usd) > 0) add('dam_tlc_adv', 'critica', 'Aduanas', 'Ad valorem liquidado pese a TLC',
      `La ${rDAM('DAM')} marca TLC aplicable pero liquida ad valorem ${rDAM(usd(dam.ad_valorem_usd))}. Revisa el certificado de origen y solicita devolución si corresponde.`)

    const cif = num(dam.valor_fob) + num(dam.flete_maritimo) + num(dam.seguro_maritimo)
    if (num(dam.valor_cif) && Math.abs(cif - num(dam.valor_cif)) > 0.5) add('dam_cif_no_suma', 'critica', 'Aduanas', 'CIF de la DAM no suma',
      `FOB ${rDAM(usd(dam.valor_fob))} + flete ${usd(dam.flete_maritimo)} + seguro ${usd(dam.seguro_maritimo)} = ${usd(cif)} ≠ CIF ${rDAM(usd(dam.valor_cif))}.`)
    if (ci && num(dam.flete_maritimo) + num(dam.seguro_maritimo) > 0 && Math.abs(num(dam.valor_fob) - num(ci.valor_total_final_ci)) < 1)
      add('dam_fob_igual_ci', 'critica', 'Aduanas', 'Posible doble conteo de flete/seguro en el valor en aduana',
        `El FOB de la ${rDAM('DAM')} (${rDAM(usd(dam.valor_fob))}) es igual al total del ${rCI('CI ' + (ci.invoice_number || ''))} (${rCI(usd(ci.valor_total_final_ci))}) y además suma flete ${usd(dam.flete_maritimo)} y seguro ${usd(dam.seguro_maritimo)}. Si el CI ya los incluye, se pagaron tributos de más: confirma con el agente.`)

    const pb = bls.reduce((s, b) => s + num(b.peso_bruto), 0)
    if (pb && num(dam.peso_bruto_kg) && Math.abs(pb - num(dam.peso_bruto_kg)) / pb > 0.005) add('peso_bl_dam', 'alerta', 'Documentos', 'Peso bruto distinto entre B/L y DAM',
      `B/L ${rBL(kg(pb))} vs DAM ${rDAM(kg(dam.peso_bruto_kg))} (diferencia ${kg(Math.abs(pb - num(dam.peso_bruto_kg)))}).`)

    if (dam.nave && bl0?.nave_viaje && String(dam.nave).trim().toLowerCase() !== String(bl0.nave_viaje).trim().toLowerCase())
      add('nave_bl_dam', 'alerta', 'Documentos', 'Nave distinta entre B/L y DAM', `B/L: ${rBL(bl0.nave_viaje)} · DAM: ${rDAM(dam.nave)}.`)

    const pts = [['PI', pi?.puerto_embarque], ['B/L', bl0?.puerto_embarque], ['DAM', dam.puerto_origen]].filter(p => p[1] && String(p[1]).trim())
    if (new Set(pts.map(p => String(p[1]).trim().toLowerCase())).size > 1) add('puerto_origen', 'alerta', 'Documentos', 'Puerto de origen no coincide',
      pts.map(p => `${p[0]}: ${p[0] === 'B/L' ? rBL(p[1]) : p[0] === 'DAM' ? rDAM(p[1]) : esc(p[1])}`).join(' · '))
  }

  if (bl0 && bl0.fecha_eta && bl0.fecha_llegada && dias(bl0.fecha_eta, bl0.fecha_llegada) > 3)
    add('eta_retraso', 'info', 'Embarque', 'Llegada posterior a la ETA', `ETA ${rBL(fch(bl0.fecha_eta))} · llegada ${rBL(fch(bl0.fecha_llegada))} (${dias(bl0.fecha_eta, bl0.fecha_llegada)} días).`)

  // Anticipo vs % de la PI
  const antic = apps.filter(a => a.doc_tipo === 'oc_anticipo').reduce((s, a) => s + num(a.monto_doc), 0)
  const topeAnt = num(pi?.total_oc) * num(pi?.anticipo_porcentaje) / 100
  if (antic && topeAnt && antic - topeAnt > 1) add('anticipo_excede', 'info', 'Pagos', 'Anticipo mayor al % de la PI',
    `Pagado ${rPagos(usd(antic))} vs ${fmt(pi.anticipo_porcentaje, 0)}% de la PI = ${usd(topeAnt)} (+${usd(antic - topeAnt)}).`)

  // Incoterm / flete
  if (pi?.incoterm && /fob/i.test(pi.incoterm) && bl0 && (num(bl0.flete_prepago_usd) > 0 || num(bl0.flete_prepago_cny) > 0))
    add('incoterm_flete', 'info', 'Documentos', 'Incoterm FOB con flete prepagado en el B/L',
      `La PI dice ${esc(pi.incoterm)} pero el ${rBL('B/L')} registra flete prepagado ${rBL(usd(bl0.flete_prepago_usd))}. Aclara el incoterm real con el proveedor.`)

  // Costos: intereses/recargos y provisionales
  for (const c of costos) {
    if (/inter|mora|recargo|late/i.test(c.concepto || c.concepto_codigo || '')) add('costo_int_' + c.id, 'info', 'Costos', 'Recargo / interés cargado',
      `${rCosto(c, c.concepto || 'Interés')}: ${rCosto(c, c.moneda === 'PEN' ? pen(c.monto_moneda) : usd(c.monto_moneda))}.`)
    if (c.es_provisional) add('costo_prov_' + c.id, 'info', 'Costos', 'Costo provisional sin sustentar',
      `${rCosto(c, c.concepto || 'Costo')} por ${rCosto(c, c.moneda === 'PEN' ? pen(c.monto_moneda) : usd(c.monto_moneda))} sigue como provisional.`)
  }

  // Lotes / guía / liquidación
  if (!guias.length) add('sin_guia', 'alerta', 'Ingreso', 'Sin guía de ingreso vinculada', `Vincula la guía de ingreso: ${rGuia('abrir guías')}.`)
  const sinCosto = lotesC.filter(l => num(l.costo_real) <= 0)
  if (lotesC.length && sinCosto.length) add('lotes_sin_costo', 'alerta', 'Costos', 'Lotes sin costo real aplicado',
    `${ref(sinCosto.length + ' de ' + lotesC.length + ' lotes', 'window.abrirCostosLote()', 'Revisar y aplicar costos al lote')} siguen con costo provisional.`)
  if (!liq && costos.some(c => c.liquidacion_agente_id == null && /agente|aduana/i.test(c.grupo || c.concepto || ''))) add('sin_liq', 'info', 'Costos', 'Sin liquidación del agente', `Registra la ${rLiq('liquidación del agente')}.`)

  // ---- CONCLUSIONES (lo registrado) ----
  if (ci) add('ok_ci', 'ok', 'Registro', 'Compra y CI',
    `${rCI('CI ' + (ci.invoice_number || ''))} · ${lineas.length} línea${lineas.length === 1 ? '' : 's'} · ${rCI(kg(ci.cantidad_total_neto))} · total ${rCI(usd(ci.valor_total_final_ci))}.`)
  if (bl0) add('ok_bl', 'ok', 'Registro', 'Embarque (B/L)',
    `${rBL('B/L ' + (bl0.nro_bill_lading || ''))}${bl0.naviera ? ' (' + esc(bl0.naviera) + ')' : ''} · ${bl0.bultos ? rBL(bl0.bultos + ' bultos') + ' · ' : ''}${rBL(kg(bl0.peso_bruto))} brutos · embarque ${rBL(fch(bl0.fecha))} · llegada ${rBL(fch(bl0.fecha_llegada))}.`)
  if (dam) add('ok_dam', 'ok', 'Registro', 'DAM',
    `${rDAM('DAM ' + (dam.numero_dam || ''))}${dam.canal_aduanero ? ' · canal ' + esc(dam.canal_aduanero) : ''} · numerada ${rDAM(fch(dam.fecha_dam))} · CIF ${rDAM(usd(dam.valor_cif))} · tributos ${rDAM(usd(num(dam.ad_valorem_usd) + num(dam.imp_usd) + num(dam.igv_usd)))}${dam.fecha_pago ? ' pagados el ' + rPagos(fch(dam.fecha_pago)) : ''}${num(dam.percepcion) ? ' · percepción ' + rDAM(pen(dam.percepcion)) : ''}.`)
  const porTipo = t => apps.filter(a => a.doc_tipo === t).reduce((s, a) => s + num(a.monto_doc), 0)
  if (porTipo('oc_anticipo') || porTipo('ci_saldo')) add('ok_pagos', 'ok', 'Registro', 'Pagos al proveedor',
    `Anticipo ${rPagos(usd(porTipo('oc_anticipo')))} + saldo ${rPagos(usd(porTipo('ci_saldo')))} = ${rPagos(usd(porTipo('oc_anticipo') + porTipo('ci_saldo')))}. ${pagos.filter(p => p.es_historico).length ? 'Pagos históricos (sin movimiento en Bancos).' : ''}`)
  if (liq) add('ok_liq', 'ok', 'Registro', 'Liquidación del agente',
    `${rLiq('Liquidación ' + (liq.numero || ''))} · ${abonosAg.length} abono${abonosAg.length === 1 ? '' : 's'} registrados · estado ${esc(liq.estado || '—')}.`)
  if (guias.length) add('ok_guia', 'ok', 'Registro', 'Guía de ingreso', `${rGuia('Guía ' + (guias[0].numero_guia || ''))} del ${rGuia(fch(guias[0].fecha_guia))}.`)
  if (lotesC.length) add('ok_lotes', 'ok', 'Registro', 'Lotes y costo',
    `${ref(lotesC.length + ' lotes', 'window.abrirCostosLote()', 'Costo por lote')} · ${lotesC.length - sinCosto.length} con costo real aplicado.`)
  return R
}

function _todas(d) {
  const estado = {}; for (const f of _filas) if (f.codigo) estado[f.codigo] = f
  const reglas = _reglas(d).map(r => ({ ...r, resuelta: !!estado[r.codigo]?.resuelta, key: 'r:' + r.codigo }))
  const notas = _filas.filter(f => !f.codigo && f.origen === 'manual').map(f => ({ key: 'n:' + f.id, id: f.id, sev: f.severidad, cat: f.categoria || 'Nota', tit: esc(f.titulo), det: esc(f.detalle || ''), resuelta: f.resuelta, nota: true }))
  return [...reglas, ...notas]
}

/** HTML del bloque. d = datos de la hoja (window.hcUltimo.d). */
export function observacionesHtml(d) {
  const todas = _todas(d || window.hcUltimo?.d)
  const vivas = todas.filter(f => !f.resuelta)
  const cuenta = s => vivas.filter(f => f.sev === s && s !== 'ok').length
  const chips = ORDEN.filter(s => s !== 'ok').map(s => cuenta(s) ? `<span class="ob-chip" style="--c:${SEV[s][2]}">${SEV[s][0]} ${cuenta(s)} ${SEV[s][1]}</span>` : '').join('')
  const fila = f => `<div class="ob-fila ${f.resuelta ? 'ob-resuelta' : ''}" style="--c:${(SEV[f.sev] || SEV.info)[2]}">
      <div class="ob-ico">${(SEV[f.sev] || SEV.info)[0]}</div>
      <div class="ob-cuerpo"><div class="ob-tit">${f.tit} ${f.cat ? `<small>${esc(f.cat)}</small>` : ''}</div><div class="ob-det">${f.det || ''}</div></div>
      <div class="ob-acc">${f.sev === 'ok' ? '' : `<button type="button" class="btn btn-secondary btn-small" title="${f.resuelta ? 'Reabrir' : 'Marcar como revisada'}" onclick="${f.nota ? `window.obResolverNota(${f.id}, ${!f.resuelta})` : `window.obResolverRegla('${f.key.slice(2)}', ${!f.resuelta})`}">${f.resuelta ? '↩' : '✓'}</button>`}</div></div>`
  const prior = todas.filter(f => f.sev !== 'ok'), oks = todas.filter(f => f.sev === 'ok')
  const sec = (tit, arr, cerrado) => arr.length ? `<details class="ob-sec" ${cerrado ? '' : 'open'}><summary>${tit} <small>(${arr.length})</small></summary>${arr.map(fila).join('')}</details>` : ''
  const form = _notaAbierta ? `<div class="ob-nota-form">
      <input id="obNotaTit" class="form-control" placeholder="Título de la nota">
      <input id="obNotaDet" class="form-control" placeholder="Detalle (opcional)">
      <select id="obNotaSev" class="form-control"><option value="info">🔵 Nota</option><option value="alerta">🟠 Revisar</option><option value="critica">🔴 Crítica</option></select>
      <button type="button" class="btn btn-primary btn-small" onclick="window.obGuardarNota()">Guardar</button>
      <button type="button" class="btn btn-secondary btn-small" onclick="window.obAgregar()">Cancelar</button></div>` : ''
  return `<div class="cr-wrap ob-wrap"><div class="cr-head">Conclusiones y alertas <span>· ${vivas.filter(f => f.sev !== 'ok').length} por revisar · calculadas con lo registrado</span> ${chips}
      <button type="button" class="btn btn-secondary btn-small" style="margin-left:auto;" onclick="window.obAgregar()">+ Nota</button></div>${form}
    ${sec('Alertas e incongruencias', prior, false) || '<div class="dm-nota">Sin alertas: los datos registrados no muestran incongruencias.</div>'}${sec('Lo que se registró (conclusiones)', oks, true)}</div>`
}

const _repintar = async () => { await cargarObservaciones(_carpetaId); window.renderHojaCosteo?.() }
window.obResolverRegla = async (codigo, resuelta) => {
  const ex = _filas.find(f => f.codigo === codigo)
  const r = ex ? await supabase.from('carpeta_observaciones').update({ resuelta }).eq('id', ex.id)
    : await supabase.from('carpeta_observaciones').insert({ carpeta_id: _carpetaId, codigo, titulo: codigo, origen: 'regla', resuelta, severidad: 'info' })
  if (r.error) return showToast('No se pudo guardar (¿ejecutaste el SQL 120?): ' + r.error.message, 'danger')
  _repintar()
}
window.obResolverNota = async (id, resuelta) => {
  const { error } = await supabase.from('carpeta_observaciones').update({ resuelta }).eq('id', id)
  if (error) return showToast('No se pudo actualizar la nota', 'danger')
  _repintar()
}
window.obAgregar = () => { _notaAbierta = !_notaAbierta; window.renderHojaCosteo?.() }
window.obGuardarNota = async () => {
  const titulo = document.getElementById('obNotaTit')?.value.trim(); if (!titulo) return showToast('Escribe un título', 'warning')
  const { error } = await supabase.from('carpeta_observaciones').insert({ carpeta_id: _carpetaId, titulo, detalle: document.getElementById('obNotaDet')?.value || '', severidad: document.getElementById('obNotaSev')?.value || 'info', origen: 'manual', orden: 500 })
  if (error) return showToast('No se pudo guardar: ' + error.message, 'danger')
  _notaAbierta = false; _repintar()
}
