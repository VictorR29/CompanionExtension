// Companion Content Script - Vitality Edition
enum MessageType {
  BROWSER_ACTIVITY = 'BROWSER_ACTIVITY',
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

declare const chrome: any;

const CONFIG = {
  SCROLL_THRESHOLD: 3000,
  IDLE_LIMIT: 50000,
  INTERACTION_COOLDOWN: 5000
};

let lastInteractionTime = 0;
let lastUrl = window.location.href;

function report(desc: string, type: any = "interaction", extra?: string) {
  if (!chrome.runtime?.id) return;
  const now = Date.now();
  if (type !== 'navigate' && (now - lastInteractionTime) < CONFIG.INTERACTION_COOLDOWN) return;

  lastInteractionTime = now;
  const payload: ContextPayload = {
    url: window.location.href,
    title: document.title,
    description: desc,
    timestamp: now,
    actionType: type,
    pageContent: extra
  };
  chrome.runtime.sendMessage({ type: MessageType.BROWSER_ACTIVITY, payload }).catch(() => { });
}

// 1. Navegación (Manejada por SPA-Guard al final del archivo)

// 2. Inactividad
let idleTimer: any;
function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    report('El usuario se quedó mirando la pantalla como un zombie', 'idle');
  }, CONFIG.IDLE_LIMIT);
}

// 3. Interacciones
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const btn = target.closest('button, a, [role="button"]');
  if (btn) {
    const label = btn.getAttribute('aria-label') || btn.textContent?.trim().substring(0, 30);
    report(`Hizo clic en: ${label || 'un elemento'}`, "interaction");
  }
  resetIdle();
});

document.addEventListener('mouseup', () => {
  const selection = window.getSelection()?.toString().trim();
  if (selection && selection.length > 10) {
    report("Seleccionó un texto", "interaction", selection);
  }
  resetIdle();
});

/********************************************************************
 *  USER-SCROLL-ONLY  (evita falsos positivos en X, IG, etc.)
 ********************************************************************/
let scrollSum = 0;
let lastY = window.scrollY;
let lastTime = Date.now();
let userScroll = false; // bandera

// Marcamos como "usuario" solo si el scroll viene de wheel/touch/teclas
['wheel', 'touchmove', 'keydown'].forEach(ev =>
  window.addEventListener(ev, () => {
    userScroll = true;
    resetIdle(); // También reseteamos idle aquí por si acaso
  }, { passive: true, capture: true })
);

window.addEventListener('scroll', () => {
  const now = Date.now();
  const delta = Math.abs(window.scrollY - lastY);
  lastY = window.scrollY;

  // Descartamos scrolls muy rápidos (< 16 ms) o sin bandera de usuario
  if (!userScroll || now - lastTime < 16) {
    lastTime = now;
    return;
  }

  scrollSum += delta;
  if (scrollSum > CONFIG.SCROLL_THRESHOLD) {
    scrollSum = 0;
    report('Está scrolleando intensamente', 'interaction');
  }
  lastTime = now;
  userScroll = false; // reset para el próximo frame
  resetIdle();
}, { passive: true });

let keyCount = 0;
document.addEventListener('keydown', (e) => {
  if (e.key.length === 1) {
    keyCount++;
    if (keyCount > 30) {
      keyCount = 0;
      report("Está escribiendo mucho texto", "input");
    }
  }
  resetIdle();
});

['mousemove', 'touchstart'].forEach(ev => window.addEventListener(ev, resetIdle, { passive: true }));
resetIdle();
report("El usuario entró a la página", "navigate", document.body.innerText.substring(0, 1000));

/********************************************************************
 *  CAPTURA SELECTIVA  (imagen al entrar, video bajo demanda)
 ********************************************************************/
const captureImage = (img: HTMLImageElement): string => {
  const canvas = document.createElement('canvas');
  const max = 1024;
  const ratio = Math.min(max / img.naturalWidth, max / img.naturalHeight, 1);
  canvas.width = img.naturalWidth * ratio;
  canvas.height = img.naturalHeight * ratio;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  try {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch (e) { return ''; }
};

const captureVideoFrame = (video: HTMLVideoElement): string => {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.6);
  } catch (e) { return ''; }
};

// ---------- IMÁGENES ----------
// Observa el DOM una sola vez al entrar
const imgObserver = new MutationObserver(() => {
  // 1. ¿Estamos DENTRO de una publicación única?
  const isPostView = /\/(status|p|pin)\/[\w-]+/.test(location.pathname);
  if (!isPostView) return;

  // 2. Busca la imagen PRINCIPAL (la más grande o la primera grande)
  const img = Array.from(document.images)
    .filter(i => i.naturalWidth > 300 && i.src && i.src.startsWith('http'))
    .sort((a, b) => b.naturalWidth - a.naturalWidth)[0];

  if (img && !img.dataset.glitchCaptured) {
    img.dataset.glitchCaptured = '1';
    // Esperar a que cargue si no está lista
    if (img.complete) {
      processImage(img);
    } else {
      img.onload = () => processImage(img);
    }
  }
});

