package com.jay.jconnect;

/*
 * Java port of the provided Node.js code using:
 * - org.jetbrains.pty4j for PTY (SSH shell)
 * - com.google.firebase for Firebase RTDB
 * - Java HTTP server for manage UI
 *
 * NOTE: The logic/flow is preserved exactly as in the original Node.js.
 * Java 11+ is recommended for Process API and HTTP utilities.
 * Dependencies needed:
 *  - org.jetbrains.pty4j:pty4j
 *  - com.google.firebase:firebase-admin
 *  - com.google.code.gson:gson
 *  - com.sun.net.httpserver.HttpServer (comes with JDK)
 */

import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.database.*;
import com.google.api.core.ApiFuture;
import com.google.auth.oauth2.GoogleCredentials;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import com.pty4j.PtyProcess;
import com.pty4j.PtyProcessBuilder;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.text.SimpleDateFormat;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;
import java.net.URI;
import java.net.http.*;
import java.util.*;
import java.nio.charset.StandardCharsets;

public class JServ {
    static final int MANAGE_PORT = 55777;
    static final String FIREBASE_URL = "https://jconnectbytes-default-rtdb.asia-southeast1.firebasedatabase.app";
    static final Gson gson = new Gson();

    // ---- Entry point ----
    public static void main(String[] args) throws Exception {
        if (args.length < 1 || !(args[0].equals("ssh") || args[0].equals("http") || args[0].equals("manage"))) {
            System.err.println("Usage: java JServ ssh|http|manage [SESSION_ID] [options]\nTo manage state: java JServ manage");
            System.exit(1);
        }
        String feature = args[0];
        String sessionId = (args.length >= 2) ? args[1] : "demo-session";
        boolean startWebAt1 = Arrays.asList(args).contains("-p");

        FirebaseDatabase db = null;
        if (!feature.equals("manage")) {
            File configFile = Paths.get(System.getProperty("user.dir"), "firebase_config.json").toFile();
            if (!configFile.exists()) {
                System.err.println("Missing firebase_config.json");
                System.exit(1);
            }
            FileInputStream serviceAccount = new FileInputStream(configFile);
            FirebaseOptions options = FirebaseOptions.builder()
                    .setCredentials(GoogleCredentials.fromStream(serviceAccount))
                    .setDatabaseUrl(FIREBASE_URL)
                    .build();
            FirebaseApp.initializeApp(options);
            db = FirebaseDatabase.getInstance();
        }
        if (feature.equals("ssh")) {
            runSSHServer(db, sessionId);
        } else if (feature.equals("http")) {
            runHTTPServer(db, sessionId);
        } else if (feature.equals("manage")) {
            runManageServer(startWebAt1);
        }
    }

    // ---- Firebase refs ----
    static class Refs {
        DatabaseReference input, output, state;
        Refs(DatabaseReference input, DatabaseReference output, DatabaseReference state) {
            this.input = input; this.output = output; this.state = state;
        }
    }
    static Refs refs(FirebaseDatabase db, String prefix) {
        return new Refs(
                db.getReference(prefix + "/input"),
                db.getReference(prefix + "/output"),
                db.getReference(prefix + "/state")
        );
    }

    // ---- SSH FEATURE ----
    static void runSSHServer(FirebaseDatabase db, String sessionId) throws Exception {
        Refs r = refs(db, "sessions/" + sessionId + "/ssh");
        r.state.setValueAsync(Map.of("status", "connected"));
        
        PtyProcess shell = new PtyProcessBuilder(new String[]{"/bin/bash"})
                .setEnvironment(System.getenv())
                .setDirectory(System.getProperty("user.home"))
                .setConsole(false)
                .start();

        // Output to Firebase
        new Thread(() -> {
            try (InputStream in = shell.getInputStream()) {
                byte[] buffer = new byte[4096];
                int len;
                while ((len = in.read(buffer)) != -1) {
                    String dataB64 = Base64.getEncoder().encodeToString(Arrays.copyOf(buffer, len));
                    r.output.push().setValueAsync(Map.of("data", dataB64));
                }
            } catch (IOException ignored) {}
        }).start();

        // Input from Firebase
        r.input.addChildEventListener(new ChildEventListener() {
            @Override
            public void onChildAdded(DataSnapshot snapshot, String prevChildKey) {
                Map<String, Object> val = (Map<String, Object>) snapshot.getValue();
                if (val != null && val.containsKey("data")) {
                    byte[] buf = Base64.getDecoder().decode((String) val.get("data"));
                    try {
                        shell.getOutputStream().write(buf);
                        shell.getOutputStream().flush();
                    } catch (IOException ignored) {}
                }
                snapshot.getRef().removeValueAsync();
            }
            @Override public void onChildChanged(DataSnapshot s, String p) {}
            @Override public void onChildRemoved(DataSnapshot s) {}
            @Override public void onChildMoved(DataSnapshot s, String p) {}
            @Override public void onCancelled(DatabaseError e) {}
        });

        // Exit handling
        new Thread(() -> {
            try {
                int code = shell.waitFor();
                r.state.setValueAsync(Map.of("status", "exited", "code", code));
                System.exit(code);
                System.out.println("SSH server down.");
            } catch (InterruptedException ignored) {}
        }).start();

        System.out.println("SSH server running. Waiting for Firebase input. You can connect a client now.");
    }

