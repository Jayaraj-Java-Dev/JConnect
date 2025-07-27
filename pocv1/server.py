import os
import sys
import time
import firebase_admin
from firebase_admin import credentials, db
import threading
import pty
import select

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
    state_ref.set({"status": "connected"})

    # PTY setup
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp("/bin/bash", ["/bin/bash"])
    else:
        def read_shell():
            while True:
                r, _, _ = select.select([fd], [], [], 0.1)
                if fd in r:
                    try:
                        data = os.read(fd, 1024)
                        if data:
                            for b in data:
                                output_ref.push({"b": b})
                        else:
                            break
                    except OSError:
                        break

        def write_shell():
            while True:
                input_data = input_ref.get() or {}
                keys = sorted(input_data.keys())
                for k in keys:
                    b = input_data[k]["b"]
                    os.write(fd, bytes([b]))
                    # Delete entry after processing
                    input_ref.child(k).delete()
                # time.sleep(0.05)

        t1 = threading.Thread(target=read_shell, daemon=True)
        t2 = threading.Thread(target=write_shell, daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

if __name__ == "__main__":
    main()