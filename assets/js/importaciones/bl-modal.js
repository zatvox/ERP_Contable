// ============================================================================
// BL-MODAL.JS — Bill of Lading de la carpeta (Ver → Editar), con rastreo
// ============================================================================
// Se abre desde la hoja de costeo (window.abrirBL(id?)). Guarda en
// bill_of_ladings (SQL 103 agrega booking, naviera, nave, bultos, CBM, ETA,
// llegada y fletes). Rastreo SIN API: botón que abre la página de la naviera
// con el enlace ya armado + "Pegar tracking" (pegas el texto de la página y el
// sistema detecta nave, ETA y llegada; tú revisas y guardas).
// ============================================================================
import { query, insert, update, deleteRecord, ultimoErrorInsert, esperarContextoEmpresa, supabase } from '../supabase-client.js'
import { getItems } from '../supabase-data.js'
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
    <div class="modal-content" style="width:min(96vw, 1040px); max-width:min(96vw, 1040px); max-height:calc(100vh - 48px); overflow-y:auto;">
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

        <strong class="mod-sec">Totales que declara el BL <small style="text-transform:none; letter-spacing:0; font-weight:400;">(de todos los contenedores juntos)</small></strong>
        <div style="display:grid; grid-template-columns:repeat(5, 1fr); gap:10px;">
          <div class="form-group"><label>Bultos <span class="bl-en">(Packages)</span></label><input type="number" id="blBultos" step="1" onchange="window.blTotalesCambiaron()"></div>
          <div class="form-group"><label>Peso bruto (kg) <span class="bl-en">(Gross weight)</span></label><input type="number" id="blPeso" step="0.01" onchange="window.blTotalesCambiaron()"></div>
          <div class="form-group"><label>Volumen (CBM) <span class="bl-en">(Measurement)</span></label><input type="number" id="blCBM" step="0.001" onchange="window.blTotalesCambiaron()"></div>
          <div class="form-group"><label>ETA al puerto <span class="bl-en">(Estimated arrival)</span></label><input type="date" id="blETA"></div>
          <div class="form-group"><label>Llegada / descarga <span class="bl-en">(Discharge)</span></label><input type="date" id="blLlegada"></div>
        </div>

        <strong class="mod-sec">Contenedores y mercadería <small style="text-transform:none; letter-spacing:0; font-weight:400;">(qué artículo del CI viaja en cada contenedor)</small></strong>
        <div id="blContHost"></div>

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
  ['blFecha', 'fecha'],
  ['blBultos', 'bultos'], ['blPeso', 'peso_bruto'], ['blCBM', 'volumen_cbm'], ['blETA', 'fecha_eta'], ['blLlegada', 'fecha_llegada'],
  ['blFleteUSD', 'flete_prepago_usd'], ['blFleteCNY', 'flete_prepago_cny'], ['blFleteDest', 'flete_destino_usd']
]

function _volcar(bl) {
  for (const [id, col] of CAMPOS) { const el = $(id); if (el) el.value = bl?.[col] ?? (id === 'blEstado' ? 'pendiente' : '') }
  if (!bl && !v('blNaviera')) $('blNaviera').value = ''
  $('blPegar').value = ''; $('blPegarRes').textContent = ''
  window.blActualizarLink()
}


// ─── Contenedores y reparto de las líneas del CI (SQL 117) ────────────────────
const n0 = x => parseFloat(x) || 0
const f2 = x => formatNumber(n0(x), 2)
let _conts = []      // [{ id?, numero, tipo, precinto, bultos, peso_bruto, volumen_cbm, lin: { [detalle_ci_id]: kg } }]
let _lin = []        // líneas del CI [{ id, product_id, cantidad_neto, nombre }]
let _sinSQL = false  // SQL 117 sin correr
let _manualLin = false, _manualTot = false

const _nuevoCont = () => ({ numero: '', tipo: '40HC', precinto: '', bultos: null, peso_bruto: null, volumen_cbm: null, lin: {} })
const _partes = (total, n) => { const base = Math.floor(total / n * 100) / 100; const a = Array(n).fill(base); a[n - 1] = Math.round((total - base * (n - 1)) * 100) / 100; return a }
const _modoLectura = () => $('modal-bl-carpeta')?.dataset.modo !== 'edicion'
const _reaplicarModo = () => aplicarModoVerEditar('modal-bl-carpeta', _modoLectura())

