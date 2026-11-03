// ============================================================================
// PRODUCTO-WEB.JS - Detalle de producto y agregar al carrito
// Ruta: assets/js/producto-web.js
// ============================================================================

import { initCtx, getProductoById, formatCurrency, getCategorias, getColoresByCategoria } from './web-data.js'
import { agregarAlCarrito, recuperarCarrito, getImagenes } from './products-web.js'

// ============================================================================
// HELPERS DE UI
// ============================================================================

function getEl(id) { return document.getElementById(id) }

function actualizarContadorCarrito() {
  const badge = getEl('carrito-count')
  if (!badge) return
  const n = recuperarCarrito().length
  const numElement = getEl('carrito-count-number')
  if (numElement) {
    numElement.textContent = n
  }
  badge.style.display = n > 0 ? 'flex' : 'none'
}

function mostrarEstado(estado) {
  // estado: 'loading' | 'error' | 'layout'
  getEl('pd-loading').style.display = estado === 'loading' ? 'flex'  : 'none'
  getEl('pd-error').style.display   = estado === 'error'   ? 'block' : 'none'
  getEl('pd-layout').style.display  = estado === 'layout'  ? 'grid'  : 'none'
}

function mostrarToast(msg) {
  const toast = getEl('pd-toast')
  if (!toast) return
  toast.textContent = msg
  toast.classList.add('show')
  setTimeout(() => toast.classList.remove('show'), 3000)
}

// ============================================================================
// RENDERIZADO DEL PRODUCTO
// ============================================================================

