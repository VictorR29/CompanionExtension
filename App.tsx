import React, { useEffect, useRef, useReducer } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { AssistantStatus, StateMachineState, MessageType, ContextPayload } from './types';

declare const chrome: any;

// --- CONSTANTES DE AUDIO ---
const OUTPUT_SAMPLE_RATE = 24000;
const INPUT_SAMPLE_RATE = 16000;

// --- REDUCER ---
const initialState: StateMachineState = {
  status: AssistantStatus.DISCONNECTED,
  apiKey: '',
  hasKey: false,
  audioReady: false,
  error: null
};

function uiReducer(state: StateMachineState, action: any): StateMachineState {
  switch (action.type) {
    case 'SET_KEY': return { ...state, apiKey: action.payload, hasKey: true };
    case 'SET_STATUS': return { ...state, status: action.payload, error: null };
    case 'SET_ERROR': return { ...state, status: AssistantStatus.ERROR, error: action.payload };
    case 'RESET': return initialState;
    default: return state;
  }
}

// --- UTILS AUDIO ---
function base64ToFloat32(base64: string): Float32Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;
  return float32;
}

function float32ToBase64(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

const App: React.FC = () => {
  const [state, dispatch] = useReducer(uiReducer, initialState);
  
  // Referencias estables
  const sessionRef = useRef<any>(null); // Acts as our WebSocket reference
  
  // Audio Refs
  const outputCtxRef = useRef<AudioContext | null>(null);
  const inputCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  
  // Visión (Contexto)
  const [currentContext, setCurrentContext] = React.useState<ContextPayload | null>(null);

  // --- 1. SETUP INICIAL ---
  useEffect(() => {
    if (!outputCtxRef.current) {
      outputCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: OUTPUT_SAMPLE_RATE,
      });
    }

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(['GEMINI_API_KEY'], (result: any) => {
        if (result?.GEMINI_API_KEY) {
          dispatch({ type: 'SET_KEY', payload: result.GEMINI_API_KEY });
        }
      });
    }

    return () => cleanupAudio();
  }, []);

  // --- 2. FUNCIÓN SEGURA DE ENVÍO (ULTRA-SAFE) ---
  const enviarDatosIA = (texto: string) => {
    // Verificación estricta de existencia
    if (sessionRef.current) {
      try {
        // Adaptamos la estructura que pediste al método del SDK
        // El SDK maneja la serialización JSON internamente
        sessionRef.current.send({ 
          clientContent: {
            turns: [{ 
              role: 'user', 
              parts: [{ text: texto }] 
            }],
            turnComplete: true
          }
        });
        console.log("✅ Mensaje enviado a Gemini:", texto);
      } catch (e) {
        console.error("❌ Error al enviar (SDK):", e);
      }
    } else {
      console.warn("⚠️ WebSocket no listo. Mensaje ignorado:", texto);
    }
  };

  // --- 3. INYECCIÓN DE VISIÓN REACTIVA (Sensory Observation) ---
  useEffect(() => {
    const messageListener = (message: any) => {
      if (message.type === MessageType.CONTEXT_UPDATED) {
        const ctx = message.payload as ContextPayload;
        setCurrentContext(ctx);

        // Solo enviamos si ya estamos en un estado activo válido
        if (state.status === AssistantStatus.IDLE || state.status === AssistantStatus.SPEAKING) {
          // Formato solicitado: Observación sensorial para forzar respuesta de audio
          const promptSensorial = `[Nueva información: El usuario ahora está viendo la pestaña "${ctx.title}". Genera una respuesta de audio corta y sarcástica sobre esto.]`;
          enviarDatosIA(promptSensorial);
        }
      }
    };

    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(messageListener);
    }
    return () => {
      if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.removeListener(messageListener);
      }
    };
  }, [state.status]); 

  // --- 4. MOTOR DE AUDIO ---
  const playAudioChunk = (base64Data: string) => {
    const ctx = outputCtxRef.current;
    if (!ctx) return;

    const float32 = base64ToFloat32(base64Data);
    const buffer = ctx.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const currentTime = ctx.currentTime;
    if (nextStartTimeRef.current < currentTime) {
      nextStartTimeRef.current = currentTime;
    }
    
    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += buffer.duration;

    dispatch({ type: 'SET_STATUS', payload: AssistantStatus.SPEAKING });
    
    source.onended = () => {
      if (ctx.currentTime >= nextStartTimeRef.current - 0.1) {
        dispatch({ type: 'SET_STATUS', payload: AssistantStatus.IDLE });
      }
    };
  };

  const startMicrophone = async () => {
    try {
      if (mediaStreamRef.current) return;

      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { 
          sampleRate: INPUT_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true
        } 
      });
      mediaStreamRef.current = stream;

      inputCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: INPUT_SAMPLE_RATE 
      });

      const source = inputCtxRef.current.createMediaStreamSource(stream);
      const processor = inputCtxRef.current.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        // Check extra de seguridad
        if (!sessionRef.current) return;

        const inputData = e.inputBuffer.getChannelData(0);
        const b64Data = float32ToBase64(inputData);
        
        try {
          sessionRef.current.sendRealtimeInput({
            media: { mimeType: 'audio/pcm;rate=16000', data: b64Data }
          });
        } catch (err) {
          // Ignorar silenciosamente si socket cae
        }
      };

      source.connect(processor);
      processor.connect(inputCtxRef.current.destination);
    } catch (e) {
      console.error("Mic Error:", e);
      dispatch({ type: 'SET_ERROR', payload: "Sin acceso al Micrófono" });
    }
  };

  const cleanupAudio = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (inputCtxRef.current) {
      inputCtxRef.current.close();
      inputCtxRef.current = null;
    }
  };

  // --- 5. LÓGICA DE CONEXIÓN ---
  const handleConnect = async () => {
    if (!state.apiKey) return;
    dispatch({ type: 'SET_STATUS', payload: AssistantStatus.CONNECTING });

    try {
      // 1. Audio Context Resume (Gesto de usuario)
      if (outputCtxRef.current?.state === 'suspended') {
        await outputCtxRef.current.resume();
      }

      // 2. Obtener Contexto Inicial
      const initialCtx: ContextPayload = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: MessageType.GET_LAST_CONTEXT }, (res: any) => {
          resolve(res || { title: 'Desconocido', url: '...' });
        });
      });
      setCurrentContext(initialCtx);

      // 3. Conexión WebSocket
      const ai = new GoogleGenAI({ apiKey: state.apiKey });
      const session = await ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: "Eres Glitch, un asistente sarcástico. Tu trabajo es juzgar las pestañas que visita el usuario.",
        },
        callbacks: {
          onopen: () => console.log("🌐 WS Conectado"),
          onmessage: (msg: LiveServerMessage) => {
            const audioData = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData) playAudioChunk(audioData);
            
            if (msg.serverContent?.turnComplete) {
              dispatch({ type: 'SET_STATUS', payload: AssistantStatus.IDLE });
            }
          },
          onclose: () => handleDisconnect(),
          onerror: (e) => {
            console.error(e);
            dispatch({ type: 'SET_ERROR', payload: "Error de Conexión" });
          }
        }
      });

      // 4. Asignación de Referencia (CRÍTICO)
      sessionRef.current = session;

      // 5. Iniciar Audio
      await startMicrophone();
      
      dispatch({ type: 'SET_STATUS', payload: AssistantStatus.IDLE });

      // 6. DELAY DE INICIALIZACIÓN (Evita carrera de condiciones)
      setTimeout(() => {
        const saludoInicial = `[Nueva información: El usuario acaba de conectarse viendo la pestaña "${initialCtx.title}". Genera un saludo sarcástico.]`;
        enviarDatosIA(saludoInicial);
      }, 1000); // Esperamos 1s para asegurar estabilidad

    } catch (e: any) {
      console.error("Connection Failed:", e);
      dispatch({ type: 'SET_ERROR', payload: "Fallo al conectar" });
      handleDisconnect();
    }
  };

  const handleDisconnect = () => {
    sessionRef.current = null;
    cleanupAudio();
    dispatch({ type: 'SET_STATUS', payload: AssistantStatus.DISCONNECTED });
  };

  const handleSaveKey = (key: string) => {
    chrome.storage.local.set({ GEMINI_API_KEY: key });
    dispatch({ type: 'SET_KEY', payload: key });
  };

  // --- RENDER ---
  if (!state.hasKey) {
    return (
      <div className="main-container setup-mode">
        <div className="mascot-large">🔑</div>
        <h2>ACCESO REQUERIDO</h2>
        <div className="input-group">
          <input 
            type="password" 
            placeholder="Pegar API Key" 
            onBlur={(e) => handleSaveKey(e.target.value)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="main-container voice-mode">
      <div className="header-actions">
        <div style={{ fontSize: '0.7rem', color: '#6366f1', textAlign: 'right', maxWidth: '200px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {currentContext ? `👁 ${currentContext.title}` : '👁 Sin visión'}
        </div>
      </div>

      <div className="mascot-display">
        <div className={`mascot-large ${state.status === AssistantStatus.SPEAKING ? 'animate-pulse' : ''}`}>
           {state.status === AssistantStatus.SPEAKING ? '🤬' : 
            state.status === AssistantStatus.CONNECTING ? '🔌' :
            state.status === AssistantStatus.ERROR ? '💀' : 
            state.status === AssistantStatus.IDLE ? '👀' : '💤'}
        </div>
        
        <p className="status-text">{state.error ? state.error : state.status}</p>
        
        <div className={`voice-visualizer ${state.status === AssistantStatus.SPEAKING ? 'active' : ''}`}>
           <div className={`bar ${state.status === AssistantStatus.SPEAKING ? 'speaking' : ''}`}></div>
           <div className={`bar ${state.status === AssistantStatus.SPEAKING ? 'speaking' : ''}`}></div>
           <div className={`bar ${state.status === AssistantStatus.SPEAKING ? 'speaking' : ''}`}></div>
        </div>
      </div>
      
      <div className="controls">
        {state.status === AssistantStatus.DISCONNECTED || state.status === AssistantStatus.ERROR ? (
           <button className="primary-btn" onClick={handleConnect}>
             ACTIVAR GLITCH
           </button>
        ) : (
           <button className="secondary-btn" onClick={handleDisconnect}>
             APAGAR
           </button>
        )}
      </div>
    </div>
  );
};

export default App;