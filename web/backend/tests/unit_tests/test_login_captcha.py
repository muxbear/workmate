"""登录滑块验证（MVP）单元测试。"""

import json

import pytest
from fastapi import HTTPException

from api.auth import service as auth_service
from core.cache import MemoryCache


class _EmptyResult:
    """模拟查不到账号的查询结果。"""

    def scalar_one_or_none(self):
        return None


class _FakeDB:
    """最小数据库替身，只覆盖登录分支用到的接口。"""

    async def execute(self, *args, **kwargs):
        return _EmptyResult()

    def add(self, obj):
        pass


async def _seed_fails(store, account, count):
    """写入指定次数的登录失败计数。"""
    for _ in range(count):
        await auth_service._incr_fail(account, store)


@pytest.fixture
def store():
    return MemoryCache()


@pytest.mark.asyncio
async def test_challenge_required_after_threshold(store, monkeypatch):
    """失败次数达到阈值后，挑战接口应返回 required=True。"""
    monkeypatch.setattr(auth_service.settings, "LOGIN_CAPTCHA_AFTER_FAILS", 3)
    assert (await auth_service.get_login_challenge_svc("alice", store)).required is False
    await _seed_fails(store, "alice", 3)
    info = await auth_service.get_login_challenge_svc("alice", store)
    assert info.required is True
    assert info.failCount == 3


@pytest.mark.asyncio
async def test_login_without_ticket_is_rejected(store, monkeypatch):
    """需要验证但未携带票据时，登录直接返回 428。"""
    monkeypatch.setattr(auth_service.settings, "LOGIN_CAPTCHA_AFTER_FAILS", 3)
    await _seed_fails(store, "alice", 3)
    req = auth_service.AccountLoginRequest(account="alice", password="cipher")
    with pytest.raises(HTTPException) as exc:
        await auth_service.account_login(req, _FakeDB(), store, ip="1.2.3.4")
    assert exc.value.status_code == 428


@pytest.mark.asyncio
async def test_ticket_is_bound_to_account_and_ip(store):
    """票据绑定账号与 IP，不匹配即作废且不可复用。"""
    await store.set(
        "login:ticket:t1",
        json.dumps({"randstr": "r1", "account": "alice", "ip": "1.2.3.4"}),
        ttl=120,
    )
    with pytest.raises(HTTPException) as exc:
        await auth_service._consume_login_ticket("t1", "r1", "bob", "1.2.3.4", store)
    assert exc.value.status_code == 428
    assert await store.get("login:ticket:t1") is None


@pytest.mark.asyncio
async def test_ticket_is_single_use(store, monkeypatch):
    """同一票据只能消费一次，重放会被拒绝。"""
    monkeypatch.setattr(auth_service.settings, "LOGIN_CAPTCHA_AFTER_FAILS", 3)
    monkeypatch.setattr(auth_service, "decrypt_password", lambda value: "plain")
    await _seed_fails(store, "alice", 3)
    await store.set(
        "login:ticket:t2",
        json.dumps({"randstr": "r2", "account": "alice", "ip": "1.2.3.4"}),
        ttl=120,
    )
    req = auth_service.AccountLoginRequest(
        account="alice",
        password="cipher",
        captchaTicket="t2",
        captchaRandstr="r2",
    )
    with pytest.raises(HTTPException) as exc:
        await auth_service.account_login(req, _FakeDB(), store, ip="1.2.3.4")
    assert exc.value.status_code == 401
    assert await store.get("login:ticket:t2") is None
    with pytest.raises(HTTPException) as replay:
        await auth_service.account_login(req, _FakeDB(), store, ip="1.2.3.4")
    assert replay.value.status_code == 428
