"""Loopback-only Responses API fixture for native Codex acceptance."""
import http.server
import json

class Mock(http.server.BaseHTTPRequestHandler):

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        expected = getattr(self.server, 'expected_context', None)
        if expected:
            found = expected.encode() in body and b'portable_chat_message' in body
            self.server.saw_expected_context = getattr(self.server, 'saw_expected_context', False) or found
        text = getattr(self.server, 'reply', 'portable-native-proof-reply')
        item = {'id': 'msg_1', 'type': 'message', 'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}
        events = [{'type': 'response.created', 'response': {'id': 'resp_1', 'status': 'in_progress'}}, {'type': 'response.output_item.added', 'output_index': 0, 'item': {**item, 'content': [], 'status': 'in_progress'}}, {'type': 'response.content_part.added', 'item_id': 'msg_1', 'output_index': 0, 'content_index': 0, 'part': {'type': 'output_text', 'text': '', 'annotations': []}}, {'type': 'response.output_text.delta', 'item_id': 'msg_1', 'output_index': 0, 'content_index': 0, 'delta': text}, {'type': 'response.output_text.done', 'item_id': 'msg_1', 'output_index': 0, 'content_index': 0, 'text': text}, {'type': 'response.content_part.done', 'item_id': 'msg_1', 'output_index': 0, 'content_index': 0, 'part': item['content'][0]}, {'type': 'response.output_item.done', 'output_index': 0, 'item': item}, {'type': 'response.completed', 'response': {'id': 'resp_1', 'status': 'completed', 'output': [item], 'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}}]
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for e in events:
            self.wfile.write(('data: ' + json.dumps(e) + '\n\n').encode())
            self.wfile.flush()
