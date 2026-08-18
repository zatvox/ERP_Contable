// ============================================================================
// BUSCADOR-SELECT.JS — Convierte un <select> en un combo con búsqueda en vivo
// ============================================================================
// Problema que resuelve: los selects de Cliente/Proveedor llegan a tener
// cientos de opciones. Un <select> nativo solo permite saltar por la primera
// letra, así que encontrar "COCA CARPENA" obliga a hacer scroll por toda la
// lista.
//
// Cómo funciona:
//   * El <select> original NO se elimina: se oculta y sigue siendo la fuente
//     de la verdad. Así todo el código existente (`document.getElementById
//     ('ventaContactId').value`, los `onchange`, los `.innerHTML = opciones`)
//     sigue funcionando sin tocar nada.
//   * Encima se dibuja un <input> de texto que filtra las opciones en vivo y,
//     al elegir una, escribe el value en el select y dispara su evento
//     `change` — de modo que la lógica de negocio ya escrita se ejecuta igual.
//   * `refrescarBuscador(select)` se llama cuando el módulo repuebla el select
//     con opciones nuevas (ej. después de crear un cliente).
//
// Teclado: ↑ ↓ para moverse, Enter para elegir, Esc para cerrar.
// ============================================================================

const _instancias = new WeakMap()

/**
 * @param {string|HTMLSelectElement} selector  id o elemento del <select>
 * @param {object} opciones
 *   placeholder      texto del input vacío
 *   sinResultados    texto cuando el filtro no encuentra nada
 *   alCrearNuevo     { label, onClick } botón extra al final de la lista
 */
