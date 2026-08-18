// ============================================================================
// SUNAT-API.JS — Integración SUNAT: NUBEFACT (CPE) + APIs.pe (RUC/DNI)
// ============================================================================
// Proveedores:
//   CPE (facturas/boletas electrónicas): NUBEFACT - https://nubefact.com
//   Consulta RUC/DNI:                    APIs.pe   - https://apis.pe
//
// Configuración en config.js → SUNAT_CONFIG:
//   NUBEFACT_TOKEN   → token de la empresa en NUBEFACT
//   NUBEFACT_RUC     → RUC de la empresa emisora
//   APIS_PE_TOKEN    → token de APIs.pe para consulta RUC/DNI
//   AMBIENTE         → 'demo' | 'produccion'
// ============================================================================

import { SUNAT_CONFIG } from './config.js'

// ============================================================================
// HELPERS INTERNOS
// ============================================================================

const NUBEFACT_BASE = {
  demo:       'https://ose.nubefact.com/ol-ti-itcpe/linkcharge/0010/xmlService',
  produccion: 'https://factura.sunat.gob.pe/ol-ti-itcpe/linkcharge/0010/xmlService'
}

// URL del API REST de NUBEFACT
const NUBEFACT_API = {
  demo:       'https://api.nubefact.com/api/v1',
  produccion: 'https://api.nubefact.com/api/v1'
}

function nubefactHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Token token="${SUNAT_CONFIG?.NUBEFACT_TOKEN || ''}"`
  }
}

function apispeHeaders() {
  return {
    'Referer':       'https://apis.pe',
    'Authorization': `Bearer ${SUNAT_CONFIG?.APIS_PE_TOKEN || ''}`
  }
}

// ============================================================================
// CONSULTA DE RUC (APIs.pe)
// ============================================================================

/**
 * Consulta datos de una empresa por RUC vía APIs.pe.
 * Retorna { ruc, razonSocial, nombreComercial, direccion, estado, condicion }
 * o null si no se encuentra.
 */
export async function consultarRUC(ruc) {
  if (!ruc || String(ruc).length !== 11) {
    return { error: 'El RUC debe tener 11 dígitos' }
  }

  const token = SUNAT_CONFIG?.APIS_PE_TOKEN
  if (!token) {
    console.warn('APIs.pe: no hay token configurado en SUNAT_CONFIG.APIS_PE_TOKEN')
    return { error: 'API no configurada. Ver SETUP.md para obtener token.' }
  }

  try {
    const res = await fetch(`https://api.apis.pe/v2/ruc?numero=${ruc}`, {
      headers: apispeHeaders()
    })

    if (!res.ok) {
      const texto = await res.text()
      return { error: `Error APIs.pe: ${res.status} — ${texto.slice(0, 100)}` }
    }

    const data = await res.json()
    return {
      ruc:              data.ruc             || ruc,
      razonSocial:      data.razonSocial     || data.nombre || '',
      nombreComercial:  data.nombreComercial || '',
      tipo:             data.tipo            || '',
      estado:           data.estado          || '',       // 'ACTIVO', 'BAJA DE OFICIO'
      condicion:        data.condicion       || '',       // 'HABIDO', 'NO HABIDO'
      ubigeo:           data.ubigeo          || '',
      direccion:        data.direccion       || '',
      departamento:     data.departamento    || '',
      provincia:        data.provincia       || '',
      distrito:         data.distrito        || '',
      actividadEconomica: data.actividadEconomica || ''
    }
  } catch (err) {
    console.error('Error consultarRUC:', err)
    return { error: 'Sin conexión o error al consultar RUC' }
  }
}

/**
 * Consulta datos de una persona por DNI vía APIs.pe.
 * Retorna { dni, nombres, apellidoPaterno, apellidoMaterno, nombreCompleto }
 */
export async function consultarDNI(dni) {
  if (!dni || String(dni).length !== 8) {
    return { error: 'El DNI debe tener 8 dígitos' }
  }

  const token = SUNAT_CONFIG?.APIS_PE_TOKEN
  if (!token) {
    return { error: 'API no configurada. Ver SETUP.md para obtener token.' }
  }

  try {
    const res = await fetch(`https://api.apis.pe/v2/dni?numero=${dni}`, {
      headers: apispeHeaders()
    })

    if (!res.ok) {
      return { error: `Error APIs.pe DNI: ${res.status}` }
    }

    const data = await res.json()
    return {
      dni:             data.dni             || dni,
      nombres:         data.nombres         || '',
      apellidoPaterno: data.apellidoPaterno || '',
      apellidoMaterno: data.apellidoMaterno || '',
      nombreCompleto:  data.nombreCompleto  || `${data.nombres} ${data.apellidoPaterno} ${data.apellidoMaterno}`.trim()
    }
  } catch (err) {
    console.error('Error consultarDNI:', err)
    return { error: 'Sin conexión o error al consultar DNI' }
  }
}

