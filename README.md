
# Sarcastic Assistant Chrome Extension

## 🚀 Instrucciones Críticas de Instalación

1.  **Instalar dependencias:**
    `npm install`

2.  **Compilar el proyecto (Paso obligatorio):**
    `npm run build`
    Esto creará una carpeta llamada `dist/` en la raíz de tu proyecto. **Esta es la única carpeta que Chrome entiende.**

3.  **Cargar en Chrome:**
    - Ve a `chrome://extensions/`.
    - Activa el **Modo de desarrollador** (arriba a la derecha).
    - Haz clic en **Cargar descomprimida** (Load unpacked).
    - **IMPORTANTE:** Selecciona la carpeta `dist/` que se generó en el paso anterior, NO la carpeta raíz del código fuente.

## 🛠 Estructura
- `public/manifest.json`: El cerebro de la extensión. Se copia a `dist/` al compilar.
- `background.ts`: El script que vive en las sombras y maneja la ventana flotante.
- `contentScript.ts`: El espía que observa lo que haces en las webs.
- `App.tsx`: La cara (sarcástica) de la IA.

## ⚠️ Errores comunes
Si Chrome dice "No se pudo cargar contentScript.js", es porque estás intentando cargar la carpeta raíz en lugar de la carpeta `dist/`. Ejecuta `npm run build` y selecciona `dist/`.
