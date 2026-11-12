"""Resolve the official DeepSeek host in the isolated test server."""

import ipaddress
import socket

import httpx

from app.schemas.solution_ai import allowed_address
from app.services import ai, solution_ai


DEEPSEEK_HOST = "api.deepseek.com"
FAKE_IP_RANGE = ipaddress.ip_network("198.18.0.0/15")


def install() -> None:
    original = solution_ai.resolved_addresses

    def resolve(host, port, *, allow_private=False):
        try:
            return original(host, port, allow_private=allow_private)
        except ai.AIError as exc:
            if (
                host != DEEPSEEK_HOST
                or port != 443
                or allow_private
                or exc.code != "model_network"
            ):
                raise
            try:
                answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
                if not answers or not all(
                    ipaddress.ip_address(row[4][0]) in FAKE_IP_RANGE for row in answers
                ):
                    raise exc from None
                # Query only this public hostname. Never pass model credentials to DNS.
                response = httpx.get(
                    "https://dns.google/resolve",
                    params={"name": DEEPSEEK_HOST, "type": "A"},
                    timeout=5,
                    trust_env=False,
                    follow_redirects=False,
                )
                response.raise_for_status()
                result = response.json()
                if not isinstance(result, dict) or result.get("Status") != 0:
                    raise exc from None
                records = result.get("Answer")
                if not isinstance(records, list):
                    raise exc from None
                addresses = list(
                    dict.fromkeys(
                        row["data"]
                        for row in records
                        if isinstance(row, dict) and row.get("type") == 1
                    )
                )
                if not addresses or not all(
                    allowed_address(address)
                    and ipaddress.IPv4Address(address).is_global
                    for address in addresses
                ):
                    raise exc from None
                return addresses
            except (httpx.HTTPError, OSError, ValueError, TypeError, KeyError):
                raise exc from None

    solution_ai.resolved_addresses = resolve
