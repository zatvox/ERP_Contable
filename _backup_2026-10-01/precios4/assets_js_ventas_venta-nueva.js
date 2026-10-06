// ============================================================================
// ventas/venta-nueva.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { S } from './state.js'
import { getCurrentUser } from '../auth-supabase.js'
import { getContactById, updateContact, tiposDeContacto, getLotes, addVenta, getVentas, addDetalleVenta, addCuentaCobrar, addCuotaCobrar, getCuotasCobrarByCxC, getCuentasCobrar, generarNumeroVenta, asegurarPeriodoAbierto, getStockUbicaciones } from '../supabase-data.js'
import { showToast, formatNumber, formatQty } from '../helpers.js'
import { refrescarBuscador } from '../buscador-select.js'
import { renderEditorCronograma, actualizarCronograma, leerCronograma } from '../cronograma.js'
import { getModuloConfig } from '../config-modulo.js'
import { _actualizarAvisoRetencionVenta, _actualizarAvisoStockLineaVenta, _poblarSelectClientes, _poblarSelectItems, _refrescarStockLoteEnVivo, _stockTotalPorItem, _sugerirUnidadesLineaVenta } from './helpers.js'
import { _aplicarAnticiposVentaSeleccionados } from './venta-anticipo.js'
import { _setEv } from './ventas-editar.js'
import { renderVentas } from './ventas-lista.js'
import { vincularTCEnVivo } from '../tc-en-vivo.js'
import { serieDefault, seriesDeTipo, getSerie, siguienteCorrelativo, registrarUsoSerie, getSeries, NOMBRE_TIPO_SERIE, poblarSelectSeries } from '../series.js'
import { refrescarBuscador as _refrescarBuscadorPK } from '../buscador-select.js'
import { marcarPackingFacturado } from './packing.js'

// ============================================================================
// MODAL: NUEVA VENTA
// ============================================================================

window.abrirModalNuevaVenta = async function() {
  try {
    S._packingOrigen = null   // se fija DESPUÉS, solo si se abre desde "Facturar" un PK
    const avisoPk = document.getElementById('ventaAvisoPacking')
    if (avisoPk) avisoPk.remove()
    S._ventaLineas = []
    document.getElementById('ventaLineas').innerHTML = ''
    document.getElementById('ventaTotalCantidad').textContent = '0'
    document.getElementById('ventaTotalBase').textContent   = '0.00'
    document.getElementById('ventaTotalIGV').textContent    = '0.00'
    document.getElementById('ventaTotalFinal').textContent  = '0.00'
    const avisoRet = document.getElementById('ventaClienteRetencionAviso')
    if (avisoRet) avisoRet.style.display = 'none'
    const docInfoCliente = document.getElementById('ventaClienteDocInfo')
    if (docInfoCliente) docInfoCliente.style.display = 'none'

    const periodo = await asegurarPeriodoAbierto()
    const periodoEl = document.getElementById('ventaPeriodo')
    if (periodoEl) {
      periodoEl.value = periodo
      periodoEl.dataset.valorAutomatico = periodo
    }

    // Fecha vencimiento por defecto = fecha emisión (el onchange del campo
    // de emisión la mantiene sincronizada mientras el usuario no la toque).
    const fEmision = document.getElementById('ventaFechaEmision')
    const fVenc    = document.getElementById('ventaFechaVencimiento')
    if (fEmision && !fEmision.value) fEmision.value = new Date().toISOString().split('T')[0]
    if (fVenc && fEmision) fVenc.value = fEmision.value

    // Preferencias de Configuración: moneda y serie por defecto.
    const cfgVentas = getModuloConfig('ventas')
    const monedaSel = document.getElementById('ventaMoneda')
    if (monedaSel) monedaSel.value = cfgVentas.monedaDefault || 'PEN'
    const tipoCompSel = document.getElementById('ventaTipoComp')
    const serieEl = document.getElementById('ventaSerie')
    // 2026-09-30: la serie por defecto sale de la tabla series_documentos
    // (Configuración → Series y correlativos); la de localStorage queda de respaldo.
    // Serie = SELECTOR con las series activas del tipo (ya no texto libre).
    // Al abrir se vacía para que quede la serie POR DEFECTO del tipo.
    if (serieEl) serieEl.innerHTML = ''
    await _poblarDatalistSeriesVenta()

    // Candados cerrados, campos opcionales plegados y correlativo sugerido
    // según la serie que quedó arriba.
    await window._prepararCamposVenta()

    // Cronograma: se re-renderiza en cada apertura para tomar el término del
    // cliente elegido y limpiar lo que quedó de la venta anterior.
    _cronogramaVentaListo = false
    await _prepararCronogramaVenta(true)

    // T.C. siempre visible (2026-10-05): en soles queda como referencia SUNAT.
    const tcGroup = document.getElementById('ventaTipoCambioGroup')
    if (tcGroup) tcGroup.style.display = 'block'
    // T.C. VENTA automático según la fecha de emisión (en vivo, candado 🔒)
    vincularTCEnVivo({ idFecha: 'ventaFechaEmision', idMoneda: 'ventaMoneda', idTC: 'ventaTipoCambio', idAviso: 'ventaTCAviso', tipo: 'venta' }).reiniciar()

    // Refrescar stock/lotes: el aviso de stock total se arma con esto, para
    // no ofrecer stock que ya no existe.
    const [lotesFrescos, stockFresco] = await Promise.all([getLotes(), getStockUbicaciones()])
    S._lotes = lotesFrescos
    S._stockUbic = stockFresco
    S._lotesMap = {}
    for (const lo of (S._lotes || [])) S._lotesMap[lo.id] = lo

    _poblarSelectClientes()
    _poblarSelectItems()
    const inpUnidad = document.getElementById('ventaLineaUnidad')
    if (inpUnidad) inpUnidad.value = ''
    const inpCantUnid = document.getElementById('ventaLineaCantUnidades')
    if (inpCantUnid) inpCantUnid.value = ''
    _actualizarAvisoStockLineaVenta()

    const atvDesc = document.getElementById('atvDescripcion')
    if (atvDesc) atvDesc.value = 'ANTICIPO'
    window.cambiarTipoVenta('mercaderia')

    window.openModal('modal-nueva-venta')
  } catch (e) {
    showToast('Error al abrir modal: ' + e.message, 'danger')
  }
}

// La venta pide lote+zona por línea (para no facturar algo que no hay), pero
// eso NO mueve stock/kardex acá — es solo referencial en detalle_ventas. El
// movimiento real (descontar de lotes/stock_ubicaciones, generar kardex) se
// hace después, en la Guía de Despacho de Venta (ver TAB: GUÍAS DE DESPACHO),
// igual que en Compras la OC no mueve stock y recién la Guía de Remisión lo hace.
/** Abre el modal de "Agregar Producto a la Venta" (espejo de compras). */
window.abrirModalLineaVenta = function () {
  S._ventaLineaEditIdx = null
  _setEv('tituloModalLineaVenta', 'Agregar Producto a la Venta')
  const btn = document.getElementById('btnAgregarLineaVenta')
  if (btn) btn.textContent = '+ Agregar'
  window.openModal('modal-agregar-linea-venta')
}

