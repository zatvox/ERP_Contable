// ============================================================================
// ventas/linea-pesaje.js — Pesaje de línea (Packing y Venta) · 2026-10-27
// ============================================================================
// Orden de captura: N° Unidades × Peso por caja/bolsa = Cantidad (kg).
// El kg se CALCULA (candado 🔒 cerrado). Solo para peso variable u otro caso
// especial se abre el candado 🔓 y se escribe el kg real; entonces el peso
// por caja se muestra como promedio (kg ÷ unidades).
// Además pinta el panel de stock por lote (Lote · Zona · Peso/caja · Disp. kg
// · Usaría) — clic en una fila copia su peso/caja al formulario.
// ============================================================================
import { _stockTotalPorItem } from './helpers.js'
import { S } from './state.js'
import { formatQty } from '../helpers.js'

const _esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const $ = id => document.getElementById(id)

/** Config por modal: ids de campos + qué refrescar después de cada cambio. */
const CFG = {}
export function registrarPesaje(pfx, cfg) { CFG[pfx] = cfg }

const _r3 = n => Math.round(n * 1000) / 1000

/** Unidades o peso/caja cambiaron → recalcula kg (si el candado está cerrado). */
window._pesajeRecalc = function (pfx) {
  const c = CFG[pfx]; if (!c) return
  const kg = $(c.kg); if (!kg) return
  const n = parseFloat($(c.und)?.value) || 0
  const p = parseFloat($(c.peso)?.value) || 0
  if (kg.readOnly) kg.value = (n > 0 && p > 0) ? _r3(n * p) : ''
  else if (n > 0 && parseFloat(kg.value) > 0 && document.activeElement !== $(c.peso)) $(c.peso).value = _r3(parseFloat(kg.value) / n)
  c.despues?.()
}

/** kg escrito a mano (candado abierto) → el peso/caja pasa a ser el promedio. */
window._pesajeKgManual = function (pfx) {
  const c = CFG[pfx]; if (!c) return
  const n = parseFloat($(c.und)?.value) || 0
  const kg = parseFloat($(c.kg)?.value) || 0
  if (n > 0 && kg > 0) $(c.peso).value = _r3(kg / n)
  c.despues?.()
}

window._pesajeCandado = function (pfx) {
  const c = CFG[pfx]; if (!c) return
  const kg = $(c.kg), btn = $(c.btn)
  const abrir = kg.readOnly
  if (abrir && !confirm('¿Escribir el kg a mano?\n\nÚsalo solo para peso variable (cada bulto pesa distinto). Lo normal es N° unidades × peso por caja.')) return
  kg.readOnly = !abrir
  kg.style.background = abrir ? '' : 'var(--bg-primary)'
  if (btn) { btn.textContent = abrir ? '🔓' : '🔒'; btn.classList.toggle('abierto', abrir) }
  if (abrir) kg.focus(); else window._pesajeRecalc(pfx)
}

/** Deja el trío listo para una línea nueva (vacío) o existente (sus valores). */
export function cargarPesaje(pfx, { cantidad = '', unidades = '' } = {}) {
  const c = CFG[pfx]; if (!c) return
  const n = parseFloat(unidades) || 0, kg = parseFloat(cantidad) || 0
  $(c.und).value = n || ''
  $(c.peso).value = n > 0 && kg > 0 ? _r3(kg / n) : ''
  $(c.kg).value = kg || ''
  // Con unidades → kg calculado (🔒). Línea vieja con kg pero sin unidades → 🔓 manual.
  const manual = kg > 0 && !(n > 0)
  $(c.kg).readOnly = !manual
  $(c.kg).style.background = manual ? '' : 'var(--bg-primary)'
  const btn = $(c.btn); if (btn) { btn.textContent = manual ? '🔓' : '🔒'; btn.classList.toggle('abierto', manual) }
}

