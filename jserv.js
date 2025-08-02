// JServ Centralized - Last updated: 2025-08-02 06:52:39 by jayaraj-c-22540

const admin = require("firebase-admin");
const pty = require("node-pty");
const fs = require("fs");
const path = require("path");
const http = require("http");
const url = require("url");
const { spawn } = require("child_process");
const os = require("os");

// Usage: node jserv.js ssh|http|manage [SESSION_ID] [options]

const initJsonPath = "./assets/init.json";
const webPanelHtmlPath = "./assets/feature_manager.html";
const serviceAccountPath = "./assets/firebase_config.json";

const feature = process.argv[2];

if (!feature || !["ssh", "http", "manage"].includes(feature)) {
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
const dbUrl = JSON.parse(initJson)["realtime_db_url"];

// Generate a unique server ID
const SERVER_ID = os.hostname() + "_" + Math.random().toString(36).substring(2, 10);

if (!dbUrl) {
  console.error(
    "The " + initJsonPath + " must contain 'realtime_db_url' of the firebase realtime db to function properly"
  );
  process.exit(1);
}

// Load firebase config
if (!fs.existsSync(serviceAccountPath)) {
  console.error("Missing firebase_config.json");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: dbUrl,
});

const db = admin.database();

// Central server registry
const serversRef = db.ref("servers");
// Command channel for communicating with servers
const commandsRef = db.ref("commands");

// Register this server in the central registry
async function registerServer(type, sessionId = null, port = null) {
  const serverInfo = {
    type,
    serverId: SERVER_ID,
    host: os.hostname(),
    ip: getServerIp(),
    pid: process.pid,
    status: "online",
    startedAt: admin.database.ServerValue.TIMESTAMP,
    lastHeartbeat: admin.database.ServerValue.TIMESTAMP
  };
  
  if (sessionId) serverInfo.sessionId = sessionId;
  if (port) serverInfo.port = port;
  
  // Register in central registry
  await serversRef.child(SERVER_ID).set(serverInfo);
  
  // Set up heartbeat
  const heartbeatInterval = setInterval(() => {
    serversRef.child(SERVER_ID).update({
      lastHeartbeat: admin.database.ServerValue.TIMESTAMP,
      status: "online"
    });
  }, 30000);
  
  // Set up automatic cleanup when server exits
  process.on('exit', () => {
    clearInterval(heartbeatInterval);
    try {
      // Use synchronous operations for cleanup during exit
      const deleteRequest = require('child_process').spawnSync('curl', [
        '-X', 'DELETE',
        `${dbUrl}/servers/${SERVER_ID}.json`
      ]);
    } catch (e) {
      // Can't do much during exit
    }
  });
  
  // Also set up cleanup for unexpected terminations
  ['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(signal => {
    process.on(signal, () => {
      clearInterval(heartbeatInterval);
      serversRef.child(SERVER_ID).update({ status: "shutting_down" })
        .then(() => serversRef.child(SERVER_ID).remove())
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  });
  
  return SERVER_ID;
}

// Get the server's IP address (for display purposes)
function getServerIp() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return 'unknown';
}

function refs(prefix) {
  return {
    input: db.ref(`${prefix}/input`),
    output: db.ref(`${prefix}/output`),
    state: db.ref(`${prefix}/state`),
  };
}

// ------------------- SSH FEATURE (SERVER) ------------------- //

async function runSSHServer() {
  if (!SESSION_ID) {
    console.error("SESSION_ID is mandatory");
    process.exit(1);
  }

  // Register this SSH server in the central registry
  await registerServer('ssh', SESSION_ID);
  console.log(`Registered SSH server with ID: ${SERVER_ID}`);

  const { input, output, state } = refs(`sessions/${SESSION_ID}/ssh`);
  state.set({ status: "connected", serverId: SERVER_ID });

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
    serversRef.child(SERVER_ID).update({ status: "exited" })
      .then(() => serversRef.child(SERVER_ID).remove())
      .then(() => process.exit(code || 0))
      .catch(() => process.exit(code || 0));
  });

  // Listen for stop commands only - SSH servers shouldn't spawn new processes
  commandsRef.child(SERVER_ID).on('child_added', async (snapshot) => {
    const command = snapshot.val();
    if (command && command.action === 'stop') {
      console.log('Received stop command, shutting down...');
      await snapshot.ref.remove();
      process.exit(0);
    }
    
    // Clean up the command
    snapshot.ref.remove();
  });

  console.log("SSH server running. Waiting for Firebase input. You can connect a client now.");
}

// ------------------- HTTP FEATURE (SERVER) ------------------- //

