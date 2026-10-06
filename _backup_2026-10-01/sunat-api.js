// ============================================================================
// SUNAT-API.JS — Integración SUNAT: NUBEFACT (CPE) + Decolecta/APIs.pe (RUC/DNI)
// ============================================================================
// Proveedores:
//   CPE (facturas/boletas electrónicas): NUBEFACT   - https://nubefact.com
//   Consulta RUC/DNI (PRINCIPAL):        Decolecta   - https://decolecta.com
//   Consulta RUC/DNI (RESPALDO):         APIs.pe     - https://apis.pe
//
// Decolecta es la fuente principal (100 consultas/mes en el plan gratuito).
// Se llama a través de la Edge Function propia `decolecta-proxy` (carpeta
// supabase/functions/decolecta-proxy/) en vez de pegarle directo desde el
// navegador: Decolecta no devuelve cabecera CORS a llamadas de navegador
// (falla siempre, sin importar el dominio — localhost o producción), y
// además el token no debe viajar en código de frontend (config.js se sirve
// tal cual al navegador; cualquiera podría copiárselo y gastar la cuota).
// El token real vive como secreto de Supabase (`DECOLECTA_TOKEN`), nunca en
// config.js. Ver instrucciones de deploy al final de index.ts del proxy.
//
// Si el proxy no está desplegado, o la llamada falla (red, cuota agotada,
// error del servicio), se cae automáticamente a APIs.pe sin que el usuario
// note la diferencia. Cada llamada que SÍ llega a pegarle a Decolecta se
// registra en decolecta_consultas_log (consume cuota, haya encontrado el
// documento o no) para poder mostrar "cuántas consultas quedan este mes" en
// Configuración → APIs externas (no hay endpoint oficial de cuota).
//
// Configuración en config.js → SUNAT_CONFIG:
//   NUBEFACT_TOKEN   → token de la empresa en NUBEFACT
//   NUBEFACT_RUC     → RUC de la empresa emisora
//   APIS_PE_TOKEN    → token de APIs.pe para consulta RUC/DNI (respaldo)
//   AMBIENTE         → 'demo' | 'produccion'
// (DECOLECTA_TOKEN ya NO va aquí — es un secreto de Supabase, ver arriba)
// ============================================================================

import { SUNAT_CONFIG } from './config.js'
import { supabase } from './supabase-client.js'
import { addDecolectaConsultaLog } from './supabase-data.js'
import { getCurrentUser } from './auth-supabase.js'
import { showToast } from './helpers.js'

async function _logDecolecta(tipo, numero, exitosa, mensajeError) {
  try {
    const user = await getCurrentUser()
    await addDecolectaConsultaLog(tipo, numero, exitosa, mensajeError, null, user?.db_id || null)
  } catch (e) {
    // El log es informativo — si falla, no debe romper la consulta real.
    console.warn('No se pudo registrar consumo de Decolecta:', e)
  }
}

/** Llama a la Edge Function decolecta-proxy. Lanza si la función no responde (red/no desplegada). */
async function _invocarDecolectaProxy(tipo, numero) {
  const { data, error } = await supabase.functions.invoke('decolecta-proxy', { body: { tipo, numero } })
  if (error) {
    // FunctionsHttpError trae la Response real en error.context — la leemos
    // para ver el status/body exactos en consola en vez de un mensaje genérico.
    try {
      const status = error?.context?.status
      const bodyTexto = error?.context ? await error.context.clone().text() : null
      console.error(`decolecta-proxy respondió ${status ?? '?'}:`, bodyTexto)
    } catch (e) { /* no se pudo leer el detalle, se sigue con el error original */ }
    throw error
  }
  return data
}

/**
 * Consulta RUC vía Decolecta (fuente principal, a través del proxy). Retorna
 * el mismo shape que la consulta por APIs.pe para que ambas sean intercambiables.
 */
