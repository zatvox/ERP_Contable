// ============================================================================
// COL-MENU.JS — Menú "⋮" de columnas mostrar/ocultar, reusable por cualquier
// tabla operativa del sistema.
// Ver memoria del proyecto: project_estandar_diseno_tablas.md
//
// Nace generalizando el menú de columnas que ya existía SOLO en Kardex
// (inventario.js). Antes cada tabla habría tenido que reescribir su propio
// _colDefs()/_colsVisibles()/_pintarMenu()/toggle() — ahora se registra una
// vez por tabla y se reusa toda la lógica.
//
// Uso típico en un módulo (compras.js, ventas.js, inventario.js, ...):
//
//   import { registrarColumnas, colMenuHtml, colStyle } from './col-menu.js'
//
//   registrarColumnas('compras', [
//     { key: 'id', label: 'Id' }, { key: 'proveedor', label: 'Proveedor' }, ...
//   ])
//
//   // en el template de la card (una sola vez, no en cada render):
//   colMenuHtml('compras', 'comprasColMenu', 'comprasColMenuDropdown')
//
//   // en cada <th>/<td> que se pueda ocultar:
//   <th data-col-tabla="compras" data-col="proveedor">Proveedor</th>
//   <td data-col-tabla="compras" data-col="proveedor"${colStyle('compras','proveedor')}>...</td>
//
// El atributo `data-col-tabla` evita que dos tablas distintas con una
// columna del mismo nombre (ej. "fecha") se pisen entre sí al ocultar/mostrar.
// ============================================================================

const _colDefsPorTabla = {}
const _aplicadores = {}   // columnasAuto: nombre -> función que re-aplica el <style>

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function _storageKey(nombre) {
  return `colVisibles_${nombre}`
}

/** Registra (o reemplaza) las columnas ocultables de una tabla. Llamar una
 *  vez por módulo, antes de pintar la tabla por primera vez. */
export function registrarColumnas(nombre, colDefs) {
  _colDefsPorTabla[nombre] = colDefs
}

/** {key: true/false} — todas visibles por defecto salvo que el usuario ya
 *  haya ocultado alguna antes (persistido en localStorage, por navegador). */
export function colsVisibles(nombre) {
  const defs = _colDefsPorTabla[nombre] || []
  let guardado = {}
  try { guardado = JSON.parse(localStorage.getItem(_storageKey(nombre)) || '{}') } catch { guardado = {} }
  const cols = {}
  // c.oculta = oculta por defecto (hasta que el usuario la active)
  for (const c of defs) cols[c.key] = (c.key in guardado) ? guardado[c.key] !== false : !c.oculta
  return cols
}

/** Atributo style listo para pegar en el <th>/<td>: '' si visible,
 *  ' style="display:none;"' si el usuario la ocultó. */
export function colStyle(nombre, key) {
  return colsVisibles(nombre)[key] ? '' : ' style="display:none;"'
}

/** HTML del ícono "⋮" + dropdown (vacío, se pinta recién al abrirlo).
 *  Insertar como hijo directo del `.card` que envuelve la tabla — `.card`
 *  ya trae position:relative para que esto quede anclado a su esquina. */
export function colMenuHtml(nombre, menuId, dropdownId) {
  return `
    <div class="col-menu card-corner-menu" id="${menuId}">
      <button type="button" class="card-menu-btn" onclick="window._colMenuToggle('${nombre}', '${menuId}', '${dropdownId}')" title="Elegir qué columnas mostrar">⋮</button>
      <div class="col-menu-dropdown" id="${dropdownId}"></div>
    </div>`
}

function _pintar(nombre, dropdownId) {
  const dd = document.getElementById(dropdownId)
  if (!dd) return
  const defs = _colDefsPorTabla[nombre] || []
  const cols = colsVisibles(nombre)
  dd.innerHTML = defs.map(c => `
    <label><input type="checkbox" ${cols[c.key] ? 'checked' : ''} onchange="window._colMenuSet('${nombre}', '${c.key}', this.checked)"> ${_esc(c.label)}</label>
  `).join('')
}

window._colMenuToggle = function (nombre, menuId, dropdownId) {
  const menu = document.getElementById(menuId)
  if (!menu) return
  const abriendo = !menu.classList.contains('open')
  if (abriendo) _pintar(nombre, dropdownId)
  menu.classList.toggle('open', abriendo)
}

window._colMenuSet = function (nombre, key, visible) {
  const cols = colsVisibles(nombre)
  cols[key] = visible
  try { localStorage.setItem(_storageKey(nombre), JSON.stringify(cols)) } catch (_) {}
  _aplicadores[nombre]?.()
  document.querySelectorAll(`[data-col-tabla="${nombre}"][data-col="${key}"]`).forEach(el => {
    el.style.display = visible ? '' : 'none'
  })
}

// Cierra cualquier menú "⋮" abierto (de cualquier tabla) al hacer clic
// fuera — un solo listener global para toda la página, no uno por tabla.
if (!window._colMenuOutsideListener) {
  window._colMenuOutsideListener = true
  document.addEventListener('click', (ev) => {
    document.querySelectorAll('.col-menu.open').forEach(menu => {
      if (!menu.contains(ev.target)) menu.classList.remove('open')
    })
  })
}


/**
 * Menú "⋮" AUTOMÁTICO para cualquier <table> ya existente (2026-10-10).
 * Toma los títulos del <thead> (sin columnas vacías / Acciones) y oculta por
 * POSICIÓN con un <style> propio, así sobrevive a cada re-render del <tbody>
 * sin tener que marcar cada <td>. El ⋮ va en la esquina del .card.
 *   columnasAuto(tabla, 'cob_cobros', { ocultas: ['Asiento'] })
 */
export function columnasAuto(tabla, nombre, { ocultas = [], card = null } = {}) {
  if (!tabla || tabla.dataset.colAuto) return
  tabla.dataset.colAuto = nombre
  if (!tabla.id) tabla.id = `tbl-${nombre}`
  const tid = tabla.id
  const ths = [...tabla.querySelectorAll('thead tr:first-child > th')]
  const defs = ths.map((th, i) => ({ key: th.textContent.replace(/[⇅▲▼↕]/g, '').trim(), i }))
    .filter(d => d.key && !/^acciones$/i.test(d.key))
  if (!defs.length) return
  registrarColumnas(nombre, defs.map(d => ({ key: d.key, label: d.key, oculta: ocultas.includes(d.key) })))
  let style = document.getElementById(`colauto-${tid}`)
  if (!style) { style = document.createElement('style'); style.id = `colauto-${tid}`; document.head.appendChild(style) }
  _aplicadores[nombre] = () => {
    const vis = colsVisibles(nombre)
    const sel = defs.filter(d => !vis[d.key]).map(d => `#${tid} thead tr > :nth-child(${d.i + 1}), #${tid} tbody tr > :nth-child(${d.i + 1})`)
    style.textContent = sel.length ? `${sel.join(',\n')} { display: none !important; }` : ''
  }
  _aplicadores[nombre]()
  const host = card || tabla.closest('.card')
  if (host && !host.querySelector(`#colmenu-${nombre}`)) {
    host.insertAdjacentHTML('afterbegin', colMenuHtml(nombre, `colmenu-${nombre}`, `colmenu-dd-${nombre}`))
    host.classList.add('con-col-menu')
  }
}
