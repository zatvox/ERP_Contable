// ============================================================================
// estadisticas/catalogo.js — Fichas de los reportes del Centro de estadísticas
// Cada ficha: id del reporte (el mismo de la sub-pestaña del módulo), la PREGUNTA de
// negocio que responde y la INTENCIÓN visual (guía qué gráfico se muestra primero).
//   intencion: evolucion | ranking | composicion | antiguedad | flujo
//   custom: true → vista propia del módulo (no usa el motor de reportes)
// ============================================================================
export const MODULOS = [
  { id: 'compras',      ico: '🛒', nombre: 'Compras' },
  { id: 'ventas',       ico: '📈', nombre: 'Ventas' },
  { id: 'inventario',   ico: '📦', nombre: 'Inventario' },
  { id: 'cobranzas',    ico: '💰', nombre: 'Cobranzas' },
  { id: 'bancos',       ico: '🏦', nombre: 'Bancos' },
  { id: 'contabilidad', ico: '📑', nombre: 'Contabilidad' }
]

export const REPORTES = [
  // Compras
  { m: 'compras', id: 'repcm-evolucion',  nombre: 'Evolución de compras', pregunta: '¿Cuánto compro cada mes y cómo se mueve mi crédito fiscal?', intencion: 'evolucion' },
  { m: 'compras', id: 'repcm-proveedores', nombre: 'Por proveedor',       pregunta: '¿A qué proveedores les compro más y cuánto dependo de los principales?', intencion: 'ranking' },
  { m: 'compras', id: 'repcm-productos',  nombre: 'Por producto',         pregunta: '¿Qué productos concentran mis compras?', intencion: 'ranking' },
  { m: 'compras', id: 'repcm-pagos',      nombre: 'Estado de pago',       pregunta: '¿Cuánto debo todavía y qué parte ya pagué?', intencion: 'composicion' },
  { m: 'compras', id: 'repcm-carpeta',    nombre: 'Historial por carpeta', pregunta: '¿Qué carpetas, productos y clientes dejan más margen?', intencion: 'ranking' },
  // Ventas
  { m: 'ventas', id: 'repv-evolucion', nombre: 'Evolución de ventas', pregunta: '¿Cuánto vendo por mes y con qué margen?', intencion: 'evolucion' },
  { m: 'ventas', id: 'repv-clientes',  nombre: 'Por cliente',         pregunta: '¿Qué clientes concentran mis ventas?', intencion: 'ranking' },
  { m: 'ventas', id: 'repv-productos', nombre: 'Por producto',        pregunta: '¿Qué productos me dejan más ingreso y cantidad?', intencion: 'ranking' },
  { m: 'ventas', id: 'repv-margen',    nombre: 'Margen bruto',        pregunta: '¿Dónde gano y dónde pierdo margen?', intencion: 'ranking' },
  { m: 'ventas', id: 'repv-vendedor',  nombre: 'Por vendedor',        pregunta: '¿Cómo rinde cada vendedor?', intencion: 'ranking' },
  { m: 'ventas', id: 'repv-lote',      nombre: 'Rentabilidad por lote', pregunta: '¿Qué lotes rinden más y cuáles tienen el costo pendiente?', intencion: 'ranking' },
  { m: 'ventas', id: 'repv-despacho',  nombre: 'Estado de despacho',  pregunta: '¿Qué parte de lo facturado falta despachar?', intencion: 'composicion' },
  // Inventario
  { m: 'inventario', id: 'repi-valorizacion', nombre: 'Valorización',            pregunta: '¿Cuánto vale mi stock y dónde se concentra?', intencion: 'composicion' },
  { m: 'inventario', id: 'repi-rotacion',     nombre: 'Rotación / Sin movimiento', pregunta: '¿Qué productos rotan y cuáles están dormidos?', intencion: 'ranking' },
  { m: 'inventario', id: 'repi-lotes',        nombre: 'Lotes y ubicaciones',     pregunta: '¿Qué lotes y ubicaciones guardan más stock?', intencion: 'composicion' },
  { m: 'inventario', id: 'repi-kardex',       nombre: 'Kardex resumido',         pregunta: '¿Cómo entran y salen mis productos en el tiempo?', intencion: 'evolucion' },
  // Cobranzas
  { m: 'cobranzas', id: 'rep-estado-cuenta',   nombre: 'Estado de cuenta',  pregunta: '¿Cómo está la cuenta de cada cliente o proveedor?', intencion: 'ranking', custom: true },
  { m: 'cobranzas', id: 'rep-antiguedad-cxc',  nombre: 'Antigüedad CxC',    pregunta: '¿Qué tan vencida está mi cartera por cobrar?', intencion: 'antiguedad' },
  { m: 'cobranzas', id: 'rep-antiguedad-cxp',  nombre: 'Antigüedad CxP',    pregunta: '¿Qué tan vencidas están mis deudas con proveedores?', intencion: 'antiguedad' },
  { m: 'cobranzas', id: 'rep-cobros',          nombre: 'Cobranza',          pregunta: '¿Cuánto cobro y por qué medio?', intencion: 'evolucion' },
  { m: 'cobranzas', id: 'rep-pagos',           nombre: 'Pagos',             pregunta: '¿Cuánto pago y a quién?', intencion: 'evolucion' },
  { m: 'cobranzas', id: 'rep-retenciones',     nombre: 'Retenciones',       pregunta: '¿Qué retenciones están pendientes de sustento?', intencion: 'ranking' },
  { m: 'cobranzas', id: 'rep-flujo',           nombre: 'Flujo proyectado',  pregunta: '¿Cómo se proyecta mi flujo de cobros y pagos?', intencion: 'flujo' },
  // Bancos
  { m: 'bancos', id: 'repb-flujo',      nombre: 'Flujo por mes',          pregunta: '¿Cuánto entra y cuánto sale cada mes?', intencion: 'flujo' },
  { m: 'bancos', id: 'repb-categorias', nombre: 'Por categoría',          pregunta: '¿En qué categorías se va el dinero?', intencion: 'composicion' },
  { m: 'bancos', id: 'repb-cuentas',    nombre: 'Por cuenta',             pregunta: '¿Cómo se mueve cada cuenta bancaria?', intencion: 'ranking' },
  { m: 'bancos', id: 'repb-posicion',   nombre: 'Posición de tesorería',  pregunta: '¿Cuál es mi posición de tesorería hoy?', intencion: 'composicion' },
  // Contabilidad
  { m: 'contabilidad', id: 'repc-cuentas',    nombre: 'Saldos por cuenta',   pregunta: '¿Cuáles son los saldos de cada cuenta contable?', intencion: 'ranking' },
  { m: 'contabilidad', id: 'repc-movimiento', nombre: 'Movimiento contable', pregunta: '¿Cómo se mueve la contabilidad en el tiempo?', intencion: 'evolucion' },
  { m: 'contabilidad', id: 'repc-igv',        nombre: 'IGV del período',     pregunta: '¿Cuánto IGV pagaré este período y cómo se compone?', intencion: 'evolucion' },
  { m: 'contabilidad', id: 'repc-descuadres', nombre: 'Control de asientos', pregunta: '¿Hay asientos descuadrados y dónde?', intencion: 'ranking' },
  { m: 'contabilidad', id: 'repc-pdt621',     nombre: 'PDTs',                pregunta: 'Vista propia: ábrela en Contabilidad → Reportes.', custom: true }
]

export const reportesDe = m => REPORTES.filter(r => r.m === m)
export const buscarReporte = id => REPORTES.find(r => r.id === id) || null
