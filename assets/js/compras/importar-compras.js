// ============================================================================
// compras/importar-compras.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { addCompra, addCompraDetalle, getItems, getSuppliers, getCompras } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { mostrarCarga, actualizarCarga, ocultarCarga } from '../animaciones/index.js'
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
  const chk = document.getElementById('chkSimularCompras')
  if (chk) chk.checked = true
  window.openModal('modal-importar-compras')
}

export async function _leerArchivoImportGenerico(file) {
  const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm')
  const buffer = await file.arrayBuffer()
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true })
  // Las plantillas nuevas traen varias hojas (DATOS + REVISAR + RESUMEN).
  // Se lee DATOS si existe; si no, la primera, para no romper los archivos
  // de una sola hoja de siempre.
  const hoja = wb.SheetNames.find(n => String(n).trim().toUpperCase() === 'DATOS') || wb.SheetNames[0]
  const ws = wb.Sheets[hoja]
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
    const simular = !!document.getElementById('chkSimularCompras')?.checked
    if (btn) { btn.disabled = true; btn.textContent = simular ? 'Simulando...' : 'Procesando...' }
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

    const [proveedores, items, terminos, comprasExistentes] = await Promise.all([
      getSuppliers(), getItems(), getTerminosConCuotas(), getCompras()
    ])
    const provPorRuc = new Map(proveedores.filter(p => p.nro_documento).map(p => [String(p.nro_documento).trim(), p]))
    const itemsBySku = new Map(items.filter(i => i.sku).map(i => [String(i.sku).trim(), i]))
    // Término "Contado" del catálogo: fallback cuando termino_pago viene
    // vacío o dice literalmente "CONTADO".
    const terminoContado = terminos.find(t => t.tipo === 'contado') || null

    // Un mismo N° de comprobante puede repetirse entre proveedores distintos
    // (F001-000123 lo emite cualquiera), así que el duplicado se mide por
    // (proveedor, N° de comprobante). Sin este control, volver a correr el
    // mismo archivo creaba las compras mellizas y duplicaba la cuenta por
    // pagar.
    const comprasYaUsadas = new Set()
    const numerosYaUsados = new Map()   // N° -> Set de proveedores
    for (const c of (comprasExistentes || [])) {
      for (const n of [c.numero, c.referencia]) {
        const num = String(n || '').trim().toUpperCase()
        if (!num) continue
        const prov = c.contact_id != null ? String(c.contact_id) : '?'
        comprasYaUsadas.add(`${prov}|${num}`)
        if (!numerosYaUsados.has(num)) numerosYaUsados.set(num, new Set())
        numerosYaUsados.get(num).add(prov)
      }
    }

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

    // La cabecera de un documento se lee SOLO de su primera fila. Repetir el
    // N° significa "estas filas son el detalle del mismo documento", así que
    // los datos de cabecera tienen que coincidir en todas. Si no coinciden no
    // es detalle: es un número repetido por error. Antes se ignoraba en
    // silencio y la compra quedaba con los datos de la primera fila.
    // `norm` normaliza antes de comparar: una fecha leída de Excel llega como
    // Date y dos celdas iguales se verían distintas (y el mensaje saldría con
    // el Date completo, ilegible).
    const _incoherencias = (filasDelGrupo, campos) => {
      const malas = []
      for (const [etiqueta, alias, norm] of campos) {
        const vistos = new Set()
        for (const { fila } of filasDelGrupo) {
          let crudo = null
          for (const a of alias) {
            if (fila[a] != null && String(fila[a]).trim() !== '') { crudo = fila[a]; break }
          }
          vistos.add(crudo == null ? '' : (norm ? (norm(crudo) || '') : String(crudo).trim().toUpperCase()))
        }
        if (vistos.size > 1) malas.push(`${etiqueta} (${[...vistos].map(v => v || '(vacío)').join(' / ')})`)
      }
      return malas
    }
    const _normFecha = (v) => _parseFechaImportGenerico(v) || String(v).trim().toUpperCase()
    const _normTipo  = (v) => String(v).trim().padStart(2, '0')
    const CAMPOS_CABECERA_COMPRA = [
      ['proveedor_ruc',    ['proveedor_ruc', 'proveedorRuc']],
      ['fecha_emision',    ['fecha_emision', 'fechaEmision'], _normFecha],
      ['moneda',           ['moneda']],
      ['tipo_cambio',      ['tipo_cambio', 'tipoCambio']],
      ['tipo_comprobante', ['tipo_comprobante', 'tipoComprobante'], _normTipo],
      ['termino_pago',     ['termino_pago', 'terminoPago']]
    ]

    await mostrarCarga({
      titulo: simular ? 'Simulando importación de compras' : 'Importando compras',
      subtitulo: `${grupos.size} comprobante${grupos.size === 1 ? '' : 's'}`,
      total: grupos.size
    })

    for (const [numeroComprobante, filasGrupo] of grupos) {
      actualizarCarga(undefined, numeroComprobante || '(sin N°)')
      if (!numeroComprobante) {
        fallidas += filasGrupo.length
        logLineas.push(`Fila ${filasGrupo[0].numFila}: falta "numero_comprobante".`)
        continue
      }

      const malas = _incoherencias(filasGrupo, CAMPOS_CABECERA_COMPRA)
      if (malas.length) {
        fallidas += filasGrupo.length
        logLineas.push(`Compra "${numeroComprobante}": sus ${filasGrupo.length} filas no coinciden en ${malas.join(', ')}. Si son dos comprobantes distintos, diferéncialos; si es uno solo, repite la cabecera igual en todas sus filas.`)
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

      // Duplicado por (proveedor, N° de comprobante).
      const _numClave = numeroComprobante.toUpperCase()
      const _provClave = prov.id != null ? String(prov.id) : '?'
      if (comprasYaUsadas.has(`${_provClave}|${_numClave}`)) {
        fallidas += filasGrupo.length
        logLineas.push(`Compra "${numeroComprobante}": ya está registrada para ${prov.nombre || prov.razon_social || 'ese proveedor'}. Se omite para no duplicarla.`)
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

      // Tipo de comprobante: columna opcional, '01' (Factura) por defecto.
      // El caso que lo motivó es el '91' — Invoice de proveedor NO DOMICILIADO
      // de una importación. Ese comprobante NO lleva IGV: el IGV de la
      // importación se paga en aduanas con la DAM y se toma como crédito
      // fiscal por ahí, no por esta factura. Por eso sus líneas van con IGV 0
      // y base NO GRAVADA, y la compra se marca como 'importacion'.
      const TIPOS_OK = ['01','02','03','08','09','10','12','18','20','91','97','98']
      // Excel/CSV suelen leer "01" como el número 1: se rellena a 2 dígitos
      // para que no falle un archivo correcto guardado sin formato de texto.
      const tipoComprobante = (String(primera.tipo_comprobante ?? primera.tipoComprobante ?? '01').trim() || '01').padStart(2, '0')
      if (!TIPOS_OK.includes(tipoComprobante)) {
        fallidas += filasGrupo.length
        logLineas.push(`Compra "${numeroComprobante}": tipo_comprobante "${tipoComprobante}" inválido.`)
        continue
      }
      const esNoDomiciliado = tipoComprobante === '91'

      // Validar cada línea de este comprobante antes de escribir nada.
      const lineas = []
      let grupoValido = true
      for (const { fila, numFila } of filasGrupo) {
        const skuRaw = fila.sku ?? fila.SKU
        const sku = skuRaw != null ? String(skuRaw).trim() : ''
        const item = itemsBySku.get(sku)
        const cantidad = parseFloat(fila.cantidad)
        const precioUnitario = parseFloat(fila.precio_unitario ?? fila.precioUnitario)
        const igvPorcentaje = parseFloat(fila.igv_porcentaje ?? fila.igvPorcentaje ?? (esNoDomiciliado ? 0 : 18))

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
          // 'no_gravada' (no 'exonerada'): la exoneración es un beneficio sobre
          // una operación que sí está dentro del ámbito del IGV; la compra a
          // un no domiciliado directamente no lo está. Cuadra con la columna
          // base_imponible_no_gravada de la cabecera.
          tipo_base: igvPorcentaje > 0 ? 'gravada' : (esNoDomiciliado ? 'no_gravada' : 'exonerada'),
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
        const baseGravadaC   = lineas.filter(l => l.tipo_base === 'gravada').reduce((s, l) => s + l.subtotal, 0)
        const baseNoGravadaC = subtotalC - baseGravadaC
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

        // Se marca ANTES de la simulación: así el mismo N° repetido dos veces
        // dentro del archivo también se detecta en modo simular.
        comprasYaUsadas.add(`${_provClave}|${_numClave}`)

        // Simulación: se valida TODO el archivo y no se escribe nada. Es la
        // red antes de una carga masiva — deshacer 47 comprobantes a mano no
        // es una opción.
        if (simular) { ok += filasGrupo.length; continue }

      const compra = await addCompra({
          referencia:             numeroComprobante,
          tipo_referencia:        'compra_directa',
          tipo_comprobante:       tipoComprobante,
          serie:                  serieC,
          numero:                 numeroC,
          periodo_mes:            parseInt(fecha.slice(5, 7)),
          periodo_ano:            parseInt(fecha.slice(0, 4)),
          fecha_emision:          fecha,
          fecha_recepcion:        fecha,
          contact_id:             prov.id,
          proveedor_ruc:          prov.nro_documento || '-',
          proveedor_nombre:       prov.nombre || '-',
          tipo_compra:            esNoDomiciliado ? 'importacion' : 'mercaderia',
          descripcion:            `${esNoDomiciliado ? 'Importación' : 'Compra directa'} (importada) - ${prov.nombre || ''}`,
          cantidad:               cantidadTotal,
          total_unidades:         null,
          precio_unitario:        parseFloat((subtotalC / cantidadTotal).toFixed(4)) || 0,
          base_imponible_gravada:    baseGravadaC,
          base_imponible_no_gravada: baseNoGravadaC,
          igv_gravado:               igvC,
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
          <div><strong style="color:var(--color-success);">${ok}</strong> líneas ${simular ? 'válidas' : 'importadas'}</div>
          <div><strong style="color:${fallidas > 0 ? 'var(--color-danger)' : 'var(--text-secondary)'};">${fallidas}</strong> filas con error</div>
        </div>${simular ? '<p style="color:var(--color-info); margin-top:8px;">Simulación: no se escribió nada. Desmarca «Sólo simular» para importar de verdad.</p>' : ''}`
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
    ocultarCarga()
    if (btn) { btn.disabled = false; btn.textContent = 'Procesar Importación' }
  }
}
