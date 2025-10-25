document.addEventListener('DOMContentLoaded', () => {
    // --- State Management ---
    let state = {
        firebaseConfig: null,
        firebaseApp: null,
        activeSessionIndex: null,
        terminalInstances: {}, // { sessionIndex: term }
        sessionsData: [], // Cache just the sessions data
        isSidebarCollapsed: false,
    };

    // --- DOM Elements ---
    const appContainer = document.getElementById('app-container');
    const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
    const serverListEl = document.getElementById('server-list');
    const sessionListEl = document.getElementById('session-list');
    const tabBarEl = document.getElementById('tab-bar');
    // ... other elements

    // --- Local Storage ---
    const AppStorage = {
        loadConfig: () => state.firebaseConfig = JSON.parse(localStorage.getItem('jconnect_firebaseConfig') || 'null'),
        saveConfig: () => localStorage.setItem('jconnect_firebaseConfig', JSON.stringify(state.firebaseConfig)),
    };

    // --- UI Rendering (Now Decoupled) ---
    function renderTabs() {
        tabBarEl.innerHTML = '';
        Object.keys(state.terminalInstances).forEach(sessionIndex => {
            const session = state.sessionsData[sessionIndex];
            if (!session) return;
            const tab = document.createElement('div');
            tab.className = 'tab';
            tab.dataset.index = sessionIndex;
            if (parseInt(sessionIndex) === state.activeSessionIndex) {
                tab.classList.add('active');
            }
            tab.innerHTML = `
                <span class="tab-name">${session.ssh.info.server.username}@${session.ssh.info.server.hostname} [${sessionIndex}]</span>
                <button class="tab-close-btn" data-index="${sessionIndex}">×</button>
            `;
            tabBarEl.appendChild(tab);
        });
    }
    
    function renderServers(servers) {
        serverListEl.innerHTML = !servers ? '<li class="item-info" style="padding: 10px 15px;">No manage servers found.</li>' : Object.values(servers).map(server => `
            <li><span class="status-dot ${server.status === 'online' ? 'online' : 'offline'}"></span><div class="item-details"><span class="item-name">${server.host}</span><span class="item-info">${server.ip}</span></div></li>`).join('');
    }

    function renderSessions(sessions) {
        state.sessionsData = sessions || []; // Cache the data
        sessionListEl.innerHTML = !sessions ? '<li class="item-info" style="padding: 10px 15px;">No active sessions found.</li>' : sessions.map((session, index) => {
            if (!session || !session.ssh) return '';
            const { info } = session.ssh;
            const timeSinceHeartbeat = Date.now() - info.lastHeartbeat;
            const statusClass = info.status === 'online' ? (timeSinceHeartbeat < 15000 ? 'online' : 'stale') : 'offline';
            return `<li class="clickable" data-index="${index}"><span class="status-dot ${statusClass}"></span><div class="item-details"><span class="item-name">${info.server.username}@${info.server.hostname}</span><span class="item-info">Session Index: ${index}</span></div></li>`;
        }).join('');
    }

    // --- Firebase Logic (Now with Decoupled Listeners) ---
    function connectToFirebase() {
        const loaderEl = document.getElementById('initial-loader');
        if (!state.firebaseConfig) {
            document.getElementById('modal-backdrop').classList.remove('hidden');
            return;
        }
        try {
            if (state.firebaseApp) state.firebaseApp.delete().then(() => state.firebaseApp = null);
            loaderEl.classList.remove('hidden');
            state.firebaseApp = firebase.initializeApp(state.firebaseConfig);
            const db = state.firebaseApp.database();

            // *** THE CORE FIX: SEPARATE LISTENERS ***
            db.ref('servers').on('value', (snapshot) => renderServers(snapshot.val()));
            db.ref('sessions').on('value', (snapshot) => {
                loaderEl.classList.add('hidden');
                renderSessions(snapshot.val());
            });

        } catch (e) {
            alert(`Firebase connection failed: ${e.message}`);
            loaderEl.classList.add('hidden');
        }
    }

    // --- UI Interaction & State Logic ---
    function toggleSidebar() {
        state.isSidebarCollapsed = !state.isSidebarCollapsed;
        appContainer.classList.toggle('sidebar-collapsed', state.isSidebarCollapsed);
        sidebarToggleBtn.innerHTML = state.isSidebarCollapsed ? '☰' : '✕';
        setTimeout(() => {
            const activeTerm = state.terminalInstances[state.activeSessionIndex];
            if (activeTerm) activeTerm.fitAddon.fit();
        }, 300);
    }

    function setActiveSession(sessionIndex) {
        if (state.activeSessionIndex !== null && state.terminalInstances[state.activeSessionIndex]) {
            document.getElementById(`term-${state.activeSessionIndex}`).classList.remove('active');
        }
        state.activeSessionIndex = sessionIndex;
        if (sessionIndex === null) {
            document.getElementById('welcome-screen').classList.remove('hidden');
            renderTabs();
            return;
        }
        document.getElementById('welcome-screen').classList.add('hidden');

        if (state.terminalInstances[sessionIndex]) {
            document.getElementById(`term-${sessionIndex}`).classList.add('active');
            state.terminalInstances[sessionIndex].focus();
        } else {
            const termContainer = document.createElement('div');
            termContainer.id = `term-${sessionIndex}`;
            termContainer.className = 'terminal-instance active';
            document.getElementById('terminal-host').appendChild(termContainer);

            const term = new Terminal({ cursorBlink: true, fontSize: 14, padding: 10, theme: { background: '#1a1d24' } });
            const fitAddon = new FitAddon.FitAddon();
            term.loadAddon(fitAddon);
            term.open(termContainer);
            fitAddon.fit();
            term.focus();
            term.fitAddon = fitAddon;
            state.terminalInstances[sessionIndex] = term;

            const db = state.firebaseApp.database();
            const sessionPrefix = `sessions/${sessionIndex}/ssh`;
            const inputRef = db.ref(`${sessionPrefix}/input`);
            const stateRef = db.ref(`${sessionPrefix}/state`);
            const outputRef = db.ref(`${sessionPrefix}/output`);
            stateRef.set({ status: 'client-connected', cols: term.cols, rows: term.rows });
            term.onData(data => inputRef.push({ data: btoa(data) }));
            const outputListener = outputRef.on('child_added', snapshot => {
                const val = snapshot.val();
                if (val && val.data) term.write(atob(val.data));
                snapshot.ref.remove();
            });
            term.onDispose(() => outputRef.off('child_added', outputListener));
        }
        renderTabs();
    }
    
    function closeSession(sessionIndex) {
        const term = state.terminalInstances[sessionIndex];
        if (term) {
            term.dispose();
            document.getElementById(`term-${sessionIndex}`).remove();
            delete state.terminalInstances[sessionIndex];
        }
        if (state.activeSessionIndex === sessionIndex) {
            const remainingKeys = Object.keys(state.terminalInstances);
            setActiveSession(remainingKeys.length > 0 ? parseInt(remainingKeys[remainingKeys.length - 1]) : null);
        } else {
            renderTabs();
        }
    }

    // --- Event Handlers Setup ---
    function setupEventListeners() {
        sidebarToggleBtn.addEventListener('click', toggleSidebar);
        const modalBackdrop = document.getElementById('modal-backdrop');
        const closeModal = () => modalBackdrop.classList.add('hidden');
        document.querySelector('.modal-close-btn').addEventListener('click', closeModal);
        modalBackdrop.addEventListener('click', (e) => { if (e.target === modalBackdrop) closeModal(); });
        document.getElementById('settings-btn').addEventListener('click', () => {
            document.getElementById('firebase-config').value = state.firebaseConfig ? JSON.stringify(state.firebaseConfig, null, 2) : '';
            modalBackdrop.classList.remove('hidden');
        });
        document.getElementById('save-settings-btn').addEventListener('click', () => {
            try {
                state.firebaseConfig = JSON.parse(document.getElementById('firebase-config').value);
                AppStorage.saveConfig();
                closeModal();
                connectToFirebase();
            } catch (e) { alert('Invalid JSON in Firebase Config.'); }
        });
        sessionListEl.addEventListener('click', e => {
            const li = e.target.closest('li.clickable');
            if (li) setActiveSession(parseInt(li.dataset.index, 10));
        });
        tabBarEl.addEventListener('click', e => {
            const target = e.target;
            if (target.classList.contains('tab-close-btn')) {
                closeSession(parseInt(target.dataset.index, 10));
            } else {
                const tab = target.closest('.tab');
                if (tab && parseInt(tab.dataset.index) !== state.activeSessionIndex) {
                    setActiveSession(parseInt(tab.dataset.index, 10));
                }
            }
        });
    }

    // --- App Initialization ---
    function init() {
        AppStorage.loadConfig();
        setupEventListeners();
        connectToFirebase();
        setActiveSession(null);
    }
    
    init();
});