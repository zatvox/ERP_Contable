// ============================================================================
// COSTOS-LEDGER.JS — Ledger único de costos de importación (FASE B)
// ============================================================================
// Reemplaza los 3 tabs que estaban separados y descoordinados:
//   tab 5 "Gastos locales"  (tabla gastos_locales)
//   tab 7 "Gastos Despacho" (sin tabla; sus funciones no existían)
//   tab 8 "Gastos Financieros" (3 campos fijos en un form)
// Son el mismo dato: una línea de costo con documento, moneda, clasificación
// y base de prorrateo. Ahora viven en importacion_costos (SQL 86).
//
// Regla de oro: el costo NO se escribe a mano. Se elige el CONCEPTO de un
// selector y el concepto trae su clasificación y su base de prorrateo — así
// nadie puede volver a cargar el IPM al inventario (el error de US$ 973 del
// Excel 1 del lote MB31539).
//
// Enlaces: documentos_importacion.cxp_id   → cuentas_pagar (Cobranzas)
//          documentos_importacion.compra_id → compras (Registro de Compras)
// ============================================================================

import { supabase, insert, update, deleteRecord, query, ultimoErrorInsert, esperarContextoEmpresa } from '../supabase-client.js'
import { getCurrentUser } from '../auth-supabase.js'
import { showToast, formatNumber, fechaDMY, pintarDocumentoContacto } from '../helpers.js'
import { convertirEnBuscador, refrescarBuscador } from '../buscador-select.js'
import { abrirModalContacto } from '../shared/contacto-modal.js'
import { getSuppliers, addCuentaPagar, subirAdjuntos, getAdjuntos, getUrlAdjunto,
         eliminarAdjuntosDe, validarArchivoAdjunto, getConteoAdjuntos } from '../supabase-data.js'
import { getTipoCambioDia } from '../sunat-api.js'
import { columnasAuto } from '../col-menu.js'
import { menuAccionesFila } from '../main.js'

// ─────────────────────────────────────────────────────────────────────────────
// CATÁLOGO DE CONCEPTOS
// Cada concepto trae su grupo, su clasificación contable y la base con la que
// se prorratea. Los físicos (los genera el peso/volumen) van por peso bruto;
// los de valor (tributos, comisiones %) por valor FOB.
// ─────────────────────────────────────────────────────────────────────────────
export const CONCEPTOS_COSTO = [
  // ── CIF ───────────────────────────────────────────────────────────────────
  { codigo: 'flete',             label: 'Flete internacional marítimo',           grupo: 'cif',             clasificacion: 'inventario',       base: 'peso_bruto' },
  { codigo: 'seguro',            label: 'Seguro de transporte internacional',     grupo: 'cif',             clasificacion: 'inventario',       base: 'valor_fob' },
  // ── Tributos de la DAM ────────────────────────────────────────────────────
  { codigo: 'ad_valorem',        label: 'Ad Valorem (6%)',                        grupo: 'tributos',        clasificacion: 'inventario',       base: 'valor_fob' },
  { codigo: 'ad_valorem_adic',   label: 'Ad Valorem adicional (duda razonable)',  grupo: 'tributos',        clasificacion: 'inventario',       base: 'valor_fob' },
  { codigo: 'igv',               label: 'IGV importación (15.5%)',                grupo: 'tributos',        clasificacion: 'credito_fiscal',   base: 'valor_fob' },
  { codigo: 'ipm',               label: 'IPM (2.5%)',                             grupo: 'tributos',        clasificacion: 'credito_fiscal',   base: 'valor_fob' },
  { codigo: 'percepcion',        label: 'Percepción IGV importación (3.5%)',      grupo: 'tributos',        clasificacion: 'percepcion',       base: 'valor_fob' },
  // ── Despacho / agenciamiento ──────────────────────────────────────────────
  { codigo: 'agenciamiento',     label: 'Agenciamiento de aduana',                grupo: 'despacho',        clasificacion: 'inventario',       base: 'valor_fob' },
  { codigo: 'comision_aduanas',  label: 'Comisión de aduanas (agente)',           grupo: 'despacho',        clasificacion: 'inventario',       base: 'valor_fob' },
  { codigo: 'comision_interna',  label: 'Comisión de agente interno (RH)',        grupo: 'despacho',        clasificacion: 'inventario',       base: 'valor_fob' },
  { codigo: 'visto_bueno',       label: 'Visto bueno',                            grupo: 'despacho',        clasificacion: 'inventario',       base: 'peso_bruto' },
  { codigo: 'gate_in',           label: 'Gate in / devolución de contenedor',     grupo: 'despacho',        clasificacion: 'inventario',       base: 'peso_bruto' },
  { codigo: 'boletin_quimico',   label: 'Boletín químico SUNAT',                  grupo: 'despacho',        clasificacion: 'inventario',       base: 'peso_bruto' },
  { codigo: 'sobreestadia',      label: 'Sobreestadía / demora de contenedor',    grupo: 'despacho',        clasificacion: 'inventario',       base: 'peso_bruto' },
  // ── Nacionalización física ────────────────────────────────────────────────
  { codigo: 'gastos_destino',    label: 'Gastos en destino',                      grupo: 'nacionalizacion', clasificacion: 'inventario',       base: 'peso_bruto' },
  { codigo: 'almacen',           label: 'Almacenaje',                             grupo: 'nacionalizacion', clasificacion: 'inventario',       base: 'peso_bruto' },
  { codigo: 'thc',               label: 'THC destino',                            grupo: 'nacionalizacion', clasificacion: 'inventario',       base: 'peso_bruto' },
  { codigo: 'transporte_local',  label: 'Transporte local a almacén',             grupo: 'nacionalizacion', clasificacion: 'inventario',       base: 'peso_bruto' },
  { codigo: 'cuadrilla',         label: 'Cuadrilla / estiba',                     grupo: 'nacionalizacion', clasificacion: 'inventario',       base: 'peso_bruto' },
  { codigo: 'resguardo',         label: 'Resguardo / custodia',                   grupo: 'nacionalizacion', clasificacion: 'inventario',       base: 'peso_bruto' },
  { codigo: 'refrigerio',        label: 'Refrigerio de cuadrilla',                grupo: 'nacionalizacion', clasificacion: 'inventario',       base: 'peso_bruto' },
  // ── Financieros ───────────────────────────────────────────────────────────
  { codigo: 'comision_bancaria', label: 'Comisión bancaria / SWIFT',              grupo: 'financiero',      clasificacion: 'gasto_financiero', base: 'valor_fob' },
  { codigo: 'interes',           label: 'Intereses moratorios',                   grupo: 'financiero',      clasificacion: 'gasto_financiero', base: 'valor_fob' },
  // ── Ajustes de gestión ────────────────────────────────────────────────────
  { codigo: 'reposicion',        label: 'Costo de reposición (% del CIF)',        grupo: 'ajuste',          clasificacion: 'solo_gestion',     base: 'valor_fob' },
  { codigo: 'otro',              label: 'Otro gasto',                             grupo: 'nacionalizacion', clasificacion: 'inventario',       base: 'valor_fob' }
]

export const GRUPOS = {
  cif:             'CIF',
  tributos:        'Tributos DAM',
  despacho:        'Despacho',
  nacionalizacion: 'Nacionalización',
  financiero:      'Financieros',
  ajuste:          'Ajustes'
}

export const CLASIFICACIONES = {
  inventario:       { label: 'Costo NIC 2',      color: 'success' },
  solo_gestion:     { label: 'Solo gestión',     color: 'info' },
  credito_fiscal:   { label: 'Crédito fiscal',   color: 'warning' },
  percepcion:       { label: 'Percepción',       color: 'warning' },
  gasto_financiero: { label: 'Gasto financiero', color: 'info' },
  no_costo:         { label: 'No costo',         color: 'secondary' }
}

