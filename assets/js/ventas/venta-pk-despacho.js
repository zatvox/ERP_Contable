// ============================================================================
// ventas/venta-pk-despacho.js — "Packing y despacho" de la FACTURA (2026-11-07)
// ----------------------------------------------------------------------------
// Sección común para Nueva Factura y Editar Factura:
//   · Packing asociado: buscador de PKs del cliente (FK ventas.packing_id) o
//     "Otro N°" para un PK que no está en el ERP (ventas.packing_ref, texto).
//     Toda factura de mercadería debe tener uno de los dos (validación app).
//   · Término de despacho heredado del PK (recoge el cliente / despacho) +
//     dirección, distrito y link de Maps. Se guarda EN LA FACTURA (puede
//     cambiar respecto del PK) y la guía de despacho lo toma de aquí primero.
// SQL 146: ventas.packing_ref, termino_despacho, despacho_direccion,
//          despacho_distrito, despacho_maps_url.
// ============================================================================
import { supabase } from '../supabase-client.js'
import { convertirEnBuscador, refrescarBuscador } from '../buscador-select.js'
import { fechaDMY, formatNumber } from '../helpers.js'

const $ = id => document.getElementById(id)
const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export const PK_OTRO = '__otro'
const _TIT = 'display:block; margin:0 0 8px; color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase; letter-spacing:.03em;'

/** Pinta la sección dentro de #{pfx}PkDespHost (una sola vez). */
export function montarSeccionPkDespacho(pfx) {
  const host = $(`${pfx}PkDespHost`)
  if (!host || host.dataset.montado) return
  host.dataset.montado = '1'
  host.innerHTML = `
    <strong style="${_TIT}">📦 Packing y despacho</strong>
    <div style="display:grid; grid-template-columns:minmax(220px, 1.3fr) minmax(180px, 1fr) minmax(200px, 1.4fr); gap:12px; align-items:start;">
      <div class="form-group" style="margin:0;">
        <label>Packing asociado *</label>
        <div id="${pfx}PkTxtWrap" style="display:none;">
          <input type="text" id="${pfx}PkTxt" readonly style="background:var(--bg-primary); font-weight:600;" title="Heredado del PK que se está facturando">
        </div>
        <div id="${pfx}PkSelWrap">
          <select id="${pfx}PkSel" onchange="window._vpdPkCambio('${pfx}')"><option value="">-- Elige el PK --</option></select>
          <input type="text" id="${pfx}PkRef" placeholder="N° de packing (ej. PK-018350)" style="display:none; margin-top:6px;" maxlength="40">
        </div>
        <small id="${pfx}PkInfo" style="color:var(--text-secondary); font-size:0.72rem;"></small>
      </div>
      <div class="form-group" style="margin:0;">
        <label>Término de despacho</label>
        <select id="${pfx}DespTermino" onchange="window._vpdTermino('${pfx}')">
          <option value="">— Sin definir —</option>
          <option value="recoge_cliente">🏭 Recoge el cliente</option>
          <option value="despacho">🚚 Despacho (llevamos)</option>
        </select>
        <small id="${pfx}DespInfo" style="color:var(--text-secondary); font-size:0.72rem;"></small>
      </div>
      <div id="${pfx}DespDatos" style="display:none; gap:8px; flex-direction:column;">
        <input type="text" id="${pfx}DespDir" placeholder="Dirección de entrega (vacío = la del cliente)">
        <div style="display:grid; grid-template-columns:1fr 1.4fr; gap:8px;">
          <input type="text" id="${pfx}DespDist" placeholder="Distrito">
          <input type="url" id="${pfx}DespMaps" placeholder="Link Google Maps">
        </div>
      </div>
    </div>
    <div id="${pfx}DespAviso" hidden style="margin-top:10px; padding:9px 12px; border-radius:8px; border:1px solid rgba(245,158,11,.45); border-left:4px solid var(--color-warning); background:rgba(245,158,11,.10); font-size:.82rem; line-height:1.45;"></div>`
  convertirEnBuscador(`${pfx}PkSel`, { placeholder: 'Escribe el N° de PK…', sinResultados: 'Ningún PK coincide' })
}

