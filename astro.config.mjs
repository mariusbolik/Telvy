// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'static',
  vite: {
    plugins: [tailwindcss()],
    server: {
      proxy: {
        '/peerjs': {
          target: 'http://localhost:9000',
          ws: true,
        },
        '/api': {
          target: 'http://localhost:9000',
        },
      },
    },
  },
});
