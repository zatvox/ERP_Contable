/* ============================================================
   main.js — Navigation, theme toggle, scroll effects
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {

  /* ─── Theme Toggle ─────────────────────────────────────── */
  const root = document.documentElement;
  const themeBtn = document.getElementById('theme-toggle');
  const stored = localStorage.getItem('jhiro-theme') || 'dark';
  root.setAttribute('data-theme', stored);
  updateThemeIcon(stored);

  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const current = root.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      localStorage.setItem('jhiro-theme', next);
      updateThemeIcon(next);
    });
  }

  function updateThemeIcon(theme) {
    if (!themeBtn) return;
    themeBtn.innerHTML = theme === 'dark'
      ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`
      : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3a7 7 0 109.79 9.79z"/></svg>`;
  }

  /* ─── Mobile Nav ───────────────────────────────────────── */
  const hamburger = document.getElementById('nav-hamburger');
  const navLinks = document.getElementById('nav-links');

  if (hamburger && navLinks) {
    hamburger.addEventListener('click', () => {
      hamburger.classList.toggle('open');
      navLinks.classList.toggle('open');
    });
  }

  /* ─── Active Nav Link ──────────────────────────────────── */
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav__link').forEach(link => {
    const href = link.getAttribute('href');
    if (href === currentPage || (currentPage === '' && href === 'index.html')) {
      link.classList.add('active');
    }
  });

  /* ─── Scroll Fade-in ───────────────────────────────────── */
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        observer.unobserve(e.target);
      }
    });
  }, { threshold: 0.08 });

  document.querySelectorAll('.fade-in').forEach(el => observer.observe(el));

  /* ─── FAQ Accordion ────────────────────────────────────── */
  document.querySelectorAll('.faq-item').forEach(item => {
    const btn = item.querySelector('.faq-q');
    if (btn) {
      btn.addEventListener('click', () => {
        const isOpen = item.classList.contains('open');
        document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
        if (!isOpen) item.classList.add('open');
      });
    }
  });

  /* ─── Contact Form ─────────────────────────────────────── */
  const form = document.getElementById('contact-form');
  const successMsg = document.getElementById('form-success');
  if (form) {
    form.addEventListener('submit', (e) => {
      // If using Formspree, remove e.preventDefault()
      // For mailto fallback, we let it happen naturally unless using Formspree
      const action = form.getAttribute('action');
      if (!action || action.startsWith('mailto')) {
        // handled by browser
      } else {
        e.preventDefault();
        fetch(action, {
          method: 'POST',
          body: new FormData(form),
          headers: { Accept: 'application/json' }
        }).then(r => {
          if (r.ok) {
            form.reset();
            if (successMsg) { successMsg.style.display = 'block'; }
          }
        }).catch(() => { /* fail silently — mailto fallback */ });
      }
    });
  }

});
