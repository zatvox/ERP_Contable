// ============================================================================
// PRODUCTS-WEB.JS - UI, renderizado y flujo de cotización JHIRO Web
// Importa funciones de datos desde web-data.js
// Ruta: assets/js/products-web.js
// ============================================================================

import {
  initCtx, getProductos, getProductoById, getCategorias, crearCotizacion, getClienteByRuc,
  subirComprobante, calcularTotalesCarrito, validarRUC, formatCurrency, formatDate, carritoKey,
} from './web-data.js'

// ============================================================================
// IMÁGENES — soporta thumbnail_url como string o array ["url1","url2",...]
// ============================================================================

export function getImagenes(thumbnailUrl) {
  if (Array.isArray(thumbnailUrl)) {
    return thumbnailUrl.length ? thumbnailUrl : ['assets/images/placeholder.png']
  }
  if (typeof thumbnailUrl === 'string' && thumbnailUrl.trim().startsWith('[')) {
    try {
      const arr = JSON.parse(thumbnailUrl)
      if (Array.isArray(arr) && arr.length) return arr
    } catch { /* no-op */ }
  }
  return [thumbnailUrl || 'assets/images/placeholder.png']
}

// ============================================================================
// ESTADO GLOBAL DE LA UI
// ============================================================================

const state = {
  productos:  [],
  categorias: [],
  filtros: {
    categoria:      'Todos',
    disponibilidad: 'all',
    busqueda:       '',
  },
}

// ============================================================================
// CARRITO EN sessionStorage
// ============================================================================


function guardarCarrito(lineas) {
  sessionStorage.setItem(carritoKey(), JSON.stringify(lineas))
}

export function recuperarCarrito() {
  try { return JSON.parse(sessionStorage.getItem(carritoKey()) || '[]') }
  catch { return [] }
}

export function limpiarCarrito() {
  sessionStorage.removeItem(carritoKey())
}

/**
 * Agregar o actualizar un producto en el carrito
 * @param {object} producto  Fila completa de productosPaginaWeb
 * @param {number} cantidadKg
 * @param {number} pesoxcaja
 * @param {number} precioUnitario  S/. por kg (0 si precio a consultar)
 */
export function agregarAlCarrito(producto, cantidadKg, pesoxcaja, precioUnitario = 0) {
  const carrito = recuperarCarrito()
  const idx = carrito.findIndex(l => l.producto_id === producto.id)
  const linea = {
    producto_id:          producto.id,
    producto_nombre:      producto.nombre,
    producto_categoria:   producto.categoria,
    precio_moneda:        producto.precio_moneda || 'PEN',
    color_nombre:         producto.color_nombre  || '',
    cantidad_kg:          parseFloat(cantidadKg),
    precio_unitario_pen:  parseFloat(precioUnitario),
    peso_x_caja:          parseFloat(pesoxcaja),
    descuento_pct:        0,
  }
  if (idx >= 0) { carrito[idx] = linea } else { carrito.push(linea) }
  guardarCarrito(carrito)
  actualizarContadorCarrito()
  return carrito
}

export function eliminarDelCarrito(productoId) {
  const carrito = recuperarCarrito().filter(l => l.producto_id !== productoId)
  guardarCarrito(carrito)
  actualizarContadorCarrito()
  return carrito
}

function actualizarContadorCarrito() {
  const carrito = recuperarCarrito()
  const badge = document.getElementById('carrito-count')
  if (badge) {
    const numElement = document.getElementById('carrito-count-number')
    if (numElement) {
      numElement.textContent = carrito.length
    }
    badge.style.display = carrito.length > 0 ? 'flex' : 'none'
  }
}

// ============================================================================
// RENDERIZADO — SIDEBAR DE CATEGORÍAS
// ============================================================================

function renderSidebar() {
  const ul = document.getElementById('sidebar-categories')
  if (!ul) return

  const items = [
    { categoria: 'Todos', total: state.productos.length },
    ...state.categorias,
  ]

  ul.innerHTML = items.map(({ categoria, total }) => `
    <li>
      <button
        class="sidebar-cat-btn${state.filtros.categoria === categoria ? ' active' : ''}"
        data-cat="${categoria}">
        ${categoria}
        <span class="sidebar-cat-count">${total}</span>
      </button>
    </li>
  `).join('')

  ul.querySelectorAll('.sidebar-cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.filtros.categoria = btn.dataset.cat
      renderSidebar()
      cargarYRenderProductos()
      
      // Cerrar sidebar en móvil al seleccionar categoría
      if (window.matchMedia('(max-width: 900px)').matches) {
        document.getElementById('products-sidebar')?.classList.remove('sidebar-open')
      }

    })
  })

  // Botones de disponibilidad
  document.querySelectorAll('.sidebar-avail-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.avail === state.filtros.disponibilidad)
    // Evitar duplicar listeners — clonar y reemplazar
    const clone = btn.cloneNode(true)
    btn.parentNode.replaceChild(clone, btn)
    clone.addEventListener('click', () => {
      state.filtros.disponibilidad = clone.dataset.avail
      document.querySelectorAll('.sidebar-avail-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.avail === state.filtros.disponibilidad)
      )
      cargarYRenderProductos()
    })
  })
}

