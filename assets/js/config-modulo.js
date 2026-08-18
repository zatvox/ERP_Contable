// ============================================================================
// CONFIG-MODULO.JS - Preferencias de vista/parámetros por módulo + apariencia
// ============================================================================
// Dos capas:
//   1. GLOBAL ('apariencia'): densidad, tamaño de fuente, color de acento,
//      formato de fecha/número, moneda, filas por página. Se aplica a TODAS
//      las pantallas vía clases en <body> y variables CSS.
//   2. POR MÓDULO: parámetros de negocio propios (IGV por defecto, series,
//      umbrales, etc.).
//
// Todo vive en localStorage: son preferencias de UI del navegador, no datos
// del negocio. Los cambios de apariencia se aplican EN CALIENTE; los
// parámetros de negocio se leen al abrir cada modal/listado.
// ============================================================================

const DEFAULTS = {
  apariencia: {
    tema:              'auto',      // 'auto' | 'claro' | 'oscuro'
    densidad:          'normal',    // 'compacta' | 'normal' | 'comoda'
    tamanoFuente:      100,         // %
    colorAcento:       '#14213d',
    rayado:            true,        // filas alternas (zebra)
    bordesTabla:       true,
    sidebarColapsado:  false,
    formatoFecha:      'dd/mm/aaaa',
    decimales:         2,
    monedaDefault:     'PEN',
    filasPorPagina:    50,
    animaciones:       true,
    mostrarKpis:       true
  },
  inventario: {
    stockCritico:       5,
    tablaCompacta:      false,
    alertaVencimiento:  30,
    mostrarCostos:      true,
    ordenProductos:     'nombre'
  },
  compras: {
    igvDefault:         18,
    // La mayoría de las compras son importadas: USD por defecto. El campo de
    // Tipo de Cambio aparece de entrada y solo se oculta al elegir PEN.
    monedaDefault:      'USD',
    itemsPorPagina:     50,
    tablaCompacta:      false,
    serieFacturaCompra: '',
    crearCxPAuto:       true,
    diasCreditoDefault: 30
  },
  ventas: {
    monedaDefault:      'PEN',
    serieFactura:       'F001',
    serieBoleta:        'B001',
    serieNotaCredito:   'FC01',
    serieNotaDebito:    'FD01',
    itemsPorPagina:     50,
    tablaCompacta:      false,
    igvDefault:         18,
    crearCxCAuto:       true,
    diasCreditoDefault: 30,
    avisarStockInsuf:   true
  },
  cobranzas: {
    retencionIgvPct:    3,
    detraccionPct:      12,
    diasAlertaVenc:     7,
    tramosAntiguedad:   '30,60,90',
    monedaDefault:      'PEN',
    autoMovBanco:       true,     // crea movimiento bancario al cobrar/pagar
    tablaCompacta:      false
  },
  bancos: {
    monedaDefault:      'PEN',
    alertaSaldoBajo:    1000,
    autoConciliar:      false,
    tablaCompacta:      false,
    mostrarSaldoProy:   true
  },
  contabilidad: {
    monedaDefault:      'PEN',
    cuentaIgvVentas:    '40111',
    cuentaIgvCompras:   '40111',
    cuentaRetencion:    '40114',
    decimalesAsiento:   2,
    bloquearPeriodo:    true,
    tablaCompacta:      false
  },
  dashboard: {
    vista:              'financiero',  // 'financiero' | 'comercial'
    periodo:            'mes',         // 'mes' | 'trimestre' | 'anio'
    autoRefrescar:      0,             // minutos, 0 = manual
    mostrarGraficos:    true
  },
  perfil: {
    paginaInicio:       'dashboard.html',
    notificaciones:     true
  }
}

function _key(modulo) { return `jhiro_config_${modulo}` }

export function getModuloConfig(modulo) {
  const base = DEFAULTS[modulo] || {}
  try {
    const raw = localStorage.getItem(_key(modulo))
    return { ...base, ...(raw ? JSON.parse(raw) : {}) }
  } catch (e) {
    console.warn('Config inválida en localStorage, usando valores por defecto:', e)
    return { ...base }
  }
}

