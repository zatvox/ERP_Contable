// ============================================================================
// estadisticas/motor.js — Motor de estadísticas ZV
// Recibe la config de CUALQUIER reporte (datos + dimensiones + medidas + kpis) y arma:
// buscador general, filtros (período, multiselección), KPIs con variación vs período anterior,
// frases de interpretación, gráfico según intención (evolución, Pareto, treemap, dona, calor,
// cascada, apilado), tabla con orden asc/desc, participación y menú ⋮ de columnas, CSV.
// Gráficos: Apache ECharts (CDN en dashboard.html). Sin ECharts queda solo la tabla.
// ============================================================================
import { _calcularMedidas, formatearMedida, nombreMes } from '../reportes.js'
import { registrarColumnas, colMenuHtml, colStyle } from '../col-menu.js'

const PAL = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6']
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const num = v => parseFloat(v) || 0
const hoyISO = () => new Date().toISOString().slice(0, 10)
const addDias = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const difDias = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000)
const fmt = (v, f) => f === 'pct' ? num(v).toFixed(1) + ' %' : formatearMedida(v, f)
const compacto = (v, f) => {
  const a = Math.abs(v)
  if (f === 'pct') return v.toFixed(0) + '%'
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'k'
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: f === 'int' || f === 'qty' ? 0 : 2 })
}
const MALAS_SUBEN = /pendiente|vencid|deuda|costo|descuadre|por pagar|por cobrar|mora/i
const VISTAS = [['evolucion', 'Evolución', '📈'], ['pareto', 'Ranking Pareto', '🎯'], ['treemap', 'Composición', '🧩'], ['dona', 'Dona', '🍩'], ['calor', 'Mapa de calor', '🔥'], ['cascada', 'Cascada', '🌊'], ['apilado', 'Apilado', '📚']]
const INTENCION_VISTA = { evolucion: 'evolucion', ranking: 'pareto', composicion: 'treemap', antiguedad: 'apilado', flujo: 'cascada' }

