"""Tests for guard.py, with the standard library only: python3 -m unittest discover -s speech/app -p 'test_*.py'"""
import asyncio
import unittest

from guard import RefuseBrowsers


def run(scope, incoming=()):
    """Runs the middleware over a fake app; returns (whether the app ran, what was sent)."""
    ran = []
    sent = []
    queue = list(incoming)

    async def app(scope, receive, send):
        ran.append(scope["type"])

    async def receive():
        return queue.pop(0)

    async def send(message):
        sent.append(message)

    asyncio.run(RefuseBrowsers(app)(scope, receive, send))
    return bool(ran), sent


class RefuseBrowsersTest(unittest.TestCase):
    def test_lets_the_server_through(self):
        ran, sent = run({"type": "http", "headers": [(b"content-type", b"multipart/form-data")]})
        self.assertTrue(ran)
        self.assertEqual(sent, [])
        ran, _ = run({"type": "websocket", "headers": [(b"host", b"speech:8000")]})
        self.assertTrue(ran)

    def test_refuses_a_page_s_post(self):
        ran, sent = run({"type": "http", "headers": [(b"origin", b"https://example.com")]})
        self.assertFalse(ran)
        self.assertEqual(sent[0]["status"], 403)

    def test_refuses_a_page_s_socket_before_accepting_it(self):
        ran, sent = run({"type": "websocket", "headers": [(b"Origin", b"null")]}, [{"type": "websocket.connect"}])
        self.assertFalse(ran)
        self.assertEqual(sent, [{"type": "websocket.close", "code": 1008}])

    def test_leaves_lifespan_alone(self):
        ran, _ = run({"type": "lifespan"})
        self.assertTrue(ran)


if __name__ == "__main__":
    unittest.main()
