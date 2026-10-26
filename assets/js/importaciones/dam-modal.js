// ============================================================================
// DAM-MODAL.JS — DAM de la carpeta (Ver → Editar) + Ajustes de valor / contingencias
// ============================================================================
// Etapa 3 del ciclo: despacho en Aduanas.
//   · Modal único de la DAM (reemplaza a los 2 modales viejos nuevo/editar):
//     identificación, canal, levante, valor declarado, tributos, pesos y bultos,
//     cruces automáticos contra CI / BL, y la lista de ajustes de valor.
//   · «Ajustar valor»: registra duda razonable / ajuste de valor / otros como un
//     REGISTRO ADICIONAL (dam_autoliquidaciones). La DAM original NO se toca.
//   · «Enviar al costeo»: convierte los tributos pagados del ajuste en líneas del
//     ledger con su clasificación contable (ad valorem adicional = costo NIC 2,
//     IGV/IPM = crédito fiscal, intereses = gasto financiero).
// Guarda con tolerancia: si el SQL 104 aún no se corrió, graba lo básico y avisa.
// ============================================================================
import { query, insert, update, deleteRecord, ultimoErrorInsert, esperarContextoEmpresa } from '../supabase-client.js'
import { getCurrentUser } from '../auth-supabase.js'
import { showToast, formatNumber, fechaDMY } from '../helpers.js'
import { aplicarModoVerEditar } from '../shared/ver-editar.js'
import { declararEmpresaModal } from '../empresa.js'
import { getTipoCambioDia } from '../sunat-api.js'
import { crearLineaCosto } from './costos-ledger.js'

const $ = id => document.getElementById(id)
const v = id => ($(id)?.value ?? '').toString().trim()
const num = x => { const n = parseFloat(String(x ?? '').replace(/,/g, '')); return isNaN(n) ? null : n }
const n0 = x => num(x) || 0
const n2 = x => formatNumber(n0(x), 2)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const CANALES = { verde: ['Verde', '#10b981'], naranja: ['Naranja', '#f59e0b'], rojo: ['Rojo', '#ef4444'] }
export const MOTIVOS = { duda_razonable: 'Duda razonable (valor)', ajuste_valor: 'Ajuste de valor', error_clasificacion: 'Error de clasificación', otro: 'Otro' }
const ESTADOS_AJ = { pendiente: ['Pendiente', '#f59e0b'], pagada: ['Pagada', '#10b981'], desestimada: ['Desestimada', '#6b7280'] }

let _dam = null        // DAM abierta (null = nueva)
let _ref = { ci: null, bls: [] }
let _aj = null         // ajuste abierto (null = nuevo)
let _ajustes = []

const carpeta = () => window.carpetaActual || null
const ciActual = () => window.costeoActual?.id ? window.costeoActual : null

// ── Guardado tolerante a columnas que aún no existen (SQL sin correr) ──────────
async function _guardarTolerante(tabla, id, fila) {
  const quitadas = []
  let datos = { ...fila }
  for (let i = 0; i < 12; i++) {
    const res = id ? await update(tabla, id, datos) : await insert(tabla, datos)
    if (res) return { res, quitadas }
    const msg = ultimoErrorInsert()?.message || ''
    const m = msg.match(/Could not find the '([^']+)' column/i) || msg.match(/column "?([a-z_0-9]+)"? .*does not exist/i) || msg.match(/column "([a-z_0-9]+)" of relation/i)
    if (!m || !(m[1] in datos)) return { res: null, quitadas, error: msg }
    quitadas.push(m[1]); delete datos[m[1]]
  }
  return { res: null, quitadas, error: 'No se pudo guardar' }
}