export function guardarModuloConfig(modulo, data) {
  const actual = getModuloConfig(modulo)
  const nuevo = { ...actual, ...data }
  localStorage.setItem(_key(modulo), JSON.stringify(nuevo))
  return nuevo
}

export function restaurarDefaults(modulo) {
  localStorage.removeItem(_key(modulo))
  return { ...(DEFAULTS[modulo] || {}) }
}

export function getApariencia() { return getModuloConfig('apariencia') }

// ============================================================================
// APLICAR APARIENCIA GLOBAL (en caliente)
// ============================================================================

export function aplicarApariencia() {
  const a = getApariencia()
  const b = document.body
  if (!b) return

  b.classList.remove('densidad-compacta', 'densidad-normal', 'densidad-comoda')
  b.classList.add(`densidad-${a.densidad || 'normal'}`)
  b.classList.toggle('tabla-compacta', a.densidad === 'compacta')
  b.classList.toggle('tabla-rayada', !!a.rayado)
  b.classList.toggle('tabla-sin-bordes', !a.bordesTabla)
  b.classList.toggle('sin-animaciones', !a.animaciones)
  b.classList.toggle('ocultar-kpis', !a.mostrarKpis)

  const root = document.documentElement
  root.style.setProperty('--font-scale', `${(a.tamanoFuente || 100) / 100}`)
  if (a.colorAcento) {
    root.style.setProperty('--color-primary', a.colorAcento)
    root.style.setProperty('--color-primary-light', _oscurecer(a.colorAcento, 0.25))
  }

  if (a.tema === 'claro')       b.classList.remove('dark-mode')
  else if (a.tema === 'oscuro') b.classList.add('dark-mode')
  // 'auto' respeta lo que guardó el botón 🌙/☀️ (erp_theme) — no se toca.
}

function _oscurecer(hex, factor) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '')
  if (!m) return hex
  const c = [1, 2, 3].map(i => Math.max(0, Math.round(parseInt(m[i], 16) * (1 - factor))))
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('')
}

/** Llamar una vez en el DOMContentLoaded de cada módulo. */
export function aplicarPreferenciasVista(modulo) {
  aplicarApariencia()
  const config = getModuloConfig(modulo)
  if (config.tablaCompacta) document.body.classList.add('tabla-compacta')
}

// ============================================================================
// DEFINICIÓN DE CAMPOS POR MÓDULO
// ============================================================================

const SEP = (titulo) => ({ tipo: 'separador', label: titulo })

const CAMPOS_APARIENCIA = [
  SEP('Tema y densidad'),
  { key: 'tema',         label: 'Tema de color', tipo: 'select', opciones: [{ value: 'auto', label: 'Automático (usa el botón 🌙/☀️)' }, { value: 'claro', label: 'Siempre claro' }, { value: 'oscuro', label: 'Siempre oscuro' }] },
  { key: 'densidad',     label: 'Densidad de las tablas', tipo: 'select', opciones: [{ value: 'compacta', label: 'Compacta' }, { value: 'normal', label: 'Normal' }, { value: 'comoda', label: 'Cómoda' }] },
  { key: 'tamanoFuente', label: 'Tamaño de letra (%)', tipo: 'range', min: 85, max: 125, step: 5 },
  { key: 'colorAcento',  label: 'Color de acento', tipo: 'color', hint: 'Afecta sidebar, botones primarios y encabezados.' },
  SEP('Tablas'),
  { key: 'rayado',       label: 'Filas alternas (zebra)', tipo: 'checkbox' },
  { key: 'bordesTabla',  label: 'Mostrar bordes de tabla', tipo: 'checkbox' },
  { key: 'filasPorPagina', label: 'Filas por página (listados)', tipo: 'select', opciones: [10, 25, 50, 100, 200] },
  SEP('Formatos'),
  { key: 'formatoFecha', label: 'Formato de fecha', tipo: 'select', opciones: ['dd/mm/aaaa', 'aaaa-mm-dd', 'dd-mmm-aaaa'] },
  { key: 'decimales',    label: 'Decimales en montos', tipo: 'select', opciones: [0, 2, 3, 4] },
  { key: 'monedaDefault', label: 'Moneda por defecto', tipo: 'select', opciones: ['PEN', 'USD'] },
  SEP('Comportamiento'),
  { key: 'animaciones',  label: 'Animaciones y transiciones', tipo: 'checkbox' },
  { key: 'mostrarKpis',  label: 'Mostrar tarjetas KPI en los módulos', tipo: 'checkbox' }
]

