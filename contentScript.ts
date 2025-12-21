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
  IDLE_LIMIT: 45000,
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
    report("El usuario se quedó mirando la pantalla como un zombie", "interaction");
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

let scrollSum = 0;
let lastY = window.scrollY;
document.addEventListener('scroll', () => {
  scrollSum += Math.abs(window.scrollY - lastY);
  lastY = window.scrollY;
  if (scrollSum > CONFIG.SCROLL_THRESHOLD) {
    scrollSum = 0;
    report("Está scrolleando intensamente", "interaction");
  }
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

// 4. CAPTURA DE FRAMES DE VIDEO (no intrusiva)

/**
 * Captura un frame del video y lo convierte a base64
 */
function captureFrame(video: HTMLVideoElement): string | null {
  try {
    const canvas = document.createElement('canvas');
    // Resolución reducida para no saturar
    const scale = Math.min(1, 640 / video.videoWidth);
    canvas.width = video.videoWidth * scale;
    canvas.height = video.videoHeight * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    // JPEG con calidad media para reducir tamaño
    return canvas.toDataURL('image/jpeg', 0.6);
  } catch (e) {
    // Video de origen cruzado (CORS)
    return null;
  }
}

let lastFrameSent = 0;

setInterval(() => {
  const video = document.querySelector('video') as HTMLVideoElement;
  if (!video || video.paused) return;

  const now = Date.now();
  if (now - lastFrameSent < 5000) return; // Solo cada 5s

  // Verificar que el video esté visible en viewport (80%+)
  const io = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      const frame = captureFrame(video);
      if (frame) {
        chrome.runtime.sendMessage({
          type: 'VIDEO_FRAME',
          frame,
          videoTitle: document.title,
          timestamp: now
        }).catch(() => { });
        lastFrameSent = now;
        console.log('[Content] Frame de video enviado');
      }
    }
    io.disconnect();
  }, { threshold: 0.8 });

  io.observe(video);
}, 1000);

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