/** Placeholder del peso/caja con el dato del lote más reciente (sugerencia, no valor). */
export function sugerirPesoPlaceholder(pfx, itemId) {
  const c = CFG[pfx]; if (!c) return
  const lote = (S._lotes || []).filter(l => l.item_id === itemId && parseFloat(l.peso_por_unidad) > 0).sort((a, b) => b.id - a.id)[0]
  $(c.peso).placeholder = lote ? `ej. ${formatQty(parseFloat(lote.peso_por_unidad), 3)} (lote ${lote.numero_lote})` : 'kg por caja'
}

/** Panel de stock por lote (mismo de Nueva Venta + columna Peso/caja). */
export function pintarPanelStock({ pfx, avisoId, panelId, itemId, cantidad }) {
  const aviso = $(avisoId), panel = $(panelId)
  if (!aviso) return
  if (!itemId) {
    aviso.textContent = 'Selecciona un producto para ver su stock disponible.'
    aviso.style.color = 'var(--text-secondary)'
    if (panel) panel.innerHTML = ''
    return
  }
  const { totalKg, totalUnid, lotes } = _stockTotalPorItem(itemId)
  const insuf = cantidad > 0 && cantidad > totalKg
  aviso.textContent = !lotes.length
    ? 'Sin stock disponible en ninguna zona para este producto.'
    : `Stock TOTAL disponible: ${formatQty(totalKg)} kg${totalUnid > 0 ? ` / ${formatQty(totalUnid)} und` : ''} (en ${lotes.length} lote${lotes.length === 1 ? '' : 's'})${insuf ? ' — INSUFICIENTE para la cantidad pedida' : ''}`
  aviso.style.color = !lotes.length ? 'var(--color-warning)' : (insuf ? 'var(--color-danger)' : 'var(--color-success)')
  if (!panel) return
  if (!lotes.length) { panel.innerHTML = ''; return }
  let resto = cantidad > 0 ? cantidad : 0
  const td = 'padding:3px 6px;'
  panel.innerHTML = `<table style="width:100%; border-collapse:collapse;">
    <tr style="color:var(--text-secondary);"><td style="${td} padding-left:0;">Lote</td><td style="${td}">Zona</td>
      <td style="${td} text-align:right;" title="Peso por caja/bolsa del lote. Clic en la fila para usarlo.">Peso/caja</td>
      <td style="${td} text-align:right;">Disp. kg</td><td style="${td} text-align:center;">Usaría</td></tr>
    ${lotes.map(l => {
      const usa = resto > 0 ? Math.min(resto, l.disp) : 0
      resto = Math.round((resto - usa) * 10000) / 10000
      const lote = S._lotesMap?.[l.lote_id]
      const pc = parseFloat(lote?.peso_por_unidad) > 0 ? parseFloat(lote.peso_por_unidad) : (l.dispUnid > 0 ? l.disp / l.dispUnid : 0)
      return `<tr ${pc ? `style="cursor:pointer;" title="Usar ${formatQty(pc)} kg por caja" onclick="window._pesajeUsarPeso('${pfx}', ${_r3(pc)})"` : ''}>
        <td style="${td} padding-left:0;">${_esc(l.numero_lote)}</td><td style="${td}">${_esc(l.zonaNombre)}</td>
        <td style="${td} text-align:right; color:var(--color-info);">${pc ? formatQty(pc, 3) : '—'}</td>
        <td style="${td} text-align:right;">${formatQty(l.disp)}</td>
        <td style="${td} text-align:center;">${usa > 0 ? '✓ ' + formatQty(usa) + ' kg' : '—'}</td></tr>`
    }).join('')}</table>`
}

window._pesajeUsarPeso = function (pfx, peso) {
  const c = CFG[pfx]; if (!c) return
  $(c.peso).value = peso
  window._pesajeRecalc(pfx)
}

// Accesos globales para helpers.js (evita import circular helpers ↔ linea-pesaje)
window._pesajeSugerir = sugerirPesoPlaceholder
window._pesajePanel = pintarPanelStock
