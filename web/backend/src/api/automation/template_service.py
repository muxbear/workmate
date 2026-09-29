"""定时任务模板业务服务.

模板是自动化任务的一份完整预设：新建任务时可以把模板的字段原样拷进 `AutomationTask`。
因此这里的字段归一化与校验直接复用 `api/automation/service.py` 的口径
（`validate_schedule_bounds` / `dedupe` / `build_freq_summary`），避免两套规则漂移。

版本号语义与专家一致：**客户端传了就用客户端的，没传才由服务端兜底**——
新建兜底 `1.0.0`，更新兜底「递增次版本」。
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.automation.schedule import build_freq_summary, build_validity_summary
from api.automation.schemas import AutomationSchedule
from api.automation.service import dedupe, validate_schedule_bounds
from api.automation.template_schemas import (
    AutomationTemplateDraft,
    AutomationTemplateListResponse,
    AutomationTemplateResponse,
)
from api.params.service import (
    SCHEDULE_TEMPLATE_TYPE_PARENT_CODE,
    list_param_options,
)
from core.pagination import PageIterator
from core.versioning import DEFAULT_VERSION, bump_minor
from db.models.automation import AutomationTemplate, now_ms

logger = logging.getLogger(__name__)


async def list_template_types(db: AsyncSession) -> list[dict[str, str]]:
    """读取可选的模板类型，供「定时模板」页面渲染筛选与表单下拉。

    取值来自「参数配置」的 ``schedule_template_type`` 分组——**不回退**内置默认值，
    管理员清空即筛选为空（「以参数配置为唯一来源」的既定口径）。
    """
    return await list_param_options(db, SCHEDULE_TEMPLATE_TYPE_PARENT_CODE)


def _normalize(draft: AutomationTemplateDraft) -> dict[str, Any]:
    """把请求草稿转换为可落库字段（不含版本号，版本由调用方决定）。."""
    validate_schedule_bounds(draft.schedule)
    return {
        "name": draft.name.strip(),
        "description": (draft.description or "").strip(),
        "icon": (draft.icon or "⏰").strip() or "⏰",
        "category": (draft.category or "").strip(),
        "prompt_text": (draft.prompt_text or "").strip(),
        "prompt_parts": [
            part.model_dump(by_alias=True, exclude_none=True)
            for part in draft.prompt_parts
        ],
        "schedule": draft.schedule.model_dump(by_alias=True),
        "freq_summary": build_freq_summary(draft.schedule),
        "validity_summary": build_validity_summary(draft.schedule),
        "model": draft.model,
        "custom_model_id": draft.custom_model_id,
        "provider_id": draft.provider_id,
        "model_id": draft.model_id,
        "expert_id": draft.expert_id,
        "expert_name": draft.expert_name,
        "context_mode": draft.context_mode,
        "skill_ids": dedupe(draft.skill_ids, 50),
        "kb_ids": dedupe(draft.kb_ids, 20),
        "workspace_id": draft.workspace_id,
        "workspace_name": draft.workspace_name,
        "allow_network": draft.allow_network,
        "allow_shell": draft.allow_shell,
        "full_access": draft.full_access,
    }


async def list_templates(
    db: AsyncSession,
    page: int = 1,
    page_size: int = 20,
    keyword: str | None = None,
    category: str | None = None,
) -> AutomationTemplateListResponse:
    """分页列出模板，支持名称/描述搜索与类型筛选。."""
    query = select(AutomationTemplate)
    count_query = select(func.count()).select_from(AutomationTemplate)

    conditions: list[Any] = []
    if category:
        conditions.append(AutomationTemplate.category == category)
    if keyword:
        like = f"%{keyword.strip()}%"
        conditions.append(
            or_(
                AutomationTemplate.name.ilike(like),
                AutomationTemplate.description.ilike(like),
            )
        )
    for condition in conditions:
        query = query.where(condition)
        count_query = count_query.where(condition)

    pager = PageIterator(
        query=query.order_by(AutomationTemplate.created_at.desc()),
        count_query=count_query,
        db=db,
        page_size=page_size,
    )
    result = await pager.get_page(page=page)
    return AutomationTemplateListResponse(
        items=[
            AutomationTemplateResponse.model_validate(item) for item in result.items
        ],
        total=result.total,
        page=result.page,
        page_size=result.page_size,
    )


async def get_template_model(
    db: AsyncSession, template_id: str
) -> AutomationTemplate:
    """按 id 取模板 ORM 对象，不存在则 404。."""
    result = await db.execute(
        select(AutomationTemplate).where(AutomationTemplate.id == template_id)
    )
    template = result.scalar_one_or_none()
    if template is None:
        raise HTTPException(status_code=404, detail="模板不存在或已被删除")
    return template


async def get_template(
    db: AsyncSession, template_id: str
) -> AutomationTemplateResponse:
    """按 id 取模板。."""
    return AutomationTemplateResponse.model_validate(
        await get_template_model(db, template_id)
    )


async def create_template(
    db: AsyncSession, draft: AutomationTemplateDraft, user_id: str
) -> AutomationTemplateResponse:
    """新建模板；未指定版本号时从 1.0.0 起步。."""
    template = AutomationTemplate(
        **_normalize(draft),
        version=draft.version or DEFAULT_VERSION,
        created_by=user_id,
    )
    db.add(template)
    await db.flush()
    await db.refresh(template)
    return AutomationTemplateResponse.model_validate(template)


async def update_template(
    db: AsyncSession, template_id: str, draft: AutomationTemplateDraft
) -> AutomationTemplateResponse:
    """更新模板；未指定版本号时默认递增次版本（1.2.3 -> 1.3.0）。."""
    template = await get_template_model(db, template_id)
    for field, value in _normalize(draft).items():
        setattr(template, field, value)
    # 客户端（编辑弹窗）默认会把次版本号算好一起提交并允许手工改；
    # 只有没传版本号时才由服务端兜底，避免把手工调高的版本号回退掉。
    template.version = draft.version or bump_minor(template.version)
    await db.flush()
    await db.refresh(template)
    return AutomationTemplateResponse.model_validate(template)


async def delete_template(db: AsyncSession, template_id: str) -> None:
    """软删除模板（模型带 deleted_at，查询会被自动过滤）。."""
    template = await get_template_model(db, template_id)
    template.deleted_at = now_ms()
    await db.flush()


# ── 内置模板种子 ─────────────────────────────────────────────

#: 单次任务的模板占位日期：模板本身不参与调度，前端由模板生成任务时会把
#: `cycle_kind == "once"` 的日期替换成「当天」（与改造前 `createDefaultSchedule()`
#: 用 `localDate()` 兜底的行为一致），这里只需要一个能过校验的合法值。
_ONCE_PLACEHOLDER_OFFSET_DAYS = 1

#: 12 条内置模板。`freq` 是改造前前端写死的展示文案，**必须原样保留**：
#: 第 10、11 条的文案与 `build_freq_summary()` 的计算结果不同（「工作日 每2h」
#: vs「每隔 2 小时执行 1 次」），重算会改变界面上已有的文案。
_BUILTIN_TEMPLATES: list[dict[str, Any]] = [
    {
        "name": "每日 AI 新闻推送",
        "description": "关注当天 AI 领域的重要动态，侧重产品与技术突破",
        "icon": "📰",
        "category": "news",
        "freq": "每天 08:00",
        "schedule": {"cycleKind": "daily", "onceTime": "08:00"},
    },
    {
        "name": "每日 5 个英语单词",
        "description": "每天推荐 5 个高频实用英语单词，配例句与记忆技巧",
        "icon": "🔤",
        "category": "learning",
        "freq": "每天 07:30",
        "schedule": {"cycleKind": "daily", "onceTime": "07:30"},
    },
    {
        "name": "每日儿童睡前故事",
        "description": "生成 3-5 分钟可读的温和睡前故事，适合亲子共读",
        "icon": "🌙",
        "category": "life",
        "freq": "每天 20:30",
        "schedule": {"cycleKind": "daily", "onceTime": "20:30"},
    },
    {
        "name": "每周工作周报",
        "description": "每周五汇总仓库 PR 与 Issue 进展，自动生成周报草稿",
        "icon": "📋",
        "category": "work",
        "freq": "每周五 18:00",
        "schedule": {"cycleKind": "weekly", "weekDays": [5], "onceTime": "18:00"},
    },
    {
        "name": "经典电影推荐",
        "description": "推荐一部高分经典电影，简要介绍背景与观影理由",
        "icon": "🎬",
        "category": "fun",
        "freq": "每周三 12:00",
        "schedule": {"cycleKind": "weekly", "weekDays": [3], "onceTime": "12:00"},
    },
    {
        "name": "历史上的今天",
        "description": "从科技、电影、音乐等领域挑选一件有趣的历史事件",
        "icon": "📅",
        "category": "learning",
        "freq": "每天 09:00",
        "schedule": {"cycleKind": "daily", "onceTime": "09:00"},
    },
    {
        "name": "每日一个为什么",
        "description": "每天提出一个有趣问题，先提问再揭晓答案，启发思考",
        "icon": "💡",
        "category": "learning",
        "freq": "每天 10:00",
        "schedule": {"cycleKind": "daily", "onceTime": "10:00"},
    },
    {
        "name": "父母联系提醒",
        "description": "每周日 10:00 提醒你给家人打电话，珍惜家人时光",
        "icon": "📞",
        "category": "life",
        "freq": "每周日 10:00",
        "schedule": {"cycleKind": "weekly", "weekDays": [7], "onceTime": "10:00"},
    },
    {
        "name": "体检预约提醒",
        "description": "在指定时间提醒你确认体检预约，提前做好准备",
        "icon": "🏥",
        "category": "life",
        "freq": "单次 07:00",
        "schedule": {"cycleKind": "once", "onceTime": "07:00"},
    },
    {
        "name": "面试准备提醒",
        "description": "工作日每 2 小时提醒你复习大模型相关知识点",
        "icon": "💼",
        "category": "work",
        "freq": "工作日 每2h",
        "schedule": {
            "freqGroup": "interval",
            "intervalKind": "hourly",
            "hourInterval": 2,
        },
    },
    {
        "name": "会议前准备",
        "description": "在会议开始前提醒你整理议题，目标与所需材料",
        "icon": "📝",
        "category": "work",
        "freq": "会前 15min",
        "schedule": {
            "freqGroup": "interval",
            "intervalKind": "hourly",
            "hourInterval": 1,
        },
    },
    {
        "name": "可爱萌宠手机壁纸",
        "description": "随机从 7 种风格中挑选一种，生成今日专属萌宠壁纸",
        "icon": "🐱",
        "category": "fun",
        "freq": "每天 07:00",
        "schedule": {"cycleKind": "daily", "onceTime": "07:00"},
    },
]


def _template_schedule(patch: dict[str, Any]) -> dict[str, Any]:
    """在默认排期上覆盖差异字段，得到一份完整的排期配置.

    对齐改造前前端的 `templateSchedule()`（`createDefaultSchedule()` + 覆盖）。
    """
    today = date.today()
    base: dict[str, Any] = {
        "freqGroup": "cycle",
        "cycleKind": "daily",
        "intervalKind": "hourly",
        "onceDate": today.isoformat(),
        "onceTime": "08:00",
        "weekDays": [1],
        "monthDay": 1,
        "yearMonth": 1,
        "yearDay": 1,
        "weekIntervalDays": [1],
        "hourInterval": 2,
        "validityMode": "forever",
        "validFrom": today.isoformat(),
        "validFromTime": "00:00",
        "validTo": (today + timedelta(days=30)).isoformat(),
        "validToTime": "23:59",
    }
    base.update(patch)
    if base["freqGroup"] == "cycle" and base["cycleKind"] == "once":
        # 单次任务必须有日期才能通过校验；模板里的这个日期只是占位。
        base["onceDate"] = (
            today + timedelta(days=_ONCE_PLACEHOLDER_OFFSET_DAYS)
        ).isoformat()
    return base


async def seed_builtin_task_templates(db: AsyncSession) -> None:
    """初始化内置定时任务模板（幂等）。

    表非空即跳过——这些模板只是「开箱可用」的起点，管理员改过/删过之后
    不应该被重新塞回来。搬迁前它们硬编码在 web 前端的 `types/automation.ts` 里。
    """
    existing = await db.execute(select(func.count()).select_from(AutomationTemplate))
    if int(existing.scalar() or 0) > 0:
        return

    for item in _BUILTIN_TEMPLATES:
        schedule = AutomationSchedule.model_validate(
            _template_schedule(item["schedule"])
        )
        draft = AutomationTemplateDraft(
            name=item["name"],
            description=item["description"],
            icon=item["icon"],
            category=item["category"],
            prompt_text=item["description"],
            prompt_parts=[{"type": "text", "text": item["description"]}],
            schedule=schedule,
        )
        payload = _normalize(draft)
        # 用改造前的展示文案覆盖计算值，保证界面文案不发生变化。
        payload["freq_summary"] = item["freq"]
        db.add(
            AutomationTemplate(
                **payload,
                version=DEFAULT_VERSION,
                created_by="",
            )
        )
    logger.info("已初始化内置定时任务模板（%d 条）", len(_BUILTIN_TEMPLATES))
