const admin = require("firebase-admin");

const SESSION_ID = "demo-session";
const serviceAccount = require("./firebase_config.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://pets-fort-default-rtdb.asia-southeast1.firebasedatabase.app"
});

const db = admin.database();
const inputRef = db.ref(`sessions/${SESSION_ID}/input`);
const outputRef = db.ref(`sessions/${SESSION_ID}/output`);
const stateRef = db.ref(`sessions/${SESSION_ID}/state`);

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