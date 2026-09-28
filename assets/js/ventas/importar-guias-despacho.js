// ============================================================================
// ventas/importar-guias-despacho.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { getLotes, getLoteById, updateLote, getItems, getVentas, getDetalleVentas, getAlmacenes, getUbicaciones, getStockUbicaciones, getStockUbicacionesByLote, updateStockUbicacion, getUbicacionCustomers, addKardexMovimiento, getGuiasDespachoVenta, addGuiaDespachoVenta, getDetalleGuiasDespachoVenta, addDetalleGuiaDespachoVenta } from '../supabase-data.js'
import { showToast, formatQty } from '../helpers.js'
import { estaAnulado } from '../anulacion.js'
import { _invalidarCacheVentas } from './anulacion.js'
import { _recalcularEstadoDespachoVenta, renderGuiasDespachoVenta } from './guias-despacho-lista.js'
import { _leerArchivoImportVentas, _parseFechaImportVentas } from './importar-ventas.js'
import { _esc } from './init.js'
import { _guiaEstaVigente } from './ventas-editar.js'
import { renderVentas } from './ventas-lista.js'

// ============================================================================
// IMPORTACIÓN MASIVA DE GUÍAS DE DESPACHO
// ============================================================================
// Espejo del importador de Guías de Ingreso, pero en sentido contrario: aquí
// se DESCUENTA stock. Por eso la validación es más estricta — se comprueba
// que el lote exista, que esté en la zona indicada y que tenga cantidad
// suficiente, acumulando las reservas de todas las filas del archivo que
// toquen el mismo lote+zona (dos guías del mismo lote no pueden llevarse cada
// una el stock completo).
//
// El modo simulación es aún más importante que en compras: si el archivo
// falla a mitad, el stock queda descuadrado sin registro que lo explique.

window.abrirModalImportarGuiasDespacho = function () {
  const input = document.getElementById('fileImportarGuiasDespacho')
  if (input) input.value = ''
  const chk = document.getElementById('chkSimularGuiasDespacho')
  if (chk) chk.checked = true
  _htmlV('importar-guias-despacho-resumen', '')
  _htmlV('importar-guias-despacho-log', '')
  window.openModal('modal-importar-guias-despacho')
}

window.descargarPlantillaGuiasDespacho = async function () {
  const { descargarCSV } = await import('./reportes.js')
  descargarCSV('plantilla_guias_despacho.csv', [
    ['numero_guia', 'fecha_guia', 'venta_numero', 'sku', 'cantidad', 'numero_unidades',
     'numero_lote', 'almacen', 'zona', 'observaciones'],
    ['T001-00000045', '2026-02-10', 'F001-00000123', 'SKU-001', '3816', '9',
     'HR-Q0830721', 'SJL2', 'Zona A', 'Salida parcial'],
    ['T001-00000045', '2026-02-10', 'F001-00000123', 'SKU-001', '424', '1',
     'HR-Q0830722', 'SJL2', 'Zona A', '']
  ])
}

function _htmlV(id, contenido) { const el = document.getElementById(id); if (el) el.innerHTML = contenido }

function _valorFilaV(fila, ...nombres) {
  for (const n of nombres) {
    if (fila[n] !== undefined && fila[n] !== null && String(fila[n]).trim() !== '') return String(fila[n]).trim()
  }
  return ''
}

