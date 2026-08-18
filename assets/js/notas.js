// ============================================================================
// NOTAS.JS — Notas de Crédito (07) y Notas de Débito (08)
// ============================================================================
// Módulo compartido por Ventas (notas emitidas) y Compras (notas recibidas).
// Aporta el catálogo de motivos SUNAT, el modal común y las utilidades de
// signo que usan los reportes.
//
// REGLA DE SIGNO — la más importante de todo el archivo:
//   Los importes se guardan SIEMPRE POSITIVOS (los CHECK de la BD exigen
//   total >= 0). El signo es contextual:
//     tipo '07' (Nota de Crédito) → RESTA  (−1)
//     tipo '08' (Nota de Débito)  → SUMA   (+1)
//     el resto (factura, boleta)  → SUMA   (+1)
//   Cualquier reporte que sume importes debe multiplicar por signoDocumento(),
//   o mostrará una NC como si hubieras vendido más.
// ============================================================================

import { supabase } from './supabase-client.js'
import { getCurrentUser } from './auth-supabase.js'

export const TIPO_NC = '07'
export const TIPO_ND = '08'

/** +1 suma, −1 resta. Ver la nota de arriba. */
export function signoDocumento(tipoComprobante) {
  return String(tipoComprobante) === TIPO_NC ? -1 : 1
}

export function esNota(tipoComprobante) {
  const t = String(tipoComprobante)
  return t === TIPO_NC || t === TIPO_ND
}

export function nombreTipoComprobante(tipo) {
  return ({ '01': 'Factura', '03': 'Boleta', '07': 'Nota de Crédito', '08': 'Nota de Débito' })[String(tipo)] || (tipo || '-')
}

export function etiquetaCortaTipo(tipo) {
  return ({ '01': 'Factura', '03': 'Boleta', '07': 'N. Crédito', '08': 'N. Débito' })[String(tipo)] || (tipo || '-')
}

// ============================================================================
// CATÁLOGO DE MOTIVOS
// ============================================================================
// Se lee de la tabla `motivos_nota`. Si la tabla aún no existe (script 35 sin
// correr) se cae a un catálogo local para que la pantalla no quede rota: el
// usuario ve el error real al guardar, no un modal vacío sin explicación.

const MOTIVOS_FALLBACK = [
  { tipo_nota: '07', codigo: '01', descripcion: 'Anulación de la operación',              anula_total: true },
  { tipo_nota: '07', codigo: '02', descripcion: 'Anulación por error en el RUC',          anula_total: true },
  { tipo_nota: '07', codigo: '03', descripcion: 'Corrección por error en la descripción', anula_total: false },
  { tipo_nota: '07', codigo: '04', descripcion: 'Descuento global',                       anula_total: false },
  { tipo_nota: '07', codigo: '05', descripcion: 'Descuento por ítem',                     anula_total: false },
  { tipo_nota: '07', codigo: '06', descripcion: 'Devolución total',                       anula_total: true },
  { tipo_nota: '07', codigo: '07', descripcion: 'Devolución por ítem',                    anula_total: false },
  { tipo_nota: '07', codigo: '08', descripcion: 'Bonificación',                           anula_total: false },
  { tipo_nota: '07', codigo: '09', descripcion: 'Disminución en el valor',                anula_total: false },
  { tipo_nota: '07', codigo: '10', descripcion: 'Otros conceptos',                        anula_total: false },
  { tipo_nota: '08', codigo: '01', descripcion: 'Intereses por mora',                     anula_total: false },
  { tipo_nota: '08', codigo: '02', descripcion: 'Aumento en el valor',                    anula_total: false },
  { tipo_nota: '08', codigo: '03', descripcion: 'Penalidades / otros conceptos',          anula_total: false }
]

let _motivosCache = null

export async function getMotivosNota(tipoNota) {
  if (!_motivosCache) {
    try {
      const { data, error } = await supabase
        .from('motivos_nota').select('*').eq('activo', true).order('codigo')
      _motivosCache = (error || !data?.length) ? MOTIVOS_FALLBACK : data
    } catch (e) {
      console.warn('motivos_nota no disponible, usando catálogo local:', e.message)
      _motivosCache = MOTIVOS_FALLBACK
    }
  }
  return _motivosCache.filter(m => m.tipo_nota === tipoNota)
}

