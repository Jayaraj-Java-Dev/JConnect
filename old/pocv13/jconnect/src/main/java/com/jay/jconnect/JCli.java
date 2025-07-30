package com.jay.jconnect;

import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.database.*;

import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.Headers;
import java.lang.reflect.Array;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.net.*;
import java.util.Base64;

public class JCli {
    static final String FIREBASE_URL = "https://jconnectbytes-default-rtdb.asia-southeast1.firebasedatabase.app";
    static final int HTTP_PORT = 55080;

    static class SessionRefs {
        DatabaseReference input;
        DatabaseReference output;
        DatabaseReference state;

        SessionRefs(DatabaseReference input, DatabaseReference output, DatabaseReference state) {
            this.input = input;
            this.output = output;
            this.state = state;
        }
    }

    static SessionRefs refs(DatabaseReference db, String prefix) {
        return new SessionRefs(
            db.child(prefix + "/input"),
            db.child(prefix + "/output"),
            db.child(prefix + "/state")
        );
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 1 || (!args[0].equals("ssh") && !args[0].equals("http"))) {
            System.err.println(
                "Usage: java JCli ssh|http [SESSION_ID] [options]\n" +
                "For HTTP client, you can use -port=PORT to fix the target port."
            );
            System.exit(1);
        }

        String feature = args[0];
        String SESSION_ID = (args.length > 1) ? args[1] : "demo-session";
        Integer fixedTargetPort = null;

        if (feature.equals("http")) {
            for (String arg : args) {
                if (arg.startsWith("-port=")) {
                    try {
                        fixedTargetPort = Integer.parseInt(arg.split("=")[1]);
                    } catch (NumberFormatException ex) {
                        System.err.println("Invalid port given: " + arg);
                        System.exit(1);
                    }
                }
            }
        }

        File configFile = Paths.get(System.getProperty("user.dir"), "firebase_config.json").toFile();
        if (!configFile.exists()) {
            System.err.println("Missing firebase_config.json");
            System.exit(1);
        }

        FileInputStream serviceAccount = new FileInputStream(configFile);

        FirebaseOptions options = FirebaseOptions.builder()
            .setCredentials(com.google.auth.oauth2.GoogleCredentials.fromStream(serviceAccount))
            .setDatabaseUrl(FIREBASE_URL)
            .build();
        FirebaseApp.initializeApp(options);

        DatabaseReference db = FirebaseDatabase.getInstance().getReference();