// ============================================================================
// RENDERIZADO — GRILLA DE TARJETAS
// ============================================================================

function renderProductos(productos) {
  const grid    = document.getElementById('products-list')
  const loading = document.getElementById('products-loading')
  const count   = document.getElementById('products-count')
  if (!grid) return

  if (loading) loading.style.display = 'none'
  grid.style.display = 'grid'

  if (count) {
    count.textContent = `${productos.length} producto${productos.length !== 1 ? 's' : ''}`
  }

  if (productos.length === 0) {
    grid.innerHTML = `
      <div class="no-results">
        <h3>No se encontraron productos</h3>
        <p>Intenta ajustar la categoría o el término de búsqueda. Si eres del equipo, publica artículos en Panel CRM → Catálogo.</p>
      </div>`
    return
  }

  grid.innerHTML = productos.map((p, i) => {
    const esAgotado   = p.disponibilidad === 'Agotado'
    const esLimitado  = p.disponibilidad?.includes('limitado')
    const badgeClass  = esAgotado ? 'pcard__badge--out' : esLimitado ? 'pcard__badge--limited' : 'pcard__badge--stock'
    const badgeText   = esAgotado ? 'Agotado' : esLimitado ? 'Stock limitado' : 'En stock'
    const colorHex    = p.color_hex    || '#888888'
    const colorNombre = p.color_nombre || ''

    const precioHtml = p.precio_referencia
      ? `<div class="pcard__price">
           <span class="pcard__price-label">Precio ref.</span>
           ${formatCurrency(p.precio_referencia, p.precio_moneda)} x kg
         </div>`
      : `<div class="pcard__price pcard__price--consult">Consultar precio</div>`

    return `
      <a class="pcard"
         href="producto.html?id=${encodeURIComponent(p.id)}"
         style="animation-delay:${i * 0.04}s"
         aria-label="Ver detalle de ${p.nombre}">
        <div class="pcard__thumb">
          ${(() => {
            const imagenes = getImagenes(p.thumbnail_url)
            if (imagenes.length <= 1) {
              return `
                <img
                  src="${imagenes[0]}"
                  alt="${p.nombre}"
                  loading="lazy"
                  onerror="this.src='assets/images/placeholder.png'">
              `
            }
            return `
              <div class="pcard__carousel" data-idx="0">
                ${imagenes.map((img, idx) => `
                  <img
                    src="${img}"
                    alt="${p.nombre}"
                    loading="lazy"
                    class="pcard__carousel-img${idx === 0 ? ' active' : ''}"
                    onerror="this.src='assets/images/placeholder.png'">
                `).join('')}
                <button class="pcard__carousel-arrow pcard__carousel-arrow--prev" aria-label="Imagen anterior">‹</button>
                <button class="pcard__carousel-arrow pcard__carousel-arrow--next" aria-label="Imagen siguiente">›</button>
                <div class="pcard__carousel-dots">
                  ${imagenes.map((_, idx) => `<span class="pcard__dot${idx === 0 ? ' active' : ''}" data-idx="${idx}"></span>`).join('')}
                </div>
              </div>
            `
          })()}
          <span class="pcard__badge ${badgeClass}">${badgeText}</span>
        </div>
        <div class="pcard__body">
          <span class="pcard__category">${p.categoria}</span>
          <h3 class="pcard__name">${p.nombre}</h3>
          <p class="pcard__moq">MOQ: <strong>${p.peso_caja_kg || '—'} kg</strong></p>
          <div class="pcard__colors">
            <span class="pcard__color-swatch"
                  style="background:${colorHex}"
                  title="${colorNombre}"></span>
            <span class="pcard__color-label">
              ${colorNombre}${p.color_no ? ' · ' + p.color_no : ''}
            </span>
          </div>
          <div class="pcard__footer">
            ${precioHtml}
            <span class="pcard__cta">Ver detalle →</span>
          </div>
        </div>
      </a>
    `
  }).join('')
}

// ============================================================================
// CARRUSELES DE IMÁGENES EN TARJETAS
// ============================================================================

function inicializarCarruseles() {
  document.querySelectorAll('.pcard__carousel').forEach(carousel => {
    const imgs = carousel.querySelectorAll('.pcard__carousel-img')
    const dots = carousel.querySelectorAll('.pcard__dot')
    const prev = carousel.querySelector('.pcard__carousel-arrow--prev')
    const next = carousel.querySelector('.pcard__carousel-arrow--next')

    function mostrar(idx) {
      imgs.forEach((img, i) => img.classList.toggle('active', i === idx))
      dots.forEach((dot, i) => dot.classList.toggle('active', i === idx))
      carousel.dataset.idx = idx
    }

    prev?.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation()
      mostrar((parseInt(carousel.dataset.idx) - 1 + imgs.length) % imgs.length)
    })
    next?.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation()
      mostrar((parseInt(carousel.dataset.idx) + 1) % imgs.length)
    })
    dots.forEach(dot => {
      dot.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation()
        mostrar(parseInt(dot.dataset.idx))
      })
    })
  })
}

