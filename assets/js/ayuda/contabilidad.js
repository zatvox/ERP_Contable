import { E } from '../shared/ayuda.js'
const T = t => `.module-nav .tab-btn[data-tab="${t}"]`
export default [
  E('con.cuentas', T('cuentas'), 'Plan de cuentas', 'El catálogo de cuentas contables que usa el sistema.', null, { q: true }),
  E('con.asientos', T('asientos'), 'Asientos', 'Registros contables (Debe = Haber). Muchos se generan solos al vender, comprar, cobrar o pagar.', ['Con **+ Asiento** creas uno manual. Debe cuadrar siempre.'], { q: true }),
  E('con.apuntes', T('apuntes'), 'Apuntes', 'Cada línea de un asiento, útil para buscar movimientos por cuenta.', null, { q: true }),
  E('con.diarios', T('diarios'), 'Plantillas de diario', 'Plantillas para repetir asientos frecuentes.', null, { q: true }),
  E('con.diario', T('diario'), 'Libro diario', 'Todos los asientos en orden cronológico.', ['El filtro de período usa el formato **AAAA-MM** (ej. 2026-10).'], { q: true }),
  E('con.mayor', T('mayor'), 'Libro mayor', 'Movimientos agrupados por cuenta.', null, { q: true }),
  E('con.balance', T('balance'), 'Balance de comprobación', 'Saldos de todas las cuentas para verificar que todo cuadra.', null, { q: true }),
  E('con.er', T('resultado'), 'Estado de resultados', 'Ingresos, costos y gastos del período: tu ganancia o pérdida.', null, { q: true }),
  E('con.bg', T('general'), 'Balance general', 'Lo que tienes, lo que debes y tu patrimonio a una fecha.', null, { q: true }),
  E('con.per', T('periodos'), 'Períodos contables', 'Abre y cierra meses. Un período cerrado no admite cambios.', ['Cerrar un período **no se puede deshacer** a la ligera: confirma que todo esté registrado antes.'], { q: true }),
  E('con.cp', T('cobrospagos'), 'Cobros y pagos', 'Cobros y pagos vistos desde la contabilidad.', null, { q: true }),
  E('con.rep', T('reportes'), 'Reportes contables', 'Saldos por cuenta, IGV del período, control de asientos y PDTs.', ['**PDT 621** resume tu IGV mensual para declarar a SUNAT.'], { q: true }),
]
