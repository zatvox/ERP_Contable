// ============================================================================
// ADJUNTOS-CARPETA.JS — El expediente digital de la carpeta de importación
// ============================================================================
// Cada documento del ciclo (Proforma, constancia de transferencia, Commercial
// Invoice, BL, packing list, póliza, certificado de origen, test report, DAM,
// liquidación del agente) se adjunta a la carpeta con su concepto, para que el
// expediente esté completo cuando haya que sustentarlo.
//
// Reusa la infraestructura que ya existe: tabla `adjuntos` + bucket privado
// `tesoreria-adjuntos` con URL firmada (SQL 60, CHECK ampliado en el 86).
//
// Las imágenes se comprimen antes de subir: una foto de celular son 3–8 MB y
// el bucket se llena en meses. Los PDF se suben tal cual.
// ============================================================================

import { query, update, esperarContextoEmpresa } from '../supabase-client.js'
import { getCurrentUser } from '../auth-supabase.js'
import { showToast, formatNumber, fechaDMY } from '../helpers.js'
import { subirAdjuntos, getAdjuntos, getUrlAdjunto, eliminarAdjunto, validarArchivoAdjunto } from '../supabase-data.js'

const kb = b => `${formatNumber((parseFloat(b) || 0) / 1024, 0)} KB`

/** Conceptos del expediente, en el orden del ciclo real. */
export const CONCEPTOS_CARPETA = {
  proforma:        'Proforma Invoice (PI)',
  voucher:         'Constancia de transferencia / pago',
  invoice:         'Commercial Invoice (CI)',
  bl:              'Bill of Lading (BL)',
  packing:         'Packing list',
  poliza:          'Póliza de seguro',
  certificado_origen: 'Certificado de origen',
  ficha_tecnica:   'Ficha técnica',
  dam:             'DAM / DUA',
  dam_completa:    'DAM completa (hojas A, B y DAV)',
  notificacion_aduana: 'Notificación de Aduanas (duda razonable)',
  garantia:        'Orden de depósito de garantía',
  autoliquidacion: 'Autoliquidación (duda razonable)',
  boletin:         'Boletín químico',
  liquidacion:     'Liquidación del agente',
  factura_gasto:   'Factura de gasto',
  rh:              'Recibo por honorarios',
  guia:            'Guía de remisión',
  recibo:          'Recibo',
  otro:            'Otro'
}

let _carpetaId = null
let _carpetaNombre = ''
let _pendientes = []

const carpetaActual = () => window.costeoActual?.carpeta_importacion_id || null