// ── Fecha/hora del levante (timestamptz ⇄ datetime-local) ─────────────────────
const _aLocalInput = iso => {
  if (!iso) return ''
  const d = new Date(iso); if (isNaN(d)) return ''
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const _deLocalInput = s => s ? new Date(s).toISOString() : null
const _fechaHora = iso => { if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return ''; return `${fechaDMY(_aLocalInput(iso).slice(0, 10))} ${_aLocalInput(iso).slice(11)}` }

// ============================================================================
// MODAL DE LA DAM
// ============================================================================
function _asegurarModalDAM() {
  if ($('modal-dam-carpeta')) return
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-dam-carpeta" class="modal">
    <div class="modal-content" style="width:min(96vw, 980px); max-width:min(96vw, 980px); max-height:calc(100vh - 48px); overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title" id="dmTitulo">DAM</h3>
        <button class="modal-close" onclick="window.cerrarDAM()">&times;</button>
      </div>
      <div style="padding:6px 20px 0;">
        <strong class="mod-sec">Identificación del despacho</strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group" style="grid-column:span 2;"><label>N° de DAM * <small style="font-weight:400;">completo, ej. 118-2026-10-436155-01-7-00</small></label><input type="text" id="dmNro" maxlength="40"></div>
          <div class="form-group"><label>Fecha de numeración *</label><input type="date" id="dmFecha"></div>
          <div class="form-group"><label>Canal de control</label>
            <select id="dmCanal"><option value="">— sin canal —</option><option value="verde">🟢 Verde</option><option value="naranja">🟠 Naranja</option><option value="rojo">🔴 Rojo</option></select></div>
          <div class="form-group"><label>Modalidad de despacho</label>
            <select id="dmModalidad"><option value="">—</option><option>Anticipado</option><option>Excepcional</option><option>Diferido</option><option>Urgente</option></select></div>
          <div class="form-group" style="grid-column:span 2;"><label>Agente de aduana</label><input type="text" id="dmAgente" maxlength="80" placeholder="Razón social del agente"></div>
          <div class="form-group"><label>Estado</label>
            <select id="dmEstado"><option value="pendiente">Pendiente</option><option value="pagado">Pagado</option></select></div>
          <div class="form-group" style="grid-column:span 2;"><label>Depósito temporal / terminal</label><input type="text" id="dmDeposito" maxlength="100"></div>
          <div class="form-group"><label>Llegada de la nave</label><input type="date" id="dmLlegada"></div>
          <div class="form-group"><label>Levante autorizado</label><input type="datetime-local" id="dmLevante"></div>
        </div>

        <strong class="mod-sec">Valor en aduana declarado <small style="text-transform:none; letter-spacing:0; font-weight:400;">(original de la DAM; los ajustes se registran aparte)</small></strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group"><label>FOB USD</label><input type="number" id="dmFOB" step="0.001" oninput="window.dmRecalcular()"></div>
          <div class="form-group"><label>Flete USD</label><input type="number" id="dmFlete" step="0.01" oninput="window.dmRecalcular()"></div>
          <div class="form-group"><label>Seguro USD</label><input type="number" id="dmSeguro" step="0.01" oninput="window.dmRecalcular()"></div>
          <div class="form-group"><label>CIF USD <small style="font-weight:400;">(FOB + flete + seguro)</small></label><input type="number" id="dmCIF" step="0.001" data-siempre-lectura></div>
        </div>

        <strong class="mod-sec">Tributos liquidados</strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group"><label>Ad valorem USD</label><input type="number" id="dmAdv" step="0.01" oninput="window.dmRecalcular()"></div>
          <div class="form-group"><label>IPM USD</label><input type="number" id="dmIPM" step="0.01" oninput="window.dmRecalcular()"></div>
          <div class="form-group"><label>IGV USD</label><input type="number" id="dmIGV" step="0.01" oninput="window.dmRecalcular()"></div>
          <div class="form-group"><label>Total liquidación USD</label><input type="number" id="dmTotal" step="0.01" data-siempre-lectura></div>
          <div class="form-group"><label>Percepción S/</label><input type="number" id="dmPercep" step="0.01"></div>
          <div class="form-group"><label>Fecha de pago de tributos</label><input type="date" id="dmFechaPago" onchange="window.dmTC()"></div>
          <div class="form-group"><label>T.C. venta SUNAT <button type="button" class="btn btn-secondary btn-small" data-solo-edicion onclick="window.dmTC(true)" title="Consultar T.C. de la fecha de pago">⟳</button></label><input type="number" id="dmTC" step="0.001"></div>
        </div>
        <div id="dmTCaviso" style="font-size:.78rem; color:var(--text-secondary); margin-top:-4px;"></div>

        <strong class="mod-sec">Mercadería despachada</strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group"><label>Bultos</label><input type="number" id="dmBultos" step="1"></div>
          <div class="form-group"><label>Peso bruto (kg)</label><input type="number" id="dmPesoBruto" step="0.001"></div>
          <div class="form-group"><label>Peso neto (kg)</label><input type="number" id="dmPesoNeto" step="0.001"></div>
        </div>

        <strong class="mod-sec">Cruces automáticos <small style="text-transform:none; letter-spacing:0; font-weight:400;">(DAM contra CI y BL)</small></strong>
        <div id="dmAuditoria" class="dm-cruces"></div>

        <div id="dmBloqueAjustes">
          <strong class="mod-sec">Ajustes de valor y contingencias <small style="text-transform:none; letter-spacing:0; font-weight:400;">(se suman a la DAM, no la reemplazan)</small></strong>
          <div id="dmAjustes"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="dmBtnDeclaracion" onclick="window.abrirDeclaracionDAM()">📋 Declaración completa</button>
        <button class="btn btn-secondary" id="dmBtnAjustar" onclick="window.abrirAjusteValor()">⚖️ Ajustar valor</button>
        <button class="btn btn-secondary" id="dmBtnCosteo" data-solo-lectura onclick="window.enviarDAMCosteo()" title="Crea las líneas de tributos de la DAM en el costeo">➡ Tributos al costeo</button>
        <button class="btn btn-secondary" data-solo-lectura onclick="window.cerrarDAM()">Cerrar</button>
        <button class="btn btn-primary" data-solo-lectura onclick="window.dmEditar()">✏️ Editar</button>
        <button class="btn btn-secondary" data-solo-edicion onclick="window.dmCancelar()">Cancelar</button>
        <button class="btn btn-primary" data-solo-edicion onclick="window.guardarDAMCarpeta()">💾 Guardar DAM</button>
      </div>
    </div>
  </div>`)
}

const CAMPOS_DAM = [
  ['dmNro', 'numero_dam'], ['dmFecha', 'fecha_dam'], ['dmCanal', 'canal_aduanero'], ['dmModalidad', 'modalidad_despacho'],
  ['dmAgente', 'agente_aduana'], ['dmEstado', 'estado'], ['dmDeposito', 'deposito_temporal'], ['dmLlegada', 'fecha_llegada'],
  ['dmFOB', 'valor_fob'], ['dmFlete', 'flete_maritimo'], ['dmSeguro', 'seguro_maritimo'],
  ['dmAdv', 'ad_valorem_usd'], ['dmIPM', 'imp_usd'], ['dmIGV', 'igv_usd'], ['dmPercep', 'percepcion'],
  ['dmFechaPago', 'fecha_pago'], ['dmTC', 'tipo_cambio'], ['dmBultos', 'bultos'], ['dmPesoBruto', 'peso_bruto_kg'], ['dmPesoNeto', 'peso_neto_kg']
]
const NUEVAS_DAM = ['canal_aduanero', 'modalidad_despacho', 'agente_aduana', 'deposito_temporal', 'fecha_llegada', 'fecha_levante', 'bultos', 'peso_bruto_kg', 'peso_neto_kg']

function _volcarDAM(dam, ref) {
  for (const [id, col] of CAMPOS_DAM) { const el = $(id); if (el) el.value = dam?.[col] ?? '' }
  $('dmLevante').value = _aLocalInput(dam?.fecha_levante)
  if (!dam) {   // DAM nueva: sugerir desde el CI y el BL ya registrados (se puede corregir)
    const { ci, bls } = ref
    if (ci) {
      $('dmFOB').value = n0(ci.valor_total_final_fob) || ''
      $('dmFlete').value = n0(ci.costo_flete) || ''
      $('dmSeguro').value = n0(ci.costo_seguro) || ''
      $('dmPesoNeto').value = n0(ci.cantidad_total_neto) || ''
    }
    if (bls.length) {
      $('dmBultos').value = bls.reduce((t, b) => t + n0(b.bultos), 0) || ''
      $('dmPesoBruto').value = bls.reduce((t, b) => t + n0(b.peso_bruto), 0) || ''
      if (bls[0].fecha_llegada) $('dmLlegada').value = bls[0].fecha_llegada
    }
    $('dmEstado').value = 'pendiente'
  }
  $('dmTCaviso').textContent = ''
  window.dmRecalcular()
}

window.dmRecalcular = function () {
  const fob = n0(v('dmFOB')), fl = n0(v('dmFlete')), sg = n0(v('dmSeguro'))
  $('dmCIF').value = (fob + fl + sg) ? (fob + fl + sg).toFixed(3) : ''
  const tot = n0(v('dmAdv')) + n0(v('dmIPM')) + n0(v('dmIGV'))
  $('dmTotal').value = tot ? tot.toFixed(2) : ''
  _pintarCruces()
}

window.dmTC = async function (forzar) {
  const f = v('dmFechaPago'); const aviso = $('dmTCaviso')
  if (!f) { if (forzar === true) showToast('Primero indica la fecha de pago de tributos', 'warning'); return }
  if (!forzar && v('dmTC') && _dam?.tipo_cambio) return
  aviso.textContent = 'Consultando T.C. SUNAT…'
  try {
    const r = await getTipoCambioDia(f, { permitirApi: forzar === true })
    if (r?.venta) { $('dmTC').value = Number(r.venta).toFixed(3); aviso.textContent = `T.C. venta SUNAT del ${fechaDMY(f)}: ${Number(r.venta).toFixed(3)} (${r.origen})` }
    else aviso.textContent = r?.error || 'Sin T.C. guardado para esa fecha: pulsa ⟳ para consultarlo.'
  } catch { aviso.textContent = 'No se pudo consultar el T.C.' }
}

// ── Cruces DAM ⇄ CI ⇄ BL ──────────────────────────────────────────────────────
function _pintarCruces() {
  const host = $('dmAuditoria'); if (!host) return
  const { ci, bls } = _ref
  if (!ci) { host.innerHTML = '<div class="dm-nota">Sin Commercial Invoice para comparar.</div>'; return }
  const sBL = k => bls.reduce((t, b) => t + n0(b[k]), 0)
  const filas = []
  const fila = (lbl, dam, otro, otroTxt, tol, nota) => {
    if (!n0(dam) || !n0(otro)) return
    const d = n0(dam) - n0(otro)
    const ok = Math.abs(d) <= tol
    filas.push(`<div class="dm-cruce ${ok ? 'ok' : 'warn'}"><span class="dm-cruce-ico">${ok ? '✔' : '⚠'}</span>
      <div><b>${lbl}</b> · DAM ${n2(dam)} · ${otroTxt} ${n2(otro)}${ok ? '' : ` · <b>diferencia ${d > 0 ? '+' : ''}${n2(d)}</b>`}${!ok && nota ? `<div class="dm-nota">${nota}</div>` : ''}</div></div>`)
  }
  if (bls.length) {
    fila('Bultos', v('dmBultos'), sBL('bultos'), 'BL', 0.5)
    fila('Peso bruto (kg)', v('dmPesoBruto'), sBL('peso_bruto'), 'BL', 0.5, 'El peso bruto del despacho puede diferir del BL si el terminal pesó el contenedor; confírmalo con tu agente.')
  }
  fila('Peso neto (kg)', v('dmPesoNeto'), ci.cantidad_total_neto, 'CI', 0.5)
  fila('FOB (USD)', v('dmFOB'), ci.valor_total_final_fob, 'CI', 0.05, 'La DAM trae un FOB distinto al del CI (suele ser un ajuste que el agente suma a la factura). Pídele que te diga el concepto.')
  fila('Flete (USD)', v('dmFlete'), ci.costo_flete, 'CI', 0.05)
  fila('Seguro (USD)', v('dmSeguro'), ci.costo_seguro, 'CI', 0.05)
  fila('CIF (USD)', v('dmCIF'), ci.valor_total_final_ci, 'factura CI', 0.05, 'El CIF de la DAM es distinto al total de la factura del proveedor.')
  const blFlete = n0(sBL('flete_prepago_usd')) + n0(sBL('flete_destino_usd'))
  const cny = sBL('flete_prepago_cny')
  if (bls.length && (blFlete || cny)) {
    filas.push(`<div class="dm-cruce info"><span class="dm-cruce-ico">ℹ</span><div><b>Flete del BL</b> · USD ${n2(sBL('flete_prepago_usd'))} prepagado${cny ? ` + CNY ${n2(cny)}` : ''}${sBL('flete_destino_usd') ? ` + USD ${n2(sBL('flete_destino_usd'))} por cobrar en destino` : ''} · flete declarado en la DAM: USD ${n2(v('dmFlete'))}</div></div>`)
  }
  host.innerHTML = filas.length ? filas.join('') : '<div class="dm-nota">Aún no hay datos para cruzar: completa la DAM y el BL.</div>'
}

// ── Ajustes (lista dentro del modal de la DAM) ───────────────────────────────
export async function cargarAjustes(damId) {
  if (!damId) return []
  const r = await query('dam_autoliquidaciones', { dam_id: damId })
  return (r || []).sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)))
}

async function _pintarAjustes() {
  const host = $('dmAjustes'); if (!host) return
  const bloque = $('dmBloqueAjustes')
  if (!_dam) { bloque.style.display = 'none'; return }
  bloque.style.display = ''
  _ajustes = await cargarAjustes(_dam.id)
  if (!_ajustes.length) { host.innerHTML = '<div class="dm-nota">Sin ajustes. Si Aduanas notifica duda razonable o pide más tributos, pulsa «⚖️ Ajustar valor».</div>'; return }
  const tot = a => n0(a.ad_valorem_usd) + n0(a.ipm_usd) + n0(a.igv_usd) + n0(a.intereses_usd)
  host.innerHTML = `<div style="overflow-x:auto;"><table class="dm-tabla"><thead><tr><th>Motivo</th><th>N° liquidación</th><th>Notificada</th><th>Pagada</th><th style="text-align:right;">Valor adicional</th><th style="text-align:right;">Tributos pagados</th><th>Estado</th><th></th></tr></thead><tbody>
    ${_ajustes.map(a => {
      const [et, col] = ESTADOS_AJ[a.estado] || ESTADOS_AJ.pendiente
      const envia = a.estado === 'pagada' && !a.enviada_costeo
      return `<tr><td>${esc(MOTIVOS[a.motivo] || a.motivo)}</td><td>${esc(a.numero)}</td><td>${a.fecha_notificacion ? fechaDMY(a.fecha_notificacion) : '—'}</td><td>${a.fecha_pago ? fechaDMY(a.fecha_pago) : '—'}</td>
        <td style="text-align:right;">${n0(a.valor_adicional_usd) ? '+ $ ' + n2(a.valor_adicional_usd) : '—'}</td><td style="text-align:right;"><b>$ ${n2(tot(a))}</b></td>
        <td><span class="cr-chip" style="--c:${col};">${et}</span>${a.enviada_costeo ? ' <span class="cr-chip" style="--c:#3b82f6;">En costeo</span>' : ''}</td>
        <td style="white-space:nowrap;"><button type="button" class="btn btn-secondary btn-small" onclick="window.abrirAjusteValor(${a.id})">👁 Ver</button>
          ${envia ? `<button type="button" class="btn btn-primary btn-small" onclick="window.enviarAjusteCosteo(${a.id})">➡ Enviar al costeo</button>` : ''}</td></tr>`
    }).join('')}</tbody></table></div>`
}

// ── Abrir / guardar la DAM ─────────────────────────────────────────────────
window.abrirDAM = async function (id) {
  try {
    await esperarContextoEmpresa()
    const ci = ciActual()
    if (!ci) { showToast('Esta carpeta aún no tiene Commercial Invoice: registra primero el CI', 'warning'); return }
    _asegurarModalDAM()
    _dam = id ? ((await query('dams', { id })) || [])[0] || null : null
    const bls = (await query('bill_of_ladings', { importacion_id: ci.id })) || []
    _ref = { ci, bls }
    $('dmTitulo').textContent = _dam ? `DAM ${_dam.numero_dam}` : 'Nueva DAM'
    declararEmpresaModal('modal-dam-carpeta', carpeta()?.empresa_id)
    _volcarDAM(_dam, _ref)
    $('dmBtnDeclaracion').style.display = _dam ? '' : 'none'
    $('dmBtnAjustar').style.display = _dam ? '' : 'none'
    aplicarModoVerEditar('modal-dam-carpeta', !!_dam)
    window.openModal('modal-dam-carpeta')
    await _pintarAjustes()
  } catch (e) { console.error('abrirDAM:', e); showToast('No se pudo abrir la DAM', 'danger') }
}
window.editarDAM = id => window.abrirDAM(id)
window.abrirNuevaDAM = () => window.abrirDAM()
window.dmEditar = () => aplicarModoVerEditar('modal-dam-carpeta', false)
window.dmCancelar = () => { if (_dam) { _volcarDAM(_dam, _ref); aplicarModoVerEditar('modal-dam-carpeta', true) } else window.cerrarDAM() }
window.cerrarDAM = () => { window.closeModal('modal-dam-carpeta'); window.renderHojaCosteo?.(); window.renderDAM?.() }

window.guardarDAMCarpeta = async function () {
  try {
    const ci = ciActual(); if (!ci) throw new Error('Falta el Commercial Invoice de la carpeta')
    if (!v('dmNro')) throw new Error('Falta el N° de DAM')
    if (!v('dmFecha')) throw new Error('Falta la fecha de numeración')
    const fechaPago = v('dmFechaPago') || null, tc = num(v('dmTC')) || 0
    const adv = n0(v('dmAdv')), ipm = n0(v('dmIPM')), igv = n0(v('dmIGV')), per = n0(v('dmPercep'))
    if (fechaPago && fechaPago < v('dmFecha')) throw new Error('La fecha de pago de tributos no puede ser anterior a la fecha de la DAM')
    if (v('dmEstado') === 'pagado' && !fechaPago) throw new Error('Una DAM pagada necesita la fecha de pago de tributos (de ahí sale el T.C.)')
    if ((adv + ipm + igv + per > 0 || v('dmEstado') === 'pagado') && !(tc >= 1 && tc <= 10)) throw new Error('Ingresa el T.C. venta SUNAT de la fecha de pago (usa ⟳)')

    const fila = { importacion_id: ci.id }
    for (const [id, col] of CAMPOS_DAM) {
      const val = v(id)
      fila[col] = val === '' ? null : (/^(valor_|flete|seguro|ad_valorem|imp_usd|igv_usd|percepcion|tipo_cambio|peso_|bultos)/.test(col) ? num(val) : val)
    }
    fila.fecha_levante = _deLocalInput(v('dmLevante'))
    fila.valor_cif = num(v('dmCIF')) || 0
    fila.total_liquidacion = adv + ipm + igv
    fila.total_liquidacion_sol = tc ? +((adv + ipm + igv) * tc).toFixed(2) : 0
    if (!_dam && carpeta()?.id) fila.carpeta_importacion_id = carpeta().id
    for (const k of ['ad_valorem_usd', 'imp_usd', 'igv_usd', 'percepcion', 'valor_fob', 'flete_maritimo', 'seguro_maritimo']) if (fila[k] == null) fila[k] = 0

    const { res, quitadas, error } = await _guardarTolerante('dams', _dam?.id, fila)
    if (!res) throw new Error(error || 'No se pudo guardar la DAM')
    const nuevas = quitadas.filter(c => NUEVAS_DAM.includes(c) || c === 'fecha_pago')
    if (nuevas.length) showToast('DAM guardada SIN algunos campos nuevos: falta correr assets/sql/104_dam_levante_ajustes_declaracion.sql', 'warning')
    else showToast('DAM guardada', 'success')
    window.closeModal('modal-dam-carpeta')
    window.renderHojaCosteo?.(); window.renderDAM?.()
  } catch (e) { showToast(e.message || 'No se pudo guardar la DAM', 'danger') }
}

// ============================================================================
// MODAL «AJUSTAR VALOR»
// ============================================================================
function _asegurarModalAjuste() {
  if ($('modal-dam-ajuste')) return
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-dam-ajuste" class="modal">
    <div class="modal-content" style="width:min(96vw, 900px); max-width:min(96vw, 900px); max-height:calc(100vh - 48px); overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title" id="ajTitulo">Ajustar valor</h3>
        <button class="modal-close" onclick="window.cerrarAjusteValor()">&times;</button>
      </div>
      <div style="padding:6px 20px 0;">
        <div class="dm-explica">💡 Esto <b>no cambia</b> la DAM original. Registra lo que Aduanas te pidió después (duda razonable, más tributos) como un ajuste adicional. Así ves siempre el valor declarado y el valor final por separado.</div>

        <strong class="mod-sec">Qué pasó</strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group" style="grid-column:span 2;"><label>Motivo</label>
            <select id="ajMotivo">${Object.entries(MOTIVOS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
          <div class="form-group"><label>N° de notificación</label><input type="text" id="ajNotif" maxlength="40" placeholder="118-2026-34680"></div>
          <div class="form-group"><label>Fecha de notificación</label><input type="date" id="ajFechaNotif"></div>
          <div class="form-group"><label>N° de liquidación / autoliquidación *</label><input type="text" id="ajNumero" maxlength="40" placeholder="118-329439-26"></div>
          <div class="form-group"><label>Fecha de liquidación *</label><input type="date" id="ajFecha"></div>
          <div class="form-group"><label>Fecha de pago</label><input type="date" id="ajFechaPago" onchange="window.ajTC()"></div>
          <div class="form-group"><label>T.C. venta SUNAT <button type="button" class="btn btn-secondary btn-small" onclick="window.ajTC(true)" title="Consultar T.C.">⟳</button></label><input type="number" id="ajTC" step="0.001"></div>
        </div>

        <strong class="mod-sec">Diferencia de valor <small style="text-transform:none; letter-spacing:0; font-weight:400;">(duda razonable)</small></strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group" style="grid-column:span 2;"><label>Indicador de precios de SUNAT</label><input type="text" id="ajIndicador" maxlength="60" placeholder="118-10-2026-80787 (Item 4)"></div>
          <div class="form-group"><label>FOB unitario declarado</label><input type="number" id="ajFobDecl" step="0.000001" oninput="window.ajRecalcular()"></div>
          <div class="form-group"><label>FOB unitario de referencia</label><input type="number" id="ajFobRef" step="0.000001" oninput="window.ajRecalcular()"></div>
          <div class="form-group" style="grid-column:span 2;"><label>Valor adicional en aduana USD <small style="font-weight:400;">(referencia − declarado) × kg neto</small></label><input type="number" id="ajValorAdic" step="0.01" oninput="window.ajRecalcular(true)"></div>
          <div class="form-group" style="grid-column:span 2; align-self:end;"><button type="button" class="btn btn-secondary" data-solo-edicion onclick="window.ajEstimarTributos()">🧮 Estimar tributos con las tasas de la DAM</button></div>
        </div>

        <strong class="mod-sec">Tributos que pagaste por este ajuste</strong>
        <div style="display:grid; grid-template-columns:repeat(5, 1fr); gap:10px;">
          <div class="form-group"><label>Ad valorem USD</label><input type="number" id="ajAdv" step="0.01" oninput="window.ajRecalcular(true)"></div>
          <div class="form-group"><label>IPM USD</label><input type="number" id="ajIPM" step="0.01" oninput="window.ajRecalcular(true)"></div>
          <div class="form-group"><label>IGV USD</label><input type="number" id="ajIGV" step="0.01" oninput="window.ajRecalcular(true)"></div>
          <div class="form-group"><label>Intereses USD</label><input type="number" id="ajInt" step="0.01" oninput="window.ajRecalcular(true)"></div>
          <div class="form-group"><label>Total pagado USD</label><input type="number" id="ajTotal" step="0.01" data-siempre-lectura></div>
        </div>
        <div id="ajDestino" class="dm-nota"></div>

        <strong class="mod-sec">Garantía y estado</strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group"><label>Garantía</label>
            <select id="ajGarTipo"><option value="">Ninguna</option><option value="deposito">Depósito</option><option value="carta_fianza">Carta fianza</option><option value="poliza">Póliza</option></select></div>
          <div class="form-group"><label>Monto de la garantía USD</label><input type="number" id="ajGarMonto" step="0.01"></div>
          <div class="form-group"><label>Estado</label>
            <select id="ajEstado"><option value="pendiente">Pendiente de pago</option><option value="pagada">Pagada</option><option value="desestimada">Desestimada (se sustentó el precio)</option></select></div>
          <div class="form-group" style="grid-column:span 4;"><label>Observaciones</label><textarea id="ajObs" rows="2"></textarea></div>
        </div>
        <div class="dm-nota" id="ajAdjuntos">📎 Adjunta la notificación, la orden de garantía y la liquidación desde «Documentos de la carpeta» (tipos: Notificación de Aduanas, Autoliquidación, Liquidación).
          <button type="button" class="btn btn-secondary btn-small" onclick="window.abrirAdjuntosCarpeta?.()">Abrir documentos</button></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-danger" id="ajBtnEliminar" data-solo-edicion onclick="window.eliminarAjusteValor()">🗑 Eliminar</button>
        <button class="btn btn-secondary" data-solo-lectura onclick="window.cerrarAjusteValor()">Cerrar</button>
        <button class="btn btn-primary" data-solo-lectura onclick="window.ajEditar()">✏️ Editar</button>
        <button class="btn btn-secondary" data-solo-edicion onclick="window.ajCancelar()">Cancelar</button>
        <button class="btn btn-primary" data-solo-edicion onclick="window.guardarAjusteValor()">💾 Guardar ajuste</button>
      </div>
    </div>
  </div>`)
}

