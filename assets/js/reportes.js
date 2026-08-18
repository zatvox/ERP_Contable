// ============================================================================
// REPORTES.JS — Motor genérico de reportes gerenciales (tabla dinámica)
// ============================================================================
// Un solo motor reutilizado por TODOS los módulos. Cada módulo solo declara:
//   - `datos`      : array plano de objetos (una fila = un hecho)
//   - `dimensiones`: por qué campos se puede agrupar
//   - `medidas`    : qué se suma/cuenta/promedia
//   - `filtros`    : barra superior (select, texto, rango de fechas, mes)
//
// El motor arma: barra de filtros + selector de agrupación + tabla dinámica
// con subtotales y total general + gráfico de barras + exportar CSV.
//
// Todo el cálculo es en memoria sobre datos ya cacheados (data-cache.js), por
// lo que mover un filtro NO golpea la base de datos.
// ============================================================================

import { formatNumber, formatQty } from './helpers.js'

// ============================================================================
// AGREGACIÓN
// ============================================================================

const AGREGADORES = {
  sum:   (vals) => vals.reduce((s, v) => s + v, 0),
  count: (vals) => vals.length,
  avg:   (vals) => (vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0),
  min:   (vals) => (vals.length ? Math.min(...vals) : 0),
  max:   (vals) => (vals.length ? Math.max(...vals) : 0),
  distinct: (vals) => new Set(vals).size
}

/** Agrupa `datos` por las claves indicadas y calcula las medidas. */
export function agrupar(datos, claves, medidas) {
  if (!claves || claves.length === 0) {
    return [{ _claves: [], _etiqueta: 'Total', _filas: datos, ...calcularMedidas(datos, medidas) }]
  }
  const mapa = new Map()
  datos.forEach(fila => {
    const valores = claves.map(k => _valorDim(fila, k))
    const id = valores.join(' ▸ ')
    if (!mapa.has(id)) mapa.set(id, { _claves: valores, _etiqueta: id, _filas: [] })
    mapa.get(id)._filas.push(fila)
  })
  return Array.from(mapa.values()).map(g => ({ ...g, ...calcularMedidas(g._filas, medidas) }))
}

function _valorDim(fila, clave) {
  const v = fila[clave]
  if (v === null || v === undefined || v === '') return '(sin dato)'
  return String(v)
}

function calcularMedidas(filas, medidas) {
  const out = {}
  medidas.forEach(m => {
    const vals = filas.map(f => {
      const v = m.calc ? m.calc(f) : f[m.key]
      const n = parseFloat(v)
      return isNaN(n) ? 0 : n
    })
    const agg = AGREGADORES[m.agg || 'sum'] || AGREGADORES.sum
    out[m.key] = agg(m.agg === 'distinct' ? filas.map(f => f[m.key]) : vals)
  })
  return out
}

// ============================================================================
// FORMATO DE CELDA
// ============================================================================

export function formatearMedida(valor, formato) {
  const n = parseFloat(valor) || 0
  switch (formato) {
    case 'money':   return formatNumber(n, 2)
    case 'money4':  return formatNumber(n, 4)
    case 'qty':     return formatQty(n)
    case 'int':     return Math.round(n).toLocaleString('en-US')
    case 'pct':     return formatNumber(n, 1) + ' %'
    default:        return formatNumber(n, 2)
  }
}

// ============================================================================
// FILTROS
// ============================================================================

