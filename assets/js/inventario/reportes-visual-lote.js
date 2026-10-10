// ============================================================================
// Visual gerencial del Kardex resumido — 2026-10-07
//  · 1 lote en el filtro   → Ciclo de vida: columnas kg vendidos/mes + línea
//                            de stock restante + KPIs (agotamiento estimado).
//  · 2+ lotes en el filtro → Mapa de calor Lote × Mes (kg vendidos netos).
// Ventas netas = clase 'Venta' − 'Devolución cliente'. El stock se calcula con
// TODOS los movimientos del lote (no depende del filtro de tipo).
// SVG/HTML puro, sin librerías (GitHub Pages estático).
// ============================================================================
import { formatQty } from '../helpers.js'

const MES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Set', 'Oct', 'Nov', 'Dic']
const _esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const _ym = (f) => String(f || '').slice(0, 7)
const _labelMes = (ym) => `${MES[parseInt(ym.slice(5, 7), 10) - 1]} ${ym.slice(2, 4)}`
const _fmt = (n) => formatQty(Math.round(n * 100) / 100)
const _ventaNeta = (f) => f.tipo === 'Venta' ? (f.salida || 0) : (f.tipo === 'Devolución cliente' ? -(f.entrada || 0) : 0)

function _rangoMeses(desde, hasta, max = 36) {
  const out = []
  let [y, m] = desde.split('-').map(Number)
  const [yh, mh] = hasta.split('-').map(Number)
  while ((y < yh || (y === yh && m <= mh)) && out.length < 240) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m++; if (m > 12) { m = 1; y++ }
  }
  return out.slice(-max)
}

/** Punto de entrada: devuelve HTML o null (null → el motor muestra sus barras). */
export function visualKardexLote(filtrados, todos, opts = {}) {
  const lotes = [...new Set((filtrados || []).map(f => f.lote).filter(l => l && l !== '(sin lote)'))]
  if (lotes.length === 1) return _cicloVida(lotes[0], filtrados, todos)
  if (lotes.length >= 2) return _mapaCalor(lotes, filtrados, opts)
  return null
}

