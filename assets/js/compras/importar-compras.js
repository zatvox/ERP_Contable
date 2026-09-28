// ============================================================================
// compras/importar-compras.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { addCompra, addCompraDetalle, getItems, getSuppliers } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { getTerminosConCuotas, generarCronograma, cronogramaDesdeTexto } from '../cronograma.js'
import { renderCompras } from './compras-lista.js'
import { _crearCuentaPagarSiFactura } from './ordenes-compra.js'

// ============================================================================
// IMPORTAR COMPRAS MASIVAS (desde Excel/CSV)
// ============================================================================
// Varias filas con el mismo numero_comprobante forman UNA compra con varias
// líneas (mismo criterio que "Nueva Compra (Mercadería)"). Solo llena
// compras + compra_detalles: NO toca stock/lotes/kardex — la Guía de
// Remisión de cada compra importada queda pendiente, igual que si se
// hubiera registrado la compra a mano desde el formulario.

window.abrirModalImportarCompras = function () {
  const input = document.getElementById('fileImportarCompras')
  if (input) input.value = ''
  const resumen = document.getElementById('importar-compras-resumen')
  const log = document.getElementById('importar-compras-log')
  if (resumen) resumen.innerHTML = ''
  if (log) log.innerHTML = ''
  window.openModal('modal-importar-compras')
}

export async function _leerArchivoImportGenerico(file) {
  const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm')
  const buffer = await file.arrayBuffer()
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true })
  const primeraHoja = wb.SheetNames[0]
  const ws = wb.Sheets[primeraHoja]
  return XLSX.utils.sheet_to_json(ws, { defval: null, raw: true })
}

