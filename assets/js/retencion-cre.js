// ============================================================================
// RETENCION-CRE.JS — Comprobante de Retención Electrónico (CRE, tipo 20) que nos
// entrega el cliente agente de retención del IGV (2026-11-11, SQL 156).
// ============================================================================
// NORMA (R.S. 037-2002/SUNAT, Régimen de Retenciones del IGV):
//   • El cliente (agente) retiene el 3 % del IMPORTE DEL PAGO (total con IGV, o de
//     cada pago parcial) y nos paga el resto. No retiene si el pago y los
//     comprobantes involucrados suman S/ 700 o menos.
//   • La retención SIEMPRE es en soles: facturas en USD se convierten con el T.C.
//     venta SBS de la FECHA DE PAGO (= fecha del CRE).
//   • La norma deja agrupar varias retenciones del mes en un CRE; el ERP guarda
//     UNA FILA POR FACTURA (si un CRE trae 2 facturas → 2 registros con el mismo
//     serie-número), así cada una conserva su T.C., base y PDF.
//   • Nosotros DEDUCIMOS la retención del IGV a pagar del periodo de la fecha del
//     CRE (PDT 621). Exceso: se arrastra; tras 3 periodos se puede pedir devolución.
//
// FLUJO EN EL ERP (naturalmente):
//   1. Se emite la factura al cliente agente (contacts.sujeto_retencion).
//   2. Al COBRAR, el modal propone la retención: el cobro guarda
//        monto           = lo que entra al BANCO (el neto)
//        monto_retencion = lo retenido (NO pasa por banco)
//      → la CxC queda saldada con dinero + retención.
//   3. Llega el CRE (mismo día o días después) → "🧾 Registrar comprobante de
//      retención": se sube el PDF, se digita serie, número y fecha; el ERP calcula
//      T.C., retención S/ y neto S/ (editables) y lo VINCULA al cobro del paso 2.
//   Caso excepcional ("sin cobro"): la factura NO tiene retención registrada
//   (se cobró sin marcarla, se importó de Odoo, o el cliente no estaba marcado como
//   agente) y por eso la CxC sigue mostrando el 3 % como saldo que nadie va a
//   pagar. Al registrar el CRE el ERP crea un "cobro de retención" SIN banco
//   (medio 'retencion', monto 0) que cierra ese saldo.
//
// CONTABILIDAD (asientos de Cobranzas hoy apagados; esto es lo que deben generar):
//   Ej. R002-23464 Camones · FFFI-288 USD 9,799.68 · T.C. 3.387 · 3 %
//   Al cobrar:
//     D 104x Bancos ME ................. USD 9,505.69 × 3.387 = S/ 32,195.77  (neto)
//     D 40114 IGV – Régimen de retenciones  S/ 995.74  (ctaRetencionIgv, def. 401141)
//     H 1212 Facturas por cobrar ME .... USD 9,799.68 × T.C. de la factura
//     D/H 676 / 776 Diferencia de cambio  la diferencia entre ambos T.C.
//   Al liquidar el IGV del periodo (PDT 621):
//     D 40111 IGV – Cuenta propia / H 40114 IGV – Régimen de retenciones
//   El "cobro de retención" (caso sin cobro) es D 40114 / H 1212 sin banco.
//   Base legal del monto deducible: comprobantes_retencion.retencion_pen.
// ============================================================================

import { supabase } from './supabase-client.js'
import { showToast, formatNumber, fechaDMY, numComp } from './helpers.js'
import { addCobro, deleteCobro, updateCobro, getAdjuntos, subirAdjuntos } from './supabase-data.js'
import { getCurrentUser } from './auth-supabase.js'
import { tcDelDia, marcarTC } from './shared/tc-fecha.js'

let C = null
let _st = null
const $ = id => document.getElementById(id)
const _r2 = n => Math.round((parseFloat(n) || 0) * 100) / 100
const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const _hoy = () => new Date().toISOString().slice(0, 10)
const MIN_PEN = 700            // R.S. 037-2002: no se retiene hasta S/ 700
const _normNum = v => parseInt(String(v || '').replace(/\D/g, ''), 10) || 0     // 0023464 → 23464
const _nCRE = (serie, numero) => `${String(serie || '').toUpperCase()}-${numero}`

export function initRetencionCRE(ctx) { C = ctx; _inyectarModal() }

