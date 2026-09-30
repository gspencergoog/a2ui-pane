/**
 * Displays temporary toast notifications in the pane viewport.
 * Used to report action transmission failures or system alerts.
 */
export function showToast(
  message: string,
  isError = true,
  durationMs = 4000,
): HTMLElement | null {
  if (typeof document === 'undefined') return null;

  let toastContainer = document.getElementById('a2ui-toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'a2ui-toast-container';
    toastContainer.style.cssText = `
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 9999;
      pointer-events: none;
    `;
    document.body.appendChild(toastContainer);
  }

  const toast = document.createElement('div');
  toast.className = 'a2ui-toast';
  toast.style.cssText = `
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 13px;
    pointer-events: auto;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    transition: opacity 0.2s ease, transform 0.2s ease;
    background-color: ${isError ? '#ffeef0' : '#dcffe4'};
    color: ${isError ? '#b31d28' : '#155724'};
    border: 1px solid ${isError ? '#f97583' : '#34d058'};
  `;
  toast.textContent = message;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => {
      if (toast.parentElement) {
        toast.parentElement.removeChild(toast);
      }
    }, 200);
  }, durationMs);

  return toast;
}
