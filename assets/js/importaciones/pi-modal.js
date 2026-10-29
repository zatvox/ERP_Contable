// ============================================================================
// pi-modal.js — Ver / Editar la Proforma (PI) desde la carpeta de importación
// ============================================================================
// Estándar Ver (ojito) → Editar: abre en modo lectura; "✏️ Editar" habilita.
// Editable: N° de PI, fecha y los datos de embarque/pago/plazos. NO editable
// aquí: proveedor, moneda, total y líneas (se cambian en Compras → Órdenes de
// Compra), el estado (Confirmar Proforma) y el incoterm cuando ya hay CI (se
// cambia en "Editar CI" para no descuadrar el desglose de flete y seguro).
// ============================================================================
import { query, update, esperarContextoEmpresa } from '../supabase-client.js'
import { showToast, formatNumber, fechaDMY } from '../helpers.js'
import { aplicarModoVerEditar } from '../shared/ver-editar.js'
import { validarCamposPI } from './pi-validaciones.js'

const MODAL = 'modal-ver-pi'
const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CIP', 'CPT', 'DAP', 'DDP']
// [id, columna, etiqueta, tipo]
const CAMPOS = [
  ['piNumero', 'numero_proforma_proveedor', 'N° de Proforma *', 'text'],
  ['piFecha', 'fecha', 'Fecha de la proforma *', 'date'],
  ['piPuertoEmb', 'puerto_embarque', 'Puerto de embarque', 'text'],
  ['piPuertoDest', 'puerto_destino', 'Puerto de destino', 'text'],
  ['piPais', 'pais_origen', 'País de origen', 'text'],
  ['piMarca', 'marca', 'Marca', 'text'],
  ['piAnticipo', 'anticipo_porcentaje', 'Anticipo (%)', 'number'],
  ['piTolerancia', 'tolerancia_porcentaje', 'Tolerancia cantidad (%)', 'number'],
  ['piDiasAnt', 'dias_validez_anticipo', 'Plazo para pagar el anticipo (días)', 'number'],
  ['piDiasEmb', 'dias_embarque', 'Plazo de embarque (días desde el anticipo)', 'number'],
  ['piEntrega', 'entrega_pactada', 'Entrega pactada (ej. JULIO 2026)', 'text'],
  ['piDiasSaldo', 'dias_saldo_desde_bl', 'Saldo: días desde el B/L', 'number'],
  ['piValidez', 'validez_oferta', 'Validez de la oferta (hasta)', 'date']
]
const SQL99 = ['entrega_pactada', 'dias_saldo_desde_bl', 'validez_oferta']
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
let _pi = null, _tieneCI = false

function _asegurarModal() {
  if (document.getElementById(MODAL)) return
  document.body.insertAdjacentHTML('beforeend', `
  <div id="${MODAL}" class="modal">
    <div class="modal-content" style="width:min(94vw, 900px); max-width:min(94vw, 900px); max-height:90vh; overflow-y:auto;">
      <div class="modal-header"><h3 class="modal-title" id="piTitulo">Proforma</h3>
        <button class="modal-close" onclick="closeModal('${MODAL}')">✕</button></div>
      <div style="padding:16px 20px;">
        <div id="piInfo" style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info); font-size:0.88rem; line-height:1.6; margin-bottom:14px;"></div>
        <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px;">
          ${CAMPOS.map(([i, , l, t]) => `<div class="form-group"><label>${l}</label><input type="${t}" id="${i}" ${t === 'number' ? 'step="1" min="0"' : ''}></div>`).join('')}
          <div class="form-group"><label>Incoterm</label>
            <select id="piIncoterm">${INCOTERMS.map(i => `<option value="${i}">${i}</option>`).join('')}</select></div>
        </div>
        <div id="piLineas"></div>
        <small id="piNota" style="display:block; margin-top:10px; color:var(--text-secondary);"></small>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-solo-lectura onclick="closeModal('${MODAL}')">Cerrar</button>
        <button class="btn btn-primary" data-solo-lectura onclick="window.activarEdicionPI()">✏️ Editar</button>
        <button class="btn btn-secondary" data-solo-edicion onclick="window.verPI()">Cancelar</button>
        <button class="btn btn-primary" data-solo-edicion onclick="window.guardarPI()">💾 Guardar</button>
      </div>
    </div>
  </div>`)
}

