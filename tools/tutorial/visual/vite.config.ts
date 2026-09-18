import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const directory = fileURLToPath(new URL('.', import.meta.url));
const repository = resolve(directory, '../../..');
export default defineConfig({
  root: directory,
  plugins: [react()],
  resolve: { alias: { '@bestword/contracts': resolve(repository, 'packages/contracts/src/index.ts'), '@bestword/engine': resolve(repository, 'packages/engine/src/index.ts') } },
  server: { host: '127.0.0.1', port: Number(process.env.BESTWORD_TUTORIAL_PORT || 4179), strictPort: true, fs: { allow: [repository, resolve(repository, '../../..')] } },
  build: { outDir: 'dist', emptyOutDir: true },
});