        if (feature.equals("ssh")) {
            runSSHClient(db, SESSION_ID);
        } else if (feature.equals("http")) {
            runHTTPClient(db, SESSION_ID, fixedTargetPort);
        }
    }

    // ------------------- SSH FEATURE (CLIENT) ------------------- //
    static void runSSHClient(DatabaseReference db, String SESSION_ID) throws Exception {
        SessionRefs refs = refs(db, "sessions/" + SESSION_ID + "/ssh");
        refs.state.setValueAsync(Collections.singletonMap("status", "client-connected"));

        final ByteArrayOutputStream exitBuffer = new ByteArrayOutputStream();

        refs.output.addChildEventListener(new ChildEventListener() {
            @Override
            public void onChildAdded(DataSnapshot snapshot, String previousChildName) {
                Map<String, Object> val = (Map<String, Object>) snapshot.getValue();
                if (val != null && val.containsKey("data")) {
                    byte[] buf = Base64.getDecoder().decode((String) val.get("data"));
                    try {
                        System.out.write(buf);
                        System.out.flush();
                    } catch (IOException e) {
                        e.printStackTrace();
                    }
                }
                snapshot.getRef().removeValueAsync();
            }

            @Override public void onChildChanged(DataSnapshot snapshot, String prev) {}
            @Override public void onChildRemoved(DataSnapshot snapshot) {}
            @Override public void onChildMoved(DataSnapshot snapshot, String prev) {}
            @Override public void onCancelled(DatabaseError error) {}
        });

        // Set terminal to raw mode is platform dependent and non-trivial in Java. Here we use System.in directly.
        InputStream stdin = System.in;
        System.out.println("SSH client running. Type commands (exit with ..1).");

        byte[] buffer = new byte[1024];
        int len;
        while ((len = stdin.read(buffer)) != -1) {
            exitBuffer.write(buffer, 0, len);
            byte[] all = exitBuffer.toByteArray();
            int allLen = all.length;
            if (allLen >= 3 &&
                all[allLen-3] == '.' && all[allLen-2] == '.' && all[allLen-1] == '1') {
                System.exit(0);
            }
            Map<String,Object> data = new HashMap<>();
            data.put("data", Base64.getEncoder().encodeToString(Arrays.copyOf(buffer, len)));
            refs.input.push().setValueAsync(data);

            // Keep only the last 3 bytes in exitBuffer
            if (allLen > 3) {
                exitBuffer.reset();
                exitBuffer.write(all, allLen - 3, 3);
            }
        }
    }

    // ------------------- HTTP FEATURE (CLIENT) ------------------- //

    static String uniqueId() {
        return Long.toString(Math.abs(new Random().nextLong()), 36) + Long.toString(System.currentTimeMillis(), 36);
    }

    static void runHTTPClient(DatabaseReference db, String SESSION_ID, Integer fixedTargetPort) throws Exception {
        SessionRefs refs = refs(db, "sessions/" + SESSION_ID + "/http");
        refs.state.setValueAsync(Collections.singletonMap("status", "client-connected"));
        final Map<String, CompletableFuture<Map<String, Object>>> pending = new ConcurrentHashMap<>();

        refs.output.addChildEventListener(new ChildEventListener() {
            @Override
            public void onChildAdded(DataSnapshot snapshot, String previousChildName) {
                Map<String, Object> val = (Map<String, Object>) snapshot.getValue();
                if (val != null && val.containsKey("reqId") && pending.containsKey(val.get("reqId"))) {
                    pending.get(val.get("reqId")).complete(val);
                    pending.remove(val.get("reqId"));
                }
                snapshot.getRef().removeValueAsync();
            }
            @Override public void onChildChanged(DataSnapshot snapshot, String prev) {}
            @Override public void onChildRemoved(DataSnapshot snapshot) {}
            @Override public void onChildMoved(DataSnapshot snapshot, String prev) {}
            @Override public void onCancelled(DatabaseError error) {}
        });

        HttpServer server = HttpServer.create(new InetSocketAddress(HTTP_PORT), 0);
        server.createContext("/", (exchange) -> {
            try {
                String path = exchange.getRequestURI().getPath();
                String method = exchange.getRequestMethod();
                Headers reqHeaders = exchange.getRequestHeaders();

                int targetPort;
                String uri;
                if (fixedTargetPort != null) {
                    targetPort = fixedTargetPort;
                    uri = path;
                } else {
                    String[] parts = path.split("/", 3);
                    if (parts.length < 2 || parts[1].isEmpty()) {
                        exchange.sendResponseHeaders(400, 0);
                        try (OutputStream os = exchange.getResponseBody()) {
                            os.write("Target port missing in path\n".getBytes());
                        }
                        return;
                    }
                    targetPort = Integer.parseInt(parts[1]);
                    uri = (parts.length > 2 ? "/" + parts[2] : "/");
                }

                // Read request body
                ByteArrayOutputStream bodyOut = new ByteArrayOutputStream();
                try (InputStream is = exchange.getRequestBody()) {
                    byte[] buf = new byte[4096];
                    int n;
                    while ((n = is.read(buf)) > 0) {
                        bodyOut.write(buf, 0, n);
                    }
                }
                byte[] body = bodyOut.toByteArray();

                String reqId = uniqueId();
                Map<String, Object> reqData = new HashMap<>();
                reqData.put("reqId", reqId);
                reqData.put("port", targetPort);
                reqData.put("method", method);
                reqData.put("uri", uri);

                // Convert headers to map
                Map<String, Object> headersMap = new HashMap<>();
                for (String h : reqHeaders.keySet()) {
                    List<String> v = reqHeaders.get(h);
                    headersMap.put(h, (v.size() == 1) ? v.get(0) : v);
                }
                reqData.put("headers", headersMap);
                reqData.put("body", Base64.getEncoder().encodeToString(body));

                refs.input.push().setValueAsync(reqData);

                CompletableFuture<Map<String, Object>> promise = new CompletableFuture<>();
                pending.put(reqId, promise);

                // Timeout logic (30s)
                Map<String, Object> resp = null;
                try {
                    resp = promise.get(30, TimeUnit.SECONDS);
                } catch (TimeoutException te) {
                    Map<String, Object> timeoutResp = new HashMap<>();
                    timeoutResp.put("status", 504);
                    timeoutResp.put("headers", new HashMap<>());
                    timeoutResp.put("body", Base64.getEncoder().encodeToString("Timeout".getBytes()));
                    resp = timeoutResp;
                }

                int status = (resp.get("status") != null) ? ((Long) resp.get("status")).intValue() : 500;
                Map<String, Object> respHeaders = (resp.get("headers") instanceof Map) ? (Map<String, Object>) resp.get("headers") : new HashMap<>();

                String respBodyBase64 = (String) resp.getOrDefault("body", "");
                byte[] respBody = Base64.getDecoder().decode(respBodyBase64);

                Headers responseHeaders = exchange.getResponseHeaders();
                for (Map.Entry<String, Object> e : respHeaders.entrySet()) {
                    String key = e.getKey();
                    Object value = e.getValue();
                    if (value == null) continue;
                    if (value instanceof List<?>) {
                        for (Object v : (List<?>) value) {
                            if (v != null)
                                responseHeaders.add(key, String.valueOf(v));
                        }
                    } else if (value.getClass().isArray()) {
                        int len = Array.getLength(value);
                        for (int i = 0; i < len; i++) {
                            Object v = Array.get(value, i);
                            if (v != null)
                                responseHeaders.add(key, String.valueOf(v));
                        }
                    } else {
                        responseHeaders.add(key, String.valueOf(value));
                    }
                }

                exchange.sendResponseHeaders(status, respBody.length);
                try (OutputStream os = exchange.getResponseBody()) {
                    os.write(respBody);
                }
            } catch (Exception ex) {
                exchange.sendResponseHeaders(500, 0);
                ex.printStackTrace();
                try (OutputStream os = exchange.getResponseBody()) {
                    os.write(("Internal error: " + ex.getMessage()).getBytes());
                }
            }
        });
        server.setExecutor(null); // Default executor

        server.start();

        if (fixedTargetPort != null) {
            System.out.println(
                String.format("HTTP proxy client running on http://localhost:%d/ - forwarding ALL requests to server port %d via Firebase", HTTP_PORT, fixedTargetPort)
            );
        } else {
            System.out.println(
                String.format("HTTP proxy client running on http://localhost:%d/<target_port>/<uri> (forwards via Firebase)", HTTP_PORT)
            );
        }
    }
}