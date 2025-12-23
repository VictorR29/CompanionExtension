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

  // ⬅️ Cargar desde sesión (si existe)
  chrome.storage.session.get(['guardUrl', 'guardTitle', 'emittedKey']).then(r => {
    lastGuardUrl = r.guardUrl || location.href;
    lastGuardTitle = r.guardTitle || document.title;
    lastEmittedKey = r.emittedKey || '';
  });

  // --- helpers ---
  const getContextKey = (url: string, title: string) => `${url}::${title}`;
  const isSameUrl = () => location.href === lastGuardUrl;

  let guardTimer: any;
  const GUARD_DELAY = 700; // ms

  function tryUniversalCommit(reason: string) {
    // ⬅️ Permitimos re-lanzar si el título cambió (aunque URL sea igual)
    if (document.title !== lastGuardTitle) {
      lastGuardTitle = document.title;
      lastEmittedKey = ''; // reseteamos para permitir nueva emisión
    }

    // ⬅️ RESET ANTES de emitir (evita URL anterior)
    const cleanUrl = location.href.replace(/#.*$/, '');
    if (cleanUrl !== lastGuardUrl.replace(/#.*$/, '')) {
      lastGuardUrl = location.href;
      lastGuardTitle = document.title;
      lastEmittedKey = '';
      // ⬅️ Persistimos en sesión para que no se pierda si SW duerme
      chrome.storage.session.set({ guardUrl: lastGuardUrl, guardTitle: lastGuardTitle, emittedKey: lastEmittedKey });
    }

    // 1. ¿URL cambió?
    if (cleanUrl === lastGuardUrl.replace(/#.*$/, '')) return;

    console.log('[Content] 🔄 Navegación detectada, esperando estabilidad DOM...', reason);

    // 2. RESET inmediato de URL (para prevenir múltiples triggers)
    lastGuardUrl = location.href;

    // 3. Cancelar cualquier check previo
    if (guardTimer) clearInterval(guardTimer);

    // 4. Sistema de ESTABILIDAD: el título debe mantenerse igual por 3 checks consecutivos
    let lastSeenTitle = document.title;
    let stableCount = 0;
    const REQUIRED_STABLE_CHECKS = 3; // título debe ser igual 3 veces seguidas
    const CHECK_INTERVAL = 100; // ms entre checks (más rápido)

    // Timeout diferenciado: videos normales necesitan más tiempo
    const isVideoPage = location.pathname === '/watch';
    const MAX_TIME = (reason === 'title mutado') ? 400 : (isVideoPage ? 2000 : 800); // ⬅️ 400 ms si cambió título
    const startTime = Date.now();

    guardTimer = setInterval(() => {
      const currentTitle = document.title;
      const elapsed = Date.now() - startTime;

      // ¿Es un título genérico/placeholder? (lista expandida para videos)
      const titleLower = currentTitle.toLowerCase().trim();
      const isGeneric =
        titleLower === '' ||
        titleLower === 'youtube' ||
        titleLower === 'home' ||
        titleLower === 'watch' ||
        titleLower === 'video' ||
        titleLower.startsWith('youtube - ') ||
        titleLower.endsWith(' - youtube') && currentTitle.split(' - ')[0].length < 5 ||
        currentTitle === lastSeenTitle && stableCount === 0;

      // Validación CRÍTICA: verificar que el h1 coincida con el título (para videos)
      const isVideoPage = location.pathname === '/watch';
      let titleMatchesContent = true;

      if (isVideoPage && !isGeneric) {
        const h1Element = document.querySelector('h1.ytd-watch-metadata, h1.title, ytd-watch-metadata h1');
        const h1Text = h1Element?.textContent?.trim() || '';
        const titleWithoutSuffix = currentTitle.replace(' - YouTube', '').trim();

        if (h1Text.length > 3) {
          titleMatchesContent = h1Text.includes(titleWithoutSuffix) || titleWithoutSuffix.includes(h1Text);

          if (!titleMatchesContent) {
            console.log(`[Content] ⚠️ Título desincronizado con h1: "${currentTitle}" vs "${h1Text}"`);
            // Resetear contador - el DOM no está listo
            stableCount = 0;
            lastSeenTitle = currentTitle;
            return; // No continuar hasta que coincidan
          }
        }
      }

      if (currentTitle === lastSeenTitle && !isGeneric && titleMatchesContent) {
        // El título se mantuvo igual → aumentar contador de estabilidad
        stableCount++;
        console.log(`[Content] 📊 Título estable: "${currentTitle}" (${stableCount}/${REQUIRED_STABLE_CHECKS})`);

        if (stableCount >= REQUIRED_STABLE_CHECKS) {
          // ✅ TÍTULO ESTABLE → emitir
          clearInterval(guardTimer);

          // DUPLICADO: comprobamos clave completa (url + título)
          const contextKey = getContextKey(location.href, currentTitle);
          if (contextKey === lastEmittedKey) {
            console.log('[Content] ⚠️ Contexto duplicado, no emitimos:', currentTitle);
            return;
          }
          lastEmittedKey = contextKey;
          lastGuardTitle = currentTitle;

          // ⬅️ Persistimos en sesión para que no se pierda si SW duerme
          chrome.storage.session.set({ guardUrl: lastGuardUrl, guardTitle: lastGuardTitle, emittedKey: lastEmittedKey });

          console.log('[Content] ✓ Navegación confirmada (DOM estable):', currentTitle);
          report(reason, 'navigate', document.body.innerText.substring(0, 1000));
        }
      } else {
        // El título cambió → resetear contador
        if (currentTitle !== lastSeenTitle) {
          console.log(`[Content] 🔄 Título cambió: "${lastSeenTitle}" → "${currentTitle}"`);
        }
        lastSeenTitle = currentTitle;
        stableCount = 0;
      }

      // Timeout de seguridad: si pasan 800ms, emitir de todas formas
      if (elapsed >= MAX_TIME) {
        clearInterval(guardTimer);
        const finalTitle = document.title;

        // Validación final ESTRICTA: verificar que el título coincida con h1 (para videos)
        if (isVideoPage) {
          const h1Element = document.querySelector('h1.ytd-watch-metadata, h1.title, ytd-watch-metadata h1');
          const h1Text = h1Element?.textContent?.trim() || '';
          const titleWithoutSuffix = finalTitle.replace(' - YouTube', '').trim();
          const titleMatchesH1 = h1Text.includes(titleWithoutSuffix) || titleWithoutSuffix.includes(h1Text);

          if (!titleMatchesH1 && h1Text.length > 3) {
            console.log('[Content] ⚠️ Timeout alcanzado pero título NO coincide con h1:', finalTitle, 'vs', h1Text);
            console.log('[Content] ❌ NO emitiendo - DOM aún desincronizado');
            return; // NO emitir - el título está desincronizado
          }
        }

        const contextKey = getContextKey(location.href, finalTitle);
        if (contextKey === lastEmittedKey) {
          console.log('[Content] ⚠️ Contexto duplicado (timeout), no emitimos:', finalTitle);
          return;
        }
        lastEmittedKey = contextKey;
        lastGuardTitle = finalTitle;

        // ⬅️ Persistimos en sesión para que no se pierda si SW duerme
        chrome.storage.session.set({ guardUrl: lastGuardUrl, guardTitle: lastGuardTitle, emittedKey: lastEmittedKey });

        console.log('[Content] ⏱️ Timeout alcanzado, emitiendo con:', finalTitle);
        report(reason, 'navigate', document.body.innerText.substring(0, 1000));
      }
    }, CHECK_INTERVAL);
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
      // ⬅️ Forzamos estabilidad aunque la URL no haya cambiado
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
})();
