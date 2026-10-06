// ============================================================================
// ventas/series-config.js — Configuración → "Series y correlativos" (2026-09-30)
// ============================================================================
// CRUD de public.series_documentos. Se pinta debajo de los parámetros del
// módulo (tab Configuración de Ventas). Reglas:
//   · correlativo inicial ≠ 1 → se pide confirmación explícita del número.
//   · una sola serie "por defecto" por tipo (+ aplica_a en NC/ND): al marcar
//     una, se desmarca la anterior.
//   · no se elimina una serie ya usada (tiene documentos) → se desactiva.
// ============================================================================
import { getSeries, addSerie, updateSerie, deleteSerie, siguienteCorrelativo, formatearNumero, NOMBRE_TIPO_SERIE, parseNumeroGuia } from '../series.js'
import { getVentas, getUbicaciones, getAlmacenes } from '../supabase-data.js'
import { supabase } from '../supabase-client.js'
import { showToast } from '../helpers.js'

const _esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
let _containerId = null

/** Ubicaciones de almacenes virtuales (Partners/…): destinos posibles de una guía de venta. */
async function _destinosVirtuales() {
  const [ubic, alms] = await Promise.all([getUbicaciones(), getAlmacenes()])
  const almMap = {}; (alms || []).forEach(a => { almMap[a.id] = a })
  return (ubic || []).filter(u => almMap[u.almacen_id]?.es_virtual)
    .map(u => ({ id: u.id, label: `${almMap[u.almacen_id]?.nombre || ''} / ${u.nombre}` }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

async function _maxUsadoPorSerie() {
  const max = {}
  const ventas = await getVentas()
  for (const v of (ventas || [])) {
    const k = `${v.tipo_comprobante}|${v.serie}`
    const n = parseInt(String(v.correlativo || '').replace(/\D/g, '')) || 0
    if (n > (max[k] || 0)) max[k] = n
  }
  try {
    const { data } = await supabase.from('packing').select('serie, correlativo')
    for (const p of (data || [])) { const k = `PK|${p.serie}`; if (p.correlativo > (max[k] || 0)) max[k] = p.correlativo }
  } catch { /* tabla packing aún no creada */ }
  // Guías (09): T001 la comparten guías de venta y de devolución a proveedor.
  for (const tabla of ['guias_despacho_venta', 'guias_devolucion_compra']) {
    try {
      const { data } = await supabase.from(tabla).select('numero_guia')
      for (const g of (data || [])) {
        const { serie, correlativo } = parseNumeroGuia(g.numero_guia)
        if (!serie) continue
        const k = `09|${serie}`; if (correlativo > (max[k] || 0)) max[k] = correlativo
      }
    } catch { /* tabla aún no creada */ }
  }
  return max
}

export async function renderSeriesConfig(containerId) {
  _containerId = containerId
  const cont = document.getElementById(containerId)
  if (!cont) return
  let card = document.getElementById('cfg-series-card')
  if (!card) {
    card = document.createElement('div')
    card.id = 'cfg-series-card'
    card.className = 'card'
    card.style.marginTop = '16px'
    cont.appendChild(card)
  }
  let series
  try { series = await getSeries(true) } catch (e) { series = null }
  if (!series) {
    card.innerHTML = `<div class="card-header"><h3 class="card-title">🔢 Series y correlativos</h3></div>
      <p style="padding:16px; color:var(--color-warning);">Falta correr <code>assets/sql/59_series_documentos_y_packing.sql</code> en Supabase.</p>`
    return
  }
  const maxUsado = await _maxUsadoPorSerie()
  const orden = { PK: 0, '01': 1, '03': 2, '07': 3, '08': 4, '09': 5 }
  let destinos = []
  try { destinos = await _destinosVirtuales() } catch { /* sin ubicaciones */ }
  const destMap = {}; destinos.forEach(d => { destMap[d.id] = d.label })
  const _guiaDestino = (s) => {
    if (s.tipo_documento === '09') return s.ubicacion_destino_id ? `→ ${_esc(destMap[s.ubicacion_destino_id] || '#' + s.ubicacion_destino_id)}` : '<span style="color:var(--color-warning);">Sin destino</span>'
    if (s.tipo_documento === '01' || s.tipo_documento === '03') return s.serie_guia ? `Guía <strong>${_esc(s.serie_guia)}</strong>` : '—'
    return '—'
  }
  series.sort((a, b) => (orden[a.tipo_documento] - orden[b.tipo_documento]) || a.serie.localeCompare(b.serie))

  card.innerHTML = `
    <div class="card-header">
      <h3 class="card-title">🔢 Series y correlativos</h3>
      <button class="btn btn-primary btn-small" onclick="window.abrirModalSerie()">+ Nueva serie</button>
    </div>
    <p style="padding:0 16px; font-size:0.82rem; color:var(--text-secondary);">
      El próximo número = mayor entre el último usado, el correlativo inicial − 1 y lo que ya existe emitido, + 1.
      <strong>CPE</strong> = se envía a NUBEFACT; sin CPE es comprobante físico (ej. NV01), suma IGV igual.
    </p>
    <div class="table-container">
      <table>
        <thead><tr>
          <th>Tipo</th><th>Serie</th><th>Descripción</th><th style="text-align:right;">Inicial</th>
          <th style="text-align:right;">Último usado</th><th>Próximo</th><th style="text-align:center;">CPE</th>
          <th>Aplica a</th><th>Guía / Destino</th><th style="text-align:right;">Validez (días)</th><th style="text-align:center;">Por defecto</th>
          <th style="text-align:center;">Activa</th><th>Acciones</th>
        </tr></thead>
        <tbody>
          ${series.map(s => {
            const usado = Math.max(parseInt(s.ultimo_correlativo) || 0, maxUsado[`${s.tipo_documento}|${s.serie}`] || 0)
            return `<tr style="${s.activo ? '' : 'opacity:.5;'}">
              <td>${_esc(NOMBRE_TIPO_SERIE[s.tipo_documento] || s.tipo_documento)}</td>
              <td><strong>${_esc(s.serie)}</strong></td>
              <td>${_esc(s.descripcion || '')}</td>
              <td style="text-align:right;">${s.correlativo_inicial}</td>
              <td style="text-align:right;">${usado || '—'}</td>
              <td><code>${_esc(formatearNumero(s, siguienteCorrelativo(s, usado)))}</code></td>
              <td style="text-align:center;">${s.es_cpe ? '✅' : '📄 Físico'}</td>
              <td>${s.aplica_a ? _esc(NOMBRE_TIPO_SERIE[s.aplica_a]) : '—'}</td>
              <td style="white-space:nowrap;">${_guiaDestino(s)}</td>
              <td style="text-align:right;">${s.dias_validez ?? '—'}</td>
              <td style="text-align:center;">${s.por_defecto ? '⭐' : ''}</td>
              <td style="text-align:center;">${s.activo ? 'Sí' : 'No'}</td>
              <td style="white-space:nowrap;">
                <button class="btn btn-small btn-secondary" onclick="window.abrirModalSerie(${s.id})">Editar</button>
                <button class="btn btn-small btn-danger" onclick="window.eliminarSerie(${s.id})">✕</button>
              </td>
            </tr>`
          }).join('')}
        </tbody>
      </table>
    </div>`
}

const _SEC = 'display:block; color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase; letter-spacing:0.03em; margin:4px 0 8px;'

function _asegurarModalSerie() {
  if (document.getElementById('modal-serie-doc')) return
  const div = document.createElement('div')
  div.id = 'modal-serie-doc'
  div.className = 'modal'
  // Estándar de modales ERP: ancho min(94vw,Xpx) en width y max-width,
  // info-card de contexto, títulos de sección en mayúsculas, candado para
  // el correlativo (window.toggleCandado de venta-nueva.js).
  div.innerHTML = `
    <div class="modal-content" style="width:min(94vw, 680px); max-width:min(94vw, 680px); max-height:90vh; overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title" id="serieModalTitulo">Serie</h3>
        <button class="modal-close" onclick="closeModal('modal-serie-doc')">&times;</button>
      </div>
      <div class="modal-body" style="padding:16px 20px;">
        <input type="hidden" id="serieId">

        <div id="serieInfoCard" style="display:none; padding:12px 14px; margin-bottom:14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info); font-size:0.88rem; line-height:1.6;">
          <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">Próximo documento</div>
          <div style="font-weight:600; font-size:1.05rem; margin-top:2px;" id="serieInfoProximo">—</div>
          <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;" id="serieInfoSub"></div>
        </div>

        <strong style="${_SEC}">Datos de la serie</strong>
        <div style="display:grid; grid-template-columns:1.4fr 0.8fr; gap:12px;">
          <div class="form-group"><label>Tipo de documento *</label>
            <select id="serieTipo" onchange="window._onCambiarTipoSerie()">
              ${Object.entries(NOMBRE_TIPO_SERIE).map(([k, v]) => `<option value="${k}">${k === 'PK' ? '' : k + ' — '}${v}</option>`).join('')}
            </select></div>
          <div class="form-group"><label>Serie *</label><input type="text" id="serieSerie" maxlength="6" placeholder="FFFI / T001 / PK" style="text-transform:uppercase;" oninput="window._previewSerie()"></div>
          <div class="form-group" style="grid-column:1/-1;"><label>Descripción</label><input type="text" id="serieDescripcion"></div>
        </div>

        <hr style="border:none; border-top:1px solid var(--border-color); margin:6px 0 12px;">
        <strong style="${_SEC}">Correlativo</strong>
        <div style="display:grid; grid-template-columns:1fr 1fr 0.7fr; gap:12px;">
          <div class="form-group"><label>Correlativo inicial *</label><input type="number" id="serieInicial" min="1" step="1" value="1" oninput="window._previewSerie()"></div>
          <div class="form-group"><label>Último usado</label>
            <div class="input-con-candado">
              <input type="number" id="serieUltimo" min="0" step="1" value="0" readonly oninput="window._previewSerie()">
              <button type="button" class="btn-candado" id="btnCandadoSerieUlt" title="Editar manualmente"
                      onclick="window.toggleCandado('serieUltimo','btnCandadoSerieUlt','aviso-serie-ult'); window._previewSerie()">🔒</button>
            </div>
            <small class="campo-editable-aviso" id="aviso-serie-ult">Editando a mano: el próximo será este + 1 (nunca menor a lo ya emitido).</small>
          </div>
          <div class="form-group"><label>Dígitos</label><input type="number" id="serieDigitos" min="3" max="10" step="1" value="8" oninput="window._previewSerie()"></div>
        </div>

        <div id="serieEnlacesBloque">
          <hr style="border:none; border-top:1px solid var(--border-color); margin:6px 0 12px;">
          <strong style="${_SEC}">Enlaces</strong>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
            <div class="form-group" id="serieAplicaGrupo"><label>Aplica a (NC/ND)</label>
              <select id="serieAplicaA"><option value="01">Factura</option><option value="03">Boleta</option></select></div>
            <div class="form-group" id="serieGuiaGrupo"><label>Genera guía (serie 09)</label>
              <select id="serieGuia"></select>
              <small style="color:var(--text-secondary);">Serie que se sugiere al emitir la guía de despacho de este comprobante.</small></div>
            <div class="form-group" id="serieDestinoGrupo" style="grid-column:1/-1;"><label>Destino de la venta (kardex)</label>
              <select id="serieDestino"></select>
              <small style="color:var(--text-secondary);">A qué ubicación de Partners sale la mercadería con esta guía. La NC con devolución reingresa desde aquí.</small></div>
            <div class="form-group" id="serieValidezGrupo"><label>Validez por defecto (días)</label><input type="number" id="serieValidez" min="1" step="1" value="15"></div>
          </div>
        </div>

        <hr style="border:none; border-top:1px solid var(--border-color); margin:6px 0 12px;">
        <strong style="${_SEC}">Opciones</strong>
        <div style="display:flex; gap:22px; flex-wrap:wrap;">
          <label style="display:flex; gap:8px; align-items:center;"><input type="checkbox" id="serieCPE" checked> Electrónico (NUBEFACT / SUNAT)</label>
          <label style="display:flex; gap:8px; align-items:center;"><input type="checkbox" id="serieDefault"> Serie por defecto</label>
          <label style="display:flex; gap:8px; align-items:center;"><input type="checkbox" id="serieActivo" checked> Activa</label>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal('modal-serie-doc')">Cancelar</button>
        <button class="btn btn-primary" onclick="window.guardarSerie()">💾 Guardar serie</button>
      </div>
    </div>`
  document.body.appendChild(div)
}

let _serieMaxEmitido = 0   // mayor número ya emitido de la serie abierta (para el preview y la validación)

window._previewSerie = function () {
  const serie = (document.getElementById('serieSerie').value || '').trim().toUpperCase()
  const row = {
    serie,
    digitos: parseInt(document.getElementById('serieDigitos').value) || 8,
    correlativo_inicial: parseInt(document.getElementById('serieInicial').value) || 1,
    ultimo_correlativo: parseInt(document.getElementById('serieUltimo').value) || 0
  }
  const card = document.getElementById('serieInfoCard')
  if (!serie) { card.style.display = 'none'; return }
  card.style.display = ''
  document.getElementById('serieInfoProximo').textContent = formatearNumero(row, siguienteCorrelativo(row, _serieMaxEmitido))
  document.getElementById('serieInfoSub').textContent = _serieMaxEmitido
    ? `Mayor número ya emitido en el sistema: ${_serieMaxEmitido}`
    : 'Aún no hay documentos emitidos con esta serie'
}

window._onCambiarTipoSerie = function () {
  const t = document.getElementById('serieTipo').value
  document.getElementById('serieAplicaGrupo').style.display = (t === '07' || t === '08') ? '' : 'none'
  document.getElementById('serieValidezGrupo').style.display = t === 'PK' ? '' : 'none'
  document.getElementById('serieGuiaGrupo').style.display = (t === '01' || t === '03') ? '' : 'none'
  document.getElementById('serieDestinoGrupo').style.display = t === '09' ? '' : 'none'
  // Bloque "Enlaces" solo si el tipo tiene algo que enlazar
  document.getElementById('serieEnlacesBloque').style.display = (t === 'PK' || t === '01' || t === '03' || t === '07' || t === '08' || t === '09') ? '' : 'none'
  const cpe = document.getElementById('serieCPE')
  if (t === 'PK') { cpe.checked = false; cpe.disabled = true } else cpe.disabled = false
}

window.abrirModalSerie = async function (id = null) {
  _asegurarModalSerie()
  const s = id ? (await getSeries()).find(x => x.id === id) : null
  const set = (k, v) => { const el = document.getElementById(k); if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? '' }
  document.getElementById('serieModalTitulo').textContent = s ? `Editar serie ${s.serie}` : 'Nueva serie'
  set('serieId', s?.id || '')
  set('serieTipo', s?.tipo_documento || '01')
  set('serieSerie', s?.serie || '')
  set('serieDescripcion', s?.descripcion || '')
  set('serieInicial', s?.correlativo_inicial || 1)
  set('serieUltimo', s?.ultimo_correlativo || 0)
  // Candado cerrado al abrir y valor automático = el de la BD
  const ult = document.getElementById('serieUltimo')
  ult.readOnly = true; ult.dataset.valorAutomatico = String(s?.ultimo_correlativo || 0)
  const bc = document.getElementById('btnCandadoSerieUlt'); bc.textContent = '🔒'; bc.classList.remove('abierto')
  document.getElementById('aviso-serie-ult').classList.remove('visible')
  _serieMaxEmitido = s ? ((await _maxUsadoPorSerie())[`${s.tipo_documento}|${s.serie}`] || 0) : 0
  set('serieDigitos', s?.digitos || 8)
  set('serieAplicaA', s?.aplica_a || '01')
  set('serieValidez', s?.dias_validez || 15)
  set('serieCPE', s ? s.es_cpe : true)
  set('serieDefault', s?.por_defecto || false)
  set('serieActivo', s ? s.activo : true)
  // Selectores de guía (para 01/03) y destino (para 09)
  const guias = (await getSeries()).filter(x => x.tipo_documento === '09' && x.activo)
  document.getElementById('serieGuia').innerHTML = '<option value="">— (la guía por defecto) —</option>' +
    guias.map(g => `<option value="${_esc(g.serie)}">${_esc(g.serie)} — ${_esc(g.descripcion || '')}</option>`).join('')
  set('serieGuia', s?.serie_guia || '')
  let destinos = []
  try { destinos = await _destinosVirtuales() } catch { /* */ }
  document.getElementById('serieDestino').innerHTML = '<option value="">— Partners / Customers (por defecto) —</option>' +
    destinos.map(d => `<option value="${d.id}">${_esc(d.label)}</option>`).join('')
  set('serieDestino', s?.ubicacion_destino_id || '')
  document.getElementById('serieTipo').disabled = !!s
  document.getElementById('serieSerie').disabled = !!s
  window._onCambiarTipoSerie()
  window._previewSerie()
  window.openModal('modal-serie-doc')
}

window.guardarSerie = async function () {
  try {
    const id = parseInt(document.getElementById('serieId').value) || null
    const tipo = document.getElementById('serieTipo').value
    const serie = document.getElementById('serieSerie').value.trim().toUpperCase()
    const inicial = parseInt(document.getElementById('serieInicial').value) || 0
    const digitos = parseInt(document.getElementById('serieDigitos').value) || 8
    if (!serie) { showToast('Ingresa la serie', 'warning'); return }
    if (inicial < 1) { showToast('El correlativo inicial debe ser 1 o más', 'warning'); return }
    const anterior = id ? (await getSeries()).find(x => x.id === id) : null
    if (inicial !== 1 && inicial !== anterior?.correlativo_inicial) {
      const muestra = `${serie}-${String(inicial).padStart(digitos, '0')}`
      if (!confirm(`La serie ${serie} empezará en ${muestra} (no en 1).\n\n¿Confirmas que el próximo documento debe ser ${muestra}?`)) return
    }
    const ultimo = parseInt(document.getElementById('serieUltimo').value) || 0
    const ultimoEditado = !document.getElementById('serieUltimo').readOnly && ultimo !== (parseInt(anterior?.ultimo_correlativo) || 0)
    if (ultimo < 0) { showToast('El último usado no puede ser negativo', 'warning'); return }
    if (ultimoEditado) {
      if (ultimo < _serieMaxEmitido) {
        showToast(`Ya hay documentos emitidos hasta el ${_serieMaxEmitido}: el próximo seguirá siendo ${_serieMaxEmitido + 1} aunque bajes el último usado.`, 'warning', 7000)
      }
      const prox = formatearNumero({ serie, digitos }, Math.max(ultimo, inicial - 1, _serieMaxEmitido) + 1)
      if (!confirm(`Último usado de ${serie} = ${ultimo}.\n\nEl próximo documento será ${prox}. ¿Confirmar?`)) return
    }
    const esNota = tipo === '07' || tipo === '08'
    const datos = {
      tipo_documento: tipo, serie,
      descripcion: document.getElementById('serieDescripcion').value.trim() || null,
      correlativo_inicial: inicial, digitos,
      ...(ultimoEditado || !id ? { ultimo_correlativo: ultimo } : {}),
      es_cpe: tipo === 'PK' ? false : document.getElementById('serieCPE').checked,
      aplica_a: esNota ? document.getElementById('serieAplicaA').value : null,
      dias_validez: tipo === 'PK' ? (parseInt(document.getElementById('serieValidez').value) || 15) : null,
      serie_guia: (tipo === '01' || tipo === '03') ? (document.getElementById('serieGuia').value || null) : null,
      ubicacion_destino_id: tipo === '09' ? (parseInt(document.getElementById('serieDestino').value) || null) : null,
      por_defecto: document.getElementById('serieDefault').checked,
      activo: document.getElementById('serieActivo').checked,
      updated_at: new Date().toISOString()
    }
    // Una sola por defecto por tipo (+aplica_a): se desmarca la anterior primero (índice único en BD).
    if (datos.por_defecto) {
      const otras = (await getSeries(true)).filter(x => x.id !== id && x.por_defecto && x.tipo_documento === tipo && (x.aplica_a || null) === datos.aplica_a)
      for (const o of otras) await updateSerie(o.id, { por_defecto: false })
    }
    const r = id ? await updateSerie(id, datos) : await addSerie(datos)
    if (!r) throw new Error('No se pudo guardar (¿serie repetida para ese tipo?)')
    showToast('Serie guardada ✅', 'success')
    window.closeModal('modal-serie-doc')
    await renderSeriesConfig(_containerId)
  } catch (e) { showToast('Error: ' + e.message, 'danger') }
}

window.eliminarSerie = async function (id) {
  const s = (await getSeries()).find(x => x.id === id)
  if (!s) return
  const maxUsado = await _maxUsadoPorSerie()
  if ((maxUsado[`${s.tipo_documento}|${s.serie}`] || 0) > 0 || (parseInt(s.ultimo_correlativo) || 0) > 0) {
    showToast(`La serie ${s.serie} ya tiene documentos emitidos: no se elimina, desactívala (Editar → Activa).`, 'warning', 7000)
    return
  }
  if (!confirm(`¿Eliminar la serie ${s.serie}?`)) return
  const ok = await deleteSerie(id)
  showToast(ok ? 'Serie eliminada' : 'No se pudo eliminar', ok ? 'success' : 'danger')
  await renderSeriesConfig(_containerId)
}
