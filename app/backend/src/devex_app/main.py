from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routes import blueprint, chat, plan
from .settings import get_settings


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="DevEx Platform UI Backend", version="0.1.0")

    # Frontend dev server (Next.js) runs on :3000; backend on :8088.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000"],
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health() -> dict[str, object]:
        return {
            "ok": True,
            "tofu_root": str(settings.tofu_root),
            "model": settings.anthropic_model,
            "anthropic_key_set": bool(settings.anthropic_api_key),
        }

    app.include_router(chat.router, prefix="/api")
    app.include_router(plan.router, prefix="/api")
    app.include_router(blueprint.router, prefix="/api")
    return app


app = create_app()