const CAMPOS_POR_MODULO = {
  apariencia: CAMPOS_APARIENCIA,
  inventario: [
    SEP('Stock'),
    { key: 'stockCritico',      label: 'Umbral de stock crítico', tipo: 'number', hint: 'Productos por debajo de este número se marcan en rojo en "Resumen Stock".' },
    { key: 'alertaVencimiento', label: 'Avisar lotes por vencer (días antes)', tipo: 'number' },
    { key: 'mostrarCostos',     label: 'Mostrar costos unitarios en los listados', tipo: 'checkbox' },
    SEP('Presentación'),
    { key: 'ordenProductos',    label: 'Orden por defecto de productos', tipo: 'select', opciones: [{ value: 'nombre', label: 'Nombre' }, { value: 'sku', label: 'SKU' }, { value: 'stock', label: 'Stock (mayor primero)' }] },
    { key: 'tablaCompacta',     label: 'Tablas compactas en este módulo', tipo: 'checkbox' }
  ],
  compras: [
    SEP('Documentos'),
    { key: 'igvDefault',         label: 'IGV % por defecto', tipo: 'number', hint: 'Precargado al agregar una línea nueva (sigue siendo editable).' },
    { key: 'monedaDefault',      label: 'Moneda por defecto', tipo: 'select', opciones: ['PEN', 'USD'] },
    { key: 'serieFacturaCompra', label: 'Serie sugerida al registrar factura', tipo: 'text' },
    SEP('Cuentas por pagar'),
    { key: 'crearCxPAuto',       label: 'Crear Cuenta por Pagar al registrar factura (01)', tipo: 'checkbox', hint: 'Recomendado dejarlo activo: mantiene simétrico CxC/CxP.' },
    { key: 'diasCreditoDefault', label: 'Días de crédito por defecto', tipo: 'number' },
    SEP('Presentación'),
    { key: 'itemsPorPagina',     label: 'Compras por página', tipo: 'select', opciones: [10, 25, 50, 100] },
    { key: 'tablaCompacta',      label: 'Tablas compactas en este módulo', tipo: 'checkbox' }
  ],
  ventas: [
    SEP('Comprobantes'),
    { key: 'serieFactura',       label: 'Serie de Factura por defecto', tipo: 'text' },
    { key: 'serieBoleta',        label: 'Serie de Boleta por defecto', tipo: 'text' },
    { key: 'serieNotaCredito',   label: 'Serie de Nota de Crédito', tipo: 'text', hint: 'Las notas llevan su propia serie correlativa, distinta de la factura.' },
    { key: 'serieNotaDebito',    label: 'Serie de Nota de Débito', tipo: 'text' },
    { key: 'igvDefault',         label: 'IGV % por defecto', tipo: 'number' },
    { key: 'monedaDefault',      label: 'Moneda por defecto', tipo: 'select', opciones: ['PEN', 'USD'] },
    SEP('Cuentas por cobrar y stock'),
    { key: 'crearCxCAuto',       label: 'Crear Cuenta por Cobrar al emitir factura (01)', tipo: 'checkbox' },
    { key: 'diasCreditoDefault', label: 'Días de crédito por defecto', tipo: 'number' },
    { key: 'avisarStockInsuf',   label: 'Avisar si no hay stock suficiente al agregar línea', tipo: 'checkbox' },
    SEP('Presentación'),
    { key: 'itemsPorPagina',     label: 'Registros por página', tipo: 'select', opciones: [10, 25, 50, 100] },
    { key: 'tablaCompacta',      label: 'Tablas compactas en este módulo', tipo: 'checkbox' }
  ],
  cobranzas: [
    SEP('Retenciones y detracciones'),
    { key: 'retencionIgvPct',  label: 'Retención de IGV (%)', tipo: 'number', hint: 'Régimen de Retenciones SUNAT. Estándar: 3%.' },
    { key: 'detraccionPct',    label: 'Detracción por defecto (%)', tipo: 'number', hint: 'Informativo por ahora; se usará al implementar detracciones.' },
    SEP('Vencimientos'),
    { key: 'diasAlertaVenc',   label: 'Avisar documentos por vencer (días antes)', tipo: 'number' },
    { key: 'tramosAntiguedad', label: 'Tramos de antigüedad (días)', tipo: 'text', hint: 'Separados por coma. Ej: 30,60,90' },
    SEP('Integración'),
    { key: 'autoMovBanco',     label: 'Registrar movimiento bancario al cobrar/pagar', tipo: 'checkbox', hint: 'Crea automáticamente el ingreso/egreso en la cuenta bancaria elegida y actualiza su saldo.' },
    { key: 'monedaDefault',    label: 'Moneda por defecto', tipo: 'select', opciones: ['PEN', 'USD'] },
    { key: 'tablaCompacta',    label: 'Tablas compactas en este módulo', tipo: 'checkbox' }
  ],
  bancos: [
    SEP('Cuentas'),
    { key: 'monedaDefault',   label: 'Moneda por defecto de nuevas cuentas', tipo: 'select', opciones: ['PEN', 'USD'] },
    { key: 'alertaSaldoBajo', label: 'Alertar cuando el saldo baje de', tipo: 'number' },
    { key: 'mostrarSaldoProy', label: 'Mostrar saldo proyectado (saldo − CxP + CxC)', tipo: 'checkbox' },
    SEP('Conciliación'),
    { key: 'autoConciliar',   label: 'Marcar como reconciliado al registrar el movimiento', tipo: 'checkbox' },
    { key: 'tablaCompacta',   label: 'Tablas compactas en este módulo', tipo: 'checkbox' }
  ],
  contabilidad: [
    SEP('Cuentas por defecto (PCGE)'),
    { key: 'cuentaIgvVentas',  label: 'Cuenta IGV ventas', tipo: 'text' },
    { key: 'cuentaIgvCompras', label: 'Cuenta IGV compras', tipo: 'text' },
    { key: 'cuentaRetencion',  label: 'Cuenta de retenciones IGV', tipo: 'text' },
    SEP('Asientos y períodos'),
    { key: 'decimalesAsiento', label: 'Decimales en asientos', tipo: 'select', opciones: [2, 3, 4] },
    { key: 'bloquearPeriodo',  label: 'Impedir registrar en períodos cerrados', tipo: 'checkbox' },
    { key: 'monedaDefault',    label: 'Moneda funcional', tipo: 'select', opciones: ['PEN', 'USD'] },
    { key: 'tablaCompacta',    label: 'Tablas compactas en este módulo', tipo: 'checkbox' }
  ],
  dashboard: [
    SEP('Vista'),
    { key: 'vista',          label: 'Vista por defecto', tipo: 'select', opciones: [{ value: 'financiero', label: 'Financiero / Contable' }, { value: 'comercial', label: 'Ventas / Inventario' }] },
    { key: 'periodo',        label: 'Período por defecto', tipo: 'select', opciones: [{ value: 'mes', label: 'Mes actual' }, { value: 'trimestre', label: 'Trimestre' }, { value: 'anio', label: 'Año' }] },
    { key: 'mostrarGraficos', label: 'Mostrar gráficos', tipo: 'checkbox' },
    { key: 'autoRefrescar',  label: 'Auto-refrescar cada (min, 0 = manual)', tipo: 'number' }
  ],
  perfil: [
    { key: 'paginaInicio',   label: 'Página de inicio al entrar', tipo: 'select', opciones: [
      { value: 'dashboard.html', label: 'Dashboard' }, { value: 'inventario.html', label: 'Inventario' },
      { value: 'compras.html', label: 'Compras' }, { value: 'ventas.html', label: 'Ventas' },
      { value: 'cobranzas.html', label: 'Cuentas x Cobrar/Pagar' }, { value: 'bancos.html', label: 'Bancos' },
      { value: 'contabilidad.html', label: 'Contabilidad' } ] },
    { key: 'notificaciones', label: 'Mostrar avisos emergentes (toasts)', tipo: 'checkbox' }
  ]
}

