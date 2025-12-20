// Tipos inline para evitar chunk separado (requerido por Chrome Service Workers)
enum MessageType {
  BROWSER_ACTIVITY = 'BROWSER_ACTIVITY',
  GET_LAST_CONTEXT = 'GET_LAST_CONTEXT',
  CONTEXT_UPDATED = 'CONTEXT_UPDATED',
  CONTEXT_RESPONSE = 'CONTEXT_RESPONSE',
  CONTEXT_REFRESH_REQUESTED = 'CONTEXT_REFRESH_REQUESTED'
}

interface ContextPayload {
  url: string;
  title: string;
  description: string;
  timestamp: number;
  pageContent?: string;
  actionType?: "navigate" | "interaction" | "input" | "media";
}

interface AppMessage {
  type: MessageType;
  payload?: any;
}

declare const chrome: any;

// --- ESTADO GLOBAL ---
let currentContextState: ContextPayload = {
  url: '',
  title: 'Nada',
  description: 'El usuario mira al vacío.',
  timestamp: 0
};

// Variable para evitar broadcasts duplicados en ráfaga
let lastBroadcastUrl: string = '';
let lastBroadcastTime: number = 0;
const BROADCAST_DEBOUNCE_MS = 150;

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
 * Obtiene el contexto fresco con delay para asegurar que el título ha actualizado.
 * Esto soluciona el bug del "fantasma" donde se mostraba el título de la página anterior.
 */
async function getDelayedFreshContext(tabId: number, description: string = 'Navegación SPA detectada'): Promise<ContextPayload> {
  return new Promise((resolve) => {
    // Esperar 100ms para que el título se actualice en sitios como YouTube/Spotify
    setTimeout(async () => {
      try {
        const freshTab = await chrome.tabs.get(tabId);
        if (freshTab && freshTab.url && !freshTab.url.startsWith('chrome-extension://')) {
          const freshContext: ContextPayload = {
            url: freshTab.url,
            title: freshTab.title || 'Sitio sin nombre',
            description: description,
            timestamp: Date.now(),
            actionType: 'navigate'
          };
          currentContextState = freshContext;
          resolve(freshContext);
        } else {
          resolve(currentContextState);
        }
      } catch (error) {
        console.error("Error getting fresh tab:", error);
        resolve(currentContextState);
      }
    }, 100);
  });
}

/**
 * Difunde el estado actual a la interfaz de usuario (Popup).
 * Si se pasa un contexto explícito, se usa ese (para eventos específicos).
 * Si no, se recalcula el estado general de la pestaña.
 * Incluye debounce para evitar spam de mensajes.
 */
async function broadcastSystemState(specificContext?: ContextPayload, forceNow: boolean = false) {
  const context = specificContext || await retrieveActiveTabInfo();

  // Debounce para evitar ráfagas de broadcasts por la misma URL
  const now = Date.now();
  if (!forceNow && context.url === lastBroadcastUrl && (now - lastBroadcastTime) < BROADCAST_DEBOUNCE_MS) {
    console.log("[Background] Broadcast debounced:", context.url);
    return;
  }

  lastBroadcastUrl = context.url;
  lastBroadcastTime = now;

  try {
    await chrome.runtime.sendMessage({
      type: MessageType.CONTEXT_UPDATED,
      payload: context
    });
    console.log("[Background] Context broadcast:", context.title);
  } catch (error) {
    // La UI no está escuchando (popup cerrado), esto es esperado.
  }
}

// --- EVENT LISTENERS ---

// 1. Cambio de pestaña activa
chrome.tabs.onActivated.addListener(() => {
  broadcastSystemState();
});

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

// ============================================
// 4. DETECCIÓN PROACTIVA DE SPAs (YouTube, Spotify, etc.)
// Este es el evento CLAVE: Se dispara cuando una SPA cambia la URL 
// usando pushState/replaceState sin recargar la página.
// ============================================
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details: any) => {
  // Solo procesar el frame principal
  if (details.frameId !== 0) return;

  console.log("[Background] SPA Navigation detected:", details.url);

  // Obtener contexto fresco con delay para título correcto
  const freshContext = await getDelayedFreshContext(details.tabId, 'El usuario navegó a nueva sección');

  // Forzar broadcast inmediato
  broadcastSystemState(freshContext, true);
});

// 5. Bus de mensajes (Comunicación UI <-> Background)
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

  // NUEVO: Refresh solicitado desde content.js (popstate/pushState intercept)
  if (message.type === MessageType.CONTEXT_REFRESH_REQUESTED) {
    const tabId = sender.tab?.id;
    if (tabId) {
      console.log("[Background] Context refresh requested from content script");
      getDelayedFreshContext(tabId, 'El usuario usó navegación del historial').then((freshContext) => {
        broadcastSystemState(freshContext, true);
      });
    }
  }
});

// 6. Gestión de Ventana (Singleton Pattern para el Popup)
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