// ============================================================================
// TIPO DE CAMBIO SBS / SUNAT (APIs.pe)
// ============================================================================

/**
 * Obtiene el tipo de cambio USD/PEN del día o de una fecha específica.
 * Fuente: APIs.pe → SBS (Superintendencia de Banca y Seguros)
 *
 * NORMATIVA SUNAT (Art. 61° LIR + Art. 5° Rgto. IGV):
 *   Ventas en ME        → usar campo `venta`
 *   Compras/importac.   → usar campo `compra`
 *
 * @param {string|null} fecha - 'YYYY-MM-DD'. Si es null, devuelve el del día.
 * @returns {{ compra: number, venta: number, fecha: string, origen: string }|{ error: string }}
 */
export async function getTipoCambioDia(fecha = null) {
  const token = SUNAT_CONFIG?.APIS_PE_TOKEN
  const url = fecha
    ? `https://api.apis.pe/v1/tipo-cambio?fecha=${fecha}`
    : 'https://api.apis.pe/v1/tipo-cambio'

  // El endpoint de TC en apis.pe es público, pero si hay token lo enviamos
  const headers = (token && !token.startsWith('REEMPLAZAR'))
    ? apispeHeaders()
    : { 'Referer': 'https://apis.pe' }

  try {
    const res = await fetch(url, { headers })
    if (!res.ok) {
      const texto = await res.text()
      return { error: `Error APIs.pe TC ${res.status}: ${texto.slice(0, 80)}` }
    }
    const data = await res.json()
    const compra = parseFloat(data.compra || 0)
    const venta  = parseFloat(data.venta  || 0)
    if (!compra || !venta) {
      return { error: 'Respuesta inválida del API de tipo de cambio' }
    }
    return {
      compra,
      venta,
      fecha:  data.fecha  || fecha || new Date().toISOString().split('T')[0],
      origen: data.origen || 'SBS'
    }
  } catch (err) {
    console.error('getTipoCambioDia:', err)
    return { error: 'Sin conexión o error al consultar tipo de cambio' }
  }
}

/**
 * TC VENTA SBS — usar para registrar VENTAS en moneda extranjera.
 * Base legal: Art. 61° LIR + Art. 5° Rgto. del IGV.
 *
 * @param {string|null} fecha - 'YYYY-MM-DD' o null para hoy
 * @returns {{ tc: number, tipo: 'venta', fecha: string, origen: string }|{ error: string }}
 */
export async function getTCVenta(fecha = null) {
  const result = await getTipoCambioDia(fecha)
  if (result.error) return result
  return { tc: result.venta, tipo: 'venta', fecha: result.fecha, origen: result.origen }
}

/**
 * TC COMPRA SBS — usar para registrar COMPRAS e IMPORTACIONES en ME.
 * Base legal: Art. 61° LIR.
 *
 * @param {string|null} fecha - 'YYYY-MM-DD' o null para hoy
 * @returns {{ tc: number, tipo: 'compra', fecha: string, origen: string }|{ error: string }}
 */
export async function getTCCompra(fecha = null) {
  const result = await getTipoCambioDia(fecha)
  if (result.error) return result
  return { tc: result.compra, tipo: 'compra', fecha: result.fecha, origen: result.origen }
}

// ============================================================================
// NUBEFACT — CPE (Comprobantes de Pago Electrónicos)
// ============================================================================

/**
 * Construye el objeto JSON de una Factura o Boleta para NUBEFACT.
 *
 * @param {Object} venta - datos del comprobante
 * @param {Array}  lineas - lineas de detalle
 * @param {Object} empresa - datos de la empresa emisora
 * @returns {Object} payload listo para enviar a NUBEFACT
 */
