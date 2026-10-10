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

import { formatNumber, formatQty, showToast } from './helpers.js'

// ============================================================================
// VISTA GUARDADA POR USUARIO (2026-10-06, SQL 69_preferencias_reporte.sql)
// ============================================================================
// "⭐ Guardar vista" guarda el estado completo del reporte (filtros incluidas
// fechas, agrupar por, columnas, orden, granularidad) en Supabase, por
// usuario + id de reporte. Al abrir el reporte se aplica sola; "↺ Limpiar"
// vuelve a la vista guardada y "✕ Quitar vista" la borra (vuelve al diseño
// original del reporte). Imports dinámicos para no crear dependencias
// circulares con auth/supabase en este motor genérico.
const _vistas = new Map()          // reporteId -> estado guardado
let _vistasPromesa = null

function _cargarVistas() {
  if (!_vistasPromesa) {
    _vistasPromesa = (async () => {
      try {
        const [{ supabase }, { getCurrentUser }] = await Promise.all([import('./supabase-client.js'), import('./auth-supabase.js')])
        const uid = getCurrentUser()?.db_id
        if (!uid) { _vistasPromesa = null; return }
        const { data, error } = await supabase.from('preferencias_reporte').select('reporte_id, estado').eq('user_id', uid)
        if (error) { console.warn('preferencias_reporte (¿falta correr el SQL 69?):', error.message); return }
        ;(data || []).forEach(r => _vistas.set(r.reporte_id, r.estado))
      } catch (e) { console.warn('No se pudieron cargar las vistas guardadas:', e) }
    })()
  }
  return _vistasPromesa
}

// Aplica una vista guardada sobre la config actual, descartando dimensiones
// o columnas que ya no existan en el reporte.
function _estadoDesdeVista(config, v, base) {
  const dims = new Set((config.dimensiones || []).map(d => d.key))
  const meds = new Set((config.medidas || []).map(m => m.key))
  const agrupar = (v.agrupar || []).filter(k => dims.has(k))
  const medidas = (v.medidas || []).filter(k => meds.has(k))
  return {
    ...base,
    filtros:  { ...(v.filtros || {}) },
    agrupar:  agrupar.length || (v.agrupar || []).length === 0 ? agrupar : base.agrupar,
    medidas:  medidas.length ? medidas : base.medidas,
    ordenKey: v.ordenKey ?? base.ordenKey,
    ordenDir: v.ordenDir || base.ordenDir,
    limite:   v.limite ?? base.limite,
    gran:     { ...base.gran, ...(v.gran || {}) }
  }
}

async function _guardarVista(id) {
  const reg = _registro.get(id)
  if (!reg) return
  try {
    const [{ supabase }, { getCurrentUser }] = await Promise.all([import('./supabase-client.js'), import('./auth-supabase.js')])
    const uid = getCurrentUser()?.db_id
    if (!uid) { showToast('No hay usuario en sesión', 'warning'); return }
    const estado = JSON.parse(JSON.stringify(reg.estado))
    const { error } = await supabase.from('preferencias_reporte')
      .upsert({ user_id: uid, reporte_id: id, estado, updated_at: new Date().toISOString() }, { onConflict: 'user_id,reporte_id' })
    if (error) throw new Error(error.message)
    _vistas.set(id, estado)
    showToast('Vista guardada ⭐ — este reporte abrirá siempre así', 'success')
    crearReporte(reg.containerId, reg.config)
  } catch (e) {
    console.error('_guardarVista:', e)
    showToast('No se pudo guardar la vista (¿falta correr el SQL 69?): ' + e.message, 'danger')
  }
}