const CAMPOS_AJ = [
  ['ajMotivo', 'motivo'], ['ajNotif', 'numero_notificacion'], ['ajFechaNotif', 'fecha_notificacion'], ['ajNumero', 'numero'], ['ajFecha', 'fecha'],
  ['ajFechaPago', 'fecha_pago'], ['ajTC', 'tipo_cambio'], ['ajIndicador', 'indicador_precio'], ['ajFobDecl', 'fob_unitario_declarado'],
  ['ajFobRef', 'fob_unitario_referencia'], ['ajValorAdic', 'valor_adicional_usd'], ['ajAdv', 'ad_valorem_usd'], ['ajIPM', 'ipm_usd'], ['ajIGV', 'igv_usd'],
  ['ajInt', 'intereses_usd'], ['ajGarTipo', 'garantia_tipo'], ['ajGarMonto', 'garantia_monto'], ['ajEstado', 'estado'], ['ajObs', 'observaciones']
]
const NUEVAS_AJ = ['numero_notificacion', 'fecha_notificacion', 'fecha_pago', 'indicador_precio', 'fob_unitario_declarado', 'fob_unitario_referencia', 'valor_adicional_usd']

function _volcarAjuste(a) {
  for (const [id, col] of CAMPOS_AJ) { const el = $(id); if (el) el.value = a?.[col] ?? (id === 'ajMotivo' ? 'duda_razonable' : id === 'ajEstado' ? 'pendiente' : '') }
  if (!a && _dam) {   // ajuste nuevo: FOB unitario declarado = FOB de la DAM ÷ kg neto
    const kg = n0(_dam.peso_neto_kg) || n0(_ref.ci?.cantidad_total_neto)
    if (kg && n0(_dam.valor_fob)) $('ajFobDecl').value = (n0(_dam.valor_fob) / kg).toFixed(6)
  }
  window.ajRecalcular()
}

