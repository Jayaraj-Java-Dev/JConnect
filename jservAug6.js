const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const http = require("http");
const url = require("url");
const os = require("os");
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { spawn } = require('child_process');

// Usage: node jserv.js ssh|http|manage [SESSION_ID] [options]

const initJsonPath = "./assets/init.json";
const webPanelHtmlPath = "./assets/feature_manager.html";                                           const serviceAccountPath = "./assets/firebase_config.json";
const thisFile = require.main.filename;

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

const dbUrl = JSON.parse(initJson)["realtime_db_url"];
if (!dbUrl) {
  console.error(
    "The " + initJsonPath + " must contain 'realtime_db_url' of the firebase realtime db to function properly"
  );
  process.exit(1);
}

// This class handles all Firebase interactions with a single listener
class JServController {
  constructor() {
    this.childProcesses = new Map(); // Map of server IDs to their child processes
    this.workers = new Map(); // Map of worker IDs to their worker threads
    this.db = null;
    this.serversRef = null;
    this.commandsRef = null;
    this.sessionsRef = null;
    // Use just hostname as server ID to ensure consistency between restarts
    this.SERVER_ID = os.hostname();
    this.commandListener = null;
    this.heartbeatInterval = null;
    this.isManageServer = false;
  }

  async init() {
    // Initialize Firebase only once
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: dbUrl,
    });

    this.db = admin.database();
    this.serversRef = this.db.ref("servers");
    this.commandsRef = this.db.ref("commands");
    this.sessionsRef = this.db.ref("sessions");

    // Set up a single command listener for all servers
    this.setupCommandListener();

    // Set up cleanup on exit
    this.setupCleanup();
  }

  setupCommandListener() {
    // Use a single listener for all commands targeting this server
    this.commandListener = this.commandsRef.child(this.SERVER_ID).on('child_added', async (commandSnapshot) => {
      const command = commandSnapshot.val();

      console.log(`Received command for this server:`, command);

      // Always remove the command first to avoid re-processing
      await commandSnapshot.ref.remove();

      if (command && command.action) {
        await this.handleCommand(command);
      }
    });
  }

  async handleCommand(command) {
    console.log(`Handling command: ${command.action}`);

    if (command.action === 'stop') {
      // Stop the main server
      console.log('Stopping main server...');
      this.cleanup();
      process.exit(0);
    }
    else if (command.action === 'startSSH') {
      // Start SSH feature locally
      const { sessionId } = command;
      if (sessionId) {
        console.log(`Starting SSH session ${sessionId} on this server`);
        await this.startSSH(sessionId);
      }
    }
    else if (command.action === 'stopSSH') {
      // Stop SSH feature locally
      const { sessionId } = command;
      if (sessionId) {
        console.log(`Stopping SSH session ${sessionId} on this server`);
        await this.stopFeature('ssh', sessionId);
      }
    }
    else if (command.action === 'startHTTP') {
      // Start HTTP feature locally
      const { sessionId, port } = command;
      if (sessionId) {
        console.log(`Starting HTTP session ${sessionId} on port ${port} on this server`);
        await this.startHTTP(sessionId, port);
      }
    }
    else if (command.action === 'stopHTTP') {
      // Stop HTTP feature locally
      const { sessionId } = command;
      if (sessionId) {
        console.log(`Stopping HTTP session ${sessionId} on this server`);
        await this.stopFeature('http', sessionId);
      }
    }
  }

  // Generate a consistent server ID for a feature
  generateFeatureServerId(feature, sessionId) {
    return `${this.SERVER_ID}_${feature}_${sessionId}`;
  }

  // Stop a feature by sessionId
  async stopFeature(feature, sessionId) {
    const serverId = this.generateFeatureServerId(feature, sessionId);

    console.log(`Stopping ${feature} feature with serverId: ${serverId}`);

    if (feature === 'ssh' && this.childProcesses.has(serverId)) {
      const childProcess = this.childProcesses.get(serverId);
      childProcess.kill('SIGTERM');
      this.childProcesses.delete(serverId);

      // Update session state
      const refs = this.refs(`sessions/${sessionId}/ssh`);
      await refs.info.update({ status: "stopped" });
      await refs.state.set({ status: "stopped" });

      console.log(`SSH process ${serverId} terminated`);
      return true;
    }
    else if (feature === 'http' && this.workers.has(serverId)) {
      const worker = this.workers.get(serverId);
      worker.postMessage({ type: 'stop' });
      this.workers.delete(serverId);

      // Update session state
      const refs = this.refs(`sessions/${sessionId}/http`);
      await refs.info.update({ status: "stopped" });
      await refs.state.set({ status: "stopped" });

      console.log(`HTTP worker ${serverId} terminated`);
      return true;
    }

    console.log(`No ${feature} process found with serverId: ${serverId}`);
    return false;
  }

  setupCleanup() {
    // Only set up heartbeat if this is a manage server
    if (this.isManageServer) {
      this.heartbeatInterval = setInterval(() => {
        // Update only the main server's heartbeat in the server registry
        this.serversRef.child(this.SERVER_ID).update({
          lastHeartbeat: admin.database.ServerValue.TIMESTAMP,
          status: "online"
        });
      }, 30000);
    }

    const cleanup = async () => {
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
      }

      // Remove server record only if this is a manage server
      if (this.isManageServer) {
        try {
          await this.serversRef.child(this.SERVER_ID).remove();
        } catch (e) {
          console.error('Failed to remove main server from registry', e);
        }
      }

      // Terminate all worker threads
      for (const [serverId, worker] of this.workers.entries()) {
        try {
          console.log(`Terminating worker: ${serverId}`);
          worker.terminate();
        } catch (e) {
          console.error(`Failed to terminate worker thread ${serverId}:`, e);
        }
      }

      // Kill all child processes
      for (const [serverId, childProcess] of this.childProcesses.entries()) {
        try {
          console.log(`Killing child process: ${serverId}`);
          childProcess.kill('SIGTERM');
        } catch (e) {
          console.error(`Failed to terminate child process ${serverId}:`, e);
        }
      }

      // Remove command listener
      if (this.commandListener) {
        this.commandsRef.child(this.SERVER_ID).off('child_added', this.commandListener);
      }
    };

    // Handle various termination signals
    ['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(signal => {
      process.on(signal, async () => {
        console.log(`Received ${signal}, cleaning up...`);
        await cleanup();
        process.exit(0);
      });
    });

    // Cleanup on normal exit
    process.on('exit', () => {
      // During exit, we can only use synchronous operations
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
      }

      // Kill all child processes (synchronously)
      for (const childProcess of this.childProcesses.values()) {
        try {
          childProcess.kill('SIGKILL');
        } catch (e) {
          // Can't do much during exit
        }
      }
    });
  }

  // Helper to create database references
  refs(prefix) {
    return {
      input: this.db.ref(`${prefix}/input`),
      output: this.db.ref(`${prefix}/output`),
      state: this.db.ref(`${prefix}/state`),
      info: this.db.ref(`${prefix}/info`),
    };
  }

  // Get detailed system information
  getSystemInfo() {
    return {
      hostname: os.hostname(),
      ip: this.getServerIp(),
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      memory: {
        total: os.totalmem(),
        free: os.freemem()
      },
      uptime: os.uptime(),
      username: os.userInfo().username
    };
  }

  // Get the server's IP address
  getServerIp() {
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

  // Register only manage servers in the central registry
  async registerManageServer(port) {
    this.isManageServer = true;

    const serverInfo = {
      type: 'manage',
      serverId: this.SERVER_ID,
      host: os.hostname(),
      ip: this.getServerIp(),
      port,
      pid: process.pid,
      status: "online",
      startedAt: admin.database.ServerValue.TIMESTAMP,
      lastHeartbeat: admin.database.ServerValue.TIMESTAMP
    };

    // Register in central registry - only for manage servers
    await this.serversRef.child(this.SERVER_ID).set(serverInfo);

    return this.SERVER_ID;
  }

  // Start SSH feature using a child process (not worker thread due to node-pty limitations)
  async startSSH(sessionId) {
    // Create a consistent server ID using hostname and session ID
    const serverId = this.generateFeatureServerId('ssh', sessionId);

    // Check if this SSH session is already running
    if (this.childProcesses.has(serverId)) {
      console.log(`SSH session ${sessionId} is already running with ID: ${serverId}`);
      return serverId;
    }

    // Create a child process for SSH
    const childProcess = spawn(process.execPath, [thisFile, 'ssh', sessionId, '--serverId', serverId], {
      stdio: 'inherit', // Changed to inherit for better debugging
      detached: false // Keep attached to parent for proper management
    });

    this.childProcesses.set(serverId, childProcess);

    // Handle child process events
    childProcess.on('exit', async (code) => {
      console.log(`SSH child process ${serverId} exited with code: ${code}`);
      this.childProcesses.delete(serverId);

      // Update session info to show process exited
      const refs = this.refs(`sessions/${sessionId}/ssh`);
      await refs.info.update({ status: "exited", exitCode: code });
      await refs.state.set({ status: "exited", code });
    });

    childProcess.on('error', async (error) => {
      console.error(`SSH child process ${serverId} error:`, error);
      this.childProcesses.delete(serverId);

      // Update session info with error
      const refs = this.refs(`sessions/${sessionId}/ssh`);
      await refs.info.update({
        status: "error",
        error: error.message
      });
      await refs.state.set({ status: "error", error: error.message });
    });

    return serverId;
  }

  // Start HTTP feature in a worker thread
  async startHTTP(sessionId, port) {
    // Create a consistent server ID using hostname and session ID
    const serverId = this.generateFeatureServerId('http', sessionId);

    // Check if this HTTP session is already running
    if (this.workers.has(serverId)) {
      console.log(`HTTP session ${sessionId} is already running with ID: ${serverId}`);
      return serverId;
    }

    // Create a worker thread for HTTP
    const worker = new Worker(__filename, {
      workerData: {
        type: 'http',
        sessionId,
        port,
        serverId,
        dbUrl
      }
    });

    this.workers.set(serverId, worker);

    // Handle worker messages
    worker.on('message', async (message) => {
      if (message.type === 'exit') {
        console.log(`HTTP worker ${serverId} exited with code: ${message.code}`);

        // Update session info to show worker exited
        const refs = this.refs(`sessions/${sessionId}/http`);
        await refs.info.update({ status: "exited", exitCode: message.code });
        await refs.state.set({ status: "exited", code: message.code });

        this.workers.delete(serverId);
      }
    });

    worker.on('error', async (error) => {
      console.error(`HTTP worker ${serverId} error:`, error);

      // Update session info with error
      const refs = this.refs(`sessions/${sessionId}/http`);
      await refs.info.update({
        status: "error",
        error: error.message
      });
      await refs.state.set({ status: "error", error: error.message });

      this.workers.delete(serverId);
    });

    worker.on('exit', async (code) => {
      if (this.workers.has(serverId)) {
        // Update session info
        const refs = this.refs(`sessions/${sessionId}/http`);
        await refs.info.update({ status: "exited", exitCode: code });
        await refs.state.set({ status: "exited", code });

        this.workers.delete(serverId);
      }
    });

    return serverId;
  }

  // Run the management server
  async runManageServer(port = 55777) {
    // Register only the management server in /servers
    await this.registerManageServer(port);
    console.log(`Management server registered with ID: ${this.SERVER_ID}`);

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
          // Fetch only manage servers from Firebase /servers
          const serversSnapshot = await this.serversRef.once('value');
          const servers = serversSnapshot.val() || {};

          // Load all active sessions for SSH/HTTP info
          const sessionsSnapshot = await this.sessionsRef.once('value');
          const sessions = sessionsSnapshot.val() || {};

          const result = {
            manage: { servers: [] },
            ssh: { servers: [] },
            http: { servers: [] }
          };

          // Process manage servers from /servers registry
          Object.entries(servers).forEach(([serverId, server]) => {
            if (server.type === 'manage') {
              result.manage.servers.push({
                serverId: server.serverId,
                host: server.host,
                ip: server.ip,
                port: server.port,
                startedAt: server.startedAt,
                status: server.status,
                pid: server.pid
              });
            }
          });

          // Process sessions for SSH and HTTP info
          Object.entries(sessions).forEach(([sessionId, sessionData]) => {
            // Add SSH servers from sessions
            if (sessionData.ssh && sessionData.ssh.info) {
              const sshInfo = sessionData.ssh.info;
              result.ssh.servers.push({
                serverId: sshInfo.serverId,
                sessionId,
                host: sshInfo.server ? sshInfo.server.hostname : 'unknown',
                ip: sshInfo.server ? sshInfo.server.ip : 'unknown',
                startedAt: sshInfo.startedAt,
                status: sshInfo.status,
                pid: sshInfo.pid,
                sessionInfo: sshInfo
              });
            }

            // Add HTTP servers from sessions
            if (sessionData.http && sessionData.http.info) {
              const httpInfo = sessionData.http.info;
              result.http.servers.push({
                serverId: httpInfo.serverId,
                sessionId,
                host: httpInfo.server ? httpInfo.server.hostname : 'unknown',
                ip: httpInfo.server ? httpInfo.server.ip : 'unknown',
                port: httpInfo.port,
                startedAt: httpInfo.startedAt,
                status: httpInfo.status,
                pid: httpInfo.pid,
                sessionInfo: httpInfo
              });
            }
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          console.error("Error fetching status:", error);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to fetch server status" }));
        }
      }
      else if (req.url === "/api/sessions" && req.method === "GET") {
        try {
          // Fetch sessions from Firebase
          const snapshot = await this.sessionsRef.once('value');
          const sessions = snapshot.val() || {};

          // Format sessions for the UI
          const result = [];
          Object.entries(sessions).forEach(([sessionId, data]) => {
            const sessionInfo = {
              sessionId,
              features: []
            };

            // Add SSH feature if present
            if (data.ssh && data.ssh.info) {
              sessionInfo.features.push({
                type: 'ssh',
                info: data.ssh.info,
                status: data.ssh.state ? data.ssh.state.status : 'unknown'
              });
            }

            // Add HTTP feature if present
            if (data.http && data.http.info) {
              sessionInfo.features.push({
                type: 'http',
                info: data.http.info,
                port: data.http.info.port,
                status: data.http.state ? data.http.state.status : 'unknown'
              });
            }

            result.push(sessionInfo);
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          console.error("Error fetching sessions:", error);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to fetch sessions" }));
        }
      }
      else if (req.url.startsWith("/api/feature/") && req.method === "POST") {
        let body = [];
        req.on("data", (chunk) => body.push(chunk));
        req.on("end", async () => {
          try {
            body = Buffer.concat(body).toString();
            const parsed = JSON.parse(body);
            const { action, sessionId, port, serverId: targetServerId } = parsed;
            const feature = req.url.split("/")[3];

            if (!['ssh', 'http'].includes(feature)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ error: "Invalid feature type" }));
            }

            if (action === "start") {
              if (!sessionId) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: "Session ID is required" }));
              }

              // Always send commands to specific servers via Firebase
              // This centralizes all start/stop operations through the command system

              // Determine which server should handle this
              let targetServer = targetServerId || this.SERVER_ID;

              // Send the command
              const commandRef = this.commandsRef.child(targetServer).push();
              if (feature === 'ssh') {
                await commandRef.set({
                  action: "startSSH",
                  sessionId,
                  timestamp: admin.database.ServerValue.TIMESTAMP
                });
              } else if (feature === 'http') {
                await commandRef.set({
                  action: "startHTTP",
                  sessionId,
                  port,
                  timestamp: admin.database.ServerValue.TIMESTAMP
                });
              }

              // Calculate what the server ID will be
              const resultServerId = `${targetServer}_${feature}_${sessionId}`;
              console.log(`Sent start command for ${feature} session ${sessionId} to server ${targetServer}`);

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                success: true,
                message: `Started ${feature} session with ID ${sessionId}`,
                serverId: resultServerId
              }));
            }
            else if (action === "stop") {
              if (!sessionId) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: "Session ID is required" }));
              }

              // Always stop via Firebase commands for consistency
              // Parse serverId to get the server that's running it
              let targetServer = targetServerId;

              // If targetServerId includes sessionId, extract the server part
              if (targetServerId && targetServerId.includes(sessionId)) {
                // Format is: serverName_feature_sessionId
                targetServer = targetServerId.split(`_${feature}_${sessionId}`)[0];
              }

              // If we can't determine the server, use this server
              if (!targetServer) {
                targetServer = this.SERVER_ID;
              }

              // Send stop command
              const commandRef = this.commandsRef.child(targetServer).push();

              if (feature === 'ssh') {
                await commandRef.set({
                  action: "stopSSH",
                  sessionId,
                  timestamp: admin.database.ServerValue.TIMESTAMP
                });
              } else if (feature === 'http') {
                await commandRef.set({
                  action: "stopHTTP",
                  sessionId,
                  timestamp: admin.database.ServerValue.TIMESTAMP
                });
              }

              console.log(`Sent stop command for ${feature} session ${sessionId} to server ${targetServer}`);

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                success: true,
                message: `Stopped ${feature} session with ID ${sessionId}`
              }));
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

    server.listen(port, () => {
      console.log(`Feature management UI running on http://localhost:${port}/`);
    });
  }

  cleanup() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Remove all Firebase listeners
    if (this.commandListener) {
      this.commandsRef.child(this.SERVER_ID).off('child_added', this.commandListener);
    }
  }
}

