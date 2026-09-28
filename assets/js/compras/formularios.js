// ============================================================================
// compras/formularios.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { getLotes, addLote, getItems, addItem, getSuppliers, getCuentasGasto } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { refrescarBuscador } from '../buscador-select.js'
import { _resolverCategoriaId } from '../shared/catalogo.js'
import { _escCompras } from './buscadores.js'
import { cargarItemsSelectDetalle } from './ordenes-compra.js'

// ============================================================================
// SELECT LOADERS
// ============================================================================
/*async function cargarTipoDocumentoSelect() {
  try {
    const tipoDocs = await getTipoDocumentos()
    if (!tipoDocs || tipoDocs.length === 0) {
      console.warn('No se encontraron tipos de documento para cargar el select')
      return
    }

    // Selects que deben listar proveedores: OC y compra de servicio/gasto
    const ids = ['ccTipoDocumento']
    ids.forEach(idSelect => {
      const select = document.getElementById(idSelect)
      if (!select) return
      select.innerHTML = '<option value="">-- Selecciona Tipo Documento --</option>'
      tipoDocs.forEach(t => {
        select.innerHTML += `<option value="${t.id}">${t.name}</option>`
      })
    })
  } catch (error) {
    console.error('Error en cargarTipoDocumentoSelect:', error) 
  }
}*/

export async function cargarProveedoresSelect() {
  try {
    const proveedores = await getSuppliers()

    // Selects que deben listar proveedores: OC y el modal unificado de Nueva Compra
    const ids = ['ocProveedor', 'nqProveedor']
    ids.forEach(idSelect => {
      const select = document.getElementById(idSelect)
      if (!select) return
      // Se arma el HTML de una sola vez: hacer `innerHTML +=` dentro del bucle
      // reconstruye el DOM en cada vuelta y con cientos de proveedores se nota.
      select.innerHTML = '<option value="">-- Selecciona Proveedor --</option>' +
        proveedores.map(p => `<option value="${p.id}">${_escCompras(p.nombre || p.razon_social || '')}</option>`).join('')
      refrescarBuscador(select)
    })
  } catch (error) {
    console.error('Error en cargarProveedoresSelect:', error) 
  }
}

export async function cargarCuentasGastoSelect() {
  try {
    const cuentas = await getCuentasGasto()
    const select = document.getElementById('csCuentaGasto')

    if (!select) return

    select.innerHTML = `<option value="">-- Selecciona Cuenta de Gasto ${cuentas.length}--</option>`
    cuentas.forEach(c => {
      select.innerHTML += `<option value="${c.codigo}">${c.codigo} - ${c.nombre}</option>`
    })
  } catch (error) {
    console.error('Error en cargarCuentasGastoSelect:', error)
  }
}

export async function cargarItemsSelect() {
  try {
    const productos = await getItems()
    const select = document.getElementById('ocProducto')

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona Producto --</option>' +
      productos.map(p => `<option value="${p.id}">${_escCompras(p.nombre || '')}</option>`).join('')
    refrescarBuscador(select)
  } catch (error) {
    console.error('Error en cargarItemsSelect:', error)
  }
}

async function cargarLotesPorProducto() {
  try {
    const lotes = await getLotes()
    const select = document.getElementById('ocLote')

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona Lote --</option>'
    lotes.forEach(lote => {
      select.innerHTML += `<option value="${lote.id}">${lote.numero_lote}</option>`
    })
  } catch (error) {
    console.error('Error en cargarProductosSelect:', error)
  }
}

// ============================================================================
// CALCULOS DE TOTALES
// ============================================================================

