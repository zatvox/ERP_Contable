// ============================================================================
// estadisticas/cosecha.js — Captura la config (datos + dimensiones + medidas) de cualquier
// reporte de los módulos SIN reescribirlos: abre la página del módulo en un iframe oculto
// (mismo origen, misma sesión), activa Reportes → sub-pestaña y lee window.__zvReportes.
// ============================================================================
const PAGINAS = { compras: 'compras.html', ventas: 'ventas.html', inventario: 'inventario.html', cobranzas: 'cobranzas.html', bancos: 'bancos.html', contabilidad: 'contabilidad.html' }
const TAB_REPORTES = { inventario: 'reportes-gerenciales' }
const _frames = {}      // modulo -> Promise<iframe>
const _configs = {}     // id -> config

function _frame(m) {
  if (_frames[m]) return _frames[m]
  _frames[m] = new Promise((resolve, reject) => {
    const fr = document.createElement('iframe')
    fr.setAttribute('aria-hidden', 'true'); fr.tabIndex = -1
    fr.style.cssText = 'position:fixed;left:-20000px;top:0;width:1400px;height:900px;border:0;opacity:0;pointer-events:none;'
    fr.src = `${PAGINAS[m]}?zv=1`
    fr.onload = () => { fr._tLoad = Date.now(); resolve(fr) }
    fr.onerror = () => reject(new Error('No se pudo abrir ' + PAGINAS[m]))
    document.body.appendChild(fr)
  })
  return _frames[m]
}

export function precargar(m) { if (PAGINAS[m]) _frame(m).catch(() => {}) }

/** Devuelve la config viva del reporte (con .datos) o lanza error si no se pudo capturar. */
export async function cosechar(m, id, { timeout = 45000, onEstado = () => {} } = {}) {
  if (_configs[id]) return _configs[id]
  onEstado('Abriendo el módulo…')
  const fr = await _frame(m)
  const t0 = Date.now()
  let ultimoClic = 0, vistoEn = 0
  while (Date.now() - t0 < timeout) {
    const w = fr.contentWindow, d = fr.contentDocument
    if (w?.__zvConfigs?.[id]) {   // reportes especiales que arman su propia config (p. ej. historial por carpeta)
      onEstado('Calculando todas las carpetas…')
      const cfg = await w.__zvConfigs[id](); _configs[id] = cfg; return cfg
    }
    const reg = w?.__zvReportes?.get(id)
    if (reg?.config && Array.isArray(reg.config.datos)) {
      if (!vistoEn) vistoEn = Date.now()
      // Con datos → listo. Vacío → esperar hasta 7 s por si los datos llegan async (si no, es un reporte sin registros)
      if (reg.config.datos.length || Date.now() - vistoEn > 7000) { _configs[id] = reg.config; return reg.config }
    }
    const tab = d?.querySelector(`.tab-btn[data-tab="${TAB_REPORTES[m] || 'reportes'}"]`)
    const sub = d?.querySelector(`.subtab[data-sub="${id}"]`)
    // esperar a que el módulo termine de cargar sus datos (si no, construye el reporte vacío)
    if (tab && Date.now() - (fr._tLoad || 0) > 4500 && Date.now() - ultimoClic > 2500) {
      ultimoClic = Date.now()
      onEstado('Calculando el reporte…')
      tab.click(); sub?.click()
    }
    await new Promise(r => setTimeout(r, 400))
  }
  const parcial = fr.contentWindow?.__zvReportes?.get(id)?.config
  if (parcial && Array.isArray(parcial.datos)) return parcial   // reporte sin registros
  throw new Error('El reporte tardó demasiado en cargar. Reintenta o ábrelo desde el módulo.')
}

export function olvidar(id) { delete _configs[id] }
