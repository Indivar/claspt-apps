# Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
# Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.
import json
import sys
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from claspt import Claspt, ClasptError, parse_reference
from claspt.references import SecretReference
from claspt.tools import tool_specs


class FakeApi(BaseHTTPRequestHandler):
    """A loopback stand-in for the desktop: records requests, answers from a table."""

    calls = []
    responses = {}

    def _reply(self, status, body, headers=None):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _handle(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"null") if length else None
        FakeApi.calls.append((self.command, self.path, body, self.headers.get("Authorization"), self.headers.get("If-Match")))
        key = (self.command, self.path.split("?")[0])
        status, payload, headers = FakeApi.responses.get(key, (404, {"message": "no route"}, None))
        self._reply(status, payload, headers)

    do_GET = do_POST = do_PUT = _handle

    def log_message(self, *args):
        pass


class ClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeApi)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.client = Claspt(token="clss_test", port=cls.server.server_address[1])

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        FakeApi.calls.clear()
        FakeApi.responses.clear()

    def test_token_is_required_and_read_from_the_environment(self):
        import os
        os.environ.pop("CLASPT_API_TOKEN", None)
        with self.assertRaises(ClasptError):
            Claspt()
        os.environ["CLASPT_API_TOKEN"] = "clsn_env"
        try:
            self.assertEqual(Claspt().token, "clsn_env")
        finally:
            del os.environ["CLASPT_API_TOKEN"]

    def test_memory_calls_hit_the_right_routes_with_the_bearer_token(self):
        FakeApi.responses[("PUT", "/api/memory/proj")] = (200, {"meta": {"title": "decisions"}}, {"etag": "2026-01-01T00:00:00Z"})
        FakeApi.responses[("GET", "/api/memory/proj/session-log")] = (200, {"content": "x", "reviewed": False}, None)
        FakeApi.responses[("GET", "/api/memory/search")] = (200, {"ranking": "fulltext", "hits": []}, None)
        page = self.client.memory_upsert("decisions", "# D", "proj", tags=["a"], kind="semantic", if_match="e1")
        self.assertEqual(page["etag"], "2026-01-01T00:00:00Z")
        read = self.client.memory_read("session-log", "proj", max_bytes=100, tail=True)
        self.assertEqual(read["content"], "x")
        self.client.memory_search("db", ["proj", "global"], limit=3)
        methods = [(c[0], c[1]) for c in FakeApi.calls]
        self.assertEqual(methods[0], ("PUT", "/api/memory/proj"))
        self.assertEqual(FakeApi.calls[0][2]["kind"], "semantic")
        self.assertEqual(FakeApi.calls[0][4], "e1")
        self.assertEqual(FakeApi.calls[0][3], "Bearer clss_test")
        self.assertEqual(methods[1], ("GET", "/api/memory/proj/session-log?max_bytes=100&tail=true"))
        self.assertIn("namespaces=proj%2Cglobal", methods[2][1])

    def test_read_secret_by_reference_picks_the_block_and_field(self):
        FakeApi.responses[("GET", "/api/pages/ai%2Fstripe.md/secret")] = (
            200,
            {"items": [{"label": "Live", "fields": {"api_key": "sk"}}, {"label": "Test", "fields": {"api_key": "tk"}}]},
            None,
        )
        got = self.client.read_secret(reference="claspt://secret/ai/stripe.md?block=Test#api_key")
        self.assertEqual(got["value"], "tk")
        self.assertEqual(got["reference"], "claspt://secret/ai/stripe.md?block=Test#api_key")
        with self.assertRaises(ClasptError) as e:
            self.client.read_secret(reference="claspt://secret/ai/stripe.md#api_key")
        self.assertEqual(e.exception.status, 409)
        with self.assertRaises(ClasptError) as e:
            self.client.read_secret(reference="claspt://secret/ai/stripe.md?block=Live#nope")
        self.assertEqual(e.exception.status, 404)
        FakeApi.responses[("GET", "/api/pages/ai%2Fx.md/secret")] = (200, {"items": [{"label": "A", "fields": {"redacted": True}}]}, None)
        with self.assertRaises(ClasptError) as e:
            self.client.read_secret(reference="claspt://secret/ai/x.md#k")
        self.assertEqual(e.exception.status, 403)

    def test_refusals_carry_the_status_and_message(self):
        FakeApi.responses[("GET", "/api/audit/rotation")] = (403, {"message": "Secrets token required"}, None)
        with self.assertRaises(ClasptError) as e:
            self.client.rotation_due()
        self.assertEqual(e.exception.status, 403)
        self.assertIn("Secrets token", e.exception.message)
        unreachable = Claspt(token="x", port=1)
        with self.assertRaises(ClasptError) as e:
            unreachable.status()
        self.assertEqual(e.exception.status, 0)


class ReferenceTests(unittest.TestCase):
    def test_round_trip_and_errors(self):
        ref = SecretReference(page="credentials/my page.md", field="API Key", block="Prod & Co")
        self.assertEqual(parse_reference(ref.to_uri()), ref)
        self.assertEqual(parse_reference("claspt://secret/ai/a.md#token"), SecretReference("ai/a.md", "token"))
        for bad in ["https://x", "claspt://secret/a.md", "claspt://secret/#f", "claspt://secret/a.md?label=x#f"]:
            with self.assertRaises(ValueError):
                parse_reference(bad)


class ToolTests(unittest.TestCase):
    def test_specs_share_one_definition_and_adapters_map_it(self):
        client = Claspt(token="t", port=1)
        specs = tool_specs(client, "proj")
        self.assertEqual([s.name for s in specs], ["memory_read", "memory_upsert", "memory_search", "find_secrets", "read_secret", "store_secret"])
        for spec in specs:
            self.assertTrue(spec.description)
            self.assertTrue(set(spec.required) <= set(spec.parameters))
        # A stand-in for langchain_core so the adapter's wiring is exercised
        # without the dependency installed.
        fake = types.ModuleType("langchain_core.tools")
        made = []

        class StructuredTool:
            @staticmethod
            def from_function(func, name, description):
                made.append((name, description, func))
                return name

        fake.StructuredTool = StructuredTool
        sys.modules["langchain_core"] = types.ModuleType("langchain_core")
        sys.modules["langchain_core.tools"] = fake
        try:
            from claspt.adapters.langchain import tools
            names = tools(client, "proj")
        finally:
            del sys.modules["langchain_core.tools"]
            del sys.modules["langchain_core"]
        self.assertEqual(names, [s.name for s in specs])
        self.assertEqual(made[0][1], specs[0].description)


if __name__ == "__main__":
    unittest.main()
