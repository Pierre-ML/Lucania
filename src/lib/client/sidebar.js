const DESKTOP = '(min-width: 768px)';

function els() {
  return {
    sidebar: document.getElementById('sidebar'),
    backdrop: document.getElementById('sidebar-backdrop'),
    toggle: document.getElementById('sidebar-toggle'),
  };
}

function isDesktop() {
  return window.matchMedia(DESKTOP).matches;
}

function syncAria() {
  const { sidebar, toggle } = els();
  if (!sidebar || !toggle) return;
  const expanded = isDesktop()
    ? sidebar.dataset.collapsed !== 'true'
    : sidebar.dataset.open === 'true';
  toggle.setAttribute('aria-expanded', String(expanded));
}

export function closeSidebarMobile() {
  if (isDesktop()) return;
  const { sidebar, backdrop } = els();
  if (sidebar) sidebar.dataset.open = 'false';
  if (backdrop) backdrop.dataset.open = 'false';
  syncAria();
}

export function initSidebar() {
  const { sidebar, backdrop, toggle } = els();
  if (!sidebar || !toggle) return;
  const mq = window.matchMedia(DESKTOP);

  toggle.addEventListener('click', () => {
    if (mq.matches) {
      const collapsed = sidebar.dataset.collapsed !== 'true';
      sidebar.dataset.collapsed = String(collapsed);
      try { localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0'); } catch {}
    } else {
      const open = sidebar.dataset.open !== 'true';
      sidebar.dataset.open = String(open);
      if (backdrop) backdrop.dataset.open = String(open);
    }
    syncAria();
  });

  if (backdrop) backdrop.addEventListener('click', closeSidebarMobile);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSidebarMobile();
  });

  const onChange = () => {
    sidebar.dataset.open = 'false';
    if (backdrop) backdrop.dataset.open = 'false';
    syncAria();
  };
  mq.addEventListener('change', onChange);

  syncAria();
}
