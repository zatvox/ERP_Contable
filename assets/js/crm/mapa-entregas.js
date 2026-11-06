// CRM · Centro de control de entregas (2026-11-06, v2 "HUD")
// Mapa oscuro (CARTO Dark Matter) con la paleta del ERP. Cada entrega es un camión/caja:
//   📦 cola de carga (facturado sin guía)  → guía emitida = camión con motor encendido junto al almacén
//   🚚 en ruta (hora_salida guardada con "Despachar", animado en línea recta con el tiempo estimado)
//   ✅ llegó / despachado (≤ 7 días)       · 🏭 por retirar (el cliente recoge)
// Tiempo estimado = distancia recta × factor_ruta ÷ velocidad media de la hora de salida (data/lima_velocidades.json).
// Jhiro y Benji se distinguen por el ANILLO + la letra de cada camión (color de empresa_config.color).
import { cargarLeaflet, cargarCss } from '../shared/leaflet-carga.js'
import { despacharGuia, entregarGuia } from '../shared/despacho-viaje.js'
import { abrirUbicacionAlmacen } from '../shared/almacen-ubicacion.js'

const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const PALETA = ['#3b82f6', '#f59e0b', '#a855f7', '#ec4899']
const ESTADOS = {
  cola:      { t: 'Cola de carga · facturado sin guía', c: '#94a3b8', o: 5 },
  motor:     { t: 'Guía emitida · motor encendido', c: '#f59e0b', o: 3 },
  ruta:      { t: 'En ruta', c: '#3b82f6', o: 1 },
  llego_est: { t: 'Llegó (estimado) · confirmar', c: '#10b981', o: 2 },
  llego:     { t: 'Entregado', c: '#10b981', o: 7 },
  despachado:{ t: 'Despachado', c: '#10b981', o: 6 },
  retiro:    { t: 'Por retirar · cliente recoge', c: '#14b8a6', o: 4 }
}
const MOTOR_HORAS = 18   // una guía emitida hace más que esto y sin "Despachar" se considera ya despachada (pedidos antiguos)
let _vel = null, _map = null, _timer = null, _tvTimer = null

async function cargarVel() {
  if (_vel) return _vel
  _vel = await (await fetch(new URL('../../data/lima_velocidades.json', import.meta.url))).json()
  return _vel
}
export const haversine = (a, b, c, d) => { const r = x => x * Math.PI / 180, R = 6371, dl = r(c - a), dg = r(d - b)
  const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dg / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)) }
/** Velocidad media (km/h) para una fecha-hora, hora de Lima. */
export function velocidadEn(fecha, v) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Lima', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(fecha)
  const wd = p.find(x => x.type === 'weekday').value, h = (+p.find(x => x.type === 'hour').value) % 24
  return v[wd === 'Sat' ? 'sabado' : wd === 'Sun' ? 'domingo' : 'laborable'][h]
}
export function etaMin(o, d, salida, v) { const km = haversine(o.lat, o.lng, d.lat, d.lng) * v.factor_ruta; return { km, min: km / velocidadEn(salida, v) * 60 } }
export const hhmm = min => { const m = Math.max(1, Math.round(min)); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` }
const bearing = (o, d) => { const r = x => x * Math.PI / 180, y = Math.sin(r(d.lng - o.lng)) * Math.cos(r(d.lat)), x = Math.cos(r(o.lat)) * Math.sin(r(d.lat)) - Math.sin(r(o.lat)) * Math.cos(r(d.lat)) * Math.cos(r(d.lng - o.lng)); return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 }
const fmtF = ts => ts ? new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts)).replace(',', '') : '—'
const fmtHM = ts => new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts))
const fmtD = d => { if (!d) return '—'; const m = String(d).match(/(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}` : String(d) }

