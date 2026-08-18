// ============================================================================
// INVENTARIO.JS - Módulo Inventario (Versión Async/Await)
// ============================================================================

import { getCurrentUser } from './auth-supabase.js'
import { getItems, addItem, updateItem, deleteItem, getItemById,
        getLotes, getLoteById, addLote, updateLote, deleteLote,
        getCategorias, getCategoriaById, addCategoria, updateCategoria, deleteCategoria,
        getPartidaById, getPartidas, addPartida, deletePartida,
        getMarcas, getMarcaById, addMarca, updateMarca, deleteMarca,
        getAlmacenes, getAlmacenById, addAlmacen, updateAlmacen, deleteAlmacen,
        getUbicaciones, getUbicacionesByAlmacen, getUbicacionById, addUbicacion, updateUbicacion, deleteUbicacion,
        getStockUbicaciones, getStockUbicacionesByLote, getStockUbicacionesByUbicacion,
        addStockUbicacion, updateStockUbicacion, deleteStockUbicacion,
        getKardex, getKardexByItem, getKardexById, addKardexMovimiento, deleteKardexMovimiento } from './supabase-data.js'
import { showToast } from './helpers.js'
import { initModuleNavDropdowns, initSubtabs } from './main.js'
import { getModuloConfig, renderConfiguracionTab, aplicarPreferenciasVista } from './config-modulo.js'
import { cacheado } from './data-cache.js'
import { crearReporte, nombreMes } from './reportes.js'
import { convertirVarios } from './buscador-select.js'

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const user = await getCurrentUser()
    const userDisplay = document.getElementById('userDisplay')
    if (userDisplay && user) {
      userDisplay.textContent = user.nombre || user.email
    }

    const loteUsuario = document.getElementById('loteUsuario')
    if (loteUsuario && user) {
      loteUsuario.value = user.email
    }

    aplicarPreferenciasVista('inventario')
    initTabsInventario()
    // Selects con muchos productos/lotes: buscador con filtrado en vivo.
    convertirVarios([
      { id: 'loteProducto',    placeholder: 'Escribe el producto o SKU...', sinResultados: 'Sin productos' },
      { id: 'partProducto',    placeholder: 'Escribe el producto o SKU...', sinResultados: 'Sin productos' },
      { id: 'tdProducto',      placeholder: 'Escribe el producto...',       sinResultados: 'Sin productos en esa zona' },
      { id: 'tdLote',          placeholder: 'Escribe el N° de lote...',     sinResultados: 'Sin lotes disponibles' },
      { id: 'tiZonaOrigen',    placeholder: 'Escribe el almacén o zona...', sinResultados: 'Sin zonas' },
      { id: 'tiZonaDestino',   placeholder: 'Escribe el almacén o zona...', sinResultados: 'Sin zonas' },
      { id: 'ajusteKardexItem', placeholder: 'Escribe el producto o lote...', sinResultados: 'Sin lotes' },
      { id: 'zonaAlmacen',     placeholder: 'Escribe el almacén...',        sinResultados: 'Sin almacenes' }
    ])
    await cargarProductosSelect()
    await cargarCategoriasSelect()
    await cargarMarcasSelect()
    await renderProductos()
  } catch (error) {
    console.error('Error en DOMContentLoaded:', error)
    showToast('Error al cargar el módulo de inventario', 'danger')
  }
})

function initTabsInventario() {
  const btns = document.querySelectorAll('#inventarioTabs .tab-btn')
  const contents = document.querySelectorAll('.tab-content')

  btns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const tab = btn.getAttribute('data-tab')

      btns.forEach(b => b.classList.remove('active'))
      contents.forEach(c => c.classList.remove('active'))

      btn.classList.add('active')
      const tabContent = document.getElementById(`tab-${tab}`)
      if (tabContent) {
        tabContent.classList.add('active')
      }

      if (tab === 'productos')  await renderProductos()
      if (tab === 'lotes')      await renderLotes()
      if (tab === 'resumen')    await renderResumenStock()
      if (tab === 'categorias') await renderCategorias()
      if (tab === 'marcas')     await renderMarcas()
      if (tab === 'partidas')   await renderPartidas()
      if (tab === 'almacenes')  await renderAlmacenes()
      if (tab === 'kardex')     await renderKardex()
      if (tab === 'reportes')   await renderReportePartidas()
      if (tab === 'reportes-gerenciales') {
        const activo = document.querySelector('#inv-subtabs-reportes .subtab.active')?.getAttribute('data-sub') || 'repi-valorizacion'
        await construirReporteInv(activo)
      }
      if (tab === 'configuracion') renderConfiguracionTab('inventario', 'tab-configuracion')
    })
  })

  initSubtabs('#inv-subtabs-reportes', (panel) => construirReporteInv(panel))

  // Convierte la fila de tabs (ahora agrupada en dropdowns dentro del header)
  // en un submenú desplegable estilo Odoo. No reemplaza el listener de arriba,
  // solo agrega abrir/cerrar y resaltar el grupo activo.
  initModuleNavDropdowns('#inventarioTabs')
}

// ============================================================================
// PRODUCTOS
// ============================================================================

// Cache para filtros (se llena una sola vez por carga, sin N+1)
let _prodCache = null
let _kardexItemsByLabel = {} // buscador de Kardex Valorizado: label -> item_id

async function _cargarDatosProductos(forzar = false) {
  if (_prodCache && !forzar) return _prodCache
  // Una sola consulta por tabla, en paralelo (antes: getLotes por cada producto)
  const [productos, lotes, categorias, marcas] = await Promise.all([
    getItems(), getLotes(), getCategorias(), getMarcas()
  ])
  const catMap = {}, marMap = {}, stockMap = {}, valorMap = {}
  ;(categorias || []).forEach(c => { catMap[c.id] = c.nombre })
  ;(marcas || []).forEach(m => { marMap[m.id] = m.nombre })
  ;(lotes || []).forEach(l => {
    // lotes usa item_id/cantidad, NO product_id/stock (esas columnas no existen en la BD)
    stockMap[l.item_id] = (stockMap[l.item_id] || 0) + (parseFloat(l.cantidad) || 0)
    valorMap[l.item_id] = (valorMap[l.item_id] || 0) + (parseFloat(l.cantidad) || 0) * (parseFloat(l.costo_unitario) || 0)
  })
  _prodCache = { productos: productos || [], categorias: categorias || [], catMap, marMap, stockMap, valorMap }
  return _prodCache
}

function _poblarFiltroCategorias(categorias) {
  const sel = document.getElementById('filtroProdCategoria')
  if (!sel || sel.options.length > 1) return
  categorias.forEach(c => {
    const opt = document.createElement('option')
    opt.value = c.id
    opt.textContent = c.nombre
    sel.appendChild(opt)
  })
}

