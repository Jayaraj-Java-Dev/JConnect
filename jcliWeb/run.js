document.addEventListener('DOMContentLoaded', () => {
    // --- State Management ---
    let state = {
        firebaseConfig: null,
        firebaseApp: null,
        activeSessionIndex: null,
        terminalInstances: {}, // Stores active xterm.js instances { sessionIndex: term }
        lastData: null,
    };

    // --- DOM Elements ---
    const appContainer = document.getElementById('app-container');
    const serverListEl = document.getElementById('server-list');
    const sessionListEl = document.getElementById('session-list');
    const terminalHostEl = document.getElementById('terminal-host');
    const welcomeScreenEl = document.getElementById('welcome-screen');
    const tabBarEl = document.getElementById('tab-bar');
    const loaderEl = document.getElementById('initial-loader');
    const settingsModal = document.getElementById('settings-modal');
    const modalBackdrop = document.getElementById('modal-backdrop');

    const HEARTBEAT_STALE_THRESHOLD_MS = 15000;

    // --- Local Storage ---
    const AppStorage = {
        loadConfig: () => state.firebaseConfig = JSON.parse(localStorage.getItem('jconnect_firebaseConfig') || 'null'),
        saveConfig: () => localStorage.setItem('jconnect_firebaseConfig', JSON.stringify(state.firebaseConfig)),
    };

    // --- UI Rendering & State Updates ---
    function render(data) {
        state.lastData = data;
        renderServers(data.servers);
        renderSessions(data.sessions);
        renderTabs();
    }
    
    function renderTabs() {
        tabBarEl.innerHTML = '';
        Object.keys(state.terminalInstances).forEach(sessionIndex => {
            const session = state.lastData.sessions[sessionIndex];
            if (!session) return; // Stale tab, will be cleaned up
            const tab = document.createElement('div');
            tab.className = 'tab';
            tab.dataset.index = sessionIndex;
            if (parseInt(sessionIndex) === state.activeSessionIndex) {
                tab.classList.add('active');
            }
            tab.innerHTML = `
                <span class="tab-name">${session.ssh.info.server.username}@${session.ssh.info.server.hostname}</span>
                <button class="tab-close-btn" data-index="${sessionIndex}">×</button>
            `;
            tabBarEl.appendChild(tab);
        });
    }

    function setActiveSession(sessionIndex) {
        // Deactivate previous terminal
        if (state.activeSessionIndex !== null && state.terminalInstances[state.activeSessionIndex]) {
            const oldTermEl = document.getElementById(`term-${state.activeSessionIndex}`);
            if (oldTermEl) oldTermEl.classList.remove('active');
        }

        state.activeSessionIndex = sessionIndex;

        // If no session, show welcome screen
        if (sessionIndex === null) {
            welcomeScreenEl.classList.remove('hidden');
            renderTabs();
            return;
        }

        welcomeScreenEl.classList.add('hidden');

        // If terminal instance already exists, just show it
        if (state.terminalInstances[sessionIndex]) {
            const termEl = document.getElementById(`term-${sessionIndex}`);
            termEl.classList.add('active');
            state.terminalInstances[sessionIndex].focus();
        } else {
            // Create a new terminal instance
            const termContainer = document.createElement('div');
            termContainer.id = `term-${sessionIndex}`;
            termContainer.className = 'terminal-instance active';
            terminalHostEl.appendChild(termContainer);

            const term = new Terminal({ cursorBlink: true, fontSize: 14, padding: 10, theme: { background: '#1a1d24' } });
            const fitAddon = new FitAddon.FitAddon();
            term.loadAddon(fitAddon);
            term.open(termContainer);
            fitAddon.fit();
            term.focus();

            state.terminalInstances[sessionIndex] = term;

            // Connect to Firebase for this new terminal
            const db = state.firebaseApp.database();
            const sessionPrefix = `sessions/${sessionIndex}/ssh`;
            const inputRef = db.ref(`${sessionPrefix}/input`);
            const stateRef = db.ref(`${sessionPrefix}/state`);
            const outputRef = db.ref(`${sessionPrefix}/output`);

            stateRef.set({ status: 'client-connected', cols: term.cols, rows: term.rows });
            term.onData(data => inputRef.push({ data: btoa(data) }));
            outputRef.on('child_added', snapshot => {
                const val = snapshot.val();
                if (val && val.data) term.write(atob(val.data));
                snapshot.ref.remove();
            });
            term.onDispose(() => outputRef.off()); // Clean up listener
        }
        renderTabs();
    }
    
    function closeSession(sessionIndex) {
        const term = state.terminalInstances[sessionIndex];
        if (term) {
            term.dispose();
            const termEl = document.getElementById(`term-${sessionIndex}`);
            if (termEl) termEl.remove();
            delete state.terminalInstances[sessionIndex];
        }

        if (state.activeSessionIndex === sessionIndex) {
            const remainingKeys = Object.keys(state.terminalInstances);
            const newActiveIndex = remainingKeys.length > 0 ? parseInt(remainingKeys[remainingKeys.length - 1]) : null;
            setActiveSession(newActiveIndex);
        } else {
            renderTabs();
        }
    }

    // --- Event Handlers ---
    function setupEventListeners() {
        // Toggle sidebar
        document.getElementById('sidebar-toggle-btn').addEventListener('click', () => {
            appContainer.classList.toggle('sidebar-collapsed');
            // Refit active terminal after transition
            setTimeout(() => {
                const activeTerm = state.terminalInstances[state.activeSessionIndex];
                if (activeTerm) activeTerm.fitAddon.fit();
            }, 300);
        });

        // Click a session in the sidebar
        sessionListEl.addEventListener('click', e => {
            const li = e.target.closest('li.clickable');
            if (li) setActiveSession(parseInt(li.dataset.index, 10));
        });

        // Click a tab or close a tab
        tabBarEl.addEventListener('click', e => {
            const target = e.target;
            if (target.classList.contains('tab-close-btn')) {
                closeSession(parseInt(target.dataset.index, 10));
            } else {
                const tab = target.closest('.tab');
                if (tab) setActiveSession(parseInt(tab.dataset.index, 10));
            }
        });
        
        // Settings, etc. (mostly unchanged logic)
        document.getElementById('settings-btn').addEventListener('click', () => {
            document.getElementById('firebase-config').value = state.firebaseConfig ? JSON.stringify(state.firebaseConfig, null, 2) : '';
            modalBackdrop.classList.remove('hidden');
        });
        document.getElementById('save-settings-btn').addEventListener('click', () => {
            try {
                state.firebaseConfig = JSON.parse(document.getElementById('firebase-config').value);
                AppStorage.saveConfig();
                modalBackdrop.classList.add('hidden');
                connectToFirebase();
            } catch (e) { alert('Invalid JSON in Firebase Config.'); }
        });
    }

    // --- App Initialization ---
    function init() {
        AppStorage.loadConfig();
        setupEventListeners();
        connectToFirebase();
        setActiveSession(null);
    }
    
    // Functions connectToFirebase, renderServers, renderSessions are the same as the previous good version
    // I'll put them here for completeness
    function connectToFirebase() {
        if (!state.firebaseConfig) {
            modalBackdrop.classList.remove('hidden');
            return;
        }
        try {
            if (state.firebaseApp) state.firebaseApp.delete().then(() => state.firebaseApp = null);
            loaderEl.classList.remove('hidden');
            state.firebaseApp = firebase.initializeApp(state.firebaseConfig);
            const db = state.firebaseApp.database();
            db.ref().on('value', (snapshot) => {
                loaderEl.classList.add('hidden');
                render(snapshot.val() || { servers: {}, sessions: [] });
            });
        } catch (e) {
            alert(`Firebase connection failed: ${e.message}`);
            loaderEl.classList.add('hidden');
        }
    }
    function renderServers(servers) {
        serverListEl.innerHTML = !servers ? '<li class="item-info" style="padding: 10px 15px;">No manage servers found.</li>' : Object.values(servers).map(server => `
            <li>
                <span class="status-dot ${server.status === 'online' ? 'online' : 'offline'}"></span>
                <div class="item-details">
                    <span class="item-name">${server.host}</span>
                    <span class="item-info">${server.ip}</span>
                </div>
            </li>
        `).join('');
    }
    function renderSessions(sessions) {
        sessionListEl.innerHTML = !sessions ? '<li class="item-info" style="padding: 10px 15px;">No active sessions found.</li>' : sessions.map((session, index) => {
            if (!session || !session.ssh) return '';
            const { info } = session.ssh;
            const timeSinceHeartbeat = Date.now() - info.lastHeartbeat;
            const statusClass = info.status === 'online' ? (timeSinceHeartbeat < HEARTBEAT_STALE_THRESHOLD_MS ? 'online' : 'stale') : 'offline';
            return `
                <li class="clickable" data-index="${index}">
                    <span class="status-dot ${statusClass}"></span>
                    <div class="item-details">
                        <span class="item-name">${info.server.username}@${info.server.hostname}</span>
                        <span class="item-info">Session Index: ${index}</span>
                    </div>
                </li>
            `;
        }).join('');
    }

    init();
});