// ============================================================================
// shared/arbol-reporte.js — Tabla del reporte como ÁRBOL desplegable / CRUZADA (pivote) + auditoría
// Lo usa reportes.js. Recibe un "ctx" ya calculado (filtrados, medidas, niveles, helpers) y devuelve HTML;
// no toca la base de datos ni el estado global del reporte (solo lee/escribe `ctx.estado`).
//
//  · ÁRBOL    cada chip «Agrupar por» es un NIVEL (en el orden elegido): ▸ Mes → ▸ Moneda → Cliente.
//             Cada grupo muestra su subtotal, su peso dentro del padre (barra) y — si el nivel es una
//             fecha — la variación contra el período anterior (▲▼). Clic en la fila abre/cierra.
//  · CRUZADA  nivel 1 en filas × nivel 2 en columnas, con mapa de calor y totales.
//  · AUDITAR  clic en CUALQUIER cifra → ventana con los registros que la componen (y CSV).
//  · 80/20    «Solo lo que pesa»: oculta la cola que no llega al 80 % de cada grupo.
//  · ALERTAS  ⚠ en grupos «(sin dato)» o con resultado negativo; filtro «solo alertas».
// ============================================================================
import { alertaDeNodo } from './observaciones-reporte.js'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const MALAS_SUBEN = /pendiente|vencid|deuda|costo|descuadre|por pagar|por cobrar|mora/i
const SEP = '\u0001'
const etq = s => String(s ?? '').replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, '$3/$2/$1')
const RESULTADO = /margen|utilidad|resultado|ganancia/i

const esFecha = (ctx, k) => (ctx.config.dimensiones || []).find(d => d.key === k)?.tipo === 'fecha'
const resolver = ctx => ctx.resolver || ((f, k) => (f[k] === null || f[k] === undefined || f[k] === '' ? '(sin dato)' : String(f[k])))
const aditiva = ctx => { const m = ctx.medidas[0]; return !m || [undefined, 'sum', 'count'].includes(m.agg) }

/** Construye el árbol completo (todos los niveles) con subtotales, orden, alertas y variación. */
export function construirArbol(ctx) {
  const { filtrados, medidas, calc, valorOrd, estado } = ctx, niveles = estado.agrupar, res = resolver(ctx), M0 = medidas[0]
  const idx = new Map()
  const cmpDe = nivel => {
    const fechaNivel = esFecha(ctx, niveles[nivel]), ok = estado.ordenKey, dir = estado.ordenDir === 'asc' ? 1 : -1
    if (ok === '_etiqueta' || (!ok && fechaNivel)) {
      const d = ok ? dir : 1
      return (a, b) => { const va = valorOrd(a.label), vb = valorOrd(b.label); if (va === vb) return 0; return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'es', { numeric: true })) * d }
    }
    const key = ok || M0?.key
    return (a, b) => ((a.vals[key] ?? 0) - (b.vals[key] ?? 0)) * dir
  }
  const construir = (fs, nivel, path) => {
    const mp = new Map()
    fs.forEach(f => { const k = String(res(f, niveles[nivel])); if (!mp.has(k)) mp.set(k, []); mp.get(k).push(f) })
    const lista = [...mp].map(([k, rows]) => {
      const p = path + SEP + k
      const n = { k, label: etq(k), nivel, path: p, filas: rows, vals: calc(rows, medidas), hijos: null, alerta: '', alertaDesc: false }
      idx.set(p, n)
      if (nivel + 1 < niveles.length) n.hijos = construir(rows, nivel + 1, p)
      const negativos = medidas.filter(m => m.semaforo || RESULTADO.test(m.label)).map(m => n.vals[m.key]).filter(v => v < 0)
      n.alerta = alertaDeNodo(n.label, negativos)
      n.alertaDesc = !!n.hijos && n.hijos.some(h => h.alerta || h.alertaDesc)
      return n
    })
    lista.sort(cmpDe(nivel))
    // variación contra el período anterior: solo si este nivel es una fecha
    if (esFecha(ctx, niveles[nivel]) && M0) {
      const cron = [...lista].sort((a, b) => { const va = valorOrd(a.label), vb = valorOrd(b.label); return typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb)) })
      cron.forEach((n, i) => { n.prev = i ? cron[i - 1] : null })
    }
    return lista
  }
  const raiz = niveles.length ? construir(filtrados, 0, '') : []
  return { raiz, idx }
}

