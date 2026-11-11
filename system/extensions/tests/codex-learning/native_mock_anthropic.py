"""Loopback-only synthetic Anthropic responses for native CLI acceptance."""
import http.server
import json

class Mock(http.server.BaseHTTPRequestHandler):

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if 'count_tokens' in self.path:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"input_tokens":1}')
            return
        expected = getattr(self.server, 'expected_context', None)
        if expected:
            self.server.context_features = {
                "expected_reply": expected.encode() in body,
                "typed_archive": b'portable_chat_message' in body,
                "navigation": b'historical_navigation' in body,
                "body_bytes": len(body), "encoding": self.headers.get('Content-Encoding', '')}
            found = expected.encode() in body and b'portable_chat_message' in body
            self.server.saw_expected_context = getattr(self.server, 'saw_expected_context', False) or found
        events = [{'type': 'message_start', 'message': {'id': 'msg_offline', 'type': 'message', 'role': 'assistant', 'content': [], 'model': 'claude-sonnet-4-5', 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 1, 'output_tokens': 0}}}, {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}}, {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': getattr(self.server, 'reply', 'portable-claude-proof-reply')}}, {'type': 'content_block_stop', 'index': 0}, {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 1}}, {'type': 'message_stop'}]
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for e in events:
            self.wfile.write(('event: ' + e['type'] + '\ndata: ' + json.dumps(e) + '\n\n').encode())
            self.wfile.flush()
