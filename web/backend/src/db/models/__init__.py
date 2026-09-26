"""数据库 ORM 模型集合（导入即注册到 Base.metadata）."""

from db.models.agent import Agent
from db.models.agent_mcp_config import AgentMcpConfig
from db.models.agent_skill import AgentSkill
from db.models.agent_tool import AgentTool
from db.models.ai_model import AIModel
from db.models.announcement import Announcement, AnnouncementRead
from db.models.automation import AutomationRun, AutomationTask
from db.models.chat_artifact import ChatArtifact
from db.models.chat_attachment import ChatAttachment
from db.models.chat_usage import ChatUsage
from db.models.conversation import Conversation
from db.models.cron_job import CronJob
from db.models.data_scope import DataScope
from db.models.department import Department
from db.models.expert import Expert
from db.models.expert_mcp_config import ExpertMcpConfig
from db.models.expert_skill import ExpertSkill
from db.models.expert_tool import ExpertTool
from db.models.expert_version import ExpertVersion
from db.models.knowledge_base import KnowledgeBase
from db.models.knowledge_base_document import KnowledgeBaseDocument
from db.models.knowledge_base_entity import KnowledgeBaseEntity
from db.models.knowledge_base_group import KnowledgeBaseGroup
from db.models.knowledge_base_relation import KnowledgeBaseRelation
from db.models.knowledge_base_share import KnowledgeBaseShare
from db.models.login_record import LoginRecord
from db.models.mcp_installation import McpInstallation
from db.models.mcp_tool import McpTool
from db.models.notification import Notification
from db.models.oauth2_client import OAuth2Client
from db.models.oauth2_consent import OAuth2Consent
from db.models.oauth2_refresh_token import OAuth2RefreshToken
from db.models.permission_resource import PermissionResource
from db.models.personnel import Personnel
from db.models.provider import Provider
from db.models.role import Role
from db.models.role_permission import RolePermission
from db.models.skill import Skill
from db.models.system_event import SystemEvent
from db.models.system_param import SystemParam
from db.models.tool import Tool
from db.models.user import Account
from db.models.user_oauth import UserOAuth
from db.models.user_role import UserRole

__all__ = [
    "ChatArtifact",
    "ChatAttachment",
    "ChatUsage",
    "Agent",
    "AgentSkill",
    "AgentTool",
    "AutomationRun",
    "AutomationTask",
    "Announcement",
    "AnnouncementRead",
    "AgentMcpConfig",
    "Expert",
    "ExpertMcpConfig",
    "ExpertSkill",
    "ExpertTool",
    "ExpertVersion",
    "AIModel",
    "Conversation",
    "CronJob",
    "DataScope",
    "Department",
    "KnowledgeBase",
    "KnowledgeBaseDocument",
    "KnowledgeBaseEntity",
    "KnowledgeBaseRelation",
    "KnowledgeBaseShare",
    Notification,
    "LoginRecord",
    "McpInstallation",
    "McpTool",
    "OAuth2Client",
    "OAuth2Consent",
    "OAuth2RefreshToken",
    "PermissionResource",
    "Personnel",
    "Provider",
    "Role",
    "RolePermission",
    "Skill",
    "SystemEvent",
    "SystemParam",
    "Tool",
    "Account",
    "UserOAuth",
    "UserRole",
]
