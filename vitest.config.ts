import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({resolve:{alias:Object.fromEntries(['contracts','engine','lexicon','ai'].map(name=>[`@bestword/${name}`,fileURLToPath(new URL(`./packages/${name}/src/index.ts`,import.meta.url))]))},test:{include:['packages/**/*.test.ts','apps/server/**/*.test.ts','apps/web/**/*.test.ts'],exclude:['**/node_modules/**','**/dist/**'],testTimeout:30_000,hookTimeout:60_000}});
