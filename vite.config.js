import { defineConfig } from 'vite';

// Served from https://dgreenheck.github.io/tolle-lege/ in production;
// keep '/' in dev so local tooling (scripts/snap.mjs) is unaffected.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/tolle-lege/' : '/',
}));
