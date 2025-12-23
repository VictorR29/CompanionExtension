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
  actionType?: "navigate" | "interaction" | "input" | "media" | "idle";
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

// Tracking de la pestaña activa
let currentActiveTabId: number | null = null;

// Sistema de debounce - trackea URL Y TÍTULO para detectar cambios reales
let pendingNavigationTimeout: ReturnType<typeof setTimeout> | null = null;
let lastBroadcastKey: string = ''; // URL + Título combinados
let isNavigating: boolean = false; // ⬅️ Guardia de transición
const NAVIGATION_DEBOUNCE_MS = 1000; // 1s de gracia para SPAs como YouTube

// --- HELPERS DE NAVEGACIÓN ---

/**
 * Detecta si un título es genérico/placeholder (típico de YouTube cargando)
 */
const isGenericTitle = (t: string): boolean =>
  ['youtube', 'home', 'watch', 'video'].includes(t.toLowerCase().trim());

/**
 * Genera una clave única para URL + Título
 */
function getContextKey(url: string, title: string): string {
  return `${url}|||${title}`;
}

/**
 * Sistema centralizado de broadcast con debounce inteligente.
 * Trackea tanto URL como TÍTULO para detectar cambios reales en SPAs.
 * Si detecta un título genérico (placeholder), espera 1s más.
 */
function scheduleNavigationBroadcast(tabId: number, description: string) {
  // Cancelar cualquier broadcast pendiente
  if (pendingNavigationTimeout) {
    clearTimeout(pendingNavigationTimeout);
  }

  console.log("[Background] Scheduling broadcast for tab:", tabId);

  pendingNavigationTimeout = setTimeout(async () => {
    try {
      const tab = await chrome.tabs.get(tabId);

      if (!tab || !tab.url || !tab.active) return;
      if (tab.url.startsWith('chrome-extension://')) return;

      // Si el título parece placeholder, esperamos 1s más
      if (isGenericTitle(tab.title || '')) {
        console.log('[Background] Título genérico detectado, re-intentando…');

        const retryKey = `retry-${tabId}`;
        // ⬅️ Persistimos el contador para que no se pierda si SW duerme
        chrome.storage.session.get([retryKey]).then(r => {
          const stored = r[retryKey] || 0;
          if (stored >= 2) return; // ya agotamos

          (globalThis as any)[retryKey] = stored + 1;
          chrome.storage.session.set({ [retryKey]: stored + 1 });

          pendingNavigationTimeout = null;
          scheduleNavigationBroadcast(tabId, description);
        });
        return;
      }

      const contextKey = getContextKey(tab.url, tab.title);

      // Evitar duplicados solo si URL Y TÍTULO son iguales
      if (contextKey === lastBroadcastKey) {
        console.log("[Background] Same URL+Title, skipping");
        const retryKey = `retry-${tabId}`;
        chrome.storage.session.remove([retryKey]);
        pendingNavigationTimeout = null;
        return;
      }


      const freshContext: ContextPayload = {
        url: tab.url,
        title: tab.title || 'Sitio sin nombre',
        description: description,
        timestamp: Date.now(),
        actionType: 'navigate'
      };

      currentContextState = freshContext;
      lastBroadcastKey = contextKey;

      await chrome.runtime.sendMessage({
        type: MessageType.CONTEXT_UPDATED,
        payload: freshContext
      });
      console.log("[Background] ✓ Broadcast:", freshContext.title);
    } catch (error) {
      // Tab cerrado o UI no escuchando
    }
    const retryKey = `retry-${tabId}`;
    chrome.storage.session.remove([retryKey]);
    pendingNavigationTimeout = null;
  }, NAVIGATION_DEBOUNCE_MS);
}

// --- SISTEMA DE COLA CON PRIORIDAD ---
const behaviorQueue: Record<'hi' | 'mid' | 'low', ContextPayload[]> = {
  hi: [], mid: [], low: []
};

const priority = (p: ContextPayload): 'hi' | 'mid' | 'low' =>
  p.description.includes('seleccionó') ? 'hi' :
    p.actionType === 'navigate' ? 'mid' : 'low';

/**
 * Encola un evento de comportamiento según su prioridad.
 */