// ── Modal ────────────────────────────────────────────────────────────────────
function _inyectarModal() {
  if ($('modal-cre')) return
  const sec = t => `<strong style="display:block; margin:4px 0 8px; color:var(--text-primary); font-size:0.85rem; font-weight:700; text-transform:uppercase; letter-spacing:0.03em;">${t}</strong>`
  const g = (lbl, inner, id = '') => `<div class="form-group" style="margin:0;" ${id ? `id="${id}"` : ''}><label>${lbl}</label>${inner}</div>`
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-cre" class="modal">
    <div class="modal-content" style="width:min(96vw, 1040px); max-width:min(96vw, 1040px); max-height:calc(100vh - 40px); overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title">🧾 Registrar comprobante de retención (CRE)</h3>
        <button class="modal-close" onclick="window.closeModal('modal-cre')">✕</button>
      </div>
      <div style="display:flex; flex-direction:column; gap:14px;">
        <div>
          ${sec('1. Factura retenida')}
          <div style="display:grid; grid-template-columns:minmax(240px, 1fr) minmax(240px, 1fr); gap:12px;">
            ${g('Cliente *', '<select id="creCliente" onchange="window._creCliente()"></select>')}
            ${g('Factura *', '<select id="creFactura" onchange="window._creFactura()"></select>')}
          </div>
          <div id="creInfoDoc" style="margin-top:10px;"></div>
        </div>
        <div style="padding-top:12px; border-top:1px solid var(--border-color);">
          ${sec('2. Datos del comprobante de retención')}
          <div style="display:grid; grid-template-columns:0.7fr 1fr 1fr; gap:12px;">
            ${g('Serie *', '<input type="text" id="creSerie" maxlength="4" placeholder="R002" style="text-transform:uppercase;" oninput="window._creRecalc()">')}
            ${g('Número *', '<input type="text" id="creNumero" inputmode="numeric" placeholder="23464" oninput="window._creRecalc()">')}
            ${g('Fecha de emisión (= fecha de pago) *', '<input type="date" id="creFecha" onchange="window._creTC(true)">')}
          </div>
          <div style="margin-top:10px;">
            <input type="file" data-preview-lista id="creArchivo" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/*" onchange="window._adjSeleccionar('cre'); setTimeout(window._creRecalc, 50)">
            <small style="color:var(--text-secondary); font-size:0.72rem;">PDF del CRE (sustento para deducir el IGV). Opcional: sin archivo queda marcado ⚠.</small>
            <div id="cre-adj-lista" style="display:flex; flex-direction:column; gap:6px; margin-top:6px;"></div>
          </div>
        </div>
        <div style="padding-top:12px; border-top:1px solid var(--border-color);">
          ${sec('3. Importes (automáticos, editables)')}
          <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:12px;">
            ${g('Importe del pago (base) <span id="creMonBase"></span>', '<input type="number" id="creBase" step="0.01" min="0" style="text-align:right;" oninput="window._creCalc(\'base\')">')}
            ${g('Tasa %', '<input type="number" id="creTasa" step="0.01" min="0" style="text-align:right;" oninput="window._creCalc(\'tasa\')">')}
            ${g('<span style="display:flex; justify-content:space-between; gap:6px;"><span>T.C. venta (fecha de pago)</span><button type="button" class="btn-tc-dia" onclick="window._creTC(true, this)">⟳ Del día</button></span>', '<input type="number" id="creTC" step="0.0001" min="0" style="text-align:right;" oninput="window._creCalc(\'tc\')">', 'creTCGroup')}
            ${g('Retención S/ (la del CRE) *', '<input type="number" id="creRetPen" step="0.01" min="0" style="text-align:right; font-weight:700;" oninput="window._creCalc(\'retPen\')">')}
            ${g('Importe neto S/ (total pagado)', '<input type="number" id="creNetoPen" step="0.01" min="0" style="text-align:right;" oninput="window._creCalc(\'neto\')">')}
            ${g('Retención en moneda de la factura <span id="creMonDoc"></span>', '<input type="number" id="creRetDoc" step="0.01" min="0" style="text-align:right; font-weight:700;" oninput="window._creCalc(\'retDoc\')">')}
          </div>
          <small style="color:var(--text-secondary); font-size:0.75rem;">Retención S/ = base × tasa × T.C. · La "retención en moneda de la factura" es lo que baja de la CxC.</small>
        </div>
        <div style="padding-top:12px; border-top:1px solid var(--border-color);">
          ${sec('4. Se vincula con')}
          <div id="creVinculo"></div>
        </div>
        <div id="creAvisos"></div>
        <div class="form-group" style="margin:0;"><label>Observaciones</label><input type="text" id="creObs" placeholder="Opcional"></div>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="window.closeModal('modal-cre')">Cancelar</button>
        <button class="btn btn-primary" id="creBtnOk" onclick="window.conCarga(this, window.guardarCRE)">💾 Registrar CRE</button>
      </div>
    </div>
  </div>`)
}

// ── Abrir ────────────────────────────────────────────────────────────────────
/** opc: { cxcId, cobroId } — desde el menú ⋮ de la CxC o desde la pestaña Retenciones. */
window.abrirRegistrarCRE = async function (opc = {}) {
  if (!C) return
  await C.cargar()
  _st = { doc: null, cobros: [], cres: [], candidatos: [], vinculo: null, opc }
  let contactId = null
  if (opc.cobroId) {
    const { data: cb } = await supabase.from('cobros').select('id, cxc_id, contact_id').eq('id', opc.cobroId).maybeSingle()
    if (cb) { opc.cxcId = cb.cxc_id; contactId = cb.contact_id }
  }
  if (opc.cxcId && !contactId) contactId = C.cxc().find(x => x.id === opc.cxcId)?.contact_id || null
  // Clientes: los marcados como agentes de retención + el del documento (si vino)
  const ids = new Set(C.cxc().filter(c => c.estado !== 'anulado' && C.contacto(c.contact_id)?.sujeto_retencion).map(c => c.contact_id))
  if (contactId) ids.add(contactId)
  const opts = [...ids].map(id => ({ id, n: C.nombre(id) })).sort((a, b) => a.n.localeCompare(b.n, 'es'))
  $('creCliente').innerHTML = '<option value="">-- Cliente (agente de retención) --</option>' + opts.map(o => `<option value="${o.id}">${_esc(o.n)}</option>`).join('')
  $('creCliente').value = contactId || ''
  C.refrescarBuscador?.('creCliente')
  for (const k of ['creSerie', 'creNumero', 'creObs', 'creBase', 'creTC', 'creRetPen', 'creNetoPen', 'creRetDoc']) $(k).value = ''
  $('creFecha').value = _hoy()
  $('creTasa').value = (C.tasa() * 100).toFixed(2)
  C.limpiarAdjuntos('cre')
  await window._creCliente(opc.cxcId)
  window.openModal('modal-cre')
}

window._creCliente = async function (cxcPre = null) {
  const cid = parseInt($('creCliente').value || 0) || null
  const docs = cid ? C.cxc().filter(c => c.contact_id === cid && c.estado !== 'anulado' && /^0?1$|factura/i.test(String(c.tipo_comprobante || '01')))
    .sort((a, b) => String(b.fecha_emision).localeCompare(String(a.fecha_emision))) : []
  $('creFactura').innerHTML = '<option value="">-- Factura --</option>' + docs.map(d => `<option value="${d.id}">${_esc(C.descDoc(d))} · ${fechaDMY(d.fecha_emision)} · ${d.moneda || 'PEN'} ${formatNumber(d.monto_total)}${parseFloat(d.monto_retenido) > 0 ? ' · ret. ' + formatNumber(d.monto_retenido) : ''}</option>`).join('')
  if (cxcPre && docs.some(d => d.id === cxcPre)) $('creFactura').value = cxcPre
  else if (docs.length === 1) $('creFactura').value = docs[0].id
  await window._creFactura()
}

/** Carga la factura, sus cobros y CRE desde la BD (siempre frescos). */
async function _cargarDoc(id) {
  const [{ data: doc }, { data: cobros }, cresR] = await Promise.all([
    supabase.from('cuentas_cobrar').select('*').eq('id', id).maybeSingle(),
    supabase.from('cobros').select('*').eq('cxc_id', id).order('fecha'),
    supabase.from('comprobantes_retencion').select('*').eq('cxc_id', id).eq('estado', 'registrado')
  ])
  if (cresR.error && /comprobantes_retencion/.test(cresR.error.message)) showToast('Falta ejecutar el SQL 156 (comprobantes de retención)', 'danger', 9000)
  _st.doc = doc; _st.cobros = cobros || []; _st.cres = cresR.data || []
  // Dinero que entró por letras canjeadas de esta factura (el neto suele ir en la letra)
  _st.abonosLetra = 0
  try {
    const { data: lts } = await supabase.from('letras_cambio').select('id').eq('cxc_id', id)
    if (lts?.length) {
      const { data: abs } = await supabase.from('letras_abonos').select('monto_amortizado').in('letra_id', lts.map(l => l.id))
      _st.abonosLetra = _r2((abs || []).reduce((s, a) => s + parseFloat(a.monto_amortizado || 0), 0))
    }
  } catch (_) { /* sin letras */ }
  // Cobros con retención aún sin CRE → candidatos para vincular (el más reciente primero)
  const conCRE = new Set(_st.cres.map(x => x.cobro_id).filter(Boolean))
  _st.candidatos = _st.cobros.filter(c => parseFloat(c.monto_retencion) > 0 && !c.numero_comprobante_retencion && !conCRE.has(c.id)).reverse()
}

window._creFactura = async function () {
  const id = parseInt($('creFactura').value || 0) || null
  _st.doc = null; _st.cobros = []; _st.cres = []; _st.candidatos = []; _st.vinculo = null
  if (!id) { $('creInfoDoc').innerHTML = ''; _pintarVinculo(); return window._creRecalc() }
  await _cargarDoc(id)
  const doc = _st.doc; if (!doc) return
  const mon = doc.moneda || 'PEN'
  $('creMonBase').textContent = `(${mon})`; $('creMonDoc').textContent = `(${mon})`
  $('creTCGroup').style.opacity = mon === 'PEN' ? '.5' : '1'
  const pre = _st.opc.cobroId && _st.candidatos.find(c => c.id === _st.opc.cobroId)
  _st.vinculo = pre ? pre.id : (_st.candidatos[0]?.id || 'sin_cobro')
  const ret = _r2(doc.monto_retenido), saldo = _r2(C.saldoCxC(doc))
  $('creInfoDoc').innerHTML = `<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:10px; padding:10px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); font-size:0.85rem;">
    ${[['Factura', _esc(C.descDoc(doc))], ['Emisión', fechaDMY(doc.fecha_emision)], ['Total', `${mon} ${formatNumber(doc.monto_total)}`], ['T.C. factura', mon === 'PEN' ? '—' : (doc.tipo_cambio || '—')],
       ['Retenido (sistema)', `${mon} ${formatNumber(ret)}`], ['Saldo', `${mon} ${formatNumber(saldo)}`], ['CRE registrados', _st.cres.length ? _st.cres.map(x => _nCRE(x.serie, x.numero)).join(', ') : '—']]
      .map(([k, v]) => `<div><div style="font-size:0.7rem; text-transform:uppercase; color:var(--text-secondary);">${k}</div><div style="font-weight:600;">${v}</div></div>`).join('')}</div>`
  _pintarVinculo()
  _baseDefecto()
  await window._creTC(false)
}

/** Base del pago por defecto: la del cobro a vincular (neto + retención) o lo que falta retener del total. */
function _baseDefecto() {
  const d = _st.doc; if (!d) return
  const cb = _st.candidatos.find(c => c.id === _st.vinculo)
  const t = (parseFloat($('creTasa').value) || 0) / 100 || C.tasa()
  const total = _r2(d.monto_total)
  const yaBase = _st.cres.reduce((s, x) => s + parseFloat(x.importe_pago || 0), 0)
  const falta = (total * t - parseFloat(d.monto_retenido || 0)) / t      // base cuya retención aún no está registrada
  const base = cb ? _r2(parseFloat(cb.monto) + parseFloat(cb.monto_retencion))
    : Math.max(0, _r2(Math.min(total - yaBase, falta > 0.01 ? falta : total - yaBase)))
  $('creBase').value = (base || total).toFixed(2)
}

function _pintarVinculo() {
  const box = $('creVinculo')
  if (!_st.doc) { box.innerHTML = '<span style="color:var(--text-secondary);">Elige la factura.</span>'; return }
  const mon = _st.doc.moneda || 'PEN'
  const opc = (val, titulo, sub) => `<label style="display:flex; gap:10px; align-items:flex-start; padding:8px 10px; border:1px solid var(--border-color); border-radius:var(--radius-sm); cursor:pointer; margin-bottom:6px;">
    <input type="radio" name="creVinc" style="width:auto; margin:3px 0 0;" ${String(_st.vinculo) === String(val) ? 'checked' : ''} onchange="window._creVinculo('${val}')">
    <span><b>${titulo}</b><br><small style="color:var(--text-secondary);">${sub}</small></span></label>`
  box.innerHTML = _st.candidatos.map(c => opc(c.id, `Cobro #${c.id} del ${fechaDMY(c.fecha)} — retención ${mon} ${formatNumber(c.monto_retencion)} (recomendado)`,
      `Entró al banco ${mon} ${formatNumber(c.monto)}${c.numero_operacion ? ' · Op. ' + _esc(c.numero_operacion) : ''}${c.numero_recibo ? ' · Rec. ' + _esc(c.numero_recibo) : ''}. Solo se le asigna este CRE (no cambia saldos ni banco).`)).join('')
    + opc('sin_cobro', 'Registrar la retención sin cobro (cobro de retención sin banco)',
      _st.candidatos.length ? 'Úsalo solo si este CRE corresponde a OTRO pago distinto de los de arriba.'
        : 'La factura no tiene retención registrada: se crea un cobro sin banco (medio "retención") que baja el saldo de la CxC y de sus cuotas.')
}
window._creVinculo = function (v) { _st.vinculo = v === 'sin_cobro' ? 'sin_cobro' : parseInt(v); _baseDefecto(); window._creCalc('base') }

/** T.C. venta de la fecha de pago (ley del sistema: sigue a la fecha). */
window._creTC = async function (forzar = false, btn = null) {
  const mon = _st?.doc?.moneda || 'PEN'
  if (mon === 'PEN') { $('creTC').value = '1'; return window._creCalc('tc') }
  const f = $('creFecha').value
  if (!f) return window._creCalc('tc')
  if (!forzar && parseFloat($('creTC').value) > 0) return window._creCalc('tc')
  const txt = btn?.textContent; if (btn) { btn.disabled = true; btn.textContent = '…' }
  const v = await tcDelDia(f, 'venta')
  if (btn) { btn.disabled = false; btn.textContent = txt }
  if (v) { $('creTC').value = v; marcarTC($('creTC'), true, `T.C. venta SUNAT del ${fechaDMY(f)}`) }
  else marcarTC($('creTC'), false, `No hay T.C. registrado para el ${fechaDMY(f)}: escríbelo (el del CRE)`)
  window._creCalc('tc')
}

/**
 * Cálculo como lo hace el agente (verificado con R002-23464):
 *   retención doc = r2(base × tasa)                  (USD 293.99)
 *   retención S/  = r2(retención doc × T.C.)          (995.74 — no 995.75)
 *   neto S/       = r2((base − retención doc) × T.C.) (32,195.77)
 * Si el usuario copia la retención S/ exacta del PDF, el equivalente en la moneda
 * de la factura se deriva de ella (retención S/ ÷ T.C.).
 */
window._creCalc = function (origen) {
  if (!_st?.doc) return window._creRecalc()
  const mon = _st.doc.moneda || 'PEN'
  const base = parseFloat($('creBase').value) || 0
  const t = (parseFloat($('creTasa').value) || 0) / 100
  const tc = mon === 'PEN' ? 1 : (parseFloat($('creTC').value) || 0)
  if (['base', 'tasa', 'tc'].includes(origen) && base > 0 && t > 0 && tc > 0) {
    // Como el agente: primero se redondea en la moneda de la factura y luego se convierte
    const rd = _r2(base * t), nd = _r2(base - rd)
    $('creRetDoc').value = rd.toFixed(2)
    $('creRetPen').value = _r2(rd * tc).toFixed(2)
    $('creNetoPen').value = _r2(nd * tc).toFixed(2)
  } else if (origen === 'retPen' && tc > 0) {
    const rp = parseFloat($('creRetPen').value) || 0
    $('creRetDoc').value = _r2(rp / tc).toFixed(2)
    $('creNetoPen').value = _r2(base * tc - rp).toFixed(2)
  }
  window._creRecalc()
}

// ── Validaciones (⛔ bloquea) y avisos (⚠️ recomienda) ────────────────────────
function _datos() {
  const d = _st?.doc, mon = d?.moneda || 'PEN'
  return {
    d, mon,
    serie: $('creSerie').value.trim().toUpperCase(), numero: _normNum($('creNumero').value), fecha: $('creFecha').value,
    base: _r2($('creBase').value), tasa: _r2($('creTasa').value), tc: mon === 'PEN' ? 1 : parseFloat($('creTC').value) || 0,
    retPen: _r2($('creRetPen').value), netoPen: _r2($('creNetoPen').value), retDoc: _r2($('creRetDoc').value),
    obs: $('creObs').value.trim() || null, vinculo: _st?.vinculo
  }
}

function _avisos(x) {
  const bloq = [], av = []
  if (!x.d) { bloq.push('Elige la factura.'); return { bloq, av } }
  if (!/^[A-Z0-9]{4}$/.test(x.serie)) bloq.push('Serie de 4 caracteres (ej. R002).')
  else if (!/^R/.test(x.serie)) av.push(`La serie ${x.serie} no empieza con "R" (los CRE electrónicos usan R001, R002…).`)
  if (!(x.numero > 0)) bloq.push('Escribe el número del CRE.')
  if (!x.fecha) bloq.push('Fecha de emisión del CRE.')
  if (!(x.retPen > 0) || !(x.retDoc > 0)) bloq.push('La retención debe ser mayor a 0.')
  if (x.mon !== 'PEN' && !(x.tc > 0)) bloq.push('Falta el T.C. de la fecha de pago.')
  if (_st.cres.some(c => c.serie === x.serie && Number(c.numero) === x.numero)) bloq.push(`El CRE ${_nCRE(x.serie, x.numero)} ya está registrado para esta factura.`)
  const ct = C.contacto(x.d.contact_id)
  if (!ct?.sujeto_retencion) av.push('El cliente no está marcado como agente de retención en Contactos: márcalo para que la retención se proponga sola al cobrar.')
  if (x.fecha && x.d.fecha_emision && x.fecha < x.d.fecha_emision) av.push(`La fecha del CRE (${fechaDMY(x.fecha)}) es anterior a la factura (${fechaDMY(x.d.fecha_emision)}).`)
  if (x.fecha && x.fecha > _hoy()) av.push('La fecha del CRE es futura.')
  const totalPen = _r2(parseFloat(x.d.monto_total) * (x.mon === 'PEN' ? 1 : (x.tc || parseFloat(x.d.tipo_cambio) || 1)))
  if (totalPen <= MIN_PEN) av.push(`La factura equivale a S/ ${formatNumber(totalPen)}: hasta S/ 700 el cliente no debía retener (R.S. 037-2002).`)
  if (Math.abs(x.tasa - C.tasa() * 100) > 0.001) av.push(`Tasa ${x.tasa}% distinta a la configurada (${(C.tasa() * 100).toFixed(2)}%).`)
  if (x.base > _r2(x.d.monto_total) + 0.01) av.push(`La base (${formatNumber(x.base)}) supera el total de la factura.`)
  const teo = _r2(_r2(x.base * x.tasa / 100) * x.tc)
  if (x.base > 0 && Math.abs(teo - x.retPen) > 0.05) av.push(`Retención S/ ${formatNumber(x.retPen)} ≠ base × tasa × T.C. (${formatNumber(teo)}). Verifica con el PDF.`)
  const acum = _r2(_st.cres.reduce((s, c) => s + parseFloat(c.retencion_doc), 0) + x.retDoc)
  const tope = _r2(parseFloat(x.d.monto_total) * x.tasa / 100)
  if (acum > tope + 0.05) av.push(`Con este CRE la retención acumulada (${x.mon} ${formatNumber(acum)}) supera el ${x.tasa}% de la factura (${formatNumber(tope)}).`)
  const cb = _st.candidatos.find(c => c.id === x.vinculo)
  if (cb && Math.abs(_r2(cb.monto_retencion) - x.retDoc) > 0.01)
    av.push(`El cobro #${cb.id} tiene retención ${x.mon} ${formatNumber(cb.monto_retencion)} y el CRE ${formatNumber(x.retDoc)}: si el CRE es el correcto, edita ese cobro (✏️) después para igualarlo.`)
  if (x.vinculo === 'sin_cobro') {
    const saldo = _r2(C.saldoCxC(x.d))
    if (x.retDoc > saldo + 0.01) bloq.push(`La retención (${x.mon} ${formatNumber(x.retDoc)}) supera el saldo de la factura (${formatNumber(saldo)}). ¿Ya está registrada en algún cobro?`)
    if (_st.candidatos.length) av.push('Hay cobros con retención pendiente de CRE: lo normal es vincular el CRE a uno de ellos.')
  }
  // Cruce con BANCO: lo que entró por la factura vs el neto que dice el CRE
  const banco = _r2(_st.cobros.filter(c => c.banco_id).reduce((s, c) => s + parseFloat(c.monto || 0), 0) + (_st.abonosLetra || 0))
  const netoDoc = _r2(x.base - x.retDoc)
  if (netoDoc > 0) {
    if (cb) { if (Math.abs(_r2(cb.monto) - netoDoc) > 0.05) av.push(`Banco: el cobro #${cb.id} ingresó ${x.mon} ${formatNumber(cb.monto)} y el neto del CRE es ${formatNumber(netoDoc)}.`) }
    else if (banco + 0.05 < netoDoc) av.push(`Banco: por esta factura (cobros + letras) han entrado ${x.mon} ${formatNumber(banco)}; el CRE dice que el cliente pagó ${formatNumber(netoDoc)} neto. Registra ese cobro (sin retención) o revisa.`)
  }
  if (!document.querySelectorAll('#cre-adj-lista > div').length) av.push('Sin PDF del CRE: quedará marcado ⚠ "sin archivo" hasta que lo subas.')
  return { bloq, av }
}

window._creRecalc = function () {
  if (!_st) return
  const { bloq, av } = _avisos(_datos())
  $('creAvisos').innerHTML = (bloq.length || av.length) ? `<div style="padding:10px 14px; border-radius:var(--radius-md); border:1px solid ${bloq.length ? 'var(--color-danger)' : 'var(--color-warning)'}; background:${bloq.length ? 'rgba(239,68,68,.08)' : 'rgba(245,158,11,.08)'}; font-size:0.85rem; line-height:1.5;">
    ${bloq.map(b => `⛔ ${_esc(b)}`).join('<br>')}${bloq.length && av.length ? '<br>' : ''}${av.map(a => `⚠️ ${_esc(a)}`).join('<br>')}
    ${av.length && !bloq.length ? '<br><small style="color:var(--text-secondary);">Son avisos: puedes registrar igual.</small>' : ''}</div>` : ''
  const btn = $('creBtnOk'); if (btn && !btn.classList.contains('btn-cargando')) btn.disabled = bloq.length > 0
}

// ── Guardar ──────────────────────────────────────────────────────────────────
window.guardarCRE = async function () {
  if (!_st?.doc) { showToast('Elige la factura', 'warning'); return }
  const vincAntes = _st.vinculo
  await _cargarDoc(_st.doc.id)                 // saldo, cobros y CRE frescos de la BD
  _st.vinculo = (vincAntes === 'sin_cobro' || _st.candidatos.some(c => c.id === vincAntes)) ? vincAntes : (_st.candidatos[0]?.id || 'sin_cobro')
  const x = _datos()
  const { bloq, av } = _avisos(x)
  if (bloq.length) { window._creRecalc(); showToast('⛔ ' + bloq[0], 'danger', 8000); return }
  const cb = _st.candidatos.find(c => c.id === x.vinculo)
  const n = _nCRE(x.serie, x.numero)
  const resumen = `CRE ${n} del ${fechaDMY(x.fecha)} — ${C.nombre(x.d.contact_id)}\nFactura ${C.descDoc(x.d)} · base ${x.mon} ${formatNumber(x.base)}${x.mon !== 'PEN' ? ` · T.C. ${x.tc}` : ''}\n`
    + `Retención S/ ${formatNumber(x.retPen)} (= ${x.mon} ${formatNumber(x.retDoc)}) · Neto S/ ${formatNumber(x.netoPen)}\n\n`
    + (cb ? `Se vincula al cobro #${cb.id} del ${fechaDMY(cb.fecha)} (no cambia saldos ni banco).`
          : `Se crea un cobro de retención SIN banco por ${x.mon} ${formatNumber(x.retDoc)}: baja el saldo de la factura.`)
    + (av.length ? `\n\n⚠️ Revisa (no bloquea):\n• ${av.join('\n• ')}` : '')
  if (!confirm(resumen + '\n\n¿Registrar?')) return

  const user = getCurrentUser()
  let cobroCreado = null
  try {
    // Caso "sin cobro": cobro de retención (monto 0, sin banco ni movimiento) → D 40114 / H 1212
    if (!cb) {
      cobroCreado = await addCobro({
        empresa_id: x.d.empresa_id, cxc_id: x.d.id, contact_id: x.d.contact_id, fecha: x.fecha,
        monto: 0, monto_retencion: x.retDoc, moneda: x.mon, tipo_cambio: x.tc || 1,
        medio_pago: 'retencion', referencia: `CRE ${n}`, banco_id: null, numero_comprobante_retencion: n
      })
      if (!cobroCreado?.id) throw new Error('No se pudo crear el cobro de retención (¿falta el SQL 156?)')
      await C.aplicarEfectosCobro(cobroCreado, x.d, { sinMov: true })
    }
    const { data: cre, error } = await supabase.from('comprobantes_retencion').insert({
      empresa_id: x.d.empresa_id, contact_id: x.d.contact_id, cxc_id: x.d.id, cobro_id: cb?.id || cobroCreado?.id || null,
      serie: x.serie, numero: x.numero, fecha_emision: x.fecha, tasa: x.tasa,
      doc_tipo: '01', doc_serie: x.d.serie || null, doc_numero: String(numComp(x.d.numero_comprobante) || x.d.numero_comprobante || ''),
      doc_fecha: x.d.fecha_emision || null, doc_moneda: x.mon, doc_importe_total: _r2(x.d.monto_total),
      importe_pago: x.base, tipo_cambio: x.tc || 1, retencion_pen: x.retPen, neto_pen: x.netoPen, retencion_doc: x.retDoc,
      origen: cb ? 'vinculado' : 'sin_cobro', observaciones: x.obs, created_by: user?.db_id || null
    }).select().single()
    if (error) throw new Error(/duplicate|ux_cre/i.test(error.message) ? `El CRE ${n} ya está registrado para esta factura` : (/does not exist|schema cache/i.test(error.message) ? 'Falta ejecutar el SQL 156: ' + error.message : error.message))
    if (cb) await updateCobro(cb.id, { numero_comprobante_retencion: n })
    await C.subirAdjuntos('cre', 'comprobante_retencion', cre.id)
    window.closeModal('modal-cre')
    showToast(`CRE ${n} registrado ✅ — S/ ${formatNumber(x.retPen)} deducible en el IGV de ${x.fecha.slice(0, 7)}`, 'success', 8000)
    await C.refrescar()
  } catch (e) {
    console.error('guardarCRE:', e)
    // Si se creó el cobro de retención pero falló el CRE, se revierte (no queda a medias)
    if (cobroCreado?.id) {
      try { await C.revertirEfectosCP('cobro', cobroCreado); await deleteCobro(cobroCreado.id) } catch (e2) { console.error(e2) }
    }
    showToast('Error: ' + e.message, 'danger', 10000)
  }
}

// ── Anular ───────────────────────────────────────────────────────────────────
window.anularCRE = async function (creId) {
  try {
    const { data: cre } = await supabase.from('comprobantes_retencion').select('*').eq('id', creId).single()
    if (!cre || cre.estado === 'anulado') { showToast('CRE no encontrado o ya anulado', 'warning'); return }
    const n = _nCRE(cre.serie, cre.numero)
    const { data: cobro } = cre.cobro_id ? await supabase.from('cobros').select('*').eq('id', cre.cobro_id).maybeSingle() : { data: null }
    const sinCobro = cre.origen === 'sin_cobro' && cobro?.medio_pago === 'retencion'
    if (!confirm(`Anular el CRE ${n} (S/ ${formatNumber(cre.retencion_pen)})?\n\n${sinCobro
      ? `Se elimina el cobro de retención #${cobro.id} (${cre.doc_moneda} ${formatNumber(cre.retencion_doc)}): la factura vuelve a tener ese saldo.`
      : 'El cobro vinculado conserva su retención; solo vuelve a quedar "pendiente de CRE".'}\n\nEl registro queda ANULADO (con su PDF) para el rastro.`)) return
    if (sinCobro) {
      const r = await C.revertirEfectosCP('cobro', cobro)
      if (!(await deleteCobro(cobro.id))) throw new Error('no se pudo eliminar el cobro de retención')
      if (r?.avisos?.length) showToast('⚠️ ' + r.avisos.join('; '), 'warning')
    } else if (cobro) await updateCobro(cobro.id, { numero_comprobante_retencion: null })
    await supabase.from('comprobantes_retencion').update({ estado: 'anulado', anulado_at: new Date().toISOString(), cobro_id: sinCobro ? null : cre.cobro_id }).eq('id', creId)
    showToast(`CRE ${n} anulado`, 'success')
    await C.refrescar()
  } catch (e) { console.error('anularCRE:', e); showToast('Error: ' + e.message, 'danger', 9000) }
}

window.verPdfCRE = async function (creId) {
  const adj = await getAdjuntos('comprobante_retencion', creId)
  if (!adj.length) { showToast('Este CRE no tiene archivo: usa "📎 Subir PDF".', 'warning'); return }
  window.verAdjunto?.(adj[0].id, adj[0].path)
}

/** Subir el PDF después (CRE registrado sin archivo). */
window.subirPdfCRE = function (creId) {
  const inp = document.createElement('input')
  inp.type = 'file'; inp.accept = '.pdf,image/*'
  inp.onchange = async () => {
    const f = inp.files?.[0]; if (!f) return
    const { ok, errores } = await subirAdjuntos('comprobante_retencion', creId, [{ file: f, concepto: 'cre' }], getCurrentUser()?.db_id || null)
    showToast(ok ? 'PDF del CRE subido ✅' : 'No se subió: ' + errores.join(' · '), ok ? 'success' : 'danger')
    if (ok) await C.refrescar()
  }
  inp.click()
}
