
// Fix: Declare chrome global to resolve 'Cannot find name chrome' errors in content script
declare const chrome: any;

import { MessageType, ContextPayload } from './types';

// Safety check: ensure chrome.runtime is available
const isExtensionCtx = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage;

let debounceTimer: any = null;
const DEBOUNCE_DELAY = 1500; // Delay para agrupar eventos rápidos

function sendContextUpdate(event: 'NAVIGATION' | 'SELECTION' | 'VISIBILITY_VISIBLE' | 'SCROLL' | 'INITIAL_LOAD') {
  if (!isExtensionCtx) return;

  // Clear pending updates
  if (debounceTimer) clearTimeout(debounceTimer);

  debounceTimer = setTimeout(() => {
    try {
      // CAPTURA DE DATOS REALES EN EL MOMENTO DEL ENVÍO
      const currentSelection = window.getSelection()?.toString().trim() || null;
      const currentUrl = window.location.href;
      const currentTitle = document.title;

      // Filtro de calidad de datos
      if (!currentUrl || currentUrl === 'about:blank') return;

      const payload: ContextPayload = {
        event,
        url: currentUrl,
        title: currentTitle || "Sin título",
        selection: currentSelection || undefined,
        timestamp: Date.now()
      };

      console.log("[ContentScript] Enviando contexto:", event, payload);

      chrome.runtime.sendMessage({
        type: MessageType.CONTEXT_UPDATE,
        payload
      }).catch(() => {
        // Extension context invalidated
      });
    } catch (e) {
      console.error("Error capturando contexto:", e);
    }
  }, event === 'INITIAL_LOAD' ? 500 : DEBOUNCE_DELAY); // INITIAL_LOAD es más rápido
}

// 1. Navigation Detection (SPA + Standard)
let lastUrl = location.href;
const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    sendContextUpdate('NAVIGATION');
  }
});
observer.observe(document, { subtree: true, childList: true });

// 2. Text Selection Detection
document.addEventListener('mouseup', () => {
  const selection = window.getSelection()?.toString().trim();
  if (selection && selection.length > 2) { 
    sendContextUpdate('SELECTION');
  }
});

// 3. Visibility & Focus (Tab Switching or App Switching)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    setTimeout(() => sendContextUpdate('VISIBILITY_VISIBLE'), 500);
  }
});

window.addEventListener('focus', () => {
  // Cuando la ventana recupera el foco (ej: alt-tab de vuelta al navegador)
  sendContextUpdate('VISIBILITY_VISIBLE');
});

// 4. Scroll Detection
let lastScrollY = window.scrollY;
window.addEventListener('scroll', () => {
  const currentScrollY = window.scrollY;
  // Solo notificar si ha scrolleado más de 1000px desde la última vez (doomscrolling detection)
  if (Math.abs(currentScrollY - lastScrollY) > 1000) {
    lastScrollY = currentScrollY;
    sendContextUpdate('SCROLL');
  }
});

// Initial Load - Forzamos actualización inmediata para despertar al asistente
sendContextUpdate('INITIAL_LOAD');
