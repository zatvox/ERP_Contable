// ============================================================================
// COMANDOS.JS — Banco de comandos ejecutables desde el navegador
// ============================================================================
// JHIRO ERP no tiene backend propio ni terminal (es JS + Supabase, corriendo
// en GitHub Pages / Live Server). Por eso un "comando" aquí no es un script
// de sistema operativo: es una función JS que corre en el navegador del
// usuario, usa fetch() para leer los propios archivos del sistema (mismo
// origen, sin necesidad de servidor adicional) y devuelve un reporte que se
// pinta como si fuera la salida de una terminal.
//
// El primer comando (auditarHandlersRotos) existe para prevenir, de forma
// automática, el tipo exacto de error que rompió el buscador de "Resumen de
// Stock" el 10/09/2026: una función definida como window.foo = ... fue
// borrada durante un refactor, pero el HTML seguía llamándola desde
// onclick="window.foo()". Como los atributos onclick/oninput/onchange son
// strings sin ningún chequeo en tiempo de edición, ese error solo se nota
// cuando alguien hace click y la consola tira un TypeError. Este comando
// escanea todas las páginas del sistema y detecta esa desconexión ANTES de
// que un usuario la sufra.
// ============================================================================

const PAGINAS = [
  'dashboard.html',
  'inventario.html',
  'compras.html',
  'ventas.html',
  'cobranzas.html',
  'bancos.html',
  'contabilidad.html',
  'usuarios.html',
  'perfil.html',
  'costeo-importaciones.html'
]

