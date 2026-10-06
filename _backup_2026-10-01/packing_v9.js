// ============================================================================
// ventas/packing.js — TAB "Packing (PK)": cotización / orden de venta (2026-09-30)
// ============================================================================
// El PK es donde inicia el flujo de almacén. Etapa 1 = PK de VENTA:
//   borrador → (PDF) enviado → Facturar (abre Nueva Venta precargada) → facturado
//   anulado: en cualquier momento antes de facturar.
// 1 PK → 1 factura (decisión de Luis). El PK NO mueve stock, CxC ni asientos:
// todo eso lo hace la factura (CxC, asiento) y su Guía de Despacho (kardex).
// Serie/correlativo: tabla series_documentos (tipo 'PK', 6 dígitos, validez 15 días).
// ============================================================================
import { S } from './state.js'
import { getCurrentUser } from '../auth-supabase.js'
import { getTerminosPago, getContactById, subirAdjuntos, validarArchivoAdjunto, getAdjuntos, getConteoAdjuntos, getUrlAdjunto, eliminarAdjuntosDe } from '../supabase-data.js'
import { supabase, insert, update, deleteRecord } from '../supabase-client.js'
import { showToast, formatNumber, pintarDocumentoContacto } from '../helpers.js'
import { convertirEnBuscador, refrescarBuscador } from '../buscador-select.js'
import { serieDefault, siguienteCorrelativo, formatearNumero, registrarUsoSerie } from '../series.js'
import { _nombreCliente, _nombreVendedor, _stockTotalPorItem } from './helpers.js'
import { menuAccionesFila } from '../main.js'
import { getTCVenta, textoAvisoTC } from '../sunat-api.js'
import { vincularTCEnVivo } from '../tc-en-vivo.js'
import { estaAnulado } from '../anulacion.js'

// Datos del emisor para el PDF (mismos del PDF de Odoo). Logo: assets/img/logo-jhiro.png
const EMPRESA = {
  nombre: 'JHIRO PERU S.A.C.', ruc: '20600842995',
  direccion: 'AV. SANTA ROSA LT. 15 MZ. S URB. SAN GABRIEL - LIMA - LIMA - SAN JUAN DE LURIGANCHO',
  email: 'gerencia@jhiroperu.com', telefono: '979050317', web: 'https://jhiroperu.com',
  logo: 'assets/img/logo-jhiro.png',          // logotipo completo (PDF)
  isotipo: 'assets/img/isotipo-jhiro.png'     // solo el símbolo (usos futuros)
}

const _esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const _hoy = () => new Date().toISOString().split('T')[0]
const _sumarDias = (f, d) => { const x = new Date(f + 'T12:00:00'); x.setDate(x.getDate() + (parseInt(d) || 0)); return x.toISOString().split('T')[0] }
const ESTADOS = { borrador: ['Borrador', 'badge-secondary'], enviado: ['Enviado', 'badge-info'], parcial: ['Parcial', 'badge-warning'], facturado: ['Facturado', 'badge-success'], anulado: ['Anulado', 'badge-danger'] }

let _pkLista = []
let _pkLineas = []
let _pkEditId = null
let _pkTerminos = []
let _pkVentasMap = new Map()

// ─── Datos ──────────────────────────────────────────────────────────────────
async function _getPackings() {
  const { data, error } = await supabase.from('packing').select('*').eq('tipo', 'venta').order('correlativo', { ascending: false })
  if (error) throw new Error(error.code === '42P01' || /does not exist|schema cache/.test(error.message)
    ? 'Falta correr assets/sql/59_series_documentos_y_packing.sql en Supabase' : error.message)
  return data || []
}
async function _getDetalle(packingId) {
  const { data } = await supabase.from('detalle_packing').select('*').eq('packing_id', packingId).order('orden')
  return data || []
}
// ─── Facturación parcial (sql/70) ───────────────────────────────────────────
// Facturado por línea del PK = Σ cantidad de las líneas de facturas VIGENTES
// que la referencian (detalle_ventas.detalle_packing_id). No se guarda: se
// calcula — anular una factura devuelve su cantidad a "pendiente" sola.
const _TOL = 0.0005
async function _facturacionPK(packingId) {
  const lineas = await _getDetalle(packingId)
  const porLinea = {}
  const ids = lineas.map(l => l.id)
  if (ids.length) {
    const { data: dvs, error } = await supabase.from('detalle_ventas').select('detalle_packing_id, cantidad, venta_id').in('detalle_packing_id', ids)
    if (error) { console.warn('Facturación parcial no disponible (¿falta sql/70?):', error.message); return { lineas, porLinea, sinSQL: true } }
    const vIds = [...new Set((dvs || []).map(d => d.venta_id))]
    let vigentes = new Set()
    if (vIds.length) {
      const { data: vs } = await supabase.from('ventas').select('id, estado, comprobante_anulado, estado_comprobante').in('id', vIds)
      vigentes = new Set((vs || []).filter(v => !estaAnulado(v)).map(v => v.id))
    }
    for (const d of (dvs || [])) {
      if (vigentes.has(d.venta_id)) porLinea[d.detalle_packing_id] = (porLinea[d.detalle_packing_id] || 0) + (parseFloat(d.cantidad) || 0)
    }
  }
  return { lineas, porLinea }
}

/** Recalcula subtotal/IGV/total de una línea PK para una cantidad nueva (mismo precio). */
function _lineaConCantidad(l, cant) {
  const old = parseFloat(l.cantidad) || 0
  const unid = old > 0 && (+l.cantidad_unidades) ? Math.round((+l.cantidad_unidades) * cant / old) : (+l.cantidad_unidades || 0)
  return { cantidad: +(+cant).toFixed(3), cantidad_unidades: unid, ..._calcLinea(+cant, +l.precio_unitario, l.tipo_base || 'gravada') }
}

async function _recalcularTotalesPK(packingId) {
  const lineas = await _getDetalle(packingId)
  const t = lineas.reduce((a, l) => ({ b: a.b + (+l.subtotal), i: a.i + (+l.igv_monto), t: a.t + (+l.total_linea) }), { b: 0, i: 0, t: 0 })
  await update('packing', packingId, { subtotal: +t.b.toFixed(2), igv: +t.i.toFixed(2), total: +t.t.toFixed(2), updated_at: new Date().toISOString() })
}

/** Estado del PK según lo facturado: todo → facturado; algo → parcial; nada → borrador. */
export async function recalcularEstadoPacking(packingId) {
  if (!packingId) return
  const { data: pk } = await supabase.from('packing').select('id, estado').eq('id', packingId).single()
  if (!pk || pk.estado === 'anulado') return
  const { lineas, porLinea } = await _facturacionPK(packingId)
  const { data: vs } = await supabase.from('ventas').select('id, estado, comprobante_anulado, estado_comprobante').eq('packing_id', packingId)
  const vig = (vs || []).filter(v => !estaAnulado(v)).sort((a, b) => a.id - b.id)
  const algo = lineas.some(l => (porLinea[l.id] || 0) > _TOL)
  const todo = lineas.length > 0 && lineas.every(l => (porLinea[l.id] || 0) >= (+l.cantidad) - _TOL)
  const estado = todo ? 'facturado' : (algo || vig.length) ? 'parcial'
    : (pk.estado === 'facturado' || pk.estado === 'parcial') ? 'borrador' : pk.estado
  await update('packing', packingId, { estado, venta_id: vig.length ? vig[vig.length - 1].id : null, updated_at: new Date().toISOString() })
  if (document.getElementById('tabla-packing-body')) await renderPacking(true)
}
window.recalcularEstadoPacking = recalcularEstadoPacking

async function _maxCorrelativoPK(serie) {
  const { data } = await supabase.from('packing').select('correlativo').eq('serie', serie).order('correlativo', { ascending: false }).limit(1)
  return data?.[0]?.correlativo || 0
}

// ─── Lista ──────────────────────────────────────────────────────────────────
export async function renderPacking(forzar = true) {
  const cont = document.getElementById('content-packing')
  if (!cont) return
  if (!document.getElementById('buscarPacking')) {
    cont.innerHTML = `
      <div class="card-header">
        <h3 class="card-title">Packing (PK) — Cotizaciones / Órdenes de venta</h3>
        <div style="display:flex; gap:8px; align-items:center;">
          <button class="btn btn-primary btn-small" onclick="window.abrirModalPacking()">+ Nuevo PK</button>
          ${menuAccionesFila([
            { icono: '🚫', label: 'Anular correlativo sin emitir (formato dañado)', onclick: 'window.abrirAnularCorrelativoPK()', peligro: true }
          ])}
        </div>
      </div>
      <div style="padding:12px 16px; border-bottom:1px solid var(--border-color); display:flex; gap:12px; flex-wrap:wrap;">
        <input type="text" id="buscarPacking" placeholder="Buscar por N° PK, cliente u O/C..." style="flex:1; min-width:240px; max-width:420px;" oninput="window.filtrarPacking()">
        <select id="filtroEstadoPacking" onchange="window.filtrarPacking()" style="max-width:190px;">
          <option value="">Estado: todos</option>
          ${Object.entries(ESTADOS).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('')}
        </select>
      </div>
      <div class="table-container"><table>
        <thead><tr><th>N° PK</th><th>Emisión</th><th>Validez</th><th>Cliente</th><th>Vendedor</th><th>O/C</th>
          <th>Moneda</th><th style="text-align:right;">Total</th><th>Estado</th><th>Factura</th><th>Acciones</th></tr></thead>
        <tbody id="tabla-packing-body"><tr><td colspan="11" style="text-align:center;">Cargando...</td></tr></tbody>
      </table></div>`
  }
  try {
    if (forzar || !_pkLista.length) {
      _pkLista = await _getPackings()
      const idsVenta = _pkLista.map(p => p.venta_id).filter(Boolean)
      _pkVentasMap = new Map()
      if (idsVenta.length) {
        const { data } = await supabase.from('ventas').select('id, serie, correlativo').in('id', idsVenta)
        for (const v of (data || [])) _pkVentasMap.set(v.id, `${v.serie}-${String(v.correlativo).padStart(8, '0')}`)
      }
      // Facturas vigentes de cada PK (puede tener varias si es parcial)
      const _factPorPK = {}
      const idsPK = _pkLista.map(p => p.id)
      if (idsPK.length) {
        const { data: vs } = await supabase.from('ventas').select('id, serie, correlativo, numero, base_imponible, packing_id, estado, comprobante_anulado, estado_comprobante').in('packing_id', idsPK)
        for (const v of (vs || []).filter(x => !estaAnulado(x))) {
          (_factPorPK[v.packing_id] = _factPorPK[v.packing_id] || []).push({ id: v.id, numero: v.numero || `${v.serie}-${String(v.correlativo).padStart(8, '0')}`, base: parseFloat(v.base_imponible) || 0 })
        }
      }
      let conteoAdj = {}
      try { conteoAdj = await getConteoAdjuntos('packing') || {} } catch { /* tabla adjuntos aún no creada */ }
      for (const p of _pkLista) {
        p._adjuntos = conteoAdj[p.id] || 0
        p._facturas = _factPorPK[p.id] || []
        p._avance = (+p.subtotal) > 0 ? Math.min(100, p._facturas.reduce((s, f) => s + f.base, 0) / (+p.subtotal) * 100) : 0
        p._cliente = await _nombreCliente(p.contact_id)
        p._sinEmitir = p.estado === 'anulado' && !p.contact_id && /^ANULADO SIN EMITIR/.test(p.observaciones || '')
      }
    }
    window.filtrarPacking()
  } catch (e) {
    document.getElementById('tabla-packing-body').innerHTML = `<tr><td colspan="11" style="text-align:center; color:var(--color-danger);">${_esc(e.message)}</td></tr>`
  }
}

