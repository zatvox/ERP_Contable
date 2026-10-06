// ============================================================================
// inventario/familias.js — Familias (2026-10-05, SQL 66_familias_lotes.sql)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
// Familia = agrupación comercial libre de lotes (ej. "10/1 Spun colores").
// Un "lote" aquí es Producto + N° de Lote (texto) — mismo nivel que la fila
// de Resumen de Stock › Por Ubicación — así abarca todos los ingresos
// (lotes.id) de ese N° de lote. Un lote pertenece a UNA sola familia.
// Solo es una capa de vista: no toca kardex, costeo ni contabilidad.
// En Resumen de Stock › Por Ubicación el checkbox "Agrupar por familia"
// junta los lotes de cada familia en una sola fila (stock-zona.js).
import { getCurrentUser } from '../auth-supabase.js'
import {
  getItems, getLotes, getMarcas, getCategorias, getStockUbicaciones,
  getFamilias, getFamiliaLotes, addFamilia, updateFamilia, deleteFamilia, setLotesFamilia
} from '../supabase-data.js'
import { showToast, hacerTablaOrdenable } from '../helpers.js'

const _fmt = (n, d = 2) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const _clave = (itemId, numeroLote) => `${itemId}|${String(numeroLote || '').trim().toLowerCase()}`
const _esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Estado del modal
window._famActual = null           // { id, nombre, ... } o null si es nueva
let _famModo = 'nuevo'             // 'nuevo' | 'ver' | 'editar'
let _famSel = new Set()            // claves item|lote seleccionadas
let _famDatos = null               // { lotes: Map(clave -> info), famDeClave, familiaMap, categorias }

// Arma el universo de lotes (Producto + N° Lote) con su stock actual desde
// kardex (vista stock_ubicaciones), sumando todas las zonas e ingresos.
async function _cargarDatos() {
  const [stock, lotes, items, marcas, categorias, familias, famLotes] = await Promise.all([
    getStockUbicaciones(), getLotes(), getItems(), getMarcas(), getCategorias(),
    getFamilias(), getFamiliaLotes()
  ])
  const loteMap = {}; (lotes || []).forEach(l => { loteMap[l.id] = l })
  const itemMap = {}; (items || []).forEach(i => { itemMap[i.id] = i })
  const marcaMap = {}; (marcas || []).forEach(m => { marcaMap[m.id] = m })
  const familiaMap = {}; (familias || []).forEach(f => { familiaMap[f.id] = f })
  const famDeClave = {}
  ;(famLotes || []).forEach(fl => { famDeClave[_clave(fl.item_id, fl.numero_lote)] = fl.familia_id })

  const mapa = new Map()
  const asegurar = (itemId, numeroLote, marcaId) => {
    const k = _clave(itemId, numeroLote)
    if (!mapa.has(k)) {
      const it = itemMap[itemId]
      mapa.set(k, {
        clave: k, item_id: itemId, numero_lote: numeroLote,
        sku: it?.sku || '-', producto: it?.nombre || 'Item #' + itemId,
        categoria_id: it?.categoria_id || null,
        marca: marcaMap[marcaId]?.nombre || '-',
        cantidad: 0, unidades: 0, valor: 0, costos: new Set()
      })
    }
    return mapa.get(k)
  }
  for (const s of (stock || [])) {
    const cant = parseFloat(s.cantidad) || 0
    if (cant <= 0) continue
    const l = loteMap[s.lote_id]
    if (!l) continue
    const e = asegurar(l.item_id, l.numero_lote || '-', l.marca_id)
    const cu = parseFloat(l.costo_unitario) || 0
    e.cantidad += cant
    e.unidades += parseFloat(s.cantidad_unidades) || 0
    e.valor += cant * cu
    e.costos.add(cu.toFixed(4))
  }
  // Lotes guardados en una familia que ya no tienen stock: se listan igual
  // (con 0) para que no "desaparezcan" al editar la familia.
  for (const fl of (famLotes || [])) {
    if (!mapa.has(_clave(fl.item_id, fl.numero_lote))) {
      const l = (lotes || []).find(x => x.item_id === fl.item_id && _clave(x.item_id, x.numero_lote) === _clave(fl.item_id, fl.numero_lote))
      asegurar(fl.item_id, fl.numero_lote, l?.marca_id)
    }
  }
  return { lotes: mapa, famDeClave, familiaMap, famLotes: famLotes || [], categorias: categorias || [] }
}