/** Comprime una imagen antes de subirla; los PDF pasan intactos. */
async function _comprimir(file, maxLado = 1600, calidad = 0.7) {
  if (!/^image\//.test(file.type) || file.type === 'image/webp') return file
  try {
    const bitmap = await createImageBitmap(file)
    const escala = Math.min(1, maxLado / Math.max(bitmap.width, bitmap.height))
    if (escala === 1 && file.size < 1024 * 1024) return file
    const w = Math.round(bitmap.width * escala)
    const h = Math.round(bitmap.height * escala)
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h)
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', calidad))
    if (!blob || blob.size >= file.size) return file
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch (e) {
    console.warn('No se pudo comprimir, se sube original:', e)
    return file
  }
}

function _asegurarModal() {
  if (document.getElementById('modal-adjuntos-carpeta')) return
  const opts = Object.entries(CONCEPTOS_CARPETA)
    .map(([k, v]) => `<option value="${k}">${v}</option>`).join('')
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-adjuntos-carpeta" class="modal" data-sin-guardia>
    <div class="modal-content" style="width:min(94vw, 860px); max-width:min(94vw, 860px); max-height:calc(100vh - 48px); overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title" id="acTitulo">Documentos de la carpeta</h3>
        <button class="modal-close" onclick="window.cerrarAdjuntosCarpeta()">&times;</button>
      </div>
      <div style="padding:16px 20px 0;">
        <strong style="display:block; margin-bottom:8px; color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase; letter-spacing:0.03em;">Agregar documento</strong>
        <div style="display:grid; grid-template-columns:1.2fr 2fr; gap:10px; align-items:end;">
          <div class="form-group">
            <label>Tipo de documento</label>
            <select id="acConcepto">${opts}</select>
          </div>
          <div class="form-group">
            <label>Archivo (cualquier tipo, máx. 10 MB)</label>
            <input type="file" id="acArchivos" multiple
                   onchange="window.acArchivosElegidos(this)">
          </div>
        </div>
        <div id="acPendientes" style="font-size:0.85rem; color:var(--text-secondary);"></div>
        <button class="btn btn-primary btn-small" id="acBtnSubir" style="margin-top:8px; display:none;"
                onclick="window.subirAdjuntosCarpeta()">&#11014; Subir</button>

        <hr style="border:none; border-top:1px solid var(--border-color); margin:14px 0;">
        <strong style="display:block; margin-bottom:8px; color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase; letter-spacing:0.03em;">Expediente</strong>
        <div id="acLista" class="table-container"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="window.cerrarAdjuntosCarpeta()">Cerrar</button>
      </div>
    </div>
  </div>`)
}

window.acArchivosElegidos = async function (input) {
  _pendientes = []
  const errores = []
  const lista = document.getElementById('acPendientes')
  if (lista) lista.innerHTML = 'Preparando…'

  const concepto = document.getElementById('acConcepto')?.value || 'otro'
  for (const f of input.files || []) {
    const comprimido = await _comprimir(f)
    const err = validarArchivoAdjunto(comprimido)
    if (err) { errores.push(err); continue }
    _pendientes.push({ file: comprimido, concepto, original: f.size })
  }

  if (lista) {
    lista.innerHTML = [
      ..._pendientes.map(a => {
        const ahorro = a.original > a.file.size
          ? ` <span style="color:var(--color-success);">(comprimido de ${kb(a.original)})</span>` : ''
        return `📎 ${a.file.name} — ${kb(a.file.size)}${ahorro}`
      }),
      ...errores.map(e => `<span style="color:var(--color-danger);">⚠️ ${e}</span>`)
    ].join('<br>')
  }
  const btn = document.getElementById('acBtnSubir')
  if (btn) btn.style.display = _pendientes.length ? '' : 'none'
}

window.subirAdjuntosCarpeta = async function () {
  const btn = document.getElementById('acBtnSubir')
  try {
    if (!_carpetaId) throw new Error('Sin carpeta seleccionada')
    if (!_pendientes.length) throw new Error('Elige al menos un archivo')
    btn.disabled = true; btn.textContent = 'Subiendo…'

    const user = await getCurrentUser()
    const res = await subirAdjuntos('carpeta_importacion', _carpetaId, _pendientes, user?.db_id)
    if (res?.errores?.length) showToast(`${res.ok} subido(s). ${res.errores[0]}`, 'warning')
    else showToast(`${res.ok} documento(s) agregados al expediente`, 'success')

    _pendientes = []
    const inp = document.getElementById('acArchivos'); if (inp) inp.value = ''
    const lista = document.getElementById('acPendientes'); if (lista) lista.innerHTML = ''
    if (btn) btn.style.display = 'none'
    await _pintarLista()
  } catch (e) {
    showToast(e.message || 'No se pudieron subir los documentos', 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬆ Subir' }
  }
}

async function _pintarLista() {
  const cont = document.getElementById('acLista')
  if (!cont) return
  const adjs = await getAdjuntos('carpeta_importacion', _carpetaId)
  if (!adjs.length) {
    cont.innerHTML = `<p style="text-align:center; color:var(--text-secondary); padding:16px;">
      Todavía no hay documentos. Empieza por la Proforma Invoice y la constancia del anticipo.</p>`
    return
  }
  cont.innerHTML = `
    <table class="table">
      <thead><tr><th>Tipo</th><th>Archivo</th><th style="text-align:right">Tamaño</th><th>Subido</th><th>Acciones</th></tr></thead>
      <tbody>
        ${adjs.map(a => `
          <tr>
            <td><select class="form-control" style="min-width:190px; padding:4px 6px;" title="Cambiar el tipo de documento" onchange="window.acCambiarConcepto(${a.id}, this.value)">
              ${Object.entries(CONCEPTOS_CARPETA).map(([k, l]) => `<option value="${k}" ${k === a.concepto ? 'selected' : ''}>${l}</option>`).join('')}
            </select></td>
            <td>${a.nombre}</td>
            <td style="text-align:right">${kb(a.tamano)}</td>
            <td>${fechaDMY(String(a.created_at || '').slice(0, 10))}</td>
            <td>
              <button class="btn btn-small" onclick="window.verAdjuntoCarpeta(${a.id})">👁 Ver</button>
              <button class="btn btn-small btn-danger" onclick="window.borrarAdjuntoCarpeta(${a.id}, '${(a.nombre || '').replace(/'/g, "\\'")}')">✕</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`
}

/** Corrige el tipo de un documento ya subido. */
window.acCambiarConcepto = async function (id, concepto) {
  const ok = await update('adjuntos', id, { concepto })
  if (!ok) { showToast('No se pudo cambiar el tipo de documento', 'danger'); await _pintarLista(); return }
  showToast('Tipo de documento actualizado', 'success')
}

window.verAdjuntoCarpeta = async function (id) {
  try {
    const adjs = await getAdjuntos('carpeta_importacion', _carpetaId)
    const a = adjs.find(x => x.id === id)
    if (!a) return
    const url = await getUrlAdjunto(a.path)
    if (url) window.open(url, '_blank')
  } catch (e) {
    showToast(e.message || 'No se pudo abrir el documento', 'danger')
  }
}

window.borrarAdjuntoCarpeta = async function (id, nombre) {
  if (!confirm(`¿Quitar "${nombre}" del expediente?\n\nSe borra el archivo del bucket y no se puede deshacer.`)) return
  try {
    await eliminarAdjunto(id)
    showToast('Documento eliminado', 'success')
    await _pintarLista()
  } catch (e) {
    showToast(e.message || 'No se pudo eliminar', 'danger')
  }
}

// Los archivos se suben al instante, así que no hay nada que "descartar": cierra directo
// y refresca la hoja para que la lista de documentos marque lo recién adjuntado.
window.cerrarAdjuntosCarpeta = function () {
  window.closeModal('modal-adjuntos-carpeta')
  window.renderHojaCosteo?.()
}

window.abrirAdjuntosCarpeta = async function () {
  await esperarContextoEmpresa()
  _carpetaId = carpetaActual()
  if (!_carpetaId) { showToast('Selecciona primero una carpeta', 'warning'); return }

  const c = ((await query('carpetas_importacion', { id: _carpetaId })) || [])[0]
  _carpetaNombre = c?.numero_carpeta || _carpetaId

  _asegurarModal()
  _pendientes = []
  const inp = document.getElementById('acArchivos'); if (inp) inp.value = ''
  const pend = document.getElementById('acPendientes'); if (pend) pend.innerHTML = ''
  const btn = document.getElementById('acBtnSubir'); if (btn) btn.style.display = 'none'
  const tit = document.getElementById('acTitulo')
  if (tit) tit.textContent = `Documentos de la carpeta ${_carpetaNombre}`

  await _pintarLista()
  window.openModal('modal-adjuntos-carpeta')
}

export default { abrirAdjuntosCarpeta: window.abrirAdjuntosCarpeta, CONCEPTOS_CARPETA }