window.filtrarPacking = function () {
  const tbody = document.getElementById('tabla-packing-body')
  if (!tbody) return
  const q = (document.getElementById('buscarPacking')?.value || '').toLowerCase().trim()
  const fe = document.getElementById('filtroEstadoPacking')?.value || ''
  const hoy = _hoy()
  const lista = _pkLista.filter(p => (!fe || p.estado === fe) &&
    (!q || `${p.numero} ${p._cliente || ''} ${p.orden_compra_cliente || ''}`.toLowerCase().includes(q)))
  if (!lista.length) { tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;">Sin PK registrados</td></tr>'; return }
  tbody.innerHTML = lista.map(p => {
    const [lbl, cls] = ESTADOS[p.estado] || [p.estado, 'badge-secondary']
    const abierto = p.estado === 'borrador' || p.estado === 'enviado' || p.estado === 'parcial'
    const vencido = abierto && p.fecha_validez && p.fecha_validez < hoy
    return `<tr style="${p.estado === 'anulado' ? 'opacity:.55;' : ''}">
      <td><strong>${_esc(p.numero)}</strong>${p._adjuntos ? ` <span title="${p._adjuntos} adjunto(s)" style="cursor:pointer;" onclick="window.verAdjuntosPacking(${p.id})">📎</span>` : ''}</td>
      <td>${_esc(p.fecha_emision || '')}</td>
      <td style="${vencido ? 'color:var(--color-danger); font-weight:600;' : ''}" title="${vencido ? 'Validez vencida' : ''}">${_esc(p.fecha_validez || '—')}</td>
      <td>${p._sinEmitir ? `<em style="color:var(--text-secondary);">Formato anulado sin emitir${p.observaciones ? ' — ' + _esc(p.observaciones.replace(/^ANULADO SIN EMITIR:\s*/, '')) : ''}</em>` : _esc(p._cliente || '-')}</td>
      <td>${_esc(_nombreVendedor(p.vendedor_id))}</td>
      <td>${_esc(p.orden_compra_cliente || '—')}</td>
      <td>${_esc(p.moneda)}</td>
      <td style="text-align:right; font-weight:600;">${formatNumber(p.total)}</td>
      <td><span class="badge ${cls}">${lbl}</span></td>
      <td>${p._facturas?.length
        ? `${p._facturas.map(f => `<div style="white-space:nowrap;">${_esc(f.numero)}</div>`).join('')}
           ${p.estado === 'parcial' ? `<div title="Facturado sobre el subtotal del PK" style="margin-top:3px; height:5px; background:var(--bg-secondary); border-radius:3px; overflow:hidden;"><div style="height:100%; width:${p._avance.toFixed(0)}%; background:var(--color-warning);"></div></div><small style="color:var(--text-secondary);">${p._avance.toFixed(0)} % facturado</small>` : ''}`
        : (p.venta_id ? _esc(_pkVentasMap.get(p.venta_id) || '#' + p.venta_id) : '—')}</td>
      <td class="col-acciones">${menuAccionesFila([
        abierto ? { icono: '🧾', label: 'Facturar', onclick: `window.facturarPacking(${p.id})` } : null,
        { icono: abierto ? '✏️' : '👁', label: abierto ? 'Editar' : 'Ver detalle', onclick: `window.abrirModalPacking(${p.id})` },
        p._sinEmitir ? null : { icono: '📄', label: 'PDF', onclick: `window.imprimirPacking(${p.id})` },
        p._adjuntos ? { icono: '📎', label: `Ver adjunto${p._adjuntos > 1 ? 's (' + p._adjuntos + ')' : ''}`, onclick: `window.verAdjuntosPacking(${p.id})` } : null,
        abierto ? { separador: true } : null,
        (abierto && !p._facturas?.length) ? { icono: '🚫', label: 'Anular', onclick: `window.anularPacking(${p.id})`, peligro: true } : null,
        (p.estado === 'anulado' && !p.venta_id) ? { separador: true } : null,
        (p.estado === 'anulado' && !p.venta_id) ? { icono: '✕', label: 'Eliminar', onclick: `window.eliminarPacking(${p.id})`, peligro: true } : null
      ])}</td></tr>`
  }).join('')
}

// ─── Modal ──────────────────────────────────────────────────────────────────
// ─── Modal (MISMA estructura que modal-nueva-venta de ventas.html) ─────────
// Estándar: secciones con título en mayúsculas, correlativo con candado 🔒,
// campos opcionales con checkbox, tabla de líneas + sub-modal "Agregar
// Producto" (espejo de modal-agregar-linea-venta) y bloque de 4 totales.
const _TIT = 'display:block; margin-bottom:10px; color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase; letter-spacing:0.03em;'
const _TOT = (lbl, id, color = 'var(--text-primary)') => `<div style="text-align:center;"><div style="font-size:12px; color:var(--text-secondary);">${lbl}</div><div style="font-size:18px; font-weight:600; color:${color};" id="${id}">0.00</div></div>`

function _asegurarModal() {
  if (document.getElementById('modal-packing')) return
  const div = document.createElement('div')
  div.id = 'modal-packing'
  div.className = 'modal'
  div.innerHTML = `
  <div class="modal-content" style="max-width:1240px; width:96%; max-height:calc(100vh - 48px); overflow-y:auto;">
    <div class="modal-header">
      <h3 id="pkTitulo">Nuevo PK — Packing</h3>
      <button class="modal-close" onclick="window.closeModal('modal-packing')">&times;</button>
    </div>

    <div style="padding:16px 20px 0;">
      <div id="pkAvisoSoloLectura" style="display:none; margin-bottom:12px; padding:10px 14px; background:var(--bg-secondary); border-left:3px solid var(--color-warning); border-radius:var(--radius-md); font-size:0.85rem; color:var(--text-secondary);"></div>

      <strong style="${_TIT}">Datos del comprobante</strong>
      <div style="display:grid; grid-template-columns:1fr 0.8fr 1fr 1fr 1.2fr; gap:12px;">
        <div class="form-group">
          <label>Tipo Documento</label>
          <select id="pkTipoDoc" disabled><option value="PK">PK - Packing</option></select>
        </div>
        <div class="form-group">
          <label>Serie</label>
          <input type="text" id="pkSerie" readonly>
        </div>
        <div class="form-group">
          <label>N° PK</label>
          <div class="input-con-candado">
            <input type="text" id="pkCorrelativo" placeholder="000001" readonly title="Correlativo sugerido automáticamente">
            <button type="button" class="btn-candado" id="btnCandadoPkCorr" onclick="window.toggleCandado('pkCorrelativo','btnCandadoPkCorr','aviso-pk-corr')" title="Editar el número manualmente">🔒</button>
          </div>
          <small id="aviso-pk-corr" class="campo-editable-aviso">Número manual: verifica que no rompa la correlatividad.</small>
        </div>
        <div class="form-group">
          <label>Validez (días)</label>
          <input type="number" id="pkDiasValidez" min="1" step="1" onchange="window._pkRecalcValidez()">
        </div>
        <div class="form-group">
          <label>Vendedor</label>
          <select id="pkVendedor"></select>
        </div>
      </div>

      <div style="display:grid; grid-template-columns:2fr 1fr 1fr 1fr 1fr; gap:12px; margin-top:4px;">
        <div class="form-group">
          <label>Cliente *</label>
          <select id="pkCliente"></select>
          <small id="pkClienteDocInfo" style="display:none; color:var(--text-secondary); font-size:0.92rem;"></small>
        </div>
        <div class="form-group">
          <label>Fecha Emisión *</label>
          <input type="date" id="pkFecha" onchange="window._pkRecalcValidez()">
        </div>
        <div class="form-group">
          <label>Válido hasta</label>
          <input type="date" id="pkValidez">
        </div>
        <div class="form-group">
          <label>Moneda</label>
          <select id="pkMoneda" onchange="window._pkOnMoneda()">
            <option value="USD">USD - Dólares</option>
            <option value="PEN">PEN - Soles</option>
          </select>
        </div>
        <div class="form-group" id="pkTCGroup">
          <label>T.C. <span style="font-size:0.75rem; font-weight:600; color:var(--color-info);">VENTA SUNAT</span>
            <button type="button" id="pkBtnTC" hidden onclick="window._pkConsultarTC()" title="Consultar TC VENTA SUNAT de la fecha de emisión (guardado = sin consumo; nuevo = 1 crédito Decolecta)"
                    style="margin-left:4px; background:none; border:1px solid var(--border-color); border-radius:4px; padding:1px 6px; font-size:0.72rem; cursor:pointer; color:var(--color-info);">🔎 Consultar</button></label>
          <input type="number" id="pkTC" step="0.001" min="0" placeholder="3.750" oninput="window._pkPintarLineas()">
          <small id="pkTCAviso" style="color:var(--text-secondary); font-size:0.72rem;"></small>
        </div>
      </div>

      <div style="margin-top:14px; padding-top:12px; border-top:1px solid var(--border-color);">
        <strong style="${_TIT} margin-bottom:6px;">Datos adicionales</strong>
        <div style="display:grid; grid-template-columns:1fr 1fr 2fr; gap:12px; align-items:start;">
          <div class="form-group" style="margin:0;">
            <label>Término de pago</label>
            <select id="pkTermino"></select>
          </div>
          <div class="campo-opcional" id="grupo-pk-oc">
            <label class="campo-opcional-cabecera">
              <input type="checkbox" id="chkPkOC" onchange="window.toggleCampoOpcional('grupo-pk-oc', this, 'pkOC')">
              <span>Orden de compra del cliente</span>
            </label>
            <div class="campo-opcional-cuerpo"><input type="text" id="pkOC" placeholder="N° de O/C del cliente"></div>
          </div>
          <div class="campo-opcional" id="grupo-pk-obs">
            <label class="campo-opcional-cabecera">
              <input type="checkbox" id="chkPkObs" onchange="window.toggleCampoOpcional('grupo-pk-obs', this, 'pkObs')">
              <span>Nota general (sale en el PDF)</span>
            </label>
            <div class="campo-opcional-cuerpo"><input type="text" id="pkObs" placeholder="Condiciones, plazo de entrega, etc."></div>
          </div>
        </div>
      </div>
    </div>

    <hr style="margin:12px 20px; border-color:var(--border-color);">

    <div style="padding:0 20px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <strong style="color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase; letter-spacing:0.03em;">Productos</strong>
        <button type="button" class="btn btn-primary btn-small" id="pkBtnAgregarLinea" onclick="window._pkAbrirLinea()">+ Agregar Producto</button>
      </div>
      <div class="table-container">
        <table>
          <thead><tr>
            <th>Descripción</th>
            <th style="text-align:right;">Cant.</th><th>Unidad</th>
            <th style="text-align:right;">N° Unid.</th>
            <th style="text-align:right;">Precio</th><th>Tipo</th>
            <th style="text-align:right;">Subtotal</th><th style="text-align:right;">IGV</th>
            <th style="text-align:right;">Total</th>
            <th style="text-align:right;" title="Subtotal (sin IGV) − costo estimado FIFO del stock actual">Ganancia</th><th></th>
          </tr></thead>
          <tbody id="pkLineasBody"></tbody>
        </table>
      </div>
    </div>

    <div style="margin:15px 20px; padding:15px; background-color:var(--bg-secondary); border-radius:var(--radius-md); display:grid; grid-template-columns:repeat(5, 1fr); gap:15px;">
      ${_TOT('Cantidad Total', 'pkTotCant')}${_TOT('Base Imponible', 'pkTotBase')}${_TOT('IGV 18%', 'pkTotIGV')}${_TOT('Total', 'pkTotTotal', 'var(--color-success)')}
      <div style="text-align:center;" title="Base imponible − costo estimado (FIFO del stock actual). Uso interno: no sale en el PDF.">
        <div style="font-size:12px; color:var(--text-secondary);">Ganancia (estim.)</div>
        <div style="font-size:18px; font-weight:600;"><span id="pkTotGan">—</span> <span id="pkTotGanPct" style="font-size:13px; font-weight:600;"></span></div>
      </div>
    </div>

    <div id="pkAdjuntosBloque" style="display:none; margin:0 20px 15px;">
      <strong style="${_TIT}">📎 Adjuntos</strong>
      <div id="pkAdjuntosLista" style="display:flex; gap:14px; flex-wrap:wrap;"></div>
    </div>

    <div class="modal-footer">
      <button class="btn" onclick="window.closeModal('modal-packing')">Cancelar</button>
      <button class="btn btn-secondary" id="pkBtnFacturar" style="display:none;" onclick="window._pkGuardarYFacturar(this)" title="Guarda los cambios del PK y abre la facturación (total o parcial)">🧾 Guardar y facturar</button>
      <button class="btn btn-primary" id="pkBtnGuardar" onclick="window.conCarga(this, window.guardarPacking)">💾 Guardar PK</button>
    </div>
  </div>`
  document.body.appendChild(div)

  // Sub-modal "Agregar Producto al PK" — espejo de modal-agregar-linea-venta
  // (sin panel de stock: el PK no reserva ni mueve stock).
  const sub = document.createElement('div')
  sub.id = 'modal-pk-linea'
  sub.className = 'modal'
  sub.innerHTML = `
  <div class="modal-content" style="max-width:900px;">
    <div class="modal-header">
      <h3 class="modal-title" id="pkLineaTitulo">Agregar Producto al PK</h3>
      <button class="modal-close" onclick="window.closeModal('modal-pk-linea')">✕</button>
    </div>
    <div style="padding:20px;">
      <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:flex-end;">
        <div style="flex:2 1 320px;">
          <label style="font-size:0.8rem;">Producto *</label>
          <select id="pkItem" onchange="window._pkOnItem()"></select>
        </div>
        <div style="flex:1 1 200px;">
          <label style="font-size:0.8rem;">Nota de la línea <small style="color:var(--text-secondary);">(sale en el PDF)</small></label>
          <input type="text" id="pkNotaLinea" placeholder="Ej: 18 BOLSAS (24.50 KG X BOLSA)">
        </div>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:flex-end; margin-top:10px;">
        <div style="flex:0.9 1 120px;">
          <label style="font-size:0.8rem;">Cantidad total *</label>
          <input type="number" id="pkCant" min="0.001" step="0.001" oninput="window._pkSugerirUnidades(); window._pkPreviewLinea()">
        </div>
        <div style="flex:0 0 auto;">
          <label style="font-size:0.8rem;">Unidad</label>
          <input type="text" id="pkUdm" value="KG" size="4" style="width:auto; max-width:60px;">
        </div>
        <div style="flex:0.9 1 130px;">
          <label style="font-size:0.8rem;" title="Bultos/conos/cajas. Informativo.">N° Unidades</label>
          <input type="number" id="pkUnid" min="0" step="1" placeholder="—">
        </div>
        <div style="flex:0.9 1 120px;">
          <label style="font-size:0.8rem;">Precio Unit. *</label>
          <input type="number" id="pkPrecio" step="0.0001" placeholder="0.00" oninput="window._pkPreviewLinea()">
        </div>
        <div style="flex:1 1 140px;">
          <label style="font-size:0.8rem;">Tipo IGV</label>
          <select id="pkIGV" onchange="window._pkPreviewLinea()">
            <option value="gravada">Gravada 18%</option>
            <option value="gravada_incluido">Gravada 18% (incluido)</option>
            <option value="exonerada">Exonerada</option>
            <option value="inafecta">Inafecta</option>
          </select>
        </div>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:flex-end; margin-top:10px;">
        <div style="flex:0.9 1 120px;"><label style="font-size:0.8rem;">Subtotal</label><input type="text" id="pkPrevSub" readonly value="0.00" style="background:var(--bg-primary); color:var(--text-secondary);"></div>
        <div style="flex:0.9 1 120px;"><label style="font-size:0.8rem;">IGV</label><input type="text" id="pkPrevIGV" readonly value="0.00" style="background:var(--bg-primary); color:var(--text-secondary);"></div>
        <div style="flex:0.9 1 120px;"><label style="font-size:0.8rem;">Total</label><input type="text" id="pkPrevTot" readonly value="0.00" style="background:var(--bg-primary); color:var(--text-secondary); font-weight:bold;"></div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="window.closeModal('modal-pk-linea')">Cancelar</button>
      <button class="btn btn-primary" id="pkBtnLineaOk" onclick="window._pkAgregarLinea()">+ Agregar</button>
    </div>
  </div>`
  document.body.appendChild(sub)

  convertirEnBuscador('pkCliente', {
    placeholder: 'Escribe el nombre o RUC del cliente...', sinResultados: 'Ningún cliente coincide',
    // Igual que Nueva Venta: registrar el cliente sin salir del PK. El modal
    // de cliente se mueve al final del <body> para quedar ENCIMA del modal PK
    // (que se creó después y, con el mismo z-index, lo taparía).
    alCrearNuevo: { label: 'Registrar cliente nuevo', onClick: () => {
      const m = document.getElementById('modal-nuevo-cliente')
      if (m) document.body.appendChild(m)
      window.abrirFormularioCliente?.()
    } }
  })
  // RUC/DNI debajo del cliente, igual que en Nueva Venta
  document.getElementById('pkCliente')?.addEventListener('change', _pintarDocClientePK)
  convertirEnBuscador('pkItem', { placeholder: 'Escribe el producto o SKU...', sinResultados: 'Sin coincidencias' })
}

// Cliente recién registrado desde el buscador: se agrega a la lista del PK y
// queda seleccionado (solo si el modal PK está abierto y editable).
window.addEventListener('cliente-creado', (ev) => {
  const c = ev.detail
  const modal = document.getElementById('modal-packing')
  const sel = document.getElementById('pkCliente')
  if (!c?.id || !sel || !modal?.classList.contains('show') || sel.disabled) return
  if (![...sel.options].some(o => o.value === String(c.id))) {
    const o = document.createElement('option')
    o.value = c.id
    o.textContent = `${c.nombre || c.razon_social || ''}${c.nro_documento ? ' — ' + c.nro_documento : ''}`
    sel.appendChild(o)
  }
  sel.value = String(c.id)
  refrescarBuscador('pkCliente')
  _pintarDocClientePK()
})

/** T.C. del PK (referencial, se usa el VENTA SUNAT como en la factura).
 *  soloCache=true → automático (no consume crédito); botón → puede ir a Decolecta. */
window._pkConsultarTC = async function (soloCache = false) {
  const campo = document.getElementById('pkTC')
  const aviso = document.getElementById('pkTCAviso')
  const btn = document.getElementById('pkBtnTC')
  if (!campo || document.getElementById('pkMoneda')?.value !== 'USD' || campo.disabled) return
  if (btn) btn.disabled = true
  if (aviso) aviso.textContent = soloCache ? 'Buscando TC guardado...' : 'Consultando TC SUNAT...'
  try {
    const r = await getTCVenta(document.getElementById('pkFecha')?.value || null, { permitirApi: !soloCache })
    if (r.error) { if (aviso) aviso.textContent = r.sinCache ? '' : `⚠ ${r.error} — ingrésalo manualmente`; return }
    campo.value = r.tc.toFixed(3)
    if (aviso) aviso.textContent = textoAvisoTC(r, 'venta')
    window._pkPintarLineas()
  } finally { if (btn) btn.disabled = false }
}

function _pintarDocClientePK() {
  const id = parseInt(document.getElementById('pkCliente')?.value || 0)
  pintarDocumentoContacto('pkClienteDocInfo', (S._clientes || []).find(c => c.id === id) || null)
}

function _poblarSelects() {
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html }
  set('pkCliente', '<option value="">-- Selecciona cliente --</option>' + (S._clientes || []).map(c => `<option value="${c.id}">${_esc(c.nombre || c.razon_social || '')}${c.nro_documento ? ' — ' + _esc(c.nro_documento) : ''}</option>`).join(''))
  set('pkVendedor', '<option value="">-- Sin asignar --</option>' + (S._vendedores || []).map(v => `<option value="${v.id}">${_esc(v.nombre)}</option>`).join(''))
  set('pkItem', '<option value="">-- Selecciona producto --</option>' + (S._items || []).map(i => `<option value="${i.id}">${i.sku ? '[' + _esc(i.sku) + '] ' : ''}${_esc(i.nombre)}</option>`).join(''))
  set('pkTermino', '<option value="">—</option>' + _pkTerminos.map(t => `<option value="${t.id}">${_esc(t.nombre)}</option>`).join(''))
  refrescarBuscador('pkCliente'); refrescarBuscador('pkItem')
}