function _totales(claves) {
  const t = { lotes: 0, cantidad: 0, unidades: 0, valor: 0, costos: new Set() }
  for (const k of claves) {
    const e = _famDatos?.lotes.get(k)
    if (!e) continue
    t.lotes++
    t.cantidad += e.cantidad
    t.unidades += e.unidades
    t.valor += e.valor
    e.costos.forEach(c => t.costos.add(c))
  }
  t.costo = t.cantidad > 0 ? t.valor / t.cantidad : 0
  t.pesoUnidad = t.unidades > 0 ? t.cantidad / t.unidades : 0
  return t
}

// ----------------------------------------------------------------------------
// LISTADO
// ----------------------------------------------------------------------------
export async function renderFamilias() {
  const container = document.getElementById('tabla-familias')
  if (!container) return
  try {
    _famDatos = await _cargarDatos()
    const fBus = (document.getElementById('buscarFamilias')?.value || '').trim().toLowerCase()
    let familias = Object.values(_famDatos.familiaMap)
    if (fBus) familias = familias.filter(f => `${f.nombre} ${f.descripcion || ''}`.toLowerCase().includes(fBus))
    familias.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '', 'es', { numeric: true }))

    if (familias.length === 0) {
      container.innerHTML = `<p style="text-align:center; color:var(--text-secondary); padding:20px;">${fBus ? 'Sin familias con ese filtro.' : 'Sin familias todavía — crea una con "+ Nueva Familia".'}</p>`
      return
    }

    let html = `<table><thead><tr>
      <th>Familia</th><th>Descripción</th>
      <th style="text-align:center;">N° Lotes</th>
      <th style="text-align:right;">Cantidad (kg)</th>
      <th style="text-align:right;">Unidades</th>
      <th style="text-align:right;">Peso/Unidad</th>
      <th style="text-align:right;">Costo S/.</th>
      <th>Acciones</th>
    </tr></thead><tbody>`
    for (const f of familias) {
      const claves = _famDatos.famLotes.filter(fl => fl.familia_id === f.id).map(fl => _clave(fl.item_id, fl.numero_lote))
      const t = _totales(claves)
      const prom = t.costos.size > 1
      html += `<tr>
        <td><strong>${_esc(f.nombre)}</strong></td>
        <td>${_esc(f.descripcion || '-')}</td>
        <td style="text-align:center;">${t.lotes}</td>
        <td style="text-align:right; font-weight:bold;">${_fmt(t.cantidad)}</td>
        <td style="text-align:right;">${t.unidades > 0 ? _fmt(t.unidades, 0) : '-'}</td>
        <td style="text-align:right;">${t.unidades > 0 ? _fmt(t.pesoUnidad, 4) : '-'}</td>
        <td style="text-align:right;" class="${prom ? 'costo-promedio' : ''}" title="${prom ? 'Promedio ponderado de ' + t.costos.size + ' costos distintos' : 'Costo único'}">S/. ${_fmt(t.costo)}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-small btn-secondary" title="Ver detalle" onclick="window.abrirFamilia(${f.id}, 'ver')">👁</button>
          <button class="btn btn-small btn-secondary" title="Editar" onclick="window.abrirFamilia(${f.id}, 'editar')">✏️</button>
          <button class="btn btn-small btn-danger" title="Eliminar" onclick="window.eliminarFamilia(${f.id})">✕</button>
        </td>
      </tr>`
    }
    html += '</tbody></table>'
    container.innerHTML = html
    const tabla = container.querySelector('table')
    if (tabla) hacerTablaOrdenable(tabla)
  } catch (e) {
    console.error('renderFamilias:', e)
    container.innerHTML = '<p style="text-align:center; color:var(--color-danger); padding:20px;">No se pudieron cargar las familias. ¿Ya ejecutaste el script <code>66_familias_lotes.sql</code> en Supabase?</p>'
  }
}
window.renderFamilias = renderFamilias