// ─── 1) Ciclo de vida de UN lote ────────────────────────────────────────────
function _cicloVida(lote, filtrados, todos) {
  const movLote = (todos || []).filter(f => f.lote === lote && f.fecha).sort((a, b) => a.fecha.localeCompare(b.fecha))
  if (!movLote.length) return null
  const hoy = new Date().toISOString().slice(0, 10)
  const visibles = filtrados.filter(f => f.fecha)
  const desde = _ym(movLote[0].fecha)
  const hasta = _ym(hoy) // la línea de stock llega hasta hoy
  const meses = _rangoMeses(desde, hasta)

  // Ventas netas por mes (respeta filtros del reporte)
  const vendidoMes = Object.fromEntries(meses.map(m => [m, 0]))
  visibles.forEach(f => { const m = _ym(f.fecha); if (m in vendidoMes) vendidoMes[m] += _ventaNeta(f) })
  // Stock al cierre de cada mes (todos los movimientos del lote)
  const stockMes = {}
  let acum = 0, i = 0
  for (const m of meses) {
    while (i < movLote.length && _ym(movLote[i].fecha) <= m) { acum += movLote[i].neto || 0; i++ }
    stockMes[m] = Math.max(0, acum)
  }
  while (i < movLote.length) { acum += movLote[i].neto || 0; i++ }
  const stockActual = Math.max(0, acum)

  // KPIs
  const comprado = movLote.filter(f => f.tipo === 'Compra').reduce((s, f) => s + (f.entrada || 0), 0)
  const vendido = movLote.reduce((s, f) => s + _ventaNeta(f), 0)
  const fCompra = (movLote.find(f => f.tipo === 'Compra') || movLote[0]).fecha
  const dias = Math.max(1, Math.round((new Date(hoy) - new Date(fCompra)) / 86400000))
  const ritmoMes = vendido / (dias / 30.44)
  const pct = comprado ? vendido / comprado * 100 : 0
  let agot = '—', agotSub = 'sin ventas aún'
  if (stockActual <= 0.0001) { agot = 'Agotado'; agotSub = '' }
  else if (ritmoMes > 0) {
    const d = new Date(hoy); d.setDate(d.getDate() + Math.round(stockActual / ritmoMes * 30.44))
    agot = `${MES[d.getMonth()]} ${d.getFullYear()}`; agotSub = `≈ ${Math.round(stockActual / ritmoMes * 10) / 10} meses al ritmo actual`
  }
  const mejor = meses.reduce((b, m) => vendidoMes[m] > (vendidoMes[b] ?? -Infinity) ? m : b, meses[0])

  const kpi = (lab, val, sub = '', color = '') => `
    <div class="reporte-kpi"><div class="reporte-kpi-label">${lab}</div>
      <div class="reporte-kpi-valor" style="${color ? `color:${color};` : ''}">${val}</div>
      ${sub ? `<div class="reporte-kpi-sub">${sub}</div>` : ''}</div>`

  // SVG combinado
  const W = 900, H = 290, pL = 58, pR = 66, pT = 22, pB = 42
  const iw = W - pL - pR, ih = H - pT - pB
  const maxV = Math.max(1, ...meses.map(m => vendidoMes[m]))
  const maxS = Math.max(1, comprado, ...meses.map(m => stockMes[m]))
  const bw = iw / meses.length
  const yV = v => pT + ih - (Math.max(0, v) / maxV) * ih
  const yS = v => pT + ih - (v / maxS) * ih
  const grid = [0, 0.25, 0.5, 0.75, 1].map(t => {
    const y = pT + ih - t * ih
    return `<line x1="${pL}" x2="${W - pR}" y1="${y}" y2="${y}" stroke="var(--border-color)" stroke-dasharray="${t ? '3 4' : ''}" opacity="0.6"/>
      <text x="${pL - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="var(--color-info)">${_fmt(maxV * t)}</text>
      <text x="${W - pR + 8}" y="${y + 4}" font-size="11" fill="var(--color-warning)">${_fmt(maxS * t)}</text>`
  }).join('')
  const barras = meses.map((m, k) => {
    const v = vendidoMes[m], x = pL + k * bw + bw * 0.18, w = bw * 0.64, y = yV(v)
    const esMejor = m === mejor && v > 0
    return `<g><title>${_labelMes(m)} · vendido ${_fmt(v)} kg · stock fin de mes ${_fmt(stockMes[m])} kg</title>
      <rect x="${x}" y="${y}" width="${w}" height="${pT + ih - y}" rx="3" fill="var(--color-info)" opacity="${esMejor ? 1 : 0.72}"/>
      ${v > 0 && meses.length <= 18 ? `<text x="${x + w / 2}" y="${y - 5}" text-anchor="middle" font-size="10.5" font-weight="600" fill="var(--text-primary)">${_fmt(v)}</text>` : ''}
      ${(meses.length <= 18 || k % Math.ceil(meses.length / 18) === 0) ? `<text x="${pL + k * bw + bw / 2}" y="${H - pB + 16}" text-anchor="middle" font-size="11" fill="var(--text-secondary)">${_labelMes(m)}</text>` : ''}
    </g>`
  }).join('')
  const pts = meses.map((m, k) => [pL + k * bw + bw / 2, yS(stockMes[m])])
  const linea = `<polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" stroke="var(--color-warning)" stroke-width="2.5" stroke-linejoin="round"/>
    ${pts.map((p, k) => `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="var(--color-warning)"><title>${_labelMes(meses[k])} · stock ${_fmt(stockMes[meses[k]])} kg</title></circle>`).join('')}`

  return `
    <div class="reporte-grafico-titulo">Ciclo de vida del lote ${_esc(lote)}</div>
    <div class="reporte-kpis" style="margin:6px 0 12px;">
      ${kpi('Comprado', _fmt(comprado) + ' kg', fCompra.split('-').reverse().join('/'))}
      ${kpi('Vendido', _fmt(vendido) + ' kg', `${pct.toFixed(1)} % del lote`, 'var(--color-info)')}
      ${kpi('Stock actual', _fmt(stockActual) + ' kg', `${(100 - pct).toFixed(1)} % restante`, 'var(--color-warning)')}
      ${kpi('Ritmo de venta', _fmt(ritmoMes) + ' kg/mes', `${dias} días desde la compra`)}
      ${kpi('Mejor mes', _labelMes(mejor), _fmt(vendidoMes[mejor]) + ' kg')}
      ${kpi('Agotamiento estimado', agot, agotSub, stockActual <= 0.0001 ? 'var(--color-success)' : '')}
    </div>
    <div style="display:flex; gap:18px; font-size:0.78rem; color:var(--text-secondary); margin:0 0 4px 4px;">
      <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--color-info);margin-right:5px;"></span>kg vendidos en el mes (eje izq.)</span>
      <span><span style="display:inline-block;width:14px;height:3px;background:var(--color-warning);margin-right:5px;vertical-align:middle;"></span>stock al cierre del mes (eje der.)</span>
    </div>
    <div style="overflow-x:auto;"><svg viewBox="0 0 ${W} ${H}" style="width:100%; min-width:560px; height:auto; display:block;" role="img" aria-label="Ciclo de vida del lote ${_esc(lote)}">
      ${grid}${barras}${linea}
    </svg></div>`
}