async function _cargarLineasCI(ciId) {
  const [det, items] = await Promise.all([query('detalle_comercial_invoice', { comercial_invoice_id: ciId }), getItems()])
  const mapa = {}; for (const i of items || []) mapa[i.id] = i
  _lin = (det || []).map(d => { const it = mapa[d.product_id]; return { id: d.id, product_id: d.product_id, cantidad_neto: n0(d.cantidad_neto), nombre: it ? (it.sku ? `(${it.sku}) ${it.nombre}` : it.nombre) : `Artículo ${d.product_id}` } })
}

async function _cargarConts() {
  _conts = []; _manualLin = false; _manualTot = false
  const t = await supabase.from('bl_contenedores').select('id').limit(1)
  _sinSQL = !!t.error
  if (!_bl) { _conts = [_nuevoCont()]; _repartirLineas(); return }
  if (_sinSQL) { _conts = [{ numero: _bl.contenedor_number || '', tipo: _bl.tipo_contenedor || '40HC', precinto: _bl.numero_precinto || '', bultos: _bl.bultos, peso_bruto: _bl.peso_bruto, volumen_cbm: _bl.volumen_cbm, lin: {} }]; _repartirLineas(); return }
  const cs = ((await query('bl_contenedores', { bl_id: _bl.id })) || []).sort((a, b) => a.orden - b.orden || a.id - b.id)
  const ids = new Set(cs.map(c => c.id))
  const ls = ((await query('bl_contenedor_lineas', {})) || []).filter(l => ids.has(l.contenedor_id))
  _conts = cs.map(c => ({ id: c.id, numero: c.numero, tipo: c.tipo || '40HC', precinto: c.precinto || '', bultos: c.bultos, peso_bruto: c.peso_bruto, volumen_cbm: c.volumen_cbm,
    lin: Object.fromEntries(ls.filter(l => l.contenedor_id === c.id).map(l => [l.detalle_ci_id, n0(l.cantidad_neto)])) }))
  if (!_conts.length) { _conts = [{ ..._nuevoCont(), numero: _bl.contenedor_number || '', tipo: _bl.tipo_contenedor || '40HC', precinto: _bl.numero_precinto || '', bultos: _bl.bultos, peso_bruto: _bl.peso_bruto, volumen_cbm: _bl.volumen_cbm }]; _repartirLineas() }
  _manualLin = _conts.some(c => Object.keys(c.lin).length); _manualTot = true
}

/** Reparte cada línea del CI en partes iguales entre los contenedores. */
function _repartirLineas() {
  _conts.forEach(c => { c.lin = {} })
  for (const l of _lin) _partes(l.cantidad_neto, _conts.length).forEach((kg, i) => { _conts[i].lin[l.id] = kg })
}
/** Reparte los totales del BL (bultos, kg, CBM) en partes iguales entre los contenedores. */
function _repartirTotales() {
  const n = _conts.length
  const rep = (id, col, dec) => { const tot = n0(v(id)); if (!tot) return; const p = dec ? _partes(tot, n) : _partes(tot, n).map(Math.round); if (!dec) p[n - 1] = tot - p.slice(0, n - 1).reduce((a, b) => a + b, 0); p.forEach((x, i) => { _conts[i][col] = x }) }
  rep('blBultos', 'bultos', false); rep('blPeso', 'peso_bruto', true); rep('blCBM', 'volumen_cbm', true)
}

window.blTotalesCambiaron = () => { if (!_manualTot) _repartirTotales(); _pintarConts() }
window.blAgregarCont = () => { _conts.push(_nuevoCont()); if (!_manualLin) _repartirLineas(); if (!_manualTot) _repartirTotales(); _pintarConts() }
window.blQuitarCont = i => { if (_conts.length <= 1) { showToast('El BL necesita al menos un contenedor', 'warning'); return }; _conts.splice(i, 1); if (!_manualLin) _repartirLineas(); if (!_manualTot) _repartirTotales(); _pintarConts() }
window.blContSet = (i, k, val) => { const c = _conts[i]; if (!c) return; if (['bultos', 'peso_bruto', 'volumen_cbm'].includes(k)) { c[k] = val === '' ? null : n0(val); _manualTot = true } else c[k] = k === 'numero' ? String(val).toUpperCase().trim() : val; _pintarConts() }
window.blLinSet = (i, detId, val) => { if (_conts[i]) { _conts[i].lin[detId] = n0(val); _manualLin = true; _pintarConts() } }
window.blRepartirLineas = () => { _manualLin = false; _repartirLineas(); _pintarConts() }
window.blRepartirTotales = () => { _manualTot = false; _repartirTotales(); _pintarConts() }