window.ajRecalcular = function (manual) {
  if (manual !== true) {   // al cambiar los FOB unitarios se recalcula el valor adicional
    const kg = n0(_dam?.peso_neto_kg) || n0(_ref.ci?.cantidad_total_neto)
    const d = num(v('ajFobDecl')), r = num(v('ajFobRef'))
    if (kg && d != null && r != null && r > d) $('ajValorAdic').value = ((r - d) * kg).toFixed(2)
  }
  const tot = n0(v('ajAdv')) + n0(v('ajIPM')) + n0(v('ajIGV')) + n0(v('ajInt'))
  $('ajTotal').value = tot ? tot.toFixed(2) : ''
  $('ajDestino').innerHTML = tot ? `Al enviarlo al costeo: ad valorem <b>$ ${n2(v('ajAdv'))}</b> → costo de la mercadería (NIC 2) · IGV + IPM <b>$ ${n2(n0(v('ajIGV')) + n0(v('ajIPM')))}</b> → crédito fiscal · intereses <b>$ ${n2(v('ajInt'))}</b> → gasto financiero. El valor adicional (<b>$ ${n2(v('ajValorAdic'))}</b>) solo es base de tributos: no se le paga al proveedor.` : ''
}

window.ajEstimarTributos = function () {
  const adic = n0(v('ajValorAdic')); if (!adic) { showToast('Primero indica el valor adicional (o los FOB unitarios)', 'warning'); return }
  const cif = n0(_dam?.valor_cif) || (n0(_dam?.valor_fob) + n0(_dam?.flete_maritimo) + n0(_dam?.seguro_maritimo))
  const tAdv = cif && n0(_dam?.ad_valorem_usd) ? n0(_dam.ad_valorem_usd) / cif : 0.06
  const base = cif + n0(_dam?.ad_valorem_usd)
  const tIgv = base && n0(_dam?.igv_usd) ? n0(_dam.igv_usd) / base : 0.155
  const tIpm = base && n0(_dam?.imp_usd) ? n0(_dam.imp_usd) / base : 0.025
  const adv = adic * tAdv
  $('ajAdv').value = adv.toFixed(2); $('ajIGV').value = ((adic + adv) * tIgv).toFixed(2); $('ajIPM').value = ((adic + adv) * tIpm).toFixed(2)
  window.ajRecalcular(true)
  showToast('Estimación con las tasas de tu DAM. Cámbiala por los montos exactos de la liquidación.', 'info')
}

