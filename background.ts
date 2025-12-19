
import { MessageType, AppMessage, ContextPayload } from './types';

declare const chrome: any;

let assistantWindowId: number | null = null;
// MEMORIA: Guardamos el último contexto recibido para cuando la ventana se abra
let lastContext: ContextPayload | null = null;

// Listener principal
chrome.runtime.onMessage.addListener((message: AppMessage, sender: any, sendResponse: any) => {
  
  // 1. Handshake / Status check
  if (message.type === MessageType.GET_STATUS) {
      // Devolvemos el estado Y el último contexto conocido (Sync on load)
      sendResponse({ 
        isActive: true,
        context: lastContext 
      });
  }

  // 2. CONTEXT HUB: Recibir actualización del Content Script
  if (message.type === MessageType.CONTEXT_UPDATE) {
    // A. Guardar en memoria (Persistencia de sesión)
    if (message.payload) {
      lastContext = message.payload;
    }

    // B. Reenviar a la UI (App.tsx) si está abierta
    // chrome.runtime.sendMessage hace broadcast a todas las vistas de la extensión (popup/windows)
    chrome.runtime.sendMessage(message).catch(() => {
      // Es normal que falle si la ventana de la IA está cerrada.
      // No hacemos nada porque ya guardamos el dato en 'lastContext'.
    });
  }

  return true; // Mantiene el canal de respuesta abierto para async
});

// Gestión de ventanas
chrome.action.onClicked.addListener(() => {
  openAssistantWindow();
});

chrome.windows.onRemoved.addListener((windowId: number) => {
  if (windowId === assistantWindowId) {
    assistantWindowId = null;
  }
});

async function openAssistantWindow() {
  if (assistantWindowId !== null) {
    try {
      await chrome.windows.get(assistantWindowId);
      chrome.windows.update(assistantWindowId, { focused: true });
      return;
    } catch (e) {
      assistantWindowId = null;
    }
  }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('index.html'),
    type: 'popup',
    width: 350,
    height: 550,
    focused: true
  });
  
  assistantWindowId = win.id || null;
}
