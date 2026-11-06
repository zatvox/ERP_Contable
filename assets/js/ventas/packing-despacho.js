// ============================================================================
// ventas/packing-despacho.js — Despacho, PV de lista y margen del PK/cotización (2026-11-05)
// ============================================================================
// Qué hace (SQL 136):
//   1. Sección "Despacho" en el modal: el vendedor elige si el cliente RECOGE o si el
//      despacho va INCLUIDO. Con despacho: distrito + link de Google Maps (obligatorios);
//      el flete sale de la tabla de parámetros del CRM (km por distrito + kg) y es un
//      costo INTERNO: va dentro del precio de venta y se RESTA al margen.
//   2. PV de lista (lotes.precio_lista, inc. IGV): se sugiere en la línea y se avisa si
//      el precio queda por debajo. NO bloquea: se guarda con alerta y va a la campanita.
//   3. Panel de ganancia con efecto HUD según el margen (objetivo/mínimo del CRM).
// packing.js solo llama a las funciones exportadas; aquí vive toda la lógica nueva.
// ============================================================================
import { supabase, empresaTrabajoCtx } from '../supabase-client.js'
import { formatNumber } from '../helpers.js'
import { S } from './state.js'
import { coordsDeMaps, coordsDeTexto } from '../shared/maps-coords.js'

const _esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const _$ = id => document.getElementById(id)

// ── Estado del módulo ──────────────────────────────────────────────────────
let _distritos = null                       // [{distrito, km}]
let _flete = { key: '', km: null, costo: null, estado: null }
let _manual = false                         // el usuario fijó el costo a mano
let _pv = {}                                // item_id → {precio_lista, moneda, igv_incluido, igv_pct, margen_objetivo, margen_minimo}
let _pvPedidos = new Set()
let _ultGan = null                          // último cálculo para repintar el panel sin recalcular líneas
let _empresaDoc = null
let _enlazado = false

const OBJ_DEF = 20, MIN_DEF = 15            // si el CRM aún no tiene margen para la familia

function _cargarCss() {
  if (document.getElementById('css-pk-despacho')) return
  const l = document.createElement('link')
  l.id = 'css-pk-despacho'; l.rel = 'stylesheet'
  l.href = new URL('../../css/packing-despacho.css', import.meta.url).href
  document.head.appendChild(l)
}
const _emp = () => _empresaDoc ?? empresaTrabajoCtx()

// ── HTML de la sección (se inserta en packing.js después de "Datos adicionales") ──
export function htmlDespacho() {
  _cargarCss()
  return `
  <div class="pk-desp" id="pkDespSec">
    <strong style="display:block; margin-bottom:8px; color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase; letter-spacing:0.03em;">🚚 Despacho</strong>
    <div class="pk-desp-cab">
      <div class="form-group">
        <label>Término de despacho *</label>
        <select id="pkDespTermino" onchange="window._pkDespTermino()">
          <option value="">— Elige —</option>
          <option value="recoge_cliente">🏭 Recoge el cliente</option>
          <option value="despacho">🚚 Despacho incluido en el precio</option>
        </select>
      </div>
      <span class="pk-desp-chip" id="pkDespChip">Define quién lleva la mercadería</span>
    </div>
    <div class="pk-desp-cuerpo" id="pkDespCuerpo" hidden>
      <label class="pk-desp-chk full">
        <input type="checkbox" id="pkDespUsaCli" onchange="window._pkDespUsaCli()">
        <span>Usar la dirección registrada del cliente
          <div class="pk-desp-dir" id="pkDespCliTxt">Selecciona un cliente</div></span>
      </label>
      <div class="form-group full" id="pkDespDirGrp" hidden>
        <label>Dirección de entrega</label>
        <input type="text" id="pkDespDir" placeholder="Calle, número, referencia">
      </div>
      <div class="form-group">
        <label>Distrito de entrega *</label>
        <input type="text" id="pkDespDistrito" list="pkDespDistritos" placeholder="Ej.: Ate" autocomplete="off" oninput="window._pkDespDistrito()">
        <datalist id="pkDespDistritos"></datalist>
      </div>
      <div class="form-group">
        <label>Link de Google Maps *</label>
        <div class="pk-desp-maps">
          <input type="url" id="pkDespMaps" placeholder="https://maps.app.goo.gl/…" oninput="window._pkDespMapsCambio()">
          <button type="button" class="btn btn-small btn-secondary" id="pkDespMapsAbrir" onclick="window._pkDespMapsAbrir()" title="Abrir en Google Maps">📍</button>
        </div>
        <small style="color:var(--text-secondary);">Pega el enlace de la ubicación exacta de entrega.</small>
        <input type="text" id="pkDespCoord" placeholder="Coordenadas (si el link es corto): -12.0464, -77.0428" style="margin-top:6px;" oninput="window._pkDespCoordCambio()">
        <small id="pkDespCoordInfo" style="color:var(--text-secondary);"></small>
      </div>
      <div class="pk-desp-flete full">
        <span>📏 <b id="pkDespKm">—</b> km</span>
        <span>Flete interno (S/): <input type="number" id="pkDespCosto" min="0" step="0.01" style="width:110px;" oninput="window._pkDespCostoManual()"></span>
        <button type="button" class="btn btn-small" onclick="window._pkDespRecalcular()" title="Volver al cálculo automático de la tabla">↺ Recalcular</button>
        <span class="pk-desp-chip" id="pkDespEstado"></span>
        <small style="color:var(--text-secondary); flex-basis:100%;">Costo interno: no se cobra aparte, va dentro del precio y se resta de la ganancia.</small>
      </div>
    </div>
  </div>`
}

