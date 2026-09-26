"""知识库的部门 / 角色维度授权（迭代 6 T6.3）。

与用户分享的区别是**生命周期**：授权"立即生效、无需接受"，撤销是软撤（留痕），
也没有账号可以 join——正因如此它单独一张表，而不是往分享表加 ``target_type``
（混表后每处既有查询都要补 ``target_type='user'`` 过滤，漏一处就是部门行混进
"已分享用户"列表并被人当成邀请接受）。

``target_id`` 对角色存的是 **``Role.key``**（不是 ``role.id``）：key 与 JWT claim、
``resolve_dept_scope(role_key)``、``check_user_permission`` 同源，跨环境重建角色行
也不会失配。对部门存 ``Department.id``，``include_subtree`` 决定是否含子部门——
**读时展开**，所以新建子部门会自动被覆盖，不需要回填。
"""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base

#: 授权对象类型
GRANT_TARGET_DEPT = "dept"
GRANT_TARGET_ROLE = "role"


class KnowledgeBaseGrant(Base):
    __tablename__ = "knowledge_base_grants"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    kb_id: Mapped[str] = mapped_column(String(36), nullable=False)
    target_type: Mapped[str] = mapped_column(
        String(16), nullable=False, comment="dept|role",
    )
    target_id: Mapped[str] = mapped_column(
        String(64), nullable=False, comment="dept=Department.id；role=Role.key",
    )
    include_subtree: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True,
        comment="仅 dept 有意义：是否含子部门（读时展开）",
    )
    permission: Mapped[str] = mapped_column(
        String(16), nullable=False, default="read", comment="read|write",
    )
    created_by: Mapped[str] = mapped_column(String(36), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
