const admin = require("firebase-admin");
const pty = require("node-pty");
const fs = require("fs");
const path = require("path");
const http = require("http");
const url = require("url");

// Usage: node connect.js server|client ssh|http [SESSION_ID] [options]
// Example: node connect.js client http demo-session -port=8000

const mode = process.argv[2];
const feature = process.argv[3];
const SESSION_ID = process.argv[4] || "demo-session";

let fixedTargetPort = null;
if (feature === "http" && mode === "client") {
  // Look for -port=XXXX in the args
  const portArg = process.argv.find((a) => a.startsWith("-port="));
  if (portArg) {
    fixedTargetPort = parseInt(portArg.split("=")[1], 10);
    if (isNaN(fixedTargetPort)) {
      console.error("Invalid port given: " + portArg);
      process.exit(1);
    }
  }
}

if (
  !mode ||
  !["client", "server"].includes(mode) ||
  !feature ||
  !["ssh", "http"].includes(feature)
) {
  console.error(
    "Usage: node connect.js server|client ssh|http [SESSION_ID] [options]\n" +
    "For HTTP client, you can use -port=PORT to fix the target port."
  );
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
  databaseURL:
    "https://pets-fort-default-rtdb.asia-southeast1.firebasedatabase.app",
});

const db = admin.database();

function refs(prefix) {
  return {
    input: db.ref(`${prefix}/input`),
    output: db.ref(`${prefix}/output`),
    state: db.ref(`${prefix}/state`),
  };
}

// ------------------- SSH FEATURE ------------------- //

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

async function runSSHServer() {
  const { input, output, state } = refs(`sessions/${SESSION_ID}/ssh`);
  state.set({ status: "connected" });

  const shell = pty.spawn("/bin/bash", [], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: process.env.HOME,
    env: process.env,
  });

  shell.on("data", (data) => {
    output.push({ data: Buffer.from(data, "utf8").toString("base64") });
  });

  input.on("child_added", (snapshot) => {
    const val = snapshot.val();
    if (val && val.data) {
      const buf = Buffer.from(val.data, "base64");
      shell.write(buf.toString("utf8"));
    }
    snapshot.ref.remove();
  });

  shell.on("exit", (code) => {
    state.set({ status: "exited", code });
    process.exit(code || 0);
  });

  console.log("SSH server running. Waiting for Firebase input. You can connect a client now.");
}

// ------------------- HTTP FEATURE ------------------- //

const HTTP_PORT = 55080;

function uniqueId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function runHTTPClient() {
  const { input, output, state } = refs(`sessions/${SESSION_ID}/http`);
  state.set({ status: "client-connected" });

  const pending = {};

  output.on("child_added", (snapshot) => {
    const val = snapshot.val();
    if (val && val.reqId && pending[val.reqId]) {
      pending[val.reqId].resolve(val);
      delete pending[val.reqId];
    }
    snapshot.ref.remove();
  });

  const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);

    let targetPort, uri;
    if (fixedTargetPort) {
      // Fixed port mode: all requests go to this port, use the full path as uri
      targetPort = fixedTargetPort;
      uri = parsedUrl.pathname;
    } else {
      // Parse port from url: e.g. /8000/abc/def
      const [_, port, ...uriParts] = parsedUrl.pathname.split("/");
      if (!port || isNaN(parseInt(port, 10))) {
        res.writeHead(400);
        res.end("Target port missing in path\n");
        return;
      }
      targetPort = parseInt(port, 10);
      uri = "/" + uriParts.join("/");
    }

    let body = [];
    req
      .on("data", (chunk) => {
        body.push(chunk);
      })
      .on("end", async () => {
        body = Buffer.concat(body);
        const reqId = uniqueId();
        input.push({
          reqId,
          port: targetPort,
          method: req.method,
          uri,
          headers: req.headers,
          body: body.toString("base64"),
        });

        const promise = new Promise((resolve) => {
          pending[reqId] = { resolve };
          setTimeout(() => {
            if (pending[reqId]) {
              resolve({ status: 504, headers: {}, body: Buffer.from("Timeout").toString("base64") });
              delete pending[reqId];
            }
          }, 30000);
        });

        const resp = await promise;
        res.writeHead(resp.status || 500, resp.headers || {});
        res.end(Buffer.from(resp.body || "", "base64"));
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

async function runHTTPServer() {
  const { input, output, state } = refs(`sessions/${SESSION_ID}/http`);
  state.set({ status: "connected" });

  input.on("child_added", async (snapshot) => {
    const val = snapshot.val();
    if (
      val &&
      val.reqId &&
      val.port &&
      val.method &&
      typeof val.uri === "string"
    ) {
      const options = {
        hostname: "localhost",
        port: parseInt(val.port, 10),
        path: val.uri,
        method: val.method,
        headers: val.headers,
      };

      let respData = Buffer.alloc(0);
      let status = 500;
      let headers = {};
      try {
        await new Promise((resolve, reject) => {
          const req = http.request(options, (resp) => {
            status = resp.statusCode;
            headers = resp.headers;
            resp.on("data", (chunk) => {
              respData = Buffer.concat([respData, chunk]);
            });
            resp.on("end", resolve);
          });
          req.on("error", (err) => {
            respData = Buffer.from("Error: " + err.message);
            status = 502;
            resolve();
          });
          if (val.body) {
            req.write(Buffer.from(val.body, "base64"));
          }
          req.end();
        });
      } catch (e) {
        respData = Buffer.from("Internal Server Error");
        status = 500;
      }
      output.push({
        reqId: val.reqId,
        status,
        headers,
        body: respData.toString("base64"),
      });
    }
    snapshot.ref.remove();
  });

  console.log(
    "HTTP server proxy running. Waiting for HTTP requests from Firebase client."
  );
}

// ------------------- MAIN ------------------- //

(async () => {
  if (feature === "ssh" && mode === "client") {
    await runSSHClient();
  } else if (feature === "ssh" && mode === "server") {
    await runSSHServer();
  } else if (feature === "http" && mode === "client") {
    await runHTTPClient();
  } else if (feature === "http" && mode === "server") {
    await runHTTPServer();
  }
})();