/** Atributos del bloque Ganancia (packing.js los usa en el HTML de totales). */
export const ATR_PANEL_GAN = 'id="pkPanelGan" class="pk-gan-panel" data-nivel="0"'
export const HTML_GAN_EXTRA = '<small class="pk-gan-flete" id="pkGanFlete"></small><div class="pk-gan-etq" id="pkGanEtq"></div>'
export const HTML_PV_HINT = '<div class="pk-pv-hint" id="pkPVHint"></div>'

// ── Enlaces del modal (una sola vez) ───────────────────────────────────────
export function enlazarDespacho() {
  if (_enlazado) return
  _enlazado = true
  _$('pkCliente')?.addEventListener('change', _pintarDirCliente)
  window._pkDespTermino = () => { _aplicarTermino(); _recalcFlete(true) }
  window._pkDespUsaCli = () => { _aplicarUsaCli(); _recalcFlete(true) }
  window._pkDespDistrito = () => { _manual = false; _recalcFlete(true) }
  window._pkDespCostoManual = () => { _manual = true; _flete.costo = parseFloat(_$('pkDespCosto').value) || 0; _repintarGanancia() }
  window._pkDespRecalcular = () => { _manual = false; _flete.key = ''; _recalcFlete(true) }
  window._pkDespMapsCambio = () => {
    const v = _$('pkDespMaps').value.trim(); _$('pkDespMapsAbrir').disabled = !_mapsValido(v)
    const c = coordsDeMaps(v); if (c) _$('pkDespCoord').value = `${c.lat}, ${c.lng}`
    window._pkDespCoordCambio()
  }
  window._pkDespCoordCambio = () => {
    const c = coordsDeTexto(_$('pkDespCoord').value), i = _$('pkDespCoordInfo')
    i.textContent = c ? '📍 Ubicación lista para el mapa' : (_$('pkDespMaps').value.trim() ? 'Link corto: pega las coordenadas (clic derecho en Maps → copiar coordenadas) para verlo en el mapa.' : '')
  }
  window._pkDespMapsAbrir = () => { const v = _$('pkDespMaps').value.trim(); if (_mapsValido(v)) window.open(v, '_blank', 'noopener') }
}

const _mapsValido = v => /^https?:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)/i.test(v)

function _cliente() {
  const id = parseInt(_$('pkCliente')?.value) || 0
  return (S._clientes || []).find(c => c.id === id) || null
}
function _pintarDirCliente() {
  const c = _cliente(), el = _$('pkDespCliTxt')
  if (!el) return
  el.textContent = c ? ([c.direccion, c.distrito].filter(Boolean).join(' — ') || 'El cliente no tiene dirección registrada') : 'Selecciona un cliente'
  if (_$('pkDespUsaCli')?.checked && c?.distrito && _$('pkDespTermino')?.value === 'despacho' && !_$('pkDespDistrito').value) {
    _$('pkDespDistrito').value = c.distrito; _recalcFlete(true)
  }
}
function _aplicarUsaCli() {
  const usa = _$('pkDespUsaCli').checked
  _$('pkDespDirGrp').hidden = usa
  if (usa) { const c = _cliente(); if (c?.distrito) _$('pkDespDistrito').value = c.distrito }
}
function _aplicarTermino() {
  const t = _$('pkDespTermino').value
  _$('pkDespCuerpo').hidden = t !== 'despacho'
  const chip = _$('pkDespChip')
  chip.className = 'pk-desp-chip' + (t ? ' ok' : '')
  chip.textContent = t === 'despacho' ? 'El flete va dentro del precio · se resta del margen' : t === 'recoge_cliente' ? 'Sin flete · el cliente retira (aparece como "por retirar")' : 'Define quién lleva la mercadería'
  if (t === 'despacho') { _pintarDirCliente(); _aplicarUsaCli() }
  _repintarGanancia()
}