window.cerrarModalLineaVenta = function () {
  S._ventaLineaEditIdx = null
  window.closeModal('modal-agregar-linea-venta')
}

/**
 * Reabre el modal "Agregar Producto" precargado con los datos de una línea
 * YA agregada a la venta, para corregirla sin tener que borrarla y volver a
 * escribir todo. Al guardar (agregarLineaVenta), como _ventaLineaEditIdx
 * queda seteado, la línea se REEMPLAZA en su mismo puesto en vez de
 * agregarse una nueva al final.
 */
window.editarLineaVenta = async function (idx) {
  const l = S._ventaLineas[idx]
  if (!l) return
  S._ventaLineaEditIdx = idx

  // Los buscadores (convertirEnBuscador) solo sincronizan su input visible
  // cuando el <select> dispara 'change' o vía refrescarBuscador() — asignar
  // .value directo no dispara 'change', así que cada asignación de abajo
  // necesita su refrescarBuscador() inmediatamente después.
  const sel = document.getElementById('ventaItemSelect')
  if (sel) sel.value = String(l.item_id)
  refrescarBuscador('ventaItemSelect')

  await _refrescarStockLoteEnVivo()

  const cantInput = document.getElementById('ventaLineaCantidad')
  if (cantInput) cantInput.value = l.cantidad

  _sugerirUnidadesLineaVenta()   // sugerencia de unidades — se pisa abajo con el valor real guardado

  const unidInput = document.getElementById('ventaLineaCantUnidades')
  if (unidInput) unidInput.value = l.cantidad_unidades || ''
  const precioInp = document.getElementById('ventaLineaPrecio')
  if (precioInp) precioInp.value = l.precio_unitario
  const descInp = document.getElementById('ventaLineaDesc')
  if (descInp) descInp.value = l.descripcion || ''
  const inpUnidad = document.getElementById('ventaLineaUnidad')
  if (inpUnidad) inpUnidad.value = l.unidad_medida || ''
  // El modo "18% incluido" es solo de captura y no se conserva en la línea
  // guardada (ver comentario en agregarLineaVenta) — al editar se muestra
  // el tipo_base real ('gravada'/'exonerada'/'inafecta'), con el precio ya
  // en base sin IGV.
  const tipoSel = document.getElementById('ventaLineTipoBase')
  if (tipoSel) tipoSel.value = l.tipo_base || 'gravada'

  window._actualizarPreviewLineaVenta()
  _actualizarAvisoStockLineaVenta()

  _setEv('tituloModalLineaVenta', 'Editar Producto de la Venta')
  const btn = document.getElementById('btnAgregarLineaVenta')
  if (btn) btn.textContent = 'Guardar cambios'

  window.openModal('modal-agregar-linea-venta')
}

/**
 * Costo promedio ponderado FIFO: recorre los lotes disponibles del ítem
 * (más antiguo primero) "consumiendo" `cantidad` kg y promedia el costo de
 * lo que se habría usado. Es solo una estimación para detalle_ventas
 * (informativa/contable referencial) — el costo REAL que se contabiliza sale
 * de los lotes que la Guía de Despacho efectivamente descuente.
 */
function _costoPromedioFIFO(lotes, cantidad) {
  let restante = cantidad, costoAcum = 0, kgAcum = 0
  for (const l of lotes) {
    if (restante <= 0) break
    const usa = Math.min(restante, l.disp)
    costoAcum += usa * l.costo_unitario
    kgAcum += usa
    restante -= usa
  }
  return kgAcum > 0 ? costoAcum / kgAcum : (lotes[0]?.costo_unitario || 0)
}