// ============================================================================
// RENDER — formulario de Configuración
// ============================================================================

function _campoHtml(modulo, campo, valorActual) {
  if (campo.tipo === 'separador') {
    return `<div class="cfg-separador">${campo.label}</div>`
  }
  const id = `cfg-${modulo}-${campo.key}`
  let input = ''
  if (campo.tipo === 'select') {
    input = `<select id="${id}">${campo.opciones.map(o => {
      const val = typeof o === 'object' ? o.value : o
      const lab = typeof o === 'object' ? o.label : o
      return `<option value="${val}" ${String(val) === String(valorActual) ? 'selected' : ''}>${lab}</option>`
    }).join('')}</select>`
  } else if (campo.tipo === 'checkbox') {
    input = `<label class="switch"><input type="checkbox" id="${id}" ${valorActual ? 'checked' : ''}><span class="switch-slider"></span></label>`
  } else if (campo.tipo === 'number') {
    input = `<input type="number" id="${id}" value="${valorActual ?? 0}" min="0" step="any" style="max-width:120px;">`
  } else if (campo.tipo === 'range') {
    input = `<div style="display:flex; align-items:center; gap:8px;">
      <input type="range" id="${id}" value="${valorActual ?? campo.min}" min="${campo.min}" max="${campo.max}" step="${campo.step || 1}" style="width:140px;">
      <output id="${id}-out" style="min-width:42px; font-variant-numeric:tabular-nums;">${valorActual}%</output></div>`
  } else if (campo.tipo === 'color') {
    input = `<input type="color" id="${id}" value="${valorActual || '#14213d'}" style="width:56px; height:32px; padding:2px;">`
  } else {
    input = `<input type="text" id="${id}" value="${valorActual ?? ''}" style="max-width:220px;">`
  }

  return `
    <div class="cfg-fila">
      <div class="cfg-fila-texto">
        <label>${campo.label}</label>
        ${campo.hint ? `<div class="cfg-hint">${campo.hint}</div>` : ''}
      </div>
      <div>${input}</div>
    </div>`
}

