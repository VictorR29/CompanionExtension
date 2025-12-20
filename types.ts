
export enum MessageType {
  BROWSER_ACTIVITY = 'BROWSER_ACTIVITY', // Content -> Background
  GET_LAST_CONTEXT = 'GET_LAST_CONTEXT', // UI -> Background
  CONTEXT_UPDATED = 'CONTEXT_UPDATED',   // Background -> UI (Real-time push)
  CONTEXT_RESPONSE = 'CONTEXT_RESPONSE'  // Background -> UI (Response to GET)
}

export interface ContextPayload {
  url: string;
  title: string;
  description: string; // "Navegando", "Scrolleando frenéticamente", etc.
  timestamp: number;
  pageContent?: string; // Contenido visible para contexto
  actionType?: "navigate" | "interaction" | "input" | "media";
}

export interface QueuedMessage {
  parts: any[];
  turnComplete: boolean;
}

export interface AppMessage {
  type: MessageType;
  payload?: any;
}

export enum AssistantStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  IDLE = 'IDLE',
  SPEAKING = 'SPEAKING',
  ERROR = 'ERROR'
}

export interface StateMachineState {
  status: AssistantStatus;
  apiKey: string;
  hasKey: boolean;
  audioReady: boolean; // Nuevo: Para el gesto de usuario obligatorio
  error: string | null;
}
