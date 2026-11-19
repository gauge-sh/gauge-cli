"""Portable, immutable web fixtures. No control plane or response transformations."""
import json
from ipaddress import ip_address
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from mitmproxy import http


def normalize(value):
    # Match the hosted fixture contract: preserve escaped path/query bytes.
    if not isinstance(value, str) or not value.isascii() or any(ord(c) <= 32 for c in value):
        raise ValueError("Invalid web fixture URL")
    p = urlsplit(value)
    if (p.scheme not in ("http", "https") or not p.hostname or p.username is not None or p.password is not None
            or p.port not in (None, 443 if p.scheme == "https" else 80)):
        raise ValueError("Expected an HTTP(S) URL without credentials")
    host = p.hostname.lower()
    if ":" in host:
        host = "[" + host + "]"
    result = urlunsplit((p.scheme, host, p.path or "/", p.query, ""))
    if not p.query and value.split("#", 1)[0].endswith("?"):
        result += "?"
    return result


def origin(url):
    p = urlsplit(url)
    return p.scheme + "://" + p.netloc


def within(url, scope):
    p, base = urlsplit(url), urlsplit(scope)
    prefix = base.path.rstrip("/")
    return origin(url) == origin(scope) and (p.path == prefix or p.path.startswith(prefix + "/"))


# Never allow credentials to change transport framing or proxy routing.
FORBIDDEN_HEADERS = {
    "host", "connection", "proxy-connection", "keep-alive", "transfer-encoding",
    "content-length", "te", "trailer", "upgrade", "proxy-authorization",
    "proxy-authenticate", "expect", "forwarded", "via",
}


class Connections:
    def __init__(self, config=None):
        if config is None:
            path = Path("/gateway/private/connections.json")
            config = json.loads(path.read_bytes()) if path.exists() else {"version": 1, "connections": []}
        if (not isinstance(config, dict) or set(config) != {"version", "connections"}
                or type(config["version"]) is not int or config["version"] != 1
                or not isinstance(config["connections"], list)):
            raise ValueError("Invalid connections contract")
        self.headers = {}
        names = set()
        for entry in config["connections"]:
            if not isinstance(entry, dict) or set(entry) != {"name", "origin", "header", "value"}:
                raise ValueError("Invalid connection entry")
            name, url, header, value = (entry[k] for k in ("name", "origin", "header", "value"))
            if not all(isinstance(v, str) and v for v in (name, url, header, value)):
                raise ValueError("Invalid connection fields")
            if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", name) or name in names:
                raise ValueError("Invalid or duplicate connection name")
            names.add(name)
            try:
                p = urlsplit(url)
                valid = (url.isascii() and not any(ord(c) <= 32 or ord(c) == 127 for c in url)
                         and p.scheme == "https" and p.hostname and not p.username and p.password is None
                         and "@" not in p.netloc and p.port in (None, 443)
                         and not p.path and not p.query and not p.fragment
                         and "?" not in url and "#" not in url
                         and re.fullmatch(r"[A-Za-z0-9.:-]+", p.hostname)
                         and not p.netloc.endswith(":"))
            except ValueError:
                valid = False
            if valid:
                try:
                    ip_address(p.hostname)
                except ValueError:
                    pass
                else:
                    valid = False
            if not valid:
                raise ValueError("Connection requires an exact HTTPS DNS origin on port 443")
            if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", header) or header.lower() in FORBIDDEN_HEADERS or header.lower().startswith("x-forwarded-"):
                raise ValueError("Invalid connection header")
            if not re.fullmatch(r"[\x20-\x7e]+", value) or not value.strip():
                raise ValueError("Invalid connection header value")
            headers = self.headers.setdefault(p.hostname.lower(), {})
            if header.lower() in headers:
                raise ValueError("Duplicate connection header")
            headers[header.lower()] = value

    def inject(self, flow):
        request = flow.request
        if flow.response is not None or request.scheme != "https" or request.port != 443:
            return
        # Transparent mode exposes the original destination IP in request.host.
        # SNI identifies the TLS origin; mitmproxy verifies its upstream certificate.
        client = getattr(flow, "client_conn", None)
        server = getattr(flow, "server_conn", None)
        if not client or not client.tls or not client.sni or server is None:
            return
        host = client.sni.lower()
        headers = self.headers.get(host)
        if not headers:
            return
        if server.sni is not None and server.sni.lower() != host:
            return
        if getattr(server, "timestamp_tls_setup", None) is not None and server.sni is None:
            return
        # Absolute-form HTTP/1 targets can route through an upstream proxy
        # independently of Host. They are outside this local origin contract.
        if request.authority and not (request.is_http2 or request.is_http3):
            return
        if (not request.path.startswith("/") or any(ord(c) <= 32 or ord(c) == 127 for c in request.path)):
            return
        host_values = request.headers.get_all("host")
        if len(host_values) > 1:
            return
        if (request.is_http2 or request.is_http3) and host_values:
            if host_values[0].lower() != request.authority.lower():
                return
        authority = request.host_header
        if not authority or not authority.isascii() or any(ord(c) <= 32 or ord(c) == 127 for c in authority):
            return
        try:
            parsed = urlsplit("https://" + authority)
            if (parsed.hostname != host or parsed.port not in (None, 443)
                    or parsed.username is not None or parsed.password is not None
                    or parsed.path or parsed.query or parsed.fragment
                    or any(c in authority for c in "/?#@") or authority.endswith(":")):
                return
        except ValueError:
            return
        server.sni = host
        request.headers.update(headers)


