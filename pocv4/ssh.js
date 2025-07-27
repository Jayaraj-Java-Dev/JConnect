const admin = require("firebase-admin");
const pty = require("node-pty");
const fs = require("fs");
const path = require("path");

// Usage: node ssh.js client|server [SESSION_ID]
// Defaults SESSION_ID to "demo-session" if omitted
const mode = process.argv[2];
const SESSION_ID = process.argv[3] || "demo-session";

if (!mode || !["client", "server"].includes(mode)) {
  console.error("Usage: node ssh.js client|server [SESSION_ID]");
  process.exit(1);
}

// Load firebase config
const serviceAccountPath = path.resolve(__dirname, "firebase_config.json");
if (!fs.existsSync(serviceAccountPath)) {
  console.error("Missing firebase_config.json");
  process.exit(1);
}

const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://pets-fort-default-rtdb.asia-southeast1.firebasedatabase.app"
});

const db = admin.database();
const inputRef = db.ref(`sessions/${SESSION_ID}/input`);
const outputRef = db.ref(`sessions/${SESSION_ID}/output`);
const stateRef = db.ref(`sessions/${SESSION_ID}/state`);

if (mode === "client") {
  stateRef.set({ status: "client-connected" });

  let exitBuffer = Buffer.alloc(0);

  // Listen for shell output from Firebase, decode, write raw to stdout, delete after
  outputRef.on("child_added", (snapshot) => {
    const val = snapshot.val();
    if (val && val.data) {
      const buf = Buffer.from(val.data, "base64");
      process.stdout.write(buf);
    }
    snapshot.ref.remove();
  });

  // Read user input from terminal in raw mode, send as base64 to Firebase
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();

  stdin.on("data", function (buf) {
    exitBuffer = Buffer.concat([exitBuffer, buf]);
    // Check if the end of the buffer is '..1' (2e 2e 31 in hex)
    if (
      exitBuffer.length >= 3 &&
      exitBuffer.slice(-3).toString() === "..1"
    ) {
      process.exit();
    }
    // If not, send the data to the shell
    inputRef.push({ data: buf.toString("base64") });
    // Keep exitBuffer at max 3 bytes to match only the most recent input
    if (exitBuffer.length > 3) {
      exitBuffer = exitBuffer.slice(-3);
    }
  });

  console.log("Client running. Type commands (exit with ..1).");
} else if (mode === "server") {
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

  shell.on("exit", (code) => {
    stateRef.set({ status: "exited", code });
    process.exit(code || 0);
  });

  console.log("Server running. Waiting for Firebase input. You can connect a client now.");
}