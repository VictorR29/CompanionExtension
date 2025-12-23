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

// ⬅️ Prevenir doble inyección
(() => {
  if ((window as any).__glitchLoaded) return;
  (window as any).__glitchLoaded = true;

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


  /********************************************************************
   *  CAPTURA DE IMAGEN  (ahora se dispara DESPUÉS de navegación confirmada)
   *******************************************************************/
  function tryCaptureImage() {
    const bigImg = Array.from(document.images)
      .filter(img => {
        const rect = img.getBoundingClientRect();
        return img.naturalWidth >= 400 && rect.top >= 0 && rect.bottom <= window.innerHeight + 200;
      })
      .sort((a, b) => b.naturalWidth - a.naturalWidth)[0];

    if (!bigImg || !bigImg.complete) return;

    const canvas = document.createElement('canvas');
    const max = 1024;
    const ratio = Math.min(max / bigImg.naturalWidth, max / bigImg.naturalHeight, 1);
    canvas.width = bigImg.naturalWidth * ratio;
    canvas.height = bigImg.naturalHeight * ratio;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(bigImg, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', 0.85);
    chrome.runtime.sendMessage({ type: 'MEDIA_CAPTURED', mediaType: 'image', data, url: location.href, title: document.title });
    console.log('[Content] Imagen capturada');
  }

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
   *  Emite navegación solo cuando URL+contenido sean ESTABLES
   *********************************************************************/
  let lastGuardUrl = '';
  let lastGuardTitle = '';
  let lastEmittedKey = '';

  // ⬅️ Clave **persistente** en sesión
  const LAST_EMITTED_KEY = 'lastEmittedTitle';

  async function getLastEmittedTitle(): Promise<string> {
    const r = await chrome.storage.session.get([LAST_EMITTED_KEY]);
    return r[LAST_EMITTED_KEY] || '';
  }

  async function setLastEmittedTitle(title: string) {
    await chrome.storage.session.set({ [LAST_EMITTED_KEY]: title });
  }

  // ⬅️ Cargar desde sesión (si existe)
  chrome.storage.session.get(['guardUrl', 'guardTitle', 'emittedKey']).then(r => {
    lastGuardUrl = r.guardUrl || location.href;
    lastGuardTitle = r.guardTitle || document.title;
    lastEmittedKey = r.emittedKey || '';
  });

  // --- helpers ---
  const getContextKey = (url: string, title: string) => `${url}::${title}`;
  const isSameUrl = () => location.href === lastGuardUrl;

  // ⬅️ Helper para limpiar notificaciones "(1) Título"
  const getCleanTitle = () => document.title.replace(/^\(\d+\)\s*/, '').trim();

  let guardTimer: any;
  // const GUARD_DELAY = 700; // ms (Eliminado)

  async function tryUniversalCommit(reason: string) {
    const cleanUrl = location.href.replace(/#.*$/, '');
    // ⬅️ Solo bloqueamos si es la misma URL Y la razón NO es un cambio de título tardío
    if (reason !== 'title mutado' && cleanUrl === lastGuardUrl.replace(/#.*$/, '')) return;

    lastGuardUrl = location.href;

    const lastEmitted = await getLastEmittedTitle();
    const start = Date.now();

    // ⬅️ Bucle: esperamos hasta que el título sea DISTINTO al último emitido
    let checks = 0;
    const REQUIRED_CHECKS = 3; // debe ser igual 3 veces seguidas
    const CHECK_MS = 150;
    const MAX_WAIT = 2000;     // 2 s máximo

    while (checks < REQUIRED_CHECKS && Date.now() - start < MAX_WAIT) {
      const current = document.title;
      // Comparamos contra el último emitido (evitar eco)
      // Y también contra "YouTube" o genéricos si queremos ser estrictos, pero el usuario pidió "distinto al último"
      if (current !== lastEmitted && current.trim() !== '') {
        checks++;
      } else {
        checks = 0; // reset si sigue siendo el mismo o está vacío
      }
      await new Promise(res => setTimeout(res, CHECK_MS));
    }

    const finalTitle = document.title;

    // ⬅️ VALIDACIÓN FINAL CRÍTICA:
    // Si después de esperar, el título sigue siendo igual al último emitido... ¡NO HACEMOS NADA!
    // Asumimos que la página sigue cargando y el MutationObserver nos avisará cuando cambie de verdad.
    if (finalTitle === lastEmitted) {
      console.log('[Content] ⏳ Título idéntico al anterior, esperando cambio real...');
      return;
    }

    // ⬅️ Emitimos título nuevo confirmado
    await setLastEmittedTitle(finalTitle);
    report(reason, 'navigate', document.body.innerText.substring(0, 1000));
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

      // ⬅️ Si cambió URL → esperamos título NUEVO
      tryUniversalCommit('title mutado');
    }).observe(titleTarget, { childList: true, subtree: true });
  } else {
    // Fallback simple
    new MutationObserver(() => {
      const t = document.querySelector('title');
      if (t && !isSameUrl()) tryUniversalCommit('title inject');
    }).observe(document.head, { childList: true });
  }

  console.log('[Content] UNIVERSAL SPA-Guard activado');

  /********************************************************************
   *  CAPTURA EN PESTAÑA-IMAGEN (URL termina en .jpg .png .webp)
   ********************************************************************/
  (() => {
    if (!/\.(jpg|jpeg|png|webp|avif)(\?.*)?$/i.test(location.pathname)) return;
    const img = document.querySelector('img');
    if (!img) return;
    if (img.naturalWidth > 0) {
      const data = captureImage(img);
      if (data) {
        chrome.runtime.sendMessage({ type: 'MEDIA_CAPTURED', mediaType: 'image', data, url: location.href, title: document.title });
        console.log('[Content] Imagen pura capturada');
      }
    } else {
      img.onload = () => {
        const data = captureImage(img);
        if (data) {
          chrome.runtime.sendMessage({ type: 'MEDIA_CAPTURED', mediaType: 'image', data, url: location.href, title: document.title });
          console.log('[Content] Imagen pura capturada');
        }
      };
    }
  })();
  /**
   * Espera hasta que el título deje de ser genérico o cambie respecto al anterior.
   * Si no cambia en 1.5 s, emite con lo que haya.
   */
  async function waitForRealTitle(reason: string) {
    const start = Date.now();
    const maxWait = 1500; // 1.5 s máximo
    const initialTitle = document.title;
    const isGeneric = (t: string) => ['youtube', 'home', 'watch', 'video', ''].includes(t.toLowerCase().trim());

    while (Date.now() - start < maxWait) {
      const current = document.title;
      // ⬅️ Salimos si: ① no es genérico ② es distinto al inicial
      if (!isGeneric(current) && current !== initialTitle) {
        break;
      }
      await new Promise(res => setTimeout(res, 100)); // chequeamos cada 100 ms
    }

    // ⬅️ Emitimos **solo** con el título real (o el que haya al timeout)
    report(reason, 'navigate', document.body.innerText.substring(0, 1000));
  }
})();
