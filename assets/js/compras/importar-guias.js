// ============================================================================
// compras/importar-guias.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { getCompras, getCompraDetalles, getLoteById, getLotes, addLote, updateLote, getItems, getMarcas, getGuiasIngresoCompra, addGuiaIngresoCompra, addDetalleGuiaIngresoCompra, getAlmacenes, getUbicaciones, addStockUbicacion, getUbicacionVendors, addKardexMovimiento, updateStockUbicacion, getStockUbicacionesByLote } from '../supabase-data.js'
import { showToast, formatQty } from '../helpers.js'
import { _invalidarCacheCompras } from './anulacion.js'
import { _escCompras } from './buscadores.js'
import { renderCompras } from './compras-lista.js'
import { _cargarComprasConGuia, renderGuias } from './guias-ingreso-lista.js'
import { _leerArchivoImportGenerico, _parseFechaImportGenerico } from './importar-compras.js'

// ============================================================================
// IMPORTACIÓN MASIVA DE GUÍAS DE INGRESO
// ============================================================================
// Reconstruye guías ya recibidas físicamente (típicamente al migrar desde otro
// sistema) sin tener que digitarlas una por una.
//
// A diferencia del importador de Compras — que solo crea documentos — este SÍ
// mueve stock: crea o suma lotes, escribe stock_ubicaciones y genera kardex,
// exactamente igual que `guardarGuiaIngresoCompra`. Por eso trae un modo
// SIMULACIÓN activado por defecto: valida el archivo completo y muestra qué
// pasaría, sin escribir nada. Con miles de filas, descubrir un error a mitad
// del proceso dejaría la base a medio migrar.

window.abrirModalImportarGuias = function () {
  const input = document.getElementById('fileImportarGuias')
  if (input) input.value = ''
  const chk = document.getElementById('chkSimularGuias')
  if (chk) chk.checked = true
  _html('importar-guias-resumen', '')
  _html('importar-guias-log', '')
  window.openModal('modal-importar-guias')
}

window.descargarPlantillaGuiasCompra = async function () {
  const { descargarCSV } = await import('./reportes.js')
  descargarCSV('plantilla_guias_ingreso.csv', [
    ['numero_guia', 'fecha_guia', 'compra_numero', 'sku', 'cantidad', 'numero_unidades',
     'numero_lote', 'marca', 'codigo_partida', 'almacen', 'zona', 'observaciones'],
    ['EG07-00006033', '2026-01-12', 'TCKI25628961', 'SKU-001', '24480', '680',
     'HR-Q0830721', 'BENJI', 'LT.26027', 'SJL2', 'Zona A', '(DAM) N° 118-2025-10-555842'],
    ['EG07-00006033', '2026-01-12', 'TCKI25628961', 'SKU-002', '5000', '100',
     'HR-Q0830722', 'BENJI', '', 'SJL2', 'Zona B', '']
  ])
}

function _valorFila(fila, ...nombres) {
  for (const n of nombres) {
    if (fila[n] !== undefined && fila[n] !== null && String(fila[n]).trim() !== '') return String(fila[n]).trim()
  }
  return ''
}

