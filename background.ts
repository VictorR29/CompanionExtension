import { MessageType, AppMessage, ContextPayload } from './types';

declare const chrome: any;

// --- ESTADO GLOBAL ---
let currentContextState: ContextPayload = {
  url: '',
  title: 'Nada',
  description: 'El usuario mira al vacío.',
  timestamp: 0
};

// --- HELPERS DE NAVEGACIÓN ---

/**
 * Obtiene la información de la pestaña activa ignorando la ventana de la extensión.
 */
async function retrieveActiveTabInfo(): Promise<ContextPayload> {
  try {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });

    let activeTab = null;

    // 1. Intentar obtener de la última ventana enfocada
    const lastFocusedWindow = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    if (lastFocusedWindow && lastFocusedWindow.tabs) {
      activeTab = lastFocusedWindow.tabs.find((t: any) => t.active);
    }

    // 2. Fallback: buscar en cualquier ventana
    if (!activeTab) {
      for (const windowItem of windows) {
        const tab = windowItem.tabs?.find((t: any) => t.active);
        if (tab) {
          activeTab = tab;
          break;
        }
      }
    }

    if (activeTab && activeTab.url && !activeTab.url.startsWith('chrome-extension://')) {
      const freshContext: ContextPayload = {
        url: activeTab.url,
        title: activeTab.title || 'Sitio sin nombre',
        description: 'Navegando activamente',
        timestamp: Date.now()
      };

      currentContextState = freshContext;
      return freshContext;
    }
  } catch (error) {
    console.error("System Error: Failed to retrieve active tab:", error);
  }
  return currentContextState;
}

/**
 * Difunde el estado actual a la interfaz de usuario (Popup).
 */
/**
 * Difunde el estado actual a la interfaz de usuario (Popup).
 * Si se pasa un contexto explícito, se usa ese (para eventos específicos).
 * Si no, se recalcula el estado general de la pestaña.
 */
async function broadcastSystemState(specificContext?: ContextPayload) {
  const context = specificContext || await retrieveActiveTabInfo();
  try {
    await chrome.runtime.sendMessage({
      type: MessageType.CONTEXT_UPDATED,
      payload: context
    });
  } catch (error) {
    // La UI no está escuchando (popup cerrado), esto es esperado.
  }
}

// --- EVENT LISTENERS ---

// 1. Cambio de pestaña activa
chrome.tabs.onActivated.addListener(() => {
  broadcastSystemState();
});

// 2. Actualización de contenido (carga completa)
// 2. Actualización de contenido (carga completa o cambio de URL/Título en SPA)
chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: any, tab: any) => {
  if (tab.active) {
    if (changeInfo.status === 'complete' || changeInfo.url || changeInfo.title) {
      broadcastSystemState();
    }
  }
});

// 3. Cambio de foco de ventana
chrome.windows.onFocusChanged.addListener((windowId: number) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    broadcastSystemState();
  }
});

// 4. Bus de mensajes (Comunicación UI <-> Background)
chrome.runtime.onMessage.addListener((message: AppMessage, sender: any, sendResponse: any) => {

  if (message.type === MessageType.GET_LAST_CONTEXT) {
    retrieveActiveTabInfo().then((context) => {
      sendResponse(context);
    });
    return true; // Respuesta asíncronas
  }

  if (message.type === MessageType.BROWSER_ACTIVITY) {
    const payload = message.payload as ContextPayload;
    // Solo actualizamos si es una URL válida y no interna
    if (payload.url && !payload.url.startsWith('chrome-extension://')) {
      currentContextState = payload;
      // USAR EL PAYLOAD ESPECÍFICO (Clics, Selección, etc.)
      broadcastSystemState(payload);
    }
  }
});

// 5. Gestión de Ventana (Singleton Pattern para el Popup)
let assistantWindowId: number | null = null;

chrome.action.onClicked.addListener(async () => {
  if (assistantWindowId !== null) {
    try {
      // Verificar si la ventana realmente existe
      await chrome.windows.get(assistantWindowId);
      await chrome.windows.update(assistantWindowId, { focused: true });
      return;
    } catch (error) {
      // Si falla, el ID es inválido, reseteamos
      assistantWindowId = null;
    }
  }

  const newWindow = await chrome.windows.create({
    url: chrome.runtime.getURL('index.html'),
    type: 'popup',
    width: 360,
    height: 600,
    focused: true
  });

  assistantWindowId = newWindow.id || null;
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === assistantWindowId) {
    assistantWindowId = null;
  }
});