// ============================================================================
// ventas/importar-ventas.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { S } from './state.js'
import { getCurrentUser } from '../auth-supabase.js'
import { getCustomers, getLotes, getItems, addVenta, addDetalleVenta, addCuentaCobrar, getAlmacenes, getUbicaciones, getStockUbicaciones } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { getTerminosConCuotas, generarCronograma, cronogramaDesdeTexto } from '../cronograma.js'
import { _guardarCuotasDeCxC } from './venta-nueva.js'
import { renderVentas } from './ventas-lista.js'

// ============================================================================
// IMPORTAR VENTAS MASIVAS (desde Excel/CSV)
// ============================================================================
// Varias filas con el mismo numero_documento forman UNA venta con varias
// líneas. A diferencia de "Nueva Venta" (que reparte el consumo entre varios
// lotes por FIFO), cada línea importada trae su lote y zona EXACTOS —
// mismo criterio que Traslado Interno: si no alcanza el stock ahí, la fila
// falla en vez de buscar stock en otro lado.

window.abrirModalImportarVentas = function () {
  const input = document.getElementById('fileImportarVentas')
  if (input) input.value = ''
  const resumen = document.getElementById('importar-ventas-resumen')
  const log = document.getElementById('importar-ventas-log')
  if (resumen) resumen.innerHTML = ''
  if (log) log.innerHTML = ''
  window.openModal('modal-importar-ventas')
}

export async function _leerArchivoImportVentas(file) {
  const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm')
  const buffer = await file.arrayBuffer()
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true })
  const primeraHoja = wb.SheetNames[0]
  const ws = wb.Sheets[primeraHoja]
  return XLSX.utils.sheet_to_json(ws, { defval: null, raw: true })
}

export function _parseFechaImportVentas(valor) {
  if (!valor) return null
  if (valor instanceof Date) return valor.toISOString().slice(0, 10)
  const s = String(valor).trim()
  if (/^\d+(\.\d+)?$/.test(s)) {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30))
    const d = new Date(excelEpoch.getTime() + parseFloat(s) * 86400000)
    return d.toISOString().slice(0, 10)
  }
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`
  const dmyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (dmyMatch) return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, '0')}-${dmyMatch[1].padStart(2, '0')}`
  return null
}

