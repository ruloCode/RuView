#!/usr/bin/env bash
# Arranca RuView (rulostark) en modo simulado: API FastAPI (:8000) + UI web (:3000).
# Ctrl+C detiene ambos.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "Creando entorno virtual e instalando dependencias..."
  python3 -m venv .venv
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -r requirements.txt
fi
source .venv/bin/activate

for port in 8000 3000; do
  if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "El puerto $port ya está en uso. Libéralo y vuelve a intentar."; exit 1
  fi
done

mkdir -p logs
PYTHONPATH=archive/v1 uvicorn src.api.main:app --host 127.0.0.1 --port 8000 > logs/api.log 2>&1 &
API_PID=$!
python3 -m http.server 3000 --bind 127.0.0.1 --directory ui > logs/ui.log 2>&1 &
UI_PID=$!
trap 'echo; echo "Deteniendo..."; kill $API_PID $UI_PID 2>/dev/null' EXIT INT TERM

echo "Esperando la API..."
for _ in $(seq 1 30); do
  curl -sf -o /dev/null http://127.0.0.1:8000/health/live && break
  sleep 1
done

echo ""
echo "  UI:        http://localhost:3000"
echo "  API docs:  http://localhost:8000/docs"
echo "  Logs:      logs/api.log, logs/ui.log"
echo "  (Modo simulado: datos CSI sintéticos, no hay ESP32 conectado)"
echo ""
echo "Ctrl+C para detener."
wait