function _htmlFiltro(id, f, valorActual) {
  const base = `rp-f-${id}-${f.key}`
  if (f.tipo === 'select') {
    const opts = (f.opciones || []).map(o => {
      const val = typeof o === 'object' ? o.value : o
      const lab = typeof o === 'object' ? o.label : o
      return `<option value="${_esc(val)}" ${String(val) === String(valorActual ?? '') ? 'selected' : ''}>${_esc(lab)}</option>`
    }).join('')
    return `<select id="${base}" data-filtro="${f.key}"><option value="">${f.placeholderTodos || 'Todos'}</option>${opts}</select>`
  }
  if (f.tipo === 'mes')   return `<input type="month" id="${base}" data-filtro="${f.key}" value="${valorActual ?? ''}">`
  if (f.tipo === 'fecha') return `<input type="date"  id="${base}" data-filtro="${f.key}" value="${valorActual ?? ''}">`
  if (f.tipo === 'rango') {
    return `<div style="display:flex; gap:6px; align-items:center;">
      <input type="date" id="${base}-desde" data-filtro="${f.key}" data-parte="desde" value="${valorActual?.desde ?? ''}" style="max-width:150px;">
      <span style="color:var(--text-secondary);">a</span>
      <input type="date" id="${base}-hasta" data-filtro="${f.key}" data-parte="hasta" value="${valorActual?.hasta ?? ''}" style="max-width:150px;">
    </div>`
  }
  return `<input type="text" id="${base}" data-filtro="${f.key}" value="${_esc(valorActual ?? '')}" placeholder="${_esc(f.placeholder || '')}">`
}

function aplicarFiltros(datos, filtros, estado) {
  return datos.filter(fila => {
    for (const f of filtros) {
      const val = estado[f.key]
      if (val === undefined || val === null || val === '' ) continue
      if (f.tipo === 'rango') {
        if (!val.desde && !val.hasta) continue
        const v = String(fila[f.campo || f.key] || '')
        if (val.desde && v < val.desde) return false
        if (val.hasta && v > val.hasta) return false
        continue
      }
      if (f.tipo === 'mes') {
        const v = String(fila[f.campo || f.key] || '')
        if (!v.startsWith(val)) return false
        continue
      }
      if (f.tipo === 'texto') {
        const campos = f.campos || [f.campo || f.key]
        const q = String(val).toLowerCase()
        const hay = campos.some(c => String(fila[c] ?? '').toLowerCase().includes(q))
        if (!hay) return false
        continue
      }
      // select / fecha exacta
      if (f.match) { if (!f.match(fila, val)) return false; continue }
      if (String(fila[f.campo || f.key] ?? '') !== String(val)) return false
    }
    return true
  })
}

// ============================================================================
// RENDER PRINCIPAL
// ============================================================================

const _registro = new Map()   // id -> config viva (para re-render en eventos)

/**
 * Crea un reporte dinámico completo dentro de `containerId`.
 *
 * config = {
 *   id, titulo, descripcion,
 *   datos: [],
 *   dimensiones: [{ key, label }],
 *   medidas:     [{ key, label, agg, formato, calc? }],
 *   filtros:     [{ key, label, tipo, opciones?, campo?, campos?, match? }],
 *   agruparPorDefecto: ['cliente'],
 *   medidasPorDefecto: ['total'],
 *   orden: { key, dir },
 *   grafico: true,
 *   kpis: (filasFiltradas) => [{ label, valor, formato, color }]
 * }
 */