const abierto = (ctx, n, forzarAlertas) => {
  if (!n.hijos) return false
  if (forzarAlertas && n.alertaDesc) return true
  const e = ctx.estado.exc?.[n.path]
  return e === undefined ? n.nivel < (ctx.estado.nivelAbierto || 0) : !!e
}

/** Aplica «solo lo que pesa» (80 %) a una lista de hermanos. */
function podar(ctx, lista) {
  const M0 = ctx.medidas[0]
  if (!ctx.estado.pesa || !aditiva(ctx) || !M0 || lista.length < 4) return { vis: lista, resto: null }
  const pos = lista.map(n => Math.max(0, n.vals[M0.key] || 0)), tot = pos.reduce((s, v) => s + v, 0)
  if (!tot) return { vis: lista, resto: null }
  const orden = [...lista].sort((a, b) => (b.vals[M0.key] || 0) - (a.vals[M0.key] || 0)), keep = new Set()
  let acc = 0
  for (const n of orden) { keep.add(n); acc += Math.max(0, n.vals[M0.key] || 0); if (acc / tot >= .8) break }
  const fuera = lista.filter(n => !keep.has(n))
  if (!fuera.length) return { vis: lista, resto: null }
  return { vis: lista.filter(n => keep.has(n)), resto: { n: fuera.length, pct: fuera.reduce((s, n) => s + Math.max(0, n.vals[M0.key] || 0), 0) / tot * 100 } }
}

/** Filas visibles (planas) del árbol según lo que esté abierto. Sirve para HTML y para el PDF. */
export function filasVisibles(ctx, arbol) {
  const out = [], solo = !!ctx.estado.soloAlertas
  const rec = lista => {
    let l = lista
    if (solo) l = l.filter(n => n.alerta || n.alertaDesc)
    const { vis, resto } = podar(ctx, l)
    vis.forEach(n => { out.push({ n }); if (n.hijos && abierto(ctx, n, solo)) rec(n.hijos) })
    if (resto) out.push({ resto, nivel: lista[0]?.nivel || 0 })
  }
  rec(arbol.raiz)
  return out
}

export function contarAlertas(arbol) { let c = 0; arbol.idx.forEach(n => { if (n.alerta) c++ }); return c }

const celdaCifra = (ctx, m, v, path, extra = '') => `<td class="n rp-cifra" data-drill="${esc(path)}" title="Clic: ver los registros que componen esta cifra" style="${ctx.colorMedida(m, v)}">${ctx.fmt(v, m.formato)}${extra}</td>`

function htmlFilaArbol(ctx, f, M0, sumHermanos) {
  if (f.resto) return `<tr class="rp-resto"><td colspan="${2 + ctx.medidas.length}" style="padding-left:${12 + f.nivel * 22}px">… y ${f.resto.n} grupo(s) menores que suman ${f.resto.pct.toFixed(1)} % <small>(apaga «Solo lo que pesa» para verlos)</small></td></tr>`
  const n = f.n, ab = abierto(ctx, n, ctx.estado.soloAlertas), sub = sumHermanos.get(n)
  const cel = ctx.medidas.map((m, i) => {
    let extra = '', estilo = ''
    if (i === 0) {
      if (sub && aditiva(ctx)) { const p = Math.max(0, n.vals[m.key] || 0) / sub.tot * 100; estilo = p; extra = ` <span class="rp-pct">${p.toFixed(0)}%</span>` }
      if (n.prev && m) {
        const a = n.vals[m.key] || 0, b = n.prev.vals[m.key] || 0
        if (b) { const d = (a - b) / Math.abs(b) * 100, sube = d >= 0, mala = MALAS_SUBEN.test(m.label) ? sube : !sube; if (Math.abs(d) >= .05) extra += ` <span class="rp-d ${mala ? 'mal' : 'bien'}" title="vs ${esc(n.prev.label)}">${sube ? '▲' : '▼'}${Math.abs(d).toFixed(0)}%</span>` }
      }
    }
    const td = celdaCifra(ctx, m, n.vals[m.key], n.path, extra)
    return estilo !== '' ? td.replace('style="', `style="background:linear-gradient(90deg,color-mix(in srgb,var(--color-info,#3b82f6) 20%,transparent) ${estilo.toFixed(1)}%,transparent 0);`) : td
  }).join('')
  return `<tr class="rp-nodo rp-n${Math.min(n.nivel, 4)} ${n.hijos ? 'rp-tiene' : ''}" data-path="${esc(n.path)}">
    <td class="rp-etq" style="padding-left:${12 + n.nivel * 22}px">${n.hijos ? `<span class="rp-tog">${ab ? '▾' : '▸'}</span>` : '<span class="rp-hoja">·</span>'}<span class="rp-lbl">${esc(n.label)}</span>${n.alerta ? `<span class="rp-alerta" title="${esc(n.alerta)}">⚠</span>` : ''}${n.hijos ? `<span class="rp-cuenta">${n.hijos.length}</span>` : ''}</td>
    <td class="n" style="color:var(--text-secondary)">${n.filas.length}</td>${cel}</tr>`
}

