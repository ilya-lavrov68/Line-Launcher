// Reference client for a provider's Minecraft auth mod. Loader-specific hook
// code is intentionally not included: call this before the game joins a server.
// Java 17+. On Windows the named pipe is opened as a file; on Unix Java 16+
// Unix-domain sockets are used. The ticket is one-shot and must be exchanged
// immediately over HTTPS; never log it or pass it as a JVM argument.
import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.*;
import java.nio.channels.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public final class LineTicketClient {
  private static final int MAX_MESSAGE = 16 * 1024;
  private static final long IPC_TIMEOUT_MS = timeoutProperty();

  public record Ticket(String ticket, String exchangeUrl, String serverId, String sha256, String username, String channelId) {
    public Ticket {
      if (ticket == null || ticket.isEmpty() || ticket.length() > 8192 || ticket.chars().anyMatch(c -> c < 0x20)) throw new IllegalArgumentException("Invalid ticket");
      if (serverId == null || !serverId.matches("[a-z0-9][a-z0-9_-]{0,63}")) throw new IllegalArgumentException("Invalid server id");
      if (sha256 == null || !sha256.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Invalid release hash");
      if (username == null || username.isEmpty() || username.length() > 64 || username.chars().anyMatch(c -> c < 0x20)) throw new IllegalArgumentException("Invalid username");
      if (channelId == null || !channelId.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) throw new IllegalArgumentException("Invalid channel");
      validateHttps(exchangeUrl);
    }
    @Override public String toString() {
      return "Ticket[ticket=[REDACTED], serverId=" + serverId + ", sha256=" + sha256 + ", username=" + username + ", channelId=" + channelId + "]";
    }
  }

  private static long timeoutProperty() {
    long value = Long.getLong("lineLauncher.ipcTimeoutMs", 60_000L);
    if (value < 1_000 || value > 60_000) throw new IllegalArgumentException("lineLauncher.ipcTimeoutMs must be 1000..60000");
    return value;
  }

  public static Ticket request() throws Exception {
    String channel = System.getProperty("lineLauncher.sessionChannel");
    if (channel == null || !channel.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) throw new IllegalStateException("Line channel missing");
    String request = "{\"type\":\"line.launch-ticket.request\",\"channel\":" + LineJson.string(channel) + "}\n";
    String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
    String response = os.contains("win") ? windowsIpc(channel, request) : unixIpc(channel, request);
    Map<String, String> fields = LineJson.object(response);
    Set<String> expected = Set.of("type", "ticket", "exchange_url", "server_id", "sha256", "username");
    if (!fields.keySet().equals(expected) || !"line.launch-ticket.response".equals(fields.get("type"))) throw new IOException("Unexpected Line IPC response");
    return new Ticket(fields.get("ticket"), fields.get("exchange_url"), fields.get("server_id"), fields.get("sha256"), fields.get("username"), channel);
  }

  private static String unixIpc(String channel, String request) throws Exception {
    // The launcher uses a short /tmp path on every Unix desktop. java.io.tmpdir
    // differs on macOS and may exceed the Unix socket path length limit.
    Path socket = Path.of("/tmp", "line-ipc-" + channel, "ticket.sock");
    try (SocketChannel ch = SocketChannel.open(StandardProtocolFamily.UNIX)) {
      ch.configureBlocking(false);
      long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(IPC_TIMEOUT_MS);
      ch.connect(UnixDomainSocketAddress.of(socket));
      while (!ch.finishConnect()) {
        if (System.nanoTime() > deadline) throw new SocketTimeoutException("Line IPC connect timeout");
        Thread.sleep(5);
      }
      ByteBuffer out = ByteBuffer.wrap(request.getBytes(StandardCharsets.UTF_8));
      while (out.hasRemaining()) {
        int n = ch.write(out);
        if (System.nanoTime() > deadline) throw new SocketTimeoutException("Line IPC write timeout");
        if (n == 0) Thread.sleep(5);
      }
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      ByteBuffer buf = ByteBuffer.allocate(4096);
      boolean newline = false;
      while (!newline) {
        buf.clear();
        int n = ch.read(buf);
        if (n < 0) break;
        if (n == 0) {
          if (System.nanoTime() > deadline) throw new SocketTimeoutException("Line IPC read timeout");
          Thread.sleep(5);
          continue;
        }
        buf.flip();
        while (buf.hasRemaining()) {
          byte b = buf.get();
          if (bytes.size() >= MAX_MESSAGE) throw new IOException("Line IPC response too large");
          bytes.write(b);
          if (b == '\n') { newline = true; break; }
        }
        if (newline && buf.hasRemaining()) throw new IOException("Trailing IPC bytes");
      }
      if (!newline) throw new IOException("Unterminated Line IPC response");
      return bytes.toString(StandardCharsets.UTF_8);
    }
  }

  private static String windowsIpc(String channel, String request) throws Exception {
    AtomicReference<RandomAccessFile> handle = new AtomicReference<>();
    ExecutorService executor = Executors.newSingleThreadExecutor(r -> {
      Thread t = new Thread(r, "line-ticket-ipc");
      t.setDaemon(true);
      return t;
    });
    Future<String> future = executor.submit(() -> {
      try (RandomAccessFile pipe = new RandomAccessFile("\\\\.\\pipe\\line-launcher-" + channel, "rw")) {
        handle.set(pipe);
        pipe.write(request.getBytes(StandardCharsets.UTF_8));
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        while (true) {
          int b = pipe.read();
          if (b < 0) throw new IOException("Unterminated Line IPC response");
          if (bytes.size() >= MAX_MESSAGE) throw new IOException("Line IPC response too large");
          bytes.write(b);
          if (b == '\n') {
            int trailing = pipe.read();
            if (trailing >= 0) throw new IOException("Trailing IPC bytes");
            return bytes.toString(StandardCharsets.UTF_8);
          }
        }
      } finally {
        handle.set(null);
      }
    });
    try {
      return future.get(IPC_TIMEOUT_MS, TimeUnit.MILLISECONDS);
    } catch (TimeoutException e) {
      RandomAccessFile pipe = handle.getAndSet(null);
      if (pipe != null) try { pipe.close(); } catch (IOException ignored) {}
      future.cancel(true);
      throw new SocketTimeoutException("Line IPC timeout");
    } finally {
      executor.shutdownNow();
    }
  }

  private static URI validateHttps(String raw) {
    if (raw == null || raw.length() > 2048) throw new IllegalArgumentException("HTTPS required");
    URI uri;
    try { uri = URI.create(raw); } catch (IllegalArgumentException e) { throw new IllegalArgumentException("Invalid HTTPS URL"); }
    if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null) throw new IllegalArgumentException("HTTPS required");
    return uri;
  }

  public static String exchange(Ticket ticket) throws Exception {
    URI uri = validateHttps(ticket.exchangeUrl());
    String body = "{\"ticket\":" + LineJson.string(ticket.ticket())
      + ",\"server_id\":" + LineJson.string(ticket.serverId())
      + ",\"sha256\":" + LineJson.string(ticket.sha256())
      + ",\"channel_id\":" + LineJson.string(ticket.channelId())
      + ",\"username\":" + LineJson.string(ticket.username()) + "}";
    HttpClient client = HttpClient.newBuilder()
      .connectTimeout(java.time.Duration.ofSeconds(10))
      .followRedirects(HttpClient.Redirect.NEVER)
      .build();
    HttpRequest request = HttpRequest.newBuilder(uri)
      .timeout(java.time.Duration.ofSeconds(30))
      .header("Content-Type", "application/json")
      .header("Accept", "application/json")
      .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
      .build();
    HttpResponse<InputStream> response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());
    try (InputStream in = response.body()) {
      if (response.statusCode() != 200) throw new IOException("Ticket exchange rejected");
      byte[] bytes = in.readNBytes(MAX_MESSAGE + 1);
      if (bytes.length > MAX_MESSAGE) throw new IOException("Ticket exchange response too large");
      return new String(bytes, StandardCharsets.UTF_8);
    }
  }

  /** Strict flat JSON object codec for the fixed launcher contract. A real mod
   * may replace this with its existing JSON library; do not use substring search. */
  static final class LineJson {
    static String string(String value) {
      StringBuilder out = new StringBuilder("\"");
      for (int i = 0; i < value.length(); i++) {
        char c = value.charAt(i);
        switch (c) {
          case '"' -> out.append("\\\"");
          case '\\' -> out.append("\\\\");
          case '\b' -> out.append("\\b");
          case '\f' -> out.append("\\f");
          case '\n' -> out.append("\\n");
          case '\r' -> out.append("\\r");
          case '\t' -> out.append("\\t");
          default -> {
            if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
            else out.append(c);
          }
        }
      }
      return out.append('"').toString();
    }

    static Map<String, String> object(String json) throws IOException {
      Parser p = new Parser(json);
      Map<String, String> out = p.object();
      p.ws();
      if (!p.eof()) throw new IOException("Trailing JSON");
      return out;
    }

    private static final class Parser {
      private final String s;
      private int i;
      Parser(String s) { this.s = s; }
      boolean eof() { return i >= s.length(); }
      void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
      char peek() throws IOException { if (eof()) throw new IOException("Unexpected end of JSON"); return s.charAt(i); }
      void expect(char c) throws IOException { ws(); if (eof() || s.charAt(i++) != c) throw new IOException("Invalid JSON"); }
      Map<String, String> object() throws IOException {
        expect('{');
        Map<String, String> out = new LinkedHashMap<>();
        ws();
        if (peek() == '}') { i++; return out; }
        while (true) {
          ws();
          String key = string();
          expect(':');
          ws();
          String value = string();
          if (out.putIfAbsent(key, value) != null) throw new IOException("Duplicate JSON field");
          ws();
          char c = peek();
          if (c == '}') { i++; return out; }
          if (c != ',') throw new IOException("Invalid JSON object");
          i++;
        }
      }
      String string() throws IOException {
        if (peek() != '"') throw new IOException("JSON string required");
        i++;
        StringBuilder out = new StringBuilder();
        while (true) {
          if (eof()) throw new IOException("Unterminated JSON string");
          char c = s.charAt(i++);
          if (c == '"') return out.toString();
          if (c < 0x20) throw new IOException("Control character in JSON string");
          if (c != '\\') { out.append(c); continue; }
          if (eof()) throw new IOException("Unterminated JSON escape");
          char e = s.charAt(i++);
          switch (e) {
            case '"', '\\', '/' -> out.append(e);
            case 'b' -> out.append('\b');
            case 'f' -> out.append('\f');
            case 'n' -> out.append('\n');
            case 'r' -> out.append('\r');
            case 't' -> out.append('\t');
            case 'u' -> {
              if (i + 4 > s.length()) throw new IOException("Invalid unicode escape");
              String hex = s.substring(i, i + 4);
              i += 4;
              try { out.append((char) Integer.parseInt(hex, 16)); } catch (NumberFormatException ex) { throw new IOException("Invalid unicode escape"); }
            }
            default -> throw new IOException("Invalid JSON escape");
          }
        }
      }
    }
  }
}
