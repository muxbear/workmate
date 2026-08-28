import urllib.request

def web_scraper(url: str = '') -> dict:
    try:
        req = urllib.request.Request(url, method='GET')
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode('utf-8', errors='replace')
            return {'status': resp.status, 'body': body}
    except Exception as e:
        return {'error': str(e), 'body': ''}

__all__ = ['web_scraper']
