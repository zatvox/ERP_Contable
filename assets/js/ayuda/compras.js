import { E } from '../shared/ayuda.js'
const T = t => `.module-nav .tab-btn[data-tab="${t}"]`
export default [
  E('com.oc', T('ordenes'), 'Órdenes de compra (OC)', 'Lo que pides al proveedor antes de recibir: productos, cantidades y precio acordado.', ['La OC no mueve stock ni deuda; es el compromiso. Al recibir la mercadería registras la **compra** y la **guía**.'], { q: true }),
  E('com.compras', T('compras'), 'Compras', 'Facturas y comprobantes de proveedores. Genera la deuda (CxP) y, con la guía, el stock.', ['Tipos: **Mercadería**, **Servicio/Gasto** y **Anticipo a proveedor**. Si el proveedor es de 4ta categoría se calcula la retención automáticamente.'], { q: true }),
  E('com.guias', T('guias'), 'Guía de remisión', 'Ingreso físico de la mercadería comprada. Al procesarla entra al kardex y al stock.', ['El **kardex** es la fuente de verdad del stock: toda entrada o salida deja su movimiento.'], { q: true }),
  E('com.prov', T('proveedores'), 'Proveedores', 'Tu lista de proveedores con datos tributarios, moneda y condiciones de pago.', null, { q: true }),
  E('com.reportes', T('reportes'), 'Reportes de compras', 'Evolución, por proveedor, por producto, estado de pago e historial por carpeta de importación.', null, { q: true }),
  E('com.f.anuladas', '#filtroAnuladasCompras', 'Anuladas', 'Muestra u oculta las compras anuladas.', null, {}),
  E('com.b.recalc', '#btnRecalcularTotalesCompra', 'Recalcular desde el detalle', 'Vuelve a sumar el total de la compra a partir de las líneas de productos.', ['Úsalo si cambiaste cantidades o precios y el total no coincide con el comprobante.']),
]