/** Deja el candado cerrado con el valor automático (toggleCandado vive en venta-nueva.js). */
function _resetCandado(idInput, idBoton, idAviso, valor) {
  const input = document.getElementById(idInput), boton = document.getElementById(idBoton)
  input.value = valor
  input.readOnly = true
  input.dataset.valorAutomatico = valor
  boton.textContent = '🔒'
  boton.classList.remove('abierto')
  document.getElementById(idAviso)?.classList.remove('visible')
}

/** Campo opcional: se abre si trae valor (igual que al editar una venta). */
function _setOpcional(idGrupo, idChk, idInput, valor) {
  document.getElementById(idInput).value = valor || ''
  document.getElementById(idChk).checked = !!valor
  document.getElementById(idGrupo).classList.toggle('abierto', !!valor)
}

window._pkOnMoneda = function () {
  document.getElementById('pkTCGroup').style.visibility = document.getElementById('pkMoneda').value === 'USD' ? 'visible' : 'hidden'
  window._pkPintarLineas()
}

window._pkRecalcValidez = function () {
  const f = document.getElementById('pkFecha').value
  const d = parseInt(document.getElementById('pkDiasValidez').value) || 0
  if (f && d > 0) document.getElementById('pkValidez').value = _sumarDias(f, d)
}