async function renderProducto(p) {
  // Imagen(es) — galería/carrusel
  const imagenes  = getImagenes(p.thumbnail_url)
  const img       = getEl('pd-img')
  const thumbsBox = getEl('pd-gallery-thumbs')
  const btnPrev   = getEl('pd-img-prev')
  const btnNext   = getEl('pd-img-next')
  let idxActual   = 0

  function mostrarImagen(idx) {
    idxActual = idx
    img.src = imagenes[idx]
    img.alt = p.nombre
    img.onerror = () => { img.src = 'assets/images/placeholder.png' }
    thumbsBox?.querySelectorAll('.pd-thumb').forEach((t, i) => t.classList.toggle('active', i === idx))
  }

  if (imagenes.length > 1) {
    if (thumbsBox) {
      thumbsBox.style.display = 'flex'
      thumbsBox.innerHTML = imagenes.map((src, idx) => `
        <button class="pd-thumb${idx === 0 ? ' active' : ''}" data-idx="${idx}" aria-label="Ver imagen ${idx + 1}">
          <img src="${src}" alt="${p.nombre} ${idx + 1}" onerror="this.src='assets/images/placeholder.png'">
        </button>
      `).join('')
      thumbsBox.querySelectorAll('.pd-thumb').forEach(btn => {
        btn.addEventListener('click', () => mostrarImagen(parseInt(btn.dataset.idx)))
      })
    }
    if (btnPrev) {
      btnPrev.style.display = 'flex'
      btnPrev.addEventListener('click', () => mostrarImagen((idxActual - 1 + imagenes.length) % imagenes.length))
    }
    if (btnNext) {
      btnNext.style.display = 'flex'
      btnNext.addEventListener('click', () => mostrarImagen((idxActual + 1) % imagenes.length))
    }
  } else {
    if (thumbsBox) thumbsBox.style.display = 'none'
    if (btnPrev) btnPrev.style.display = 'none'
    if (btnNext) btnNext.style.display = 'none'
  }

  mostrarImagen(0)

  // Badge de disponibilidad
  const badge = getEl('pd-badge')
  const esLimitado = p.disponibilidad?.includes('limitado')
  const esAgotado = p.disponibilidad === 'Agotado'
  badge.textContent = esAgotado ? 'Agotado' : esLimitado ? 'Stock limitado' : 'En stock'
  badge.className = `pd-badge ${esAgotado ? 'pd-badge--out' : esLimitado ? 'pd-badge--limited' : 'pd-badge--stock'}`
  if (esAgotado) { const bt = getEl('pd-btn-agregar'); bt.disabled = true; bt.textContent = 'Agotado por ahora' }

  // Texto básico
  getEl('pd-category').textContent    = p.categoria   || ''
  getEl('pd-name').textContent        = p.nombre      || ''
  getEl('breadcrumb-nombre').textContent = p.nombre   || 'Producto'

  // Color - obtener colores de la categoría
  const label  = getEl('pd-color-label')
  const coloresContainer = getEl('pd-color-row')
  
  try {
    const categorias = await getCategorias()
    const categoria = categorias.find(c => c.nombre === p.categoria)
    const colores = await getColoresByCategoria(categoria?.nombre || p.categoria)

    if (p.color_hex || p.color_nombre) {
      // Mostrar etiqueta del color actual
      label.textContent = [p.color_nombre, p.color_no].filter(Boolean).join(' · ')
      
      // Renderizar todos los colores como swatches clickeables
      const swatchesHTML = colores.map(color => `
        <button 
          class="pd-color-swatch ${color.color_nombre === p.color_nombre ? 'pd-color-swatch--active' : ''}"
          style="background-color: ${color.color_hex || '#888'}"
          title="${color.color_nombre}"
          data-id="${color.id}"
          data-color="${color.color_nombre}"
          aria-label="Color ${color.color_nombre}"
        ></button>
      `).join('')
      
      coloresContainer.innerHTML = swatchesHTML
      coloresContainer.style.display = 'flex'
      
      // Event listeners para cambiar de color
      coloresContainer.querySelectorAll('.pd-color-swatch').forEach(swatch => {
        swatch.addEventListener('click', () => {
          const colorSeleccionado = swatch.dataset.color
          const colorObj = colores.find(c => c.color_nombre === colorSeleccionado)
          if (colorObj) {
            // Actualizar estilos
            coloresContainer.querySelectorAll('.pd-color-swatch').forEach(s => 
              s.classList.remove('pd-color-swatch--active')
            )
            swatch.classList.add('pd-color-swatch--active')
            label.textContent = colorSeleccionado
          }
        })
      })
    } else {
      coloresContainer.style.display = 'none'
    }
  } catch (error) {
    console.error('Error al cargar colores:', error)
    coloresContainer.style.display = 'none'
  }

  // Seleccionamos el contenedor de los colores
  const colorRow = document.getElementById('pd-color-row');

  if (colorRow) {
    colorRow.addEventListener('click', (e) => {
    // Buscamos si el click fue en un círculo de color (swatch)
    const swatch = e.target.closest('.pd-color-swatch');
    
    if (swatch) {
      // Obtenemos el ID que configuraste (usa 'data-id' o 'id' según lo hayas puesto)
      // Si usaste el atributo id de HTML: swatch.id
      // Si usaste data-id: swatch.getAttribute('data-id')
      const productId = swatch.getAttribute('data-id') || swatch.id;
      
      if (productId) {
        // Redirigimos directamente usando el ID exacto
        window.location.href = `producto.html?id=${productId}`;
        } else {
          console.error("No se encontró el ID en el elemento clickeado.");
        }
      }
    });
  }

  // Precio
  const precio = getEl('pd-price')
  if (p.precio_referencia) {
    precio.innerHTML = `${formatCurrency(p.precio_referencia, p.precio_moneda)}<span class="pd-price-per">x kg</span>`
    precio.classList.remove('pd-price--consult')
  } else {
    precio.textContent = 'Consultar precio'
    precio.classList.add('pd-price--consult')
  }

  // Especificaciones técnicas
  const specs = [
    //{ label: 'MOQ',          value: p.moq                ? `${p.moq_kg} kg`  : '—' },
    { label: 'Peso por caja / Conos por caja',value: (p.peso_caja_kg    ? `${p.peso_caja_kg} kg` : '—' ) + (p.conos_por_caja ? ` / ${p.conos_por_caja} conos` : '') },
    //{ label: 'Conos / caja', value: p.conos_por_caja  ? p.conos_por_caja : '—' },
    //{ label: 'Lote ref.',    value: p.lote_referencia || '—' },
  ]
  getEl('pd-specs').innerHTML = specs.map(s => `
    <div class="pd-spec-item">
      <span class="pd-spec-label">${s.label}</span>
      <span class="pd-spec-value">${s.value}</span>
    </div>
  `).join('')

  // Descripción y aplicaciones
  getEl('pd-desc').textContent = p.descripcion || ''
  const aplicSection = getEl('pd-aplic-section')
  if (p.aplicaciones) {
    getEl('pd-aplic').textContent = p.aplicaciones
    aplicSection.style.display = 'block'
  } else {
    aplicSection.style.display = 'none'
  }

  // Cantidad: MOQ kg como mínimo
  const moq = parseFloat(p.peso_caja_kg) || 1
  const inputQtyKg = getEl('pd-cantidad-kg')
  inputQtyKg.min   = moq
  inputQtyKg.step  = moq
  inputQtyKg.value = moq
  getEl('pd-qty-kg-hint').textContent = `MOQ: ${moq} kg`

  // Botones ± cantidad
  getEl('pd-qty-kg-menos').addEventListener('click', () => {
    //Actualizar cantidad kg
    const actualKg = parseFloat(inputQtyKg.value) || moq
    const nuevoKg  = Math.max(moq, actualKg - moq)
    inputQtyKg.value = nuevoKg
    //Actualizar cantidad unidades proporcionalmente
    const actualUnid = parseFloat(inputQtyUnid.value) || 1
    const nuevoUnid  = Math.max(1, actualUnid - 1)
    inputQtyUnid.value = nuevoUnid
  })
  getEl('pd-qty-kg-mas').addEventListener('click', () => {
    //Actualizar cantidad kg
    const actualKg = parseFloat(inputQtyKg.value) || moq
    inputQtyKg.value = actualKg + moq
    //Actualizar cantidad unidades proporcionalmente
    const actualUnid = parseFloat(inputQtyUnid.value) || 1
    inputQtyUnid.value = actualUnid + 1
  })

    // Cantidad: cantidad unidades como mínimo
  const inputQtyUnid = getEl('pd-cantidad-unidades')
  inputQtyUnid.min   = 1
  inputQtyUnid.step  = 1
  inputQtyUnid.value = 1
  //getEl('pd-qty-unidades-hint').textContent = `MOQ: ${moq} unidades`

  // Botones ± cantidad
  getEl('pd-qty-unidades-menos').addEventListener('click', () => {
    //Actualizar cantidad unidades
    const actualUnid = parseFloat(inputQtyUnid.value) || 1
    const nuevoUnid  = Math.max(1, actualUnid - 1)
    inputQtyUnid.value = nuevoUnid
    //Actualizar cantidad kg proporcionalmente
    const actualKg = parseFloat(inputQtyKg.value) || moq
    const nuevoKg  = Math.max(moq, actualKg - moq)
    inputQtyKg.value = nuevoKg
  })
  getEl('pd-qty-unidades-mas').addEventListener('click', () => {
    //Actualizar cantidad unidades
    const actualUnid = parseFloat(inputQtyUnid.value) || 1
    inputQtyUnid.value = actualUnid + 1
    //Actualizar cantidad kg proporcionalmente
    const actualKg = parseFloat(inputQtyKg.value) || moq
    inputQtyKg.value = actualKg + moq
  })

  // Botón agregar al carrito
  getEl('pd-btn-agregar').addEventListener('click', () => {
    const kg     = parseFloat(inputQtyKg.value) || moq
    const precio = parseFloat(p.precio_referencia) || 0
    agregarAlCarrito(p, kg, p.peso_caja_kg, precio)
    actualizarContadorCarrito()
    mostrarToast(`✓ ${p.nombre} agregado a tu cotización`)
    setTimeout(() => { window.location.href = 'cotizar.html' }, 3000)
  })
}

// ============================================================================
// INICIALIZACIÓN
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  await initCtx()
  actualizarContadorCarrito()

  const params = new URLSearchParams(window.location.search)
  const id     = params.get('id')

  if (!id) { mostrarEstado('error'); return }

  mostrarEstado('loading')

  const producto = await getProductoById(id)

  if (!producto) { mostrarEstado('error'); return }

  await renderProducto(producto)
  mostrarEstado('layout')
})
