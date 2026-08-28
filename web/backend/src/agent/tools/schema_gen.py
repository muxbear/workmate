"""从 Python 函数签名自动生成 JSON Schema（改进6）。

用于将 tools 表中的 params 字段升级为完整的 JSON Schema，
使其同时适用于前端表单渲染、运行时参数校验和 LLM 工具描述。
"""
import inspect
from typing import Any, get_type_hints

_PY_TYPE_MAP: dict[type, str] = {
    str: "string",
    int: "integer",
    float: "number",
    bool: "boolean",
    dict: "object",
    list: "array",
}


def func_to_json_schema(func: Any) -> dict:
    """从函数签名提取 JSON Schema。

    读取函数的类型注解，生成符合 OpenAI function calling 规范的 schema。

    Args:
        func: 可调用的工具函数。

    Returns:
        JSON Schema dict，包含 type / properties / required。
    """
    sig = inspect.signature(func)
    try:
        hints = get_type_hints(func)
    except Exception:
        hints = {}

    properties: dict[str, Any] = {}
    required: list[str] = []

    for param_name, param in sig.parameters.items():
        if param_name == "return":
            continue

        annotation = hints.get(param_name, str)
        json_type = _PY_TYPE_MAP.get(annotation, "string")

        prop: dict[str, Any] = {
            "type": json_type,
            "description": "",
            "title": param_name,
        }

        if param.default is inspect.Parameter.empty:
            required.append(param_name)
        else:
            prop["default"] = param.default

        properties[param_name] = prop

    return {
        "type": "object",
        "properties": properties,
        "required": required,
    }


def sync_tool_schemas_to_db(tools_module: Any) -> dict[str, dict]:
    """扫描 tools 模块中所有工具函数，生成 name -> schema 映射。

    用于初始化种子数据或运行时校验。

    Args:
        tools_module: agent.tools 模块对象。

    Returns:
        工具名称 -> JSON Schema 的映射。
    """
    result: dict[str, dict] = {}
    for name in dir(tools_module):
        if name.startswith("_"):
            continue
        obj = getattr(tools_module, name, None)
        if (
            callable(obj)
            and hasattr(obj, "__module__")
            and "agent.tools" in str(obj.__module__)
        ):
            result[name] = func_to_json_schema(obj)
    return result
