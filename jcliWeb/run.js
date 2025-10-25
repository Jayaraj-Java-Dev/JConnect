document.addEventListener('DOMContentLoaded', () => {
    // --- State Management ---
    let state = {
        firebaseConfig: null, firebaseApp: null, activeSessionIndex: null,
        terminalInstances: {}, serverData: {}, sessionsData: [],
        isSidebarCollapsed: false, isSettingsOpen: false,
    };

    // --- DOM Elements ---
    const appContainer = document.getElementById('app-container');
    const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
    const serverListEl = document.getElementById('server-list');
    const sessionListEl = document.getElementById('session-list');
    const tabBarEl = document.getElementById('tab-bar');
    const terminalHostEl = document.getElementById('terminal-host');
    const welcomeScreenEl = document.getElementById('welcome-screen');
    const loaderEl = document.getElementById('initial-loader');
    const modalBackdrop = document.getElementById('modal-backdrop');

    const ICONS = {
        menu: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"></path></svg>',
        close: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"></path></svg>'
    };

    // --- THE PROFESSIONAL FIX: Centralized Rendering ---
    function render() {
        // Render Sidebar
        serverListEl.innerHTML = Object.values(state.serverData).map(server => `
            <li>
                <span class="status-dot ${server.status === 'online' ? 'online' : 'offline'}"></span>
                <span class="item-name">${server.host}</span>
                <span class="item-info">${server.ip}</span>
            </li>`).join('') || '<li class="item-info" style="padding: 10px 20px;">No servers found.</li>';
        
        sessionListEl.innerHTML = state.sessionsData.map((session, index) => {
            if (!session || !session.ssh) return '';
            const { info } = session.ssh;
            const statusClass = info.status === 'online' ? (Date.now() - info.lastHeartbeat < 15000 ? 'online' : 'stale') : 'offline';
            return `<li class="clickable" data-index="${index}">
                        <span class="status-dot ${statusClass}"></span>
                        <span class="item-name">${info.server.username}@${info.server.hostname}</span>
                        <span class="item-info">[${index}]</span>
                    </li>`;
        }).join('') || '<li class="item-info" style="padding: 10px 20px;">No sessions found.</li>';

        // Render Tabs
        tabBarEl.innerHTML = Object.keys(state.terminalInstances).map(sessionIndex => {
            const session = state.sessionsData[sessionIndex];
            if (!session) return '';
            return `<div class="tab ${parseInt(sessionIndex) === state.activeSessionIndex ? 'active' : ''}" data-index="${sessionIndex}">
                        <span class="tab-name">${session.ssh.info.server.username}@${session.ssh.info.server.hostname} [${sessionIndex}]</span>
                        <button class="icon-btn tab-close-btn" data-index="${sessionIndex}">${ICONS.close}</button>
                    </div>`;
        }).join('');

        // Render Modals & Main View
        modalBackdrop.classList.toggle('hidden', !state.isSettingsOpen);
        welcomeScreenEl.classList.toggle('hidden', state.activeSessionIndex !== null);
    }
    
    // --- Local Storage & Firebase ---
    const AppStorage = {
        loadConfig: () => state.firebaseConfig = JSON.parse(localStorage.getItem('jconnect_firebaseConfig') || 'null'),
        saveConfig: () => localStorage.setItem('jconnect_firebaseConfig', JSON.stringify(state.firebaseConfig)),
    };

    function connectToFirebase() {
        if (!state.firebaseConfig) { state.isSettingsOpen = true; render(); return; }
        try {
            if (state.firebaseApp) state.firebaseApp.delete().then(() => state.firebaseApp = null);
            loaderEl.classList.remove('hidden');
            state.firebaseApp = firebase.initializeApp(state.firebaseConfig);
            const db = state.firebaseApp.database();
            db.ref('servers').on('value', (snapshot) => { state.serverData = snapshot.val() || {}; render(); });
            db.ref('sessions').on('value', (snapshot) => {
                loaderEl.classList.add('hidden');
                state.sessionsData = snapshot.val() || [];
                render();
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
        sidebarToggleBtn.innerHTML = state.isSidebarCollapsed ? ICONS.menu : ICONS.close;
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
        if (sessionIndex === null) { render(); return; }

        if (state.terminalInstances[sessionIndex]) {
            document.getElementById(`term-${sessionIndex}`).classList.add('active');
            state.terminalInstances[sessionIndex].focus();
        } else {
            const termContainer = document.createElement('div');
            termContainer.id = `term-${sessionIndex}`;
            termContainer.className = 'terminal-instance active';
            terminalHostEl.appendChild(termContainer);
            const term = new Terminal({ cursorBlink: true, fontSize: 14, padding: 15, theme: { background: '#111827', foreground: '#F9FAFB', cursor: '#22d3ee', selection: 'rgba(34, 211, 238, 0.3)' } });
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
        render();
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
            render();
        }
    }

    // --- Event Handlers Setup ---
    function setupEventListeners() {
        sidebarToggleBtn.addEventListener('click', toggleSidebar);
        const closeModal = () => { state.isSettingsOpen = false; render(); };
        document.querySelector('.modal-close-btn').addEventListener('click', closeModal);
        modalBackdrop.addEventListener('click', (e) => { if (e.target === modalBackdrop) closeModal(); });
        document.getElementById('settings-btn').addEventListener('click', () => {
            document.getElementById('firebase-config').value = state.firebaseConfig ? JSON.stringify(state.firebaseConfig, null, 2) : '';
            state.isSettingsOpen = true;
            render();
        });
        document.getElementById('save-settings-btn').addEventListener('click', () => {
            try {
                state.firebaseConfig = JSON.parse(document.getElementById('firebase-config').value);
                AppStorage.saveConfig();
                state.isSettingsOpen = false;
                render();
                connectToFirebase();
            } catch (e) { alert('Invalid JSON in Firebase Config.'); }
        });
        sessionListEl.addEventListener('click', e => {
            const li = e.target.closest('li.clickable');
            if (li) setActiveSession(parseInt(li.dataset.index, 10));
        });
        tabBarEl.addEventListener('click', e => {
            const closeBtn = e.target.closest('.tab-close-btn');
            if (closeBtn) {
                closeSession(parseInt(closeBtn.dataset.index, 10));
            } else {
                const tab = e.target.closest('.tab');
                if (tab && parseInt(tab.dataset.index) !== state.activeSessionIndex) {
                    setActiveSession(parseInt(tab.dataset.index, 10));
                }
            }
        });
    }

    // --- App Initialization ---
    function init() {
        sidebarToggleBtn.innerHTML = ICONS.close;
        AppStorage.loadConfig();
        setupEventListeners();
        connectToFirebase();
        render();
    }
    
    init();
});