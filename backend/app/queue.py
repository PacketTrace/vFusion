"""arq pool helpers for the FastAPI side.

The worker has its own redis connection (via ``WorkerSettings``). The
backend enqueues jobs via a pool stored in ``app.state.arq_pool`` and
created in the FastAPI lifespan.
"""

from arq import create_pool
from arq.connections import ArqRedis, RedisSettings

from app.config import settings


async def make_pool() -> ArqRedis:
    return await create_pool(RedisSettings.from_dsn(settings.redis_url))
