from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import mqtt_config as mqtt_api
from app.api import onvif as onvif_api
from app.api import helix_demo as helix_demo_api
from app.api import flow_assist as flow_assist_api
from app.api import security as security_api
from app.api import rtsp as rtsp_api
from app.mqtt import ingest as mqtt_ingest
from app.rtsp import pump as rtsp_pump
from app.rtsp import settings as rtsp_settings
from app.api import (
    auth as auth_api,
    byoa,
    config as config_api,
    connections,
    flow_builder,
    flow_templates,
    flows,
    hooks,
    mcp as mcp_api,
    prompt_templates,
    runs,
    settings as settings_api,
    stats,
    taxonomy,
    triggers,
    verkada_catalog,
    verkada_resources,
    webhook_events,
)
from app.auth import SESSION_COOKIE, set_epoch, verify_session_token
from app.security.surface import PUBLIC_PATH_PREFIXES
from app.config import settings
from app.pricing.gemini import refresh_gemini_pricing
from app.queue import make_pool
from app.reclassify import reclassify_unknowns


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Resolve / auto-generate the Fernet key eagerly at boot so the
    # "I generated a new key" warning shows up in startup logs (vs
    # waiting for the first encryption op). Also catches volume-mount
    # or permission problems at boot rather than on first Connection
    # save.
    from app.crypto import _fernet
    _fernet()
    # Resolve the session signing key eagerly too, so a published-default
    # SECRET_KEY is reported in the startup logs rather than discovered
    # when somebody wonders why they were signed out.
    from app.security.keys import session_key_status

    session_key_status()
    # The session epoch backs "sign out everywhere". Verifying a cookie
    # runs on every request and must stay synchronous, so the value is
    # cached in-process and loaded once here.
    from app.settings_store import get_str as _get_setting

    _raw_epoch = await _get_setting("session_epoch")
    try:
        set_epoch(int(_raw_epoch or 0))
    except (TypeError, ValueError):
        set_epoch(0)
    # Re-classify unknowns against the latest taxonomy.
    await reclassify_unknowns()
    # Seed Gemini pricing so cost_for() has rows on first request, even
    # before the worker's daily cron runs for the first time.
    try:
        await refresh_gemini_pricing()
    except Exception:  # noqa: BLE001 — pricing failure must not block boot
        pass
    # arq pool for enqueuing flow runs.
    app.state.arq_pool = await make_pool()
    # Object-position ingest. Opt-in, and deliberately non-fatal: a broker
    # that is down must not stop the rest of the app from booting, so the
    # loop retries in the background and reports itself via /api/mqtt/status.
    if mqtt_ingest.enabled():
        mqtt_ingest.ingest.start()
    # The virtual camera, if it was left on. A Command Connector that was
    # watching before a restart is still watching after one, and the whole
    # point of the feature is that it does not have to notice.
    from app.rtsp import mediamtx as rtsp_mediamtx

    rtsp_mediamtx.ensure(rtsp_settings.get())
    if rtsp_settings.get().get("enabled"):
        rtsp_pump.pump.start()
    try:
        yield
    finally:
        await rtsp_pump.pump.stop()
        await mqtt_ingest.ingest.stop()
        await app.state.arq_pool.close()


from app.brand import BRAND_NAME

app = FastAPI(
    title=BRAND_NAME,
    version="0.3.0",
    lifespan=lifespan,
    # FastAPI mounts /docs, /redoc and /openapi.json by default. vFusion
    # does not serve them: nothing here consumes them, and they hand a
    # complete map of the API to anyone who can reach the host. The
    # schema is still generated in-process (``app.openapi()``); it is
    # simply not published over HTTP.
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Routes that bypass the session-cookie gate. Webhooks are public by
# design (signature-verified, not cookie-verified) and the auth + tiny
# public-config + health endpoints must work before the operator has
# anything resembling a session. The list itself lives in
# app/security/surface.py so the security page can render the real one.
_PUBLIC_PATH_PREFIXES = PUBLIC_PATH_PREFIXES


@app.middleware("http")
async def require_session(request: Request, call_next):
    """Enforce the admin session cookie on every non-public route.

    The frontend's ``AuthGate`` reads ``/api/auth/status`` first to
    decide whether to show the setup wizard, the login form, or the app
    proper. Any other request without a valid cookie gets a clean 401
    so the frontend can react (e.g. on session expiry mid-session).
    """
    # CORS preflight requests carry no cookies — let them through so
    # the actual request can be evaluated on its own merits.
    if request.method == "OPTIONS":
        return await call_next(request)
    path = request.url.path
    if any(path.startswith(p) for p in _PUBLIC_PATH_PREFIXES):
        return await call_next(request)
    token = request.cookies.get(SESSION_COOKIE)
    if not verify_session_token(token):
        return JSONResponse({"detail": "Not authenticated"}, status_code=401)
    return await call_next(request)


app.include_router(auth_api.router)
app.include_router(hooks.router)
app.include_router(webhook_events.router)
app.include_router(connections.router)
app.include_router(taxonomy.router)
app.include_router(flows.router)
app.include_router(runs.router)
app.include_router(verkada_resources.router)
app.include_router(verkada_catalog.router)
app.include_router(triggers.router)
app.include_router(stats.router)
app.include_router(prompt_templates.router)
app.include_router(flow_templates.router)
app.include_router(flow_builder.router)
app.include_router(byoa.router)
app.include_router(mcp_api.router)
app.include_router(config_api.router)
app.include_router(mqtt_api.router)
app.include_router(rtsp_api.router)
app.include_router(helix_demo_api.router)
app.include_router(onvif_api.router)
app.include_router(flow_assist_api.router)
app.include_router(security_api.router)
app.include_router(settings_api.router)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
