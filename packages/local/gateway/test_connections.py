import unittest
from fixtures import Connections, Fixtures
from test_fixtures import flow as base_flow
from types import SimpleNamespace
from urllib.parse import urlsplit

def flow(url, **kwargs):
    f = base_flow(url, **kwargs)
    if kwargs.get("headers"):
        for key, value in kwargs["headers"].items():
            f.request.headers[key] = value
    f.client_conn = SimpleNamespace(tls=url.startswith("https:"), sni=urlsplit(url).hostname)
    f.server_conn = SimpleNamespace(sni=None)
    return f


def config(**changes):
    entry = {"name": "example", "origin": "https://api.example.com",
             "header": "Authorization", "value": "Bearer test-only"}
    entry.update(changes)
    return {"version": 1, "connections": [entry]}


class GatewayConnections(unittest.TestCase):
    def test_validation(self):
        for origin in ("https://192.0.2.1", "https://[::1]", "http://api.example.com", "https://api.example.com/",
                       "https://api.example.com:444", "https://user@api.example.com",
                       "https://*.example.com", "https://api.example.com?",
                       "https://api.example.com#", "https://api.example.com/path"):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                Connections(config(origin=origin))
        for header in ("Host", "Connection", "Proxy-Authorization", "Content-Length", "bad header", "Forwarded", "Via", "X-Forwarded-Host"):
            with self.subTest(header=header), self.assertRaises(ValueError):
                Connections(config(header=header))
        for value in ("a\r\nb", "\x00", "\x7f", "é", "   "):
            with self.subTest(value=value), self.assertRaises(ValueError):
                Connections(config(value=value))
        for name in ("bad name", "_bad", ""):
            with self.assertRaises(ValueError):
                Connections(config(name=name))
        duplicate = config()
        duplicate["connections"].append(dict(duplicate["connections"][0], header="authorization"))
        with self.assertRaises(ValueError):
            Connections(duplicate)

    def test_transport_matching_and_replacement(self):
        connections = Connections(config())
        for url in ("http://api.example.com", "https://api.example.com:444",
                    "https://sub.api.example.com", "https://api.example.com.evil.test",
                    "https://other.example.com"):
            f = flow(url, headers={"Host": "api.example.com"})
            connections.inject(f)
            self.assertNotIn("authorization", f.request.headers)
        f = flow("https://api.example.com:443/x", headers={"Host": "other.example.com"})
        connections.inject(f)
        self.assertNotIn("authorization", f.request.headers)
        f.request.host = "192.0.2.10"
        f.request.host_header = "api.example.com"
        f.request.headers.add("Authorization", "old")
        f.request.headers.add("authorization", "older")
        connections.inject(f)
        self.assertEqual(f.request.headers.get_all("authorization"), ["Bearer test-only"])

    def test_transparent_tls_authority_binding(self):
        from mitmproxy import connection, http
        connections = Connections(config())
        for authority, sni, upstream_sni, expected in (
            ("api.example.com", "api.example.com", None, True),
            ("API.EXAMPLE.COM:443", "api.example.com", "api.example.com", True),
            ("other.example.com", "api.example.com", None, False),
            ("api.example.com", "other.example.com", None, False),
            ("api.example.com", "api.example.com", "other.example.com", False),
            ("api.example.com", None, None, False),
            ("api.example.com:444", "api.example.com", None, False),
        ):
            with self.subTest(authority=authority, sni=sni, upstream_sni=upstream_sni):
                client = connection.Client(peername=("127.0.0.1", 1234), sockname=("127.0.0.1", 8080))
                client.tls = True
                client.sni = sni
                server = connection.Server(address=("192.0.2.10", 443))
                server.tls = True
                server.sni = upstream_sni
                f = http.HTTPFlow(client, server)
                f.request = http.Request.make("GET", "https://192.0.2.10/path")
                f.request.host_header = authority
                connections.inject(f)
                self.assertEqual("authorization" in f.request.headers, expected)
                if expected:
                    self.assertEqual(server.sni, "api.example.com")

    def test_absolute_form_and_duplicate_authority_fail_closed(self):
        from mitmproxy.net.http.http1.read import read_request_head
        connections = Connections(config())
        for target in ("https://evil.example/secret", "https://api.example.com/secret"):
            f = flow("https://api.example.com/")
            f.request = read_request_head([
                ("GET " + target + " HTTP/1.1").encode(),
                b"Host: api.example.com",
            ])
            f.request.data.host = "192.0.2.10"
            f.request.data.port = 443
            f.request.scheme = "https"
            connections.inject(f)
            self.assertNotIn("authorization", f.request.headers)
        f = flow("https://api.example.com/")
        f.request.headers.add("Host", "evil.example")
        connections.inject(f)
        self.assertNotIn("authorization", f.request.headers)
        f = flow("https://api.example.com/")
        f.request.http_version = "HTTP/2.0"
        f.request.authority = "api.example.com"
        f.request.headers["Host"] = "evil.example"
        connections.inject(f)
        self.assertNotIn("authorization", f.request.headers)

    def test_http2_absolute_path_fails_closed(self):
        f = flow("https://api.example.com/")
        f.request.http_version = "HTTP/2.0"
        f.request.authority = "api.example.com"
        f.request.path = "https://evil.example/secret"
        Connections(config()).inject(f)
        self.assertNotIn("authorization", f.request.headers)

    def test_fixture_intervention_never_injects(self):
        connections = Connections(config())
        for source, target in (("https://api.example.com", "https://other.example.com"),
                               ("https://other.example.com", "https://api.example.com")):
            addon = Fixtures({"version": 1, "origins": [{"origin": source, "upstream": target}]}, connections)
            f = flow(source + "/")
            addon.requestheaders(f)
            self.assertNotIn("authorization", f.request.headers)
        addon = Fixtures({"version": 1, "pages": [{"url": "https://api.example.com/",
                         "body": "fixture", "status": 200, "contentType": "text/plain"}]}, connections)
        f = flow("https://api.example.com/")
        addon.requestheaders(f)
        self.assertNotIn("authorization", f.request.headers)


if __name__ == "__main__":
    unittest.main()
