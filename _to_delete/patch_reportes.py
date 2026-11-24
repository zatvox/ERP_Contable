import re
base = 'assets/js/'
def rw(p, fn):
    s = open(base + p, encoding='utf-8').read()
    s = fn(s)
    open(base + p, 'w', encoding='utf-8').write(s)

def rep(s, o, n, c=1):
    assert s.count(o) == c, (o[:70], s.count(o))
    return s.replace(o, n)

# ---------------- motor.js: import dinámico (evita ciclos) ----------------
def motor(s):
    s = rep(s, "import { abrirImprimirReporte } from '../shared/imprimir-reporte.js'\n", "")
    s = rep(s, "  $('zsImprimir').addEventListener('click', () => {\n    const rows = filtrar()", "  $('zsImprimir').addEventListener('click', async () => {\n    const { abrirImprimirReporte } = await import('../shared/imprimir-reporte.js')\n    const rows = filtrar()")
    return s
rw('estadisticas/motor.js', motor)

# ---------------- reportes.js ----------------
def rp(s):
    s = rep(s, "import { formatNumber, formatQty, showToast } from './helpers.js'",
"import { formatNumber, formatQty, showToast } from './helpers.js'\nimport { renderTablaReporte, enlazarTabla, construirArbol, filasVisibles, matrizCruzada } from './shared/arbol-reporte.js'\nimport { analizar } from './shared/observaciones-reporte.js'")
    # estado por defecto
    s = rep(s, "    limite:   config.limite || 0,\n    gran:",
"    limite:   config.limite || 0,\n    vista: 'arbol', nivelAbierto: 0, exc: {}, pesa: false, soloAlertas: false, medCruz: null,\n    gran:")
    # vista guardada
    s = rep(s, "    limite:   v.limite ?? base.limite,\n    gran:     { ...base.gran, ...(v.gran || {}) }",
"    limite:   v.limite ?? base.limite,\n    vista: ['arbol', 'cruzada', 'plana'].includes(v.vista) ? v.vista : base.vista, nivelAbierto: v.nivelAbierto ?? base.nivelAbierto, exc: { ...(v.exc || {}) },\n    pesa: !!v.pesa, soloAlertas: false, medCruz: v.medCruz && meds.has(v.medCruz) ? v.medCruz : null,\n    gran:     { ...base.gran, ...(v.gran || {}) }")
    # botón imprimir
    s = rep(s, """          <button class="btn btn-secondary btn-small" data-rp-accion="excel" data-rp-id="${id}">⬇ Excel</button>""",
"""          <button class="btn btn-secondary btn-small" data-rp-accion="excel" data-rp-id="${id}">⬇ Excel</button>
          <button class="btn btn-secondary btn-small" data-rp-accion="imprimir" data-rp-id="${id}" title="Imprimir este reporte en PDF: tú eliges qué secciones incluir">🖨️ Imprimir PDF</button>""")
    s = rep(s, "      if (accion === 'excel')   exportarExcel(id)\n", "      if (accion === 'excel')   exportarExcel(id)\n      if (accion === 'imprimir') imprimirReporte(id)\n")
    # chips de agrupación: orden + arrastrar
    s = rep(s, """          <label>Agrupar por</label>
          <div class="reporte-chips" id="rp-dims-${id}">""",
"""          <label>Agrupar por <span class="rp-ayuda">· cada chip es un nivel · arrastra para cambiar el orden</span></label>
          <div class="reporte-chips" id="rp-dims-${id}">""")
    s = rep(s, """<span role="button" tabindex="0" class="reporte-chip ${estado.agrupar.includes(d.key) ? 'on' : ''}"
                    data-rp-dim="${_esc(d.key)}" data-rp-id="${id}" style="display:inline-flex; align-items:center; gap:6px;">${_esc(d.label)}""",
"""<span role="button" tabindex="0" class="reporte-chip ${estado.agrupar.includes(d.key) ? 'on' : ''}" draggable="true"
                    data-rp-dim="${_esc(d.key)}" data-rp-id="${id}" style="display:inline-flex; align-items:center; gap:6px;">${estado.agrupar.includes(d.key) ? `<b class="rp-ord">${estado.agrupar.indexOf(d.key) + 1}</b>` : ''}${_esc(d.label)}""")
    s = rep(s, """              <button type="button" class="reporte-chip ${estado.agrupar.includes(d.key) ? 'on' : ''}"
                      data-rp-dim="${_esc(d.key)}" data-rp-id="${id}">${_esc(d.label)}</button>`).join('')}""",
"""              <button type="button" class="reporte-chip ${estado.agrupar.includes(d.key) ? 'on' : ''}" draggable="true"
                      data-rp-dim="${_esc(d.key)}" data-rp-id="${id}">${estado.agrupar.includes(d.key) ? `<b class="rp-ord">${estado.agrupar.indexOf(d.key) + 1}</b>` : ''}${_esc(d.label)}</button>`).join('')}""")
    # clic en chip: re-render completo para renumerar niveles
    s = rep(s, """        if (i >= 0) estado.agrupar.splice(i, 1); else estado.agrupar.push(k)
        btn.classList.toggle('on')
        refrescarReporte(id)
      })
    })
""", """        if (i >= 0) estado.agrupar.splice(i, 1); else estado.agrupar.push(k)
        estado.exc = {}; crearReporte(reg.containerId, config)
      })
      // Arrastrar y soltar: cambia el ORDEN de los niveles (solo entre chips activos)
      btn.addEventListener('dragstart', ev => { ev.dataTransfer.setData('text/plain', btn.getAttribute('data-rp-dim')); ev.dataTransfer.effectAllowed = 'move' })
      btn.addEventListener('dragover', ev => { if (estado.agrupar.includes(btn.getAttribute('data-rp-dim'))) { ev.preventDefault(); btn.classList.add('rp-drop') } })
      btn.addEventListener('dragleave', () => btn.classList.remove('rp-drop'))
      btn.addEventListener('drop', ev => {
        ev.preventDefault(); btn.classList.remove('rp-drop')
        const de = ev.dataTransfer.getData('text/plain'), a = btn.getAttribute('data-rp-dim')
        if (!de || de === a || !estado.agrupar.includes(de) || !estado.agrupar.includes(a)) return
        estado.agrupar.splice(estado.agrupar.indexOf(de), 1); estado.agrupar.splice(estado.agrupar.indexOf(a), 0, de)
        estado.exc = {}; crearReporte(reg.containerId, config)
      })
    })
""")
    # gran select al agregar fecha: también renumera
    s = rep(s, """          estado.agrupar.push(k)
          sel.closest('[data-rp-dim]')?.classList.add('on')
        }
        refrescarReporte(id)""", """          estado.agrupar.push(k)
          estado.exc = {}; crearReporte(reg.containerId, config); return
        }
        refrescarReporte(id)""")
    # medida con requiereDim
    s = rep(s, """          estado.agrupar.push(req)
          cajaFiltros.querySelector(`[data-rp-dim="${req}"]`)?.classList.add('on')
        }
        refrescarReporte(id)""", """          estado.agrupar.push(req)
          estado.exc = {}; crearReporte(reg.containerId, config); return
        }
        refrescarReporte(id)""")
    # tabla: reemplazo del bloque
    a = s.index("  // --- Tabla\n  const tCont")
    b = s.index("  // --- Gráfico\n  const gCont")
    nuevo = r'''  // --- Tabla: Árbol / Cruzada / Plana (ver shared/arbol-reporte.js)
  const tCont = document.getElementById(`rp-tabla-${id}`)
  if (tCont) {
    if (filtrados.length === 0) {
      tCont.innerHTML = `<p class="reporte-vacio">Sin datos para los filtros seleccionados.</p>`
    } else {
      const plana = () => {
        const filasMostrar = estado.limite > 0 ? grupos.slice(0, estado.limite) : grupos
        return `
        <table>
          <thead>
            <tr>
              <th class="rp-th-orden" data-rp-orden="_etiqueta" data-rp-id="${id}">
                ${estado.agrupar.length ? estado.agrupar.map(k => _esc(_labelDim(config, k))).join(' ▸ ') : 'Total general'}
                ${_flecha(estado, '_etiqueta')}
              </th>
              <th style="text-align:right; width:80px;">N°</th>
              ${medidasUsar.map(m => `
                <th style="text-align:right;" class="rp-th-orden" data-rp-orden="${_esc(m.key)}" data-rp-id="${id}">
                  ${_esc(m.label)}${_flecha(estado, m.key)}
                </th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${filasMostrar.map(g => `
              <tr>
                <td>${_esc(String(g._etiqueta ?? '').replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, '$3/$2/$1'))}</td>
                <td style="text-align:right; color:var(--text-secondary);">${g._filas.length}</td>
                ${medidasUsar.map(m => `<td style="text-align:right;${_colorMedida(m, g[m.key])}">${formatearMedida(g[m.key], m.formato)}</td>`).join('')}
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr class="rp-total">
              <td><strong>TOTAL${estado.limite > 0 && grupos.length > estado.limite ? ` (de ${grupos.length} grupos)` : ''}</strong></td>
              <td style="text-align:right;"><strong>${filtrados.length}</strong></td>
              ${medidasUsar.map(m => `<td style="text-align:right;"><strong>${formatearMedida(totales[m.key], m.formato)}</strong></td>`).join('')}
            </tr>
          </tfoot>
        </table>`
      }
      const ctx = _ctxReporte(id, filtrados, medidasUsar)
      const r = renderTablaReporte(ctx, plana)
      tCont.innerHTML = r.html ?? plana()
      enlazarTabla(tCont, ctx, r.arbol, () => refrescarReporte(id))
    }
  }

'''
    s = s[:a] + nuevo + s[b:]
    # barras: nivel 1 cuando hay árbol
    s = rep(s, "    else gCont.innerHTML = _barras(grupos.slice(0, 12), medidasUsar[0])",
"""    else {
      const base = estado.agrupar.length > 1 && (estado.vista || 'arbol') !== 'plana'
        ? agrupar(filtrados, [estado.agrupar.find(k => !_esFechaDim(config, k)) || estado.agrupar[0]], medidasUsar, _resolverDims(config, estado)).sort((a, b) => (b[medidasUsar[0].key] || 0) - (a[medidasUsar[0].key] || 0))
        : grupos
      gCont.innerHTML = _barras(base.slice(0, 12), medidasUsar[0])
    }""")
    s += r'''

// ============================================================================
// CONTEXTO DE LA TABLA + IMPRIMIR PDF (2026-11-23)
// ============================================================================
const _esFechaDim = (config, k) => (config.dimensiones || []).find(d => d.key === k)?.tipo === 'fecha'

function _ctxReporte(id, filtrados, medidas) {
  const reg = _registro.get(id), { config, estado } = reg
  return { config, estado, filtrados, medidas, resolver: _resolverDims(config, estado), calc: calcularMedidas, fmt: formatearMedida,
    valorOrd: _valorOrdenable, labelDim: k => _labelDim(config, k, estado), colorMedida: _colorMedida, csv: descargarCSV }
}

function _imagenBarras(items) {
  const W = 940, rowH = 30, padL = 260, padR = 140, top = 14, H = top + items.length * rowH + 10
  const cv = document.createElement('canvas'); cv.width = W * 2; cv.height = H * 2
  const g = cv.getContext('2d'); g.scale(2, 2); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.font = '12px Arial'
  const max = Math.max(...items.map(x => Math.abs(x.v)), 1e-9)
  items.forEach((x, i) => {
    const y = top + i * rowH; let t = x.l
    g.textAlign = 'right'; g.fillStyle = '#374151'
    while (g.measureText(t).width > padL - 14 && t.length > 4) t = t.slice(0, -2)
    g.fillText(t === x.l ? t : t + '…', padL - 8, y + 18)
    const w = Math.max(2, (W - padL - padR) * Math.abs(x.v) / max)
    g.fillStyle = x.v < 0 ? '#dc2626' : '#3b82f6'; g.fillRect(padL, y + 5, w, 18)
    g.textAlign = 'left'; g.fillStyle = '#111827'; g.fillText(x.t, padL + w + 6, y + 18)
  })
  return cv.toDataURL('image/png')
}

async function imprimirReporte(id) {
  const reg = _registro.get(id); if (!reg) return
  const { abrirImprimirReporte } = await import('./shared/imprimir-reporte.js')
  const { config, estado } = reg
  const filtrados = aplicarFiltros(config.datos || [], config.filtros || [], estado.filtros)
  const ms = config.medidas.filter(m => estado.medidas.includes(m.key)), medidas = ms.length ? ms : config.medidas
  const c = _ctxReporte(id, filtrados, medidas), M0 = medidas[0], res = c.resolver
  const grupos = agrupar(filtrados, estado.agrupar, medidas, res)
  const dimR = estado.agrupar.find(k => !_esFechaDim(config, k)) || estado.agrupar[0]
  const rank = dimR ? agrupar(filtrados, [dimR], medidas, res).sort((a, b) => (b[M0.key] || 0) - (a[M0.key] || 0)) : []
  const sinHtml = h => String(h ?? '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&')
  const vistaTxt = { arbol: 'Árbol', cruzada: 'Cruzada', plana: 'Plana' }[estado.vista || 'arbol']

  abrirImprimirReporte({
    id: 'rp_' + id, titulo: config.titulo || 'Reporte', pregunta: config.descripcion || '', modulo: '',
    filtros: () => {
      const f = []
      ;(config.filtros || []).forEach(fl => {
        let v = estado.filtros[fl.key]
        if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) || /^(todos?|all)$/i.test(String(v))) return
        const nom = x => { const o = (fl.opciones || []).find(o => String(typeof o === 'object' ? o.value : o) === String(x)); return o ? (typeof o === 'object' ? (o.label ?? o.value) : o) : x }
        if (Array.isArray(v)) { const l = v.map(nom); f.push(`${fl.label}: ${l.slice(0, 3).join(', ')}${l.length > 3 ? ` (+${l.length - 3})` : ''}`) }
        else if (typeof v === 'object') { if (v.desde || v.hasta) f.push(`${fl.label}: ${String(v.desde || 'inicio').split('-').reverse().join('/')} → ${String(v.hasta || 'hoy').split('-').reverse().join('/')}`) }
        else f.push(`${fl.label}: ${nom(v)}`)
      })
      if (estado.agrupar.length) f.push('Agrupado por: ' + estado.agrupar.map(k => _labelDim(config, k, estado)).join(' ▸ '))
      f.push('Vista: ' + vistaTxt)
      return f
    },
    kpis: () => {
      const k = config.kpis ? config.kpis(filtrados, grupos) : null
      if (k && k.length) return k.map(x => ({ label: x.label, texto: sinHtml(x.texto ?? formatearMedida(x.valor, x.formato)), sub: x.sub || '' }))
      const t = calcularMedidas(filtrados, medidas)
      return medidas.slice(0, 4).map(m => ({ label: m.label, texto: formatearMedida(t[m.key], m.formato) }))
    },
    hallazgos: () => {
      const out = [], pos = rank.map(g => Math.max(0, g[M0.key] || 0)), tot = pos.reduce((s, v) => s + v, 0)
      if (rank.length && tot > 0) {
        out.push(`⭐ ${rank[0]._etiqueta} lidera en ${M0.label} con ${formatearMedida(rank[0][M0.key], M0.formato)} (${(pos[0] / tot * 100).toFixed(1)} % del total).`)
        let acc = 0, n = 0; for (const v of pos) { acc += v; n++; if (acc / tot >= .8) break }
        if (rank.length >= 3) out.push(`🎯 ${n} de ${rank.length} ${_labelDim(config, dimR, estado).toLowerCase()} generan el 80 % de ${M0.label}.`)
      }
      out.push(`📄 ${filtrados.length.toLocaleString('en-US')} registro(s) agrupados en ${grupos.length.toLocaleString('en-US')} combinación(es).`)
      return out
    },
    graficos: [{ id: 'barras', nombre: dimR ? `Ranking por ${_labelDim(config, dimR, estado).toLowerCase()}` : 'Ranking', detalle: M0.label + ' · top 12', ok: rank.length > 0, actual: true,
      img: async () => _imagenBarras(rank.slice(0, 12).map(g => ({ l: g._etiqueta, v: g[M0.key] || 0, t: formatearMedida(g[M0.key], M0.formato) }))) }],
    tabla: ({ filas }) => {
      const tot = calcularMedidas(filtrados, medidas), cap = filas > 0 ? filas : Infinity, vista = estado.vista || 'arbol'
      const fmt = (v, m) => formatearMedida(v, m.formato)
      if (vista === 'cruzada') {
        const X = matrizCruzada(c, 8)
        if (X) return { cab: [`${_labelDim(config, X.kr, estado)} \\ ${_labelDim(config, X.kc, estado)}`, ...X.colKeys.map(k => String(k).replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, '$3/$2/$1')), 'Total'],
          filas: X.filas.slice(0, cap).map(f => ({ c: [f.label, ...f.celdas.map(x => (x.v ? fmt(x.v, X.M) : '·')), fmt(f.tot, X.M)] })),
          total: ['TOTAL', ...X.colTot.map(x => fmt(x.v, X.M)), fmt(X.grand.v, X.M)],
          nota: `Medida: ${X.M.label}.${X.totalCols > X.colKeys.length ? ` Solo se imprimen las ${X.colKeys.length} primeras de ${X.totalCols} columnas.` : ''}` }
      }
      if (vista === 'arbol' && estado.agrupar.length) {
        const vis = filasVisibles(c, construirArbol(c)), lim = vis.slice(0, cap)
        return { cab: [estado.agrupar.map(k => _labelDim(config, k, estado)).join(' ▸ '), 'N°', ...medidas.map(m => m.label)],
          filas: lim.map(f => f.resto ? { c: [`… ${f.resto.n} grupo(s) menores (${f.resto.pct.toFixed(1)} %)`, '', ...medidas.map(() => '')], n: f.nivel }
            : { c: [f.n.label, String(f.n.filas.length), ...medidas.map(m => fmt(f.n.vals[m.key], m))], n: f.n.nivel, b: f.n.nivel === 0 && !!f.n.hijos }),
          total: ['TOTAL', String(filtrados.length), ...medidas.map(m => fmt(tot[m.key], m))],
          nota: vis.length > lim.length ? `Se imprimen ${lim.length} de ${vis.length} filas visibles. Abre/cierra niveles en pantalla para elegir el detalle.` : 'Se imprime el árbol tal como lo tienes abierto en pantalla.' }
      }
      const ok = estado.ordenKey && estado.ordenKey !== '_etiqueta' ? estado.ordenKey : M0.key
      const ord = [...grupos].sort((a, b) => estado.ordenKey === '_etiqueta' ? String(a._etiqueta).localeCompare(String(b._etiqueta), 'es', { numeric: true }) : ((b[ok] ?? 0) - (a[ok] ?? 0)))
      return { cab: [estado.agrupar.length ? estado.agrupar.map(k => _labelDim(config, k, estado)).join(' ▸ ') : 'Total', 'N°', ...medidas.map(m => m.label)],
        filas: ord.slice(0, cap).map(g => ({ c: [String(g._etiqueta).replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, '$3/$2/$1'), String(g._filas.length), ...medidas.map(m => fmt(g[m.key], m))] })),
        total: ['TOTAL', String(filtrados.length), ...medidas.map(m => fmt(tot[m.key], m))],
        nota: ord.length > cap ? `Se imprimen ${cap} de ${ord.length} filas; los totales incluyen todas.` : '' }
    },
    observaciones: () => {
      const kf = estado.agrupar.find(k => _esFechaDim(config, k)); let series = []
      if (kf) series = agrupar(filtrados, [kf], [M0], res).sort((a, b) => { const va = _valorOrdenable(a._etiqueta), vb = _valorOrdenable(b._etiqueta); return typeof va === 'number' && typeof vb === 'number' ? va - vb : String(a._etiqueta).localeCompare(String(b._etiqueta)) }).map(g => ({ label: g._etiqueta, v: g[M0.key] || 0 }))
      const t = calcularMedidas(filtrados, medidas)
      return analizar({ medida: M0, total: t[M0.key], series, ranking: rank.map(g => ({ k: g._etiqueta, v: g[M0.key] || 0 })), dimLabel: dimR ? _labelDim(config, dimR, estado) : '',
        medidas: medidas.map(m => ({ label: m.label, valor: t[m.key], formato: m.formato })), registros: filtrados.length,
        sinDato: dimR ? filtrados.filter(f => res(f, dimR) === '(sin dato)').length : 0, campoSinDato: dimR ? _labelDim(config, dimR, estado) : '' })
    }
  })
}
'''
    return s
rw('reportes.js', rp)
print('ok')
