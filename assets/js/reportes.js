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
import { renderTablaReporte, enlazarTabla, construirArbol, filasVisibles, matrizCruzada } from './shared/arbol-reporte.js'
import { analizar } from './shared/observaciones-reporte.js'

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
    vista: ['arbol', 'cruzada', 'plana'].includes(v.vista) ? v.vista : base.vista, nivelAbierto: v.nivelAbierto ?? base.nivelAbierto, exc: { ...(v.exc || {}) },
    pesa: !!v.pesa, soloAlertas: false, medCruz: v.medCruz && meds.has(v.medCruz) ? v.medCruz : null,
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
    case 'money4':  return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })   // unitarios: hasta 6 dec.
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

// ── MULTISELECCIÓN (2026-10-10) ──────────────────────────────────────────────
// Todo filtro 'select' es un desplegable con casillas + buscador. Los filtros
// de texto que buscan en un campo de contacto (cliente / proveedor / contacto)
// suman un multiselect con los contactos que hay en los datos: en Ventas
// salen clientes y en Compras proveedores, porque se arma de las filas.
// Estado: array de valores; vacío/undefined = todos. Un valor viejo (string,
// de una vista ⭐ guardada) se toma como lista de 1.
const _CAMPOS_CONTACTO = ['cliente', 'proveedor', 'contacto', 'contraparte']
const _campoContacto = f => f.tipo === 'texto' && f.multi !== false
  ? (f.campos || [f.campo || f.key]).find(c => _CAMPOS_CONTACTO.includes(c)) || null : null
const _msKey = (f, cf) => `${f.key}::${cf}`
const _comoLista = v => Array.isArray(v) ? v.map(String) : (v === undefined || v === null || v === '' ? [] : [String(v)])

function _opcionesSelect(f) {
  return (f.opciones || []).map(o => ({ v: String(typeof o === 'object' ? o.value : o), l: String(typeof o === 'object' ? o.label : o) }))
}
function _opcionesDeDatos(datos, campo) {
  const set = new Set()
  ;(datos || []).forEach(r => { const v = r?.[campo]; if (v !== undefined && v !== null && v !== '') set.add(String(v)) })
  return [...set].sort((a, b) => a.localeCompare(b, 'es')).map(v => ({ v, l: v }))
}
function _etiquetaMs(opciones, sel, todos = 'Todos') {
  if (!sel.length) return todos
  if (sel.length === 1) return opciones.find(o => o.v === sel[0])?.l || sel[0]
  return `${sel.length} seleccionados`
}
function _htmlMs(msKey, opciones, valorActual, todos = 'Todos') {
  const sel = _comoLista(valorActual)
  return `<div class="rp-ms" data-rp-ms="${_esc(msKey)}">
    <button type="button" class="rp-ms-btn ${sel.length ? 'activo' : ''}" title="${_esc(sel.join(', '))}"><span class="rp-ms-txt">${_esc(_etiquetaMs(opciones, sel, todos))}</span> <span class="rp-ms-car">▾</span></button>
    <div class="rp-ms-panel" hidden>
      ${opciones.length > 6 ? '<input type="text" class="rp-ms-buscar" placeholder="Buscar...">' : ''}
      <div class="rp-ms-acc"><a href="#" data-rp-ms-todos>Marcar visibles</a><a href="#" data-rp-ms-limpiar>Limpiar</a></div>
      <div class="rp-ms-lista">
        ${opciones.map(o => `<label class="rp-ms-op" data-txt="${_esc(o.l.toLowerCase())}"><input type="checkbox" value="${_esc(o.v)}" ${sel.includes(o.v) ? 'checked' : ''}> <span>${_esc(o.l)}</span></label>`).join('') || '<small style="color:var(--text-secondary);">Sin opciones</small>'}
      </div>
    </div>
  </div>`
}

