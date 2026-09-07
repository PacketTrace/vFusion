# MCP

*Browse the tools a Model Context Protocol server exposes: what it can do, what each call takes, and what the server tells a model about itself.*

**Where:** the **MCP** item in the nav. Two tabs: Server and History.

No model is in the loop. vFusion is a plain MCP client. Nothing you look at here costs tokens or leaves your network except the calls to the server itself.

## Server

- **Zero new credentials.** Verkada's MCP server accepts the same org API key vFusion already holds, as a bearer token. Pick the Verkada connection and the catalog loads.
- **Every tool, badged honestly**: read-only, writes, or destructive, from the server's own annotations. "Not destructive" is not "read-only", so the three states are kept apart.
- **Playbooks.** Verkada's server ships skill documents behind `list_verkada_skills` and `load_verkada_skill`; they are rendered here so you can read them before a model does.
- **The server's instructions block** is shown as sent, since it is what a model would be told.
- **Freshness and health** in the third column: when the catalog was last fetched, whether the handshake is succeeding, and uptime rather than a tally.

## History

MCP publishes no timestamps. A tool entry carries only its name, description, schema and annotations, and Verkada's server reports its version as `dev`. So "when was this tool added" can only be answered by looking repeatedly and writing down what moved.

The worker checks every configured server on a schedule. The History tab shows tools by the date they first appeared, tools whose schema changed, and tools the server took away. Tools present at the first observation are marked *original* rather than given a fabricated date.

## How it is built

- `backend/app/connectors/mcp/client.py` — the four-message exchange (initialize, initialized, tools/list, tools/call) over Streamable HTTP, accepting JSON or SSE framing.
- `backend/app/connectors/mcp/history.py` and `health.py` — file-backed on the assets volume, no migration.
- `backend/app/connectors/mcp/poll.py` — the scheduled check-in.
