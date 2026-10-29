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
  estadia:         'Constancia de estadía (naviera / terminal / SUNAT)',
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
  const d = window.hcUltimo?.d
  const extra = d?.liq?.id ? await getAdjuntos('liquidacion_agente', d.liq.id) : []
  const todos = [...adjs, ...extra]
  const slots = window.hcDocSlots ? window.hcDocSlots(d || {}) : []
  cont.innerHTML = window.acTarjetas(slots, todos, { gestion: true })
}

// ─── Tarjetas de documentos (compartidas: hoja de costeo y modal «Documentos») ──
// Cada tarjeta = un tipo de documento: estado, miniatura clicable (lupa → visor grande),
// nombre como enlace de descarga, y «＋» / arrastrar-y-soltar para adjuntar al instante.
const _fmtKb = b => `${formatNumber((parseFloat(b) || 0) / 1024, 0)} KB`
function _archivoHtml(a, gestion) {
  const opts = gestion ? `<select class="dx-tipo" title="Cambiar el tipo de documento" onchange="window.acCambiarConcepto(${a.id}, this.value)">${Object.entries(CONCEPTOS_CARPETA).map(([k, l]) => `<option value="${k}" ${k === a.concepto ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''
  return `<div class="dx-file"><span class="adj-thumb dx-thumb" data-adj-path="${esc_(a.path)}" data-adj-nombre="${esc_(a.nombre)}">…</span>
    <div class="dx-fx"><a href="#" class="dx-link" title="Descargar ${esc_(a.nombre)}" onclick="event.preventDefault(); window.acDescargar(${a.id})">${esc_(a.nombre)}</a>
    <small>${_fmtKb(a.tamano)} · ${fechaDMY(String(a.created_at || '').slice(0, 10))}</small>${opts}</div>
    ${gestion ? `<button type="button" class="dx-x" title="Quitar" onclick="window.borrarAdjuntoCarpeta(${a.id}, '${(a.nombre || '').replace(/'/g, "\\'")}')">✕</button>` : ''}</div>`
}
const esc_ = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
function _tarjeta(sl, files, gestion) {
  const ok = !!sl.ok || files.length > 0
  const sube = sl.sube ? `window.acSubirA('${sl.sube}')` : (sl.subeFn || '')
  return `<div class="dx-card ${ok ? 'ok' : 'vacio'}" data-tit="${esc_(sl.tit)}" ${sube ? `ondragover="event.preventDefault(); this.classList.add('dx-drop')" ondragleave="this.classList.remove('dx-drop')" ondrop="this.classList.remove('dx-drop'); window.acSoltar(event, '${sl.sube || ''}', ${sl.subeFn ? "'" + sl.subeFn.replace(/'/g, "&#39;") + "'" : "''"})"` : ''}>
    <div class="dx-head"><span class="dx-ico">${sl.ico}</span><b>${sl.tit}</b>
      <span class="dx-estado ${ok ? 'ok' : ''}">${ok ? '✔' : (sl.opcional ? 'Opcional' : 'Pendiente')}</span>
      <span class="dx-acc">${sl.reg || ''}${sube ? `<button type="button" class="btn btn-secondary btn-small dx-mas" title="Adjuntar (o arrastra el archivo aquí)" onclick="${sube}">＋</button>` : ''}</span></div>
    ${sl.sub ? `<div class="dx-sub">${sl.sub}</div>` : ''}
    ${files.length ? `<div class="dx-files">${files.map(f => _archivoHtml(f, gestion)).join('')}</div>` : (sube ? '<div class="dx-vacio">Arrastra el archivo aquí o pulsa ＋</div>' : '')}
  </div>`
}
function _mini(sl, files) {
  const ok = !!sl.ok || files.length > 0
  const f = files[0]
  const img = f ? `<span class="adj-thumb dx-mt" data-adj-path="${esc_(f.path)}" data-adj-nombre="${esc_(f.nombre)}" title="${esc_(f.nombre)} — clic para ver en grande">…</span>` : `<span class="dx-mt dx-mt-vacio">${sl.ico}</span>`
  const pg = sl.pago
  const pbtn = pg ? `<button type="button" class="dx-pg" title="${esc_(pg.txt)}" onclick="event.stopPropagation(); ${pg.fn}">💳 Ver pago</button>` : ''
  return `<div class="dx-mini ${ok ? 'ok' : 'vacio'}${pg ? ' con-pago' : ''}" onclick="${sl.abrir || `window.abrirAdjuntosCarpeta('${String(sl.tit).replace(/'/g, "\\'")}')`}" title="${esc_(sl.tit)}${f ? '' : ' — sin archivo'}${pg ? ' · ' + esc_(pg.txt) : ''} · ${sl.abrir ? 'clic para abrir su registro' : 'clic para gestionar este documento'}">
    <div class="dx-mw">${img}${pg ? '<span class="dx-pgb">💲</span>' : ''}${pbtn}${files.length > 1 ? `<span class="dx-n">${files.length}</span>` : ''}<span class="dx-ck ${ok ? 'ok' : ''}">${ok ? '✔' : ''}</span></div>
    <div class="dx-cap">${sl.tit}</div></div>`
}
window.acTarjetas = function (slots, adjs, { gestion = false, compacto = false } = {}) {
  window._acCache = Object.fromEntries((adjs || []).map(a => [a.id, a]))
  const usados = new Set()
  const html = (slots || []).map(sl => {
    const files = (adjs || []).filter(a => !usados.has(a.id) && sl.match(a))
    files.forEach(a => usados.add(a.id))
    return compacto ? _mini(sl, files) : _tarjeta(sl, files, gestion)
  })
  const resto = (adjs || []).filter(a => !usados.has(a.id))
  if (resto.length) html.push(compacto ? _mini({ ico: '📎', tit: 'Otros', ok: true }, resto) : _tarjeta({ ico: '📎', tit: 'Otros documentos', sube: 'otro', ok: true }, resto, gestion))
  return `<div class="dx-grid${compacto ? ' dx-compacto' : ''}">${html.join('')}</div>`
}

