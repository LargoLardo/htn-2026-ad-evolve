"""Resolve Baseten request authentication without logging or copying credentials."""


def authorization_headers(api_key="", truss_remote=None):
    """Return a per-request callback; Truss refreshes browser-login tokens as needed."""
    if truss_remote:
        try:
            from truss.remote.remote_factory import RemoteFactory
        except ImportError as exc:
            raise RuntimeError("Install training/requirements-baseten.txt to use --truss-remote.") from exc
        remote = RemoteFactory.create(truss_remote)
        return remote.fetch_auth_header
    if not api_key:
        raise ValueError("Set BASETEN_API_KEY or use --truss-remote baseten with your existing Truss login.")
    return lambda: {"Authorization": f"Bearer {api_key}"}
