// ============================================================================
// inventario/formularios.js — parte de inventario.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getItems, getCategorias, getPartidas, getMarcas } from '../supabase-data.js'

// ============================================================================
// CARGAR SELECTS
// ============================================================================

export async function cargarProductosSelect() {
  try {
    const productos = await getItems()
    const select = document.getElementById('loteProducto')

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona --</option>'
    productos.forEach(p => {
      select.innerHTML += `<option value="${p.id}">${p.sku ? '(' + p.sku + ') ' : ''}${p.nombre}</option>`
    })

    // onchange en vez de addEventListener acumulado: cargarProductosSelect
    // se llama más de una vez (init + abrirModalLote), addEventListener
    // duplicaría el listener en cada llamada.
    select.onchange = cargarPartidasSelect
  } catch (error) {
    console.error('Error en cargarProductosSelect:', error)
  }
}

export async function cargarCategoriasSelect() {
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

export async function cargarMarcasSelect() {
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
