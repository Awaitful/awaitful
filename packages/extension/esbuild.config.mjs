import * as esbuild from 'esbuild';

// Load .env so `pnpm build` picks up API_BASE_URL without a shell prefix.
// Shell env vars still take precedence (CI sets API_BASE_URL directly).
try { process.loadEnvFile(); } catch { /* no .env present — fine */ }

const watch = process.argv.includes('--watch');

// API_BASE_URL is baked into the bundle at build time.
// - Local dev:  set API_BASE_URL=http://localhost:3000 in packages/extension/.env
// - CI publish: set API_BASE_URL in the GitHub Actions environment.
const apiBaseUrl = process.env['API_BASE_URL'] ?? '';

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'], // Provided by the VS Code extension host at runtime.
  format: 'cjs',        // Extension host requires CommonJS.
  platform: 'node',
  target: 'node20',     // VS Code 1.90+ ships Node 20.
  sourcemap: true,
  minify: !watch,
  define: {
    AWAITFUL_API_BASE_URL: JSON.stringify(apiBaseUrl),
  },
});

if (watch) {
  await ctx.watch();
  console.log('[Awaitful] Watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