/** Abre la PI en modo lectura. Sin id, reabre la última (Cancelar). */
window.verPI = async function (id) {
  try {
    await esperarContextoEmpresa()
    const ocId = id || _pi?.id
    if (!ocId) { showToast('Esta carpeta no tiene Proforma enlazada', 'warning'); return }
    const oc = ((await query('orden_compra', { id: ocId })) || [])[0]
    if (!oc) { showToast('Proforma no encontrada', 'warning'); return }
    const prov = oc.contact_id ? ((await query('contacts', { id: oc.contact_id })) || [])[0] : null
    const carpeta = window.carpetaActual
    _pi = oc
    _tieneCI = !!(carpeta?.comercial_invoice_id)
    _asegurarModal()
    document.getElementById('piTitulo').textContent = `Proforma ${oc.numero_proforma_proveedor || oc.numero}`
    document.getElementById('piInfo').innerHTML = `
      <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">Proforma · ${esc(oc.estado || 'borrador')}</div>
      <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${esc(oc.numero_proforma_proveedor || oc.numero)} · ${esc(oc.currency || oc.moneda || 'USD')} ${formatNumber(oc.total_oc || 0, 2)}</div>
      <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">${esc(prov?.nombre || '—')}${carpeta ? ` · Carpeta ${esc(carpeta.numero_carpeta)}` : ''}</div>`
    for (const [i, c] of CAMPOS) document.getElementById(i).value = oc[c] ?? ''
    document.getElementById('piIncoterm').value = oc.incoterm || 'CIF'
    document.getElementById('piNota').textContent = (_tieneCI
      ? 'El incoterm se cambia desde "Editar CI" (ahí se guarda el desglose de flete y seguro). '
      : '') + 'Proveedor, moneda, total y líneas se cambian en Compras → Órdenes de Compra; el estado con "Confirmar Proforma".'
    const lh = document.getElementById('piLineas'); if (lh) lh.innerHTML = (window.hcLineasDoc?.('pi') || '') + `<div data-pg-doc="oc_anticipo" data-pg-id="${oc.id}" data-pg-tit="Pago del anticipo">${window.pagosBloqueHtml?.('oc_anticipo', oc.id, 'Pago del anticipo') || ''}</div>`
    window.openModal(MODAL)
    aplicarModoVerEditar(MODAL, true)
  } catch (e) { console.error('verPI:', e); showToast('No se pudo abrir la Proforma', 'danger') }
}

window.activarEdicionPI = function () {
  aplicarModoVerEditar(MODAL, false)
  document.getElementById('piIncoterm').disabled = _tieneCI
  document.getElementById('piTitulo').textContent = `Editar Proforma ${_pi?.numero_proforma_proveedor || _pi?.numero || ''}`
}

window.guardarPI = async function () {
  try {
    if (!_pi) return
    const datos = {}
    for (const [i, c, , t] of CAMPOS) {
      const val = document.getElementById(i).value.trim()
      datos[c] = val === '' ? null : (t === 'number' ? parseFloat(val) : val)
    }
    datos.incoterm = document.getElementById('piIncoterm').value || _pi.incoterm
    if (!datos.numero_proforma_proveedor) { showToast('El N° de Proforma es obligatorio', 'warning'); return }
    if (!datos.fecha) { showToast('La fecha de la proforma es obligatoria', 'warning'); return }
    const err = validarCamposPI({ ...datos, flete_estimado: _pi.flete_estimado, seguro_estimado: _pi.seguro_estimado }, datos.fecha)
    if (err) { showToast(err, 'warning'); return }
    // La fecha de la PI no puede ser posterior al Commercial Invoice de la carpeta
    const ci = window.costeoActual
    if (ci?.fecha && datos.fecha > String(ci.fecha).slice(0, 10)) { showToast('La fecha de la proforma no puede ser posterior a la del Commercial Invoice', 'warning'); return }
    // Misma PI del mismo proveedor no puede repetirse
    const otras = (await query('orden_compra', { es_importacion: true })) || []
    const dup = otras.find(o => o.id !== _pi.id && o.contact_id === _pi.contact_id &&
      String(o.numero_proforma_proveedor || '').trim().toUpperCase() === datos.numero_proforma_proveedor.toUpperCase())
    if (dup) { showToast(`Ya existe la proforma ${datos.numero_proforma_proveedor} de este proveedor (OC ${dup.numero || dup.id})`, 'warning'); return }

    let ok = await update('orden_compra', _pi.id, datos)
    if (!ok) {   // sin el SQL 99 faltan 3 columnas: guardar el resto
      const reducido = { ...datos }; for (const k of SQL99) delete reducido[k]
      ok = await update('orden_compra', _pi.id, reducido)
      if (ok) showToast('Guardado, pero faltan 3 campos del SQL 99 (entrega, saldo, validez). Córrelo y vuelve a completar.', 'warning')
    }
    if (!ok) { showToast('No se pudo guardar la Proforma', 'danger'); return }
    showToast('Proforma actualizada', 'success')
    _pi = { ..._pi, ...datos }
    await window.verPI(_pi.id)            // vuelve a modo lectura con lo guardado
    await window.renderHojaCosteo?.()     // refresca la hoja
    await window.cargarImportacionesList?.()
  } catch (e) { console.error('guardarPI:', e); showToast('Error al guardar la Proforma', 'danger') }
}

export default { verPI: window.verPI }