window.calculoTotalNewOC = async function () {
  try {
    const cantidad = parseFloat(document.getElementById('ocCantidad')?.value || 0)
    const precioUnit = parseFloat(document.getElementById('ocPrecio')?.value || 0)
    const igv = parseFloat(document.getElementById('ocIGV')?.value || 0)

    if (igv === 18) {
      const subtotal = cantidad * precioUnit
      const igvAmount = subtotal * 0.18
      const totalConIGV = subtotal + igvAmount
      document.getElementById('ocIGVAmount').value = igvAmount.toFixed(2) || 0
      document.getElementById('ocSubtotal').value = subtotal.toFixed(2) || 0
      document.getElementById('ocTotal').value = totalConIGV.toFixed(2) || 0
    } else {
      const totalSinIGV = cantidad * precioUnit
      document.getElementById('ocIGVAmount').value = '0.00'
      document.getElementById('ocSubtotal').value = totalSinIGV.toFixed(2) || 0
      document.getElementById('ocTotal').value = totalSinIGV.toFixed(2) || 0
    }
  } catch (error) {
    console.error('Error en calculoTotalNewOC:', error)
    showToast('Error al calcular el total', 'danger')
  }
}
// ============================================================================
// ABRIR FORMULARIOS (Modal Helpers)
// ============================================================================

window.abrirFormularioProveedor = function() {
  window.openModal('modal-nuevo-proveedor')
}

window.abrirFormularioProducto = function() {
  window.openModal('modal-nuevo-producto')
}

window.abrirFormularioLote = async function() {
  try {
    const productos = await getItems()
    const sel = document.getElementById('loteProducto')
    if (sel) {
      sel.innerHTML = '<option value="">-- Selecciona --</option>' +
        productos.map(p => `<option value="${p.id}">${p.sku ? '(' + _escCompras(p.sku) + ') ' : ''}${_escCompras(p.nombre || '')}</option>`).join('')
      refrescarBuscador(sel)
    }
  } catch (error) {
    console.error('Error en abrirFormularioLote:', error)
  }
  window.openModal('modal-nuevo-lote')
}

window.guardarProductoDesdeCompras = async function () {
  try {
    const nombre      = document.getElementById('prodNombre')?.value?.trim()
    const sku         = document.getElementById('prodSKU')?.value?.trim()
    const marcaTexto  = document.getElementById('prodMarca')?.value?.trim()
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

    // Nota: "Marca" en este modal es texto libre y no mapea a marca_id (FK).
    if (marcaTexto) console.info('Marca ingresada como texto (sin asociar a catálogo de marcas):', marcaTexto)

    showToast('Producto creado exitosamente', 'success')
    window.closeModal('modal-nuevo-producto')
    const form = document.getElementById('formNewProducto')
    if (form) form.reset()
    await cargarItemsSelectDetalle()
  } catch (error) {
    console.error('Error en guardarProductoDesdeCompras:', error)
    showToast('Error: ' + error.message, 'danger')
  }
}

window.guardarLoteDesdeCompras = async function () {
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
    const cantidad      = parseFloat(document.getElementById('loteStock')?.value || 0)
    const costoUnitario = parseFloat(document.getElementById('loteCosto')?.value || 0)
    const fechaVenc      = document.getElementById('loteVencimiento')?.value || null

    if (!productId || !numeroLote || !cantidad || !costoUnitario) {
      showToast('Complete todos los campos requeridos (Producto, N° Lote, Stock, Costo)', 'warning')
      return
    }

    // Columnas reales de lotes: item_id, cantidad (no product_id/stock/costo_destino).
    // cantidad_unidades no se pide en este modal. lotes.cantidad_unidades es
    // NOT NULL DEFAULT 0, así que va 0 (no null: eso pisaría el DEFAULT y
    // Postgres rechazaría el insert con 23502).
    await addLote({
      item_id:            productId,
      numero_lote:        numeroLote,
      cantidad:           cantidad,
      cantidad_unidades:  0,
      costo_unitario:     costoUnitario,
      moneda:             'PEN',
      tipo_cambio:         1,
      costo_unit_original: costoUnitario,
      fecha_vencimiento:  fechaVenc,
      fecha_ingreso:      new Date().toISOString().split('T')[0],
      created_by:         user.db_id
    })

    showToast('Lote creado exitosamente', 'success')
    window.closeModal('modal-nuevo-lote')
    const form = document.getElementById('formNewLote')
    if (form) form.reset()
  } catch (error) {
    console.error('Error en guardarLoteDesdeCompras:', error)
    showToast('Error: ' + error.message, 'danger')
  }
}