export function buildPayloadNubefact(venta, lineas, empresa) {
  const tipoDoc = venta.tipo_comprobante   // '01' factura, '03' boleta
  const igvRate = 0.18

  const items = lineas.map((l, i) => ({
    unidad_de_medida:   l.unidad_medida || 'KG',
    codigo:             l.item_codigo  || String(i + 1).padStart(3, '0'),
    descripcion:        l.descripcion  || '',
    cantidad:           parseFloat(l.cantidad || 0),
    valor_unitario:     parseFloat(l.precio_unitario || 0),
    precio_unitario:    parseFloat((parseFloat(l.precio_unitario || 0) * (1 + igvRate)).toFixed(2)),
    subtotal:           parseFloat(l.subtotal || 0),
    tipo_de_igv:        l.tipo_base === 'gravada' ? 1 : (l.tipo_base === 'exonerada' ? 2 : 3),
    igv:                parseFloat(l.igv_monto || 0),
    total:              parseFloat(l.total_linea || 0),
    anticipo_regularizacion: false
  }))

  const payload = {
    operacion:              'generar_comprobante',
    tipo_de_comprobante:    parseInt(tipoDoc, 10),
    serie:                  venta.serie   || (tipoDoc === '01' ? 'F001' : 'B001'),
    numero:                 parseInt(venta.correlativo || 1, 10),
    sunat_transaction:      1,
    cliente_tipo_de_documento: venta.cliente_tipo_doc || '6',  // 6=RUC, 1=DNI
    cliente_numero_de_documento: venta.cliente_doc    || '',
    cliente_denominacion:   venta.cliente_nombre || '',
    cliente_direccion:      venta.cliente_direccion  || '',
    cliente_email:          venta.cliente_email      || '',
    fecha_de_emision:       venta.fecha_emision || new Date().toISOString().split('T')[0],
    fecha_de_vencimiento:   venta.fecha_vencimiento  || '',
    moneda:                 venta.moneda === 'USD' ? 2 : 1,  // 1=PEN, 2=USD
    tipo_de_cambio:         venta.tipo_cambio    || '',
    porcentaje_de_igv:      18.00,
    total_gravada:          parseFloat(venta.base_imponible || 0),
    total_exonerada:        0,
    total_inafecta:         0,
    total_igv:              parseFloat(venta.igv || 0),
    total_otros_cargos:     0,
    total:                  parseFloat(venta.total || 0),
    enviar_automaticamente_a_la_sunat: true,
    enviar_automaticamente_al_cliente: false,
    codigo_unico:           venta.id || '',
    condiciones_de_pago:    'Contado',
    medio_de_pago:          '',
    placa_vehiculo:         '',
    orden_compra_servicio:  '',
    observaciones:          venta.observaciones || '',
    datos_del_emisor: {
      codigo_del_producto_de_la_sunat: ''
    },
    items
  }

  return payload
}

/**
 * Envía un comprobante a NUBEFACT y retorna la respuesta.
 * La respuesta incluye: enlace_del_pdf, enlace_del_xml, cadena_para_codigo_qr, hash.
 *
 * @param {Object} venta  - cabecera de la venta
 * @param {Array}  lineas - líneas de detalle
 * @param {Object} empresa - { ruc, razonSocial, ... }
 * @returns {Object} { ok, enlace_pdf, enlace_xml, qr, hash, error }
 */
export async function emitirCPE(venta, lineas, empresa) {
  const token = SUNAT_CONFIG?.NUBEFACT_TOKEN
  if (!token) {
    return { ok: false, error: 'NUBEFACT_TOKEN no configurado. Ver SETUP.md.' }
  }

  const ambiente = SUNAT_CONFIG?.AMBIENTE || 'demo'
  const ruc_emisor = SUNAT_CONFIG?.NUBEFACT_RUC || empresa?.ruc || ''

  if (!ruc_emisor) {
    return { ok: false, error: 'RUC emisor no configurado en SUNAT_CONFIG.NUBEFACT_RUC.' }
  }

  const payload = buildPayloadNubefact(venta, lineas, empresa)

  try {
    const url = `${NUBEFACT_API[ambiente]}/${ruc_emisor}/comprobantes`
    const res = await fetch(url, {
      method:  'POST',
      headers: nubefactHeaders(),
      body:    JSON.stringify(payload)
    })

    const data = await res.json()

    if (!res.ok || data.errors) {
      const errMsg = data.errors
        ? Object.values(data.errors).flat().join('; ')
        : `Error NUBEFACT: ${res.status}`
      return { ok: false, error: errMsg, raw: data }
    }

    return {
      ok:            true,
      nubefact_id:   String(data.numero || ''),
      enlace_pdf:    data.enlace_del_pdf     || data.pdf_url || '',
      enlace_xml:    data.enlace_del_xml     || data.xml_url || '',
      qr:            data.cadena_para_codigo_qr || '',
      hash:          data.hash              || '',
      aceptado:      data.aceptado_por_sunat ?? null,
      raw:           data
    }
  } catch (err) {
    console.error('Error emitirCPE:', err)
    return { ok: false, error: 'Error de red al conectar con NUBEFACT' }
  }
}

/**
 * Consulta el estado de un comprobante en NUBEFACT.
 * @param {string} tipoComprobante '01' | '03'
 * @param {string} serie           'F001'
 * @param {number} numero           1
 */
