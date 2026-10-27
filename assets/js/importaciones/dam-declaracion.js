// ============================================================================
// DAM-DECLARACION.JS — Declaración completa: PROPUESTA del sistema vs lo que dice el agente
// ============================================================================
// La DAM la arma el agente de aduana. Aquí el sistema genera, con los datos que
// ya tienes registrados (CI, BL, packing, proveedor), cómo DEBERÍA salir cada
// hoja de la declaración:
//     Hoja A  — declaración (importador, valor, despacho, mercadería)
//     Hoja B  — proveedor y determinación del valor
//     DAV     — Declaración Andina del Valor (valor de transacción)
//     Tributos y percepción
// y lo compara campo por campo con lo que dice la DAM del agente. Lo que difiere se
// resalta para que lo consultes; el valor del agente es editable y al final se
// CONFIRMA. No modifica la DAM ni el costeo: es una herramienta de revisión.
// Se guarda en dams.declaracion_agente (SQL 104).
// ============================================================================
import { query, update, esperarContextoEmpresa } from '../supabase-client.js'
import { showToast, formatNumber } from '../helpers.js'
import { declararEmpresaModal, empresaById } from '../empresa.js'

const $ = id => document.getElementById(id)
const num = x => { const n = parseFloat(String(x ?? '').replace(/,/g, '')); return isNaN(n) ? null : n }
const n0 = x => num(x) || 0
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const norm = s => String(s ?? '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]/g, '')

const TOL = { money: 0.05, kg: 0.5, rate: 0.00001, unit: 0.000001, int: 0 }
const SECC = { A: 'Hoja A — Declaración', B: 'Hoja B — Proveedor y valor', C: 'DAV — Declaración Andina del Valor', T: 'Tributos y percepción' }

// Campos: [clave, sección, casilla, etiqueta, tipo(text|date|num), tolerancia, nota si difiere]
const CAMPOS = [
  ['a_ruc', 'A', '1.1', 'Importador — RUC', 'text'],
  ['a_razon', 'A', '1.1', 'Importador — razón social', 'text'],
  ['a_llegada', 'A', '3.4', 'Fecha de llegada de la nave', 'date'],
  ['a_terminal', 'A', '4.1', 'Terminal / depósito temporal', 'text'],
  ['a_fob', 'A', '6.1', 'FOB (USD)', 'num', TOL.money, 'El FOB de la DAM no coincide con el del CI. Si es un ajuste del agente, pídele el concepto.'],
  ['a_flete', 'A', '6.2', 'Flete (USD)', 'num', TOL.money, 'El flete declarado difiere del CI. Compáralo también con el flete del BL.'],
  ['a_seguro', 'A', '6.3', 'Seguro (USD)', 'num', TOL.money, 'El seguro declarado difiere del CI / póliza.'],
  ['a_ajustes', 'A', '6.4', 'Total ajustes (USD)', 'num', TOL.money, 'Hay un ajuste que el sistema no tiene registrado: pregunta a tu agente de qué concepto es.'],
  ['a_cif', 'A', '6.5', 'Valor en aduana — CIF (USD)', 'num', TOL.money, 'El CIF declarado difiere del que sale de tus documentos.'],
  ['a_puerto', 'A', '7.1', 'Puerto de embarque', 'text'],
  ['a_bl', 'A', '7.2', 'N° de B/L', 'text'],
  ['a_femb', 'A', '7.2', 'Fecha de embarque', 'date'],
  ['a_bultos', 'A', '7.12', 'Cantidad de bultos', 'num', TOL.int, 'Los bultos no coinciden con el BL / packing list.'],
  ['a_bruto', 'A', '7.15', 'Peso bruto (kg)', 'num', TOL.kg, 'El peso bruto difiere del BL. Puede deberse al pesaje del terminal; confírmalo.'],
  ['a_neto', 'A', '7.14', 'Peso neto (kg)', 'num', TOL.kg, 'El peso neto no coincide con el CI / packing list.'],
  ['a_partida', 'A', '7.19', 'Subpartida nacional', 'text'],
  ['a_origen', 'A', '7.20', 'País de origen', 'text'],
  ['a_factura', 'A', '7.36', 'N° de factura comercial', 'text'],
  ['a_ffactura', 'A', '7.36', 'Fecha de la factura', 'date'],
  ['a_contenedor', 'A', '9', 'N° de contenedor', 'text'],
  ['a_precinto', 'A', '9', 'Precinto', 'text'],
  ['a_tipocont', 'A', '9', 'Tipo de contenedor', 'text'],
  ['b_prov', 'B', '3.1', 'Proveedor — razón social', 'text'],
  ['b_provdir', 'B', '3.3', 'Proveedor — dirección', 'text'],
  ['b_provpais', 'B', '3.5', 'Proveedor — país', 'text'],
  ['b_incoterm', 'B', '5.4', 'Condición de entrega (Incoterm)', 'text'],
  ['b_moneda', 'B', '5.5', 'Moneda de la transacción', 'text'],
  ['b_fobunit', 'B', '5.9', 'FOB unitario (USD por kg)', 'num', TOL.unit, 'El precio unitario declarado difiere del CI.'],
  ['b_cantidad', 'B', '5.11', 'Cantidad comercial (kg)', 'num', TOL.kg],
  ['b_precio', 'B', '8.1.1', 'Precio neto según factura (USD)', 'num', TOL.money, 'El precio de factura declarado no coincide con el CI.'],
  ['b_otros', 'B', '8.1.6', 'Otros ajustes (USD)', 'num', TOL.money, 'Ajuste adicional sobre la factura: pide el sustento al agente.'],
  ['b_transporte', 'B', '8.3.1', 'Gastos de transporte (USD)', 'num', TOL.money],
  ['c_precio', 'C', '59', 'Precio neto según factura (USD)', 'num', TOL.money],
  ['c_indirectos', 'C', '60', 'Pagos indirectos / descuentos retroactivos (USD)', 'num', TOL.money, 'La DAV declara un monto aquí que el sistema no conoce.'],
  ['c_declarado', 'C', '79', 'Valor de transacción declarado (USD)', 'num', TOL.money, 'El valor de transacción declarado difiere del que sale de tus documentos.'],
  ['t_adv', 'T', 'Liq.', 'Ad valorem (USD)', 'num', TOL.money],
  ['t_igv', 'T', 'Liq.', 'IGV (USD)', 'num', TOL.money],
  ['t_ipm', 'T', 'Liq.', 'IPM (USD)', 'num', TOL.money],
  ['t_total', 'T', 'Liq.', 'Total liquidación (USD)', 'num', TOL.money],
  ['t_tc', 'T', '—', 'T.C. venta SUNAT', 'num', 0.0005],
  ['t_cancel', 'T', '—', 'Monto cancelado en soles (S/)', 'num', 1],
  ['t_percep', 'T', '—', 'Percepción IGV (S/) — referencial', 'num', 1, 'Mayor entre 3.5 % × (valor aduana + tributos) y el monto fijo SUNAT × kg si la subpartida es «sensible al fraude» (DS 104-2026-EF). Confírmala con tu agente.']
]

let _ctx = null    // { dam, ci, bls, bl, lineas, prov, emp, tasas }
let _agente = {}   // valores del agente (editables)

// ── Tasas: las deduce de la DAM; si no hay, valores de ley habituales ───────────
function _tasasDe(dam, guardadas) {
  const cif = n0(dam.valor_cif) || (n0(dam.valor_fob) + n0(dam.flete_maritimo) + n0(dam.seguro_maritimo))
  const base = cif + n0(dam.ad_valorem_usd)
  const r = (a, b, def) => (a > 0 && b > 0) ? +(a / b * 100).toFixed(2) : def
  return {
    adv: guardadas?.adv ?? r(n0(dam.ad_valorem_usd), cif, 6),
    igv: guardadas?.igv ?? r(n0(dam.igv_usd), base, 15.5),
    ipm: guardadas?.ipm ?? r(n0(dam.imp_usd), base, 2.5),
    per: guardadas?.per ?? 3.5
  }
}

// ── Propuesta del sistema ────────────────────────────────────────────────────
function _propuesta() {
  const { dam, ci, bl, bls, lineas, prov, emp, tasas } = _ctx
  const kg = n0(dam.peso_neto_kg) || n0(ci.cantidad_total_neto) || lineas.reduce((t, l) => t + n0(l.cantidad_neto), 0)
  const fob = n0(ci.valor_total_final_fob) || n0(dam.valor_fob)
  const flete = n0(ci.costo_flete), seguro = n0(ci.costo_seguro)
  const cif = fob + flete + seguro
  const adv = cif * tasas.adv / 100
  const igv = (cif + adv) * tasas.igv / 100, ipm = (cif + adv) * tasas.ipm / 100
  const total = adv + igv + ipm
  const tc = n0(dam.tipo_cambio)
  const sumBL = k => (bls || []).reduce((t, b) => t + n0(b[k]), 0)
  const p = {
    a_ruc: emp?.ruc, a_razon: emp?.razon_social, a_llegada: dam.fecha_llegada || bl?.fecha_llegada, a_terminal: dam.deposito_temporal,
    a_fob: fob, a_flete: flete, a_seguro: seguro, a_ajustes: 0, a_cif: cif,
    a_puerto: ci.puerto_embarque, a_bl: bl?.nro_bill_lading, a_femb: bl?.fecha, a_bultos: sumBL('bultos') || null, a_bruto: sumBL('peso_bruto') || null,
    a_neto: kg, a_partida: lineas[0]?.partida_arancelaria, a_origen: ci.pais_origen, a_factura: ci.invoice_number, a_ffactura: ci.fecha,
    a_contenedor: bl?.contenedor_number, a_precinto: bl?.numero_precinto, a_tipocont: bl?.tipo_contenedor,
    b_prov: prov?.nombre, b_provdir: prov?.direccion, b_provpais: prov?.pais, b_incoterm: ci.terminos_delivery, b_moneda: 'USD',
    b_fobunit: kg ? +(fob / kg).toFixed(6) : null, b_cantidad: kg, b_precio: n0(ci.valor_total_final_ci) || cif, b_otros: 0, b_transporte: flete,
    c_precio: n0(ci.valor_total_final_ci) || cif, c_indirectos: 0, c_declarado: cif,
    t_adv: adv, t_igv: igv, t_ipm: ipm, t_total: total, t_tc: tc || null, t_cancel: tc ? total * tc : null,
    t_percep: tc ? (window.calcularPercepcion ? window.calcularPercepcion({ baseSoles: (cif + adv + igv + ipm) * tc, kg, subpartida: dam.subpartida || lineas[0]?.partida_arancelaria, tasa: tasas.per }).monto : (cif + adv + igv + ipm) * tc * tasas.per / 100) : null
  }
  return p
}

// Lo que la DAM registrada en el sistema ya dice (se usa como valor inicial del agente)
function _desdeDAM() {
  const { dam, ci } = _ctx
  const fobDam = n0(dam.valor_fob), fobCI = n0(ci.valor_total_final_fob)
  const kg = n0(dam.peso_neto_kg) || n0(ci.cantidad_total_neto)
  const cif = n0(dam.valor_cif) || (fobDam + n0(dam.flete_maritimo) + n0(dam.seguro_maritimo))
  const ajuste = fobDam && fobCI ? +(fobDam - fobCI).toFixed(3) : null
  return {
    a_llegada: dam.fecha_llegada, a_terminal: dam.deposito_temporal, a_fob: dam.valor_fob, a_flete: dam.flete_maritimo, a_seguro: dam.seguro_maritimo,
    a_ajustes: ajuste, a_cif: cif || null, a_bultos: dam.bultos, a_bruto: dam.peso_bruto_kg, a_neto: dam.peso_neto_kg,
    b_fobunit: kg && fobDam ? +(fobDam / kg).toFixed(6) : null, b_cantidad: dam.peso_neto_kg, b_otros: ajuste, c_indirectos: ajuste, c_declarado: cif || null,
    t_adv: dam.ad_valorem_usd, t_igv: dam.igv_usd, t_ipm: dam.imp_usd, t_total: dam.total_liquidacion, t_tc: dam.tipo_cambio,
    t_cancel: dam.total_liquidacion_sol, t_percep: dam.percepcion
  }
}

const _vacio = x => x == null || x === '' || (typeof x === 'number' && isNaN(x))
function _estado(c, prop, ag) {
  const [, , , , tipo, tol] = c
  if (_vacio(ag)) return _vacio(prop) ? 'vacio' : 'falta'
  if (_vacio(prop)) return 'sinprop'
  if (tipo === 'num') return Math.abs(n0(prop) - n0(ag)) <= (tol ?? TOL.money) ? 'ok' : 'dif'
  if (tipo === 'date') return String(prop).slice(0, 10) === String(ag).slice(0, 10) ? 'ok' : 'dif'
  const a = norm(prop), b = norm(ag)
  return a === b || (a.length > 3 && b.length > 3 && (a.includes(b) || b.includes(a))) ? 'ok' : 'dif'
}
const ETQ = { ok: ['✔', 'coincide', '#10b981'], dif: ['⚠', 'difiere', '#f59e0b'], falta: ['·', 'sin dato del agente', '#6b7280'], sinprop: ['·', 'sin propuesta', '#6b7280'], vacio: ['', '', '#6b7280'] }

const _fmtVal = (c, x) => _vacio(x) ? '' : (c[4] === 'num' ? (c[5] === TOL.unit ? Number(x).toFixed(6) : formatNumber(n0(x), 2)) : String(x))

// ── Modal ────────────────────────────────────────────────────────────────────
function _asegurarModal() {
  if ($('modal-dam-declaracion')) return
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-dam-declaracion" class="modal">
    <div class="modal-content" style="width:min(98vw, 1120px); max-width:min(98vw, 1120px); max-height:calc(100vh - 40px); overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title" id="ddTitulo">Declaración completa</h3>
        <button class="modal-close" onclick="window.cerrarDeclaracionDAM()">&times;</button>
      </div>
      <div style="padding:6px 20px 0;">
        <div class="dm-explica">📋 <b>Propuesta del sistema</b> = cómo debería salir cada hoja de la DAM según tus documentos (CI, BL, packing, proveedor). <b>Declaración del agente</b> = lo que dice la DAM que te entregaron (ya cargué lo que registraste en la DAM; completa el resto). Las filas ⚠ son las que conviene consultar.</div>
        <div id="ddResumen" class="dd-resumen"></div>
        <div class="dd-tasas">
          <span class="dd-tasas-t">Tasas para la propuesta de tributos:</span>
          <label>Ad valorem % <input type="number" id="ddTasaAdv" step="0.01" oninput="window.ddPintar()"></label>
          <label>IGV % <input type="number" id="ddTasaIgv" step="0.01" oninput="window.ddPintar()"></label>
          <label>IPM % <input type="number" id="ddTasaIpm" step="0.01" oninput="window.ddPintar()"></label>
          <label>Percepción % <input type="number" id="ddTasaPer" step="0.01" oninput="window.ddPintar()"></label>
        </div>
        <div id="ddTabla" style="overflow-x:auto;"></div>
      </div>
      <div class="modal-footer">
        <span id="ddConfirmada" class="dd-conf"></span>
        <button class="btn btn-secondary" onclick="window.ddCopiarVacios()" title="Copia la propuesta a las filas del agente que están vacías">⬇ Copiar propuesta a lo vacío</button>
        <button class="btn btn-secondary" onclick="window.cerrarDeclaracionDAM()">Cerrar</button>
        <button class="btn btn-secondary" onclick="window.ddGuardar(false)">💾 Guardar borrador</button>
        <button class="btn btn-primary" onclick="window.ddGuardar(true)">✔ Confirmar declaración</button>
      </div>
    </div>
  </div>`)
}

function _leerAgente() {
  document.querySelectorAll('#ddTabla input[data-k]').forEach(i => { _agente[i.dataset.k] = i.value })
}

window.ddPintar = function () {
  if (!_ctx) return
  _leerAgente()
  const t = _ctx.tasas
  t.adv = n0($('ddTasaAdv').value); t.igv = n0($('ddTasaIgv').value); t.ipm = n0($('ddTasaIpm').value); t.per = n0($('ddTasaPer').value)
  const prop = _propuesta()
  let ok = 0, dif = 0, falta = 0
  let ultima = ''
  const filas = CAMPOS.map(c => {
    const [k, sec, cas, lbl, tipo] = c
    const p = prop[k], a = _agente[k]
    const st = _estado(c, p, a)
    if (st === 'ok') ok++; else if (st === 'dif') dif++; else if (st === 'falta') falta++
    const [ico, txt, col] = ETQ[st]
    const cab = sec !== ultima ? `<tr class="dd-sec"><td colspan="6">${SECC[sec]}</td></tr>` : ''
    ultima = sec
    const ayuda = st === 'dif' && c[6] ? `<div class="dd-nota">💬 ${esc(c[6])}</div>` : ''
    return `${cab}<tr class="dd-fila ${st}"><td class="dd-cas">${esc(cas)}</td><td>${esc(lbl)}${ayuda}</td>
      <td class="dd-prop">${esc(_fmtVal(c, p)) || '<span class="dd-nd">—</span>'}</td>
      <td><input type="${tipo === 'date' ? 'date' : 'text'}" data-k="${k}" value="${esc(tipo === 'date' ? String(a ?? '').slice(0, 10) : _fmtVal(c, a))}" oninput="window.ddPintarSuave()" placeholder="${tipo === 'date' ? '' : 'lo que dice la DAM'}"></td>
      <td><span class="dd-chip" style="--c:${col};">${ico} ${txt}</span></td>
      <td><button type="button" class="btn btn-secondary btn-small" title="Usar la propuesta" onclick="window.ddUsar('${k}')" ${_vacio(p) ? 'disabled' : ''}>←</button></td></tr>`
  }).join('')
  $('ddTabla').innerHTML = `<table class="dm-tabla dd-tabla"><thead><tr><th>Casilla</th><th>Campo</th><th>Propuesta del sistema</th><th>Declaración del agente</th><th>Revisión</th><th></th></tr></thead><tbody>${filas}</tbody></table>`
  $('ddResumen').innerHTML = `<span class="dd-chip" style="--c:#10b981;">✔ ${ok} coinciden</span><span class="dd-chip" style="--c:#f59e0b;">⚠ ${dif} difieren</span><span class="dd-chip" style="--c:#6b7280;">· ${falta} sin dato del agente</span>`
  const conf = _ctx.dam.declaracion_confirmada_at
  $('ddConfirmada').textContent = conf ? `Confirmada el ${new Date(conf).toLocaleDateString('es-PE')}` : 'Sin confirmar'
}

// Repintar sin perder el foco mientras se escribe
let _t = null
window.ddPintarSuave = function () {
  clearTimeout(_t)
  _t = setTimeout(() => {
    const el = document.activeElement
    const k = el?.dataset?.k, pos = el?.selectionStart
    window.ddPintar()
    if (k) { const n = document.querySelector(`#ddTabla input[data-k="${k}"]`); if (n) { n.focus(); try { n.setSelectionRange(pos, pos) } catch { /* date */ } } }
  }, 450)
}

