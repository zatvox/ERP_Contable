// ============================================================================
// COTIZAR-WEB.JS - Flujo de cotización en 3 pasos
// Ruta: assets/js/cotizar-web.js
// ============================================================================

import { initCtx, getCtx, carritoKey, calcularTotalesCarrito, formatCurrency, validarRUC, getClienteByRuc, subirComprobante } from './web-data.js'
import { recuperarCarrito, eliminarDelCarrito, procesarCotizacion } from './products-web.js'

// ============================================================================
// ESTADO LOCAL
// ============================================================================

const MON = () => recuperarCarrito()[0]?.precio_moneda || 'PEN'
const escH = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
let pasoActual = 1
let cotizacionId = null

// ============================================================================
// HELPERS
// ============================================================================

function getEl(id) { return document.getElementById(id) }

function guardarCarritoLocal(lineas) {
  sessionStorage.setItem(carritoKey(), JSON.stringify(lineas))
}

function irAPaso(n) {
  ;[1, 2, 3].forEach(i => {
    const panel = getEl(`panel-${i}`)
    if (panel) panel.style.display = i === n ? 'block' : 'none'
  })
  document.querySelectorAll('.cot-step').forEach(el => {
    const s = parseInt(el.dataset.step)
    el.classList.toggle('active', s === n)
    el.classList.toggle('done',   s < n)
  })
  pasoActual = n
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function mostrarError(msg) {
  const el = getEl('cot-msg-error')
  if (!el) return
  el.textContent = msg
  el.style.display = msg ? 'block' : 'none'
}

// ============================================================================
// PASO 1 — CARRITO
// ============================================================================

function renderCarrito() {
  const carrito = recuperarCarrito()
  const empty   = getEl('cot-empty')
  const wrap    = getEl('cot-tabla-wrap')
  const tbody   = getEl('cot-tbody')

  if (carrito.length === 0) {
    if (empty) empty.style.display = 'flex'
    if (wrap)  wrap.style.display  = 'none'
    return
  }

  if (empty) empty.style.display = 'none'
  if (wrap)  wrap.style.display  = 'block'

  tbody.innerHTML = carrito.map((l, idx) => {
    const subtotal = (l.cantidad_kg || 0) * (l.precio_unitario_pen || 0)
    const precioStr = l.precio_unitario_pen ? formatCurrency(l.precio_unitario_pen, MON()) : 'A consultar'
    const cantidadUnidades = l.cantidad_kg && l.peso_x_caja ? Math.ceil(l.cantidad_kg / l.peso_x_caja) : 0
    const subtotalStr = l.precio_unitario_pen
      ? formatCurrency(subtotal, MON())
      : '—'
    return `
      <tr data-id="${l.producto_id}">
        <td>
          <strong>${l.producto_nombre}</strong>
          <br><small>${l.producto_categoria || ''}</small>
        </td>
        <td>${l.color_nombre || '—'}</td>
        <td class="text-right">${l.peso_x_caja || '—'}</td>
        <td class="text-right">
          <input
            class="ct-qty-input"
            type="number"
            value="${l.cantidad_kg}"
            min="1"
            step="1"
            data-idx="${idx}"
            aria-label="Cantidad kg de ${l.producto_nombre}">
        </td>
        <td class="text-right">${cantidadUnidades || '—'}</td>
        <td class="text-right">${precioStr}</td>
        <td class="text-right">${subtotalStr}</td>
        <td>
          <button class="ct-btn-del btn-icon" data-id="${l.producto_id}" aria-label="Eliminar ${l.producto_nombre}">
            ✕
          </button>
        </td>
      </tr>
    `
  }).join('')

  // Listeners — editar cantidad
  tbody.querySelectorAll('.ct-qty-input').forEach(input => {
    input.addEventListener('change', () => {
      const idx = parseInt(input.dataset.idx)
      const carrito = recuperarCarrito()
      const nuevo = parseFloat(input.value) || 1
      if (carrito[idx]) {
        carrito[idx].cantidad_kg = nuevo
        guardarCarritoLocal(carrito)
        renderTotales(carrito)
      }
    })
  })

  // Listeners — eliminar
  tbody.querySelectorAll('.ct-btn-del').forEach(btn => {
    btn.addEventListener('click', () => {
      eliminarDelCarrito(btn.dataset.id)
      renderCarrito()
    })
  })

  renderTotales(carrito)
}

function renderTotales(lineas) {
  const { subtotal, igv, total } = calcularTotalesCarrito(lineas)
  const sub = getEl('tot-subtotal')
  const igvEl = getEl('tot-igv')
  const tot   = getEl('tot-total')
  if (sub)  sub.textContent  = formatCurrency(subtotal, MON())
  if (igvEl) igvEl.textContent = formatCurrency(igv, MON())
  if (tot)  tot.textContent  = formatCurrency(total, MON())
}

// ============================================================================
// PASO 2 — RESUMEN LATERAL
// ============================================================================

function renderResumen() {
  const carrito = recuperarCarrito()
  const container = getEl('cot-resumen-items')
  if (container) {
    container.innerHTML = carrito.map(l => `
      <div class="cot-resumen-item">
        <span>${l.producto_nombre}</span>
        <span>${l.cantidad_kg} kg</span>
      </div>
    `).join('')
  }
  const { subtotal, igv, total } = calcularTotalesCarrito(carrito)
  const s = getEl('res-subtotal'), g = getEl('res-igv'), t = getEl('res-total')
  if (s) s.textContent = formatCurrency(subtotal, MON())
  if (g) g.textContent = formatCurrency(igv, MON())
  if (t) t.textContent = formatCurrency(total, MON())
}

// ============================================================================
// PASO 2 — BUSCAR RUC
// ============================================================================

async function buscarRuc() {
  const ruc = (getEl('f-ruc')?.value || '').trim()
  if (!validarRUC(ruc)) {
    mostrarError('El RUC debe tener 11 dígitos numéricos.')
    return
  }
  mostrarError('')
  const cliente = await getClienteByRuc(ruc)
  if (!cliente) return
  const map = {
    'f-razon':      cliente.razon_social,
    'f-contacto':   cliente.nombre_contacto,
    'f-email':      cliente.email,
    'f-tel':        cliente.telefono,
    'f-dir-fiscal': cliente.direccion_fiscal,
  }
  Object.entries(map).forEach(([id, val]) => {
    const el = getEl(id)
    if (el && val) el.value = val
  })
}

// ============================================================================
// PASO 2 — CONFIRMAR COTIZACIÓN
// ============================================================================

async function confirmar() {
  mostrarError('')
  const btn = getEl('btn-confirmar')

  const datosCliente = {
    ruc:              (getEl('f-ruc')?.value        || '').trim(),
    razon_social:     (getEl('f-razon')?.value      || '').trim(),
    nombre_contacto:  (getEl('f-contacto')?.value   || '').trim(),
    email:            (getEl('f-email')?.value       || '').trim(),
    telefono:         (getEl('f-tel')?.value         || '').trim(),
    direccion_fiscal: (getEl('f-dir-fiscal')?.value  || '').trim(),
  }
  const datosEntrega = {
    dir_entrega:        (getEl('f-dir-entrega')?.value || '').trim(),
    distrito_entrega:   (getEl('f-distrito')?.value   || '').trim(),
    referencia_entrega: (getEl('f-referencia')?.value || '').trim(),
  }
  const notas = (getEl('f-notas')?.value || '').trim()

  // Validaciones básicas
  if (!validarRUC(datosCliente.ruc)) {
    mostrarError('RUC inválido. Debe tener 11 dígitos numéricos.')
    return
  }
  if (!datosCliente.razon_social) {
    mostrarError('La Razón Social / Nombre es obligatorio.')
    return
  }
  if (!datosCliente.nombre_contacto) {
    mostrarError('El Nombre de Contacto es obligatorio.')
    return
  }
  if (!datosCliente.email) {
    mostrarError('El Email es obligatorio.')
    return
  }
  if (!datosEntrega.dir_entrega) {
    mostrarError('La Dirección de Entrega es obligatoria.')
    return
  }
  if (!datosEntrega.distrito_entrega) {
    mostrarError('El Distrito de Entrega es obligatorio.')
    return
  }

  // Bloquear botón durante el procesamiento
  btn.disabled = true
  btn.textContent = 'Procesando...'

  const resultado = await procesarCotizacion(datosCliente, datosEntrega, null, notas)

  btn.disabled = false
  btn.textContent = 'Confirmar Cotización →'

  if (!resultado.ok) {
    mostrarError(resultado.mensaje)
    return
  }

  // Guardar ID para el comprobante
  cotizacionId = resultado.cotizacion?.id || null

  // Mostrar número de cotización en paso 3
  const numEl = getEl('conf-numero')
  if (numEl) {
    const num = resultado.cotizacion?.numero_cotizacion || resultado.cotizacion?.id?.slice(0, 8).toUpperCase() || '—'
    numEl.textContent = `Número de cotización: ${num}`
  }

  irAPaso(3)
}

// ============================================================================
// PASO 3 — COPIAR CUENTA Y SUBIR COMPROBANTE
// ============================================================================

function inicializarPaso3() {
  // Botones copiar
  document.querySelectorAll('.btn-copy').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target
      const texto    = getEl(targetId)?.textContent?.trim() || ''
      navigator.clipboard.writeText(texto).catch(() => {})
      btn.classList.add('copied')
      setTimeout(() => btn.classList.remove('copied'), 2000)
    })
  })

  // Upload comprobante
  const fileInput = getEl('comprobante-file')
  const btnSubir  = getEl('btn-subir-comprobante')
  const uploadOk  = getEl('cot-upload-ok')
  const labelText = getEl('upload-label-text')

  fileInput?.addEventListener('change', () => {
    const archivo = fileInput.files?.[0]
    if (archivo && btnSubir) {
      if (labelText) labelText.textContent = archivo.name
      btnSubir.style.display = 'inline-flex'
    }
  })

  btnSubir?.addEventListener('click', async () => {
    const archivo = fileInput?.files?.[0]
    if (!archivo) return
    if (!cotizacionId) {
      console.warn('[Web] No hay cotizacionId para subir comprobante')
      return
    }
    btnSubir.disabled = true
    btnSubir.textContent = 'Subiendo...'
    const { error } = await subirComprobante(cotizacionId, archivo)
    btnSubir.style.display = 'none'
    if (!error && uploadOk) uploadOk.style.display = 'block'
    else if (error) {
      btnSubir.disabled = false
      btnSubir.textContent = 'Confirmar envío de comprobante'
      console.error('[Web] Error subir comprobante:', error.message)
    }
  })
}