function enqueueBehavior(p: ContextPayload) {
  behaviorQueue[priority(p)].push(p);
  // Descartar eventos de baja prioridad si la cola crece mucho
  if (behaviorQueue.hi.length + behaviorQueue.mid.length > 10) {
    behaviorQueue.low.shift();
  }
  flushBehaviorQueue();
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Procesa la cola de comportamiento, priorizando hi > mid > low.
 */
function flushBehaviorQueue() {
  if (flushTimer) clearTimeout(flushTimer);

  flushTimer = setTimeout(() => {
    const next = behaviorQueue.hi.shift() || behaviorQueue.mid.shift() || behaviorQueue.low.shift();
    if (next) {
      currentContextState = next;
      chrome.runtime.sendMessage({ type: MessageType.CONTEXT_UPDATED, payload: next })
        .catch(() => { }); // UI no escuchando
      console.log('[Background] ✓ Queue flush:', next.description);
      flushBehaviorQueue(); // seguir vaciando
    }
  }, 1200);
}

/**
 * Obtiene la información de la pestaña activa.
 */
async function retrieveActiveTabInfo(): Promise<ContextPayload> {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const activeTab = tabs[0];

    if (activeTab && activeTab.url && !activeTab.url.startsWith('chrome-extension://')) {
      return {
        url: activeTab.url,
        title: activeTab.title || 'Sitio sin nombre',
        description: 'Pestaña activa',
        timestamp: Date.now(),
        actionType: 'navigate'
      };
    }
  } catch (error) { }
  return currentContextState;
}

// --- EVENT LISTENERS ---

// 1. Cambio de pestaña activa
chrome.tabs.onActivated.addListener((activeInfo: { tabId: number; windowId: number }) => {
  if (activeInfo.tabId === currentActiveTabId) return;

  currentActiveTabId = activeInfo.tabId;
  console.log("[Background] Tab activated:", activeInfo.tabId);
  scheduleNavigationBroadcast(activeInfo.tabId, 'El usuario cambió a esta pestaña');
});

// 2. Actualización de contenido - CLAVE: escuchar TANTO url como title
// Lista blanca de hosts que sabemos que son SPAs
const SPA_HOSTS = new Set(['youtube.com', 'spotify.com', 'x.com', 'reddit.com', 'instagram.com']);

function isSPA(url: string) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return SPA_HOSTS.has(hostname) || hostname.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

// 2. Actualización de contenido - CLAVE: escuchar TANTO url como title
chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: any, tab: any) => {
  if (!tab.active) return;

  currentActiveTabId = tabId;

  // Reaccionar a cambios de URL O de título (SPAs actualizan título después)
  if (changeInfo.url || changeInfo.title) {
    if (isSPA(tab.url || '')) {
      console.log('[Background] SPA detectada, **silencio total** – esperando content-script');
      return; // ⬅️ NADA más
    }

    // Desactivamos la lógica de adivinación para evitar capturar títulos viejos
    // console.log("[Background] Tab updated:", changeInfo.url || changeInfo.title);
    // scheduleNavigationBroadcast(tabId, 'El usuario navegó a nuevo contenido');
  }
});

// 3. Cambio de foco de ventana (sin cambios)
chrome.windows.onFocusChanged.addListener(async (windowId: number) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;

  try {
    const tabs = await chrome.tabs.query({ active: true, windowId: windowId });
    if (tabs[0] && !tabs[0].url?.startsWith('chrome-extension://')) {
      if (tabs[0].id !== currentActiveTabId) {
        currentActiveTabId = tabs[0].id;
        scheduleNavigationBroadcast(tabs[0].id, 'El usuario cambió de ventana');
      }
    }
  } catch (e) { }
});

// 4. Navegación SPA (pushState/replaceState) - Ignorar, usamos content-script
chrome.webNavigation.onHistoryStateUpdated.addListener((details: any) => {
  if (details.frameId !== 0) return;
  // Solo log, no broadcast directo
  console.log("[Background] SPA history update:", details.url);
});

// 5. Bus de mensajes
let assistantSpeaking = false; // Para evitar enviar frames mientras habla