    // ---- HTTP FEATURE ----
    static void runHTTPServer(FirebaseDatabase db, String sessionId) throws Exception {
        Refs r = refs(db, "sessions/" + sessionId + "/http");
        r.state.setValueAsync(Map.of("status", "connected"));

        r.input.addChildEventListener(new ChildEventListener() {
            @Override
            public void onChildAdded(DataSnapshot snapshot, String prevChildKey) {
                Map<String, Object> val = (Map<String, Object>) snapshot.getValue();
                if (val != null && val.containsKey("reqId") && val.containsKey("port")
                        && val.containsKey("method") && val.containsKey("uri")) {
                    String reqId = (String) val.get("reqId");
                    int port = Integer.parseInt(val.get("port").toString());
                    String method = (String) val.get("method");
                    String uri = (String) val.get("uri");
                    Map<String, String> headers = val.containsKey("headers") ?
                            (Map<String, String>) val.get("headers") : new HashMap<>();
                    byte[] body = (val.containsKey("body") && val.get("body") != null) ?
                            Base64.getDecoder().decode((String) val.get("body")) : new byte[0];

                    // HTTP Request
                    int status = 500;
                    byte[] respData = new byte[0];
                    Map<String, List<String>> respHeaders = new HashMap<>();
                    try {
                        HttpClient client = HttpClient.newHttpClient();

                        HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
                            .uri(new URI("http://localhost:" + port + uri))
                            .method(method.toUpperCase(), body.length > 0 
                                ? HttpRequest.BodyPublishers.ofByteArray(body)
                                : HttpRequest.BodyPublishers.noBody());

                        // Set headers
                        // headers.forEach(reqBuilder::header);
                        Set<String> restricted = Set.of(
                            "host", "content-length", "transfer-encoding", "connection", "expect", "upgrade"
                        );

                        headers.forEach((k, v) -> {
                            if (!restricted.contains(k.toLowerCase()))
                                reqBuilder.header(k, v);
                        });


                        HttpRequest request = reqBuilder.build();
                        HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());

                        status = response.statusCode();
                        respHeaders = response.headers().map();
                        respData = response.body();
                    } catch (Exception e) {
                        respData = ("Error: " + e.getMessage()).getBytes(StandardCharsets.UTF_8);
                        status = 502;
                    }

                    // Output to Firebase 
                    final Map<String, Object> outVal = new HashMap<>();
                    outVal.put("reqId", reqId);
                    outVal.put("status", status);
                    outVal.put("headers", respHeaders);
                    outVal.put("body", Base64.getEncoder().encodeToString(respData));

                    new Thread(() -> {
                        r.output.push().setValueAsync(outVal);
                    }).start();
                    
                }
                snapshot.getRef().removeValueAsync();
            }
            @Override public void onChildChanged(DataSnapshot s, String p) {}
            @Override public void onChildRemoved(DataSnapshot s) {}
            @Override public void onChildMoved(DataSnapshot s, String p) {}
            @Override public void onCancelled(DatabaseError e) {}
        });

        System.out.println("HTTP server proxy running. Waiting for HTTP requests from Firebase client.");