// ============================================================================
// FLUJO PRINCIPAL — CARGA + FILTRO
// ============================================================================

async function cargarYRenderProductos(silencioso = false) {
  const loading = document.getElementById('products-loading')
  const grid    = document.getElementById('products-list')

  if (loading && !silencioso) { loading.style.display = 'flex' }
  if (grid && !silencioso)    { grid.style.display = 'none' }

  const productos = await getProductos(state.filtros, silencioso)

  // Filtro de búsqueda local sobre los resultados (backup al ilike de Supabase)
  const q = state.filtros.busqueda.toLowerCase().trim()
  const filtrados = q
    ? productos.filter(p =>
        p.nombre?.toLowerCase().includes(q) ||
        p.descripcion?.toLowerCase().includes(q) ||
        p.categoria?.toLowerCase().includes(q) ||
        (p.tags || []).some(t => t.toLowerCase().includes(q))
      )
    : productos

  state.productos = filtrados
  renderProductos(filtrados)
  inicializarCarruseles()
}

async function inicializarSidebar() {
  state.categorias = await getCategorias()
  renderSidebar()
}

// ============================================================================
// FLUJO DE COTIZACIÓN
// ============================================================================

/**
 * Procesar cotización completa:
 * Registro cliente → cotización → líneas de detalle → comprobante (opcional)
 *
 * @param {object}   datosCliente  { ruc, razon_social, nombre_contacto, email, telefono, direccion_fiscal, distrito }
 * @param {object}   datosEntrega  { dir_entrega, distrito_entrega, referencia_entrega }
 * @param {File|null} archivoPago  Imagen/PDF de comprobante (opcional)
 * @param {string}   notas
 * @returns {Promise<{ok: boolean, cotizacion: object|null, mensaje: string}>}
 */
export async function procesarCotizacion(datosCliente, datosEntrega, archivoPago = null, notas = '') {
  const carrito = recuperarCarrito()
  if (!carrito.length) return { ok: false, cotizacion: null, mensaje: 'El carrito está vacío.' }
  if (!validarRUC(datosCliente.ruc)) return { ok: false, cotizacion: null, mensaje: 'RUC (11 dígitos) o DNI (8) inválido.' }
  if (!datosCliente.email || !datosCliente.razon_social) return { ok: false, cotizacion: null, mensaje: 'Razón social y email son obligatorios.' }

  // El servidor valida, toma los precios de la BD y numera la cotización.
  const { cotizacion, error } = await crearCotizacion(datosCliente, datosEntrega, carrito, notas)
  if (error) return { ok: false, cotizacion: null, mensaje: error.message || 'Error al crear la cotización.' }

  if (archivoPago) {
    const { error: errPago } = await subirComprobante(cotizacion.id, archivoPago)
    if (errPago) console.warn('[CRM] Comprobante no subido:', errPago.message)
  }
  limpiarCarrito()
  actualizarContadorCarrito()
  return { ok: true, cotizacion, mensaje: `Cotización ${cotizacion.numero_cotizacion} registrada correctamente.` }
}

// ============================================================================
// INICIALIZACIÓN
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // Solo en páginas con grilla de productos
  if (!document.getElementById('products-list')) return
  await initCtx()

  // Sidebar
  await inicializarSidebar()

  // Cargar productos iniciales
  await cargarYRenderProductos()

  // Buscador con debounce
  const input = document.getElementById('product-search')
  if (input) {
    let timer
    input.addEventListener('input', () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        state.filtros.busqueda = input.value
        cargarYRenderProductos()
      }, 300)
    })
  }

  // Toggle sidebar mobile
  const btnFiltros = document.getElementById('btn-show-filters')
  const sidebar    = document.getElementById('products-sidebar')
  const btnCerrar  = document.getElementById('sidebar-toggle-mobile')

  btnFiltros?.addEventListener('click', () => sidebar?.classList.toggle('sidebar-open'))
  btnCerrar?.addEventListener('click',  () => sidebar?.classList.remove('sidebar-open'))

  // Contador del carrito al cargar
  actualizarContadorCarrito()

  // Tiempo real: stock y precios del ERP se refrescan solos
  setInterval(() => { if (!document.hidden) cargarYRenderProductos(true) }, 45000)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) cargarYRenderProductos(true) })
})

// ============================================================================
// EXPONER EN window — para páginas sin módulos (cotizar.html, producto.html)
// ============================================================================

window.JhiroWeb = { getProductos, getProductoById, getCategorias, getImagenes, recuperarCarrito, agregarAlCarrito, eliminarDelCarrito, limpiarCarrito, calcularTotalesCarrito, procesarCotizacion, validarRUC, formatCurrency, formatDate }