window._vpdTermino = function (pfx) {
  const t = $(`${pfx}DespTermino`)?.value
  const d = $(`${pfx}DespDatos`)
  if (d) d.style.display = t === 'despacho' ? 'flex' : 'none'
  const av = $(`${pfx}DespAviso`)
  if (av) {
    av.hidden = !!t
    av.innerHTML = '⚠ <b style="color:var(--color-warning);">Despacho pendiente:</b> aún no se definió si recoge el cliente o lo llevamos. Puedes guardar la factura así, <b style="color:var(--color-warning);">pero es obligatorio antes de emitir la guía de despacho.</b>'
  }
}
window._vpdPkCambio = function (pfx) {
  const v = $(`${pfx}PkSel`)?.value
  const ref = $(`${pfx}PkRef`)
  if (ref) { ref.style.display = v === PK_OTRO ? '' : 'none'; if (v === PK_OTRO) ref.focus() }
  const opt = $(`${pfx}PkSel`)?.selectedOptions?.[0]
  const info = $(`${pfx}PkInfo`)
  if (info) info.textContent = v === PK_OTRO ? 'PK que no está registrado en el ERP: se guarda solo como referencia.' : (opt?.dataset?.info || '')
  // Elegir un PK del sistema propone su término de despacho (si la factura no tiene uno)
  if (v && v !== PK_OTRO && opt?.dataset?.termino && !$(`${pfx}DespTermino`).value) {
    setDespacho(pfx, { termino: opt.dataset.termino, dir: opt.dataset.dir, dist: opt.dataset.dist, maps: opt.dataset.maps }, 'Propuesto desde el PK elegido.')
  }
}

/** Datos de despacho de una fila de `packing` → formato de la factura. */
export function despachoDePK(pk) {
  if (!pk) return {}
  return {
    termino: pk.termino_despacho || '',
    dir: pk.despacho_usa_dir_cliente === false ? (pk.despacho_direccion || '') : '',
    dist: pk.despacho_distrito || '',
    maps: pk.despacho_maps_url || ''
  }
}

export function setDespacho(pfx, { termino = '', dir = '', dist = '', maps = '' } = {}, nota = '') {
  const s = (id, v) => { const el = $(id); if (el) el.value = v ?? '' }
  s(`${pfx}DespTermino`, termino); s(`${pfx}DespDir`, dir); s(`${pfx}DespDist`, dist); s(`${pfx}DespMaps`, maps)
  const info = $(`${pfx}DespInfo`); if (info) info.textContent = nota
  window._vpdTermino(pfx)
}

/**
 * Carga el buscador de PKs del cliente (misma empresa por el filtro global).
 * actual = { id, numero } para conservar el PK ya asociado aunque no esté en la lista.
 */