/** Descarga con el nombre original (clic en el nombre del archivo). */
window.acDescargar = async function (id) {
  try {
    const a = window._acCache?.[id]; if (!a) return
    const url = await getUrlAdjunto(a.path, 600, a.nombre)
    if (!url) throw new Error('Sin enlace')
    const l = document.createElement('a'); l.href = url; l.download = a.nombre || ''; document.body.appendChild(l); l.click(); l.remove()
  } catch (e) { showToast(e.message || 'No se pudo descargar', 'danger') }
}

async function _subirRapido(files, concepto) {
  const id = carpetaActual(); if (!id) { showToast('Selecciona primero una carpeta', 'warning'); return }
  const listos = [], errores = []
  for (const f of files) {
    const c = await _comprimir(f); const err = validarArchivoAdjunto(c)
    if (err) errores.push(err); else listos.push({ file: c, concepto })
  }
  if (errores.length) showToast(errores[0], 'danger')
  if (!listos.length) return
  const user = await getCurrentUser()
  const res = await subirAdjuntos('carpeta_importacion', id, listos, user?.db_id)
  showToast(res?.errores?.length ? `${res.ok} subido(s). ${res.errores[0]}` : `${res.ok} documento(s) agregados`, res?.errores?.length ? 'warning' : 'success')
  _carpetaId = id
  if (document.getElementById('modal-adjuntos-carpeta')?.classList.contains('active') || document.getElementById('acLista')?.offsetParent) await _pintarLista()
  window.renderHojaCosteo?.()
}
window.acSubirA = function (concepto) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true; inp.accept = 'application/pdf,image/*,.xlsx,.xls,.doc,.docx'
  inp.setAttribute('data-sin-preview', '1')
  inp.onchange = () => _subirRapido([...inp.files], concepto)
  inp.click()
}
window.acSoltar = function (ev, concepto, fn) {
  ev.preventDefault()
  const files = [...(ev.dataTransfer?.files || [])]; if (!files.length) return
  if (fn) { showToast('Este documento se adjunta desde su ventana propia', 'info'); try { new Function(fn)() } catch {} ; return }
  _subirRapido(files, concepto || 'otro')
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

window.abrirAdjuntosCarpeta = async function (foco) {
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
  // Si se abrió desde un icono sin registro propio, enfoca esa tarjeta
  if (typeof foco === 'string' && foco) setTimeout(() => {
    const card = [...document.querySelectorAll('#modal-adjuntos-carpeta .dx-card')].find(x => x.dataset.tit === foco)
    if (card) { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); card.classList.add('dx-foco'); setTimeout(() => card.classList.remove('dx-foco'), 2200) }
  }, 120)
}

export default { abrirAdjuntosCarpeta: window.abrirAdjuntosCarpeta, CONCEPTOS_CARPETA }
