import { E } from '../shared/ayuda.js'
const T = t => `.module-nav .tab-btn[data-tab="${t}"]`
export default [
  E('das.fin', T('financiero'), 'Resumen financiero', 'Lo que te deben, lo que debes, bancos, IGV y retenciones del período.', ['**Posición** = por cobrar + bancos − por pagar. Los vencimientos próximos y los top deudores te dicen dónde actuar primero.'], { q: true }),
  E('das.com', T('comercial'), 'Resumen comercial', 'Ventas, compras, inventario y despachos pendientes.', null, { q: true }),
  E('das.est', T('estadisticas'), 'Estadísticas', 'Centro de estadísticas con gráficos y comparativos.', null, { q: true }),
  E('das.cfg', T('configuracion'), 'Configuración del dashboard', 'Elige la vista y el período con que abre el dashboard, y cada cuánto se actualiza.', null, { q: true }),
  E('das.per', '#dashPeriodo', 'Período', 'Rango de fechas de las cifras: mes, año o personalizado.', null, { q: true }),
  E('das.mon', '#dashMoneda', 'Moneda', 'Muestra las cifras en soles, dólares o ambas sin mezclar.', null, { q: true }),
]