export function convertirEnBuscador(selector, opciones = {}) {
  const select = typeof selector === 'string' ? document.getElementById(selector) : selector
  if (!select || _instancias.has(select)) return _instancias.get(select)

  const placeholder = opciones.placeholder || 'Escribe para buscar...'
  const sinResultados = opciones.sinResultados || 'Sin coincidencias'

  // ── Estructura
  const caja = document.createElement('div')
  caja.className = 'bsq-caja'

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'bsq-input'
  input.placeholder = placeholder
  input.autocomplete = 'off'
  input.setAttribute('role', 'combobox')

  const limpiar = document.createElement('button')
  limpiar.type = 'button'
  limpiar.className = 'bsq-limpiar'
  limpiar.textContent = '✕'
  limpiar.title = 'Limpiar selección'
  limpiar.style.display = 'none'

  const lista = document.createElement('div')
  lista.className = 'bsq-lista'

  select.parentNode.insertBefore(caja, select)
  caja.appendChild(input)
  caja.appendChild(limpiar)
  caja.appendChild(lista)
  caja.appendChild(select)
  select.classList.add('bsq-select-oculto')

  let indiceActivo = -1
  let visibles = []

  // ── Sincronización select → input
  function sincronizarDesdeSelect() {
    const opt = select.selectedOptions[0]
    const texto = (opt && opt.value) ? opt.textContent.trim() : ''
    input.value = texto
    input.dataset.textoElegido = texto
    limpiar.style.display = texto ? '' : 'none'
  }

  // ── Construir la lista filtrada
  function pintarLista(filtro = '') {
    const q = filtro.trim().toLowerCase()
    // Se ignoran las opciones "placeholder" (value vacío): ya está el
    // placeholder del input haciendo ese trabajo.
    const todas = Array.from(select.options).filter(o => o.value !== '')
    visibles = q
      ? todas.filter(o => o.textContent.toLowerCase().includes(q))
      : todas

    lista.innerHTML = ''
    if (visibles.length === 0) {
      const vacio = document.createElement('div')
      vacio.className = 'bsq-vacio'
      vacio.textContent = sinResultados
      lista.appendChild(vacio)
    } else {
      visibles.forEach((o, i) => {
        const item = document.createElement('div')
        item.className = 'bsq-item' + (o.value === select.value ? ' elegido' : '')
        item.dataset.valor = o.value
        item.innerHTML = _resaltar(o.textContent.trim(), q)
        item.addEventListener('mousedown', (e) => { e.preventDefault(); elegir(o.value) })
        item.addEventListener('mouseenter', () => { indiceActivo = i; marcarActivo() })
        lista.appendChild(item)
      })
    }

    if (opciones.alCrearNuevo) {
      const btn = document.createElement('div')
      btn.className = 'bsq-item bsq-nuevo'
      btn.innerHTML = `<span class="bsq-nuevo-icono">＋</span> ${opciones.alCrearNuevo.label}`
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault()
        cerrar()
        opciones.alCrearNuevo.onClick(input.value.trim())
      })
      lista.appendChild(btn)
    }

    indiceActivo = visibles.length ? 0 : -1
    marcarActivo()
  }

  function marcarActivo() {
    lista.querySelectorAll('.bsq-item').forEach((el, i) => el.classList.toggle('activo', i === indiceActivo))
    lista.querySelector('.bsq-item.activo')?.scrollIntoView({ block: 'nearest' })
  }

  function abrir() {
    pintarLista(input.value === input.dataset.textoElegido ? '' : input.value)
    caja.classList.add('abierta')
    _posicionarLista()
  }

  function cerrar() {
    caja.classList.remove('abierta')
    // Si el usuario escribió sin elegir nada, se restaura el texto de la
    // opción realmente seleccionada: el input nunca puede quedar mostrando
    // algo que no corresponde al value del select.
    sincronizarDesdeSelect()
  }

  function elegir(valor) {
    select.value = valor
    sincronizarDesdeSelect()
    caja.classList.remove('abierta')
    // Dispara el onchange original del select (la lógica de negocio del módulo).
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }

  // La lista se posiciona con `fixed` porque estos selects viven dentro de
  // modales con overflow — igual que el menú ⋮ de las tablas.
  function _posicionarLista() {
    const r = input.getBoundingClientRect()
    const espacioAbajo = window.innerHeight - r.bottom
    const alto = Math.min(lista.scrollHeight + 2, 260)
    lista.style.width = `${r.width}px`
    lista.style.left = `${r.left}px`
    lista.style.top = (espacioAbajo < alto + 10 && r.top > alto + 10)
      ? `${r.top - alto - 3}px`
      : `${r.bottom + 3}px`
  }

  // ── Eventos
  input.addEventListener('focus', abrir)
  input.addEventListener('input', () => { pintarLista(input.value); caja.classList.add('abierta'); _posicionarLista() })
  input.addEventListener('keydown', (e) => {
    if (!caja.classList.contains('abierta') && ['ArrowDown', 'ArrowUp'].includes(e.key)) { abrir(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); indiceActivo = Math.min(indiceActivo + 1, visibles.length - 1); marcarActivo() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); indiceActivo = Math.max(indiceActivo - 1, 0); marcarActivo() }
    else if (e.key === 'Enter') {
      if (caja.classList.contains('abierta') && visibles[indiceActivo]) { e.preventDefault(); elegir(visibles[indiceActivo].value) }
    }
    else if (e.key === 'Escape') { cerrar(); input.blur() }
  })
  input.addEventListener('blur', () => setTimeout(cerrar, 120))

  limpiar.addEventListener('click', () => {
    select.value = ''
    sincronizarDesdeSelect()
    select.dispatchEvent(new Event('change', { bubbles: true }))
    input.focus()
  })

  window.addEventListener('scroll', () => { if (caja.classList.contains('abierta')) _posicionarLista() }, true)
  window.addEventListener('resize', () => { if (caja.classList.contains('abierta')) _posicionarLista() })

  // Si otro código cambia el select por su cuenta (ej. preseleccionar un
  // cliente al editar), el input debe reflejarlo.
  select.addEventListener('change', sincronizarDesdeSelect)

  sincronizarDesdeSelect()

  const api = { refrescar: sincronizarDesdeSelect, input, select }
  _instancias.set(select, api)
  return api
}

/** Llamar tras repoblar el <select> con opciones nuevas. */
export function refrescarBuscador(selector) {
  const select = typeof selector === 'string' ? document.getElementById(selector) : selector
  _instancias.get(select)?.refrescar()
}

/**
 * Convierte varios selects de una vez. Ignora los que no existan en la página,
 * para poder usar una sola lista compartida entre módulos.
 */
export function convertirVarios(defs = []) {
  defs.forEach(d => {
    const el = document.getElementById(d.id)
    if (el) convertirEnBuscador(el, d)
  })
}

function _resaltar(texto, q) {
  const seguro = _esc(texto)
  if (!q) return seguro
  const i = texto.toLowerCase().indexOf(q)
  if (i < 0) return seguro
  return _esc(texto.slice(0, i)) + '<mark>' + _esc(texto.slice(i, i + q.length)) + '</mark>' + _esc(texto.slice(i + q.length))
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
