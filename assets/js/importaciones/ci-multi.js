// ============================================================================
// importaciones/ci-multi.js — Una Proforma (PI) puede tener VARIOS Commercial Invoices.
// Criterio (igual que 1 PK facturado en parciales):
//   · El anticipo se paga UNA vez sobre la PI y es una "bolsa".
//   · Cada CI absorbe una parte (comercial_invoices.anticipo_asignado; si falta, proporcional al valor).
//   · Saldo del CI = total del CI − anticipo asignado a ese CI.
//   · Lo que falta por embarcar = PI − suma de CI (kg y valor).
// ============================================================================
const num = x => { const n = parseFloat(x); return Number.isFinite(n) ? n : 0 }

/** ¿La tabla comercial_invoices tiene la columna anticipo_asignado? (viene en cualquier fila leída) */
export const tieneColAnticipo = cis => (cis || []).some(c => 'anticipo_asignado' in c)

/** Anticipo (en moneda de la PI) que absorbe `ci`. 1 solo CI sin asignar = todo el anticipo (comportamiento de siempre). */
export function anticipoDeCI(ci, cis, antBase) {
  if (!ci) return antBase
  const tot = c => num(c.valor_total_final_ci)
  if (ci.anticipo_asignado != null && ci.anticipo_asignado !== '') return Math.min(num(ci.anticipo_asignado), tot(ci) || num(ci.anticipo_asignado))
  const lista = (cis && cis.length) ? cis : [ci]
  if (lista.length <= 1) return antBase
  const asignados = lista.filter(c => c.anticipo_asignado != null && c.anticipo_asignado !== '')
  const libres = lista.filter(c => !(c.anticipo_asignado != null && c.anticipo_asignado !== ''))
  const resto = Math.max(0, antBase - asignados.reduce((t, c) => t + num(c.anticipo_asignado), 0))
  const sumaLibres = libres.reduce((t, c) => t + tot(c), 0)
  return sumaLibres > 0 ? resto * tot(ci) / sumaLibres : resto / libres.length
}

/** Lo ya facturado (CI) frente a la PI. lineasPI: detalle_orden_compra; lineasCI: detalle_comercial_invoice de TODOS los CI. */
export function resumenEmbarcado(pi, cis, lineasCI) {
  const totPI = num(pi?.total_oc), tol = num(pi?.tolerancia_porcentaje) || 10
  const valor = (cis || []).reduce((t, c) => t + num(c.valor_total_final_ci), 0)
  const kg = (cis || []).reduce((t, c) => t + num(c.cantidad_total_neto), 0)
  return { totPI, tol, valor, kg, pendiente: totPI - valor, pct: totPI > 0 ? valor / totPI * 100 : 0, completa: totPI > 0 && valor >= totPI * (1 - tol / 100) }
}
