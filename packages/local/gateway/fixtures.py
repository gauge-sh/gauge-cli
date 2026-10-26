"""Portable, immutable web fixtures. No control plane or response transformations."""
import json
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


class Fixtures:
    def __init__(self, fixture=None):
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

    def responseheaders(self, flow):
        flow.response.stream = not flow.metadata.get("fixture_reply", False)


addons = [Fixtures()] if Path("/gateway/fixture.json").exists() else []
