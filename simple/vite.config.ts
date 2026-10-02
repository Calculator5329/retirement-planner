// The one-question page builds on its own: `vite simple` / `vite build simple`.
// It deliberately has none of the root config's PLANNER_HOLDINGS /
// PLANNER_DEFAULTS aliases; the page never reads holdings or defaults.
// The build inlines the script and stylesheet so dist/index.html is one
// self-contained file that also opens straight from disk.
import { defineConfig, type Plugin } from 'vite';

function inlineIntoHtml(): Plugin {
  return {
    name: 'inline-into-html',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const html = Object.values(bundle).find((f) => f.type === 'asset' && f.fileName.endsWith('.html'));
      if (!html || html.type !== 'asset') return;
      let text = String(html.source);
      for (const [name, file] of Object.entries(bundle)) {
        const ref = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (file.type === 'chunk' && file.isEntry) {
          text = text.replace(new RegExp(`<script type="module" crossorigin src="\\./${ref}"></script>`), () => `<script type="module">${file.code.replace(/<\/script/g, '<\\/script')}</script>`);
          delete bundle[name];
        } else if (file.type === 'asset' && name.endsWith('.css')) {
          text = text.replace(new RegExp(`<link rel="stylesheet" crossorigin href="\\./${ref}">`), () => `<style>${String(file.source)}</style>`);
          delete bundle[name];
        }
      }
      html.source = text;
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [inlineIntoHtml()],
  build: { outDir: 'dist', emptyOutDir: true, modulePreload: false },
});