// ============================================================================
// MODAL COMÚN
// ============================================================================

let _onEmitirActual = null
let _motivosActuales = []
let _maxImporteActual = 0

function _asegurarModal() {
  if (document.getElementById('modal-nota-cd')) return
  const div = document.createElement('div')
  div.id = 'modal-nota-cd'
  div.className = 'modal'
  div.innerHTML = `
    <div class="modal-content" style="max-width:620px;">
      <div class="modal-header">
        <h3 class="modal-title" id="nota-titulo">Nota</h3>
        <button class="modal-close" onclick="window.cerrarModalNota()">&times;</button>
      </div>
      <div style="padding:20px; display:flex; flex-direction:column; gap:14px;">
        <div id="nota-origen" style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info);"></div>
        <div id="nota-bloqueo" style="display:none; padding:12px 14px; border-radius:var(--radius-md); background:rgba(239,68,68,.12); color:var(--color-danger); font-size:0.87rem; line-height:1.5;"></div>

        <div id="nota-formulario">
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
            <div class="form-group">
              <label>Motivo SUNAT *</label>
              <select id="notaMotivo" onchange="window.onCambiarMotivoNota()"></select>
            </div>
            <div class="form-group">
              <label>Fecha de emisión *</label>
              <input type="date" id="notaFecha">
            </div>
          </div>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
            <div class="form-group">
              <label>Serie</label>
              <input type="text" id="notaSerie" placeholder="Ej: FC01">
              <small style="color:var(--text-secondary);">Las notas llevan su propia serie correlativa.</small>
            </div>
            <div class="form-group">
              <label>N° de documento</label>
              <input type="text" id="notaNumero" placeholder="Se sugiere automáticamente">
            </div>
          </div>

          <div class="form-group">
            <label>Importe total de la nota *</label>
            <input type="number" id="notaImporte" step="0.01" min="0.01" placeholder="0.00" oninput="window.onCambiarImporteNota()">
            <small id="nota-importe-ayuda" style="color:var(--text-secondary);"></small>
          </div>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
            <div class="form-group">
              <label>IGV incluido en el importe</label>
              <input type="number" id="notaIgv" step="0.01" min="0" placeholder="0.00">
              <small style="color:var(--text-secondary);">Se calcula solo, pero puedes ajustarlo.</small>
            </div>
            <div class="form-group">
              <label>Base imponible</label>
              <input type="number" id="notaBase" step="0.01" readonly style="background:var(--bg-tertiary);">
            </div>
          </div>

          <div class="form-group">
            <label>Descripción / sustento *</label>
            <input type="text" id="notaDescripcion" placeholder="Detalle de la nota (aparece en el comprobante)">
          </div>

          <div id="nota-aviso-anula" style="display:none; padding:10px 12px; border-radius:var(--radius-md); background:rgba(245,158,11,.14); color:var(--color-warning); font-size:0.85rem; line-height:1.45;"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="window.cerrarModalNota()">Cancelar</button>
        <button class="btn btn-primary" id="notaBtnEmitir" onclick="window.emitirNota()">Emitir nota</button>
      </div>
    </div>`
  document.body.appendChild(div)
}

/**
 * Abre el modal para emitir una nota.
 *
 * @param {object} o
 *   tipoNota    '07' | '08'
 *   contexto    'venta' | 'compra'  (solo cambia los textos)
 *   documento   Etiqueta del comprobante de origen
 *   detalle     Línea secundaria (cliente/proveedor, fecha, total)
 *   totalOrigen Importe del comprobante de origen (tope para una NC)
 *   saldoOrigen Saldo pendiente (informativo)
 *   igvPorcentaje  18 por defecto
 *   serieSugerida  string
 *   numeroSugerido string
 *   bloqueos    string[]
 *   onEmitir    async ({ motivo, motivoTexto, fecha, serie, numero, importe, igv, base, descripcion, anulaTotal }) => void
 */
