
declare const chrome: any;
import { MessageType, ContextPayload } from './types';

let debounceTimer: any = null;
const DEBOUNCE_DELAY = 1000;

// Función segura para enviar mensajes
function reportActivity(description: string) {
  if (!chrome.runtime?.id) return; // Extensión invalidada/actualizada

  if (debounceTimer) clearTimeout(debounceTimer);

  debounceTimer = setTimeout(() => {
    try {
      const payload: ContextPayload = {
        url: window.location.href,
        title: document.title || 'Página sin título',
        description: description,
        timestamp: Date.now()
      };

      chrome.runtime.sendMessage({
        type: MessageType.BROWSER_ACTIVITY,
        payload
      }).catch((err: any) => {
        // Ignorar errores de conexión si el popup está cerrado, es normal en V3
        // console.debug("Mensaje no entregado (normal si background duerme):", err);
      });

    } catch (e) {
      console.error("Error reportando actividad:", e);
    }
  }, DEBOUNCE_DELAY);
}

// 1. Detección de Navegación Inicial
reportActivity("El usuario acaba de entrar a esta página.");

// 2. Detección de Scroll (Doomscrolling)
let lastScrollY = window.scrollY;
window.addEventListener('scroll', () => {
  const current = window.scrollY;
  if (Math.abs(current - lastScrollY) > 800) {
    lastScrollY = current;
    reportActivity("El usuario está scrolleando bastante rápido.");
  }
});

// 3. Detección de Visibilidad (Cambio de pestaña)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    reportActivity("El usuario volvió a mirar esta pestaña.");
  }
});

// 4. Detección de Foco
window.addEventListener('focus', () => {
  reportActivity("La ventana recuperó el foco.");
});
