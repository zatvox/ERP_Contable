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
import { getSeries, addSerie, updateSerie, deleteSerie, siguienteCorrelativo, formatearNumero, NOMBRE_TIPO_SERIE } from '../series.js'
import { getVentas } from '../supabase-data.js'
import { supabase } from '../supabase-client.js'
import { showToast } from '../helpers.js'

const _esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
let _containerId = null

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
  const orden = { PK: 0, '01': 1, '03': 2, '07': 3, '08': 4 }
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
          <th>Aplica a</th><th style="text-align:right;">Validez (días)</th><th style="text-align:center;">Por defecto</th>
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

function _asegurarModalSerie() {
  if (document.getElementById('modal-serie-doc')) return
  const div = document.createElement('div')
  div.id = 'modal-serie-doc'
  div.className = 'modal'
  div.innerHTML = `
    <div class="modal-content" style="width:min(94vw, 560px); max-width:min(94vw, 560px);">
      <div class="modal-header">
        <h3 class="modal-title" id="serieModalTitulo">Serie</h3>
        <button class="modal-close" onclick="closeModal('modal-serie-doc')">✕</button>
      </div>
      <div class="modal-body" style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <input type="hidden" id="serieId">
        <div class="form-group"><label>Tipo de documento *</label>
          <select id="serieTipo" onchange="window._onCambiarTipoSerie()">
            ${Object.entries(NOMBRE_TIPO_SERIE).map(([k, v]) => `<option value="${k}">${k === 'PK' ? '' : k + ' — '}${v}</option>`).join('')}
          </select></div>
        <div class="form-group"><label>Serie *</label><input type="text" id="serieSerie" maxlength="6" placeholder="FFFI / NV01 / PK" style="text-transform:uppercase;"></div>
        <div class="form-group" style="grid-column:1/-1;"><label>Descripción</label><input type="text" id="serieDescripcion"></div>
        <div class="form-group"><label>Correlativo inicial *</label><input type="number" id="serieInicial" min="1" step="1" value="1"></div>
        <div class="form-group"><label>Dígitos del número</label><input type="number" id="serieDigitos" min="3" max="10" step="1" value="8"></div>
        <div class="form-group" id="serieAplicaGrupo"><label>Aplica a (NC/ND)</label>
          <select id="serieAplicaA"><option value="01">Factura</option><option value="03">Boleta</option></select></div>
        <div class="form-group" id="serieValidezGrupo"><label>Validez por defecto (días)</label><input type="number" id="serieValidez" min="1" step="1" value="15"></div>
        <label style="display:flex; gap:8px; align-items:center;"><input type="checkbox" id="serieCPE" checked> Comprobante electrónico (NUBEFACT)</label>
        <label style="display:flex; gap:8px; align-items:center;"><input type="checkbox" id="serieDefault"> Serie por defecto</label>
        <label style="display:flex; gap:8px; align-items:center;"><input type="checkbox" id="serieActivo" checked> Activa</label>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('modal-serie-doc')">Cancelar</button>
        <button class="btn btn-primary" onclick="window.guardarSerie()">Guardar</button>
      </div>
    </div>`
  document.body.appendChild(div)
}

window._onCambiarTipoSerie = function () {
  const t = document.getElementById('serieTipo').value
  document.getElementById('serieAplicaGrupo').style.display = (t === '07' || t === '08') ? '' : 'none'
  document.getElementById('serieValidezGrupo').style.display = t === 'PK' ? '' : 'none'
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
  set('serieDigitos', s?.digitos || 8)
  set('serieAplicaA', s?.aplica_a || '01')
  set('serieValidez', s?.dias_validez || 15)
  set('serieCPE', s ? s.es_cpe : true)
  set('serieDefault', s?.por_defecto || false)
  set('serieActivo', s ? s.activo : true)
  document.getElementById('serieTipo').disabled = !!s
  document.getElementById('serieSerie').disabled = !!s
  window._onCambiarTipoSerie()
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
    const esNota = tipo === '07' || tipo === '08'
    const datos = {
      tipo_documento: tipo, serie,
      descripcion: document.getElementById('serieDescripcion').value.trim() || null,
      correlativo_inicial: inicial, digitos,
      es_cpe: tipo === 'PK' ? false : document.getElementById('serieCPE').checked,
      aplica_a: esNota ? document.getElementById('serieAplicaA').value : null,
      dias_validez: tipo === 'PK' ? (parseInt(document.getElementById('serieValidez').value) || 15) : null,
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