export function _parseFechaImportGenerico(valor) {
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

window.procesarImportacionCompras = async function () {
  const btn = document.getElementById('btnProcesarImportarCompras')
  const input = document.getElementById('fileImportarCompras')
  const resumenEl = document.getElementById('importar-compras-resumen')
  const logEl = document.getElementById('importar-compras-log')
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
      filas = await _leerArchivoImportGenerico(file)
    } catch (e) {
      console.error('Error leyendo archivo de importación:', e)
      if (resumenEl) resumenEl.innerHTML = '<p style="color:var(--color-danger);">No se pudo leer el archivo. Verifica que sea un .xlsx o .csv válido.</p>'
      return
    }

    if (!filas || filas.length === 0) {
      if (resumenEl) resumenEl.innerHTML = '<p style="color:var(--color-danger);">El archivo no tiene filas de datos.</p>'
      return
    }

    const [proveedores, items, terminos] = await Promise.all([getSuppliers(), getItems(), getTerminosConCuotas()])
    const provPorRuc = new Map(proveedores.filter(p => p.nro_documento).map(p => [String(p.nro_documento).trim(), p]))
    const itemsBySku = new Map(items.filter(i => i.sku).map(i => [String(i.sku).trim(), i]))
    // Término "Contado" del catálogo: fallback cuando termino_pago viene
    // vacío o dice literalmente "CONTADO".
    const terminoContado = terminos.find(t => t.tipo === 'contado') || null

    // Agrupar filas por numero_comprobante, preservando el orden de aparición.
    const grupos = new Map()
    filas.forEach((fila, idx) => {
      const numRaw = fila.numero_comprobante ?? fila.numeroComprobante
      const num = numRaw != null ? String(numRaw).trim() : ''
      if (!grupos.has(num)) grupos.set(num, [])
      grupos.get(num).push({ fila, numFila: idx + 2 })
    })

    let ok = 0, fallidas = 0
    const logLineas = []

    for (const [numeroComprobante, filasGrupo] of grupos) {
      if (!numeroComprobante) {
        fallidas += filasGrupo.length
        logLineas.push(`Fila ${filasGrupo[0].numFila}: falta "numero_comprobante".`)
        continue
      }

      const primera = filasGrupo[0].fila
      const rucRaw = primera.proveedor_ruc ?? primera.proveedorRuc
      const ruc = rucRaw != null ? String(rucRaw).trim() : ''
      const prov = provPorRuc.get(ruc)
      if (!ruc || !prov) {
        fallidas += filasGrupo.length
        logLineas.push(`Compra "${numeroComprobante}": proveedor RUC "${ruc}" no existe.`)
        continue
      }

      const fecha = _parseFechaImportGenerico(primera.fecha_emision ?? primera.fechaEmision)
      if (!fecha) {
        fallidas += filasGrupo.length
        logLineas.push(`Compra "${numeroComprobante}": fecha inválida.`)
        continue
      }

      const moneda = (primera.moneda || 'PEN').toString().trim().toUpperCase()
      const tipoCambio = moneda === 'USD' ? (parseFloat(primera.tipo_cambio ?? primera.tipoCambio) || 1) : 1

      // Validar cada línea de este comprobante antes de escribir nada.
      const lineas = []
      let grupoValido = true
      for (const { fila, numFila } of filasGrupo) {
        const skuRaw = fila.sku ?? fila.SKU
        const sku = skuRaw != null ? String(skuRaw).trim() : ''
        const item = itemsBySku.get(sku)
        const cantidad = parseFloat(fila.cantidad)
        const precioUnitario = parseFloat(fila.precio_unitario ?? fila.precioUnitario)
        const igvPorcentaje = parseFloat(fila.igv_porcentaje ?? fila.igvPorcentaje ?? 18)

        if (!sku || !item) { logLineas.push(`Fila ${numFila}: SKU "${sku}" no existe.`); grupoValido = false; continue }
        if (!cantidad || cantidad <= 0) { logLineas.push(`Fila ${numFila}: cantidad inválida.`); grupoValido = false; continue }
        if (isNaN(precioUnitario) || precioUnitario < 0) { logLineas.push(`Fila ${numFila}: precio unitario inválido.`); grupoValido = false; continue }

        const subtotal = parseFloat((cantidad * precioUnitario).toFixed(2))
        const igvMonto = parseFloat((subtotal * igvPorcentaje / 100).toFixed(2))
        const totalLinea = parseFloat((subtotal + igvMonto).toFixed(2))

        lineas.push({
          item_id: item.id,
          descripcion: item.nombre,
          unidad_medida: item.unidad_medida || 'UND',
          cantidad,
          precio_unitario: precioUnitario,
          subtotal,
          tipo_base: igvPorcentaje > 0 ? 'gravada' : 'exonerada',
          igv_porcentaje: igvPorcentaje,
          igv_monto: igvMonto,
          total_linea: totalLinea,
          unidades: null
        })
      }

      if (!grupoValido || lineas.length === 0) {
        fallidas += filasGrupo.length
        continue
      }

      try {
        const cantidadTotal = lineas.reduce((s, l) => s + l.cantidad, 0) || 1
        const subtotalC = lineas.reduce((s, l) => s + l.subtotal, 0)
        const igvC = lineas.reduce((s, l) => s + l.igv_monto, 0)
        const totalC = lineas.reduce((s, l) => s + l.total_linea, 0)
        const [serieC, numeroC] = numeroComprobante.includes('-')
          ? numeroComprobante.split(/-(.+)/)
          : [null, numeroComprobante]

        // Término de pago: texto libre de Odoo ("CONTADO", "45 DIAS",
        // "60-75-90 DIAS"...). Sin match reconocible, cae al término
        // habitual del proveedor y, si no tiene, a Contado.
        const terminoTexto = primera.termino_pago ?? primera.terminoPago ?? ''
        let crono = cronogramaDesdeTexto(terminoTexto, totalC, fecha, terminoContado)
        if (!crono) {
          const terminoProv = terminos.find(x => x.id === prov.termino_pago_id)
          crono = {
            cuotas: generarCronograma(terminoProv || terminoContado, totalC, fecha),
            terminoId: prov.termino_pago_id || terminoContado?.id || null,
            personalizado: false
          }
          if (terminoTexto) {
            logLineas.push(`Compra "${numeroComprobante}": término de pago "${terminoTexto}" no reconocido, se usó ${terminoProv ? terminoProv.nombre : 'Contado'}.`)
          }
        }

        const compra = await addCompra({
          referencia:             numeroComprobante,
          tipo_referencia:        'compra_directa',
          tipo_comprobante:       '01',
          serie:                  serieC,
          numero:                 numeroC,
          periodo_mes:            parseInt(fecha.slice(5, 7)),
          periodo_ano:            parseInt(fecha.slice(0, 4)),
          fecha_emision:          fecha,
          fecha_recepcion:        fecha,
          contact_id:             prov.id,
          proveedor_ruc:          prov.nro_documento || '-',
          proveedor_nombre:       prov.nombre || '-',
          tipo_compra:            'mercaderia',
          descripcion:            `Compra directa (importada) - ${prov.nombre || ''}`,
          cantidad:               cantidadTotal,
          total_unidades:         null,
          precio_unitario:        parseFloat((subtotalC / cantidadTotal).toFixed(4)) || 0,
          base_imponible_gravada: subtotalC,
          igv_gravado:            igvC,
          subtotal:               subtotalC,
          total:                  totalC,
          currency:               moneda,
          tipo_cambio:            tipoCambio,
          estado_pago:            'pendiente',
          asiento_id:             null,
          termino_pago_id:        crono.terminoId,
          cronograma_personalizado: crono.personalizado,
          created_by:             user.db_id
        })

        if (!compra?.id) {
          fallidas += filasGrupo.length
          logLineas.push(`Compra "${numeroComprobante}": no se pudo registrar (¿referencia duplicada?).`)
          continue
        }
        await _crearCuentaPagarSiFactura(compra, user.db_id, crono)

        for (const l of lineas) {
          await addCompraDetalle({ compra_id: compra.id, ...l })
        }

        ok += filasGrupo.length
      } catch (e) {
        console.error(`Error importando compra ${numeroComprobante}:`, e)
        fallidas += filasGrupo.length
        logLineas.push(`Compra "${numeroComprobante}": error inesperado al procesar (ver consola).`)
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
      showToast(`Compras importadas correctamente (${ok} línea(s)). La Guía de Remisión de cada una queda pendiente.`, 'success')
      await renderCompras(true)
    }
    if (fallidas > 0 && ok === 0) {
      showToast('No se pudo importar ninguna fila. Revisa el detalle de errores.', 'danger')
    }
  } catch (error) {
    console.error('Error en procesarImportacionCompras:', error)
    showToast('Error al procesar la importación', 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Procesar Importación' }
  }
}