window.agregarLineaVenta = function() {
  const sel    = document.getElementById('ventaItemSelect')
  const opt    = sel?.selectedOptions[0]
  const itemId = parseInt(sel?.value || 0)
  if (!itemId) { showToast('Selecciona un producto', 'warning'); return }

  const cantInput  = document.getElementById('ventaLineaCantidad')
  const unidInput  = document.getElementById('ventaLineaCantUnidades')
  const precioInp  = document.getElementById('ventaLineaPrecio')
  const descInp    = document.getElementById('ventaLineaDesc')
  const tipoBase   = document.getElementById('ventaLineTipoBase')?.value || 'gravada'

  const cantidad         = parseFloat(cantInput?.value || 1)
  const cantidadUnidades = parseFloat(unidInput?.value || 0) || 0
  const precio      = parseFloat(precioInp?.value || opt?.getAttribute('data-precio') || 0)
  const descripcion = descInp?.value || opt?.text || ''
  const item        = S._items.find(i => i.id === itemId)
  const unidadMedida = item?.unidad_medida || 'KG'

  if (cantidad <= 0 || precio <= 0) {
    showToast('Cantidad y precio deben ser mayores a 0', 'warning')
    return
  }

  // Stock TOTAL disponible del producto (todas las zonas/lotes sumadas) — si
  // no alcanza, se bloquea acá (solo aviso: el stock recién se descuenta de
  // verdad al crear la Guía de Despacho, que ahí sí elige lote/zona). Se
  // descuenta lo que OTRAS líneas de este mismo producto ya reservaron en
  // este mismo formulario, para no "vender" el mismo stock dos veces antes
  // de guardar. Si se está EDITANDO una línea existente, esa línea se
  // excluye de la cuenta para no restarse a sí misma.
  const { totalKg, totalUnid, lotes } = _stockTotalPorItem(itemId)
  const otrasLineas = S._ventaLineas.filter((l, i) => i !== S._ventaLineaEditIdx)
  const yaReservadoKg = otrasLineas
    .filter(l => l.item_id === itemId)
    .reduce((s, l) => s + (parseFloat(l.cantidad) || 0), 0)
  const yaReservadoUnid = otrasLineas
    .filter(l => l.item_id === itemId)
    .reduce((s, l) => s + (parseFloat(l.cantidad_unidades) || 0), 0)
  const disponibleKg   = totalKg - yaReservadoKg
  const disponibleUnid = totalUnid - yaReservadoUnid

  if (cantidad > disponibleKg) {
    showToast(
      `Stock insuficiente para "${descripcion}": disponible ${formatQty(disponibleKg)} kg (todas las zonas), solicitado ${formatQty(cantidad)} kg.`,
      'danger'
    )
    return
  }
  if (cantidadUnidades > 0 && cantidadUnidades > disponibleUnid) {
    showToast(
      `Unidades insuficientes para "${descripcion}": disponible ${formatQty(disponibleUnid)} und, solicitado ${formatQty(cantidadUnidades)} und.`,
      'danger'
    )
    return
  }

  // "Gravada 18% (incluido)" es solo un modo de captura: el vendedor pasa
  // el precio del pedido con IGV ya incluido. tipo_base se sigue guardando
  // como 'gravada' (el CHECK de detalle_ventas no tiene un valor aparte
  // para esto), pero precio_unitario se normaliza a la base SIN IGV antes
  // de guardar, para que subtotal = cantidad * precio_unitario siga
  // cumpliéndose en todo el sistema (ej. calcularTotalesLinea).
  const igvIncluido = tipoBase === 'gravada_incluido'
  const tipoBaseGuardar = igvIncluido ? 'gravada' : tipoBase
  const igvPct = (tipoBase === 'gravada' || igvIncluido) ? 18 : 0

  let subtotal, igvMonto, totalLine, precioUnitarioGuardar
  if (igvIncluido) {
    totalLine = parseFloat((cantidad * precio).toFixed(2))
    subtotal  = parseFloat((totalLine / 1.18).toFixed(2))
    igvMonto  = parseFloat((totalLine - subtotal).toFixed(2))
    precioUnitarioGuardar = parseFloat((subtotal / cantidad).toFixed(4))
  } else {
    subtotal  = parseFloat((cantidad * precio).toFixed(2))
    igvMonto  = parseFloat((subtotal * igvPct / 100).toFixed(2))
    totalLine = parseFloat((subtotal + igvMonto).toFixed(2))
    precioUnitarioGuardar = precio
  }

  // Sin lote/zona elegidos acá (eso lo decide la Guía de Despacho al
  // despachar). lote_id/ubicacion_id/stock_ubicacion_id quedan null —
  // detalle_ventas.lote_id ya soporta null (ON DELETE SET NULL) porque la
  // venta nunca movió stock de verdad, solo lo registraba como referencia.
  const lineaGuardada = {
    item_id: itemId, descripcion, cantidad, cantidad_unidades: cantidadUnidades,
    precio_unitario: precioUnitarioGuardar,
    subtotal, tipo_base: tipoBaseGuardar, igv_porcentaje: igvPct,
    igv_monto: igvMonto, total_linea: totalLine,
    unidad_medida: unidadMedida, ubicacion_id: null,
    lote_id: null, stock_ubicacion_id: null, numero_lote: null,
    costo_unitario: parseFloat(_costoPromedioFIFO(lotes, cantidad).toFixed(4))
  }

  const editando = S._ventaLineaEditIdx !== null
  if (editando) {
    const prev = S._ventaLineas[S._ventaLineaEditIdx]
    if (prev?.detalle_packing_id && prev.item_id === lineaGuardada.item_id) {
      lineaGuardada.detalle_packing_id = prev.detalle_packing_id
      lineaGuardada.precio_pk = prev.precio_pk
    }
  }
  if (editando) S._ventaLineas[S._ventaLineaEditIdx] = lineaGuardada
  else S._ventaLineas.push(lineaGuardada)

  _renderLineasVenta()

  // Limpiar
  if (cantInput)  cantInput.value  = '1'
  if (unidInput)  unidInput.value  = ''
  if (precioInp)  precioInp.value  = ''
  if (descInp)    descInp.value    = ''
  if (sel)        sel.value        = ''
  refrescarBuscador('ventaItemSelect')
  const inpUnidad = document.getElementById('ventaLineaUnidad')
  if (inpUnidad)  inpUnidad.value  = ''
  _actualizarAvisoStockLineaVenta()
  window._actualizarPreviewLineaVenta()
  window.cerrarModalLineaVenta()
  showToast(editando ? 'Producto actualizado' : 'Producto agregado a la venta', 'success')
}

// Etiqueta + color legibles para el tipo de IGV de una línea (en vez de
// mostrar el valor crudo de la BD como 'gravada'/'exonerada'/'inafecta').
function _badgeTipoIGV(tipoBase) {
  const map = {
    gravada:   { label: 'Gravada 18%', color: 'var(--color-info)' },
    exonerada: { label: 'Exonerada',   color: 'var(--color-warning)' },
    inafecta:  { label: 'Inafecta',    color: 'var(--text-secondary)' }
  }
  const m = map[tipoBase] || { label: tipoBase || '-', color: 'var(--text-secondary)' }
  return `<span style="display:inline-block; padding:2px 8px; border-radius:999px; font-size:0.75rem; font-weight:600; color:#fff; background:${m.color}; white-space:nowrap;">${m.label}</span>`
}


function _renderLineasVenta() {
  const container = document.getElementById('ventaLineas')
  if (!container) return

  let cantidadTotal = 0, base = 0, igv = 0, total = 0
  S._ventaLineas.forEach(l => {
    cantidadTotal += parseFloat(l.cantidad) || 0
    base += l.subtotal; igv += l.igv_monto; total += l.total_linea
  })

  if (S._ventaLineas.length === 0) {
    container.innerHTML = `<tr><td colspan="10" style="text-align:center; color:var(--text-secondary); padding:20px;">Sin productos agregados</td></tr>`
  } else {
    container.innerHTML = S._ventaLineas.map((l, idx) => `
      <tr>
        <td>${l.descripcion}</td>
        <td style="text-align:right;">${(parseFloat(l.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 3 })}</td>
        <td>${l.unidad_medida || '-'}</td>
        <td style="text-align:right;">${(parseFloat(l.cantidad_unidades) || 0) > 0 ? (parseFloat(l.cantidad_unidades) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '-'}</td>
        <td style="text-align:right;">${l.precio_unitario.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td>${_badgeTipoIGV(l.tipo_base)}</td>
        <td style="text-align:right;">${l.subtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td><input type="number" step="0.01" min="0" value="${l.igv_monto.toFixed(2)}" style="width:90px; text-align:right;" title="Editable: ajusta por redondeo si hace falta" onchange="window.editarMontoIGVLineaVenta(${idx}, this.value)"></td>
        <td style="text-align:right; font-weight:bold;">${l.total_linea.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td style="white-space:nowrap;">
          <button type="button" class="btn btn-small btn-secondary" onclick="window.editarLineaVenta(${idx})">✏️</button>
          <button type="button" class="btn btn-small btn-danger" onclick="window.quitarLineaVenta(${idx})">✕</button>
        </td>
      </tr>
    `).join('')
  }

  document.getElementById('ventaTotalCantidad').textContent = cantidadTotal.toLocaleString('en-US', { maximumFractionDigits: 3 })
  document.getElementById('ventaTotalBase').textContent   = base.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  document.getElementById('ventaTotalIGV').textContent    = igv.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  document.getElementById('ventaTotalFinal').textContent  = total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  _actualizarAvisoRetencionVenta()
  // Las cuotas se prorratean sobre el total: si cambian las líneas, el
  // cronograma tiene que seguirlas o dejaría de cuadrar.
  window._refrescarCronogramaVenta?.()
}

window.quitarLineaVenta = function(idx) {
  S._ventaLineas.splice(idx, 1)
  _renderLineasVenta()
  _actualizarAvisoStockLineaVenta()
}