export function montar(host, config, meta = {}) {
  const datos = Array.isArray(config.datos) ? config.datos : []
  const dims = config.dimensiones || [], meds = config.medidas || []
  const idRep = meta.id || config.id || 'rep'
  const fechaDim = dims.find(d => d.tipo === 'fecha') || null
  const row0 = datos[0] || {}
  const campoFecha = fechaDim ? (fechaDim.campo || fechaDim.key)
    : Object.keys(row0).find(k => /fecha/i.test(k) && /^\d{4}-\d{2}-\d{2}/.test(String(row0[k] || ''))) || null
  const catDims = dims.filter(d => d.tipo !== 'fecha')
  const dimLabel = k => (dims.find(d => d.key === k) || {}).label || k
  const medida = k => meds.find(m => m.key === k) || meds[0]

  const E = { buscar: '', desde: '', hasta: '', chip: 'todo', sel: {}, medida: meds[0]?.key, medida2: '', dim: catDims[0]?.key || (fechaDim ? fechaDim.key : ''), dim2: '', gran: fechaDim?.granularidad || 'mes', top: 15, vista: null, orden: { key: null, dir: 'desc' } }

  const esDimFecha = k => !!fechaDim && k === fechaDim.key
  const clavePeriodo = (iso, g) => {
    const f = String(iso || '').slice(0, 10)
    if (!/^\d{4}-\d{2}/.test(f)) return '(sin fecha)'
    return g === 'anio' ? f.slice(0, 4) : g === 'dia' ? f : f.slice(0, 7)
  }
  const claveDim = (r, k) => {
    if (esDimFecha(k)) return clavePeriodo(r[campoFecha], E.gran)
    const v = r[k]; return v === null || v === undefined || v === '' ? '(sin dato)' : String(v)
  }
  const etiqueta = k => /^\d{4}-\d{2}$/.test(k) ? nombreMes(k) : /^\d{4}-\d{2}-\d{2}$/.test(k) ? k.split('-').reverse().join('/') : k
  const val = (m, rows) => num(_calcularMedidas(rows, [m])[m.key]) * (m.escala || 1)

  const opcionesDim = {}
  catDims.forEach(d => {
    const mp = new Map(); datos.forEach(r => { const k = claveDim(r, d.key); mp.set(k, (mp.get(k) || 0) + 1) })
    if (mp.size >= 2 && mp.size <= 300) opcionesDim[d.key] = [...mp.entries()].sort((a, b) => b[1] - a[1])
  })
  const dimsFiltro = Object.keys(opcionesDim).slice(0, 8)

  const _txt = new WeakMap()
  const txt = r => { let t = _txt.get(r); if (t === undefined) { t = Object.values(r).filter(v => v !== null && v !== undefined && typeof v !== 'object' && typeof v !== 'function').join(' ').toLowerCase(); _txt.set(r, t) } return t }
  const filtrar = (o = {}) => {
    const desde = o.desde !== undefined ? o.desde : E.desde, hasta = o.hasta !== undefined ? o.hasta : E.hasta
    const toks = E.buscar.toLowerCase().split(/\s+/).filter(Boolean)
    return datos.filter(r => {
      if (toks.length) { const t = txt(r); for (const k of toks) if (!t.includes(k)) return false }
      for (const [k, set] of Object.entries(E.sel)) if (set.size && !set.has(claveDim(r, k))) return false
      if (campoFecha && (desde || hasta)) {
        const f = String(r[campoFecha] || '').slice(0, 10)
        if (!f || (desde && f < desde) || (hasta && f > hasta)) return false
      }
      return true
    })
  }
  const ventanaPrev = () => {
    if (!campoFecha || (!E.desde && !E.hasta)) return null
    const h = E.hasta || hoyISO()
    const d = E.desde || (datos.map(r => String(r[campoFecha] || '').slice(0, 10)).filter(Boolean).sort()[0] || h)
    const len = difDias(d, h) + 1; if (len < 1) return null
    const ph = addDias(d, -1)
    return { desde: addDias(ph, -(len - 1)), hasta: ph }
  }
  const ventanaChip = c => {
    const h = hoyISO(), y = h.slice(0, 4), m = h.slice(5, 7)
    if (c === 'mes') return [`${y}-${m}-01`, h]
    if (c === 'mesant') return [new Date(Date.UTC(+y, +m - 2, 1)).toISOString().slice(0, 10), new Date(Date.UTC(+y, +m - 1, 0)).toISOString().slice(0, 10)]
    if (c === '3m') return [addDias(h, -90), h]
    if (c === 'anio') return [`${y}-01-01`, h]
    if (c === '12m') return [addDias(h, -365), h]
    return ['', '']
  }

  const agrupa = (rows, dimKey) => { const mp = new Map(); rows.forEach(r => { const k = claveDim(r, dimKey); if (!mp.has(k)) mp.set(k, []); mp.get(k).push(r) }); return mp }
  const periodos = (rows, m) => {
    if (!campoFecha) return []
    const mp = new Map(); rows.forEach(r => { const k = clavePeriodo(r[campoFecha], E.gran); if (k === '(sin fecha)') return; if (!mp.has(k)) mp.set(k, []); mp.get(k).push(r) })
    return [...mp.keys()].sort().map(k => ({ k, label: etiqueta(k), v: val(m, mp.get(k)), rows: mp.get(k) }))
  }
  const ranking = (rows, dimKey, m) => [...agrupa(rows, dimKey).entries()].map(([k, rs]) => ({ k, v: val(m, rs), rows: rs })).sort((a, b) => b.v - a.v)
  const dimCat = () => (E.dim && !esDimFecha(E.dim) ? E.dim : catDims[0]?.key || '')
  const dim2Cat = () => (E.dim2 && E.dim2 !== dimCat() ? E.dim2 : (catDims.find(d => d.key !== dimCat()) || {}).key) || ''

  const vistasOk = () => { const f = !!campoFecha, c = catDims.length > 0; return { evolucion: f, pareto: c, treemap: c, dona: c, calor: f && c, cascada: f, apilado: c && (f || catDims.length > 1) } }
  const vistaDefault = () => {
    const ok = vistasOk(); let v = INTENCION_VISTA[meta.intencion]
    if (v === 'treemap' && Object.values(opcionesDim)[0]?.length <= 7) v = 'dona'
    if (v && ok[v]) return v
    return ['evolucion', 'pareto', 'treemap', 'cascada'].find(x => ok[x]) || null
  }
  E.vista = vistaDefault()

  const tema = () => {
    const cs = getComputedStyle(document.body), g = n => cs.getPropertyValue(n).trim()
    return { txt: g('--text-primary') || '#e5e7eb', sec: g('--text-secondary') || '#94a3b8', line: g('--border-color') || '#334155', bg: g('--bg-secondary') || '#1e293b' }
  }
  const baseOpt = T => ({
    textStyle: { fontFamily: 'inherit', color: T.txt },
    tooltip: { backgroundColor: T.bg, borderColor: T.line, textStyle: { color: T.txt, fontSize: 13 }, confine: true },
    legend: { textStyle: { color: T.sec, fontSize: 12 }, icon: 'roundRect', itemHeight: 8, itemWidth: 14 },
    animationDuration: 600
  })
  const ejeX = (T, data, rot) => ({ type: 'category', data, axisLine: { lineStyle: { color: T.line } }, axisTick: { show: false }, axisLabel: { color: T.sec, fontSize: 12, rotate: rot || 0, width: 110, overflow: 'truncate', hideOverlap: true } })
  const ejeY = (T, f, extra = {}) => ({ type: 'value', axisLabel: { color: T.sec, fontSize: 12, formatter: v => compacto(v, f) }, splitLine: { lineStyle: { color: T.line, opacity: .55, type: 'dashed' } }, ...extra })
  const grad = c => ({ type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: c }, { offset: 1, color: c + '55' }] })
  const zoom = (T, n) => n > 14 ? [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 8, borderColor: T.line, textStyle: { color: T.sec } }] : []

  function opcionGrafico(rows) {
    const T = tema(), M = medida(E.medida), M2 = E.medida2 && E.medida2 !== E.medida ? medida(E.medida2) : null, o = baseOpt(T)
    const axTip = fn => ({ ...o.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: fn })
    switch (E.vista) {
      case 'evolucion': {
        const P = periodos(rows, M); if (!P.length) return null
        const P2 = M2 ? periodos(rows, M2) : null, dual = M2 && M2.formato !== M.formato
        const mm = P.map((p, i) => { const w = P.slice(Math.max(0, i - 2), i + 1); return +(w.reduce((s, x) => s + x.v, 0) / w.length).toFixed(4) })
        return { ...o, color: PAL, grid: { left: 64, right: dual ? 64 : 24, top: 52, bottom: P.length > 14 ? 64 : 36 }, legend: { ...o.legend, top: 6, right: 10 },
          tooltip: axTip(ps => `<b>${esc(ps[0].axisValue)}</b><br>` + ps.map(p => `${p.marker} ${esc(p.seriesName)}: <b>${fmt(p.value, p.seriesIndex === 0 ? M.formato : (M2 ? M2.formato : M.formato))}</b>`).join('<br>')),
          xAxis: ejeX(T, P.map(p => p.label)), yAxis: dual ? [ejeY(T, M.formato), ejeY(T, M2.formato, { splitLine: { show: false } })] : ejeY(T, M.formato), dataZoom: zoom(T, P.length),
          series: [
            { name: M.label, type: 'bar', data: P.map(p => p.v), barMaxWidth: 46, itemStyle: { borderRadius: [8, 8, 0, 0], color: grad(PAL[0]) }, label: { show: P.length <= 12, position: 'top', color: T.sec, fontSize: 11, formatter: p => compacto(p.value, M.formato) } },
            M2 ? { name: M2.label, type: 'line', yAxisIndex: dual ? 1 : 0, smooth: true, symbolSize: 8, lineStyle: { width: 3 }, itemStyle: { color: PAL[1] }, data: P.map(p => (P2.find(x => x.k === p.k) || {}).v ?? 0) }
              : { name: 'Tendencia (prom. móvil 3)', type: 'line', smooth: true, showSymbol: false, lineStyle: { width: 3, color: PAL[2] }, data: mm }] }
      }
      case 'pareto': {
        const R = ranking(rows, dimCat(), M); if (!R.length) return null
        const tot = R.reduce((s, x) => s + Math.max(0, x.v), 0) || 1, top = E.top ? R.slice(0, E.top) : R
        let acc = 0; const cum = top.map(x => { acc += Math.max(0, x.v); return +(acc / tot * 100).toFixed(1) })
        let a2 = 0, corte = R.length - 1; for (let i = 0; i < R.length; i++) { a2 += Math.max(0, R[i].v); if (a2 / tot >= .8) { corte = i; break } }
        return { ...o, color: PAL, grid: { left: 64, right: 56, top: 56, bottom: 88 }, legend: { ...o.legend, top: 6, right: 10 },
          tooltip: axTip(ps => `<b>${esc(ps[0].axisValue)}</b><br>` + ps.map(p => `${p.marker} ${esc(p.seriesName)}: <b>${p.seriesIndex === 0 ? fmt(p.value, M.formato) : p.value + ' %'}</b>`).join('<br>')),
          xAxis: ejeX(T, top.map(x => etiqueta(x.k)), 28), yAxis: [ejeY(T, M.formato), ejeY(T, 'pct', { max: 100, splitLine: { show: false }, axisLabel: { color: T.sec, formatter: '{value}%' } })],
          series: [
            { name: M.label, type: 'bar', barMaxWidth: 44, data: top.map((x, i) => ({ value: x.v, itemStyle: { borderRadius: [8, 8, 0, 0], color: grad(i <= corte ? PAL[0] : '#64748b') } })), label: { show: top.length <= 12, position: 'top', color: T.sec, fontSize: 11, formatter: p => compacto(p.value, M.formato) } },
            { name: '% acumulado', type: 'line', yAxisIndex: 1, smooth: true, symbolSize: 7, lineStyle: { width: 3, color: PAL[2] }, itemStyle: { color: PAL[2] }, data: cum, markLine: { silent: true, symbol: 'none', lineStyle: { color: PAL[4], type: 'dashed' }, label: { color: PAL[4], formatter: '80 %' }, data: [{ yAxis: 80 }] } }] }
      }
      case 'treemap': {
        const R = ranking(rows, dimCat(), M).filter(x => x.v > 0).slice(0, 40); if (!R.length) return null
        return { ...o, color: PAL, tooltip: { ...o.tooltip, formatter: p => `<b>${esc(p.name)}</b><br>${fmt(p.value, M.formato)}` },
          series: [{ type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false }, left: 6, right: 6, top: 6, bottom: 6,
            label: { show: true, color: '#fff', fontSize: 13, fontWeight: 600, formatter: p => `${p.name}\n${compacto(p.value, M.formato)}`, overflow: 'truncate' },
            itemStyle: { borderColor: T.bg, borderWidth: 3, gapWidth: 2, borderRadius: 8 }, data: R.map((x, i) => ({ name: etiqueta(x.k), value: x.v, itemStyle: { color: PAL[i % PAL.length] } })) }] }
      }
      case 'dona': {
        const R = ranking(rows, dimCat(), M).filter(x => x.v > 0); if (!R.length) return null
        const top = R.slice(0, 8), resto = R.slice(8).reduce((s, x) => s + x.v, 0), tot = R.reduce((s, x) => s + x.v, 0)
        const data = top.map(x => ({ name: etiqueta(x.k), value: x.v })); if (resto > 0) data.push({ name: 'Otros', value: resto, itemStyle: { color: '#64748b' } })
        return { ...o, color: PAL, tooltip: { ...o.tooltip, formatter: p => `${p.marker} ${esc(p.name)}<br><b>${fmt(p.value, M.formato)}</b> · ${p.percent}%` }, legend: { ...o.legend, orient: 'vertical', right: 16, top: 'middle' },
          graphic: [{ type: 'text', left: '31%', top: '43%', style: { text: compacto(tot, M.formato), fill: T.txt, font: '700 26px sans-serif', textAlign: 'center' } }, { type: 'text', left: '31%', top: '53%', style: { text: M.label, fill: T.sec, font: '13px sans-serif', textAlign: 'center' } }],
          series: [{ type: 'pie', center: ['38%', '50%'], radius: ['48%', '74%'], padAngle: 2, itemStyle: { borderRadius: 10, borderColor: T.bg, borderWidth: 2 }, label: { color: T.sec, fontSize: 12, formatter: '{b}\n{d}%' }, data }] }
      }
      case 'calor': {
        const P = periodos(rows, M).slice(-24), dk = dimCat(), C = ranking(rows, dk, M).slice(0, 12); if (!P.length || !C.length) return null
        const data = []; C.forEach((c, yi) => P.forEach((p, xi) => { const rs = p.rows.filter(r => claveDim(r, dk) === c.k); data.push([xi, yi, rs.length ? val(M, rs) : 0]) }))
        const mx = Math.max(...data.map(d => d[2]), 1e-9)
        return { ...o, grid: { left: 150, right: 24, top: 24, bottom: 76 }, tooltip: { ...o.tooltip, formatter: p => `<b>${esc(C[p.value[1]].k)}</b> · ${esc(P[p.value[0]].label)}<br>${esc(M.label)}: <b>${fmt(p.value[2], M.formato)}</b>` },
          xAxis: { ...ejeX(T, P.map(p => p.label)), splitArea: { show: true } }, yAxis: { type: 'category', data: C.map(c => etiqueta(c.k)), inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: T.sec, fontSize: 12, width: 130, overflow: 'truncate' } },
          visualMap: { min: 0, max: mx, calculable: true, orient: 'horizontal', left: 'center', bottom: 6, textStyle: { color: T.sec }, inRange: { color: ['#e0f2fe', '#7dd3fc', '#3b82f6', '#1e3a8a'] }, formatter: v => compacto(v, M.formato) },
          series: [{ type: 'heatmap', data, label: { show: data.length <= 120, color: '#0f172a', fontSize: 10, formatter: p => p.value[2] ? compacto(p.value[2], M.formato) : '' }, itemStyle: { borderColor: T.bg, borderWidth: 2, borderRadius: 4 } }] }
      }
      case 'cascada': {
        const P = periodos(rows, M); if (!P.length) return null
        let acc = 0; const base = [], up = [], down = []
        P.forEach(p => { if (p.v >= 0) { base.push(acc); up.push(p.v); down.push('-'); acc += p.v } else { acc += p.v; base.push(acc); up.push('-'); down.push(-p.v) } })
        const labels = [...P.map(p => p.label), 'Total']
        return { ...o, grid: { left: 64, right: 24, top: 36, bottom: P.length > 14 ? 64 : 36 },
          tooltip: axTip(ps => { const i = ps[0].dataIndex, v = i < P.length ? P[i].v : acc; return `<b>${esc(labels[i])}</b><br>${esc(M.label)}: <b>${fmt(v, M.formato)}</b>` }),
          xAxis: ejeX(T, labels), yAxis: ejeY(T, M.formato), dataZoom: zoom(T, P.length),
          series: [
            { type: 'bar', stack: 'w', silent: true, itemStyle: { color: 'transparent' }, data: [...base, 0] },
            { name: 'Aumenta', type: 'bar', stack: 'w', barMaxWidth: 44, itemStyle: { color: PAL[1], borderRadius: [6, 6, 0, 0] }, data: [...up, '-'], label: { show: P.length <= 12, position: 'top', color: T.sec, fontSize: 11, formatter: p => p.value === '-' ? '' : compacto(p.value, M.formato) } },
            { name: 'Disminuye', type: 'bar', stack: 'w', barMaxWidth: 44, itemStyle: { color: PAL[4], borderRadius: [6, 6, 0, 0] }, data: [...down, '-'] },
            { name: 'Total', type: 'bar', stack: 'w2', barMaxWidth: 44, itemStyle: { color: PAL[0], borderRadius: [6, 6, 0, 0] }, data: [...P.map(() => '-'), acc] }] }
      }
      case 'apilado': {
        const usaFecha = !!campoFecha, sk = usaFecha ? dimCat() : dim2Cat(); if (!sk) return null
        const X = usaFecha ? periodos(rows, M).map(p => ({ label: p.label, rows: p.rows })) : ranking(rows, dimCat(), M).slice(0, E.top || 15).map(x => ({ label: etiqueta(x.k), rows: x.rows }))
        const S = ranking(rows, sk, M); if (!X.length || !S.length) return null
        const top = S.slice(0, 7).map(s => s.k), serie = k => X.map(x => val(M, x.rows.filter(r => k === '__otros' ? !top.includes(claveDim(r, sk)) : claveDim(r, sk) === k)))
        const series = top.map((k, i) => ({ name: etiqueta(k), type: 'bar', stack: 'a', barMaxWidth: 46, emphasis: { focus: 'series' }, itemStyle: { color: PAL[i % PAL.length] }, data: serie(k) }))
        if (S.length > 7) series.push({ name: 'Otros', type: 'bar', stack: 'a', barMaxWidth: 46, emphasis: { focus: 'series' }, itemStyle: { color: '#64748b' }, data: serie('__otros') })
        return { ...o, color: PAL, grid: { left: 64, right: 24, top: 56, bottom: X.length > 14 ? 76 : 48 }, legend: { ...o.legend, top: 6, right: 10 },
          tooltip: axTip(ps => `<b>${esc(ps[0].axisValue)}</b><br>` + ps.filter(p => p.value).map(p => `${p.marker} ${esc(p.seriesName)}: <b>${fmt(p.value, M.formato)}</b>`).join('<br>')),
          xAxis: ejeX(T, X.map(x => x.label), usaFecha ? 0 : 28), yAxis: ejeY(T, M.formato), dataZoom: zoom(T, X.length), series }
      }
    }
    return null
  }

  function frases(rows) {
    const M = medida(E.medida), out = []
    if (!rows.length || !M) return out
    const P = periodos(rows, M)
    if (P.length >= 2) {
      const a = P[P.length - 1], b = P[P.length - 2]
      if (b.v) { const d = (a.v - b.v) / Math.abs(b.v) * 100; out.push(`${d >= 0 ? '📈' : '📉'} En <b>${esc(a.label)}</b> ${esc(M.label)} ${d >= 0 ? 'subió' : 'bajó'} <b>${Math.abs(d).toFixed(1)} %</b> frente a ${esc(b.label)} (${fmt(b.v, M.formato)} → ${fmt(a.v, M.formato)}).`) }
      const mejor = [...P].sort((x, y) => y.v - x.v)[0]; out.push(`🏆 Mejor período: <b>${esc(mejor.label)}</b> con ${fmt(mejor.v, M.formato)}.`)
    }
    const dk = dimCat()
    if (dk) {
      const R = ranking(rows, dk, M).filter(x => x.v > 0), tot = R.reduce((s, x) => s + x.v, 0)
      if (R.length >= 3 && tot > 0) {
        let acc = 0, n = 0; for (const x of R) { acc += x.v; n++; if (acc / tot >= .8) break }
        out.push(`🎯 <b>${n}</b> de ${R.length} ${esc(dimLabel(dk).toLowerCase())} generan el <b>80 %</b> de ${esc(M.label)}.`)
        out.push(`⭐ <b>${esc(etiqueta(R[0].k))}</b> lidera con ${fmt(R[0].v, M.formato)} (${(R[0].v / tot * 100).toFixed(1)} %).`)
      }
    }
    return out.slice(0, 4)
  }

  const kpisDe = rows => {
    if (config.kpis) { try { const k = config.kpis(rows); if (Array.isArray(k) && k.length) return { lista: k, curados: true } } catch (e) { console.warn('kpis', e) } }
    return { lista: meds.slice(0, 4).map(m => ({ label: m.label, valor: val(m, rows), formato: m.formato, _m: m })), curados: false }
  }
  const spark = (m, rows) => {
    const P = periodos(rows, m).slice(-12); if (P.length < 2) return ''
    const vs = P.map(p => p.v), mn = Math.min(...vs), r = (Math.max(...vs) - mn) || 1
    return `<svg class="zs-spark" viewBox="0 0 100 28" preserveAspectRatio="none"><polyline points="${vs.map((v, i) => `${(i / (vs.length - 1) * 100).toFixed(1)},${(26 - (v - mn) / r * 22).toFixed(1)}`).join(' ')}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  }

  const colTabla = 'est_' + idRep
  registrarColumnas(colTabla, [{ key: '_part', label: 'Participación' }, ...meds.map(m => ({ key: m.key, label: m.label }))])
  const chipsRango = [['todo', 'Todo'], ['mes', 'Este mes'], ['mesant', 'Mes anterior'], ['3m', '3 meses'], ['anio', 'Año actual'], ['12m', '12 meses']]
  const icoBuscar = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>'
  const optsMed = meds.map(m => `<option value="${esc(m.key)}">${esc(m.label)}</option>`).join('')
  const optsDim = catDims.map(d => `<option value="${esc(d.key)}">${esc(d.label)}</option>`).join('')

  host.innerHTML = `<div class="zs">
    ${meta.pregunta ? `<div class="zs-q"><span>❓</span><div><small>Pregunta que responde</small><b>${esc(meta.pregunta)}</b></div><em>${datos.length.toLocaleString('en-US')} registros</em></div>` : ''}
    <div class="zs-bar">
      <label class="zs-search">${icoBuscar}<input type="search" id="zsBuscar" placeholder="Buscar en todo el reporte (cliente, producto, comprobante…)" autocomplete="off"></label>
      ${campoFecha ? `<div class="zs-seg" id="zsChips">${chipsRango.map(([k, t]) => `<button type="button" data-chip="${k}" class="${k === 'todo' ? 'on' : ''}">${t}</button>`).join('')}</div>
      <div class="zs-fechas"><input type="date" id="zsDesde" title="Desde"><span>→</span><input type="date" id="zsHasta" title="Hasta"></div>` : ''}
      ${dimsFiltro.map(k => `<details class="zs-ms" data-dim="${esc(k)}"><summary>${esc(dimLabel(k))} <b>todos</b></summary>
        <div class="zs-ms-b"><input type="search" placeholder="Buscar…" class="zs-ms-q"><div class="zs-ms-a"><button type="button" data-a="none">Ninguno</button><button type="button" data-a="all">Todos</button></div>
        <div class="zs-ms-l">${opcionesDim[k].slice(0, 200).map(([v, n]) => `<label><input type="checkbox" value="${esc(v)}"><span>${esc(etiqueta(v))}</span><small>${n}</small></label>`).join('')}</div></div></details>`).join('')}
      <button type="button" class="zs-btn" id="zsLimpiar" title="Quitar búsqueda y filtros">↺ Limpiar</button>
    </div>
    <div class="zs-kpis" id="zsKpis"></div>
    <div class="zs-ins" id="zsIns"></div>
    <section class="zs-card">
      <header class="zs-ch">
        <div class="zs-seg" id="zsVistas">${VISTAS.map(([k, t, i]) => `<button type="button" data-v="${k}" title="${t}">${i} ${t}</button>`).join('')}</div>
        <div class="zs-sel">
          <label>Medida<select id="zsMed">${optsMed}</select></label>
          ${meds.length > 1 ? `<label>Comparar con<select id="zsMed2"><option value="">— nada —</option>${optsMed}</select></label>` : ''}
          ${catDims.length ? `<label>Agrupar por<select id="zsDim">${optsDim}</select></label>` : ''}
          ${catDims.length > 1 ? `<label id="zsDim2W">Dividir por<select id="zsDim2">${optsDim}</select></label>` : ''}
          ${campoFecha ? `<label>Período<select id="zsGran"><option value="dia">Día</option><option value="mes">Mes</option><option value="anio">Año</option></select></label>` : ''}
          <label>Mostrar<select id="zsTop"><option value="5">Top 5</option><option value="10">Top 10</option><option value="15">Top 15</option><option value="30">Top 30</option><option value="0">Todos</option></select></label>
        </div>
      </header>
      <div id="zsChart" class="zs-chart"></div>
    </section>
    <section class="zs-card zs-tcard" id="zsTCard">
      ${colMenuHtml(colTabla, 'zsColMenu', 'zsColMenuDd')}
      <header class="zs-ch"><h4>Detalle <span id="zsTn"></span></h4><div class="zs-sel"><button type="button" class="zs-btn" id="zsCsv">⬇ CSV</button></div></header>
      <div class="zs-tw" id="zsTabla"></div>
    </section>
  </div>`

  const $ = id => host.querySelector('#' + id)
  $('zsMed').value = E.medida; if ($('zsMed2')) $('zsMed2').value = E.medida2
  if ($('zsDim')) $('zsDim').value = dimCat()
  if ($('zsDim2')) $('zsDim2').value = dim2Cat()
  if ($('zsGran')) $('zsGran').value = E.gran
  $('zsTop').value = String(E.top)

  let chart = null
  const hayEcharts = () => typeof window.echarts !== 'undefined'

  function pintarKpis(rows) {
    const act = kpisDe(rows), prevW = ventanaPrev(), prev = prevW ? kpisDe(filtrar(prevW)) : null
    $('zsKpis').innerHTML = act.lista.map((k, i) => {
      let d = ''
      if (prev && prev.lista[i] && prev.lista[i].label === k.label) {
        const a = num(k.valor), b = num(prev.lista[i].valor)
        if (b) { const p = (a - b) / Math.abs(b) * 100, sube = p >= 0, mala = MALAS_SUBEN.test(k.label) ? sube : !sube
          d = `<span class="zs-d ${Math.abs(p) < .05 ? '' : mala ? 'mal' : 'bien'}">${sube ? '▲' : '▼'} ${Math.abs(p).toFixed(1)} %<small>vs período anterior</small></span>` }
        else d = '<span class="zs-d"><small>sin período anterior</small></span>'
      }
      return `<div class="zs-kpi" style="--c:${PAL[i % PAL.length]}"><div class="zs-kl">${esc(k.label)}</div><div class="zs-kv">${fmt(k.valor, k.formato)}</div>${d}${!act.curados && k._m ? spark(k._m, rows) : ''}</div>`
    }).join('')
  }

  function pintarChart(rows) {
    const el = $('zsChart'), ok = vistasOk()
    host.querySelectorAll('#zsVistas button').forEach(b => { b.classList.toggle('on', b.dataset.v === E.vista); b.disabled = !ok[b.dataset.v] })
    if ($('zsDim2W')) $('zsDim2W').style.display = E.vista === 'apilado' && !campoFecha ? '' : 'none'
    el.style.height = (E.vista === 'calor' ? 500 : 420) + 'px'
    if (!hayEcharts()) { el.innerHTML = '<div class="zs-vacio">No se cargó la librería de gráficos (¿sin internet?). Se muestra solo la tabla.</div>'; return }
    const opt = rows.length && E.vista ? opcionGrafico(rows) : null
    if (!opt) { if (chart) { chart.dispose(); chart = null } el.innerHTML = '<div class="zs-vacio">Sin datos para este gráfico con los filtros actuales.</div>'; return }
    if (!chart || el.querySelector('.zs-vacio')) { if (chart) chart.dispose(); el.innerHTML = ''; chart = window.echarts.init(el) }
    chart.setOption(opt, true); chart.resize()
  }

  const grupoTabla = rows => {
    const dk = E.dim || (fechaDim ? fechaDim.key : '')
    const mp = dk ? agrupa(rows, dk) : new Map([['Total', rows]])
    const arr = [...mp.entries()].map(([k, rs]) => ({ k, label: etiqueta(k), rows: rs, vals: Object.fromEntries(meds.map(m => [m.key, val(m, rs)])) }))
    const ok = E.orden.key, s = E.orden.dir === 'asc' ? 1 : -1
    if (ok === '_label') arr.sort((a, b) => (/^\d{4}/.test(a.k) ? a.k.localeCompare(b.k) : a.label.localeCompare(b.label, 'es', { numeric: true })) * s)
    else if (ok) arr.sort((a, b) => (a.vals[ok] - b.vals[ok]) * s)
    else if (dk && esDimFecha(dk)) arr.sort((a, b) => a.k.localeCompare(b.k))
    else arr.sort((a, b) => (b.vals[meds[0]?.key] || 0) - (a.vals[meds[0]?.key] || 0))
    return arr
  }
  function pintarTabla(rows) {
    const arr = grupoTabla(rows), M0 = meds[0], tot0 = arr.reduce((s, g) => s + Math.max(0, g.vals[M0?.key] || 0), 0), max0 = Math.max(...arr.map(g => g.vals[M0?.key] || 0), 1e-9)
    const aditiva = M0 && [undefined, 'sum', 'count'].includes(M0.agg)
    const ind = k => E.orden.key === k ? (E.orden.dir === 'asc' ? '▲' : '▼') : '⇅'
    const dk = E.dim || (fechaDim ? fechaDim.key : '')
    const ca = (k) => `data-col-tabla="${colTabla}" data-col="${esc(k)}"${colStyle(colTabla, k)}`
    const cab = `<tr><th data-ord="_label">${esc(dimLabel(dk) || 'Grupo')} <i>${ind('_label')}</i></th>${meds.map(m => `<th class="n" data-ord="${esc(m.key)}" ${ca(m.key)}>${esc(m.label)} <i>${ind(m.key)}</i></th>`).join('')}${aditiva ? `<th class="n" ${ca('_part')}>Participación</th>` : ''}</tr>`
    const filas = arr.slice(0, 300).map(g => `<tr><td class="zs-et">${esc(g.label)}</td>${meds.map((m, i) => {
      const bar = i === 0 && aditiva ? ` style="background:linear-gradient(90deg,color-mix(in srgb,#3b82f6 22%,transparent) ${Math.max(0, (g.vals[m.key] || 0) / max0 * 100).toFixed(1)}%,transparent 0)"` : ''
      return `<td class="n"${bar} ${ca(m.key)}>${fmt(g.vals[m.key], m.formato)}</td>` }).join('')}${aditiva ? `<td class="n" ${ca('_part')}>${tot0 ? (Math.max(0, g.vals[M0.key]) / tot0 * 100).toFixed(1) + ' %' : '—'}</td>` : ''}</tr>`).join('')
    const tot = `<tr class="zs-tot"><td>TOTAL</td>${meds.map(m => `<td class="n" ${ca(m.key)}>${fmt(val(m, rows), m.formato)}</td>`).join('')}${aditiva ? `<td class="n" ${ca('_part')}>100 %</td>` : ''}</tr>`
    $('zsTabla').innerHTML = rows.length ? `<table class="zs-t"><thead>${cab}</thead><tbody>${filas}</tbody><tfoot>${tot}</tfoot></table>${arr.length > 300 ? `<div class="zs-nota">Mostrando 300 de ${arr.length} filas · usa el buscador o los filtros para acotar.</div>` : ''}` : '<div class="zs-vacio">Sin registros con los filtros actuales.</div>'
    $('zsTn').textContent = `· ${arr.length.toLocaleString('en-US')} ${arr.length === 1 ? 'fila' : 'filas'}`
    host.querySelectorAll('#zsTabla th[data-ord]').forEach(th => th.addEventListener('click', () => {
      const k = th.dataset.ord; E.orden = E.orden.key === k ? { key: k, dir: E.orden.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: k === '_label' ? 'asc' : 'desc' }; pintarTabla(filtrar())
    }))
    host._zsArr = arr
  }

  function pintar() {
    const rows = filtrar()
    pintarKpis(rows)
    $('zsIns').innerHTML = frases(rows).map(f => `<span class="zs-i">${f}</span>`).join('')
    pintarChart(rows); pintarTabla(rows)
  }

  let tBuscar = null
  $('zsBuscar').addEventListener('input', e => { clearTimeout(tBuscar); tBuscar = setTimeout(() => { E.buscar = e.target.value; pintar() }, 180) })
  host.querySelectorAll('#zsChips button').forEach(b => b.addEventListener('click', () => {
    E.chip = b.dataset.chip; const [d, h] = ventanaChip(E.chip); E.desde = d; E.hasta = h
    $('zsDesde').value = d; $('zsHasta').value = h
    host.querySelectorAll('#zsChips button').forEach(x => x.classList.toggle('on', x === b)); pintar()
  }))
  ;['zsDesde', 'zsHasta'].forEach(id => $(id)?.addEventListener('change', () => {
    E.desde = $('zsDesde').value; E.hasta = $('zsHasta').value; E.chip = 'custom'
    host.querySelectorAll('#zsChips button').forEach(x => x.classList.remove('on')); pintar()
  }))
  host.querySelectorAll('.zs-ms').forEach(det => {
    const k = det.dataset.dim, sum = det.querySelector('summary b')
    const act = () => { const s = E.sel[k] || new Set(); sum.textContent = s.size ? `${s.size} sel.` : 'todos'; det.classList.toggle('on', s.size > 0) }
    det.addEventListener('toggle', () => { if (!det.open) return; det.classList.remove('der'); const r = det.querySelector('.zs-ms-b').getBoundingClientRect(); if (r.right > window.innerWidth - 8) det.classList.add('der') })
    det.querySelectorAll('.zs-ms-l input').forEach(cb => cb.addEventListener('change', () => { const s = E.sel[k] || (E.sel[k] = new Set()); cb.checked ? s.add(cb.value) : s.delete(cb.value); act(); pintar() }))
    det.querySelector('.zs-ms-q').addEventListener('input', e => { const q = e.target.value.toLowerCase(); det.querySelectorAll('.zs-ms-l label').forEach(l => { l.style.display = l.textContent.toLowerCase().includes(q) ? '' : 'none' }) })
    det.querySelectorAll('.zs-ms-a button').forEach(b => b.addEventListener('click', () => {
      const all = b.dataset.a === 'all', s = E.sel[k] = new Set()
      det.querySelectorAll('.zs-ms-l label').forEach(l => { if (l.style.display === 'none') return; const cb = l.querySelector('input'); cb.checked = all; if (all) s.add(cb.value) }); act(); pintar()
    }))
  })
  const cerrarMs = e => host.querySelectorAll('.zs-ms[open]').forEach(d => { if (!d.contains(e.target)) d.open = false })
  document.addEventListener('click', cerrarMs)
  $('zsLimpiar').addEventListener('click', () => {
    E.buscar = ''; E.desde = ''; E.hasta = ''; E.chip = 'todo'; E.sel = {}; E.orden = { key: null, dir: 'desc' }
    $('zsBuscar').value = ''; if ($('zsDesde')) { $('zsDesde').value = ''; $('zsHasta').value = '' }
    host.querySelectorAll('#zsChips button').forEach(x => x.classList.toggle('on', x.dataset.chip === 'todo'))
    host.querySelectorAll('.zs-ms').forEach(d => { d.classList.remove('on'); d.querySelector('summary b').textContent = 'todos'; d.querySelectorAll('.zs-ms-l input').forEach(c => { c.checked = false }) }); pintar()
  })
  host.querySelectorAll('#zsVistas button').forEach(b => b.addEventListener('click', () => { if (b.disabled) return; E.vista = b.dataset.v; pintarChart(filtrar()) }))
  $('zsMed').addEventListener('change', e => { E.medida = e.target.value; pintar() })
  $('zsMed2')?.addEventListener('change', e => { E.medida2 = e.target.value; pintarChart(filtrar()) })
  $('zsDim')?.addEventListener('change', e => { E.dim = e.target.value; E.orden = { key: null, dir: 'desc' }; pintar() })
  $('zsDim2')?.addEventListener('change', e => { E.dim2 = e.target.value; pintarChart(filtrar()) })
  $('zsGran')?.addEventListener('change', e => { E.gran = e.target.value; pintar() })
  $('zsTop').addEventListener('change', e => { E.top = +e.target.value; pintarChart(filtrar()) })
  $('zsCsv').addEventListener('click', () => {
    const arr = host._zsArr || [], dk = E.dim || (fechaDim ? fechaDim.key : '')
    const head = [dimLabel(dk) || 'Grupo', ...meds.map(m => m.label)]
    const body = arr.map(g => [g.label, ...meds.map(m => g.vals[m.key] ?? 0)])
    const csv = [head, ...body].map(f => f.map(c => { const s = String(c ?? ''); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }).join(';')).join('\n')
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })); a.download = `${idRep}.csv`; a.click()
  })
  const ro = new ResizeObserver(() => chart && chart.resize()); ro.observe($('zsChart'))
  const mo = new MutationObserver(() => pintarChart(filtrar())); mo.observe(document.body, { attributes: true, attributeFilter: ['class'] })

  pintar()
  return () => { ro.disconnect(); mo.disconnect(); document.removeEventListener('click', cerrarMs); if (chart) chart.dispose(); host.innerHTML = '' }
}
