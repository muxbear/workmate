"""系统设置接口集成测试.

单独装配一个只挂载系统设置路由的 FastAPI 应用并注入内存数据库与内存版产物
存储（真实实现会往 ARTIFACT_ROOT 写文件，测试不应触碰磁盘）。

注意两类错误响应的形状不同，断言时要分开：

- 端点**函数体内**抛出的 HTTPException 会被 `handle_errors` 吞掉，
  返回 HTTP 200 + ``{"code": 400, "message": ...}``；
- **依赖**（`RequirePermission`）抛出的 HTTPException 发生在函数被调用之前，
  走 FastAPI 默认处理器，返回真正的 HTTP 403 + ``{"detail": ...}``。
"""

from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from api.deps import get_current_user_id, get_db
from api.settings.settings_api import admin_router
from api.settings.settings_api import router as settings_router
from db.base import Base

pytestmark = pytest.mark.anyio

USER_ID = "user-settings"
SYSTEM_PREFIX = "/api/settings"
ADMIN_PREFIX = "/api/admin/settings"

# 1x1 透明 PNG 的文件头 + 填充，足够让魔数嗅探识别
PNG_BYTES = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * 64
JUNK_BYTES = b"definitely not an image"
UNSAFE_SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
SAFE_SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>'


class FakeArtifactStore:
    """内存版产物存储，避免测试触碰真实磁盘."""

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.deleted: list[str] = []

    def save(self, key: str, content: bytes) -> None:
        """写入对象."""
        self.files[key] = content

    def open(self, key: str) -> bytes | None:
        """读取对象，不存在返回 None."""
        return self.files.get(key)

    def exists(self, key: str) -> bool:
        """判断对象是否存在."""
        return key in self.files

    def delete(self, key: str) -> None:
        """删除对象并记录，供断言清理行为."""
        self.deleted.append(key)
        self.files.pop(key, None)


@pytest_asyncio.fixture
async def fake_store() -> FakeArtifactStore:
    """内存产物存储实例."""
    return FakeArtifactStore()


