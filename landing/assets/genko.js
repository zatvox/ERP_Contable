/* ============================================================
   genko.js — landing de Genko
   Sin dependencias. Script clásico (no módulo) para que también
   funcione abriendo el archivo directo, sin Live Server.
============================================================ */

/* ⬇️ CAMBIAR AQUÍ: número de WhatsApp en formato internacional sin + ni espacios */
var WSP_NUMERO  = '51970741197';
var WSP_MENSAJE = 'Hola, me interesa Genko para mi empresa. Quisiera una demo.';

document.addEventListener('DOMContentLoaded', function () {
  // WhatsApp en todos los botones marcados con data-wsp
  var url = 'https://wa.me/' + WSP_NUMERO + '?text=' + encodeURIComponent(WSP_MENSAJE);
  var enlaces = document.querySelectorAll('[data-wsp]');
  for (var i = 0; i < enlaces.length; i++) {
    enlaces[i].setAttribute('href', url);
    enlaces[i].setAttribute('target', '_blank');
    enlaces[i].setAttribute('rel', 'noopener');
  }

  var anio = document.getElementById('anio');
  if (anio) anio.textContent = new Date().getFullYear();

  // ----------------------------------------------------------
  // Geco caminante: baja por el costado a medida que se scrollea
  // ----------------------------------------------------------
  var caminante = document.getElementById('caminante');
  var barra     = document.getElementById('barra');
  var quieto;

  function alScroll() {
    var alto  = document.documentElement.scrollHeight - window.innerHeight;
    var avance = alto > 0 ? Math.min(1, Math.max(0, window.scrollY / alto)) : 0;

    if (barra) barra.style.width = (avance * 100).toFixed(2) + '%';

    if (caminante) {
      // recorre la altura de la ventana dejando un margen arriba y abajo
      var alcance = window.innerHeight - caminante.offsetHeight - 120;
      var y = 70 + avance * alcance;
      // leve balanceo lateral, como un bicho que camina
      var x = Math.sin(avance * 14) * 6;
      caminante.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';

      caminante.classList.add('anda');
      clearTimeout(quieto);
      quieto = setTimeout(function () { caminante.classList.remove('anda'); }, 160);
    }
  }

  var pendiente = false;
  window.addEventListener('scroll', function () {
    if (pendiente) return;
    pendiente = true;
    requestAnimationFrame(function () { alScroll(); pendiente = false; });
  }, { passive: true });
  window.addEventListener('resize', alScroll, { passive: true });
  alScroll();

  // ----------------------------------------------------------
  // Reveal al hacer scroll
  // ----------------------------------------------------------
  var items = document.querySelectorAll('.rv');
  if (!('IntersectionObserver' in window)) {
    for (var j = 0; j < items.length; j++) items[j].classList.add('on');
    return;
  }
  var obs = new IntersectionObserver(function (entradas, o) {
    entradas.forEach(function (en) {
      if (en.isIntersecting) { en.target.classList.add('on'); o.unobserve(en.target); }
    });
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 });
  for (var k = 0; k < items.length; k++) obs.observe(items[k]);
});