window.ddUsar = function (k) {
  _leerAgente()
  const c = CAMPOS.find(x => x[0] === k); const p = _propuesta()[k]
  _agente[k] = c[4] === 'date' ? String(p ?? '').slice(0, 10) : (c[4] === 'num' ? String(p) : String(p ?? ''))
  window.ddPintar()
}
window.ddCopiarVacios = function () {
  _leerAgente()
  const prop = _propuesta()
  for (const c of CAMPOS) if (_vacio(_agente[c[0]]) && !_vacio(prop[c[0]])) _agente[c[0]] = c[4] === 'num' ? String(prop[c[0]]) : String(prop[c[0]]).slice(0, c[4] === 'date' ? 10 : 400)
  window.ddPintar()
}

window.abrirDeclaracionDAM = async function (damId) {
  try {
    await esperarContextoEmpresa()
    const ci = window.costeoActual?.id ? window.costeoActual : null
    if (!ci) { showToast('Esta carpeta aún no tiene Commercial Invoice', 'warning'); return }
    const dam = damId ? ((await query('dams', { id: damId })) || [])[0] : ((await query('dams', { importacion_id: ci.id })) || [])[0]
    if (!dam) { showToast('Primero registra la DAM de la carpeta', 'warning'); return }
    const carpeta = window.carpetaActual || null
    const [bls, lineas, prov] = await Promise.all([
      query('bill_of_ladings', { importacion_id: ci.id }),
      query('detalle_comercial_invoice', { comercial_invoice_id: ci.id }),
      ci.contact_id ? query('contacts', { id: ci.contact_id }) : (carpeta?.proveedor_id ? query('contacts', { id: carpeta.proveedor_id }) : [])
    ])
    const guardado = dam.declaracion_agente || {}
    _ctx = { dam, ci, bls: bls || [], bl: (bls || [])[0] || null, lineas: lineas || [], prov: (prov || [])[0] || null,
      emp: empresaById(carpeta?.empresa_id), tasas: _tasasDe(dam, guardado._tasas) }
    const base = _desdeDAM()
    _agente = {}
    for (const c of CAMPOS) {
      const val = guardado[c[0]] ?? base[c[0]]
      if (!_vacio(val)) _agente[c[0]] = String(val)
    }
    _asegurarModal()
    $('ddTitulo').textContent = `Declaración completa · DAM ${dam.numero_dam}`
    $('ddTasaAdv').value = _ctx.tasas.adv; $('ddTasaIgv').value = _ctx.tasas.igv; $('ddTasaIpm').value = _ctx.tasas.ipm; $('ddTasaPer').value = _ctx.tasas.per
    declararEmpresaModal('modal-dam-declaracion', carpeta?.empresa_id)
    window.ddPintar()
    window.openModal('modal-dam-declaracion')
  } catch (e) { console.error('abrirDeclaracionDAM:', e); showToast('No se pudo abrir la declaración', 'danger') }
}
window.cerrarDeclaracionDAM = () => window.closeModal('modal-dam-declaracion')

