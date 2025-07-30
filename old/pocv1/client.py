import sys
import os
import time
import threading
import termios
import tty
import select
import firebase_admin
from firebase_admin import credentials, db

# CONFIG
FIREBASE_CONFIG_PATH = "firebase_config.json"
DB_URL = "https://python-hosting-server-default-rtdb.firebaseio.com/"
SESSION_ID = "demo-session"

def main():
    # Initialize Firebase
    cred = credentials.Certificate(FIREBASE_CONFIG_PATH)
    firebase_admin.initialize_app(cred, {"databaseURL": DB_URL})
    input_ref = db.reference(f"sessions/{SESSION_ID}/input")
    output_ref = db.reference(f"sessions/{SESSION_ID}/output")
    state_ref = db.reference(f"sessions/{SESSION_ID}/state")
    state_ref.set({"status": "client-connected"})

    # Set terminal to raw mode
    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)
    tty.setraw(fd)

    def read_input():
        while True:
            r, _, _ = select.select([fd], [], [], 0.1)
            if fd in r:
                ch = os.read(fd, 1)
                if ch:
                    input_ref.push({"b": ch[0]})
                else:
                    break

    def write_output():
        while True:
            output_data = output_ref.get() or {}
            keys = sorted(output_data.keys())
            for k in keys:
                b = output_data[k]["b"]
                os.write(sys.stdout.fileno(), bytes([b]))
                # Delete entry after processing
                output_ref.child(k).delete()
            # time.sleep(0.05)

    try:
        t1 = threading.Thread(target=read_input, daemon=True)
        t2 = threading.Thread(target=write_output, daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)

if __name__ == "__main__":
    main()