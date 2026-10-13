import { buildXml, parseXml } from "./game.ts";
import { BomberpenguEngine, type Result } from "./engine.ts";
import { BOT_NAMES, isBotName, botLevel } from "./bot-types.ts";
import { BotController } from "./bots.ts";
import { assetUrl, BomberpenguAudio, BomberpenguRenderer, spriteElement } from "./render.ts";
import { browserLanguage, translations, translateError, translateServerMessage, type Language } from "./i18n.ts";
import type { LocalConnection } from "../net/index.ts";
import "./style.css";

interface LobbyPlayer { name: string; skill: string; state: string }
const statusSprite: Record<string, number> = { "0": 257, "1": 261, "2": 263, "3": 259, "13": 265, "23": 264, "5": 269 };

export class BomberpenguClient {
  readonly engine: BomberpenguEngine;
  private root: HTMLElement;
  private audio = new BomberpenguAudio();
  private renderer: BomberpenguRenderer;
  private socket: LocalConnection | null = null;
  private players = new Map<string, LobbyPlayer>();
  private challenged = new Set<string>();
  private requests = new Set<string>();
  private selected: string | null = null;
  private challengeAll = false;
  private opponent = "";
  private bot: BotController | null = null;
  private botTime = 0;
  private screen = "lobby";
  private rematchRequested = false;
  private rematchReceived = false;
  private connected = false;
  private failure: string | null = null;
  private starting = false;
  private disposed = false;
  private keys: string[] = [];
  private input = new AbortController();
  private ticker: ReturnType<typeof setInterval>;
  private heartbeat: ReturnType<typeof setInterval>;
  private frame = 0;
  private lastTime = performance.now();
  private decoder = new TextDecoder();
  private pending = "";
  private resizeObserver: ResizeObserver;
  private readonly text: typeof translations.en;