const _chip = (ok, txt) => `<span style="display:inline-block; padding:1px 8px; border-radius:10px; font-size:.75rem; font-weight:600; color:#fff; background:${ok ? '#10b981' : '#f59e0b'};">${txt}</span>`

function _cruces() {
  const out = []
  const ci = window.costeoActual || {}
  const fila = (ok, txt) => out.push(`<div style="font-size:.84rem; padding:3px 0;">${ok ? '✅' : '⚠️'} ${txt}</div>`)
  const sum = k => _conts.reduce((t, c) => t + n0(c[k]), 0)
  const cmp = (lbl, bl, cont, tol) => { if (!bl && !cont) return; if (!bl) return; fila(Math.abs(bl - cont) <= tol, `${lbl}: BL declara <b>${f2(bl)}</b> · suma de contenedores <b>${f2(cont)}</b>${Math.abs(bl - cont) > tol ? ` (dif. ${f2(bl - cont)})` : ''}`) }
  cmp('Bultos', n0(v('blBultos')), sum('bultos'), 0.5)
  cmp('Peso bruto kg', n0(v('blPeso')), sum('peso_bruto'), 0.5)
  cmp('Volumen CBM', n0(v('blCBM')), sum('volumen_cbm'), 0.05)
  const totCI = _lin.reduce((t, l) => t + l.cantidad_neto, 0)
  const totAsig = _conts.reduce((t, c) => t + Object.values(c.lin).reduce((a, b) => a + n0(b), 0), 0)
  if (_lin.length) fila(Math.abs(totCI - totAsig) <= 0.5, `Mercadería: CI <b>${f2(totCI)}</b> kg neto · repartido en contenedores <b>${f2(totAsig)}</b> kg${Math.abs(totCI - totAsig) > 0.5 ? ` (dif. ${f2(totCI - totAsig)})` : ''}`)
  const flCI = n0(ci.costo_flete), flBL = n0(v('blFleteUSD'))
  if (flCI && flBL) fila(Math.abs(flCI - flBL) <= 0.05, `Flete: CI <b>US$ ${f2(flCI)}</b> · BL prepagado <b>US$ ${f2(flBL)}</b>`)
  const nombres = _conts.map(c => c.numero).filter(Boolean)
  if (new Set(nombres).size !== nombres.length) fila(false, 'Hay contenedores con el mismo número')
  return out.join('')
}

