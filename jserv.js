const admin = require("firebase-admin");
const pty = require("node-pty");
const fs = require("fs");
const path = require("path");
const http = require("http");
const url = require("url");
const { spawn } = require("child_process");

// Usage: node jserv.js ssh|http|manage [SESSION_ID] [options]

const initJsonPath = "./assets/init.json";
const webPanelHtmlPath = "./assets/feature_manager.html";
const serviceAccountPath = "./assets/firebase_config.json";

const feature = process.argv[2];

if (
  !feature ||
  !["ssh", "http", "manage"].includes(feature)
) {
  console.error(
    "Usage: node jserv.js ssh|http|manage [SESSION_ID] [options]\n" +
    "To manage state: node jserv.js manage"
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
checkFileExists(webPanelHtmlPath);
checkFileExists(serviceAccountPath);

const initJson = fs.readFileSync(initJsonPath, "utf8");
const webPanelHtml = fs.readFileSync(webPanelHtmlPath, "utf8");
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));

const SESSION_ID = process.argv[3];
const startWebAt1 = process.argv.includes("-p");
const dbUrl = JSON.parse(initJson)["realtime_db_url"];


if(!dbUrl) {
  console.error(
    "The "+initJsonPath+" must contain 'realtime_db_url' of the firebase realtime db to function properly"
  );
  process.exit(1);
}

// Load firebase config if not manage feature
if (feature !== "manage") {
  if(!SESSION_ID) {
    console.error(
      "SESSION_ID is mandatory"
    );  
    process.exit(1);
  }

  if (!fs.existsSync(serviceAccountPath)) {
    console.error("Missing firebase_config.json");
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: dbUrl,
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

// ------------------- SSH FEATURE (SERVER) ------------------- //

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

// ------------------- HTTP FEATURE (SERVER) ------------------- //

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

let MANAGE_PORT = 55777;
if (feature === "manage") {
  // If a number is provided immediately after "manage", use it as port
  if (process.argv.length > 3 && /^\d+$/.test(process.argv[3])) {
    const portNum = parseInt(process.argv[3], 10);
    if (portNum > 0 && portNum < 65536) MANAGE_PORT = portNum;
  }
}
const thisFile = require.main.filename;

function createFeatureManager() {
  // Each feature has a sessions map (sessionId -> sessionInfo)
  const state = {
    ssh: {
      enabled: true,
      sessions: {}, // { sessionId: { proc, status, startedAt } }
      history: []
    },
    http: {
      enabled: true,
      sessions: {}, // { sessionId: { port, proc, status, startedAt } }
      history: []
    },
  };

  function getStatus() {
    // List all sessions for both features
    return {
      ssh: {
        enabled: state.ssh.enabled,
        sessions: Object.entries(state.ssh.sessions).map(([sessionId, s]) => ({
          sessionId,
          status: s.status,
          startedAt: s.startedAt,
          pid: s.proc?.pid
        })),
        history: state.ssh.history.slice(-20)
      },
      http: {
        enabled: state.http.enabled,
        sessions: Object.entries(state.http.sessions).map(([sessionId, s]) => ({
          sessionId,
          port: s.port,
          status: s.status,
          startedAt: s.startedAt,
          pid: s.proc?.pid
        })),
        history: state.http.history.slice(-20)
      }
    };
  }

  function setFeature(feature, action, sessionId, port) {
    if (!["ssh", "http"].includes(feature)) return { error: "Invalid feature" };
    const now = new Date().toISOString();

    if (action === "enable") {
      state[feature].enabled = true;
      state[feature].history.push({ action, time: now });
      return { success: true };
    }
    if (action === "disable") {
      state[feature].enabled = false;
      // Stop all sessions for this feature
      Object.keys(state[feature].sessions).forEach(sid => stopSession(feature, sid));
      state[feature].history.push({ action, time: now });
      return { success: true };
    }
    if (action === "start") {
      if (!state[feature].enabled) return { error: "Feature disabled" };
      if (!sessionId) return { error: "Session ID is required" };
      // For HTTP, port can optionally be specified
      if (feature === "http" && port) port = parseInt(port, 10);

      const sessionKey = feature === "http" && port ? `${sessionId}:${port}` : sessionId;
      if (state[feature].sessions[sessionKey]) return { error: "Session already running" };

      const args = [feature, sessionId];
      const proc = spawn(process.execPath, [thisFile, ...args], { stdio: "ignore", detached: true });
      proc.unref();

      const sessionInfo = {
        proc,
        status: "running",
        startedAt: now
      };
      if (feature === "http" && port) sessionInfo.port = port;

      state[feature].sessions[sessionKey] = sessionInfo;
      state[feature].history.push({
        action, time: now, sessionId, port
      });
      return { success: true };
    }
    if (action === "stop") {
      if (!sessionId) return { error: "Session ID is required" };
      const sessionKey = feature === "http" && port ? `${sessionId}:${port}` : sessionId;
      if (!state[feature].sessions[sessionKey]) return { error: "No such session" };
      stopSession(feature, sessionKey);
      return { success: true };
    }
    return { error: "Unknown action" };
  }

  function stopSession(feature, sessionKey) {
    const session = state[feature].sessions[sessionKey];
    if (session && session.proc) {
      try { process.kill(session.proc.pid); } catch (e) {}
    }
    if (session) session.status = "stopped";
    delete state[feature].sessions[sessionKey];

    state[feature].history.push({
      action: "stop",
      time: new Date().toISOString(),
      sessionId: sessionKey.includes(":") ? sessionKey.split(":")[0] : sessionKey,
      port: sessionKey.includes(":") ? sessionKey.split(":")[1] : undefined
    });
  }

  return { getStatus, setFeature };
}



function runManageServer() {
  const featureManager = createFeatureManager();
  
  // Auto-start HTTP session 1 if flag is present
  if (startWebAt1) {
    const result = featureManager.setFeature("http", "start", "1");
    if (!result.success) {
      console.error("[manage] Failed to auto-start HTTP session 1:", result.error);
    } else {
      console.log("[manage] Auto-started HTTP session with ID 1.");
    }
  }

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204); res.end(); return;
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
      res.writeHead(200, { "Content-Type": "text/html" }); res.end(webPanelHtml);
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
  if (feature === "ssh") {
    await runSSHServer();
  } else if (feature === "http") {
    await runHTTPServer();
  } else if (feature === "manage") {
    runManageServer();
  }
})();