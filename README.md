# Reactor

Convierte guiones de estudio en MP3 con voces neuronales en español (España, México, Argentina).

- `index.html` — la web (frontend estático, se publica en GitHub Pages).
- `worker.js` — backend mínimo para Cloudflare Workers (`POST /tts` → `audio/mpeg`).

## Puesta en marcha

1. Desplegar el Worker (desde esta carpeta):
   ```
   npx wrangler login
   npx wrangler deploy
   ```
2. Poner la URL del Worker en la constante `API` de `index.html` (termina en `/tts`).
3. Activar GitHub Pages: Settings → Pages → Deploy from a branch → `main` / root.