window.ajTC = async function (forzar) {
  const f = v('ajFechaPago') || v('ajFecha'); if (!f) { if (forzar === true) showToast('Indica la fecha de pago', 'warning'); return }
  if (!forzar && v('ajTC')) return
  try {
    const r = await getTipoCambioDia(f, { permitirApi: forzar === true })
    if (r?.venta) $('ajTC').value = Number(r.venta).toFixed(3)
    else if (forzar === true) showToast(r?.error || 'Sin T.C. para esa fecha', 'warning')
  } catch { if (forzar === true) showToast('No se pudo consultar el T.C.', 'danger') }
}

window.abrirAjusteValor = async function (ajusteId) {
  try {
    await esperarContextoEmpresa()
    if (!($('modal-dam-carpeta')?.classList.contains('show') && _dam)) {   // abierto desde la hoja: tomar la DAM de la carpeta
      const ci = ciActual(); if (!ci) { showToast('Esta carpeta aún no tiene Commercial Invoice', 'warning'); return }
      _dam = ((await query('dams', { importacion_id: ci.id })) || [])[0] || null
      _ref = { ci, bls: (await query('bill_of_ladings', { importacion_id: ci.id })) || [] }
    }
    if (!_dam) { showToast('Primero registra la DAM de la carpeta', 'warning'); return }
    _asegurarModalAjuste()
    _aj = ajusteId ? ((await query('dam_autoliquidaciones', { id: ajusteId })) || [])[0] || null : null
    $('ajTitulo').textContent = _aj ? `Ajuste ${_aj.numero}` : `Ajustar valor · DAM ${_dam.numero_dam}`
    _volcarAjuste(_aj)
    $('ajBtnEliminar').style.display = _aj && !_aj.enviada_costeo ? '' : 'none'
    aplicarModoVerEditar('modal-dam-ajuste', !!_aj)
    if (_aj?.enviada_costeo) $('ajDestino').innerHTML += '<br>🔒 Ya está en el costeo: para corregir montos edita sus líneas en el ledger de costos.'
    window.openModal('modal-dam-ajuste')
  } catch (e) { console.error('abrirAjusteValor:', e); showToast('No se pudo abrir el ajuste', 'danger') }
}
window.ajEditar = () => {
  aplicarModoVerEditar('modal-dam-ajuste', false)
  if (_aj?.enviada_costeo) ['ajAdv', 'ajIPM', 'ajIGV', 'ajInt', 'ajEstado'].forEach(id => { $(id).disabled = true })
}
window.ajCancelar = () => { if (_aj) { _volcarAjuste(_aj); aplicarModoVerEditar('modal-dam-ajuste', true) } else window.cerrarAjusteValor() }
window.cerrarAjusteValor = async () => {
  window.closeModal('modal-dam-ajuste')
  if ($('modal-dam-carpeta')?.classList.contains('show')) await _pintarAjustes()
  window.renderHojaCosteo?.()
}

