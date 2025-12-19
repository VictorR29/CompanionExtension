import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // Cargar variables de entorno desde .env (si existe)
  // Use '.' instead of process.cwd() to avoid TS error if types/node is missing.
  const env = loadEnv(mode, '.', '');

  return {
    plugins: [react()],
    define: {
      // Inyectar la API KEY de forma segura durante el build
      'process.env.API_KEY': JSON.stringify(env.API_KEY),
    },
    css: {
      devSourcemap: true,
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          background: resolve(__dirname, 'background.ts'),
          contentScript: resolve(__dirname, 'contentScript.ts'),
        },
        output: {
          entryFileNames: (chunkInfo) => {
            if (chunkInfo.name === 'background' || chunkInfo.name === 'contentScript') {
              return '[name].js';
            }
            return 'assets/[name]-[hash].js';
          },
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: (assetInfo) => {
            if (assetInfo.name?.endsWith('.css')) {
              return 'assets/style-[hash].css';
            }
            return 'assets/[name]-[hash].[ext]';
          }
        },
      },
    },
  };
});