  constructor(slot: HTMLElement, readonly name: string, readonly language: Language = browserLanguage()) {
    const t = this.text = translations[language];
    slot.innerHTML = `
      <div class="bp-viewport"><main class="bp-stage" aria-label="BomberPengu" lang="${language}" data-language="${language}" data-loading="true">
        <section class="bp-top">
          <canvas class="bp-arena" width="640" height="480" tabindex="0" aria-label="${t.arena}" hidden></canvas>
          <section class="bp-lobby">
            <header class="bp-title bp-panel"></header>
            <div class="bp-player-panel bp-panel"><div class="bp-player-list" aria-label="${t.players}"></div><footer><b>${t.playerCount}</b><span class="bp-player-count">0</span></footer></div>
            <div class="bp-action bp-panel">${t.choosePlayer}</div>
            <section class="bp-info bp-panel"><h2>${t.playerInfo}</h2><dl>
              <dt>${t.total}</dt><dd data-stat="total">-</dd><dt>${t.wins}</dt><dd data-stat="wins">-</dd>
              <dt>${t.losses}</dt><dd data-stat="losses">-</dd><dt>${t.draws}</dt><dd data-stat="draws">-</dd>
              <dt class="bp-rate">${t.rate}</dt><dd class="bp-rate" data-stat="rate">- %</dd>
            </dl></section>
            <section class="bp-legend bp-panel" aria-label="${t.playerStatus}"></section>
            <button class="bp-challenge-all bp-image-button" type="button" aria-label="${t.challengeAll}"></button>
          </section>
          <section class="bp-results" hidden>
            <header class="bp-result-heading bp-panel"><h2 class="bp-result-text"></h2></header>
            <section class="bp-next bp-panel"><div class="bp-rematch-status"></div><button class="bp-rematch bp-image-button" type="button" aria-label="${t.playAgain}"></button></section>
            <section class="bp-return bp-panel"><div class="bp-return-label"></div><button class="bp-to-room bp-image-button" type="button" aria-label="${t.playerRoom}"></button></section>
          </section>
          <button class="bp-surrender bp-image-button" type="button" aria-label="${t.surrender}" hidden></button>
          <button class="bp-sound" type="button" aria-label="${t.soundOff}" title="${t.soundOff}">♫</button>
          <section class="bp-overlay" hidden><div class="bp-panel"><h2 class="bp-overlay-title"></h2><p class="bp-overlay-message"></p><div class="bp-overlay-buttons"></div></div></section>
        </section>
        <section class="bp-chat" inert><div class="bp-chat-lines" role="log" aria-live="polite" aria-label="${t.chat}"></div>
          <form class="bp-chat-form"><input class="bp-chat-input" aria-label="${t.chatMessage}" maxlength="200" autocomplete="off"><button class="bp-send bp-image-button" type="submit" aria-label="${t.send}"></button></form>
        </section>
        <div class="bp-touch" aria-label="${t.touchControls}"><button data-key="ArrowLeft" aria-label="${t.left}">◀</button><button data-key="ArrowUp" aria-label="${t.up}">▲</button><button data-key="ArrowDown" aria-label="${t.down}">▼</button><button data-key="ArrowRight" aria-label="${t.right}">▶</button><button data-key="Space" aria-label="${t.bomb}">${t.bomb.toUpperCase()}</button></div>
      </main></div>`;
    this.root = slot.querySelector(".bp-stage")!;
    this.root.dataset.screen = "lobby";
    this.heading(".bp-title", 272, t.playerRoom, t.gameSubtitle);
    this.heading(".bp-result-heading", 434, t.results, t.gameSubtitle);
    this.heading(".bp-next", 435, t.next, t.decide);
    if (language === "de") {
      const image = new Image(); image.src = assetUrl("text-454.svg"); image.alt = t.returnTo;
      this.el(".bp-return-label").append(image);
    } else this.el(".bp-return-label").textContent = t.returnTo;
    this.engine = new BomberpenguEngine(xml => this.sendRaw(xml), sound => this.audio.play(sound), result => this.showResult(result));
    this.renderer = new BomberpenguRenderer(this.el<HTMLCanvasElement>(".bp-arena"), this.engine);
    void this.renderer.load().catch(error => this.showError(t.graphicsFailed(String(error))));
    this.el(".bp-challenge-all").append(this.buttonSprite(277, t.challengeAll));
    this.el(".bp-rematch").append(this.buttonSprite(442, t.playAgain));
    this.el(".bp-to-room").append(this.buttonSprite(453, t.playerRoom));
    this.el(".bp-send").append(this.buttonSprite(284, t.send));
    this.el(".bp-surrender").append(this.buttonSprite(429, t.surrender));
    [257, 259, 269, 261, 265, 263, 264].forEach((id, i) => {
      const entry = document.createElement("div");
      entry.append(spriteElement(id), document.createTextNode(t.legend[i]!));
      this.el(".bp-legend").append(entry);
    });
    this.bindInputs();
    const viewport = slot.querySelector<HTMLElement>(".bp-viewport")!;
    this.resizeObserver = new ResizeObserver(() => {
      const scale = Math.min(viewport.clientWidth / 640, viewport.clientHeight / 640);
      this.root.style.transform = `translate(-50%, -50%) scale(${scale})`;
      this.renderer.setDisplayScale(scale);
    });
    this.resizeObserver.observe(viewport);
    this.overlay(t.connecting, t.loadingRoom);
    this.ticker = setInterval(() => {
      const now = performance.now(), dt = now - this.lastTime;
      this.lastTime = now;
      if (this.screen === "game") {
        if (this.bot) {
          // The AI and collision rules share fixed 40-Hz steps.
          this.botTime += Math.min(dt, 250);
          while (this.botTime >= 25 && this.screen === "game") {
            this.bot.tick(25);
            this.engine.tick(25);
            this.botTime -= 25;
          }
        } else this.engine.tick(dt);
      }
      if (this.starting && this.engine.phase === "playing") {
        this.starting = false;
        this.hideOverlay();
      }
    }, 25);
    this.heartbeat = setInterval(() => this.send("beat"), 15000);
    const draw = () => {
      if (this.disposed) return;
      if (this.screen !== "lobby") {
        const names: [string, string] = this.engine.localNr === 1 ? [name, this.opponent] : [this.opponent, name];
        this.renderer.draw(names, this.screen === "game");
      }
      this.frame = requestAnimationFrame(draw);
    };
    this.frame = requestAnimationFrame(draw);
  }