window.guardarAjusteValor = async function () {
  try {
    if (!_dam) throw new Error('Falta la DAM')
    if (!v('ajNumero')) throw new Error('Falta el N° de liquidación')
    if (!v('ajFecha')) throw new Error('Falta la fecha de liquidación')
    if (v('ajEstado') === 'pagada' && !v('ajFechaPago')) throw new Error('Un ajuste pagado necesita su fecha de pago')
    if (v('ajEstado') === 'pagada' && n0(v('ajTotal')) > 0 && !(n0(v('ajTC')) >= 1)) throw new Error('Ingresa el T.C. venta SUNAT (usa ⟳)')
    const fila = { dam_id: _dam.id }
    for (const [id, col] of CAMPOS_AJ) {
      const val = v(id)
      fila[col] = val === '' ? null : (/^(tipo_cambio|ad_valorem|ipm|igv|intereses|valor_adicional|fob_unitario|garantia_monto)/.test(col) ? num(val) : val)
    }
    for (const k of ['ad_valorem_usd', 'ipm_usd', 'igv_usd', 'intereses_usd', 'valor_adicional_usd']) if (fila[k] == null) fila[k] = 0
    if (!fila.garantia_tipo) { fila.garantia_tipo = null; fila.garantia_monto = 0 }
    const { res, quitadas, error } = await _guardarTolerante('dam_autoliquidaciones', _aj?.id, fila)
    if (!res) throw new Error(/duplicate|unique/i.test(error || '') ? 'Ya existe un ajuste con ese N° de liquidación en esta DAM' : (error || 'No se pudo guardar el ajuste'))
    if (quitadas.some(c => NUEVAS_AJ.includes(c))) showToast('Ajuste guardado SIN algunos campos: falta correr assets/sql/104_dam_levante_ajustes_declaracion.sql', 'warning')
    else showToast('Ajuste guardado', 'success')
    await window.cerrarAjusteValor()
  } catch (e) { showToast(e.message || 'No se pudo guardar el ajuste', 'danger') }
}

