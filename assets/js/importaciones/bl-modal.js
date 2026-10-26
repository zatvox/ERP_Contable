// ============================================================================
// BL-MODAL.JS — Bill of Lading de la carpeta (Ver → Editar), con rastreo
// ============================================================================
// Se abre desde la hoja de costeo (window.abrirBL(id?)). Guarda en
// bill_of_ladings (SQL 103 agrega booking, naviera, nave, bultos, CBM, ETA,
// llegada y fletes). Rastreo SIN API: botón que abre la página de la naviera
// con el enlace ya armado + "Pegar tracking" (pegas el texto de la página y el
// sistema detecta nave, ETA y llegada; tú revisas y guardas).
// ============================================================================
import { query, insert, update, ultimoErrorInsert, esperarContextoEmpresa } from '../supabase-client.js'
import { showToast, formatNumber } from '../helpers.js'
import { aplicarModoVerEditar } from '../shared/ver-editar.js'

const $ = id => document.getElementById(id)
const v = id => ($(id)?.value ?? '').toString().trim()
const num = x => { const n = parseFloat(String(x).replace(/,/g, '')); return isNaN(n) ? null : n }
const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

let _bl = null   // BL abierto (null = nuevo)

/** Enlace de rastreo de ONE (el BL se busca sin el prefijo ONEY). Otras navieras: abre su buscador general. */
export function urlRastreo(bl) {
  const nro = String(bl?.nro_bill_lading || '').trim().toUpperCase()
  if (!nro) return null
  if (nro.startsWith('ONEY')) {
    return `https://www.one-line.com/one-ecom/manage-shipment/cargo-tracking?trakNoParam=${nro.slice(4)}&trakNoTpCdParam=B`
  }
  return `https://www.google.com/search?q=${encodeURIComponent(`${bl?.naviera || ''} cargo tracking ${nro}`)}`
}
window.urlRastreoBL = urlRastreo