// Atributos de evento inline que pueden llamar a window.algo(...)
const HANDLERS_ATTR_RE = /\son(?:click|input|change|submit|keyup|keydown|dblclick|blur|focus)\s*=\s*"([^"]*)"/g
const CALL_RE = /window\.([A-Za-z_$][\w$]*)\s*\(/g
const DEF_RE = /window\.([A-Za-z_$][\w$]*)\s*=(?!=)/g
const SCRIPT_SRC_RE = /<script[^>]*\ssrc=["']([^"']+)["'][^>]*>/g
// Un archivo .js puede definir window.X = ... directamente, o hacerlo un
// módulo que a su vez importa otro módulo. El navegador carga esa cadena
// completa aunque el <script> del HTML solo mencione el primero, así que el
// auditor tiene que seguir esa cadena de módulos tal como lo hace el propio
// navegador, o va a marcar como "no definida" cualquier función que en
// realidad vive en un archivo importado (falso positivo).
const IMPORT_RE = /(?:import|export)[^;'"]*["']([^"']+\.js)["']/g

// Funciones/propiedades nativas del navegador que a veces se llaman como
// window.X(...) pero no son "nuestras" (no tiene sentido pedir que estén
// definidas en el código del proyecto).
const IGNORAR = new Set(['print', 'alert', 'confirm', 'prompt', 'open', 'close', 'scrollTo', 'reload', 'focus', 'blur'])

async function _leerTexto(url) {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

// A partir de una lista de módulos .js cargados directamente por una página
// (via <script src>), sigue la cadena de imports de cada uno de forma
// recursiva -tal cual lo hace el navegador- y devuelve el conjunto completo
// de URLs absolutas de módulos que terminan ejecutándose para esa página.
// cacheModulos se comparte entre páginas para no releer el mismo archivo dos
// veces durante todo el escaneo.
async function _resolverModulosTransitivos(urlsIniciales, cacheModulos, lineas) {
  const visitados = new Set()
  const pendientes = [...urlsIniciales]

  while (pendientes.length) {
    const url = pendientes.pop()
    if (visitados.has(url)) continue
    visitados.add(url)

    if (!cacheModulos.has(url)) {
      try {
        const texto = await _leerTexto(url)
        const defs = new Set()
        let dm
        DEF_RE.lastIndex = 0
        while ((dm = DEF_RE.exec(texto))) defs.add(dm[1])

        const imports = []
        let im
        IMPORT_RE.lastIndex = 0
        while ((im = IMPORT_RE.exec(texto))) imports.push(new URL(im[1], url).href)

        cacheModulos.set(url, { defs, imports })
      } catch (e) {
        cacheModulos.set(url, { defs: new Set(), imports: [] })
        lineas.push({ tipo: 'error', texto: `✗ ${url.split('/').pop()}: no se pudo leer (${e.message})` })
        continue
      }
    }

    for (const dep of cacheModulos.get(url).imports) {
      if (!visitados.has(dep)) pendientes.push(dep)
    }
  }

  return visitados
}

/**
 * Escanea todas las páginas del sistema y, para cada una, compara las
 * funciones window.X() que sus botones/campos llaman contra las funciones
 * window.X = ... que de verdad están definidas en los .js que esa misma
 * página carga. Devuelve un arreglo de líneas { tipo, texto } listo para
 * pintarse como salida de terminal.
 */
export async function auditarHandlersRotos() {
  const lineas = []
  // Un solo mapa global (URL absoluta -> {defs, imports}) para todo el
  // escaneo: muchos módulos se comparten entre páginas (main.js, helpers.js,
  // etc.), así que cachear por URL evita leerlos una vez por cada página.
  const cacheModulos = new Map()
  let totalRevisados = 0
  let totalRotos = 0
  let paginasConError = 0

  lineas.push({ tipo: 'info', texto: `Escaneando ${PAGINAS.length} páginas del sistema...` })

  for (const pagina of PAGINAS) {
    const urlPagina = new URL(pagina, location.href).href
    let html
    try {
      html = await _leerTexto(urlPagina)
    } catch (e) {
      paginasConError++
      lineas.push({ tipo: 'error', texto: `✗ ${pagina}: no se pudo leer (${e.message})` })
      continue
    }

    // 1) ¿Qué archivos .js carga esta página directamente (<script src>)?
    const scriptsDirectos = []
    let m
    SCRIPT_SRC_RE.lastIndex = 0
    while ((m = SCRIPT_SRC_RE.exec(html))) {
      if (m[1].endsWith('.js')) scriptsDirectos.push(new URL(m[1], urlPagina).href)
    }

    // 2) Seguir la cadena de módulos importados por cada uno,
    //    igual que hace el navegador al cargar módulos ES, para no perder
    //    funciones definidas en archivos importados (ej. col-menu.js
    //    importado desde inventario.js en vez de estar en un <script> propio).
    const modulosDeEstaPagina = await _resolverModulosTransitivos(scriptsDirectos, cacheModulos, lineas)

    // 3) Unión de todas las funciones window.X = ... definidas en esos módulos
    const definidos = new Set()
    for (const url of modulosDeEstaPagina) {
      cacheModulos.get(url)?.defs.forEach(n => definidos.add(n))
    }

    // 4) Funciones window.X() que este HTML llama desde onclick/oninput/etc.
    const llamadas = new Set()
    HANDLERS_ATTR_RE.lastIndex = 0
    let hm
    while ((hm = HANDLERS_ATTR_RE.exec(html))) {
      const contenido = hm[1]
      let cm
      CALL_RE.lastIndex = 0
      while ((cm = CALL_RE.exec(contenido))) llamadas.add(cm[1])
    }

    // 5) Comparar
    const rotosEnEstaPagina = []
    for (const nombre of llamadas) {
      if (IGNORAR.has(nombre)) continue
      totalRevisados++
      if (!definidos.has(nombre)) {
        totalRotos++
        rotosEnEstaPagina.push(nombre)
      }
    }

    if (rotosEnEstaPagina.length === 0) {
      lineas.push({ tipo: 'ok', texto: `✓ ${pagina}: ${llamadas.size} función(es) revisada(s), todo en orden.` })
    } else {
      for (const nombre of rotosEnEstaPagina) {
        lineas.push({ tipo: 'error', texto: `✗ ${pagina}: window.${nombre}() se usa en un botón/campo pero NO está definida en ningún JS que carga esta página.` })
      }
    }
  }

  lineas.push({ tipo: 'info', texto: '—' })
  if (paginasConError > 0) {
    lineas.push({ tipo: 'error', texto: `⚠ ${paginasConError} página(s) no se pudieron leer (revisa que el nombre del archivo siga existiendo).` })
  }
  lineas.push({
    tipo: totalRotos === 0 ? 'ok' : 'error',
    texto: totalRotos === 0
      ? `✓ Listo: ${totalRevisados} función(es) revisada(s) en total, 0 rotas.`
      : `✗ Listo: ${totalRevisados} función(es) revisada(s) en total, ${totalRotos} rota(s). Corrige las líneas marcadas arriba.`
  })
  return lineas
}

export const COMANDOS = [
  {
    id: 'auditar-handlers',
    nombre: '🔍 Auditar botones y campos del sistema',
    descripcion: 'Revisa todas las páginas del sistema y verifica que cada función usada en un botón o campo (onclick, oninput, onchange, onsubmit) exista de verdad en el código. Detecta automáticamente el tipo de error que rompió el buscador de Resumen de Stock el 10/09.',
    ejecutar: auditarHandlersRotos
  }
]

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/**
 * Pinta la lista de comandos disponibles dentro del contenedor indicado.
 * No usa onclick inline a propósito (addEventListener), para no repetir la
 * misma clase de bug que esta herramienta existe para detectar.
 */
export function renderComandos(containerId) {
  const cont = typeof containerId === 'string' ? document.getElementById(containerId) : containerId
  if (!cont) return

  cont.innerHTML = `
    <div class="card">
      <div class="card-header"><h3 class="card-title">Banco de comandos</h3></div>
      <div style="padding:6px 20px 20px;">
        <p style="font-size:0.85rem; color:var(--text-secondary); margin:10px 0 16px;">
          Herramientas que corren en tu navegador para revisar el sistema. No requieren servidor ni instalar nada.
        </p>
        <div id="comandos-lista"></div>
      </div>
    </div>`

  const lista = cont.querySelector('#comandos-lista')
  lista.innerHTML = COMANDOS.map(c => `
    <div class="cfg-fila" style="align-items:flex-start; flex-direction:column; gap:10px;">
      <div class="cfg-fila-texto" style="width:100%;">
        <label>${c.nombre}</label>
        <div class="cfg-hint">${c.descripcion}</div>
      </div>
      <button type="button" class="btn btn-primary btn-small" data-cmd-run="${c.id}">▶ Ejecutar</button>
      <div class="terminal-box" data-cmd-output="${c.id}" hidden></div>
    </div>
  `).join('')

  lista.querySelectorAll('[data-cmd-run]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-cmd-run')
      const comando = COMANDOS.find(c => c.id === id)
      const salida = lista.querySelector(`[data-cmd-output="${id}"]`)
      if (!comando || !salida) return

      btn.disabled = true
      const textoOriginal = btn.textContent
      btn.textContent = '⏳ Ejecutando...'
      salida.hidden = false
      salida.innerHTML = `<div class="terminal-line-info">$ ${comando.id}</div><div class="terminal-line-info">Ejecutando...</div>`

      try {
        const lineas = await comando.ejecutar()
        salida.innerHTML = lineas.map(l => `<div class="terminal-line-${l.tipo}">${_esc(l.texto)}</div>`).join('')
      } catch (e) {
        salida.innerHTML += `<div class="terminal-line-error">✗ Error inesperado: ${_esc(e.message)}</div>`
      } finally {
        btn.disabled = false
        btn.textContent = textoOriginal
      }
    })
  })
}
