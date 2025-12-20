import React, { useEffect, useRef, useReducer, useState } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { AssistantStatus, StateMachineState, MessageType, ContextPayload, QueuedMessage } from './types';

declare const chrome: any;

// --- CONFIGURACIÓN DE AUDIO ---
const AUDIO_CONFIG = {
  OUTPUT_SAMPLE_RATE: 24000,
  INPUT_SAMPLE_RATE: 16000,
  BUFFER_SIZE: 4096
};

// --- STATE MANAGEMENT ---
const initialState: StateMachineState = {
  status: AssistantStatus.DISCONNECTED,
  apiKey: '',
  hasKey: false,
  audioReady: false,
  error: null
};

function systemReducer(state: StateMachineState, action: any): StateMachineState {
  switch (action.type) {
    case 'SET_API_KEY': return { ...state, apiKey: action.payload, hasKey: true };
    case 'UPDATE_STATUS': return { ...state, status: action.payload, error: null };
    case 'REPORT_ERROR': return { ...state, status: AssistantStatus.ERROR, error: action.payload };
    case 'RESET_SYSTEM': return initialState;
    default: return state;
  }
}

// --- AUDIO UTILITIES ---
function decodeBase64ToFloat32(base64String: string): Float32Array {
  const binaryString = atob(base64String);
  const length = binaryString.length;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = binaryString.charCodeAt(i);
  const int16Array = new Int16Array(bytes.buffer);
  const float32Array = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) float32Array[i] = int16Array[i] / 32768.0;
  return float32Array;
}