window._pkOnItem = function () {
  const it = (S._items || []).find(i => i.id === parseInt(document.getElementById('pkItem').value))
  if (it) document.getElementById('pkUdm').value = it.unidad_medida || 'KG'
  window._pkSugerirUnidades()
}

// Unidades sugeridas: cantidad ÷ peso por unidad del lote más reciente del
// producto (mismo criterio que Nueva Venta). Editable.
window._pkSugerirUnidades = function () {
  const itemId = parseInt(document.getElementById('pkItem').value)
  const cant = parseFloat(document.getElementById('pkCant').value) || 0
  const lote = (S._lotes || []).filter(l => l.item_id === itemId && parseFloat(l.peso_por_unidad) > 0).sort((a, b) => b.id - a.id)[0]
  if (lote && cant > 0) document.getElementById('pkUnid').value = Math.round(cant / parseFloat(lote.peso_por_unidad))
}

// Mismo cálculo que agregarLineaVenta (venta-nueva.js): precio guardado SIN IGV.
function _calcLinea(cant, precio, igvTipo) {
  const incl = igvTipo === 'gravada_incluido'
  const pct = (igvTipo === 'gravada' || incl) ? 18 : 0
  let subtotal, igvMonto, total, precioBase
  if (incl) { total = +(cant * precio).toFixed(2); subtotal = +(total / 1.18).toFixed(2); igvMonto = +(total - subtotal).toFixed(2); precioBase = +(subtotal / cant).toFixed(4) }
  else { subtotal = +(cant * precio).toFixed(2); igvMonto = +(subtotal * pct / 100).toFixed(2); total = +(subtotal + igvMonto).toFixed(2); precioBase = precio }
  return { subtotal, igv_monto: igvMonto, total_linea: total, precio_unitario: precioBase, tipo_base: incl ? 'gravada' : igvTipo, igv_porcentaje: pct }
}

window._pkPreviewLinea = function () {
  const cant = parseFloat(document.getElementById('pkCant').value) || 0
  const precio = parseFloat(document.getElementById('pkPrecio').value) || 0
  const c = cant > 0 ? _calcLinea(cant, precio, document.getElementById('pkIGV').value) : { subtotal: 0, igv_monto: 0, total_linea: 0 }
  document.getElementById('pkPrevSub').value = formatNumber(c.subtotal)
  document.getElementById('pkPrevIGV').value = formatNumber(c.igv_monto)
  document.getElementById('pkPrevTot').value = formatNumber(c.total_linea)
}

let _pkLineaEditIdx = null

/** Abre el sub-modal para agregar (idx=null) o editar una línea. */
window._pkAbrirLinea = function (idx = null) {
  _pkLineaEditIdx = idx
  const l = idx != null ? _pkLineas[idx] : null
  const val = (k, v) => { document.getElementById(k).value = v ?? '' }
  val('pkItem', l?.item_id || ''); refrescarBuscador('pkItem')
  val('pkNotaLinea', l?.nota || '')
  val('pkCant', l?.cantidad || '')
  val('pkUdm', l?.unidad_medida || 'KG')
  val('pkUnid', l?.cantidad_unidades || '')
  val('pkPrecio', l?.precio_unitario || '')
  val('pkIGV', l ? (l.tipo_base || 'gravada') : 'gravada')
  document.getElementById('pkLineaTitulo').textContent = l ? `Editar línea ${idx + 1}` : 'Agregar Producto al PK'
  document.getElementById('pkBtnLineaOk').textContent = l ? '💾 Guardar línea' : '+ Agregar'
  window._pkPreviewLinea()
  window.openModal('modal-pk-linea')
}

window._pkAgregarLinea = function () {
  const itemId = parseInt(document.getElementById('pkItem').value) || null
  const it = (S._items || []).find(i => i.id === itemId)
  const cant = parseFloat(document.getElementById('pkCant').value) || 0
  const precio = parseFloat(document.getElementById('pkPrecio').value) || 0
  if (!it) { showToast('Selecciona un producto', 'warning'); return }
  if (!(cant > 0)) { showToast('Ingresa la cantidad', 'warning'); return }
  if (!(precio > 0)) { showToast('Ingresa el precio', 'warning'); return }
  const linea = {
    item_id: it.id, descripcion: `${it.sku ? '[' + it.sku + '] ' : ''}${it.nombre}`,
    nota: document.getElementById('pkNotaLinea').value.trim() || null,
    cantidad: cant, unidad_medida: document.getElementById('pkUdm').value.trim() || 'KG',
    cantidad_unidades: parseFloat(document.getElementById('pkUnid').value) || 0,
    ..._calcLinea(cant, precio, document.getElementById('pkIGV').value)
  }
  if (_pkLineaEditIdx != null) {
    const prev = _pkLineas[_pkLineaEditIdx]
    const fact = prev?.id ? (_pkFactPorLinea[prev.id] || 0) : 0
    if (fact > _TOL && cant < fact - _TOL) { showToast(`Ya se facturaron ${formatNumber(fact)} de esta línea: la cantidad no puede ser menor.`, 'warning', 7000); return }
    if (fact > _TOL && prev.item_id !== linea.item_id) { showToast('Esta línea ya tiene facturas: no se puede cambiar el producto.', 'warning', 7000); return }
    if (prev?.id) linea.id = prev.id
    _pkLineas[_pkLineaEditIdx] = linea
  }
  else _pkLineas.push(linea)
  window.closeModal('modal-pk-linea')
  window._pkPintarLineas()
}

window._pkQuitarLinea = function (idx) { _pkLineas.splice(idx, 1); window._pkPintarLineas() }

// Ganancia estimada por línea (uso interno, no se guarda ni sale en el PDF):
//   costo = promedio FIFO del stock disponible del ítem (mismo cálculo que
//   usa Nueva Venta al facturar el PK), en SOLES; si el PK es en USD se
//   divide entre el T.C. del PK. Ganancia = subtotal (sin IGV) − costo × cant.
//   % = ganancia / subtotal (margen sobre la venta).
function _costoFIFOItem(itemId, cantidad) {
  const lotes = _stockTotalPorItem(itemId)?.lotes || []
  if (!lotes.length) return null
  let restante = cantidad, acum = 0, kg = 0
  for (const l of lotes) {
    if (restante <= 0) break
    const usa = Math.min(restante, l.disp)
    acum += usa * (parseFloat(l.costo_unitario) || 0); kg += usa; restante -= usa
  }
  return kg > 0 ? acum / kg : (parseFloat(lotes[0]?.costo_unitario) || 0)
}

function _gananciaLinea(l) {
  if (!l.item_id) return null
  const costoPEN = _costoFIFOItem(l.item_id, +l.cantidad)
  if (costoPEN === null) return null
  const usd = document.getElementById('pkMoneda')?.value === 'USD'
  const tc = parseFloat(document.getElementById('pkTC')?.value) || 0
  if (usd && !tc) return null
  const costoLinea = (costoPEN / (usd ? tc : 1)) * (+l.cantidad)
  const gan = (+l.subtotal) - costoLinea
  return { gan, pct: +l.subtotal ? gan / (+l.subtotal) * 100 : 0, costo: costoLinea }
}

const _colorGan = (g) => g < 0 ? 'var(--color-danger)' : 'var(--color-success)'

window._pkPintarLineas = function () {
  const tb = document.getElementById('pkLineasBody')
  if (!tb) return
  const gans = _pkLineas.map(_gananciaLinea)
  const soloLectura = document.getElementById('pkBtnGuardar')?.style.display === 'none'
  tb.innerHTML = _pkLineas.length ? _pkLineas.map((l, i) => `<tr>
    <td>${_esc(l.descripcion)}${l.nota ? `<br><small style="color:var(--text-secondary); font-style:italic;">${_esc(l.nota)}</small>` : ''}</td>
    <td style="text-align:right;">${formatNumber(l.cantidad)}${l.id && _pkFactPorLinea[l.id] ? `<br><small style="color:var(--color-success); white-space:nowrap;">fact. ${formatNumber(_pkFactPorLinea[l.id])}</small><br><small style="color:var(--color-warning); white-space:nowrap;">pend. ${formatNumber(Math.max(0, l.cantidad - _pkFactPorLinea[l.id]))}</small>` : ''}</td><td>${_esc(l.unidad_medida)}</td>
    <td style="text-align:right;">${l.cantidad_unidades || '—'}</td>
    <td style="text-align:right;">${(+l.precio_unitario).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
    <td>${l.tipo_base === 'gravada' ? 'Gravada' : _esc(l.tipo_base)}</td>
    <td style="text-align:right;">${formatNumber(l.subtotal)}</td>
    <td style="text-align:right;">${formatNumber(l.igv_monto)}</td>
    <td style="text-align:right; font-weight:600;">${formatNumber(l.total_linea)}</td>
    <td style="text-align:right; white-space:nowrap;">${gans[i] ? `<span style="color:${_colorGan(gans[i].gan)}; font-weight:600;" title="Costo estimado: ${formatNumber(gans[i].costo)}">${formatNumber(gans[i].gan)}</span><br><small style="color:var(--text-secondary);">${gans[i].pct.toFixed(1)}%</small>` : '<span style="color:var(--text-secondary);" title="Sin stock con costo o falta T.C.">—</span>'}</td>
    <td style="white-space:nowrap;">${soloLectura ? '' : `<button class="btn btn-small btn-secondary" onclick="window._pkAbrirLinea(${i})" title="Editar">✏️</button>
      ${l.id && _pkFactPorLinea[l.id] ? '' : `<button class="btn btn-small btn-danger" onclick="window._pkQuitarLinea(${i})" title="Quitar">✕</button>`}`}</td></tr>`).join('')
    : '<tr><td colspan="11" style="text-align:center; color:var(--text-secondary); padding:20px;">Sin productos agregados</td></tr>'
  const t = _pkLineas.reduce((a, l) => ({ c: a.c + (+l.cantidad), b: a.b + (+l.subtotal), i: a.i + (+l.igv_monto), t: a.t + (+l.total_linea) }), { c: 0, b: 0, i: 0, t: 0 })
  const mon = document.getElementById('pkMoneda')?.value === 'USD' ? '$' : 'S/'
  document.getElementById('pkTotCant').textContent = formatNumber(t.c)
  document.getElementById('pkTotBase').textContent = `${mon} ${formatNumber(t.b)}`
  document.getElementById('pkTotIGV').textContent = `${mon} ${formatNumber(t.i)}`
  document.getElementById('pkTotTotal').textContent = `${mon} ${formatNumber(t.t)}`
  // Ganancia total: solo si TODAS las líneas tienen costo (si no, sería engañosa)
  const elG = document.getElementById('pkTotGan'), elP = document.getElementById('pkTotGanPct')
  if (elG && elP) {
    const completas = gans.length && gans.every(Boolean)
    if (!completas) {
      elG.textContent = '—'; elG.style.color = 'var(--text-secondary)'
      elP.textContent = gans.length ? '(falta costo o T.C.)' : ''
    } else {
      const g = gans.reduce((a, x) => a + x.gan, 0)
      elG.textContent = `${mon} ${formatNumber(g)}`; elG.style.color = _colorGan(g)
      elP.textContent = t.b ? `${(g / t.b * 100).toFixed(1)}%` : ''; elP.style.color = _colorGan(g)
    }
  }
}

