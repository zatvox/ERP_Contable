import { E } from '../shared/ayuda.js'
const T = t => `.module-nav .tab-btn[data-tab="${t}"]`
export default [
  E('ven.packing', T('packing'), 'Packing (PK)', 'La lista de empaque: qué lotes y cuántos kilos/conos se van a un cliente antes de facturar.', ['El PK reserva la mercadería. De un PK se emite la **factura** y luego la **guía de despacho**. Puedes importar PK en lote con la plantilla de ejemplo.'], { q: true }),
  E('ven.cpe', T('ventas'), 'Ventas (CPE)', 'Comprobantes de pago electrónicos: facturas, boletas y notas.', ['Al guardar, el sistema genera el asiento contable y la cuenta por cobrar. Una venta **anulada** deja de generar deuda.', 'Elige **Mercadería** o **Anticipo de cliente** según lo que estés facturando.'], { q: true }),
  E('ven.guias', T('guias-despacho'), 'Guías de despacho', 'Documentos de traslado de la mercadería vendida.', ['Si una factura no tiene guía, la **campanita** te lo recuerda. Una guía parcial indica que falta despachar el resto.'], { q: true }),
  E('ven.cot', '.tab-btn[data-tab="cotizaciones"]', 'Cotizaciones', 'Ofertas a clientes con precio y validez. Al aceptarse se convierten en venta o PK.', ['Si cotizas por debajo del precio de lista, el sistema genera un aviso para gerencia.'], { q: true }),
  E('ven.cli', T('clientes'), 'Clientes', 'Tu cartera: datos tributarios, condiciones de pago y contactos.', ['Al escribir un RUC o DNI el sistema consulta los datos automáticamente.'], { q: true }),
  E('ven.reportes', T('reportes'), 'Reportes de ventas', 'Evolución, por cliente, por producto, margen, vendedor, rentabilidad por lote y estado de despacho.', ['**Rentabilidad por lote** sigue cada lote desde su costo hasta su venta para ver cuánto ganaste realmente.'], { q: true }),
  E('ven.f.periodo', '#ventaPeriodo, #evPeriodo', 'Período contable', 'Mes contable al que pertenece el comprobante. Define en qué libro de ventas e IGV se declara.', null, { q: true }),
  E('ven.f.moneda', '#ventaMoneda, #evMoneda, #cotMoneda', 'Moneda', 'Moneda del comprobante. Si es dólares se usa el tipo de cambio de la fecha.', null, { q: true }),
  E('ven.b.tc', '#btnAutoTC', 'Consultar tipo de cambio', 'Trae el tipo de cambio oficial de la fecha del comprobante.', null),
  E('ven.b.nuevaguia', 'button', 'Nueva guía de despacho', 'Crea la guía de una venta ya facturada.', null, { txt: '+ Nueva Guía de Despacho' }),
]