const svgCamion = rot => `<svg viewBox="0 0 24 40" style="transform:rotate(${rot}deg)"><rect x="4" y="14" width="16" height="25" rx="2.5" fill="#e2e8f0" stroke="#0a0f24" stroke-width="1"/><rect x="6" y="17" width="12" height="19" rx="1.5" fill="#cbd5e1"/><rect x="5" y="2" width="14" height="12" rx="3.5" style="fill:var(--glow)" stroke="#0a0f24" stroke-width="1"/><rect x="7.5" y="4.5" width="9" height="4" rx="1.4" fill="#0a0f24" opacity=".75"/></svg>`
const svgCaja = `<svg viewBox="0 0 24 24"><path d="M12 2 3 6.5v11L12 22l9-4.5v-11z" fill="#cbd5e1" stroke="#0a0f24" stroke-width="1"/><path d="M3 6.5 12 11l9-4.5M12 11v11" fill="none" stroke="#0a0f24" stroke-width="1"/><path d="M7.5 4.3 16.5 9" stroke="#f59e0b" stroke-width="1.6"/></svg>`

export async function renderMapaEntregas(cont, ctx) {
  const [L, v] = await Promise.all([cargarLeaflet(), cargarVel(), cargarCss(new URL('../../css/mapa-entregas.css', import.meta.url).href)])
  clearInterval(_timer); clearInterval(_tvTimer); if (_map) { _map.remove(); _map = null }
  const rows = ctx.rows || [], refrescar = () => ctx.alRefrescar && ctx.alRefrescar()
  const reducido = matchMedia('(prefers-reduced-motion: reduce)').matches

  // ── empresas (color + letra) ──
  const empresas = new Map()
  const regEmp = (id, cod, col) => { if (id == null || empresas.has(id)) return; empresas.set(id, { id, cod: cod || ('E' + id), col: col || PALETA[empresas.size % PALETA.length], on: true }) }
  rows.forEach(r => regEmp(r.empresa_id, r.empresa_codigo, r.empresa_color)); ;(ctx.empresas || []).forEach(e => regEmp(e.id, e.codigo, e.color))

  // ── orígenes (almacén por empresa) ──
  const origenes = new Map(), orgKey = o => o.lat.toFixed(4) + ',' + o.lng.toFixed(4)
  const fb = v.origen
  const origenDe = id => {
    if (origenes.has(id)) return origenes.get(id)
    const x = (ctx.origenes || {})[id]; let o
    if (x && x.lat != null && x.lng != null) o = { id, almacen_id: x.almacen_id, nombre: x.nombre, direccion: x.direccion, lat: +x.lat, lng: +x.lng, fuente: x.fuente }
    else o = { id, almacen_id: x && x.almacen_id, nombre: (x && x.nombre) || fb.nombre, direccion: (x && x.direccion) || '', lat: fb.lat, lng: fb.lng, fuente: 'sin_datos' }
    o.key = orgKey(o); origenes.set(id, o); return o
  }
  empresas.forEach(e => origenDe(e.id))

  // ── estructura ──
  cont.innerHTML = `<div class="mp-wrap" id="mp-wrap"><div class="mp-mapa" id="mp-box"></div>
    <div class="mp-top"><div class="mp-kpi" id="mp-kpi"></div><div class="mp-tools" id="mp-tools"></div></div>
    <aside class="mp-side"><h4><span>Flota</span><span id="mp-n"></span></h4><div class="mp-lista" id="mp-lista"></div></aside>
    <div class="mp-leyenda"><span>📦 cola</span><span>🟠 motor encendido</span><span>🔵 en ruta</span><span>🟢 llegó</span><span>🟦 por retirar</span><span>┄ ubicación aprox.</span></div>
    <div class="mp-aviso" id="mp-aviso"></div></div>`
  const wrap = cont.querySelector('#mp-wrap'), $ = s => wrap.querySelector(s)
  wrap._mapa = null
  const map = _map = L.map('mp-box', { zoomControl: false, attributionControl: true, zoomSnap: .5 })
  wrap._mapa = map; L.control.zoom({ position: 'bottomright' }).addTo(map)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'mp-tiles', attribution: '© OpenStreetMap' }).addTo(map)   // oscurecido por CSS (CARTO ahora exige API key)

  // ── almacenes ──
  const grupos = new Map()
  origenes.forEach(o => { const g = grupos.get(o.key) || { o, emps: [] }; g.emps.push(empresas.get(o.id)); grupos.set(o.key, g) })
  grupos.forEach(g => {
    const o = g.o, aprox = g.emps.some(e => origenes.get(e.id).fuente !== 'almacen')
    const m = L.marker([o.lat, o.lng], { zIndexOffset: 500, icon: L.divIcon({ className: 'mp-ico', iconSize: [44, 44], iconAnchor: [22, 22],
      html: `<div class="alm${aprox ? ' aprox' : ''}"><i class="rad"></i><i class="rad b"></i><i class="rad c"></i><div class="nuc">🏭</div><span class="etq">${esc(g.emps.map(e => e.cod).join(' · '))}${aprox ? ' · aprox.' : ''}</span></div>` }) }).addTo(map)
    m.bindPopup(() => `<div class="tip"><div class="t1"><b>🏭 ${esc(o.nombre)}</b></div><dl><dt>Dirección</dt><dd>${esc(o.direccion || '—')}</dd><dt>Ubicación</dt><dd>${o.fuente === 'almacen' ? 'Exacta (guardada en el almacén)' : o.fuente === 'fiscal_aprox' ? 'Aprox. por el distrito de la dirección fiscal' : 'Sin datos: usando punto de referencia'}</dd></dl></div>
      <div class="pop-acc">${g.emps.map(e => `<button data-ubic="${origenes.get(e.id).almacen_id || ''}" data-emp="${e.id}">📍 Ubicar almacén ${esc(e.cod)}</button>`).join('')}</div>`, { className: 'mp-pop', minWidth: 250 })
  })

  // ── entregas ──
  const sinCoord = [], items = [], slots = {}
  rows.forEach(r => {
    const emp = empresas.get(r.empresa_id) || { id: null, cod: '?', col: '#64748b', on: true }, o = origenDe(r.empresa_id)
    let tipo = r.estado_flujo === 'por_retirar' ? 'retiro' : r.estado_flujo === 'facturado_sin_guia' ? 'cola' : (r.guia_id || r.guia) ? 'guia' : null
    if (!tipo) return                                    // PK sin facturar: aún no es del mapa
    const d = r.lat != null && r.lng != null ? { lat: +r.lat, lng: +r.lng } : null
    if (tipo === 'guia' && !d) { sinCoord.push(r); return }
    items.push({ r, emp, o, d, tipo, aprox: !!r.aprox, g: L.layerGroup().addTo(map) })
  })
  const lado = (it, k) => {      // posición "estacionado" en píxeles junto al almacén
    const key = it.o.key + it.cat, n = slots[key] = (slots[key] ?? -1) + 1
    if (it.cat === 'cola') return [-(40 + (n % 3) * 32), (Math.floor(n / 3)) * 32 - 8]
    if (it.cat === 'motor') return [40 + (n % 3) * 32, (Math.floor(n / 3)) * 32 - 8]
    return [(n % 4) * 32 - 48, 56 + Math.floor(n / 4) * 32]
  }
  const simInicio = {}, xSel = { v: 1 }
  const calc = (it, ahora) => {
    const r = it.r
    let est, p = 0, minTot = 0, minRest = 0, km = 0, salida = null
    if (it.d) { const sal = r.hora_salida ? new Date(r.hora_salida) : new Date(ahora); const t = etaMin(it.o, it.d, sal, v); km = t.km; minTot = t.min }
    if (it.tipo === 'retiro') est = 'retiro'
    else if (it.tipo === 'cola') est = 'cola'
    else if (r.hora_llegada) est = 'llego'
    else if (r.hora_salida || simInicio[r.packing_id]) {
      salida = r.hora_salida ? new Date(r.hora_salida).getTime() : simInicio[r.packing_id]
      const mult = r.hora_salida ? xSel.v : Math.max(60, xSel.v)
      p = Math.min(1, ((ahora - salida) * mult / 60000) / minTot); minRest = minTot * (1 - p)
      est = p >= 1 ? 'llego_est' : 'ruta'
    } else if (r.guia_emitida && ahora - new Date(r.guia_emitida).getTime() < MOTOR_HORAS * 3600e3) est = 'motor'
    else est = 'despachado'
    if (est === 'llego' || est === 'despachado' || est === 'llego_est') p = 1
    const pos = (it.d && (est === 'ruta' || est === 'llego_est' || est === 'llego' || est === 'despachado'))
      ? { lat: it.o.lat + (it.d.lat - it.o.lat) * p, lng: it.o.lng + (it.d.lng - it.o.lng) * p } : { lat: it.o.lat, lng: it.o.lng }
    const eta = est === 'ruta' ? new Date(ahora + minRest * 60000) : null
    return { est, p, minTot, minRest, km, pos, eta, salida }
  }
  const t0 = Date.now()
  items.forEach(it => {
    const s = calc(it, t0); it.cat = s.est === 'cola' ? 'cola' : s.est === 'retiro' ? 'retiro' : s.est === 'motor' ? 'motor' : 'ruta'
    it.estLab = s.est; it.rot = it.d ? bearing(it.o, it.d) : 0
    it.park = it.cat === 'ruta' ? [0, 0] : lado(it)
    it.m = L.marker([it.o.lat, it.o.lng], { zIndexOffset: 300 }).addTo(it.g)
    if (it.d) { it.dst = L.marker([it.d.lat, it.d.lng], { interactive: false, icon: L.divIcon({ className: 'mp-ico', iconSize: [12, 12], iconAnchor: [6, 6], html: '<div class="dst" style="--c:#3b82f6"></div>' }) }).addTo(it.g)
      it.ruta = L.polyline([[it.o.lat, it.o.lng], [it.d.lat, it.d.lng]], { color: '#3b82f6', weight: 2, opacity: .85, className: 'mp-ruta' + (reducido ? ' quieta' : '') })
      it.trail = L.polyline([[it.o.lat, it.o.lng], [it.o.lat, it.o.lng]], { color: '#93c5fd', weight: 3.5, opacity: .95, className: 'mp-trail' }) }
    it.m.bindTooltip(() => tipHtml(it), { direction: 'top', className: 'mp-tip', offset: [0, -16], opacity: 1 })
    it.m.bindPopup(() => popHtml(it), { className: 'mp-pop', minWidth: 250 })
  })

  const letra = it => esc((it.emp.cod || '?')[0])
  const iconoDe = (it, est) => {
    const ec = `--ec:${it.emp.col}`, ap = it.aprox ? ' aprox' : '', [dx, dy] = est === 'ruta' || est === 'llego_est' || est === 'llego' || est === 'despachado' ? [0, 0] : it.park
    const anchor = [15 - dx, 15 - dy]
    if (est === 'cola' || est === 'retiro') return L.divIcon({ className: 'mp-ico', iconSize: [30, 30], iconAnchor: anchor, html: `<div class="cj ${est}${ap}" style="${ec}"><i class="anillo"></i>${svgCaja}<span class="insig" style="${ec}">${letra(it)}</span></div>` })
    return L.divIcon({ className: 'mp-ico', iconSize: [30, 30], iconAnchor: anchor, html: `<div class="tk ${est}${ap}" style="${ec}"><i class="anillo"></i><span class="luces"><i></i><i></i></span><i class="humo"></i><i class="humo b"></i>${svgCamion(it.d ? it.rot : 0)}<span class="insig">${letra(it)}</span></div>` })
  }
  function tipHtml(it) {
    const s = it.s || calc(it, Date.now()), r = it.r, E = ESTADOS[s.est]
    const eta = it.d ? `${hhmm(s.minTot)} h · ${s.km.toFixed(1)} km` : '—'
    return `<div class="tip" style="--c:${E.c}"><div class="t1"><b>${esc(r.cot_numero || r.doc_actual)}</b><span class="mp-emp" style="--ec:${it.emp.col}">${esc(it.emp.cod)}</span></div>
      <span class="est">${esc(E.t)}</span>
      <dl><dt>Cliente</dt><dd>${esc(r.cliente || '—')}</dd>
      <dt>Último doc</dt><dd>${esc(r.doc_tipo || '')} ${esc(r.doc_actual || '')} · ${fmtD(r.fecha_doc)}</dd>
      ${r.guia ? `<dt>Guía</dt><dd>${esc(r.guia)} · emitida ${fmtF(r.guia_emitida)}</dd>` : ''}
      ${r.hora_salida ? `<dt>Salida</dt><dd>${fmtF(r.hora_salida)}</dd>` : ''}
      ${r.hora_llegada ? `<dt>Llegada</dt><dd>${fmtF(r.hora_llegada)}</dd>` : ''}
      <dt>Destino</dt><dd>${esc(r.distrito || '—')}${it.aprox ? ' <i>(aprox.)</i>' : ''}</dd>
      ${s.est === 'ruta' ? `<dt>Faltan</dt><dd><b>${hhmm(s.minRest)} h</b> · llega ~${fmtHM(s.eta)}</dd>` : `<dt>Viaje est.</dt><dd>${eta}</dd>`}</dl>
      ${it.aprox ? '<div class="nota">📍 Ubicación aproximada (centro del distrito). Edita el PK con el link de Maps para afinarla.</div>' : ''}</div>`
  }
  function popHtml(it) {
    const s = it.s || calc(it, Date.now()), r = it.r, b = []
    if (s.est === 'motor' && r.guia_id) b.push(`<button class="go" data-act="despachar" data-i="${it.i}">🚚 Despachar ahora</button>`)
    if ((s.est === 'ruta' || s.est === 'llego_est') && r.guia_id) b.push(`<button class="go" data-act="entregar" data-i="${it.i}">✅ Confirmar llegada</button>`)
    if (s.est === 'despachado' && r.guia_id) b.push(`<button data-act="entregar2" data-i="${it.i}">✅ Marcar como entregado</button>`)
    if (s.est === 'motor' || s.est === 'ruta') b.push(`<button data-act="seguir" data-i="${it.i}">🎯 Seguir con la cámara</button>`)
    if (it.d && (s.est === 'motor') && !r.hora_salida) b.push(`<button class="sim" data-act="sim" data-i="${it.i}">▶ Simular viaje (solo en pantalla)</button>`)
    if (s.est === 'cola') b.push('<div class="nota" style="padding:0 2px;color:#94a3b8">Emite la guía en Ventas → Guías de despacho y el camión encenderá motor.</div>')
    return tipHtml(it) + (b.length ? `<div class="pop-acc">${b.join('')}</div>` : '')
  }
  items.forEach((it, i) => { it.i = i })

  // ── pintar ──
  let follow = null, selI = null
  const pintar = pesado => {
    const ahora = Date.now(), cnt = { ruta: 0, motor: 0, cola: 0, ok: 0 }, lista = []
    items.forEach(it => {
      const s = it.s = calc(it, ahora), sig = s.est + '|' + (it.d ? Math.round(it.rot) : 0)
      if (it.sig !== sig) { it.sig = sig; it.m.setIcon(iconoDe(it, s.est))
        if (it.dst) it.dst.setIcon(L.divIcon({ className: 'mp-ico', iconSize: [12, 12], iconAnchor: [6, 6], html: `<div class="dst${s.est === 'ruta' ? ' ping' : ''}" style="--c:${ESTADOS[s.est].c}"></div>` }))
        if (it.ruta) { const ver = s.est === 'ruta' || s.est === 'motor' || s.est === 'llego_est'; ver ? it.g.addLayer(it.ruta) : it.g.removeLayer(it.ruta)
          it.ruta.getElement && it.ruta.getElement() && it.ruta.getElement().classList.toggle('quieta', s.est === 'motor' || reducido) }
        if (it.trail) { s.est === 'ruta' || s.est === 'llego_est' ? it.g.addLayer(it.trail) : it.g.removeLayer(it.trail) } }
      const mueve = s.est === 'ruta' || s.est === 'llego_est' || s.est === 'llego' || s.est === 'despachado'
      it.m.setLatLng(mueve ? [s.pos.lat, s.pos.lng] : [it.o.lat, it.o.lng])
      if (it.trail && (s.est === 'ruta' || s.est === 'llego_est')) it.trail.setLatLngs([[it.o.lat, it.o.lng], [s.pos.lat, s.pos.lng]])
      if (it.m.isTooltipOpen && it.m.isTooltipOpen()) it.m.setTooltipContent(tipHtml(it))
      if (s.est === 'ruta') cnt.ruta++; else if (s.est === 'motor') cnt.motor++; else if (s.est === 'cola' || s.est === 'retiro') cnt.cola++; else cnt.ok++
      lista.push(it)
    })
    if (follow && follow.s && follow.s.est !== 'cola') map.panTo(follow.m.getLatLng(), { animate: !reducido, duration: .3, easeLinearity: 1, noMoveStart: true })
    if (!pesado) return
    $('#mp-kpi').innerHTML = [['ruta', cnt.ruta, 'En ruta'], ['motor', cnt.motor, 'Motor encendido'], ['cola', cnt.cola, 'Por salir'], ['ok', cnt.ok, 'Llegados']].map(([c, n, t]) => `<div class="mp-k ${c}"><b>${n}</b><span>${t}</span></div>`).join('')
    lista.sort((a, b) => ESTADOS[a.s.est].o - ESTADOS[b.s.est].o || a.s.minRest - b.s.minRest)
    $('#mp-n').textContent = lista.filter(i => i.emp.on).length + ' pedidos'
    $('#mp-lista').innerHTML = lista.filter(i => i.emp.on).map(it => {
      const s = it.s, E = ESTADOS[s.est], r = it.r
      const dato = s.est === 'ruta' ? `<b style="color:#93c5fd">${hhmm(s.minRest)}</b> h · ~${fmtHM(s.eta)}` : s.est === 'motor' ? 'Listo para salir' : s.est === 'cola' ? 'Esperando guía' : s.est === 'retiro' ? 'Cliente recoge' : s.est === 'llego_est' ? 'Confirmar llegada' : esc(E.t)
      return `<div class="mp-card${selI === it.i ? ' sel' : ''}" data-i="${it.i}" style="--c:${E.c}"><div class="l1"><b>${esc(r.cliente || '—')}</b><span class="mp-emp" style="--ec:${it.emp.col}">${esc(it.emp.cod)}</span></div>
        <div class="l2"><span>${esc(r.cot_numero || r.doc_actual)} · ${esc(r.distrito || '—')}${it.aprox ? '*' : ''}</span><span>${dato}</span></div>
        ${s.est === 'ruta' || s.est === 'llego_est' ? `<div class="mp-prog" style="--p:${(s.p * 100).toFixed(0)}%"><i></i></div>` : ''}</div>`
    }).join('') || '<div class="mp-vacio">Sin entregas en el periodo</div>'
  }

  // ── herramientas ──
  const dias = ctx.dias || 7
  $('#mp-tools').innerHTML = `${[...empresas.values()].map(e => `<button class="mp-btn on" data-emp="${e.id}" style="border-color:${e.col}">● ${esc(e.cod)}</button>`).join('')}
    <button class="mp-btn" id="mp-ubic">📍 Ubicar almacén</button>
    <select class="mp-btn" id="mp-x" title="Aceleración (solo para demostrar el viaje)"><option value="1">Tiempo real</option><option value="30">×30</option><option value="60">×60</option><option value="300">×300</option></select>
    <button class="mp-btn" id="mp-fit">⤢ Ver todo</button><button class="mp-btn" id="mp-tv">📺 Modo TV</button>`
  $('#mp-x').onchange = e => { xSel.v = +e.target.value }
  const encuadrar = () => {
    const pts = [...origenes.values()].map(o => [o.lat, o.lng]); items.forEach(i => { if (i.d && i.s && i.s.est !== 'despachado' && i.s.est !== 'llego') pts.push([i.d.lat, i.d.lng]) })
    follow = null; map.fitBounds(L.latLngBounds(pts).pad(.1), { maxZoom: 14, animate: !reducido, paddingTopLeft: [20, 110], paddingBottomRight: [wrap.clientWidth > 820 ? 340 : 20, wrap.clientWidth > 820 ? 60 : 200] })
  }
  $('#mp-fit').onclick = encuadrar
  $('#mp-tools').addEventListener('click', e => {
    const b = e.target.closest('button[data-emp]'); if (!b) return
    const E = empresas.get(+b.dataset.emp); E.on = !E.on; b.classList.toggle('on', E.on); b.style.opacity = E.on ? 1 : .45
    items.forEach(it => { it.emp === E && (E.on ? map.addLayer(it.g) : map.removeLayer(it.g)) }); pintar(true)
  })
  const ubicar = (almId, empId) => {
    if (!almId) return alert('Esa empresa no tiene un almacén creado. Créalo en Inventario → Almacenes.')
    const o = origenes.get(+empId) || {}; abrirUbicacionAlmacen(almId, { centro: o.lat ? { lat: o.lat, lng: o.lng } : null, alGuardar: refrescar })
  }
  $('#mp-ubic').onclick = () => { const ids = [...empresas.keys()]; ids.length === 1 ? ubicar(origenDe(ids[0]).almacen_id, ids[0]) : ubicar(origenDe(ids[0]).almacen_id, ids[0]) }
  if (empresas.size > 1) $('#mp-ubic').title = 'Para otra empresa, haz clic en su almacén en el mapa'
  const seguir = it => { selI = it.i; follow = it; const p = it.m.getLatLng(); map.flyTo(p, Math.max(map.getZoom(), 14), { animate: !reducido, duration: 1 }); pintar(true) }
  $('#mp-lista').addEventListener('click', e => { const c = e.target.closest('.mp-card'); if (c) { const it = items[+c.dataset.i]; seguir(it); it.m.openPopup() } })
  map.on('dragstart', () => { follow = null })
  map.on('popupopen', e => {
    const n = e.popup.getElement(); if (!n) return
    n.querySelectorAll('[data-ubic]').forEach(b => b.onclick = () => { map.closePopup(); ubicar(+b.dataset.ubic, b.dataset.emp) })
    n.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
      const it = items[+b.dataset.i], a = b.dataset.act; map.closePopup()
      if (a === 'despachar') { if (await despacharGuia(it.r.guia_id)) refrescar() }
      else if (a === 'entregar') { if (await entregarGuia(it.r.guia_id)) refrescar() }
      else if (a === 'entregar2') { if (await entregarGuia(it.r.guia_id, !it.r.hora_salida)) refrescar() }
      else if (a === 'seguir') seguir(it)
      else if (a === 'sim') { simInicio[it.r.packing_id] = Date.now(); seguir(it) }
    })
  })
  // Modo TV: pantalla completa + recorrido automático por los camiones en ruta
  $('#mp-tv').onclick = async () => {
    try { document.fullscreenElement ? await document.exitFullscreen() : await wrap.requestFullscreen() } catch (_) { wrap.classList.toggle('tv') }
  }
  document.addEventListener('fullscreenchange', () => {
    const on = document.fullscreenElement === wrap; wrap.classList.toggle('tv', on); setTimeout(() => map.invalidateSize(), 150)
    clearInterval(_tvTimer)
    if (on) { let k = 0; _tvTimer = setInterval(() => { const en = items.filter(i => i.s && i.s.est === 'ruta' && i.emp.on); if (!en.length) { encuadrar(); return } seguir(en[k++ % en.length]) }, 9000) }
  })

  // ── avisos y arranque ──
  const aprox = items.filter(i => i.aprox).length, orgAprox = [...empresas.values()].filter(e => origenDe(e.id).fuente !== 'almacen')
  $('#mp-aviso').innerHTML = [
    orgAprox.length ? `⚠ Almacén ${esc(orgAprox.map(e => e.cod).join(', '))} con ubicación aproximada → pulsa <b>📍 Ubicar almacén</b>.` : '',
    aprox ? `* ${aprox} destino(s) con ubicación aprox. (centro del distrito).` : '',
    sinCoord.length ? `Sin ubicación (${sinCoord.length}): ${sinCoord.slice(0, 3).map(r => `<b>${esc(r.cot_numero || r.doc_actual)}</b>`).join(' · ')}${sinCoord.length > 3 ? ' …' : ''}` : '',
    `Mostrando despachados de los últimos ${dias} días.`].filter(Boolean).join(' &nbsp;·&nbsp; ')
  pintar(true); encuadrar()
  let n = 0
  _timer = setInterval(() => { if (!document.getElementById('mp-box')) { clearInterval(_timer); return } pintar(++n % 8 === 0) }, 250)
  setTimeout(() => { map.invalidateSize(); encuadrar() }, 350)
}