let _pkSerieActual = null
let _pkFactPorLinea = {}

window._pkGuardarYFacturar = async function (btn) {
  window._pkFacturarTrasGuardar = true
  try { await window.conCarga(btn, window.guardarPacking) } finally { window._pkFacturarTrasGuardar = false }
}
let _pkCorrSugerido = null

window.abrirModalPacking = async function (id = null) {
  try {
    _asegurarModal()
    if (!_pkTerminos.length) _pkTerminos = (await getTerminosPago()) || []
    _poblarSelects()
    const serie = await serieDefault('PK')
    if (!serie) { showToast('Falta la serie PK: corre assets/sql/59_series_documentos_y_packing.sql', 'danger', 7000); return }
    const pk = id ? (_pkLista.find(p => p.id === id) || (await supabase.from('packing').select('*').eq('id', id).single()).data) : null
    _pkEditId = pk?.id || null
    _pkSerieActual = pk ? { ...serie, serie: pk.serie } : serie
    _pkLineas = pk ? (await _getDetalle(pk.id)).map(d => ({ ...d, cantidad: +d.cantidad, cantidad_unidades: +d.cantidad_unidades, precio_unitario: +d.precio_unitario, subtotal: +d.subtotal, igv_monto: +d.igv_monto, total_linea: +d.total_linea })) : []
    const val = (k, v) => { const el = document.getElementById(k); if (el) el.value = v ?? '' }
    const hoy = _hoy()
    const dig = parseInt(serie.digitos) || 6
    _pkCorrSugerido = pk ? pk.correlativo : siguienteCorrelativo(serie, await _maxCorrelativoPK(serie.serie))
    val('pkSerie', _pkSerieActual.serie)
    _resetCandado('pkCorrelativo', 'btnCandadoPkCorr', 'aviso-pk-corr', String(_pkCorrSugerido).padStart(dig, '0'))
    val('pkCliente', pk?.contact_id || ''); refrescarBuscador('pkCliente'); _pintarDocClientePK()
    val('pkVendedor', pk?.vendedor_id || '')
    val('pkFecha', pk?.fecha_emision || hoy)
    val('pkDiasValidez', serie.dias_validez || 15)
    val('pkValidez', pk?.fecha_validez || _sumarDias(hoy, serie.dias_validez || 15))
    val('pkTermino', pk?.termino_pago_id || '')
    val('pkMoneda', pk?.moneda || 'USD')
    val('pkTC', pk?.tipo_cambio && pk.tipo_cambio !== 1 ? pk.tipo_cambio : '')
    const _avTC = document.getElementById('pkTCAviso'); if (_avTC) _avTC.textContent = ''
    // T.C. VENTA automático según la fecha de emisión (en vivo, candado 🔒).
    // PK existente: conserva su T.C.; se recalcula solo si cambias fecha/moneda.
    const _tcPk = vincularTCEnVivo({ idFecha: 'pkFecha', idMoneda: 'pkMoneda', idTC: 'pkTC', idAviso: 'pkTCAviso', tipo: 'venta', onCambio: () => window._pkPintarLineas() })
    if (pk) _tcPk.conservar(); else _tcPk.reiniciar()
    _setOpcional('grupo-pk-oc', 'chkPkOC', 'pkOC', pk?.orden_compra_cliente)
    _setOpcional('grupo-pk-obs', 'chkPkObs', 'pkObs', pk?.observaciones)

    const abierto = !pk || pk.estado === 'borrador' || pk.estado === 'enviado' || pk.estado === 'parcial'
    // Facturado/pendiente por línea (para mostrar y para no dejar bajar de lo ya facturado)
    _pkFactPorLinea = pk ? (await _facturacionPK(pk.id)).porLinea : {}
    document.getElementById('pkBtnFacturar').style.display = (pk && abierto) ? '' : 'none'
    document.getElementById('pkTitulo').textContent = pk ? `${abierto ? 'Editar' : 'Ver'} ${pk.numero}` : 'Nuevo PK — Packing'
    document.getElementById('pkBtnGuardar').style.display = abierto ? '' : 'none'
    document.getElementById('pkBtnAgregarLinea').style.display = abierto ? '' : 'none'
    document.getElementById('btnCandadoPkCorr').disabled = !abierto
    document.querySelectorAll('#modal-packing input, #modal-packing select').forEach(el => {
      if (el.id === 'pkTipoDoc' || el.id === 'pkSerie' || el.id === 'pkCorrelativo') return
      el.disabled = !abierto
    })
    const aviso = document.getElementById('pkAvisoSoloLectura')
    aviso.style.display = abierto ? 'none' : 'block'
    if (abierto && pk?.estado === 'parcial') { aviso.style.display = 'block'; aviso.textContent = 'PK facturado parcialmente: puedes editarlo, pero no bajar una línea por debajo de lo ya facturado.' }
    else aviso.textContent = abierto ? '' : (pk.estado === 'facturado' ? `Facturado en ${_pkVentasMap.get(pk.venta_id) || 'la venta #' + pk.venta_id} — solo lectura.` : 'PK anulado — solo lectura.')
    window._pkOnMoneda()
    window.openModal('modal-packing')
    _pintarAdjuntosPK(pk?.id || null)
  } catch (e) { showToast('Error: ' + e.message, 'danger') }
}

/** Ver detalle: vista previa de las imágenes adjuntas + descargar; PDF solo enlace. */
async function _pintarAdjuntosPK(packingId) {
  const bloque = document.getElementById('pkAdjuntosBloque')
  const lista = document.getElementById('pkAdjuntosLista')
  if (!bloque || !lista) return
  bloque.style.display = 'none'; lista.innerHTML = ''
  if (!packingId) return
  let adjs = []
  try { adjs = await getAdjuntos('packing', packingId) } catch { return }
  if (!adjs?.length) return
  const tarjetas = await Promise.all(adjs.map(async a => {
    const esImagen = /^image\//.test(a.mime || '') || /\.(jpe?g|png|webp)$/i.test(a.path || '')
    let ver = null, bajar = null
    try { [ver, bajar] = await Promise.all([getUrlAdjunto(a.path), getUrlAdjunto(a.path, 3600, a.nombre || 'adjunto')]) } catch { /* sin enlace */ }
    if (!bajar) return `<div style="color:var(--color-danger); font-size:0.85rem;">${_esc(a.nombre)}: no se pudo generar el enlace</div>`
    const kb = a.tamano ? ` · ${(a.tamano / 1024).toFixed(0)} KB` : ''
    if (!esImagen) {
      return `<a href="${bajar}" class="btn btn-small btn-secondary" style="text-decoration:none;">⬇ ${_esc(a.nombre)}${kb}</a>`
    }
    return `<div style="width:240px; border:1px solid var(--border-color); border-radius:var(--radius-md); overflow:hidden; background:var(--bg-secondary);">
      <a href="${ver}" target="_blank" title="Abrir en tamaño completo">
        <img src="${ver}" alt="${_esc(a.nombre)}" style="display:block; width:100%; height:170px; object-fit:cover;">
      </a>
      <div style="padding:8px 10px; display:flex; justify-content:space-between; align-items:center; gap:8px;">
        <span style="font-size:0.78rem; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${_esc(a.nombre)}">${_esc(a.nombre)}${kb}</span>
        <a href="${bajar}" class="btn btn-small btn-secondary" style="text-decoration:none; white-space:nowrap;">⬇ Descargar</a>
      </div>
    </div>`
  }))
  lista.innerHTML = tarjetas.join('')
  bloque.style.display = ''
}

/**
 * Correlativo a usar. Candado cerrado → el sugerido (null en PK nuevo = se
 * calcula al insertar, con reintento). Candado abierto → el digitado, validando
 * que sea número y que no exista otro PK con ese número en la serie.
 */
async function _pkCorrelativoElegido() {
  const input = document.getElementById('pkCorrelativo')
  if (input.readOnly) return { manual: false, n: _pkEditId ? _pkCorrSugerido : null }
  const n = parseInt(String(input.value).replace(/\D/g, ''))
  if (!(n > 0)) throw new Error('El N° PK debe ser un número mayor a 0')
  if (n === _pkCorrSugerido) return { manual: false, n: _pkEditId ? n : null }
  let q = supabase.from('packing').select('id, numero').eq('serie', _pkSerieActual.serie).eq('correlativo', n)
  if (_pkEditId) q = q.neq('id', _pkEditId)
  const { data } = await q.limit(1)
  if (data?.length) throw new Error(`Ya existe ${data[0].numero}`)
  if (!confirm(`Vas a usar el número manual ${formatearNumero(_pkSerieActual, n)} (sugerido: ${formatearNumero(_pkSerieActual, _pkCorrSugerido)}).\n\n¿Continuar?`)) return null
  return { manual: true, n }
}

