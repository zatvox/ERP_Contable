// Botón único «Informes» del dashboard: un panel sobrio con los entregables de avance.
// Para sumar uno nuevo: agregar una fila a INFORMES (pdf:null = «En preparación»).
const INFORMES = [
  { titulo: '2.º Entregable de Avance', detalle: 'Genko by ZatVox · Nov 2026 · 15 págs', pdf: 'informe/Informe_2do_Avance_Genko.pdf' },
  { titulo: '1.er Entregable de Avance', detalle: 'Sep 2026 · 16 págs', pdf: 'informe/Informe_1er_Avance_Genko.pdf' }
];

const _ICO_DOC = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>';
const _ICO_DESC = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>';
const _esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function montarMenuInformes(host) {
  if (!host) return;
  host.classList.add('inf-menu');
  host.innerHTML = `
    <button type="button" class="inf-btn" aria-haspopup="true" aria-expanded="false">
      ${_ICO_DOC}<span>Informes</span><i class="inf-chev" aria-hidden="true"></i>
    </button>
    <div class="inf-panel" role="menu">
      ${INFORMES.map(i => i.pdf
        ? `<a class="inf-fila" role="menuitem" href="${_esc(i.pdf)}" download><span class="inf-txt"><b>${_esc(i.titulo)}</b><small>${_esc(i.detalle)}</small></span><span class="inf-acc">${_ICO_DESC}</span></a>`
        : `<div class="inf-fila inf-off" role="menuitem" aria-disabled="true"><span class="inf-txt"><b>${_esc(i.titulo)}</b><small>${_esc(i.detalle)}</small></span><span class="inf-tag">En preparación</span></div>`).join('')}
    </div>`;
  const btn = host.querySelector('.inf-btn');
  const cerrar = () => { host.classList.remove('abierto'); btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const abre = !host.classList.contains('abierto');
    host.classList.toggle('abierto', abre);
    btn.setAttribute('aria-expanded', String(abre));
  });
  document.addEventListener('click', e => { if (!host.contains(e.target)) cerrar(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') cerrar(); });
}

document.addEventListener('DOMContentLoaded', () => montarMenuInformes(document.getElementById('informes-menu')));