async function _cargarDistritos() {
  if (_distritos) return
  const { data, error } = await supabase.rpc('crm_flete_distritos')
  _distritos = error ? [] : (data || [])
  const dl = _$('pkDespDistritos')
  if (dl) dl.innerHTML = _distritos.map(d => `<option value="${_esc(d.distrito)}">${d.km} km</option>`).join('')
}

/** Rellena la sección al abrir el modal. `pk` = fila del packing (o null si es nuevo / duplicado sin despacho). */
export async function iniciarDespacho(pk, { empresaId = null } = {}) {
  enlazarDespacho()
  _empresaDoc = empresaId
  _flete = { key: '', km: pk?.despacho_km ?? null, costo: pk?.despacho_costo ?? null, estado: null }
  _manual = !!pk?.despacho_costo_manual
  _ultGan = null
  _pvPedidos = new Set()
  _$('pkDespTermino').value = pk?.termino_despacho || ''
  _$('pkDespUsaCli').checked = pk ? pk.despacho_usa_dir_cliente !== false : true
  _$('pkDespDir').value = pk?.despacho_direccion || ''
  _$('pkDespDistrito').value = pk?.despacho_distrito || ''
  _$('pkDespMaps').value = pk?.despacho_maps_url || ''
  _$('pkDespCoord').value = pk?.despacho_lat != null ? `${pk.despacho_lat}, ${pk.despacho_lng}` : ''
  _$('pkDespCosto').value = pk?.despacho_costo ?? ''
  _$('pkDespKm').textContent = pk?.despacho_km != null ? pk.despacho_km : '—'
  _$('pkDespEstado').textContent = ''
  _pintarDirCliente(); _aplicarTermino(); _aplicarUsaCli(); window._pkDespMapsCambio()
  _cargarDistritos().catch(() => {})
}

// ── Flete ───────────────────────────────────────────────────────────────────
const _kgTotal = () => (window._pkLineasActuales?.() || []).reduce((a, l) => a + (+l.cantidad || 0), 0)

async function _recalcFlete(forzar = false) {
  if (_$('pkDespTermino')?.value !== 'despacho') { _repintarGanancia(); return }
  const dist = _$('pkDespDistrito').value.trim(), kg = _kgTotal()
  if (!dist || !(kg > 0) || _manual) { _repintarGanancia(); return }
  const key = `${dist.toLowerCase()}|${kg.toFixed(1)}`
  if (!forzar && key === _flete.key) return
  _flete.key = key
  const { data, error } = await supabase.rpc('packing_flete_calcular', { p_empresa: _emp(), p_distrito: dist, p_kg: kg })
  const r = Array.isArray(data) ? data[0] : data
  const chip = _$('pkDespEstado')
  if (error || !r) { chip.className = 'pk-desp-chip warn'; chip.textContent = 'No se pudo calcular (¿SQL 133/136?). Ingresa el costo a mano.'; return }
  _flete.km = r.km; _flete.estado = r.estado
  _$('pkDespKm').textContent = r.km ?? '—'
  if (r.estado === 'cotizar' || r.costo == null) {
    _flete.costo = parseFloat(_$('pkDespCosto').value) || 0
    chip.className = 'pk-desp-chip warn'; chip.textContent = 'Distrito fuera de tabla o carga especial: ingresa el flete a mano'
  } else {
    _flete.costo = +r.costo
    _$('pkDespCosto').value = (+r.costo).toFixed(2)
    chip.className = 'pk-desp-chip ok'
    chip.textContent = r.estado === 'incluido' ? 'Zona sin recargo según la tabla' : 'Recargo calculado según la tabla'
  }
  _repintarGanancia()
}
/** packing.js lo llama cuando cambian las líneas (kg). */
export function alCambiarLineas(itemIds) {
  _recalcFlete(false)
  _cargarPV(itemIds)
}