async function _consultarRUCDecolecta(ruc) {
  try {
    const data = await _invocarDecolectaProxy('ruc', ruc)

    if (data?.error) {
      await _logDecolecta('ruc', ruc, true, data.error)
      return { error: data.error }
    }
    await _logDecolecta('ruc', ruc, true, null)

    return {
      ruc:              data.numero_documento || ruc,
      razonSocial:      data.razon_social || '',
      nombreComercial:  '',
      tipo:             '',
      estado:           data.estado    || '',
      condicion:        data.condicion || '',
      ubigeo:           data.ubigeo    || '',
      direccion:        data.direccion || '',
      departamento:     data.departamento || '',
      provincia:        data.provincia    || '',
      distrito:         data.distrito     || '',
      actividadEconomica: '',
      // Solo Decolecta trae estos dos — APIs.pe (respaldo) no los tiene, por
      // eso quedan undefined en ese caso (la UI muestra '—' si no llegan).
      esAgenteRetencion:   typeof data.es_agente_retencion === 'boolean' ? data.es_agente_retencion : undefined,
      esBuenContribuyente: typeof data.es_buen_contribuyente === 'boolean' ? data.es_buen_contribuyente : undefined
    }
  } catch (err) {
    // El proxy no respondió (no desplegado aún, sin red, etc.) — no se loguea
    // porque no hay certeza de que haya llegado a consumir cuota de Decolecta.
    console.warn('decolecta-proxy no disponible para RUC, se usará respaldo:', err)
    return { error: 'Proxy de Decolecta no disponible' }
  }
}

/** Consulta DNI vía Decolecta (fuente principal, a través del proxy). */
async function _consultarDNIDecolecta(dni) {
  try {
    const data = await _invocarDecolectaProxy('dni', dni)

    if (data?.error) {
      await _logDecolecta('dni', dni, true, data.error)
      return { error: data.error }
    }
    await _logDecolecta('dni', dni, true, null)

    return {
      dni:             data.document_number || dni,
      nombres:         data.first_name || '',
      apellidoPaterno: data.first_last_name || '',
      apellidoMaterno: data.second_last_name || '',
      nombreCompleto:  data.full_name || `${data.first_name || ''} ${data.first_last_name || ''} ${data.second_last_name || ''}`.trim()
    }
  } catch (err) {
    console.warn('decolecta-proxy no disponible para DNI, se usará respaldo:', err)
    return { error: 'Proxy de Decolecta no disponible' }
  }
}

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
 * Consulta RUC: Decolecta primero (fuente principal), APIs.pe como respaldo
 * automático si Decolecta no está configurado o falla (red, cuota agotada,
 * error del servicio). Transparente para quien llama — mismo shape siempre.
 */
export async function consultarRUC(ruc) {
  if (!ruc || String(ruc).length !== 11) {
    return { error: 'El RUC debe tener 11 dígitos' }
  }

  const porDecolecta = await _consultarRUCDecolecta(ruc)
  if (!porDecolecta.error) return porDecolecta

  console.warn('Decolecta falló para RUC, cayendo a APIs.pe:', porDecolecta.error)
  return await _consultarRUCApisPe(ruc)
}

/**
 * Consulta datos de una empresa por RUC vía APIs.pe (respaldo).
 * Retorna { ruc, razonSocial, nombreComercial, direccion, estado, condicion }
 * o null si no se encuentra.
 */
