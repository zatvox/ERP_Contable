// ============================================================================
// compras/historial-carpeta.js — Reporte «Historial de operaciones por carpeta»
// Estilo kardex: ENTRADAS (compra por producto → lotes, con «ver más») y
// SALIDAS (ventas por lote con cliente y comprobante), subtotales, estadísticas,
// gráficos mensuales (kg vendidos, precio unitario, margen) y rentabilidad de la
// carpeta + stock remanente. Todo en US$ (costo real del lote; ventas en soles ÷ T.C.).
// ============================================================================
import { getItems, getSuppliers, getCompras } from '../supabase-data.js'
import { query, supabase } from '../supabase-client.js'
import { estaAnulado } from '../anulacion.js'
import { signoDocumento } from '../notas.js'
import { cacheado } from '../data-cache.js'
import { hacerTablaOrdenable } from '../helpers.js'
import { registrarColumnas, colMenuHtml, colStyle } from '../col-menu.js'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const num = v => parseFloat(v) || 0
const f = (v, d = 2) => num(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const u6 = v => `US$ ${num(v).toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 })}`
const usd = v => `US$ ${f(v)}`
const fch = s => s ? String(s).slice(0, 10).split('-').reverse().join('/') : '—'
const MES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']
const mesTxt = ym => { const [y, m] = String(ym).split('-'); return `${MES[(+m || 1) - 1]} ${String(y).slice(2)}` }

let _carpetas = [], _sel = null, _datos = null, _grupo = 'producto', _incNV = true
// Orden de las filas agrupadas (entradas, ventas facturadas, notas de venta): k = columna, d = 1 asc / -1 desc
const _ord = { ent: { k: 'n', d: 1 }, fact: { k: 'n', d: 1 }, nv: { k: 'n', d: 1 } }
function _aplicarOrd(root, id) {
  const lista = root.querySelector(`.hc-lista[data-lista="${id}"]`); if (!lista) return
  const { k, d } = _ord[id]
  const items = [...lista.children].filter(x => x.matches('details'))
  const val = x => k === 'n' ? x.dataset.n : parseFloat(x.dataset[k]) || 0
  items.sort((a, b) => k === 'n' ? String(val(a)).localeCompare(String(val(b)), 'es', { numeric: true }) * d : (val(a) - val(b)) * d)
  items.forEach(x => lista.appendChild(x))
  root.querySelectorAll(`.hc-ord[data-lista="${id}"] button`).forEach(b => { const on = b.dataset.k === k; b.classList.toggle('on', on); const i = b.querySelector('i'); if (i) i.textContent = on ? (d === 1 ? '▲' : '▼') : '⇅' })
}
// Columnas ocultables (menú ⋮ de la esquina). La Fecha / Lote del detalle no se ocultan: llevan la etiqueta del subtotal.
const COLS_HIST = [
  ['s_comprobante', 'Ventas · Comprobante'], ['s_cliente', 'Ventas · Cliente'], ['s_producto', 'Ventas · Producto'], ['s_lote', 'Ventas · Lote'], ['s_kg', 'Ventas · Kg'],
  ['s_pu', 'Ventas · P.U. US$'], ['s_puigv', 'Ventas · P.U. inc. IGV US$'], ['s_ing', 'Ventas · Ingreso US$'], ['s_costo', 'Ventas · Costo US$'], ['s_margen', 'Ventas · Margen US$'], ['s_pct', 'Ventas · Margen %'],
  ['e_producto', 'Ingresos · Producto'], ['e_op', 'Ingresos · Nro operación'], ['e_fecha', 'Ingresos · Fecha ingreso'], ['e_kg', 'Ingresos · Kg ingresados'], ['e_cu', 'Ingresos · Costo unit. final'],
  ['e_costo', 'Ingresos · Costo total'], ['e_vend', 'Ingresos · Vendido'], ['e_stock', 'Ingresos · Stock real']]
registrarColumnas('hc_hist', COLS_HIST.map(([key, label]) => ({ key, label })))
const C = k => ` data-col-tabla="hc_hist" data-col="${k}"${colStyle('hc_hist', k)}`
const pct = (m, i) => i ? f(m / i * 100, 1) + '%' : '—'
const GRUPOS = { producto: 'Producto', operacion: 'Nro de operación (factura / guía)', lote: 'Lote', mes: 'Mes', cliente: 'Cliente (solo salidas)' }

export async function construirHistorialCarpeta(panelId = 'repcm-carpeta') {
  const cont = document.getElementById(panelId); if (!cont) return
  cont.innerHTML = '<div class="card"><p class="reporte-vacio">Calculando historial…</p></div>'
  try {
    _carpetas = ((await query('carpetas_importacion', {})) || []).sort((a, b) => b.id - a.id)
    if (!_carpetas.length) { cont.innerHTML = '<div class="card"><p class="reporte-vacio">Aún no hay carpetas de importación.</p></div>'; return }
    const hash = new URLSearchParams(location.search).get('carpeta')
    _sel = _sel && _carpetas.some(c => c.id === _sel) ? _sel : (hash ? +hash : _carpetas[0].id)
    await _pintar(panelId)
  } catch (e) { console.error('historial carpeta:', e); cont.innerHTML = '<div class="card"><p class="reporte-vacio">No se pudo calcular el historial.</p></div>' }
}

// Supabase corta en 1,000 filas por consulta: se pide SOLO lo de la carpeta (por lote) y por tandas.
async function _enIds(tabla, col, ids) {
  const out = []
  for (let i = 0; i < ids.length; i += 80) {
    const { data, error } = await supabase.from(tabla).select('*').in(col, ids.slice(i, i + 80)).range(0, 4999)
    if (error) throw error; out.push(...(data || []))
  }
  return out
}
const _cache = {}
async function _cargarDatos(carpetaId) {
  if (_cache[carpetaId]) return _cache[carpetaId]
  const [items, provs, compras] = await Promise.all([cacheado('items', getItems), cacheado('proveedores', getSuppliers), cacheado('compras', getCompras)])
  const lotes = (await query('lotes', { carpeta_importacion_id: carpetaId })) || []
  const loteIds = lotes.map(l => l.id)
  const [kardex, detalles] = await Promise.all([_enIds('kardex', 'lote_id', loteIds), _enIds('detalle_ventas', 'lote_id', loteIds)])
  const ventaIds = [...new Set([...kardex.map(k => k.venta_id), ...detalles.map(d => d.venta_id)].filter(Boolean))]
  const ventas = await _enIds('ventas', 'id', ventaIds)
  const cliIds = [...new Set(ventas.map(v => v.contact_id).filter(Boolean))]
  const cli = await _enIds('contacts', 'id', cliIds)
  const itemMap = {}; (items || []).forEach(i => { itemMap[i.id] = i })
  const ventaMap = {}; ventas.forEach(v => { ventaMap[v.id] = v })
  const provMap = {}; (provs || []).forEach(p => { provMap[p.id] = p.razon_social || p.nombre })
  const compraMap = {}; (compras || []).forEach(c => { compraMap[c.id] = c })
  const cliMap = {}; cli.forEach(c => { cliMap[c.id] = c.razon_social || c.nombre })
  return (_cache[carpetaId] = { kardex, lotes, itemMap, ventaMap, provMap, compraMap, cliMap, detalles })
}

function _calcular(D, carpeta) {
  const lotes = D.lotes
  const loteIds = new Set(lotes.map(l => l.id))
  // Salidas = movimientos de KARDEX del lote (fuente de verdad del stock):
  //   'salida' con venta = venta · 'entrada' con venta = devolución (NC) → cantidad negativa.
  const salidas = [], entradaKg = {}
  const kx = D.kardex.filter(k => loteIds.has(k.lote_id)).sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || a.id - b.id)
  for (const k of kx) {
    const l = lotes.find(x => x.id === k.lote_id)
    if (k.tipo_movimiento === 'entrada' && !k.venta_id) { entradaKg[k.lote_id] = (entradaKg[k.lote_id] || 0) + num(k.cantidad_entrada); continue }
    if (!k.venta_id || !['salida', 'entrada'].includes(k.tipo_movimiento)) continue
    const v = D.ventaMap[k.venta_id]; if (!v || estaAnulado(v)) continue
    // Criterio (acordado 2026-10-30): FACTURA/BOLETA = salida − entrada (la entrada es una devolución NC).
    // NOTA DE VENTA (NV): sale de Zona A → Zona B; la «entrada» es solo el cambio de zona → se cuenta la columna SALIDA completa.
    const esNV = /^NV/i.test(v.numero || v.serie || '')
    const cant = esNV ? num(k.cantidad_salida) : num(k.cantidad_salida) - num(k.cantidad_entrada)
    const det = D.detalles.find(d => d.venta_id === k.venta_id && d.lote_id === k.lote_id)
    const puOrig = det ? (num(det.cantidad) ? (num(det.subtotal) || num(det.cantidad) * num(det.precio_unitario)) / num(det.cantidad) : num(det.precio_unitario)) : 0
    const tc = num(v.tipo_cambio) || 1
    const puUsd = v.moneda === 'USD' ? puOrig : (tc > 0 ? puOrig / tc : 0)
    // P.U. con IGV: total de la línea ÷ cantidad (las NV no llevan IGV → igual al P.U.); misma conversión a US$
    const puIgvOrig = det ? (num(det.total_linea) && num(det.cantidad) ? num(det.total_linea) / num(det.cantidad) : puOrig * (1 + num(det.igv_porcentaje) / 100)) : 0
    const puIgvUsd = v.moneda === 'USD' ? puIgvOrig : (tc > 0 ? puIgvOrig / tc : 0)
    const cuUsd = _cuUsd(l, D)
    salidas.push({ lote: l, loteId: l.id, item: l.item_id, fecha: v.fecha_emision || k.fecha || '', doc: v.numero || `${v.serie || ''}-${String(v.correlativo || '').padStart(8, '0')}`,
      ventaId: v.id, cliente: D.cliMap[v.contact_id] || '(sin cliente)', devolucion: cant < 0, nv: esNV, kg: cant, ingUsd: cant * puUsd, costoUsd: cant * cuUsd, puUsd, puIgvUsd, mon: v.moneda || 'PEN', tc })
  }
  const nvPorLote = {}; salidas.filter(s => s.nv).forEach(s => { nvPorLote[s.loteId] = (nvPorLote[s.loteId] || 0) + s.kg })
  const vendidoPorLote = {}; salidas.forEach(s => { vendidoPorLote[s.loteId] = (vendidoPorLote[s.loteId] || 0) + s.kg })
  // Entradas por producto
  const porProd = {}, ents = []
  for (const l of lotes) {
    const cu = _cuUsd(l, D), stock = num(l.cantidad), kgIni = entradaKg[l.id] ?? (stock + (vendidoPorLote[l.id] || 0))
    const p = porProd[l.item_id] ||= { item: l.item_id, nombre: D.itemMap[l.item_id]?.nombre || `Item ${l.item_id}`, lotes: [], kg: 0, costo: 0, stock: 0, vendido: 0 }
    const cmp = D.compraMap[l.compra_id]
    const op = cmp ? `${cmp.tipo_comprobante || ''} ${cmp.serie || ''}-${cmp.numero || ''}`.trim() : (l.numero_factura || '(sin documento)')
    const ent = { l, kgIni, cu, costo: kgIni * cu, stock, nv: nvPorLote[l.id] || 0, stockReal: stock - (nvPorLote[l.id] || 0), vendido: vendidoPorLote[l.id] || 0, op, prod: p.nombre }
    p.lotes.push(ent); ents.push(ent)
    p.kg += kgIni; p.costo += kgIni * cu; p.stock += stock; p.vendido += vendidoPorLote[l.id] || 0
  }
  const prods = Object.values(porProd).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
  return { lotes, salidas, prods, ents }
}
// costo unitario FINAL en US$/kg: costo real aplicado; si no, costo del lote ÷ T.C.
function _cuUsd(l, D) {
  if (num(l.costo_real) > 0) return num(l.costo_real)
  if (l.moneda === 'USD' && num(l.costo_unit_original)) return num(l.costo_unit_original)
  const tc = num(D.compraMap[l.compra_id]?.tipo_cambio) || num(l.tipo_cambio) || 1
  return num(l.costo_unitario) / tc
}

