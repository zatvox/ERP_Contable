// ============================================================================
// ventas/formularios.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { S } from './state.js'
import { getCurrentUser } from '../auth-supabase.js'
import { getLotes, addLote, getItems, addItem } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { _resolverCategoriaId } from '../shared/catalogo.js'
import { _poblarSelectItems, _poblarSelectLotes } from './helpers.js'

// ============================================================================
// MODALES RÁPIDOS: PRODUCTO Y LOTE (accesibles desde el formulario de Cotización)
// ============================================================================

window.abrirFormularioProducto = function() {
  const form = document.getElementById('formNewProducto')
  if (form) form.reset()
  window.openModal('modal-nuevo-producto')
}

window.guardarProducto = async function() {
  try {
    const nombre      = document.getElementById('prodNombre')?.value?.trim()
    const sku         = document.getElementById('prodSKU')?.value?.trim()
    const descripcion = document.getElementById('prodDescripcion')?.value?.trim()
    const categoria   = document.getElementById('prodCategoria')?.value?.trim()
    const activo      = document.getElementById('prodActivo')?.value === 'true'

    if (!nombre || !sku) { showToast('Complete los campos requeridos (Nombre y SKU)', 'warning'); return }

    const categoriaId = await _resolverCategoriaId(categoria)

    await addItem({
      nombre,
      sku,
      descripcion:  descripcion || null,
      categoria_id: categoriaId,
      tipo_item:    'mercaderia',
      activo
    })

    showToast('Producto creado exitosamente', 'success')
    window.closeModal('modal-nuevo-producto')
    const form = document.getElementById('formNewProducto')
    if (form) form.reset()

    S._items = await getItems()
    _poblarSelectItems()
  } catch (e) {
    console.error('guardarProducto:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

window.abrirFormularioLote = function() {
  const selLote = document.getElementById('loteProducto')
  if (selLote) {
    selLote.innerHTML = '<option value="">-- Selecciona --</option>' +
      S._items.map(i => `<option value="${i.id}">${i.sku ? '(' + i.sku + ') ' : ''}${i.nombre}</option>`).join('')
  }
  const usuario = document.getElementById('loteUsuario')
  if (usuario) {
    getCurrentUser().then(u => { usuario.value = u?.nombre || u?.email || '' })
  }
  const form = document.getElementById('formNewLote')
  if (form) form.reset()
  window.openModal('modal-nuevo-lote')
}

window.guardarLote = async function() {
  // 2026-09-25 (migración 57): lotes.cantidad/cantidad_unidades los calcula
  // la BD desde el Kardex. Este modal creaba/editaba lotes con stock SIN
  // fila de kardex (lote fantasma) → bloqueado por decisión de Luis. Se
  // deja la función para no romper el onclick del HTML.
  showToast('Crear o editar lotes sueltos está deshabilitado: el stock solo entra por Guía de Remisión (Compras) o Ajuste de Inventario (Inventario → Kardex). Desde 2026-09-25 lotes.cantidad se calcula del Kardex.', 'warning')
  return
  // eslint-disable-next-line no-unreachable
  try {
    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    const productId    = parseInt(document.getElementById('loteProducto')?.value || 0)
    const numeroLote    = document.getElementById('loteNumero')?.value?.trim()
    const stock         = parseFloat(document.getElementById('loteStock')?.value || 0)
    const costoUnitario = parseFloat(document.getElementById('loteCosto')?.value || 0)
    const costoDestino  = parseFloat(document.getElementById('loteDestino')?.value || 0)
    const fechaVenc     = document.getElementById('loteVencimiento')?.value || ''

    if (!productId || !numeroLote || !stock || !costoUnitario || !fechaVenc) {
      showToast('Complete todos los campos requeridos', 'warning')
      return
    }

    // Columnas reales de lotes: item_id, cantidad (no product_id/stock/costo_destino)
    await addLote({
      item_id:            productId,
      numero_lote:        numeroLote,
      cantidad:           stock,
      cantidad_unidades:  stock,
      costo_unitario:     costoUnitario,
      fecha_vencimiento:  fechaVenc || null,
      fecha_ingreso:      new Date().toISOString().split('T')[0],
      created_by:         user.db_id
    })

    showToast('Lote creado exitosamente', 'success')
    window.closeModal('modal-nuevo-lote')
    const form = document.getElementById('formNewLote')
    if (form) form.reset()

    S._lotes = await getLotes()
    _poblarSelectLotes()
  } catch (e) {
    console.error('guardarLote:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}
