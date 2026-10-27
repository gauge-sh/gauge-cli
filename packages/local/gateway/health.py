"""Startup barrier: configuration loaded, public CA generated, listener bound."""
import socket
from pathlib import Path

assert Path("/gateway/private/ready").is_file()
assert Path("/gateway/private/mitmproxy-ca-cert.pem").is_file()
with socket.create_connection(("127.0.0.1", 8080), timeout=1):
    pass
