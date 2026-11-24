import { E } from '../shared/ayuda.js'
const T = t => `.module-nav .tab-btn[data-tab="${t}"]`
export default [
  E('tes.inicio', T('inicio'), 'Inicio de Tesorería', 'Resumen de tus cajas y bancos: saldos, gastos recientes y alertas de reposición.', null, { q: true }),
  E('tes.libro', T('libro'), 'Libro de caja', 'Todos los movimientos de efectivo y banco en orden de fecha, con saldo acumulado.', null, { q: true }),
  E('tes.gastos', T('gastos'), 'Gastos', 'Registro de gastos pagados desde una caja o cuenta, con categoría y sustento.', ['• **Ámbito**: empresa o familiar.', '• **Sustento**: factura, boleta o sin sustento (afecta si es deducible).', '• Usa **+ Gasto** para registrar uno rápido desde cualquier pestaña.'], { q: true }),
  E('tes.entregas', T('entregas'), 'Entregas a rendir', 'Dinero que entregas a alguien para gastar y luego sustentar.', ['La persona **rinde** presentando comprobantes; lo no gastado vuelve a caja. Puedes bajar el **PDF de rendición**.'], { q: true }),
  E('tes.repos', T('reposiciones'), 'Reposiciones', 'Reponer el efectivo de una caja chica desde el banco.', null, { q: true }),
  E('tes.cajas', T('cajas'), 'Cajas', 'Tus cajas de efectivo (por moneda y responsable).', null, { q: true }),
  E('tes.bancos', T('cuentas-banco'), 'Cuentas bancarias', 'Tus cuentas por empresa y moneda, con su saldo contable.', null, { q: true }),
  E('tes.transf', T('transferencias'), 'Transferencias entre cuentas', 'Mover dinero entre tus cuentas o cajas sin que sea ingreso ni gasto.', ['Si las cuentas son de distinta moneda se usa tipo de cambio.'], { q: true }),
  E('tes.conc', T('conciliacion'), 'Conciliación', 'Compara el saldo del sistema contra el estado de cuenta del banco para encontrar diferencias.', ['Elige el mes y pulsa **Ver diferencia**: te muestra qué movimientos faltan a un lado u otro.'], { q: true }),
  E('tes.repb', T('reportes-banco'), 'Reportes bancarios', 'Reportes de movimientos y saldos por cuenta bancaria.', null, { q: true }),
  E('tes.rep', T('reportes'), 'Reportes de tesorería', 'Flujo por mes, por categoría, por cuenta y posición de tesorería.', null, { q: true }),
  E('tes.f.sustento', '#gasFiltroSustento', 'Filtro Sustento', 'Gastos con o sin comprobante.', null, { q: true }),
  E('tes.f.ambito', '#gasFiltroAmbito', 'Filtro Ámbito', 'Empresa o familiar: separa lo del negocio de lo personal.', null, { q: true }),
]