async function renderProductos(forzar = false) {
  try {
    const container = document.getElementById('tabla-productos')
    if (!container) return

    const { productos, categorias, catMap, marMap, stockMap, valorMap } = await _cargarDatosProductos(forzar)
    _poblarFiltroCategorias(categorias)

    // Filtros (por defecto: stock > 0 y estado activo) + búsqueda en vivo
    const fCat    = document.getElementById('filtroProdCategoria')?.value || ''
    const fStock  = document.getElementById('filtroProdStock')?.value ?? 'con'
    const fEstado = document.getElementById('filtroProdEstado')?.value ?? 'activo'
    const fBusqueda = (document.getElementById('buscarProducto')?.value || '').trim().toLowerCase()

    const filtrados = productos.filter(p => {
      const stock = stockMap[p.id] || 0
      if (fCat && String(p.categoria_id) !== fCat) return false
      if (fStock === 'con' && stock <= 0) return false
      if (fStock === 'sin' && stock > 0) return false
      if (fEstado === 'activo' && !p.activo) return false
      if (fEstado === 'inactivo' && p.activo) return false
      if (fBusqueda) {
        const texto = `${p.nombre || ''} ${p.sku || ''}`.toLowerCase()
        if (!texto.includes(fBusqueda)) return false
      }
      return true
    })

    if (filtrados.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin productos que coincidan con los filtros</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Nombre</th>
            <th>Descripción</th>
            <th>Categoría</th>
            <th>Marca</th>
            <th>Stock Total</th>
            <th>Valor Inventario</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    for (const prod of filtrados) {
      const stockTotal = stockMap[prod.id] || 0
      const valorTotal = valorMap[prod.id] || 0
      const estado = prod.activo ? 'Activo' : 'Inactivo'
      const badgeClass = prod.activo ? 'badge-success' : 'badge-secondary'

      html += `
        <tr>
          <td><strong>${prod.sku}</strong></td>
          <td>${prod.nombre}</td>
          <td>${prod.descripcion || '-'}</td>
          <td>${catMap[prod.categoria_id] || '-'}</td>
          <td>${marMap[prod.marca_id] || '-'}</td>
          <td style="text-align: center; font-weight: bold;">${stockTotal.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
          <td>S/. ${valorTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td><span class="badge ${badgeClass}">${estado}</span></td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.editarProducto(${prod.id})">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarProducto(${prod.id})">Eliminar</button>
          </td>
        </tr>
      `
    }

    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderProductos:', error)
    showToast('Error al cargar productos', 'danger')
  }
}

window.aplicarFiltrosProductos = async function () {
  await renderProductos()  // usa cache, solo re-filtra
}

// ID del producto en edición (null = modo crear)
let _prodEditandoId = null

function _leerFormProducto() {
  return {
    nombre: document.getElementById('prodNombre')?.value || '',
    sku: document.getElementById('prodSKU')?.value || '',
    unidad_medida: document.getElementById('prodUnidadMedida')?.value || '',
    descripcion: document.getElementById('prodDescripcion')?.value || '',
    categoria_id: parseInt(document.getElementById('prodCategoria')?.value || 0) || null,
    marca_id: parseInt(document.getElementById('prodMarca')?.value || 0) || null,
    tipo_item: 'mercaderia',
    activo: document.getElementById('prodActivo')?.value === 'true'
  }
}

function _resetModalProducto() {
  _prodEditandoId = null
  const titulo = document.getElementById('modalProductoTitle')
  if (titulo) titulo.textContent = 'Nuevo Producto'
  const form = document.getElementById('formNewProducto')
  if (form) form.reset()
}

window.abrirModalNuevoProducto = function () {
  _resetModalProducto()
  window.openModal('modal-nuevo-producto')
}

window.guardarProducto = async function () {
  try {
    const user = await getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const prod = _leerFormProducto()  // sin 'id': la columna es GENERATED ALWAYS

    if (!prod.nombre || !prod.sku) {
      showToast('Complete campos requeridos', 'warning')
      return
    }

    if (_prodEditandoId) {
      await updateItem(_prodEditandoId, prod)
      showToast('Producto actualizado', 'success')
    } else {
      await addItem(prod)
      showToast('Producto creado exitosamente', 'success')
    }

    window.closeModal('modal-nuevo-producto')
    _resetModalProducto()
    await renderProductos(true)
    await cargarProductosSelect()
  } catch (error) {
    console.error('Error en guardarProducto:', error)
    showToast('Error al guardar producto', 'danger')
  }
}

window.editarProducto = async function (prodId) {
  try {
    const prod = await getItemById(prodId)
    if (!prod) return

    // Columnas reales: nombre, sku, descripcion, unidad_medida, categoria_id, marca_id, activo
    document.getElementById('prodNombre').value = prod.nombre || ''
    document.getElementById('prodSKU').value = prod.sku || ''
    document.getElementById('prodUnidadMedida').value = prod.unidad_medida || ''
    document.getElementById('prodDescripcion').value = prod.descripcion || ''
    document.getElementById('prodCategoria').value = prod.categoria_id || ''
    document.getElementById('prodMarca').value = prod.marca_id || ''
    document.getElementById('prodActivo').value = prod.activo ? 'true' : 'false'

    _prodEditandoId = prodId
    const titulo = document.getElementById('modalProductoTitle')
    if (titulo) titulo.textContent = `Editar Producto #${prodId}`
    window.openModal('modal-nuevo-producto')
  } catch (error) {
    console.error('Error en editarProducto:', error)
    showToast('Error al editar producto', 'danger')
  }
}

window.eliminarProducto = async function (prodId) {
  try {
    if (!confirm('¿Estás seguro de que deseas eliminar este producto?')) return

    await deleteItem(prodId)
    showToast('Producto eliminado', 'success')
    await renderProductos(true)
    await renderLotes(true)
    await cargarProductosSelect()
  } catch (error) {
    console.error('Error en eliminarProducto:', error)
    showToast('Error al eliminar producto', 'danger')
  }
}

// ============================================================================
// LOTES
// ============================================================================

let _loteLista = null // caché: se trae una vez y la búsqueda filtra en memoria

async function renderLotes(forzar = false) {
  try {
    const container = document.getElementById('tabla-lotes')
    if (!container) return

    if (!_loteLista || forzar) {
      _loteLista = await getLotes()
    }

    if (!_loteLista || _loteLista.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin lotes</p>'
      return
    }

    // Mapa de productos para no golpear la BD por cada lote (N+1)
    const productos = await getItems()
    const prodMap = {}
    productos.forEach(p => { prodMap[p.id] = p })

    // Búsqueda en vivo (contiene, sobre la lista ya cacheada) por N° de
    // lote, código de partida o nombre del producto — igual que en
    // Productos/Proveedores.
    const busqueda = (document.getElementById('buscarLote')?.value || '').trim().toLowerCase()
    const lotes = busqueda
      ? _loteLista.filter(l => {
          const nombreProd = prodMap[l.item_id]?.nombre || ''
          return `${l.numero_lote || ''} ${l.codigo_partida || ''} ${nombreProd}`.toLowerCase().includes(busqueda)
        })
      : _loteLista

    if (lotes.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin resultados para la búsqueda</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>Lote</th>
            <th>Partida</th>
            <th>Producto</th>
            <th>Stock</th>
            <th>Unidad</th>
            <th>N° Unidades</th>
            <th>Peso/Unidad</th>
            <th>Costo Unit.</th>
            <th>Costo Total Lote</th>
            <th>Vencimiento</th>
            <th>Días Restantes</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    const hoy = new Date()

    for (const lote of lotes) {
      const prod = prodMap[lote.item_id]
      const cantidad = parseFloat(lote.cantidad) || 0
      const costoUnit = parseFloat(lote.costo_unitario) || 0
      const costoTotalLote = cantidad * costoUnit

      let vencCell = '<span style="color:var(--text-secondary);">Sin vencimiento</span>'
      let diasCell = '-'
      if (lote.fecha_vencimiento) {
        const vencimiento = new Date(lote.fecha_vencimiento)
        const diasRestantes = Math.ceil((vencimiento - hoy) / (1000 * 60 * 60 * 24))
        let colorDias = 'color: var(--color-success);'
        if (diasRestantes < 0) colorDias = 'color: var(--color-danger); font-weight: bold;'
        else if (diasRestantes < 30) colorDias = 'color: var(--color-warning); font-weight: bold;'
        vencCell = window.formatDate(lote.fecha_vencimiento)
        diasCell = `<span style="${colorDias}">${diasRestantes} días</span>`
      }

      const pesoPorUnidad = lote.peso_por_unidad != null ? parseFloat(lote.peso_por_unidad) : null

      html += `
        <tr>
          <td><strong>${lote.numero_lote || '-'}</strong></td>
          <td>${lote.codigo_partida || '-'}</td>
          <td>${prod?.nombre || '-'}</td>
          <td style="text-align: center; font-weight: bold;">${cantidad.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td style="text-align: center;">${lote.unidad_medida || '-'}</td>
          <td style="text-align: center;">${lote.cantidad_unidades != null ? parseFloat(lote.cantidad_unidades).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '-'}</td>
          <td style="text-align: center;">${pesoPorUnidad != null ? pesoPorUnidad.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '-'}</td>
          <td>S/. ${costoUnit.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>S/. ${costoTotalLote.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>${vencCell}</td>
          <td>${diasCell}</td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.editarLote(${lote.id})">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarLote(${lote.id})">Eliminar</button>
          </td>
        </tr>
      `
    }

    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderLotes:', error)
    showToast('Error al cargar lotes', 'danger')
  }
}

window.filtrarLotes = async function () {
  await renderLotes()
}

window.guardarLote = async function () {
  try {
    const user = await getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const productId = parseInt(document.getElementById('loteProducto')?.value || 0)
    const partidaId = parseInt(document.getElementById('lotePartida')?.value || 0) || null
    const numeroLote = document.getElementById('loteNumero')?.value?.trim() || ''
    const cantidad = parseFloat(document.getElementById('loteStock')?.value || 0)
    const unidadMedida = document.getElementById('loteUnidadMedida')?.value || 'KG'
    // cantidad_unidades = N° de bultos/cajas (dimensión distinta de cantidad,
    // que es el peso/medida total). Opcional: si no se indica, queda null
    // (nunca igual a "cantidad" — eran dos cosas distintas y antes se
    // confundían).
    const cantUnidades = parseInt(document.getElementById('loteUnidades')?.value || 0) || null
    const costoUnitario = parseFloat(document.getElementById('loteCosto')?.value || 0)
    const fechaVencimiento = document.getElementById('loteVencimiento')?.value || null

    if (!productId || !numeroLote || !cantidad || !costoUnitario) {
      showToast('Complete todos los campos requeridos (Producto, N° Lote, Stock, Costo)', 'warning')
      return
    }

    // Peso por unidad = cantidad total / N° de unidades (ej: 500kg en 25
    // bultos = 20kg por bulto). Solo se puede calcular si se indicó cuántas
    // unidades hay.
    const pesoPorUnidad = cantUnidades && cantUnidades > 0
      ? parseFloat((cantidad / cantUnidades).toFixed(4))
      : null

    // Columnas reales de lotes: item_id, cantidad (no product_id/stock/costo_destino)
    const lote = {
      item_id: productId,
      partida_id: partidaId,
      numero_lote: numeroLote,
      cantidad: cantidad,
      unidad_medida: unidadMedida,
      cantidad_unidades: cantUnidades,
      peso_por_unidad: pesoPorUnidad,
      costo_unitario: costoUnitario,
      fecha_vencimiento: fechaVencimiento,
      fecha_ingreso: new Date().toISOString().split('T')[0],
      created_by: user.db_id
    }

    await addLote(lote)
    showToast('Lote creado exitosamente', 'success')
    window.closeModal('modal-nuevo-lote')
    await renderLotes(true)
    const form = document.getElementById('formNewLote')
    if (form) form.reset()
  } catch (error) {
    console.error('Error en guardarLote:', error)
    showToast('Error al crear lote', 'danger')
  }
}

window.editarLote = async function (loteId) {
  try {
    const lote = await getLoteById(loteId)
    if (!lote) return

    document.getElementById('editLoteNumero').value = lote.numero_lote
    document.getElementById('editLoteStock').value = lote.cantidad
    document.getElementById('editLoteUnidadMedida').value = lote.unidad_medida || 'KG'
    document.getElementById('editLoteUnidades').value = lote.cantidad_unidades || ''
    document.getElementById('editLoteCosto').value = lote.costo_unitario
    if (document.getElementById('editLoteDestino')) document.getElementById('editLoteDestino').value = 0
    document.getElementById('editLoteVencimiento').value = lote.fecha_vencimiento || ''

    window.editingLoteId = loteId
    window.openModal('modal-editar-lote')
  } catch (error) {
    console.error('Error en editarLote:', error)
    showToast('Error al editar lote', 'danger')
  }
}

window.actualizarLote = async function () {
  try {
    if (!window.editingLoteId) {
      showToast('Error: No se identificó el lote', 'danger')
      return
    }

    const loteId = window.editingLoteId
    const cantidad = parseFloat(document.getElementById('editLoteStock').value)
    const unidadMedida = document.getElementById('editLoteUnidadMedida')?.value || 'KG'
    const cantUnidades = parseInt(document.getElementById('editLoteUnidades')?.value || 0) || null
    // Recalcular peso por unidad si cambió el stock o el N° de unidades.
    const pesoPorUnidad = cantUnidades && cantUnidades > 0
      ? parseFloat((cantidad / cantUnidades).toFixed(4))
      : null

    const lote = {
      cantidad,
      unidad_medida: unidadMedida,
      cantidad_unidades: cantUnidades,
      peso_por_unidad: pesoPorUnidad,
      costo_unitario: parseFloat(document.getElementById('editLoteCosto').value),
      fecha_vencimiento: document.getElementById('editLoteVencimiento').value || null
    }

    await updateLote(loteId, lote)
    showToast('Lote actualizado', 'success')
    window.closeModal('modal-editar-lote')
    await renderLotes(true)
    window.editingLoteId = null
  } catch (error) {
    console.error('Error en actualizarLote:', error)
    showToast('Error al actualizar lote', 'danger')
  }
}

window.eliminarLote = async function (loteId) {
  try {
    const lote = await getLoteById(loteId)
    if (!lote) return

    if (!confirm(`¿Eliminar lote "${lote.numero_lote}"?`)) return

    const ok = await deleteLote(loteId)
    if (!ok) {
      showToast('No se pudo eliminar el lote (puede tener ventas asociadas)', 'danger')
      return
    }
    showToast('Lote eliminado', 'success')
    await renderLotes(true)
  } catch (error) {
    console.error('Error en eliminarLote:', error)
    showToast('Error al eliminar lote', 'danger')
  }
}

// ============================================================================
// RESUMEN DE STOCK
// ============================================================================

function _poblarFiltroCategoriasResumen(categorias) {
  const sel = document.getElementById('filtroResumenCategoria')
  if (!sel || sel.options.length > 1) return
  categorias.forEach(c => {
    const opt = document.createElement('option')
    opt.value = c.id
    opt.textContent = c.nombre
    sel.appendChild(opt)
  })
}

async function renderResumenStock() {
  try {
    const [productos, lotes, categorias] = await Promise.all([getItems(), getLotes(), getCategorias()])
    const container = document.getElementById('tabla-resumen')

    if (!container) return

    _poblarFiltroCategoriasResumen(categorias || [])

    // Filtros (mismo patrón que tab Productos): categoría, stock y búsqueda
    // en vivo por nombre/SKU. Por defecto solo se muestra lo que tiene
    // stock, igual que en Productos.
    const fCat = document.getElementById('filtroResumenCategoria')?.value || ''
    const fStock = document.getElementById('filtroResumenStock')?.value ?? 'con'
    const fBusqueda = (document.getElementById('buscarResumenStock')?.value || '').trim().toLowerCase()

    const stockPorProducto = {}
    ;(lotes || []).forEach(l => {
      stockPorProducto[l.item_id] = (stockPorProducto[l.item_id] || 0) + (parseFloat(l.cantidad) || 0)
    })

    const productosFiltrados = (productos || []).filter(p => {
      const stock = stockPorProducto[p.id] || 0
      if (fCat && String(p.categoria_id) !== fCat) return false
      if (fStock === 'con' && stock <= 0) return false
      if (fStock === 'sin' && stock > 0) return false
      if (fBusqueda) {
        const texto = `${p.nombre || ''} ${p.sku || ''}`.toLowerCase()
        if (!texto.includes(fBusqueda)) return false
      }
      return true
    })

    const umbralCritico = getModuloConfig('inventario').stockCritico

    if (productosFiltrados.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin productos que coincidan con los filtros</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Producto</th>
            <th>Stock Total</th>
            <th>Total Unidades</th>
            <th>Cantidad Lotes</th>
            <th>Costo Promedio Unit.</th>
            <th>Valor Total Inventario</th>
            <th>Stock Crítico (&lt;${umbralCritico})</th>
          </tr>
        </thead>
        <tbody>
    `

    let totalInventario = 0
    let totalStockGeneral = 0
    let totalUnidadesGeneral = 0

    for (const prod of productosFiltrados) {
      const lotesProducto = (lotes || []).filter(l => l.item_id === prod.id)
      const stockTotal = lotesProducto.reduce((sum, l) => sum + (parseFloat(l.cantidad) || 0), 0)
      const totalUnidades = lotesProducto.reduce((sum, l) => sum + (parseFloat(l.cantidad_unidades) || 0), 0)
      const cantidadLotes = lotesProducto.length
      const valorTotal = lotesProducto.reduce((sum, l) => sum + ((parseFloat(l.cantidad) || 0) * (parseFloat(l.costo_unitario) || 0)), 0)
      const costoPromedio = stockTotal > 0 ? valorTotal / stockTotal : 0
      const critico = stockTotal < umbralCritico

      totalInventario += valorTotal
      totalStockGeneral += stockTotal
      totalUnidadesGeneral += totalUnidades

      const colorCritico = critico ? 'background-color: #ea6868; color: #991b1b;' : ''

      html += `
        <tr style="${colorCritico}">
          <td><strong>${prod.sku}</strong></td>
          <td>${prod.nombre}</td>
          <td style="text-align: center; font-weight: bold;">${stockTotal.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
          <td style="text-align: center;">${totalUnidades.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
          <td style="text-align: center;">${cantidadLotes.toLocaleString('en-US')}</td>
          <td>S/. ${costoPromedio.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>S/. ${valorTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td style="text-align: center;">${critico ? '⚠️ SÍ' : 'NO'}</td>
        </tr>
      `
    }

    html += `
        </tbody>
        <tfoot>
          <tr style="border-top: 2px solid var(--border-color); font-weight: bold;">
            <td colspan="2">TOTAL INVENTARIO</td>
            <td style="text-align: center;">${totalStockGeneral.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
            <td style="text-align: center;">${totalUnidadesGeneral.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
            <td></td>
            <td>S/. ${totalInventario.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    `

    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderResumenStock:', error)
    showToast('Error al cargar resumen', 'danger')
  }
}

window.aplicarFiltrosResumenStock = async function () {
  await renderResumenStock()
}

// ============================================================================
// REPORTES — Stock por Partida (bloque de reportes del módulo)
// ============================================================================
// Agrupa los lotes por (producto, código de partida): la partida es la
// etiqueta libre que agrupa varios lotes recibidos juntos en una misma guía
// (ver 23_codigo_partida_lotes.sql) — este reporte responde "¿cuánto stock
// total queda de la partida X?" sin tener que sumar lote por lote a mano.

function _poblarFiltroCategoriaReportePartidas(categorias) {
  const sel = document.getElementById('filtroReportePartidaCategoria')
  if (!sel || sel.options.length > 1) return
  categorias.forEach(c => {
    const opt = document.createElement('option')
    opt.value = c.id
    opt.textContent = c.nombre
    sel.appendChild(opt)
  })
}

async function renderReportePartidas() {
  try {
    const container = document.getElementById('tabla-reporte-partidas')
    if (!container) return

    const [lotes, items, categorias, zonas, almacenes] = await Promise.all([
      getLotes(), getItems(), getCategorias(), getUbicaciones(), getAlmacenes()
    ])

    _poblarFiltroCategoriaReportePartidas(categorias || [])

    const itemMap = {}
    ;(items || []).forEach(i => { itemMap[i.id] = i })
    const almacenMap = {}
    ;(almacenes || []).forEach(a => { almacenMap[a.id] = a })
    const zonaMap = {}
    ;(zonas || []).forEach(z => { zonaMap[z.id] = z })
    const nombreZona = (ubicacionId) => {
      const z = zonaMap[ubicacionId]
      if (!z) return null
      return `${almacenMap[z.almacen_id]?.nombre || '?'} — ${z.nombre}`
    }

    const soloConPartida = (document.getElementById('filtroReporteSoloConPartida')?.value ?? '1') === '1'
    const fCat = document.getElementById('filtroReportePartidaCategoria')?.value || ''
    const fBusqueda = (document.getElementById('buscarReportePartida')?.value || '').trim().toLowerCase()

    // Agrupar por producto + código de partida.
    const grupos = new Map()
    for (const l of (lotes || [])) {
      const partida = (l.codigo_partida || '').trim()
      if (soloConPartida && !partida) continue

      const item = itemMap[l.item_id]
      if (fCat && String(item?.categoria_id) !== fCat) continue

      const clave = `${l.item_id}||${partida}`
      const acc = grupos.get(clave) || { item_id: l.item_id, partida, lotes: 0, cantidad: 0, valor: 0, zonas: new Set() }
      acc.lotes += 1
      acc.cantidad += parseFloat(l.cantidad) || 0
      acc.valor += (parseFloat(l.cantidad) || 0) * (parseFloat(l.costo_unitario) || 0)
      const zn = nombreZona(l.ubicacion_id)
      if (zn) acc.zonas.add(zn)
      grupos.set(clave, acc)
    }

    let filas = [...grupos.values()]

    if (fBusqueda) {
      filas = filas.filter(g => {
        const nombreProd = itemMap[g.item_id]?.nombre || ''
        const sku = itemMap[g.item_id]?.sku || ''
        return `${g.partida} ${nombreProd} ${sku}`.toLowerCase().includes(fBusqueda)
      })
    }

    filas.sort((a, b) =>
      (itemMap[a.item_id]?.nombre || '').localeCompare(itemMap[b.item_id]?.nombre || '') ||
      a.partida.localeCompare(b.partida)
    )

    if (filas.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin datos para los filtros seleccionados</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>Partida</th>
            <th>SKU</th>
            <th>Producto</th>
            <th style="text-align:center;">N° Lotes</th>
            <th style="text-align:right;">Cantidad Total</th>
            <th style="text-align:right;">Costo Promedio</th>
            <th style="text-align:right;">Valor Total</th>
            <th>Zona(s)</th>
          </tr>
        </thead>
        <tbody>
    `

    let valorGranTotal = 0
    for (const g of filas) {
      const item = itemMap[g.item_id]
      const costoProm = g.cantidad > 0 ? g.valor / g.cantidad : 0
      valorGranTotal += g.valor

      html += `
        <tr>
          <td><strong>${g.partida || '-'}</strong></td>
          <td>${item?.sku || '-'}</td>
          <td>${item?.nombre || `Item #${g.item_id}`}</td>
          <td style="text-align:center;">${g.lotes}</td>
          <td style="text-align:right; font-weight:bold;">${g.cantidad.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td style="text-align:right;">S/. ${costoProm.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td style="text-align:right;">S/. ${g.valor.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td style="font-size:0.82rem;">${[...g.zonas].join(', ') || '-'}</td>
        </tr>
      `
    }

    html += `
        </tbody>
        <tfoot>
          <tr style="border-top: 2px solid var(--border-color); font-weight: bold;">
            <td colspan="6">TOTAL</td>
            <td colspan="2" style="text-align: right;">S/. ${valorGranTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          </tr>
        </tfoot>
      </table>
    `

    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderReportePartidas:', error)
    showToast('Error al cargar el reporte de partidas', 'danger')
  }
}

window.aplicarFiltrosReportePartidas = async function () {
  await renderReportePartidas()
}

// ============================================================================
// CARGAR SELECTS
// ============================================================================

async function cargarProductosSelect() {
  try {
    const productos = await getItems()
    const select = document.getElementById('loteProducto')

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona --</option>'
    productos.forEach(p => {
      select.innerHTML += `<option value="${p.id}">${p.nombre} (${p.sku})</option>`
    })

    // onchange en vez de addEventListener acumulado: cargarProductosSelect
    // se llama más de una vez (init + abrirModalLote), addEventListener
    // duplicaría el listener en cada llamada.
    select.onchange = cargarPartidasSelect
  } catch (error) {
    console.error('Error en cargarProductosSelect:', error)
  }
}

async function cargarCategoriasSelect() {
  try {
    const categorias = await getCategorias()
    const select = document.getElementById('prodCategoria')

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona --</option>'
    categorias.forEach(c => {
      select.innerHTML += `<option value="${c.id}">${c.nombre}</option>`
    })
  } catch (error) {
    console.error('Error en cargarCategoriasSelect:', error)
  }
}

async function cargarMarcasSelect() {
  try {
    const marcas = await getMarcas()
    const select = document.getElementById('prodMarca')

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona --</option>'
    marcas.forEach(m => {
      select.innerHTML += `<option value="${m.id}">${m.nombre}</option>`
    })
  } catch (error) {
    console.error('Error en cargarMarcasSelect:', error)
  }
}

async function cargarPartidasSelect() {
  try {
    const productId = parseInt(document.getElementById('loteProducto')?.value || 0)
    if (!productId) {
      const select = document.getElementById('lotePartida')
      if (select) select.innerHTML = '<option value="">-- Selecciona --</option>'
      return
    }

    const partidas = await getPartidas()
    const partidasProducto = partidas.filter(p => p.product_id === productId)
    const select = document.getElementById('lotePartida')

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona --</option>'
    partidasProducto.forEach(p => {
      select.innerHTML += `<option value="${p.id}">${p.numero_partida}</option>`
    })
  } catch (error) {
    console.error('Error en cargarPartidasSelect:', error)
  }
}

window.abrirModalLote = function() {
  cargarProductosSelect()
  window.openModal('modal-nuevo-lote')
}

// ============================================================================
// CATEGORÍAS
// ============================================================================

async function renderCategorias() {
  try {
    const categorias = await getCategorias()
    const container = document.getElementById('tabla-categorias')

    if (!container) return

    if (!categorias || categorias.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin categorías</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Descripción</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    categorias.forEach(cat => {
      const estado = cat.activo ? 'Activo' : 'Inactivo'
      const badgeClass = cat.activo ? 'badge-success' : 'badge-secondary'

      html += `
        <tr>
          <td><strong>${cat.nombre}</strong></td>
          <td>${cat.descripcion || '-'}</td>
          <td><span class="badge ${badgeClass}">${estado}</span></td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.editarCategoria(${cat.id})">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarCategoria(${cat.id})">Eliminar</button>
          </td>
        </tr>
      `
    })

    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderCategorias:', error)
    showToast('Error al cargar categorías', 'danger')
  }
}

window.guardarCategoria = async function () {
  try {
    const user = await getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const cat = {
      nombre: document.getElementById('catNombre')?.value || '',
      descripcion: document.getElementById('catDescripcion')?.value || '',
      activo: document.getElementById('catActivo')?.value === 'true'
    }

    if (!cat.nombre) {
      showToast('Complete los campos requeridos', 'warning')
      return
    }

    if (window.editingCategoriaId) {
      await updateCategoria(window.editingCategoriaId, cat)
      showToast('Categoría actualizada exitosamente', 'success')
      window.editingCategoriaId = null
    } else {
      await addCategoria(cat)
      showToast('Categoría creada exitosamente', 'success')
    }

    window.closeModal('modal-nueva-categoria')
    await renderCategorias()
    await cargarCategoriasSelect()
    const form = document.getElementById('formNewCategoria')
    if (form) form.reset()
  } catch (error) {
    console.error('Error en guardarCategoria:', error)
    showToast('Error al guardar categoría', 'danger')
  }
}

window.editarCategoria = async function (catId) {
  try {
    const cat = await getCategoriaById(catId)
    if (!cat) return

    document.getElementById('catNombre').value = cat.nombre
    document.getElementById('catDescripcion').value = cat.descripcion || ''
    document.getElementById('catActivo').value = cat.activo ? 'true' : 'false'

    window.editingCategoriaId = catId
    window.openModal('modal-nueva-categoria')
  } catch (error) {
    console.error('Error en editarCategoria:', error)
    showToast('Error al editar categoría', 'danger')
  }
}

window.eliminarCategoria = async function (catId) {
  try {
    const cat = await getCategoriaById(catId)
    if (!cat) return

    if (!confirm(`¿Eliminar categoría "${cat.nombre}"?`)) return

    await deleteCategoria(catId)
    showToast('Categoría eliminada', 'success')
    await renderCategorias()
    await cargarCategoriasSelect()
  } catch (error) {
    console.error('Error en eliminarCategoria:', error)
    showToast('Error al eliminar categoría', 'danger')
  }
}

// ============================================================================
// MARCAS
// ============================================================================

async function renderMarcas() {
  try {
    const marcas = await getMarcas()
    const container = document.getElementById('tabla-marcas')

    if (!container) return

    if (!marcas || marcas.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin marcas</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Descripción</th>
            <th>País de Origen</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    marcas.forEach(mar => {
      const estado = mar.activo ? 'Activo' : 'Inactivo'
      const badgeClass = mar.activo ? 'badge-success' : 'badge-secondary'

      html += `
        <tr>
          <td><strong>${mar.nombre}</strong></td>
          <td>${mar.descripcion || '-'}</td>
          <td>${mar.pais_origen || '-'}</td>
          <td><span class="badge ${badgeClass}">${estado}</span></td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.editarMarca(${mar.id})">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarMarca(${mar.id})">Eliminar</button>
          </td>
        </tr>
      `
    })

    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderMarcas:', error)
    showToast('Error al cargar marcas', 'danger')
  }
}

window.guardarMarca = async function () {
  try {
    const user = await getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const mar = {
      nombre: document.getElementById('marNombre')?.value || '',
      descripcion: document.getElementById('marDescripcion')?.value || '',
      pais_origen: document.getElementById('marPais')?.value || '',
      activo: document.getElementById('marActivo')?.value === 'true'
    }

    if (!mar.nombre) {
      showToast('Complete los campos requeridos', 'warning')
      return
    }

    if (window.editingMarcaId) {
      await updateMarca(window.editingMarcaId, mar)
      showToast('Marca actualizada exitosamente', 'success')
      window.editingMarcaId = null
    } else {
      await addMarca(mar)
      showToast('Marca creada exitosamente', 'success')
    }

    window.closeModal('modal-nueva-marca')
    await renderMarcas()
    await cargarMarcasSelect()
    const form = document.getElementById('formNewMarca')
    if (form) form.reset()
  } catch (error) {
    console.error('Error en guardarMarca:', error)
    showToast('Error al guardar marca', 'danger')
  }
}

window.editarMarca = async function (marId) {
  try {
    const mar = await getMarcaById(marId)
    if (!mar) return

    document.getElementById('marNombre').value = mar.nombre
    document.getElementById('marDescripcion').value = mar.descripcion || ''
    document.getElementById('marPais').value = mar.pais_origen || ''
    document.getElementById('marActivo').value = mar.activo ? 'true' : 'false'

    window.editingMarcaId = marId
    window.openModal('modal-nueva-marca')
  } catch (error) {
    console.error('Error en editarMarca:', error)
    showToast('Error al editar marca', 'danger')
  }
}

window.eliminarMarca = async function (marId) {
  try {
    const mar = await getMarcaById(marId)
    if (!mar) return

    if (!confirm(`¿Eliminar marca "${mar.nombre}"?`)) return

    await deleteMarca(marId)
    showToast('Marca eliminada', 'success')
    await renderMarcas()
    await cargarMarcasSelect()
  } catch (error) {
    console.error('Error en eliminarMarca:', error)
    showToast('Error al eliminar marca', 'danger')
  }
}

// ============================================================================
// KARDEX VALORIZADO (Método Promedio Ponderado)
// ============================================================================

async function renderKardex() {
  try {
    const items     = await getItems()
    const container = document.getElementById('content-kardex')
    if (!container) return

    // Buscador con filtro en vivo (datalist nativo del navegador: filtra a
    // cada letra sin JS extra) en vez de un <select> plano donde había que
    // scrollear toda la lista de productos.
    const itemsOrdenados = items
      .slice()
      .sort((a, b) => (a.nombre || a.name || '').localeCompare(b.nombre || b.name || ''))
    _kardexItemsByLabel = {}
    const datalistHtml = itemsOrdenados.map(i => {
      const label = `${i.nombre || i.name} (${i.codigo || i.sku || 'sin código'})`
      _kardexItemsByLabel[label] = i.id
      return `<option value="${label}">`
    }).join('')

    container.innerHTML = `
      <div class="card-header">
        <h3 class="card-title">Kardex Valorizado — Promedio Ponderado</h3>
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <input type="text" id="kardexItemSelect" list="kardexItemsList" placeholder="Escribe para buscar producto..." style="min-width:280px;" autocomplete="off">
          <datalist id="kardexItemsList">${datalistHtml}</datalist>
          <input type="month" id="kardexFiltroMes" title="Filtrar por mes">
          <button class="btn btn-primary btn-small" onclick="window.cargarKardex()">Ver Kardex</button>
          <button class="btn btn-secondary btn-small" onclick="window.abrirModalAjusteKardex()">+ Ajuste Inventario</button>
        </div>
      </div>
      <div id="kardex-body" style="padding:10px;">
        <p style="text-align:center; color:var(--text-secondary);">Escribe o selecciona un producto para ver su kardex.</p>
      </div>
    `
  } catch (e) {
    console.error('renderKardex:', e)
    showToast('Error al cargar kardex', 'danger')
  }
}

window.cargarKardex = async function() {
  const textoBuscado = document.getElementById('kardexItemSelect')?.value?.trim() || ''
  const itemId  = _kardexItemsByLabel[textoBuscado] || 0
  const filtroMes = document.getElementById('kardexFiltroMes')?.value
  const body    = document.getElementById('kardex-body')

  if (!itemId) { showToast('Escribe y selecciona un producto de la lista', 'warning'); return }
  if (body) body.innerHTML = '<p style="padding:20px;">Cargando...</p>'

  try {
    const [items, zonas, almacenes, lotes] = await Promise.all([getItems(), getUbicaciones(), getAlmacenes(), getLotes()])
    const item  = items.find(i => i.id === itemId)
    let movs    = await getKardexByItem(itemId)

    if (filtroMes) {
      movs = movs.filter(m => (m.fecha || '').startsWith(filtroMes))
    }

    movs = movs.sort((a, b) => new Date(a.fecha) - new Date(b.fecha) || a.id - b.id)

    // "Desde" / "A": Almacén/Zona real, o Partners/Vendors — Partners/Customers
    // para el lado externo (proveedor/cliente), estilo Odoo.
    const almacenMap = {}
    for (const a of (almacenes || [])) almacenMap[a.id] = a
    const zonaNombre = (ubicacionId) => {
      if (!ubicacionId) return '-'
      const z = (zonas || []).find(x => x.id === ubicacionId)
      if (!z) return `Zona #${ubicacionId}`
      return `${almacenMap[z.almacen_id]?.nombre || '?'}/${z.nombre}`
    }

    // El kardex guarda lote_id, no el número. Con el costeo por
    // identificación específica el lote es la información más importante de
    // cada fila: es lo que explica por qué dos salidas del mismo producto
    // tienen costos unitarios distintos.
    const loteMap = {}
    for (const l of (lotes || [])) loteMap[l.id] = l
    const loteEtiqueta = (loteId) => {
      if (!loteId) return '<span style="color:var(--text-secondary);">—</span>'
      const l = loteMap[loteId]
      // Un lote borrado (guía eliminada) deja el movimiento huérfano: se
      // muestra el id para poder rastrearlo en vez de un guión mudo.
      if (!l) return `<span style="color:var(--color-warning);" title="El lote ya no existe">#${loteId}</span>`
      return `<span title="Lote ${l.numero_lote} · costo unit. ${(parseFloat(l.costo_unitario) || 0).toFixed(4)}">${_escInv(l.numero_lote || ('#' + loteId))}</span>`
    }

    const totalEntradas = movs.filter(m => m.cantidad_entrada > 0).reduce((s, m) => s + parseFloat(m.cantidad_entrada || 0), 0)
    const totalSalidas  = movs.filter(m => m.cantidad_salida  > 0).reduce((s, m) => s + parseFloat(m.cantidad_salida  || 0), 0)

    // items NO tiene columnas stock_actual/costo_promedio (por eso estas
    // tarjetas siempre daban 0) — se calculan igual que en "Resumen de
    // Stock": stock físico real = suma de lotes.cantidad de este producto,
    // costo promedio = valor total / stock total.
    const lotesItem  = (lotes || []).filter(l => l.item_id === itemId)
    const stockActual = lotesItem.reduce((s, l) => s + (parseFloat(l.cantidad) || 0), 0)
    const valorTotal   = lotesItem.reduce((s, l) => s + (parseFloat(l.cantidad) || 0) * (parseFloat(l.costo_unitario) || 0), 0)
    const costoPromedio = stockActual > 0 ? valorTotal / stockActual : 0

    let html = `
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px,1fr)); gap:12px; margin-bottom:15px;">
        <div class="card" style="padding:12px; text-align:center;">
          <div style="font-size:0.8rem; color:var(--text-secondary);">Stock Actual</div>
          <div style="font-size:1.4rem; font-weight:bold;">${stockActual.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div class="card" style="padding:12px; text-align:center;">
          <div style="font-size:0.8rem; color:var(--text-secondary);">Costo Promedio</div>
          <div style="font-size:1.4rem; font-weight:bold; color:var(--color-info);">S/ ${costoPromedio.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</div>
        </div>
        <div class="card" style="padding:12px; text-align:center;">
          <div style="font-size:0.8rem; color:var(--text-secondary);">Valor Total</div>
          <div style="font-size:1.4rem; font-weight:bold; color:var(--color-success);">S/ ${valorTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div class="card" style="padding:12px; text-align:center;">
          <div style="font-size:0.8rem; color:var(--text-secondary);">Entradas (período)</div>
          <div style="font-size:1.2rem; font-weight:bold; color:var(--color-success);">+${totalEntradas.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div class="card" style="padding:12px; text-align:center;">
          <div style="font-size:0.8rem; color:var(--text-secondary);">Salidas (período)</div>
          <div style="font-size:1.2rem; font-weight:bold; color:var(--color-danger);">-${totalSalidas.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Fecha</th><th>Tipo Movimiento</th><th>Concepto</th>
              <th>Doc. Ref.</th><th>Lote</th><th>Desde</th><th>A</th>
              <th style="text-align:right;">Entrada</th>
              <th style="text-align:right;">Salida</th>
              <th style="text-align:right;">Costo Unit.</th>
              <th style="text-align:right;">Costo Total</th>
              <th style="text-align:right;">Saldo Cant.</th>
              <th style="text-align:right;">Saldo Valor</th>
              <th style="text-align:right;">T.C.</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
    `

    if (movs.length === 0) {
      html += '<tr><td colspan="16" style="text-align:center;">Sin movimientos en este período.</td></tr>'
    } else {
      let totEntrada = 0, totSalida = 0, totValorEntrada = 0, totValorSalida = 0
      movs.forEach(m => {
        const entrada      = parseFloat(m.cantidad_entrada || 0)
        const salida       = parseFloat(m.cantidad_salida  || 0)
        const costoUnit    = parseFloat(m.costo_unitario   || 0)
        const valorEntradaMov = parseFloat(m.valor_entrada || 0)
        const valorSalidaMov  = parseFloat(m.valor_salida  || 0)
        // costo_total se reemplazó por valor_entrada/valor_salida (mismo
        // patrón que cantidad_entrada/cantidad_salida): solo uno de los dos
        // es distinto de 0 por fila, así que sumarlos da el valor de ESTE
        // movimiento puntual (para la columna). Para el TOTAL del período no
        // se suman entre sí — mezclaría compras con costo de venta — se
        // acumulan por separado (totValorEntrada / totValorSalida).
        const costoTotal   = valorEntradaMov + valorSalidaMov
        const saldoCant    = parseFloat(m.saldo_cantidad   || 0)
        const saldoValor   = parseFloat(m.saldo_valor      || 0)
        const tipoColor    = m.tipo_movimiento?.includes('entrada') || m.tipo_movimiento === 'entrada'
          ? 'color:var(--color-success)' : 'color:var(--color-danger)'
        const tipoCambioMov = parseFloat(m.tipo_cambio || 1)

        totEntrada += entrada
        totSalida += salida
        totValorEntrada += valorEntradaMov
        totValorSalida  += valorSalidaMov

        html += `<tr>
          <td style="font-size:0.82rem; color:var(--text-secondary);">${m.id}</td>
          <td>${m.fecha || '-'}</td>
          <td><span style="${tipoColor}; font-weight:bold;">${m.tipo_movimiento || '-'}</span></td>
          <td>${m.concepto || '-'}</td>
          <td style="font-size:0.82rem;">${m.documento_referencia || '-'}</td>
          <td style="font-size:0.82rem; font-weight:600;">${loteEtiqueta(m.lote_id)}</td>
          <td style="font-size:0.82rem;">${zonaNombre(m.ubicacion_origen_id)}</td>
          <td style="font-size:0.82rem;">${zonaNombre(m.ubicacion_destino_id)}</td>
          <td style="text-align:right; color:var(--color-success);">${entrada > 0 ? entrada.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''}</td>
          <td style="text-align:right; color:var(--color-danger);">${salida > 0 ? salida.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''}</td>
          <td style="text-align:right;">${costoUnit.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</td>
          <td style="text-align:right;">${costoTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td style="text-align:right; font-weight:bold;">${saldoCant.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td style="text-align:right; font-weight:bold;">${saldoValor.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td style="text-align:right;">${tipoCambioMov.toFixed(3)}</td>
          <td>${m.tipo_movimiento === 'traslado_interno' ? `
            <button class="btn btn-small btn-secondary" onclick="window.editarTrasladoInterno(${m.id})">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarTrasladoInterno(${m.id})">Eliminar</button>
          ` : ''}</td>
        </tr>`
      })

      html += `<tr style="border-top:2px solid var(--border-color); font-weight:bold;">
        <td colspan="8" style="text-align:right;">Totales del período:</td>
        <td style="text-align:right; color:var(--color-success);">${totEntrada.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td style="text-align:right; color:var(--color-danger);">${totSalida.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td></td>
        <td style="text-align:right; font-size:0.82rem;">
          ${totValorEntrada > 0 ? `<div style="color:var(--color-success);">+${totValorEntrada.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>` : ''}
          ${totValorSalida > 0 ? `<div style="color:var(--color-danger);">-${totValorSalida.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>` : ''}
        </td>
        <td></td>
        <td></td>
        <td></td>
        <td></td>
      </tr>`
    }

    html += '</tbody></table></div>'
    body.innerHTML = html
  } catch (e) {
    console.error('cargarKardex:', e)
    body.innerHTML = `<p style="color:var(--color-danger); text-align:center; padding:20px;">Error al cargar el kardex: ${e.message}</p>`
  }
}

// ============================================================================
// PARTIDAS ARANCELARIAS
// ============================================================================

async function renderPartidas() {
  try {
    const container = document.getElementById('tabla-partidas')
    if (!container) return

    const [partidas, productos] = await Promise.all([getPartidas(), getItems()])
    const prodMap = {}
    productos.forEach(p => { prodMap[p.id] = p.nombre })

    // Poblar el select de producto del modal "Nueva Partida"
    const selProd = document.getElementById('partProducto')
    if (selProd) {
      selProd.innerHTML = '<option value="">-- Selecciona --</option>' +
        productos.map(p => `<option value="${p.id}">${p.nombre}${p.sku ? ' (' + p.sku + ')' : ''}</option>`).join('')
    }

    if (!partidas || partidas.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Sin partidas registradas</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>N° Partida</th><th>Producto</th><th>Descripción</th>
            <th>Fecha Inicio</th><th>Fecha Fin</th><th>Estado</th><th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    partidas.forEach(p => {
      const badgeColor = p.status === 'activa' ? 'success' : p.status === 'cerrada' ? 'secondary' : 'danger'
      html += `<tr>
        <td><strong>${p.numero_partida}</strong></td>
        <td>${prodMap[p.product_id] || '-'}</td>
        <td style="font-size:0.85rem;">${p.descripcion || '-'}</td>
        <td>${p.fecha_inicio || '-'}</td>
        <td>${p.fecha_fin || '-'}</td>
        <td><span class="badge badge-${badgeColor}">${p.status || '-'}</span></td>
        <td>
          <button class="btn btn-small btn-danger" onclick="window.eliminarPartida(${p.id})">Eliminar</button>
        </td>
      </tr>`
    })

    html += '</tbody></table>'
    container.innerHTML = html
  } catch (e) {
    console.error('renderPartidas:', e)
    showToast('Error al cargar partidas', 'danger')
  }
}

window.guardarPartida = async function() {
  try {
    const productId    = parseInt(document.getElementById('partProducto')?.value || 0)
    const numero       = document.getElementById('partNumero')?.value?.trim()
    const descripcion  = document.getElementById('partDescripcion')?.value?.trim()
    const fechaInicio  = document.getElementById('partFechaInicio')?.value
    const fechaFin     = document.getElementById('partFechaFin')?.value || null
    const status       = document.getElementById('partStatus')?.value || 'activa'

    if (!productId || !numero || !fechaInicio) {
      showToast('Complete los campos requeridos (Producto, Número, Fecha Inicio)', 'warning')
      return
    }

    await addPartida({
      product_id:     productId,
      numero_partida: numero,
      descripcion:    descripcion || null,
      fecha_inicio:   fechaInicio,
      fecha_fin:      fechaFin,
      status
    })

    showToast('Partida creada exitosamente', 'success')
    window.closeModal('modal-nueva-partida')
    const form = document.getElementById('formNewPartida')
    if (form) form.reset()
    await renderPartidas()
  } catch (e) {
    console.error('guardarPartida:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

window.eliminarPartida = async function(id) {
  try {
    if (!confirm('¿Eliminar esta partida?')) return
    await deletePartida(id)
    showToast('Partida eliminada', 'success')
    await renderPartidas()
  } catch (e) {
    console.error('eliminarPartida:', e)
    showToast('Error al eliminar la partida', 'danger')
  }
}

// ============================================================================
// ALMACENES Y ZONAS
// ============================================================================
// Etapa 1 del stock por zona: un almacén es una dirección fiscal (puede
// haber varias). Cada almacén tiene Zonas internas (tabla ubicaciones,
// tipo='zona'). El stock real por zona se calcula desde stock_ubicaciones
// (Etapa 1 de la Guía de Remisión / Etapa 2 traslados internos), no desde
// aquí; este tab solo administra el catálogo de almacenes y zonas.

let _almacenesCache = null

async function _cargarAlmacenesCache(forzar = false) {
  if (_almacenesCache && !forzar) return _almacenesCache
  _almacenesCache = await getAlmacenes()
  return _almacenesCache
}

async function renderAlmacenes() {
  try {
    const container = document.getElementById('tabla-almacenes')
    if (!container) return

    const almacenes = await _cargarAlmacenesCache(true)

    // Poblar selects que dependen de la lista de almacenes
    const selectFiltro = document.getElementById('filtroZonaAlmacen')
    const selectModal = document.getElementById('zonaAlmacen')
    const opciones = (almacenes || []).map(a => `<option value="${a.id}">${a.nombre} (${a.codigo})</option>`).join('')
    if (selectFiltro) selectFiltro.innerHTML = '<option value="">-- Todos los almacenes --</option>' + opciones
    if (selectModal)  selectModal.innerHTML  = '<option value="">-- Selecciona --</option>' + opciones

    if (!almacenes || almacenes.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Sin almacenes registrados</p>'
    } else {
      let html = `
        <table>
          <thead>
            <tr>
              <th>Código</th><th>Nombre</th><th>Dirección</th><th>Ubigeo</th>
              <th>Principal</th><th>Estado</th><th>Acciones</th>
            </tr>
          </thead>
          <tbody>
      `
      for (const a of almacenes) {
        html += `
          <tr>
            <td><strong>${a.codigo}</strong></td>
            <td>${a.nombre}</td>
            <td>${a.direccion}</td>
            <td>${a.ubigeo || '-'}</td>
            <td>${a.es_principal ? '<span class="badge badge-success">Sí</span>' : '-'}</td>
            <td>${a.activo === false ? '<span class="badge badge-secondary">Inactivo</span>' : '<span class="badge badge-success">Activo</span>'}</td>
            <td style="white-space:nowrap;">
              <button class="btn btn-small btn-secondary" onclick="window.editarAlmacen(${a.id})">Editar</button>
              <button class="btn btn-small btn-danger" onclick="window.eliminarAlmacen(${a.id})">Eliminar</button>
            </td>
          </tr>
        `
      }
      html += '</tbody></table>'
      container.innerHTML = html
    }

    await window.renderZonas()
    await renderStockZonas()
  } catch (error) {
    console.error('Error en renderAlmacenes:', error)
    showToast('Error al cargar los almacenes', 'danger')
  }
}

window.abrirModalNuevoAlmacen = function () {
  document.getElementById('modalAlmacenTitle').textContent = 'Nuevo Almacén'
  const form = document.getElementById('formNewAlmacen')
  if (form) form.reset()
  document.getElementById('almId').value = ''
  window.openModal('modal-nuevo-almacen')
}

window.editarAlmacen = async function (id) {
  try {
    const a = await getAlmacenById(id)
    if (!a) { showToast('No se encontró el almacén', 'danger'); return }

    document.getElementById('modalAlmacenTitle').textContent = 'Editar Almacén'
    document.getElementById('almId').value = a.id
    document.getElementById('almCodigo').value = a.codigo || ''
    document.getElementById('almNombre').value = a.nombre || ''
    document.getElementById('almDireccion').value = a.direccion || ''
    document.getElementById('almUbigeo').value = a.ubigeo || ''
    document.getElementById('almEstablecimientoSunat').value = a.establecimiento_sunat || ''
    document.getElementById('almPrincipal').checked = !!a.es_principal

    window.openModal('modal-nuevo-almacen')
  } catch (error) {
    console.error('Error en editarAlmacen:', error)
    showToast('Error al abrir el almacén', 'danger')
  }
}

window.guardarAlmacen = async function () {
  try {
    const id = parseInt(document.getElementById('almId')?.value || 0)
    const codigo = document.getElementById('almCodigo')?.value?.trim()
    const nombre = document.getElementById('almNombre')?.value?.trim()
    const direccion = document.getElementById('almDireccion')?.value?.trim()
    const ubigeo = document.getElementById('almUbigeo')?.value?.trim() || null
    const establecimientoSunat = document.getElementById('almEstablecimientoSunat')?.value?.trim() || null
    const esPrincipal = document.getElementById('almPrincipal')?.checked || false

    if (!codigo || !nombre || !direccion) {
      showToast('Completa código, nombre y dirección', 'warning')
      return
    }

    const data = { codigo, nombre, direccion, ubigeo, establecimiento_sunat: establecimientoSunat, es_principal: esPrincipal }

    const resultado = id ? await updateAlmacen(id, data) : await addAlmacen(data)
    if (!resultado) { showToast('No se pudo guardar el almacén (¿código duplicado?)', 'danger'); return }

    showToast(id ? 'Almacén actualizado' : 'Almacén creado', 'success')
    window.closeModal('modal-nuevo-almacen')
    await renderAlmacenes()
  } catch (error) {
    console.error('Error en guardarAlmacen:', error)
    showToast('Error al guardar el almacén', 'danger')
  }
}

window.eliminarAlmacen = async function (id) {
  try {
    const almacen = await getAlmacenById(id)
    if (almacen?.es_virtual) {
      showToast('"Partners" es una ubicación virtual usada por el Kardex de compras/ventas — no se puede eliminar.', 'danger')
      return
    }

    const zonas = await getUbicacionesByAlmacen(id)
    if (zonas && zonas.length > 0) {
      showToast(
        `No se puede eliminar: este almacén tiene ${zonas.length} zona(s) registrada(s). Elimina las zonas primero.`,
        'danger'
      )
      return
    }

    if (!confirm('¿Eliminar este almacén?')) return

    const ok = await deleteAlmacen(id)
    if (!ok) { showToast('No se pudo eliminar el almacén (puede tener lotes o movimientos asociados)', 'danger'); return }

    showToast('Almacén eliminado', 'success')
    await renderAlmacenes()
  } catch (error) {
    console.error('Error en eliminarAlmacen:', error)
    showToast('Error al eliminar el almacén', 'danger')
  }
}

// ─── Zonas (ubicaciones) ──────────────────────────────────────────────────────

window.renderZonas = async function () {
  try {
    const container = document.getElementById('tabla-zonas')
    if (!container) return

    const almacenId = parseInt(document.getElementById('filtroZonaAlmacen')?.value || 0)
    const zonas = almacenId ? await getUbicacionesByAlmacen(almacenId) : await getUbicaciones()

    if (!zonas || zonas.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Sin zonas registradas</p>'
      return
    }

    const almacenes = await _cargarAlmacenesCache()
    const almacenNombre = {}
    for (const a of (almacenes || [])) almacenNombre[a.id] = `${a.nombre} (${a.codigo})`

    let html = `
      <table>
        <thead>
          <tr>
            <th>Almacén</th><th>Código</th><th>Nombre</th><th>Tipo</th><th>Estado</th><th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `
    for (const z of zonas) {
      html += `
        <tr>
          <td>${almacenNombre[z.almacen_id] || `Almacén #${z.almacen_id}`}</td>
          <td><strong>${z.codigo}</strong></td>
          <td>${z.nombre}</td>
          <td>${z.tipo || 'zona'}</td>
          <td>${z.activo === false ? '<span class="badge badge-secondary">Inactiva</span>' : '<span class="badge badge-success">Activa</span>'}</td>
          <td style="white-space:nowrap;">
            <button class="btn btn-small btn-secondary" onclick="window.editarZona(${z.id})">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarZona(${z.id})">Eliminar</button>
          </td>
        </tr>
      `
    }
    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderZonas:', error)
    showToast('Error al cargar las zonas', 'danger')
  }
}

window.abrirModalNuevaZona = async function () {
  await _cargarAlmacenesCache()
  document.getElementById('modalZonaTitle').textContent = 'Nueva Zona'
  const form = document.getElementById('formNewZona')
  if (form) form.reset()
  document.getElementById('zonaId').value = ''

  // Preseleccionar el almacén del filtro, si hay uno elegido
  const filtroAlmacen = document.getElementById('filtroZonaAlmacen')?.value || ''
  const selectModal = document.getElementById('zonaAlmacen')
  if (selectModal) {
    selectModal.innerHTML = '<option value="">-- Selecciona --</option>' +
      (_almacenesCache || []).map(a => `<option value="${a.id}">${a.nombre} (${a.codigo})</option>`).join('')
    if (filtroAlmacen) selectModal.value = filtroAlmacen
  }

  window.openModal('modal-nueva-zona')
}

window.editarZona = async function (id) {
  try {
    const z = await getUbicacionById(id)
    if (!z) { showToast('No se encontró la zona', 'danger'); return }

    await _cargarAlmacenesCache()
    const selectModal = document.getElementById('zonaAlmacen')
    if (selectModal) {
      selectModal.innerHTML = '<option value="">-- Selecciona --</option>' +
        (_almacenesCache || []).map(a => `<option value="${a.id}">${a.nombre} (${a.codigo})</option>`).join('')
    }

    document.getElementById('modalZonaTitle').textContent = 'Editar Zona'
    document.getElementById('zonaId').value = z.id
    document.getElementById('zonaAlmacen').value = z.almacen_id
    document.getElementById('zonaCodigo').value = z.codigo || ''
    document.getElementById('zonaNombre').value = z.nombre || ''
    document.getElementById('zonaTipo').value = z.tipo || 'zona'

    window.openModal('modal-nueva-zona')
  } catch (error) {
    console.error('Error en editarZona:', error)
    showToast('Error al abrir la zona', 'danger')
  }
}

window.guardarZona = async function () {
  try {
    const id = parseInt(document.getElementById('zonaId')?.value || 0)
    const almacenId = parseInt(document.getElementById('zonaAlmacen')?.value || 0)
    const codigo = document.getElementById('zonaCodigo')?.value?.trim()
    const nombre = document.getElementById('zonaNombre')?.value?.trim()
    const tipo = document.getElementById('zonaTipo')?.value || 'zona'

    if (!almacenId) { showToast('Selecciona el almacén', 'warning'); return }
    if (!codigo || !nombre) { showToast('Completa código y nombre', 'warning'); return }

    const data = { almacen_id: almacenId, codigo, nombre, tipo }

    const resultado = id ? await updateUbicacion(id, data) : await addUbicacion(data)
    if (!resultado) { showToast('No se pudo guardar la zona (¿código duplicado en ese almacén?)', 'danger'); return }

    showToast(id ? 'Zona actualizada' : 'Zona creada', 'success')
    window.closeModal('modal-nueva-zona')
    await window.renderZonas()
  } catch (error) {
    console.error('Error en guardarZona:', error)
    showToast('Error al guardar la zona', 'danger')
  }
}

window.eliminarZona = async function (id) {
  try {
    const stock = await getStockUbicacionesByUbicacion(id)
    const conStock = (stock || []).filter(s => (parseFloat(s.cantidad) || 0) > 0)
    if (conStock.length > 0) {
      showToast(
        `No se puede eliminar: esta zona todavía tiene stock (${conStock.length} lote(s)). Traslada el stock a otra zona primero.`,
        'danger'
      )
      return
    }

    if (!confirm('¿Eliminar esta zona?')) return

    const ok = await deleteUbicacion(id)
    if (!ok) { showToast('No se pudo eliminar la zona', 'danger'); return }

    showToast('Zona eliminada', 'success')
    await window.renderZonas()
  } catch (error) {
    console.error('Error en eliminarZona:', error)
    showToast('Error al eliminar la zona', 'danger')
  }
}

// ============================================================================
// STOCK POR ZONA Y TRASLADOS INTERNOS (Etapa 2)
// ============================================================================
// stock_ubicaciones es la fuente de verdad de "cuánto de cada lote hay en
// cada zona". Un traslado interno mueve cantidad entre dos filas (mismo
// lote_id, distinto ubicacion_id) sin tocar lotes.cantidad ni el costeo, y
// deja rastro en kardex con tipo_movimiento='traslado_interno'.

async function renderStockZonas() {
  try {
    const container = document.getElementById('tabla-stock-zonas')
    if (!container) return

    const [stock, lotes, items, marcas, zonas, almacenes] = await Promise.all([
      getStockUbicaciones(),
      getLotes(),
      getItems(),
      getMarcas(),
      getUbicaciones(),
      getAlmacenes()
    ])

    const stockConCantidad = (stock || []).filter(s => (parseFloat(s.cantidad) || 0) > 0)
    if (stockConCantidad.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Sin stock registrado por zona todavía (se genera al recibir una Guía de Remisión).</p>'
      return
    }

    const loteMap = {}
    for (const l of (lotes || [])) loteMap[l.id] = l
    const itemMap = {}
    for (const it of (items || [])) itemMap[it.id] = it
    const marcaMap = {}
    for (const m of (marcas || [])) marcaMap[m.id] = m
    const almacenMap = {}
    for (const a of (almacenes || [])) almacenMap[a.id] = a
    const zonaMap = {}
    for (const z of (zonas || [])) zonaMap[z.id] = z

    let html = `
      <table>
        <thead>
          <tr>
            <th>Producto</th><th>N° Lote</th><th>Marca</th><th>Almacén — Zona</th>
            <th style="text-align:right;">Cantidad</th><th style="text-align:right;">Unidades</th><th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `
    for (const s of stockConCantidad.sort((a, b) => a.id - b.id)) {
      const lote = loteMap[s.lote_id]
      const item = lote ? itemMap[lote.item_id] : null
      const marca = lote?.marca_id ? marcaMap[lote.marca_id] : null
      const zona = zonaMap[s.ubicacion_id]
      const almacen = zona ? almacenMap[zona.almacen_id] : null

      html += `
        <tr>
          <td>${item?.nombre || 'Item #' + (lote?.item_id ?? '?')}</td>
          <td>${lote?.numero_lote || '-'}</td>
          <td>${marca?.nombre || '-'}</td>
          <td>${almacen?.nombre || '?'} — ${zona?.nombre || 'Zona #' + s.ubicacion_id}</td>
          <td style="text-align:right; font-weight:bold;">${(parseFloat(s.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
          <td style="text-align:right;">${(parseFloat(s.cantidad_unidades) || 0) > 0 ? (parseFloat(s.cantidad_unidades) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '-'}</td>
          <td><button class="btn btn-small btn-secondary" onclick="window.abrirModalTraslado(${s.id})">Trasladar</button></td>
        </tr>
      `
    }
    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderStockZonas:', error)
    showToast('Error al cargar el stock por zona', 'danger')
  }
}

// ============================================================================
// TRASLADO INTERNO — MULTI-LÍNEA
// ============================================================================
// Un traslado interno ahora es un documento con cabecera (zona origen, zona
// destino, fecha, descripción, documento de referencia) y varias líneas
// (producto + lote + cantidad), igual que Nueva Compra/Nueva Venta. Cada
// línea sigue generando su propia fila de kardex (mismo tipo_movimiento
// 'traslado_interno'), así que editarTrasladoInterno/eliminarTrasladoInterno
// (que operan sobre UNA fila de kardex) no necesitan cambios.

let _detallesTrasladoEnCreacion = []

async function _poblarZonasTraslado(zonaOrigenSeleccionada = null) {
  const [zonas, almacenes] = await Promise.all([getUbicaciones(), getAlmacenes()])
  const almacenMap = {}
  for (const a of (almacenes || [])) almacenMap[a.id] = a

  // Las zonas virtuales (Partners/Vendors, Partners/Customers) son solo para
  // el Kardex de compras/ventas — no son válidas como origen/destino de un
  // traslado interno real entre tus propias zonas.
  const zonasReales = (zonas || []).filter(z => !almacenMap[z.almacen_id]?.es_virtual)
  const opciones = (idExcluir) => zonasReales
    .filter(z => z.id !== idExcluir)
    .map(z => `<option value="${z.id}">${almacenMap[z.almacen_id]?.nombre || '?'} — ${z.nombre}</option>`)
    .join('')

  const selectOrigen = document.getElementById('tiZonaOrigen')
  const selectDestino = document.getElementById('tiZonaDestino')
  selectOrigen.innerHTML = '<option value="">-- Selecciona --</option>' +
    zonasReales.map(z => `<option value="${z.id}">${almacenMap[z.almacen_id]?.nombre || '?'} — ${z.nombre}</option>`).join('')
  selectDestino.innerHTML = '<option value="">-- Selecciona --</option>' + opciones(zonaOrigenSeleccionada ? parseInt(zonaOrigenSeleccionada) : null)

  if (zonaOrigenSeleccionada) selectOrigen.value = zonaOrigenSeleccionada
}

window.abrirModalNuevoTraslado = async function (zonaOrigenIdPrefill = null) {
  try {
    _detallesTrasladoEnCreacion = []
    await _poblarZonasTraslado(zonaOrigenIdPrefill)
    document.getElementById('tiFecha').value = new Date().toISOString().split('T')[0]
    document.getElementById('tiDescripcion').value = ''
    document.getElementById('tiDocumentoReferencia').value = ''
    _renderTablaDetalleTraslado()
    window.openModal('modal-traslado-interno')
  } catch (error) {
    console.error('Error en abrirModalNuevoTraslado:', error)
    showToast('Error al abrir el traslado', 'danger')
  }
}

// Atajo desde el botón "Trasladar" de una fila de Stock por Zona: abre el
// modal con esa zona ya como origen y esa línea (item/lote) ya cargada en
// el sub-modal de "Agregar Producto", lista para que solo ajusten cantidad.
window.abrirModalTraslado = async function (stockId) {
  try {
    const stockList = await getStockUbicaciones()
    const registro = (stockList || []).find(s => s.id === stockId)
    if (!registro) { showToast('No se encontró el registro de stock', 'danger'); return }
    const lote = await getLoteById(registro.lote_id)
    if (!lote) { showToast('No se encontró el lote', 'danger'); return }

    await window.abrirModalNuevoTraslado(registro.ubicacion_id)
    await window.abrirModalDetalleTraslado()

    const selProducto = document.getElementById('tdProducto')
    selProducto.value = lote.item_id
    await window.onCambiarProductoDetalleTraslado()
    const selLote = document.getElementById('tdLote')
    selLote.value = registro.lote_id
    window.onCambiarLoteDetalleTraslado()
    document.getElementById('tdCantidad').value = registro.cantidad
  } catch (error) {
    console.error('Error en abrirModalTraslado:', error)
    showToast('Error al abrir el traslado', 'danger')
  }
}

window.onCambiarZonaOrigenTraslado = async function () {
  const zonaOrigenId = document.getElementById('tiZonaOrigen')?.value
  if (_detallesTrasladoEnCreacion.length > 0) {
    showToast('Se limpiaron las líneas agregadas: pertenecían a la zona origen anterior', 'warning')
    _detallesTrasladoEnCreacion = []
    _renderTablaDetalleTraslado()
  }
  await _poblarZonasTraslado(zonaOrigenId || null)
}

// Devuelve, para una zona origen dada, el stock disponible por item con
// detalle de lotes (item_id -> [{lote_id, numero_lote, cantidad, cantidad_unidades, peso_por_unidad, es_peso_variable}]).
async function _stockDisponiblePorItemEnZona(zonaOrigenId) {
  const [stock, lotes, items] = await Promise.all([getStockUbicaciones(), getLotes(), getItems()])
  const loteMap = {}
  for (const l of (lotes || [])) loteMap[l.id] = l
  const itemMap = {}
  for (const it of (items || [])) itemMap[it.id] = it

  const porItem = {}
  for (const s of (stock || [])) {
    if (s.ubicacion_id !== parseInt(zonaOrigenId)) continue
    const cantidad = parseFloat(s.cantidad) || 0
    if (cantidad <= 0) continue
    const lote = loteMap[s.lote_id]
    if (!lote) continue
    const itemId = lote.item_id
    if (!porItem[itemId]) porItem[itemId] = { item: itemMap[itemId], lotes: [] }
    porItem[itemId].lotes.push({
      lote_id: lote.id,
      numero_lote: lote.numero_lote,
      cantidad,
      cantidad_unidades: parseFloat(s.cantidad_unidades) || 0,
      peso_por_unidad: parseFloat(lote.peso_por_unidad) || 0,
      es_peso_variable: !!lote.es_peso_variable
    })
  }
  return porItem
}

window.abrirModalDetalleTraslado = async function () {
  const zonaOrigenId = document.getElementById('tiZonaOrigen')?.value
  if (!zonaOrigenId) { showToast('Selecciona primero la zona origen', 'warning'); return }

  const porItem = await _stockDisponiblePorItemEnZona(zonaOrigenId)
  window._tiStockPorItem = porItem

  const selProducto = document.getElementById('tdProducto')
  const ids = Object.keys(porItem)
  if (ids.length === 0) {
    selProducto.innerHTML = '<option value="">-- Sin stock en esa zona --</option>'
    showToast('No hay productos con stock en la zona origen seleccionada', 'warning')
  } else {
    selProducto.innerHTML = '<option value="">-- Selecciona --</option>' +
      ids.map(id => `<option value="${id}">${porItem[id].item?.nombre || 'Item #' + id}</option>`).join('')
  }
  document.getElementById('tdLote').innerHTML = '<option value="">-- Selecciona un producto primero --</option>'
  document.getElementById('tdCantidad').value = ''
  document.getElementById('tdDisponible').textContent = ''
  const inpUnid = document.getElementById('tdCantUnidades')
  if (inpUnid) inpUnid.value = ''

  window.openModal('modal-detalle-traslado')
}

window.onCambiarProductoDetalleTraslado = async function () {
  const itemId = document.getElementById('tdProducto')?.value
  const selLote = document.getElementById('tdLote')
  const porItem = window._tiStockPorItem || {}
  const entry = porItem[itemId]

  if (!entry) {
    selLote.innerHTML = '<option value="">-- Selecciona un producto primero --</option>'
    return
  }

  // Resta lo que ya se agregó de este mismo lote en líneas previas de este
  // traslado, para no dejar reservar más de lo que realmente queda.
  selLote.innerHTML = '<option value="">-- Selecciona --</option>' +
    entry.lotes.map(l => {
      const yaAgregadoKg = _detallesTrasladoEnCreacion
        .filter(d => d.lote_id === l.lote_id)
        .reduce((s, d) => s + (parseFloat(d.cantidad) || 0), 0)
      const yaAgregadoUnid = _detallesTrasladoEnCreacion
        .filter(d => d.lote_id === l.lote_id)
        .reduce((s, d) => s + (parseFloat(d.cantidad_unidades) || 0), 0)
      const disponible = parseFloat((l.cantidad - yaAgregadoKg).toFixed(4))
      const disponibleUnid = parseFloat((l.cantidad_unidades - yaAgregadoUnid).toFixed(4))
      return `<option value="${l.lote_id}" data-disponible="${disponible}" data-disponible-unid="${disponibleUnid}" data-peso-por-unidad="${l.peso_por_unidad || 0}" data-peso-variable="${l.es_peso_variable ? '1' : '0'}">${l.numero_lote} (disp. ${disponible.toLocaleString('en-US', { maximumFractionDigits: 2 })})</option>`
    }).join('')

  document.getElementById('tdCantidad').value = ''
  document.getElementById('tdDisponible').textContent = ''
  const inpUnid = document.getElementById('tdCantUnidades')
  if (inpUnid) inpUnid.value = ''
}

window.onCambiarLoteDetalleTraslado = function () {
  const selLote = document.getElementById('tdLote')
  const opt = selLote?.options[selLote.selectedIndex]
  const disponible = parseFloat(opt?.getAttribute('data-disponible') || 0)
  const disponibleUnid = parseFloat(opt?.getAttribute('data-disponible-unid') || 0)
  const cantInput = document.getElementById('tdCantidad')
  cantInput.max = disponible
  document.getElementById('tdDisponible').textContent = `Disponible: ${disponible.toLocaleString('en-US', { maximumFractionDigits: 2 })} kg` +
    (disponibleUnid > 0 ? ` / ${disponibleUnid.toLocaleString('en-US', { maximumFractionDigits: 2 })} und` : '')
  window.onCambiarCantidadDetalleTraslado()
}

// Sugiere N° de Unidades a partir del peso_por_unidad del lote elegido,
// igual criterio que en Nueva Venta.
window.onCambiarCantidadDetalleTraslado = function () {
  const selLote = document.getElementById('tdLote')
  const opt = selLote?.options[selLote.selectedIndex]
  const inpUnid = document.getElementById('tdCantUnidades')
  if (!opt || !inpUnid) return
  const pesoPorUnidad = parseFloat(opt.getAttribute('data-peso-por-unidad') || 0)
  const esPesoVariable = opt.getAttribute('data-peso-variable') === '1'
  const cantidad = parseFloat(document.getElementById('tdCantidad')?.value || 0)
  if (pesoPorUnidad > 0) {
    inpUnid.value = parseFloat((cantidad / pesoPorUnidad).toFixed(2))
    inpUnid.placeholder = esPesoVariable ? 'Aproximado (peso variable) — ajusta si hace falta' : ''
  } else {
    inpUnid.value = ''
    inpUnid.placeholder = 'Este lote no trackea unidades'
  }
}

window.agregarLineaTraslado = function () {
  const itemId = parseInt(document.getElementById('tdProducto')?.value || 0)
  const loteId = parseInt(document.getElementById('tdLote')?.value || 0)
  const cantidad = parseFloat(document.getElementById('tdCantidad')?.value || 0)
  const cantidadUnidades = parseFloat(document.getElementById('tdCantUnidades')?.value || 0) || 0
  const selLote = document.getElementById('tdLote')
  const opt = selLote?.options[selLote.selectedIndex]
  const disponible = parseFloat(opt?.getAttribute('data-disponible') || 0)
  const disponibleUnid = parseFloat(opt?.getAttribute('data-disponible-unid') || 0)

  if (!itemId || !loteId) { showToast('Selecciona producto y lote', 'warning'); return }
  if (!cantidad || cantidad <= 0) { showToast('Ingresa una cantidad válida', 'warning'); return }
  if (cantidad > disponible) {
    showToast(`No hay stock suficiente: disponible ${disponible.toLocaleString('en-US', { maximumFractionDigits: 2 })} kg`, 'danger')
    return
  }
  if (cantidadUnidades > 0 && cantidadUnidades > disponibleUnid) {
    showToast(`No hay unidades suficientes: disponible ${disponibleUnid.toLocaleString('en-US', { maximumFractionDigits: 2 })} und`, 'danger')
    return
  }

  const porItem = window._tiStockPorItem || {}
  const item = porItem[itemId]?.item

  _detallesTrasladoEnCreacion.push({
    item_id: itemId,
    item_nombre: item?.nombre || `Item #${itemId}`,
    lote_id: loteId,
    numero_lote: opt.textContent.split(' (disp.')[0],
    cantidad,
    cantidad_unidades: cantidadUnidades
  })

  window.closeModal('modal-detalle-traslado')
  _renderTablaDetalleTraslado()
}

window.quitarLineaTraslado = function (idx) {
  _detallesTrasladoEnCreacion.splice(idx, 1)
  _renderTablaDetalleTraslado()
}

function _renderTablaDetalleTraslado() {
  const container = document.getElementById('tabla-detalle-traslado')
  if (container) {
    if (_detallesTrasladoEnCreacion.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin productos agregados</p>'
    } else {
      let html = `<table>
        <thead><tr><th>Producto</th><th>Lote</th><th style="text-align:right;">Cantidad (kg)</th><th style="text-align:right;">N° Unid.</th><th></th></tr></thead>
        <tbody>`
      _detallesTrasladoEnCreacion.forEach((d, idx) => {
        html += `<tr>
          <td>${d.item_nombre}</td>
          <td>${d.numero_lote}</td>
          <td style="text-align:right; font-weight:bold;">${(parseFloat(d.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
          <td style="text-align:right;">${(parseFloat(d.cantidad_unidades) || 0) > 0 ? (parseFloat(d.cantidad_unidades) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '-'}</td>
          <td><button type="button" class="btn btn-small btn-danger" onclick="window.quitarLineaTraslado(${idx})">✕</button></td>
        </tr>`
      })
      html += '</tbody></table>'
      container.innerHTML = html
    }
  }

  const totCant = _detallesTrasladoEnCreacion.reduce((s, d) => s + (parseFloat(d.cantidad) || 0), 0)
  const elCant = document.getElementById('tiTotalCantidad')
  const elLin = document.getElementById('tiTotalLineas')
  if (elCant) elCant.textContent = totCant.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (elLin) elLin.textContent = _detallesTrasladoEnCreacion.length
}

window.guardarTrasladoInterno = async function () {
  const btn = document.getElementById('btnGuardarTrasladoInterno')
  if (btn?.disabled) return
  try {
    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    const zonaOrigenId = parseInt(document.getElementById('tiZonaOrigen')?.value || 0)
    const zonaDestinoId = parseInt(document.getElementById('tiZonaDestino')?.value || 0)
    const fecha = document.getElementById('tiFecha')?.value
    const descripcion = document.getElementById('tiDescripcion')?.value?.trim() || null
    const documentoReferencia = document.getElementById('tiDocumentoReferencia')?.value?.trim() || null

    if (!zonaOrigenId)  { showToast('Selecciona la zona origen', 'warning'); return }
    if (!zonaDestinoId) { showToast('Selecciona la zona destino', 'warning'); return }
    if (zonaOrigenId === zonaDestinoId) { showToast('La zona destino debe ser distinta a la zona origen', 'warning'); return }
    if (!fecha)         { showToast('Ingresa la fecha', 'warning'); return }
    if (_detallesTrasladoEnCreacion.length === 0) { showToast('Agrega al menos un producto', 'warning'); return }

    if (btn) { btn.disabled = true; btn.textContent = 'Guardando...' }

    const [zonas, almacenes] = await Promise.all([getUbicaciones(), getAlmacenes()])
    const zonaOrigen = (zonas || []).find(z => z.id === zonaOrigenId)
    const zonaDestino = (zonas || []).find(z => z.id === zonaDestinoId)

    for (const linea of _detallesTrasladoEnCreacion) {
      const stockList = await getStockUbicaciones()
      const origen = stockList.find(s => s.lote_id === linea.lote_id && s.ubicacion_id === zonaOrigenId)
      const disponible = parseFloat(origen?.cantidad || 0)
      const disponibleUnid = parseFloat(origen?.cantidad_unidades || 0)
      const unidades = parseFloat(linea.cantidad_unidades) || 0
      if (!origen || linea.cantidad > disponible) {
        showToast(`Stock insuficiente para ${linea.item_nombre} (lote ${linea.numero_lote}): disponible ${disponible.toLocaleString('en-US', { maximumFractionDigits: 2 })}`, 'danger')
        continue
      }
      if (unidades > 0 && unidades > disponibleUnid) {
        showToast(`Unidades insuficientes para ${linea.item_nombre} (lote ${linea.numero_lote}): disponible ${disponibleUnid.toLocaleString('en-US', { maximumFractionDigits: 2 })} und`, 'danger')
        continue
      }

      const lote = await getLoteById(linea.lote_id)
      const costoUnitario = parseFloat(lote?.costo_unitario || 0)

      // 1) Descontar (o eliminar) la fila de origen
      const restante = parseFloat((disponible - linea.cantidad).toFixed(4))
      const restanteUnid = Math.max(0, parseFloat((disponibleUnid - unidades).toFixed(4)))
      if (restante <= 0) {
        await deleteStockUbicacion(origen.id)
      } else {
        await updateStockUbicacion(origen.id, { cantidad: restante, cantidad_unidades: restanteUnid })
      }

      // 2) Sumar (o crear) la fila de destino
      const destinoExistente = stockList.find(s => s.lote_id === linea.lote_id && s.ubicacion_id === zonaDestinoId)
      if (destinoExistente) {
        const nuevaCantidadDestino = parseFloat(((parseFloat(destinoExistente.cantidad) || 0) + linea.cantidad).toFixed(4))
        const nuevaUnidadesDestino = parseFloat(((parseFloat(destinoExistente.cantidad_unidades) || 0) + unidades).toFixed(4))
        await updateStockUbicacion(destinoExistente.id, { cantidad: nuevaCantidadDestino, cantidad_unidades: nuevaUnidadesDestino })
      } else {
        await addStockUbicacion({ lote_id: linea.lote_id, ubicacion_id: zonaDestinoId, cantidad: linea.cantidad, cantidad_unidades: unidades })
      }

      // 3) Kardex: una fila por línea (mismo criterio granular que compras/ventas)
      // saldo_cantidad/saldo_unidades quedan como el saldo que dejó la
      // ZONA ORIGEN (no lotes.cantidad total: un traslado no cambia el
      // total del lote, solo su distribución entre zonas).
      await addKardexMovimiento({
        item_id:              linea.item_id,
        lote_id:              linea.lote_id,
        almacen_id:           zonaOrigen?.almacen_id || null,
        almacen_destino_id:   zonaDestino?.almacen_id || null,
        ubicacion_origen_id:  zonaOrigenId,
        ubicacion_destino_id: zonaDestinoId,
        fecha,
        tipo_movimiento:      'traslado_interno',
        concepto:             'Traslado interno entre zonas',
        descripcion,
        documento_referencia: documentoReferencia,
        cantidad_salida:      linea.cantidad,
        cantidad_entrada:     0,
        cantidad_unidades_entrada: 0,
        cantidad_unidades_salida:  unidades,
        costo_unitario:       costoUnitario,
        valor_entrada:        0,
        valor_salida:         parseFloat((linea.cantidad * costoUnitario).toFixed(2)),
        moneda:               lote?.moneda || 'PEN',
        tipo_cambio:           parseFloat(lote?.tipo_cambio) || 1,
        costo_unit_original:   parseFloat(lote?.costo_unit_original ?? costoUnitario),
        saldo_cantidad:       restante,
        saldo_valor:          parseFloat((restante * costoUnitario).toFixed(2)),
        saldo_unidades:       restanteUnid,
        created_by:           user.db_id
      })
    }

    showToast('Traslado registrado', 'success')
    window.closeModal('modal-traslado-interno')
    _detallesTrasladoEnCreacion = []
    const form = document.getElementById('formTrasladoInterno')
    if (form) form.reset()
    await renderStockZonas()
  } catch (error) {
    console.error('Error en guardarTrasladoInterno:', error)
    showToast('Error al registrar el traslado', 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Trasladar' }
  }
}

// ============================================================================
// IMPORTAR TRASLADOS INTERNOS MASIVOS (desde Excel/CSV)
// ============================================================================
// Cada fila del archivo es un traslado interno independiente: sku, numero_lote,
// zona_origen, zona_destino, cantidad, fecha, documento_referencia (opcional),
// descripcion (opcional). Mismo efecto que crear cada traslado a mano, uno por
// uno, en el modal 'Nuevo Traslado'.

const COLUMNAS_IMPORT_TRASLADO = ['sku', 'numero_lote', 'zona_origen', 'zona_destino', 'cantidad', 'cantidad_unidades', 'fecha', 'documento_referencia', 'descripcion']

window.abrirModalImportarTraslados = function () {
  const input = document.getElementById('fileImportarTraslados')
  if (input) input.value = ''
  const resumen = document.getElementById('importar-traslados-resumen')
  const log = document.getElementById('importar-traslados-log')
  if (resumen) resumen.innerHTML = ''
  if (log) log.innerHTML = ''
  window.openModal('modal-importar-traslados')
}

function _parseFechaImport(valor) {
  if (!valor) return null
  if (valor instanceof Date) return valor.toISOString().slice(0, 10)
  const s = String(valor).trim()
  // Excel serial date (numérico)
  if (/^\d+(\.\d+)?$/.test(s)) {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30))
    const dias = parseFloat(s)
    const d = new Date(excelEpoch.getTime() + dias * 86400000)
    return d.toISOString().slice(0, 10)
  }
  // 'YYYY-MM-DD' o 'DD/MM/YYYY'
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`
  const dmyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (dmyMatch) return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, '0')}-${dmyMatch[1].padStart(2, '0')}`
  return null
}

async function _leerArchivoImportTraslados(file) {
  const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm')
  const buffer = await file.arrayBuffer()
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true })
  const primeraHoja = wb.SheetNames[0]
  const ws = wb.Sheets[primeraHoja]
  const filas = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true })
  return filas
}

window.procesarImportacionTraslados = async function () {
  const btn = document.getElementById('btnProcesarImportarTraslados')
  const input = document.getElementById('fileImportarTraslados')
  const resumenEl = document.getElementById('importar-traslados-resumen')
  const logEl = document.getElementById('importar-traslados-log')
  if (btn?.disabled) return

  const file = input?.files?.[0]
  if (!file) { showToast('Selecciona un archivo primero', 'warning'); return }

  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Procesando...' }
    if (resumenEl) resumenEl.innerHTML = '<p style="color:var(--text-secondary);">Leyendo archivo...</p>'
    if (logEl) logEl.innerHTML = ''

    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    let filas
    try {
      filas = await _leerArchivoImportTraslados(file)
    } catch (e) {
      console.error('Error leyendo archivo de importación:', e)
      if (resumenEl) resumenEl.innerHTML = '<p style="color:var(--color-danger);">No se pudo leer el archivo. Verifica que sea un .xlsx o .csv válido.</p>'
      return
    }

    if (!filas || filas.length === 0) {
      if (resumenEl) resumenEl.innerHTML = '<p style="color:var(--color-danger);">El archivo no tiene filas de datos.</p>'
      return
    }

    // Catálogos actuales, indexados para validación rápida
    const [items, lotes, ubicaciones] = await Promise.all([getItems(), getLotes(), getUbicaciones()])
    const itemsBySku = new Map(items.filter(i => i.sku).map(i => [String(i.sku).trim(), i]))
    const lotesByNumero = new Map(lotes.map(l => [String(l.numero_lote).trim(), l]))
    const ubicacionesByCodigo = new Map(ubicaciones.map(u => [String(u.codigo).trim(), u]))
    const almacenes = await getAlmacenes()
    const almacenesById = new Map(almacenes.map(a => [a.id, a]))

    let ok = 0, fallidas = 0
    const logLineas = []

    for (let i = 0; i < filas.length; i++) {
      const numFila = i + 2 // fila 1 = encabezado
      const fila = filas[i]
      const skuRaw = fila.sku ?? fila.SKU
      const loteRaw = fila.numero_lote ?? fila.lote
      const zonaOrigenRaw = fila.zona_origen ?? fila.zonaOrigen
      const zonaDestinoRaw = fila.zona_destino ?? fila.zonaDestino
      const cantidadRaw = fila.cantidad
      const unidadesRaw = fila.cantidad_unidades ?? fila.unidades
      const fechaRaw = fila.fecha
      const documentoReferencia = (fila.documento_referencia ?? fila.documentoReferencia ?? '').toString().trim() || null
      const descripcion = (fila.descripcion ?? '').toString().trim() || null

      const sku = skuRaw != null ? String(skuRaw).trim() : ''
      const numeroLote = loteRaw != null ? String(loteRaw).trim() : ''
      const zonaOrigenCod = zonaOrigenRaw != null ? String(zonaOrigenRaw).trim() : ''
      const zonaDestinoCod = zonaDestinoRaw != null ? String(zonaDestinoRaw).trim() : ''
      const cantidad = parseFloat(cantidadRaw)
      const fecha = _parseFechaImport(fechaRaw)

      const item = itemsBySku.get(sku)
      const lote = lotesByNumero.get(numeroLote)
      const zonaOrigen = ubicacionesByCodigo.get(zonaOrigenCod)
      const zonaDestino = ubicacionesByCodigo.get(zonaDestinoCod)

      if (!sku || !item) { fallidas++; logLineas.push(`Fila ${numFila}: SKU "${sku}" no existe.`); continue }
      if (!numeroLote || !lote) { fallidas++; logLineas.push(`Fila ${numFila}: Lote "${numeroLote}" no existe.`); continue }
      if (lote.item_id !== item.id) { fallidas++; logLineas.push(`Fila ${numFila}: Lote "${numeroLote}" no pertenece al SKU "${sku}".`); continue }
      if (!zonaOrigenCod || !zonaOrigen) { fallidas++; logLineas.push(`Fila ${numFila}: Zona origen "${zonaOrigenCod}" no existe.`); continue }
      if (!zonaDestinoCod || !zonaDestino) { fallidas++; logLineas.push(`Fila ${numFila}: Zona destino "${zonaDestinoCod}" no existe.`); continue }
      if (zonaOrigen.id === zonaDestino.id) { fallidas++; logLineas.push(`Fila ${numFila}: Zona origen y destino son iguales.`); continue }
      if (!cantidad || cantidad <= 0) { fallidas++; logLineas.push(`Fila ${numFila}: Cantidad inválida.`); continue }
      if (!fecha) { fallidas++; logLineas.push(`Fila ${numFila}: Fecha inválida ("${fechaRaw}").`); continue }

      try {
        const stockList = await getStockUbicaciones()
        const origen = stockList.find(s => s.lote_id === lote.id && s.ubicacion_id === zonaOrigen.id)
        const disponible = parseFloat(origen?.cantidad || 0)
        const disponibleUnid = parseFloat(origen?.cantidad_unidades || 0)
        if (!origen || cantidad > disponible) {
          fallidas++
          logLineas.push(`Fila ${numFila}: Stock insuficiente en zona origen (disponible ${disponible.toLocaleString('en-US', { maximumFractionDigits: 2 })}).`)
          continue
        }

        // cantidad_unidades es opcional en el archivo: si no viene, se
        // estima con el peso_por_unidad del lote (cuando lo tiene).
        let unidades = unidadesRaw != null && unidadesRaw !== '' ? parseFloat(unidadesRaw) : NaN
        if (isNaN(unidades)) {
          unidades = (lote.peso_por_unidad && lote.peso_por_unidad > 0)
            ? parseFloat((cantidad / lote.peso_por_unidad).toFixed(2))
            : 0
        }
        if (unidades > 0 && unidades > disponibleUnid) {
          fallidas++
          logLineas.push(`Fila ${numFila}: Unidades insuficientes en zona origen (disponible ${disponibleUnid.toLocaleString('en-US', { maximumFractionDigits: 2 })} und).`)
          continue
        }

        const costoUnitario = parseFloat(lote.costo_unitario || 0)
        const restante = parseFloat((disponible - cantidad).toFixed(4))
        const restanteUnid = Math.max(0, parseFloat((disponibleUnid - unidades).toFixed(4)))
        if (restante <= 0) {
          await deleteStockUbicacion(origen.id)
        } else {
          await updateStockUbicacion(origen.id, { cantidad: restante, cantidad_unidades: restanteUnid })
        }

        const destinoExistente = stockList.find(s => s.lote_id === lote.id && s.ubicacion_id === zonaDestino.id)
        if (destinoExistente) {
          const nuevaCantidadDestino = parseFloat(((parseFloat(destinoExistente.cantidad) || 0) + cantidad).toFixed(4))
          const nuevaUnidadesDestino = parseFloat(((parseFloat(destinoExistente.cantidad_unidades) || 0) + unidades).toFixed(4))
          await updateStockUbicacion(destinoExistente.id, { cantidad: nuevaCantidadDestino, cantidad_unidades: nuevaUnidadesDestino })
        } else {
          await addStockUbicacion({ lote_id: lote.id, ubicacion_id: zonaDestino.id, cantidad, cantidad_unidades: unidades })
        }

        await addKardexMovimiento({
          item_id:              item.id,
          lote_id:              lote.id,
          almacen_id:           almacenesById.get(zonaOrigen.almacen_id)?.id || zonaOrigen.almacen_id || null,
          almacen_destino_id:   almacenesById.get(zonaDestino.almacen_id)?.id || zonaDestino.almacen_id || null,
          ubicacion_origen_id:  zonaOrigen.id,
          ubicacion_destino_id: zonaDestino.id,
          fecha,
          tipo_movimiento:      'traslado_interno',
          concepto:             'Traslado interno entre zonas (importación masiva)',
          descripcion,
          documento_referencia: documentoReferencia,
          cantidad_salida:      cantidad,
          cantidad_entrada:     0,
          cantidad_unidades_entrada: 0,
          cantidad_unidades_salida:  unidades,
          costo_unitario:       costoUnitario,
          valor_entrada:        0,
          valor_salida:         parseFloat((cantidad * costoUnitario).toFixed(2)),
          moneda:               lote?.moneda || 'PEN',
          tipo_cambio:           parseFloat(lote?.tipo_cambio) || 1,
          costo_unit_original:   parseFloat(lote?.costo_unit_original ?? costoUnitario),
          saldo_cantidad:       restante,
          saldo_valor:          parseFloat((restante * costoUnitario).toFixed(2)),
          saldo_unidades:       restanteUnid,
          created_by:           user.db_id
        })

        ok++
      } catch (e) {
        console.error(`Error importando fila ${numFila}:`, e)
        fallidas++
        logLineas.push(`Fila ${numFila}: Error inesperado al procesar (ver consola).`)
      }
    }

    if (resumenEl) {
      resumenEl.innerHTML = `
        <div style="display:flex; gap:20px;">
          <div><strong style="color:var(--color-success);">${ok}</strong> traslados creados</div>
          <div><strong style="color:${fallidas > 0 ? 'var(--color-danger)' : 'var(--text-secondary)'};">${fallidas}</strong> filas con error</div>
        </div>`
    }
    if (logEl) {
      logEl.innerHTML = logLineas.length > 0
        ? `<ul style="margin:0; padding-left:18px; color:var(--color-danger);">${logLineas.map(l => `<li>${l}</li>`).join('')}</ul>`
        : ''
    }

    if (ok > 0) {
      showToast(`${ok} traslado(s) importado(s) correctamente`, 'success')
      await renderStockZonas()
    }
    if (fallidas > 0 && ok === 0) {
      showToast('No se pudo importar ninguna fila. Revisa el detalle de errores.', 'danger')
    }
  } catch (error) {
    console.error('Error en procesarImportacionTraslados:', error)
    showToast('Error al procesar la importación', 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Procesar Importación' }
  }
}

// ============================================================================
// EDITAR / ELIMINAR TRASLADO INTERNO
// ============================================================================
// Un traslado interno es una sola fila de kardex (tipo_movimiento =
// 'traslado_interno') que movió cantidad de una zona origen a una zona
// destino en stock_ubicaciones. Revertirlo es el inverso exacto de
// guardarTrasladoInterno: restar/eliminar en destino, sumar/crear en origen.
//
// Antes de revertir se valida que la zona destino todavía tenga esa cantidad
// disponible AHORA — si parte de ese stock ya se vendió o se volvió a
// trasladar a una tercera zona después, revertir crearía stock negativo, así
// que se bloquea con un mensaje claro (mismo criterio que eliminarGuia /
// eliminarCompra).
//
// "Editar" no muta el movimiento en sitio: revierte el traslado y reabre el
// modal de Traslado prellenado con los datos anteriores, para que el usuario
// corrija y vuelva a guardar. Esto evita recalcular deltas contra un stock
// que pudo haber cambiado, y es consistente con cómo se tratan compras y
// ventas en este sistema (no se editan documentos posteados, se recrean).

async function _revertirTrasladoInterno(mov) {
  const stockList = await getStockUbicaciones()
  const cantidad = parseFloat(mov.cantidad_salida || 0)
  const unidades = parseFloat(mov.cantidad_unidades_salida || 0)

  const destino = stockList.find(s => s.lote_id === mov.lote_id && s.ubicacion_id === mov.ubicacion_destino_id)
  const disponibleDestino = parseFloat(destino?.cantidad || 0)
  const disponibleUnidDestino = parseFloat(destino?.cantidad_unidades || 0)

  if (disponibleDestino < cantidad) {
    throw new Error(`No se puede revertir: en la zona destino solo quedan ${disponibleDestino.toLocaleString('en-US', { maximumFractionDigits: 2 })} unidades de este lote (se trasladaron ${cantidad.toLocaleString('en-US', { maximumFractionDigits: 2 })}). Parte de ese stock ya se vendió o se volvió a trasladar desde ahí.`)
  }

  // Restar (o eliminar) la fila de destino
  const restanteDestino = parseFloat((disponibleDestino - cantidad).toFixed(4))
  const restanteUnidDestino = Math.max(0, parseFloat((disponibleUnidDestino - unidades).toFixed(4)))
  if (restanteDestino <= 0) {
    await deleteStockUbicacion(destino.id)
  } else {
    await updateStockUbicacion(destino.id, { cantidad: restanteDestino, cantidad_unidades: restanteUnidDestino })
  }

  // Sumar (o crear) la fila de origen
  const origen = stockList.find(s => s.lote_id === mov.lote_id && s.ubicacion_id === mov.ubicacion_origen_id)
  let origenStockId
  if (origen) {
    const nuevaCantidadOrigen = parseFloat(((parseFloat(origen.cantidad) || 0) + cantidad).toFixed(4))
    const nuevaUnidadesOrigen = parseFloat(((parseFloat(origen.cantidad_unidades) || 0) + unidades).toFixed(4))
    await updateStockUbicacion(origen.id, { cantidad: nuevaCantidadOrigen, cantidad_unidades: nuevaUnidadesOrigen })
    origenStockId = origen.id
  } else {
    const nuevo = await addStockUbicacion({ lote_id: mov.lote_id, ubicacion_id: mov.ubicacion_origen_id, cantidad, cantidad_unidades: unidades })
    origenStockId = nuevo.id
  }

  await deleteKardexMovimiento(mov.id)
  return { origenStockId }
}

window.eliminarTrasladoInterno = async function (kardexId) {
  if (!confirm('¿Eliminar este traslado interno? El stock trasladado se devolverá a la zona de origen.')) return
  try {
    const mov = await getKardexById(kardexId)
    if (!mov) { showToast('No se encontró el movimiento', 'danger'); return }
    if (mov.tipo_movimiento !== 'traslado_interno') {
      showToast('Solo se pueden eliminar traslados internos desde aquí', 'warning')
      return
    }

    await _revertirTrasladoInterno(mov)

    showToast('Traslado eliminado y stock devuelto a la zona de origen', 'success')
    await renderStockZonas()
    if (document.getElementById('kardexItemSelect')?.value) await window.cargarKardex()
  } catch (error) {
    console.error('Error en eliminarTrasladoInterno:', error)
    showToast(error.message || 'Error al eliminar el traslado', 'danger')
  }
}

window.editarTrasladoInterno = async function (kardexId) {
  if (!confirm('Para editar, el traslado se eliminará (devolviendo el stock a origen) y se abrirá el formulario con los datos anteriores para que los corrijas y lo guardes de nuevo. ¿Continuar?')) return
  try {
    const mov = await getKardexById(kardexId)
    if (!mov) { showToast('No se encontró el movimiento', 'danger'); return }
    if (mov.tipo_movimiento !== 'traslado_interno') {
      showToast('Solo se pueden editar traslados internos desde aquí', 'warning')
      return
    }

    const datosPrevios = {
      cantidad:             parseFloat(mov.cantidad_salida || 0),
      cantidadUnidades:     parseFloat(mov.cantidad_unidades_salida || 0),
      zonaOrigenId:         mov.ubicacion_origen_id,
      zonaDestinoId:        mov.ubicacion_destino_id,
      fecha:                mov.fecha,
      descripcion:          mov.descripcion || '',
      documentoReferencia:  mov.documento_referencia || ''
    }

    const lote = await getLoteById(mov.lote_id)
    const item = lote ? await getItemById(lote.item_id) : null

    await _revertirTrasladoInterno(mov)

    showToast('Traslado revertido. Corrige los datos y guarda de nuevo.', 'success')
    await renderStockZonas()
    if (document.getElementById('kardexItemSelect')?.value) await window.cargarKardex()

    // Reabre el modal multi-línea con la cabecera prellenada y esta línea ya
    // cargada (revertida), lista para ajustar cantidad/zona/lote si hace falta.
    await window.abrirModalNuevoTraslado(datosPrevios.zonaOrigenId)
    document.getElementById('tiZonaDestino').value = datosPrevios.zonaDestinoId
    if (datosPrevios.fecha) document.getElementById('tiFecha').value = datosPrevios.fecha
    document.getElementById('tiDescripcion').value = datosPrevios.descripcion
    document.getElementById('tiDocumentoReferencia').value = datosPrevios.documentoReferencia

    _detallesTrasladoEnCreacion.push({
      item_id: lote?.item_id || null,
      item_nombre: item?.nombre || `Item #${lote?.item_id ?? '?'}`,
      lote_id: mov.lote_id,
      numero_lote: lote?.numero_lote || '-',
      cantidad: datosPrevios.cantidad,
      cantidad_unidades: datosPrevios.cantidadUnidades
    })
    _renderTablaDetalleTraslado()
  } catch (error) {
    console.error('Error en editarTrasladoInterno:', error)
    showToast(error.message || 'Error al editar el traslado', 'danger')
  }
}
// ============================================================================
// REPORTES GERENCIALES DE INVENTARIO — Fase 2
// ============================================================================
// Se arman sobre lotes, stock por ubicación y kardex, cruzando con el catálogo
// (producto, categoría, marca, partida). Todo pasa por data-cache.js para que
// mover un filtro no vuelva a consultar Supabase.

const _repInvListos = {}

async function construirReporteInv(panelId) {
  if (_repInvListos[panelId]) return
  _repInvListos[panelId] = true
  const cont = document.getElementById(panelId)
  if (cont) cont.innerHTML = '<div class="card"><p class="reporte-vacio">Calculando reporte…</p></div>'

  try {
    const [items, lotes, categorias, marcas, partidas, stockUbic, ubicaciones, almacenes] = await Promise.all([
      cacheado('items', getItems),
      cacheado('lotes', getLotes),
      cacheado('categorias', getCategorias),
      cacheado('marcas', getMarcas),
      cacheado('partidas', getPartidas),
      cacheado('stock_ubicaciones', getStockUbicaciones),
      cacheado('ubicaciones', getUbicaciones),
      cacheado('almacenes', getAlmacenes)
    ])

    const itemMap = {};      (items || []).forEach(i => { itemMap[i.id] = i })
    const catMap = {};       (categorias || []).forEach(c => { catMap[c.id] = c.nombre })
    const marcaMap = {};     (marcas || []).forEach(m => { marcaMap[m.id] = m.nombre })
    const partidaMap = {};   (partidas || []).forEach(p => { partidaMap[p.item_id] = p.codigo || p.partida || p.nombre })
    const almMap = {};       (almacenes || []).forEach(a => { almMap[a.id] = a.nombre })
    const ubicMap = {};      (ubicaciones || []).forEach(u => { ubicMap[u.id] = u })

    const _prod = (id) => itemMap[id]?.nombre || `Item ${id}`

    // Una fila por lote: es el grano natural del costeo por identificación específica.
    const filasLotes = (lotes || []).map(l => {
      const it = itemMap[l.item_id] || {}
      const cant = parseFloat(l.cantidad) || 0
      const costo = parseFloat(l.costo_unitario) || 0
      return {
        producto: _prod(l.item_id),
        sku: it.sku || '—',
        categoria: catMap[it.categoria_id] || '(sin categoría)',
        marca: marcaMap[it.marca_id] || '(sin marca)',
        partida: partidaMap[l.item_id] || '(sin partida)',
        lote: l.numero_lote || `#${l.id}`,
        estado_stock: cant <= 0 ? '3 · Agotado' : (cant <= (parseFloat(getModuloConfig('inventario').stockCritico) || 5) ? '1 · Crítico' : '2 · Normal'),
        fecha_ingreso: l.fecha_ingreso || l.created_at?.slice(0, 10) || '',
        mes_ingreso: nombreMes((l.fecha_ingreso || l.created_at || '').slice(0, 7)),
        cantidad: cant,
        costo_unitario: costo,
        valor: parseFloat((cant * costo).toFixed(2))
      }
    })

    if (panelId === 'repi-valorizacion') {
      crearReporte('repi-valorizacion', {
        id: 'repi-valorizacion',
        titulo: 'Valorización del inventario',
        descripcion: 'Cuánto dinero hay parado en stock. Agrupa por categoría, marca, partida o producto para ver dónde está concentrado.',
        datos: filasLotes,
        dimensiones: [
          { key: 'categoria', label: 'Categoría' }, { key: 'marca', label: 'Marca' },
          { key: 'producto', label: 'Producto' }, { key: 'partida', label: 'Partida' },
          { key: 'estado_stock', label: 'Estado' }
        ],
        medidas: [
          { key: 'cantidad', label: 'Cantidad', agg: 'sum', formato: 'qty' },
          { key: 'valor', label: 'Valor', agg: 'sum', formato: 'money' },
          { key: 'costo_unitario', label: 'Costo unit. prom.', agg: 'avg', formato: 'money4' }
        ],
        filtros: [
          { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['producto', 'sku', 'lote'], placeholder: 'Producto, SKU o lote...' },
          { key: 'categoria', label: 'Categoría', tipo: 'select', opciones: Array.from(new Set(filasLotes.map(f => f.categoria))).sort() },
          { key: 'estado_stock', label: 'Estado', tipo: 'select', opciones: ['1 · Crítico', '2 · Normal', '3 · Agotado'] }
        ],
        agruparPorDefecto: ['categoria'],
        kpis: (f) => [
          { label: 'Valor total', valor: f.reduce((s, x) => s + x.valor, 0), formato: 'money', color: 'var(--color-success)' },
          { label: 'Unidades', valor: f.reduce((s, x) => s + x.cantidad, 0), formato: 'qty' },
          { label: 'Lotes', valor: f.length, formato: 'int' },
          { label: 'Productos distintos', valor: new Set(f.map(x => x.producto)).size, formato: 'int' }
        ]
      })
    }

    if (panelId === 'repi-lotes') {
      // Grano por ubicación física: dónde está cada lote y cuánto hay ahí.
      const filasUbic = (stockUbic || []).map(su => {
        const l = (lotes || []).find(x => x.id === su.lote_id) || {}
        const it = itemMap[l.item_id] || {}
        const u  = ubicMap[su.ubicacion_id] || {}
        const cant = parseFloat(su.cantidad) || 0
        const costo = parseFloat(l.costo_unitario) || 0
        return {
          almacen: almMap[u.almacen_id] || '(sin almacén)',
          zona: u.nombre || u.codigo || `Ubic. ${su.ubicacion_id}`,
          producto: _prod(l.item_id),
          sku: it.sku || '—',
          lote: l.numero_lote || `#${su.lote_id}`,
          categoria: catMap[it.categoria_id] || '(sin categoría)',
          cantidad: cant,
          valor: parseFloat((cant * costo).toFixed(2))
        }
      })

      crearReporte('repi-lotes', {
        id: 'repi-lotes',
        titulo: 'Stock por lote y ubicación',
        descripcion: 'Dónde está físicamente cada lote. Sirve para preparar despachos y para el conteo cíclico.',
        datos: filasUbic,
        dimensiones: [
          { key: 'almacen', label: 'Almacén' }, { key: 'zona', label: 'Zona' },
          { key: 'producto', label: 'Producto' }, { key: 'lote', label: 'Lote' },
          { key: 'categoria', label: 'Categoría' }
        ],
        medidas: [
          { key: 'cantidad', label: 'Cantidad', agg: 'sum', formato: 'qty' },
          { key: 'valor', label: 'Valor', agg: 'sum', formato: 'money' }
        ],
        filtros: [
          { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['producto', 'sku', 'lote', 'zona'], placeholder: 'Producto, lote o zona...' },
          { key: 'almacen', label: 'Almacén', tipo: 'select', opciones: Array.from(new Set(filasUbic.map(f => f.almacen))).sort() }
        ],
        agruparPorDefecto: ['almacen', 'zona'],
        kpis: (f) => [
          { label: 'Unidades ubicadas', valor: f.reduce((s, x) => s + x.cantidad, 0), formato: 'qty' },
          { label: 'Valor ubicado', valor: f.reduce((s, x) => s + x.valor, 0), formato: 'money' },
          { label: 'Ubicaciones con stock', valor: new Set(f.map(x => `${x.almacen}|${x.zona}`)).size, formato: 'int' }
        ]
      })
    }

    if (panelId === 'repi-rotacion' || panelId === 'repi-kardex') {
      const kardex = await cacheado('kardex', getKardex)
      const filasK = (kardex || []).map(k => {
        const it = itemMap[k.item_id] || {}
        const entrada = parseFloat(k.cantidad_entrada || 0) || 0
        const salida  = parseFloat(k.cantidad_salida || 0) || 0
        return {
          producto: _prod(k.item_id),
          sku: it.sku || '—',
          categoria: catMap[it.categoria_id] || '(sin categoría)',
          tipo: k.tipo_movimiento || k.tipo || '(sin tipo)',
          mes: nombreMes((k.fecha || '').slice(0, 7)),
          fecha: k.fecha || '',
          entrada, salida,
          valor_entrada: parseFloat(k.valor_entrada || 0) || 0,
          valor_salida: parseFloat(k.valor_salida || 0) || 0,
          neto: entrada - salida
        }
      })

      if (panelId === 'repi-kardex') {
        crearReporte('repi-kardex', {
          id: 'repi-kardex',
          titulo: 'Kardex resumido (valorizado)',
          descripcion: 'Entradas y salidas por producto, tipo de movimiento y mes, con su valorización.',
          datos: filasK,
          dimensiones: [
            { key: 'mes', label: 'Mes' }, { key: 'producto', label: 'Producto' },
            { key: 'tipo', label: 'Tipo de movimiento' }, { key: 'categoria', label: 'Categoría' }
          ],
          medidas: [
            { key: 'entrada', label: 'Entradas (cant.)', agg: 'sum', formato: 'qty' },
            { key: 'salida', label: 'Salidas (cant.)', agg: 'sum', formato: 'qty' },
            { key: 'valor_entrada', label: 'Valor entradas', agg: 'sum', formato: 'money' },
            { key: 'valor_salida', label: 'Valor salidas', agg: 'sum', formato: 'money' },
            { key: 'neto', label: 'Neto (cant.)', agg: 'sum', formato: 'qty', semaforo: true }
          ],
          filtros: [
            { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['producto', 'sku'], placeholder: 'Producto o SKU...' },
            { key: 'tipo', label: 'Tipo', tipo: 'select', opciones: Array.from(new Set(filasK.map(f => f.tipo))).sort() },
            { key: 'rango', label: 'Fecha', tipo: 'rango', campo: 'fecha' }
          ],
          agruparPorDefecto: ['mes'], orden: { key: '_etiqueta', dir: 'asc' },
          medidasPorDefecto: ['entrada', 'salida', 'valor_salida']
        })
      }

      if (panelId === 'repi-rotacion') {
        // Rotación: compara lo que salió en el período contra el stock actual.
        // Un índice bajo con mucho stock = capital inmovilizado.
        const salidaPorProducto = {}
        filasK.forEach(k => {
          salidaPorProducto[k.producto] = (salidaPorProducto[k.producto] || 0) + k.salida
        })
        const stockPorProducto = {}
        const valorPorProducto = {}
        const ultimaSalida = {}
        filasLotes.forEach(l => {
          stockPorProducto[l.producto] = (stockPorProducto[l.producto] || 0) + l.cantidad
          valorPorProducto[l.producto] = (valorPorProducto[l.producto] || 0) + l.valor
        })
        filasK.filter(k => k.salida > 0).forEach(k => {
          if (!ultimaSalida[k.producto] || k.fecha > ultimaSalida[k.producto]) ultimaSalida[k.producto] = k.fecha
        })

        const hoy = new Date()
        const datos = Object.keys({ ...stockPorProducto, ...salidaPorProducto }).map(prod => {
          const stock = stockPorProducto[prod] || 0
          const salidas = salidaPorProducto[prod] || 0
          const ult = ultimaSalida[prod] || ''
          const diasSinVender = ult ? Math.floor((hoy - new Date(ult + 'T00:00:00')) / 86400000) : null
          return {
            producto: prod,
            estado: salidas === 0 ? '1 · Sin movimiento nunca'
                  : diasSinVender > 180 ? '2 · Más de 180 días sin salir'
                  : diasSinVender > 90  ? '3 · 90-180 días sin salir'
                  : '4 · Con rotación',
            ultima_salida: ult || '(nunca)',
            stock, salidas,
            valor_inmovilizado: salidas === 0 ? (valorPorProducto[prod] || 0) : 0,
            valor: valorPorProducto[prod] || 0,
            rotacion: stock > 0 ? parseFloat((salidas / stock).toFixed(2)) : 0
          }
        })

        crearReporte('repi-rotacion', {
          id: 'repi-rotacion',
          titulo: 'Rotación y stock sin movimiento',
          descripcion: 'Detecta capital inmovilizado: productos con stock que no salen hace mucho, o que nunca han salido.',
          datos,
          dimensiones: [{ key: 'estado', label: 'Estado de rotación' }, { key: 'producto', label: 'Producto' }],
          medidas: [
            { key: 'stock', label: 'Stock actual', agg: 'sum', formato: 'qty' },
            { key: 'salidas', label: 'Salidas históricas', agg: 'sum', formato: 'qty' },
            { key: 'valor', label: 'Valor en stock', agg: 'sum', formato: 'money' },
            { key: 'valor_inmovilizado', label: 'Valor inmovilizado', agg: 'sum', formato: 'money' },
            { key: 'rotacion', label: 'Índice rotación', agg: 'avg', formato: 'money' }
          ],
          filtros: [
            { key: 'producto', label: 'Producto', tipo: 'texto', campos: ['producto'], placeholder: 'Buscar...' },
            { key: 'estado', label: 'Estado', tipo: 'select', opciones: ['1 · Sin movimiento nunca', '2 · Más de 180 días sin salir', '3 · 90-180 días sin salir', '4 · Con rotación'] }
          ],
          agruparPorDefecto: ['estado'], orden: { key: '_etiqueta', dir: 'asc' },
          medidasPorDefecto: ['stock', 'salidas', 'valor'],
          kpis: (f) => {
            const muertos = f.filter(x => x.estado.startsWith('1') || x.estado.startsWith('2'))
            return [
              { label: 'Valor en stock', valor: f.reduce((s, x) => s + x.valor, 0), formato: 'money' },
              { label: 'Productos sin rotar', valor: muertos.length, formato: 'int', color: 'var(--color-danger)' },
              { label: 'Capital inmovilizado', valor: muertos.reduce((s, x) => s + x.valor, 0), formato: 'money', color: 'var(--color-danger)' }
            ]
          }
        })
      }
    }
  } catch (e) {
    console.error('construirReporteInv:', e)
    _repInvListos[panelId] = false
    if (cont) cont.innerHTML = `<div class="card"><p class="reporte-vacio">No se pudo construir el reporte: ${e.message}</p></div>`
  }
}

// ============================================================================
// AJUSTE DE INVENTARIO (KARDEX) — botón que estaba sin implementar
// ============================================================================
// El modal `modal-ajuste-kardex` existía en el HTML pero sus dos funciones
// nunca se escribieron, así que ambos botones lanzaban TypeError.
//
// Un ajuste corrige una diferencia entre el stock del sistema y el conteo
// físico. Como el costeo es por identificación específica, el ajuste se aplica
// SIEMPRE contra un lote concreto: sin lote no se sabría a qué costo entra o
// sale la mercadería. Por eso el selector muestra lotes, no solo productos.

window.abrirModalAjusteKardex = async function () {
  try {
    const [lotes, items] = await Promise.all([getLotes(), getItems()])
    const itemMap = {}
    items.forEach(i => { itemMap[i.id] = i })

    const sel = document.getElementById('ajusteKardexItem')
    if (sel) {
      const conStock = lotes
        .filter(l => l.item_id)
        .sort((a, b) => (itemMap[a.item_id]?.nombre || '').localeCompare(itemMap[b.item_id]?.nombre || ''))
      sel.innerHTML = '<option value="">-- Selecciona lote --</option>' + conStock.map(l => {
        const it = itemMap[l.item_id]
        return `<option value="${l.id}" data-costo="${l.costo_unitario || 0}">${(it?.nombre || 'Item ' + l.item_id)} · Lote ${l.numero_lote || l.id} (stock ${parseFloat(l.cantidad || 0)})</option>`
      }).join('')

      // Precargar el costo del lote elegido: en un ajuste de entrada casi
      // siempre se usa el mismo costo que ya tiene el lote.
      sel.onchange = () => {
        const costo = sel.selectedOptions[0]?.getAttribute('data-costo')
        const inp = document.getElementById('ajusteKardexCosto')
        if (inp && costo) inp.value = parseFloat(costo).toFixed(4)
      }
    }

    const fecha = document.getElementById('ajusteKardexFecha')
    if (fecha) fecha.value = new Date().toISOString().split('T')[0]
    ;['ajusteKardexCant', 'ajusteKardexConcepto'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = ''
    })

    window.openModal('modal-ajuste-kardex')
  } catch (e) {
    console.error('abrirModalAjusteKardex:', e)
    showToast('Error al abrir el ajuste: ' + e.message, 'danger')
  }
}

window.guardarAjusteKardex = async function () {
  try {
    const loteId   = parseInt(document.getElementById('ajusteKardexItem')?.value || 0)
    const tipo     = document.getElementById('ajusteKardexTipo')?.value
    const fecha    = document.getElementById('ajusteKardexFecha')?.value
    const cantidad = parseFloat(document.getElementById('ajusteKardexCant')?.value || 0)
    const costo    = parseFloat(document.getElementById('ajusteKardexCosto')?.value || 0)
    const concepto = document.getElementById('ajusteKardexConcepto')?.value?.trim()

    if (!loteId)       { showToast('Selecciona el lote a ajustar', 'warning'); return }
    if (!fecha)        { showToast('Ingresa la fecha del ajuste', 'warning'); return }
    if (cantidad <= 0) { showToast('La cantidad debe ser mayor a 0', 'warning'); return }
    if (!concepto)     { showToast('Indica el motivo del ajuste (queda registrado en el kardex)', 'warning'); return }

    const lote = await getLoteById(loteId)
    if (!lote) { showToast('Lote no encontrado', 'danger'); return }

    const esEntrada = tipo === 'ajuste_entrada'
    const stockActual = parseFloat(lote.cantidad || 0)

    if (!esEntrada && cantidad > stockActual + 0.0001) {
      showToast(`No puedes retirar ${cantidad}: el lote solo tiene ${stockActual}`, 'warning')
      return
    }

    const nuevaCantidad = parseFloat((esEntrada ? stockActual + cantidad : stockActual - cantidad).toFixed(4))
    const costoUnitario = costo > 0 ? costo : (parseFloat(lote.costo_unitario) || 0)
    const valor = parseFloat((cantidad * costoUnitario).toFixed(2))

    const user = await getCurrentUser()

    await addKardexMovimiento({
      item_id:              lote.item_id,
      lote_id:              lote.id,
      fecha,
      tipo_movimiento:      tipo,
      concepto,
      descripcion:          `Ajuste de inventario — lote ${lote.numero_lote || lote.id}`,
      documento_referencia: `AJUSTE-${new Date().toISOString().slice(0, 10)}`,
      cantidad_entrada:     esEntrada ? cantidad : 0,
      cantidad_salida:      esEntrada ? 0 : cantidad,
      costo_unitario:       costoUnitario,
      valor_entrada:        esEntrada ? valor : 0,
      valor_salida:         esEntrada ? 0 : valor,
      created_by:           user?.db_id || null
    })

    await updateLote(lote.id, { cantidad: nuevaCantidad })

    showToast(`Ajuste registrado ✅ — el lote pasó de ${stockActual} a ${nuevaCantidad}`, 'success')
    window.closeModal('modal-ajuste-kardex')

    // El ajuste altera stock y valorización: hay que invalidar el caché para
    // que los reportes gerenciales no muestren las cifras anteriores.
    _invalidarCacheInventario()
    await renderKardex()
  } catch (e) {
    console.error('guardarAjusteKardex:', e)
    showToast('Error al guardar el ajuste: ' + e.message, 'danger')
  }
}

function _invalidarCacheInventario() {
  import('./data-cache.js').then(({ invalidarVarios }) => {
    invalidarVarios(['lotes', 'kardex', 'stock_ubicaciones', 'items'])
  }).catch(() => {})
  Object.keys(_repInvListos).forEach(k => { _repInvListos[k] = false })
}

function _escInv(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
