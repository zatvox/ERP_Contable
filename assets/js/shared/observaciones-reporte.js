// ============================================================================
// shared/observaciones-reporte.js — Detector de alarmas / irregularidades / curiosidades
// Motor GENÉRICO: no sabe de ventas ni compras. Recibe una "radiografía" normalizada del reporte
// (la arma cada motor: estadisticas/motor.js y reportes.js) y devuelve observaciones priorizadas:
//   nivel 'alarma'  🔴  → urgente: algo está mal o en riesgo
//   nivel 'revisar' 🟠  → conviene revisar / regularizar
//   nivel 'curioso' 🔵  → dato llamativo (no es error, pero vale la pena mirarlo)
// Se usa en: PDF (sección «Observaciones y pendientes») y marcas ⚠ del árbol de reportes.
// ============================================================================

const MALAS_SUBEN = /pendiente|vencid|deuda|costo|descuadre|por pagar|por cobrar|mora/i
const fmtN = v => Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })
const pct = (a, b) => (b ? (a / Math.abs(b)) * 100 : 0)

/**
 * radiografia = {
 *   medida:   { label, formato },                 // medida principal
 *   total:    number,                             // total de la medida principal
 *   series:   [{ label, v }],                     // evolución por período (cronológico) — opcional
 *   ranking:  [{ k, v }],                         // grupos de la dimensión principal (desc) — opcional
 *   dimLabel: 'Cliente',                          // nombre de esa dimensión
 *   medidas:  [{ label, valor, formato }],        // totales de todas las medidas
 *   registros: n, sinDato: n, sinFecha: n         // calidad del dato (opcional)
 *   campoSinDato: 'Cliente'
 * }
 */