// SSH implementation (runs in its own process)
async function runSSHServer(sessionId, serverId) {
  // Import node-pty here, only in the SSH process
  const pty = require("node-pty");

  // Initialize Firebase
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: dbUrl,
  });

  const db = admin.database();
  const commandsRef = db.ref("commands");

  // Set up the session references - store detailed info here, not in /servers
  const sessionInfoRef = db.ref(`sessions/${sessionId}/ssh/info`);
  const sessionStateRef = db.ref(`sessions/${sessionId}/ssh/state`);
  const sessionInputRef = db.ref(`sessions/${sessionId}/ssh/input`);
  const sessionOutputRef = db.ref(`sessions/${sessionId}/ssh/output`);

  // Set system info helper function in SSH process
  function getSystemInfo() {
    return {
      hostname: os.hostname(),
      ip: getServerIp(),
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      memory: {
        total: os.totalmem(),
        free: os.freemem()
      },
      uptime: os.uptime(),
      username: os.userInfo().username
    };
  }

  // Get IP helper function in SSH process
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

  // Store detailed server information in session info only
  await sessionInfoRef.set({
    server: getSystemInfo(),
    serverId,
    pid: process.pid,
    status: "online",
    startedAt: admin.database.ServerValue.TIMESTAMP,
    lastHeartbeat: admin.database.ServerValue.TIMESTAMP
  });

  // Set up heartbeat for session info only
  const heartbeatInterval = setInterval(() => {
    sessionInfoRef.update({
      lastHeartbeat: admin.database.ServerValue.TIMESTAMP,
      status: "online"
    });
  }, 30000);

  // Set up command listener for this specific serverId
  const commandListener = commandsRef.child(serverId).on('child_added', async (snapshot) => {
    const command = snapshot.val();
    console.log(`SSH process received command:`, command);

    // Always remove the command first to avoid re-processing
    await snapshot.ref.remove();

    if (command && command.action === 'stop') {
      console.log('Received stop command, shutting down SSH process...');
      process.exit(0);
    }
  });

  // Set up cleanup
  ['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(signal => {
    process.on(signal, async () => {
      clearInterval(heartbeatInterval);
      commandsRef.child(serverId).off('child_added', commandListener);

      // Update session info and state
      await sessionInfoRef.update({ status: "shutting_down" });
      await sessionStateRef.set({ status: "disconnected", code: 0 });

      process.exit(0);
    });
  });

  // Update state to connected
  await sessionStateRef.set({ status: "connected", serverId });

  const shell = pty.spawn("/bin/bash", [], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: process.env.HOME,
    env: process.env,
  });

  shell.on("data", (data) => {
    sessionOutputRef.push({ data: Buffer.from(data, "utf8").toString("base64") });
  });

  sessionInputRef.on("child_added", (snapshot) => {
    const val = snapshot.val();
    if (val && val.data) {
      const buf = Buffer.from(val.data, "base64");
      shell.write(buf.toString("utf8"));
    }
    snapshot.ref.remove();
  });

  shell.on("exit", async (code) => {
    // Update session info and state
    await sessionInfoRef.update({ status: "exited", exitCode: code });
    await sessionStateRef.set({ status: "exited", code });

    clearInterval(heartbeatInterval);
    commandsRef.child(serverId).off('child_added', commandListener);

    process.exit(code || 0);
  });

  console.log(`SSH server running for session ${sessionId} with ID ${serverId}`);
}

