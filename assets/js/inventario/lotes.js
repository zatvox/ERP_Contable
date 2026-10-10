// ============================================================================
// inventario/lotes.js — parte de inventario.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { colStyle } from '../col-menu.js'
import { getItems, getLotes, getLoteById, addLote, updateLote, deleteLote } from '../supabase-data.js'
import { showToast } from '../helpers.js'

// ============================================================================
// LOTES
// ============================================================================

let _loteLista = null // caché: se trae una vez y la búsqueda filtra en memoria

export async function renderLotes(forzar = false) {
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
            <th data-col-tabla="lotes" data-col="numero_lote"${colStyle('lotes','numero_lote')}>Lote</th>
            <th data-col-tabla="lotes" data-col="partida"${colStyle('lotes','partida')}>Partida</th>
            <th data-col-tabla="lotes" data-col="codigo"${colStyle('lotes','codigo')}>Código</th>
            <th data-col-tabla="lotes" data-col="producto"${colStyle('lotes','producto')}>Producto</th>
            <th data-col-tabla="lotes" data-col="stock"${colStyle('lotes','stock')}>Stock</th>
            <th data-col-tabla="lotes" data-col="unidad"${colStyle('lotes','unidad')}>Unidad</th>
            <th data-col-tabla="lotes" data-col="unidades"${colStyle('lotes','unidades')}>N° Unidades</th>
            <th data-col-tabla="lotes" data-col="peso_unidad"${colStyle('lotes','peso_unidad')}>Peso/Unidad</th>
            <th data-col-tabla="lotes" data-col="costo_unit"${colStyle('lotes','costo_unit')}>Costo Unit.</th>
            <th data-col-tabla="lotes" data-col="costo_total"${colStyle('lotes','costo_total')}>Costo Total Lote</th>
            <th data-col-tabla="lotes" data-col="costo_cif"${colStyle('lotes','costo_cif')} title="Costo de la factura de compra (sin IGV), en la moneda del lote">Costo CIF</th>
            <th data-col-tabla="lotes" data-col="costo_real"${colStyle('lotes','costo_real')} title="CIF + costos de destino, por kg, en la moneda del lote. Editable: escribe y presiona Enter o sal del campo.">Costo real ✏️</th>
            <th data-col-tabla="lotes" data-col="vencimiento"${colStyle('lotes','vencimiento')}>Vencimiento</th>
            <th data-col-tabla="lotes" data-col="dias_restantes"${colStyle('lotes','dias_restantes')}>Días Restantes</th>
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
          <td data-col-tabla="lotes" data-col="numero_lote"${colStyle('lotes','numero_lote')}><strong>${lote.numero_lote || '-'}</strong></td>
          <td data-col-tabla="lotes" data-col="partida"${colStyle('lotes','partida')}>${lote.codigo_partida || '-'}</td>
          <td data-col-tabla="lotes" data-col="codigo"${colStyle('lotes','codigo')}>${prod?.sku || '-'}</td>
          <td data-col-tabla="lotes" data-col="producto"${colStyle('lotes','producto')}>${prod?.nombre || '-'}</td>
          <td data-col-tabla="lotes" data-col="stock" style="text-align: center; font-weight: bold;${colStyle('lotes','stock') ? ' display:none;' : ''}">${cantidad.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td data-col-tabla="lotes" data-col="unidad" style="text-align: center;${colStyle('lotes','unidad') ? ' display:none;' : ''}">${lote.unidad_medida || '-'}</td>
          <td data-col-tabla="lotes" data-col="unidades" style="text-align: center;${colStyle('lotes','unidades') ? ' display:none;' : ''}">${lote.cantidad_unidades != null ? parseFloat(lote.cantidad_unidades).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '-'}</td>
          <td data-col-tabla="lotes" data-col="peso_unidad" style="text-align: center;${colStyle('lotes','peso_unidad') ? ' display:none;' : ''}">${pesoPorUnidad != null ? pesoPorUnidad.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '-'}</td>
          <td data-col-tabla="lotes" data-col="costo_unit"${colStyle('lotes','costo_unit')}>S/. ${costoUnit.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td data-col-tabla="lotes" data-col="costo_total"${colStyle('lotes','costo_total')}>S/. ${costoTotalLote.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td data-col-tabla="lotes" data-col="costo_cif" style="white-space:nowrap;${colStyle('lotes','costo_cif') ? ' display:none;' : ''}">${_celdaCostoCIF(lote)}</td>
          <td data-col-tabla="lotes" data-col="costo_real" style="white-space:nowrap;${colStyle('lotes','costo_real') ? ' display:none;' : ''}">${_celdaCostoReal(lote)}</td>
          <td data-col-tabla="lotes" data-col="vencimiento"${colStyle('lotes','vencimiento')}>${vencCell}</td>
          <td data-col-tabla="lotes" data-col="dias_restantes"${colStyle('lotes','dias_restantes')}>${diasCell}</td>
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

// ─── Costo CIF / Costo real (2026-10-09, SQL 81) ────────────────────────────
// costo_real = CIF + costos de destino, por unidad, en la moneda ORIGINAL del
// lote. Se edita aquí mismo; más adelante lo llenará el módulo Importaciones.
function _simMoneda(m) { return m === 'USD' ? '$' : 'S/' }
function _cifDe(lote) { return parseFloat(lote.costo_unit_original ?? lote.costo_unitario) || 0 }
function _celdaCostoCIF(lote) {
  const cif = _cifDe(lote)
  return cif ? `${_simMoneda(lote.moneda)} ${cif.toFixed(4)}` : '<span style="color:var(--text-secondary);">—</span>'
}
function _pctDestino(lote) {
  const cif = _cifDe(lote), real = parseFloat(lote.costo_real) || 0
  if (!cif || !real) return ''
  const pct = (real / cif - 1) * 100
  const color = pct < 0 ? 'var(--color-danger)' : 'var(--text-secondary)'
  return `<small id="lotePctReal-${lote.id}" style="display:block; color:${color}; font-size:0.72rem;">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% sobre CIF</small>`
}
function _celdaCostoReal(lote) {
  const v = lote.costo_real != null ? parseFloat(lote.costo_real) : ''
  return `<div style="display:flex; align-items:center; gap:4px;">
      <span style="color:var(--text-secondary); font-size:0.8rem;">${_simMoneda(lote.moneda)}</span>
      <input type="number" step="0.0001" min="0" value="${v === '' ? '' : v}" placeholder="—"
             data-lote-real="${lote.id}" data-valor="${v === '' ? '' : v}"
             style="width:96px; padding:3px 6px; text-align:right;"
             onkeydown="if(event.key==='Enter'){this.blur()} if(event.key==='Escape'){this.value=this.dataset.valor; this.blur()}"
             onchange="window.guardarCostoRealLote(${lote.id}, this)">
    </div>${_pctDestino(lote)}`
}

window.guardarCostoRealLote = async function (loteId, input) {
  const lote = (_loteLista || []).find(l => l.id === loteId)
  const txt = String(input.value || '').trim()
  const valor = txt === '' ? null : parseFloat(txt)
  if (valor !== null && (!(valor > 0) || isNaN(valor))) {
    showToast('El costo real debe ser mayor a 0 (o déjalo vacío)', 'warning'); input.value = input.dataset.valor; return
  }
  const cif = lote ? _cifDe(lote) : 0
  if (valor !== null && cif && valor < cif &&
      !confirm(`El costo real (${valor}) es MENOR que el costo CIF (${cif.toFixed(4)}).\n\n¿Guardarlo igual?`)) {
    input.value = input.dataset.valor; return
  }
  input.disabled = true
  const r = await updateLote(loteId, { costo_real: valor, costo_real_actualizado_at: new Date().toISOString() })
  input.disabled = false
  if (!r) {
    showToast('No se pudo guardar el costo real. ¿Corriste el SQL 81 (lotes.costo_real)?', 'danger', 7000)
    input.value = input.dataset.valor; return
  }
  input.dataset.valor = valor ?? ''
  if (lote) lote.costo_real = valor
  const pct = document.getElementById(`lotePctReal-${loteId}`)
  const html = lote ? _pctDestino(lote) : ''
  if (pct) pct.outerHTML = html || ''
  else if (html) input.closest('td')?.insertAdjacentHTML('beforeend', html)
  showToast(valor === null ? 'Costo real borrado' : `Costo real ${lote?.numero_lote || ''} guardado ✓`, 'success')
}

window.filtrarLotes = async function () {
  await renderLotes()
}

window.guardarLote = async function () {
  // 2026-09-25 (migración 57): lotes.cantidad/cantidad_unidades los calcula
  // la BD desde el Kardex. Este modal creaba/editaba lotes con stock SIN
  // fila de kardex (lote fantasma) → bloqueado por decisión de Luis. Se
  // deja la función para no romper el onclick del HTML.
  showToast('Crear o editar lotes sueltos está deshabilitado: el stock solo entra por Guía de Remisión (Compras) o Ajuste de Inventario (Inventario → Kardex). Desde 2026-09-25 lotes.cantidad se calcula del Kardex.', 'warning')
  return
  // eslint-disable-next-line no-unreachable
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

// ⚠️ 2026-09-05: los botones "Editar"/"Eliminar" de la tabla de Lotes se
// quitaron de la UI a propósito (ver memoria
// project_desincronizacion_lotes_stock_kardex). Esta pantalla escribía
// lotes.cantidad/cantidad_unidades directo con updateLote(), sin crear fila
// de kardex ni tocar stock_ubicaciones — eso dejaba "lotes fantasma" con
// stock sin ningún rastro auditable. Las funciones se dejan aquí por si
// algo interno todavía las referencia, pero NO deben volver a exponerse
// desde un botón sin antes hacerlas pasar por kardex + stock_ubicaciones
// (ver manual project_manual_integridad_crud_stock).
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
  // 2026-09-25 (migración 57): lotes.cantidad/cantidad_unidades los calcula
  // la BD desde el Kardex. Este modal creaba/editaba lotes con stock SIN
  // fila de kardex (lote fantasma) → bloqueado por decisión de Luis. Se
  // deja la función para no romper el onclick del HTML.
  showToast('Crear o editar lotes sueltos está deshabilitado: el stock solo entra por Guía de Remisión (Compras) o Ajuste de Inventario (Inventario → Kardex). Desde 2026-09-25 lotes.cantidad se calcula del Kardex.', 'warning')
  return
  // eslint-disable-next-line no-unreachable
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
