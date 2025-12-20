
declare const chrome: any;
import { MessageType, ContextPayload } from './types';

let debounceTimer: any = null;
const DEBOUNCE_DELAY = 500;

// Función segura para enviar mensajes
function reportActivity(description: string, immediate: boolean = false, actionType: "navigate" | "interaction" | "input" | "media" = "interaction") {
  if (!chrome.runtime?.id) return;

  if (debounceTimer) clearTimeout(debounceTimer);

  const sendMessage = () => {
    try {
      // Capturar contenido simplificado (primeros 2k caracteres para no saturar)
      // Solo tomamos contenido nuevo si es navegación o interacción mayor, no para eventos simples
      const needsContent = actionType === 'navigate' || actionType === 'interaction';
      const contentSnippet = needsContent ? document.body.innerText.replace(/\s+/g, ' ').trim().substring(0, 2000) : undefined;

      const payload: ContextPayload = {
        url: window.location.href,
        title: document.title || 'Página sin título',
        description: description,
        timestamp: Date.now(),
        pageContent: contentSnippet,
        actionType: actionType
      };

      console.log("[Companion Content] Reportando:", description, actionType);

      chrome.runtime.sendMessage({
        type: MessageType.BROWSER_ACTIVITY,
        payload
      }).catch((err: any) => {
        // console.debug("Background dormido?", err);
      });

    } catch (e) {
      console.error("Error reportando actividad:", e);
    }
  };

  if (immediate) {
    sendMessage();
  } else {
    debounceTimer = setTimeout(sendMessage, DEBOUNCE_DELAY);
  }
}

// 1. Detección de Navegación Inicial
reportActivity("El usuario entró a este sitio.", false, "navigate");

// 2. Detección de Scroll (Doomscrolling)
let lastScrollY = window.scrollY;
let scrollTimeout: any;

window.addEventListener('scroll', () => {
  const current = window.scrollY;
  if (Math.abs(current - lastScrollY) > 1500) {
    lastScrollY = current;
    // Debounce del scroll para no saturar
    if (scrollTimeout) clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      reportActivity("El usuario está haciendo doomscrolling frenéticamente.", false, "interaction");
    }, 1000);
  }
  resetIdleTimer();
});

// 3. Selección de Texto
document.addEventListener('mouseup', () => {
  const selection = window.getSelection()?.toString().trim();
  if (selection && selection.length > 5) {
    const cleanText = selection.substring(0, 100) + (selection.length > 100 ? "..." : "");
    reportActivity(`El usuario seleccionó el texto: "${cleanText}".`, false, "interaction");
  }
  resetIdleTimer();
});

// 4. Detección de Clics (Botones, Links) - Reemplazado por la nueva lógica de Rage Clicks
// La lógica original de clics se integrará en la nueva sección de Rage Clicks.

// 5. Detector de Inactividad (Idle)
let idleTimer: any;
const IDLE_LIMIT = 20000; // 20 segundos

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    reportActivity("El usuario se quedó estático, no mueve el mouse ni hace nada.", false, "interaction");
  }, IDLE_LIMIT);
}

// ==========================================
// NUEVAS INTERACCIONES (Compadre Mode)
// ==========================================

// 6. Detección de Multimedia (YouTube, Netflix, etc.)
document.addEventListener('play', (e) => {
  const target = e.target as HTMLMediaElement;
  if (target.tagName === 'VIDEO' || target.tagName === 'AUDIO') {
    const duration = target.duration;
    const type = target.tagName === 'VIDEO' ? 'video' : 'audio';
    if (duration > 30) {
      reportActivity(`El usuario empezó a reproducir un ${type} de ${Math.round(duration / 60)} minutos.`, true, "media");
    }
  }
}, true); // Capture phase para eventos de media

// 7. Copiar y Pegar
document.addEventListener('copy', () => {
  const text = window.getSelection()?.toString() || '';
  reportActivity(`El usuario copió texto (${text.length} caracteres).`, true, "interaction");
});

document.addEventListener('paste', () => {
  reportActivity("El usuario pegó contenido.", true, "interaction");
});

// 8. Detección de Rage Clicks (Clics de furia)
let lastClickTime = 0;
let lastClickX = 0;
let lastClickY = 0;
let clickCount = 0;

document.addEventListener('click', (e: MouseEvent) => {
  const now = Date.now();
  const dist = Math.sqrt(Math.pow(e.clientX - lastClickX, 2) + Math.pow(e.clientY - lastClickY, 2));

  // Si hace clic en el mismo sitio (dist < 20px) muy rápido (< 500ms)
  if (dist < 20 && (now - lastClickTime) < 500) {
    clickCount++;
  } else {
    clickCount = 1;
  }

  lastClickTime = now;
  lastClickX = e.clientX;
  lastClickY = e.clientY;

  if (clickCount === 4) { // 4 clics seguidos
    reportActivity("¡RAGE CLICK! El usuario está golpeando el mouse.", true, "input");
    clickCount = 0;
    return;
  }

  // Lógica normal de clic (Texto de botones/links)
  const target = e.target as HTMLElement;
  if (target && clickCount === 1) {
    const text = target.innerText?.trim() || target.getAttribute('aria-label') || target.getAttribute('alt');
    const tag = target.tagName.toLowerCase();

    // Solo reportar si es interactivo
    if (tag === 'button' || tag === 'a' || target.closest('a') || target.closest('button')) {
      const cleanText = text ? text.substring(0, 50) : "elemento";
      if (cleanText) reportActivity(`El usuario hizo clic en ${tag === 'a' ? 'un enlace' : 'un botón'}: "${cleanText}".`, false, "interaction");
    }
  }
  resetIdleTimer();
});

// 9. Detección de Escritura (Typing)
let typingTimer: any;
let keyPressCount = 0;

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  // Ignorar contraseñas
  if (target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'password') return;

  // Solo contar si está en un campo de texto
  if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
    keyPressCount++;

    if (typingTimer) clearTimeout(typingTimer);

    typingTimer = setTimeout(() => {
      if (keyPressCount > 20) {
        reportActivity("El usuario está escribiendo mucho texto.", false, "input");
      }
      keyPressCount = 0;
    }, 2000); // Evaluar cada 2 segundos de pausa
  }
  resetIdleTimer();
});

// 10. Detección de Foco (cuando el usuario vuelve a la pestaña)
window.addEventListener('focus', () => {
  reportActivity("El usuario volvió a enfocar esta pestaña.", false, "interaction");
  resetIdleTimer();
});

// Inicializar detector de actividad
['mousemove', 'keydown', 'click', 'scroll'].forEach(evt => {
  window.addEventListener(evt, resetIdleTimer);
});
resetIdleTimer();

// 11. Detección de Navegación SPA (YouTube, Spotify)
let lastUrl = window.location.href;
// Usamos un observer para detectar cambios de URL en SPAs que no recargan
setInterval(() => {
  const currentUrl = window.location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    // Esperar un momento a que el DOM se actualice con el nuevo contenido
    setTimeout(() => {
      reportActivity("El usuario navegó internamente a una nueva sección.", true, "navigate");
    }, 1500);
  }
}, 1000);
