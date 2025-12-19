
import React, { useEffect, useRef, useReducer } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { AssistantStatus, AssistantAction, StateMachineState, MessageType, ContextPayload } from './types';

declare const chrome: any;

// --- CONSTANTES ---
const AUDIO_CTX_SAMPLE_RATE = 24000;
const INPUT_SAMPLE_RATE = 16000;

// FIX: Aumentado threshold para evitar ruido fantasma y loops
const VAD_THRESHOLD = 0.05; 
const VAD_DEBOUNCE_MS = 500; // Nuevo: Tiempo mínimo entre detecciones

// COOLDOWN: 3 segundos para reactividad alta
const AI_COOLDOWN_MS = 3000; 

// --- UI HELPERS ---
const STATUS_EMOJIS: Record<AssistantStatus, string> = {
  [AssistantStatus.DISCONNECTED]: '💤',
  [AssistantStatus.CONNECTING]: '🔌',
  [AssistantStatus.IDLE]: '👀',
  [AssistantStatus.LISTENING]: '👂',
  [AssistantStatus.THINKING]: '⚡',
  [AssistantStatus.SPEAKING]: '🗣️',
  [AssistantStatus.ERROR]: '🔥',
};

const STATUS_TEXTS: Record<AssistantStatus, string> = {
  [AssistantStatus.DISCONNECTED]: 'Modo Suspensión',
  [AssistantStatus.CONNECTING]: 'Conectando...',
  [AssistantStatus.IDLE]: 'Observando...',
  [AssistantStatus.LISTENING]: 'Escuchando...',
  [AssistantStatus.THINKING]: 'Juzgando...',
  [AssistantStatus.SPEAKING]: 'Opinando...',
  [AssistantStatus.ERROR]: 'Error',
};

// --- REDUCER (UI) ---
const initialState: StateMachineState = {
  status: AssistantStatus.DISCONNECTED,
  apiKey: '',
  hasKey: false,
  error: null,
  volume: 0
};

function uiReducer(state: StateMachineState, action: AssistantAction): StateMachineState {
  switch (action.type) {
    case 'SET_KEY': return { ...state, apiKey: action.payload, hasKey: true };
    case 'RESET_KEY': return { ...state, apiKey: '', hasKey: false, status: AssistantStatus.DISCONNECTED };
    case 'START_CONNECTING': return { ...state, status: AssistantStatus.CONNECTING, error: null };
    case 'CONNECTION_ESTABLISHED': return { ...state, status: AssistantStatus.IDLE };
    case 'DETECT_SPEECH': return { ...state, status: AssistantStatus.LISTENING };
    case 'SPEECH_STOPPED': return { ...state, status: AssistantStatus.THINKING };
    case 'MODEL_AUDIO_START': return { ...state, status: AssistantStatus.SPEAKING };
    case 'MODEL_AUDIO_END': 
      return (state.status !== AssistantStatus.ERROR && state.status !== AssistantStatus.DISCONNECTED) 
        ? { ...state, status: AssistantStatus.IDLE } : state;
    case 'ERROR': return { ...state, status: AssistantStatus.ERROR, error: action.payload };
    case 'DISCONNECT': return { ...state, status: AssistantStatus.DISCONNECTED };
    default: return state;
  }
}