// ── Lectura / validación / payload ─────────────────────────────────────────
export function validarDespacho() {
  const t = _$('pkDespTermino').value
  if (!t) return 'Elige el término de despacho: ¿recoge el cliente o va con despacho incluido?'
  if (t === 'despacho') {
    if (!_$('pkDespDistrito').value.trim()) return 'Con despacho incluido indica el distrito de entrega.'
    const m = _$('pkDespMaps').value.trim()
    if (!m) return 'Con despacho incluido pega el link de Google Maps de la entrega.'
    if (!_mapsValido(m)) return 'El link no parece de Google Maps (ej.: https://maps.app.goo.gl/…).'
    if (!_$('pkDespUsaCli').checked && !_$('pkDespDir').value.trim()) return 'Escribe la dirección de entrega o usa la del cliente.'
    if (!(parseFloat(_$('pkDespCosto').value) >= 0) || _$('pkDespCosto').value === '') return 'Falta el costo de flete: espera el cálculo o ingrésalo a mano.'
  }
  return null
}

export function leerDespacho(bajoPV = false) {
  const t = _$('pkDespTermino').value || null
  const d = t === 'despacho'
  const usa = d ? _$('pkDespUsaCli').checked : true
  const cli = _cliente()
  return {
    termino_despacho: t,
    despacho_usa_dir_cliente: usa,
    despacho_direccion: d ? (usa ? ([cli?.direccion].filter(Boolean).join('') || null) : (_$('pkDespDir').value.trim() || null)) : null,
    despacho_distrito: d ? (_$('pkDespDistrito').value.trim() || null) : null,
    despacho_maps_url: d ? (_$('pkDespMaps').value.trim() || null) : null,
    despacho_lat: d ? (coordsDeTexto(_$('pkDespCoord').value)?.lat ?? null) : null,
    despacho_lng: d ? (coordsDeTexto(_$('pkDespCoord').value)?.lng ?? null) : null,
    despacho_km: d ? (_flete.km ?? null) : null,
    despacho_costo: d ? (parseFloat(_$('pkDespCosto').value) || 0) : null,
    despacho_costo_manual: d ? _manual : false,
    bajo_pv_lista: !!bajoPV
  }
}
/** Costo interno de despacho en SOLES (0 si recoge el cliente). */
export const costoDespachoPEN = () => _$('pkDespTermino')?.value === 'despacho' ? (parseFloat(_$('pkDespCosto')?.value) || 0) : 0

// ── PV de lista ─────────────────────────────────────────────────────────────
async function _cargarPV(itemIds = []) {
  const faltan = [...new Set(itemIds.filter(Boolean))].filter(id => !_pvPedidos.has(id))
  if (!faltan.length) return
  faltan.forEach(id => _pvPedidos.add(id))
  const { data, error } = await supabase.rpc('crm_pv_lista_items', { p_empresa: _emp(), p_items: faltan })
  if (error) { faltan.forEach(id => _pvPedidos.delete(id)); return }
  for (const r of (data || [])) _pv[r.item_id] = r
  _repintarGanancia()
}
export const cargarPVItem = id => _cargarPV([id])

/** PV de lista SIN IGV expresado en la moneda del documento (o null si no hay dato / falta T.C.). */
function _listaSinIGVDoc(r, moneda, tc) {
  if (!r || !(+r.precio_lista > 0)) return null
  const sin = r.igv_incluido ? +r.precio_lista / (1 + (+r.igv_pct || 18) / 100) : +r.precio_lista
  if (r.moneda === moneda) return sin
  if (!(tc > 0)) return null
  return r.moneda === 'PEN' ? sin / tc : sin * tc
}

/** Pista bajo el precio del modal de línea: muestra el PV de lista y deja aplicarlo. */
export function pintarPistaPV() {
  const box = _$('pkPVHint'); if (!box) return
  const itemId = parseInt(_$('pkItem')?.value) || 0
  if (!itemId) { box.className = 'pk-pv-hint'; return }
  _cargarPV([itemId]).then(() => { if (parseInt(_$('pkItem')?.value) === itemId) _pistaPV(itemId) })
  _pistaPV(itemId)
}
function _pistaPV(itemId) {
  const box = _$('pkPVHint'), r = _pv[itemId]
  if (!box) return
  const moneda = _$('pkMoneda').value, tc = parseFloat(_$('pkTC').value) || 0
  const sin = _listaSinIGVDoc(r, moneda, tc)
  if (sin == null) { box.className = 'pk-pv-hint on'; box.innerHTML = r && +r.precio_lista > 0 ? '<span>PV de lista en otra moneda: falta el T.C. para compararlo.</span>' : '<span style="color:var(--text-secondary);">Este producto aún no tiene PV de lista (se define en CRM → Precios).</span>'; return }
  const igv = (+r.igv_pct || 18) / 100, inc = sin * (1 + igv), sim = moneda === 'USD' ? '$' : 'S/'
  const tipo = _$('pkIGV').value, precio = parseFloat(_$('pkPrecio').value) || 0
  const precioSin = tipo === 'gravada_incluido' ? precio / (1 + igv) : precio
  const bajo = precio > 0 && precioSin < sin - 0.0049
  box.className = 'pk-pv-hint on' + (bajo ? ' bajo' : '')
  box.innerHTML = `<span>📋 PV de lista: <b>${sim} ${inc.toFixed(2)}</b> inc. IGV <small style="color:var(--text-secondary);">(${sim} ${sin.toFixed(2)} sin IGV)</small></span>
    ${bajo ? '<span style="color:var(--color-warning); font-weight:600;">⚠ Precio por debajo del PV de lista — se guardará con aviso</span>' : ''}
    <button type="button" class="btn btn-small btn-secondary" onclick="window._pkUsarPVLista(${itemId})">Usar PV de lista</button>`
}
window._pkUsarPVLista = function (itemId) {
  const r = _pv[itemId], moneda = _$('pkMoneda').value, tc = parseFloat(_$('pkTC').value) || 0
  const sin = _listaSinIGVDoc(r, moneda, tc); if (sin == null) return
  const igv = (+r.igv_pct || 18) / 100
  _$('pkPrecio').value = (_$('pkIGV').value === 'gravada_incluido' ? sin * (1 + igv) : sin).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  window._pkPreviewLinea?.()
}