window.procesarImportacionVentas = async function () {
  const btn = document.getElementById('btnProcesarImportarVentas')
  const input = document.getElementById('fileImportarVentas')
  const resumenEl = document.getElementById('importar-ventas-resumen')
  const logEl = document.getElementById('importar-ventas-log')
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
      filas = await _leerArchivoImportVentas(file)
    } catch (e) {
      console.error('Error leyendo archivo de importación:', e)
      if (resumenEl) resumenEl.innerHTML = '<p style="color:var(--color-danger);">No se pudo leer el archivo. Verifica que sea un .xlsx o .csv válido.</p>'
      return
    }

    if (!filas || filas.length === 0) {
      if (resumenEl) resumenEl.innerHTML = '<p style="color:var(--color-danger);">El archivo no tiene filas de datos.</p>'
      return
    }

    const [clientes, items, lotes, ubicaciones, almacenes, terminos] = await Promise.all([
      getCustomers(), getItems(), getLotes(), getUbicaciones(), getAlmacenes(), getTerminosConCuotas()
    ])
    // Término "Contado" del catálogo: es el fallback cuando la columna
    // termino_pago viene vacía o dice literalmente "CONTADO".
    const terminoContado = terminos.find(t => t.tipo === 'contado') || null
    const clientesPorRuc = new Map(clientes.filter(c => c.nro_documento).map(c => [String(c.nro_documento).trim(), c]))
    const itemsBySku = new Map(items.filter(i => i.sku).map(i => [String(i.sku).trim(), i]))
    const lotesByNumero = new Map(lotes.map(l => [String(l.numero_lote).trim(), l]))
    const almacenesById = new Map(almacenes.map(a => [a.id, a]))
    // Solo zonas de almacenes REALES (no la virtual "Partners") son válidas como origen.
    const zonasRealesByCodigo = new Map(
      ubicaciones.filter(u => !almacenesById.get(u.almacen_id)?.es_virtual).map(u => [String(u.codigo).trim(), u])
    )

    // La importación masiva crea venta + detalle_ventas con el lote/zona del
    // Excel (informativo, igual que al facturar manualmente) pero NO mueve
    // stock ni kardex — eso lo hace después, manual, la Guía de Despacho de
    // Venta. Sí se VALIDA contra el stock real (lote+zona exacto, igual que
    // un traslado) para no facturar algo que ya no hay: se reserva
    // localmente por si dos filas del archivo comparten lote+zona.
    S._lotes = lotes
    S._lotesMap = {}
    for (const lo of (S._lotes || [])) S._lotesMap[lo.id] = lo
    let stockLocal = (await getStockUbicaciones()).map(s => ({ ...s }))
    S._stockUbic = stockLocal

    const grupos = new Map()
    filas.forEach((fila, idx) => {
      const numRaw = fila.numero_documento ?? fila.numeroDocumento
      const num = numRaw != null ? String(numRaw).trim() : ''
      if (!grupos.has(num)) grupos.set(num, [])
      grupos.get(num).push({ fila, numFila: idx + 2 })
    })

    let ok = 0, fallidas = 0
    const logLineas = []

    for (const [numeroDocumento, filasGrupo] of grupos) {
      if (!numeroDocumento) {
        fallidas += filasGrupo.length
        logLineas.push(`Fila ${filasGrupo[0].numFila}: falta "numero_documento".`)
        continue
      }

      const primera = filasGrupo[0].fila
      const rucRaw = primera.cliente_ruc ?? primera.clienteRuc
      const ruc = rucRaw != null ? String(rucRaw).trim() : ''
      const cliente = clientesPorRuc.get(ruc)
      if (!ruc || !cliente) {
        fallidas += filasGrupo.length
        logLineas.push(`Venta "${numeroDocumento}": cliente RUC/DNI "${ruc}" no existe.`)
        continue
      }

      const fecha = _parseFechaImportVentas(primera.fecha_emision ?? primera.fechaEmision)
      if (!fecha) {
        fallidas += filasGrupo.length
        logLineas.push(`Venta "${numeroDocumento}": fecha inválida.`)
        continue
      }

      const tipoComprobante = String(primera.tipo_comprobante ?? primera.tipoComprobante ?? '01').trim()
      if (!['01', '03', '07', '08'].includes(tipoComprobante)) {
        fallidas += filasGrupo.length
        logLineas.push(`Venta "${numeroDocumento}": tipo_comprobante "${tipoComprobante}" inválido (usa 01, 03, 07 u 08).`)
        continue
      }

      const moneda = (primera.moneda || 'PEN').toString().trim().toUpperCase()
      const tipoCambio = moneda === 'USD' ? (parseFloat(primera.tipo_cambio ?? primera.tipoCambio) || 1) : 1

      // Validar cada línea: SKU, lote, zona real, stock exacto disponible
      // (no mueve nada, solo valida y reserva localmente para el resto del archivo).
      const lineas = []
      let grupoValido = true
      for (const { fila, numFila } of filasGrupo) {
        const skuRaw = fila.sku ?? fila.SKU
        const sku = skuRaw != null ? String(skuRaw).trim() : ''
        const loteRaw = fila.numero_lote ?? fila.numeroLote
        const numeroLote = loteRaw != null ? String(loteRaw).trim() : ''
        const zonaRaw = fila.zona_origen ?? fila.zonaOrigen
        const zonaCod = zonaRaw != null ? String(zonaRaw).trim() : ''
        const cantidad = parseFloat(fila.cantidad)
        const precioUnitario = parseFloat(fila.precio_unitario ?? fila.precioUnitario)
        const igvPorcentaje = parseFloat(fila.igv_porcentaje ?? fila.igvPorcentaje ?? 18)
        // cantidad_unidades es opcional en el archivo: si no viene, se
        // estima con el peso_por_unidad del lote (cuando el lote lo tiene
        // calculado). Si el lote no trackea unidades, queda en 0.
        const unidadesRaw = fila.cantidad_unidades ?? fila.unidades
        let cantidadUnidades = unidadesRaw != null && unidadesRaw !== '' ? parseFloat(unidadesRaw) : NaN

        const item = itemsBySku.get(sku)
        const lote = lotesByNumero.get(numeroLote)
        const zona = zonasRealesByCodigo.get(zonaCod)

        if (!sku || !item) { logLineas.push(`Fila ${numFila}: SKU "${sku}" no existe.`); grupoValido = false; continue }
        if (!numeroLote || !lote) { logLineas.push(`Fila ${numFila}: lote "${numeroLote}" no existe.`); grupoValido = false; continue }
        if (lote.item_id !== item.id) { logLineas.push(`Fila ${numFila}: lote "${numeroLote}" no pertenece al SKU "${sku}".`); grupoValido = false; continue }
        if (!zonaCod || !zona) { logLineas.push(`Fila ${numFila}: zona origen "${zonaCod}" no existe o no es una zona real.`); grupoValido = false; continue }
        if (!cantidad || cantidad <= 0) { logLineas.push(`Fila ${numFila}: cantidad inválida.`); grupoValido = false; continue }
        if (isNaN(precioUnitario) || precioUnitario < 0) { logLineas.push(`Fila ${numFila}: precio unitario inválido.`); grupoValido = false; continue }

        if (isNaN(cantidadUnidades)) {
          cantidadUnidades = (lote.peso_por_unidad && lote.peso_por_unidad > 0)
            ? parseFloat((cantidad / lote.peso_por_unidad).toFixed(2))
            : 0
        }

        const filaStock = stockLocal.find(s => s.lote_id === lote.id && s.ubicacion_id === zona.id)
        const disponible = parseFloat(filaStock?.cantidad || 0)
        const disponibleUnid = parseFloat(filaStock?.cantidad_unidades || 0)
        if (!filaStock || cantidad > disponible) {
          logLineas.push(`Fila ${numFila}: stock insuficiente en "${zonaCod}" para lote "${numeroLote}" (disponible ${disponible.toLocaleString('en-US', { maximumFractionDigits: 2 })}).`)
          grupoValido = false
          continue
        }
        if (cantidadUnidades > 0 && cantidadUnidades > disponibleUnid) {
          logLineas.push(`Fila ${numFila}: unidades insuficientes en "${zonaCod}" para lote "${numeroLote}" (disponible ${disponibleUnid.toLocaleString('en-US', { maximumFractionDigits: 2 })} und).`)
          grupoValido = false
          continue
        }

        const subtotal = parseFloat((cantidad * precioUnitario).toFixed(2))
        const igvMonto = parseFloat((subtotal * igvPorcentaje / 100).toFixed(2))
        const totalLinea = parseFloat((subtotal + igvMonto).toFixed(2))

        // Reserva local: esta cantidad ya no está disponible para la
        // siguiente fila del archivo que use el mismo lote+zona (no se
        // escribe en la BD, es solo para no sobrevender dentro del mismo
        // archivo importado).
        filaStock.cantidad = parseFloat((disponible - cantidad).toFixed(4))
        filaStock.cantidad_unidades = parseFloat((disponibleUnid - cantidadUnidades).toFixed(4))

        lineas.push({
          item_id: item.id,
          lote_id: lote.id,
          ubicacion_id: zona.id,
          descripcion: item.nombre,
          unidad_medida: item.unidad_medida || 'UND',
          cantidad,
          cantidad_unidades: cantidadUnidades,
          precio_unitario: precioUnitario,
          subtotal,
          tipo_base: igvPorcentaje > 0 ? 'gravada' : 'exonerada',
          igv_porcentaje: igvPorcentaje,
          igv_monto: igvMonto,
          total_linea: totalLinea,
          costo_unitario: parseFloat(lote.costo_unitario || 0)
        })
      }

      if (!grupoValido || lineas.length === 0) {
        fallidas += filasGrupo.length
        continue
      }

      try {
        const base = lineas.reduce((s, l) => s + l.subtotal, 0)
        const igv = lineas.reduce((s, l) => s + l.igv_monto, 0)
        const total = lineas.reduce((s, l) => s + l.total_linea, 0)
        const [serieV, correlativoV] = numeroDocumento.includes('-')
          ? numeroDocumento.split(/-(.+)/)
          : [null, numeroDocumento]

        // Término de pago: se interpreta el texto libre de la columna
        // termino_pago (ej. "CONTADO", "45 DIAS", "60-75-90 DIAS", tal cual
        // viene de Odoo). Si la columna no viene o el texto no trae ningún
        // número reconocible, se usa el término habitual del cliente y, si
        // tampoco tiene uno asignado, Contado.
        const terminoTexto = primera.termino_pago ?? primera.terminoPago ?? ''
        let crono = cronogramaDesdeTexto(terminoTexto, total, fecha, terminoContado)
        if (!crono) {
          const terminoCliente = terminos.find(x => x.id === cliente.termino_pago_id)
          crono = {
            cuotas: generarCronograma(terminoCliente || terminoContado, total, fecha),
            terminoId: cliente.termino_pago_id || terminoContado?.id || null,
            personalizado: false
          }
          if (terminoTexto) {
            logLineas.push(`Venta "${numeroDocumento}": término de pago "${terminoTexto}" no reconocido, se usó ${terminoCliente ? terminoCliente.nombre : 'Contado'}.`)
          }
        }
        const fechaVencCrono = crono.cuotas[crono.cuotas.length - 1].fecha_vencimiento

        const venta = await addVenta({
          numero:           numeroDocumento,
          tipo_comprobante: tipoComprobante,
          serie:            serieV,
          correlativo:      correlativoV,
          contact_id:       cliente.id,
          fecha_emision:    fecha,
          fecha_vencimiento: fechaVencCrono,
          periodo_contable: fecha.slice(0, 7),
          moneda,
          tipo_cambio:      tipoCambio,
          base_imponible:   parseFloat(base.toFixed(2)),
          igv:              parseFloat(igv.toFixed(2)),
          total:            parseFloat(total.toFixed(2)),
          estado:           'emitida',
          estado_pago:      'pendiente',
          cpe_estado:       'no_enviado',
          descripcion:      `Venta importada - ${cliente.nombre || ''}`,
          observaciones:    null,
          termino_pago_id:  crono.terminoId,
          cronograma_personalizado: crono.personalizado,
          created_by:       user.db_id
        })

        if (!venta?.id) {
          fallidas += filasGrupo.length
          logLineas.push(`Venta "${numeroDocumento}": no se pudo registrar (¿número duplicado?).`)
          continue
        }

        // Venta + detalle_ventas con lote/zona del Excel (informativo, ya
        // validado arriba contra stock real) — sin tocar stock/kardex. El
        // despacho real se hace después, manual, en la Guía de Despacho.
        for (const l of lineas) {
          await addDetalleVenta({
            venta_id: venta.id,
            lote_id: l.lote_id,
            ubicacion_id: l.ubicacion_id,
            item_id: l.item_id,
            descripcion: l.descripcion,
            unidad_medida: l.unidad_medida,
            cantidad: l.cantidad,
            cantidad_unidades: l.cantidad_unidades || 0,
            precio_unitario: l.precio_unitario,
            subtotal: l.subtotal,
            tipo_base: l.tipo_base,
            igv_porcentaje: l.igv_porcentaje,
            igv_monto: l.igv_monto,
            total_linea: l.total_linea,
            costo_unitario: l.costo_unitario
          })
        }

        if (tipoComprobante === '01' || tipoComprobante === '03') {
          try {
            const cxc = await addCuentaCobrar({
              contact_id:          cliente.id,
              venta_id:            venta.id,
              tipo_comprobante:    tipoComprobante,
              serie:               serieV,
              numero_comprobante:  correlativoV,
              fecha_emision:       fecha,
              fecha_vencimiento:   fechaVencCrono,
              moneda,
              tipo_cambio:         tipoCambio,
              monto_total:         parseFloat(total.toFixed(2)),
              monto_cobrado:       0,
              estado:              'pendiente',
              termino_pago_id:     crono.terminoId,
              cronograma_personalizado: crono.personalizado
            })
            if (cxc?.id) await _guardarCuotasDeCxC(cxc.id, crono)
          } catch (eCxC) {
            console.warn(`Venta ${numeroDocumento} creada pero CxC falló:`, eCxC.message)
          }
        }

        ok += filasGrupo.length
      } catch (e) {
        console.error(`Error importando venta ${numeroDocumento}:`, e)
        fallidas += filasGrupo.length
        logLineas.push(`Venta "${numeroDocumento}": error inesperado al procesar (ver consola).`)
      }
    }

    if (resumenEl) {
      resumenEl.innerHTML = `
        <div style="display:flex; gap:20px;">
          <div><strong style="color:var(--color-success);">${ok}</strong> líneas importadas</div>
          <div><strong style="color:${fallidas > 0 ? 'var(--color-danger)' : 'var(--text-secondary)'};">${fallidas}</strong> filas con error</div>
        </div>`
    }
    if (logEl) {
      logEl.innerHTML = logLineas.length > 0
        ? `<ul style="margin:0; padding-left:18px; color:var(--color-danger);">${logLineas.map(l => `<li>${l}</li>`).join('')}</ul>`
        : ''
    }

    if (ok > 0) {
      showToast(`Ventas importadas correctamente (${ok} línea(s)).`, 'success')
      await renderVentas(true)
    }
    if (fallidas > 0 && ok === 0) {
      showToast('No se pudo importar ninguna fila. Revisa el detalle de errores.', 'danger')
    }
  } catch (error) {
    console.error('Error en procesarImportacionVentas:', error)
    showToast('Error al procesar la importación', 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Procesar Importación' }
  }
}