/** Barra de herramientas sobre la tabla. */
function htmlBarra(ctx, arbol) {
  const e = ctx.estado, nl = e.agrupar.length, vista = e.vista || 'arbol', al = arbol ? contarAlertas(arbol) : 0
  const b = (a, t, on, tip = '') => `<button type="button" class="rp-tb ${on ? 'on' : ''}" data-rpa="${a}" ${tip ? `title="${esc(tip)}"` : ''}>${t}</button>`
  const niv = Array.from({ length: nl }, (_, i) => b('niv:' + (i + 1), String(i + 1), (e.nivelAbierto || 0) === i && !Object.keys(e.exc || {}).length, `Ver hasta el nivel ${i + 1}`)).join('')
  return `<div class="rp-barra">
    <div class="rp-seg">${b('vista:arbol', '🌳 Árbol', vista === 'arbol', 'Desglose por niveles con subtotales')}${b('vista:cruzada', '▦ Cruzada', vista === 'cruzada', 'Nivel 1 en filas × nivel 2 en columnas')}${b('vista:plana', '☰ Plana', vista === 'plana', 'Una fila por combinación (como antes)')}</div>
    ${vista === 'arbol' && nl > 0 ? `<div class="rp-grp"><span>Abrir</span>${b('contraer', '⊟ Todo cerrado')}${nl > 1 ? niv : ''}${b('expandir', '⊞ Todo abierto')}</div>` : ''}
    ${vista === 'cruzada' ? `<div class="rp-grp">${b('swap', '⇄ Intercambiar filas y columnas', false, 'Cambia cuál nivel va en filas y cuál en columnas')}</div>` : ''}
    ${vista !== 'cruzada' && aditiva(ctx) && nl > 0 ? `<div class="rp-grp">${b('pesa', e.pesa ? '☑ Solo lo que pesa (80 %)' : '☐ Solo lo que pesa (80 %)', e.pesa, 'Oculta los grupos pequeños que no llegan al 80 % acumulado')}</div>` : ''}
    ${vista === 'arbol' && al ? `<div class="rp-grp">${b('alertas', `⚠ ${al} alerta${al > 1 ? 's' : ''}${e.soloAlertas ? ' · viendo solo alertas' : ''}`, e.soloAlertas, 'Grupos sin dato o con resultado negativo')}</div>` : ''}
    <div class="rp-hint">💡 Clic en cualquier cifra para auditar sus registros</div></div>`
}

// ── CRUZADA ─────────────────────────────────────────────────────────────────────────────────────
export function matrizCruzada(ctx, maxCols = 60) {
  const { filtrados, estado, valorOrd, medidas, calc } = ctx, res = resolver(ctx)
  const [kr, kc] = estado.agrupar
  if (!kr || !kc) return null
  const M = medidas.find(m => m.key === estado.medCruz) || medidas[0]
  const mp = new Map(), cols = new Map()
  filtrados.forEach(f => {
    const r = String(res(f, kr)), c = String(res(f, kc))
    if (!mp.has(r)) mp.set(r, new Map())
    const fm = mp.get(r); if (!fm.has(c)) fm.set(c, []); fm.get(c).push(f)
    if (!cols.has(c)) cols.set(c, [])
    cols.get(c).push(f)
  })
  const val = fs => (fs && fs.length ? calc(fs, [M])[M.key] : 0)
  let colKeys = [...cols.keys()]
  const fechaC = esFecha(ctx, kc)
  if (fechaC) colKeys.sort((a, b) => { const va = valorOrd(etq(a)), vb = valorOrd(etq(b)); return typeof va === 'number' && typeof vb === 'number' ? va - vb : String(a).localeCompare(String(b)) })
  else colKeys.sort((a, b) => val(cols.get(b)) - val(cols.get(a)))
  const totalCols = colKeys.length
  if (colKeys.length > maxCols) colKeys = colKeys.slice(0, maxCols)
  const filas = [...mp].map(([r, fm]) => { const todas = [...fm.values()].flat(); return { k: r, label: etq(r), celdas: colKeys.map(c => ({ v: val(fm.get(c)), fs: fm.get(c) || [] })), tot: val(todas), fs: todas } })
  const fechaR = esFecha(ctx, kr)
  if (fechaR) filas.sort((a, b) => { const va = valorOrd(a.label), vb = valorOrd(b.label); return typeof va === 'number' && typeof vb === 'number' ? va - vb : String(a.label).localeCompare(String(b.label)) })
  else filas.sort((a, b) => b.tot - a.tot)
  return { M, kr, kc, colKeys, totalCols, filas, colTot: colKeys.map(c => ({ v: val(cols.get(c)), fs: cols.get(c) })), grand: { v: val(filtrados), fs: filtrados } }
}