// Ajuste manual de redondeo: el IGV de una línea normalmente sale de
// subtotal × 18%, pero al sumar varias líneas (o venir de un pedido externo
// ya redondeado) puede haber una diferencia de centavos. Se deja editable en
// vez de forzar siempre el cálculo exacto — el Subtotal NO se toca, solo el
// IGV y, en cascada, el Total de esa línea.
window.editarMontoIGVLineaVenta = function (idx, valor) {
  const l = S._ventaLineas[idx]
  if (!l) return
  const nuevoIGV = Math.max(0, parseFloat(valor) || 0)
  l.igv_monto = parseFloat(nuevoIGV.toFixed(2))
  l.total_linea = parseFloat((l.subtotal + l.igv_monto).toFixed(2))
  _renderLineasVenta()
}

window.guardarNuevaVenta = async function() {
  const btn = document.getElementById('btnGuardarNuevaVenta')
  if (btn?.disabled) return
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...' }
  try {
    const user = await getCurrentUser()

    const contactId     = parseInt(document.getElementById('ventaContactId')?.value || 0)
    const tipoComp      = document.getElementById('ventaTipoComp')?.value || '01'
    const serie         = document.getElementById('ventaSerie')?.value?.trim() || (tipoComp === '01' ? 'F001' : 'B001')
    const fechaEmision  = document.getElementById('ventaFechaEmision')?.value
    const fechaVenc     = document.getElementById('ventaFechaVencimiento')?.value
    const moneda        = document.getElementById('ventaMoneda')?.value || 'PEN'
    // PEN siempre es 1 (igual que en Compras); en USD se usa el valor del
    // campo (manual o el que dejó el botón "↻ Auto").
    // 2026-10-05: en SOLES también se guarda el T.C. SUNAT del día como referencia
    // (reportes / registro). Solo CONVIERTE montos cuando la moneda es USD.
    const tipoCambio = parseFloat(document.getElementById('ventaTipoCambio')?.value || 0) || 1
    const periodo       = document.getElementById('ventaPeriodo')?.value
    const vendedorId    = parseInt(document.getElementById('ventaVendedor')?.value || 0) || null
    const descripcion   = document.getElementById('ventaDescripcion')?.value?.trim() || null
    const observaciones = document.getElementById('ventaObservaciones')?.value?.trim() || null

    if (!contactId)           { showToast('Selecciona un cliente', 'warning'); return }

    // ── Facturando un PK: precio distinto al pactado → aviso (editable) ──
    if (S._packingOrigen?.id) {
      const difieren = S._ventaLineas.filter(l => l.detalle_packing_id && l.precio_pk != null && Math.abs((+l.precio_unitario) - (+l.precio_pk)) > 0.00005)
      if (difieren.length && !confirm(
        `⚠ ${difieren.length} línea(s) con precio distinto al del ${S._packingOrigen.numero}:\n\n` +
        difieren.map(l => `• ${l.descripcion}: PK ${(+l.precio_pk).toFixed(4)} → factura ${(+l.precio_unitario).toFixed(4)}`).join('\n') +
        `\n\n¿Facturar con el precio nuevo?`)) return
    }

    // ── Validación Tipo ↔ Serie ↔ Cliente (2026-10-02) ────────────────────
    // Caso real: BBOL-00000041 se guardó como Factura (tipo 01) porque la
    // serie es texto libre. La serie DEBE pertenecer al tipo elegido según
    // Configuración → Series y correlativos.
    {
      const seriesTipo = await seriesDeTipo(tipoComp).catch(() => null)
      const serieOk = seriesTipo?.some(x => x.serie === serie.toUpperCase())
      if (seriesTipo && seriesTipo.length && !serieOk) {
        const otra = (await getSeries().catch(() => [])).find(x => x.serie === serie.toUpperCase())
        showToast(otra
          ? `La serie ${serie} es de ${NOMBRE_TIPO_SERIE[otra.tipo_documento] || otra.tipo_documento}, no de ${NOMBRE_TIPO_SERIE[tipoComp] || tipoComp}. Cambia el Tipo de comprobante o la serie.`
          : `La serie ${serie} no está registrada para ${NOMBRE_TIPO_SERIE[tipoComp] || tipoComp} (Configuración → Series).`, 'danger', 8000)
        return
      }
      // Factura exige RUC (11 dígitos); con DNI corresponde Boleta.
      const cli = await getContactById(contactId)
      const docCli = String(cli?.nro_documento || '').replace(/\D/g, '')
      // (Clientes del exterior con VAT/pasaporte sí pueden llevar factura de exportación)
      const esDNI = String(cli?.tipo_documento || '').toUpperCase() === 'DNI' || docCli.length === 8
      if (tipoComp === '01' && esDNI) {
        showToast('Una Factura no se emite a DNI: el cliente necesita RUC. Con DNI emite Boleta.', 'danger', 8000)
        return
      }
      if (tipoComp === '03' && docCli.length === 11 &&
          !confirm('El cliente tiene RUC y estás emitiendo BOLETA (no le sirve para crédito fiscal).\n\n¿Continuar como Boleta?')) return
    }

    // Si el contacto no tiene el tipo 'cliente' (ej. solo proveedor), se informa
    // y se agrega 'cliente' a su lista tipo_contacto para futuras ventas.
    // La venta continúa después de la confirmación, no se anula.
    const contactoVenta = await getContactById(contactId)
    if (contactoVenta) {
      const tipos = tiposDeContacto(contactoVenta)
      if (!tipos.includes('cliente')) {
        const ok = confirm(
          `⚠ "${contactoVenta.nombre}" está registrado como: ${tipos.join(', ') || 'sin tipo'}.\n\n` +
          `Se agregará "cliente" a su tipo de contacto para esta y futuras ventas.\n\n` +
          `¿Confirmar y continuar con la venta?`
        )
        if (!ok) return
        await updateContact(contactId, { tipo_contacto: [...tipos, 'cliente'] })
        showToast(`"${contactoVenta.nombre}" ahora también es cliente`, 'info')
      }
    }

    if (!fechaEmision)        { showToast('Ingresa la fecha de emisión', 'warning'); return }
    if (S._ventaLineas.length === 0) { showToast('Agrega al menos una línea', 'warning'); return }

    // Re-chequeo de stock TOTAL por producto (todas las zonas/lotes sumadas)
    // justo antes de crear la venta — agregarLineaVenta ya valida al
    // agregar, pero el stock pudo cambiar mientras el modal estaba abierto.
    // Es solo un aviso preventivo: la venta no descuenta stock (eso lo hace
    // la Guía de Despacho, que ahí sí elige lote/zona). Se agrupa por
    // item_id por si el carrito tiene varias líneas del mismo producto.
    const [lotesActuales, stockUbicActual] = await Promise.all([getLotes(), getStockUbicaciones()])
    S._lotes = lotesActuales
    S._stockUbic = stockUbicActual
    S._lotesMap = {}
    for (const lo of (S._lotes || [])) S._lotesMap[lo.id] = lo

    const totalPedidoPorItem = {}
    for (const l of S._ventaLineas) {
      if (!totalPedidoPorItem[l.item_id]) totalPedidoPorItem[l.item_id] = { cantidad: 0, cantidad_unidades: 0, descripcion: l.descripcion }
      totalPedidoPorItem[l.item_id].cantidad += parseFloat(l.cantidad) || 0
      totalPedidoPorItem[l.item_id].cantidad_unidades += parseFloat(l.cantidad_unidades) || 0
    }
    for (const [itemIdStr, pedido] of Object.entries(totalPedidoPorItem)) {
      const { totalKg, totalUnid } = _stockTotalPorItem(parseInt(itemIdStr))
      if (pedido.cantidad > totalKg) {
        showToast(
          `Stock insuficiente para "${pedido.descripcion}": disponible ${formatQty(totalKg)} kg (todas las zonas), solicitado ${formatQty(pedido.cantidad)} kg. ` +
          `El stock pudo cambiar desde que abriste el formulario — cierra y vuelve a intentar.`,
          'danger'
        )
        return
      }
      if (pedido.cantidad_unidades > 0 && pedido.cantidad_unidades > totalUnid) {
        showToast(
          `Unidades insuficientes para "${pedido.descripcion}": disponible ${formatQty(totalUnid)} und, solicitado ${formatQty(pedido.cantidad_unidades)} und. ` +
          `El stock pudo cambiar desde que abriste el formulario — cierra y vuelve a intentar.`,
          'danger'
        )
        return
      }
    }

    // El correlativo sale del campo del formulario (sugerido automáticamente,
    // o escrito a mano si el usuario abrió el candado).
    const correlativoInput = document.getElementById('ventaCorrelativo')?.value?.trim()
    const correlativo = correlativoInput
      ? parseInt(correlativoInput, 10)
      : await generarNumeroVenta(tipoComp, serie)

    if (!correlativo || isNaN(correlativo) || correlativo <= 0) {
      showToast('El N° de comprobante debe ser un número válido', 'warning')
      return
    }

    // Si el número o el período se editaron a mano, se pide confirmación
    // explícita: ambos tienen consecuencias (correlatividad y mes de
    // declaración) que no conviene cambiar sin darse cuenta.
    if (!(await _confirmarCamposManualesVenta(periodo, correlativo))) {
      showToast('Guardado cancelado', 'info')
      return
    }

    // Comprobante duplicado (serie + N°): antes solo se revisaba si el
    // usuario había editado el correlativo a mano, así que editar la SERIE
    // en vez del número (o un correlativo mal calculado) se colaba sin
    // aviso y el INSERT fallaba silencioso más abajo por la restricción
    // UNIQUE de la base, dejando el botón trabado en "Guardando...". Ahora
    // se revisa siempre, sin importar qué campo se haya tocado.
    const numeroTentativo = `${serie}-${String(correlativo).padStart(8, '0')}`
    const yaExiste = (await getVentas() || []).some(v => v.numero === numeroTentativo)
    if (yaExiste) {
      showToast(`Ya existe el comprobante ${numeroTentativo}. Usa otro número.`, 'danger')
      return
    }

    const base  = S._ventaLineas.reduce((s, l) => s + l.subtotal,   0)
    const igv   = S._ventaLineas.reduce((s, l) => s + l.igv_monto,  0)
    const total = S._ventaLineas.reduce((s, l) => s + l.total_linea, 0)

    // Cronograma de pago: si las cuotas no suman el total, la CxC quedaría
    // descuadrada desde el día uno. Se valida aquí, antes de escribir nada.
    const cronograma = leerCronograma('venta-cronograma')
    if (cronograma && !cronograma.cuadra) {
      showToast(
        `Las cuotas suman ${formatNumber(cronograma.suma)} pero el total es ${formatNumber(total)}. ` +
        `Usa "= Prorratear al total" en el cronograma o corrige los importes.`,
        'warning'
      )
      return
    }

    const venta = await addVenta({
      numero:           `${serie}-${String(correlativo).padStart(8,'0')}`,
      tipo_comprobante: tipoComp,
      serie,
      correlativo,
      contact_id:       contactId,
      fecha_emision:    fechaEmision,
      fecha_vencimiento: fechaVenc || null,
      periodo_contable: periodo || fechaEmision.slice(0,7),
      moneda,
      tipo_cambio:      tipoCambio,
      tipo_venta:       'mercaderia',
      base_imponible:   parseFloat(base.toFixed(2)),
      igv:              parseFloat(igv.toFixed(2)),
      total:            parseFloat(total.toFixed(2)),
      estado:           'emitida',
      estado_pago:      'pendiente',
      cpe_estado:       'no_enviado',
      vendedor_id:      vendedorId,
      descripcion,
      observaciones,
      termino_pago_id:  cronograma?.terminoId || null,
      cronograma_personalizado: !!cronograma?.personalizado,
      packing_id:       S._packingOrigen?.id || null,
      created_by:       user?.db_id
    })

    if (!venta?.id) throw new Error('No se pudo crear la venta')
    await registrarUsoSerie(tipoComp, serie, correlativo)
    if (S._packingOrigen?.id) {
      await marcarPackingFacturado(S._packingOrigen.id, venta.id)
      S._packingOrigen = null
    }

    // La venta SOLO registra el comprobante — NO mueve stock ni kardex
    // (eso lo hace la Guía de Despacho, paso separado, ver TAB: GUÍAS DE
    // DESPACHO; venta.estado_despacho queda en 'pendiente' por default).
    // lote_id/ubicacion_id/costo_unitario SÍ se guardan en detalle_ventas
    // como referencia de lo que el vendedor eligió al facturar, pero son
    // solo informativos: no descuentan lotes.cantidad ni stock_ubicaciones,
    // y la Guía de Despacho puede terminar despachando de un lote distinto
    // si el elegido aquí ya no tiene stock al momento de despachar.
    for (const l of S._ventaLineas) {
      await addDetalleVenta({
        venta_id:         venta.id,
        item_id:          l.item_id,
        lote_id:          l.lote_id,
        ubicacion_id:     l.ubicacion_id,
        descripcion:      l.descripcion,
        unidad_medida:    l.unidad_medida,
        cantidad:         l.cantidad,
        cantidad_unidades: l.cantidad_unidades || 0,
        precio_unitario:  l.precio_unitario,
        subtotal:         l.subtotal,
        tipo_base:        l.tipo_base,
        igv_porcentaje:   l.igv_porcentaje,
        igv_monto:        l.igv_monto,
        total_linea:      l.total_linea,
        costo_unitario:   l.costo_unitario,
        ...(l.detalle_packing_id ? { detalle_packing_id: l.detalle_packing_id } : {})
      })
    }

    // Crear CxC automáticamente. Antes solo Factura ('01'); las Boletas
    // ('03') a crédito calculaban un cronograma que se descartaba sin
    // guardarse — ahora también generan CxC/cuotas si corresponde.
    if (tipoComp === '01' || tipoComp === '03') {
      try {
        const cxc = await addCuentaCobrar({
          contact_id:          contactId,
          venta_id:            venta.id,
          tipo_comprobante:    tipoComp,
          serie,
          numero_comprobante:  correlativo,
          fecha_emision:       fechaEmision,
          // La fecha de vencimiento del documento es la de la ÚLTIMA cuota:
          // es el momento en que la deuda queda totalmente exigible.
          fecha_vencimiento:   cronograma?.cuotas?.length
            ? cronograma.cuotas[cronograma.cuotas.length - 1].fecha_vencimiento
            : (fechaVenc || null),
          moneda,
          tipo_cambio:         tipoCambio,
          monto_total:         parseFloat(total.toFixed(2)),
          monto_cobrado:       0,
          estado:              'pendiente',
          termino_pago_id:     cronograma?.terminoId || null,
          cronograma_personalizado: !!cronograma?.personalizado
        })

        // Cuotas: el cronograma real. Si falla alguna, la venta NO se revierte
        // — la factura ya está emitida y es lo crítico; las cuotas se pueden
        // regenerar después desde Cuentas x Cobrar.
        if (cxc?.id) await _guardarCuotasDeCxC(cxc.id, cronograma)

        // Anticipo(s) del cliente marcados en "Anticipos disponibles" — se
        // descuentan de la CxC recién creada, nunca de detalle_ventas.
        if (cxc?.id) await _aplicarAnticiposVentaSeleccionados(venta, cxc, user?.db_id)
      } catch (eCxC) {
        console.warn('Venta creada pero CxC falló:', eCxC.message)
      }
    }

    showToast(`Venta ${serie}-${String(correlativo).padStart(8,'0')} creada ✅`, 'success')
    window.closeModal('modal-nueva-venta')
    S._ventaLineas = []
    const descEl = document.getElementById('ventaDescripcion')
    const obsEl  = document.getElementById('ventaObservaciones')
    if (descEl) descEl.value = ''
    if (obsEl)  obsEl.value  = ''

    await renderVentas(true)
  } catch (e) {
    console.error('guardarNuevaVenta:', e)
    showToast('Error: ' + e.message, 'danger')
  } finally {
    // Antes el botón se deshabilitaba arriba pero solo se volvía a
    // habilitar si TODO el guardado salía bien — cualquier validación que
    // cortara con `return` (cliente sin elegir, stock insuficiente,
    // comprobante duplicado, cronograma descuadrado, etc.) dejaba
    // "Guardando..." trabado para siempre y el formulario parecía colgado.
    // `finally` se ejecuta siempre, sin importar por dónde se salga del
    // try — es el punto correcto para reponer el botón.
    if (btn) { btn.disabled = false; btn.textContent = '💾 Guardar Venta' }
  }
}

