// Minimal "game" for end-to-end launcher testing. It is NOT Minecraft: it only
// performs the launch handshake a provider's auth mod would perform, then keeps
// running for a while so the launcher's "game is running" state, the stop button
// and the exit event can all be exercised by hand.
//
// The launcher passes: --gameDir --username --version [--assetIndex --assetsDir]
// and -DlineLauncher.sessionChannel=<uuid>. Nothing secret is in the arguments.
//
// LINE_DEMO_SECONDS (default 20, 0 = exit right away) controls how long it stays
// alive; the automated provider test sets 0 so it does not wait.
//
// Exit codes: 0 = handshake succeeded, 1 = handshake failed.
public final class DemoGame {
  public static void main(String[] args) {
    System.out.println("[demo] Line Launcher handshake started");
    for (int i = 0; i < args.length; i += 1) {
      // Print only non-secret flags; the channel id is not a secret but the
      // ticket must never be logged.
      if (args[i].startsWith("--")) {
        System.out.println("[demo] arg " + args[i] + (i + 1 < args.length ? "=" + args[i + 1] : ""));
      }
    }
    try {
      LineTicketClient.Ticket ticket = LineTicketClient.request();
      System.out.println("[demo] received " + ticket); // toString() redacts the ticket
      String response = LineTicketClient.exchange(ticket);
      System.out.println("[demo] exchange response: " + response);
      System.out.println("[demo] handshake OK");
    } catch (Exception error) {
      // Messages from the reference client never contain the ticket itself.
      System.err.println("[demo] handshake FAILED: " + error.getClass().getSimpleName() + ": " + error.getMessage());
      System.exit(1);
    }
    int seconds = seconds();
    if (seconds <= 0) {
      System.out.println("[demo] exiting immediately (LINE_DEMO_SECONDS=0)");
      return;
    }
    System.out.println("[demo] running for " + seconds + " s — press \"Остановить игру\" in the launcher to stop early");
    for (int left = seconds; left > 0; left -= 1) {
      try {
        Thread.sleep(1000);
      } catch (InterruptedException stopped) {
        Thread.currentThread().interrupt();
        System.out.println("[demo] interrupted");
        return;
      }
      if (left % 5 == 0) System.out.println("[demo] still running, " + (left - 1) + " s left");
    }
    System.out.println("[demo] finished normally");
  }

  private static int seconds() {
    String raw = System.getenv("LINE_DEMO_SECONDS");
    if (raw == null || raw.isBlank()) return 20;
    try {
      return Math.max(0, Math.min(600, Integer.parseInt(raw.trim())));
    } catch (NumberFormatException ignored) {
      return 20;
    }
  }
}