async function _quitarVista(id) {
  const reg = _registro.get(id)
  if (!reg) return
  if (!confirm('¿Quitar la vista guardada de este reporte?\nVolverá a abrir con el diseño original.')) return
  try {
    const [{ supabase }, { getCurrentUser }] = await Promise.all([import('./supabase-client.js'), import('./auth-supabase.js')])
    const uid = getCurrentUser()?.db_id
    const { error } = await supabase.from('preferencias_reporte').delete().eq('user_id', uid).eq('reporte_id', id)
    if (error) throw new Error(error.message)
    _vistas.delete(id)
    _registro.delete(id)
    showToast('Vista guardada eliminada', 'success')
    crearReporte(reg.containerId, reg.config)
  } catch (e) {
    console.error('_quitarVista:', e)
    showToast('No se pudo quitar la vista: ' + e.message, 'danger')
  }
}

// ============================================================================
// AGREGACIÓN
// ============================================================================

const AGREGADORES = {
  sum:   (vals) => vals.reduce((s, v) => s + v, 0),
  count: (vals) => vals.length,
  avg:   (vals) => (vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0),
  min:   (vals) => (vals.length ? Math.min(...vals) : 0),
  max:   (vals) => (vals.length ? Math.max(...vals) : 0),
  distinct: (vals) => new Set(vals.filter(v => v !== null && v !== undefined && v !== '')).size
}

/** Agrupa `datos` por las claves indicadas y calcula las medidas. */
export function agrupar(datos, claves, medidas, resolver = null) {
  if (!claves || claves.length === 0) {
    return [{ _claves: [], _etiqueta: 'Total', _filas: datos, ...calcularMedidas(datos, medidas) }]
  }
  const mapa = new Map()
  datos.forEach(fila => {
    const valores = claves.map(k => resolver ? resolver(fila, k) : _valorDim(fila, k))
    const id = valores.join(' ▸ ')
    if (!mapa.has(id)) mapa.set(id, { _claves: valores, _etiqueta: id, _filas: [] })
    mapa.get(id)._filas.push(fila)
  })
  return Array.from(mapa.values()).map(g => ({ ...g, ...calcularMedidas(g._filas, medidas) }))
}

// Dimensión de FECHA con granularidad elegible (Año / Mes / Día) — 2026-10-02.
// Se declara en config.dimensiones como { key, label, tipo: 'fecha', campo?, granularidad? }.
const _GRAN = { anio: 'Año', mes: 'Mes', dia: 'Día' }
function _valorFecha(iso, gran) {
  const f = String(iso || '').slice(0, 10)
  if (!/^\d{4}-\d{2}/.test(f)) return '(sin fecha)'
  if (gran === 'anio') return f.slice(0, 4)
  if (gran === 'dia') return f.length === 10 ? `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}` : f
  return nombreMes(f.slice(0, 7))
}
/** Resuelve el valor de agrupación según config/estado (fechas granulares). */
function _resolverDims(config, estado) {
  const fechas = {}
  ;(config.dimensiones || []).forEach(d => { if (d.tipo === 'fecha') fechas[d.key] = d })
  if (!Object.keys(fechas).length) return null
  return (fila, k) => {
    const d = fechas[k]
    if (!d) return _valorDim(fila, k)
    return _valorFecha(fila[d.campo || d.key], estado.gran?.[k] || d.granularidad || 'mes')
  }
}

function _valorDim(fila, clave) {
  const v = fila[clave]
  if (v === null || v === undefined || v === '') return '(sin dato)'
  return String(v)
}