// Worker Thread Implementation for HTTP
async function runHTTPWorker(data) {
  const { sessionId, serverId, dbUrl, port } = data;

  // Initialize Firebase within the worker
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: dbUrl,
  });

  const db = admin.database();
  const commandsRef = db.ref("commands");

  // Set system info helper function in HTTP worker
  function getSystemInfo() {
    return {
      hostname: os.hostname(),
      ip: getServerIp(),
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      memory: {
        total: os.totalmem(),
        free: os.freemem()
      },
      uptime: os.uptime(),
      username: os.userInfo().username
    };
  }

  // Get IP helper function in HTTP worker
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

  // Set up session references - store detailed info here, not in /servers
  const sessionInfoRef = db.ref(`sessions/${sessionId}/http/info`);
  const sessionStateRef = db.ref(`sessions/${sessionId}/http/state`);
  const sessionInputRef = db.ref(`sessions/${sessionId}/http/input`);
  const sessionOutputRef = db.ref(`sessions/${sessionId}/http/output`);

  // Store detailed server information in session info only
  await sessionInfoRef.set({
    server: getSystemInfo(),
    serverId,
    port,
    pid: process.pid,
    status: "online",
    startedAt: admin.database.ServerValue.TIMESTAMP,
    lastHeartbeat: admin.database.ServerValue.TIMESTAMP
  });

  // Set up heartbeat for session info only
  const heartbeatInterval = setInterval(() => {
    sessionInfoRef.update({
      lastHeartbeat: admin.database.ServerValue.TIMESTAMP,
      status: "online"
    });
  }, 30000);

  // Set up command listener for the specific serverId
  const commandListener = commandsRef.child(serverId).on('child_added', async (snapshot) => {
    const command = snapshot.val();
    console.log(`HTTP worker received command:`, command);

    // Always remove the command first to avoid re-processing
    await snapshot.ref.remove();

    if (command && command.action === 'stop') {
      console.log('Received stop command, shutting down HTTP worker...');

      // Clean up
      clearInterval(heartbeatInterval);
      commandsRef.child(serverId).off('child_added', commandListener);
      sessionInputRef.off("child_added", inputHandler);

      // Update session info and state
      await sessionInfoRef.update({ status: "stopped" });
      await sessionStateRef.set({ status: "stopped" });

      // Send exit message to parent
      parentPort.postMessage({ type: 'exit', code: 0 });

      // Allow some time for the message to be sent before exiting
      setTimeout(() => process.exit(0), 500);
    }
  });

  // Update state to connected
  await sessionStateRef.set({ status: "connected", serverId, port });

  // Setup input handler
  const inputHandler = sessionInputRef.on("child_added", async (snapshot) => {
    const val = snapshot.val();
    if (
      val &&
      val.reqId &&
      val.port &&
      val.method &&
      typeof val.uri === "string"
    ) {
      // Capture client info if present
      if (val.clientInfo && !await sessionInfoRef.child('client').once('value').then(snap => snap.exists())) {
        await sessionInfoRef.child('client').set(val.clientInfo);
      }

      const options = {
        hostname: "localhost",
        port: parseInt(val.port, 10),
        path: val.uri,
        method: val.method,
        headers: val.headers,
        timeout: 100000,
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

      sessionOutputRef.push({
        reqId: val.reqId,
        status,
        headers,
        body: respData.toString("base64"),
      });
    }
    snapshot.ref.remove();
  });

  // Listen for messages from the main thread
  parentPort.on('message', async (message) => {
    if (message.type === 'stop') {
      // Clean up
      clearInterval(heartbeatInterval);
      commandsRef.child(serverId).off('child_added', commandListener);
      sessionInputRef.off("child_added", inputHandler);

      // Update session info and state
      await sessionInfoRef.update({ status: "stopped" });
      await sessionStateRef.set({ status: "stopped" });

      // Send exit message to parent
      parentPort.postMessage({ type: 'exit', code: 0 });
    }
  });

  // Clean up on worker exit
  process.on('exit', () => {
    clearInterval(heartbeatInterval);
  });

  console.log(`HTTP worker running for session ${sessionId}, port ${port}, serverId: ${serverId}`);
}