// ============================================================================
// CAMPOS OPCIONALES Y CANDADOS DEL MODAL DE VENTA
// ============================================================================
// Descripción y Observaciones se muestran solo si el usuario los pide: el
// formulario arranca más limpio y se evita el ruido de dos campos vacíos que
// casi nunca se llenan.

window.toggleCampoOpcional = function (idGrupo, checkbox, idInput) {
  const grupo = document.getElementById(idGrupo)
  if (!grupo) return
  const abierto = !!checkbox.checked
  grupo.classList.toggle('abierto', abierto)
  const input = idInput ? document.getElementById(idInput) : null
  if (abierto) { input?.focus() }
  else if (input) { input.value = '' }   // al ocultarlo se limpia: no se guarda algo invisible
}

// Correlativo y Período llegan calculados por el sistema. Se pueden editar,
// pero hay que abrir el candado a propósito — así nadie los cambia sin querer
// y el sistema sabe que el valor es manual (para pedir confirmación al guardar).
const _camposDesbloqueados = new Set()

window.toggleCandado = function (idInput, idBoton, idAviso) {
  const input = document.getElementById(idInput)
  const boton = document.getElementById(idBoton)
  const aviso = document.getElementById(idAviso)
  if (!input || !boton) return

  const abriendo = input.readOnly
  input.readOnly = !abriendo
  boton.textContent = abriendo ? '🔓' : '🔒'
  boton.classList.toggle('abierto', abriendo)
  boton.title = abriendo ? 'Volver al valor automático' : 'Editar manualmente'
  aviso?.classList.toggle('visible', abriendo)

  if (abriendo) {
    _camposDesbloqueados.add(idInput)
    input.dataset.valorAutomatico = input.dataset.valorAutomatico ?? input.value
    input.focus()
    input.select()
  } else {
    _camposDesbloqueados.delete(idInput)
    // Al cerrar el candado se restaura el valor que había calculado el sistema.
    if (input.dataset.valorAutomatico !== undefined) input.value = input.dataset.valorAutomatico
  }
}

