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

  // --- REFERENCIAS DE ARQUITECTURA ---
  const liveSessionRef = useRef<any>(null);
  const pendingMessageQueueRef = useRef<QueuedMessage[]>([]);
  const latestTabContextRef = useRef<ContextPayload | null>(null);
  const lastSelectedTextRef = useRef<string | null>(null);
  const lastMediaRef = useRef<any>(null); // Última imagen/video vista
  const portRef = useRef<any>(null); // Puerto persistente al background

  // --- REFERENCIAS DE AUDIO ---
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const audioQueueParamsRef = useRef<{ nextStartTime: number }>({ nextStartTime: 0 });

  // --- VISUAL UI STATE ---
  const [currentDisplayContext, setCurrentDisplayContext] = useState<ContextPayload | null>(null);
  const lastProcessedUrlRef = useRef<string>('');

  // 1. INICIALIZACIÓN
  useEffect(() => {
    if (!audioContextRef.current) {
      // @ts-ignore
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: AUDIO_CONFIG.OUTPUT_SAMPLE_RATE,
      });
    }

    // Conectar puerto persistente al background
    if (typeof chrome !== 'undefined' && chrome.runtime?.connect) {
      portRef.current = chrome.runtime.connect({ name: 'gemini-live' });

      portRef.current.onMessage.addListener((msg: any) => {
        // Recibir contexto via puerto (más eficiente)
        if (msg.type === 'LAST_MEDIA') { lastMediaRef.current = msg.payload; }
        if (msg.type === 'CONTEXT_UPDATED' || msg.type === 'CURRENT_CONTEXT') {
          const newContext = msg.payload as ContextPayload;
          latestTabContextRef.current = newContext;
          setCurrentDisplayContext(newContext);
        }
        // Recibir media inicial o actualizado
        if (msg.type === 'LAST_MEDIA') {
          lastMediaRef.current = msg.payload;
        }
        // El background informa que había una sesión activa
        if (msg.type === 'SESSION_STATUS' && msg.active) {
          console.log('[App] Sesión previa detectada, reconectando...');
        }
        // (Listener VIDEO_FRAME eliminado - ahora es bajo demanda)
      });
    }

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(['GEMINI_API_KEY'], (result: any) => {
        if (result?.GEMINI_API_KEY) {
          dispatch({ type: 'SET_API_KEY', payload: result.GEMINI_API_KEY });
        }
      });
    }

    return () => {
      portRef.current?.disconnect();
      shutdownSystem();
    };
  }, []);

  // 2. SISTEMA DE MENSAJERÍA

  // 3. DETECTOR DE PREGUNTA – tanto imagen como video
  const isMediaQuestion = (text: string) => {
    const imgQ = /\b(imagen|foto|picture|imágen)\b/i.test(text);
    const vidQ = /\b(vídeo|video|clip)\b/i.test(text);
    const ask = /\b(describe|qué te parece|opina|explica|cuéntame)\b/i.test(text);
    return ask && (imgQ || vidQ);
  };

  const askAboutImage = async () => {
    const stored = lastMediaRef.current;
    if (!stored || stored.type !== 'image') {
      sendToGeminiSafe([{ text: 'No tengo ninguna imagen reciente.' }], true, true);
      return;
    }
    const prompt = [
      { text: 'El usuario pregunta por la imagen que está viendo. descríbela con sarcasmo.' },
      { inlineData: { mimeType: 'image/jpeg', data: stored.data.replace(/^data:image\/\w+;base64,/, '') } },
      { text: `Contexto: ${stored.title} (${stored.url})` }
    ];
    sendToGeminiSafe(prompt, true, true);
  };

  const askAboutVideo = async () => {
    const stored = lastMediaRef.current;

    // 1. Si hay imagen reciente (< 120s) → usar URL directa (Gemini Vision)
    if (stored && stored.type === 'image' && (Date.now() - stored.ts < 120_000)) {
      const prompt = [
        { text: 'El usuario pregunta por la imagen que está viendo.' },
        { image: { url: stored.data } }, // <-- URL directa
        { text: `Contexto: ${stored.title}` }
      ];
      sendToGeminiSafe(prompt, true, true);
      return;
    }

    // 2. Si no hay imagen → pedimos frame de video (sin cambios)
    const frame = await chrome.runtime.sendMessage({ type: 'GET_VIDEO_FRAME' });
    if (!frame) {
      sendToGeminiSafe([{ text: 'No veo ninguna imagen ni video ahora mismo.' }], true, true);
      return;
    }
    const prompt = [
      { text: 'El usuario acaba de pedirte que comentes el vídeo que está viendo.' },
      { inlineData: { mimeType: 'image/jpeg', data: frame.frame.replace(/^data:image\/\w+;base64,/, '') } },
      { text: `Título: ${frame.title}` }
    ];
    sendToGeminiSafe(prompt, true, true);
  };

  const sendToGeminiSafe = (parts: any[], turnComplete: boolean = true, skipMediaCheck: boolean = false) => {
    // Intercepción universal
    if (!skipMediaCheck && parts.length > 0 && parts[0].text) {
      const t = parts[0].text;
      if (isMediaQuestion(t)) {
        if (/\b(imagen|foto)\b/i.test(t)) {
          console.log('[App] Pregunta de imagen detectada');
          askAboutImage();
          return;
        }
        if (/\b(vídeo|video|clip)\b/i.test(t)) {
          console.log('[App] Pregunta de video detectada');
          askAboutVideo();
          return;
        }
      }
    }

    const enrichedParts = [...parts];
    if (lastSelectedTextRef.current) {
      enrichedParts.push({
        text: `\n[Nota de visión: El usuario tiene resaltado esto: "${lastSelectedTextRef.current.substring(0, 400)}"]`
      });
    }

    if (liveSessionRef.current) {
      try {
        liveSessionRef.current.sendClientContent({
          turns: [{ role: 'user', parts: enrichedParts }],
          turnComplete: turnComplete
        });
      } catch (err) {
        console.error("❌ Send Error:", err);
      }
    } else {
      pendingMessageQueueRef.current.push({ parts: enrichedParts, turnComplete });
    }
  };

  const triggerSarcasticComment = (context: ContextPayload) => {
    if (!context) return;

    let promptText = "";
    const desc = context.description.toLowerCase();

    if (desc.includes("zombie") || desc.includes("mirando")) {
      promptText = `[INACTIVIDAD] El usuario está paralizado mirando "${context.title}". Búrlate de su falta de vida.`;
    } else if (desc.includes("clic") || desc.includes("presionó")) {
      promptText = `[ACCIÓN] Seleccionó un elemento en "${context.title}". Comenta brevemente sobre ese clic.`;
    } else if (desc.includes("scrolleando") || desc.includes("scroll")) {
      promptText = `[SCROLL] El usuario está bajando la página rápido. Pregúntale qué busca con tanta prisa.`;
    } else if (desc.includes("seleccionó") || context.actionType === 'interaction' && context.pageContent) {
      promptText = `[SELECCIÓN] El usuario acaba de resaltar un texto (ver nota de visión). Júzgalo ácidamente por leer eso.`;
    } else if (context.actionType === 'navigate') {
      promptText = `[NAVEGACIÓN] Entró a: "${context.title}". `;
      if (context.pageContent) promptText += `Contenido visible: "${context.pageContent.substring(0, 500)}". `;
      promptText += "Haz un comentario sarcástico sobre este sitio.";
    } else {
      promptText = `[EVENTO] ${context.description}. Reacciona sarcásticamente.`;
    }

    sendToGeminiSafe([{ text: promptText }], true);
  };

  // 3. SINCRONIZACIÓN DE MENSAJES (REACTIVIDAD TOTAL)
  useEffect(() => {
    const handleRuntimeMessage = (message: any) => {
      if (message.type === MessageType.CONTEXT_UPDATED) {
        const newContext = message.payload as ContextPayload;
        const isConnected = systemState.status === AssistantStatus.IDLE ||
          systemState.status === AssistantStatus.SPEAKING;

        latestTabContextRef.current = newContext;
        setCurrentDisplayContext(newContext);

        if (!isConnected) return;

        const now = Date.now();
        const lastActionTime = (window as any).__lastActionTime || 0;

        // 1. Memoria de selección (siempre disponible)
        if (newContext.description.toLowerCase().includes("seleccionó") && newContext.pageContent) {
          lastSelectedTextRef.current = newContext.pageContent;
        }

        // 2. Lógica de reacción inmediata
        if (newContext.actionType === 'idle') {
          triggerSarcasticComment(newContext); // 👹 reacción personalizada
          return;
        }

        if (newContext.actionType === 'navigate') {
          // ⬅️ Reset selection on new page load
          lastSelectedTextRef.current = null;

          // Evitar eco de la misma página (URL + Título)
          const contextKey = `${newContext.url}|||${newContext.title}`;
          if (contextKey === lastProcessedUrlRef.current) return;
          lastProcessedUrlRef.current = contextKey;
          triggerSarcasticComment(newContext);
        } else {
          // Cooldowns suaves para interacciones (Vitalidad)
          const isSelection = newContext.description.toLowerCase().includes("seleccionó");
          const cooldown = isSelection ? 2000 : 6000;

          if (now - lastActionTime < cooldown) return;
          (window as any).__lastActionTime = now;
          triggerSarcasticComment(newContext);
        }
      }
    };

    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    }
    return () => chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
  }, [systemState.status]);

  // 4. MOTOR DE AUDIO
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
    if (audioQueueParamsRef.current.nextStartTime < currentTime) {
      audioQueueParamsRef.current.nextStartTime = currentTime;
    }
    sourceNode.start(audioQueueParamsRef.current.nextStartTime);
    audioQueueParamsRef.current.nextStartTime += buffer.duration;
    dispatch({ type: 'UPDATE_STATUS', payload: AssistantStatus.SPEAKING });
    // Notificar al background que el asistente está hablando
    portRef.current?.postMessage({ type: 'ASSISTANT_SPEAKING' });
    sourceNode.onended = () => {
      if (context.currentTime >= audioQueueParamsRef.current.nextStartTime - 0.1) {
        dispatch({ type: 'UPDATE_STATUS', payload: AssistantStatus.IDLE });
        // Notificar al background que el asistente terminó
        portRef.current?.postMessage({ type: 'ASSISTANT_IDLE' });
      }
    };
  };

  const initializeAudioInput = async (sessionInstance: any) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: AUDIO_CONFIG.INPUT_SAMPLE_RATE, echoCancellation: true, noiseSuppression: true }
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
        if (!sessionInstance) return;
        const inputData = event.inputBuffer.getChannelData(0);
        sessionInstance.sendRealtimeInput({
          media: { mimeType: 'audio/pcm;rate=16000', data: encodeFloat32ToBase64(inputData) }
        });
      };
      source.connect(processor);
      processor.connect(inputContextRef.current.destination);
    } catch (error) { console.error(error); }
  };

  const shutdownSystem = () => {
    if (mediaStreamRef.current) mediaStreamRef.current.getTracks().forEach(t => t.stop());
    if (inputContextRef.current) inputContextRef.current.close();
    liveSessionRef.current = null;
    pendingMessageQueueRef.current = [];
    dispatch({ type: 'UPDATE_STATUS', payload: AssistantStatus.DISCONNECTED });
  };

  const connectToGemini = async () => {
    if (!systemState.apiKey) return;
    dispatch({ type: 'UPDATE_STATUS', payload: AssistantStatus.CONNECTING });
    try {
      const genAI = new GoogleGenAI({ apiKey: systemState.apiKey });
      const session = await genAI.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: { parts: [{ text: "Eres Glitch, un IA sarcástica. Reacciona al instante a lo que el usuario hace. Sé muy breve y muy ácido." }] },
        },
        callbacks: {
          onopen: () => {
            // Informar al background que la sesión está activa
            portRef.current?.postMessage({ type: 'GEMINI_SESSION_STARTED' });
            while (pendingMessageQueueRef.current.length > 0) {
              const msg = pendingMessageQueueRef.current.shift();
              if (msg) session.sendClientContent({ turns: [{ role: 'user', parts: msg.parts }], turnComplete: msg.turnComplete });
            }
          },
          onmessage: (msg: LiveServerMessage) => {
            const audioData = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData) processAudioChunk(audioData);
            if (msg.serverContent?.turnComplete) dispatch({ type: 'UPDATE_STATUS', payload: AssistantStatus.IDLE });
          },
          onclose: () => {
            portRef.current?.postMessage({ type: 'GEMINI_SESSION_ENDED' });
            shutdownSystem();
          },
          onerror: () => dispatch({ type: 'REPORT_ERROR', payload: "Socket Error" })
        }
      });
      liveSessionRef.current = session;
      await initializeAudioInput(session);
      dispatch({ type: 'UPDATE_STATUS', payload: AssistantStatus.IDLE });
      // ⬅️ Usar el contexto más reciente (el que acaba de llegar)
      if (latestTabContextRef.current) triggerSarcasticComment(latestTabContextRef.current);
    } catch (e) { shutdownSystem(); }
  };

  // --- RENDERIZADO UI (MATCHING style.css) ---
  if (!systemState.hasKey) {
    return (
      <div className="main-container setup-mode">
        <div className="mascot-large">🔑</div>
        <h2>ACCESO REQUERIDO</h2>
        <div className="input-group">
          <input
            type="password"
            placeholder="Pegar API Key"
            onBlur={(e) => {
              chrome.storage.local.set({ GEMINI_API_KEY: e.target.value });
              dispatch({ type: 'SET_API_KEY', payload: e.target.value });
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="main-container voice-mode">
      <div className="header-actions">
        <div style={{ fontSize: '0.7rem', color: '#6366f1', textAlign: 'right', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '150px' }}>
          {currentDisplayContext?.title || 'Esperando visión...'}
        </div>
      </div>

      <div className="mascot-display">
        <div className={`mascot-large ${systemState.status === AssistantStatus.SPEAKING ? 'animate-pulse' : ''}`}>
          {systemState.status === AssistantStatus.SPEAKING ? '🤬' :
            systemState.status === AssistantStatus.CONNECTING ? '🔌' :
              systemState.status === AssistantStatus.IDLE ? '👀' : '💤'}
        </div>
        <p className="status-text">{systemState.status}</p>
        <div className={`voice-visualizer ${systemState.status === AssistantStatus.SPEAKING ? 'active' : ''}`}>
          <div className={`bar ${systemState.status === AssistantStatus.SPEAKING ? 'speaking' : ''}`}></div>
          <div className={`bar ${systemState.status === AssistantStatus.SPEAKING ? 'speaking' : ''}`}></div>
          <div className={`bar ${systemState.status === AssistantStatus.SPEAKING ? 'speaking' : ''}`}></div>
        </div>
      </div>

      <div className="controls">
        {systemState.status === AssistantStatus.DISCONNECTED ? (
          <button className="primary-btn" onClick={connectToGemini}>CONECTAR</button>
        ) : (
          <button className="secondary-btn" onClick={shutdownSystem}>PARAR</button>
        )}
      </div>
    </div>
  );
};

export default App;
