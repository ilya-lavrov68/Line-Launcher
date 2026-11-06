// Minimal "game" for end-to-end launcher testing. It is NOT Minecraft: it only
// performs the launch handshake a provider's auth mod would perform, then exits.
//
// The launcher passes: --gameDir --username --version [--assetIndex --assetsDir]
// and -DlineLauncher.sessionChannel=<uuid>. Nothing secret is in the arguments.
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
  }
}
