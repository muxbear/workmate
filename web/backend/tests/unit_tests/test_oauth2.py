import base64
import hashlib

from api.oauth2.client_service import redirect_uri_matches
from api.oauth2.oauth2_service import _verify_pkce


def test_redirect_uri_matches_loopback_port_template() -> None:
    assert redirect_uri_matches(
        ["http://127.0.0.1:{port}/callback"],
        "http://127.0.0.1:54821/callback",
    )
    assert not redirect_uri_matches(
        ["http://127.0.0.1:{port}/callback"],
        "http://evil.example/callback",
    )


def test_redirect_uri_matches_custom_scheme() -> None:
    assert redirect_uri_matches(
        ["workmate://oauth/callback"],
        "workmate://oauth/callback",
    )
    assert not redirect_uri_matches(
        ["workmate://oauth/callback"],
        "workmate://oauth/other",
    )


def test_verify_pkce_s256() -> None:
    verifier = "a" * 43
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()

    assert _verify_pkce(verifier, challenge)
    assert not _verify_pkce("b" * 43, challenge)