        while (true) Thread.sleep(10000);
        // System.out.println("HTTP server proxy down.");
    }

    // ---- MANAGE FEATURE ----
    static class FeatureManager {
        static class SessionInfo {
            Process proc;
            String status;
            String startedAt;
            Integer port; // for HTTP
        }
        static class HistoryEntry {
            String action, time, sessionId;
            Integer port;
            HistoryEntry(String action, String time, String sessionId, Integer port) {
                this.action = action; this.time = time; this.sessionId = sessionId; this.port = port;
            }
        }

        Map<String, Boolean> enabled = Map.of("ssh", true, "http", true);
        Map<String, Map<String, SessionInfo>> sessions = Map.of(
                "ssh", new ConcurrentHashMap<>(),
                "http", new ConcurrentHashMap<>()
        );
        Map<String, List<HistoryEntry>> history = Map.of(
                "ssh", Collections.synchronizedList(new ArrayList<>()),
                "http", Collections.synchronizedList(new ArrayList<>())
        );

        synchronized Map<String, Object> getStatus() {
            Map<String, Object> res = new HashMap<>();
            for (String feat : List.of("ssh", "http")) {
                Map<String, Object> f = new HashMap<>();
                f.put("enabled", enabled.get(feat));
                List<Map<String, Object>> sessList = new ArrayList<>();
                for (Map.Entry<String, SessionInfo> e : sessions.get(feat).entrySet()) {
                    Map<String, Object> s = new HashMap<>();
                    s.put("sessionId", e.getKey());
                    s.put("status", e.getValue().status);
                    s.put("startedAt", e.getValue().startedAt);
                    s.put("pid", e.getValue().proc != null ? e.getValue().proc.pid() : null);
                    if (feat.equals("http"))
                        s.put("port", e.getValue().port);
                    sessList.add(s);
                }
                f.put("sessions", sessList);
                f.put("history", history.get(feat).stream()
                        .skip(Math.max(0, history.get(feat).size() - 20))
                        .map(h -> {
                            Map<String, Object> he = new HashMap<>();
                            he.put("action", h.action);
                            he.put("time", h.time);
                            if (h.sessionId != null) he.put("sessionId", h.sessionId);
                            if (h.port != null) he.put("port", h.port);
                            return he;
                        }).collect(Collectors.toList()));
                res.put(feat, f);
            }
            return res;
        }

        synchronized Map<String, Object> setFeature(String feature, String action, String sessionId, Integer port) {
            if (!List.of("ssh", "http").contains(feature))
                return Map.of("error", "Invalid feature");
            String now = Instant.now().toString();
            Map<String, Object> result = new HashMap<>();
            if (action.equals("enable")) {
                enabled = new HashMap<>(enabled); enabled.put(feature, true);
                history.get(feature).add(new HistoryEntry(action, now, null, null));
                result.put("success", true);
                return result;
            }
            if (action.equals("disable")) {
                enabled = new HashMap<>(enabled); enabled.put(feature, false);
                // Stop all sessions
                for (String sid : new ArrayList<>(sessions.get(feature).keySet()))
                    stopSession(feature, sid);
                history.get(feature).add(new HistoryEntry(action, now, null, null));
                result.put("success", true);
                return result;
            }
            if (action.equals("start")) {
                if (!enabled.get(feature)) return Map.of("error", "Feature disabled");
                if (sessionId == null || sessionId.isEmpty()) return Map.of("error", "Session ID is required");
                String sessionKey = feature.equals("http") && port != null ? sessionId + ":" + port : sessionId;
                if (sessions.get(feature).containsKey(sessionKey)) return Map.of("error", "Session already running");
                // Start process
                try {

                    List<String> cmd = new ArrayList<>();

                    cmd.add(System.getProperty("java.home") + "/bin/java");
                    cmd.add("-Duser.dir=" + System.getProperty("user.dir"));
                    cmd.add("-cp");
                    cmd.add(System.getProperty("java.class.path"));
                    cmd.add(JServ.class.getName());
                    cmd.add(feature); cmd.add(sessionId);

                    ProcessBuilder pb = new ProcessBuilder(cmd);
                    pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
                    pb.redirectError(ProcessBuilder.Redirect.DISCARD);
                    Process proc = pb.start();
                    // Detach: Java doesn't support full OS detach, but we don't wait for it.
                    SessionInfo info = new SessionInfo();
                    info.proc = proc;
                    info.status = "running";
                    info.startedAt = now;
                    if (feature.equals("http") && port != null) info.port = port;
                    sessions.get(feature).put(sessionKey, info);
                    history.get(feature).add(new HistoryEntry(action, now, sessionId, port));
                    result.put("success", true);
                    return result;
                } catch (Exception e) {
                    return Map.of("error", "Failed to start: " + e.getMessage());
                }
            }
            if (action.equals("stop")) {
                if (sessionId == null || sessionId.isEmpty()) return Map.of("error", "Session ID is required");
                String sessionKey = feature.equals("http") && port != null ? sessionId + ":" + port : sessionId;
                if (!sessions.get(feature).containsKey(sessionKey)) return Map.of("error", "No such session");
                stopSession(feature, sessionKey);
                result.put("success", true);
                return result;
            }
            return Map.of("error", "Unknown action");
        }

        void stopSession(String feature, String sessionKey) {
            SessionInfo s = sessions.get(feature).get(sessionKey);
            if (s != null && s.proc != null) {
                s.proc.destroy();
            }
            if (s != null) s.status = "stopped";
            sessions.get(feature).remove(sessionKey);
            String now = Instant.now().toString();
            String sid = sessionKey.contains(":") ? sessionKey.split(":")[0] : sessionKey;
            Integer p = sessionKey.contains(":") ? Integer.valueOf(sessionKey.split(":")[1]) : null;
            history.get(feature).add(new HistoryEntry("stop", now, sid, p));
        }
    }

    static void runManageServer(boolean startWebAt1) throws IOException {
        FeatureManager mgr = new FeatureManager();
        if (startWebAt1) {
            Map<String, Object> result = mgr.setFeature("http", "start", "1", null);
            if (result.get("success") == null || !(Boolean) result.get("success")) {
                System.err.println("[manage] Failed to auto-start HTTP session 1: " + result.get("error"));
            } else {
                System.out.println("[manage] Auto-started HTTP session with ID 1.");
            }
        }
        com.sun.net.httpserver.HttpServer server = com.sun.net.httpserver.HttpServer.create(new InetSocketAddress(MANAGE_PORT), 0);
        // API: /api/status
        server.createContext("/api/status", exchange -> {
            if ("GET".equals(exchange.getRequestMethod())) {
                byte[] resp = gson.toJson(mgr.getStatus()).getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                addCORS(exchange);
                exchange.sendResponseHeaders(200, resp.length);
                exchange.getResponseBody().write(resp);
            } else {
                addCORS(exchange);
                exchange.sendResponseHeaders(204, -1);
            }
            exchange.close();
        });
        // API: /api/feature/{feature}
        server.createContext("/api/feature/", exchange -> {
            String[] segs = exchange.getRequestURI().getPath().split("/");
            if (segs.length != 4) {
                addCORS(exchange);
                exchange.sendResponseHeaders(404, -1);
                exchange.close();
                return;
            }
            String feature = segs[3];
            if ("POST".equals(exchange.getRequestMethod())) {
                byte[] body = exchange.getRequestBody().readAllBytes();
                Map<String, Object> req = gson.fromJson(new String(body, StandardCharsets.UTF_8),
                        new TypeToken<Map<String, Object>>() {}.getType());
                String action = (String) req.get("action");
                String sessionId = req.containsKey("sessionId") ? (String) req.get("sessionId") : null;
                Integer port = req.containsKey("port") && req.get("port") != null ? ((Number) req.get("port")).intValue() : null;
                Map<String, Object> result = mgr.setFeature(feature, action, sessionId, port);
                byte[] resp = gson.toJson(result).getBytes(StandardCharsets.UTF_8);
                addCORS(exchange);
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(result.containsKey("error") ? 400 : 200, resp.length);
                exchange.getResponseBody().write(resp);
            } else {
                addCORS(exchange);
                exchange.sendResponseHeaders(204, -1);
            }
            exchange.close();
        });
        // UI: /
        server.createContext("/", exchange -> {
            if ("GET".equals(exchange.getRequestMethod()) && "/".equals(exchange.getRequestURI().getPath())) {
                String html = getManageHtml();
                byte[] resp = html.getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "text/html");
                addCORS(exchange);
                exchange.sendResponseHeaders(200, resp.length);
                exchange.getResponseBody().write(resp);
            } else {
                addCORS(exchange);
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                byte[] resp = "{\"error\":\"Not found\"}".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(404, resp.length);
                exchange.getResponseBody().write(resp);
            }
            exchange.close();
        });
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();
        System.out.println("Feature management UI running on http://localhost:" + MANAGE_PORT + "/");
    }
    static void addCORS(com.sun.net.httpserver.HttpExchange exchange) {
        exchange.getResponseHeaders().add("Access-Control-Allow-Origin", "*");
        exchange.getResponseHeaders().add("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        exchange.getResponseHeaders().add("Access-Control-Allow-Headers", "Content-Type");
    }

    static String htmlCode  = null;
    // ---- Manage UI HTML (exact port of Node.js) ----
    static String getManageHtml() {
      if(htmlCode == null) {
        try{
          htmlCode = Files.readString(Paths.get(System.getProperty("user.dir"), "feature_manager.html"));
          return htmlCode;
        } catch(Exception e) { return ""; }
      } else return htmlCode;
    }
}