chrome.runtime.onMessage.addListener((message: AppMessage, sender: any, sendResponse: any) => {
  if (message.type === MessageType.GET_LAST_CONTEXT) {
    retrieveActiveTabInfo().then((context) => sendResponse(context));
    return true;
  }

  if (message.type === MessageType.BROWSER_ACTIVITY) {
    const payload = message.payload as ContextPayload;

    // ⛔ No re-broadcastear inactividad como navegación
    if (payload.actionType === 'idle') {
      currentContextState = payload;
      return;
    }

    // ⬅️ BLOQUEO si estamos navegando (ignoramos clicks/interacciones viejas)
    if (isNavigating && payload.actionType !== 'navigate') {
      return;
    }

    // Si es navegación desde content-script, actualizar estado directamente
    if (payload.actionType === 'navigate' && payload.url) {
      console.log('[Background] ✓ Commit recibido:', payload.title, payload.url);

      // ⬅️ VALIDACIÓN DE INTEGRIDAD: Si título es igual al anterior pero URL distinta, ignorar (premature)
      if (payload.title === currentContextState.title && payload.url !== currentContextState.url) {
        console.log('[Background] ⚠️ Título desincronizado (URL nueva, Título viejo). Esperando...');
        // Esperamos 500ms extra por si acaso llega el bueno
        setTimeout(() => { }, 500);
        return;
      }

      // ⬅️ Resetear clave de broadcast para aceptar el nuevo estado incondicionalmente
      lastBroadcastKey = '';
      isNavigating = false; // 🔓 Desbloqueamos interacciones

      currentContextState = payload;

      // ⬅️ Resetear clave de broadcast para aceptar el nuevo estado incondicionalmente
      lastBroadcastKey = '';

      currentContextState = payload;
      // lastBroadcastKey = getContextKey(payload.url, payload.title); // Ya no la seteamos aquí para no bloquear
      chrome.runtime.sendMessage({ type: MessageType.CONTEXT_UPDATED, payload });
      return;
    }

    if (payload.url && !payload.url.startsWith('chrome-extension://')) {
      enqueueBehavior(payload);
    }
  }

  if (message.type === MessageType.CONTEXT_REFRESH_REQUESTED) {
    // Ignorar si es SPA conocida (confiamos en el emitStableContext)
    const tabUrl = sender.tab?.url || '';
    if (!isSPA(tabUrl)) {
      const tabId = sender.tab?.id;
      if (tabId) scheduleNavigationBroadcast(tabId, 'El usuario usó navegación del historial');
    }
  }

  // ⬅️ SEÑAL DE INICIO DE NAVEGACIÓN (SPA)
  if ((message as any).type === 'NAV_STARTING') {
    isNavigating = true; // 🔒 Bloqueamos interacciones
    console.log('[Background] 🔒 Navegación iniciada (interacciones pausadas)');
  }


  // MEDIA_CAPTURED: Guardar en storage (URL)
  if ((message as any).type === 'MEDIA_CAPTURED') {
    // Guardamos la URL, no base64
    // @ts-ignore
    chrome.storage.session.set({
      lastMedia: {
        type: (message as any).mediaType,
        data: (message as any).data, // <-- ahora es una URL
        url: (message as any).url,
        title: (message as any).title,
        ts: Date.now()
      }
    });
    console.log('[Background] URL guardada:', (message as any).data);
  }

  // GET_VIDEO_FRAME proxy: Popup -> Background -> Active Tab
  if (message.type === 'GET_VIDEO_FRAME' as any) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_VIDEO_FRAME' }, (response) => {
          sendResponse(response);
        });
      } else {
        sendResponse(null);
      }
    });
    return true; // async response
  }
});

// 6. SISTEMA DE PUERTOS PERSISTENTES (Gemini Live)
let geminiPort: any = null;
let geminiSessionActive: boolean = false;

chrome.runtime.onConnect.addListener((port: any) => {
  if (port.name !== 'gemini-live') return;

  console.log('[Background] Puerto gemini-live conectado');
  geminiPort = port;

  // ⬅️ NUEVO: mandamos inmediatamente el último media guardado
  chrome.storage.session.get(['lastMedia']).then(({ lastMedia }: any) => {
    if (lastMedia) {
      port.postMessage({ type: 'LAST_MEDIA', payload: lastMedia });
    }
  });

  // Informar al popup si ya hay una sesión activa
  if (geminiSessionActive) {
    port.postMessage({ type: 'SESSION_STATUS', active: true });
  }

  port.onMessage.addListener((msg: any) => {
    // El popup informa que inició sesión Gemini
    if (msg.type === 'GEMINI_SESSION_STARTED') {
      geminiSessionActive = true;
      console.log('[Background] Sesión Gemini iniciada');
    }

    // El popup informa que cerró sesión Gemini
    if (msg.type === 'GEMINI_SESSION_ENDED') {
      geminiSessionActive = false;
      assistantSpeaking = false;
      console.log('[Background] Sesión Gemini terminada');
    }

    // El popup informa que el asistente está hablando
    if (msg.type === 'ASSISTANT_SPEAKING') {
      assistantSpeaking = true;
    }

    // El popup informa que el asistente terminó de hablar
    if (msg.type === 'ASSISTANT_IDLE') {
      assistantSpeaking = false;
    }

    // Reenviar contexto al popup bajo demanda
    if (msg.type === 'GET_CURRENT_CONTEXT') {
      port.postMessage({ type: 'CURRENT_CONTEXT', payload: currentContextState });
    }
  });

  port.onDisconnect.addListener(() => {
    console.log('[Background] Puerto gemini-live desconectado (popup cerrado)');
    geminiPort = null;
    // NO cerramos la sesión aquí - el popup puede reconectar
  });
});

// Función para enviar contexto al popup via puerto (más eficiente que sendMessage)
function sendContextToPort(context: ContextPayload) {
  if (geminiPort) {
    try {
      geminiPort.postMessage({ type: 'CONTEXT_UPDATED', payload: context });
    } catch (e) {
      geminiPort = null;
    }
  }
}

// 7. Gestión de Ventana Singleton
let assistantWindowId: number | null = null;

chrome.action.onClicked.addListener(async () => {
  if (assistantWindowId !== null) {
    try {
      await chrome.windows.get(assistantWindowId);
      await chrome.windows.update(assistantWindowId, { focused: true });
      return;
    } catch (error) {
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