window.ddGuardar = async function (confirmar) {
  try {
    _leerAgente()
    if (confirmar) {
      const prop = _propuesta()
      const difs = CAMPOS.filter(c => _estado(c, prop[c[0]], _agente[c[0]]) === 'dif').length
      const msg = difs ? `Hay ${difs} campo(s) que difieren de la propuesta. ¿Confirmas igualmente que la declaración del agente es la correcta?` : '¿Confirmar la declaración del agente?'
      if (!confirm(msg)) return
    }
    const datos = { ..._agente, _tasas: _ctx.tasas }
    for (const k of Object.keys(datos)) if (datos[k] === '') delete datos[k]
    const cambios = { declaracion_agente: datos }
    if (confirmar) cambios.declaracion_confirmada_at = new Date().toISOString()
    const ok = await update('dams', _ctx.dam.id, cambios)
    if (!ok) throw new Error('No se pudo guardar. ¿Corriste assets/sql/104_dam_levante_ajustes_declaracion.sql?')
    _ctx.dam.declaracion_agente = datos
    if (confirmar) _ctx.dam.declaracion_confirmada_at = cambios.declaracion_confirmada_at
    showToast(confirmar ? 'Declaración confirmada' : 'Borrador guardado', 'success')
    window.ddPintar()
    window.renderHojaCosteo?.()
  } catch (e) { showToast(e.message || 'No se pudo guardar', 'danger') }
}

export default { CAMPOS }
