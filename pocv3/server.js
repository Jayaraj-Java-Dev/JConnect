const admin = require("firebase-admin");
const pty = require("node-pty");

const SESSION_ID = "demo-session";
const serviceAccount = require("./firebase_config.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://python-hosting-server-default-rtdb.firebaseio.com"
});

const db = admin.database();
const inputRef = db.ref(`sessions/${SESSION_ID}/input`);
const outputRef = db.ref(`sessions/${SESSION_ID}/output`);
const stateRef = db.ref(`sessions/${SESSION_ID}/state`);

stateRef.set({ status: "connected" });

// Start shell in PTY for real terminal behavior
const shell = pty.spawn("/bin/bash", [], {
  name: "xterm-256color",
  cols: 100,
  rows: 30,
  cwd: process.env.HOME,
  env: process.env
});

// Send PTY output as base64 to Firebase
shell.on("data", (data) => {
  // data is a UTF-8 string; for binary safety, send as base64
  outputRef.push({ data: Buffer.from(data, "utf8").toString("base64") });
});

// Listen for new input in Firebase, decode, write to shell, delete after
inputRef.on("child_added", (snapshot) => {
  const val = snapshot.val();
  if (val && val.data) {
    const buf = Buffer.from(val.data, "base64");
    shell.write(buf.toString("utf8"));
  }
  snapshot.ref.remove();
});

// Optionally handle window resize (not needed for basic usage)
// shell.resize(cols, rows);

shell.on("exit", (code) => {
  stateRef.set({ status: "exited", code });
  process.exit(code || 0);
});

console.log("Server running. Waiting for Firebase input. You can connect a client now.");