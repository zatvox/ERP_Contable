import { E } from '../shared/ayuda.js'
const T = t => `.module-nav .tab-btn[data-tab="${t}"]`
export default [
  E('crm.cot', T('cot'), 'Cotizaciones', 'Seguimiento comercial de las ofertas enviadas.', null, { q: true }),
  E('crm.stk', T('stk'), 'Stock y lotes', 'Lo disponible para ofrecer, por producto y lote.', null, { q: true }),
  E('crm.pre', T('pre'), 'Precios', 'Lista de precios y márgenes para cotizar.', ['Cotizar por debajo del precio de lista genera un aviso en la campanita.'], { q: true }),
  E('crm.cat', T('cat'), 'Catálogo web', 'Los productos que se muestran en el catálogo para clientes.', null, { q: true }),
  E('crm.web', T('web'), 'Web y flete', 'Parámetros del catálogo web y costos de flete.', null, { q: true }),
  E('crm.map', T('map'), 'Mapa', 'Ubicación de clientes y entregas en el mapa.', null, { q: true }),
  E('crm.doc', T('doc'), 'Documentos', 'Formatos de documentos comerciales (cotización, speech de venta, catálogo).', null, { q: true }),
]
