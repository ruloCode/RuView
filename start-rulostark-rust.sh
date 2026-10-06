#!/usr/bin/env bash
# Arranca el servidor RuView en Rust (imagen Docker ruvnet/wifi-densepose).
# Fuente de datos: CSI_SOURCE en docker/.env (esp32 = nodos reales, simulated = demo sintética).
# UI + REST: http://localhost:3000   WebSocket: :3001   ESP32 UDP: :5005 en la Mac
# colima no reenvía UDP: rulostark-udp-relay.py (Mac) + sidecar llevan el UDP al contenedor.
# Detener: ./start-rulostark-rust.sh stop
set -euo pipefail
cd "$(dirname "$0")"

stop_all() {
  [ -f logs/udp-relay.pid ] && kill "$(cat logs/udp-relay.pid)" 2>/dev/null || true
  rm -f logs/udp-relay.pid
  docker rm -f rulostark-udp-sidecar rulostark-rust >/dev/null 2>&1 || true
}
if [ "${1:-}" = "stop" ]; then stop_all; echo "Detenido."; exit 0; fi

if ! docker info >/dev/null 2>&1; then
  echo "Iniciando Colima (motor Docker)..."
  colima start
fi

# Token de API local (docker/.env está en .gitignore)
if [ ! -f docker/.env ]; then
  umask 077
  printf 'RUVIEW_API_TOKEN=%s\nCSI_SOURCE=simulated\n' "$(openssl rand -hex 32)" > docker/.env
fi

stop_all
docker run -d --name rulostark-rust \
  --env-file docker/.env \
  -e RUST_LOG=info \
  -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 -p 127.0.0.1:5008:5008 \
  -v "$PWD/rulostark-escenario.html:/app/ui/escenario.html:ro" \
  -v "$PWD/rulostark-vendor:/app/ui/vendor:ro" \
  -v "$PWD/rulostark-web:/app/ui/rulostark:ro" \
  -v "$PWD/rulostark-web/observatory-original.html:/app/ui/observatory.html:ro" \
  --security-opt no-new-privileges:true --cap-drop ALL \
  --memory 1g --cpus 2 \
  ruvnet/wifi-densepose:latest >/dev/null

# Sidecar en la red del servidor: TCP :5008 -> UDP 127.0.0.1:5005
docker run -d --name rulostark-udp-sidecar \
  --network container:rulostark-rust \
  -v "$PWD/rulostark-udp-relay.py:/relay.py:ro" \
  --entrypoint python3 \
  --security-opt no-new-privileges:true --cap-drop ALL \
  --memory 128m \
  espressif/idf:v5.4 -u /relay.py sidecar >/dev/null

# Relay en la Mac: UDP 0.0.0.0:5005 (solo IPs privadas) -> TCP 127.0.0.1:5008
mkdir -p logs
nohup python3 -u rulostark-udp-relay.py host > logs/udp-relay.log 2>&1 &
echo $! > logs/udp-relay.pid

echo "Servidor Rust arrancando en contenedor 'rulostark-rust'."
echo ""
echo "  UI:     http://localhost:3000"
echo "  Demo:   http://localhost:3000/ui/escenario.html  (tecla F = pantalla completa)"
echo "  Sala3D: http://localhost:3000/ui/rulostark/sala3d.html"
echo "  Observ: http://localhost:3000/ui/rulostark/observatory.html  (Observatory con datos reales)"
echo "  Token:  $(grep '^RUVIEW_API_TOKEN=' docker/.env | cut -d= -f2)"
echo "          (pégalo en los ajustes rápidos de la UI, campo API token)"
echo "  IP Mac: $(ipconfig getifaddr en0 2>/dev/null || echo '?')  (target-ip de los ESP32, UDP 5005)"
echo "  Logs:   docker logs -f rulostark-rust   |   tail -f logs/udp-relay.log"
echo "  Parar:  ./start-rulostark-rust.sh stop"