window.procesarImportacionGuiasDespacho = async function () {
  const btn     = document.getElementById('btnProcesarImportarGuiasDespacho')
  const input   = document.getElementById('fileImportarGuiasDespacho')
  const simular = !!document.getElementById('chkSimularGuiasDespacho')?.checked
  if (btn?.disabled) return

  const file = input?.files?.[0]
  if (!file) { showToast('Selecciona un archivo primero', 'warning'); return }

  const log = []
  const anotar = (tipo, texto) => log.push({ tipo, texto })

  try {
    if (btn) { btn.disabled = true; btn.textContent = simular ? 'Simulando...' : 'Importando...' }
    _htmlV('importar-guias-despacho-resumen', '<p style="color:var(--text-secondary);">Leyendo archivo...</p>')
    _htmlV('importar-guias-despacho-log', '')

    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    let filas
    try {
      filas = await _leerArchivoImportVentas(file)
    } catch (e) {
      _htmlV('importar-guias-despacho-resumen', '<p style="color:var(--color-danger);">No se pudo leer el archivo. Verifica que sea un .xlsx o .csv válido.</p>')
      return
    }
    if (!filas?.length) {
      _htmlV('importar-guias-despacho-resumen', '<p style="color:var(--color-danger);">El archivo no tiene filas de datos.</p>')
      return
    }

    const [ventas, items, lotesTodos, stockTodo, zonas, almacenes, guiasExistentes] = await Promise.all([
      getVentas(), getItems(), getLotes(), getStockUbicaciones(),
      getUbicaciones(), getAlmacenes(), getGuiasDespachoVenta(true)
    ])

    // La venta se puede referenciar por `numero` o por "serie-correlativo".
    const ventaPorClave = new Map()
    for (const v of (ventas || [])) {
      const claves = [v.numero, `${v.serie || ''}-${String(v.correlativo || '').padStart(8, '0')}`]
      for (const k of claves) if (k) ventaPorClave.set(String(k).trim().toUpperCase(), v)
    }
    const itemPorSku = new Map((items || []).filter(i => i.sku).map(i => [String(i.sku).trim().toUpperCase(), i]))
    const almacenPorId = new Map((almacenes || []).map(a => [a.id, a]))
    const guiasYaUsadas = new Set((guiasExistentes || []).map(g => String(g.numero_guia || '').trim().toUpperCase()))

    const zonaPorClave = new Map()
    const zonaPorNombreSolo = new Map()
    for (const z of (zonas || [])) {
      const alm = almacenPorId.get(z.almacen_id)
      if (alm?.es_virtual) continue
      zonaPorClave.set(`${String(alm?.nombre || '').trim().toUpperCase()}|${String(z.nombre || '').trim().toUpperCase()}`, z)
      const solo = String(z.nombre || '').trim().toUpperCase()
      zonaPorNombreSolo.set(solo, zonaPorNombreSolo.has(solo) ? null : z)
    }

    const lotePorItemNumero = new Map()
    for (const l of (lotesTodos || [])) {
      if (!l.item_id || !l.numero_lote) continue
      lotePorItemNumero.set(`${l.item_id}|${String(l.numero_lote).trim().toUpperCase()}`, l)
    }

    // Copia mutable del stock: cada línea validada "reserva" su cantidad, para
    // que dos filas del mismo lote+zona no pasen ambas la validación.
    const stockLocal = new Map()
    for (const su of (stockTodo || [])) stockLocal.set(su.id, { ...su })

    // Ya despachado por cada línea de venta (guías previas no anuladas).
    const guiasAnuladas = new Set((guiasExistentes || []).filter(g => !_guiaEstaVigente(g)).map(g => g.id))
    const despachosPrevios = await getDetalleGuiasDespachoVenta()
    const yaDespachadoPorDetalle = new Map()
    for (const d of (despachosPrevios || [])) {
      if (guiasAnuladas.has(d.guia_id)) continue
      yaDespachadoPorDetalle.set(d.detalle_venta_id, (yaDespachadoPorDetalle.get(d.detalle_venta_id) || 0) + (parseFloat(d.cantidad) || 0))
    }

    // ── Agrupar por N° de guía ────────────────────────────────────────────
    const grupos = new Map()
    filas.forEach((fila, i) => {
      const numeroGuia = _valorFilaV(fila, 'numero_guia', 'guia', 'nro_guia')
      if (!numeroGuia) { anotar('error', `Fila ${i + 2}: sin numero_guia, se omite`); return }
      const clave = numeroGuia.toUpperCase()
      if (!grupos.has(clave)) grupos.set(clave, { numeroGuia, filas: [] })
      grupos.get(clave).filas.push({ fila, nroFila: i + 2 })
    })

    // ── Validación completa ───────────────────────────────────────────────
    const guiasValidas = []
    let filasConError = 0

    for (const [clave, grupo] of grupos) {
      const errores = []
      if (guiasYaUsadas.has(clave)) errores.push(`la guía ${grupo.numeroGuia} ya existe`)

      const primera = grupo.filas[0].fila
      const ventaClave = _valorFilaV(primera, 'venta_numero', 'venta', 'comprobante', 'numero_documento').toUpperCase()
      const venta = ventaPorClave.get(ventaClave)
      if (!venta) errores.push(`no se encontró la venta "${ventaClave || '(vacío)'}"`)
      else if (estaAnulado(venta)) errores.push(`la venta ${ventaClave} está anulada`)

      const fechaGuia = _parseFechaImportVentas(_valorFilaV(primera, 'fecha_guia', 'fecha'))
      if (!fechaGuia) errores.push('fecha_guia inválida o vacía')

      const detallesVenta = venta ? await getDetalleVentas(venta.id) : []
      const lineas = []

      for (const { fila, nroFila } of grupo.filas) {
        const errFila = []

        const sku  = _valorFilaV(fila, 'sku', 'codigo', 'producto').toUpperCase()
        const item = itemPorSku.get(sku)
        if (!item) errFila.push(`SKU "${sku || '(vacío)'}" no existe`)

        const cantidad = parseFloat(_valorFilaV(fila, 'cantidad', 'cantidad_kg', 'kg') || 0)
        if (!(cantidad > 0)) errFila.push('cantidad debe ser mayor a 0')
        const unidades = parseFloat(_valorFilaV(fila, 'numero_unidades', 'unidades') || 0) || 0

        const numeroLote = _valorFilaV(fila, 'numero_lote', 'lote')
        if (!numeroLote) errFila.push('falta numero_lote')

        const almacenNom = _valorFilaV(fila, 'almacen', 'almacén').toUpperCase()
        const zonaNom    = _valorFilaV(fila, 'zona', 'ubicacion', 'ubicación').toUpperCase()
        let zona = zonaPorClave.get(`${almacenNom}|${zonaNom}`)
        if (!zona && !almacenNom && zonaNom) {
          const unica = zonaPorNombreSolo.get(zonaNom)
          if (unica === null) errFila.push(`la zona "${zonaNom}" existe en varios almacenes: indica también almacen`)
          else zona = unica
        }
        if (!zona) errFila.push(`no se encontró la zona "${almacenNom ? almacenNom + ' / ' : ''}${zonaNom || '(vacío)'}"`)

        // La línea de venta a la que corresponde este despacho.
        const detalleVenta = item ? (detallesVenta || []).find(d => d.item_id === item.id) : null
        if (venta && item && !detalleVenta) {
          errFila.push(`el producto ${item.nombre} no figura en el detalle de la venta ${ventaClave}`)
        }

        // Lote + stock disponible en esa zona, descontando lo ya reservado
        // por filas anteriores de este mismo archivo.
        let filaStock = null
        if (item && numeroLote && zona) {
          const lote = lotePorItemNumero.get(`${item.id}|${numeroLote.toUpperCase()}`)
          if (!lote) {
            errFila.push(`el lote "${numeroLote}" no existe para ${item.nombre}`)
          } else {
            filaStock = Array.from(stockLocal.values()).find(su => su.lote_id === lote.id && su.ubicacion_id === zona.id)
            if (!filaStock) {
              errFila.push(`el lote ${numeroLote} no tiene stock en ${zonaNom}`)
            } else if ((parseFloat(filaStock.cantidad) || 0) + 0.0001 < cantidad) {
              errFila.push(`stock insuficiente en lote ${numeroLote} / ${zonaNom}: disponible ${formatQty(filaStock.cantidad)}, pedido ${formatQty(cantidad)}`)
            }
          }
        }

        if (errFila.length > 0) {
          filasConError++
          anotar('error', `Fila ${nroFila} (guía ${grupo.numeroGuia}): ${errFila.join(' · ')}`)
          continue
        }

        // Reserva local (solo en la copia; el stock real no se toca aún)
        filaStock.cantidad = parseFloat(((parseFloat(filaStock.cantidad) || 0) - cantidad).toFixed(4))
        filaStock.cantidad_unidades = parseFloat(Math.max(0, (parseFloat(filaStock.cantidad_unidades) || 0) - unidades).toFixed(4))

        const lote = lotePorItemNumero.get(`${item.id}|${numeroLote.toUpperCase()}`)
        lineas.push({ nroFila, item, cantidad, unidades, lote, zona, detalleVenta, filaStockId: filaStock.id })
      }

      if (errores.length > 0 || lineas.length === 0) {
        anotar('error', `Guía ${grupo.numeroGuia}: ${errores.length ? errores.join(' · ') : 'sin líneas válidas'} — no se importará`)
        continue
      }

      // Aviso (no bloqueo) si se despacha más de lo vendido: puede ser un
      // error de digitación, pero también un ajuste legítimo por peso.
      const porDetalle = new Map()
      for (const l of lineas) {
        if (!l.detalleVenta) continue
        porDetalle.set(l.detalleVenta.id, (porDetalle.get(l.detalleVenta.id) || 0) + l.cantidad)
      }
      for (const [detId, cant] of porDetalle) {
        const det = (detallesVenta || []).find(d => d.id === detId)
        const pendiente = (parseFloat(det?.cantidad) || 0) - (yaDespachadoPorDetalle.get(detId) || 0)
        if (cant > pendiente + 0.0001) {
          anotar('error', `Guía ${grupo.numeroGuia}: se despachan ${formatQty(cant)} de "${det?.descripcion || ''}" pero solo quedan ${formatQty(pendiente)} pendientes (se importará igual)`)
        }
      }

      guiasValidas.push({ numeroGuia: grupo.numeroGuia, fechaGuia, venta, lineas,
        observaciones: _valorFilaV(primera, 'observaciones', 'observacion') || null })
      guiasYaUsadas.add(clave)
    }

    const totalLineas = guiasValidas.reduce((s, g) => s + g.lineas.length, 0)
    const totalKg     = guiasValidas.reduce((s, g) => s + g.lineas.reduce((s2, l) => s2 + l.cantidad, 0), 0)

    if (guiasValidas.length === 0) {
      _htmlV('importar-guias-despacho-resumen', '<p style="color:var(--color-danger);">Ninguna guía se puede importar. Revisa el detalle de abajo.</p>')
      _pintarLogImportV('importar-guias-despacho-log', log)
      return
    }

    if (simular) {
      _htmlV('importar-guias-despacho-resumen', `
        <div style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info);">
          <strong>Simulación — no se grabó nada</strong>
          <div style="margin-top:8px; font-size:0.88rem; line-height:1.7;">
            Guías a crear: <strong>${guiasValidas.length}</strong><br>
            Líneas: <strong>${totalLineas}</strong> · Stock a descontar: <strong>${formatQty(totalKg)}</strong><br>
            ${filasConError > 0 ? `<span style="color:var(--color-danger);">Filas con error que se omitirán: <strong>${filasConError}</strong></span>` : '<span style="color:var(--color-success);">Sin errores ✅</span>'}
          </div>
          <div style="margin-top:10px; font-size:0.85rem; color:var(--text-secondary);">
            Si el resultado es correcto, desmarca "Simular primero" y vuelve a procesar.
          </div>
        </div>`)
      _pintarLogImportV('importar-guias-despacho-log', log)
      return
    }

    // ── Escritura real ────────────────────────────────────────────────────
    let creadas = 0, fallidas = 0
    const zonaClientes = await getUbicacionCustomers()
    const ventasTocadas = new Set()

    for (const g of guiasValidas) {
      try {
        const guia = await addGuiaDespachoVenta({
          venta_id: g.venta.id, numero_guia: g.numeroGuia, fecha_guia: g.fechaGuia,
          observaciones: g.observaciones, created_by: user.db_id
        })
        if (!guia?.id) throw new Error('no se pudo crear la cabecera de la guía')

        for (const l of g.lineas) {
          const loteFresco = await getLoteById(l.lote.id)
          const costoUnit = parseFloat(loteFresco?.costo_unitario) || 0

          // Lote
          await updateLote(l.lote.id, {
            cantidad: parseFloat(Math.max(0, (parseFloat(loteFresco?.cantidad) || 0) - l.cantidad).toFixed(4)),
            cantidad_unidades: parseFloat(Math.max(0, (parseFloat(loteFresco?.cantidad_unidades) || 0) - l.unidades).toFixed(4))
          })

          // Stock de la zona
          const filasLote = await getStockUbicacionesByLote(l.lote.id)
          const filaZona = (filasLote || []).find(f => f.ubicacion_id === l.zona.id)
          if (filaZona) {
            await updateStockUbicacion(filaZona.id, {
              cantidad: parseFloat(Math.max(0, (parseFloat(filaZona.cantidad) || 0) - l.cantidad).toFixed(4)),
              cantidad_unidades: parseFloat(Math.max(0, (parseFloat(filaZona.cantidad_unidades) || 0) - l.unidades).toFixed(4))
            })
          }

          const valorSalida = parseFloat((l.cantidad * costoUnit).toFixed(2))
          await addKardexMovimiento({
            item_id: l.item.id, lote_id: l.lote.id,
            ubicacion_origen_id: l.zona.id,
            ubicacion_destino_id: zonaClientes?.id || null,
            fecha: g.fechaGuia, tipo_movimiento: 'salida',
            concepto: 'Venta - despacho a cliente (importado)',
            documento_referencia: g.numeroGuia,
            cantidad_entrada: 0, cantidad_salida: l.cantidad,
            cantidad_unidades_entrada: 0, cantidad_unidades_salida: l.unidades,
            costo_unitario: costoUnit, valor_entrada: 0, valor_salida: valorSalida,
            venta_id: g.venta.id, created_by: user.db_id
          })

          await addDetalleGuiaDespachoVenta({
            guia_id: guia.id, detalle_venta_id: l.detalleVenta?.id || null,
            item_id: l.item.id, cantidad: l.cantidad, cantidad_unidades: l.unidades || 0,
            lote_id: l.lote.id, ubicacion_id: l.zona.id, numero_lote: l.lote.numero_lote
          })
        }

        ventasTocadas.add(g.venta.id)
        creadas++
        anotar('ok', `Guía ${g.numeroGuia}: ${g.lineas.length} línea(s) despachada(s)`)
      } catch (e) {
        fallidas++
        anotar('error', `Guía ${g.numeroGuia}: ${e.message}`)
      }
    }

    // El estado de despacho se recalcula una vez por venta al final, no por
    // línea: si una venta tuvo 3 guías en el archivo, calcularlo 3 veces sería
    // trabajo repetido y el resultado intermedio sería incorrecto.
    for (const ventaId of ventasTocadas) {
      try { await _recalcularEstadoDespachoVenta(ventaId) } catch (e) { console.warn('estado_despacho:', e.message) }
    }

    _htmlV('importar-guias-despacho-resumen', `
      <div style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid ${fallidas ? 'var(--color-warning)' : 'var(--color-success)'};">
        <strong>Importación terminada</strong>
        <div style="margin-top:8px; font-size:0.88rem; line-height:1.7;">
          Guías creadas: <strong style="color:var(--color-success);">${creadas}</strong><br>
          Guías con error: <strong style="color:${fallidas ? 'var(--color-danger)' : 'var(--text-secondary)'};">${fallidas}</strong><br>
          Filas omitidas por validación: <strong>${filasConError}</strong><br>
          Ventas con estado de despacho recalculado: <strong>${ventasTocadas.size}</strong>
        </div>
      </div>`)
    _pintarLogImportV('importar-guias-despacho-log', log)

    _invalidarCacheVentas()
    await renderGuiasDespachoVenta(true)
    await renderVentas(true)
    showToast(`${creadas} guía(s) de despacho importada(s)`, creadas ? 'success' : 'warning')
  } catch (error) {
    console.error('procesarImportacionGuiasDespacho:', error)
    _htmlV('importar-guias-despacho-resumen', `<p style="color:var(--color-danger);">Error inesperado: ${_esc(error.message)}</p>`)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Procesar' }
  }
}

function _pintarLogImportV(idContenedor, log) {
  const errores = log.filter(l => l.tipo === 'error')
  const oks     = log.filter(l => l.tipo === 'ok')
  _htmlV(idContenedor, [
    ...errores.map(l => `<div style="padding:4px 0; color:var(--color-danger);">✕ ${_esc(l.texto)}</div>`),
    ...oks.map(l => `<div style="padding:4px 0; color:var(--color-success);">✓ ${_esc(l.texto)}</div>`)
  ].join('') || '<div style="color:var(--text-secondary);">Sin observaciones.</div>')
}
