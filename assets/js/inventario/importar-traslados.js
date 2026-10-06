// ============================================================================
// inventario/importar-traslados.js — parte de inventario.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { getItems, getLotes, getAlmacenes, getUbicaciones, getStockUbicaciones, addStockUbicacion, updateStockUbicacion, deleteStockUbicacion, addKardexMovimiento } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { _generarNumeroDocumentoTraslado } from './historial-movimientos.js'

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

        // Cada fila del archivo es un traslado independiente (no vienen
        // agrupadas por documento), así que el número se genera POR FILA
        // aquí — a diferencia de guardarTrasladoInterno, donde un solo
        // traslado con varias líneas comparte un único numeroDocumento.
        const almacenOrigenObjImport = almacenesById.get(zonaOrigen.almacen_id)
        const numeroDocumentoImport = await _generarNumeroDocumentoTraslado(almacenOrigenObjImport)

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
          numero_documento:     numeroDocumentoImport,
          // Ver comentario equivalente en guardarTrasladoInterno: entrada =
          // salida en la misma fila, para que un traslado no se cuente como
          // pérdida de inventario en cálculos/vistas por zona.
          cantidad_salida:      cantidad,
          cantidad_entrada:     cantidad,
          cantidad_unidades_entrada: unidades,
          cantidad_unidades_salida:  unidades,
          costo_unitario:       costoUnitario,
          // Mismo costo entra y sale (neto de valor 0) — ver guardarTrasladoInterno.
          valor_entrada:        parseFloat((cantidad * costoUnitario).toFixed(2)),
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
      await window.renderResumenStockUnificado()
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
