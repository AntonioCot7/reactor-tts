/**
 * Backend de sintesis de voz. Un solo endpoint:
 *
 *   POST /tts   { text, voice, rate }  ->  audio/mpeg
 *
 * Despliegue:
 *   npm create cloudflare@latest lector-tts -- --type=hello-world
 *   (reemplaza src/index.js con este archivo)
 *   npx wrangler deploy
 */

// ---------------------------------------------------------------- constantes

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_VERSION = "143.0.3650.0";
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

// Pon aca la URL de tu GitHub Pages cuando la tengas, para cerrar el endpoint.
// Ejemplo: ["https://tuusuario.github.io"]
const ORIGENES_PERMITIDOS = null; // null = cualquiera

// ---------------------------------------------------------------- utilidades

function cabecerasCors(origen) {
  const permitido =
    ORIGENES_PERMITIDOS === null
      ? "*"
      : ORIGENES_PERMITIDOS.includes(origen)
        ? origen
        : ORIGENES_PERMITIDOS[0];

  return {
    "Access-Control-Allow-Origin": permitido,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function hex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function idAleatorio() {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Sec-MS-GEC: SHA-256 en mayusculas de (ticks de Windows redondeados a 5 min)
 * concatenado con el token de cliente.
 *
 * Los ticks pasan de 1e17, asi que van en BigInt. Con Number se pierde
 * precision silenciosamente y el servidor responde 403.
 */
async function generarTokenGec() {
  let ticks = BigInt(Math.floor(Date.now() / 1000)) + WIN_EPOCH;
  ticks -= ticks % 300n;
  ticks *= 10000000n;

  const entrada = new TextEncoder().encode(ticks.toString() + TRUSTED_CLIENT_TOKEN);
  const digest = await crypto.subtle.digest("SHA-256", entrada);
  return hex(new Uint8Array(digest)).toUpperCase();
}

function escaparXml(texto) {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function marcaTiempo() {
  return new Date().toString() + " (Hora estandar de Peru)";
}

// ------------------------------------------------------------------ sintesis

async function sintetizar(texto, voz, rate) {
  const connectionId = idAleatorio();
  const gec = await generarTokenGec();

  const url =
    `${BASE_WSS}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${gec}` +
    `&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}` +
    `&ConnectionId=${connectionId}`;

  const respuesta = await fetch(url, {
    headers: {
      Upgrade: "websocket",
      Origin: ORIGIN,
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
      Cookie: `MUID=${idAleatorio().toUpperCase()}`,
    },
  });

  const ws = respuesta.webSocket;
  if (!ws) {
    throw new Error(
      `El servicio rechazo la conexion (HTTP ${respuesta.status}). ` +
        `Si es 403, el token caduco; si es 400, el runtime no dejo pasar el handshake.`
    );
  }

  ws.accept();

  const trozos = [];
  let recibidos = 0;

  await new Promise((resolver, rechazar) => {
    const reloj = setTimeout(() => {
      try { ws.close(); } catch {}
      rechazar(new Error("El servicio no respondio en 25 segundos."));
    }, TIMEOUT_MS);

    const terminar = (fn, arg) => {
      clearTimeout(reloj);
      try { ws.close(); } catch {}
      fn(arg);
    };

    ws.addEventListener("message", (evento) => {
      // Mensajes de control: texto plano con cabeceras estilo HTTP.
      if (typeof evento.data === "string") {
        if (evento.data.includes("Path:turn.end")) {
          terminar(resolver);
        }
        return;
      }

      // Mensajes de audio: uint16 big-endian con el largo de la cabecera,
      // la cabecera, y despues los bytes del MP3.
      const datos =
        evento.data instanceof ArrayBuffer
          ? evento.data
          : evento.data.buffer.slice(
              evento.data.byteOffset,
              evento.data.byteOffset + evento.data.byteLength
            );

      if (datos.byteLength < 2) return;

      const largoCabecera = new DataView(datos).getUint16(0, false);
      const cabecera = new TextDecoder().decode(
        new Uint8Array(datos, 2, Math.min(largoCabecera, datos.byteLength - 2))
      );

      if (!cabecera.includes("Path:audio")) return;

      const audio = new Uint8Array(datos, 2 + largoCabecera);
      if (audio.byteLength > 0) {
        trozos.push(audio);
        recibidos += audio.byteLength;
      }
    });

    ws.addEventListener("error", () =>
      terminar(rechazar, new Error("Se corto la conexion con el servicio."))
    );

    ws.addEventListener("close", () => {
      if (recibidos > 0) terminar(resolver);
      else terminar(rechazar, new Error("La conexion se cerro sin devolver audio."));
    });

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
        })
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
        ssml
    );
  });

  if (trozos.length === 0) throw new Error("No se recibio audio.");

  const total = trozos.reduce((n, t) => n + t.byteLength, 0);
  const salida = new Uint8Array(total);
  let offset = 0;
  for (const t of trozos) {
    salida.set(t, offset);
    offset += t.byteLength;
  }
  return salida;
}

// -------------------------------------------------------------------- rutas

export default {
  async fetch(peticion) {
    const cors = cabecerasCors(peticion.headers.get("Origin") || "");
    const ruta = new URL(peticion.url).pathname;

    if (peticion.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (ruta === "/salud") {
      return Response.json(
        { ok: true, voces: [...VOCES_PERMITIDAS] },
        { headers: cors }
      );
    }

    if (ruta !== "/tts" || peticion.method !== "POST") {
      return Response.json(
        { error: "Usa POST /tts con { text, voice, rate }." },
        { status: 404, headers: cors }
      );
    }

    let cuerpo;
    try {
      cuerpo = await peticion.json();
    } catch {
      return Response.json(
        { error: "El cuerpo debe ser JSON." },
        { status: 400, headers: cors }
      );
    }

    const texto = (cuerpo.text || "").trim();
    const voz = cuerpo.voice || "es-MX-DaliaNeural";
    const rate = /^[+-]\d{1,3}%$/.test(cuerpo.rate || "") ? cuerpo.rate : "+0%";

    if (!texto) {
      return Response.json(
        { error: "No mandaste texto." },
        { status: 400, headers: cors }
      );
    }

    if (texto.length > LIMITE_CARACTERES) {
      return Response.json(
        {
          error: `El bloque tiene ${texto.length} caracteres y el maximo es ${LIMITE_CARACTERES}. Partelo antes de enviarlo.`,
        },
        { status: 413, headers: cors }
      );
    }

    if (!VOCES_PERMITIDAS.has(voz)) {
      return Response.json(
        { error: `La voz "${voz}" no esta en la lista.` },
        { status: 400, headers: cors }
      );
    }

    try {
      const mp3 = await sintetizar(texto, voz, rate);
      return new Response(mp3, {
        headers: {
          ...cors,
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-store",
        },
      });
    } catch (e) {
      return Response.json(
        { error: e.message || "Fallo la sintesis." },
        { status: 502, headers: cors }
      );
    }
  },
};
