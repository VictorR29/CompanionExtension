import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { copyFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Plugin para copiar manifest.json al dist después del build
const copyManifestPlugin = () => ({
  name: 'copy-manifest',
  closeBundle() {
    copyFileSync(
      resolve(__dirname, 'manifest.json'),
      resolve(__dirname, 'dist', 'manifest.json')
    );
    console.log('✓ manifest.json copied to dist/');
  }
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');

  return {
    plugins: [react(), copyManifestPlugin()],
    define: {
      'process.env.API_KEY': JSON.stringify(env.API_KEY),
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          background: resolve(__dirname, 'background.ts'),
          content: resolve(__dirname, 'contentScript.ts'),
        },
        output: {
          // Formato ES para bundles
          format: 'es',
          entryFileNames: (chunkInfo) => {
            if (chunkInfo.name === 'background') return 'background.js';
            if (chunkInfo.name === 'content') return 'content.js';
            return 'assets/[name].js';
          },
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name].[ext]',
        },
      },
    },
  };
});