function _pintarConts() {
  const host = $('blContHost'); if (!host) return
  const lect = _modoLectura()
  const dis = lect ? 'disabled' : ''
  const inp = (i, k, val, ancho, tipo = 'number', extra = '') => `<input type="${tipo}" ${tipo === 'number' ? 'step="any"' : ''} value="${_esc(val ?? '')}" ${dis} style="width:${ancho}; padding:4px 6px;" onchange="window.blContSet(${i}, '${k}', this.value)" ${extra}>`
  const TD = 'padding:5px 6px; border-bottom:1px solid var(--border-color);'
  const filasC = _conts.map((c, i) => `<tr>
      <td style="${TD}">${inp(i, 'numero', c.numero, '130px', 'text', 'maxlength="20" placeholder="WHSU5068632"')}</td>
      <td style="${TD}"><select ${dis} onchange="window.blContSet(${i}, 'tipo', this.value)">${['40HC', '40GP', '20GP', 'LCL'].map(o => `<option${o === c.tipo ? ' selected' : ''}>${o}</option>`).join('')}</select></td>
      <td style="${TD}">${inp(i, 'precinto', c.precinto, '120px', 'text', 'maxlength="30"')}</td>
      <td style="${TD}">${inp(i, 'bultos', c.bultos, '80px')}</td><td style="${TD}">${inp(i, 'peso_bruto', c.peso_bruto, '100px')}</td><td style="${TD}">${inp(i, 'volumen_cbm', c.volumen_cbm, '80px')}</td>
      <td style="${TD}" data-solo-edicion><button type="button" class="btn btn-secondary btn-small" onclick="window.blQuitarCont(${i})" title="Quitar contenedor">🗑</button></td></tr>`).join('')
  const tabC = `<div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:.85rem;">
    <thead><tr style="color:var(--text-secondary); text-align:left;"><th>N° contenedor *</th><th>Tipo</th><th>Precinto</th><th>Bultos</th><th>Peso bruto kg</th><th>CBM</th><th data-solo-edicion></th></tr></thead><tbody>${filasC}</tbody></table></div>
    <div data-solo-edicion style="margin:8px 0; display:flex; gap:8px; flex-wrap:wrap;">
      <button type="button" class="btn btn-secondary btn-small" onclick="window.blAgregarCont()">＋ Contenedor</button>
      <button type="button" class="btn btn-secondary btn-small" onclick="window.blRepartirTotales()" title="Divide bultos, peso y CBM del BL en partes iguales">⚖ Repartir totales del BL</button></div>`
  let tabL = '<div style="font-size:.85rem; color:var(--text-secondary); margin-top:8px;">El CI aún no tiene líneas: registra los artículos en el CI para repartirlos por contenedor.</div>'
  if (_lin.length) {
    const cab = _conts.map((c, i) => `<th style="text-align:right; padding:4px 6px;">${_esc(c.numero || 'Contenedor ' + (i + 1))}</th>`).join('')
    const filasL = _lin.map(l => {
      const asig = _conts.reduce((t, c) => t + n0(c.lin[l.id]), 0), dif = l.cantidad_neto - asig, ok = Math.abs(dif) <= 0.5
      const celdas = _conts.map((c, i) => `<td style="${TD} text-align:right;"><input type="number" step="any" value="${n0(c.lin[l.id]) || ''}" ${dis} style="width:100px; text-align:right; padding:4px 6px;" onchange="window.blLinSet(${i}, ${l.id}, this.value)"></td>`).join('')
      return `<tr><td style="${TD}">${_esc(l.nombre)}</td><td style="${TD} text-align:right;">${f2(l.cantidad_neto)}</td>${celdas}<td style="${TD} text-align:right;">${f2(asig)}</td><td style="${TD}">${ok ? _chip(true, 'Completo') : _chip(false, dif > 0 ? `Faltan ${f2(dif)}` : `Sobran ${f2(-dif)}`)}</td></tr>`
    }).join('')
    const pie = _conts.map(c => `<td style="padding:5px 6px; text-align:right; font-weight:700;">${f2(Object.values(c.lin).reduce((a, b) => a + n0(b), 0))}</td>`).join('')
    tabL = `<div style="font-weight:600; font-size:.85rem; margin:12px 0 6px;">Mercadería por contenedor <small style="font-weight:400; color:var(--text-secondary);">(kg netos de cada artículo del CI)</small></div>
      <div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:.85rem;">
      <thead><tr style="color:var(--text-secondary);"><th style="text-align:left; padding:4px 6px;">Artículo</th><th style="text-align:right; padding:4px 6px;">Según CI</th>${cab}<th style="text-align:right; padding:4px 6px;">Repartido</th><th></th></tr></thead>
      <tbody>${filasL}<tr style="background:var(--bg-secondary);"><td style="padding:5px 6px; font-weight:700;">Total por contenedor</td><td></td>${pie}<td></td><td></td></tr></tbody></table></div>
      <div data-solo-edicion style="margin:8px 0;"><button type="button" class="btn btn-secondary btn-small" onclick="window.blRepartirLineas()" title="Divide cada artículo en partes iguales entre los contenedores">⚖ Repartir artículos en partes iguales</button></div>`
  }
  const aviso = _sinSQL ? `<div style="padding:8px 12px; border-left:3px solid var(--color-warning,#f59e0b); background:var(--bg-secondary); font-size:.83rem; margin-bottom:8px;">Falta correr <code>assets/sql/117_bl_contenedores_lineas.sql</code> para guardar varios contenedores y su mercadería.</div>` : ''
  host.innerHTML = aviso + tabC + tabL + `<div style="margin-top:10px; padding:8px 12px; background:var(--bg-secondary); border-radius:8px;"><div style="font-weight:600; font-size:.85rem; margin-bottom:4px;">Cruce BL ↔ CI</div>${_cruces() || '<span style="font-size:.84rem; color:var(--text-secondary);">Completa los totales del BL para cruzarlos.</span>'}</div>`
  _reaplicarModo()
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
    await _cargarLineasCI(ciId)
    await _cargarConts()
    $('modal-bl-carpeta').dataset.modo = _bl ? 'lectura' : 'edicion'
    _pintarConts()
    aplicarModoVerEditar('modal-bl-carpeta', !!_bl)
    window.openModal('modal-bl-carpeta')
  } catch (e) { console.error('abrirBL:', e); showToast('No se pudo abrir el BL', 'danger') }
}

window.blEditar = () => { aplicarModoVerEditar('modal-bl-carpeta', false); _pintarConts() }
window.blCancelar = async () => { if (_bl) { _volcar(_bl); await _cargarConts(); aplicarModoVerEditar('modal-bl-carpeta', true); _pintarConts() } else window.cerrarBL() }
window.cerrarBL = () => { window.closeModal('modal-bl-carpeta'); window.renderHojaCosteo?.() }