function calcularMedidas(filas, medidas) {
  const out = {}
  medidas.forEach(m => {
    // agg 'ratio': Σ num / Σ den (promedio PONDERADO, p.ej. costo unitario
    // = Σ(costo×kg) / Σ kg). num/den son funciones fila → número.
    if (m.agg === 'ratio') {
      let n = 0, d = 0
      filas.forEach(f => { n += parseFloat(m.num(f)) || 0; d += parseFloat(m.den(f)) || 0 })
      out[m.key] = d ? n / d : 0
      return
    }
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
    case 'tc':      return n ? formatNumber(n, 3) : '—'
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
  if (f.tipo === 'multi') {
    // Selección múltiple con chips: valorActual = array de valores incluidos
    // (undefined = todos). Sirve p.ej. para sacar traslados del kardex.
    const sel = Array.isArray(valorActual) ? valorActual : (f.opciones || []).map(o => typeof o === 'object' ? o.value : o)
    return `<div class="reporte-chips" data-rp-multi-box="${f.key}">
      ${(f.opciones || []).map(o => {
        const val = typeof o === 'object' ? o.value : o
        const lab = typeof o === 'object' ? o.label : o
        return `<button type="button" class="reporte-chip ${sel.includes(val) ? 'on' : ''}" data-rp-multi="${_esc(f.key)}" data-rp-val="${_esc(val)}">${_esc(lab)}</button>`
      }).join('')}
      <button type="button" class="reporte-chip" data-rp-multi-todos="${_esc(f.key)}" title="Marcar / desmarcar todos">✓ Todos</button>
    </div>`
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
      if (f.tipo === 'multi') {
        if (!Array.isArray(val)) continue
        if (!val.includes(String(fila[f.campo || f.key] ?? ''))) return false
        continue
      }
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
 *   kpis: (filasFiltradas) => [{ label, valor, formato, color }],
 *   visual: (filasFiltradas, { grupos, estado, idBuscar }) => html | null  // gráfico propio
 * }
 */
export function crearReporte(containerId, config) {
  const cont = document.getElementById(containerId)
  if (!cont) return

  const id = config.id || containerId
  const previo = _registro.get(id)?.estado
  const porDefecto = {
    filtros:  {},
    agrupar:  (config.agruparPorDefecto || (config.dimensiones[0] ? [config.dimensiones[0].key] : [])).slice(),
    medidas:  (config.medidasPorDefecto || config.medidas.map(m => m.key)).slice(),
    ordenKey: config.orden?.key || null,
    ordenDir: config.orden?.dir || 'desc',
    limite:   config.limite || 0,
    gran:     Object.fromEntries((config.dimensiones || []).filter(d => d.tipo === 'fecha').map(d => [d.key, d.granularidad || 'mes']))
  }
  const vista = _vistas.get(id)
  const estado = previo || (vista ? _estadoDesdeVista(config, vista, porDefecto) : porDefecto)
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
          <button class="btn btn-secondary btn-small" data-rp-accion="guardar-vista" data-rp-id="${id}" title="Guarda filtros, fechas, agrupación, columnas y orden: el reporte abrirá siempre así (solo para tu usuario)">⭐ ${vista ? 'Actualizar vista' : 'Guardar vista'}</button>
          ${vista ? `<button class="btn btn-secondary btn-small" data-rp-accion="quitar-vista" data-rp-id="${id}" title="Borra la vista guardada y vuelve al diseño original del reporte">✕ Quitar vista</button>` : ''}
          <button class="btn btn-secondary btn-small" data-rp-accion="excel" data-rp-id="${id}">⬇ Excel</button>
          <button class="btn btn-secondary btn-small" data-rp-accion="limpiar" data-rp-id="${id}" title="${vista ? 'Vuelve a tu vista guardada' : 'Vuelve al diseño original del reporte'}">↺ Limpiar</button>
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
            ${config.dimensiones.map(d => d.tipo === 'fecha' ? `
              <span role="button" tabindex="0" class="reporte-chip ${estado.agrupar.includes(d.key) ? 'on' : ''}"
                    data-rp-dim="${_esc(d.key)}" data-rp-id="${id}" style="display:inline-flex; align-items:center; gap:6px;">${_esc(d.label)}
                <select class="reporte-chip-gran" data-rp-gran="${_esc(d.key)}" title="Agrupar la fecha por"
                        onclick="event.stopPropagation()" onmousedown="event.stopPropagation()"
                        style="width:auto; padding:1px 4px; font-size:0.78rem; border-radius:6px; background:var(--bg-primary); color:var(--text-primary); border:1px solid var(--border-color);">
                  ${Object.entries(_GRAN).map(([v, l]) => `<option value="${v}" ${(estado.gran?.[d.key] || d.granularidad || 'mes') === v ? 'selected' : ''}>${l}</option>`).join('')}
                </select></span>` : `
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

  // Primera apertura: si las vistas guardadas aún no se cargaron, se
  // consultan y, si hay una para este reporte y el usuario no tocó nada
  // todavía, se vuelve a pintar con ella.
  if (!previo && !vista) {
    const foto = JSON.stringify(estado)
    _cargarVistas().then(() => {
      const reg = _registro.get(id)
      if (_vistas.has(id) && reg && JSON.stringify(reg.estado) === foto) {
        _registro.delete(id)
        crearReporte(containerId, config)
      }
    })
  }
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

  let grupos = agrupar(filtrados, estado.agrupar, medidasUsar, _resolverDims(config, estado))

  const ordenKey = estado.ordenKey || medidasUsar[0]?.key
  if (ordenKey) {
    const dir = estado.ordenDir === 'asc' ? 1 : -1
    grupos.sort((a, b) => {
      if (ordenKey === '_etiqueta') {
        // Cada segmento de la etiqueta (separados por ' ▸ ' cuando se agrupa
        // por varias dimensiones) se intenta convertir a un valor ordenable
        // cronológicamente si es un mes tipo "Ago 2026" (formato de
        // nombreMes) — así "Mes" ordena por fecha real y no alfabéticamente,
        // sin afectar el orden alfabético normal de Cliente/Producto/etc.
        const pa = String(a._etiqueta).split(' ▸ ').map(_valorOrdenable)
        const pb = String(b._etiqueta).split(' ▸ ').map(_valorOrdenable)
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const va = pa[i], vb = pb[i]
          if (va === vb) continue
          if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
          return String(va ?? '').localeCompare(String(vb ?? '')) * dir
        }
        return 0
      }
      const va = a[ordenKey] ?? 0
      const vb = b[ordenKey] ?? 0
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
    // config.visual(filtrados, ctx) → HTML propio del reporte (o null = barras por defecto)
    let vis = null
    if (config.visual) {
      try { vis = config.visual(filtrados, { grupos, estado, idBuscar: `rp-f-${id}-buscar` }) } catch (e) { console.warn('visual', e) }
    }
    if (vis) gCont.innerHTML = vis
    else if (config.grafico === false || grupos.length === 0 || estado.agrupar.length === 0) gCont.innerHTML = ''
    else gCont.innerHTML = _barras(grupos.slice(0, 12), medidasUsar[0])
  }
}

function _labelDim(config, key, estado = null) {
  const d = config.dimensiones.find(x => x.key === key)
  if (!d) return key
  if (d.tipo === 'fecha') {
    const g = (estado || _registro.get(config.id)?.estado)?.gran?.[key] || d.granularidad || 'mes'
    return `${d.label} (${_GRAN[g].toLowerCase()})`
  }
  return d.label
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

    const _opcionesMulti = (key) => ((config.filtros || []).find(f => f.key === key)?.opciones || [])
      .map(o => String(typeof o === 'object' ? o.value : o))
    cajaFiltros.querySelectorAll('[data-rp-multi]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-rp-multi')
        const val = btn.getAttribute('data-rp-val')
        const actual = Array.isArray(estado.filtros[key]) ? estado.filtros[key].slice() : _opcionesMulti(key)
        const i = actual.indexOf(val)
        if (i >= 0) actual.splice(i, 1); else actual.push(val)
        estado.filtros[key] = actual
        btn.classList.toggle('on', i < 0)
        refrescarReporte(id)
      })
    })
    cajaFiltros.querySelectorAll('[data-rp-multi-todos]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-rp-multi-todos')
        const todas = _opcionesMulti(key)
        const actual = Array.isArray(estado.filtros[key]) ? estado.filtros[key] : todas
        const marcarTodo = actual.length < todas.length
        estado.filtros[key] = marcarTodo ? todas : []
        cajaFiltros.querySelectorAll(`[data-rp-multi="${key}"]`).forEach(b => b.classList.toggle('on', marcarTodo))
        refrescarReporte(id)
      })
    })

    cajaFiltros.querySelectorAll('[data-rp-gran]').forEach(sel => {
      sel.addEventListener('change', (ev) => {
        ev.stopPropagation()
        const k = sel.getAttribute('data-rp-gran')
        estado.gran = { ...(estado.gran || {}), [k]: sel.value }
        // Elegir granularidad implica querer agrupar por esa fecha
        if (!estado.agrupar.includes(k)) {
          estado.agrupar.push(k)
          sel.closest('[data-rp-dim]')?.classList.add('on')
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
        // Medida que necesita una dimensión para tener sentido (p.ej. Costo
        // unitario → Lote): al activarla se agrega esa agrupación sola.
        const req = config.medidas.find(m => m.key === k)?.requiereDim
        if (i < 0 && req && !estado.agrupar.includes(req)) {
          estado.agrupar.push(req)
          cajaFiltros.querySelector(`[data-rp-dim="${req}"]`)?.classList.add('on')
        }
        refrescarReporte(id)
      })
    })
  }

  document.querySelectorAll(`[data-rp-accion][data-rp-id="${id}"]`).forEach(btn => {
    btn.addEventListener('click', () => {
      const accion = btn.getAttribute('data-rp-accion')
      if (accion === 'csv')     exportarCSV(id)
      if (accion === 'excel')   exportarExcel(id)
      if (accion === 'guardar-vista') _guardarVista(id)
      if (accion === 'quitar-vista')  _quitarVista(id)
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

/** Arma la matriz exportable: UNA columna por dimensión de agrupación (antes
 *  iban todas pegadas en una celda "Mes | Producto | Tipo"), N° registros y
 *  una columna por medida con el número crudo (no texto). */
function _matrizExport(id) {
  const reg = _registro.get(id)
  if (!reg) return null
  const { config, estado } = reg
  const filtrados = aplicarFiltros(config.datos || [], config.filtros || [], estado.filtros)
  const medidasSel = config.medidas.filter(m => estado.medidas.includes(m.key))
  const medidas = medidasSel.length ? medidasSel : config.medidas
  let grupos = agrupar(filtrados, estado.agrupar, medidas, _resolverDims(config, estado))
  // mismo orden que la tabla en pantalla (por etiqueta asc si no hay otro)
  const ok = estado.ordenKey || medidas[0]?.key || '_etiqueta'
  const dir = estado.ordenDir === 'asc' ? 1 : -1
  grupos.sort((a, b) => {
    if (ok === '_etiqueta') {
      const pa = a._claves.map(_valorOrdenable), pb = b._claves.map(_valorOrdenable)
      for (let i = 0; i < pa.length; i++) {
        if (pa[i] === pb[i]) continue
        if (typeof pa[i] === 'number' && typeof pb[i] === 'number') return (pa[i] - pb[i]) * dir
        return String(pa[i]).localeCompare(String(pb[i])) * dir
      }
      return 0
    }
    return ((a[ok] ?? 0) - (b[ok] ?? 0)) * dir
  })
  const dims = estado.agrupar.length ? estado.agrupar.map(k => _labelDim(config, k)) : ['Total']
  const dec = (m) => (m.formato === 'money4' ? 4 : (m.formato === 'int' ? 0 : ((m.formato === 'qty' || m.formato === 'tc') ? 3 : 2)))
  const num = (m, v) => { const n = parseFloat(v) || 0; const p = 10 ** dec(m); return Math.round(n * p) / p }
  const cab = [...dims, 'N° registros', ...medidas.map(m => m.label)]
  const filas = grupos.map(g => [...(g._claves.length ? g._claves : ['Total']), g._filas.length, ...medidas.map(m => num(m, g[m.key]))])
  const tot = calcularMedidas(filtrados, medidas)
  const filaTotal = ['TOTAL', ...dims.slice(1).map(() => ''), filtrados.length, ...medidas.map(m => num(m, tot[m.key]))]
  return { config, cab, filas, filaTotal, medidas, nDims: dims.length }
}

function _nombreArchivo(config, ext) {
  return `${(config.titulo || 'reporte').replace(/[^\w]+/g, '_')}_${new Date().toISOString().slice(0, 10)}.${ext}`
}

export function exportarCSV(id) {
  const mx = _matrizExport(id)
  if (!mx) return
  descargarCSV(_nombreArchivo(mx.config, 'csv'), [mx.cab, ...mx.filas, mx.filaTotal])
}

/** Exporta a .xlsx real (SheetJS, mismo import que usa importar-compras.js).
 *  Si el CDN no carga, cae al CSV para no dejar al usuario sin archivo. */
export async function exportarExcel(id) {
  const mx = _matrizExport(id)
  if (!mx) return
  let XLSX
  try { XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm') }
  catch (e) { console.error('No cargó SheetJS, exporto CSV:', e); exportarCSV(id); return }
  const aoa = [mx.cab, ...mx.filas, mx.filaTotal]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  // formato numérico por columna de medida
  const fmt = (m) => m.formato === 'money4' ? '#,##0.0000' : (m.formato === 'int' ? '#,##0' : (m.formato === 'qty' ? '#,##0.###' : (m.formato === 'tc' ? '0.000' : '#,##0.00')))
  for (let r = 1; r < aoa.length; r++) {
    mx.medidas.forEach((m, j) => {
      const ref = XLSX.utils.encode_cell({ r, c: mx.nDims + 1 + j })
      if (ws[ref] && typeof ws[ref].v === 'number') ws[ref].z = fmt(m)
    })
  }
  ws['!cols'] = mx.cab.map((h, c) => ({ wch: Math.min(90, Math.max(String(h).length + 2, ...aoa.map(f => String(f[c] ?? '').length + 2))) }))
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 2, c: mx.cab.length - 1 } }) }
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, (mx.config.titulo || 'Reporte').replace(/[\\/?*\[\]:]/g, '').slice(0, 31))
  XLSX.writeFile(wb, _nombreArchivo(mx.config, 'xlsx'))
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

const _MESES_ABREV = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Set', 'Oct', 'Nov', 'Dic']

/** Nombre de mes legible desde 'YYYY-MM'. */
export function nombreMes(ym) {
  if (!ym) return '(sin fecha)'
  const [a, m] = ym.split('-')
  return `${_MESES_ABREV[parseInt(m, 10) - 1] || m} ${a}`
}

/** Convierte una etiqueta "Ago 2026" (formato de nombreMes) en un número
 *  YYYYMM ordenable cronológicamente. Si no matchea ese formato (Cliente,
 *  Producto, Lote, "(sin fecha)", etc.) devuelve el valor tal cual, así
 *  sigue ordenando alfabéticamente como antes. */
function _valorOrdenable(valor) {
  const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(valor)            // DD/MM/AAAA (fecha por día)
  if (d) return parseInt(d[3] + d[2] + d[1], 10)
  if (/^\d{4}$/.test(valor)) return parseInt(valor, 10) * 10000     // AAAA (fecha por año)
  const m = /^([A-Za-z]{3})\s(\d{4})$/.exec(valor)
  if (!m) return valor
  const idx = _MESES_ABREV.indexOf(m[1])
  if (idx === -1) return valor
  return parseInt(m[2], 10) * 100 + (idx + 1)
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

export { _esc as escaparHtml }
