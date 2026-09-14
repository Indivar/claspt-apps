# Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
# Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.
"""The HTTP client. Standard library only, so it can go anywhere an agent runs."""

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, List, Optional

from .references import parse_reference

DEFAULT_PORT = 9315


class ClasptError(Exception):
    """A refused or failed request. `status` is the HTTP status, 0 when the
    desktop could not be reached."""

    def __init__(self, status: int, message: str):
        super().__init__(f"{status}: {message}" if status else message)
        self.status = status
        self.message = message


class Claspt:
    def __init__(
        self,
        token: Optional[str] = None,
        port: Optional[int] = None,
        base_url: Optional[str] = None,
        timeout: float = 60.0,
    ):
        self.token = token or os.environ.get("CLASPT_API_TOKEN", "")
        if not self.token:
            raise ClasptError(0, "no token: pass token= or set CLASPT_API_TOKEN")
        port = port or int(os.environ.get("CLASPT_API_PORT", DEFAULT_PORT))
        # The host is never configurable: the API is a loopback service.
        self.base_url = base_url or f"http://127.0.0.1:{port}"
        self.timeout = timeout

    # ── transport ────────────────────────────────────────────

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Any:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
                if not raw:
                    return None
                parsed = json.loads(raw)
                etag = resp.headers.get("etag")
                if etag and isinstance(parsed, dict):
                    parsed.setdefault("etag", etag)
                return parsed
        except urllib.error.HTTPError as e:
            with e:
                text = e.read().decode(errors="replace")
            try:
                message = json.loads(text).get("message", text)
            except (ValueError, AttributeError):
                message = text
            raise ClasptError(e.code, message or e.reason) from None
        except urllib.error.URLError as e:
            raise ClasptError(0, f"cannot reach Claspt at {self.base_url}: {e.reason}") from None

    # ── status ───────────────────────────────────────────────

    def status(self) -> Dict[str, Any]:
        return self.request("GET", "/api/status")

    # ── memory ───────────────────────────────────────────────

    def memory_guide(self) -> str:
        return self.request("GET", "/api/memory/guide")["guide"]

    def memory_list(self, namespace: str, tag: Optional[str] = None) -> List[Dict[str, Any]]:
        path = f"/api/memory/{urllib.parse.quote(namespace, safe='')}"
        if tag:
            path += "?tag=" + urllib.parse.quote(tag, safe="")
        return self.request("GET", path)

    def memory_read(
        self,
        title: str,
        namespace: str,
        max_bytes: Optional[int] = None,
        tail: bool = False,
    ) -> Dict[str, Any]:
        path = f"/api/memory/{urllib.parse.quote(namespace, safe='')}/{urllib.parse.quote(title, safe='')}"
        params = []
        if max_bytes is not None:
            params.append(f"max_bytes={int(max_bytes)}")
        if tail:
            params.append("tail=true")
        if params:
            path += "?" + "&".join(params)
        return self.request("GET", path)

    def memory_upsert(
        self,
        title: str,
        content: str,
        namespace: str,
        tags: Iterable[str] = (),
        kind: Optional[str] = None,
        if_match: Optional[str] = None,
        **fields: Any,
    ) -> Dict[str, Any]:
        body = {"title": title, "content": content, "tags": list(tags)}
        if kind:
            body["kind"] = kind
        body.update({k: v for k, v in fields.items() if v is not None})
        headers = {"If-Match": if_match} if if_match else None
        return self.request("PUT", f"/api/memory/{urllib.parse.quote(namespace, safe='')}", body, headers)

    def memory_append(self, title: str, text: str, namespace: str, if_match: Optional[str] = None) -> Dict[str, Any]:
        path = f"/api/memory/{urllib.parse.quote(namespace, safe='')}/{urllib.parse.quote(title, safe='')}/append"
        headers = {"If-Match": if_match} if if_match else None
        return self.request("POST", path, {"text": text}, headers)

    def memory_search(self, query: str, namespaces: Iterable[str] = (), limit: int = 10) -> Dict[str, Any]:
        params = {"q": query, "limit": str(limit)}
        ns = ",".join(namespaces)
        if ns:
            params["namespaces"] = ns
        return self.request("GET", "/api/memory/search?" + urllib.parse.urlencode(params))

    def memory_verify(self, title: str, namespace: str) -> Dict[str, Any]:
        path = f"/api/memory/{urllib.parse.quote(namespace, safe='')}/{urllib.parse.quote(title, safe='')}/verify"
        return self.request("POST", path, {})

    def memory_compact(self, title: str, namespace: str, keep_sections: int = 10) -> Dict[str, Any]:
        path = f"/api/memory/{urllib.parse.quote(namespace, safe='')}/{urllib.parse.quote(title, safe='')}/compact"
        return self.request("POST", path, {"keep_sections": keep_sections})

    # ── secrets ──────────────────────────────────────────────

    def find_secrets(self, query: Optional[str] = None) -> List[Dict[str, Any]]:
        path = "/api/secrets"
        if query:
            path += "?q=" + urllib.parse.quote(query, safe="")
        return self.request("GET", path)

    def store_secret(
        self,
        service: str,
        label: str,
        fields: Dict[str, str],
        tags: Iterable[str] = (),
    ) -> Dict[str, Any]:
        body = {"service": service, "label": label, "fields": fields, "tags": list(tags), "agent_ns": "sdk"}
        return self.request("POST", "/api/secrets", body)

    def read_secret(self, page: Optional[str] = None, reference: Optional[str] = None) -> Dict[str, Any]:
        """A page's secret blocks (`{"items": [...]}`), or with `reference` one
        field's value (`{"reference": ..., "value": ...}`). The owner may be
        asked to approve; a refusal is a ClasptError with status 403."""
        if reference:
            ref = parse_reference(reference)
            listing = self.request("GET", f"/api/pages/{urllib.parse.quote(ref.page, safe='')}/secret")
            blocks = listing.get("items", [])
            if ref.block is not None:
                blocks = [b for b in blocks if b.get("label") == ref.block]
                if not blocks:
                    raise ClasptError(404, f"page {ref.page} has no secret block '{ref.block}'")
            if len(blocks) != 1:
                labels = ", ".join(b.get("label", "") for b in blocks)
                raise ClasptError(409, f"page {ref.page} has {len(blocks)} secret blocks; add ?block=<label> ({labels})")
            fields = blocks[0].get("fields", {})
            if fields.get("redacted") is True:
                raise ClasptError(403, "this token has Notes scope; a reference needs a Secrets-scope token")
            if ref.field not in fields:
                raise ClasptError(404, f"secret block has no field '{ref.field}' (fields: {', '.join(fields)})")
            return {"reference": ref.to_uri(), "value": fields[ref.field]}
        if not page:
            raise ClasptError(0, "read_secret needs page= or reference=")
        return self.request("GET", f"/api/pages/{urllib.parse.quote(page, safe='')}/secret")

    # ── audits ───────────────────────────────────────────────

    def audit_secrets(self) -> List[Dict[str, Any]]:
        return self.request("GET", "/api/audit/secrets")

    def rotation_due(self) -> Dict[str, Any]:
        return self.request("GET", "/api/audit/rotation")