// ============================================================================
// INICIALIZACIÓN
// ============================================================================

function renderCuentas() {
  const box = document.querySelector('.cot-cuentas')
  if (!box) return
  const cs = getCtx()?.emp?.cuentas_bancarias
  if (!Array.isArray(cs) || !cs.length) {
    box.innerHTML = '<p class="cot-pago-desc">Te enviaremos los datos de pago junto con la confirmación de tu cotización.</p>'
    return
  }
  box.innerHTML = cs.map((c, i) => `
    <div class="cot-cuenta">
      <div class="cot-cuenta__banco">${escH(c.banco)}</div>
      <div class="cot-cuenta__tipo">${escH(c.tipo || '')}${c.titular ? ' · ' + escH(c.titular) : ''}</div>
      <div class="cot-cuenta__num" id="cuenta-${i}">${escH(c.numero || '')}</div>
      ${c.cci ? `<div class="cot-cuenta__tipo">CCI <span id="cci-${i}">${escH(c.cci)}</span></div>` : ''}
      <button class="btn-copy" data-target="cuenta-${i}" aria-label="Copiar número de cuenta">Copiar</button>
    </div>`).join('')
}

document.addEventListener('DOMContentLoaded', async () => {
  await initCtx()
  renderCuentas()
  // Render inicial paso 1
  renderCarrito()

  // Botón avanzar a paso 2
  getEl('btn-ir-paso2')?.addEventListener('click', () => {
    if (recuperarCarrito().length === 0) return
    renderResumen()
    irAPaso(2)
  })

  // Buscar RUC
  getEl('btn-buscar-ruc')?.addEventListener('click', buscarRuc)

  // Volver a paso 1
  getEl('btn-volver-paso1')?.addEventListener('click', () => {
    mostrarError('')
    irAPaso(1)
    renderCarrito()
  })

  // Confirmar cotización
  getEl('btn-confirmar')?.addEventListener('click', confirmar)

  // Paso 3
  inicializarPaso3()
})