window.guardarPacking = async function () {
  const btn = document.getElementById('pkBtnGuardar')
  if (btn.disabled) return
  btn.disabled = true
  try {
    const user = await getCurrentUser()
    const contactId = parseInt(document.getElementById('pkCliente').value) || null
    const fecha = document.getElementById('pkFecha').value
    if (!contactId) { showToast('Selecciona el cliente', 'warning'); return }
    if (!fecha) { showToast('Ingresa la fecha de emisión', 'warning'); return }
    if (!_pkLineas.length) { showToast('Agrega al menos un producto', 'warning'); return }
    const corr = await _pkCorrelativoElegido()
    if (!corr) return
    const t = _pkLineas.reduce((a, l) => ({ b: a.b + (+l.subtotal), i: a.i + (+l.igv_monto), t: a.t + (+l.total_linea) }), { b: 0, i: 0, t: 0 })
    const cab = {
      contact_id: contactId, fecha_emision: fecha,
      fecha_validez: document.getElementById('pkValidez').value || null,
      moneda: document.getElementById('pkMoneda').value,
      tipo_cambio: parseFloat(document.getElementById('pkTC').value) || 1,
      termino_pago_id: parseInt(document.getElementById('pkTermino').value) || null,
      vendedor_id: parseInt(document.getElementById('pkVendedor').value) || null,
      orden_compra_cliente: document.getElementById('pkOC').value.trim() || null,
      observaciones: document.getElementById('pkObs').value.trim() || null,
      subtotal: +t.b.toFixed(2), igv: +t.i.toFixed(2), total: +t.t.toFixed(2),
      updated_at: new Date().toISOString()
    }
    // PK con facturas: ninguna línea facturada puede quitarse ni bajar de lo facturado
    let _prevLineas = [], _prevFact = {}
    if (_pkEditId) {
      const f = await _facturacionPK(_pkEditId)
      _prevLineas = f.lineas; _prevFact = f.porLinea
      for (const pl of _prevLineas) {
        const fact = _prevFact[pl.id] || 0
        if (fact <= _TOL) continue
        const actual = _pkLineas.find(l => l.id === pl.id)
        if (!actual) throw new Error(`"${pl.descripcion}" ya tiene ${formatNumber(fact)} facturado: no se puede retirar del PK.`)
        if (actual.cantidad < fact - _TOL) throw new Error(`"${pl.descripcion}": la cantidad no puede ser menor a lo facturado (${formatNumber(fact)}).`)
      }
    }
    let pk = null
    if (_pkEditId) {
      if (corr.manual) { cab.correlativo = corr.n; cab.numero = formatearNumero(_pkSerieActual, corr.n) }
      pk = await update('packing', _pkEditId, cab)
      if (!pk) throw new Error('No se pudo actualizar el PK')
      if (corr.manual) await registrarUsoSerie('PK', pk.serie, pk.correlativo)
      // Líneas retiradas (sin facturas) se borran; el resto se ACTUALIZA por id
      const quedan = new Set(_pkLineas.filter(l => l.id).map(l => l.id))
      for (const pl of _prevLineas) {
        if (quedan.has(pl.id)) continue
        const { error } = await supabase.from('detalle_packing').delete().eq('id', pl.id)
        if (error) throw new Error('No se pudo retirar una línea: ' + error.message)
      }
    } else {
      // Correlativo: siguiente de la serie; si otro usuario tomó el mismo
      // número al mismo tiempo (UNIQUE), se reintenta con el siguiente.
      // Con candado abierto se usa el N° digitado (ya validado) sin reintentos.
      const serie = await serieDefault('PK')
      const base = corr.manual ? corr.n : siguienteCorrelativo(serie, await _maxCorrelativoPK(serie.serie))
      for (let intento = 0; intento < (corr.manual ? 1 : 5) && !pk; intento++) {
        const n = base + intento
        pk = await insert('packing', { ...cab, tipo: 'venta', serie: serie.serie, correlativo: n, numero: formatearNumero(serie, n), estado: 'borrador', created_by: user?.db_id || null })
      }
      if (!pk) throw new Error('No se pudo crear el PK')
      await registrarUsoSerie('PK', pk.serie, pk.correlativo)
    }
    for (const [i, l] of _pkLineas.entries()) {
      const fila = {
        packing_id: pk.id, orden: i, item_id: l.item_id, descripcion: l.descripcion, nota: l.nota || null,
        cantidad: l.cantidad, unidad_medida: l.unidad_medida, cantidad_unidades: l.cantidad_unidades || 0,
        precio_unitario: l.precio_unitario, tipo_base: l.tipo_base, igv_porcentaje: l.igv_porcentaje,
        subtotal: l.subtotal, igv_monto: l.igv_monto, total_linea: l.total_linea
      }
      const r = l.id && _pkEditId ? await update('detalle_packing', l.id, fila) : await insert('detalle_packing', fila)
      if (!r) throw new Error(`No se pudo guardar la línea ${i + 1} (${l.descripcion})`)
    }
    showToast(`${pk.numero} guardado ✅`, 'success')
    window.closeModal('modal-packing')
    if (_pkEditId && Object.keys(_prevFact).length) await recalcularEstadoPacking(pk.id)
    await renderPacking(true)
    if (window._pkFacturarTrasGuardar) { window._pkFacturarTrasGuardar = false; await window.facturarPacking(pk.id) }
  } catch (e) { showToast('Error: ' + e.message, 'danger', 7000) }
  finally { btn.disabled = false }
}

window.anularPacking = async function (id) {
  const pk = _pkLista.find(p => p.id === id)
  if (!pk || !(pk.estado === 'borrador' || pk.estado === 'enviado')) {
    if (pk?.estado === 'parcial') showToast('El PK ya tiene facturas: no se anula. Retira lo pendiente editando el PK.', 'warning', 7000)
    return
  }
  if (!confirm(`¿Anular ${pk.numero}? Queda registrado (no se borra) y ya no se podrá facturar.`)) return
  const r = await update('packing', id, { estado: 'anulado', updated_at: new Date().toISOString() })
  showToast(r ? `${pk.numero} anulado` : 'No se pudo anular', r ? 'success' : 'danger')
  await renderPacking(true)
}

// ─── Anular correlativo sin emitir (formato físico dañado) ───────────────────
// Caso: un juego impreso de PK se moja/rompe ANTES de registrarse en el
// sistema. Se consume ese N° como un PK "anulado" sin cliente ni líneas,
// para que el correlativo no quede como hueco y nunca se reutilice.
// (Si la impresora rompe una hoja de un PK YA registrado, basta con editar
// el N° con el candado — eso no pasa por aquí.)
function _asegurarModalAnularCorr() {
  if (document.getElementById('modal-pk-anular-corr')) return
  const div = document.createElement('div')
  div.id = 'modal-pk-anular-corr'
  div.className = 'modal'
  div.innerHTML = `
    <div class="modal-content" style="width:min(94vw, 560px); max-width:min(94vw, 560px);">
      <div class="modal-header">
        <h3>🚫 Anular correlativo sin emitir</h3>
        <button class="modal-close" onclick="closeModal('modal-pk-anular-corr')">&times;</button>
      </div>
      <div class="modal-body" style="padding:16px 20px;">
        <div style="padding:12px 14px; margin-bottom:14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-warning); font-size:0.88rem; line-height:1.6;">
          <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">Se registrará como anulado</div>
          <div style="font-weight:600; font-size:1.05rem; margin-top:2px;" id="pkAcNumeroPrev">—</div>
          <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">Sin cliente ni productos. El número queda consumido y no se vuelve a usar.</div>
        </div>
        <strong style="${_TIT}">Datos</strong>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
          <div class="form-group"><label>N° PK *</label>
            <input type="number" id="pkAcCorrelativo" min="1" step="1" oninput="window._pkAcPreview()"></div>
          <div class="form-group"><label>Fecha *</label><input type="date" id="pkAcFecha"></div>
          <div class="form-group" style="grid-column:1/-1;"><label>Motivo *</label>
            <input type="text" id="pkAcMotivo" maxlength="200" placeholder="Ej. Juego de formatos mojado en oficina"></div>
          <div class="form-group" style="grid-column:1/-1;"><label>Foto del formato (opcional)</label>
            <input type="file" id="pkAcFoto" accept="image/jpeg,image/png,image/webp,application/pdf">
            <small style="color:var(--text-secondary);">JPG, PNG, WEBP o PDF · máx. 10 MB. Queda como evidencia de la anulación.</small></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal('modal-pk-anular-corr')">Cancelar</button>
        <button class="btn btn-danger" id="pkAcBtn" onclick="window.guardarAnularCorrelativoPK()">🚫 Anular correlativo</button>
      </div>
    </div>`
  document.body.appendChild(div)
}

let _pkAcSerie = null

window._pkAcPreview = function () {
  const n = parseInt(document.getElementById('pkAcCorrelativo').value) || 0
  document.getElementById('pkAcNumeroPrev').textContent = n && _pkAcSerie ? formatearNumero(_pkAcSerie, n) : '—'
}

window.abrirAnularCorrelativoPK = async function () {
  try {
    _asegurarModalAnularCorr()
    _pkAcSerie = await serieDefault('PK')
    if (!_pkAcSerie) { showToast('No hay serie PK configurada', 'warning'); return }
    // Por defecto: el siguiente número (el formato que se dañó suele ser el próximo)
    document.getElementById('pkAcCorrelativo').value = siguienteCorrelativo(_pkAcSerie, await _maxCorrelativoPK(_pkAcSerie.serie))
    document.getElementById('pkAcFecha').value = _hoy()
    document.getElementById('pkAcMotivo').value = ''
    document.getElementById('pkAcFoto').value = ''
    window._pkAcPreview()
    window.openModal('modal-pk-anular-corr')
  } catch (e) { showToast('Error: ' + e.message, 'danger') }
}

window.guardarAnularCorrelativoPK = async function () {
  const btn = document.getElementById('pkAcBtn')
  try {
    const n = parseInt(document.getElementById('pkAcCorrelativo').value) || 0
    const fecha = document.getElementById('pkAcFecha').value
    const motivo = document.getElementById('pkAcMotivo').value.trim()
    if (n < 1) { showToast('Ingresa el N° de PK', 'warning'); return }
    if (!fecha) { showToast('Ingresa la fecha', 'warning'); return }
    if (!motivo) { showToast('Indica el motivo (queda registrado)', 'warning'); return }
    const foto = document.getElementById('pkAcFoto').files?.[0] || null
    if (foto) { const err = validarArchivoAdjunto(foto); if (err) { showToast(err, 'warning'); return } }
    const numero = formatearNumero(_pkAcSerie, n)
    const { data: existe } = await supabase.from('packing').select('id, estado').eq('serie', _pkAcSerie.serie).eq('correlativo', n).limit(1)
    if (existe?.length) { showToast(`${numero} ya existe en el sistema (${existe[0].estado}). Si es un PK registrado, usa Anular en su fila.`, 'warning', 7000); return }
    if (!confirm(`¿Anular ${numero} sin emitir?\n\nMotivo: ${motivo}\n\nEl número queda consumido y no se podrá usar.`)) return
    btn.disabled = true
    const user = getCurrentUser()
    const r = await insert('packing', {
      tipo: 'venta', serie: _pkAcSerie.serie, correlativo: n, numero,
      contact_id: null, fecha_emision: fecha, fecha_validez: null,
      moneda: 'PEN', tipo_cambio: 1, subtotal: 0, igv: 0, total: 0,
      observaciones: `ANULADO SIN EMITIR: ${motivo}`,
      estado: 'anulado', created_by: user?.db_id || null
    })
    if (!r) throw new Error('No se pudo registrar (¿número repetido?)')
    await registrarUsoSerie('PK', _pkAcSerie.serie, n)
    if (foto) {
      const { errores } = await subirAdjuntos('packing', r.id, [{ file: foto, concepto: 'otro' }], user?.db_id || null)
      if (errores.length) showToast(`${numero} anulado, pero la foto no se subió: ${errores.join(' · ')}`, 'warning', 8000)
    }
    showToast(`${numero} anulado ✅`, 'success')
    window.closeModal('modal-pk-anular-corr')
    await renderPacking(true)
  } catch (e) { showToast('Error: ' + e.message, 'danger', 7000) }
  finally { if (btn) btn.disabled = false }
}

/** Elimina un PK ANULADO (sin factura): detalle (cascade), adjuntos y cabecera.
 *  El correlativo NO se libera: series_documentos.ultimo_correlativo ya lo
 *  registró, así que el próximo PK sigue después de él. */
window.eliminarPacking = async function (id) {
  const pk = _pkLista.find(p => p.id === id)
  if (!pk) return
  if (pk.estado !== 'anulado' || pk.venta_id) { showToast('Solo se elimina un PK anulado y sin factura', 'warning'); return }
  if (!confirm(`¿Eliminar definitivamente ${pk.numero}?\n\nSe borran sus líneas y adjuntos. El número NO se reutiliza.`)) return
  try {
    try { await eliminarAdjuntosDe('packing', id) } catch { /* sin adjuntos / tabla */ }
    const ok = await deleteRecord('packing', id)
    if (!ok) throw new Error('No se pudo eliminar (revisa permisos/RLS)')
    showToast(`${pk.numero} eliminado`, 'success')
    await renderPacking(true)
  } catch (e) { showToast('Error: ' + e.message, 'danger', 7000) }
}

