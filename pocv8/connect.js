const admin = require("firebase-admin");
const pty = require("node-pty");
const fs = require("fs");
const path = require("path");
const http = require("http");
const url = require("url");
const { spawn } = require("child_process");

// Usage: node connect.js server|client ssh|http|manage [SESSION_ID] [options]
// Example: node connect.js client http demo-session -port=8000

const mode = process.argv[2];
const feature = process.argv[3];
const SESSION_ID = process.argv[4] || "demo-session";

let fixedTargetPort = null;
if (feature === "http" && mode === "client") {
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
const thisFile = require.main.filename; // Absolute path to this script

function createFeatureManager() {
  const state = {
    ssh: {
      enabled: true,
      running: false,
      lastSessionId: null,
      proc: null,
      history: [],
    },
    http: {
      enabled: true,
      running: false,
      lastSessionId: null,
      lastPort: null,
      proc: null,
      history: [],
    },
  };

  function getStatus() {
    return {
      ssh: {
        enabled: state.ssh.enabled,
        running: state.ssh.running,
        lastSessionId: state.ssh.lastSessionId,
        last: state.ssh.history[state.ssh.history.length - 1] || null,
        history: state.ssh.history.slice(-20),
      },
      http: {
        enabled: state.http.enabled,
        running: state.http.running,
        lastSessionId: state.http.lastSessionId,
        lastPort: state.http.lastPort,
        last: state.http.history[state.http.history.length - 1] || null,
        history: state.http.history.slice(-20),
      },
    };
  }

  function setFeature(feature, action, sessionId, port) {
    if (!["ssh", "http"].includes(feature)) return { error: "Invalid feature" };
    const now = new Date().toISOString();

    if (action === "enable") {
      state[feature].enabled = true;
      state[feature].history.push({ action, time: now });
    } else if (action === "disable") {
      state[feature].enabled = false;
      state[feature].history.push({ action, time: now });
      if (state[feature].running) {
        stopFeature(feature);
      }
    } else if (action === "start") {
      if (state[feature].enabled && !state[feature].running) {
        if (!sessionId) {
          return { error: "Session ID is required" };
        }
        const args = ["server", feature, sessionId];
        if (feature === "http" && port) {
          state.http.lastPort = port;
          // Optionally, you could pass the port, but in this design, the HTTP server always forwards to whatever port the client asks for.
        }
        // Spawn the process
        const proc = spawn(process.execPath, [thisFile, "server", feature, sessionId], {
          stdio: "ignore", // or "inherit" for debugging
          detached: true,
        });
        proc.unref();
        state[feature].proc = proc;
        state[feature].running = true;
        state[feature].lastSessionId = sessionId;
        const item = { action, time: now, sessionId };
        if (feature === "http" && port) item.port = port;
        state[feature].history.push(item);
      } else {
        return { error: "Cannot start: feature disabled or already running" };
      }
    } else if (action === "stop") {
      if (state[feature].running) {
        stopFeature(feature);
      } else {
        return { error: "Feature is not running" };
      }
    } else {
      return { error: "Unknown action" };
    }
    return { success: true };
  }

  function stopFeature(feature) {
    if (state[feature].proc) {
      try {
        process.kill(state[feature].proc.pid);
      } catch (e) {}
      state[feature].proc = null;
    }
    state[feature].running = false;
    state[feature].history.push({ action: "stop", time: new Date().toISOString() });
  }

  return { getStatus, setFeature };
}

function runManageServer() {
  const featureManager = createFeatureManager();

  const server = http.createServer((req, res) => {
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
          const parsed = JSON.parse(body);
          const { action, sessionId, port } = parsed;
          const feature = req.url.split("/")[3];
          const result = featureManager.setFeature(feature, action, sessionId, port);
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
    .modal {
      display: none; 
      position: fixed; 
      z-index: 10; 
      left: 0; top: 0; width: 100vw; height: 100vh;
      background: rgba(0,0,0,0.4);
      justify-content: center; align-items: center;
    }
    .modal-content {
      background: #fff; padding: 20px; border-radius: 6px; min-width: 320px;
      box-shadow: 0 2px 16px #0002;
    }
    .modal-content label { display: block; margin-top: 10px; }
    .modal-content input { width: 100%; margin-top: 4px; padding: 6px; }
    .modal-content .error { color: #b00; margin-top: 10px; }
    .close-modal { float: right; cursor: pointer; color: #888; font-size: 18px;}
    button:disabled { opacity:0.5; }
  </style>
</head>
<body>
  <h1>Server Feature Management</h1>
  <div id="main"></div>

  <!-- SSH Modal -->
  <div class="modal" id="ssh-modal">
    <div class="modal-content">
      <span class="close-modal" onclick="closeModal('ssh-modal')">&times;</span>
      <h3>Start SSH Server</h3>
      <form onsubmit="return submitStart('ssh', event)">
        <label>Session ID <span style="color:red">*</span></label>
        <input type="text" id="ssh-session" required>
        <div id="ssh-error" class="error"></div>
        <button type="submit">Start</button>
      </form>
    </div>
  </div>
  <!-- HTTP Modal -->
  <div class="modal" id="http-modal">
    <div class="modal-content">
      <span class="close-modal" onclick="closeModal('http-modal')">&times;</span>
      <h3>Start HTTP Server</h3>
      <form onsubmit="return submitStart('http', event)">
        <label>Session ID <span style="color:red">*</span></label>
        <input type="text" id="http-session" required>
        <label>Forward Port (optional)</label>
        <input type="number" id="http-port" min="1" max="65535" placeholder="e.g. 8000">
        <div id="http-error" class="error"></div>
        <button type="submit">Start</button>
      </form>
    </div>
  </div>
  <script>
    let featureStatus = {};
    async function fetchStatus() {
      const resp = await fetch('/api/status');
      const data = await resp.json();
      featureStatus = data;
      document.getElementById('main').innerHTML = Object.entries(data).map(([feature, f]) => \`
        <div>
          <h2>\${feature.toUpperCase()}</h2>
          <div class="status">
            <b>Enabled:</b> \${f.enabled ? "Yes" : "No"}<br>
            <b>Running:</b> \${f.running ? "Yes" : "No"}<br>
            <b>Last Session ID:</b> \${f.lastSessionId ? f.lastSessionId : "-"}<br>
            \${feature === "http" ? '<b>Last Port:</b> ' + (f.lastPort ? f.lastPort : "-") + '<br>' : ""}
            <button onclick="action('\${feature}', 'enable')" \${f.enabled ? "disabled" : ""}>Enable</button>
            <button onclick="action('\${feature}', 'disable')" \${!f.enabled ? "disabled" : ""}>Disable</button>
            <button onclick="openStartModal('\${feature}')" \${(!f.enabled || f.running) ? "disabled" : ""}>Start</button>
            <button onclick="action('\${feature}', 'stop')" \${!f.running ? "disabled" : ""}>Stop</button>
          </div>
          <div class="history">
            <b>Recent history:</b>
            <ul>\${f.history.map(h => '<li>' + h.time + ' - ' + h.action + 
              (h.sessionId ? ' (session: ' + h.sessionId + ')' : '') + 
              (h.port ? ' (port: ' + h.port + ')' : '') +
              '</li>').join('')}</ul>
          </div>
        </div>
      \`).join('');
    }
    async function action(feature, act) {
      if (act === "start") return openStartModal(feature);
      await fetch('/api/feature/' + feature, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({action: act})
      });
      fetchStatus();
    }
    function openStartModal(feature) {
      if (feature === "ssh") {
        document.getElementById("ssh-session").value = "";
        document.getElementById("ssh-error").textContent = "";
        document.getElementById("ssh-modal").style.display = "flex";
      } else if (feature === "http") {
        document.getElementById("http-session").value = "";
        document.getElementById("http-port").value = "";
        document.getElementById("http-error").textContent = "";
        document.getElementById("http-modal").style.display = "flex";
      }
    }
    function closeModal(id) {
      document.getElementById(id).style.display = "none";
    }
    async function submitStart(feature, event) {
      if (event) event.preventDefault();
      if (feature === "ssh") {
        const sessionId = document.getElementById("ssh-session").value.trim();
        if (!sessionId) {
          document.getElementById("ssh-error").textContent = "Session ID is required.";
          return false;
        }
        const resp = await fetch('/api/feature/ssh', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({action: "start", sessionId})
        });
        if (!resp.ok) {
          const err = await resp.json();
          document.getElementById("ssh-error").textContent = err.error || "Error starting SSH";
          return false;
        }
        closeModal("ssh-modal");
      } else if (feature === "http") {
        const sessionId = document.getElementById("http-session").value.trim();
        const portStr = document.getElementById("http-port").value.trim();
        if (!sessionId) {
          document.getElementById("http-error").textContent = "Session ID is required.";
          return false;
        }
        let port = null;
        if (portStr) {
          port = parseInt(portStr, 10);
          if (isNaN(port) || port < 1 || port > 65535) {
            document.getElementById("http-error").textContent = "Invalid port value.";
            return false;
          }
        }
        const resp = await fetch('/api/feature/http', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({action: "start", sessionId, port})
        });
        if (!resp.ok) {
          const err = await resp.json();
          document.getElementById("http-error").textContent = err.error || "Error starting HTTP";
          return false;
        }
        closeModal("http-modal");
      }
      fetchStatus();
      return false;
    }
    fetchStatus();
    setInterval(fetchStatus, 5000);
    window.onclick = function(event) {
      ['ssh-modal','http-modal'].forEach(id=>{
        const m=document.getElementById(id);
        if(event.target===m) m.style.display='none';
      });
    }
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