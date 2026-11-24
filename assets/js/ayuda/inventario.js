import { E } from '../shared/ayuda.js'
const T = t => `.module-nav .tab-btn[data-tab="${t}"]`
export default [
  E('inv.prod', T('productos'), 'Productos', 'Tu catálogo: cada producto con su familia, unidad, partida y estado.', ['Un producto se organiza en **familia → categoría → marca**. La **partida** arancelaria se usa en importaciones.'], { q: true }),
  E('inv.attr', T('atributos'), 'Familias y atributos', 'Define cómo se clasifican y describen tus productos (familias, categorías, marcas, partidas).', null, { q: true }),
  E('inv.lotes', T('lotes'), 'Lotes', 'Cada lote es una compra/producción identificable, con su costo y ubicación.', ['El lote permite saber **cuánto costó** lo que vendiste y de qué importación vino.'], { q: true }),
  E('inv.resumen', T('resumen'), 'Resumen de stock', 'Stock actual en una sola tabla: General (total) o Por ubicación (almacén/zona).', ['Puedes exportar a Excel o PDF lo que ves. El orden se cambia haciendo clic en las columnas.'], { q: true }),
  E('inv.kardex', T('kardex'), 'Kardex valorizado', 'El libro de movimientos de inventario con cantidades y valor.', ['Es la **fuente de verdad** del stock: toda compra, venta, traslado y ajuste deja un movimiento aquí.'], { q: true }),
  E('inv.hist', T('historial'), 'Historial de movimientos', 'Línea de tiempo de cada movimiento con su documento de origen.', null, { q: true }),
  E('inv.rep', T('reportes-gerenciales'), 'Reportes de inventario', 'Valorización, rotación/sin movimiento, lotes y ubicaciones, kardex resumido.', null, { q: true }),
  E('inv.f.stock', '#filtroProdStock, #filtroResumenStock', 'Filtro Stock total', 'Con stock, sin stock o bajo mínimo.', null, { q: true }),
  E('inv.f.zona', '#filtroZonaStock', 'Filtro Zona', 'Limita el stock a una zona del almacén.', null, { q: true }),
  E('inv.b.traslado', 'button', 'Nuevo traslado', 'Mueve mercadería entre almacenes o zonas sin cambiar el stock total.', null, { txt: '+ Nuevo Traslado' }),
]
