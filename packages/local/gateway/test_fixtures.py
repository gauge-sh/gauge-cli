import unittest
from types import SimpleNamespace
from mitmproxy import http
from fixtures import Fixtures, normalize


def flow(url, method="GET", headers=None):
    return SimpleNamespace(request=http.Request.make(method, url, headers=headers or {}),
                           response=None, metadata={}, killed=False)


class GatewayFixtures(unittest.TestCase):
    def test_origin_rewrite_preserves_encoding_and_streams_both_directions(self):
        addon = Fixtures({"version": 1, "origins": [{"origin": "https://docs.example.com", "upstream": "https://preview.example.com"}]})
        f = flow("https://docs.example.com/a%2Fb?q=%2F&key=x")
        addon.requestheaders(f)
        self.assertEqual(f.request.url, "https://preview.example.com/a%2Fb?q=%2F&key=x")
        self.assertEqual(f.request.host_header, "preview.example.com")
        self.assertTrue(f.request.stream)
        f.response = http.Response.make(200, b"data: streamed event\n\n", {"content-type": "text/event-stream"})
        addon.responseheaders(f)
        self.assertTrue(f.response.stream)

    def test_passthrough_does_not_buffer_large_uploads_or_responses(self):
        addon = Fixtures({"version": 1})
        f = flow("https://api.example.com/inference", "POST", {"content-length": "100000000"})
        addon.requestheaders(f)
        self.assertTrue(f.request.stream)
        self.assertIsNone(f.response)
        f.response = http.Response.make(200)
        addon.responseheaders(f)
        self.assertTrue(f.response.stream)

    def test_pages_head_scopes_and_body_rejection(self):
        addon = Fixtures({"version": 1, "scopes": ["https://example.com/docs"], "pages": [
            {"url": "https://example.com/docs", "body": "café", "status": 200, "contentType": "text/plain"}]})
        f = flow("https://example.com/docs", "HEAD")
        addon.requestheaders(f)
        self.assertEqual(f.response.content, b"")
        self.assertEqual(f.response.headers["content-length"], "5")
        f = flow("https://example.com/docs/missing")
        addon.requestheaders(f)
        self.assertEqual(f.response.status_code, 404)
        f = flow("https://example.com/docs-other")
        addon.requestheaders(f)
        self.assertIsNone(f.response)
        f = flow("https://example.com/docs", "POST", {"transfer-encoding": "chunked"})
        f.kill = lambda: setattr(f, "killed", True)
        addon.requestheaders(f)
        self.assertTrue(f.killed)
        self.assertIsNone(f.response)

    def test_url_normalization_preserves_encoded_paths(self):
        for raw, expected in [
            ("https://EXAMPLE.com:443/docs#ignored", "https://example.com/docs"),
            ("https://example.com/a/%2e%2e/docs?", "https://example.com/a/%2e%2e/docs?"),
            ("https://example.com/a%2Fb?q=%2F", "https://example.com/a%2Fb?q=%2F"),
        ]:
            self.assertEqual(normalize(raw), expected)

    def test_unknown_features_and_overlapping_routes_fail_startup(self):
        for fixture in [
            {"version": 1, "transforms": {}},
            {"version": 1, "searches": [{"query": "x"}]},
            {"version": 1, "origins": [{"origin": "https://example.com", "upstream": "https://example.com"}]},
        ]:
            with self.assertRaises(ValueError):
                Fixtures(fixture)


if __name__ == "__main__":
    unittest.main()