/** Abre los adjuntos del PK (bucket privado → URL firmada temporal). */
window.verAdjuntosPacking = async function (id) {
  try {
    const adjs = await getAdjuntos('packing', id)
    if (!adjs?.length) { showToast('Sin adjuntos', 'info'); return }
    for (const a of adjs) {
      const url = await getUrlAdjunto(a.path)
      if (url) window.open(url, '_blank')
    }
  } catch (e) { showToast('No se pudo abrir el adjunto: ' + e.message, 'danger') }
}

// ─── Facturar: abre Nueva Venta precargada (flujo completo de la venta) ──────
// Sub-modal "Facturar PK": por línea Pedido / Facturado / Pendiente / A facturar.
// · A facturar > pendiente (peso real mayor) → el PK se ACTUALIZA con la cantidad real.
// · "Retirar" (ítem que el cliente ya no lleva): sin facturas → se quita del PK;
//   con facturas → el pedido se ajusta a lo ya facturado. Se guarda en el PK.
// · Continuar → Nueva Venta precargada con lo seleccionado (precio editable con aviso).
let _pkFac = null   // { pk, filas: [{ l, fact, pend, sel, aFact, unid, retirar }] }

function _asegurarModalFacturarPK() {
  if (document.getElementById('modal-pk-facturar')) return
  const div = document.createElement('div')
  div.id = 'modal-pk-facturar'
  div.className = 'modal'
  div.innerHTML = `
    <div class="modal-content" style="width:min(96vw, 1100px); max-width:min(96vw, 1100px); max-height:90vh; overflow-y:auto;">
      <div class="modal-header">
        <h3 id="pkFacTitulo">Facturar PK</h3>
        <button class="modal-close" onclick="window.closeModal('modal-pk-facturar')">&times;</button>
      </div>
      <div class="modal-body" style="padding:16px 20px;">
        <div id="pkFacInfo" style="padding:12px 14px; margin-bottom:14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info); font-size:0.88rem; line-height:1.6;"></div>
        <strong style="${_TIT}">Qué facturar ahora</strong>
        <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); overflow:hidden; overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; margin:0;">
            <thead><tr style="background:var(--bg-secondary);">
              <th style="width:40px; padding:8px 10px;"></th>
              <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Producto</th>
              <th style="text-align:right; padding:8px 10px; font-size:0.78rem;">Pedido</th>
              <th style="text-align:right; padding:8px 10px; font-size:0.78rem;">Facturado</th>
              <th style="text-align:right; padding:8px 10px; font-size:0.78rem;">Pendiente</th>
              <th style="text-align:right; padding:8px 10px; font-size:0.78rem; width:140px;">A facturar</th>
              <th style="text-align:right; padding:8px 10px; font-size:0.78rem; width:100px;">N° Unid.</th>
              <th style="text-align:right; padding:8px 10px; font-size:0.78rem;">Precio PK</th>
              <th style="text-align:right; padding:8px 10px; font-size:0.78rem;">Subtotal</th>
              <th style="width:110px; padding:8px 10px;"></th>
            </tr></thead>
            <tbody id="pkFacBody"></tbody>
          </table>
        </div>
        <div id="pkFacResumen" style="margin-top:12px; display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; font-size:0.88rem;"></div>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="window.closeModal('modal-pk-facturar')">Cancelar</button>
        <button class="btn btn-primary" id="pkFacBtn" onclick="window._pkFacContinuar()">Continuar a la factura →</button>
      </div>
    </div>`
  document.body.appendChild(div)
}

window.facturarPacking = async function (id) {
  try {
    const pk = _pkLista.find(p => p.id === id) || (await supabase.from('packing').select('*').eq('id', id).single()).data
    if (!pk) return
    if (pk.estado === 'facturado') { showToast('Este PK ya está facturado por completo', 'warning'); return }
    if (pk.estado === 'anulado') { showToast('PK anulado: no se puede facturar', 'warning'); return }
    const { lineas, porLinea, sinSQL } = await _facturacionPK(pk.id)
    if (sinSQL) { showToast('Falta correr assets/sql/70_packing_facturacion_parcial.sql en Supabase', 'danger', 8000); return }
    if (!lineas.length) { showToast('El PK no tiene líneas', 'warning'); return }
    _asegurarModalFacturarPK()
    _pkFac = {
      pk,
      filas: lineas.map(l => {
        const fact = porLinea[l.id] || 0
        const pend = Math.max(0, (+l.cantidad) - fact)
        const unidPend = (+l.cantidad) > 0 && (+l.cantidad_unidades) ? Math.round((+l.cantidad_unidades) * pend / (+l.cantidad)) : 0
        return { l, fact, pend, sel: pend > _TOL, aFact: +pend.toFixed(3), unid: unidPend, retirar: false }
      })
    }
    const cli = pk._cliente || await _nombreCliente(pk.contact_id)
    const previas = (pk._facturas || []).map(f => f.numero).join(', ')
    document.getElementById('pkFacTitulo').textContent = `Facturar ${pk.numero}`
    document.getElementById('pkFacInfo').innerHTML = `
      <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">Packing</div>
      <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${_esc(pk.numero)} · ${_esc(cli || '')}</div>
      <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">${_esc(pk.moneda)} ${formatNumber(pk.total)} · ${previas ? `Ya facturado en: ${_esc(previas)}` : 'Aún sin facturas'}</div>`
    _pkFacPintar()
    window.openModal('modal-pk-facturar')
  } catch (e) { showToast('Error: ' + e.message, 'danger') }
}

function _pkFacPintar() {
  const tb = document.getElementById('pkFacBody')
  if (!tb || !_pkFac) return
  const mon = _pkFac.pk.moneda === 'USD' ? '$' : 'S/'
  tb.innerHTML = _pkFac.filas.map((f, i) => {
    const l = f.l
    const completa = f.pend <= _TOL
    const sub = f.sel && !f.retirar ? _calcLinea(f.aFact || 0, +l.precio_unitario, l.tipo_base || 'gravada').subtotal : 0
    const exceso = f.sel && !f.retirar && f.aFact > f.pend + _TOL
    const estilo = f.retirar ? 'opacity:.5; text-decoration:line-through;' : (completa ? 'opacity:.6;' : '')
    return `<tr style="border-top:1px solid var(--border-color); ${estilo}">
      <td style="padding:8px 10px; text-align:center;">
        <input type="checkbox" ${f.sel && !f.retirar ? 'checked' : ''} ${completa || f.retirar ? 'disabled' : ''} onchange="window._pkFacSel(${i}, this.checked)"
               style="width:18px; height:18px; margin:0; accent-color:var(--color-info);"></td>
      <td style="padding:8px 10px;">${_esc(l.descripcion)}${l.nota ? `<br><small style="color:var(--text-secondary);">${_esc(l.nota)}</small>` : ''}</td>
      <td style="padding:8px 10px; text-align:right;">${formatNumber(l.cantidad)} ${_esc(l.unidad_medida)}</td>
      <td style="padding:8px 10px; text-align:right; color:var(--color-success);">${f.fact ? formatNumber(f.fact) : '—'}</td>
      <td style="padding:8px 10px; text-align:right; color:var(--color-warning); font-weight:600;">${completa ? '✓' : formatNumber(f.pend)}</td>
      <td style="padding:8px 10px;">
        <input type="number" step="0.001" min="0" value="${f.aFact}" ${!f.sel || f.retirar || completa ? 'disabled' : ''}
               oninput="window._pkFacCant(${i}, this.value)" style="width:100%; text-align:right;">
        ${exceso ? `<small style="color:var(--color-info); display:block; line-height:1.2;">El PK se actualizará a ${formatNumber(f.fact + f.aFact)} (cantidad real)</small>` : ''}
      </td>
      <td style="padding:8px 10px;">
        <input type="number" step="1" min="0" value="${f.unid || 0}" ${!f.sel || f.retirar || completa ? 'disabled' : ''}
               oninput="window._pkFacUnid(${i}, this.value)" style="width:100%; text-align:right;"></td>
      <td style="padding:8px 10px; text-align:right;">${(+l.precio_unitario).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
      <td style="padding:8px 10px; text-align:right; font-weight:600;">${sub ? formatNumber(sub) : '—'}</td>
      <td style="padding:8px 10px; text-align:center;">
        ${completa ? '' : `<button type="button" class="btn btn-small ${f.retirar ? 'btn-secondary' : 'btn-danger'}" onclick="window._pkFacRetirar(${i})"
           title="${f.fact > _TOL ? 'El cliente no lleva el resto: el pedido se ajusta a lo ya facturado' : 'El cliente ya no lleva este ítem: se retira del PK'}">${f.retirar ? '↩ Deshacer' : (f.fact > _TOL ? '✕ Retirar saldo' : '✕ Retirar')}</button>`}
      </td></tr>`
  }).join('')
  const selec = _pkFac.filas.filter(f => f.sel && !f.retirar && f.aFact > 0)
  const base = selec.reduce((s, f) => s + _calcLinea(f.aFact, +f.l.precio_unitario, f.l.tipo_base || 'gravada').subtotal, 0)
  const total = selec.reduce((s, f) => s + _calcLinea(f.aFact, +f.l.precio_unitario, f.l.tipo_base || 'gravada').total_linea, 0)
  const cambios = _pkFac.filas.filter(f => f.retirar || (f.sel && f.aFact > f.pend + _TOL)).length
  document.getElementById('pkFacResumen').innerHTML = `
    <span style="color:var(--text-secondary);">${selec.length} línea(s) a facturar${cambios ? ` · <strong style="color:var(--color-info);">${cambios} cambio(s) se guardarán en el PK</strong>` : ''}</span>
    <span>Base ${mon} <strong>${formatNumber(base)}</strong> · Total ${mon} <strong style="color:var(--color-success);">${formatNumber(total)}</strong></span>`
}

window._pkFacSel = (i, v) => { _pkFac.filas[i].sel = v; _pkFacPintar() }
window._pkFacUnid = (i, v) => { _pkFac.filas[i].unid = parseFloat(v) || 0 }
window._pkFacCant = (i, v) => {
  const f = _pkFac.filas[i]
  f.aFact = Math.max(0, parseFloat(v) || 0)
  // N° unidades sugerido en proporción
  if ((+f.l.cantidad) > 0 && (+f.l.cantidad_unidades)) f.unid = Math.round((+f.l.cantidad_unidades) * f.aFact / (+f.l.cantidad))
  clearTimeout(window._tPkFac); window._tPkFac = setTimeout(_pkFacPintar, 400)
}
window._pkFacRetirar = (i) => { const f = _pkFac.filas[i]; f.retirar = !f.retirar; if (f.retirar) f.sel = false; else f.sel = f.pend > _TOL; _pkFacPintar() }