// ----------------------------------------------------------------------------
// MODAL Nueva / Ver / Editar
// ----------------------------------------------------------------------------
window.abrirFamilia = async function (id, modo = 'ver') {
  try {
    _famDatos = await _cargarDatos()
    _famModo = id ? modo : 'nuevo'
    window._famActual = id ? (_famDatos.familiaMap[id] || null) : null
    if (id && !window._famActual) { showToast('Familia no encontrada', 'danger'); return }

    _famSel = new Set(id ? _famDatos.famLotes.filter(fl => fl.familia_id === id).map(fl => _clave(fl.item_id, fl.numero_lote)) : [])

    const lectura = _famModo === 'ver'
    document.getElementById('famTitulo').textContent =
      _famModo === 'nuevo' ? 'Nueva Familia' : (lectura ? 'Familia — ' : 'Editar Familia — ') + (window._famActual?.nombre || '')
    const nom = document.getElementById('famNombre')
    const des = document.getElementById('famDescripcion')
    nom.value = window._famActual?.nombre || ''
    des.value = window._famActual?.descripcion || ''
    nom.disabled = des.disabled = lectura
    document.getElementById('famAvisoLectura').style.display = lectura ? 'block' : 'none'
    document.getElementById('famFiltros').style.display = lectura ? 'none' : 'flex'
    // .btn trae su propio display y pisa el atributo `hidden`: se usa style.display.
    // ✏️ Editar solo existe en modo 👁 Ver; Guardar solo en Nueva/Editar.
    document.getElementById('famBtnEditar').style.display = lectura ? '' : 'none'
    document.getElementById('famBtnGuardar').style.display = lectura ? 'none' : ''

    const selCat = document.getElementById('famCategoria')
    selCat.innerHTML = '<option value="">Todas</option>' + _famDatos.categorias.map(c => `<option value="${c.id}">${_esc(c.nombre)}</option>`).join('')
    document.getElementById('famBuscar').value = ''
    document.getElementById('famMostrar').value = _famModo === 'editar' ? 'disponibles' : 'disponibles'

    window._famPintarLotes()
    window.openModal('modal-familia')
  } catch (e) {
    console.error('abrirFamilia:', e)
    showToast('No se pudo abrir la familia. ¿Ejecutaste 66_familias_lotes.sql?', 'danger')
  }
}

window._famPintarLotes = function () {
  const tabla = document.getElementById('famTablaLotes')
  if (!tabla || !_famDatos) return
  const lectura = _famModo === 'ver'
  const idActual = window._famActual?.id || null
  const fBus = (document.getElementById('famBuscar')?.value || '').trim().toLowerCase()
  const fCat = document.getElementById('famCategoria')?.value || ''
  const mostrar = lectura ? 'seleccionados' : (document.getElementById('famMostrar')?.value || 'disponibles')

  let filas = [..._famDatos.lotes.values()].filter(e => {
    const sel = _famSel.has(e.clave)
    const famOtra = _famDatos.famDeClave[e.clave] && _famDatos.famDeClave[e.clave] !== idActual
    if (mostrar === 'seleccionados' && !sel) return false
    if (mostrar === 'disponibles' && !sel && (famOtra || e.cantidad <= 0)) return false
    if (mostrar === 'todos' && !sel && e.cantidad <= 0) return false
    if (fCat && String(e.categoria_id) !== fCat) return false
    if (fBus && !`${e.sku} ${e.producto} ${e.numero_lote} ${e.marca}`.toLowerCase().includes(fBus)) return false
    return true
  })
  // Seleccionados primero, luego por producto y lote.
  filas.sort((a, b) => (_famSel.has(b.clave) - _famSel.has(a.clave)) ||
    a.producto.localeCompare(b.producto, 'es', { numeric: true }) ||
    String(a.numero_lote).localeCompare(String(b.numero_lote), 'es', { numeric: true }))

  const th = (t, al = 'left') => `<th style="text-align:${al}; padding:8px 10px; font-size:0.78rem; white-space:nowrap; position:sticky; top:0; background:var(--bg-secondary); z-index:1;">${t}</th>`
  let html = `<thead><tr style="background:var(--bg-secondary);">
    ${th(lectura ? '' : `<input type="checkbox" title="Marcar/desmarcar los visibles" style="width:auto;" onchange="window._famMarcarVisibles(this.checked)">`)}
    ${th('SKU')}${th('Producto')}${th('N° Lote')}${th('Marca')}
    ${th('Kg', 'right')}${th('Unid.', 'right')}${th('Peso/Unid.', 'right')}${th('Costo S/.', 'right')}${th('Familia actual')}
  </tr></thead><tbody>`
  if (filas.length === 0) {
    html += `<tr><td colspan="10" style="text-align:center; padding:16px; color:var(--text-secondary);">${lectura ? 'Esta familia no tiene lotes.' : 'Sin lotes con stock para ese filtro.'}</td></tr>`
  }
  for (const e of filas) {
    const sel = _famSel.has(e.clave)
    const famId = _famDatos.famDeClave[e.clave]
    const famOtra = famId && famId !== idActual
    const costo = e.cantidad > 0 ? e.valor / e.cantidad : 0
    const prom = e.costos.size > 1
    const td = (v, al = 'left', extra = '') => `<td style="text-align:${al}; padding:6px 10px; font-size:0.85rem;"${extra}>${v}</td>`
    html += `<tr style="${sel ? 'background:rgba(59,130,246,0.08);' : ''}${famOtra ? 'opacity:0.55;' : ''}">
      ${td(lectura ? '' : `<input type="checkbox" class="fam-chk" data-clave="${_esc(e.clave)}" style="width:auto;" ${sel ? 'checked' : ''} ${famOtra ? 'disabled title="Ya pertenece a otra familia — quítalo de allá primero"' : ''} onchange="window._famToggle(this.dataset.clave, this.checked)">`)}
      ${td(_esc(e.sku))}${td(_esc(e.producto))}${td(`<strong>${_esc(e.numero_lote)}</strong>`)}${td(_esc(e.marca))}
      ${td(_fmt(e.cantidad), 'right')}${td(e.unidades > 0 ? _fmt(e.unidades, 0) : '-', 'right')}
      ${td(e.unidades > 0 ? _fmt(e.cantidad / e.unidades, 4) : '-', 'right')}
      ${td('S/. ' + _fmt(costo), 'right', prom ? ' class="costo-promedio" title="Promedio de varios ingresos"' : '')}
      ${td(famId ? _esc(_famDatos.familiaMap[famId]?.nombre || '') : '<span style="color:var(--text-secondary);">—</span>')}
    </tr>`
  }
  html += '</tbody>'
  tabla.innerHTML = html
  _famPintarResumen()
}

