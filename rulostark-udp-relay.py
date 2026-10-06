#!/usr/bin/env python3
"""Relay UDP CSI de los ESP32 hacia el servidor RuView dentro de colima.

colima no reenvía puertos UDP publicados, así que el tráfico va así:

  ESP32 --UDP:5005--> Mac (modo host) --TCP 127.0.0.1:5008--> sidecar
  (modo sidecar, en la red del contenedor rulostark-rust) --UDP--> 127.0.0.1:5005

El servidor sigue escuchando UDP solo en loopback. Identifica cada nodo por
el node_id dentro del frame, no por la IP de origen.

Uso:
  python3 rulostark-udp-relay.py host     # en la Mac
  python3 rulostark-udp-relay.py sidecar  # dentro del contenedor auxiliar
"""
import ipaddress
import socket
import struct
import sys
import threading
import time
from collections import Counter

UDP_PORT = 5005
TCP_PORT = 5008
MAX_DATAGRAM = 65535
# Solo se aceptan orígenes de redes privadas (LAN); nunca IPs públicas.
ALLOWED = [ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")]


def run_host():
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
    udp.bind(("0.0.0.0", UDP_PORT))
    print(f"[relay] escuchando UDP 0.0.0.0:{UDP_PORT} -> TCP 127.0.0.1:{TCP_PORT}", flush=True)

    tcp = None
    stats, dropped, lock = Counter(), Counter(), threading.Lock()

    def report():
        while True:
            time.sleep(10)
            with lock:
                fwd, drp = dict(stats), dict(dropped)
                stats.clear()
                dropped.clear()
            if fwd or drp:
                parts = [f"{ip}={n} frames ({n / 10:.1f}/s)" for ip, n in sorted(fwd.items())]
                print(f"[relay] ultimos 10s: {' '.join(parts) or 'sin frames'}"
                      + (f" | descartados: {drp}" if drp else ""), flush=True)
            else:
                print("[relay] ultimos 10s: ningun ESP32 enviando", flush=True)

    threading.Thread(target=report, daemon=True).start()

    while True:
        data, (ip, _port) = udp.recvfrom(MAX_DATAGRAM)
        if not any(ipaddress.ip_address(ip) in net for net in ALLOWED):
            with lock:
                dropped[ip] += 1
            continue
        if tcp is None:
            try:
                tcp = socket.create_connection(("127.0.0.1", TCP_PORT), timeout=2)
                tcp.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                print("[relay] conectado al sidecar", flush=True)
            except OSError as exc:
                with lock:
                    dropped["sidecar-caido"] += 1
                if dropped["sidecar-caido"] == 1:
                    print(f"[relay] sidecar no disponible ({exc}); reintentando", flush=True)
                continue
        try:
            tcp.sendall(struct.pack("!H", len(data)) + data)
            with lock:
                stats[ip] += 1
        except OSError as exc:
            print(f"[relay] conexion con sidecar perdida ({exc}); reconectando", flush=True)
            tcp.close()
            tcp = None


def run_sidecar():
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", TCP_PORT))
    srv.listen(4)
    print(f"[sidecar] TCP :{TCP_PORT} -> UDP 127.0.0.1:{UDP_PORT}", flush=True)

    def recv_exact(conn, n):
        buf = b""
        while len(buf) < n:
            chunk = conn.recv(n - len(buf))
            if not chunk:
                return None
            buf += chunk
        return buf

    def handle(conn, addr):
        print(f"[sidecar] relay conectado desde {addr}", flush=True)
        with conn:
            while True:
                hdr = recv_exact(conn, 2)
                if hdr is None:
                    break
                payload = recv_exact(conn, struct.unpack("!H", hdr)[0])
                if payload is None:
                    break
                udp.sendto(payload, ("127.0.0.1", UDP_PORT))
        print("[sidecar] relay desconectado", flush=True)

    while True:
        conn, addr = srv.accept()
        threading.Thread(target=handle, args=(conn, addr), daemon=True).start()


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "host":
        run_host()
    elif mode == "sidecar":
        run_sidecar()
    else:
        sys.exit("uso: rulostark-udp-relay.py host|sidecar")