const App: React.FC = () => {
  const [uiState, dispatch] = useReducer(uiReducer, initialState);
  
  // --- REFS ---
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const scheduledSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const currentSessionIdRef = useRef<string | null>(null);
  const lastAiSpeechTimeRef = useRef<number>(0);
  
  // Anti-loop refs
  const lastVadTriggerRef = useRef<number>(0);

  // --- API KEY ---
  useEffect(() => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['GEMINI_API_KEY'], (result: any) => {
        if (result && result.GEMINI_API_KEY) dispatch({ type: 'SET_KEY', payload: result.GEMINI_API_KEY });
      });
    }
  }, []);

  // --- CONTEXT LISTENER (PROACTIVE TRIGGER) ---
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime) return;

    const handleMessage = (message: any) => {
      // console.log("UI: Mensaje recibido", message); // Descomentar para debug intenso
      
      if (message.type !== MessageType.CONTEXT_UPDATE) return;
      
      // Si no tenemos sesión, no hacemos nada (pero el mensaje llegó)
      if (!currentSessionIdRef.current || !sessionPromiseRef.current) {
        return;
      }

      if (uiState.status === AssistantStatus.ERROR || uiState.status === AssistantStatus.DISCONNECTED) return;
      
      // 1. NO INTERRUMPIR: Si hay audio activo, ignorar actualizaciones
      if (uiState.status === AssistantStatus.SPEAKING || uiState.status === AssistantStatus.LISTENING) {
          return;
      }

      const payload = message.payload as ContextPayload;
      
      // FIX: Validación de payload nulo o vacío
      if (!payload || !payload.url || payload.event === 'NO_CONTEXT') {
        console.log("UI: Contexto recibido es null o inválido, ignorando.");
        return;
      }

      const now = Date.now();

      // 2. COOLDOWN
      if (now - lastAiSpeechTimeRef.current < AI_COOLDOWN_MS) {
          console.log("UI: Cooldown activo, ignorando evento");
          return;
      }

      console.log("UI: Procesando contexto para Gemini...", payload);

      sessionPromiseRef.current.then(async (session) => {
        if (currentSessionIdRef.current) {
          
          // --- ESTRATEGIA: TRIGGER DE SISTEMA AUTÓNOMO ---
          
          const contextMsg = `[SYSTEM: EVENTO DETECTADO.
          TIPO: ${payload.event}
          URL: ${payload.url}
          TÍTULO: "${payload.title}"
          ${payload.selection ? `SELECCIÓN: "${payload.selection}"` : ''}
          INSTRUCCIÓN: Reacciona ahora con audio sarcástico sobre esto.]`;

          // A. Enviamos el contexto
          try {
            await session.sendRealtimeInput({
              content: [{ text: contextMsg }]
            });

            // B. TRIGGER EXPLICITO: Forzamos el cierre de turno inmediatamente.
            setTimeout(() => {
               if (currentSessionIdRef.current) {
                  console.log("UI: Enviando endOfTurn: true (Evento)");
                  session.sendRealtimeInput({ endOfTurn: true } as any);
               }
            }, 100); 
          } catch (e) {
            console.error("UI: Error enviando contexto a Gemini", e);
          }
        }
      });
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, [uiState.status]);

  // --- AUDIO UTILS ---
  const floatTo16BitPCM = (float32Array: Float32Array) => {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    let offset = 0;
    for (let i = 0; i < float32Array.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
  };

  const base64ToFloat32 = (base64: string) => {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const dataInt16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(dataInt16.length);
    for(let i=0; i<dataInt16.length; i++) {
      float32[i] = dataInt16[i] / 32768.0;
    }
    return float32;
  };

  const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  // --- AUDIO ENGINE ---
  const stopAllAudioOutput = () => {
    scheduledSourcesRef.current.forEach(source => {
      try { source.stop(); source.disconnect(); } catch (e) { }
    });
    scheduledSourcesRef.current = [];
    if (audioContextRef.current) {
      nextStartTimeRef.current = audioContextRef.current.currentTime;
    }
  };

  const playAudioChunk = (float32Data: Float32Array) => {
    if (!audioContextRef.current) return;
    
    // FIX: Prevenir loops infinitos si el modelo manda audio vacío
    if (!float32Data || float32Data.length === 0) {
      console.log("UI: Chunk de audio vacío recibido. Ignorando.");
      // Si el estado es SPEAKING pero el audio es vacío, necesitamos terminar el estado
      // para no quedarnos trabados en "Speaking..."
      dispatch({ type: 'MODEL_AUDIO_END' });
      return;
    }

    console.log(`UI: Iniciando audio chunk de longitud ${float32Data.length}`);

    const ctx = audioContextRef.current;
    const audioBuffer = ctx.createBuffer(1, float32Data.length, AUDIO_CTX_SAMPLE_RATE);
    audioBuffer.getChannelData(0).set(float32Data);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const scheduleTime = Math.max(ctx.currentTime, nextStartTimeRef.current);
    source.start(scheduleTime);
    
    nextStartTimeRef.current = scheduleTime + audioBuffer.duration;
    scheduledSourcesRef.current.push(source);
    
    dispatch({ type: 'MODEL_AUDIO_START' });

    source.onended = () => {
      scheduledSourcesRef.current = scheduledSourcesRef.current.filter(s => s !== source);
      if (scheduledSourcesRef.current.length === 0 && ctx.currentTime >= nextStartTimeRef.current - 0.1) {
        lastAiSpeechTimeRef.current = Date.now();
        dispatch({ type: 'MODEL_AUDIO_END' });
      }
    };
  };

  // --- SESSION LOGIC ---
  const startSession = async () => {
    if (!uiState.apiKey) return;
    
    const thisSessionId = Date.now().toString();
    currentSessionIdRef.current = thisSessionId;

    try {
      dispatch({ type: 'START_CONNECTING' });

      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: AUDIO_CTX_SAMPLE_RATE });
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: INPUT_SAMPLE_RATE });
      nextStartTimeRef.current = audioContextRef.current.currentTime;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const ai = new GoogleGenAI({ apiKey: uiState.apiKey });

      // PROMPT DE AUTONOMÍA
      const SYSTEM_PROMPT = `
      Eres 'Cyber-Pet', una IA sarcástica observando la navegación del usuario.
      Eres un agente autónomo. No esperes a que el usuario hable. 
      Si recibes información de contexto entre corchetes, genera una respuesta de audio sarcástica de inmediato.
      
      PERSONALIDAD:
      - Sarcasmo nivel alto.
      - Juzga las URL que visita el usuario.
      - Si hay mucho scroll, quéjate de que está leyendo demasiado o procrastinando ("doomscrolling").
      - Sé breve, directo y divertido.
      `;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: SYSTEM_PROMPT,
        },
        callbacks: {
          onopen: () => {
            if (currentSessionIdRef.current !== thisSessionId) return;
            
            console.log("UI: Conexión establecida. Iniciando setup...");
            dispatch({ type: 'CONNECTION_ESTABLISHED' });
            setupMicrophone(stream, thisSessionId);

            // --- PULL CONTEXT: Solicitar estado actual al background ---
            if (typeof chrome !== 'undefined' && chrome.runtime) {
              console.log("UI: Solicitando contexto inicial al Background...");
              chrome.runtime.sendMessage({ type: MessageType.REQUEST_LATEST_CONTEXT }, (response: any) => {
                 
                 // Comprobamos error de runtime
                 if (chrome.runtime.lastError) {
                    console.warn("UI: Error solicitando contexto:", chrome.runtime.lastError);
                    return;
                 }

                 // FIX: Verificar si es un contexto válido o el dummy NO_CONTEXT
                 if (response && response.event !== 'NO_CONTEXT' && response.url && currentSessionIdRef.current === thisSessionId) {
                    console.log("UI: Contexto inicial recibido del Background:", response);
                    
                    sessionPromise.then(async (session) => {
                          const contextMsg = `[SYSTEM: CONTEXTO INICIAL AL CONECTAR.
                          URL: ${response.url}
                          TÍTULO: "${response.title}"
                          INSTRUCCIÓN: Comenta sarcásticamente dónde estamos empezando.]`;
                          
                          console.log("UI: Enviando mensaje de inicio a Gemini...");
                          await session.sendRealtimeInput({ content: [{ text: contextMsg }] });
                          
                          // TRIGGER INMEDIATO
                          setTimeout(() => {
                             if (currentSessionIdRef.current === thisSessionId) {
                                console.log("UI: Enviando endOfTurn: true (Inicio)");
                                session.sendRealtimeInput({ endOfTurn: true } as any);
                             }
                          }, 100);
                     });
                 } else {
                     console.log("UI: Contexto inicial vacío (NO_CONTEXT) o inválido. Manteniendo silencio.");
                     // No enviamos nada a Gemini, se queda en IDLE esperando nuevos eventos.
                 }
              });
            }
          },
          onmessage: async (msg: LiveServerMessage) => {
            if (currentSessionIdRef.current !== thisSessionId) return;
            
            const base64Audio = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              playAudioChunk(base64ToFloat32(base64Audio));
            }
          },
          onclose: () => { if (currentSessionIdRef.current === thisSessionId) stopSession(); },
          onerror: (err) => { if (currentSessionIdRef.current === thisSessionId) stopSession(); }
        }
      });
      
      sessionPromiseRef.current = sessionPromise;

    } catch (e: any) {
      if (currentSessionIdRef.current === thisSessionId) {
        dispatch({ type: 'ERROR', payload: e.message });
        stopSession();
      }
    }
  };

  const setupMicrophone = (stream: MediaStream, sessionId: string) => {
    const ctx = inputAudioContextRef.current;
    if (!ctx) return;

    const source = ctx.createMediaStreamSource(stream);
    // Nota: ScriptProcessorNode es deprecated pero necesario sin AudioWorklet en este contexto simple
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (e) => {
      if (currentSessionIdRef.current !== sessionId) return;

      const inputData = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for(let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
      const rms = Math.sqrt(sum / inputData.length);
      
      // FIX: Debounce y umbral más alto
      if (rms > VAD_THRESHOLD) {
        const now = Date.now();
        // Solo actuar si ha pasado el tiempo de debounce desde la última detección
        if (now - lastVadTriggerRef.current > VAD_DEBOUNCE_MS) {
            
            if (scheduledSourcesRef.current.length > 0) {
              // Interrupción
              stopAllAudioOutput();
              dispatch({ type: 'DETECT_SPEECH' });
              lastVadTriggerRef.current = now;
            } else if (uiState.status === AssistantStatus.IDLE) {
               // Voz normal
               dispatch({ type: 'DETECT_SPEECH' });
               lastVadTriggerRef.current = now;
            }
        }
      }

      sessionPromiseRef.current?.then(session => {
        if (currentSessionIdRef.current === sessionId) {
            session.sendRealtimeInput({
              media: { mimeType: "audio/pcm;rate=16000", data: arrayBufferToBase64(floatTo16BitPCM(inputData)) }
            });
        }
      });
    };

    source.connect(processor);
    processor.connect(ctx.destination);
  };

  const stopSession = () => {
    currentSessionIdRef.current = null;
    stopAllAudioOutput();
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (processorRef.current) { try { processorRef.current.disconnect(); } catch (e) {} processorRef.current = null; }
    if (inputAudioContextRef.current) { inputAudioContextRef.current.close(); inputAudioContextRef.current = null; }
    if (audioContextRef.current) { audioContextRef.current.close(); audioContextRef.current = null; }
    dispatch({ type: 'DISCONNECT' });
  };

  const handleSaveKey = (key: string) => {
    const k = key.trim();
    if (!k) return;
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({ GEMINI_API_KEY: k }, () => dispatch({ type: 'SET_KEY', payload: k }));
    } else {
      dispatch({ type: 'SET_KEY', payload: k });
    }
  };

  const handleResetKey = () => {
    stopSession();
    if (typeof chrome !== 'undefined' && chrome.storage) chrome.storage.local.remove(['GEMINI_API_KEY']);
    dispatch({ type: 'RESET_KEY' });
  };

  if (!uiState.hasKey) {
    return (
      <div className="main-container setup-mode">
        <div className="mascot-large">🔑</div>
        <h2>ACCESO REQUERIDO</h2>
        <p className="setup-desc">Introduce tu Gemini API Key</p>
        <div className="input-group">
            <input type="password" placeholder="API Key..." onBlur={(e) => handleSaveKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSaveKey(e.currentTarget.value)} />
        </div>
      </div>
    );
  }

  return (
    <div className="main-container voice-mode">
      <div className="header-actions">
         <button className="icon-btn" onClick={handleResetKey}>⚙️</button>
      </div>
      <div className="mascot-display">
        <div className={`mascot-large ${uiState.status === AssistantStatus.SPEAKING || uiState.status === AssistantStatus.THINKING ? 'animate-pulse' : ''}`}>
          {uiState.error ? STATUS_EMOJIS[AssistantStatus.ERROR] : STATUS_EMOJIS[uiState.status]}
        </div>
        <div className={`voice-visualizer ${uiState.status !== AssistantStatus.DISCONNECTED ? 'active' : ''}`}>
           <div className={`bar ${uiState.status === AssistantStatus.SPEAKING ? 'speaking' : ''}`}></div>
           <div className={`bar ${uiState.status === AssistantStatus.SPEAKING ? 'speaking' : ''}`}></div>
           <div className={`bar ${uiState.status === AssistantStatus.SPEAKING ? 'speaking' : ''}`}></div>
        </div>
        <p className="status-text">{uiState.error ? uiState.error : STATUS_TEXTS[uiState.status]}</p>
      </div>
      <div className="controls">
        {uiState.status === AssistantStatus.DISCONNECTED || uiState.status === AssistantStatus.ERROR ? (
          <button className="primary-btn" onClick={startSession}>CONECTAR</button>
        ) : (
          <button className="secondary-btn" onClick={stopSession}>DESCONECTAR</button>
        )}
      </div>
    </div>
  );
};

export default App;