/**
 * Renderiza el tab de Configuración de un módulo.
 * Siempre incluye, además de los campos del módulo, la sección global de
 * Apariencia (para que se pueda ajustar el diseño desde cualquier pantalla).
 */
export function renderConfiguracionTab(modulo, containerId, opciones = {}) {
  const container = document.getElementById(containerId)
  if (!container) return
  const campos = CAMPOS_POR_MODULO[modulo] || []
  const config = getModuloConfig(modulo)
  const incluirApariencia = opciones.incluirApariencia !== false && modulo !== 'apariencia'
  const aparienciaCfg = getApariencia()

  container.innerHTML = `
    <div class="cfg-grid">
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">⚙️ Parámetros de ${_titulo(modulo)}</h3>
          <button class="btn btn-secondary btn-small" id="btnResetConfig-${modulo}">Restaurar valores</button>
        </div>
        <div class="cfg-body">
          ${campos.length ? campos.map(c => _campoHtml(modulo, c, config[c.key])).join('')
                          : '<p style="color:var(--text-secondary);">Este módulo no tiene parámetros propios.</p>'}
          <div class="cfg-acciones">
            <button class="btn btn-primary btn-small" id="btnGuardarConfig-${modulo}">Guardar</button>
            <span id="config-guardado-msg-${modulo}" class="cfg-ok">✓ Guardado</span>
          </div>
        </div>
      </div>

      ${incluirApariencia ? `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">🎨 Apariencia (todo el sistema)</h3>
          <button class="btn btn-secondary btn-small" id="btnResetConfig-apariencia">Restaurar valores</button>
        </div>
        <div class="cfg-body">
          ${CAMPOS_APARIENCIA.map(c => _campoHtml('apariencia', c, aparienciaCfg[c.key])).join('')}
          <div class="cfg-acciones">
            <button class="btn btn-primary btn-small" id="btnGuardarConfig-apariencia">Guardar apariencia</button>
            <span id="config-guardado-msg-apariencia" class="cfg-ok">✓ Aplicado</span>
          </div>
        </div>
      </div>` : ''}
    </div>

    <div class="card" style="margin-top:16px;">
      <div class="card-header"><h3 class="card-title">🧹 Datos y caché</h3></div>
      <div class="cfg-body">
        <div class="cfg-fila">
          <div class="cfg-fila-texto">
            <label>Limpiar caché de reportes</label>
            <div class="cfg-hint">Fuerza a releer todo desde Supabase. Útil si ves cifras desactualizadas.</div>
          </div>
          <div><button class="btn btn-warning btn-small" id="btnLimpiarCache-${modulo}">Limpiar ahora</button></div>
        </div>
        <div class="cfg-fila">
          <div class="cfg-fila-texto">
            <label>Estado del caché</label>
            <div class="cfg-hint" id="cache-stats-${modulo}">—</div>
          </div>
        </div>
      </div>
    </div>`

  _bindConfig(modulo, campos, opciones.onGuardar)
  if (incluirApariencia) _bindConfig('apariencia', CAMPOS_APARIENCIA, () => aplicarApariencia())

  const btnCache = document.getElementById(`btnLimpiarCache-${modulo}`)
  if (btnCache) {
    btnCache.addEventListener('click', async () => {
      const { invalidarTodo } = await import('./data-cache.js')
      invalidarTodo()
      btnCache.textContent = '✓ Caché limpio'
      setTimeout(() => { btnCache.textContent = 'Limpiar ahora' }, 2000)
    })
  }
  import('./data-cache.js').then(({ estadisticasCache }) => {
    const el = document.getElementById(`cache-stats-${modulo}`)
    if (el) {
      const s = estadisticasCache()
      el.textContent = `${s.enMemoria} datasets en memoria · ${s.ratio}% de aciertos (${s.hits} hits / ${s.miss} consultas)`
    }
  }).catch(() => {})
}