const BASES = {
  valor_fob:  'Valor FOB',
  peso_neto:  'Peso neto',
  peso_bruto: 'Peso bruto',
  bultos:     'Bultos',
  directo:    'Directo a una línea'
}

const TIPOS_DOC = {
  factura:           'Factura',
  boleta:            'Boleta de venta',
  rh:                'Recibo por honorarios',
  liquidacion_sunat: 'Liquidación SUNAT',
  dam:               'DAM / DUA',
  autoliquidacion:   'Autoliquidación',
  voucher_bancario:  'Voucher / nota bancaria',
  proforma:          'Proforma (provisional)',
  nota_credito:      'Nota de crédito',
  poliza:            'Póliza de seguro',
  sin_comprobante:   'Sin comprobante',
  otro:              'Otro'
}

// Código SUNAT sugerido por tipo, para que la línea pueda ir al Registro de Compras
const TIPO_COMPROBANTE_SUNAT = {
  factura: '01', boleta: '02', rh: '02', nota_credito: '09',
  dam: '50', autoliquidacion: '50', liquidacion_sunat: '50', proforma: null,
  voucher_bancario: null, poliza: '01', sin_comprobante: null, otro: null
}

export const conceptoPorCodigo = c => CONCEPTOS_COSTO.find(x => x.codigo === c) || null

// ─────────────────────────────────────────────────────────────────────────────
// ESTADO DEL TAB
// ─────────────────────────────────────────────────────────────────────────────
const LS_FILTRO = 'impCostosFiltroGrupo'
let _lineas = []
let _resumen = null
let _parametros = []
let _proveedores = []
let _contenedores = []
let _detallesCI = []
let _conteoAdj = {}
let _filtroGrupo = localStorage.getItem(LS_FILTRO) || 'todos'
let _busqueda = ''
let _orden = { campo: 'fecha_emision', dir: 'asc' }
let _editandoId = null
let _archivosPendientes = []

const n2 = v => formatNumber(parseFloat(v) || 0, 2)
const n4 = v => formatNumber(parseFloat(v) || 0, 4)
const num = v => parseFloat(v) || 0

/** La carpeta de la importación seleccionada arriba. */
function carpetaActual() {
  return window.costeoActual?.carpeta_importacion_id || null
}

// ─────────────────────────────────────────────────────────────────────────────
// CAPA DE DATOS
// ─────────────────────────────────────────────────────────────────────────────
export async function getLineasCosto(carpetaId) {
  const { data, error } = await supabase.from('v_importacion_costos')
    .select('*').eq('carpeta_importacion_id', carpetaId).order('fecha_emision')
  if (error) { console.warn('getLineasCosto:', error.message); return [] }
  return data || []
}

export async function getResumenCarpeta(carpetaId) {
  const { data, error } = await supabase.from('v_importacion_resumen')
    .select('*').eq('carpeta_id', carpetaId).maybeSingle()
  if (error) { console.warn('getResumenCarpeta:', error.message); return null }
  return data || null
}

export async function getParametrosCosteo() {
  return await query('importacion_parametros', { activo: true })
}

export async function getContenedoresCarpeta(carpetaId) {
  return await query('contenedores', { carpeta_importacion_id: carpetaId })
}

async function getDetallesCIdeCarpeta(carpetaId) {
  const { data, error } = await supabase.from('detalle_comercial_invoice')
    .select('id, lote, cantidad_neto, costo_total, comercial_invoice_id, comercial_invoices!inner(carpeta_importacion_id)')
    .eq('comercial_invoices.carpeta_importacion_id', carpetaId)
  if (error) { console.warn('getDetallesCIdeCarpeta:', error.message); return [] }
  return data || []
}

/**
 * Crea el documento + su línea de costo. Si el documento ya existe (mismo
 * proveedor/serie/número) lo reusa: así una factura que cubre 2 carpetas se
 * registra UNA vez y se reparte en N líneas.
 */
export async function crearLineaCosto(doc, linea, userId) {
  let documentoId = doc.id || null

  if (!documentoId) {
    // ¿Ya existe este comprobante? (caso "una factura, 2 DAMs")
    // El indice unico del SQL 87 es por (empresa, proveedor, serie, numero):
    // la misma factura del mismo agente puede existir en Jhiro y en Benji y
    // son dos documentos distintos. Por eso la busqueda se acota a la empresa
    // de la carpeta, no a las empresas activas del chip.
    if (doc.proveedor_id && doc.serie && doc.numero) {
      const filtro = { proveedor_id: doc.proveedor_id, serie: doc.serie, numero: doc.numero }
      if (doc.empresa_id) filtro.empresa_id = doc.empresa_id
      const previos = await query('documentos_importacion', filtro)
      if (previos && previos.length) documentoId = previos[0].id
    }
    if (!documentoId) {
      const fila = await insert('documentos_importacion', { ...doc, created_by: userId })
      if (!fila || !fila.id) throw new Error(ultimoErrorInsert()?.message || 'No se pudo registrar el documento')
      documentoId = fila.id
    }
  }

  // Costo comercial (gestión): IGV/IPM/percepción también cuentan, salvo que el llamador diga otra cosa.
  if (linea.entra_costo_gestion == null && ['credito_fiscal', 'percepcion'].includes(linea.clasificacion)) linea = { ...linea, entra_costo_gestion: true }
  const filaCosto = await insert('importacion_costos', { ...linea, documento_id: documentoId, created_by: userId })
  if (!filaCosto || !filaCosto.id) throw new Error(ultimoErrorInsert()?.message || 'No se pudo registrar la línea de costo')
  return { documentoId, costoId: filaCosto.id }
}