function _campoFueEditado(idInput) {
  const input = document.getElementById(idInput)
  if (!input || !_camposDesbloqueados.has(idInput)) return false
  return input.dataset.valorAutomatico !== undefined && input.value.trim() !== input.dataset.valorAutomatico
}

function _resetearCandados() {
  ;[['ventaCorrelativo', 'btnCandadoCorrelativo', 'aviso-correlativo'],
    ['ventaPeriodo', 'btnCandadoPeriodo', 'aviso-periodo']].forEach(([i, b, a]) => {
    const input = document.getElementById(i)
    const boton = document.getElementById(b)
    if (input) { input.readOnly = true; delete input.dataset.valorAutomatico }
    if (boton) { boton.textContent = '🔒'; boton.classList.remove('abierto') }
    document.getElementById(a)?.classList.remove('visible')
    _camposDesbloqueados.delete(i)
  })
}

function _resetearCamposOpcionales() {
  ;[['grupo-venta-descripcion', 'chkVentaDescripcion', 'ventaDescripcion'],
    ['grupo-venta-observaciones', 'chkVentaObservaciones', 'ventaObservaciones']].forEach(([g, c, i]) => {
    document.getElementById(g)?.classList.remove('abierto')
    const chk = document.getElementById(c); if (chk) chk.checked = false
    const inp = document.getElementById(i); if (inp) inp.value = ''
  })
}

// ============================================================================
// CORRELATIVO SUGERIDO
// ============================================================================
// Se recalcula al abrir el modal y cada vez que cambian el tipo o la serie,
// porque el correlativo es por serie: F001 y B001 llevan numeraciones
// independientes.

async function _sugerirCorrelativoVenta() {
  const input = document.getElementById('ventaCorrelativo')
  if (!input || _camposDesbloqueados.has('ventaCorrelativo')) return
  try {
    const tipo  = document.getElementById('ventaTipoComp')?.value || '01'
    const serie = document.getElementById('ventaSerie')?.value?.trim() || (tipo === '03' ? 'B001' : 'F001')
    const maxUsado = (await generarNumeroVenta(tipo, serie)) - 1
    const serieRow = await getSerie(tipo, serie).catch(() => null)
    const n = siguienteCorrelativo(serieRow, maxUsado)
    input.value = String(n).padStart(8, '0')
    input.dataset.valorAutomatico = input.value
  } catch (e) {
    console.warn('No se pudo sugerir el correlativo:', e.message)
  }
}

