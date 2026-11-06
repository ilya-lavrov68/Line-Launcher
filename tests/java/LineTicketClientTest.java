// Integration harness for scripts/test-java-client.mjs. Not a mod-loader hook.
import java.io.IOException;
import java.net.SocketTimeoutException;
import java.util.Map;

public final class LineTicketClientTest {
  public static void main(String[] args) throws Exception {
    String mode = args.length == 0 ? "json" : args[0];
    switch (mode) {
      case "json" -> json();
      case "exchange" -> exchange(false, false);
      case "replay" -> exchange(true, false);
      case "expired" -> exchange(false, true);
      case "bindings" -> bindings();
      case "redirect", "oversize-http" -> expectExchangeFailure();
      case "ipc-malformed", "ipc-oversize", "ipc-trailing" -> expectRequestFailure(IOException.class);
      case "ipc-timeout" -> expectRequestFailure(SocketTimeoutException.class);
      default -> throw new IllegalArgumentException("Unknown mode");
    }
    System.out.println("OK");
  }

  private static void json() throws Exception {
    String value = "quote\" slash\\ nl\n tab\t unicode\u00e9控制";
    String encoded = LineTicketClient.LineJson.string(value);
    Map<String, String> decoded = LineTicketClient.LineJson.object("{\"value\":" + encoded + "}");
    if (!value.equals(decoded.get("value"))) throw new AssertionError("JSON roundtrip");
    for (String bad : new String[] {
      "{\"a\":\"1\",\"a\":\"2\"}",
      "{\"a\":\"1\"} trailing",
      "{\"a\":1}",
      "{\"a\":\"unterminated}",
      "{\"a\":\"bad\\x\"}",
      "{\"a\":\"raw\n\"}",
      "{\"a\":\"1\",}"
    }) {
      try {
        LineTicketClient.LineJson.object(bad);
        throw new AssertionError("Accepted bad JSON");
      } catch (IOException expected) {
      }
    }
    LineTicketClient.Ticket ticket = new LineTicketClient.Ticket(
      "secret-ticket", "https://auth.example.com/exchange", "survival", "a".repeat(64), "player",
      "123e4567-e89b-42d3-a456-426614174000");
    if (ticket.toString().contains("secret-ticket")) throw new AssertionError("Ticket toString leaked");
  }

  private static void exchange(boolean replay, boolean expired) throws Exception {
    LineTicketClient.Ticket ticket = LineTicketClient.request();
    if (expired) {
      Thread.sleep(1200);
      try {
        LineTicketClient.exchange(ticket);
        throw new AssertionError("Expired ticket accepted");
      } catch (IOException expected) {
        return;
      }
    }
    String response = LineTicketClient.exchange(ticket);
    if (!response.contains("\"ok\":true")) throw new AssertionError("Unexpected exchange response");
    if (replay) {
      try {
        LineTicketClient.exchange(ticket);
        throw new AssertionError("Replay accepted");
      } catch (IOException expected) {
      }
    }
  }

  private static void bindings() throws Exception {
    LineTicketClient.Ticket t = LineTicketClient.request();
    LineTicketClient.Ticket[] wrong = new LineTicketClient.Ticket[] {
      new LineTicketClient.Ticket(t.ticket(), t.exchangeUrl(), "other", t.sha256(), t.username(), t.channelId()),
      new LineTicketClient.Ticket(t.ticket(), t.exchangeUrl(), t.serverId(), "b".repeat(64), t.username(), t.channelId()),
      new LineTicketClient.Ticket(t.ticket(), t.exchangeUrl(), t.serverId(), t.sha256(), "other", t.channelId()),
      new LineTicketClient.Ticket(t.ticket(), t.exchangeUrl(), t.serverId(), t.sha256(), t.username(), "123e4567-e89b-42d3-a456-426614174999")
    };
    for (LineTicketClient.Ticket bad : wrong) {
      try {
        LineTicketClient.exchange(bad);
        throw new AssertionError("Binding mismatch accepted");
      } catch (IOException expected) {
      }
    }
  }

  private static void expectExchangeFailure() throws Exception {
    LineTicketClient.Ticket ticket = LineTicketClient.request();
    try {
      LineTicketClient.exchange(ticket);
      throw new AssertionError("Exchange failure expected");
    } catch (IOException expected) {
    }
  }

  private static void expectRequestFailure(Class<? extends Exception> type) throws Exception {
    try {
      LineTicketClient.request();
      throw new AssertionError("IPC failure expected");
    } catch (Exception expected) {
      if (!type.isInstance(expected)) throw expected;
    }
  }
}