export function crearReporte(containerId, config) {
  const cont = document.getElementById(containerId)
  if (!cont) return

  const id = config.id || containerId
  const estado = _registro.get(id)?.estado || {
    filtros:  {},
    agrupar:  (config.agruparPorDefecto || (config.dimensiones[0] ? [config.dimensiones[0].key] : [])).slice(),
    medidas:  (config.medidasPorDefecto || config.medidas.map(m => m.key)).slice(),
    ordenKey: config.orden?.key || null,
    ordenDir: config.orden?.dir || 'desc',
    limite:   config.limite || 0
  }
  // valores por defecto de filtros declarados
  ;(config.filtros || []).forEach(f => {
    if (estado.filtros[f.key] === undefined && f.valorDefecto !== undefined) estado.filtros[f.key] = f.valorDefecto
  })

  _registro.set(id, { config, estado, containerId })

  cont.innerHTML = `
    <div class="card reporte-card">
      <div class="card-header">
        <div>
          <h3 class="card-title">${_esc(config.titulo || 'Reporte')}</h3>
          ${config.descripcion ? `<div class="reporte-desc">${_esc(config.descripcion)}</div>` : ''}
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-secondary btn-small" data-rp-accion="csv" data-rp-id="${id}">⬇ CSV</button>
          <button class="btn btn-secondary btn-small" data-rp-accion="limpiar" data-rp-id="${id}">↺ Limpiar</button>
        </div>
      </div>

      <div class="reporte-filtros" id="rp-filtros-${id}">
        ${(config.filtros || []).map(f => `
          <div class="reporte-filtro">
            <label>${_esc(f.label)}</label>
            ${_htmlFiltro(id, f, estado.filtros[f.key])}
          </div>`).join('')}

        <div class="reporte-filtro">
          <label>Agrupar por</label>
          <div class="reporte-chips" id="rp-dims-${id}">
            ${config.dimensiones.map(d => `
              <button type="button" class="reporte-chip ${estado.agrupar.includes(d.key) ? 'on' : ''}"
                      data-rp-dim="${_esc(d.key)}" data-rp-id="${id}">${_esc(d.label)}</button>`).join('')}
          </div>
        </div>

        ${config.medidas.length > 1 ? `
        <div class="reporte-filtro">
          <label>Columnas</label>
          <div class="reporte-chips" id="rp-meds-${id}">
            ${config.medidas.map(m => `
              <button type="button" class="reporte-chip ${estado.medidas.includes(m.key) ? 'on' : ''}"
                      data-rp-med="${_esc(m.key)}" data-rp-id="${id}">${_esc(m.label)}</button>`).join('')}
          </div>
        </div>` : ''}
      </div>

      <div id="rp-kpis-${id}" class="reporte-kpis"></div>
      <div id="rp-tabla-${id}" class="table-container reporte-tabla"></div>
      <div id="rp-grafico-${id}" class="reporte-grafico"></div>
    </div>`

  _bindEventos(id)
  refrescarReporte(id)
}

/** Reemplaza los datos de un reporte ya creado sin perder los filtros. */
export function actualizarDatosReporte(id, datos) {
  const reg = _registro.get(id)
  if (!reg) return
  reg.config.datos = datos
  refrescarReporte(id)
}

