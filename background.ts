
import { MessageType, AppMessage, ContextPayload } from './types';

declare const chrome: any;

let assistantWindowId: number | null = null;
// MEMORIA: Guardamos el último contexto recibido (variable 'i' en tu descripción conceptual)
let lastContext: ContextPayload | null = null;

// Listener principal
chrome.runtime.onMessage.addListener((message: AppMessage, sender: any, sendResponse: any) => {
  
  // 1. Handshake / Status check
  if (message.type === MessageType.GET_STATUS) {
      sendResponse({ 
        isActive: true,
        context: lastContext 
      });
  }

  // 2. Solicitud explícita de la UI (Pull) - CRÍTICO PARA EL INICIO
  if (message.type === MessageType.REQUEST_LATEST_CONTEXT) {
      // FIX: Si es null, enviamos un objeto vacío explícito para evitar crashes en UI
      const safeContext = lastContext || { 
        event: 'NO_CONTEXT', 
        url: '', 
        title: '', 
        timestamp: Date.now() 
      };
      
      console.log("Background: UI solicitó último contexto. Enviando:", safeContext);
      sendResponse(safeContext);
  }

  // 3. CONTEXT HUB: Recibir actualización del Content Script
  if (message.type === MessageType.CONTEXT_UPDATE) {
    // A. Guardar en memoria (Persistencia de sesión)
    if (message.payload) {
      lastContext = message.payload;
      console.log("Background: Contexto actualizado en memoria:", lastContext);
    }

    // B. Reenviar a la UI (App.tsx) con DELAY
    // El delay ayuda a prevenir condiciones de carrera si la UI está ocupada renderizando
    setTimeout(() => {
        chrome.runtime.sendMessage(message).catch(() => {
          // Ignoramos error si la ventana no está abierta
        });
    }, 200);
  }

  return true; // Mantiene el canal de respuesta abierto para async (necesario para sendResponse)
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

  // C. Inyección retardada al abrir
  // Esperamos a que React cargue (1s) y enviamos el contexto proactivamente
  if (lastContext) {
      console.log("Background: Programando envío de contexto inicial a ventana nueva...");
      setTimeout(() => {
          chrome.runtime.sendMessage({
              type: MessageType.CONTEXT_UPDATE,
              payload: lastContext
          }).catch(err => console.log("Fallo envío inicial (posiblemente UI no lista):", err));
      }, 1000);
  }
}
