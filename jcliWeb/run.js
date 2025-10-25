document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const terminalEl = document.getElementById('terminal');
    const configOverlay = document.getElementById('config-overlay');
    const connectBtn = document.getElementById('connect-btn');
    const configInput = document.getElementById('firebase-config');
    const sessionIdInput = document.getElementById('session-id');
    const errorMessage = document.getElementById('error-message');

    let db;
    let inputRef;
    let stateRef;

    // --- Xterm.js Initialization ---
    const term = new Terminal({
        cursorBlink: true,
        fontFamily: 'SF Mono, Consolas, Menlo, monospace',
        fontSize: 14,
        // Add padding directly within the terminal's rendering options
        padding: 10, 
        theme: {
            background: '#1a1d24',
            foreground: '#e0e0e0',
            cursor: '#00ff00',
            selection: '#4a90e280',
        }
    });

    // Load the Fit addon to make the terminal resize to its container
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    // Mount the terminal to the DOM and size it
    term.open(terminalEl);
    fitAddon.fit();
    
    // Adjust terminal size on window resize
    window.addEventListener('resize', () => {
        // Debounce resize events for better performance
        setTimeout(() => {
            fitAddon.fit();
            if (stateRef) {
                stateRef.update({ cols: term.cols, rows: term.rows });
            }
        }, 100);
    });

    term.writeln('Welcome to the Web SSH Client.');
    term.writeln('Please provide your Firebase configuration to connect.');

    // --- Core Functions (Unchanged) ---
    function initializeFirebase(firebaseConfig, sessionId) {
        try {
            if (!firebase.apps.length) {
                firebase.initializeApp(firebaseConfig);
            }
            db = firebase.database();
            
            const sessionPrefix = `sessions/${sessionId}/ssh`;
            inputRef = db.ref(`${sessionPrefix}/input`);
            stateRef = db.ref(`${sessionPrefix}/state`);
            const outputRef = db.ref(`${sessionPrefix}/output`);

            stateRef.set({ 
                status: 'client-connected',
                cols: term.cols,
                rows: term.rows
            });

            term.clear();
            term.writeln('🔌 Connection established. Session is live.');

            term.onData(data => {
                inputRef.push({ data: btoa(data) });
            });

            outputRef.on('child_added', (snapshot) => {
                const val = snapshot.val();
                if (val && val.data) {
                    try {
                        term.write(atob(val.data));
                    } catch (e) {
                        console.error("Decoding error:", e);
                    }
                }
                snapshot.ref.remove();
            });

            configOverlay.style.opacity = '0';
            setTimeout(() => {
                configOverlay.style.display = 'none';
                term.focus();
            }, 300);

        } catch (error) {
            errorMessage.textContent = `Firebase Error: ${error.message}`;
            console.error('Firebase initialization failed:', error);
            term.writeln(`\n\n--- Firebase Error: ${error.message} ---`);
        }
    }

    // --- Event Listener for Connection (Unchanged) ---
    connectBtn.addEventListener('click', () => {
        errorMessage.textContent = '';
        const configStr = configInput.value;
        const sessionId = sessionIdInput.value;
        if (!configStr || !sessionId) {
            errorMessage.textContent = 'Both Firebase Config and Session ID are required.';
            return;
        }
        try {
            const firebaseConfig = JSON.parse(configStr);
            if (!firebaseConfig.apiKey || !firebaseConfig.databaseURL) {
                throw new Error('Invalid Firebase config object.');
            }
            initializeFirebase(firebaseConfig, sessionId);
        } catch (e) {
            errorMessage.textContent = 'Invalid JSON in Firebase Config.';
            console.error('Config parsing error:', e);
        }
    });
});