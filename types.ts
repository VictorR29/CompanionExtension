
export enum MessageType {
  URL_CHANGED = 'URL_CHANGED',
  TEXT_SELECTED = 'TEXT_SELECTED',
  AI_REQUEST = 'AI_REQUEST',
  GET_STATUS = 'GET_STATUS',
  TOGGLE_ASSISTANT = 'TOGGLE_ASSISTANT',
  CONTEXT_UPDATE = 'CONTEXT_UPDATE'
}

export interface AppMessage {
  type: MessageType;
  payload?: any;
}

export interface AssistantState {
  isActive: boolean;
  hasKey: boolean;
  lastUrl: string;
  lastSelection: string;
}

export interface ContextPayload {
  event: 'NAVIGATION' | 'SELECTION' | 'VISIBILITY_VISIBLE' | 'VISIBILITY_HIDDEN' | 'SCROLL';
  url: string;
  title: string;
  selection?: string;
  timestamp: number;
}

// --- STATE MACHINE TYPES ---

export enum AssistantStatus {
  DISCONNECTED = 'DISCONNECTED', // Sin key o apagado
  CONNECTING = 'CONNECTING',     // Handshake WebSocket
  IDLE = 'IDLE',                 // Conectado, esperando voz
  LISTENING = 'LISTENING',       // Usuario hablando (VAD activo)
  THINKING = 'THINKING',         // Procesando respuesta
  SPEAKING = 'SPEAKING',         // Reproduciendo audio
  ERROR = 'ERROR'                // Fallo recuperable
}

export type AssistantAction = 
  | { type: 'SET_KEY'; payload: string }
  | { type: 'RESET_KEY' }
  | { type: 'START_CONNECTING' }
  | { type: 'CONNECTION_ESTABLISHED' }
  | { type: 'DETECT_SPEECH' }    // VAD Trigger
  | { type: 'SPEECH_STOPPED' }   // Silence detected / Turn complete
  | { type: 'MODEL_AUDIO_START' }
  | { type: 'MODEL_AUDIO_END' }
  | { type: 'ERROR'; payload: string }
  | { type: 'DISCONNECT' };

export interface StateMachineState {
  status: AssistantStatus;
  apiKey: string;
  hasKey: boolean;
  error: string | null;
  volume: number; // Para visualización
}