async function _consultarRUCApisPe(ruc) {
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
 * Consulta DNI: Decolecta primero (fuente principal), APIs.pe como respaldo
 * automático si Decolecta no está configurado o falla.
 */
export async function consultarDNI(dni) {
  if (!dni || String(dni).length !== 8) {
    return { error: 'El DNI debe tener 8 dígitos' }
  }

  const porDecolecta = await _consultarDNIDecolecta(dni)
  if (!porDecolecta.error) return porDecolecta

  console.warn('Decolecta falló para DNI, cayendo a APIs.pe:', porDecolecta.error)
  return await _consultarDNIApisPe(dni)
}

/**
 * Consulta datos de una persona por DNI vía APIs.pe (respaldo).
 * Retorna { dni, nombres, apellidoPaterno, apellidoMaterno, nombreCompleto }
 */
async function _consultarDNIApisPe(dni) {
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
 * @param {Object} nota - { tipo_comprobante: '07'|'08', motivo_nota_codigo, motivo_nota_texto, ... }
 * @param {Object} docRef - { tipo, serie, numero } documento de referencia (el que se modifica)
 */
export async function emitirNota(nota, lineas, docRef, empresa) {
  const payload = buildPayloadNubefact(nota, lineas, empresa)

  // NUBEFACT usa un campo distinto según sea Nota de Crédito (07, Catálogo 09
  // SUNAT) o Nota de Débito (08, Catálogo 10 SUNAT) — antes se enviaba
  // siempre "tipo_de_nota_de_credito", incluso para notas de débito.
  const esND = String(nota.tipo_comprobante) === '08'
  const codigoMotivo = parseInt(nota.motivo_nota_codigo ?? nota.motivo, 10) || 1
  if (esND) {
    payload.tipo_de_nota_de_debito = codigoMotivo
  } else {
    payload.tipo_de_nota_de_credito = codigoMotivo  // Catálogo 09: 1=Anulación de la operación, etc.
  }
  payload.motivo_o_sustento_de_la_nota = nota.motivo_nota_texto || nota.motivo || ''
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

/**
 * Wirea un botón "Consultar" (RUC/DNI) para los modales de creación de
 * contacto (Nuevo Cliente en Ventas, Nuevo Proveedor en Compras, y cualquier
 * otro modal con la misma estructura Tipo Documento + Nro Documento).
 * A diferencia de attachRucAutocomplete (autocompleta al escribir 11 dígitos,
 * pensado para el RUC del cliente en una venta rápida), esta es una acción
 * explícita del usuario que respeta el selector "Tipo Documento" (RUC/DNI/VAT)
 * y llena más campos del formulario de contacto.
 *
 * @param {Object} o
 * @param {string} o.btnId        - id del botón "Consultar"
 * @param {string} o.tipoDocId    - id del <select> Tipo Documento (RUC/DNI/VAT)
 * @param {string} o.numeroId     - id del input de Nro Documento
 * @param {string} o.nombreId     - id del input de Nombre/Razón Social a llenar
 * @param {string} [o.direccionId] - id del input de Dirección
 * @param {string} [o.distritoId] - id del input de Distrito
 * @param {string} [o.paisId]     - id del input de País (se fuerza a "Perú" si RUC/DNI)
 * @param {string} [o.sunatSectionId]     - id del contenedor "Datos SUNAT" (solo RUC) — se muestra/oculta según Tipo Documento
 * @param {string} [o.estadoId]           - id del span/badge de Estado SUNAT (ACTIVO / BAJA DE OFICIO...)
 * @param {string} [o.condicionId]        - id del span/badge de Condición SUNAT (HABIDO / NO HABIDO)
 * @param {string} [o.buenContribuyenteId] - id del span/badge "Buen Contribuyente" (Sí/No)
 * @param {string} [o.agenteRetencionId]  - id del checkbox "Agente de Retención IGV" a marcar según SUNAT (campo operativo, editable)
 * @param {string} [o.agenteRetencionBadgeId] - id del span/badge de solo lectura que muestra EXACTAMENTE lo que devolvió SUNAT (Sí/No/—), para no confundirlo con el estado del checkbox (que puede haber sido tocado a mano)
 */
/**
 * Pinta un span.badge de "Datos SUNAT" (estado/condición/buen contribuyente)
 * con el color semántico correcto, reemplazando la clase badge-* anterior.
 * Se exporta porque ventas.js/compras.js también la usan al recargar un
 * contacto ya guardado en editarCliente/editarProveedor.
 */
export function pintarBadgeSunat(el, texto, tono) {
  if (!el) return
  el.textContent = texto
  el.classList.remove('badge-secondary', 'badge-success', 'badge-danger')
  el.classList.add(tono === 'success' ? 'badge-success' : tono === 'danger' ? 'badge-danger' : 'badge-secondary')
}

export function attachConsultaDocumento(o) {
  const btn = document.getElementById(o.btnId)
  const tipoDocSelect = document.getElementById(o.tipoDocId)
  if (!btn) return

  // Muestra el bloque "Datos SUNAT" solo cuando Tipo Documento = RUC (DNI/VAT
  // no tienen esos datos: estado/condición/buen contribuyente son propios de
  // empresas con RUC en SUNAT, no de personas naturales por DNI).
  function actualizarVisibilidadSunat() {
    const tipoDoc = tipoDocSelect?.value || ''
    if (o.sunatSectionId) {
      const sec = document.getElementById(o.sunatSectionId)
      if (sec) sec.style.display = (tipoDoc === 'RUC') ? '' : 'none'
    }
  }
  if (tipoDocSelect) {
    tipoDocSelect.addEventListener('change', actualizarVisibilidadSunat)
    actualizarVisibilidadSunat()
  }

  btn.addEventListener('click', async () => {
    const tipoDoc = document.getElementById(o.tipoDocId)?.value || ''
    const numero  = (document.getElementById(o.numeroId)?.value || '').trim()

    if (tipoDoc === 'VAT') {
      showToast('VAT es un documento extranjero: Decolecta/APIs.pe solo consultan RUC y DNI peruanos. Completa los datos a mano.', 'warning')
      return
    }
    if (!tipoDoc) { showToast('Selecciona primero el Tipo de Documento', 'warning'); return }
    if (tipoDoc === 'RUC' && numero.length !== 11) { showToast('El RUC debe tener 11 dígitos', 'warning'); return }
    if (tipoDoc === 'DNI' && numero.length !== 8) { showToast('El DNI debe tener 8 dígitos', 'warning'); return }

    const textoOriginal = btn.textContent
    btn.disabled = true
    btn.textContent = 'Consultando...'

    try {
      const datos = tipoDoc === 'RUC' ? await consultarRUC(numero) : await consultarDNI(numero)

      if (datos.error) {
        showToast(`No se pudo consultar: ${datos.error}`, 'danger')
        return
      }

      const nombreEl = document.getElementById(o.nombreId)
      if (nombreEl) nombreEl.value = tipoDoc === 'RUC' ? (datos.razonSocial || '') : (datos.nombreCompleto || '')

      if (o.direccionId) {
        const dirEl = document.getElementById(o.direccionId)
        // RENIEC (DNI) no devuelve dirección — solo aplica para RUC.
        if (dirEl && tipoDoc === 'RUC') dirEl.value = datos.direccion || dirEl.value
      }
      if (o.distritoId) {
        const distEl = document.getElementById(o.distritoId)
        if (distEl && tipoDoc === 'RUC' && datos.distrito) distEl.value = datos.distrito
      }
      if (o.paisId) {
        const paisEl = document.getElementById(o.paisId)
        if (paisEl && !paisEl.value) paisEl.value = 'Perú'
      }

      // Datos SUNAT (solo RUC — DNI/RENIEC no trae nada de esto).
      if (tipoDoc === 'RUC') {
        if (o.estadoId) {
          pintarBadgeSunat(document.getElementById(o.estadoId), datos.estado || '—', datos.estado === 'ACTIVO' ? 'success' : 'danger')
        }
        if (o.condicionId) {
          pintarBadgeSunat(document.getElementById(o.condicionId), datos.condicion || '—', datos.condicion === 'HABIDO' ? 'success' : 'danger')
        }
        if (o.buenContribuyenteId) {
          const el = document.getElementById(o.buenContribuyenteId)
          if (el) {
            const texto = datos.esBuenContribuyente === undefined ? '—' : (datos.esBuenContribuyente ? 'Sí' : 'No')
            pintarBadgeSunat(el, texto, datos.esBuenContribuyente === true ? 'success' : (datos.esBuenContribuyente === false ? 'secondary' : 'secondary'))
            // dataset.value guarda el booleano real (el texto "Sí"/"No" es solo
            // para mostrar) — así el formulario puede leerlo al guardar el contacto.
            el.dataset.value = datos.esBuenContribuyente === undefined ? '' : String(datos.esBuenContribuyente)
          }
        }
        if (o.agenteRetencionId) {
          const chk = document.getElementById(o.agenteRetencionId)
          if (chk && typeof datos.esAgenteRetencion === 'boolean') chk.checked = datos.esAgenteRetencion
        }
        if (o.agenteRetencionBadgeId) {
          const el = document.getElementById(o.agenteRetencionBadgeId)
          if (el) {
            const texto = datos.esAgenteRetencion === undefined ? '—' : (datos.esAgenteRetencion ? 'Sí' : 'No')
            pintarBadgeSunat(el, texto, datos.esAgenteRetencion === true ? 'success' : 'secondary')
            // dataset.value guarda el booleano exacto que devolvió SUNAT (el
            // texto "Sí"/"No" es solo para mostrar) — se persiste al guardar.
            el.dataset.value = datos.esAgenteRetencion === undefined ? '' : String(datos.esAgenteRetencion)
          }
        }
      }

      showToast('Datos encontrados y autocompletados.', 'success')
    } finally {
      btn.disabled = false
      btn.textContent = textoOriginal
    }
  })
}
