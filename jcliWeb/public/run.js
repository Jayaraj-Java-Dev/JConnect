// --- State Management ---
var state = {
    firebaseConfig: null, firebaseApp: null, activeSessionKey: null,
    terminalInstances: {}, serverData: {}, sessionsData: {},
    isSidebarCollapsed: false, isSettingsOpen: false, isNewSessionOpen: false,
};

document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const appContainer = document.getElementById('app-container');
    const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    const serverListEl = document.getElementById('server-list');
    const sessionListEl = document.getElementById('session-list');
    const tabBarEl = document.getElementById('tab-bar');
    const terminalHostEl = document.getElementById('terminal-host');
    const welcomeScreenEl = document.getElementById('welcome-screen');
    const modalBackdrop = document.getElementById('modal-backdrop');
    const settingsModal = document.getElementById('settings-modal');
    const newSessionModal = document.getElementById('new-session-modal');
    const addSessionBtn = document.getElementById('add-session-btn');
    const serverSelect = document.getElementById('server-select');
    const sessionIdInput = document.getElementById('session-id-input');
    const startSessionBtn = document.getElementById('start-session-btn');
    const notificationContainer = document.getElementById('notification-container');

    // --- Constants & Helpers ---
    const ICONS = {
        menu: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"></path></svg>',
        close: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"></path></svg>',
        delete: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"></path></svg>'
    };
    const isMobile = () => window.innerWidth <= 768;
    const formatUptime = (seconds) => {
        if (typeof seconds !== 'number' || isNaN(seconds)) return 'N/A';
        if (seconds < 60) return `${Math.floor(seconds)}s`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
        return `${Math.floor(seconds / 86400)}d`;
    };
    const formatBytes = (bytes) => {
        if (typeof bytes !== 'number' || isNaN(bytes) || bytes === 0) return '0 B';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(1))} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`;
    };
    const AppStorage = {
        loadConfig: () => state.firebaseConfig = JSON.parse(localStorage.getItem('jconnect_firebaseConfig') || 'null'),
        saveConfig: () => localStorage.setItem('jconnect_firebaseConfig', JSON.stringify(state.firebaseConfig)),
    };

    // --- Notification Manager ---
    function showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.textContent = message;
        notificationContainer.appendChild(notification);
        setTimeout(() => notification.classList.add('show'), 10);
        setTimeout(() => {
            notification.classList.remove('show');
            notification.addEventListener('transitionend', () => notification.remove());
        }, 5000);
    }

    // --- Centralized Rendering ---
    function render() {
        serverListEl.innerHTML = Object.values(state.serverData || {}).map(server => {
            if (!server || !server.host || !server.ip) return '';
            return `<li class="compact"><span class="status-dot ${server.status === 'online' ? 'online' : 'offline'}"></span><span class="item-name">${server.host}</span><span class="item-info">${server.ip}</span></li>`;
        }).join('') || '<li class="item-info" style="padding: 10px 20px;">No servers found.</li>';
        
        sessionListEl.innerHTML = Object.keys(state.sessionsData || {}).map(sessionKey => {
            const session = state.sessionsData[sessionKey];
            if (!session || !session.ssh || !session.ssh.info || !session.ssh.info.server) return '';
            const { info } = session.ssh;
            const statusClass = info.status === 'online' ? (Date.now() - info.lastHeartbeat < 15000 ? 'online' : 'stale') : 'offline';
            let tooltip = `Status: ${info.status}`;
            let memoryBarHtml = '';
            const hasMemoryData = info.server.memory && typeof info.server.memory.total === 'number' && typeof info.server.memory.free === 'number';
            const hasUptimeData = typeof info.server.uptime === 'number';
            if (hasMemoryData) {
                const memUsed = info.server.memory.total - info.server.memory.free;
                const memPercent = (memUsed / info.server.memory.total) * 100;
                tooltip = `Memory: ${memPercent.toFixed(1)}% (${formatBytes(memUsed)} / ${formatBytes(info.server.memory.total)})`;
                if (hasUptimeData) tooltip += `\nUptime: ${formatUptime(info.server.uptime)}`;
                memoryBarHtml = `<div class="memory-bar"><div class="memory-bar-inner ${memPercent > 90 ? 'critical' : memPercent > 75 ? 'high' : ''}" style="width: ${memPercent}%;"></div></div>`;
            } else if (hasUptimeData) {
                tooltip = `Uptime: ${formatUptime(info.server.uptime)}`;
            }
            return `<li class="clickable" data-id="${sessionKey}" title="${tooltip}">
                        <div class="item-header">
                            <div class="item-name"><span class="status-dot ${statusClass}"></span>${info.server.username || '...'}@${info.server.hostname || '...'}</div>
                            <span class="item-info">${info.serverId || sessionKey}</span>
                        </div>
                        ${memoryBarHtml}
                        <button class="icon-btn session-delete-btn" data-id="${sessionKey}" title="Delete Session">${ICONS.delete}</button>
                    </li>`;
        }).join('') || '<li class="item-info" style="padding: 10px 20px;">No sessions found.</li>';

        tabBarEl.innerHTML = Object.keys(state.terminalInstances || {}).map(sessionKey => {
            const session = state.sessionsData[sessionKey];
            if (!session || !session.ssh || !session.ssh.info || !session.ssh.info.server) return '';
            return `<div class="tab ${sessionKey === state.activeSessionKey ? 'active' : ''}" data-id="${sessionKey}"><span class="tab-name">${session.ssh.info.server.username}@${session.ssh.info.server.hostname} [${session.ssh.info.serverId}]</span><button class="icon-btn tab-close-btn" data-id="${sessionKey}">${ICONS.close}</button></div>`;
        }).join('');

        modalBackdrop.classList.toggle('active', state.isSettingsOpen || state.isNewSessionOpen);
        settingsModal.classList.toggle('active', state.isSettingsOpen);
        newSessionModal.classList.toggle('active', state.isNewSessionOpen);
        welcomeScreenEl.classList.toggle('hidden', state.activeSessionKey !== null);
    }
    
    // --- Firebase Logic ---
    function connectToFirebase() {
        if (!state.firebaseConfig) { state.isSettingsOpen = true; render(); return; }
        try {
            if (state.firebaseApp) { state.firebaseApp.delete().catch(console.error); state.firebaseApp = null; }
            state.firebaseApp = firebase.initializeApp(state.firebaseConfig);
            const db = state.firebaseApp.database();
            db.ref('servers').on('value', (snapshot) => { state.serverData = snapshot.val() || {}; render(); });
            db.ref('sessions').on('value', (snapshot) => {  state.sessionsData = snapshot.val() || {}; render(); });
        } catch (e) { showNotification(`Firebase connection failed: ${e.message}`, 'error'); }
    }

    // --- UI Interaction & State Logic ---
    function setSidebarCollapsed(collapsed) {
        state.isSidebarCollapsed = collapsed;
        appContainer.classList.toggle('sidebar-collapsed', state.isSidebarCollapsed);
        sidebarToggleBtn.innerHTML = state.isSidebarCollapsed ? ICONS.menu : ICONS.close;
        // After the sidebar animation completes, resize the active terminal.
        setTimeout(() => resizeActiveTerminal(), 300);
    }
    
    function setActiveSession(sessionKey) {
        if (isMobile()) {
            setSidebarCollapsed(true); // Always collapse sidebar on mobile when a session is activated
        }
        if (state.activeSessionKey === sessionKey && sessionKey !== null) return;
        if (state.activeSessionKey && state.terminalInstances[state.activeSessionKey]) { document.getElementById(`term-${state.activeSessionKey}`).classList.remove('active'); }
        state.activeSessionKey = sessionKey;
        if (sessionKey === null) { render(); return; }
        if (state.terminalInstances[sessionKey]) {
            document.getElementById(`term-${sessionKey}`).classList.add('active');
            const term = state.terminalInstances[sessionKey].term;
            setTimeout(() => { term.fitAddon.fit(); term.focus(); }, 0);
        } else {
            welcomeScreenEl.classList.add('hidden');
            const termContainer = document.createElement('div');
            termContainer.id = `term-${sessionKey}`;
            termContainer.className = 'terminal-instance active';
            terminalHostEl.appendChild(termContainer);
            const term = new Terminal({ cursorBlink: true, fontSize: 14, padding: 15, theme: { background: '#111827', foreground: '#F9FAFB', cursor: '#22d3ee', selection: 'rgba(34, 211, 238, 0.3)' } });
            const fitAddon = new FitAddon.FitAddon();
            term.loadAddon(fitAddon);
            term.open(termContainer);
            setTimeout(() => { fitAddon.fit(); term.focus(); }, 0);
            term.fitAddon = fitAddon;
            const db = state.firebaseApp.database();
            const sessionPrefix = `sessions/${sessionKey}/ssh`;
            const inputRef = db.ref(`${sessionPrefix}/input`);
            const stateRef = db.ref(`${sessionPrefix}/state`);
            const outputRef = db.ref(`${sessionPrefix}/output`);
            stateRef.set({ status: 'client-connected', cols: term.cols, rows: term.rows });
            term.onData(data => inputRef.push({ data: btoa(data) }));
            const outputListener = outputRef.on('child_added', snapshot => { const val = snapshot.val(); if (val && val.data) term.write(atob(val.data)); snapshot.ref.remove(); });
            state.terminalInstances[sessionKey] = { term, listener: outputListener, dbRef: outputRef };
        }
        render();
    }
    
    function closeSession(sessionKey) {
        const instance = state.terminalInstances[sessionKey];
        if (instance) { instance.dbRef.off('child_added', instance.listener); instance.term.dispose(); document.getElementById(`term-${sessionKey}`).remove(); delete state.terminalInstances[sessionKey]; }
        if (state.activeSessionKey === sessionKey) {
            const remainingKeys = Object.keys(state.terminalInstances);
            setActiveSession(remainingKeys.length > 0 ? remainingKeys[remainingKeys.length - 1] : null);
        } else { render(); }
    }

    function deleteSession(sessionId) {
        const session = state.sessionsData[sessionId];
        if (!session || !session.ssh || !session.ssh.info) {
            showNotification("Could not find session data to delete.", "error");
            return;
        }

        const serverId = session.ssh.info.serverId.split("_")[0];
        const server = state.serverData[serverId];
        
        if (confirm(`Are you sure you want to delete session "${sessionId}"?`)) {
            showNotification(`Deletion request sent for session "${sessionId}"...`);
            sendRequest(
                state.firebaseApp.database().ref(`sessions/0/http`),
                {
                    port: server.port,
                    method: "POST",
                    uri: "/api/feature/ssh",
                    headers: {},
                    body: `{"action":"stop","sessionId":"${sessionId}","serverId":"${serverId}"}`
                },
                (response) => {
                    const bodyText = new TextDecoder().decode(response.body);
                    try {
                        const resp = JSON.parse(bodyText);
                        if (resp["success"] == true) {
                            state.firebaseApp.database().ref(`sessions/`+sessionId).remove().then(() => {
                                showNotification(`Session "${sessionId}" deleted.`, "success");
                            })
                        } else {
                            showNotification(resp["message"] || `Failed to delete session "${sessionId}".`, "error");
                        }
                    } catch (e) {
                         showNotification(`Deleted "${sessionId}", but received an invalid server response.`, "error");
                    }
                },
                (error) => {
                    console.error("❌ Delete Request Failed:", error);
                    showNotification(`Delete failed: ${error.message}`, "error");
                }
            );
        }
    }
    
    function resizeActiveTerminal() {
        if (state.activeSessionKey) {
            const activeInstance = state.terminalInstances[state.activeSessionKey];
            if (activeInstance && activeInstance.term.fitAddon) {
                activeInstance.term.fitAddon.fit();
            }
        }
    }

    function openNewSessionModal() {
        serverSelect.innerHTML = '';
        const serverKeys = Object.keys(state.serverData);
        if (serverKeys.length === 0) {
            serverSelect.innerHTML = '<option disabled>No live servers found</option>';
        } else {
            serverKeys.forEach(serverKey => {
                const server = state.serverData[serverKey];
                const option = document.createElement('option');
                option.value = serverKey;
                option.textContent = server.host;
                serverSelect.appendChild(option);
            });
        }
        sessionIdInput.value = '';
        state.isSettingsOpen = false;
        state.isNewSessionOpen = true;
        render();
    }

    function openSettingsModal() {
        document.getElementById('firebase-config').value = state.firebaseConfig ? JSON.stringify(state.firebaseConfig, null, 2) : '';
        state.isNewSessionOpen = false;
        state.isSettingsOpen = true;
        render();
    }

    function setupEventListeners() {
        sidebarToggleBtn.addEventListener('click', () => setSidebarCollapsed(!state.isSidebarCollapsed));
        sidebarOverlay.addEventListener('click', () => setSidebarCollapsed(true));
        
        const closeModal = () => {
            state.isSettingsOpen = false;
            state.isNewSessionOpen = false;
            render();
        };

        settingsModal.querySelector('.modal-close-btn').addEventListener('click', closeModal);
        newSessionModal.querySelector('.modal-close-btn').addEventListener('click', closeModal);
        modalBackdrop.addEventListener('click', (e) => { if (e.target === modalBackdrop) closeModal(); });

        document.getElementById('settings-btn').addEventListener('click', openSettingsModal);
        addSessionBtn.addEventListener('click', openNewSessionModal);

        document.getElementById('save-settings-btn').addEventListener('click', () => {
            try {
                state.firebaseConfig = JSON.parse(document.getElementById('firebase-config').value);
                AppStorage.saveConfig();
                closeModal();
                connectToFirebase();
            } catch (e) { showNotification('Invalid JSON in Firebase Config.', 'error'); }
        });
        
        startSessionBtn.addEventListener('click', () => {
            const sessionId = sessionIdInput.value.trim();
            const serverId = serverSelect.value;

            if (!sessionId || !serverId) {
                showNotification('Please provide a Session ID and select a server.', 'error');
                return;
            }

            const server = state.serverData[serverId];
            
            sendRequest(
                state.firebaseApp.database().ref(`sessions/0/http`),
                {
                    port: server.port,
                    method: "POST",
                    uri: "/api/feature/ssh",
                    headers: {},
                    body: `{"action":"start","sessionId":"`+sessionId+`","serverId":"`+serverId+`","port":null}`
                },
                (response) => {
                    const bodyText = new TextDecoder().decode(response.body);
                    try {
                        const resp = JSON.parse(bodyText);
                        if (resp["success"] == true) {
                            showNotification("Session started successfully.", "success");
                        } else {
                            showNotification(resp["message"] || "Failed to start session.", "error");
                        }
                    } catch(e) {
                        showNotification("Started, but received an invalid server response.", "error");
                    }
                    closeModal();
                },
                (error) => {
                    console.error("❌ Request Failed:", error);
                    showNotification(`Request Failed: ${error.message}`, "error");
                    closeModal();
                }
            );
        });

        sessionListEl.addEventListener('click', e => {
            const deleteBtn = e.target.closest('.session-delete-btn');
            if (deleteBtn) {
                e.stopPropagation(); // Prevent the setActiveSession from firing
                deleteSession(deleteBtn.dataset.id);
                return;
            }
            const li = e.target.closest('li.clickable');
            if (li) {
                setActiveSession(li.dataset.id);
            }
        });
        tabBarEl.addEventListener('click', e => { const closeBtn = e.target.closest('.tab-close-btn'); if (closeBtn) { closeSession(closeBtn.dataset.id); } else { const tab = e.target.closest('.tab'); if (tab && tab.dataset.id !== state.activeSessionKey) setActiveSession(tab.dataset.id); } });
    }

    function init() {
        AppStorage.loadConfig();
        setupEventListeners();
        connectToFirebase();
        
        // Initial sidebar state based on screen size
        setSidebarCollapsed(isMobile());

        render();
        let resizeTimeout;
        window.addEventListener('resize', () => { 
            clearTimeout(resizeTimeout); 
            resizeTimeout = setTimeout(resizeActiveTerminal, 100); 
        });
    }
    
    init();
});

// ... (The rest of the file remains unchanged)

function uniqueId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function sendRequest(
  sessionRef,
  { port, method, uri, headers, body },
  onResponseReceived,
  onFailed
) {
  const input = sessionRef.child("input");
  const output = sessionRef.child("output");
  const streams = sessionRef.child("streams");
  const reqId = uniqueId();

  let outputListener = null;
  let streamListener = null;
  let initialTimeout = null;
  let streamTimeout = null;

  const responseData = {
    status: null,
    headers: {},
    bodyChunks: [],
  };

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function bytesToBase64(uint8arr) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < uint8arr.length; i += chunkSize) {
      const chunk = uint8arr.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  const cleanup = (streamRef) => {
    if (initialTimeout) clearTimeout(initialTimeout);
    if (streamTimeout) clearTimeout(streamTimeout);
    if (outputListener) output.off("child_added", outputListener);
    if (streamListener && streamRef) streamRef.off("child_added", streamListener);
    if (streamRef) streamRef.remove();
  };

  outputListener = output.on("child_added", (snapshot) => {
    const val = snapshot.val();
    if (val && val.reqId === reqId) {
      clearTimeout(initialTimeout);
      snapshot.ref.remove();

      if (val.type === "start") {
        responseData.status = val.status || 500;
        responseData.headers = val.headers || {};
        const streamId = `${reqId}_stream`;
        const streamRef = streams.child(streamId);
        streamTimeout = setTimeout(() => {
          cleanup(streamRef);
          onFailed({ code: 504, message: "Timeout: The data stream did not complete in time." });
        }, 30000);
        streamListener = streamRef.on("child_added", (chunkSnapshot) => {
          const chunkData = chunkSnapshot.val();
          if (chunkData.type === "chunk" && chunkData.body) {
            responseData.bodyChunks.push(base64ToBytes(chunkData.body));
          } else if (chunkData.type === "end") {
            let totalLength = responseData.bodyChunks.reduce((sum, arr) => sum + arr.length, 0);
            const fullBody = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of responseData.bodyChunks) {
              fullBody.set(chunk, offset);
              offset += chunk.length;
            }
            onResponseReceived({ status: responseData.status, headers: responseData.headers, body: fullBody, text: new TextDecoder().decode(fullBody) });
            cleanup(streamRef);
          }
        });
      } else {
        const responseBody = val.body ? base64ToBytes(val.body) : new Uint8Array();
        onResponseReceived({ status: val.status || 500, headers: val.headers || {}, body: responseBody, text: new TextDecoder().decode(responseBody) });
        cleanup(null);
      }
    }
  });

  initialTimeout = setTimeout(() => {
    cleanup(null);
    onFailed({ code: 504, message: "Timeout waiting for initial server response." });
  }, 10000);

  try {
    await input.push({ reqId, port, method, uri, headers, body: body instanceof Uint8Array ? bytesToBase64(body) : btoa(unescape(encodeURIComponent(body))) });
  } catch (error) {
    cleanup(null);
    onFailed({ code: 500, message: `Failed to send request to Firebase: ${error.message}` });
  }
}