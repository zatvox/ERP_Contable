// ============================================================================
// importaciones/ci-nuevo-modal.js — REGISTRAR el Commercial Invoice de una carpeta
// que nació desde la OC/PI (etapa 2). Hereda las líneas y condiciones de la PI;
// el usuario ajusta lo que el proveedor realmente facturó (kg, precio, flete/seguro).
// Al guardar: crea comercial_invoices + detalle_comercial_invoice y enlaza la
// carpeta (carpetas_importacion.comercial_invoice_id). Luego el saldo se paga
// desde el cronograma / el modal del CI.
// ============================================================================
import { insert, update, query, supabase, ultimoErrorInsert } from '../supabase-client.js'
import { getCurrentUser } from '../auth-supabase.js'
import { showToast, fechaDMY } from '../helpers.js'
import { getItems } from '../supabase-data.js'
import { incluyeFlete } from './carpeta-nueva.js'
import { tieneColAnticipo } from './ci-multi.js'

const $ = id => document.getElementById(id)
const num = x => { const n = parseFloat(x); return Number.isFinite(n) ? n : 0 }
const n2 = x => num(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

let _pi = null, _lin = [], _carpeta = null, _cisPrev = [], _adicional = false, _antBase = 0, _colAnt = false, _totPrev = 0

function _asegurar() {
  if ($('modal-registrar-ci')) return
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-registrar-ci" class="modal">
    <div class="modal-content" style="width:min(96vw, 980px); max-width:min(96vw, 980px); max-height:calc(100vh - 48px); overflow-y:auto;">
      <div class="modal-header"><h3 class="modal-title" id="rciTitulo">Registrar Commercial Invoice</h3>
        <button class="modal-close" onclick="closeModal('modal-registrar-ci')">&times;</button></div>
      <div style="padding:16px 20px;">
        <div id="rciNota" style="font-size:.84rem; padding:8px 12px; border-left:3px solid var(--color-primary,#6366f1); background:var(--bg-secondary); border-radius:6px; margin-bottom:14px;"></div>
        <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px;">
          <div class="form-group"><label>N° de Commercial Invoice *</label><input type="text" id="rciNumero" placeholder="Ej: TKCI2661388"></div>
          <div class="form-group"><label>Fecha del CI *</label><input type="date" id="rciFecha"></div>
          <div class="form-group"><label>Incoterm</label><input type="text" id="rciIncoterm" disabled></div>
        </div>
        <div id="rciDesglose" style="display:none; grid-template-columns:1fr 1fr; gap:12px;">
          <div class="form-group"><label>Flete incluido en el precio</label><input type="number" step="0.01" min="0" id="rciFlete" value="0" oninput="window.rciCalc()"></div>
          <div class="form-group"><label>Seguro incluido en el precio</label><input type="number" step="0.01" min="0" id="rciSeguro" value="0" oninput="window.rciCalc()">
            <small style="color:var(--text-secondary);">El FOB real = total − flete − seguro. Si aún no lo sabes, déjalo en 0 y complétalo luego en 👁 CI.</small></div>
        </div>
        <div id="rciParcialBox" style="margin:4px 0 12px; padding:10px 12px; border:1px dashed var(--border-color); border-radius:8px; font-size:.85rem;">
          <label id="rciParcialLbl" style="display:flex; gap:8px; align-items:center; cursor:pointer;"><input type="checkbox" id="rciParcial" style="width:auto; margin:0;" onchange="window.rciCalc()">
            <span><strong>Esta Proforma se dividirá en varios CI</strong> <small style="color:var(--text-secondary);">(cada CI tendrá su BL, ETA, DAM y saldo)</small></span></label>
          <div id="rciAntBox" style="display:none; margin-top:10px; grid-template-columns:minmax(180px,260px) 1fr; gap:12px; align-items:start;">
            <div class="form-group" style="margin:0;"><label>Anticipo que absorbe este CI</label><input type="number" step="0.01" min="0" id="rciAnticipo" oninput="this.dataset.manual='1'; window.rciCalc()"></div>
            <small id="rciAntInfo" style="color:var(--text-secondary); line-height:1.4;"></small>
          </div>
        </div>
        <strong class="mod-sec">Artículos facturados <small style="font-weight:400; color:var(--text-secondary);">(vienen de la PI: corrige lo que difiera)</small></strong>
        <div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:.8rem;">
          <thead><tr style="color:var(--text-secondary); text-align:right;"><th style="text-align:left; padding:5px 8px;">Artículo</th><th style="padding:5px 8px;">PI kg <small id="rciYaH"></small></th><th style="padding:5px 8px;">Kg neto CI</th><th style="padding:5px 8px;">Kg bruto</th><th style="padding:5px 8px;">Bultos</th><th style="padding:5px 8px;">Precio unit.</th><th style="padding:5px 8px;">Subtotal</th></tr></thead>
          <tbody id="rciLineas"></tbody></table></div>
        <div id="rciTotales" style="margin-top:10px; padding:10px 12px; background:var(--bg-secondary); border-radius:8px; font-size:.88rem;"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('modal-registrar-ci')">Cancelar</button>
        <button class="btn btn-primary" id="rciGuardar" onclick="window.rciGuardar()">💾 Registrar CI</button>
      </div>
    </div>
  </div>`)
}

window.abrirRegistrarOtroCI = () => window.abrirRegistrarCI(true)

window.abrirRegistrarCI = async function (adicional = false) {
  try {
    _carpeta = window.carpetaActual
    if (!_carpeta?.id) { showToast('Selecciona una carpeta primero', 'warning'); return }
    _adicional = adicional === true
    if (!_adicional && window.costeoActual?.id) { showToast('Esta carpeta ya tiene Commercial Invoice', 'info'); return window.verCI?.() }
    if (!_carpeta.orden_compra_id) { showToast('La carpeta no tiene Proforma (PI) enlazada', 'warning'); return }
    const [pi] = await query('orden_compra', { id: _carpeta.orden_compra_id })
    _pi = pi; if (!pi) { showToast('No se encontró la Proforma de la carpeta', 'danger'); return }
    const [det, items, cisPrev, pagos, apps] = await Promise.all([query('detalle_orden_compra', { orden_compra_id: pi.id }), getItems(),
      query('comercial_invoices', { carpeta_importacion_id: _carpeta.id }), query('importacion_pagos', { carpeta_importacion_id: _carpeta.id }), query('importacion_pago_aplicaciones', { carpeta_importacion_id: _carpeta.id })])
    _cisPrev = (cisPrev || []).slice().sort((a, b) => a.id - b.id)
    try { const r = await supabase.from('comercial_invoices').select('anticipo_asignado').limit(1); _colAnt = !r.error } catch { _colAnt = tieneColAnticipo(_cisPrev) }
    const vivos = new Set((pagos || []).filter(p => p.estado !== 'observado').map(p => p.id))
    const antPag = (apps || []).filter(a => a.doc_tipo === 'oc_anticipo' && vivos.has(a.pago_id)).reduce((t, a) => t + num(a.monto_doc), 0)
    _antBase = antPag > 0 ? antPag : num(pi.total_oc) * num(pi.anticipo_porcentaje) / 100
    const prevDet = _cisPrev.length ? await Promise.all(_cisPrev.map(c => query('detalle_comercial_invoice', { comercial_invoice_id: c.id }))) : []
    const yaPorItem = {}; for (const l of prevDet.flat()) yaPorItem[l.product_id] = (yaPorItem[l.product_id] || 0) + num(l.cantidad_neto)
    _totPrev = _cisPrev.reduce((t, c) => t + num(c.valor_total_final_ci), 0)
    const mapa = {}; for (const i of items || []) mapa[i.id] = i
    _lin = (det || []).map(d => {
      const it = mapa[d.item_id]
      const kgPIl = num(d.peso_neto) > 0 ? num(d.peso_neto) : num(d.cantidad)
      const ya = yaPorItem[d.item_id] || 0
      const kg = _adicional ? Math.max(0, +(kgPIl - ya).toFixed(2)) : kgPIl
      const f = kgPIl > 0 ? kg / kgPIl : 1
      return { product_id: d.item_id, nombre: it ? (it.sku ? `(${it.sku}) ${it.nombre}` : it.nombre) : 'Artículo ' + d.item_id,
        kgPI: num(d.cantidad), ya, neto: kg, bruto: +(num(d.peso_bruto) * f).toFixed(2) || 0, bultos: Math.round(num(d.bultos) * f) || 0, precio: num(d.precio_unitario) }
    })
    if (!_lin.length) { showToast('La Proforma no tiene líneas', 'warning'); return }
    _asegurar()
    $('rciTitulo').textContent = `${_adicional ? 'Registrar otro Commercial Invoice' : 'Registrar Commercial Invoice'} — Carpeta ${_carpeta.numero_carpeta || ''}${_adicional ? ' · CI ' + (_cisPrev.length + 1) : ''}`
    $('rciParcial').checked = _adicional; $('rciParcial').disabled = _adicional
    $('rciParcialLbl').style.display = _adicional ? 'none' : 'flex'
    $('rciAnticipo').dataset.manual = ''
    $('rciNota').innerHTML = `Heredado de la Proforma <strong>${esc(pi.numero_proforma_proveedor || pi.numero)}</strong> (${fechaDMY(pi.fecha)}) · tolerancia ±${num(pi.tolerancia_porcentaje) || 10}%. Al registrarlo se habilita el pago del <strong>saldo</strong>, el BL y la DAM.`
    $('rciNumero').value = ''; $('rciFecha').value = new Date().toISOString().slice(0, 10)
    $('rciIncoterm').value = pi.incoterm || _carpeta.incoterm || ''
    $('rciFlete').value = 0; $('rciSeguro').value = 0
    $('rciDesglose').style.display = incluyeFlete(pi.incoterm || _carpeta.incoterm) ? 'grid' : 'none'
    $('rciLineas').innerHTML = _lin.map((l, i) => {
      const inp = (k, v, st = '0.01') => `<input type="number" step="${st}" min="0" value="${v || ''}" style="width:74px; padding:4px 6px; font-size:.8rem; text-align:right;" oninput="window.rciCalc(${i}, '${k}', this.value)">`
      return `<tr><td style="padding:4px 6px; font-size:.76rem; min-width:150px;">${esc(l.nombre)}</td><td style="padding:4px 8px; text-align:right;">${n2(l.kgPI)}${l.ya ? `<br><small style="color:var(--text-secondary);">ya en CI: ${n2(l.ya)}</small>` : ''}</td>
        <td style="padding:4px 8px; text-align:right;">${inp('neto', l.neto)}</td><td style="padding:4px 8px; text-align:right;">${inp('bruto', l.bruto)}</td>
        <td style="padding:4px 8px; text-align:right;">${inp('bultos', l.bultos, '1')}</td><td style="padding:4px 8px; text-align:right;">${inp('precio', l.precio, '0.0001')}</td>
        <td style="padding:4px 8px; text-align:right;" id="rciSub${i}"></td></tr>`
    }).join('')
    window.rciCalc()
    window.openModal('modal-registrar-ci')
  } catch (e) { console.error('abrirRegistrarCI:', e); showToast('No se pudo abrir el registro del CI', 'danger') }
}

/** Reparto propuesto del anticipo: este CI y los anteriores que aún no tienen parte asignada. */
function _propAnticipo(tot) {
  const totPI = num(_pi?.total_oc), tol = num(_pi?.tolerancia_porcentaje) || 10
  const completa = totPI > 0 && (_totPrev + tot) >= totPI * (1 - tol / 100)
  const prevMat = _cisPrev.filter(c => c.anticipo_asignado == null).map(c => ({ id: c.id, nro: c.invoice_number, monto: totPI > 0 ? +(_antBase * num(c.valor_total_final_ci) / totPI).toFixed(2) : 0 }))
  const prevTot = _cisPrev.reduce((t, c) => t + (c.anticipo_asignado != null ? num(c.anticipo_asignado) : (prevMat.find(m => m.id === c.id)?.monto || 0)), 0)
  const nuevo = completa ? Math.max(0, +(_antBase - prevTot).toFixed(2)) : (totPI > 0 ? +(_antBase * tot / totPI).toFixed(2) : 0)
  return { nuevo: Math.min(nuevo, tot), prevMat, completa }
}

window.rciCalc = function (i, k, v) {
  if (i != null && _lin[i]) _lin[i][k] = num(v)
  let tot = 0, kg = 0
  _lin.forEach((l, j) => { const s = l.neto * l.precio; tot += s; kg += l.neto; const c = $('rciSub' + j); if (c) c.textContent = n2(s) })
  const fl = num($('rciFlete')?.value), sg = num($('rciSeguro')?.value), tol = num(_pi?.tolerancia_porcentaje) || 10
  const totPI = num(_pi?.total_oc), acum = _totPrev + tot
  const dif = acum - totPI, pct = totPI > 0 ? dif / totPI * 100 : 0
  const col = Math.abs(pct) <= tol ? '#10b981' : (pct < 0 && $('rciParcial')?.checked ? '#f59e0b' : '#ef4444')
  const parcial = !!$('rciParcial')?.checked
  let extra = ''
  if (parcial && totPI > 0) {
    const faltaPct = (1 - acum / totPI) * 100
    extra = faltaPct > tol ? ` · <strong>pendiente por embarcar: ${_pi?.currency || 'USD'} ${n2(totPI - acum)} (${faltaPct.toFixed(1)}%)</strong>` : ''
  }
  $('rciTotales').innerHTML = `Total de este CI: <strong>${_pi?.currency || 'USD'} ${n2(tot)}</strong> · ${n2(kg)} kg` + (fl || sg ? ` · FOB: <strong>${n2(tot - fl - sg)}</strong>` : '')
    + `<br>${_adicional ? `Acumulado de la PI (${_cisPrev.length + 1} CI): ${n2(acum)} · ` : ''}Contra la PI (${n2(totPI)}): <span style="color:${col}; font-weight:600;">${dif >= 0 ? '+' : ''}${n2(dif)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>${extra} · `
    + (Math.abs(pct) <= tol ? 'dentro de la tolerancia: la diferencia se paga/descuenta en el saldo' : (pct < 0 && parcial ? 'faltan embarques: se registrarán en otro CI' : `excede la tolerancia ±${tol}%: confirma con el proveedor`))
  // Anticipo que absorbe este CI
  const box = $('rciAntBox'); if (box) box.style.display = parcial ? 'grid' : 'none'
  if (parcial) {
    const pr = _propAnticipo(tot), inp = $('rciAnticipo')
    if (inp.dataset.manual !== '1') inp.value = pr.nuevo
    $('rciAntInfo').innerHTML = (_colAnt ? '' : '<span style="color:#ef4444;">⚠ Falta la columna: ejecuta <code>assets/sql/118_ci_anticipo_asignado.sql</code> en Supabase antes de guardar.</span><br>')
      + `Anticipo pagado de la PI: <strong>${_pi?.currency || 'USD'} ${n2(_antBase)}</strong>. Se reparte entre los CI (${pr.completa ? 'con este CI la PI queda completa: absorbe el resto' : 'proporcional al valor'}); el saldo de este CI = ${n2(tot)} − ${n2(num(inp.value))} = <strong>${n2(Math.max(0, tot - num(inp.value)))}</strong>.`
      + (pr.prevMat.length ? `<br>Se ajustará el anticipo de ${pr.prevMat.map(m => `CI ${esc(m.nro)} → ${n2(m.monto)}`).join(', ')}.` : '')
  }
}

window.rciGuardar = async function () {
  const btn = $('rciGuardar')
  try {
    const numero = $('rciNumero').value.trim(), fecha = $('rciFecha').value
    if (!numero) throw new Error('Falta el N° de Commercial Invoice')
    if (!fecha) throw new Error('Falta la fecha del CI')
    const lin = _lin.filter(l => l.neto > 0)
    if (!lin.length) throw new Error('Ningún artículo tiene kg neto')
    if (lin.some(l => !(l.precio > 0))) throw new Error('Hay artículos sin precio unitario')
    const dup = (await query('comercial_invoices', { invoice_number: numero }) || []).find(c => c.contact_id === _carpeta.proveedor_id)
    if (dup) throw new Error(`Ya existe el CI ${numero} de este proveedor`)
    const total = lin.reduce((t, l) => t + l.neto * l.precio, 0)
    const fl = $('rciDesglose').style.display === 'none' ? 0 : num($('rciFlete').value)
    const sg = $('rciDesglose').style.display === 'none' ? 0 : num($('rciSeguro').value)
    if ((fl + sg) > 0 && (fl + sg) >= total) throw new Error('Flete + seguro no pueden igualar o superar el total del CI')
    btn.disabled = true; btn.textContent = 'Guardando…'
    const parcial = !!$('rciParcial')?.checked
    if (parcial && !_colAnt) throw new Error('Falta la columna anticipo_asignado: ejecuta assets/sql/118_ci_anticipo_asignado.sql en Supabase')
    if (_adicional || parcial) { const a = num($('rciAnticipo').value); if (a < 0 || a > total + 0.005) throw new Error('El anticipo asignado no puede ser mayor al total del CI') }
    if (_adicional && _cisPrev.some(c => c.anticipo_asignado == null) && !confirm('El anticipo de los CI anteriores se repartirá con este nuevo CI y su saldo cambiará. ¿Continuar?')) return
    const user = await getCurrentUser()
    const pi = _pi
    const ci = await insert('comercial_invoices', {
      contact_id: _carpeta.proveedor_id, invoice_number: numero, fecha,
      product: _carpeta.descripcion || null,
      terminos_delivery: pi.incoterm || _carpeta.incoterm || 'FOB',
      proforma_number: pi.numero_proforma_proveedor || null,
      puerto_embarque: pi.puerto_embarque || null, pais_origen: pi.pais_origen || null,
      terminos_payment: pi.anticipo_porcentaje != null
        ? `${num(pi.anticipo_porcentaje)}% advance - ${parseFloat((100 - num(pi.anticipo_porcentaje)).toFixed(2))}% ${pi.dias_saldo_desde_bl != null ? 'within ' + pi.dias_saldo_desde_bl + ' days from B/L date' : 'balance'}` : null,
      total_unidades: lin.reduce((t, l) => t + l.bultos, 0),
      cantidad_total_neto: lin.reduce((t, l) => t + l.neto, 0),
      cantidad_total_gross: lin.reduce((t, l) => t + (l.bruto || 0), 0),
      valor_total_final_ci: parseFloat(total.toFixed(2)),
      costo_flete: fl, costo_seguro: sg,
      valor_total_final_fob: parseFloat((total - fl - sg).toFixed(2)),
      carpeta_importacion_id: _carpeta.id, status: 'confirmado', created_by: user?.db_id,
      ...((_adicional || parcial) ? { anticipo_asignado: parseFloat(num($('rciAnticipo').value).toFixed(2)) } : {})
    })
    if (!ci?.id) throw new Error('No se pudo crear el CI: ' + (ultimoErrorInsert()?.mensaje || ultimoErrorInsert()?.message || 'revisa la consola'))
    if (!_adicional) await update('carpetas_importacion', _carpeta.id, { comercial_invoice_id: ci.id })
    else for (const m of _propAnticipo(total).prevMat) await update('comercial_invoices', m.id, { anticipo_asignado: m.monto })
    window.ciActivoPorCarpeta = window.ciActivoPorCarpeta || {}; window.ciActivoPorCarpeta[_carpeta.id] = ci.id
    let fallidas = 0
    for (const l of lin) {
      const f = await insert('detalle_comercial_invoice', { comercial_invoice_id: ci.id, product_id: l.product_id, lote: '',
        cantidad_neto: l.neto, cantidad_gross: l.bruto || 0, cantidad_unid: l.bultos || 0,
        costo_unitario: l.precio, costo_total: parseFloat((l.neto * l.precio).toFixed(2)) })
      if (!f) fallidas++
    }
    if (fallidas) showToast(`${fallidas} línea(s) del CI no se pudieron guardar. Revísalas en 👁 CI.`, 'warning')
    showToast(`Commercial Invoice ${numero} registrado. Ya puedes pagar su saldo.`, 'success')
    window.closeModal('modal-registrar-ci')
    const sel = $('costeoSelector')
    if (sel) { sel.value = String(_carpeta.id); await window.cargarImportacion?.() }
  } catch (e) { console.error('rciGuardar:', e); showToast(e.message || 'No se pudo registrar el CI', 'danger') }
  finally { if (btn) { btn.disabled = false; btn.textContent = '💾 Registrar CI' } }
}