window._famToggle = function (clave, on) {
  if (on) _famSel.add(clave); else _famSel.delete(clave)
  window._famPintarLotes()
}

window._famMarcarVisibles = function (on) {
  document.querySelectorAll('#famTablaLotes .fam-chk:not(:disabled)').forEach(chk => {
    if (on) _famSel.add(chk.dataset.clave); else _famSel.delete(chk.dataset.clave)
  })
  window._famPintarLotes()
}

function _famPintarResumen() {
  const box = document.getElementById('famResumen')
  if (!box) return
  const t = _totales(_famSel)
  const card = (lbl, val, extra = '') => `<div><div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">${lbl}</div><div style="font-weight:700; font-size:1.05rem;"${extra}>${val}</div></div>`
  box.innerHTML =
    card('Lotes', t.lotes) +
    card('Cantidad (kg) / Unidades', `${_fmt(t.cantidad)} kg · ${t.unidades > 0 ? _fmt(t.unidades, 0) : 0} u`) +
    card('Peso por unidad (prom.)', t.unidades > 0 ? _fmt(t.pesoUnidad, 4) : '-') +
    card('Costo S/. (prom. ponderado)', 'S/. ' + _fmt(t.costo), ' style="font-weight:700; font-size:1.05rem; color:var(--color-success);"')
}

window.guardarFamilia = async function () {
  const nombre = document.getElementById('famNombre')?.value.trim()
  const descripcion = document.getElementById('famDescripcion')?.value.trim() || null
  if (!nombre) { showToast('Escribe el nombre de la familia', 'warning'); return }
  if (_famSel.size === 0) { showToast('Selecciona al menos un lote', 'warning'); return }
  const repetida = Object.values(_famDatos?.familiaMap || {}).find(f => f.nombre.trim().toLowerCase() === nombre.toLowerCase() && f.id !== window._famActual?.id)
  if (repetida) { showToast('Ya existe una familia con ese nombre', 'warning'); return }

  try {
    let id = window._famActual?.id
    if (id) {
      const r = await updateFamilia(id, { nombre, descripcion })
      if (!r) throw new Error('No se pudo actualizar la familia')
    } else {
      const user = await getCurrentUser()
      const r = await addFamilia({ nombre, descripcion, created_by: user?.db_id || null })
      if (!r) throw new Error('No se pudo crear la familia')
      id = r.id
    }
    const lotes = [..._famSel].map(k => {
      const e = _famDatos.lotes.get(k)
      return { item_id: e.item_id, numero_lote: e.numero_lote }
    })
    await setLotesFamilia(id, lotes)
    showToast(`Familia "${nombre}" guardada con ${lotes.length} lote(s) ✅`, 'success')
    window.closeModal('modal-familia')
    await renderFamilias()
  } catch (e) {
    console.error('guardarFamilia:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

window.eliminarFamilia = async function (id) {
  const f = _famDatos?.familiaMap[id]
  if (!confirm(`¿Eliminar la familia "${f?.nombre || id}"?\nLos lotes NO se tocan: solo dejan de estar agrupados.`)) return
  const ok = await deleteFamilia(id)
  if (!ok) { showToast('No se pudo eliminar la familia', 'danger'); return }
  showToast('Familia eliminada', 'success')
  await renderFamilias()
}
