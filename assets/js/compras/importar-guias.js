// ============================================================================
// compras/importar-guias.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { costoNetoLineaCompra } from './compra-nueva.js'
import { getCurrentUser } from '../auth-supabase.js'
import { getCompras, getCompraDetalles, getLoteById, getLotes, addLote, updateLote, getItems, getMarcas, getGuiasIngresoCompra, addGuiaIngresoCompra, addDetalleGuiaIngresoCompra, getTodosDetalleGuiasIngresoCompra, getAlmacenes, getUbicaciones, addStockUbicacion, getUbicacionVendors, addKardexMovimiento, updateStockUbicacion, getStockUbicacionesByLote } from '../supabase-data.js'
import { empresaTrabajoCtx } from '../supabase-client.js'
import { showToast, formatQty } from '../helpers.js'
import { mostrarCarga, actualizarCarga, tituloCarga, ocultarCarga } from '../animaciones/index.js'
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
  const { descargarCSV } = await import('../reportes.js')
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
    const [_compras, items, marcas, _zonas, _almacenes, _lotes, _guiasExistentes] = await Promise.all([
      getCompras(), getItems(), getMarcas(), getUbicaciones(), getAlmacenes(), getLotes(), getGuiasIngresoCompra()
    ])

    // MULTIEMPRESA: los get* vienen recortados a las empresas ACTIVAS del
    // switch, que con dos marcadas incluye a Jhiro. Una guía de ingreso crea
    // stock, así que todo lo que resuelve debe ser de la EMPRESA DE TRABAJO:
    // de lo contrario el archivo podría enganchar la "Zona A" de Jhiro o
    // sumar cantidad a un lote suyo. El trigger del kardex lo rechazaría,
    // pero el error llegaría a mitad de la importación y sin explicar por qué.
    // `items` y `marcas` no se filtran: son catálogo compartido.
    const _emp = empresaTrabajoCtx()
    const _deEmpresa = (arr) => _emp == null ? (arr || []) : (arr || []).filter(x => Number(x.empresa_id) === Number(_emp))
    const compras         = _deEmpresa(_compras)
    const zonas           = _deEmpresa(_zonas)
    const almacenes       = _deEmpresa(_almacenes)
    const lotes           = _deEmpresa(_lotes)
    const guiasExistentes = _deEmpresa(_guiasExistentes)

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
    // El N° de Guía de Remisión lo pone el PROVEEDOR, no nosotros: dos
    // proveedores distintos pueden traer la misma numeración. Caso real: las
    // guías T001-xxx que Benji recibe de Jhiro conviven con las T001-xxx que
    // Jhiro emite. Por eso la unicidad es por (proveedor, N° de guía) y no
    // global: si fuera global, la segunda guía legítima se rechazaría.
    const compraPorId  = new Map((compras || []).map(c => [c.id, c]))
    const _provDeCompra = (c) => (c && c.contact_id != null) ? String(c.contact_id) : '?'
    const guiasYaUsadas  = new Set()   // "proveedor|N°"
    const numerosYaUsados = new Map()  // N° -> Set de proveedores que ya lo usaron
    for (const g of (guiasExistentes || [])) {
      const num = String(g.numero_guia || '').trim().toUpperCase()
      if (!num) continue
      const prov = _provDeCompra(compraPorId.get(g.compra_id))
      guiasYaUsadas.add(`${prov}|${num}`)
      if (!numerosYaUsados.has(num)) numerosYaUsados.set(num, new Set())
      numerosYaUsados.get(num).add(prov)
    }

    // Cuánto se recibió ya de cada PRODUCTO de cada compra, sumando TODAS sus
    // guías: una compra se puede recibir en varias guías parciales, así que el
    // tope no es "lo de esta guía" sino lo acumulado.
    //
    // Se mide por (compra, producto) y NO por línea de compra a propósito: una
    // misma factura puede traer el mismo SKU en dos líneas con precios
    // distintos (caso real: F002-00006556 trae 0090-009006 a 12.2881 y a
    // 11.4407). Contra una sola de esas líneas, una recepción legítima de
    // 3,056.5 parecería un exceso sobre 710.
    const _todosDetGuia = await getTodosDetalleGuiasIngresoCompra()
    const _compraDeGuia = new Map((guiasExistentes || []).map(g => [g.id, g.compra_id]))
    const recibidoPorItem = new Map()     // "compraId|itemId" -> cantidad
    for (const d of (_todosDetGuia || [])) {
      const compraId = _compraDeGuia.get(d.guia_id)
      if (compraId == null || d.item_id == null) continue
      const k = `${compraId}|${d.item_id}`
      recibidoPorItem.set(k, (recibidoPorItem.get(k) || 0) + parseFloat(d.cantidad || 0))
    }
    // Lo que va sumando este mismo archivo (solo guías ya aceptadas).
    const recibidoEnArchivo = new Map()

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

    await mostrarCarga({
      titulo: 'Validando el archivo',
      subtitulo: `${grupos.size} guía${grupos.size === 1 ? '' : 's'} de ingreso`,
      total: grupos.size
    })

    for (const [clave, grupo] of grupos) {
      actualizarCarga(undefined, grupo.numeroGuia)
      const errores = []

      const primera = grupo.filas[0].fila
      const compraClave = _valorFila(primera, 'compra_numero', 'compra', 'numero_comprobante', 'referencia').toUpperCase()
      const compra = compraPorClave.get(compraClave)
      if (!compra) errores.push(`no se encontró la compra "${compraClave || '(vacío)'}"`)

      const fechaGuia = _parseFechaImportGenerico(_valorFila(primera, 'fecha_guia', 'fecha'))
      if (!fechaGuia) errores.push('fecha_guia inválida o vacía')

      const observaciones = _valorFila(primera, 'observaciones', 'observacion') || null

      // ── La cabecera tiene que ser la misma en todas las filas del grupo ──
      // La cabecera se lee solo de la PRIMERA fila. Repetir el N° de guía
      // significa "estas filas son el detalle de la misma guía", así que su
      // compra y su fecha deben coincidir. Si no coinciden, no es detalle:
      // es un N° repetido por error o dos guías que comparten número. Antes
      // se ignoraba en silencio y la guía quedaba con la cabecera de la 1ª.
      const comprasEnGrupo = new Set()
      const fechasEnGrupo  = new Set()
      for (const { fila } of grupo.filas) {
        comprasEnGrupo.add(_valorFila(fila, 'compra_numero', 'compra', 'numero_comprobante', 'referencia').toUpperCase())
        const f = _parseFechaImportGenerico(_valorFila(fila, 'fecha_guia', 'fecha'))
        if (f) fechasEnGrupo.add(f)
      }
      if (comprasEnGrupo.size > 1) {
        errores.push(`sus filas apuntan a ${comprasEnGrupo.size} compras distintas (${[...comprasEnGrupo].join(', ')}): si son dos guías distintas que comparten número, diferéncialas`)
      }
      if (fechasEnGrupo.size > 1) {
        errores.push(`sus filas traen ${fechasEnGrupo.size} fechas distintas (${[...fechasEnGrupo].join(', ')})`)
      }

      // ── Duplicado: por (proveedor, N° de guía), no por N° suelto ─────────
      const provGuia = _provDeCompra(compra)
      if (guiasYaUsadas.has(`${provGuia}|${clave}`)) {
        errores.push(`la guía ${grupo.numeroGuia} ya está registrada para este proveedor`)
      } else if (numerosYaUsados.get(clave)?.size) {
        anotar('aviso', `Guía ${grupo.numeroGuia}: ese N° ya existe pero de OTRO proveedor — se registra igual, la numeración es del proveedor.`)
      }

      // Detalle de la compra: cada línea del archivo debe corresponder a un
      // producto realmente comprado, para poder enlazar detalle_compra_id.
      const detallesCompra = compra ? await getCompraDetalles(compra.id) : []
      const detallePorItem = new Map()
      const compradoPorItem = new Map()
      for (const d of (detallesCompra || [])) {
        if (!d.item_id) continue
        if (!detallePorItem.has(d.item_id)) detallePorItem.set(d.item_id, d)   // para enlazar detalle_compra_id
        compradoPorItem.set(d.item_id, (compradoPorItem.get(d.item_id) || 0) + parseFloat(d.cantidad || 0))
      }

      const lineas = []
      // Reserva local: si dos filas usan el mismo lote nuevo, la segunda debe
      // saber que la primera ya lo va a crear (si no, se crearía dos veces).
      const lotesNuevosEnEsteArchivo = new Set()
      // Lo que esta guía va sumando por línea de compra. Se vuelca a
      // `recibidoEnArchivo` solo si la guía entera resulta válida: si se cae,
      // su consumo no debe penalizar a las guías siguientes.
      const recibidoEnGuia = new Map()
      // Par (sku, lote) ya visto en esta guía con la misma cantidad: es la
      // misma línea repetida, no detalle nuevo.
      const lineasVistas = new Set()

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

        // ── Tope: no se puede recibir más de lo comprado ─────────────────
        // El mismo lote SÍ puede entrar en varias guías (entregas parciales);
        // lo que no puede pasar es que el acumulado supere la línea de la
        // compra. Ese exceso es, casi siempre, la misma recepción registrada
        // dos veces. Atraparlo aquí evita inflar el stock en silencio.
        if (compra && item && cantidad > 0) {
          const claveTope = `${compra.id}|${item.id}`
          const compradoIt = compradoPorItem.get(item.id) || 0
          const yaIt = (recibidoPorItem.get(claveTope) || 0) +
                       (recibidoEnArchivo.get(claveTope) || 0) +
                       (recibidoEnGuia.get(claveTope) || 0)
          if (compradoIt > 0 && yaIt + cantidad > compradoIt + 0.001) {
            errFila.push(`se recibirían ${formatQty(yaIt + cantidad)} de "${item?.nombre || sku}" pero la compra ${compra?.numero || compraClave} solo lleva ${formatQty(compradoIt)} (ya recibido antes: ${formatQty(yaIt)})`)
          }
        }

        // ¿El lote ya existe? Si sí, se sumará; si no, se creará.
        const claveLote = item ? `${item.id}|${numeroLote.toUpperCase()}` : null
        const loteExistente = claveLote ? lotePorItemNumero.get(claveLote) : null
        const yaEnArchivo = claveLote ? lotesNuevosEnEsteArchivo.has(claveLote) : false
        if (claveLote && !loteExistente) lotesNuevosEnEsteArchivo.add(claveLote)

        // Línea calcada: mismo SKU, mismo lote y misma cantidad dentro de la
        // misma guía. Detalle legítimo sería el mismo lote con OTRA cantidad.
        const claveLinea = `${sku}|${numeroLote.toUpperCase()}|${cantidad}`
        if (!errFila.length && lineasVistas.has(claveLinea)) {
          filasConError++
          anotar('error', `Fila ${nroFila} (guía ${grupo.numeroGuia}): línea repetida — mismo SKU ${sku}, mismo lote ${numeroLote} y misma cantidad ${formatQty(cantidad)} ya vienen en esta guía.`)
          continue
        }
        lineasVistas.add(claveLinea)

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
        if (compra && item) {
          const k = `${compra.id}|${item.id}`
          recibidoEnGuia.set(k, (recibidoEnGuia.get(k) || 0) + cantidad)
        }
      }

      if (errores.length > 0 || lineas.length === 0) {
        anotar('error', `Guía ${grupo.numeroGuia}: ${errores.length ? errores.join(' · ') : 'sin líneas válidas'} — no se importará`)
        continue
      }

      guiasValidas.push({ numeroGuia: grupo.numeroGuia, fechaGuia, compra, observaciones, lineas })
      guiasYaUsadas.add(`${provGuia}|${clave}`)  // evita duplicados dentro del mismo archivo
      if (!numerosYaUsados.has(clave)) numerosYaUsados.set(clave, new Set())
      numerosYaUsados.get(clave).add(provGuia)
      for (const [k, cant] of recibidoEnGuia) {
        recibidoEnArchivo.set(k, (recibidoEnArchivo.get(k) || 0) + cant)
      }
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

    tituloCarga('Creando guías, lotes y kardex',
                `${guiasValidas.length} guía${guiasValidas.length === 1 ? '' : 's'}`,
                guiasValidas.length)

    for (const g of guiasValidas) {
      actualizarCarga(undefined, g.numeroGuia)
      try {
        const guia = await addGuiaIngresoCompra({
          compra_id: g.compra.id, numero_guia: g.numeroGuia, fecha_guia: g.fechaGuia,
          observaciones: g.observaciones, created_by: user.db_id
        })
        if (!guia?.id) throw new Error('no se pudo crear la cabecera de la guía')

        const monedaCompra = g.compra.currency || 'PEN'
        // Solo USD convierte; PEN = 1 aunque la compra guarde el T.C. SUNAT de referencia (2026-10-05)
        const tcCompra = monedaCompra === 'USD' ? (parseFloat(g.compra.tipo_cambio) || 1) : 1

        for (const l of g.lineas) {
          const costoOriginal = costoNetoLineaCompra(l.detalleCompra)   // sin IGV (2026-10-09)
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
    ocultarCarga()
    if (btn) { btn.disabled = false; btn.textContent = 'Procesar' }
  }
}

/** Log compartido por los importadores: errores primero, con scroll. */
function _pintarLogImport(idContenedor, log) {
  const errores = log.filter(l => l.tipo === 'error')
  const avisos  = log.filter(l => l.tipo === 'aviso')
  const oks     = log.filter(l => l.tipo === 'ok')
  _html(idContenedor, [
    ...errores.map(l => `<div style="padding:4px 0; color:var(--color-danger);">✕ ${_escCompras(l.texto)}</div>`),
    ...avisos.map(l => `<div style="padding:4px 0; color:var(--color-warning);">⚠ ${_escCompras(l.texto)}</div>`),
    ...oks.map(l => `<div style="padding:4px 0; color:var(--color-success);">✓ ${_escCompras(l.texto)}</div>`)
  ].join('') || '<div style="color:var(--text-secondary);">Sin observaciones.</div>')
}

function _html(id, contenido) { const el = document.getElementById(id); if (el) el.innerHTML = contenido }
