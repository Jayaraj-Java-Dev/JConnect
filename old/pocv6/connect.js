const admin = require("firebase-admin");
const pty = require("node-pty");
const fs = require("fs");
const path = require("path");
const http = require("http");
const url = require("url");

// Usage: node connect.js server|client ssh|http|manage [SESSION_ID] [options]
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
  !["ssh", "http", "manage"].includes(feature)
) {
  console.error(
    "Usage: node connect.js server|client ssh|http|manage [SESSION_ID] [options]\n" +
    "For HTTP client, you can use -port=PORT to fix the target port.\n" +
    "To manage state: node connect.js server manage [SESSION_ID]"
  );
  process.exit(1);
}

// Load firebase config if not manage feature
if (feature !== "manage") {
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
}

const db = feature !== "manage" ? admin.database() : null;

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
      targetPort = fixedTargetPort;
      uri = parsedUrl.pathname;
    } else {
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

// ------------------- MANAGE FEATURE ------------------- //

const MANAGE_PORT = 55777;

function createFeatureManager() {
  // In-memory state
  const state = {
    ssh: {
      enabled: true,
      running: false,
      history: [],
    },
    http: {
      enabled: true,
      running: false,
      history: [],
    },
  };

  // Simple API helpers
  function getStatus() {
    return {
      ssh: {
        enabled: state.ssh.enabled,
        running: state.ssh.running,
        last: state.ssh.history[state.ssh.history.length - 1] || null,
        history: state.ssh.history.slice(-20), // last 20 actions
      },
      http: {
        enabled: state.http.enabled,
        running: state.http.running,
        last: state.http.history[state.http.history.length - 1] || null,
        history: state.http.history.slice(-20),
      },
    };
  }

  function setFeature(feature, action) {
    if (!["ssh", "http"].includes(feature)) return { error: "Invalid feature" };
    const now = new Date().toISOString();

    if (action === "enable") {
      state[feature].enabled = true;
      state[feature].history.push({ action, time: now });
    } else if (action === "disable") {
      state[feature].enabled = false;
      state[feature].history.push({ action, time: now });
      // Optionally stop if running
      if (state[feature].running) {
        state[feature].running = false;
        state[feature].history.push({ action: "stop", time: now });
      }
    } else if (action === "start") {
      if (state[feature].enabled && !state[feature].running) {
        state[feature].running = true;
        state[feature].history.push({ action, time: now });
      } else {
        return { error: "Cannot start: feature disabled or already running" };
      }
    } else if (action === "stop") {
      if (state[feature].running) {
        state[feature].running = false;
        state[feature].history.push({ action, time: now });
      } else {
        return { error: "Feature is not running" };
      }
    } else {
      return { error: "Unknown action" };
    }
    return { success: true };
  }

  return { getStatus, setFeature };
}

function runManageServer() {
  const featureManager = createFeatureManager();

  const server = http.createServer((req, res) => {
    // CORS for UI dev
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/api/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(featureManager.getStatus()));
    } else if (
      req.url.startsWith("/api/feature/") &&
      req.method === "POST"
    ) {
      let body = [];
      req.on("data", (chunk) => body.push(chunk));
      req.on("end", () => {
        try {
          body = Buffer.concat(body).toString();
          const { action } = JSON.parse(body);
          const feature = req.url.split("/")[3];
          const result = featureManager.setFeature(feature, action);
          res.writeHead(result.error ? 400 : 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid request" }));
        }
      });
    } else if (req.url === "/" && req.method === "GET") {
      // Simple UI for demo
      const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Feature Manager</title>
  <style>
    body { font-family: sans-serif; max-width: 700px; margin: 40px auto; background: #f9f9f9;}
    h2 { margin-top: 30px; }
    .status { margin-bottom: 20px; }
    .history { font-size: 0.95em; color: #555;}
    button { margin: 0 6px 0 0; }
  </style>
</head>
<body>
  <h1>Server Feature Management</h1>
  <div id="main"></div>
  <script>
    async function fetchStatus() {
      const resp = await fetch('/api/status');
      const data = await resp.json();
      document.getElementById('main').innerHTML = Object.entries(data).map(([feature, f]) => \`
        <div>
          <h2>\${feature.toUpperCase()}</h2>
          <div class="status">
            <b>Enabled:</b> \${f.enabled ? "Yes" : "No"}<br>
            <b>Running:</b> \${f.running ? "Yes" : "No"}<br>
            <button onclick="action('\${feature}', 'enable')">Enable</button>
            <button onclick="action('\${feature}', 'disable')">Disable</button>
            <button onclick="action('\${feature}', 'start')">Start</button>
            <button onclick="action('\${feature}', 'stop')">Stop</button>
          </div>
          <div class="history">
            <b>Recent history:</b>
            <ul>\${f.history.map(h => '<li>' + h.time + ' - ' + h.action + '</li>').join('')}</ul>
          </div>
        </div>
      \`).join('');
    }
    async function action(feature, act) {
      await fetch('/api/feature/' + feature, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({action: act})
      });
      fetchStatus();
    }
    fetchStatus();
    setInterval(fetchStatus, 5000);
  </script>
</body>
</html>
      `;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });

  server.listen(MANAGE_PORT, () => {
    console.log(`Feature management UI running on http://localhost:${MANAGE_PORT}/`);
  });
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
  } else if (feature === "manage" && mode === "server") {
    runManageServer();
  }
})();