export function analizar(r = {}) {
  const out = []
  const M = r.medida || { label: 'valor' }, L = M.label
  const add = (nivel, titulo, detalle, accion) => out.push({ nivel, titulo, detalle, accion })

  // 1) Variación brusca del último período
  const S = r.series || []
  if (S.length >= 2) {
    const a = S[S.length - 1], b = S[S.length - 2]
    if (b.v) {
      const d = pct(a.v - b.v, b.v), malo = MALAS_SUBEN.test(L) ? d > 0 : d < 0
      if (Math.abs(d) >= 30) add(malo ? 'alarma' : 'curioso', `${L}: ${d > 0 ? 'sube' : 'cae'} ${Math.abs(d).toFixed(0)} % en ${a.label}`,
        `${fmtN(b.v)} en ${b.label} → ${fmtN(a.v)} en ${a.label}.`, malo ? 'Confirmar si es estacionalidad o un registro faltante/duplicado.' : 'Validar que el movimiento esté completo y bien clasificado.')
    }
    // 2) Meses sin movimiento entre el primero y el último
    const huecos = S.filter(p => !p.v).map(p => p.label)
    if (huecos.length && S.length > 3) add('revisar', `${huecos.length} período(s) sin movimiento`, `Sin ${L}: ${huecos.slice(0, 6).join(', ')}${huecos.length > 6 ? '…' : ''}.`, 'Verificar si falta registrar operaciones de esos períodos.')
  }

  // 3) Concentración / dependencia
  const R = (r.ranking || []).filter(x => x.v > 0), tot = R.reduce((s, x) => s + x.v, 0)
  if (R.length >= 2 && tot > 0) {
    const top = R[0], share = top.v / tot * 100
    if (share >= 50) add(share >= 70 ? 'alarma' : 'revisar', `Dependencia de «${top.k}» (${share.toFixed(0)} %)`, `Un solo ${String(r.dimLabel || 'grupo').toLowerCase()} concentra más de la mitad de ${L}.`, 'Evaluar diversificar o asegurar condiciones con ese tercero.')
    const top3 = R.slice(0, 3).reduce((s, x) => s + x.v, 0) / tot * 100
    if (R.length > 5 && top3 >= 85 && share < 50) add('curioso', `Top 3 concentra ${top3.toFixed(0)} % de ${L}`, `De ${R.length} ${String(r.dimLabel || 'grupos').toLowerCase()}, tres explican casi todo.`, '')
    // 4) Valores atípicos
    if (R.length >= 6) {
      const vs = R.map(x => x.v), m = vs.reduce((s, x) => s + x, 0) / vs.length, sd = Math.sqrt(vs.reduce((s, x) => s + (x - m) ** 2, 0) / vs.length)
      const at = R.filter(x => sd && (x.v - m) / sd > 3).filter(x => x.k !== top.k || share < 50)
      if (at.length) add('curioso', `Valor atípico: ${at.slice(0, 3).map(x => x.k).join(', ')}`, `Se aleja más de 3 desviaciones del promedio de ${String(r.dimLabel || 'grupos').toLowerCase()}.`, 'Revisar que no sea un error de digitación o tipo de cambio.')
    }
  }
  // 5) Negativos
  const neg = (r.ranking || []).filter(x => x.v < 0)
  if (neg.length) add('alarma', `${neg.length} ${String(r.dimLabel || 'grupo').toLowerCase()}(s) con ${L} negativo`, `${neg.slice(0, 4).map(x => `${x.k} (${fmtN(x.v)})`).join(' · ')}${neg.length > 4 ? '…' : ''}.`, 'Revisar notas de crédito, costos mal cargados o ventas bajo costo.')
  if (r.total < 0) add('alarma', `${L} total negativo (${fmtN(r.total)})`, 'El resultado global está en negativo con los filtros actuales.', 'Revisar costos y devoluciones del período.')

  // 6) Medidas «malas» con saldo (pendiente, vencido, descuadre, mora…)
  ;(r.medidas || []).forEach(m => {
    const v = Number(m.valor) || 0
    if (/descuadre/i.test(m.label) && v !== 0) add('alarma', `${m.label}: ${fmtN(v)}`, 'Hay asientos/valores que no cuadran.', 'Corregir antes del cierre contable.')
    else if (/vencid|mora/i.test(m.label) && v > 0) add('alarma', `${m.label}: ${fmtN(v)}`, 'Hay montos vencidos.', 'Gestionar cobro/pago y reprogramar vencimientos.')
    else if (/pendiente|por pagar|por cobrar/i.test(m.label) && v > 0 && r.total && Math.abs(v) / Math.abs(r.total) > .25) add('revisar', `${m.label}: ${fmtN(v)} (${(Math.abs(v) / Math.abs(r.total) * 100).toFixed(0)} % del total)`, 'Una parte importante sigue sin regularizarse.', 'Asignar responsable y fecha para ponerlo al día.')
  })

  // 7) Calidad de datos
  if (r.registros > 0 && r.sinDato > 0) {
    const p = r.sinDato / r.registros * 100
    add(p >= 10 ? 'revisar' : 'curioso', `${r.sinDato} registro(s) sin ${String(r.campoSinDato || 'dato')} (${p.toFixed(0)} %)`, 'Quedan agrupados como «(sin dato)» y distorsionan el análisis.', 'Completar el dato en el documento original.')
  }
  if (r.registros > 0 && r.sinFecha > 0) add('revisar', `${r.sinFecha} registro(s) sin fecha`, 'No aparecen en los gráficos por período.', 'Completar la fecha en el documento original.')
  if (!r.registros) add('revisar', 'Sin registros con los filtros actuales', 'El reporte salió vacío.', 'Ampliar el período o limpiar filtros antes de compartirlo.')

  const orden = { alarma: 0, revisar: 1, curioso: 2 }
  return out.sort((a, b) => orden[a.nivel] - orden[b.nivel])
}

export const NIVELES = {
  alarma: { ico: '🔴', txt: 'Alarma', color: '#dc2626', bg: '#fef2f2' },
  revisar: { ico: '🟠', txt: 'Revisar', color: '#d97706', bg: '#fffbeb' },
  curioso: { ico: '🔵', txt: 'Curiosidad', color: '#2563eb', bg: '#eff6ff' }
}

/** Marca rápida para un nodo del árbol: devuelve texto del problema o ''. */
export function alertaDeNodo(label, valores = []) {
  if (/^\(sin dato\)|^\(sin fecha\)/i.test(label)) return 'Sin dato: completar en el documento original'
  if (valores.some(v => v < 0)) return 'Valor negativo: revisar notas de crédito / costos'
  return ''
}
