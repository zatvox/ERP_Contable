// ============================================================================
// ventas/importar-packing.js — IMPORTACIÓN MASIVA DE PACKINGS (PK)
// ============================================================================
// Espejo de importar-ventas.js. Varias filas con el mismo `numero_documento`
// forman UN PK con varias líneas: la cabecera se lee de la PRIMERA fila del
// grupo y cada fila aporta una línea de producto + lote + precio.
//
// Pensado para carga RETROACTIVA (histórico de otra empresa):
//   · Sin bultos: `cantidad_unidades` es opcional y por defecto 0, así no se
//     inventa un packing list que nadie pesó.
//   · El PK no mueve stock ni kardex (es cotización / orden de venta), igual
//     que al crearlo a mano. El lote es informativo y sirve para sugerir
//     costo y unidades cuando el PK se facture.
//   · El N° de documento viene en el archivo (es historia, ya tiene número).
//     El correlativo de la serie se adelanta hasta el mayor importado para que
//     el siguiente PK manual no choque.
//
// MULTIEMPRESA: se importa SIEMPRE en la empresa de TRABAJO del switch, nunca
// en una empresa escrita en el Excel. El documento se firma con un solo sello
// y ese sello es el que está puesto en la cabecera, a la vista. Los lotes y
// clientes se validan contra esa misma empresa.
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { supabase, insert, empresaTrabajoCtx } from '../supabase-client.js'
import { getCustomers, getLotes, getItems } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { mostrarCarga, actualizarCarga, ocultarCarga } from '../animaciones/index.js'
import { getSerie, registrarUsoSerie, formatearNumero, seriesDeTipo } from '../series.js'
import { empresaById, nombreEmpresa } from '../empresa.js'
import { _leerArchivoImportVentas, _parseFechaImportVentas } from './importar-ventas.js'
import { _esc } from './init.js'
import { renderPacking } from './packing.js'

const COLUMNAS = [
  'numero_documento', 'cliente_doc', 'fecha_emision', 'fecha_validez', 'moneda', 'tipo_cambio',
  'vendedor_doc', 'orden_compra_cliente', 'observaciones', 'estado',
  'sku', 'numero_lote', 'descripcion', 'nota',
  'cantidad', 'cantidad_unidades', 'precio_unitario', 'tipo_base', 'igv_porcentaje'
]

const TIPOS_BASE = ['gravada', 'exonerada', 'inafecta', 'exportacion']
const ESTADOS_OK = ['borrador', 'enviado']

function _htmlPK(id, contenido) { const el = document.getElementById(id); if (el) el.innerHTML = contenido }

