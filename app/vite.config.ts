import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // the game's own local server: AI provider settings, region jobs and the GLB
    // files Blender builds at runtime (see server/index.mjs)
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/generated': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
  },
});