function _barras(titulo, serie, fmt, color) {
  if (!serie.length) return ''
  const max = Math.max(...serie.map(s => Math.abs(s.v)), 1e-9)
  return `<div class="hc-graf"><div class="hc-graf-t">${titulo}</div><div class="hc-barras">${serie.map(s => `
    <div class="hc-bar-col" title="${esc(s.k)}: ${esc(fmt(s.v))}"><div class="hc-bar-v">${esc(fmt(s.v))}</div>
      <div class="hc-bar" style="height:${Math.max(3, Math.abs(s.v) / max * 100)}%;background:${s.v < 0 ? '#ef4444' : color}"></div><div class="hc-bar-k">${esc(s.k)}</div></div>`).join('')}</div></div>`
}

async function _pintar(panelId) {
  const cont = document.getElementById(panelId)
  const carpeta = _carpetas.find(c => c.id === _sel)
  _datos = await _cargarDatos(_sel)
  const { lotes, salidas: salAll, prods, ents } = _calcular(_datos, carpeta)
  const salidas = _incNV ? salAll : salAll.filter(s => !s.nv)
  const fact = salAll.filter(s => !s.nv), nvs = salAll.filter(s => s.nv)
  const tot = arr => ({ kg: arr.reduce((a, x) => a + x.kg, 0), ing: arr.reduce((a, x) => a + x.ingUsd, 0), cs: arr.reduce((a, x) => a + x.costoUsd, 0) })
  const kgIni = prods.reduce((s, p) => s + p.kg, 0), costoTot = prods.reduce((s, p) => s + p.costo, 0)
  const kgVend = salidas.reduce((s, x) => s + x.kg, 0), ingTot = salidas.reduce((s, x) => s + x.ingUsd, 0), costoVend = salidas.reduce((s, x) => s + x.costoUsd, 0)
  const stockKg = ents.reduce((s, x) => s + x.stockReal, 0), stockVal = ents.reduce((s, x) => s + x.stockReal * x.cu, 0), stockKardex = ents.reduce((s, x) => s + x.stock, 0)
  const margen = ingTot - costoVend, margenPct = ingTot ? margen / ingTot * 100 : 0
  const puProm = kgVend ? ingTot / kgVend : 0, cuProm = kgIni ? costoTot / kgIni : 0
  const pus = salidas.filter(s => s.kg > 0 && s.puUsd > 0).map(s => s.puUsd)
  const clientes = new Set(salidas.map(s => s.cliente)).size
  const prov = _datos.provMap[carpeta.proveedor_id] || '—'
  // mensual
  const mm = {}; for (const s of salidas) { const k = String(s.fecha).slice(0, 7); if (!k) continue; const m = mm[k] ||= { kg: 0, ing: 0, costo: 0 }; m.kg += s.kg; m.ing += s.ingUsd; m.costo += s.costoUsd }
  const meses = Object.keys(mm).sort()
  // proyección: stock a precio promedio de venta
  const proy = stockKg * puProm - stockVal
  const kpi = (t, v, sub) => `<div class="hc-kpi"><div class="hc-kpi-t">${t}</div><div class="hc-kpi-v">${v}</div>${sub ? `<div class="hc-kpi-s">${sub}</div>` : ''}</div>`

  const keyEnt = x => ({ producto: x.prod, operacion: x.op, lote: x.l.numero_lote || 'Lote ' + x.l.id, mes: x.l.fecha_ingreso ? mesTxt(String(x.l.fecha_ingreso).slice(0, 7)) : '—', cliente: x.prod })[_grupo]
  const keySal = s => ({ producto: _datos.itemMap[s.item]?.nombre || 'Item ' + s.item, operacion: s.doc, lote: s.lote.numero_lote || 'Lote ' + s.loteId, mes: s.fecha ? mesTxt(String(s.fecha).slice(0, 7)) : '—', cliente: s.cliente })[_grupo]
  const agrupar = (arr, kf) => { const m = new Map(); arr.forEach(x => { const k = kf(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x) }); return [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'es', { numeric: true })) }
  const filaEnt = x => `<tr><td>${esc(x.l.numero_lote || 'Lote ' + x.l.id)}</td><td${C('e_producto')}>${esc(x.prod)}</td><td${C('e_op')}>${esc(x.op)}</td><td${C('e_fecha')}>${fch(x.l.fecha_ingreso)}</td><td class="n"${C('e_kg')}>${f(x.kgIni, 1)}</td><td class="n"${C('e_cu')}>${u6(x.cu)}</td><td class="n"${C('e_costo')}>${usd(x.costo)}</td><td class="n"${C('e_vend')}>${f(x.vendido, 1)}</td><td class="n"${C('e_stock')}>${f(x.stockReal, 1)}</td></tr>`
  const gruposEnt = agrupar(ents, keyEnt).map(([k, xs]) => {
    const kg = xs.reduce((a, x) => a + x.kgIni, 0), c = xs.reduce((a, x) => a + x.costo, 0)
    return `<details class="hc-prod hc-sub2" data-n="${esc(k)}" data-kg="${kg}" data-pu="${kg ? c / kg : 0}" data-imp="${c}" data-ln="${xs.length}"><summary><span class="hc-p-n">${esc(k)}</span><span>${f(kg, 1)} kg</span><span>Costo prom. ${u6(kg ? c / kg : 0)}/kg</span><span class="hc-fuerte">${usd(c)}</span><small>${xs.length} lote${xs.length > 1 ? 's' : ''} · ver más ▾</small></summary>
      <table class="hc-tbl"><thead><tr><th>Lote</th><th${C('e_producto')}>Producto</th><th${C('e_op')}>Nro operación</th><th${C('e_fecha')}>Fecha ingreso</th><th class="n"${C('e_kg')}>Kg ingresados</th><th class="n"${C('e_cu')}>Costo unit. final</th><th class="n"${C('e_costo')}>Costo total</th><th class="n"${C('e_vend')}>Vendido</th><th class="n"${C('e_stock')}>Stock real</th></tr></thead><tbody>${xs.map(filaEnt).join('')}</tbody></table></details>`
  }).join('')
  const ordBar = (id, cols) => `<div class="hc-ord" data-lista="${id}"><button type="button" data-k="n" class="hc-ord-n">${GRUPOS[_grupo].split(' (')[0]} <i>⇅</i></button>${cols.map(([k, t]) => `<button type="button" data-k="${k}"${k === 'ln' ? ' class="hc-ord-l"' : ''}>${t} <i>⇅</i></button>`).join('')}</div>`
  const operaciones = new Set(ents.map(x => x.op))
  const entradas = `<details class="hc-prod hc-resumen"><summary><span class="hc-p-n">Ingreso total de la carpeta</span><span>${f(kgIni, 1)} kg</span><span>Costo prom. ${u6(cuProm)}/kg</span><span class="hc-fuerte">${usd(costoTot)}</span><small>${prods.length} productos · ${ents.length} lotes · ${operaciones.size} operación(es) · ver más ▾</small></summary>
      <div style="padding:4px 10px 10px;">${ordBar('ent', [['kg', 'Kg'], ['pu', 'Costo prom.'], ['imp', 'Importe'], ['ln', 'Lotes']])}<div class="hc-lista" data-lista="ent">${gruposEnt}</div></div></details>`
  const gruposDe = arr => agrupar(arr, keySal).map(([k, ss]) => {
    ss = ss.slice().sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)))
    const kg = ss.reduce((a, x) => a + x.kg, 0), ing = ss.reduce((a, x) => a + x.ingUsd, 0), cs = ss.reduce((a, x) => a + x.costoUsd, 0)
    return `<details class="hc-prod" data-n="${esc(k)}" data-kg="${kg}" data-pu="${kg ? ing / kg : 0}" data-imp="${ing}" data-mg="${ing - cs}" data-ln="${ss.length}"><summary><span class="hc-p-n">${esc(k)}</span><span>${f(kg, 1)} kg vendidos</span><span>P.U. prom. ${u6(kg ? ing / kg : 0)}</span><span class="hc-fuerte">${usd(ing)}</span><span class="${ing - cs >= 0 ? 'hc-pos' : 'hc-neg'}">Margen ${usd(ing - cs)}</span><small>${ss.length} línea${ss.length > 1 ? 's' : ''} · ver más ▾</small></summary>
      <table class="hc-tbl"><thead><tr><th>Fecha</th><th${C('s_comprobante')}>Comprobante</th><th${C('s_cliente')}>Cliente</th><th${C('s_producto')}>Producto</th><th${C('s_lote')}>Lote</th><th class="n"${C('s_kg')}>Kg</th><th class="n"${C('s_pu')}>P.U. US$</th><th class="n"${C('s_puigv')}>P.U. inc. IGV US$</th><th class="n"${C('s_ing')}>Ingreso US$</th><th class="n"${C('s_costo')}>Costo US$</th><th class="n"${C('s_margen')}>Margen US$</th><th class="n"${C('s_pct')}>Margen %</th></tr></thead><tbody>
      ${ss.map(x => `<tr><td>${fch(x.fecha)}</td><td${C('s_comprobante')}>${esc(x.doc)}${x.devolucion ? ' <small class="hc-neg">(NC / devolución)</small>' : ''}</td><td${C('s_cliente')}>${esc(x.cliente)}</td><td${C('s_producto')}>${esc(_datos.itemMap[x.item]?.nombre || '')}</td><td${C('s_lote')}>${esc(x.lote.numero_lote || '')}</td><td class="n"${C('s_kg')}>${f(x.kg, 1)}</td><td class="n"${C('s_pu')}>${f(x.puUsd, 6)}</td><td class="n"${C('s_puigv')}>${f(x.puIgvUsd, 6)}</td><td class="n"${C('s_ing')}>${f(x.ingUsd)}</td><td class="n"${C('s_costo')}>${f(x.costoUsd)}</td><td class="n ${x.ingUsd - x.costoUsd >= 0 ? 'hc-pos' : 'hc-neg'}"${C('s_margen')}>${f(x.ingUsd - x.costoUsd)}</td><td class="n ${x.ingUsd - x.costoUsd >= 0 ? 'hc-pos' : 'hc-neg'}"${C('s_pct')}>${pct(x.ingUsd - x.costoUsd, x.ingUsd)}</td></tr>`).join('')}
      </tbody><tfoot><tr class="hc-sub"><td style="white-space:nowrap;">Subtotal ${esc(k)}</td><td${C('s_comprobante')}></td><td${C('s_cliente')}></td><td${C('s_producto')}></td><td${C('s_lote')}></td><td class="n"${C('s_kg')}>${f(kg, 1)}</td><td class="n"${C('s_pu')}>${f(kg ? ing / kg : 0, 6)}</td><td class="n"${C('s_puigv')}>${f(kg ? ss.reduce((a, x) => a + x.puIgvUsd * x.kg, 0) / kg : 0, 6)}</td><td class="n"${C('s_ing')}>${f(ing)}</td><td class="n"${C('s_costo')}>${f(cs)}</td><td class="n"${C('s_margen')}>${f(ing - cs)}</td><td class="n"${C('s_pct')}>${pct(ing - cs, ing)}</td></tr></tfoot></table></details>`
  }).join('')
  const bloque = (tit, sub, arr, id) => { if (!arr.length) return ''; const t = tot(arr); return `<div class="hc-bl-t"><b>${tit}</b> <small>${sub}</small><span>${f(t.kg, 1)} kg · ${usd(t.ing)} · margen <b class="${t.ing - t.cs >= 0 ? 'hc-pos' : 'hc-neg'}">${usd(t.ing - t.cs)}</b></span></div>${ordBar(id, [['kg', 'Kg vendidos'], ['pu', 'P.U. prom.'], ['imp', 'Ingreso US$'], ['mg', 'Margen'], ['ln', 'Líneas']])}<div class="hc-lista" data-lista="${id}">${gruposDe(arr)}</div>` }
  const salidasHtml = (bloque('Ventas facturadas', 'factura / boleta · kardex: salida − devoluciones', fact, 'fact') + (_incNV ? bloque('Notas de venta (NV)', 'Zona A → Zona B · kardex: columna salida', nvs, 'nv') : '')) || '<div class="dm-nota">Esta carpeta aún no tiene ventas.</div>'
  const tF = tot(fact), tN = tot(nvs)

  cont.innerHTML = `<div class="card hc-wrap con-col-menu">${colMenuHtml('hc_hist', 'hcColMenu', 'hcColMenuDd')}
    <div class="card-header" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;"><h3 class="card-title">Historial de operaciones por carpeta</h3>
      <select id="hcCarpetaSel" class="form-control" style="max-width:380px;margin-left:auto;">${_carpetas.map(c => `<option value="${c.id}" ${c.id === _sel ? 'selected' : ''}>${esc(c.numero_carpeta ? 'Carpeta ' + c.numero_carpeta : 'Carpeta ' + c.id)}${c.descripcion ? ' — ' + esc(String(c.descripcion).slice(0, 40)) : ''}</option>`).join('')}</select></div>
    <div class="dm-nota">Proveedor <b>${esc(prov)}</b> · apertura ${fch(carpeta.fecha_apertura)} · ${lotes.length} lotes · cifras en US$ (costo final real del lote; ventas en soles convertidas con el T.C. de cada venta).</div>
    <div class="hc-kpis">
      ${kpi('Comprado', `${f(kgIni, 1)} kg`, `Costo final ${usd(costoTot)}`)}
      ${kpi('Costo unit. prom.', u6(cuProm), 'por kg, ponderado')}
      ${kpi('Vendido', `${f(kgVend, 1)} kg`, `Fact. ${f(tF.kg, 1)} + NV ${f(tN.kg, 1)} · ${f(kgIni ? kgVend / kgIni * 100 : 0, 1)}%`)}
      ${kpi('Ingresos', usd(ingTot), `${salidas.length} líneas · ${clientes} clientes`)}
      ${kpi('Margen realizado', `<span class="${margen >= 0 ? 'hc-pos' : 'hc-neg'}">${usd(margen)}</span>`, `${f(margenPct, 1)}% sobre ventas`)}
      ${kpi('Stock remanente', `${f(stockKg, 1)} kg`, `Valorizado ${usd(stockVal)} · saldo kardex ${f(stockKardex, 1)}`)}
      ${kpi('Rentabilidad carpeta', costoTot ? `${f(margen / (costoVend || 1) * 100, 1)}%` : '—', `Proyectada con stock: ${usd(margen + proy)}`)}
    </div>
    <div class="hc-agrupar">Agrupar por: <select id="hcGrupoSel" class="form-control" style="width:auto;display:inline-block;">${Object.entries(GRUPOS).map(([k, l]) => `<option value="${k}" ${k === _grupo ? 'selected' : ''}>${l}</option>`).join('')}</select> <label class="hc-chk"><input type="checkbox" id="hcNV" ${_incNV ? 'checked' : ''}> Incluir notas de venta (NV)</label></div>
    <h4 class="hc-h">⬇ Entradas — ingreso de la compra</h4>${entradas}
    <div class="hc-tot">Total entradas: <b>${f(kgIni, 1)} kg</b> · <b>${usd(costoTot)}</b></div>
    <h4 class="hc-h">⬆ Salidas — ventas (agrupadas por ${GRUPOS[_grupo].split(' (')[0].toLowerCase()})</h4>${salidasHtml}
    <div class="hc-tot">Facturado <b>${f(tF.kg, 1)} kg</b> · ${usd(tF.ing)} &nbsp;|&nbsp; NV <b>${f(tN.kg, 1)} kg</b> · ${usd(tN.ing)} &nbsp;|&nbsp; Total salidas: <b>${f(kgVend, 1)} kg</b> · ingresos <b>${usd(ingTot)}</b> · costo <b>${usd(costoVend)}</b> · margen <b class="${margen >= 0 ? 'hc-pos' : 'hc-neg'}">${usd(margen)}</b></div>
    <h4 class="hc-h">📈 Estadísticas</h4>
    <div class="hc-kpis">
      ${kpi('P.U. venta promedio', u6(puProm), 'ponderado por kg')}
      ${kpi('P.U. mín. / máx.', pus.length ? `${f(Math.min(...pus), 4)} / ${f(Math.max(...pus), 4)}` : '—', 'US$ por kg')}
      ${kpi('Margen unitario', usd(kgVend ? margen / kgVend : 0), 'por kg vendido')}
      ${kpi('Venta promedio', usd(salidas.length ? ingTot / salidas.length : 0), 'por línea de venta')}
    </div>
    <div class="hc-grafs">
      ${_barras('Kg vendidos por mes', meses.map(k => ({ k: mesTxt(k), v: mm[k].kg })), v => f(v, 0), '#3b82f6')}
      ${_barras('Precio unitario de venta (US$/kg)', meses.map(k => ({ k: mesTxt(k), v: mm[k].kg ? mm[k].ing / mm[k].kg : 0 })), v => f(v, 3), '#10b981')}
      ${_barras('Margen por mes (US$)', meses.map(k => ({ k: mesTxt(k), v: mm[k].ing - mm[k].costo })), v => f(v, 0), '#f59e0b')}
    </div></div>`
  cont.querySelectorAll('.hc-ord button').forEach(b => b.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation()
    const id = b.closest('.hc-ord').dataset.lista, o = _ord[id]
    if (o.k === b.dataset.k) o.d = -o.d; else { o.k = b.dataset.k; o.d = b.dataset.k === 'n' ? 1 : -1 }   // numéricas: primero el mayor
    _aplicarOrd(cont, id)
  }))
  Object.keys(_ord).forEach(id => _aplicarOrd(cont, id))
  cont.querySelectorAll('table.hc-tbl').forEach(hacerTablaOrdenable)
  document.getElementById('hcNV')?.addEventListener('change', async e => { _incNV = e.target.checked; await _pintar(panelId) })
  document.getElementById('hcGrupoSel')?.addEventListener('change', async e => { _grupo = e.target.value; await _pintar(panelId) })
  document.getElementById('hcCarpetaSel')?.addEventListener('change', async e => { _sel = +e.target.value; await _pintar(panelId) })
}
