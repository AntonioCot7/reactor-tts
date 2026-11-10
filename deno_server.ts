/**
 * Backend de sintesis de voz para Deno Deploy. Mismos endpoints que worker.js:
 *
 *   POST /tts    { text, voice, rate }  ->  audio/mpeg
 *   GET  /salud                         ->  { ok, voces }
 *
 * Entrypoint en Deno Deploy: deno_server.ts
 */

import WebSocket from "npm:ws";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------- constantes

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_VERSION = "143.0.3650.75";
const WIN_EPOCH = 11644473600n; // segundos entre 1601-01-01 y 1970-01-01

const BASE_WSS =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";

const ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";

const VOCES_PERMITIDAS = new Set([
  "es-ES-ElviraNeural",
  "es-ES-AlvaroNeural",
  "es-MX-DaliaNeural",
  "es-MX-JorgeNeural",
  "es-AR-ElenaNeural",
  "es-AR-TomasNeural",
]);

const LIMITE_CARACTERES = 3000;
const TIMEOUT_MS = 25000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// ---------------------------------------------------------------- utilidades

function idAleatorio(): string {
  return randomBytes(16).toString("hex");
}

/** Sec-MS-GEC: SHA-256 en mayusculas de (ticks de Windows a 5 min) + token. */
function generarTokenGec(): string {
  let ticks = BigInt(Math.floor(Date.now() / 1000)) + WIN_EPOCH;
  ticks -= ticks % 300n;
  ticks *= 10000000n;
  return createHash("sha256")
    .update(ticks.toString() + TRUSTED_CLIENT_TOKEN)
    .digest("hex")
    .toUpperCase();
}

function escaparXml(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function marcaTiempo(): string {
  return new Date().toString() + " (Hora estandar de Peru)";
}

// ------------------------------------------------------------------ sintesis

function sintetizar(texto: string, voz: string, rate: string): Promise<Uint8Array> {
  return new Promise((resolver, rechazar) => {
    const connectionId = idAleatorio();
    const url =
      `${BASE_WSS}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&Sec-MS-GEC=${generarTokenGec()}` +
      `&Sec-MS-GEC-Version=2-${CHROMIUM_VERSION}` +
      `&ConnectionId=${connectionId}`;

    const ws = new WebSocket(url, {
      headers: {
        Origin: ORIGIN,
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        Cookie: `MUID=${idAleatorio().toUpperCase()}`,
      },
    });

    const trozos: Buffer[] = [];
    let terminado = false;

    const reloj = setTimeout(
      () => fin(new Error("El servicio no respondio en 25 segundos.")),
      TIMEOUT_MS,
    );

    function fin(error?: Error) {
      if (terminado) return;
      terminado = true;
      clearTimeout(reloj);
      try { ws.close(); } catch { /* ya cerrado */ }
      if (error) rechazar(error);
      else resolver(new Uint8Array(Buffer.concat(trozos)));
    }

    ws.on("unexpected-response", (_req: unknown, res: { statusCode?: number }) => {
      fin(new Error(
        `El servicio rechazo la conexion (HTTP ${res.statusCode}). ` +
          `Si es 403, Microsoft bloquea este servidor o el token es invalido.`,
      ));
    });

    ws.on("error", (e: Error) => fin(new Error("Se corto la conexion: " + e.message)));

    ws.on("close", () => {
      if (trozos.length > 0) fin();
      else fin(new Error("La conexion se cerro sin devolver audio."));
    });

    ws.on("open", () => {
      // 1. Configuracion de salida.
      ws.send(
        `X-Timestamp:${marcaTiempo()}\r\n` +
          `Content-Type:application/json; charset=utf-8\r\n` +
          `Path:speech.config\r\n\r\n` +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: {
                    sentenceBoundaryEnabled: "false",
                    wordBoundaryEnabled: "false",
                  },
                  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
                },
              },
            },
          }),
      );

      // 2. El texto.
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='es-ES'>` +
        `<voice name='${voz}'>` +
        `<prosody pitch='+0Hz' rate='${rate}' volume='+0%'>${escaparXml(texto)}</prosody>` +
        `</voice></speak>`;

      ws.send(
        `X-RequestId:${connectionId}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${marcaTiempo()}Z\r\n` +
          `Path:ssml\r\n\r\n` +
          ssml,
      );
    });

    ws.on("message", (data: Buffer, esBinario: boolean) => {
      // Mensajes de control: texto con cabeceras estilo HTTP.
      if (!esBinario) {
        if (data.toString().includes("Path:turn.end")) fin();
        return;
      }

      // Mensajes de audio: uint16 big-endian con el largo de la cabecera,
      // la cabecera, y despues los bytes del MP3.
      if (data.length < 2) return;
      const largoCabecera = data.readUInt16BE(0);
      const cabecera = data.subarray(2, 2 + largoCabecera).toString();
      if (!cabecera.includes("Path:audio")) return;

      const audio = data.subarray(2 + largoCabecera);
      if (audio.length > 0) trozos.push(audio);
    });
  });
}

// -------------------------------------------------------------------- rutas

function json(cuerpo: unknown, status = 200): Response {
  return Response.json(cuerpo, { status, headers: CORS });
}

Deno.serve(async (peticion: Request) => {
  const ruta = new URL(peticion.url).pathname;

  if (peticion.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (ruta === "/salud") {
    return json({ ok: true, voces: [...VOCES_PERMITIDAS] });
  }

  if (ruta !== "/tts" || peticion.method !== "POST") {
    return json({ error: "Usa POST /tts con { text, voice, rate }." }, 404);
  }

  let cuerpo: { text?: string; voice?: string; rate?: string };
  try {
    cuerpo = await peticion.json();
  } catch {
    return json({ error: "El cuerpo debe ser JSON." }, 400);
  }

  const texto = (cuerpo.text || "").trim();
  const voz = cuerpo.voice || "es-MX-DaliaNeural";
  const rate = /^[+-]\d{1,3}%$/.test(cuerpo.rate || "") ? cuerpo.rate! : "+0%";

  if (!texto) return json({ error: "No mandaste texto." }, 400);

  if (texto.length > LIMITE_CARACTERES) {
    return json({
      error: `El bloque tiene ${texto.length} caracteres y el maximo es ${LIMITE_CARACTERES}. Partelo antes de enviarlo.`,
    }, 413);
  }

  if (!VOCES_PERMITIDAS.has(voz)) {
    return json({ error: `La voz "${voz}" no esta en la lista.` }, 400);
  }

  try {
    const mp3 = await sintetizar(texto, voz, rate);
    return new Response(mp3, {
      headers: { ...CORS, "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  } catch (e) {
    return json({ error: (e as Error).message || "Fallo la sintesis." }, 502);
  }
});
