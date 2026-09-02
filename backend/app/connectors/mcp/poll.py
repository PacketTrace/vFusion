"""Scheduled check-in with each configured MCP server.

Without this, the tool history only advances when somebody opens the MCP
page — so a tool Verkada shipped on Tuesday would be dated whenever you
next happened to look. The worker calls this on a cron so "added <date>"
means roughly when it appeared, not when you noticed.

Cheap: one handshake plus a tools/list per connection, and it writes to
the same JSON file on the shared webhook_assets volume that the API
reads.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select

from app.connectors.mcp.client import MCPError, describe_server
from app.connectors.mcp.history import record
from app.connectors.verkada.client import normalize_base_url
from app.crypto import decrypt_secret
from app.db import SessionLocal
from app.models import Connection


logger = logging.getLogger(__name__)


async def poll_all_connections() -> list[dict[str, Any]]:
    """Refresh tool history for every configured Verkada org.

    One entry per connection describing what happened, so a failure on
    one org is visible without stopping the others.
    """
    results: list[dict[str, Any]] = []
    async with SessionLocal() as session:
        conns = (
            (
                await session.execute(
                    select(Connection).where(
                        Connection.type == "verkada",
                        Connection.setup_complete.is_(True),
                    )
                )
            )
            .scalars()
            .all()
        )
        targets: list[tuple[str, str, str]] = []
        for conn in conns:
            try:
                secret = decrypt_secret(conn.encrypted_secret)
            except Exception as e:  # noqa: BLE001 — one bad row shouldn't stop the sweep
                results.append({"connection": conn.name, "error": f"decrypt: {e}"})
                continue
            token = secret.get("api_key")
            if not token:
                results.append({"connection": conn.name, "skipped": "no api_key"})
                continue
            url = f"{normalize_base_url(secret.get('region') or None)}/mcp"
            targets.append((conn.name, url, token))

    # Network work happens outside the DB session — no reason to hold a
    # connection open across an HTTP round trip.
    for name, url, token in targets:
        try:
            described = await describe_server(url, token)
        except MCPError as e:
            results.append({"connection": name, "url": url, "error": str(e)})
            continue
        except Exception as e:  # noqa: BLE001 — network/DNS/TLS
            results.append({"connection": name, "url": url, "error": repr(e)})
            continue
        summary = await record(url, described.get("tools") or [])
        results.append(
            {
                "connection": name,
                "url": url,
                "tools": len(described.get("tools") or []),
                **summary,
            }
        )
        logger.info(
            "mcp poll %s: %d tools, last_changed=%s, new_30d=%s",
            url,
            len(described.get("tools") or []),
            summary.get("last_changed_at"),
            summary.get("new_tools_30d"),
        )
    return results
