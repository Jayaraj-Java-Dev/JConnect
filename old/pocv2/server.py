import os
import sys
import time
import firebase_admin
from firebase_admin import credentials, db
import threading
import pty
import select

FIREBASE_CONFIG_PATH = "firebase_config.json"
DB_URL = "https://python-hosting-server-default-rtdb.firebaseio.com/"
SESSION_ID = "demo-session"
BATCH_SIZE = 128  # Number of bytes per message

def main():
    cred = credentials.Certificate(FIREBASE_CONFIG_PATH)
    firebase_admin.initialize_app(cred, {"databaseURL": DB_URL})
    input_ref = db.reference(f"sessions/{SESSION_ID}/input")
    output_ref = db.reference(f"sessions/{SESSION_ID}/output")
    state_ref = db.reference(f"sessions/{SESSION_ID}/state")
    state_ref.set({"status": "connected"})

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp("/bin/bash", ["/bin/bash"])
    else:
        def read_shell():
            while True:
                r, _, _ = select.select([fd], [], [], 0.01)
                if fd in r:
                    data = os.read(fd, BATCH_SIZE)
                    if data:
                        # latin1 encoding preserves all byte values 0-255 safely in JSON
                        output_ref.push({"data": data.decode("latin1")})
                    else:
                        break

        def write_shell():
            while True:
                input_data = input_ref.get() or {}
                keys = sorted(input_data.keys())
                for k in keys:
                    chunk = input_data[k]["data"]
                    os.write(fd, chunk.encode("latin1"))
                    input_ref.child(k).delete()
                time.sleep(0.01)

        t1 = threading.Thread(target=read_shell, daemon=True)
        t2 = threading.Thread(target=write_shell, daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

if __name__ == "__main__":
    main()