export async function consultarEstadoCPE(tipoComprobante, serie, numero) {
  const token = SUNAT_CONFIG?.NUBEFACT_TOKEN
  const ruc   = SUNAT_CONFIG?.NUBEFACT_RUC
  const amb   = SUNAT_CONFIG?.AMBIENTE || 'demo'

  if (!token || !ruc) {
    return { ok: false, error: 'NUBEFACT no configurado' }
  }

  try {
    const url = `${NUBEFACT_API[amb]}/${ruc}/comprobantes/${tipoComprobante}/${serie}/${numero}`
    const res = await fetch(url, { headers: nubefactHeaders() })
    const data = await res.json()

    return {
      ok:          res.ok,
      aceptado:    data.aceptado_por_sunat,
      enlace_pdf:  data.enlace_del_pdf || '',
      enlace_xml:  data.enlace_del_xml || '',
      raw:         data
    }
  } catch (err) {
    return { ok: false, error: 'Error al consultar estado CPE' }
  }
}

/**
 * Genera una Nota de Crédito/Débito electrónica en NUBEFACT.
 * @param {Object} nota - { tipo_comprobante: '07'|'08', motivo, ... }
 * @param {Object} docRef - { tipo, serie, numero } documento de referencia
 */
export async function emitirNota(nota, lineas, docRef, empresa) {
  const payload = buildPayloadNubefact(nota, lineas, empresa)

  // Campos adicionales para nota
  payload.tipo_de_nota_de_credito = nota.tipo_nota || 1  // 1=Anulación
  payload.motivo_o_sustento_de_la_nota = nota.motivo || ''
  payload.documento_que_se_modifica_tipo = parseInt(docRef.tipo, 10)
  payload.documento_que_se_modifica_serie = docRef.serie
  payload.documento_que_se_modifica_numero = parseInt(docRef.numero, 10)

  const token = SUNAT_CONFIG?.NUBEFACT_TOKEN
  const ruc   = SUNAT_CONFIG?.NUBEFACT_RUC
  const amb   = SUNAT_CONFIG?.AMBIENTE || 'demo'

  if (!token || !ruc) return { ok: false, error: 'NUBEFACT no configurado' }

  try {
    const res = await fetch(`${NUBEFACT_API[amb]}/${ruc}/comprobantes`, {
      method:  'POST',
      headers: nubefactHeaders(),
      body:    JSON.stringify(payload)
    })
    const data = await res.json()
    return {
      ok:         res.ok && !data.errors,
      enlace_pdf: data.enlace_del_pdf || '',
      enlace_xml: data.enlace_del_xml || '',
      raw:        data
    }
  } catch (err) {
    return { ok: false, error: 'Error al emitir nota' }
  }
}

// ============================================================================
// UI HELPERS — para usar directamente en formularios
// ============================================================================

/**
 * Al ingresar un RUC en un campo, consulta y autocompleta razón social y dirección.
 * @param {string} rucInputId  - id del input de RUC
 * @param {string} nombreId    - id del input/span de razón social a rellenar
 * @param {string} [direccionId] - id opcional del input de dirección
 * @param {string} [estadoId]    - id opcional de badge/span de estado SUNAT
 */
export function attachRucAutocomplete(rucInputId, nombreId, direccionId = null, estadoId = null) {
  const rucInput = document.getElementById(rucInputId)
  if (!rucInput) return

  let debounceTimer = null

  rucInput.addEventListener('input', () => {
    clearTimeout(debounceTimer)
    const ruc = rucInput.value.trim()
    if (ruc.length !== 11) return

    debounceTimer = setTimeout(async () => {
      const spinner = document.getElementById(`${rucInputId}-spinner`)
      if (spinner) spinner.style.display = 'inline-block'

      const datos = await consultarRUC(ruc)

      if (spinner) spinner.style.display = 'none'

      if (datos.error) {
        console.warn('RUC no encontrado:', datos.error)
        return
      }

      const nombreEl = document.getElementById(nombreId)
      if (nombreEl) nombreEl.value = datos.razonSocial

      if (direccionId) {
        const dirEl = document.getElementById(direccionId)
        if (dirEl) dirEl.value = [datos.direccion, datos.distrito, datos.provincia, datos.departamento].filter(Boolean).join(', ')
      }

      if (estadoId) {
        const estadoEl = document.getElementById(estadoId)
        if (estadoEl) {
          estadoEl.textContent = `${datos.estado} / ${datos.condicion}`
          estadoEl.style.color = datos.estado === 'ACTIVO' && datos.condicion === 'HABIDO' ? 'var(--color-success)' : 'var(--color-danger)'
        }
      }
    }, 600)
  })
}
