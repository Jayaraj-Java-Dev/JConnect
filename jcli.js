const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const http = require("http");
const url = require("url");

// Usage: node jcli.js ssh|http [SESSION_ID] [options]
// Example: node jcli.js http demo-session -port=8000

const initJsonPath = "./assets/init.json";
const serviceAccountPath = "./assets/firebase_config.json";

const feature = process.argv[2];

if (
  !feature ||
  !["ssh", "http"].includes(feature)
) {
  console.error(
    "Usage: node jcli.js ssh|http [SESSION_ID] [options]\n" +
    "For HTTP client, you can use -port=PORT to fix the target port."
  );
  process.exit(1);
}

// Helper function to check file existence and print a polite message
function checkFileExists(filePath) {
    if (!fs.existsSync(filePath)) {
        console.log(`❌ Sorry, the file "${filePath}" does not exist. Please check the path or create the file.`);
        process.exit(1);
    }
}

// Check each file
checkFileExists(initJsonPath);
checkFileExists(serviceAccountPath);

const initJson = fs.readFileSync(initJsonPath, "utf8");
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));

const SESSION_ID = process.argv[3];
const dbUrl = JSON.parse(initJson)["realtime_db_url"];


if(!SESSION_ID) {
  console.error(
    "SESSION_ID is mandatory"
  );
  process.exit(1);
}


let fixedTargetPort = null;
if (feature === "http") {
  const portArg = process.argv.find((a) => a.startsWith("-port="));
  if (portArg) {
    fixedTargetPort = parseInt(portArg.split("=")[1], 10);
    if (isNaN(fixedTargetPort)) {
      console.error("Invalid port given: " + portArg);
      process.exit(1);
    }
  }
}

// Load firebase config
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: dbUrl,
});

const db = admin.database();

function refs(prefix) {
  return {
    input: db.ref(`${prefix}/input`),
    output: db.ref(`${prefix}/output`),
    state: db.ref(`${prefix}/state`),
  };
}

// ------------------- SSH FEATURE (CLIENT) ------------------- //

async function runSSHClient() {
  const { input, output, state } = refs(`sessions/${SESSION_ID}/ssh`);
  state.set({ status: "client-connected" });

  let exitBuffer = Buffer.alloc(0);

  output.on("child_added", (snapshot) => {
    const val = snapshot.val();
    if (val && val.data) {
      const buf = Buffer.from(val.data, "base64");
      process.stdout.write(buf);
    }
    snapshot.ref.remove();
  });

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();

  stdin.on("data", function (buf) {
    exitBuffer = Buffer.concat([exitBuffer, buf]);
    if (
      exitBuffer.length >= 3 &&
      exitBuffer.slice(-3).toString() === "..1"
    ) {
      process.exit();
    }
    input.push({ data: buf.toString("base64") });
    if (exitBuffer.length > 3) {
      exitBuffer = exitBuffer.slice(-3);
    }
  });

  console.log("SSH client running. Type commands (exit with ..1).");
}

// ------------------- HTTP FEATURE (CLIENT) ------------------- //

const HTTP_PORT = 55080;

function uniqueId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}


async function runHTTPClient() {
  const sessionRef = db.ref(`sessions/${SESSION_ID}/http`);
  const input = sessionRef.child("input");
  const output = sessionRef.child("output");
  const state = sessionRef.child("state");
  const streams = sessionRef.child("streams");

  await state.set({ status: "client-connected" });

  const pending = {};

  // Listen for the initial 'start' response from the server
  output.on("child_added", (snapshot) => {
    const val = snapshot.val();
    if (val && val.reqId && pending[val.reqId]) {
      // Don't resolve the main promise here. Instead, handle the stream.
      if (val.type === 'start') {
        const { res } = pending[val.reqId];
        res.writeHead(val.status || 500, val.headers || {});
        
        // The server will now send chunks to a stream path
        const streamId = `${val.reqId}_stream`;
        const streamRef = streams.child(streamId);

        const streamListener = streamRef.on("child_added", (chunkSnapshot) => {
          const chunkData = chunkSnapshot.val();
          
          if (chunkData.type === 'chunk' && chunkData.body) {
            res.write(Buffer.from(chunkData.body, "base64"));
          } else if (chunkData.type === 'end') {
            res.end();
            // Clean up
            streamRef.off("child_added", streamListener);
            streamRef.remove();
            delete pending[val.reqId];
          }
        });
        
        // Handle cases where the stream ends unexpectedly or times out
        setTimeout(() => {
          if (pending[val.reqId]) { // If still pending, it means 'end' was not received
            res.end();
            streamRef.off("child_added", streamListener);
            streamRef.remove();
            delete pending[val.reqId];
          }
        }, 30000); // 30-second timeout for the whole stream

      } else if (val.type === 'error') {
        // Handle non-streaming errors
        const { res } = pending[val.reqId];
        res.writeHead(val.status || 500, val.headers || {});
        res.end(Buffer.from(val.body || "", "base64"));
        delete pending[val.reqId];
      }
    }
    snapshot.ref.remove();
  });

  const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);

    let targetPort, uri;
    if (fixedTargetPort) {
      targetPort = fixedTargetPort;
      uri = parsedUrl.pathname + (parsedUrl.search || '');
    } else {
      const [_, port, ...uriParts] = parsedUrl.pathname.split("/");
      if (!port || isNaN(parseInt(port, 10))) {
        res.writeHead(400);
        res.end("Target port missing in path\n");
        return;
      }
      targetPort = parseInt(port, 10);
      uri = "/" + uriParts.join("/") + (parsedUrl.search || '');
    }

    let body = [];
    req
      .on("data", (chunk) => {
        body.push(chunk);
      })
      .on("end", async () => {
        body = Buffer.concat(body);
        const reqId = uniqueId();

        // Store the response object to stream back into it later
        pending[reqId] = { res };

        // Push request to server
        input.push({
          reqId,
          port: targetPort,
          method: req.method,
          uri,
          headers: req.headers,
          body: body.toString("base64"),
          // Include client info for the server
          clientInfo: {
            ip: req.socket.remoteAddress,
            userAgent: req.headers['user-agent']
          }
        });

        // Set a timeout for the initial response from the server
        setTimeout(() => {
          if (pending[reqId] && !res.headersSent) {
            res.writeHead(504);
            res.end("Timeout waiting for server response.");
            delete pending[reqId];
          }
        }, 10000); // 10-second timeout for initial contact
      });
  });

  server.listen(HTTP_PORT, () => {
    if (fixedTargetPort) {
      console.log(
        `HTTP proxy client running on http://localhost:${HTTP_PORT}/ - forwarding ALL requests to server port ${fixedTargetPort} via Firebase`
      );
    } else {
      console.log(
        `HTTP proxy client running on http://localhost:${HTTP_PORT}/<target_port>/<uri> (forwards via Firebase)`
      );
    }
  });
}

// ------------------- MAIN ------------------- //

(async () => {
  if (feature === "ssh") {
    await runSSHClient();
  } else if (feature === "http") {
    await runHTTPClient();
  }
})();