/** Primer valor no vacío entre varios alias de columna. */
function _val(fila, ...nombres) {
  for (const n of nombres) {
    if (fila[n] !== undefined && fila[n] !== null && String(fila[n]).trim() !== '') return String(fila[n]).trim()
  }
  return ''
}
function _num(fila, ...nombres) {
  const v = _val(fila, ...nombres)
  if (v === '') return null
  const n = parseFloat(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

// ── Modal ────────────────────────────────────────────────────────────────────

window.abrirModalImportarPacking = function () {
  const input = document.getElementById('fileImportarPacking')
  if (input) input.value = ''
  const chk = document.getElementById('chkSimularPacking')
  if (chk) chk.checked = true
  _htmlPK('importar-packing-resumen', '')
  _htmlPK('importar-packing-log', '')

  // La empresa destino se MUESTRA, no se escribe: es lo que evita cargar el
  // histórico de Benji dentro de Jhiro y descubrirlo un mes después.
  const emp = empresaById(empresaTrabajoCtx())
  _htmlPK('importar-packing-empresa', emp
    ? `<div style="display:flex; align-items:center; gap:8px; padding:9px 12px; border:1px solid var(--border-color);
                   border-left:4px solid ${_esc(emp.color || '#2563eb')}; border-radius:var(--radius-md);
                   background:var(--bg-secondary); margin-bottom:12px; flex-wrap:wrap;">
         <span>Se importará en</span>
         <strong>${_esc(emp.codigo || emp.nombre_comercial)}</strong>
         <small style="color:var(--text-secondary);">RUC ${_esc(emp.ruc)}</small>
         <small style="margin-left:auto; color:var(--text-secondary);">Para cambiarla, usa el switch de la cabecera</small>
       </div>`
    : '<p style="color:var(--color-warning);">No hay empresa de trabajo definida. Revisa el switch de la cabecera.</p>')

  window.openModal('modal-importar-packing')
}

// ── Plantilla .xlsx (con los catálogos reales, para hacer VLOOKUP) ──────────
// La plantilla no es un archivo estático: se genera con el catálogo vigente de
// la empresa de trabajo. Así el Excel que descargas ya trae TUS SKU y TUS
// lotes en hojas aparte y puedes cruzarlos con BUSCARV en vez de tipear.

window.descargarPlantillaPacking = async function () {
  const btn = document.getElementById('btnPlantillaPacking')
  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Generando...' }
    const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm')
    const [clientes, items, lotes, seriesPK] = await Promise.all([
      getCustomers(), getItems(), getLotes(), seriesDeTipo('PK')
    ])
    const emp   = empresaById(empresaTrabajoCtx())
    const s0    = seriesPK[0]
    const serie = s0?.serie || 'PK'
    const hoy   = new Date().toISOString().slice(0, 10)
    const sig   = String((s0?.ultimo_correlativo || 0) + 1).padStart(s0?.digitos || 6, '0')
    const ejSku  = items.find(i => i.sku && i.tipo_item === 'mercaderia')
    const ejSku2 = items.filter(i => i.sku && i.tipo_item === 'mercaderia' && i.id !== ejSku?.id)[0]
    const ejLote = lotes.find(l => l.item_id === ejSku?.id)
    const ejCli  = clientes.find(c => c.nro_documento)

    const wb = XLSX.utils.book_new()

    // ── Hoja DATOS: UN documento con DOS líneas (el caso que importa) ─────
    const ej = (sku, lote, cant, precio, nota) => ({
      numero_documento: `${serie}-${sig}`,
      cliente_doc: ejCli?.nro_documento || '20123456789',
      fecha_emision: hoy,
      fecha_validez: '',
      moneda: 'PEN',
      tipo_cambio: '',
      vendedor_doc: '',
      orden_compra_cliente: 'OC-1234',
      observaciones: 'Carga retroactiva',
      estado: 'enviado',
      sku: sku || 'SKU-001',
      numero_lote: lote || '',
      descripcion: '',
      nota: nota || '',
      cantidad: cant,
      cantidad_unidades: '',
      precio_unitario: precio,
      tipo_base: 'gravada',
      igv_porcentaje: 18
    })
    const wsDatos = XLSX.utils.json_to_sheet(
      [ej(ejSku?.sku, ejLote?.numero_lote, 441, 12.5, '18 BOLSAS (24.50 KG X BOLSA)'),
       ej(ejSku2?.sku, '', 250, 14.8, '')],
      { header: COLUMNAS })
    wsDatos['!cols'] = COLUMNAS.map(c => ({ wch: Math.max(14, c.length + 2) }))
    XLSX.utils.book_append_sheet(wb, wsDatos, 'DATOS')

    // ── Hoja INSTRUCCIONES ────────────────────────────────────────────────
    const ins = [
      ['Columna', 'Obligatorio', 'Formato', 'Qué poner'],
      ['— CABECERA: se lee de la PRIMERA fila de cada numero_documento —', '', '', ''],
      ['numero_documento', 'SÍ', `${serie}-${sig}`, 'N° del PK. Repítelo IGUAL en todas las líneas del mismo documento. La serie debe existir en Configuración → Series.'],
      ['cliente_doc', 'SÍ', '11 u 8 dígitos', 'RUC o DNI del cliente. Debe existir en Contactos con rol Cliente (hoja CAT_CLIENTES).'],
      ['fecha_emision', 'SÍ', 'AAAA-MM-DD', 'También acepta DD/MM/AAAA y fecha de Excel.'],
      ['fecha_validez', 'no', 'AAAA-MM-DD', 'Vacío = se calcula con los días de validez de la serie.'],
      ['moneda', 'no', 'PEN o USD', 'Por defecto PEN.'],
      ['tipo_cambio', 'si USD', '3.7520', 'Soles por 1 USD. Obligatorio sólo si moneda = USD.'],
      ['vendedor_doc', 'no', 'RUC o DNI', 'Vacío = sin vendedor.'],
      ['orden_compra_cliente', 'no', 'texto', 'O/C del cliente.'],
      ['observaciones', 'no', 'texto', 'Nota general del PK (sale en el PDF).'],
      ['estado', 'no', 'borrador o enviado', 'Por defecto enviado. "facturado" NO se importa: eso lo marca la factura real.'],
      ['— LÍNEAS: una fila por producto —', '', '', ''],
      ['sku', 'SÍ', 'texto', 'SKU del producto. Debe existir en el catálogo (hoja CAT_PRODUCTOS).'],
      ['numero_lote', 'no', 'texto', 'Lote de referencia. Si lo pones, debe existir Y ser de esta empresa (hoja CAT_LOTES).'],
      ['descripcion', 'no', 'texto', 'Vacío = se usa el nombre del producto.'],
      ['nota', 'no', 'texto', 'Ej. "18 BOLSAS (24.50 KG X BOLSA)".'],
      ['cantidad', 'SÍ', 'número > 0', 'Kilos de la línea.'],
      ['cantidad_unidades', 'no', 'número', 'N° de bultos. Déjalo VACÍO en carga retroactiva: no se inventan bultos.'],
      ['precio_unitario', 'SÍ', '4 decimales', 'Precio SIN IGV, igual que en todo el ERP.'],
      ['tipo_base', 'no', TIPOS_BASE.join(' / '), 'Por defecto gravada.'],
      ['igv_porcentaje', 'no', 'número', 'Por defecto 18. Si tipo_base no es gravada se fuerza a 0.'],
      ['', '', '', ''],
      ['REGLAS', '', '', ''],
      ['1', '', '', 'Filas con el mismo numero_documento = UN PK con varias líneas.'],
      ['2', '', '', 'Si una línea del documento falla, NO se importa ninguna línea de ese documento (todo o nada por documento).'],
      ['3', '', '', `Se importa en la empresa de trabajo del switch: ahora ${emp ? (emp.codigo || emp.nombre_comercial) : '(sin definir)'}.`],
      ['4', '', '', 'El PK no mueve stock ni kardex. El lote queda informativo hasta que se facture.'],
      ['5', '', '', 'Deja marcado "Sólo simular" la primera vez: valida todo el archivo sin escribir nada.'],
      ['6', '', '', 'No borres ni renombres la hoja DATOS: es la que lee el importador.']
    ]
    const wsIns = XLSX.utils.aoa_to_sheet(ins)
    wsIns['!cols'] = [{ wch: 26 }, { wch: 12 }, { wch: 20 }, { wch: 96 }]
    XLSX.utils.book_append_sheet(wb, wsIns, 'INSTRUCCIONES')

    // ── Catálogos reales para BUSCARV ─────────────────────────────────────
    const wsProd = XLSX.utils.json_to_sheet(items.filter(i => i.sku).map(i => ({
      sku: i.sku, nombre: i.nombre, tipo: i.tipo_item, unidad: i.unidad_medida, precio_venta: i.precio_venta
    })))
    wsProd['!cols'] = [{ wch: 18 }, { wch: 46 }, { wch: 13 }, { wch: 9 }, { wch: 13 }]
    XLSX.utils.book_append_sheet(wb, wsProd, 'CAT_PRODUCTOS')

    const itemsPorId = new Map(items.map(i => [i.id, i]))
    const wsLotes = XLSX.utils.json_to_sheet(lotes.map(l => ({
      numero_lote: l.numero_lote,
      sku: itemsPorId.get(l.item_id)?.sku || '',
      producto: itemsPorId.get(l.item_id)?.nombre || '',
      cantidad: l.cantidad,
      costo_unitario: l.costo_unitario
    })))
    wsLotes['!cols'] = [{ wch: 22 }, { wch: 18 }, { wch: 46 }, { wch: 12 }, { wch: 14 }]
    XLSX.utils.book_append_sheet(wb, wsLotes, 'CAT_LOTES')

    const wsCli = XLSX.utils.json_to_sheet(clientes.map(c => ({ nro_documento: c.nro_documento, nombre: c.nombre })))
    wsCli['!cols'] = [{ wch: 16 }, { wch: 52 }]
    XLSX.utils.book_append_sheet(wb, wsCli, 'CAT_CLIENTES')

    const wsSer = XLSX.utils.aoa_to_sheet([
      ['serie', 'descripcion', 'digitos', 'ultimo_correlativo', 'dias_validez'],
      ...seriesPK.map(s => [s.serie, s.descripcion, s.digitos, s.ultimo_correlativo, s.dias_validez])
    ])
    wsSer['!cols'] = [{ wch: 10 }, { wch: 34 }, { wch: 9 }, { wch: 19 }, { wch: 13 }]
    XLSX.utils.book_append_sheet(wb, wsSer, 'CAT_SERIES_PK')

    XLSX.writeFile(wb, `plantilla_packing_${(emp?.codigo || 'erp').toLowerCase()}_${hoy}.xlsx`)
    showToast(`Plantilla generada con tu catálogo actual: ${items.filter(i => i.sku).length} productos, ${lotes.length} lotes, ${clientes.length} clientes.`, 'success', 7000)
  } catch (e) {
    console.error('descargarPlantillaPacking', e)
    showToast('No se pudo generar la plantilla: ' + e.message, 'danger', 7000)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📄 Descargar plantilla de ejemplo' }
  }
}

// ── Procesar ─────────────────────────────────────────────────────────────────

window.procesarImportacionPacking = async function () {
  const btn     = document.getElementById('btnProcesarImportarPacking')
  const input   = document.getElementById('fileImportarPacking')
  const simular = !!document.getElementById('chkSimularPacking')?.checked
  if (btn?.disabled) return

  const file = input?.files?.[0]
  if (!file) { showToast('Selecciona un archivo primero', 'warning'); return }

  const empresaId = empresaTrabajoCtx()
  if (empresaId == null) { showToast('No hay empresa de trabajo definida (switch de la cabecera)', 'danger'); return }

  const logLineas = []
  let docsOk = 0, lineasOk = 0, docsFallidos = 0

  try {
    if (btn) { btn.disabled = true; btn.textContent = simular ? 'Simulando...' : 'Importando...' }
    _htmlPK('importar-packing-resumen', '<p style="color:var(--text-secondary);">Leyendo archivo...</p>')
    _htmlPK('importar-packing-log', '')

    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    let filas
    try { filas = await _leerArchivoImportVentas(file) }
    catch {
      _htmlPK('importar-packing-resumen', '<p style="color:var(--color-danger);">No se pudo leer el archivo. Verifica que sea un .xlsx o .csv válido.</p>')
      return
    }
    if (!filas?.length) {
      _htmlPK('importar-packing-resumen', '<p style="color:var(--color-danger);">La hoja DATOS no tiene filas.</p>')
      return
    }

    // getLotes()/getCustomers() ya vienen filtrados por el contexto de
    // empresa: un lote de otra empresa simplemente "no existe" aquí.
    const [clientes, items, lotes] = await Promise.all([getCustomers(), getItems(), getLotes()])
    const { data: pkExistentes } = await supabase.from('packing').select('numero, empresa_id')
    const numerosUsados = new Set((pkExistentes || [])
      .filter(p => Number(p.empresa_id) === Number(empresaId))
      .map(p => String(p.numero || '').trim().toUpperCase()))

    const cliPorDoc  = new Map(clientes.filter(c => c.nro_documento).map(c => [String(c.nro_documento).trim(), c]))
    const itemPorSku = new Map(items.filter(i => i.sku).map(i => [String(i.sku).trim().toUpperCase(), i]))
    const lotePorNum = new Map()
    for (const l of (lotes || [])) {
      if (!l.numero_lote) continue
      if (Number(l.empresa_id) !== Number(empresaId)) continue      // cinturón, además del filtro central
      lotePorNum.set(String(l.numero_lote).trim().toUpperCase(), l)
    }

    // Agrupar: mismo numero_documento = un PK con N líneas
    const grupos = new Map()
    filas.forEach((fila, idx) => {
      const num = _val(fila, 'numero_documento', 'numeroDocumento').toUpperCase()
      if (!grupos.has(num)) grupos.set(num, [])
      grupos.get(num).push({ fila, numFila: idx + 2 })
    })

    const seriesCache = new Map()
    const maxPorSerie = new Map()

    // La cabecera se lee SOLO de la primera fila del grupo. Repetir el N°
    // significa "estas filas son el detalle del mismo PK", así que su
    // cabecera debe coincidir en todas. Si no coincide no es detalle: es un
    // número repetido por error.
    // `norm` normaliza antes de comparar: una fecha leída de Excel llega como
    // Date y dos celdas iguales se verían distintas.
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
    const _normFechaPK = (v) => _parseFechaImportVentas(v) || String(v).trim().toUpperCase()
    const CAMPOS_CABECERA_PK = [
      ['cliente_doc',   ['cliente_doc', 'cliente_ruc', 'clienteRuc']],
      ['fecha_emision', ['fecha_emision', 'fechaEmision'], _normFechaPK],
      ['fecha_validez', ['fecha_validez', 'fechaValidez'], _normFechaPK],
      ['moneda',        ['moneda']],
      ['tipo_cambio',   ['tipo_cambio', 'tipoCambio']],
      ['termino_pago',  ['termino_pago', 'terminoPago']]
    ]

    await mostrarCarga({
      titulo: simular ? 'Simulando importación de packings' : 'Importando packings',
      subtitulo: `${grupos.size} PK · ${nombreEmpresa(empresaId)}`,
      total: grupos.size
    })

    for (const [numeroDoc, filasGrupo] of grupos) {
      actualizarCarga(undefined, numeroDoc || '(sin N°)')
      const falla = (msg) => { docsFallidos++; logLineas.push(msg) }

      if (!numeroDoc) { falla(`Fila ${filasGrupo[0].numFila}: falta "numero_documento".`); continue }
      if (numerosUsados.has(numeroDoc)) { falla(`PK "${numeroDoc}": ya existe en ${nombreEmpresa(empresaId)}.`); continue }

      const malasPK = _incoherencias(filasGrupo, CAMPOS_CABECERA_PK)
      if (malasPK.length) {
        falla(`PK "${numeroDoc}": sus ${filasGrupo.length} filas no coinciden en ${malasPK.join(', ')}. Si son dos PK distintos, diferéncialos; si es uno solo, repite la cabecera igual en todas sus filas.`)
        continue
      }

      // Serie y correlativo salen del propio número: PK-018500 → serie PK, 18500
      const corte = numeroDoc.lastIndexOf('-')
      const serieTxt = corte > 0 ? numeroDoc.slice(0, corte) : ''
      const corr = corte > 0 ? parseInt(numeroDoc.slice(corte + 1), 10) : NaN
      if (!serieTxt || !Number.isFinite(corr) || corr <= 0) {
        falla(`PK "${numeroDoc}": formato inválido. Se espera SERIE-NÚMERO, ej. PK-018500.`); continue
      }
      if (!seriesCache.has(serieTxt)) seriesCache.set(serieTxt, await getSerie('PK', serieTxt))
      const serieRow = seriesCache.get(serieTxt)
      if (!serieRow) {
        falla(`PK "${numeroDoc}": la serie "${serieTxt}" no existe para ${nombreEmpresa(empresaId)} (Configuración → Series y correlativos).`); continue
      }

      const primera = filasGrupo[0].fila
      const docCli  = _val(primera, 'cliente_doc', 'cliente_ruc', 'clienteRuc')
      const cliente = cliPorDoc.get(docCli)
      if (!docCli || !cliente) { falla(`PK "${numeroDoc}": cliente "${docCli || '(vacío)'}" no existe o no tiene rol Cliente.`); continue }

      const fecha = _parseFechaImportVentas(_val(primera, 'fecha_emision', 'fechaEmision'))
      if (!fecha) { falla(`PK "${numeroDoc}": fecha_emision inválida.`); continue }

      const moneda = (_val(primera, 'moneda') || 'PEN').toUpperCase()
      if (!['PEN', 'USD'].includes(moneda)) { falla(`PK "${numeroDoc}": moneda "${moneda}" inválida (PEN o USD).`); continue }
      const tc = moneda === 'USD' ? _num(primera, 'tipo_cambio', 'tipoCambio') : 1
      if (moneda === 'USD' && (!tc || tc <= 0)) { falla(`PK "${numeroDoc}": en USD el tipo_cambio es obligatorio y mayor a 0.`); continue }

      const estado = (_val(primera, 'estado') || 'enviado').toLowerCase()
      if (!ESTADOS_OK.includes(estado)) {
        falla(`PK "${numeroDoc}": estado "${estado}" no se importa (sólo ${ESTADOS_OK.join(' o ')}; "facturado" lo marca la factura real).`); continue
      }

      let validez = _parseFechaImportVentas(_val(primera, 'fecha_validez', 'fechaValidez'))
      if (!validez && serieRow.dias_validez) {
        const d = new Date(fecha + 'T00:00:00')
        d.setDate(d.getDate() + parseInt(serieRow.dias_validez))
        validez = d.toISOString().slice(0, 10)
      }

      const docVend  = _val(primera, 'vendedor_doc', 'vendedor')
      const vendedor = docVend ? cliPorDoc.get(docVend) : null
      if (docVend && !vendedor) logLineas.push(`PK "${numeroDoc}": vendedor "${docVend}" no existe — se guarda sin vendedor.`)

      // ── Líneas: todo o nada por documento ────────────────────────────────
      const lineas = []
      let grupoValido = true
      for (const { fila, numFila } of filasGrupo) {
        const sku  = _val(fila, 'sku', 'SKU')
        const item = itemPorSku.get(sku.toUpperCase())
        if (!sku || !item) {
          logLineas.push(`PK "${numeroDoc}" fila ${numFila}: SKU "${sku || '(vacío)'}" no existe en el catálogo.`)
          grupoValido = false; continue
        }

        const numLote = _val(fila, 'numero_lote', 'numeroLote')
        let lote = null
        if (numLote) {
          lote = lotePorNum.get(numLote.toUpperCase())
          if (!lote) {
            logLineas.push(`PK "${numeroDoc}" fila ${numFila}: lote "${numLote}" no existe en ${nombreEmpresa(empresaId)}.`)
            grupoValido = false; continue
          }
          if (lote.item_id !== item.id) {
            logLineas.push(`PK "${numeroDoc}" fila ${numFila}: el lote "${numLote}" no pertenece al SKU "${sku}".`)
            grupoValido = false; continue
          }
        }

        const cantidad = _num(fila, 'cantidad')
        if (!cantidad || cantidad <= 0) {
          logLineas.push(`PK "${numeroDoc}" fila ${numFila}: cantidad debe ser mayor a 0.`)
          grupoValido = false; continue
        }

        const precio = _num(fila, 'precio_unitario', 'precioUnitario')
        if (precio == null || precio < 0) {
          logLineas.push(`PK "${numeroDoc}" fila ${numFila}: precio_unitario inválido.`)
          grupoValido = false; continue
        }

        const tipoBase = (_val(fila, 'tipo_base', 'tipoBase') || 'gravada').toLowerCase()
        if (!TIPOS_BASE.includes(tipoBase)) {
          logLineas.push(`PK "${numeroDoc}" fila ${numFila}: tipo_base "${tipoBase}" inválido (${TIPOS_BASE.join('/')}).`)
          grupoValido = false; continue
        }

        // Si la base no es gravada el IGV es 0 por definición: se fuerza en vez
        // de confiar en lo que diga el Excel.
        const igvPct   = tipoBase === 'gravada' ? (_num(fila, 'igv_porcentaje', 'igvPorcentaje') ?? 18) : 0
        const subtotal = +(cantidad * precio).toFixed(2)
        const igvMonto = +(subtotal * igvPct / 100).toFixed(2)

        lineas.push({
          item_id: item.id,
          lote_id: lote?.id || null,
          descripcion: _val(fila, 'descripcion') || item.nombre,
          nota: _val(fila, 'nota') || null,
          cantidad,
          unidad_medida: item.unidad_medida || 'KG',
          cantidad_unidades: _num(fila, 'cantidad_unidades', 'cantidadUnidades') || 0,
          precio_unitario: +precio.toFixed(4),       // 4 decimales, como todo el ERP
          tipo_base: tipoBase,
          igv_porcentaje: igvPct,
          subtotal,
          igv_monto: igvMonto,
          total_linea: +(subtotal + igvMonto).toFixed(2)
        })
      }

      if (!grupoValido || !lineas.length) {
        docsFallidos++
        logLineas.push(grupoValido
          ? `PK "${numeroDoc}": no quedó ninguna línea válida.`
          : `PK "${numeroDoc}": NO se importó — una o más líneas tienen error (todo o nada por documento).`)
        continue
      }

      const tot = lineas.reduce((a, l) => ({
        b: a.b + l.subtotal, i: a.i + l.igv_monto, t: a.t + l.total_linea
      }), { b: 0, i: 0, t: 0 })

      if (simular) { docsOk++; lineasOk += lineas.length; numerosUsados.add(numeroDoc); continue }

      // ── Escritura. empresa_id va EXPLÍCITO: una carga masiva no debe
      //    depender del sello automático. ──────────────────────────────────
      const pk = await insert('packing', {
        empresa_id: empresaId,
        tipo: 'venta', serie: serieRow.serie, correlativo: corr,
        numero: formatearNumero(serieRow, corr),
        contact_id: cliente.id,
        fecha_emision: fecha, fecha_validez: validez,
        moneda, tipo_cambio: tc || 1,
        termino_pago_id: null,
        vendedor_id: vendedor?.id || null,
        orden_compra_cliente: _val(primera, 'orden_compra_cliente', 'ordenCompraCliente') || null,
        observaciones: _val(primera, 'observaciones') || null,
        subtotal: +tot.b.toFixed(2), igv: +tot.i.toFixed(2), total: +tot.t.toFixed(2),
        estado,
        created_by: user?.db_id || null
      })
      if (!pk) { docsFallidos++; logLineas.push(`PK "${numeroDoc}": no se pudo crear la cabecera (¿número repetido?).`); continue }

      let escritas = 0
      for (const [i, l] of lineas.entries()) {
        const r = await insert('detalle_packing', { packing_id: pk.id, orden: i, ...l })
        if (!r) { logLineas.push(`PK "${numeroDoc}": falló la línea ${i + 1} (${l.descripcion}).`); break }
        escritas++
      }
      if (escritas !== lineas.length) {
        // Cabecera sin todas sus líneas = documento mentiroso. Se revierte.
        await supabase.from('detalle_packing').delete().eq('packing_id', pk.id)
        await supabase.from('packing').delete().eq('id', pk.id)
        docsFallidos++
        logLineas.push(`PK "${numeroDoc}": revertido por completo (la cabecera no puede quedar sin todas sus líneas).`)
        continue
      }

      numerosUsados.add(numeroDoc)
      docsOk++; lineasOk += lineas.length
      if (corr > (maxPorSerie.get(serieRow.serie) || 0)) maxPorSerie.set(serieRow.serie, corr)
    }

    // El correlativo de la serie se adelanta al mayor importado para que el
    // siguiente PK manual no choque con el histórico recién cargado.
    if (!simular) {
      for (const [serie, corr] of maxPorSerie) await registrarUsoSerie('PK', serie, corr)
    }

    _htmlPK('importar-packing-resumen', `
      <div style="display:flex; gap:20px; flex-wrap:wrap;">
        <div><strong style="color:var(--color-success);">${docsOk}</strong> PK ${simular ? 'válidos' : 'importados'}</div>
        <div><strong>${lineasOk}</strong> líneas</div>
        <div><strong style="color:${docsFallidos > 0 ? 'var(--color-danger)' : 'var(--text-secondary)'};">${docsFallidos}</strong> documentos con error</div>
        <div style="color:var(--text-secondary);">en ${_esc(nombreEmpresa(empresaId))}</div>
      </div>
      ${simular ? '<p style="color:var(--color-info); margin-top:8px;">Simulación: no se escribió nada. Desmarca "Sólo simular" para importar de verdad.</p>' : ''}`)

    _pintarLogImportPK(logLineas)

    if (!simular && docsOk > 0) {
      showToast(`${docsOk} PK importado(s) en ${nombreEmpresa(empresaId)} (${lineasOk} líneas).`, 'success', 6000)
      await renderPacking(true)
    }
    if (docsFallidos > 0 && docsOk === 0) showToast('No se importó ningún documento. Revisa el detalle.', 'danger', 7000)
  } catch (e) {
    console.error('procesarImportacionPacking', e)
    _htmlPK('importar-packing-resumen', `<p style="color:var(--color-danger);">Error: ${_esc(e.message)}</p>`)
    showToast('Error al procesar la importación', 'danger')
  } finally {
    ocultarCarga()
    if (btn) { btn.disabled = false; btn.textContent = 'Procesar' }
  }
}

/** Log con los errores primero y scroll, igual que los otros importadores. */
function _pintarLogImportPK(lineas) {
  if (!lineas.length) { _htmlPK('importar-packing-log', ''); return }
  _htmlPK('importar-packing-log', `
    <div style="max-height:260px; overflow-y:auto; margin-top:10px; padding:10px;
                border:1px solid var(--border-color); border-radius:var(--radius-md); background:var(--bg-secondary);">
      <ul style="margin:0; padding-left:18px; color:var(--color-danger); font-size:0.84rem;">
        ${lineas.map(l => `<li>${_esc(l)}</li>`).join('')}
      </ul>
    </div>`)
}