/** Sincroniza contenedores y líneas del BL: actualiza los existentes, crea los nuevos y borra los quitados. */
async function _guardarConts(blId, conts) {
  if (!blId) throw new Error('No se pudo obtener el id del BL guardado')
  const previos = (await query('bl_contenedores', { bl_id: blId })) || []
  const quedan = new Set(conts.map(c => c.id).filter(Boolean))
  for (const p of previos) if (!quedan.has(p.id)) await deleteRecord('bl_contenedores', p.id)
  let orden = 0
  for (const c of conts) {
    orden++
    const fila = { bl_id: blId, numero: c.numero, tipo: c.tipo || null, precinto: c.precinto || null, bultos: c.bultos == null ? null : Math.round(n0(c.bultos)), peso_bruto: c.peso_bruto, volumen_cbm: c.volumen_cbm, orden }
    let id = c.id
    if (id) { if (!await update('bl_contenedores', id, fila)) throw new Error(`No se pudo actualizar el contenedor ${c.numero}`) }
    else { const g = await insert('bl_contenedores', fila); if (!g?.id) throw new Error(`No se pudo crear el contenedor ${c.numero}: ${ultimoErrorInsert()?.message || ''}`); id = g.id; c.id = id }
    const viejas = ((await query('bl_contenedor_lineas', { contenedor_id: id })) || [])
    for (const l of viejas) await deleteRecord('bl_contenedor_lineas', l.id)
    for (const l of _lin) {
      const kg = n0(c.lin[l.id]); if (kg <= 0) continue
      await insert('bl_contenedor_lineas', { contenedor_id: id, detalle_ci_id: l.id, cantidad_neto: kg })
    }
  }
}

window.guardarBL = async function () {
  try {
    const ciId = window.costeoActual?.id
    if (!ciId) throw new Error('Falta el Commercial Invoice de la carpeta')
    if (!v('blNro')) throw new Error('Falta el N° de BL')
    const conts = _conts.filter(c => c.numero)
    if (!conts.length) throw new Error('Falta el N° de al menos un contenedor')
    if (new Set(conts.map(c => c.numero)).size !== conts.length) throw new Error('Hay contenedores con el mismo número')
    const NUEVAS = ['booking_number', 'naviera', 'nave_viaje', 'tipo_contenedor', 'bultos', 'volumen_cbm', 'fecha_eta', 'fecha_llegada', 'flete_prepago_usd', 'flete_prepago_cny', 'flete_destino_usd']
    const numericos = ['bultos', 'peso_bruto', 'volumen_cbm', 'flete_prepago_usd', 'flete_prepago_cny', 'flete_destino_usd']
    const fila = { importacion_id: ciId }
    for (const [id, col] of CAMPOS) {
      let val = v(id)
      if (numericos.includes(col)) val = num(val)
      else if (val === '') val = null
      if (col === 'nro_bill_lading') val = String(val).toUpperCase()
      fila[col] = val
    }
    // Resumen para los lectores antiguos (DAM, guías): todos los contenedores en un texto
    fila.contenedor_number = conts.map(c => c.numero).join(', ')
    fila.tipo_contenedor = conts[0].tipo || null
    fila.numero_precinto = conts.map(c => c.precinto).filter(Boolean).join(', ') || null
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
    } else if (!_sinSQL) {
      await _guardarConts(_bl?.id || res?.id, conts)
      showToast('Bill of Lading guardado', 'success')
    } else showToast('BL guardado con un solo contenedor: falta correr el SQL 117', 'warning')
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
  booking_number: ['blBooking', 'Booking'], contenedor_number: [null, 'Contenedor'], tipo_contenedor: [null, 'Tipo'],
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
  Object.entries(_TRK).forEach(([k, [id]]) => { if (r[k] && id && $(id)) $(id).value = r[k] })
  if (r.contenedor_number) {   // el contenedor leído se une a la tabla: si ya está, se completa; si hay una fila vacía, se usa; si no, se agrega
    let c = _conts.find(x => x.numero === r.contenedor_number) || _conts.find(x => !x.numero)
    if (!c) { c = _nuevoCont(); _conts.push(c); if (!_manualLin) _repartirLineas() }
    c.numero = r.contenedor_number
    if (r.tipo_contenedor) c.tipo = String(r.tipo_contenedor).replace(/^1x/i, '')
    _pintarConts()
  }
  $('blPegarRes').innerHTML = '✅ Datos aplicados. Revisa los campos y pulsa «Guardar BL».'
  $('blPegar').value = ''
}

export default { urlRastreo, parsearTracking }
