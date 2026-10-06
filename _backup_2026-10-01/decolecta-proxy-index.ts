// ============================================================================
// DECOLECTA-PROXY — Edge Function (Supabase) que hace de puente entre el
// navegador y la API de Decolecta (https://decolecta.com).
// ============================================================================
// Por qué existe:
//   Decolecta (y APIs.pe, su respaldo) no soportan llamadas directas desde el
//   navegador: no devuelven cabecera Access-Control-Allow-Origin (CORS), así
//   que el fetch() del navegador se bloquea siempre, sin importar el dominio
//   (localhost, GitHub Pages, el que sea). Además, aunque CORS no fuera un
//   problema, exponer el token de Decolecta en config.js (código que se le
//   sirve tal cual al navegador) permitiría a cualquiera copiarlo desde
//   "Ver código fuente" y gastarse la cuota mensual del plan.
//
//   Esta función corre en el servidor de Supabase (Deno), donde SÍ puede
//   pegarle a Decolecta sin restricción de CORS, guarda el token como
//   SECRETO de Supabase (nunca viaja al navegador), y le responde al
//   frontend con las cabeceras CORS que el propio ERP necesita.
//
// Uso desde el frontend (sunat-api.js):
//   const { data, error } = await supabase.functions.invoke('decolecta-proxy', {
//     body: { tipo: 'ruc' | 'dni', numero: '20601030013' }
//   })
//
// Seguridad:
//   Se despliega con --no-verify-jwt (ver instrucciones abajo). Con
//   verify_jwt activado (el default), el propio gateway de Supabase devuelve
//   401 antes de que este código llegue a ejecutarse — pasó justo eso en la
//   primera prueba en vivo. La protección real de la cuota mensual queda en
//   que la URL de la función no se publica en ningún lado visible y en el
//   contador/log que ya lleva el ERP (decolecta_consultas_log). Si más
//   adelante se quiere blindar mejor, se puede agregar un secreto compartido
//   propio (ej. un header custom validado a mano dentro de esta función)
//   sin depender del verify_jwt de la plataforma.
//
// Deploy (ver instrucciones completas al final de este archivo):
//   supabase secrets set DECOLECTA_TOKEN=tu_token_real
//   supabase functions deploy decolecta-proxy --no-verify-jwt
// ============================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

Deno.serve(async (req: Request) => {
  // Preflight CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    const { tipo, numero } = await req.json()

    if (!tipo || !['ruc', 'dni'].includes(tipo)) {
      return new Response(JSON.stringify({ error: 'tipo debe ser "ruc" o "dni"' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      })
    }
    const num = String(numero || '').trim()
    if (tipo === 'ruc' && num.length !== 11) {
      return new Response(JSON.stringify({ error: 'El RUC debe tener 11 dígitos' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      })
    }
    if (tipo === 'dni' && num.length !== 8) {
      return new Response(JSON.stringify({ error: 'El DNI debe tener 8 dígitos' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      })
    }

    const token = Deno.env.get('DECOLECTA_TOKEN')
    if (!token) {
      return new Response(JSON.stringify({ error: 'DECOLECTA_TOKEN no configurado en los secretos de Supabase' }), {
        status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      })
    }
    // DIAGNÓSTICO TEMPORAL — no imprime el token completo, solo su longitud y
    // extremos, para detectar si quedó corrupto al guardarlo como secreto
    // (espacios, comillas, salto de línea de más, etc.). Ver con:
    //   supabase functions logs decolecta-proxy
    // Quitar este bloque una vez confirmado que el token llega bien.
    console.log(`[diagnóstico] DECOLECTA_TOKEN longitud=${token.length} inicio="${token.slice(0, 6)}" fin="${token.slice(-4)}"`)

    const url = tipo === 'ruc'
      ? `https://api.decolecta.com/v1/sunat/ruc?numero=${num}`
      : `https://api.decolecta.com/v1/reniec/dni?numero=${num}`

    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token.trim()}`, 'Content-Type': 'application/json' }
    })
    const data = await res.json().catch(() => ({}))
    console.log(`[diagnóstico] Decolecta respondió status=${res.status}`)

    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: `Error interno del proxy: ${err instanceof Error ? err.message : String(err)}` }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    })
  }
})

// ============================================================================
// INSTRUCCIONES DE DEPLOY (una sola vez, desde tu terminal local)
// ============================================================================
// 1. Instalar Supabase CLI (si no la tienes):
//      npm install -g supabase
//
// 2. Iniciar sesión:
//      supabase login
//
// 3. Vincular este proyecto a tu proyecto Supabase (ygqmbgwtciuzgrpycxjx):
//      supabase link --project-ref ygqmbgwtciuzgrpycxjx
//    (ejecutar este comando desde la carpeta erp_v2, donde está supabase/)
//
// 4. Guardar el token de Decolecta como secreto (NO va en config.js, NI en
//    este archivo — este comando se ejecuta en tu terminal, el valor real
//    nunca queda escrito en un archivo del repositorio):
//      supabase secrets set DECOLECTA_TOKEN=TU_TOKEN_REAL_DE_DECOLECTA
//
// 5. Desplegar la función (--no-verify-jwt: ver nota de "Seguridad" arriba,
//    si no se pasa este flag el gateway responde 401 antes de llegar aquí):
//      supabase functions deploy decolecta-proxy --no-verify-jwt
//
// 6. Probar (reemplaza TU_ANON_KEY y TU_JWT_DE_SESION, o simplemente prueba
//    desde la app ya logueado — sunat-api.js ya está armado para usar esto):
//      curl -X POST 'https://ygqmbgwtciuzgrpycxjx.supabase.co/functions/v1/decolecta-proxy' \
//        -H "Authorization: Bearer TU_JWT_DE_SESION" \
//        -H "Content-Type: application/json" \
//        -d '{"tipo":"ruc","numero":"20601030013"}'
// ============================================================================
