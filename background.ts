import { MessageType, AppMessage, ContextPayload } from './types';

declare const chrome: any;

// ESTADO GLOBAL EN MEMORIA
let ultimoContexto: ContextPayload = {
  url: '',
  title: 'Nada',
  description: 'El usuario mira al vacío.',
  timestamp: 0
};

// --- HELPERS ---

/**
 * Obtiene la pestaña activa real, ignorando la ventana de la extensión.
 */
async function getActiveTabInfo(): Promise<ContextPayload> {
  try {
    // 1. Obtener todas las ventanas normales (no popups ni paneles)
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    
    // 2. Buscar la pestaña activa en la ventana que tiene el foco (o la última que lo tuvo)
    let activeTab = null;
    
    // Primero intentar con la última ventana enfocada
    const lastFocused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    if (lastFocused && lastFocused.tabs) {
      activeTab = lastFocused.tabs.find((t: any) => t.active);
    }

    // Si no, buscar en cualquiera
    if (!activeTab) {
      for (const win of windows) {
        const tab = win.tabs?.find((t: any) => t.active);
        if (tab) {
          activeTab = tab;
          break;
        }
      }
    }

    if (activeTab && activeTab.url && !activeTab.url.startsWith('chrome-extension://')) {
      const realContext: ContextPayload = {
        url: activeTab.url,
        title: activeTab.title || 'Sitio sin nombre',
        description: 'Navegando activamente',
        timestamp: Date.now()
      };
      
      ultimoContexto = realContext;
      return realContext;
    }
  } catch (e) {
    console.error("Error obteniendo tab:", e);
  }
  return ultimoContexto;
}

/**
 * Envía el contexto actualizado a la UI (Popup) si está abierta.
 */
async function broadcastContextUpdate() {
  const ctx = await getActiveTabInfo();
  try {
    // Enviamos mensaje a la runtime. Si el popup está cerrado, esto fallará silenciosamente.
    await chrome.runtime.sendMessage({
      type: MessageType.CONTEXT_UPDATED,
      payload: ctx
    });
  } catch (e) {
    // Es normal que falle si la UI no está abierta
  }
}

// --- LISTENERS ---

// 1. Cambio de Pestaña activa
chrome.tabs.onActivated.addListener(() => {
  broadcastContextUpdate();
});

// 2. Actualización de URL/Carga en la misma pestaña
chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: any, tab: any) => {
  if (changeInfo.status === 'complete' && tab.active) {
    broadcastContextUpdate();
  }
});

// 3. Cambio de foco de ventana
chrome.windows.onFocusChanged.addListener((windowId: number) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    broadcastContextUpdate();
  }
});

// 4. Comunicación con la UI (React)
chrome.runtime.onMessage.addListener((message: AppMessage, sender: any, sendResponse: any) => {
  
  // Solicitud sincrónica del contexto inicial al abrir el popup
  if (message.type === MessageType.GET_LAST_CONTEXT) {
    getActiveTabInfo().then((ctx) => {
      sendResponse(ctx);
    });
    return true; // Indica respuesta asíncrona
  }

  // Recepción de actividad desde content scripts
  if (message.type === MessageType.BROWSER_ACTIVITY) {
    const payload = message.payload as ContextPayload;
    if (payload.url && !payload.url.startsWith('chrome-extension://')) {
      ultimoContexto = payload;
      broadcastContextUpdate();
    }
  }
});

// 5. Gestión de Ventana Popup
let assistantWindowId: number | null = null;

chrome.action.onClicked.addListener(async () => {
  if (assistantWindowId !== null) {
    try {
      await chrome.windows.get(assistantWindowId);
      await chrome.windows.update(assistantWindowId, { focused: true });
      return;
    } catch (e) {
      assistantWindowId = null;
    }
  }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('index.html'),
    type: 'popup',
    width: 360,
    height: 600,
    focused: true
  });
  
  assistantWindowId = win.id || null;
});

chrome.windows.onRemoved.addListener((winId) => {
  if (winId === assistantWindowId) {
    assistantWindowId = null;
  }
});