function htmlCruzada(ctx) {
  const e = ctx.estado, X = matrizCruzada(ctx)
  if (!X) return `<div class="reporte-vacio">Para la tabla cruzada activa <b>al menos 2 niveles</b> en «Agrupar por» (el 1.º va en filas y el 2.º en columnas).</div>`
  const max = Math.max(...X.filas.flatMap(f => f.celdas.map(c => Math.abs(c.v))), 1e-9)
  const registro = new Map(); let n = 0
  const ref = fs => { const k = 'x' + (n++); registro.set(k, fs); return k }
  const chipsMed = ctx.medidas.length > 1 ? `<div class="rp-grp"><span>Medida</span>${ctx.medidas.map(m => `<button type="button" class="rp-tb ${m.key === X.M.key ? 'on' : ''}" data-rpa="med:${esc(m.key)}">${esc(m.label)}</button>`).join('')}</div>` : ''
  const celda = (v, fs, extra = '') => `<td class="n rp-cifra" data-xdrill="${ref(fs)}" ${extra}>${v ? ctx.fmt(v, X.M.formato) : '<span style="opacity:.3">·</span>'}</td>`
  const head = `<tr><th class="rp-xsticky">${esc(ctx.labelDim(X.kr))} \\ ${esc(ctx.labelDim(X.kc))}</th>${X.colKeys.map(c => `<th class="n" title="${esc(etq(c))}">${esc(etq(c))}</th>`).join('')}<th class="n">Total</th></tr>`
  const body = X.filas.slice(0, 300).map(f => `<tr><td class="rp-xsticky rp-lbl">${esc(f.label)}</td>${f.celdas.map(c => celda(c.v, c.fs, c.v ? `style="background:color-mix(in srgb,var(--color-info,#3b82f6) ${Math.round(8 + 52 * Math.abs(c.v) / max)}%,transparent)"` : '')).join('')}${celda(f.tot, f.fs, 'style="font-weight:700"')}</tr>`).join('')
  const pie = `<tr class="rp-total"><td class="rp-xsticky"><strong>TOTAL</strong></td>${X.colTot.map(c => celda(c.v, c.fs, 'style="font-weight:700"')).join('')}${celda(X.grand.v, X.grand.fs, 'style="font-weight:800"')}</tr>`
  ctx._xreg = registro
  return `${chipsMed ? `<div class="rp-barra" style="margin-top:0">${chipsMed}</div>` : ''}<div class="rp-xwrap"><table class="rp-x"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${pie}</tfoot></table></div>
    ${X.totalCols > X.colKeys.length ? `<div class="reporte-vacio">Se muestran las primeras ${X.colKeys.length} de ${X.totalCols} columnas; acota el período para verlas todas.</div>` : ''}
    ${e.agrupar.length > 2 ? `<div class="reporte-vacio">Los niveles 3.º en adelante no entran en la cruzada: usa la vista Árbol para verlos.</div>` : ''}`
}

