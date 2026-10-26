"""Hermetic TLS origin used only by Docker qualification tests."""
import json
import ssl
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b"data: first\n\n")
            self.wfile.flush()
            time.sleep(3)
            self.wfile.write(b"data: last\n\n")
            return
        if self.path == "/large":
            self.send_response(200)
            self.send_header("Content-Length", str(12 * 1024 * 1024))
            self.end_headers()
            for _ in range(12):
                self.wfile.write(b"x" * 1024 * 1024)
            return
        body = json.dumps({"path": self.path, "host": self.headers["Host"]}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


server = ThreadingHTTPServer(("0.0.0.0", 443), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("/origin/cert.pem", "/origin/key.pem")
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