function _htmlFiltro(id, f, valorActual, estadoFiltros = {}, datos = []) {
  const base = `rp-f-${id}-${f.key}`
  if (f.tipo === 'select') return _htmlMs(f.key, _opcionesSelect(f), valorActual, f.placeholderTodos || 'Todos')
  const cf = _campoContacto(f)
  if (cf) {
    const otros = (f.campos || [f.campo || f.key]).filter(c => c !== cf)
    const ms = _htmlMs(_msKey(f, cf), _opcionesDeDatos(datos, cf), estadoFiltros[_msKey(f, cf)], `Todos (${cf === 'proveedor' ? 'proveedores' : cf === 'cliente' ? 'clientes' : 'contactos'})`)
    if (!otros.length) return ms
    return `<div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">${ms}
      <input type="text" id="${base}" data-filtro="${f.key}" value="${_esc(typeof valorActual === 'string' ? valorActual : '')}" placeholder="${_esc('Buscar ' + otros.join(', ') + '...')}" style="min-width:150px; flex:1;"></div>`
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
      // Multiselect de contactos (filtros de texto)
      const cf = _campoContacto(f)
      if (cf) {
        const selC = _comoLista(estado[_msKey(f, cf)])
        if (selC.length && !selC.includes(String(fila[cf] ?? ''))) return false
      }
      // Select → multiselección
      if (f.tipo === 'select') {
        const selS = _comoLista(estado[f.key])
        if (!selS.length) continue
        if (f.match) { if (!selS.some(v => f.match(fila, v))) return false; continue }
        if (!selS.includes(String(fila[f.campo || f.key] ?? ''))) return false
        continue
      }
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
        if (Array.isArray(val)) continue
        // Con multiselect de contacto, el texto busca solo en los OTROS campos
        const campos = (f.campos || [f.campo || f.key]).filter(c => !cf || c !== cf)
        if (!campos.length) continue
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
// El Centro de estadísticas (dashboard) captura estas configs desde un iframe oculto de cada módulo
if (typeof window !== 'undefined') window.__zvReportes = _registro

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
    vista: 'arbol', nivelAbierto: 0, exc: {}, pesa: false, soloAlertas: false, medCruz: null,
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
          <button class="btn btn-secondary btn-small" data-rp-accion="imprimir" data-rp-id="${id}" title="Imprimir este reporte en PDF: tú eliges qué secciones incluir">🖨️ Imprimir PDF</button>
          <button class="btn btn-secondary btn-small" data-rp-accion="limpiar" data-rp-id="${id}" title="${vista ? 'Vuelve a tu vista guardada' : 'Vuelve al diseño original del reporte'}">↺ Limpiar</button>
        </div>
      </div>

      <div class="reporte-filtros" id="rp-filtros-${id}">
        ${(config.filtros || []).map(f => `
          <div class="reporte-filtro">
            <label>${_esc(f.label)}</label>
            ${_htmlFiltro(id, f, estado.filtros[f.key], estado.filtros, config.datos)}
          </div>`).join('')}

        <div class="reporte-filtro">
          <label>Agrupar por <span class="rp-ayuda">· cada chip es un nivel · arrastra para cambiar el orden</span></label>
          <div class="reporte-chips" id="rp-dims-${id}">
            ${config.dimensiones.map(d => d.tipo === 'fecha' ? `
              <span role="button" tabindex="0" class="reporte-chip ${estado.agrupar.includes(d.key) ? 'on' : ''}" draggable="true"
                    data-rp-dim="${_esc(d.key)}" data-rp-id="${id}" style="display:inline-flex; align-items:center; gap:6px;">${estado.agrupar.includes(d.key) ? `<b class="rp-ord">${estado.agrupar.indexOf(d.key) + 1}</b>` : ''}${_esc(d.label)}
                <select class="reporte-chip-gran" data-rp-gran="${_esc(d.key)}" title="Agrupar la fecha por"
                        onclick="event.stopPropagation()" onmousedown="event.stopPropagation()"
                        style="width:auto; padding:1px 4px; font-size:0.78rem; border-radius:6px; background:var(--bg-primary); color:var(--text-primary); border:1px solid var(--border-color);">
                  ${Object.entries(_GRAN).map(([v, l]) => `<option value="${v}" ${(estado.gran?.[d.key] || d.granularidad || 'mes') === v ? 'selected' : ''}>${l}</option>`).join('')}
                </select></span>` : `
              <button type="button" class="reporte-chip ${estado.agrupar.includes(d.key) ? 'on' : ''}" draggable="true"
                      data-rp-dim="${_esc(d.key)}" data-rp-id="${id}">${estado.agrupar.includes(d.key) ? `<b class="rp-ord">${estado.agrupar.indexOf(d.key) + 1}</b>` : ''}${_esc(d.label)}</button>`).join('')}
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

  // --- Tabla: Árbol / Cruzada / Plana (ver shared/arbol-reporte.js)
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
    else {
      const base = estado.agrupar.length > 1 && (estado.vista || 'arbol') !== 'plana'
        ? agrupar(filtrados, [estado.agrupar.find(k => !_esFechaDim(config, k)) || estado.agrupar[0]], medidasUsar, _resolverDims(config, estado)).sort((a, b) => (b[medidasUsar[0].key] || 0) - (a[medidasUsar[0].key] || 0))
        : grupos
      gCont.innerHTML = _barras(base.slice(0, 12), medidasUsar[0])
    }
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

    // Multiselect desplegable
    cajaFiltros.querySelectorAll('[data-rp-ms]').forEach(box => {
      const key = box.getAttribute('data-rp-ms')
      const btn = box.querySelector('.rp-ms-btn')
      const panel = box.querySelector('.rp-ms-panel')
      const pintarBtn = () => {
        const sel = _comoLista(estado.filtros[key])
        const ops = [...box.querySelectorAll('.rp-ms-op')].map(l => ({ v: l.querySelector('input').value, l: l.textContent.trim() }))
        const f = (config.filtros || []).find(x => x.key === key)
        box.querySelector('.rp-ms-txt').textContent = _etiquetaMs(ops, sel, f?.placeholderTodos || (key.includes('::') ? 'Todos' : 'Todos'))
        btn.classList.toggle('activo', sel.length > 0)
        btn.title = sel.join(', ')
      }
      const leer = () => {
        estado.filtros[key] = [...box.querySelectorAll('.rp-ms-op input:checked')].map(i => i.value)
        pintarBtn(); refrescarReporte(id)
      }
      btn.addEventListener('click', ev => {
        ev.stopPropagation()
        const abrir = panel.hidden
        document.querySelectorAll('.rp-ms-panel').forEach(p => { p.hidden = true })
        panel.hidden = !abrir
        if (abrir) box.querySelector('.rp-ms-buscar')?.focus()
      })
      panel.addEventListener('click', ev => ev.stopPropagation())
      box.querySelectorAll('.rp-ms-op input').forEach(i => i.addEventListener('change', leer))
      box.querySelector('.rp-ms-buscar')?.addEventListener('input', ev => {
        const q = ev.target.value.toLowerCase().trim()
        box.querySelectorAll('.rp-ms-op').forEach(l => { l.hidden = !!q && !l.dataset.txt.includes(q) })
      })
      box.querySelector('[data-rp-ms-todos]')?.addEventListener('click', ev => {
        ev.preventDefault()
        box.querySelectorAll('.rp-ms-op').forEach(l => { if (!l.hidden) l.querySelector('input').checked = true })
        leer()
      })
      box.querySelector('[data-rp-ms-limpiar]')?.addEventListener('click', ev => {
        ev.preventDefault()
        box.querySelectorAll('.rp-ms-op input').forEach(i => { i.checked = false })
        leer()
      })
    })
    if (!window.__rpMsCierre) {
      window.__rpMsCierre = true
      document.addEventListener('click', () => document.querySelectorAll('.rp-ms-panel').forEach(p => { p.hidden = true }))
    }

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
          estado.exc = {}; crearReporte(reg.containerId, config); return
        }
        refrescarReporte(id)
      })
    })

    cajaFiltros.querySelectorAll('[data-rp-dim]').forEach(btn => {
      btn.addEventListener('click', () => {
        const k = btn.getAttribute('data-rp-dim')
        const i = estado.agrupar.indexOf(k)
        if (i >= 0) estado.agrupar.splice(i, 1); else estado.agrupar.push(k)
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
          estado.exc = {}; crearReporte(reg.containerId, config); return
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
      if (accion === 'imprimir') imprimirReporte(id)
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
  const dec = (m) => (m.formato === 'money4' ? 6 : (m.formato === 'int' ? 0 : ((m.formato === 'qty' || m.formato === 'tc') ? 3 : 2)))
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
  const fmt = (m) => m.formato === 'money4' ? '#,##0.00####' : (m.formato === 'int' ? '#,##0' : (m.formato === 'qty' ? '#,##0.###' : (m.formato === 'tc' ? '0.000' : '#,##0.00')))
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

export { calcularMedidas as _calcularMedidas }

// ============================================================================
// BOTÓN 📊 «Estadísticas» en la barra de sub-pestañas de cada módulo de reportes
// → abre el Centro de estadísticas (dashboard) con ese reporte ya elegido.
// ============================================================================
function _inyectarBotonStats() {
  try {
    const mod = (location.pathname.split('/').pop() || '').replace('.html', '')
    if (!['compras', 'ventas', 'inventario', 'cobranzas', 'bancos', 'contabilidad'].includes(mod)) return
    if (new URLSearchParams(location.search).get('zv') === '1') return   // iframe de captura: no hace falta
    document.querySelectorAll('.subtab-bar[id$="subtabs-reportes"]').forEach(bar => {
      if (bar.querySelector('.rp-stats-btn')) return
      const b = document.createElement('button')
      b.type = 'button'; b.className = 'rp-stats-btn'
      b.title = 'Ver este reporte en Estadísticas: gráficos, filtros, buscador y análisis'
      b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>'
      b.addEventListener('click', () => {
        const act = bar.querySelector('.subtab.active')?.dataset.sub || ''
        location.href = `dashboard.html?m=${mod}&r=${encodeURIComponent(act)}`
      })
      bar.appendChild(b)
    })
  } catch (e) { console.warn('boton estadísticas:', e) }
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _inyectarBotonStats)
  else _inyectarBotonStats()
}


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
