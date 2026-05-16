// ============================================================================
// MAIN.JS - Funciones globales de la aplicación
// ============================================================================
import { getProducts } from './supabase-data.js'
import { getCurrentUser } from './auth-supabase.js'

const THEME_KEY = 'erp_theme';

// ============================================================================
// TEMA CLARO/OSCURO
// ============================================================================

export function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const isDark = saved === 'dark';
  
  if (isDark) {
    document.body.classList.add('dark-mode');
  }
  updateThemeButton();
}

function toggleTheme() {
  const isDark = document.body.classList.toggle('dark-mode');
  localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light');
  updateThemeButton();
}

function updateThemeButton() {
  const btn = document.getElementById('themeToggle');
  if (btn) {
    const isDark = document.body.classList.contains('dark-mode');
    btn.textContent = isDark ? '☀️ Claro' : '🌙 Oscuro';
  }
}

// ============================================================================
// MENÚ RESPONSIVO
// ============================================================================

export function initMenu() {
  const toggle = document.getElementById('menuToggle');
  const sidebar = document.querySelector('.sidebar');
  
  if (toggle) {
    toggle.addEventListener('click', () => {
      sidebar.classList.toggle('hidden');
    });
  }

  // Cerrar menú al hacer click en enlace
  document.querySelectorAll('.sidebar a').forEach(link => {
    link.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        sidebar.classList.add('hidden');
      }
    });
  });

  // Cerrar menú al redimensionar
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
      sidebar.classList.remove('hidden');
    }
  });

  // Marcar menú activo
  const current = window.location.pathname.split('/').pop() || 'dashboard.html';
  document.querySelectorAll('.sidebar a').forEach(link => {
    link.classList.remove('active');
    if (link.href.includes(current)) {
      link.classList.add('active');
    }
  });
}

// ============================================================================
// MODAL
// ============================================================================

function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
  }
}

// Hacer disponible globalmente
window.openModal = openModal;

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.remove('show');
    document.body.style.overflow = 'auto';
  }
}

// Hacer disponible globalmente
window.closeModal = closeModal;

// Cerrar modal al hacer click fuera
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal')) {
    e.target.classList.remove('show');
    document.body.style.overflow = 'auto';
  }
});

// ============================================================================
// TOAST
// ============================================================================

function showToast(message, type = 'info', duration = 3000) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.remove();
  }, duration);
}

// ============================================================================
// FORMATO
// ============================================================================

function formatCurrency(value, currency = 'PEN') {
  const num = parseFloat(value) || 0;
  const symbol = currency === 'USD' ? '$' : 'S/.';
  return `${symbol} ${num.toFixed(2)}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleDateString('es-PE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

function formatNumber(value) {
  return parseFloat(value || 0).toFixed(2);
}

// ============================================================================
// VALIDACIONES
// ============================================================================

function validateRequired(value) {
  return value && value.toString().trim().length > 0;
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateRUC(ruc) {
  return ruc && ruc.length === 11 && /^\d+$/.test(ruc);
}

// ============================================================================
// TABS
// ============================================================================

function initTabs(containerSelector) {
  const buttons = document.querySelectorAll(`${containerSelector} .tab-btn`);
  const contents = document.querySelectorAll(`${containerSelector} .tab-content`);
  
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      
      buttons.forEach(b => b.classList.remove('active'));
      contents.forEach(c => c.classList.remove('active'));
      
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`)?.classList.add('active');
    });
  });
}

// ============================================================================
// INICIALIZACIÓN - Solo si se carga directamente como módulo
// ============================================================================

// Exportar funciones útiles
export function openModalGlobal(id) {
  openModal(id);
}

export function closeModalGlobal(id) {
  closeModal(id);
}

export function showToastGlobal(message, type = 'info', duration = 3000) {
  showToast(message, type, duration);
}

// Auto-inicializar solo si no se importa como módulo
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initMenu();
    
    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', toggleTheme);
    }
  });
} else {
  // DOM ya está listo
  initTheme();
  initMenu();
  
  const themeBtn = document.getElementById('themeToggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', toggleTheme);
  }
}
