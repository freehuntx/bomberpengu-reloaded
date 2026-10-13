import { Network, createSession, trysteroBridge, broadcastChannelBridge, type GameSession, type Bridge } from "./net/index.ts";
import { bomberpengu } from "./game/game.ts";
import { BomberpenguClient } from "./game/client.ts";
import { browserLanguage, translations } from "./game/i18n.ts";
import "./app.css";

const params = new URLSearchParams(location.search);
const language = browserLanguage();
const text = translations[language];
document.documentElement.lang = language;
const roomCode = params.get("room")?.trim() || "lobby";
let playerName = params.get("name")?.trim();
try {
  playerName ||= localStorage.getItem("playerName")?.trim();
} catch {
  // Joining still works when browser storage is unavailable.
}
playerName ||= `Player${Math.floor(Math.random() * 98999 + 1000)}`;
try {
  localStorage.setItem("playerName", playerName);
} catch {
  // Keep the selected name for this session even if it cannot be saved.
}

const root = document.getElementById("game-root")!;
const client = new BomberpenguClient(root, playerName, language);
const net = new Network({ debug: params.has("debug") });
let bridge: Bridge | undefined;
let session: GameSession | undefined;
let disposed = false;
window.addEventListener("beforeunload", () => {
  disposed = true;
  client.dispose();
  session?.leave();
  bridge?.close();
  net.dispose();
});
try {
  bridge = params.get("transport") === "local"
    ? broadcastChannelBridge({ channel: `bomberpengu-reloaded:${roomCode}` })
    : await remoteBridge(roomCode);
  if (disposed) bridge.close();
  else {
    session = await createSession(bomberpengu({
      motd: params.get("motd") ?? undefined,
      debug: params.has("debug"),
    }), { net, bridge, settleMs: params.get("transport") === "local" ? 200 : 4000 });
    if (disposed) session.leave();
    else {
      if (params.has("debug")) {
        session.on("host-changed", (host, isHost) => console.log("[bomberpengu] host:", host, isHost));
        session.on("join", peer => console.log("[bomberpengu] joined:", peer));
        session.on("leave", peer => console.log("[bomberpengu] left:", peer));
      }
      client.connect(session.connect());
    }
  }
} catch (error) {
  client.showError(`${text.connectionFailed} ${String(error)}`);
  bridge?.close();
  net.dispose();
}

async function remoteBridge(roomCode: string): Promise<Bridge> {
  const { joinRoom, selfId } = await import("@trystero-p2p/mqtt");
  return trysteroBridge({ selfId, room: joinRoom({ appId: "bomberpengu-reloaded" }, roomCode) });
}