/** Líneas con precio bajo el PV de lista → [{descripcion, precio, lista, sim}] */
export function lineasBajoPV(lineas, moneda, tc) {
  const out = []
  for (const l of lineas) {
    const sin = _listaSinIGVDoc(_pv[l.item_id], moneda, tc)
    if (sin == null) continue
    if ((+l.precio_unitario) < sin - 0.0049) out.push({ descripcion: l.descripcion, precio: +l.precio_unitario, lista: sin, sim: moneda === 'USD' ? '$' : 'S/' })
  }
  return out
}

// ── Panel de ganancia con efecto HUD ───────────────────────────────────────
function _umbrales(lineas) {
  let sw = 0, so = 0, sm = 0
  for (const l of lineas) {
    const r = _pv[l.item_id]; if (!r || r.margen_objetivo == null) continue
    const w = +l.subtotal || 0; sw += w; so += w * +r.margen_objetivo; sm += w * +r.margen_minimo
  }
  return sw > 0 ? { obj: so / sw, min: sm / sw } : { obj: OBJ_DEF, min: MIN_DEF }
}

/**
 * Pinta ganancia total, flete y efecto. gans = ganancias por línea (puede contener null).
 * Ganancia neta = Σ ganancia líneas − flete interno (convertido a la moneda del PK).
 */
export function pintarGanancia({ gans, base, mon, usd, tc, lineas }) {
  _ultGan = { gans, base, mon, usd, tc, lineas }
  const elG = _$('pkTotGan'), elP = _$('pkTotGanPct'), pan = _$('pkPanelGan'), fl = _$('pkGanFlete'), etq = _$('pkGanEtq')
  if (!elG || !elP) return
  const color = g => g < 0 ? 'var(--color-danger)' : 'var(--color-success)'
  const completas = gans.length && gans.every(Boolean)
  if (pan) pan.dataset.nivel = '0'
  if (fl) fl.textContent = ''
  if (etq) etq.textContent = ''
  if (!completas) {
    elG.textContent = '—'; elG.style.color = 'var(--text-secondary)'
    elP.textContent = gans.length ? '(falta costo o T.C.)' : ''
    return
  }
  const fletePEN = costoDespachoPEN()
  const flete = fletePEN ? (usd ? (tc > 0 ? fletePEN / tc : 0) : fletePEN) : 0
  const g = gans.reduce((a, x) => a + x.gan, 0) - flete
  const pct = base ? g / base * 100 : 0
  elG.textContent = `${mon} ${formatNumber(g)}`; elG.style.color = color(g)
  elP.textContent = base ? `${pct.toFixed(1)}%` : ''; elP.style.color = color(g)
  if (fl && flete) fl.textContent = `incluye flete interno −${mon} ${formatNumber(flete)}`
  if (!pan || !base) return
  const u = _umbrales(lineas || [])
  const nivel = pct < 0 ? 3 : pct < u.min ? 2 : pct < u.obj ? 1 : 0
  pan.dataset.nivel = String(nivel)
  const txt = ['', `Margen bajo el objetivo (${u.obj.toFixed(0)}%)`, `Margen bajo el mínimo (${u.min.toFixed(0)}%)`, 'Venta con pérdida']
  if (etq) etq.textContent = txt[nivel]
}
function _repintarGanancia() { if (_ultGan) pintarGanancia(_ultGan) }
