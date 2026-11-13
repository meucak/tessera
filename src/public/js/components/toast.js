/**
 * Accessible toast notifications and confirmation modal helper.
 */

export function showToast(message, durationMs = 2600) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast-item';
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, durationMs);
}

export function openModal(html, { wide = false, onMount = null } = {}) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-card${wide ? ' is-wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  root.hidden = false;

  const close = () => {
    root.hidden = true;
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKey);

  root.onclick = (e) => {
    if (e.target === root) close();
  };
  root.querySelectorAll('[data-modal-close]').forEach((btn) => {
    btn.addEventListener('click', close);
  });

  if (onMount) onMount(root.firstElementChild, close);
  return close;
}