window.onCambiarTipoCompVenta = async function () {
  // Al cambiar el tipo, el selector de Serie se rehace solo con las series
  // de ese tipo: es imposible dejar una serie de Boleta en una Factura.
  await _poblarDatalistSeriesVenta()
  await _sugerirCorrelativoVenta()
}

/** Selector de Serie: series activas del tipo elegido (tabla series_documentos).
 *  Conserva la serie elegida si sigue siendo válida para el tipo. */
async function _poblarDatalistSeriesVenta() {
  const sel = document.getElementById('ventaSerie')
  if (!sel) return
  const tipo = document.getElementById('ventaTipoComp')?.value || '01'
  const cfg = getModuloConfig('ventas')
  await poblarSelectSeries(sel, tipo, {
    preferida: sel.value || null,
    fallback: tipo === '03' ? (cfg.serieBoleta || 'B001') : (cfg.serieFactura || 'F001')
  })
}

window.onCambiarSerieVenta = function () {
  _sugerirCorrelativoVenta()
}

window._prepararCamposVenta = async function () {
  _resetearCandados()
  _resetearCamposOpcionales()
  await _sugerirCorrelativoVenta()
}

/**
 * Valida el período y el correlativo manuales antes de guardar.
 * Devuelve false si el usuario cancela.
 */
async function _confirmarCamposManualesVenta(periodo, correlativo) {
  const avisos = []

  if (_campoFueEditado('ventaPeriodo')) {
    const auto = document.getElementById('ventaPeriodo').dataset.valorAutomatico
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo || '')) {
      showToast('El período contable debe tener el formato AAAA-MM (ej. 2026-08)', 'warning')
      return false
    }
    avisos.push(
      `PERÍODO CONTABLE modificado a mano:\n` +
      `   automático: ${auto}\n` +
      `   se guardará: ${periodo}\n` +
      `   Esto define en qué mes declara esta venta ante SUNAT.`
    )
  }

  if (_campoFueEditado('ventaCorrelativo')) {
    const auto = document.getElementById('ventaCorrelativo').dataset.valorAutomatico
    avisos.push(
      `N° DE COMPROBANTE modificado a mano:\n` +
      `   sugerido: ${auto}\n` +
      `   se guardará: ${String(correlativo).padStart(8, '0')}\n` +
      `   Verifica que no duplique ni salte la correlatividad de la serie.`
    )
  }

  if (avisos.length === 0) return true
  return confirm(`⚠ Vas a guardar con datos editados manualmente:\n\n${avisos.join('\n\n')}\n\n¿Confirmar y guardar la venta?`)
}

// ============================================================================
// CRONOGRAMA DE PAGO EN NUEVA VENTA
// ============================================================================
// La Fecha de Vencimiento del comprobante dejó de digitarse: ahora la calcula
// el cronograma (es el vencimiento de la ÚLTIMA cuota). Antes el onchange de
// Fecha Emisión la sobrescribía con el mismo valor, así que toda venta nacía
// vencida el día que se emitía — por eso el reporte de antigüedad mostraba
// casi todo en "1-30 días" en vez de "por vencer".

export let _cronogramaVentaListo = false

window.onCambiarFechaEmisionVenta = function () {
  const fecha = document.getElementById('ventaFechaEmision')?.value
  if (!fecha) return
  // El período contable sigue a la fecha de emisión salvo que se haya
  // desbloqueado el candado para escribirlo a mano.
  const periodoEl = document.getElementById('ventaPeriodo')
  if (periodoEl && periodoEl.readOnly) {
    periodoEl.value = fecha.slice(0, 7)
    periodoEl.dataset.valorAutomatico = periodoEl.value
  }
  if (_cronogramaVentaListo) actualizarCronograma('venta-cronograma', { fechaEmision: fecha })
}

/** Se llama al abrir el modal y cada vez que cambia el total de la venta. */
// Render del cronograma en curso: varios disparadores (abrir modal, cambiar
// cliente, cargar líneas desde un PK) lo llaman sin await. Si un render
// forzado arranca con total 0 y termina DESPUÉS de cargar las líneas, pisa
// las cuotas con importe 0 (bug al facturar desde PK, 2026-10-02). Ahora
// cada render forzado espera al anterior y lee el total al momento de pintar.
let _cronoEnCurso = Promise.resolve()

export async function _prepararCronogramaVenta(forzarRender = false, terminoIdForzado = null) {
  const cont = document.getElementById('venta-cronograma')
  if (!cont) return
  if (!_cronogramaVentaListo || forzarRender) {
    const previo = _cronoEnCurso
    _cronoEnCurso = (async () => {
      try { await previo } catch { /* */ }
      await _renderCronogramaVenta(terminoIdForzado)
    })()
    return await _cronoEnCurso
  }
  const total = parseFloat((document.getElementById('ventaTotalFinal')?.textContent || '0').replace(/,/g, '')) || 0
  const fechaEmision = document.getElementById('ventaFechaEmision')?.value || new Date().toISOString().slice(0, 10)
  actualizarCronograma('venta-cronograma', { total, fechaEmision })
}

async function _renderCronogramaVenta(terminoIdForzado = null) {

  const total = parseFloat((document.getElementById('ventaTotalFinal')?.textContent || '0').replace(/,/g, '')) || 0
  const fechaEmision = document.getElementById('ventaFechaEmision')?.value || new Date().toISOString().slice(0, 10)

  {
    // El término del cliente solo PRECARGA el selector: la condición real se
    // negocia por operación, así que la venta guarda la suya y nunca se
    // reescribe la ficha del contacto desde aquí.
    const contactId = parseInt(document.getElementById('ventaContactId')?.value || 0)
    const cliente = S._clientes.find(c => c.id === contactId)

    await renderEditorCronograma('venta-cronograma', {
      total, fechaEmision, aplicaA: 'venta',
      terminoId: terminoIdForzado || cliente?.termino_pago_id || null,
      onCambio: (crono) => {
        // La fecha de vencimiento del comprobante = última cuota.
        const ultima = crono?.cuotas?.[crono.cuotas.length - 1]
        const fv = document.getElementById('ventaFechaVencimiento')
        if (fv && ultima) fv.value = ultima.fecha_vencimiento
      }
    })
    _cronogramaVentaListo = true
    // El total pudo cambiar mientras se pintaba (líneas cargadas desde PK): re-sincronizar.
    const totalAhora = parseFloat((document.getElementById('ventaTotalFinal')?.textContent || '0').replace(/,/g, '')) || 0
    if (totalAhora !== total) actualizarCronograma('venta-cronograma', { total: totalAhora, fechaEmision })
  }
}

/** El cronograma se re-prorratea cada vez que cambian las líneas de la venta. */
window._refrescarCronogramaVenta = function () {
  if (_cronogramaVentaListo) _prepararCronogramaVenta(false)
}