window._pkFacContinuar = async function () {
  const btn = document.getElementById('pkFacBtn')
  if (!_pkFac || btn.disabled) return
  const { pk, filas } = _pkFac
  const selec = filas.filter(f => f.sel && !f.retirar && f.aFact > _TOL)
  const retiros = filas.filter(f => f.retirar)
  const excesos = selec.filter(f => f.aFact > f.pend + _TOL)
  if (!selec.length && !retiros.length) { showToast('Marca al menos una línea con cantidad a facturar', 'warning'); return }
  const resumen = [
    ...retiros.map(f => f.fact > _TOL
      ? `• ${f.l.descripcion}: pedido ${formatNumber(f.l.cantidad)} → ${formatNumber(f.fact)} (se retira el saldo)`
      : `• ${f.l.descripcion}: se RETIRA del PK`),
    ...excesos.map(f => `• ${f.l.descripcion}: pedido ${formatNumber(f.l.cantidad)} → ${formatNumber(f.fact + f.aFact)} (cantidad real)`)
  ]
  if (resumen.length && !confirm(`Se actualizará ${pk.numero}:\n\n${resumen.join('\n')}\n\n¿Confirmar?`)) return
  btn.disabled = true
  try {
    // 1) Cambios al PK (se guardan antes de facturar)
    for (const f of retiros) {
      if (f.fact > _TOL) {
        const r = await update('detalle_packing', f.l.id, _lineaConCantidad(f.l, f.fact))
        if (!r) throw new Error(`No se pudo ajustar ${f.l.descripcion}`)
      } else {
        const { error } = await supabase.from('detalle_packing').delete().eq('id', f.l.id)
        if (error) throw new Error(`No se pudo retirar ${f.l.descripcion}: ${error.message}`)
      }
    }
    for (const f of excesos) {
      const r = await update('detalle_packing', f.l.id, _lineaConCantidad(f.l, f.fact + f.aFact))
      if (!r) throw new Error(`No se pudo actualizar ${f.l.descripcion}`)
    }
    if (resumen.length) { await _recalcularTotalesPK(pk.id); await recalcularEstadoPacking(pk.id) }
    window.closeModal('modal-pk-facturar')
    if (!selec.length) { showToast(`${pk.numero} actualizado ✅`, 'success'); return }

    // 2) Nueva Venta precargada con lo seleccionado (enlazado línea a línea)
    const lineas = selec.map(f => ({
      ...f.l,
      detalle_packing_id: f.l.id,
      precio_pk: +f.l.precio_unitario,
      cantidad: +f.aFact.toFixed(3),
      cantidad_unidades: f.unid || 0,
      ..._calcLinea(f.aFact, +f.l.precio_unitario, f.l.tipo_base || 'gravada')
    }))
    const pkFresco = (await supabase.from('packing').select('*').eq('id', pk.id).single()).data || pk
    await window.abrirNuevaVentaDesdePacking?.(pkFresco, lineas)
  } catch (e) { showToast('Error: ' + e.message, 'danger', 8000) }
  finally { btn.disabled = false }
}

// Lo llama venta-nueva.js cuando la factura se guardó bien.
/** Tras guardar una factura desde el PK: si alguna línea se facturó por ENCIMA
 *  de lo pedido (peso real), el PK toma la cantidad real; luego se recalcula
 *  el estado (parcial / facturado). */
export async function marcarPackingFacturado(packingId, ventaId) {
  try {
    const { lineas, porLinea, sinSQL } = await _facturacionPK(packingId)
    if (sinSQL) {   // sin sql/70: comportamiento anterior (1 PK → 1 factura)
      await update('packing', packingId, { estado: 'facturado', venta_id: ventaId, updated_at: new Date().toISOString() })
    } else {
      let cambio = false
      for (const l of lineas) {
        const f = porLinea[l.id] || 0
        if (f > (+l.cantidad) + _TOL) { await update('detalle_packing', l.id, _lineaConCantidad(l, f)); cambio = true }
      }
      if (cambio) await _recalcularTotalesPK(packingId)
      await recalcularEstadoPacking(packingId)
    }
  } catch (e) { console.warn('No se pudo actualizar el PK tras facturar:', e) }
  if (document.getElementById('tabla-packing-body')) await renderPacking(true)
  return true
}

// ─── PDF (formato "Orden de Venta" de Odoo) ──────────────────────────────────
const _U = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE', 'VEINTIUNO', 'VEINTIDÓS', 'VEINTITRÉS', 'VEINTICUATRO', 'VEINTICINCO', 'VEINTISÉIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE']
const _D = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA']
const _C = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS']
function _menorMil(n) {
  if (n === 0) return ''
  if (n === 100) return 'CIEN'
  const c = Math.floor(n / 100), r = n % 100
  const dec = r < 30 ? _U[r] : _D[Math.floor(r / 10)] + (r % 10 ? ' Y ' + _U[r % 10] : '')
  return [_C[c], dec].filter(Boolean).join(' ')
}
export function numeroALetras(monto, moneda = 'PEN') {
  const redondo = Math.round((+monto || 0) * 100)
  const entero = Math.floor(redondo / 100), cent = redondo % 100
  const mill = Math.floor(entero / 1e6), miles = Math.floor((entero % 1e6) / 1000), resto = entero % 1000
  const partes = []
  if (mill) partes.push(mill === 1 ? 'UN MILLÓN' : `${_menorMil(mill).replace(/UNO$/, 'UN')} MILLONES`)
  if (miles) partes.push(miles === 1 ? 'MIL' : `${_menorMil(miles).replace(/UNO$/, 'UN')} MIL`)
  if (resto) partes.push(_menorMil(resto))
  const mon = moneda === 'USD' ? 'DÓLARES' : 'SOLES'
  return `${partes.join(' ') || 'CERO'} ${mon} Y ${cent ? _menorMil(cent) : 'CERO'} CENTAVOS`
}

window.imprimirPacking = async function (id) {
  try {
    const pk = _pkLista.find(p => p.id === id)
    if (!pk) return
    const w = window.open('', '_blank')   // se abre ANTES de los await: si no, el navegador lo bloquea
    if (!w) { showToast('El navegador bloqueó la ventana del PDF: permite ventanas emergentes', 'warning'); return }
    const [lineas, cliente] = await Promise.all([_getDetalle(pk.id), getContactById(pk.contact_id)])
    if (!_pkTerminos.length) _pkTerminos = (await getTerminosPago()) || []
    const termino = _pkTerminos.find(t => t.id === pk.termino_pago_id)?.nombre || '—'
    const sim = pk.moneda === 'USD' ? '$' : 'S/'
    const f = n => `${sim} ${formatNumber(n)}`
    const base = new URL('.', location.href).href
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${_esc(pk.numero)}</title><base href="${base}">
<style>
  @page { size: A4; margin: 14mm; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color:#111; }
  .top { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
  .logo { width:210px; font-size:28px; font-weight:bold; letter-spacing:2px; }
  .emp { flex:1; font-size:10px; line-height:1.45; }
  .doc { border:1px solid #333; border-radius:10px; padding:10px 18px; text-align:center; min-width:210px; font-size:12px; }
  .doc b { display:block; font-size:13px; }
  .box { border:1px solid #333; border-radius:10px; padding:8px 12px; margin-top:16px; display:grid; grid-template-columns:90px 1fr 110px 1fr; gap:4px 8px; font-size:10px; }
  .box .k { font-weight:bold; }
  table.l { width:100%; border-collapse:collapse; margin-top:16px; }
  table.l th { background:#2f6db5; color:#fff; padding:6px; font-size:11px; border:1px solid #2f6db5; }
  table.l td { border:1px solid #bbb; padding:5px 6px; }
  .r { text-align:right; } .c { text-align:center; } .nota td { font-style:italic; }
  .tot { width:48%; margin-left:auto; border-collapse:collapse; margin-top:10px; }
  .tot td { border:1px solid #bbb; padding:6px 8px; } .tot td:first-child { color:#2f6db5; font-weight:bold; }
  .tot tr.t td { background:#2f6db5; color:#fff; font-weight:bold; }
  .letras { font-weight:bold; margin-top:14px; }
</style></head><body>
  <div class="top">
    <div class="logo"><img src="${EMPRESA.logo}" alt="JHIRO" style="width:200px; max-height:70px; object-fit:contain;" onerror="this.replaceWith(document.createTextNode('JHIRO'))"></div>
    <div class="emp"><b>${EMPRESA.nombre}</b><br>${EMPRESA.direccion}<br><b>Email:</b> ${EMPRESA.email}<br><b>Teléfono:</b> ${EMPRESA.telefono}<br><b>Sitio web:</b> ${EMPRESA.web}</div>
    <div class="doc"><b>Orden de Venta</b>RUC ${EMPRESA.ruc}<br><span style="font-size:14px;">${_esc(pk.numero)}</span></div>
  </div>
  <div class="box">
    <span class="k">CLIENTE</span><span>${_esc(cliente?.nombre || '')}<br>RUC : ${_esc(cliente?.nro_documento || '')}</span>
    <span class="k">TÉRMINO PAGO</span><span>${_esc(termino)}</span>
    <span class="k">DIRECCIÓN</span><span>${_esc(cliente?.direccion || '')}</span>
    <span class="k">VENDEDOR</span><span>${_esc(_nombreVendedor(pk.vendedor_id))}</span>
    <span class="k">F. EMISIÓN</span><span>${_esc(pk.fecha_emision)}</span>
    <span class="k">ORDEN DE COMPRA</span><span>${_esc(pk.orden_compra_cliente || '')}</span>
    <span class="k">F. VALIDEZ</span><span>${_esc(pk.fecha_validez || '')}</span>
    <span class="k">MONEDA</span><span>${pk.moneda === 'USD' ? 'DÓLARES' : 'SOLES'}</span>
  </div>
  <table class="l"><thead><tr><th>Descripción</th><th>Cantidad</th><th>UdM</th><th>Precio unitario</th><th>Total</th></tr></thead><tbody>
    ${lineas.map(l => `<tr><td>${_esc(l.descripcion)}</td><td class="c">${formatNumber(l.cantidad)}</td><td class="c">${_esc((l.unidad_medida || '').toLowerCase())}</td>
      <td class="c">${sim} ${(+l.precio_unitario).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td><td class="r">${f(l.subtotal)}</td></tr>
      ${l.nota ? `<tr class="nota"><td colspan="5">${_esc(l.nota)}</td></tr>` : ''}`).join('')}
    ${pk.observaciones ? `<tr class="nota"><td colspan="5">${_esc(pk.observaciones).replace(/\n/g, '<br>')}</td></tr>` : ''}
  </tbody></table>
  <div class="letras">SON: ${numeroALetras(pk.total, pk.moneda)}</div>
  <table class="tot"><tr><td>OP. GRAVADA</td><td class="r">${f(pk.subtotal)}</td></tr>
    <tr><td>IGV 18%</td><td class="r">${f(pk.igv)}</td></tr><tr class="t"><td>TOTAL</td><td class="r">${f(pk.total)}</td></tr></table>
  <p style="margin-top:18px;">Términos de pago: ${_esc(termino)}</p>
  <script>window.onload = () => setTimeout(() => window.print(), 300)<\/script>
</body></html>`
    w.document.open(); w.document.write(html); w.document.close()
    if (pk.estado === 'borrador') {
      await update('packing', pk.id, { estado: 'enviado', updated_at: new Date().toISOString() })
      await renderPacking(true)
    }
  } catch (e) { showToast('Error al generar PDF: ' + e.message, 'danger') }
}