// Main execution path
if (isMainThread) {
  // Main thread code
  const feature = process.argv[2];

  if (!feature || !["ssh", "http", "manage"].includes(feature)) {
    console.error(
      "Usage: node jserv.js ssh|http|manage [SESSION_ID] [options]\n" +
      "To manage state: node jserv.js manage"
    );
    process.exit(1);
  }

  // Parse the --serverId argument for SSH child processes
  let customServerId = null;
  for (let i = 3; i < process.argv.length; i++) {
    if (process.argv[i] === '--serverId' && i + 1 < process.argv.length) {
      customServerId = process.argv[i + 1];
      break;
    }
  }

  // Special case for SSH child process
  if (feature === "ssh" && customServerId) {
    const SESSION_ID = process.argv[3];
    if (!SESSION_ID) {
      console.error("SESSION_ID is mandatory");
      process.exit(1);
    }

    runSSHServer(SESSION_ID, customServerId);
  }
  // Normal case for starting the controller
  else {
    // Create and initialize the controller
    const controller = new JServController();

    (async () => {
      await controller.init();

      if (feature === "manage") {
        // Determine port for manage feature
        let MANAGE_PORT = 55777;
        if (process.argv.length > 3 && /^\d+$/.test(process.argv[3])) {
          const portNum = parseInt(process.argv[3], 10);
          if (portNum > 0 && portNum < 65536) MANAGE_PORT = portNum;
        }

        await controller.runManageServer(MANAGE_PORT);
      } else {
        // For direct execution (not using commands), we'll use the command system internally
        const SESSION_ID = process.argv[3];

        if (!SESSION_ID) {
          console.error("SESSION_ID is mandatory");
          process.exit(1);
        }

        // Push command to start the feature for this server
        const commandRef = controller.commandsRef.child(controller.SERVER_ID).push();

        if (feature === "ssh") {
          await commandRef.set({
            action: "startSSH",
            sessionId: SESSION_ID,
            timestamp: admin.database.ServerValue.TIMESTAMP
          });
        } else if (feature === "http") {
          // Check if a port was provided
          let port = null;
          for (let i = 4; i < process.argv.length; i++) {
            if (process.argv[i] === "-port" && i + 1 < process.argv.length) {
              port = parseInt(process.argv[i + 1], 10);
              break;
            }
          }

          await commandRef.set({
            action: "startHTTP",
            sessionId: SESSION_ID,
            port,
            timestamp: admin.database.ServerValue.TIMESTAMP
          });
        }
      }
    })();
  }
} else {
  // Worker thread code
  const data = workerData;

  if (data.type === 'http') {
    runHTTPWorker(data);
  }
}
