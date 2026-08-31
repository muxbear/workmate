"""文生图工具."""

from typing import Any

import httpx

from agent.config import settings

'文生图工具.'


def image_generate(prompt: str = '', size: str = '512x512') -> dict[str, Any]:
    """""调用配置的图像生成服务，返回图片 URL 或 base64."""""
    api_key = settings.IMAGE_GEN_API_KEY
    base_url = settings.IMAGE_GEN_BASE_URL
    model = settings.IMAGE_GEN_MODEL
    if not api_key or not base_url or not model:
        return {'error': 'image_generate tool not configured', 'prompt': prompt}

    url = base_url if base_url.endswith('/') else base_url + '/'
    headers = {'Authorization': 'Bearer ' + api_key}
    payload = {'model': model, 'prompt': prompt, 'size': size}
    try:
        response = httpx.post(url, json=payload, headers=headers, timeout=60)
        response.raise_for_status()
        data = response.json()
    except Exception as exc:
        return {'error': 'image_generate request failed: ' + str(exc), 'prompt': prompt}

    items = data.get('data') or []
    if not items:
        return {'error': 'image_generate returned no image data', 'prompt': prompt}

    first = items[0]
    if first.get('url'):
        return {'url': first['url'], 'prompt': prompt}
    if first.get('b64_json'):
        return {'b64_json': first['b64_json'], 'prompt': prompt}
    return {'error': 'image_generate returned unsupported image format', 'prompt': prompt}