function encodeFloat32ToBase64(float32Array: Float32Array): string {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
  }
  const bytes = new Uint8Array(int16Array.buffer);
  let binary = '';
  const length = bytes.byteLength;
  for (let i = 0; i < length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

const App: React.FC = () => {
  const [systemState, dispatch] = useReducer(systemReducer, initialState);

  // --- REFERENCIAS DE ARQUITECTURA (NO PRIMITIVOS) ---
  const liveSessionRef = useRef<any>(null);
  const pendingMessageQueueRef = useRef<QueuedMessage[]>([]); // Cola de mensajes tipada
  const latestTabContextRef = useRef<ContextPayload | null>(null);

  // --- REFERENCIAS DE AUDIO ---
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const audioQueueParamsRef = useRef<{ nextStartTime: number }>({ nextStartTime: 0 });

  // --- VISUAL UI STATE ---
  const [currentDisplayContext, setCurrentDisplayContext] = useState<ContextPayload | null>(null);

  // 1. INICIALIZACIÓN DEL ENTORNO
  useEffect(() => {
    // Inicializar AudioContext de salida (Lazy init para cumplir políticas de navegador)
    if (!audioContextRef.current) {
      // @ts-ignore
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: AUDIO_CONFIG.OUTPUT_SAMPLE_RATE,
      });
    }

    // Cargar API Key
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(['GEMINI_API_KEY'], (result: any) => {
        if (result?.GEMINI_API_KEY) {
          dispatch({ type: 'SET_API_KEY', payload: result.GEMINI_API_KEY });
        }
      });
    }

    return () => shutdownSystem();
  }, []);

  // 2. SISTEMA DE MENSAJERÍA ROBUSTO (QUEUE PATTERN)
  const sendToGeminiSafe = (parts: any[], turnComplete: boolean = true) => {
    if (liveSessionRef.current) {
      try {
        liveSessionRef.current.sendClientContent({
          turns: [{ role: 'user', parts: parts }],
          turnComplete: turnComplete
        });
        console.log("✅ [Direct Send]", parts);
      } catch (err) {
        console.error("❌ Send Error:", err);
      }
    } else {
      console.warn("⚠️ [Queueing] Socket not ready. Pushing to queue.");
      pendingMessageQueueRef.current.push({ parts, turnComplete });
    }
  };

  const triggerSarcasticComment = (context: ContextPayload) => {
    if (!context) return;

    // Construir prompt con contenido si disponible
    let promptText = `[SYSTEM EVENT] Acción del usuario: ${context.description} (en ${context.title}).`;

    if (context.pageContent && (context.description.includes("entró") || context.actionType === 'navigate')) {
      // Si es una navegación nueva, damos contexto del contenido
      promptText += `\nContenido visible de la página: "${context.pageContent.substring(0, 500)}..."`;
      promptText += `\nUsa esto para comentar sobre lo que el usuario está viendo, si es relevante.`;
    } else {
      promptText += `\nResponde brevemente a esta acción con tu personalidad.`;
    }

    const textPart = { text: promptText };
    sendToGeminiSafe([textPart], true);
  };

  // 3. SINCRONIZACIÓN DE VISIÓN (CONTEXTO)
  // Refs para evitar saludos duplicados y manejar debounce
  const lastProcessedContextRef = useRef<{ url: string; title: string } | null>(null);
  const navigationDebounceTimerRef = useRef<any>(null);
  const pendingContextRef = useRef<ContextPayload | null>(null);
  const lastUrlChangeTimeRef = useRef<number>(0);

  // Tiempo de estabilización para navegación (ms) - Aumentado para SPAs
  const NAVIGATION_SETTLE_TIME = 800;

  // Títulos genéricos que indican que la página aún no ha cargado el contenido real
  const GENERIC_TITLES = [
    'youtube', 'spotify', 'netflix', 'twitch', 'twitter', 'x',
    'facebook', 'instagram', 'tiktok', 'reddit', 'amazon'
  ];

  // Función para normalizar títulos (ignorar números de notificación como "(4)")
  const normalizeTitle = (title: string): string => {
    return title.replace(/^\(\d+\+?\)\s*/, '').trim();
  };

  // Función para detectar si un título es genérico (solo el nombre del sitio)
  const isGenericTitle = (title: string): boolean => {
    const normalized = normalizeTitle(title).toLowerCase();
    // Si el título es SOLO el nombre del sitio (o muy similar), es genérico
    return GENERIC_TITLES.some(site => {
      // El título es genérico si es exactamente el nombre del sitio
      // o si es el nombre del sitio + algo muy corto (ej: "YouTube" o "YouTube -")
      return normalized === site ||
        normalized === `${site} -` ||
        normalized.length <= site.length + 3 && normalized.startsWith(site);
    });
  };

  useEffect(() => {
    const handleRuntimeMessage = (message: any) => {
      if (message.type === MessageType.CONTEXT_UPDATED) {
        const newContext = message.payload as ContextPayload;

        // =========== SOLO PROCESAR SI ESTAMOS CONECTADOS ===========
        const isConnected = systemState.status === AssistantStatus.IDLE ||
          systemState.status === AssistantStatus.SPEAKING;

        // Siempre actualizar el display visual (aunque no estemos conectados)
        latestTabContextRef.current = newContext;
        setCurrentDisplayContext(newContext);

        // Si no estamos conectados, no hacer nada más
        if (!isConnected) {
          return;
        }

        // =========== VALIDACIÓN DE NO-REPETICIÓN ===========
        const lastProcessed = lastProcessedContextRef.current;
        const normalizedNewTitle = normalizeTitle(newContext.title);
        const normalizedLastTitle = lastProcessed ? normalizeTitle(lastProcessed.title) : '';

        const isUrlSame = lastProcessed?.url === newContext.url;
        const isTitleSame = normalizedLastTitle === normalizedNewTitle;

        // Si URL y Título son iguales, ignorar completamente
        if (isUrlSame && isTitleSame) {
          return;
        }

        // Determinar tipo de cambio
        const isNavigation = newContext.actionType === 'navigate' || !isUrlSame || !isTitleSame;
        const isUserAction = newContext.actionType === 'interaction' ||
          newContext.actionType === 'input' ||
          newContext.actionType === 'media';

        // =========== LÓGICA DE NAVEGACIÓN INTELIGENTE ===========
        if (isNavigation) {
          const now = Date.now();

          // Si la URL cambió, registrar el momento
          if (!isUrlSame) {
            lastUrlChangeTimeRef.current = now;
          }

          // Cancelar cualquier timer pendiente
          if (navigationDebounceTimerRef.current) {
            clearTimeout(navigationDebounceTimerRef.current);
          }

          // Guardar el contexto más reciente
          pendingContextRef.current = newContext;

          // Si el título es genérico, esperar más tiempo (el contenido aún no cargó)
          const titleIsGeneric = isGenericTitle(newContext.title);

          if (titleIsGeneric) {
            console.log("[App] Generic title detected, waiting for real content...");
            // NO iniciar timer - esperar a que llegue un título real
            return;
          }

          console.log("[App] Navigation settling:", normalizedNewTitle.substring(0, 40) + "...");

          // Esperar para asegurar que no hay más cambios
          navigationDebounceTimerRef.current = setTimeout(() => {
            const stableContext = pendingContextRef.current;
            if (!stableContext) return;

            // Verificar que el contexto no cambió durante la espera
            const lastProc = lastProcessedContextRef.current;
            const stableNormalized = normalizeTitle(stableContext.title);
            const lastNormalized = lastProc ? normalizeTitle(lastProc.title) : '';

            // Si ya procesamos esta URL con este título, salir
            if (lastProc?.url === stableContext.url && lastNormalized === stableNormalized) {
              return;
            }

            // Marcar como procesado
            lastProcessedContextRef.current = {
              url: stableContext.url,
              title: stableContext.title
            };

            console.log("👁️ Navigation:", stableNormalized.substring(0, 50));
            triggerSarcasticComment(stableContext);
            pendingContextRef.current = null;
          }, NAVIGATION_SETTLE_TIME);

          return;
        }

        // =========== ACCIONES DE USUARIO (Sin debounce) ===========
        if (isUserAction) {
          lastProcessedContextRef.current = {
            url: newContext.url,
            title: newContext.title
          };

          console.log("👁️ Action:", newContext.description);
          triggerSarcasticComment(newContext);
        }
      }
    };

    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    }
    return () => {
      if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
      }
      if (navigationDebounceTimerRef.current) {
        clearTimeout(navigationDebounceTimerRef.current);
      }
    };
  }, [systemState.status]);

  // 4. MOTOR DE AUDIO (PLAYBACK)
  const processAudioChunk = (base64Data: string) => {
    const context = audioContextRef.current;
    if (!context) return;

    const float32Data = decodeBase64ToFloat32(base64Data);
    const buffer = context.createBuffer(1, float32Data.length, AUDIO_CONFIG.OUTPUT_SAMPLE_RATE);
    buffer.getChannelData(0).set(float32Data);

    const sourceNode = context.createBufferSource();
    sourceNode.buffer = buffer;
    sourceNode.connect(context.destination);

    const currentTime = context.currentTime;
    // Lógica para evitar solapamiento (Gapless playback)
    if (audioQueueParamsRef.current.nextStartTime < currentTime) {
      audioQueueParamsRef.current.nextStartTime = currentTime;
    }

    sourceNode.start(audioQueueParamsRef.current.nextStartTime);
    audioQueueParamsRef.current.nextStartTime += buffer.duration;

    dispatch({ type: 'UPDATE_STATUS', payload: AssistantStatus.SPEAKING });

    sourceNode.onended = () => {
      // Histerésis pequeña para evitar parpadeo de estado
      if (context.currentTime >= audioQueueParamsRef.current.nextStartTime - 0.1) {
        dispatch({ type: 'UPDATE_STATUS', payload: AssistantStatus.IDLE });
      }
    };
  };

  // 5. CAPTURA DE AUDIO (INPUT)
  const initializeAudioInput = async (sessionInstance: any) => {
    try {
      if (mediaStreamRef.current) return; // Ya iniciado

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: AUDIO_CONFIG.INPUT_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      mediaStreamRef.current = stream;

      // @ts-ignore
      inputContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: AUDIO_CONFIG.INPUT_SAMPLE_RATE
      });

      const source = inputContextRef.current.createMediaStreamSource(stream);
      const processor = inputContextRef.current.createScriptProcessor(AUDIO_CONFIG.BUFFER_SIZE, 1, 1);
      scriptProcessorRef.current = processor;

      processor.onaudioprocess = (event) => {
        // SEGURIDAD: Verificar que la sesión aún es válida antes de procesar
        if (!sessionInstance) return;

        const inputData = event.inputBuffer.getChannelData(0);
        const base64Encoded = encodeFloat32ToBase64(inputData);

        try {
          sessionInstance.sendRealtimeInput({
            media: { mimeType: 'audio/pcm;rate=16000', data: base64Encoded }
          });
        } catch (error) {
          // Si falla el envío (socket cerrado), no crasheamos la app
        }
      };

      source.connect(processor);
      processor.connect(inputContextRef.current.destination);
      console.log("🎤 Micrófono activado y vinculado al stream.");

    } catch (error) {
      console.error("Critical: Microphone access denied or failed.", error);
      dispatch({ type: 'REPORT_ERROR', payload: "Sin acceso al Micrófono" });
    }
  };

  const shutdownSystem = () => {
    // 1. Limpiar Audio Input
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if (inputContextRef.current) {
      inputContextRef.current.close();
      inputContextRef.current = null;
    }

    // 2. Limpiar Sesión
    liveSessionRef.current = null;
    pendingMessageQueueRef.current = [];
  };

  // 6. LÓGICA DE CONEXIÓN PRINCIPAL
  const connectToGemini = async () => {
    if (!systemState.apiKey) return;
    dispatch({ type: 'UPDATE_STATUS', payload: AssistantStatus.CONNECTING });

    try {
      // 1. Reanudar Audio Context (Requiere interacción previa del usuario)
      if (audioContextRef.current?.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      // 2. Obtener Contexto Inicial del Background
      const initialContext: ContextPayload = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: MessageType.GET_LAST_CONTEXT }, (response: any) => {
          resolve(response || { title: 'Desconocido', url: 'about:blank', description: "Inicio", timestamp: 0 });
        });
      });

      latestTabContextRef.current = initialContext;
      setCurrentDisplayContext(initialContext);

      // 3. Iniciar Cliente GenAI
      const genAIClient = new GoogleGenAI({ apiKey: systemState.apiKey });

      // 4. Establecer Conexión (Promise)
      const session = await genAIClient.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: { parts: [{ text: `Eres Glitch, un asistente sarcástico y cínico. Tu único propósito es juzgar las páginas web que visita el usuario. Sé breve y mordaz.` }] },
        },
        callbacks: {
          onopen: () => {
            console.log("🌐 Conexión Establecida.");

            // FLUSH QUEUE: Enviar mensajes pendientes
            while (pendingMessageQueueRef.current.length > 0) {
              const msg = pendingMessageQueueRef.current.shift();
              if (msg) {
                // @ts-ignore
                session.sendClientContent({
                  turns: [{ role: 'user', parts: msg.parts }],
                  turnComplete: msg.turnComplete
                });
              }
            }
          },
          onmessage: (serverMessage: LiveServerMessage) => {
            // Procesar Audio
            const audioData = serverMessage.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData) processAudioChunk(audioData);

            // Actualizar Estado
            if (serverMessage.serverContent?.turnComplete) {
              dispatch({ type: 'UPDATE_STATUS', payload: AssistantStatus.IDLE });
            }
          },
          onclose: () => {
            console.warn("🔌 Conexión cerrada.");
            handleDisconnect();
          },
          onerror: (err) => {
            console.error("🔥 Error WebSocket:", err);
            dispatch({ type: 'REPORT_ERROR', payload: "Error de Conexión" });
          }
        }
      });

      // 5. Asignar Referencia GLOBALMENTE
      liveSessionRef.current = session;

      // 6. Iniciar Audio Input (SOLO AHORA ES SEGURO)
      await initializeAudioInput(session);

      dispatch({ type: 'UPDATE_STATUS', payload: AssistantStatus.IDLE });

      // 7. Prompt Inicial
      triggerSarcasticComment(initialContext);

    } catch (error: any) {
      console.error("Connection Handshake Failed:", error);
      dispatch({ type: 'REPORT_ERROR', payload: "Fallo al conectar con Gemini" });
      handleDisconnect();
    }
  };

  const handleDisconnect = () => {
    shutdownSystem();
    dispatch({ type: 'UPDATE_STATUS', payload: AssistantStatus.DISCONNECTED });
  };

  const saveApiKey = (key: string) => {
    chrome.storage.local.set({ GEMINI_API_KEY: key });
    dispatch({ type: 'SET_API_KEY', payload: key });
  };

  // --- RENDERIZADO UI ---
  if (!systemState.hasKey) {
    return (
      <div className="main-container setup-mode">
        <div className="mascot-large">🔑</div>
        <h2>ACCESO REQUERIDO</h2>
        <div className="input-group">
          <input
            type="password"
            placeholder="Pegar API Key"
            onBlur={(e) => saveApiKey(e.target.value)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="main-container voice-mode">
      <div className="header-actions">
        <div style={{ fontSize: '0.7rem', color: '#6366f1', textAlign: 'right', maxWidth: '200px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {currentDisplayContext ? `👁 ${currentDisplayContext.title}` : '👁 Esperando visión...'}
        </div>
      </div>

      <div className="mascot-display">
        <div className={`mascot-large ${systemState.status === AssistantStatus.SPEAKING ? 'animate-pulse' : ''}`}>
          {systemState.status === AssistantStatus.SPEAKING ? '🤬' :
            systemState.status === AssistantStatus.CONNECTING ? '🔌' :
              systemState.status === AssistantStatus.ERROR ? '💀' :
                systemState.status === AssistantStatus.IDLE ? '👀' : '💤'}
        </div>

        <p className="status-text">{systemState.error ? systemState.error : systemState.status}</p>

        <div className={`voice-visualizer ${systemState.status === AssistantStatus.SPEAKING ? 'active' : ''}`}>
          <div className={`bar ${systemState.status === AssistantStatus.SPEAKING ? 'speaking' : ''}`}></div>
          <div className={`bar ${systemState.status === AssistantStatus.SPEAKING ? 'speaking' : ''}`}></div>
          <div className={`bar ${systemState.status === AssistantStatus.SPEAKING ? 'speaking' : ''}`}></div>
        </div>
      </div>

      <div className="controls">
        {systemState.status === AssistantStatus.DISCONNECTED || systemState.status === AssistantStatus.ERROR ? (
          <button className="primary-btn" onClick={connectToGemini}>
            CONECTAR SISTEMA
          </button>
        ) : (
          <button className="secondary-btn" onClick={handleDisconnect}>
            DESCONECTAR
          </button>
        )}
      </div>
    </div>
  );
};

export default App;