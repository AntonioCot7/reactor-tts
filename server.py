"""
Backend de sintesis de voz (FastAPI + edge-tts oficial).

    POST /tts    { text, voice, rate }  ->  audio/mpeg
    GET  /salud                         ->  { ok, voces }

Local:   uvicorn server:app --reload
Render:  uvicorn server:app --host 0.0.0.0 --port $PORT
"""

import edge_tts
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

VOCES_PERMITIDAS = [
    "es-ES-ElviraNeural",
    "es-ES-AlvaroNeural",
    "es-MX-DaliaNeural",
    "es-MX-JorgeNeural",
    "es-AR-ElenaNeural",
    "es-AR-TomasNeural",
]
LIMITE_CARACTERES = 3000

app = FastAPI(title="Reactor TTS")

# Para cerrarlo a tu web: allow_origins=["https://antoniocot7.github.io"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["Content-Type"],
)


class Peticion(BaseModel):
    text: str = ""
    voice: str = "es-MX-DaliaNeural"
    rate: str = "+0%"


def error(mensaje: str, status: int) -> JSONResponse:
    return JSONResponse({"error": mensaje}, status_code=status)


@app.get("/salud")
def salud():
    return {"ok": True, "voces": VOCES_PERMITIDAS}


@app.post("/tts")
async def tts(p: Peticion):
    texto = p.text.strip()

    if not texto:
        return error("No mandaste texto.", 400)
    if len(texto) > LIMITE_CARACTERES:
        return error(
            f"El bloque tiene {len(texto)} caracteres y el maximo es "
            f"{LIMITE_CARACTERES}. Partelo antes de enviarlo.",
            413,
        )
    if p.voice not in VOCES_PERMITIDAS:
        return error(f'La voz "{p.voice}" no esta en la lista.', 400)

    rate = p.rate if len(p.rate) <= 5 and p.rate[:1] in "+-" and p.rate.endswith("%") else "+0%"

    try:
        comunicador = edge_tts.Communicate(texto, p.voice, rate=rate)
        audio = bytearray()
        async for trozo in comunicador.stream():
            if trozo["type"] == "audio":
                audio.extend(trozo["data"])
    except Exception as e:  # noqa: BLE001 - se devuelve el motivo al frontend
        return error(f"Fallo la sintesis: {e}", 502)

    if not audio:
        return error("El servicio no devolvio audio.", 502)

    return Response(
        content=bytes(audio),
        media_type="audio/mpeg",
        headers={"Cache-Control": "no-store"},
    )