/** Crea la Cuenta por Pagar del documento (una sola fuente de CxP: Cobranzas). */
export async function vincularCxPDocumento(documentoId, userId) {
  const docs = await query('documentos_importacion', { id: documentoId })
  const doc = docs && docs[0]
  if (!doc) throw new Error('Documento no encontrado')
  if (doc.cxp_id) throw new Error('Este documento ya tiene Cuenta por Pagar')
  if (!doc.proveedor_id) throw new Error('El documento necesita proveedor para generar la CxP')
  if (num(doc.monto_total) <= 0) throw new Error('El documento no tiene importe')

  const cxp = await addCuentaPagar({
    contact_id:         doc.proveedor_id,
    tipo_comprobante:   doc.tipo_comprobante || null,
    serie:              doc.serie || null,
    numero_comprobante: doc.numero || null,
    fecha_emision:      doc.fecha_emision,
    fecha_vencimiento:  doc.fecha_vencimiento || null,
    moneda:             doc.moneda || 'USD',
    tipo_cambio:        num(doc.tipo_cambio) || 1,
    monto_total:        num(doc.monto_total),
    monto_pagado:       0,
    estado:             'pendiente',
    observaciones:      `Gasto de importación · doc #${documentoId}`,
    created_by:         userId
  })
  if (!cxp || !cxp.id) throw new Error(ultimoErrorInsert()?.message || 'No se pudo crear la Cuenta por Pagar')

  const ok = await update('documentos_importacion', documentoId, { cxp_id: cxp.id })
  if (!ok) throw new Error('CxP creada pero no se pudo enlazar al documento')
  return cxp
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER DEL TAB
// ─────────────────────────────────────────────────────────────────────────────
export async function renderCostosLedger() {
  const cont = document.getElementById('tabla-costos-importacion')
  if (!cont) return

  // Multiempresa: las vistas v_importacion_* se filtran por empresa_id y el
  // filtro falla CERRADO si el contexto no esta listo (SQL 87 + supabase-client).
  await esperarContextoEmpresa()

  if (!window.costeoActual || !window.costeoActual.id) {
    cont.innerHTML = _aviso('Selecciona una importación arriba para ver sus costos.')
    _pintarTotales(null)
    return
  }

  const carpeta = carpetaActual()
  if (!carpeta) {
    cont.innerHTML = _aviso(
      'Esta importación todavía no tiene carpeta de costeo.',
      'Corre <code>assets/sql/86_importaciones_ledger_costos.sql</code> en Supabase: crea una carpeta por cada Commercial Invoice y traslada los gastos locales al ledger.'
    )
    _pintarTotales(null)
    return
  }

  cont.innerHTML = '<p style="text-align:center; padding:20px; color:var(--text-secondary);">Cargando costos…</p>'

  const [lineas, resumen, params, contens, detalles, adj] = await Promise.all([
    getLineasCosto(carpeta),
    getResumenCarpeta(carpeta),
    getParametrosCosteo(),
    getContenedoresCarpeta(carpeta),
    getDetallesCIdeCarpeta(carpeta),
    getConteoAdjuntos('documento_importacion')
  ])
  _lineas = lineas; _resumen = resumen; _parametros = params || []
  _contenedores = contens || []; _detallesCI = detalles || []; _conteoAdj = adj || {}

  _pintarChips()
  _pintarTabla()
  _pintarTotales(resumen)
  _pintarCandadoCarpeta(resumen)
}

function _aviso(titulo, detalle = '') {
  return `
    <div style="padding:14px 16px; background:var(--bg-secondary); border-radius:var(--radius-md);
                border-left:3px solid var(--color-warning); font-size:0.9rem; line-height:1.6;">
      <strong>${titulo}</strong>
      ${detalle ? `<div style="color:var(--text-secondary); margin-top:4px;">${detalle}</div>` : ''}
    </div>`
}

/** Chips de grupo con el conteo real de líneas de cada uno. */
function _pintarChips() {
  const box = document.getElementById('filtros-grupo-costos')
  if (!box) return
  const vivas = _lineas.filter(l => !l.anulado)
  const cuenta = g => vivas.filter(l => l.grupo === g).length
  const chip = (g, label, n) =>
    `<button type="button" class="reporte-chip ${_filtroGrupo === g ? 'on' : ''}" data-grupo="${g}"
             onclick="window.filtrarGrupoCostos('${g}')">${label}${n !== null ? ` (${n})` : ''}</button>`

  box.innerHTML = [
    chip('todos', 'Todos', vivas.length),
    ...Object.entries(GRUPOS).map(([g, label]) => chip(g, label, cuenta(g)))
  ].join(' ')
}

function _lineasFiltradas() {
  let f = _lineas.filter(l => !l.anulado)
  if (_filtroGrupo !== 'todos') f = f.filter(l => l.grupo === _filtroGrupo)
  if (_busqueda.trim()) {
    const palabras = _busqueda.toLowerCase().split(/\s+/).filter(Boolean)
    f = f.filter(l => {
      const texto = [
        l.concepto, l.documento_numero, l.proveedor_nombre, l.contenedor_numero,
        GRUPOS[l.grupo], CLASIFICACIONES[l.clasificacion] && CLASIFICACIONES[l.clasificacion].label,
        l.observaciones, TIPOS_DOC[l.documento_tipo], fechaDMY(l.fecha_emision)
      ].filter(Boolean).join(' ').toLowerCase()
      return palabras.every(p => texto.includes(p))
    })
  }
  const dir = _orden.dir === 'asc' ? 1 : -1
  return f.slice().sort((a, b) => {
    const va = a[_orden.campo], vb = b[_orden.campo]
    if (typeof va === 'number' || typeof vb === 'number') return ((va || 0) - (vb || 0)) * dir
    return String(va || '').localeCompare(String(vb || '')) * dir
  })
}

function _pintarTabla() {
  const cont = document.getElementById('tabla-costos-importacion')
  if (!cont) return
  const filas = _lineasFiltradas()
  const cerrada = ['cerrada', 'anulada'].includes(_resumen && _resumen.estado)

  if (!filas.length) {
    cont.innerHTML = _aviso(
      _lineas.length ? 'Ningún costo coincide con el filtro.' : 'Esta carpeta todavía no tiene costos registrados.',
      _lineas.length ? '' : 'Usa “+ Nuevo costo” para cargar la primera factura, liquidación o comisión.'
    )
    return
  }

  const th = (key, label, extra = '') =>
    `<th style="cursor:pointer; ${extra}" onclick="window.ordenarCostosImportacion('${key}')">${label} ${_orden.campo === key ? (_orden.dir === 'asc' ? '▲' : '▼') : '⇅'}</th>`

  cont.innerHTML = `
    <table class="table" id="tbl-imp-costos">
      <thead>
        <tr>
          ${th('fecha_emision', 'Fecha')}
          ${th('grupo', 'Grupo')}
          ${th('concepto', 'Concepto')}
          ${th('documento_numero', 'Documento')}
          <th>Tipo doc</th>
          ${th('proveedor_nombre', 'Proveedor')}
          <th>Mon.</th>
          ${th('monto_moneda', 'Importe', 'text-align:right')}
          <th style="text-align:right" title="IGV en la moneda original de la factura">IGV (mon. orig.)</th>
          ${th('monto_usd', 'USD', 'text-align:right')}
          ${th('monto_pen', 'PEN', 'text-align:right')}
          <th>Clasificacion</th>
          <th>Base prorrateo</th>
          <th>NIC 2</th>
          <th>Gestion</th>
          <th>Contenedor</th>
          <th>Pago</th>
          <th>Doc.</th>
          <th>Acciones</th>
        </tr>
      </thead>
      <tbody>
        ${filas.map(l => _filaHtml(l, cerrada)).join('')}
      </tbody>
    </table>`

  columnasAuto(document.getElementById('tbl-imp-costos'), 'impCostos', {
    ocultas: ['PEN', 'Base prorrateo', 'Contenedor', 'Tipo doc'],
    card: cont.closest('.card')
  })
}

function _filaHtml(l, cerrada) {
  const cls = CLASIFICACIONES[l.clasificacion] || { label: l.clasificacion, color: 'secondary' }
  const check = v => v ? '<span style="color:var(--color-success); font-weight:600;">✓</span>'
                       : '<span style="color:var(--text-secondary);">–</span>'
  const badgePago = {
    pagado: '<span class="badge badge-success">Cancelado</span>',
    parcial: '<span class="badge badge-warning">Parcial</span>',
    pendiente: '<span class="badge badge-danger">Pendiente</span>',
    no_aplica: '<span class="badge">N/A</span>'
  }[l.estado_pago] || '—'

  const nAdj = _conteoAdj[l.documento_id] || 0
  const acciones = menuAccionesFila([
    { icono: '👁', label: 'Ver detalle', onclick: `window.verLineaCosto(${l.id})` },
    !cerrada && { icono: '✏️', label: 'Editar', onclick: `window.editarLineaCosto(${l.id})` },
    !l.cxp_id && l.documento_id && !cerrada && { icono: '💳', label: 'Enviar a Cuentas por Pagar', onclick: `window.enviarCostoACxP(${l.documento_id})` },
    l.documento_id && { icono: '📎', label: 'Ver adjuntos', onclick: `window.adjuntosDocumentoImportacion(${l.documento_id})` },
    { separador: true },
    !cerrada && { icono: '✕', label: 'Eliminar', peligro: true, onclick: `window.eliminarLineaCosto(${l.id})` }
  ])

  const avisos = []
  if (l.es_provisional && !l.castigada) avisos.push('<span class="badge badge-warning" title="Proforma del agente: falta la factura real">Provisional</span>')
  if (l.sustentado === false) avisos.push('<span class="badge badge-danger" title="Sin comprobante válido: no entra al costo contable">Sin sustento</span>')

  return `
    <tr>
      <td>${fechaDMY(l.fecha_emision)}</td>
      <td>${GRUPOS[l.grupo] || l.grupo}</td>
      <td>${l.concepto} ${avisos.join(' ')}</td>
      <td>${l.documento_numero || '—'}</td>
      <td>${TIPOS_DOC[l.documento_tipo] || '—'}</td>
      <td>${l.proveedor_nombre || '—'}</td>
      <td><span class="badge">${l.moneda}</span></td>
      <td style="text-align:right">${n2(l.monto_moneda)}</td>
      <td style="text-align:right">${num(l.igv_monto) ? n2(l.igv_monto) : '—'}</td>
      <td style="text-align:right">${n2(l.monto_usd)}</td>
      <td style="text-align:right">${n2(l.monto_pen)}</td>
      <td><span class="badge badge-${cls.color}">${cls.label}</span></td>
      <td>${BASES[l.base_prorrateo] || l.base_prorrateo}</td>
      <td style="text-align:center">${check(l.entra_costo_contable)}</td>
      <td style="text-align:center">${check(l.entra_costo_gestion)}</td>
      <td>${l.contenedor_numero || '—'}</td>
      <td>${badgePago}</td>
      <td style="text-align:center">${nAdj ? `<a href="#" onclick="window.adjuntosDocumentoImportacion(${l.documento_id}); return false;">📎${nAdj}</a>` : '—'}</td>
      <td>${acciones}</td>
    </tr>`
}

/** Pie de cuadre: costo contable vs costo de gestión, créditos y desembolso. */
function _pintarTotales(r) {
  const box = document.getElementById('resumen-costos-importacion')
  if (!box) return
  if (!r) { box.innerHTML = ''; return }

  const kg = num(r.peso_neto)
  const tile = (label, valor, sub = '', color = '') => `
    <div style="padding:10px 12px; background:var(--bg-secondary); border-radius:var(--radius-md);">
      <div style="font-size:0.7rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">${label}</div>
      <div style="font-weight:700; font-size:1.05rem; ${color ? `color:var(--color-${color});` : ''}">${valor}</div>
      ${sub ? `<div style="font-size:0.78rem; color:var(--text-secondary);">${sub}</div>` : ''}
    </div>`

  const desc = num(r.desembolso_usd)
  const suma = num(r.costo_contable_usd) + num(r.solo_gestion_usd) + num(r.credito_fiscal_usd) +
               num(r.percepcion_usd) + num(r.financiero_usd)
  const cuadra = Math.abs(desc - suma) < 0.01

  box.innerHTML = `
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(170px,1fr)); gap:10px; margin-bottom:10px;">
      ${tile('FOB', '$ ' + n2(r.fob_usd), kg ? `${n2(kg)} kg netos` : 'sin peso en el detalle de la CI')}
      ${tile('CIF', '$ ' + n2(r.cif_usd))}
      ${tile('Costo contable (NIC 2)', '$ ' + n2(r.costo_contable_usd),
             kg ? `${n4(r.costo_contable_kg)} USD/kg · F.D. ${n4(r.factor_contable_calc)}` : '', 'success')}
      ${tile('Costo de gestion', '$ ' + n2(r.costo_gestion_usd),
             kg ? `${n4(r.costo_gestion_kg)} USD/kg · F.D. ${n4(r.factor_gestion_calc)}` : '', 'info')}
      ${tile('Credito fiscal + percepcion', '$ ' + n2(num(r.credito_fiscal_usd) + num(r.percepcion_usd)), 'No es costo', 'warning')}
      ${tile('Gastos financieros', '$ ' + n2(r.financiero_usd), 'NIC 23')}
      ${tile('Desembolso total', '$ ' + n2(r.desembolso_usd),
             cuadra ? 'cuadra ✔' : `descuadre $ ${n2(desc - suma)}`, cuadra ? 'success' : 'danger')}
    </div>
    ${num(r.lineas_provisionales) ? _aviso(
      `${r.lineas_provisionales} linea(s) todavia son provisionales`,
      'La carpeta no deberia cerrarse hasta que cada proforma tenga su factura real o quede castigada.') : ''}
    ${num(r.lineas_sin_sustento) ? _aviso(
      `${r.lineas_sin_sustento} linea(s) sin comprobante`,
      'Entran al costo de gestion pero no al costo contable NIC 2.') : ''}`
}

function _pintarCandadoCarpeta(r) {
  const av = document.getElementById('aviso-carpeta-cerrada')
  const btn = document.getElementById('btnNuevoCostoImportacion')
  const cerrada = ['cerrada', 'anulada'].includes(r && r.estado)
  if (av) {
    av.style.display = cerrada ? 'block' : 'none'
    if (cerrada) av.innerHTML = _aviso(
      `Carpeta ${r.numero_carpeta} ${r.estado === 'anulada' ? 'anulada' : 'cerrada'} — costos en solo lectura.`,
      'Para corregir un importe hay que reabrirla con motivo; si el lote ya tuvo ventas, el recosteo genera asiento de ajuste.')
  }
  if (btn) btn.style.display = cerrada ? 'none' : ''
}

// ─────────────────────────────────────────────────────────────────────────────
// FILTROS / ORDEN / BUSCADOR
// ─────────────────────────────────────────────────────────────────────────────
window.filtrarGrupoCostos = function (grupo) {
  _filtroGrupo = grupo
  localStorage.setItem(LS_FILTRO, grupo)
  document.querySelectorAll('#filtros-grupo-costos .reporte-chip').forEach(b =>
    b.classList.toggle('on', b.dataset.grupo === grupo))
  _pintarTabla()
}

window.buscarCostosImportacion = function (valor) {
  _busqueda = valor || ''
  const limpiar = document.getElementById('bsqLimpiarCostos')
  if (limpiar) limpiar.style.display = _busqueda ? '' : 'none'
  _pintarTabla()
}

window.limpiarBusquedaCostos = function () {
  const input = document.getElementById('bsqCostosImportacion')
  if (input) input.value = ''
  window.buscarCostosImportacion('')
}

window.ordenarCostosImportacion = function (campo) {
  if (_orden.campo === campo) _orden.dir = _orden.dir === 'asc' ? 'desc' : 'asc'
  else _orden = { campo, dir: 'asc' }
  _pintarTabla()
}

// ─────────────────────────────────────────────────────────────────────────────
// MODAL DE LÍNEA DE COSTO
// Patrón "Nueva Venta": secciones con subtítulo en MAYÚSCULAS, grids, footer.
// ─────────────────────────────────────────────────────────────────────────────
function _asegurarModalLinea() {
  if (document.getElementById('modal-linea-costo')) return

  const opts = (obj, sel = '') => Object.entries(obj)
    .map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('')

  const html = `
  <div id="modal-linea-costo" class="modal">
    <div class="modal-content" style="width:min(96vw, 1100px); max-width:min(96vw, 1100px); max-height:calc(100vh - 48px); overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title" id="tituloModalLineaCosto">Nuevo costo de importacion</h3>
        <button class="modal-close" onclick="window.cerrarModalLineaCosto()">&times;</button>
      </div>

      <div style="padding:16px 20px 0;">
        <div id="lcInfoCarpeta"></div>

        <strong style="display:block; margin:14px 0 8px; color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase; letter-spacing:0.03em;">Documento que sustenta el gasto</strong>
        <div style="display:grid; grid-template-columns:1.8fr 1fr 0.7fr 0.9fr; gap:10px;">
          <div class="form-group">
            <label>Proveedor *</label>
            <select id="lcProveedor"><option value="">-- Selecciona --</option></select>
            <small id="lcProveedorDocInfo" style="display:none; color:var(--text-secondary); font-size:0.72rem;"></small>
          </div>
          <div class="form-group">
            <label>Tipo de documento *</label>
            <select id="lcTipoDoc" onchange="window.lcOnTipoDoc()">${opts(TIPOS_DOC, 'factura')}</select>
          </div>
          <div class="form-group">
            <label>Serie</label>
            <input type="text" id="lcSerie" placeholder="F001">
          </div>
          <div class="form-group">
            <label>Numero</label>
            <input type="text" id="lcNumero" placeholder="1645">
          </div>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr 0.8fr 1.1fr 1fr; gap:10px;">
          <div class="form-group">
            <label>Fecha de emision *</label>
            <input type="date" id="lcFecha" onchange="window.lcTCDelDia()">
          </div>
          <div class="form-group">
            <label>Vencimiento</label>
            <input type="date" id="lcVencimiento">
          </div>
          <div class="form-group">
            <label>Moneda *</label>
            <select id="lcMoneda" onchange="window.lcRecalcular()">
              <option value="USD">USD</option>
              <option value="PEN">PEN</option>
            </select>
          </div>
          <div class="form-group">
            <label>T.C. (S/ por USD) *</label>
            <div style="display:flex; gap:6px;">
              <input type="number" id="lcTC" step="0.001" value="3.750" style="flex:1;" onchange="window.lcRecalcular()">
              <button type="button" class="btn btn-secondary btn-small" style="margin-bottom:0; white-space:nowrap;"
                      onclick="window.lcTCDelDia(true)" title="Traer el T.C. compra del dia">⟳</button>
            </div>
          </div>
          <div class="form-group">
            <label>Estado de pago</label>
            <select id="lcEstadoPago">
              <option value="pendiente">Pendiente</option>
              <option value="parcial">Parcial</option>
              <option value="pagado">Pagado</option>
              <option value="no_aplica">No aplica</option>
            </select>
          </div>
        </div>
        <small id="lcTCAviso" style="display:block; margin:-4px 0 6px; color:var(--text-secondary); font-size:.76rem;"></small>

        <hr style="border:none; border-top:1px solid var(--border-color); margin:14px 0;">
        <strong style="display:block; margin-bottom:4px; color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase; letter-spacing:0.03em;">Clasificacion del costo</strong>
        <small style="display:block; margin-bottom:10px; color:var(--text-secondary); line-height:1.4;">
          Elige el concepto y el resto se llena solo: el concepto decide si la plata es costo NIC 2, credito fiscal o gasto financiero, y con que base se prorratea.
        </small>
        <div style="display:grid; grid-template-columns:1.5fr 1.1fr 1fr 1.2fr; gap:10px;">
          <div class="form-group">
            <label>Concepto *</label>
            <select id="lcConcepto" onchange="window.lcOnConcepto()">
              <option value="">-- Selecciona --</option>
              ${Object.keys(GRUPOS).map(g => `
                <optgroup label="${GRUPOS[g]}">
                  ${CONCEPTOS_COSTO.filter(c => c.grupo === g).map(c => `<option value="${c.codigo}">${c.label}</option>`).join('')}
                </optgroup>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Clasificacion contable *</label>
            <select id="lcClasificacion" onchange="window.lcOnClasificacion()">
              ${Object.entries(CLASIFICACIONES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Base de prorrateo *</label>
            <select id="lcBase" onchange="window.lcOnBase()">${opts(BASES, 'valor_fob')}</select>
          </div>
          <div class="form-group">
            <label>Contenedor</label>
            <select id="lcContenedor"><option value="">Toda la carpeta</option></select>
          </div>
        </div>

        <div style="display:grid; grid-template-columns:2fr 1fr; gap:10px;">
          <div class="form-group" id="lcGrupoDetalleCI" style="display:none;">
            <label>Linea de la Commercial Invoice *</label>
            <select id="lcDetalleCI"><option value="">-- Selecciona --</option></select>
          </div>
          <div class="form-group">
            <label>Descripcion del concepto</label>
            <input type="text" id="lcDescripcion" placeholder="Se llena con el concepto; puedes precisarlo" oninput="this.dataset.tocado='1'">
          </div>
        </div>

        <div style="display:flex; gap:18px; flex-wrap:wrap; margin:4px 0 10px;">
          <label style="display:flex; align-items:center; gap:6px;">
            <input type="checkbox" id="lcEntraContable" style="width:auto; margin:0;"> Entra al costo contable (NIC 2)
          </label>
          <label style="display:flex; align-items:center; gap:6px;">
            <input type="checkbox" id="lcEntraGestion" style="width:auto; margin:0;"> Entra al costo de gestion
          </label>
          <label style="display:flex; align-items:center; gap:6px;">
            <input type="checkbox" id="lcProvisional" style="width:auto; margin:0;"> Es provisional (proforma del agente)
          </label>
          <label style="display:flex; align-items:center; gap:6px;">
            <input type="checkbox" id="lcSustentado" style="width:auto; margin:0;" checked> Tiene comprobante valido
          </label>
        </div>

        <hr style="border:none; border-top:1px solid var(--border-color); margin:14px 0;">
        <strong style="display:block; margin-bottom:8px; color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase; letter-spacing:0.03em;">Importes</strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group">
            <label>Importe sin IGV *</label>
            <input type="number" id="lcMonto" step="0.0001" placeholder="0.0000" oninput="window.lcRecalcular()">
          </div>
          <div class="form-group">
            <label>IGV del documento</label>
            <input type="number" id="lcIGV" step="0.01" placeholder="0.00" oninput="window.lcRecalcular()">
          </div>
          <div class="form-group">
            <label>Total del documento</label>
            <input type="number" id="lcTotal" step="0.01" readonly disabled>
          </div>
          <div class="form-group">
            <label>Equivalente</label>
            <input type="text" id="lcEquivalente" readonly disabled>
          </div>
        </div>

        <div id="lcGrupoRH" style="display:none; grid-template-columns:repeat(3, 1fr); gap:10px;">
          <div class="form-group">
            <label>Retencion 4ta (8%)</label>
            <input type="number" id="lcRetencion" step="0.01" placeholder="0.00" oninput="window.lcRecalcular()">
          </div>
          <div class="form-group">
            <label>Neto pagado</label>
            <input type="number" id="lcNetoPagado" step="0.01" readonly disabled>
          </div>
          <div class="form-group" style="align-self:end;">
            <small style="color:var(--text-secondary); line-height:1.4;">El COSTO es el bruto. La retencion es pasivo (4017), no menos costo.</small>
          </div>
        </div>

        <hr style="border:none; border-top:1px solid var(--border-color); margin:14px 0;">
        <strong style="display:block; margin-bottom:4px; color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase; letter-spacing:0.03em;">Documento escaneado</strong>
        <small style="display:block; margin-bottom:8px; color:var(--text-secondary); line-height:1.4;">
          PDF o foto, max. 10 MB por archivo. Se guardan en el bucket privado y se abren con enlace firmado.
        </small>
        <input type="file" id="lcArchivos" multiple onchange="window.lcArchivosElegidos(this)">
        <div id="lcListaArchivos" style="margin-top:6px; font-size:0.85rem; color:var(--text-secondary);"></div>

        <div class="form-group" style="margin-top:12px;">
          <label>Observaciones</label>
          <input type="text" id="lcObservaciones" placeholder="Opcional">
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="window.cerrarModalLineaCosto()">Cancelar</button>
        <button class="btn btn-primary" id="lcBtnGuardar" onclick="window.guardarLineaCosto()">💾 Guardar costo</button>
      </div>
    </div>
  </div>`

  document.body.insertAdjacentHTML('beforeend', html)
}

window.lcOnTipoDoc = function () {
  const tipo = document.getElementById('lcTipoDoc') && document.getElementById('lcTipoDoc').value
  const grupoRH = document.getElementById('lcGrupoRH')
  if (grupoRH) grupoRH.style.display = tipo === 'rh' ? 'grid' : 'none'
  const prov = document.getElementById('lcProvisional')
  if (prov && tipo === 'proforma') prov.checked = true
  const sust = document.getElementById('lcSustentado')
  if (sust && tipo === 'sin_comprobante') sust.checked = false
  window.lcRecalcular()
}

window.lcOnConcepto = function () {
  const sel = document.getElementById('lcConcepto')
  const c = conceptoPorCodigo(sel && sel.value)
  if (!c) return
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v }
  set('lcClasificacion', c.clasificacion)
  set('lcBase', c.base)
  const desc = document.getElementById('lcDescripcion')
  if (desc && !desc.dataset.tocado) desc.value = c.label
  window.lcOnClasificacion()
  window.lcOnBase()
}

window.lcOnClasificacion = function () {
  const sel = document.getElementById('lcClasificacion')
  const cl = sel && sel.value
  const cont = document.getElementById('lcEntraContable')
  const gest = document.getElementById('lcEntraGestion')
  if (cont) {
    cont.checked = cl === 'inventario'
    // La BD lo rechaza igual (trigger fn_importacion_costos_normalizar):
    // lo que no es inventario no puede ser costo NIC 2.
    cont.disabled = cl !== 'inventario'
  }
  if (gest) gest.checked = ['inventario', 'solo_gestion', 'gasto_financiero', 'credito_fiscal', 'percepcion'].includes(cl)
}

window.lcOnBase = function () {
  const sel = document.getElementById('lcBase')
  const grupo = document.getElementById('lcGrupoDetalleCI')
  if (grupo) grupo.style.display = (sel && sel.value) === 'directo' ? '' : 'none'
}

window.lcRecalcular = function () {
  const g = id => document.getElementById(id)
  const monto = num(g('lcMonto') && g('lcMonto').value)
  const igv = num(g('lcIGV') && g('lcIGV').value)
  const tc = num(g('lcTC') && g('lcTC').value) || 1
  const moneda = (g('lcMoneda') && g('lcMoneda').value) || 'USD'
  const total = monto + igv

  if (g('lcTotal')) g('lcTotal').value = total.toFixed(2)
  if (g('lcEquivalente')) {
    g('lcEquivalente').value = moneda === 'PEN'
      ? `$ ${n2(monto / tc)} USD`
      : `S/ ${n2(monto * tc)} PEN`
  }
  const ret = num(g('lcRetencion') && g('lcRetencion').value)
  if (g('lcNetoPagado')) g('lcNetoPagado').value = (total - ret).toFixed(2)
}

window.lcTCDelDia = async function (forzar = false) {
  const campo = document.getElementById('lcTC')
  const aviso = document.getElementById('lcTCAviso')
  if (!campo) return
  if (!forzar && campo.dataset.auto !== '1') return

  const fechaEl = document.getElementById('lcFecha')
  const fecha = (fechaEl && fechaEl.value) || null
  if (aviso) aviso.textContent = 'Buscando T.C....'
  try {
    const r = await getTipoCambioDia(fecha, { permitirApi: forzar })
    const tc = (r && (r.compra || r.tc)) || null
    if (!tc) { if (aviso) aviso.textContent = 'Sin T.C. para esa fecha — ingresalo a mano'; return }
    campo.value = parseFloat(tc).toFixed(3)
    campo.dataset.auto = '1'
    if (aviso) aviso.textContent = `T.C. compra ${(r && r.fecha) || fecha || ''}: S/ ${parseFloat(tc).toFixed(3)}`
    window.lcRecalcular()
  } catch (e) {
    if (aviso) aviso.textContent = 'No se pudo consultar el T.C. — ingresalo a mano'
  }
}

window.lcArchivosElegidos = function (input) {
  _archivosPendientes = []
  const lista = document.getElementById('lcListaArchivos')
  const errores = []
  for (const f of input.files || []) {
    const err = validarArchivoAdjunto(f)
    if (err) { errores.push(err); continue }
    _archivosPendientes.push({ file: f, concepto: 'factura_gasto' })
  }
  if (lista) {
    lista.innerHTML = [
      ..._archivosPendientes.map(a => `📎 ${a.file.name} (${(a.file.size / 1024).toFixed(0)} KB)`),
      ...errores.map(e => `<span style="color:var(--color-danger);">⚠️ ${e}</span>`)
    ].join('<br>')
  }
}

// Proveedor: mismo buscador estándar de Compras (nombre o RUC) + alta de contacto con búsqueda por RUC
let _pendienteProv = false
function _syncProveedor() {
  const sel = document.getElementById('lcProveedor'); if (!sel) return
  refrescarBuscador(sel)
  const id = parseInt(sel.value || 0)
  pintarDocumentoContacto('lcProveedorDocInfo', id ? (_proveedores.find(p => p.id === id) || null) : null)
}
window.addEventListener('contacto-guardado', async e => {
  if (!_pendienteProv) return
  _pendienteProv = false
  const c = e.detail?.contacto
  _proveedores = []
  await _llenarSelectoresModal()
  if (c?.id && !c._eliminado) { const sel = document.getElementById('lcProveedor'); if (sel) { sel.value = String(c.id); _syncProveedor() } showToast(`${c.nombre || 'Proveedor'} seleccionado`, 'success') }
})

async function _llenarSelectoresModal() {
  if (!_proveedores.length) _proveedores = (await getSuppliers()) || []
  const prov = document.getElementById('lcProveedor')
  if (prov) {
    const previo = prov.value
    prov.innerHTML = '<option value="">-- Selecciona --</option>' +
      _proveedores.map(p => `<option value="${p.id}">${p.nombre}${p.nro_documento ? ` (${p.nro_documento})` : ''}</option>`).join('')
    prov.value = previo
    if (!prov.dataset.bus) {
      prov.dataset.bus = '1'
      convertirEnBuscador(prov, { placeholder: 'Escribe el nombre o RUC del proveedor...', sinResultados: 'Ningún proveedor coincide',
        alCrearNuevo: { label: 'Registrar proveedor nuevo (con búsqueda por RUC)', onClick: () => { _pendienteProv = true; abrirModalContacto({ roles: ['proveedor'] }) } } })
      prov.addEventListener('change', _syncProveedor)
    }
    _syncProveedor()
  }
  const cont = document.getElementById('lcContenedor')
  if (cont) {
    cont.innerHTML = '<option value="">Toda la carpeta</option>' +
      _contenedores.map(c => `<option value="${c.id}">${c.numero}</option>`).join('')
  }
  const det = document.getElementById('lcDetalleCI')
  if (det) {
    det.innerHTML = '<option value="">-- Selecciona --</option>' +
      _detallesCI.map(d => `<option value="${d.id}">${d.lote || 'linea ' + d.id} · ${n2(d.cantidad_neto)} kg</option>`).join('')
  }
  const info = document.getElementById('lcInfoCarpeta')
  if (info && _resumen) {
    info.innerHTML = `
      <div style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info); font-size:0.88rem; line-height:1.6;">
        <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">Carpeta de importacion</div>
        <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${_resumen.numero_carpeta}${_resumen.numero_dam ? ` · DAM ${_resumen.numero_dam}` : ''}</div>
        <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">
          FOB $ ${n2(_resumen.fob_usd)} · ${n2(_resumen.peso_neto)} kg netos · costo NIC 2 actual ${n4(_resumen.costo_contable_kg)} USD/kg
        </div>
      </div>`
  }
}

window.abrirModalLineaCosto = async function () {
  if (!carpetaActual()) { showToast('Esta importacion no tiene carpeta de costeo', 'warning'); return }
  if (['cerrada', 'anulada'].includes(_resumen && _resumen.estado)) {
    showToast(`La carpeta esta ${_resumen.estado}: reabrela para registrar costos`, 'warning'); return
  }
  _asegurarModalLinea()
  _editandoId = null
  _archivosPendientes = []
  await _llenarSelectoresModal()

  document.getElementById('tituloModalLineaCosto').textContent = 'Nuevo costo de importacion'
  const hoy = new Date().toISOString().slice(0, 10)
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v }
  set('lcFecha', hoy); set('lcVencimiento', ''); set('lcSerie', ''); set('lcNumero', '')
  set('lcConcepto', ''); set('lcDescripcion', ''); set('lcMonto', ''); set('lcIGV', '')
  set('lcRetencion', ''); set('lcObservaciones', ''); set('lcProveedor', ''); _syncProveedor()
  set('lcTipoDoc', 'factura'); set('lcMoneda', 'USD'); set('lcEstadoPago', 'pendiente')
  const desc = document.getElementById('lcDescripcion'); if (desc) delete desc.dataset.tocado
  const prov = document.getElementById('lcProvisional'); if (prov) prov.checked = false
  const sus = document.getElementById('lcSustentado'); if (sus) sus.checked = true
  const arch = document.getElementById('lcArchivos'); if (arch) arch.value = ''
  const lista = document.getElementById('lcListaArchivos'); if (lista) lista.innerHTML = ''
  const tc = document.getElementById('lcTC'); if (tc) tc.dataset.auto = '1'

  await window.lcTCDelDia()
  window.lcOnTipoDoc()
  window.lcOnBase()
  window.lcOnClasificacion()
  window.openModal('modal-linea-costo')
}

window.cerrarModalLineaCosto = function () {
  window.closeModal('modal-linea-costo')
  _editandoId = null
  _archivosPendientes = []
}

window.editarLineaCosto = async function (id) {
  const l = _lineas.find(x => x.id === id)
  if (!l) return
  _asegurarModalLinea()
  await _llenarSelectoresModal()
  _editandoId = id
  _archivosPendientes = []

  const set = (campo, v) => { const e = document.getElementById(campo); if (e) e.value = (v === null || v === undefined) ? '' : v }
  document.getElementById('tituloModalLineaCosto').textContent = `Editar costo · ${l.concepto}`
  set('lcProveedor', l.proveedor_id); _syncProveedor(); set('lcTipoDoc', l.documento_tipo || 'factura')
  const partes = (l.documento_numero || '').split('-')
  set('lcSerie', partes.length > 1 ? partes[0] : '')
  set('lcNumero', partes.length > 1 ? partes.slice(1).join('-') : partes[0])
  set('lcFecha', l.fecha_emision); set('lcMoneda', l.moneda); set('lcTC', num(l.tipo_cambio).toFixed(3))
  set('lcEstadoPago', l.estado_pago || 'pendiente')
  set('lcConcepto', l.concepto_codigo || ''); set('lcClasificacion', l.clasificacion)
  set('lcBase', l.base_prorrateo); set('lcContenedor', l.contenedor_id || '')
  set('lcDetalleCI', l.detalle_ci_id || ''); set('lcDescripcion', l.concepto)
  set('lcMonto', num(l.monto_moneda)); set('lcIGV', num(l.igv_monto))
  set('lcObservaciones', l.observaciones)
  const desc = document.getElementById('lcDescripcion'); if (desc) desc.dataset.tocado = '1'
  const tc = document.getElementById('lcTC'); if (tc) tc.dataset.auto = '0'
  document.getElementById('lcProvisional').checked = !!l.es_provisional
  document.getElementById('lcSustentado').checked = l.sustentado !== false
  const arch = document.getElementById('lcArchivos'); if (arch) arch.value = ''
  const lista = document.getElementById('lcListaArchivos'); if (lista) lista.innerHTML = ''

  window.lcOnTipoDoc(); window.lcOnBase()
  // Los flags reales de la fila ganan sobre el default del concepto.
  document.getElementById('lcEntraContable').checked = !!l.entra_costo_contable
  document.getElementById('lcEntraContable').disabled = l.clasificacion !== 'inventario'
  document.getElementById('lcEntraGestion').checked = !!l.entra_costo_gestion
  window.lcRecalcular()
  window.openModal('modal-linea-costo')
}

window.guardarLineaCosto = async function () {
  const btn = document.getElementById('lcBtnGuardar')
  try {
    const carpeta = carpetaActual()
    if (!carpeta) throw new Error('Sin carpeta de importacion')

    const v = id => { const e = document.getElementById(id); return e && e.value ? String(e.value).trim() : '' }
    const chk = id => { const e = document.getElementById(id); return !!(e && e.checked) }
    const proveedorId = v('lcProveedor') ? parseInt(v('lcProveedor')) : null
    const tipoDoc = v('lcTipoDoc')
    const concepto = v('lcConcepto')
    const monto = num(v('lcMonto'))
    const base = v('lcBase')

    if (!concepto) throw new Error('Elige el concepto del gasto')
    if (!v('lcFecha')) throw new Error('Falta la fecha de emision')
    if (!monto) throw new Error('El importe no puede ser 0')
    if (!proveedorId && tipoDoc !== 'sin_comprobante') throw new Error('Elige el proveedor (o usa el tipo "Sin comprobante")')
    if (base === 'directo' && !v('lcDetalleCI')) throw new Error('Una linea "directa" necesita decir a que linea de la CI se carga')
    if (num(v('lcTC')) <= 0) throw new Error('El tipo de cambio debe ser mayor a 0')

    btn.disabled = true; btn.textContent = 'Guardando...'
    const user = await getCurrentUser()
    const igv = num(v('lcIGV'))
    const retencion = tipoDoc === 'rh' ? num(v('lcRetencion')) : 0

    const doc = {
      tipo: tipoDoc,
      tipo_comprobante: TIPO_COMPROBANTE_SUNAT[tipoDoc] || null,
      serie: v('lcSerie') || null,
      numero: v('lcNumero') || null,
      proveedor_id: proveedorId,
      fecha_emision: v('lcFecha'),
      fecha_vencimiento: v('lcVencimiento') || null,
      moneda: v('lcMoneda'),
      tipo_cambio: num(v('lcTC')),
      monto_sin_igv: monto,
      igv_monto: igv,
      monto_total: monto + igv,
      retencion_4ta: retencion,
      neto_pagado: tipoDoc === 'rh' ? (monto + igv - retencion) : null,
      estado_pago: v('lcEstadoPago'),
      es_provisional: chk('lcProvisional'),
      sustentado: chk('lcSustentado'),
      // La empresa la manda la CARPETA (v_importacion_resumen.empresa_id),
      // no el chip de trabajo: evita documentos mestizos entre empresas.
      empresa_id: _resumen?.empresa_id ?? undefined
    }

    const cat = conceptoPorCodigo(concepto)
    const linea = {
      carpeta_importacion_id: carpeta,
      grupo: (cat && cat.grupo) || 'nacionalizacion',
      concepto: v('lcDescripcion') || (cat && cat.label) || concepto,
      concepto_codigo: concepto,
      clasificacion: v('lcClasificacion'),
      entra_costo_contable: chk('lcEntraContable'),
      entra_costo_gestion: chk('lcEntraGestion'),
      moneda: v('lcMoneda'),
      tipo_cambio: num(v('lcTC')),
      monto_moneda: monto,
      igv_monto: igv,
      base_prorrateo: base,
      detalle_ci_id: base === 'directo' ? parseInt(v('lcDetalleCI')) : null,
      contenedor_id: v('lcContenedor') ? parseInt(v('lcContenedor')) : null,
      es_provisional: chk('lcProvisional'),
      observaciones: v('lcObservaciones') || null
    }

    let documentoId
    if (_editandoId) {
      const previa = _lineas.find(x => x.id === _editandoId)
      documentoId = (previa && previa.documento_id) || null
      if (documentoId) {
        const okDoc = await update('documentos_importacion', documentoId, doc)
        if (!okDoc) throw new Error('No se pudo actualizar el documento')
      }
      const okLinea = await update('importacion_costos', _editandoId, linea)
      if (!okLinea) throw new Error('No se pudo actualizar la linea de costo (revisa si la carpeta esta cerrada)')
    } else {
      const r = await crearLineaCosto(doc, linea, user && user.db_id)
      documentoId = r.documentoId
    }

    if (_archivosPendientes.length && documentoId) {
      const res = await subirAdjuntos('documento_importacion', documentoId, _archivosPendientes, user && user.db_id)
      if (res && res.errores && res.errores.length) {
        showToast(`Costo guardado, ${res.ok} adjunto(s) subidos. ${res.errores[0]}`, 'warning')
      }
    }

    showToast(_editandoId ? 'Costo actualizado' : 'Costo registrado', 'success')
    window.cerrarModalLineaCosto()
    await renderCostosLedger()
    try { await window._alGuardarCosto?.() } catch (e2) { console.warn('alGuardarCosto', e2) }
  } catch (e) {
    console.error('guardarLineaCosto:', e)
    showToast(e.message || 'No se pudo guardar el costo', 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Guardar costo' }
  }
}

window.eliminarLineaCosto = async function (id) {
  const l = _lineas.find(x => x.id === id)
  if (!l) return
  if (!confirm(`¿Eliminar el costo "${l.concepto}" por ${l.moneda} ${n2(l.monto_moneda)}?\n\nEl documento y sus adjuntos se conservan si otra carpeta los usa.`)) return
  try {
    const ok = await deleteRecord('importacion_costos', id)
    if (!ok) throw new Error('No se pudo eliminar (¿la carpeta esta cerrada?)')

    // Documento huerfano (ninguna otra linea lo usa) -> se borra con sus adjuntos
    if (l.documento_id) {
      const restantes = await query('importacion_costos', { documento_id: l.documento_id })
      if (!restantes || !restantes.length) {
        await eliminarAdjuntosDe('documento_importacion', l.documento_id).catch(() => {})
        await deleteRecord('documentos_importacion', l.documento_id)
      }
    }
    showToast('Costo eliminado', 'success')
    await renderCostosLedger()
  } catch (e) {
    showToast(e.message || 'No se pudo eliminar el costo', 'danger')
  }
}

window.verLineaCosto = function (id) {
  const l = _lineas.find(x => x.id === id)
  if (!l) return
  const cls = CLASIFICACIONES[l.clasificacion]
  const filas = [
    ['Carpeta', `${l.numero_carpeta} (${l.carpeta_estado})`],
    ['Grupo', GRUPOS[l.grupo] || l.grupo],
    ['Concepto', l.concepto],
    ['Documento', `${TIPOS_DOC[l.documento_tipo] || '—'} ${l.documento_numero || ''}`],
    ['Proveedor', l.proveedor_nombre || '—'],
    ['Fecha', fechaDMY(l.fecha_emision)],
    ['Importe', `${l.moneda} ${n2(l.monto_moneda)}${num(l.igv_monto) ? ` + IGV ${n2(l.igv_monto)}` : ''}`],
    ['T.C.', n4(l.tipo_cambio)],
    ['Equivalente', `$ ${n2(l.monto_usd)} · S/ ${n2(l.monto_pen)}`],
    ['Clasificacion', (cls && cls.label) || l.clasificacion],
    ['Costo NIC 2', l.entra_costo_contable ? 'Si' : 'No'],
    ['Costo gestion', l.entra_costo_gestion ? 'Si' : 'No'],
    ['Base de prorrateo', BASES[l.base_prorrateo] || l.base_prorrateo],
    ['Contenedor', l.contenedor_numero || 'Toda la carpeta'],
    ['Estado de pago', l.estado_pago || '—'],
    ['CxP', l.cxp_id ? `#${l.cxp_id}` : 'sin generar'],
    ['Registro de Compras', l.compra_id ? `compra #${l.compra_id}` : 'no registrada'],
    ['Provisional', l.es_provisional ? 'Si — falta la factura real' : 'No'],
    ['Sustentado', l.sustentado === false ? 'No' : 'Si'],
    ['Observaciones', l.observaciones || '—']
  ]
  alert(filas.map(([k, val]) => `${k}: ${val}`).join('\n'))
}

window.enviarCostoACxP = async function (documentoId) {
  try {
    const user = await getCurrentUser()
    const cxp = await vincularCxPDocumento(documentoId, user && user.db_id)
    showToast(`Cuenta por Pagar #${cxp.id} creada — ya se puede pagar desde Cobranzas`, 'success')
    await renderCostosLedger()
  } catch (e) {
    showToast(e.message || 'No se pudo crear la Cuenta por Pagar', 'danger')
  }
}

window.adjuntosDocumentoImportacion = async function (documentoId) {
  try {
    const adjs = await getAdjuntos('documento_importacion', documentoId)
    if (!adjs.length) { showToast('Este documento no tiene archivos adjuntos', 'info'); return }
    for (const a of adjs) {
      const url = await getUrlAdjunto(a.path)
      if (url) window.open(url, '_blank')
    }
  } catch (e) {
    showToast(e.message || 'No se pudieron abrir los adjuntos', 'danger')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTENEDORES (reemplaza la funcion crearContenedor que faltaba)
// ─────────────────────────────────────────────────────────────────────────────
window.crearContenedor = async function () {
  try {
    const carpeta = carpetaActual()
    if (!carpeta) throw new Error('Selecciona una importacion con carpeta de costeo')
    const v = id => { const e = document.getElementById(id); return e && e.value ? String(e.value).trim() : '' }
    if (!v('newContenedorNumero')) throw new Error('Falta el numero de contenedor')

    const user = await getCurrentUser()
    const fila = await insert('contenedores', {
      carpeta_importacion_id: carpeta,
      numero: v('newContenedorNumero').toUpperCase(),
      etiqueta: v('newContenedorEtiqueta') || null,
      tipo: v('newContenedorTipo') || '40HC',
      numero_precinto: v('newContenedorPrecinto') || null,
      peso_bruto: num(v('newContenedorPesoBruto')),
      bultos: parseInt(v('newContenedorBultos')) || 0,
      canal: v('newContenedorCanal') || null,
      fecha_eta: v('newContenedorETA') || null,
      fecha_llegada: v('newContenedorLlegada') || null,
      created_by: user && user.db_id
    })
    if (!fila || !fila.id) throw new Error(ultimoErrorInsert()?.message || 'No se pudo crear el contenedor (¿numero repetido?)')

    showToast('Contenedor registrado', 'success')
    window.closeModal('modal-nuevo-contenedor')
    await renderCostosLedger()
  } catch (e) {
    showToast(e.message || 'No se pudo crear el contenedor', 'danger')
  }
}

// Compatibilidad: los tabs 7 y 8 ya no existen, pero el switch de tabs puede
// seguir llamandolos desde una version cacheada del HTML.
window.renderDespacho = renderCostosLedger
window.renderFinancieros = renderCostosLedger
window.calcularFinancieros = () => {}
window.renderCostosLedger = renderCostosLedger

export default { renderCostosLedger, getLineasCosto, getResumenCarpeta, vincularCxPDocumento }
