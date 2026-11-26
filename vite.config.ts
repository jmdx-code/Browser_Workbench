import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const version = z
  .object({ version: z.string() })
  .parse(
    JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as unknown,
  ).version;
const extensionVersion = z
  .object({ version: z.string() })
  .parse(
    JSON.parse(
      readFileSync(new URL('./extension/manifest.json', import.meta.url), 'utf8'),
    ) as unknown,
  ).version;

export default defineConfig({
  root: 'src/renderer',
  base: '/workbench/',
  plugins: [tailwindcss(), react()],
  define: {
    __WORKBENCH_VERSION__: JSON.stringify(version),
    __BRIDGE_EXTENSION_VERSION__: JSON.stringify(extensionVersion),
  },
  build: {
    outDir: '../../web',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            {
              name: 'vendor-ui',
              test: /node_modules[\\/](@radix-ui|radix-ui|lucide-react|@tanstack)[\\/]/,
            },
            { name: 'vendor-datetime', test: /node_modules[\\/]luxon[\\/]/ },
            { name: 'vendor-schema', test: /node_modules[\\/]zod[\\/]/ },
          ],
        },
      },
    },
  },
});