window.procesarImportacionGuias = async function () {
  const btn      = document.getElementById('btnProcesarImportarGuias')
  const input    = document.getElementById('fileImportarGuias')
  const simular  = !!document.getElementById('chkSimularGuias')?.checked
  if (btn?.disabled) return

  const file = input?.files?.[0]
  if (!file) { showToast('Selecciona un archivo primero', 'warning'); return }

  const log = []
  const anotar = (tipo, texto) => log.push({ tipo, texto })

  try {
    if (btn) { btn.disabled = true; btn.textContent = simular ? 'Simulando...' : 'Importando...' }
    _html('importar-guias-resumen', '<p style="color:var(--text-secondary);">Leyendo archivo...</p>')
    _html('importar-guias-log', '')

    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    let filas
    try {
      filas = await _leerArchivoImportGenerico(file)
    } catch (e) {
      _html('importar-guias-resumen', '<p style="color:var(--color-danger);">No se pudo leer el archivo. Verifica que sea un .xlsx o .csv válido.</p>')
      return
    }
    if (!filas?.length) {
      _html('importar-guias-resumen', '<p style="color:var(--color-danger);">El archivo no tiene filas de datos.</p>')
      return
    }

    // ── Catálogos para resolver los textos del archivo a ids ──────────────
    const [compras, items, marcas, zonas, almacenes, lotes, guiasExistentes] = await Promise.all([
      getCompras(), getItems(), getMarcas(), getUbicaciones(), getAlmacenes(), getLotes(), getGuiasIngresoCompra()
    ])

    // Una compra se puede referenciar por su N° de comprobante, por
    // serie-numero o por su referencia interna: se indexan las tres formas.
    const compraPorClave = new Map()
    for (const c of (compras || [])) {
      const claves = [c.numero, c.referencia, c.serie && c.numero ? `${c.serie}-${c.numero}` : null]
      for (const k of claves) if (k) compraPorClave.set(String(k).trim().toUpperCase(), c)
    }
    const itemPorSku   = new Map((items || []).filter(i => i.sku).map(i => [String(i.sku).trim().toUpperCase(), i]))
    const marcaPorNom  = new Map((marcas || []).map(m => [String(m.nombre || '').trim().toUpperCase(), m]))
    const almacenPorId = new Map((almacenes || []).map(a => [a.id, a]))
    const guiasYaUsadas = new Set((guiasExistentes || []).map(g => String(g.numero_guia || '').trim().toUpperCase()))

    // Zona: se busca por "almacen + zona"; si el archivo solo trae zona y su
    // nombre es único en todo el sistema, también se acepta.
    const zonaPorClave = new Map()
    const zonaPorNombreSolo = new Map()
    for (const z of (zonas || [])) {
      const alm = almacenPorId.get(z.almacen_id)
      if (alm?.es_virtual) continue   // Partners/Vendors no es una zona real de recepción
      zonaPorClave.set(`${String(alm?.nombre || '').trim().toUpperCase()}|${String(z.nombre || '').trim().toUpperCase()}`, z)
      const soloNombre = String(z.nombre || '').trim().toUpperCase()
      zonaPorNombreSolo.set(soloNombre, zonaPorNombreSolo.has(soloNombre) ? null : z) // null = ambiguo
    }

    const lotePorItemNumero = new Map()
    for (const l of (lotes || [])) {
      if (!l.item_id || !l.numero_lote) continue
      lotePorItemNumero.set(`${l.item_id}|${String(l.numero_lote).trim().toUpperCase()}`, l)
    }

    // ── Agrupar por N° de guía, preservando el orden de aparición ─────────
    const grupos = new Map()
    filas.forEach((fila, i) => {
      const numeroGuia = _valorFila(fila, 'numero_guia', 'numero guia', 'guia', 'nro_guia')
      if (!numeroGuia) { anotar('error', `Fila ${i + 2}: sin numero_guia, se omite`); return }
      const clave = numeroGuia.toUpperCase()
      if (!grupos.has(clave)) grupos.set(clave, { numeroGuia, filas: [] })
      grupos.get(clave).filas.push({ fila, nroFila: i + 2 })
    })

    // ── Validar TODO antes de escribir nada ───────────────────────────────
    const guiasValidas = []
    let filasConError = 0

    for (const [clave, grupo] of grupos) {
      const errores = []

      if (guiasYaUsadas.has(clave)) {
        errores.push(`la guía ${grupo.numeroGuia} ya existe en el sistema`)
      }

      const primera = grupo.filas[0].fila
      const compraClave = _valorFila(primera, 'compra_numero', 'compra', 'numero_comprobante', 'referencia').toUpperCase()
      const compra = compraPorClave.get(compraClave)
      if (!compra) errores.push(`no se encontró la compra "${compraClave || '(vacío)'}"`)

      const fechaGuia = _parseFechaImportGenerico(_valorFila(primera, 'fecha_guia', 'fecha'))
      if (!fechaGuia) errores.push('fecha_guia inválida o vacía')

      const observaciones = _valorFila(primera, 'observaciones', 'observacion') || null

      // Detalle de la compra: cada línea del archivo debe corresponder a un
      // producto realmente comprado, para poder enlazar detalle_compra_id.
      const detallesCompra = compra ? await getCompraDetalles(compra.id) : []
      const detallePorItem = new Map()
      for (const d of (detallesCompra || [])) if (d.item_id) detallePorItem.set(d.item_id, d)

      const lineas = []
      // Reserva local: si dos filas usan el mismo lote nuevo, la segunda debe
      // saber que la primera ya lo va a crear (si no, se crearía dos veces).
      const lotesNuevosEnEsteArchivo = new Set()

      for (const { fila, nroFila } of grupo.filas) {
        const errFila = []

        const sku  = _valorFila(fila, 'sku', 'codigo', 'producto').toUpperCase()
        const item = itemPorSku.get(sku)
        if (!item) errFila.push(`SKU "${sku || '(vacío)'}" no existe`)

        const cantidad = parseFloat(_valorFila(fila, 'cantidad', 'cantidad_kg', 'kg') || 0)
        if (!(cantidad > 0)) errFila.push('cantidad debe ser mayor a 0')

        const unidades = parseFloat(_valorFila(fila, 'numero_unidades', 'unidades', 'n_unidades') || 0) || null
        // Obligatorio (mismo motivo que en el formulario manual): sin esto
        // peso_por_unidad queda null y el lote nunca podrá sugerir unidades
        // al vender. Causó un bug de 13 lotes corregido el 05/09/2026.
        if (!(unidades > 0)) errFila.push('falta numero_unidades (obligatorio, mayor a 0)')

        const numeroLote = _valorFila(fila, 'numero_lote', 'lote')
        if (!numeroLote) errFila.push('falta numero_lote')

        const marcaNom = _valorFila(fila, 'marca').toUpperCase()
        // La marca del producto sirve de respaldo si el archivo no la trae.
        const marca = marcaPorNom.get(marcaNom) || (item?.marca_id ? { id: item.marca_id } : null)
        if (!marca) errFila.push(`marca "${marcaNom || '(vacío)'}" no existe y el producto no tiene marca por defecto`)

        const almacenNom = _valorFila(fila, 'almacen', 'almacén').toUpperCase()
        const zonaNom    = _valorFila(fila, 'zona', 'ubicacion', 'ubicación').toUpperCase()
        let zona = zonaPorClave.get(`${almacenNom}|${zonaNom}`)
        if (!zona && !almacenNom && zonaNom) {
          const unica = zonaPorNombreSolo.get(zonaNom)
          if (unica === null) errFila.push(`la zona "${zonaNom}" existe en varios almacenes: indica también la columna almacen`)
          else zona = unica
        }
        if (!zona) errFila.push(`no se encontró la zona "${almacenNom ? almacenNom + ' / ' : ''}${zonaNom || '(vacío)'}"`)

        const detalleCompra = item ? detallePorItem.get(item.id) : null
        if (compra && item && !detalleCompra) {
          errFila.push(`el producto ${item.nombre} no figura en el detalle de la compra ${compra.numero || compra.referencia}`)
        }

        // ¿El lote ya existe? Si sí, se sumará; si no, se creará.
        const claveLote = item ? `${item.id}|${numeroLote.toUpperCase()}` : null
        const loteExistente = claveLote ? lotePorItemNumero.get(claveLote) : null
        const yaEnArchivo = claveLote ? lotesNuevosEnEsteArchivo.has(claveLote) : false
        if (claveLote && !loteExistente) lotesNuevosEnEsteArchivo.add(claveLote)

        if (errFila.length > 0) {
          filasConError++
          anotar('error', `Fila ${nroFila} (guía ${grupo.numeroGuia}): ${errFila.join(' · ')}`)
          continue
        }

        lineas.push({
          nroFila, item, cantidad, unidades, numeroLote,
          marcaId: marca.id,
          codigoPartida: _valorFila(fila, 'codigo_partida', 'partida') || null,
          zona, detalleCompra,
          loteExistenteId: loteExistente?.id || null,
          seSumaALoteExistente: !!loteExistente || yaEnArchivo
        })
      }

      if (errores.length > 0 || lineas.length === 0) {
        anotar('error', `Guía ${grupo.numeroGuia}: ${errores.length ? errores.join(' · ') : 'sin líneas válidas'} — no se importará`)
        continue
      }

      guiasValidas.push({ numeroGuia: grupo.numeroGuia, fechaGuia, compra, observaciones, lineas })
      guiasYaUsadas.add(clave)  // evita duplicados dentro del mismo archivo
    }

    // ── Resumen ───────────────────────────────────────────────────────────
    const totalLineas = guiasValidas.reduce((s, g) => s + g.lineas.length, 0)
    const totalKg     = guiasValidas.reduce((s, g) => s + g.lineas.reduce((s2, l) => s2 + l.cantidad, 0), 0)
    const lotesNuevos = guiasValidas.reduce((s, g) => s + g.lineas.filter(l => !l.seSumaALoteExistente).length, 0)
    const lotesSumados = totalLineas - lotesNuevos

    if (guiasValidas.length === 0) {
      _html('importar-guias-resumen',
        `<p style="color:var(--color-danger);">Ninguna guía se puede importar. Revisa el detalle de abajo.</p>`)
      _pintarLogImport('importar-guias-log', log)
      return
    }

    if (simular) {
      _html('importar-guias-resumen', `
        <div style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info);">
          <strong>Simulación — no se grabó nada</strong>
          <div style="margin-top:8px; font-size:0.88rem; line-height:1.7;">
            Guías a crear: <strong>${guiasValidas.length}</strong><br>
            Líneas: <strong>${totalLineas}</strong> · Cantidad total: <strong>${formatQty(totalKg)}</strong><br>
            Lotes nuevos: <strong>${lotesNuevos}</strong> · Se sumarán a lotes existentes: <strong>${lotesSumados}</strong><br>
            ${filasConError > 0 ? `<span style="color:var(--color-danger);">Filas con error que se omitirán: <strong>${filasConError}</strong></span>` : '<span style="color:var(--color-success);">Sin errores ✅</span>'}
          </div>
          <div style="margin-top:10px; font-size:0.85rem; color:var(--text-secondary);">
            Si el resultado es correcto, desmarca "Simular primero" y vuelve a procesar.
          </div>
        </div>`)
      _pintarLogImport('importar-guias-log', log)
      return
    }

    // ── Escritura real ────────────────────────────────────────────────────
    let creadas = 0, fallidas = 0
    const vendorsZona = await getUbicacionVendors()

    for (const g of guiasValidas) {
      try {
        const guia = await addGuiaIngresoCompra({
          compra_id: g.compra.id, numero_guia: g.numeroGuia, fecha_guia: g.fechaGuia,
          observaciones: g.observaciones, created_by: user.db_id
        })
        if (!guia?.id) throw new Error('no se pudo crear la cabecera de la guía')

        const monedaCompra = g.compra.currency || 'PEN'
        const tcCompra = parseFloat(g.compra.tipo_cambio) || 1

        for (const l of g.lineas) {
          const costoOriginal = parseFloat(l.detalleCompra?.precio_unitario) || 0
          const costoPen = parseFloat((costoOriginal * tcCompra).toFixed(4))
          const pesoPorUnidad = l.unidades > 0 ? parseFloat((l.cantidad / l.unidades).toFixed(4)) : null

          // Se relee el lote por si otra línea de este mismo archivo ya lo creó.
          const claveLote = `${l.item.id}|${l.numeroLote.toUpperCase()}`
          let lote = lotePorItemNumero.get(claveLote) || null
          let cantidadResultante = l.cantidad
          let costoFinal = costoPen

          if (lote) {
            const fresco = await getLoteById(lote.id)
            const cantPrevia = parseFloat(fresco?.cantidad) || 0
            const unidPrevias = parseFloat(fresco?.cantidad_unidades) || 0
            cantidadResultante = parseFloat((cantPrevia + l.cantidad).toFixed(4))
            const unidadesResultantes = parseFloat((unidPrevias + (l.unidades || 0)).toFixed(4))
            const costoPrevio = parseFloat(fresco?.costo_unitario) || 0
            costoFinal = cantidadResultante > 0
              ? parseFloat((((cantPrevia * costoPrevio) + (l.cantidad * costoPen)) / cantidadResultante).toFixed(4))
              : costoPen

            await updateLote(lote.id, {
              cantidad: cantidadResultante,
              cantidad_unidades: unidadesResultantes,
              costo_unitario: costoFinal,
              peso_por_unidad: unidadesResultantes > 0
                ? parseFloat((cantidadResultante / unidadesResultantes).toFixed(4))
                : fresco?.peso_por_unidad
            })
          } else {
            lote = await addLote({
              item_id: l.item.id, proveedor_id: g.compra.contact_id || null,
              numero_lote: l.numeroLote, numero_factura: g.compra.numero || null,
              codigo_partida: l.codigoPartida, marca_id: l.marcaId,
              costo_unitario: costoPen, moneda: monedaCompra, tipo_cambio: tcCompra,
              costo_unit_original: costoOriginal, costo_estado: 'definitivo',
              cantidad: l.cantidad, unidad_medida: l.detalleCompra?.unidad_medida || 'KG',
              cantidad_unidades: l.unidades, peso_por_unidad: pesoPorUnidad,
              es_peso_variable: false, ubicacion_id: l.zona.id,
              fecha_ingreso: g.fechaGuia, compra_id: g.compra.id, guia_id: guia.id,
              created_by: user.db_id
            })
            if (lote?.id) lotePorItemNumero.set(claveLote, lote)
          }

          if (!lote?.id) throw new Error(`no se pudo resolver el lote ${l.numeroLote}`)

          // Stock por zona: suma si ya había en esa zona, si no crea la fila.
          const filas = await getStockUbicacionesByLote(lote.id)
          const fila = (filas || []).find(f => f.ubicacion_id === l.zona.id)
          if (fila) {
            await updateStockUbicacion(fila.id, {
              cantidad: parseFloat(((parseFloat(fila.cantidad) || 0) + l.cantidad).toFixed(4)),
              cantidad_unidades: parseFloat(((parseFloat(fila.cantidad_unidades) || 0) + (l.unidades || 0)).toFixed(4))
            })
          } else {
            await addStockUbicacion({
              lote_id: lote.id, ubicacion_id: l.zona.id,
              cantidad: l.cantidad, cantidad_unidades: l.unidades || 0
            })
          }

          const valorLinea = parseFloat((l.cantidad * costoPen).toFixed(2))
          await addKardexMovimiento({
            item_id: l.item.id, lote_id: lote.id,
            ubicacion_origen_id: vendorsZona?.id || null,
            ubicacion_destino_id: l.zona.id,
            fecha: g.fechaGuia, tipo_movimiento: 'entrada',
            concepto: 'Compra - ingreso a almacén (importado)',
            documento_referencia: g.numeroGuia,
            cantidad_entrada: l.cantidad, cantidad_salida: 0,
            cantidad_unidades_entrada: l.unidades || 0, cantidad_unidades_salida: 0,
            costo_unitario: costoPen, valor_entrada: valorLinea, valor_salida: 0,
            moneda: monedaCompra, tipo_cambio: tcCompra, costo_unit_original: costoOriginal,
            saldo_cantidad: cantidadResultante,
            saldo_valor: parseFloat((cantidadResultante * costoFinal).toFixed(2)),
            saldo_unidades: l.unidades || 0,
            compra_id: g.compra.id, created_by: user.db_id
          })

          await addDetalleGuiaIngresoCompra({
            guia_id: guia.id, detalle_compra_id: l.detalleCompra?.id || null,
            item_id: l.item.id, cantidad: l.cantidad, cantidad_unidades: l.unidades || 0,
            numero_lote: l.numeroLote,
            marca_id: l.marcaId, codigo_partida: l.codigoPartida,
            ubicacion_id: l.zona.id, lote_id: lote.id
          })
        }

        creadas++
        anotar('ok', `Guía ${g.numeroGuia}: ${g.lineas.length} línea(s) importada(s)`)
      } catch (e) {
        fallidas++
        anotar('error', `Guía ${g.numeroGuia}: ${e.message}`)
      }
    }

    _html('importar-guias-resumen', `
      <div style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid ${fallidas ? 'var(--color-warning)' : 'var(--color-success)'};">
        <strong>Importación terminada</strong>
        <div style="margin-top:8px; font-size:0.88rem; line-height:1.7;">
          Guías creadas: <strong style="color:var(--color-success);">${creadas}</strong><br>
          Guías con error: <strong style="color:${fallidas ? 'var(--color-danger)' : 'var(--text-secondary)'};">${fallidas}</strong><br>
          Filas omitidas por validación: <strong>${filasConError}</strong>
        </div>
      </div>`)
    _pintarLogImport('importar-guias-log', log)

    _invalidarCacheCompras()
    await _cargarComprasConGuia(true)
    await renderGuias(true)
    await renderCompras(true)
    showToast(`${creadas} guía(s) importada(s)`, creadas ? 'success' : 'warning')
  } catch (error) {
    console.error('procesarImportacionGuias:', error)
    _html('importar-guias-resumen', `<p style="color:var(--color-danger);">Error inesperado: ${_escCompras(error.message)}</p>`)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Procesar' }
  }
}

/** Log compartido por los importadores: errores primero, con scroll. */
function _pintarLogImport(idContenedor, log) {
  const errores = log.filter(l => l.tipo === 'error')
  const oks     = log.filter(l => l.tipo === 'ok')
  _html(idContenedor, [
    ...errores.map(l => `<div style="padding:4px 0; color:var(--color-danger);">✕ ${_escCompras(l.texto)}</div>`),
    ...oks.map(l => `<div style="padding:4px 0; color:var(--color-success);">✓ ${_escCompras(l.texto)}</div>`)
  ].join('') || '<div style="color:var(--text-secondary);">Sin observaciones.</div>')
}

function _html(id, contenido) { const el = document.getElementById(id); if (el) el.innerHTML = contenido }