function _bindConfig(modulo, campos, onGuardar) {
  campos.filter(c => c.tipo === 'range').forEach(c => {
    const el = document.getElementById(`cfg-${modulo}-${c.key}`)
    const out = document.getElementById(`cfg-${modulo}-${c.key}-out`)
    if (el && out) el.addEventListener('input', () => { out.textContent = el.value + '%' })
  })

  const btn = document.getElementById(`btnGuardarConfig-${modulo}`)
  if (btn) {
    btn.addEventListener('click', () => {
      const data = {}
      campos.forEach(c => {
        if (c.tipo === 'separador') return
        const el = document.getElementById(`cfg-${modulo}-${c.key}`)
        if (!el) return
        if (c.tipo === 'checkbox') data[c.key] = el.checked
        else if (c.tipo === 'number' || c.tipo === 'range') data[c.key] = parseFloat(el.value) || 0
        else if (c.tipo === 'select') data[c.key] = isNaN(parseFloat(el.value)) ? el.value : parseFloat(el.value)
        else data[c.key] = el.value
      })
      guardarModuloConfig(modulo, data)
      aplicarApariencia()
      const msg = document.getElementById(`config-guardado-msg-${modulo}`)
      if (msg) { msg.style.display = 'inline'; setTimeout(() => { msg.style.display = 'none' }, 2500) }
      if (typeof onGuardar === 'function') onGuardar(data)
    })
  }

  const reset = document.getElementById(`btnResetConfig-${modulo}`)
  if (reset) {
    reset.addEventListener('click', () => {
      if (!confirm(`¿Restaurar los valores por defecto de ${_titulo(modulo)}?`)) return
      restaurarDefaults(modulo)
      aplicarApariencia()
      location.reload()
    })
  }
}

function _titulo(m) {
  return ({ apariencia: 'Apariencia', inventario: 'Inventario', compras: 'Compras', ventas: 'Ventas',
            cobranzas: 'Cuentas x Cobrar/Pagar', bancos: 'Bancos', contabilidad: 'Contabilidad',
            dashboard: 'Dashboard', perfil: 'Perfil' })[m] || m
}

// Aplica apariencia lo antes posible en cualquier página que importe este módulo.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', aplicarApariencia)
} else {
  aplicarApariencia()
}