function processImage(img: HTMLImageElement) {
  const tryCapture = (attempt: number) => {
    if (attempt > 3 || img.naturalWidth === 0) return;
    if (img.complete && img.naturalWidth > 0) {
      const data = captureImage(img);
      if (data) {
        chrome.runtime.sendMessage({ type: 'MEDIA_CAPTURED', mediaType: 'image', data, url: location.href, title: document.title }).catch(() => { });
        console.log('[Content] Imagen capturada y enviada');
      }
      return;
    }
    setTimeout(() => tryCapture(attempt + 1), 800);
  };
  tryCapture(1);
}

imgObserver.observe(document.body, { childList: true, subtree: true });

// ---------- VÍDEOS ----------
// Guardamos referencia al video visible (sin capturar aún)
let activeVideo: HTMLVideoElement | null = null;
const videoPoller = setInterval(() => {
  const v = document.querySelector('video') as HTMLVideoElement;
  if (v && !v.paused && v.readyState >= 2) activeVideo = v;
  else activeVideo = null;
}, 1000);

// Escucha pedido de frame desde background
chrome.runtime.onMessage.addListener((msg: any, sender: any, sendResponse: any) => {
  if (msg.type === 'GET_VIDEO_FRAME') {
    if (activeVideo) {
      const frame = captureVideoFrame(activeVideo);
      sendResponse({ frame, url: location.href, title: document.title });
    } else {
      sendResponse(null);
    }
    return true; // async
  }
});

/*********************************************************************
 *  UNIVERSAL SPA-Guard
 *  Emite navegación solo cuando URL+cotenido sean ESTABLES
 *********************************************************************/
let lastGuardUrl = location.href;
let lastGuardTitle = document.title;
let guardTimer: any;
const GUARD_DELAY = 700; // ms

// --- helpers ---
const isSameUrl = () => location.href === lastGuardUrl;
const isTitleStable = () => document.title === lastGuardTitle;
const getMainHeading = () =>
  document.querySelector('h1, [role="heading"], header h1, main h1')?.textContent?.trim() || '';

function tryUniversalCommit(reason: string) {
  // 1. ¿URL cambió?
  if (isSameUrl()) return;
  lastGuardUrl = location.href;
  lastGuardTitle = document.title; // guardamos el primero

  console.log('[Content] URL cambió, esperando estabilidad...', reason);

  if (guardTimer) clearInterval(guardTimer);
  let checks = 0;
  const MAX_CHECKS = 3;
  const INTERVAL = GUARD_DELAY / MAX_CHECKS;

  let lastHeading = getMainHeading();

  guardTimer = setInterval(() => {
    // 2. ¿Título **o** <h1> se mantuvo igual?
    const currentHeading = getMainHeading();
    const stable = isTitleStable() || (lastHeading !== '' && currentHeading === lastHeading);

    if (stable) {
      checks++;
      if (checks >= MAX_CHECKS) {
        clearInterval(guardTimer);
        // 3. CONTENIDO ESTABLE → emitimos
        console.log('[Content] ✓ Navegación confirmada:', document.title);
        report(reason, 'navigate', document.body.innerText.substring(0, 1000));
      }
    } else {
      // se movió algo → reset y seguimos esperando
      checks = 0;
      lastGuardTitle = document.title;
      lastHeading = currentHeading;
    }
  }, INTERVAL);
}

// --- hooks ---
['pushState', 'replaceState'].forEach(method => {
  // @ts-ignore
  const original = history[method];
  // @ts-ignore
  history[method] = function (...args) {
    original.apply(this, args);
    window.dispatchEvent(new Event(method)); // para otros listeners si los hubiera
    tryUniversalCommit(method);
  };
});

window.addEventListener('popstate', () => tryUniversalCommit('history pop'));

// MutationObserver solo para título (barato)
const titleTarget = document.querySelector('title');
if (titleTarget) {
  new MutationObserver(() => {
    // Si el título cambia y la URL es DIFERENTE a la última reportada, intentar commit
    // (Ojo: tryUniversalCommit chequea si URL cambió)
    if (!isSameUrl()) tryUniversalCommit('title mutado');
  }).observe(titleTarget, { childList: true, subtree: true });
} else {
  // Fallback simple
  new MutationObserver(() => {
    const t = document.querySelector('title');
    if (t && !isSameUrl()) tryUniversalCommit('title inject');
  }).observe(document.head, { childList: true });
}

console.log('[Content] UNIVERSAL SPA-Guard activado');