async function runHTTPServer() {
  if (!SESSION_ID) {
    console.error("SESSION_ID is mandatory");
    process.exit(1);
  }

  // Check if a port was provided
  let port = null;
  for (let i = 4; i < process.argv.length; i++) {
    if (process.argv[i] === "-port" && i + 1 < process.argv.length) {
      port = parseInt(process.argv[i + 1], 10);
      break;
    }
  }

  // Register this HTTP server in the central registry
  await registerServer('http', SESSION_ID, port);
  console.log(`Registered HTTP server with ID: ${SERVER_ID}`);

  const { input, output, state } = refs(`sessions/${SESSION_ID}/http`);
  state.set({ status: "connected", serverId: SERVER_ID, port });

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

  // Listen for stop commands only - HTTP servers shouldn't spawn new processes
  commandsRef.child(SERVER_ID).on('child_added', async (snapshot) => {
    const command = snapshot.val();
    if (command && command.action === 'stop') {
      console.log('Received stop command, shutting down...');
      await snapshot.ref.remove();
      process.exit(0);
    }
    
    // Clean up the command
    snapshot.ref.remove();
  });

  console.log("HTTP server proxy running. Waiting for HTTP requests from Firebase client.");
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

function runManageServer() {
  // Register this management server in the central registry
  registerServer('manage', null, MANAGE_PORT);
  console.log(`Management server registered with ID: ${SERVER_ID}`);
  
  // Create HTTP server for the management UI
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    
    if (req.method === "OPTIONS") {
      res.writeHead(204); 
      res.end(); 
      return;
    }

    // API endpoints
    if (req.url === "/api/status" && req.method === "GET") {
      try {
        // Fetch servers from Firebase
        const snapshot = await serversRef.once('value');
        const servers = snapshot.val() || {};
        
        // Group servers by type
        const result = {
          ssh: { servers: [] },
          http: { servers: [] },
          manage: { servers: [] }
        };
        
        Object.entries(servers).forEach(([key, server]) => {
          // Make sure we categorize servers correctly by their type
          const serverType = server.type || 'unknown';
          
          // Initialize the category if it doesn't exist
          if (!result[serverType]) {
            result[serverType] = { servers: [] };
          }
          
          const serverInfo = {
            serverId: server.serverId,
            sessionId: server.sessionId,
            host: server.host,
            ip: server.ip,
            port: server.port,
            startedAt: server.startedAt,
            status: server.status,
            pid: server.pid
          };
          
          result[serverType].servers.push(serverInfo);
        });
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        console.error("Error fetching status:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to fetch server status" }));
      }
    } 
    else if (req.url.startsWith("/api/feature/") && req.method === "POST") {
      let body = [];
      req.on("data", (chunk) => body.push(chunk));
      req.on("end", async () => {
        try {
          body = Buffer.concat(body).toString();
          const parsed = JSON.parse(body);
          const { action, sessionId, port, serverId } = parsed;
          const feature = req.url.split("/")[3];
          
          if (action === "start") {
            if (!sessionId) {
              res.writeHead(400, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ error: "Session ID is required" }));
            }
            
            // For feature starts, we directly spawn the process from the management server
            // instead of sending commands to other servers
            
            // Validate the feature type
            if (!['ssh', 'http'].includes(feature)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ error: "Invalid feature type" }));
            }
            
            // Construct the arguments
            const args = [feature, sessionId];
            if (feature === 'http' && port) {
              args.push('-port', port.toString());
            }
            
            // Spawn the new process
            const proc = spawn(process.execPath, [thisFile, ...args], {
              stdio: 'ignore',
              detached: true
            });
            proc.unref();
            
            console.log(`Started new ${feature} session with ID ${sessionId}, PID: ${proc.pid}`);
            
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ 
              success: true,
              message: `Started ${feature} session with ID ${sessionId}`
            }));
          } 
          else if (action === "stop") {
            if (!serverId) {
              res.writeHead(400, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ error: "Server ID is required" }));
            }
            
            // Check if the server exists
            const serverSnapshot = await serversRef.child(serverId).once('value');
            if (!serverSnapshot.exists()) {
              res.writeHead(404, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ error: "Server not found" }));
            }
            
            // Send command to stop server
            const commandRef = commandsRef.child(serverId).push();
            await commandRef.set({
              action: "stop",
              timestamp: admin.database.ServerValue.TIMESTAMP
            });
            
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true }));
          } 
          else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown action" }));
          }
        } catch (e) {
          console.error("API error:", e);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid request" }));
        }
      });
    } 
    else if (req.url === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html" }); 
      res.end(webPanelHtml);
    } 
    else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });
  
  server.listen(MANAGE_PORT, () => {
    console.log(`Feature management UI running on http://localhost:${MANAGE_PORT}/`);
  });

  // Listen for commands directed to this management server
  commandsRef.child(SERVER_ID).on('child_added', async (snapshot) => {
    const command = snapshot.val();
    if (command && command.action === 'stop') {
      console.log('Received stop command, shutting down...');
      await snapshot.ref.remove();
      process.exit(0);
    }
    // Clean up the command
    snapshot.ref.remove();
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