import http.server
import socketserver
import time
import datetime
import sys
import json
import random

# Configuration
PORT = 9000
CHUNK_DELAY = 0.5  # seconds between chunks

class StreamingHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        print(f"Received request: {self.path}")
        
        if self.path == "/api/stream":
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-cache')
            # Don't use chunked encoding, just keep the connection open
            self.end_headers()
            
            # Stream 10 JSON objects with timestamps
            for i in range(10):
                timestamp = datetime.datetime.now().isoformat()
                data = {
                    "chunk": i + 1,
                    "total": 10,
                    "timestamp": timestamp,
                    "value": random.randint(1, 100),
                    "message": f"This is streaming chunk {i+1} of 10"
                }
                
                json_data = json.dumps(data) + "\n"
                
                # Log on server side
                print(f"Sending chunk {i+1}/10 at {timestamp}")
                sys.stdout.flush()
                
                # Send the chunk
                self.wfile.write(json_data.encode('utf-8'))
                self.wfile.flush()
                
                # Wait before sending next chunk
                time.sleep(CHUNK_DELAY)
                
            print("Finished sending all chunks")

        elif self.path == "/api/plain-stream":
            # Simple plain text streaming
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            
            for i in range(10):
                timestamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')
                line = f"Line {i+1}/10 - Timestamp: {timestamp}\n"
                
                print(f"Sending line {i+1}/10")
                sys.stdout.flush()
                
                self.wfile.write(line.encode('utf-8'))
                self.wfile.flush()
                
                time.sleep(CHUNK_DELAY)
                
            print("Finished sending all lines")

        elif self.path == "/api/status":
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            
            status = {
                "status": "running",
                "server_time": datetime.datetime.now().isoformat(),
                "endpoints": [
                    {
                        "path": "/api/stream",
                        "description": "JSON streaming example - returns 10 JSON objects with 0.5s delay between each"
                    },
                    {
                        "path": "/api/plain-stream",
                        "description": "Plain text streaming example - sends 10 lines with 0.5s delay between each"
                    }
                ]
            }
            
            self.wfile.write(json.dumps(status, indent=2).encode('utf-8'))
        
        else:
            self.send_response(404)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            
            error = {
                "error": "Not Found",
                "message": f"The requested path '{self.path}' does not exist",
                "available_endpoints": ["/api/stream", "/api/plain-stream", "/api/status"]
            }
            
            self.wfile.write(json.dumps(error, indent=2).encode('utf-8'))

def run_server():
    handler = StreamingHandler
    with socketserver.TCPServer(("", PORT), handler) as httpd:
        print(f"Simple Streaming Server started at http://localhost:{PORT}")
        print(f"Current Date and Time: {datetime.datetime.now().isoformat()}")
        print(f"Available endpoints:")
        print(f"  - http://localhost:{PORT}/api/stream (JSON streaming)")
        print(f"  - http://localhost:{PORT}/api/plain-stream (Plain text streaming)")
        print(f"  - http://localhost:{PORT}/api/status (Server status)")
        print("\nPress Ctrl+C to stop the server")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped by user")

if __name__ == "__main__":
    run_server()