// ─── 2) Mapa de calor Lote × Mes ────────────────────────────────────────────
function _mapaCalor(lotes, filtrados, opts) {
  const ventas = filtrados.filter(f => f.fecha && (f.tipo === 'Venta' || f.tipo === 'Devolución cliente'))
  if (!ventas.length) return null
  const fechas = ventas.map(f => f.fecha).sort()
  const meses = _rangoMeses(_ym(fechas[0]), _ym(fechas[fechas.length - 1]), 18)
  const celda = {}, total = {}
  ventas.forEach(f => {
    const m = _ym(f.fecha); const v = _ventaNeta(f)
    total[f.lote] = (total[f.lote] || 0) + v
    if (!meses.includes(m)) return
    const k = `${f.lote}|${m}`; celda[k] = (celda[k] || 0) + v
  })
  const filas = lotes.filter(l => total[l]).sort((a, b) => total[b] - total[a]).slice(0, 30)
  if (!filas.length) return null
  const max = Math.max(1, ...Object.values(celda))
  const totMes = Object.fromEntries(meses.map(m => [m, filas.reduce((s, l) => s + (celda[`${l}|${m}`] || 0), 0)]))
  const idBuscar = opts.idBuscar || ''
  const th = 'padding:6px 8px; font-size:0.75rem; color:var(--text-secondary); font-weight:600; white-space:nowrap;'
  return `
    <div class="reporte-grafico-titulo">Mapa de calor — kg vendidos por lote y mes${lotes.length > filas.length ? ` (top ${filas.length})` : ''}</div>
    <div style="font-size:0.78rem; color:var(--text-secondary); margin:0 0 8px;">Más intenso = más vendido. Clic en un lote para ver su ciclo de vida.</div>
    <div style="overflow-x:auto;">
      <table style="border-collapse:separate; border-spacing:3px; width:100%; font-variant-numeric:tabular-nums;">
        <thead><tr><th style="${th} text-align:left;">Lote</th>${meses.map(m => `<th style="${th} text-align:center;">${_labelMes(m)}</th>`).join('')}<th style="${th} text-align:right;">Total</th></tr></thead>
        <tbody>
          ${filas.map(l => `<tr>
            <td style="padding:6px 8px; white-space:nowrap; font-size:0.82rem;">
              ${idBuscar ? `<a href="#" style="color:var(--color-info); font-weight:600;" onclick="event.preventDefault(); const i=document.getElementById('${idBuscar}'); if(i){ i.value='${_esc(l)}'; i.dispatchEvent(new Event('input',{bubbles:true})) }">${_esc(l)}</a>` : _esc(l)}</td>
            ${meses.map(m => {
              const v = celda[`${l}|${m}`] || 0
              const a = v > 0 ? 0.12 + 0.88 * (v / max) : 0
              return `<td title="${_esc(l)} · ${_labelMes(m)} · ${_fmt(v)} kg" style="min-width:44px; height:30px; text-align:center; border-radius:4px; font-size:0.72rem;
                background:${v > 0 ? `rgba(59,130,246,${a.toFixed(2)})` : 'var(--bg-tertiary)'}; color:${a > 0.55 ? '#fff' : 'var(--text-primary)'};">${v > 0 ? _fmt(v) : ''}</td>`
            }).join('')}
            <td style="padding:6px 8px; text-align:right; font-weight:700; font-size:0.82rem;">${_fmt(total[l])}</td>
          </tr>`).join('')}
          <tr><td style="padding:6px 8px; font-weight:700; font-size:0.78rem; color:var(--text-secondary);">Total mes</td>
            ${meses.map(m => `<td style="text-align:center; font-weight:700; font-size:0.72rem;">${totMes[m] ? _fmt(totMes[m]) : ''}</td>`).join('')}
            <td style="padding:6px 8px; text-align:right; font-weight:700;">${_fmt(filas.reduce((s, l) => s + total[l], 0))}</td></tr>
        </tbody>
      </table>
    </div>`
}