/**
 * Guarda el cronograma como cuotas de la CxC recién creada.
 * Si algo falla, NO se revierte la venta: la factura ya está emitida y es lo
 * crítico; las cuotas se pueden regenerar después desde Cuentas x Cobrar.
 */
export async function _guardarCuotasDeCxC(cxcId, crono) {
  if (!cxcId || !crono?.cuotas?.length) return
  for (const c of crono.cuotas) {
    try {
      await addCuotaCobrar({
        cxc_id: cxcId,
        numero_cuota: c.numero_cuota,
        fecha_vencimiento: c.fecha_vencimiento,
        monto: parseFloat(c.monto.toFixed(2)),
        monto_cobrado: 0, monto_retenido: 0, monto_canjeado: 0,
        estado: 'pendiente',
        hito: c.hito || null
      })
    } catch (e) {
      console.warn(`Cuota ${c.numero_cuota} no se pudo crear:`, e.message)
      showToast(`⚠️ La cuota ${c.numero_cuota} no se guardó: ${e.message}`, 'warning')
    }
  }
}

void getCuotasCobrarByCxC
void leerCronograma

// ============================================================================
// AVISO DE LÍNEA DE CRÉDITO
// ============================================================================
// Avisa, no bloquea: la decisión de vender por encima del límite es comercial,
// no del sistema. Se puede endurecer desde Configuración → Ventas si algún día
// hace falta.

export async function _avisarCreditoCliente() {
  const aviso = document.getElementById('ventaClienteRetencionAviso')
  if (!aviso) return
  const contactId = parseInt(document.getElementById('ventaContactId')?.value || 0)
  if (!contactId) return

  const cliente = S._clientes.find(c => c.id === contactId)
  const linea = parseFloat(cliente?.linea_credito) || 0
  if (linea <= 0) return   // 0 = sin límite definido

  try {
    const { cacheado } = await import('../data-cache.js')
    const cxcs = await cacheado('cuentas_cobrar', getCuentasCobrar)
    const deuda = (cxcs || [])
      .filter(c => c.contact_id === contactId && c.estado !== 'cobrado' && c.estado !== 'anulado')
      .reduce((s, c) => s + (
        parseFloat(c.monto_total || 0) + parseFloat(c.monto_notas_debito || 0)
        - parseFloat(c.monto_notas_credito || 0) - parseFloat(c.monto_cobrado || 0)
        - parseFloat(c.monto_retenido || 0) - parseFloat(c.monto_canjeado || 0)
        - parseFloat(c.monto_anticipo_aplicado || 0)
      ), 0)

    if (deuda > linea) {
      aviso.style.display = 'block'
      aviso.style.color = 'var(--color-danger)'
      aviso.textContent = `⚠ Este cliente supera su línea de crédito: debe ${formatNumber(deuda)} de un tope de ${formatNumber(linea)}. Puedes continuar, es solo un aviso.`
    } else if (deuda > linea * 0.8) {
      aviso.style.display = 'block'
      aviso.style.color = 'var(--color-warning)'
      aviso.textContent = `Línea de crédito al ${((deuda / linea) * 100).toFixed(0)}%: debe ${formatNumber(deuda)} de ${formatNumber(linea)}.`
    }
  } catch (e) {
    console.warn('No se pudo evaluar la línea de crédito:', e.message)
  }
}

void getCuentasCobrar


// ============================================================================
// FACTURAR DESDE PACKING (PK) — 2026-09-30
// ============================================================================
// Abre "Nueva Venta" normal y la precarga con el PK: cliente, moneda, T.C.,
// vendedor y líneas (precio SIN IGV igual que detalle_ventas). Todo lo demás
// (serie editable FFFI/NV01/BBOL…, cronograma, CxC, anticipos, asiento) es el
// flujo de siempre. Al guardar, guardarNuevaVenta enlaza ventas.packing_id y
// marca el PK como 'facturado'. Lote/zona NO se eligen aquí: los define la
// Guía de Despacho (que es la que mueve kardex).
window.abrirNuevaVentaDesdePacking = async function (pk, lineasPk) {
  await window.abrirModalNuevaVenta()
  S._packingOrigen = { id: pk.id, numero: pk.numero }
  const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v }

  set('ventaTipoComp', '01')
  window.onCambiarTipoCompVenta()
  set('ventaContactId', pk.contact_id)
  _refrescarBuscadorPK('ventaContactId')
  window.onCambiarClienteVenta?.()
  set('ventaMoneda', pk.moneda)
  document.getElementById('ventaMoneda')?.dispatchEvent(new Event('change', { bubbles: true }))
  if (pk.moneda === 'USD' && parseFloat(pk.tipo_cambio) > 1) set('ventaTipoCambio', pk.tipo_cambio)
  if (pk.vendedor_id) { set('ventaVendedor', pk.vendedor_id); _refrescarBuscadorPK('ventaVendedor') }

  S._ventaLineas = lineasPk.map(l => ({
    item_id: l.item_id, descripcion: l.descripcion + (l.nota ? ` — ${l.nota}` : ''),
    cantidad: +l.cantidad, cantidad_unidades: +l.cantidad_unidades || 0,
    precio_unitario: +l.precio_unitario, subtotal: +l.subtotal, tipo_base: l.tipo_base,
    igv_porcentaje: +l.igv_porcentaje, igv_monto: +l.igv_monto, total_linea: +l.total_linea,
    unidad_medida: l.unidad_medida, ubicacion_id: null, lote_id: null, stock_ubicacion_id: null, numero_lote: null,
    costo_unitario: parseFloat(_costoPromedioFIFO(_stockTotalPorItem(l.item_id).lotes || [], +l.cantidad).toFixed(4)) || 0,
    // Enlace con la línea del PK (facturación parcial, sql/70) y su precio original
    detalle_packing_id: l.detalle_packing_id ?? l.id ?? null,
    precio_pk: l.precio_pk ?? (+l.precio_unitario)
  }))
  _renderLineasVenta()
  // Cronograma con el total ya cargado y el término de pago del PK (si tiene)
  await _prepararCronogramaVenta(true, pk.termino_pago_id || null)

  const cont = document.querySelector('#modal-nueva-venta .modal-header')
  if (cont && !document.getElementById('ventaAvisoPacking')) {
    const av = document.createElement('div')
    av.id = 'ventaAvisoPacking'
    av.style.cssText = 'margin:10px 20px 0; padding:8px 12px; border-radius:var(--radius-md); background:rgba(59,130,246,.12); color:var(--color-info); font-size:0.85rem;'
    cont.after(av)
  }
  const _av = document.getElementById('ventaAvisoPacking')
  if (_av) {
    _av.style.display = ''
    _av.textContent = `📦 Facturando ${pk.numero}: revisa serie, cronograma, cantidades y precios. Si facturas más que lo pedido, el PK se actualiza con la cantidad real; al guardar el PK queda "Parcial" o "Facturado".`
  }
}