  private el<T extends HTMLElement = HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }

  private heading(selector: string, id: number, title: string, subtitle: string): void {
    const heading = document.createElement("h1");
    if (this.language === "de") {
      const image = new Image(); image.src = assetUrl(`text-${id}.svg`); image.alt = `${title} – ${subtitle}`;
      heading.append(image);
    } else {
      // The original display font uses lowercase character codes for its
      // uppercase-looking glyphs. Avoid falling back to a second font per letter.
      heading.textContent = title.toLowerCase();
    }
    this.el(selector).prepend(heading);
    if (this.language === "en") {
      const small = document.createElement("small"); small.textContent = subtitle.toLowerCase();
      heading.after(small);
    }
  }

  private buttonSprite(id: number, label: string, frame = 1): HTMLElement {
    return spriteElement(id, frame, this.language === "en" ? label : undefined);
  }

  connect(connection: LocalConnection): void {
    // Preserve the NUL-delimited XML protocol over the native peer connection.
    this.socket = connection;
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("open", () => {
      this.connected = true;
      this.failure = null;
      this.send("auth", { name: this.name, version: "1.1.0.spika", hash: "1bf6093ea530924697ca9cebd7bf4abb" });
    });
    this.socket.addEventListener("message", rawEvent => {
      const event = rawEvent as MessageEvent<string | ArrayBuffer>;
      this.pending += typeof event.data === "string" ? event.data : this.decoder.decode(event.data, { stream: true });
      let end: number;
      while ((end = this.pending.indexOf("\0")) !== -1) {
        const message = this.pending.slice(0, end).trim();
        this.pending = this.pending.slice(end + 1);
        this.receive(message);
      }
    });
    this.socket.addEventListener("close", () => {
      this.connected = false;
      if (!this.disposed) this.showError(this.failure ?? this.text.disconnected);
    });
    this.socket.addEventListener("error", () => this.showError(this.text.connectionFailed));
  }

  private sendRaw(xml: string): void { if (this.connected) this.socket?.send(`${xml}\0`); }
  private send(tag: string, attrs: Record<string, string | number> = {}): void { this.sendRaw(buildXml(tag, attrs)); }

  private receive(raw: string): void {
    const xml = parseXml(raw);
    if (!xml) return;
    const { tag, attrs: a } = xml;
    switch (tag) {
      case "userList": {
        const bots = BOT_NAMES.map(name => this.players.get(name) ?? { name, skill: "0/0/0", state: "0" });
        this.players.clear();
        for (const bot of bots) this.players.set(bot.name, bot);
        for (const text of raw.match(/<user\s[^>]*>/g) ?? []) {
          const user = parseXml(text)!.attrs;
          this.players.set(user.name!, { name: user.name!, skill: user.skill ?? "0/0/0", state: user.state ?? "0" });
        }
        delete this.root.dataset.loading;
        this.el(".bp-chat").inert = false;
        this.hideOverlay();
        this.refreshLobby();
        return;
      }
      case "newPlayer": case "playerUpdate": {
        const name = a.name!;
        let state = name === this.name ? "5" : a.state ?? "0";
        if (name !== this.name) {
          const busy = state.endsWith("3");
          if (this.requests.has(name)) state = busy ? "13" : "1";
          else if (this.challenged.has(name) || this.challengeAll) state = busy ? "23" : "2";
        }
        this.players.set(name, { name, skill: a.skill ?? "0/0/0", state });
        if (name === this.opponent && this.screen === "result" && !state.endsWith("3")) this.updateRematch();
        this.refreshLobby();
        return;
      }
      case "playerLeft":
        this.players.delete(a.name!);
        this.requests.delete(a.name!); this.challenged.delete(a.name!);
        if (a.name === this.opponent) {
          if (this.screen === "game") this.engine.finish("win");
          this.updateRematch();
        }
        this.refreshLobby();
        return;
      case "request": case "remRequest": {
        const player = this.players.get(a.name!);
        if (tag === "request") { this.requests.add(a.name!); this.audio.play("request"); }
        else this.requests.delete(a.name!);
        if (player) player.state = tag === "request" ? player.state.endsWith("3") ? "13" : "1"
          : player.state.endsWith("3") ? "3" : "0";
        this.refreshLobby();
        return;
      }
      case "startGame": this.startMatch(a.name!, 2); return;
      case "startBot":
        if (isBotName(a.name ?? "")) this.startMatch(a.name!, 2);
        return;
      case "playAgain":
        this.rematchReceived = true;
        this.updateRematch();
        return;
      case "surrender":
        this.engine.finish(a.winner === this.name ? "win" : a.winner === this.opponent ? "loss" : "draw");
        return;
      case "msgAll": case "msgPlayer":
        if ((tag === "msgAll") === (this.screen === "lobby")) {
          const name = a.name ?? "System";
          this.chat(name, translateServerMessage(name, a.msg ?? "", this.language));
        }
        return;
      case "errorMsg": {
        const document = new DOMParser().parseFromString(raw, "text/xml");
        this.showError(translateError(document.documentElement.textContent ?? this.text.connectionFailed, this.language));
        return;
      }
    }
    if (this.screen === "game" || this.screen === "result") this.engine.receive(xml);
  }

  private refreshLobby(): void {
    const list = this.el(".bp-player-list");
    list.replaceChildren();
    const players = [...this.players.values()].sort((a, b) =>
      Number(isBotName(b.name)) - Number(isBotName(a.name))
      || (isBotName(a.name) && isBotName(b.name) ? BOT_NAMES.indexOf(a.name) - BOT_NAMES.indexOf(b.name) : 0)
      || Number(a.name.startsWith("Gast")) - Number(b.name.startsWith("Gast")) || a.name.localeCompare(b.name));
    for (const player of players) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bp-player";
      button.dataset.name = player.name;
      button.title = this.text.actions[player.state] ?? "";
      button.append(spriteElement(statusSprite[player.state] ?? 257), document.createTextNode(player.name));
      button.addEventListener("pointerenter", () => this.select(player.name));
      button.addEventListener("focus", () => this.select(player.name));
      button.addEventListener("click", () => this.playerAction(player));
      list.append(button);
    }
    this.el(".bp-player-count").textContent = String(players.filter(player => !isBotName(player.name)).length);
    if (this.selected && this.players.has(this.selected)) this.select(this.selected);
    const challengeLabel = this.challengeAll ? this.text.challengedAll : this.text.challengeAll;
    this.el(".bp-challenge-all").replaceChildren(this.buttonSprite(277, challengeLabel, this.challengeAll ? 2 : 1));
    this.el(".bp-challenge-all").setAttribute("aria-label", challengeLabel);
  }

  private select(name: string): void {
    this.selected = name;
    const player = this.players.get(name)!;
    const [wins = 0, losses = 0, draws = 0] = player.skill.split("/").map(Number);
    const total = wins + losses + draws;
    this.el(".bp-info h2").textContent = name;
    this.el(".bp-action").textContent = this.text.actions[player.state] ?? this.text.actions["13"]!;
    for (const [key, value] of Object.entries({ total, wins, losses, draws, rate: `${total ? Math.round(wins / total * 100) : 0} %` })) {
      this.el(`[data-stat="${key}"]`).textContent = String(value);
    }
  }

  private playerAction(player: LobbyPlayer): void {
    this.select(player.name);
    if (isBotName(player.name)) {
      this.send("startBot", { name: player.name });
      return;
    }
    switch (player.state) {
      case "0": case "3":
        this.send("challenge", { name: player.name, hash: "xxxxxx" });
        this.challenged.add(player.name);
        player.state = player.state === "3" ? "23" : "2";
        break;
      case "1": this.startMatch(player.name, 1); break;
      case "2": case "23":
        this.send("remChallenge", { name: player.name, hash: "xxxxxx" });
        this.challenged.delete(player.name);
        player.state = player.state === "23" ? "3" : "0";
        break;
    }
    this.refreshLobby();
  }

  private startMatch(opponent: string, nr: number): void {
    const wasLobby = this.screen === "lobby";
    this.opponent = opponent;
    this.challengeAll = false;
    this.challenged.clear(); this.requests.delete(opponent);
    for (const player of this.players.values()) {
      if (player.name === this.name) continue;
      const busy = player.name === opponent || player.state.endsWith("3");
      player.state = this.requests.has(player.name) ? busy ? "13" : "1" : busy ? "3" : "0";
    }
    this.rematchReceived = this.rematchRequested = false;
    this.screen = "game";
    this.starting = true;
    this.keys = [];
    this.botTime = 0;
    if (isBotName(opponent)) {
      this.engine.startBot(botLevel(opponent) === "freestyle");
      this.bot = new BotController(this.engine, botLevel(opponent));
    } else {
      this.bot = null;
      this.engine.start(nr);
    }
    this.lastTime = performance.now();
    if (nr === 1 && !this.bot) this.send("startGame", { name: opponent, hash: "xxxxxx" });
    if (wasLobby) this.el(".bp-chat-lines").replaceChildren();
    this.root.dataset.screen = "game";
    this.el(".bp-arena").hidden = false;
    this.el(".bp-lobby").hidden = true;
    this.el(".bp-results").hidden = true;
    this.el(".bp-surrender").hidden = false;
    this.overlay(this.text.starting, this.text.controls);
    this.el<HTMLCanvasElement>(".bp-arena").focus();
  }

  private showResult(result: Result): void {
    if (this.bot) {
      this.send("botResult", { result });
      const opponent = this.players.get(this.opponent);
      if (opponent) {
        const stats = opponent.skill.split("/").map(Number);
        const index = result === "win" ? 1 : result === "loss" ? 0 : 2;
        stats[index] = (stats[index] ?? 0) + 1;
        opponent.skill = stats.join("/");
      }
    }
    this.screen = "result";
    this.keys = [];
    this.hideOverlay();
    this.root.dataset.screen = "result";
    this.el(".bp-results").hidden = false;
    this.el(".bp-surrender").hidden = true;
    const resultText = this.text[result];
    if (this.language === "de") {
      const image = new Image();
      image.src = assetUrl(`text-${result === "win" ? 437 : result === "loss" ? 438 : 436}.svg`);
      image.alt = resultText;
      this.el(".bp-result-text").replaceChildren(image);
    } else this.el(".bp-result-text").textContent = resultText;
    const self = this.players.get(this.name);
    if (self) {
      const stats = self.skill.split("/").map(Number);
      const index = result === "win" ? 0 : result === "loss" ? 1 : 2;
      stats[index] = (stats[index] ?? 0) + 1;
      self.skill = stats.join("/");
    }
    this.updateRematch();
  }

  private updateRematch(): void {
    const player = this.players.get(this.opponent);
    const departed = !player || (this.screen === "result" && !player.state.endsWith("3"));
    this.el<HTMLButtonElement>(".bp-rematch").disabled = departed || (this.rematchRequested && !this.rematchReceived);
    const status = this.el(".bp-rematch-status");
    status.textContent = departed ? this.text.opponentLeft(this.opponent) : this.rematchReceived
      ? this.text.opponentRematch(this.opponent) : this.rematchRequested
        ? this.text.waitingFor(this.opponent) : `${this.text.withOpponent}${this.opponent}`;
    if (!departed && !this.rematchReceived && !this.rematchRequested) {
      const prefix = document.createElement("b");
      prefix.textContent = this.text.withOpponent;
      status.replaceChildren(prefix, document.createTextNode(this.opponent));
    }
  }

  private toRoom(): void {
    this.send("toRoom");
    if (this.bot) {
      const opponent = this.players.get(this.opponent);
      if (opponent) opponent.state = "0";
      this.bot = null;
    }
    this.screen = "lobby";
    this.opponent = "";
    this.root.dataset.screen = "lobby";
    this.el(".bp-arena").hidden = true;
    this.keys = [];
    this.hideOverlay();
    this.el(".bp-lobby").hidden = false;
    this.el(".bp-results").hidden = true;
    this.el(".bp-chat-lines").replaceChildren();
    this.refreshLobby();
  }

  private chat(name: string, message: string): void {
    const log = this.el(".bp-chat-lines");
    const line = document.createElement("div"), who = document.createElement("b");
    who.textContent = `${name}: `;
    line.append(who, document.createTextNode(message));
    log.append(line);
    while (log.children.length > 500) log.firstElementChild?.remove();
    log.scrollTop = log.scrollHeight;
    if (name !== this.name) this.audio.play("message");
  }

  private overlay(title: string, message: string, buttons: [string, () => void][] = []): void {
    this.el(".bp-overlay").hidden = false;
    this.el(".bp-overlay-title").textContent = title;
    this.el(".bp-overlay-message").textContent = message;
    const actions = this.el(".bp-overlay-buttons");
    actions.replaceChildren();
    for (const [label, action] of buttons) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("aria-label", label);
      const originalButton = ({ [this.text.yes]: 417, [this.text.no]: 420, [this.text.closeChat]: 411 } as Record<string, number>)[label];
      if (originalButton) {
        button.className = "bp-image-button";
        button.append(this.buttonSprite(originalButton, label));
      } else {
        button.className = "bp-button";
        button.textContent = label;
      }
      button.addEventListener("click", action);
      actions.append(button);
    }
  }
  private hideOverlay(): void { this.el(".bp-overlay").hidden = true; }
  private resumeGame(): void {
    this.hideOverlay();
    this.el<HTMLCanvasElement>(".bp-arena").focus();
  }
  showError(message: string): void {
    this.failure = message;
    this.keys = [];
    this.engine.setCode("0000");
    this.overlay(this.text.connectionLost, message, [[this.text.reconnect, () => location.reload()]]);
  }

  private key(key: string, down: boolean): void {
    if (this.screen !== "game" || this.engine.phase !== "playing") return;
    if (down && !this.el(".bp-overlay").hidden) return;
    if (key === "Space") { if (down) this.engine.drop(); return; }
    this.keys = this.keys.filter(k => k !== key);
    if (down) this.keys.push(key);
    const active = this.keys[this.keys.length - 1];
    this.engine.setCode(["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].map(k => k === active ? "1" : "0").join(""));
  }

  private bindInputs(): void {
    const signal = this.input.signal;
    this.root.addEventListener("pointerdown", () => void this.audio.unlock().catch(() => {}), { signal });
    window.addEventListener("keydown", event => {
      if (!(event.target instanceof Node) || !this.root.contains(event.target)) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (!["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Space"].includes(event.code)) return;
      if (this.screen !== "game") return;
      event.preventDefault();
      void this.audio.unlock().catch(() => {});
      if (!event.repeat) this.key(event.code, true);
    }, { signal });
    window.addEventListener("keyup", event => this.key(event.code, false), { signal });
    const release = () => { this.keys = []; this.engine.setCode("0000"); };
    window.addEventListener("blur", release, { signal });
    document.addEventListener("visibilitychange", () => { if (document.hidden) release(); }, { signal });
    this.el(".bp-chat-input").addEventListener("focus", () => {
      release();
      if (this.screen === "game" && this.engine.phase === "playing") {
        this.overlay(this.text.chatting, "", [[this.text.closeChat, () => this.resumeGame()]]);
      }
    }, { signal });
    this.el(".bp-chat-form").addEventListener("submit", event => {
      event.preventDefault();
      const input = this.el<HTMLInputElement>(".bp-chat-input");
      const msg = input.value.trim();
      if (!msg || !this.connected) return;
      this.send(this.screen === "lobby" ? "msgAll" : "msgPlayer", { name: this.name, msg });
      if (!msg.startsWith("!")) this.chat(this.name, msg);
      input.value = "";
      if (this.screen === "game") this.resumeGame();
    }, { signal });
    this.el(".bp-challenge-all").addEventListener("click", () => {
      // ChallengeAllButton.onPress tests exactly state "1", not "13".
      // It also blocks retracting challenge-all while a request is pending.
      if ([...this.players.values()].some(player => player.state === "1")) {
        this.chat("Server", this.text.challengeBlocked);
        return;
      }
      this.challengeAll = !this.challengeAll;
      this.send(this.challengeAll ? "challengeAll" : "remChallengeAll");
      for (const player of this.players.values()) {
        if (isBotName(player.name)) continue;
        if (this.challengeAll) {
          if (player.state === "0") player.state = "2";
          else if (player.state === "3") player.state = "23";
        } else {
          if (player.state === "2") player.state = "0";
          else if (player.state === "23") player.state = "3";
        }
      }
      if (!this.challengeAll) this.challenged.clear();
      this.refreshLobby();
    }, { signal });
    this.el(".bp-rematch").addEventListener("click", () => {
      if (this.bot) this.send("startBot", { name: this.opponent });
      else if (this.rematchReceived) this.startMatch(this.opponent, 1);
      else { this.send("playAgain"); this.rematchRequested = true; this.updateRematch(); }
    }, { signal });
    this.el(".bp-to-room").addEventListener("click", () => this.toRoom(), { signal });
    this.el(".bp-surrender").addEventListener("click", () => {
      release();
      this.overlay(this.text.confirmSurrender, "", [[this.text.yes, () => this.send("surrender")], [this.text.no, () => this.resumeGame()]]);
    }, { signal });
    this.el(".bp-sound").addEventListener("click", () => {
      const enabled = this.audio.toggle();
      const button = this.el(".bp-sound");
      button.textContent = enabled ? "♫" : "♪̸";
      button.setAttribute("aria-label", enabled ? this.text.soundOff : this.text.soundOn);
      button.title = enabled ? this.text.soundOff : this.text.soundOn;
    }, { signal });
    this.root.querySelectorAll<HTMLButtonElement>("[data-key]").forEach(button => {
      button.addEventListener("pointerdown", event => {
        event.preventDefault(); button.setPointerCapture(event.pointerId); this.key(button.dataset.key!, true);
      }, { signal });
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) button.addEventListener(type, () => this.key(button.dataset.key!, false), { signal });
    });
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.ticker); clearInterval(this.heartbeat); cancelAnimationFrame(this.frame);
    this.input.abort(); this.resizeObserver.disconnect(); this.socket?.close(); this.audio.dispose();
  }
}