/** HTML completo del bloque de tabla según la vista; `plana()` lo entrega reportes.js (tabla clásica). */
export function renderTablaReporte(ctx, plana) {
  const e = ctx.estado, vista = e.vista || 'arbol'
  if (!e.agrupar.length || !ctx.filtrados.length) return { html: null }
  if (vista === 'plana') return { html: htmlBarra(ctx, null) + plana(), arbol: null }
  if (vista === 'cruzada') return { html: htmlBarra(ctx, null) + htmlCruzada(ctx), arbol: null }
  const arbol = construirArbol(ctx), vis = filasVisibles(ctx, arbol), M0 = ctx.medidas[0]
  // total de hermanos (para el % de peso de cada fila)
  const sumHermanos = new Map()
  const rec = lista => { const tot = lista.reduce((s, n) => s + Math.max(0, n.vals[M0?.key] || 0), 0) || 1; lista.forEach(n => { sumHermanos.set(n, { tot }); if (n.hijos) rec(n.hijos) }) }
  rec(arbol.raiz)
  const ind = k => (ctx.estado.ordenKey === k ? (ctx.estado.ordenDir === 'asc' ? ' ▲' : ' ▼') : ' <span class="rp-orden-hint">⇅</span>')
  const tot = ctx.calc(ctx.filtrados, ctx.medidas)
  const html = `${htmlBarra(ctx, arbol)}<table class="rp-arbol"><thead><tr>
    <th class="rp-th-orden" data-rp-orden="_etiqueta">${e.agrupar.map(k => esc(ctx.labelDim(k))).join(' ▸ ')}${ind('_etiqueta')}</th><th class="n" style="width:70px">N°</th>
    ${ctx.medidas.map(m => `<th class="n rp-th-orden" data-rp-orden="${esc(m.key)}">${esc(m.label)}${ind(m.key)}</th>`).join('')}</tr></thead>
    <tbody>${vis.map(f => htmlFilaArbol(ctx, f, M0, sumHermanos)).join('')}</tbody>
    <tfoot><tr class="rp-total"><td><strong>TOTAL</strong></td><td class="n"><strong>${ctx.filtrados.length}</strong></td>${ctx.medidas.map(m => `<td class="n rp-cifra" data-drill="__total" style="font-weight:700">${ctx.fmt(tot[m.key], m.formato)}</td>`).join('')}</tr></tfoot></table>`
  return { html, arbol }
}

// ── Eventos (delegación sobre el contenedor de la tabla) ───────────────────────────────────────
export function enlazarTabla(root, ctx, arbol, rerender) {
  const e = ctx.estado
  root.onclick = ev => {
    const bt = ev.target.closest('[data-rpa]')
    if (bt) {
      const [a, p] = bt.dataset.rpa.split(':')
      if (a === 'vista') e.vista = p
      else if (a === 'contraer') { e.nivelAbierto = 0; e.exc = {} }
      else if (a === 'expandir') { e.nivelAbierto = e.agrupar.length; e.exc = {} }
      else if (a === 'niv') { e.nivelAbierto = Number(p) - 1; e.exc = {} }
      else if (a === 'pesa') e.pesa = !e.pesa
      else if (a === 'alertas') e.soloAlertas = !e.soloAlertas
      else if (a === 'swap') { if (e.agrupar.length > 1) { [e.agrupar[0], e.agrupar[1]] = [e.agrupar[1], e.agrupar[0]] } }
      else if (a === 'med') e.medCruz = p
      return rerender()
    }
    const th = ev.target.closest('[data-rp-orden]')
    if (th) { const k = th.dataset.rpOrden; if (e.ordenKey === k) e.ordenDir = e.ordenDir === 'asc' ? 'desc' : 'asc'; else { e.ordenKey = k; e.ordenDir = k === '_etiqueta' ? 'asc' : 'desc' } return rerender() }
    const dr = ev.target.closest('[data-drill]')
    if (dr) { ev.stopPropagation(); const k = dr.dataset.drill, n = arbol?.idx.get(k); return abrirAuditoria(ctx, k === '__total' ? 'Total del reporte' : (n ? rutaTitulo(n, arbol) : 'Detalle'), k === '__total' ? ctx.filtrados : (n?.filas || [])) }
    const xd = ev.target.closest('[data-xdrill]')
    if (xd) return abrirAuditoria(ctx, 'Celda de la tabla cruzada', ctx._xreg?.get(xd.dataset.xdrill) || [])
    const fila = ev.target.closest('tr.rp-tiene')
    if (fila && arbol) {
      const n = arbol.idx.get(fila.dataset.path); if (!n) return
      e.exc = e.exc || {}; e.exc[n.path] = !abierto(ctx, n, e.soloAlertas); rerender()
    }
  }
}
const rutaTitulo = (n, arbol) => { const t = []; let p = n.path; while (p) { const x = arbol.idx.get(p); if (!x) break; t.unshift(x.label); p = p.slice(0, p.lastIndexOf(SEP)) } return t.join(' ▸ ') }