window.eliminarAjusteValor = async function () {
  if (!_aj || _aj.enviada_costeo) return
  if (!confirm('¿Eliminar este ajuste? (La DAM original no se toca)')) return
  const ok = await deleteRecord('dam_autoliquidaciones', _aj.id)
  if (!ok) { showToast('No se pudo eliminar el ajuste', 'danger'); return }
  showToast('Ajuste eliminado', 'success')
  await window.cerrarAjusteValor()
}

// ── Enviar el ajuste al costeo (ledger) ────────────────────────────────────
window.enviarAjusteCosteo = async function (ajusteId) {
  try {
    const a = ((await query('dam_autoliquidaciones', { id: ajusteId })) || [])[0]
    if (!a) throw new Error('Ajuste no encontrado')
    if (a.enviada_costeo) { showToast('Este ajuste ya está en el costeo', 'info'); return }
    if (a.estado !== 'pagada') throw new Error('Solo se envía al costeo un ajuste pagado')
    const c = carpeta(); if (!c) throw new Error('Sin carpeta de importación')
    const tc = n0(a.tipo_cambio); if (tc < 1) throw new Error('El ajuste no tiene T.C.: edítalo y usa ⟳')
    const lineas = [
      ['ad_valorem_adic', 'Ad Valorem adicional (' + (MOTIVOS[a.motivo] || 'ajuste') + ')', 'tributos', 'inventario', n0(a.ad_valorem_usd)],
      ['igv', 'IGV adicional (' + (MOTIVOS[a.motivo] || 'ajuste') + ')', 'tributos', 'credito_fiscal', n0(a.igv_usd)],
      ['ipm', 'IPM adicional (' + (MOTIVOS[a.motivo] || 'ajuste') + ')', 'tributos', 'credito_fiscal', n0(a.ipm_usd)],
      ['interes', 'Intereses de la liquidación ' + a.numero, 'financiero', 'gasto_financiero', n0(a.intereses_usd)]
    ].filter(l => l[4] > 0)
    if (!lineas.length) throw new Error('El ajuste no tiene montos que enviar')
    const total = lineas.reduce((t, l) => t + l[4], 0)
    const lista = lineas.map(l => `  · ${l[1]}: $ ${n2(l[4])}`).join('\n')
    if (!confirm(`Se crearán ${lineas.length} línea(s) en el costeo de la carpeta ${c.numero_carpeta}:\n${lista}\n\nTotal $ ${n2(total)} · T.C. ${tc}. ¿Continuar?`)) return
    const user = await getCurrentUser()
    const fechaDoc = a.fecha_pago || a.fecha
    const doc = {
      tipo: 'autoliquidacion', tipo_comprobante: '50', numero: a.numero, proveedor_id: null, fecha_emision: fechaDoc,
      moneda: 'USD', tipo_cambio: tc, monto_sin_igv: total, igv_monto: 0, monto_total: total, estado_pago: 'pagado',
      es_provisional: false, sustentado: true, observaciones: 'Liquidación SUNAT · ' + (MOTIVOS[a.motivo] || a.motivo) + (a.numero_notificacion ? ' · Notif. ' + a.numero_notificacion : ''),
      empresa_id: c.empresa_id ?? undefined
    }
    let documentoId = null
    for (const [cod, nombre, grupo, clasif, monto] of lineas) {
      const linea = {
        carpeta_importacion_id: c.id, grupo, concepto: nombre, concepto_codigo: cod, clasificacion: clasif,
        moneda: 'USD', tipo_cambio: tc, monto_moneda: monto, igv_monto: 0, base_prorrateo: 'valor_fob',
        es_provisional: false, observaciones: 'Generado desde el ajuste de valor de la DAM'
      }
      const r = await crearLineaCosto(documentoId ? { id: documentoId } : doc, linea, user?.db_id)
      documentoId = r.documentoId
    }
    await update('dam_autoliquidaciones', a.id, { enviada_costeo: true })
    showToast(`Listo: ${lineas.length} línea(s) en el costeo`, 'success')
    await _pintarAjustes()
    window.renderHojaCosteo?.(); window.renderCostosLedger?.()
  } catch (e) { console.error('enviarAjusteCosteo:', e); showToast(e.message || 'No se pudo enviar al costeo', 'danger') }
}