function _asegurarModal() {
  if ($('modal-bl-carpeta')) return
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-bl-carpeta" class="modal">
    <div class="modal-content" style="width:min(96vw, 860px); max-width:min(96vw, 860px); max-height:calc(100vh - 48px); overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title" id="blTitulo">Bill of Lading</h3>
        <button class="modal-close" onclick="window.cerrarBL()">&times;</button>
      </div>
      <div style="padding:6px 20px 0;">
        <strong class="mod-sec">Documento</strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group" style="grid-column:span 2;"><label>N° de BL * <span class="bl-en">(B/L No.)</span> <small style="font-weight:400;">completo, ej. ONEYNBOGE1733500</small></label><input type="text" id="blNro" maxlength="40" oninput="window.blActualizarLink()"></div>
          <div class="form-group"><label>Booking <span class="bl-en">(Booking No.)</span></label><input type="text" id="blBooking" maxlength="40"></div>
          <div class="form-group"><label>Estado</label>
            <select id="blEstado"><option value="pendiente">Pendiente</option><option value="recibido">Recibido</option><option value="despachado">Despachado</option></select></div>
          <div class="form-group"><label>Naviera <span class="bl-en">(Carrier / As carrier)</span></label><input type="text" id="blNaviera" maxlength="60" placeholder="ONE"></div>
          <div class="form-group" style="grid-column:span 2;"><label>Nave y viaje <span class="bl-en">(Ocean vessel / Voyage no.)</span></label><input type="text" id="blNave" maxlength="80" placeholder="HMM IVY 005E"></div>
          <div class="form-group"><label>Embarque a bordo <span class="bl-en">(Date laden on board)</span></label><input type="date" id="blFecha"></div>
        </div>

        <strong class="mod-sec">Contenedor y carga</strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group"><label>N° contenedor * <span class="bl-en">(Container no.)</span></label><input type="text" id="blCont" maxlength="20" style="text-transform:uppercase;"></div>
          <div class="form-group"><label>Tipo <span class="bl-en">(Type, ej. 1x40HC)</span></label>
            <select id="blTipoCont"><option>40HC</option><option>40GP</option><option>20GP</option><option>LCL</option></select></div>
          <div class="form-group"><label>Precinto <span class="bl-en">(Seal no.)</span></label><input type="text" id="blPrecinto" maxlength="30"></div>
          <div class="form-group"><label>Bultos <span class="bl-en">(Quantity / Packages)</span></label><input type="number" id="blBultos" step="1"></div>
          <div class="form-group"><label>Peso bruto (kg) <span class="bl-en">(Gross weight)</span></label><input type="number" id="blPeso" step="0.01"></div>
          <div class="form-group"><label>Volumen (CBM) <span class="bl-en">(Gross measurement)</span></label><input type="number" id="blCBM" step="0.001"></div>
          <div class="form-group"><label>ETA al puerto <span class="bl-en">(Estimated arrival)</span></label><input type="date" id="blETA"></div>
          <div class="form-group"><label>Llegada / descarga <span class="bl-en">(Discharge / Arrival)</span></label><input type="date" id="blLlegada"></div>
        </div>

        <strong class="mod-sec">Flete del BL <small style="text-transform:none; letter-spacing:0; font-weight:400;">(para auditar contra el flete del CI)</small></strong>
        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:10px;">
          <div class="form-group"><label>Prepagado USD <span class="bl-en">(Freight prepaid)</span></label><input type="number" id="blFleteUSD" step="0.01"></div>
          <div class="form-group"><label>Prepagado CNY <span class="bl-en">(Freight prepaid)</span></label><input type="number" id="blFleteCNY" step="0.01"></div>
          <div class="form-group"><label>Por cobrar en destino USD <span class="bl-en">(Freight collect)</span></label><input type="number" id="blFleteDest" step="0.01"></div>
        </div>

        <div data-solo-edicion>
          <strong class="mod-sec">Seguimiento (sin API)</strong>
          <textarea id="blPegar" rows="3" placeholder="1) Pulsa «Rastrear» y abre la página de la naviera.  2) Ctrl+A, Ctrl+C.  3) Pega aquí: el sistema detecta nave, ETA y llegada." style="width:100%;" oninput="window.blLeerTracking()"></textarea>
          <div id="blPegarRes" style="font-size:.82rem; color:var(--text-secondary); margin-top:4px;"></div>
        </div>
      </div>
      <div class="modal-footer">
        <a id="blRastrear" class="btn btn-secondary" target="_blank" rel="noopener" style="text-decoration:none;" onclick="return window.blActualizarLink(true)">🔎 Rastrear</a>
        <button class="btn btn-secondary" data-solo-lectura onclick="window.cerrarBL()">Cerrar</button>
        <button class="btn btn-primary" data-solo-lectura onclick="window.blEditar()">✏️ Editar</button>
        <button class="btn btn-secondary" data-solo-edicion onclick="window.blCancelar()">Cancelar</button>
        <button class="btn btn-primary" data-solo-edicion onclick="window.guardarBL()">💾 Guardar BL</button>
      </div>
    </div>
  </div>`)
}

window.blActualizarLink = function (soloComprobar) {
  const a = $('blRastrear'); if (!a) return true
  const url = urlRastreo({ nro_bill_lading: v('blNro'), naviera: v('blNaviera') })
  if (url) a.href = url; else a.removeAttribute('href')
  if (soloComprobar === true && !url) { showToast('Primero escribe el N° de BL', 'warning'); return false }
  return true
}

const CAMPOS = [
  ['blNro', 'nro_bill_lading'], ['blBooking', 'booking_number'], ['blEstado', 'estado'], ['blNaviera', 'naviera'], ['blNave', 'nave_viaje'],
  ['blFecha', 'fecha'], ['blCont', 'contenedor_number'], ['blTipoCont', 'tipo_contenedor'], ['blPrecinto', 'numero_precinto'],
  ['blBultos', 'bultos'], ['blPeso', 'peso_bruto'], ['blCBM', 'volumen_cbm'], ['blETA', 'fecha_eta'], ['blLlegada', 'fecha_llegada'],
  ['blFleteUSD', 'flete_prepago_usd'], ['blFleteCNY', 'flete_prepago_cny'], ['blFleteDest', 'flete_destino_usd']
]

function _volcar(bl) {
  for (const [id, col] of CAMPOS) { const el = $(id); if (el) el.value = bl?.[col] ?? (id === 'blEstado' ? 'pendiente' : id === 'blTipoCont' ? '40HC' : '') }
  if (!bl && !v('blNaviera')) $('blNaviera').value = ''
  $('blPegar').value = ''; $('blPegarRes').textContent = ''
  window.blActualizarLink()
}

window.abrirBL = async function (id) {
  try {
    await esperarContextoEmpresa()
    const ciId = window.costeoActual?.id
    if (!ciId) { showToast('Esta carpeta aún no tiene Commercial Invoice: registra primero el CI', 'warning'); return }
    _asegurarModal()
    _bl = null
    if (id) _bl = ((await query('bill_of_ladings', { id })) || [])[0] || null
    $('blTitulo').textContent = _bl ? `Bill of Lading ${_bl.nro_bill_lading}` : 'Nuevo Bill of Lading'
    _volcar(_bl)
    aplicarModoVerEditar('modal-bl-carpeta', !!_bl)
    window.openModal('modal-bl-carpeta')
  } catch (e) { console.error('abrirBL:', e); showToast('No se pudo abrir el BL', 'danger') }
}

window.blEditar = () => aplicarModoVerEditar('modal-bl-carpeta', false)
window.blCancelar = () => { if (_bl) { _volcar(_bl); aplicarModoVerEditar('modal-bl-carpeta', true) } else window.cerrarBL() }
window.cerrarBL = () => { window.closeModal('modal-bl-carpeta'); window.renderHojaCosteo?.() }

window.guardarBL = async function () {
  try {
    const ciId = window.costeoActual?.id
    if (!ciId) throw new Error('Falta el Commercial Invoice de la carpeta')
    if (!v('blNro')) throw new Error('Falta el N° de BL')
    if (!v('blCont')) throw new Error('Falta el N° de contenedor')
    const NUEVAS = ['booking_number', 'naviera', 'nave_viaje', 'tipo_contenedor', 'bultos', 'volumen_cbm', 'fecha_eta', 'fecha_llegada', 'flete_prepago_usd', 'flete_prepago_cny', 'flete_destino_usd']
    const numericos = ['bultos', 'peso_bruto', 'volumen_cbm', 'flete_prepago_usd', 'flete_prepago_cny', 'flete_destino_usd']
    const fila = { importacion_id: ciId }
    for (const [id, col] of CAMPOS) {
      let val = v(id)
      if (numericos.includes(col)) val = num(val)
      else if (val === '') val = null
      if (col === 'nro_bill_lading' || col === 'contenedor_number') val = String(val).toUpperCase()
      fila[col] = val
    }
    if (v('blPegar')) fila.tracking_actualizado = new Date().toISOString()

    const guardar = async datos => _bl ? await update('bill_of_ladings', _bl.id, datos) : await insert('bill_of_ladings', datos)
    let res = await guardar(fila)
    if (!res) {
      const msg = ultimoErrorInsert()?.message || ''
      if (/column|schema cache/i.test(msg)) {   // SQL 103 sin correr: guarda lo básico y avisa
        const basico = { ...fila }; [...NUEVAS, 'tracking_actualizado'].forEach(k => delete basico[k])
        res = await guardar(basico)
        if (res) showToast('BL guardado SIN los campos nuevos: falta correr assets/sql/103_bl_campos_y_adjuntos_origen_ficha.sql', 'warning')
      }
      if (!res) throw new Error(msg || 'No se pudo guardar el BL')
    } else showToast('Bill of Lading guardado', 'success')
    window.closeModal('modal-bl-carpeta')
    if (typeof window.renderBillOfLadings === 'function') window.renderBillOfLadings()
    window.renderHojaCosteo?.()
  } catch (e) { showToast(e.message || 'No se pudo guardar el BL', 'danger') }
}

// ─── "Pegar tracking": lectura de la página de la naviera (probado con ONE) ───
// Estándar para todos: Rastrear → Ctrl+A, Ctrl+C → pegar. Se muestra una vista previa
// y los campos solo se llenan cuando el usuario pulsa «Aplicar».
const _iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
function _fechaDe(txt) {
  const m = String(txt || '').match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/)
  return m ? _iso(m[1], m[2], m[3]) : null
}
const _fmt = iso => iso ? iso.split('-').reverse().join('/') : ''
const EVENTOS_ES = [
  [/empty container returned/i, 'Contenedor vacío devuelto al depósito (ciclo terminado)'],
  [/gate out from inbound/i, 'Contenedor salió del terminal hacia el cliente'],
  [/unloaded from vessel/i, 'Contenedor descargado de la nave'],
  [/vessel arrival at port of discharge/i, 'Nave llegó al puerto de destino'],
  [/vessel departure from port of loading/i, 'Nave zarpó del puerto de origen'],
  [/loaded on vessel/i, 'Contenedor cargado en la nave'],
  [/gate in to outbound/i, 'Contenedor ingresó al terminal de origen'],
  [/empty container release/i, 'Contenedor vacío entregado al exportador']
]
export function parsearTracking(texto) {
  const L = String(texto || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const out = {}
  // fecha del evento = 1ª fecha dentro de las 4 líneas siguientes al nombre del evento
  const evento = re => { const i = L.findIndex(l => re.test(l)); if (i < 0) return null; for (let k = i; k <= i + 4 && k < L.length; k++) { const f = _fechaDe(L[k]); if (f) return f } return null }
  const iCt = L.findIndex(l => /^[A-Z]{3}U\d{7}$/.test(l))
  if (iCt >= 0) {
    out.contenedor_number = L[iCt]
    if (iCt > 0 && /^[A-Z0-9]{9,14}$/.test(L[iCt - 1])) out.booking_number = L[iCt - 1]
    const t = L.slice(iCt + 1, iCt + 4).join(' ').match(/(20|40|45)\s*'?\s*(DRY|HC|HIGH|REEFER|RF|GP)?\s*(HC|HIGH)?/i)
    if (t) out.tipo_contenedor = '1x' + t[1] + (/HC|HIGH/i.test(`${t[2]} ${t[3]}`) ? 'HC' : (/RF|REEFER/i.test(t[2] || '') ? 'RF' : 'GP'))
  }
  const iS = L.findIndex(l => /^sailing information/i.test(l))
  if (iS >= 0) {
    const nv = L.slice(iS, iS + 14).map(l => l.match(/^([A-Z][A-Z0-9 ]{2,30}?\s\d{2,4}[A-Z]?)\s*(\([A-Z0-9]+\))?$/)).find(Boolean)
    if (nv) out.nave_viaje = nv[1].trim()
  }
  if (/ocean network express|one-line/i.test(texto)) out.naviera = 'ONE (Ocean Network Express)'
  out.fecha = evento(/^vessel departure/i) || evento(/^loaded on vessel/i) // el BL declara la fecha de zarpe como «Date laden on board»
  out.fecha_llegada = evento(/^vessel arrival at port of discharge/i)
  out.fecha_eta = out.fecha_llegada
  const ultimo = L.find(l => EVENTOS_ES.some(([re]) => re.test(l)))
  if (ultimo) {
    // el "último evento" es el que aparece primero en la tabla resumen (más reciente)
    const e = EVENTOS_ES.find(([re]) => re.test(ultimo))
    out._ultimo = `${e[1]} (${_fmt(evento(new RegExp('^' + ultimo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))))})`
  }
  Object.keys(out).forEach(k => { if (!out[k]) delete out[k] })
  return out
}
const _TRK = {
  booking_number: ['blBooking', 'Booking'], contenedor_number: ['blCont', 'Contenedor'], tipo_contenedor: ['blTipoCont', 'Tipo'],
  nave_viaje: ['blNave', 'Nave y viaje'], naviera: ['blNaviera', 'Naviera'], fecha: ['blFecha', 'Embarque a bordo'],
  fecha_eta: ['blETA', 'ETA'], fecha_llegada: ['blLlegada', 'Llegada']
}
window.blLeerTracking = function () {
  const r = parsearTracking($('blPegar').value)
  window._blTrk = r
  const filas = Object.entries(_TRK).filter(([k]) => r[k]).map(([k, [, et]]) => `<li><b>${et}:</b> ${_esc(/^fecha/.test(k) ? _fmt(r[k]) : r[k])}</li>`)
  if (!filas.length) { $('blPegarRes').innerHTML = v('blPegar') ? '⚠️ No encontré datos de seguimiento. Verifica que copiaste la página completa del rastreo (Ctrl+A, Ctrl+C) con el resultado visible.' : ''; return }
  $('blPegarRes').innerHTML = `<div style="background:var(--bg-secondary,#f4f6fa); border-radius:10px; padding:10px 12px;"><b>Esto es lo que encontré:</b><ul style="margin:6px 0 8px 18px;">${filas.join('')}</ul>${r._ultimo ? `<div style="margin-bottom:8px;">📍 <b>Estado actual:</b> ${_esc(r._ultimo)}</div>` : ''}<button type="button" class="btn btn-primary" onclick="window.blAplicarTracking()">Aplicar a la ficha</button> <small>Podrás revisar antes de guardar.</small></div>`
}
window.blAplicarTracking = function () {
  const r = window._blTrk || {}
  Object.entries(_TRK).forEach(([k, [id]]) => { if (r[k] && $(id)) $(id).value = r[k] })
  $('blPegarRes').innerHTML = '✅ Datos aplicados. Revisa los campos y pulsa «Guardar BL».'
  $('blPegar').value = ''
}

export default { urlRastreo, parsearTracking }