// ── Auditoría: registros que componen una cifra ─────────────────────────────────────────────────
export function abrirAuditoria(ctx, titulo, filas) {
  document.getElementById('rpAudOv')?.remove()
  if (!document.getElementById('rpAudCss')) {
    const s = document.createElement('style'); s.id = 'rpAudCss'
    s.textContent = `.rpa-ov{position:fixed;inset:0;z-index:4000;background:rgba(2,6,23,.6);display:flex;align-items:center;justify-content:center;padding:16px}
    .rpa-m{background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border-color);border-radius:14px;width:min(1100px,100%);max-height:90vh;display:flex;flex-direction:column}
    .rpa-h{display:flex;justify-content:space-between;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border-color)}.rpa-h h3{margin:0;font-size:1.05rem}.rpa-h small{color:var(--text-secondary)}
    .rpa-b{padding:10px 18px;overflow:auto}.rpa-t{width:100%;border-collapse:collapse;font-size:.85rem}.rpa-t th{position:sticky;top:0;background:var(--bg-tertiary);text-align:left;padding:7px 8px}.rpa-t td{padding:6px 8px;border-bottom:1px solid var(--border-color)}.rpa-t .n{text-align:right;font-variant-numeric:tabular-nums}
    .rpa-f{display:flex;gap:8px;align-items:center;padding:10px 18px;border-top:1px solid var(--border-color)}.rpa-f input{flex:1;background:var(--bg-primary);color:inherit;border:1px solid var(--border-color);border-radius:8px;padding:7px 10px}`
    document.head.appendChild(s)
  }
  const dims = (ctx.config.dimensiones || []).slice(0, 5), meds = ctx.medidas.slice(0, 6)
  const celdaDim = (f, d) => { const v = d.tipo === 'fecha' ? String(f[d.campo || d.key] || '').slice(0, 10) : f[d.key]; return etq(v ?? '') }
  const valor = (f, m) => { const v = m.calc ? m.calc(f) : f[m.key]; const x = parseFloat(v); return isNaN(x) ? null : x }
  const M0 = meds[0], orden = M0 ? [...filas].sort((a, b) => (valor(b, M0) || 0) - (valor(a, M0) || 0)) : filas
  const ov = document.createElement('div'); ov.className = 'rpa-ov'; ov.id = 'rpAudOv'
  const pintar = q => {
    const t = (q || '').toLowerCase().trim(), l = t ? orden.filter(f => dims.some(d => celdaDim(f, d).toLowerCase().includes(t))) : orden
    ov.querySelector('tbody').innerHTML = l.slice(0, 200).map(f => `<tr>${dims.map(d => `<td>${esc(celdaDim(f, d))}</td>`).join('')}${meds.map(m => { const v = valor(f, m); return `<td class="n">${v === null ? '—' : ctx.fmt(v, m.formato)}</td>` }).join('')}</tr>`).join('') || `<tr><td colspan="${dims.length + meds.length}" style="text-align:center;padding:18px">Sin coincidencias</td></tr>`
    ov.querySelector('[data-n]').textContent = `${l.length.toLocaleString('en-US')} registro(s)${l.length > 200 ? ' · se muestran 200' : ''}`
  }
  ov.innerHTML = `<div class="rpa-m"><div class="rpa-h"><div><h3>🔍 ${esc(titulo)}</h3><small>Registros que componen esta cifra</small></div><button type="button" class="rp-tb" data-x>✕</button></div>
    <div class="rpa-b"><table class="rpa-t"><thead><tr>${dims.map(d => `<th>${esc(d.label)}</th>`).join('')}${meds.map(m => `<th class="n">${esc(m.label)}</th>`).join('')}</tr></thead><tbody></tbody></table></div>
    <div class="rpa-f"><input type="search" placeholder="Buscar dentro de estos registros…"><small data-n></small><button type="button" class="rp-tb" data-csv>⬇ CSV</button></div></div>`
  document.body.appendChild(ov); pintar('')
  const cerrar = () => { ov.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = e => { if (e.key === 'Escape') cerrar() }
  document.addEventListener('keydown', onKey)
  ov.querySelector('[data-x]').onclick = cerrar; ov.addEventListener('mousedown', e => { if (e.target === ov) cerrar() })
  ov.querySelector('input').addEventListener('input', e => pintar(e.target.value))
  ov.querySelector('[data-csv]').onclick = () => ctx.csv(`auditoria_${new Date().toISOString().slice(0, 10)}.csv`, [[...dims.map(d => d.label), ...meds.map(m => m.label)], ...orden.map(f => [...dims.map(d => celdaDim(f, d)), ...meds.map(m => valor(f, m) ?? '')])])
}