export function refrescarReporte(id) {
  const reg = _registro.get(id)
  if (!reg) return
  const { config, estado } = reg

  const filtrados = aplicarFiltros(config.datos || [], config.filtros || [], estado.filtros)
  const medidasSel = config.medidas.filter(m => estado.medidas.includes(m.key))
  const medidasUsar = medidasSel.length ? medidasSel : config.medidas

  let grupos = agrupar(filtrados, estado.agrupar, medidasUsar)

  const ordenKey = estado.ordenKey || medidasUsar[0]?.key
  if (ordenKey) {
    const dir = estado.ordenDir === 'asc' ? 1 : -1
    grupos.sort((a, b) => {
      const va = ordenKey === '_etiqueta' ? a._etiqueta : (a[ordenKey] ?? 0)
      const vb = ordenKey === '_etiqueta' ? b._etiqueta : (b[ordenKey] ?? 0)
      if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb)) * dir
      return (va - vb) * dir
    })
  }

  const totales = calcularMedidas(filtrados, medidasUsar)

  // --- KPIs
  const kpiCont = document.getElementById(`rp-kpis-${id}`)
  if (kpiCont) {
    const kpis = config.kpis ? config.kpis(filtrados, grupos) : null
    kpiCont.innerHTML = kpis && kpis.length
      ? kpis.map(k => `
          <div class="reporte-kpi">
            <div class="reporte-kpi-label">${_esc(k.label)}</div>
            <div class="reporte-kpi-valor" style="${k.color ? `color:${k.color};` : ''}">${k.texto ?? formatearMedida(k.valor, k.formato)}</div>
            ${k.sub ? `<div class="reporte-kpi-sub">${_esc(k.sub)}</div>` : ''}
          </div>`).join('')
      : ''
  }

  // --- Tabla
  const tCont = document.getElementById(`rp-tabla-${id}`)
  if (tCont) {
    if (filtrados.length === 0) {
      tCont.innerHTML = `<p class="reporte-vacio">Sin datos para los filtros seleccionados.</p>`
    } else {
      const filasMostrar = estado.limite > 0 ? grupos.slice(0, estado.limite) : grupos
      tCont.innerHTML = `
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
                <td>${_esc(g._etiqueta)}</td>
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
      tCont.querySelectorAll('[data-rp-orden]').forEach(th => {
        th.addEventListener('click', () => {
          const k = th.getAttribute('data-rp-orden')
          if (estado.ordenKey === k) estado.ordenDir = estado.ordenDir === 'asc' ? 'desc' : 'asc'
          else { estado.ordenKey = k; estado.ordenDir = k === '_etiqueta' ? 'asc' : 'desc' }
          refrescarReporte(id)
        })
      })
    }
  }

  // --- Gráfico
  const gCont = document.getElementById(`rp-grafico-${id}`)
  if (gCont) {
    if (config.grafico === false || grupos.length === 0 || estado.agrupar.length === 0) gCont.innerHTML = ''
    else gCont.innerHTML = _barras(grupos.slice(0, 12), medidasUsar[0])
  }
}

function _labelDim(config, key) {
  return config.dimensiones.find(d => d.key === key)?.label || key
}

function _flecha(estado, key) {
  if (estado.ordenKey !== key) return ' <span class="rp-orden-hint">⇅</span>'
  return estado.ordenDir === 'asc' ? ' ▲' : ' ▼'
}

function _colorMedida(m, valor) {
  if (!m.semaforo) return ''
  const n = parseFloat(valor) || 0
  if (n < 0) return 'color:var(--color-danger);'
  if (n > 0) return 'color:var(--color-success);'
  return ''
}

// Gráfico de barras horizontales en HTML puro (sin librerías externas:
// GitHub Pages sirve estático y no queremos depender de un CDN).
function _barras(grupos, medida) {
  if (!medida) return ''
  const max = Math.max(...grupos.map(g => Math.abs(g[medida.key] || 0)), 1)
  return `
    <div class="reporte-grafico-titulo">${_esc(medida.label)} — top ${grupos.length}</div>
    ${grupos.map(g => {
      const v = g[medida.key] || 0
      const pct = Math.abs(v) / max * 100
      return `
        <div class="reporte-barra-fila">
          <div class="reporte-barra-label" title="${_esc(g._etiqueta)}">${_esc(g._etiqueta)}</div>
          <div class="reporte-barra-track">
            <div class="reporte-barra-fill ${v < 0 ? 'neg' : ''}" style="width:${pct.toFixed(1)}%;"></div>
          </div>
          <div class="reporte-barra-valor">${formatearMedida(v, medida.formato)}</div>
        </div>`
    }).join('')}`
}

// ============================================================================
// EVENTOS
// ============================================================================

function _bindEventos(id) {
  const reg = _registro.get(id)
  if (!reg) return
  const { estado, config } = reg

  const cajaFiltros = document.getElementById(`rp-filtros-${id}`)
  if (cajaFiltros) {
    cajaFiltros.querySelectorAll('[data-filtro]').forEach(el => {
      const evento = (el.tagName === 'SELECT' || el.type === 'date' || el.type === 'month') ? 'change' : 'input'
      el.addEventListener(evento, () => {
        const key   = el.getAttribute('data-filtro')
        const parte = el.getAttribute('data-parte')
        if (parte) {
          estado.filtros[key] = { ...(estado.filtros[key] || {}), [parte]: el.value }
        } else {
          estado.filtros[key] = el.value
        }
        refrescarReporte(id)
      })
    })

    cajaFiltros.querySelectorAll('[data-rp-dim]').forEach(btn => {
      btn.addEventListener('click', () => {
        const k = btn.getAttribute('data-rp-dim')
        const i = estado.agrupar.indexOf(k)
        if (i >= 0) estado.agrupar.splice(i, 1); else estado.agrupar.push(k)
        btn.classList.toggle('on')
        refrescarReporte(id)
      })
    })

    cajaFiltros.querySelectorAll('[data-rp-med]').forEach(btn => {
      btn.addEventListener('click', () => {
        const k = btn.getAttribute('data-rp-med')
        const i = estado.medidas.indexOf(k)
        if (i >= 0 && estado.medidas.length > 1) estado.medidas.splice(i, 1)
        else if (i < 0) estado.medidas.push(k)
        else return
        btn.classList.toggle('on')
        refrescarReporte(id)
      })
    })
  }

  document.querySelectorAll(`[data-rp-accion][data-rp-id="${id}"]`).forEach(btn => {
    btn.addEventListener('click', () => {
      const accion = btn.getAttribute('data-rp-accion')
      if (accion === 'csv')     exportarCSV(id)
      if (accion === 'limpiar') {
        // Reset completo de la vista: filtros, agrupación, columnas y orden
        // vuelven a como estaba el reporte recién abierto. Se borra la entrada
        // del registro para que crearReporte no reutilice el estado anterior.
        _registro.delete(id)
        void estado
        crearReporte(reg.containerId, config)
      }
    })
  })
}

// ============================================================================
// EXPORTAR
// ============================================================================

export function exportarCSV(id) {
  const reg = _registro.get(id)
  if (!reg) return
  const { config, estado } = reg
  const filtrados = aplicarFiltros(config.datos || [], config.filtros || [], estado.filtros)
  const medidasUsar = config.medidas.filter(m => estado.medidas.includes(m.key))
  const grupos = agrupar(filtrados, estado.agrupar, medidasUsar.length ? medidasUsar : config.medidas)

  const cab = [estado.agrupar.map(k => _labelDim(config, k)).join(' | ') || 'Total', 'N° registros',
               ...(medidasUsar.length ? medidasUsar : config.medidas).map(m => m.label)]
  const filas = grupos.map(g => [
    g._etiqueta, g._filas.length,
    ...(medidasUsar.length ? medidasUsar : config.medidas).map(m => (parseFloat(g[m.key]) || 0).toFixed(2))
  ])
  descargarCSV(`${(config.titulo || 'reporte').replace(/[^\w]+/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`, [cab, ...filas])
}

export function descargarCSV(nombre, filas) {
  const csv = filas.map(f => f.map(c => {
    const s = String(c ?? '')
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }).join(';')).join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = nombre; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ============================================================================
// UTILIDADES COMPARTIDAS PARA LOS MÓDULOS
// ============================================================================

/** Devuelve 'YYYY-MM' de hoy. */
export function mesActual() { return new Date().toISOString().slice(0, 7) }

/** Devuelve { desde, hasta } del mes en curso. */
export function rangoMesActual() {
  const hoy = new Date()
  const desde = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().slice(0, 10)
  const hasta = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).toISOString().slice(0, 10)
  return { desde, hasta }
}

/** Días de diferencia entre una fecha ISO y hoy (positivo = vencido). */
export function diasVencidos(fechaIso) {
  if (!fechaIso) return 0
  const ms = Date.now() - new Date(fechaIso + 'T00:00:00').getTime()
  return Math.floor(ms / 86400000)
}

/** Clasifica una antigüedad de saldo en tramos estándar. */
export function tramoAntiguedad(dias) {
  if (dias <= 0)  return '0 · Por vencer'
  if (dias <= 30) return '1 · 1-30 días'
  if (dias <= 60) return '2 · 31-60 días'
  if (dias <= 90) return '3 · 61-90 días'
  return '4 · Más de 90 días'
}

/** Nombre de mes legible desde 'YYYY-MM'. */
export function nombreMes(ym) {
  if (!ym) return '(sin fecha)'
  const [a, m] = ym.split('-')
  const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Set', 'Oct', 'Nov', 'Dic']
  return `${meses[parseInt(m, 10) - 1] || m} ${a}`
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

export { _esc as escaparHtml }