export async function cargarPKsCliente(pfx, contactId, { actual = null, ref = '' } = {}) {
  const sel = $(`${pfx}PkSel`)
  if (!sel) return
  let pks = []
  if (contactId) {
    const { data } = await supabase.from('packing')
      .select('id, numero, fecha_emision, total, moneda, estado, termino_despacho, despacho_usa_dir_cliente, despacho_direccion, despacho_distrito, despacho_maps_url')
      .eq('contact_id', contactId).not('estado', 'in', '(cotizacion,anulado)')
      .order('fecha_emision', { ascending: false }).limit(80)
    pks = data || []
  }
  if (actual?.id && !pks.some(p => p.id === actual.id)) pks.unshift({ id: actual.id, numero: actual.numero || `PK #${actual.id}` })
  const EST = { borrador: 'Borrador', enviado: 'Enviado', parcial: 'Parcial', facturado: 'Facturado' }
  sel.innerHTML = '<option value="">-- Elige el PK --</option>' + pks.map(p => {
    const d = despachoDePK(p)
    const info = [p.fecha_emision ? fechaDMY(p.fecha_emision) : '', p.total != null ? `${p.moneda || ''} ${formatNumber(p.total)}` : '', EST[p.estado] || ''].filter(Boolean).join(' · ')
    return `<option value="${p.id}" data-info="${_esc(info)}" data-termino="${_esc(d.termino || '')}" data-dir="${_esc(d.dir || '')}" data-dist="${_esc(d.dist || '')}" data-maps="${_esc(d.maps || '')}">${_esc(p.numero)}${info ? ' — ' + _esc(info) : ''}</option>`
  }).join('') + `<option value="${PK_OTRO}">✍️ Otro N° (no está en el ERP)…</option>`
  sel.value = actual?.id ? String(actual.id) : (ref ? PK_OTRO : '')
  const r = $(`${pfx}PkRef`); if (r) { r.value = ref || ''; r.style.display = sel.value === PK_OTRO ? '' : 'none' }
  refrescarBuscador(`${pfx}PkSel`)
  const info = $(`${pfx}PkInfo`)
  if (info) info.textContent = sel.value === PK_OTRO ? 'PK que no está registrado en el ERP: se guarda solo como referencia.'
    : (sel.selectedOptions[0]?.dataset?.info || (contactId && !pks.length ? 'Este cliente no tiene PKs en el ERP: usa "Otro N°".' : ''))
}

/** Modo: PK fijo (heredado, solo lectura) o buscador. */
export function modoPKFijo(pfx, pk) {
  const fijo = !!pk?.id
  const a = $(`${pfx}PkTxtWrap`), b = $(`${pfx}PkSelWrap`)
  if (a) a.style.display = fijo ? '' : 'none'
  if (b) b.style.display = fijo ? 'none' : ''
  if (fijo) { $(`${pfx}PkTxt`).value = pk.numero || `PK #${pk.id}`; const i = $(`${pfx}PkInfo`); if (i) i.textContent = 'Heredado del PK que se está facturando.' }
}

export function habilitarSeccion(pfx, habilitado) {
  ;[`${pfx}PkSel`, `${pfx}PkRef`, `${pfx}DespTermino`, `${pfx}DespDir`, `${pfx}DespDist`, `${pfx}DespMaps`].forEach(id => { const el = $(id); if (el) el.disabled = !habilitado })
  const inp = $(`${pfx}PkSel`)?.parentElement?.querySelector('.bsq-input'); if (inp) inp.disabled = !habilitado
}

/** { packing_id, packing_ref, termino_despacho, despacho_* } · pkFijo = PK heredado. */
export function leerPkDespacho(pfx, pkFijo = null) {
  const v = $(`${pfx}PkSel`)?.value || ''
  const termino = $(`${pfx}DespTermino`)?.value || null
  const esDesp = termino === 'despacho'
  return {
    packing_id: pkFijo?.id || (v && v !== PK_OTRO ? parseInt(v) : null),
    packing_ref: pkFijo?.id ? null : (v === PK_OTRO ? (($(`${pfx}PkRef`)?.value || '').trim().toUpperCase() || null) : null),
    termino_despacho: termino,
    despacho_direccion: esDesp ? (($(`${pfx}DespDir`)?.value || '').trim() || null) : null,
    despacho_distrito: esDesp ? (($(`${pfx}DespDist`)?.value || '').trim() || null) : null,
    despacho_maps_url: esDesp ? (($(`${pfx}DespMaps`)?.value || '').trim() || null) : null
  }
}

/** Mensaje de error o null. Factura de mercadería: PK del ERP o N° escrito obligatorio. */
export function validarPkDespacho(datos) {
  if (!datos.packing_id && !datos.packing_ref) return 'Indica el Packing asociado: elige el PK del cliente o escribe su N° con "Otro N°".'
  if (datos.packing_ref && datos.packing_ref.length < 3) return 'El N° de packing escrito es demasiado corto.'
  if (datos.despacho_maps_url && !/^https?:\/\//i.test(datos.despacho_maps_url)) return 'El link de Maps debe empezar con https://'
  return null
}
