// Shipped data in src/data/ is synthetic. To plan over a real export, point
// PLANNER_HOLDINGS (and optionally PLANNER_DEFAULTS) at files under private/,
// which is gitignored. Tests always run on the shipped sample.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const useEnv = !process.env.VITEST;
const holdings = useEnv ? process.env.PLANNER_HOLDINGS : undefined;
const defaults = useEnv ? process.env.PLANNER_DEFAULTS : undefined;

export default defineConfig({
  resolve: {
    alias: [
      ...(holdings ? [{ find: /^\.\/data\/holdings\.csv/, replacement: resolve(holdings) }] : []),
      ...(defaults ? [{ find: /^\.\/data\/defaults\.json$/, replacement: resolve(defaults) }] : []),
    ],
  },
});