export async function abrirModalNota(o) {
  _asegurarModal()

  const esNC = o.tipoNota === TIPO_NC
  _motivosActuales = await getMotivosNota(o.tipoNota)
  _maxImporteActual = esNC ? (parseFloat(o.totalOrigen) || 0) : 0

  document.getElementById('nota-titulo').textContent =
    `${esNC ? 'Nota de Crédito' : 'Nota de Débito'} — ${o.contexto === 'compra' ? 'recibida del proveedor' : 'emitida al cliente'}`

  document.getElementById('nota-origen').innerHTML = `
    <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">Modifica el comprobante</div>
    <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${_esc(o.documento || '')}</div>
    ${o.detalle ? `<div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">${_esc(o.detalle)}</div>` : ''}
    <div style="font-size:0.82rem; margin-top:6px;">
      ${esNC
        ? `Esta nota <strong style="color:var(--color-danger);">reduce</strong> el importe del comprobante.`
        : `Esta nota <strong style="color:var(--color-success);">aumenta</strong> el importe del comprobante.`}
    </div>`

  const bloqueos = o.bloqueos || []
  const blo  = document.getElementById('nota-bloqueo')
  const form = document.getElementById('nota-formulario')
  const btn  = document.getElementById('notaBtnEmitir')
  blo.style.display = bloqueos.length ? 'block' : 'none'
  blo.innerHTML = bloqueos.length
    ? `<strong>No se puede emitir la nota:</strong><ul style="margin:6px 0 0 18px; padding:0;">${bloqueos.map(b => `<li>${_esc(b)}</li>`).join('')}</ul>`
    : ''
  form.style.display = bloqueos.length ? 'none' : 'block'
  btn.style.display = bloqueos.length ? 'none' : ''
  btn.disabled = false
  btn.textContent = esNC ? 'Emitir Nota de Crédito' : 'Emitir Nota de Débito'

  const selMotivo = document.getElementById('notaMotivo')
  selMotivo.innerHTML = _motivosActuales
    .map(m => `<option value="${m.codigo}" data-anula="${m.anula_total ? '1' : '0'}">${m.codigo} — ${_esc(m.descripcion)}</option>`)
    .join('')

  _valor('notaFecha', new Date().toISOString().split('T')[0])
  _valor('notaSerie', o.serieSugerida || (esNC ? 'FC01' : 'FD01'))
  _valor('notaNumero', o.numeroSugerido || '')
  _valor('notaDescripcion', '')
  _valor('notaImporte', '')
  _valor('notaIgv', '')
  _valor('notaBase', '')

  document.getElementById('nota-importe-ayuda').textContent = esNC
    ? `Máximo ${_num(o.totalOrigen)} (total del comprobante). Saldo pendiente actual: ${_num(o.saldoOrigen ?? o.totalOrigen)}.`
    : 'Importe adicional que se cobrará sobre el comprobante original.'

  document.getElementById('modal-nota-cd').dataset.igvPct = String(o.igvPorcentaje ?? 18)
  document.getElementById('modal-nota-cd').dataset.tipoNota = o.tipoNota

  _onEmitirActual = o.onEmitir
  window.onCambiarMotivoNota()
  window.openModal('modal-nota-cd')
}

window.cerrarModalNota = function () {
  _onEmitirActual = null
  window.closeModal('modal-nota-cd')
}

window.onCambiarMotivoNota = function () {
  const sel = document.getElementById('notaMotivo')
  const opt = sel?.selectedOptions?.[0]
  const anula = opt?.getAttribute('data-anula') === '1'
  const aviso = document.getElementById('nota-aviso-anula')
  const modal = document.getElementById('modal-nota-cd')
  const esNC = modal?.dataset.tipoNota === TIPO_NC

  if (aviso) {
    aviso.style.display = anula ? 'block' : 'none'
    aviso.textContent = anula
      ? 'Este motivo anula la operación completa: la nota debe emitirse por el TOTAL del comprobante. Se precargó ese importe y, al emitirla, el comprobante de origen quedará marcado como anulado.'
      : ''
  }

  // Si el motivo anula todo, el importe es el total y no se discute.
  if (anula && esNC && _maxImporteActual > 0) {
    _valor('notaImporte', _maxImporteActual.toFixed(2))
    window.onCambiarImporteNota()
  }
  if (opt && !document.getElementById('notaDescripcion').value) {
    _valor('notaDescripcion', opt.textContent.split('—').slice(1).join('—').trim())
  }
}

window.onCambiarImporteNota = function () {
  const modal = document.getElementById('modal-nota-cd')
  const pct = parseFloat(modal?.dataset.igvPct || '18')
  const importe = parseFloat(document.getElementById('notaImporte')?.value || 0)
  if (!(importe > 0)) { _valor('notaIgv', ''); _valor('notaBase', ''); return }

  // El importe que digita el usuario es el TOTAL (con IGV), igual que en el
  // comprobante original. De ahí se desagrega la base y el IGV.
  const base = importe / (1 + pct / 100)
  _valor('notaBase', base.toFixed(2))
  _valor('notaIgv', (importe - base).toFixed(2))
}

window.emitirNota = async function () {
  const btn = document.getElementById('notaBtnEmitir')
  try {
    const sel        = document.getElementById('notaMotivo')
    const opt        = sel?.selectedOptions?.[0]
    const motivo     = sel?.value
    const motivoTexto = opt ? opt.textContent : ''
    const anulaTotal = opt?.getAttribute('data-anula') === '1'
    const fecha      = document.getElementById('notaFecha')?.value
    const serie      = document.getElementById('notaSerie')?.value?.trim()
    const numero     = document.getElementById('notaNumero')?.value?.trim()
    const importe    = parseFloat(document.getElementById('notaImporte')?.value || 0)
    const igv        = parseFloat(document.getElementById('notaIgv')?.value || 0)
    const base       = parseFloat(document.getElementById('notaBase')?.value || 0)
    const descripcion = document.getElementById('notaDescripcion')?.value?.trim()

    if (!motivo)       { window.showToast?.('Selecciona el motivo SUNAT', 'warning'); return }
    if (!fecha)        { window.showToast?.('Indica la fecha de emisión', 'warning'); return }
    if (!(importe > 0)) { window.showToast?.('El importe debe ser mayor a 0', 'warning'); return }
    if (!descripcion)  { window.showToast?.('Escribe la descripción / sustento', 'warning'); return }

    const modal = document.getElementById('modal-nota-cd')
    if (modal?.dataset.tipoNota === TIPO_NC && _maxImporteActual > 0 && importe > _maxImporteActual + 0.01) {
      window.showToast?.(`Una Nota de Crédito no puede superar el total del comprobante (${_num(_maxImporteActual)})`, 'warning')
      return
    }
    if (typeof _onEmitirActual !== 'function') { window.cerrarModalNota(); return }

    if (btn) { btn.disabled = true; btn.textContent = 'Emitiendo…' }
    const user = getCurrentUser()
    await _onEmitirActual({
      motivo, motivoTexto, fecha, serie, numero,
      importe, igv, base, descripcion, anulaTotal,
      usuarioId: user?.db_id || null
    })
    window.cerrarModalNota()
  } catch (e) {
    console.error('emitirNota:', e)
    window.showToast?.('No se pudo emitir la nota: ' + e.message, 'danger')
    if (btn) { btn.disabled = false; btn.textContent = 'Emitir nota' }
  }
}

// ============================================================================
// BADGE PARA LOS LISTADOS
// ============================================================================

export function badgeTipoDocumento(tipo) {
  const t = String(tipo)
  if (t === TIPO_NC) return '<span class="badge badge-danger" title="Nota de Crédito: resta del comprobante que referencia">N. Crédito</span>'
  if (t === TIPO_ND) return '<span class="badge badge-warning" title="Nota de Débito: suma al comprobante que referencia">N. Débito</span>'
  return nombreTipoComprobante(t)
}

function _valor(id, v) { const el = document.getElementById(id); if (el) el.value = v }
function _num(v) { return (parseFloat(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
