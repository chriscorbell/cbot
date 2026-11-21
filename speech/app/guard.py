"""Keeps web pages out of the speech service.

Only Dispatch's server talks to this service, on its internal network, and it never sends an Origin
header. The machine itself still reaches that network (the server does), and so do the web pages the
bots open in their Chrome there: a page could post a clip to decode, or hold a listening socket open
and feed it audio, and keep the CPU or memory the calls need. A browser always sends Origin on a
WebSocket handshake and on a POST, so a request that carries one is refused before it reaches the
service.
"""


class RefuseBrowsers:
    """ASGI middleware: answers 403 to any HTTP request or WebSocket handshake with an Origin header."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket") and any(k.lower() == b"origin" for k, _ in scope.get("headers", ())):
            if scope["type"] == "http":
                await send({"type": "http.response.start", "status": 403, "headers": [(b"content-type", b"text/plain")]})
                await send({"type": "http.response.body", "body": b"refused: the speech service takes no requests from web pages\n"})
            else:
                await receive()  # websocket.connect
                await send({"type": "websocket.close", "code": 1008})  # before accepting: the handshake gets 403
            return
        await self.app(scope, receive, send)
