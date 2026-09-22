import asyncio
from datetime import timedelta

import httpx
from code_interpreter import CodeInterpreter, SupportedLanguage
from deepagents.graph import logger
from opensandbox import Sandbox
from opensandbox.config import ConnectionConfig, ConnectionConfigSync
from opensandbox.models import NetworkPolicy, NetworkRule, WriteEntry
from opensandbox.sync import SandboxSync

from agent.config import settings
from agent.config.config import (
    SANDBOX_NETWORK_MODE_ALLOW_ALL,
    SANDBOX_NETWORK_MODE_DENY_ALL,
)


def merge_allowed_domains(
    configured: list[str] | None,
    extra: list[str] | None = None,
) -> list[str]:
    """合并配置白名单与附加域名：去重保序，并剔除空白项。"""
    merged: list[str] = []
    for domain in list(configured or []) + list(extra or []):
        value = str(domain).strip()
        if value and value not in merged:
            merged.append(value)
    return merged


def allow_network_rules(domains: list[str]) -> list[NetworkRule]:
    """把域名列表转换为 allow 规则。"""
    return [NetworkRule(action="allow", target=domain) for domain in domains]


def deny_network_rules(domains: list[str]) -> list[NetworkRule]:
    """把域名列表转换为 deny 规则（用于覆盖已下发的放行规则）。"""
    return [NetworkRule(action="deny", target=domain) for domain in domains]


def _default_network_policy(
    extra_domains: list[str] | None = None,
) -> NetworkPolicy:
    """按 SANDBOX_NETWORK_MODE 构建沙盒创建时的出网策略。

    - allow_all：默认放行全部域名，沙盒可不受限制访问网络；
    - deny_all：默认拒绝且不下发任何规则，沙盒完全不可访问网络；
    - whitelist：默认拒绝，仅放行 SANDBOX_ALLOWED_DOMAINS 内的域名。
    """
    mode = settings.sandbox_network_mode
    if mode == SANDBOX_NETWORK_MODE_ALLOW_ALL:
        return NetworkPolicy(defaultAction="allow", egress=[])
    if mode == SANDBOX_NETWORK_MODE_DENY_ALL:
        return NetworkPolicy(defaultAction="deny", egress=[])
    domains = merge_allowed_domains(
        settings.sandbox_allowed_domains_list, extra_domains
    )
    return NetworkPolicy(defaultAction="deny", egress=allow_network_rules(domains))


def create_sandboxsync(config=None, sandbox_id=None, image=None):
    """获取或创建 SandboxSync

    Args:
        config: ConnectionConfigSync
        sandbox_id: 可选，要连接的沙盒标识
        image: 可选，创建沙盒时使用的镜像
    """
    if not config:
        config = _get_config_sync()

    if sandbox_id:
        try:
            sandbox = SandboxSync.connect(
                sandbox_id=sandbox_id, connection_config=config
            )
            return sandbox
        except Exception as e:
            logger.error(f"连接到沙盒 {sandbox_id} 出错：{str(e)}")
            raise

    if not image:
        image = "sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/code-interpreter:v1.0.2"

    sandbox = SandboxSync.create(
        image=image,
        entrypoint=["/opt/opensandbox/code-interpreter.sh"],
        env={"PYTHON_VERSION": "3.11"},
        resource={"cpu": "2", "memory": "3Gi"},
        timeout=timedelta(minutes=10),  # 10 分钟不使用会停止沙盒
        connection_config=config,
        network_policy=_default_network_policy(),
    )

    return sandbox


async def create_sandbox(config=None, sandbox_id=None, image=None):
    """获取或创建 Sandbox

    Args:
        config: ConnectionConfig
        sandbox_id: 可选，要连接的沙盒标识
        image: 可选，创建沙盒时使用的镜像
    """
    if not config:
        config = _get_config()

    if sandbox_id:
        try:
            sandbox = await Sandbox.connect(
                sandbox_id=sandbox_id, connection_config=config
            )
            return sandbox
        except Exception as e:
            logger.error(f"连接到沙盒 {sandbox_id} 出错：{str(e)}")
            raise

    if not image:
        image = "sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/code-interpreter:v1.0.2"

    sandbox = await Sandbox.create(
        image=image,
        entrypoint=["/opt/opensandbox/code-interpreter.sh"],
        env={"PYTHON_VERSION": "3.11"},
        resource={"cpu": "2", "memory": "3Gi"},
        timeout=timedelta(minutes=10),
        connection_config=config,
        network_policy=_default_network_policy(),
    )

    return sandbox


def list_running_sandbox(config):
    """列出所有正在运行的沙盒"""
    raise NotImplementedError("list_running_sandbox 尚未实现")


def _get_config_sync():
    """获取沙盒连接配置，优先从环境变量读取。"""
    domain = settings.OPENSANDBOX_DOMAIN
    api_key = settings.OPENSANDBOX_API_KEY
    return ConnectionConfigSync(
        domain=domain,
        api_key=api_key,
        use_server_proxy=True,
        request_timeout=timedelta(seconds=60),
        transport=httpx.HTTPTransport(limits=httpx.Limits(max_connections=20)),
    )


def _get_config():
    """获取沙盒连接配置，优先从环境变量读取。"""
    domain = settings.OPENSANDBOX_DOMAIN
    api_key = settings.OPENSANDBOX_API_KEY
    return ConnectionConfig(
        domain=domain,
        api_key=api_key,
        use_server_proxy=True,
        request_timeout=timedelta(seconds=60),
        transport=httpx.AsyncHTTPTransport(limits=httpx.Limits(max_connections=20)),
    )


async def main():
    config = _get_config()
    sandbox = await create_sandbox(config)

    async with sandbox:
        # 2. Execute a shell command
        execution = await sandbox.commands.run("echo 'Hello OpenSandbox!'")
        print(execution.logs.stdout[0].text)

        # 3. Write a file
        await sandbox.files.write_files(
            [
                WriteEntry(path="/tmp/hello.txt", data="Hello World", mode=644),
            ]
        )

        # 4. Read a file
        content = await sandbox.files.read_file("/tmp/hello.txt")
        print(f"Content: {content}")

        # 5. Create a code interpreter
        interpreter = await CodeInterpreter.create(sandbox)

        # 6. 执行 Python 代码
        result = await interpreter.codes.run(
            """
                import sys
                print(sys.version)
                result = 2 + 2
                result
            """,
            language=SupportedLanguage.PYTHON,
        )

        print(result.result[0].text)
        print(result.logs.stdout[0].text)

    # 7. Cleanup the sandbox
    await sandbox.kill()


if __name__ == "__main__":
    asyncio.run(main())
