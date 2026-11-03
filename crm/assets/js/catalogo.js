import { $, $$, esc, money, norm, arrancar, getCatalogo, imagenes, semLabel } from './crm-core.js'

const { emp } = await arrancar('cat')
const app = $('#app')
if (!emp) {
  app.innerHTML = '<div class="vacio"><h2>Catálogo no disponible</h2><p>Aún no hay productos publicados.</p></div>'
} else {
  let data = [], grupo = '', disp = '', q = ''
  app.innerHTML = `
    <section class="hero"><h1>${esc(emp.titulo || 'Catálogo de hilos')}</h1>
      <p>${esc(emp.mensaje || 'Disponibilidad y precios en tiempo real.')}</p>
      <span class="live" id="live">En vivo</span></section>
    <div class="layout">
      <aside class="side"><h4>Categorías</h4><ul id="grupos"></ul>
        <h4>Disponibilidad</h4><ul id="disp"></ul></aside>
      <section><div class="bar"><div class="buscar"><input id="q" type="search" placeholder="Buscar color, código o tipo…"></div>
        <span class="muted" id="cnt"></span></div><div class="grid" id="grid"></div></section>
    </div>`

  const pintar = () => {
    const base = data.filter(p => !q || norm(`${p.nombre} ${p.grupo} ${p.color_nombre} ${p.color_no}`).includes(q))
    const grupos = [...new Set(data.map(p => p.grupo))]
    $('#grupos').innerHTML = `<li><button class="${grupo ? '' : 'on'}" data-g="">Todo <span>${data.length}</span></button></li>` +
      grupos.map(g => `<li><button class="${grupo === g ? 'on' : ''}" data-g="${esc(g)}">${esc(g)} <span>${data.filter(p => p.grupo === g).length}</span></button></li>`).join('')
    $('#disp').innerHTML = [['', 'Todos'], ['disponible', 'Disponible'], ['poco', 'Poco stock'], ['agotado', 'Agotado']]
      .map(([v, l]) => `<li><button class="${disp === v ? 'on' : ''}" data-d="${v}">${l}</button></li>`).join('')
    const lista = base.filter(p => (!grupo || p.grupo === grupo) && (!disp || p.semaforo === disp))
    $('#cnt').textContent = `${lista.length} producto${lista.length === 1 ? '' : 's'}`
    $('#grid').innerHTML = lista.length ? lista.map(p => {
      const f = imagenes(p.fotos)[0]
      return `<a class="card" href="producto.html?emp=${emp.id}&id=${p.id}">
        <div class="card__img">${f ? `<img loading="lazy" src="${esc(f)}" alt="${esc(p.nombre)}">` : '<div class="sinfoto">Sin foto</div>'}
          <span class="sem sem--${p.semaforo}">${semLabel(p.semaforo)}</span></div>
        <div class="card__body"><div class="card__cat">${esc(p.grupo)}</div><h3 class="card__name">${esc(p.nombre)}</h3>
          ${p.color_nombre ? `<span class="col"><i style="background:${esc(p.color_hex || '#ccc')}"></i>${esc(p.color_nombre)}${p.color_no ? ' · ' + esc(p.color_no) : ''}</span>` : ''}
          <div class="card__foot">${p.precio ? `<span class="precio">${money(p.precio, p.moneda)} <small>/kg${p.igv_incluido ? ' inc. IGV' : ' + IGV'}</small></span>` : '<span class="muted">Consultar precio</span>'}</div></div></a>`
    }).join('') : '<div class="vacio">Sin resultados.</div>'
  }
  const cargar = async (forzar) => {
    data = await getCatalogo(emp.id, forzar); pintar()
    $('#live').textContent = 'En vivo · ' + new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
  }
  app.addEventListener('click', e => {
    const g = e.target.closest('[data-g]'), d = e.target.closest('[data-d]')
    if (g) { grupo = g.dataset.g; pintar() } if (d) { disp = d.dataset.d; pintar() }
  })
  $('#q').oninput = e => { q = norm(e.target.value.trim()); pintar() }
  await cargar(true)
  setInterval(() => document.hidden || cargar(true), 45000)
  document.addEventListener('visibilitychange', () => document.hidden || cargar(true))
}