// ── Enviar los tributos de la DAM ORIGINAL al costeo (ledger) ────────────────
window.enviarDAMCosteo = async function () {
  try {
    const d = _dam; if (!d) throw new Error('Guarda primero la DAM')
    if (d.estado !== 'pagado') throw new Error('La DAM debe estar pagada (con fecha de pago y T.C.) para enviar sus tributos')
    const c = carpeta(); if (!c) throw new Error('Sin carpeta de importación')
    const tc = n0(d.tipo_cambio); if (tc < 1) throw new Error('La DAM no tiene T.C.: edítala y usa ⟳')
    const previas = ((await query('importacion_costos', { carpeta_importacion_id: c.id })) || [])
      .filter(k => !k.anulado && ['ad_valorem', 'igv', 'ipm', 'percepcion'].includes(k.concepto_codigo) && !/adicional/i.test(k.concepto || ''))
    if (previas.length) throw new Error(`El costeo ya tiene ${previas.length} línea(s) de tributos de esta carpeta. Para no duplicar, revísalas en «Costos» antes de enviar.`)
    const lineas = [
      ['ad_valorem', 'Ad Valorem', 'tributos', 'inventario', n0(d.ad_valorem_usd), 'USD'],
      ['igv', 'IGV importación', 'tributos', 'credito_fiscal', n0(d.igv_usd), 'USD'],
      ['ipm', 'IPM', 'tributos', 'credito_fiscal', n0(d.imp_usd), 'USD'],
      ['percepcion', 'Percepción IGV importación', 'tributos', 'percepcion', n0(d.percepcion), 'PEN']
    ].filter(l => l[4] > 0)
    if (!lineas.length) throw new Error('La DAM no tiene tributos para enviar')
    const lista = lineas.map(l => `  · ${l[1]}: ${l[5] === 'PEN' ? 'S/' : '$'} ${n2(l[4])}`).join('\n')
    if (!confirm(`Se crearán ${lineas.length} línea(s) de tributos en el costeo de la carpeta ${c.numero_carpeta}:\n${lista}\n\nT.C. ${tc}. ¿Continuar?`)) return
    const user = await getCurrentUser()
    const total = n0(d.ad_valorem_usd) + n0(d.igv_usd) + n0(d.imp_usd)
    const doc = {
      tipo: 'dam', tipo_comprobante: '50', numero: d.numero_dam, proveedor_id: null, fecha_emision: d.fecha_pago || d.fecha_dam,
      moneda: 'USD', tipo_cambio: tc, monto_sin_igv: total, igv_monto: 0, monto_total: total, estado_pago: 'pagado',
      es_provisional: false, sustentado: true, observaciones: 'Tributos de la DAM ' + d.numero_dam, empresa_id: c.empresa_id ?? undefined
    }
    let documentoId = null
    for (const [cod, nombre, grupo, clasif, monto, mon] of lineas) {
      const r = await crearLineaCosto(documentoId ? { id: documentoId } : doc, {
        carpeta_importacion_id: c.id, grupo, concepto: nombre, concepto_codigo: cod, clasificacion: clasif,
        moneda: mon, tipo_cambio: tc, monto_moneda: monto, igv_monto: 0, base_prorrateo: 'valor_fob', es_provisional: false,
        observaciones: 'Generado desde la DAM'
      }, user?.db_id)
      documentoId = r.documentoId
    }
    showToast(`Listo: ${lineas.length} línea(s) de tributos en el costeo`, 'success')
    window.renderHojaCosteo?.(); window.renderCostosLedger?.()
  } catch (e) { console.error('enviarDAMCosteo:', e); showToast(e.message || 'No se pudo enviar al costeo', 'danger') }
}

export default { cargarAjustes, CANALES, MOTIVOS }