class Fixtures:
    def __init__(self, fixture=None, connections=None):
        self.connections = connections if connections is not None else Connections()
        if fixture is None:
            raw = Path("/gateway/fixture.json").read_bytes()
            if len(raw) > 1_000_000:
                raise ValueError("Web fixture exceeds 1 MB")
            fixture = json.loads(raw)
        if set(fixture) - {"version", "pages", "origins", "scopes", "searches"} or fixture.get("version") != 1 or fixture.get("searches", []):
            raise ValueError("Unsupported web fixture contract")
        self.pages = {}
        for page in fixture.get("pages", []):
            if set(page) != {"url", "body", "status", "contentType"}:
                raise ValueError("Expected a compiled page fixture")
            url = normalize(page["url"])
            p = urlsplit(url)
            if p.scheme != "https" or p.port or url in self.pages:
                raise ValueError("Invalid or duplicate page URL")
            if type(page["status"]) is not int or not 200 <= page["status"] <= 599 or not isinstance(page["body"], str):
                raise ValueError("Invalid fixture response")
            if not isinstance(page["contentType"], str) or not re.fullmatch(r"[\x20-\x7e]+", page["contentType"]):
                raise ValueError("Invalid content type")
            page["body"].encode("utf-8")
            if page["status"] in (204, 205, 304) and page["body"]:
                raise ValueError("Status requires an empty body")
            self.pages[url] = page
        self.scopes = [normalize(s) for s in fixture.get("scopes", [])]
        self.origins = {}
        for route in fixture.get("origins", []):
            if set(route) != {"origin", "upstream"}:
                raise ValueError("Invalid origin mapping")
            source, target = (normalize(route[k]) for k in ("origin", "upstream"))
            for value in (source, target):
                p = urlsplit(value)
                if p.scheme != "https" or p.port or p.path != "/" or p.query:
                    raise ValueError("Expected an HTTPS origin")
            source, target = origin(source), origin(target)
            if source == target or source in self.origins or any(origin(u) == source for u in [*self.pages, *self.scopes]):
                raise ValueError("Overlapping fixture routes")
            self.origins[source] = target
        for index, scope in enumerate(self.scopes):
            p = urlsplit(scope)
            if p.scheme != "https" or p.port or p.query or not any(origin(u) == origin(scope) for u in self.pages):
                raise ValueError("Invalid fixture scope")
            if any(within(scope, other) or within(other, scope) for other in self.scopes[:index]):
                raise ValueError("Overlapping fixture scopes")

    def running(self):
        Path("/gateway/private/connections-ready").write_text("1\n")
        Path("/gateway/private/ready").write_text("ready\n")

    def event(self, flow, action, **extra):
        # Only intervention evidence, never ordinary traffic bodies or headers.
        print(json.dumps({"at": datetime.now(timezone.utc).isoformat(), "action": action,
                          "url": flow.metadata["fixture_url"], "method": flow.request.method, **extra}), flush=True)

    def reply(self, flow, status, body, content_type="text/plain", action="hit"):
        # Synthetic fixtures are GET/HEAD representations. Reject body-bearing
        # requests at headers, without reading or buffering an unbounded upload.
        if flow.request.headers.get("transfer-encoding") or flow.request.headers.get("content-length", "0") != "0":
            self.event(flow, "body-denied")
            flow.kill()
            return
        encoded = body.encode("utf-8")
        flow.request.stream = False
        flow.response = http.Response.make(status, b"" if flow.request.method == "HEAD" else encoded,
            {"Content-Type": content_type, "Cache-Control": "no-store", "X-Gauge-Fixture": action})
        flow.response.headers["Content-Length"] = str(len(encoded))
        if status in (204, 304):
            flow.response.headers.pop("Content-Length", None)
        flow.metadata["fixture_reply"] = True
        self.event(flow, action, status=status)

    def requestheaders(self, flow):
        flow.request.stream = True
        try:
            url = normalize(flow.request.pretty_url)
        except ValueError:
            return
        flow.metadata["fixture_url"] = url
        source = origin(url)
        if source in self.origins:
            target = urlsplit(self.origins[source])
            flow.request.scheme = target.scheme
            flow.request.host = target.hostname
            flow.request.port = 443
            flow.request.host_header = target.netloc
            self.event(flow, "rewrite", target=flow.request.pretty_url)
            return
        page = self.pages.get(url)
        if page is not None and flow.request.method in ("GET", "HEAD"):
            self.reply(flow, page["status"], page["body"], page["contentType"])
        elif any(within(url, scope) for scope in self.scopes):
            self.reply(flow, 404, "Fixture missing within scope", action="blocked")
        else:
            self.connections.inject(flow)

    def responseheaders(self, flow):
        flow.response.stream = not flow.metadata.get("fixture_reply", False)


addons = [Fixtures()] if Path("/gateway/fixture.json").exists() else []