@pytest_asyncio.fixture
async def session_maker() -> AsyncGenerator[async_sessionmaker[AsyncSession], None]:
    """内存库会话工厂."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture
async def api_client(
    session_maker: async_sessionmaker[AsyncSession],
    fake_store: FakeArtifactStore,
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[AsyncClient, None]:
    """内存数据库 + 放行权限 + 内存产物存储的测试客户端."""

    async def override_db() -> AsyncGenerator[AsyncSession, None]:
        async with session_maker() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    async def override_user() -> str:
        return USER_ID

    async def fake_payload(request: object) -> dict[str, str]:
        return {"sub": USER_ID, "role": "super_admin"}

    async def allow(
        db: AsyncSession,
        user_id: str,
        perm_key: str,
        role_key: str | None = None,
    ) -> bool:
        return True

    monkeypatch.setattr("api.rbac.deps.get_current_token_payload", fake_payload)
    monkeypatch.setattr("api.rbac.deps.check_user_permission", allow)
    monkeypatch.setattr("api.settings.service.get_artifact_store", lambda: fake_store)

    app = FastAPI()
    app.include_router(settings_router)
    app.include_router(admin_router)
    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user_id] = override_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


async def test_system_identity_defaults(api_client: AsyncClient) -> None:
    """未配置时公开接口返回默认系统名称与空 LOGO."""
    response = await api_client.get(f"{SYSTEM_PREFIX}/system")
    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 0
    assert body["data"]["systemName"] == "Ke-Work"
    assert body["data"]["logoUrl"] is None


async def test_update_system_name(api_client: AsyncClient) -> None:
    """改名后公开接口读到新值（camelCase 字段）."""
    update = await api_client.put(
        f"{ADMIN_PREFIX}/system", json={"systemName": "  我的工作台  "}
    )
    assert update.status_code == 200
    assert update.json()["data"]["systemName"] == "我的工作台"

    reread = await api_client.get(f"{SYSTEM_PREFIX}/system")
    assert reread.json()["data"]["systemName"] == "我的工作台"


@pytest.mark.parametrize(
    ("name", "message"),
    [
        ("   ", "系统名称不能为空"),
        ("x" * 25, "系统名称不能超过 24 个字符"),
        ("带\n换行", "系统名称不能包含换行或制表等控制字符"),
    ],
)
async def test_system_name_validation(
    api_client: AsyncClient, name: str, message: str
) -> None:
    """非法系统名称被拒绝，且返回可读的中文提示."""
    response = await api_client.put(f"{ADMIN_PREFIX}/system", json={"systemName": name})
    body = response.json()
    assert body["code"] == 400
    assert body["message"] == message


async def test_system_name_accepts_exactly_24_chars(api_client: AsyncClient) -> None:
    """24 字是闭区间上界，不应被拒."""
    response = await api_client.put(
        f"{ADMIN_PREFIX}/system", json={"systemName": "y" * 24}
    )
    assert response.json()["code"] == 0
    assert response.json()["data"]["systemName"] == "y" * 24


async def test_logo_upload_serve_and_reset(
    api_client: AsyncClient, fake_store: FakeArtifactStore
) -> None:
    """上传后公开接口可读回字节；恢复默认后文件被删除且接口 404."""
    upload = await api_client.post(
        f"{ADMIN_PREFIX}/system/logo",
        files={"file": ("logo.png", PNG_BYTES, "image/png")},
    )
    assert upload.json()["code"] == 0
    assert upload.json()["data"]["logoUrl"] == f"{SYSTEM_PREFIX}/system/logo"
    assert len(fake_store.files) == 1

    served = await api_client.get(f"{SYSTEM_PREFIX}/system/logo")
    assert served.status_code == 200
    assert served.content == PNG_BYTES
    assert served.headers["content-type"] == "image/png"
    assert served.headers["x-content-type-options"] == "nosniff"

    reset = await api_client.delete(f"{ADMIN_PREFIX}/system/logo")
    assert reset.json()["data"]["logoUrl"] is None
    assert not fake_store.files
    assert len(fake_store.deleted) == 1

    missing = await api_client.get(f"{SYSTEM_PREFIX}/system/logo")
    assert missing.json()["code"] == 404


async def test_logo_upload_replaces_previous_file(
    api_client: AsyncClient, fake_store: FakeArtifactStore
) -> None:
    """重新上传会删掉旧文件，不留孤儿对象."""
    await api_client.post(
        f"{ADMIN_PREFIX}/system/logo",
        files={"file": ("a.png", PNG_BYTES, "image/png")},
    )
    first_key = next(iter(fake_store.files))

    await api_client.post(
        f"{ADMIN_PREFIX}/system/logo",
        files={"file": ("b.svg", SAFE_SVG, "image/svg+xml")},
    )
    assert len(fake_store.files) == 1
    assert first_key in fake_store.deleted


@pytest.mark.parametrize(
    ("filename", "content", "message"),
    [
        ("x.txt", JUNK_BYTES, "仅支持 PNG / JPG / WEBP / SVG 格式的图片"),
        ("x.svg", UNSAFE_SVG, "SVG 中包含不安全的脚本或事件属性"),
        ("empty.png", b"", "LOGO 文件为空"),
    ],
)
async def test_logo_upload_rejects_invalid(
    api_client: AsyncClient,
    fake_store: FakeArtifactStore,
    filename: str,
    content: bytes,
    message: str,
) -> None:
    """格式不符与危险 SVG 均被拒绝，且不落盘."""
    response = await api_client.post(
        f"{ADMIN_PREFIX}/system/logo", files={"file": (filename, content, "image/png")}
    )
    assert response.json()["code"] == 400
    assert response.json()["message"] == message
    assert not fake_store.files


async def test_logo_upload_rejects_oversize(
    api_client: AsyncClient, fake_store: FakeArtifactStore
) -> None:
    """超过 1MB 被拒绝；不放进 parametrize——1MB 的 repr 会撑爆
    Windows 上 PYTEST_CURRENT_TEST 环境变量的长度上限."""
    oversize = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * (1024 * 1024)
    response = await api_client.post(
        f"{ADMIN_PREFIX}/system/logo",
        files={"file": ("huge.png", oversize, "image/png")},
    )
    assert response.json()["code"] == 400
    assert response.json()["message"] == "LOGO 大小不能超过 1MB"
    assert not fake_store.files


async def test_preferences_defaults_and_partial_update(
    api_client: AsyncClient,
) -> None:
    """未设置时返回默认值；部分更新只影响传入字段."""
    initial = await api_client.get(f"{SYSTEM_PREFIX}/preferences")
    assert initial.json()["data"] == {
        "language": "zh-CN",
        "fontSize": 17,
        "clientNotifications": True,
        "notificationSound": "none",
    }

    updated = await api_client.put(
        f"{SYSTEM_PREFIX}/preferences", json={"fontSize": 20}
    )
    data = updated.json()["data"]
    assert data["fontSize"] == 20
    assert data["language"] == "zh-CN"
    assert data["notificationSound"] == "none"

    again = await api_client.put(
        f"{SYSTEM_PREFIX}/preferences",
        json={"language": "en", "notificationSound": "soft", "clientNotifications": False},
    )
    data = again.json()["data"]
    assert data["language"] == "en"
    assert data["notificationSound"] == "soft"
    assert data["clientNotifications"] is False
    assert data["fontSize"] == 20  # 上一次设置保持不变


async def test_preferences_reject_out_of_range_font_size(
    api_client: AsyncClient,
) -> None:
    """字号超出 12–24 被拒绝，并返回中文提示."""
    response = await api_client.put(
        f"{SYSTEM_PREFIX}/preferences", json={"fontSize": 99}
    )
    body = response.json()
    assert body["code"] == 400
    assert body["message"] == "字号必须在 12–24 之间"
