import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { nitro } from 'nitro/vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 3020,
    strictPort: true,
    allowedHosts: ['dev.loxep.com']
  },
  resolve: {
    tsconfigPaths: true
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      importProtection: {
        // The complete workspace packages are server domains. Isomorphic UI
        // code may consume only deliberately browser-safe subpaths; otherwise
        // a barrel can make Vite traverse database, crypto, filesystem, or
        // worker code while constructing the client graph.
        client: {
          specifiers: [/^@loxep\/(?!domain\/browser$)/]
        }
      }
    }),
    // Nitro auto-detects the deploy target: Vercel/Cloudflare/Netlify in their
    // CI (zero-config), and the Node.js server preset locally (.output/server,
    // matching the `start` script). Override with SERVER_PRESET to force one,
    // e.g. SERVER_PRESET=node-server / cloudflare-module / bun.
    nitro({ preset: process.env.SERVER_PRESET }),
    viteReact()
  ]
});
