import { buildXml, type XmlMessage } from "./game.ts";

// Port of the original MyMath, Grid, MyPlayer, Bomb, Bliz and Game rules.
// Positions on the wire are Flash stage coordinates, not canvas/grid coordinates.
export const COLS = 13;
export const ROWS = 11;
export const TILE = 40;
export const FUSE = 3500;
export const FLAME_TIME = 500;
export const enum Stone { Free, Wall, Box, BombUp, SpeedUp, FlameUp, Kick, Bomb }
export type Phase = "init" | "waiting" | "playing" | "over" | "finished";
export type Result = "win" | "loss" | "draw";
export interface Cell { type: Stone; open: boolean }
export interface Penguin {
  nr: number;
  x: number;
  y: number;
  code: string;
  speed: number;
  capacity: number;
  range: number;
  kick: boolean;
  bombs: number;
  alive: boolean;
  facing: number;
  animation: string;
  animationTime: number;
  ping: number;
  fps: number;
}
export interface Bomb {
  col: number;
  row: number;
  x: number;
  y: number;
  player: Penguin;
  placed: number;
  expires: number;
  exploded: boolean;
  moving: boolean;
  dx: number;
  dy: number;
  id: number | null;
  kickedBy: Penguin | null;
  remoteKicked: boolean;
  underneath: Cell;
}
export interface Flame {
  col: number;
  row: number;
  player: Penguin;
  center: boolean;
  horizontal: boolean;
  created: number;
}

export class FlashRandom {
  constructor(public seed: number) {}
  random(): number {
    this.seed = (1291 * this.seed + 4621) % 21870;
    return this.seed / 21870;
  }
  integer(max: number): number { return Math.floor(this.random() * (max + 1)); }
}

export function makeGrid(seed: number): Cell[][] {
  const random = new FlashRandom(seed);
  const grid = Array.from({ length: ROWS }, (_, row) =>
    Array.from({ length: COLS }, (_, col): Cell => ({
      type: row % 2 === 1 && col % 2 === 1 ? Stone.Wall : Stone.Free,
      open: false,
    })),
  );
  const banned = new Set(["0:0", "1:0", "2:0", "0:1", "0:2", "12:8", "12:9", "10:10", "11:10", "12:10"]);
  let count = 0;
  while (count < 65) {
    const col = random.integer(12), row = random.integer(10);
    const cell = grid[row]![col]!;
    if (cell.type !== Stone.Free || banned.has(`${col}:${row}`)) continue;
    cell.type = count < 10 ? Stone.BombUp : count < 16 ? Stone.SpeedUp
      : count < 22 ? Stone.FlameUp : count < 28 ? Stone.Kick : Stone.Box;
    count++;
  }
  return grid;
}

const free = (): Cell => ({ type: Stone.Free, open: false });
const actor = (nr: number): Penguin => ({
  nr, x: nr === 1 ? 120 : 600, y: nr === 1 ? 40 : 440,
  code: "0000", speed: 0.15, capacity: 1, range: 2, kick: false,
  bombs: 0, alive: true, facing: nr === 1 ? 1 : -1,
  animation: "stand", animationTime: 0, ping: 100, fps: 40,
});
export const playerCol = (x: number) => Math.floor((x - 100) / TILE);
export const playerRow = (y: number) => Math.floor((y - 20) / TILE);
// Grid.xToArrayPos intentionally assigns its first boundary to the first tile.
const bombCell = (value: number) => value <= 40 ? 0 : Math.floor(value / TILE);

export class BomberpenguEngine {
  grid: Cell[][] = [];
  players: [Penguin, Penguin] = [actor(1), actor(2)];
  bombs: Bomb[] = [];
  flames: Flame[] = [];
  phase: Phase = "init";
  result: Result | null = null;
  time = 0;
  frames = 0;
  localNr = 1;
  nextId = 5000;
  oldCode = "0000";
  overAt = 0;
  pingAt = 0;
  lastPing = -9000;
  private priority = false;
  private locked = false;
  localOpponent = false;
  recoveringBot = false;
  private freestyle = false;
  private seedSource: () => number;

  constructor(
    private send: (xml: string) => void,
    private sound: (name: string) => void = () => {},
    private finished: (result: Result) => void = () => {},
    seedSource = () => Math.floor(Math.random() * 20001),
  ) { this.seedSource = seedSource; }

  get local(): Penguin { return this.players[this.localNr - 1]!; }
  get remote(): Penguin { return this.players[2 - this.localNr]!; }

  start(nr: number): void {
    this.localOpponent = this.freestyle = this.recoveringBot = false;
    this.localNr = nr;
    this.players = [actor(1), actor(2)];
    this.grid = [];
    this.bombs = [];
    this.flames = [];
    this.phase = "init";
    this.result = null;
    this.time = this.frames = this.overAt = 0;
    this.lastPing = -9000;
    this.oldCode = "0000";
    this.locked = false;
    this.nextId = nr === 1 ? 5000 : 10000;
  }

  startBot(freestyle = false): void {
    this.start(2);
    this.localOpponent = true;
    this.freestyle = freestyle;
  }

  seed(seed: number): void {
    this.grid = makeGrid(seed);
    this.bombs = [];
    this.flames = [];
    for (const p of this.players) {
      p.x = p.nr === 1 ? 120 : 600;
      p.y = p.nr === 1 ? 40 : 440;
      p.bombs = 0;
    }
    this.phase = "playing";
    if (this.freestyle) {
      // One tile left of player one's spawn, inside the permanent arena border.
      this.remote.x = 80;
      for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++) {
        const cell = this.cell(col, row);
        if (cell.type < Stone.Box || cell.type > Stone.Kick) continue;
        this.flames.push({ col, row, player: this.remote, center: true, horizontal: false, created: this.time });
        if (cell.type === Stone.Box) this.put(col, row, free());
        else cell.open = true;
      }
      this.sound("explode");
    }
  }

  setCode(code: string, player = this.local): void {
    if (!/^[01]{4}$/.test(code)) return;
    player.code = code;
    if (code[0] === "1") player.facing = -1;
    if (code[2] === "1") player.facing = 1;
    const animation = code[1] === "1" ? "up" : code[3] === "1" ? "down"
      : code[0] === "1" || code[2] === "1" ? "go" : "stand";
    if (animation !== player.animation) {
      player.animation = animation;
      player.animationTime = this.time;
    }
  }

  cell(col: number, row: number): Cell {
    return this.grid[row]?.[col] ?? { type: Stone.Wall, open: false };
  }
  private put(col: number, row: number, cell: Cell): void {
    if (col >= 0 && col < COLS && row >= 0 && row < ROWS) this.grid[row]![col] = cell;
  }
  private enter(cell: Cell): boolean {
    return cell.type === Stone.Free || (cell.open && cell.type >= Stone.BombUp && cell.type <= Stone.Kick);
  }
  private action(tag: string, attrs: Record<string, string | number> = {}): void {
    if (!this.localOpponent) this.send(buildXml(tag, {
      c: this.local.code, x: Math.round(this.local.x), y: Math.round(this.local.y), ...attrs,
    }));
    this.oldCode = this.local.code;
    this.priority = true;
  }

  tick(dt: number): void {
    this.time += dt;
    this.frames++;
    this.priority = false;
    if (this.phase === "init" && this.frames >= 20) {
      if (this.localNr === 1 || this.localOpponent) {
        const seed = this.seedSource();
        if (!this.localOpponent) this.send(buildXml("16", { s: seed }));
        this.seed(seed);
      } else this.phase = "waiting";
    }
    if (this.phase === "playing") {
      this.updatePlayer(this.local, dt);
      this.updatePlayer(this.remote, dt);
      if (!this.priority && this.local.code !== this.oldCode) this.action("12");
      else if (!this.localOpponent && !this.priority && this.time - this.lastPing >= 10000) {
        this.lastPing = this.pingAt = this.time;
        this.send(buildXml("ping"));
      }
    }
    if (this.phase === "playing" || this.phase === "over") {
      // MovieClip bomb/explosion timelines keep running during the death delay.
      for (const bomb of [...this.bombs]) {
        if (bomb.exploded) continue;
        if (this.time > bomb.expires && !bomb.remoteKicked) this.explode(bomb);
        if (bomb.moving && !bomb.exploded) this.moveBomb(bomb, dt);
      }
      this.bombs = this.bombs.filter(b => !b.exploded);
      this.flames = this.flames.filter(f => this.time - f.created <= FLAME_TIME);
      if (this.phase === "over" && this.time - this.overAt > 3000) {
        if (this.result === "win" && !this.localOpponent) this.send(buildXml("winGame"));
        this.finish(this.result ?? "loss");
      }
    }
  }

  private updatePlayer(p: Penguin, dt: number): void {
    if (!p.alive) return;
    const col = playerCol(p.x), row = playerRow(p.y);
    if (p === this.local || this.localOpponent) {
      const cell = this.cell(col, row);
      if (cell.open && cell.type >= Stone.BombUp && cell.type <= Stone.Kick) {
        if (cell.type === Stone.BombUp) p.capacity++;
        if (cell.type === Stone.SpeedUp) p.speed = Math.min(0.18, p.speed + 0.01);
        if (cell.type === Stone.FlameUp) p.range++;
        if (cell.type === Stone.Kick) p.kick = true;
        if (p === this.local) this.action("18", { xp: col, yp: row, s: p.speed, b: p.range });
        this.put(col, row, free());
        this.sound("pickup");
      }
    }
    const dx = p.code[2] === "1" ? 1 : p.code[0] === "1" ? -1 : 0;
    const dy = p.code[1] === "1" ? -1 : p.code[3] === "1" ? 1 : 0;
    if (dx) this.movePlayer(p, dx, 0, dt);
    if (dy) this.movePlayer(p, 0, dy, dt);
  }

  private movePlayer(p: Penguin, dx: number, dy: number, dt: number): void {
    const col = playerCol(p.x + dx * 21), row = playerRow(p.y + dy * 21);
    const cell = this.cell(col, row);
    const escapingWall = this.localOpponent && p === this.remote && this.recoveringBot && !this.freestyle;
    if (this.enter(cell) || (escapingWall && cell.type !== Stone.Bomb)) {
      if ((p === this.local || this.localOpponent) && this.flames.some(f =>
        f.col === playerCol(p.x + dx * 18) && f.row === playerRow(p.y + dy * 18))) this.die(p);
      let distance = Math.min(20, p.speed * dt);
      const cross = dx ? p.y : p.x;
      const mod = cross % TILE;
      const correction = mod < 20 ? -mod : TILE - mod;
      const step = Math.sign(correction) * Math.min(Math.abs(correction), distance);
      if (dx) p.y += step;
      else p.x += step;
      distance -= Math.abs(step);
      // The original downward branch recomputes dy after lane correction.
      if (dy > 0) distance = Math.min(20, p.speed * dt);
      // Outside-wall recovery must walk back in, rather than snapping across
      // the arena boundary. Normal movement still uses the original bounds.
      p.x = Math.max(escapingWall ? Math.min(120, p.x) : 120,
        Math.min(escapingWall ? Math.max(600, p.x) : 600, p.x + dx * distance));
      p.y = Math.max(escapingWall ? Math.min(40, p.y) : 40,
        Math.min(escapingWall ? Math.max(440, p.y) : 440, p.y + dy * distance));
    } else {
      if (dx) p.x = Math.floor((p.x + 20) / TILE) * TILE;
      else p.y = Math.floor((p.y + 20) / TILE) * TILE;
      if ((p === this.local || this.localOpponent) && cell.type === Stone.Bomb && p.kick && this.cell(playerCol(p.x), playerRow(p.y)).type !== Stone.Bomb) {
        const bomb = this.bombs.find(b => !b.exploded && b.col === col && b.row === row);
        if (bomb) this.kick(bomb, dx * 0.1, dy * 0.1, p);
      }
    }
  }

  drop(p = this.local): void {
    if (this.phase !== "playing") return;
    if (!p.alive || (p !== this.local && !this.localOpponent)) return;
    const col = playerCol(p.x), row = playerRow(p.y);
    if (this.cell(col, row).type !== Stone.Free || p.bombs >= p.capacity) return;
    this.placeBomb(col, row, p);
    if (p === this.local) this.action("17", { xp: col, yp: row });
  }

  placeBomb(col: number, row: number, player: Penguin): Bomb | null {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS || !this.grid.length) return null;
    if (this.cell(col, row).type === Stone.Bomb) return null;
    const bomb: Bomb = {
      col, row, x: col * TILE + 20, y: row * TILE + 20,
      player, placed: this.time, expires: this.time + FUSE, exploded: false,
      moving: false, dx: 0, dy: 0, id: null, kickedBy: null, remoteKicked: false,
      underneath: free(),
    };
    this.put(col, row, { type: Stone.Bomb, open: false });
    this.bombs.push(bomb);
    player.bombs++;
    this.sound("drop");
    return bomb;
  }

  private kick(bomb: Bomb, dx: number, dy: number, player = this.local): void {
    if (bomb.kickedBy === player || (dx < 0 && bomb.col === 0) || (dx > 0 && bomb.col === 12)
      || (dy < 0 && bomb.row === 0) || (dy > 0 && bomb.row === 10)) return;
    bomb.kickedBy = player;
    bomb.remoteKicked = false;
    bomb.moving = true;
    bomb.dx = dx;
    bomb.dy = dy;
    bomb.id ??= this.nextId++;
    this.action("19", { xp: bomb.col, yp: bomb.row, i: bomb.id, dx, dy, t: bomb.expires - this.time });
    this.sound("kick");
  }

  private relocate(bomb: Bomb, col: number, row: number): void {
    if (col === bomb.col && row === bomb.row) return;
    this.put(bomb.col, bomb.row, bomb.underneath);
    bomb.underneath = this.cell(col, row);
    bomb.col = col;
    bomb.row = row;
    this.put(col, row, { type: Stone.Bomb, open: false });
  }

  private moveBomb(bomb: Bomb, dt: number): void {
    bomb.x = Math.max(20, Math.min(500, bomb.x + bomb.dx * dt));
    bomb.y = Math.max(20, Math.min(420, bomb.y + bomb.dy * dt));
    const ox = Math.sign(bomb.dx) * 20, oy = Math.sign(bomb.dy) * 20;
    for (const player of this.localOpponent ? this.players : [this.local]) {
      if (bomb.kickedBy === player || !player.alive
        || Math.abs(player.x - (bomb.x + ox + 100)) >= 17
        || Math.abs(player.y - (bomb.y + oy + 20)) >= 18) continue;
      bomb.x = bomb.col * TILE + 20;
      bomb.y = bomb.row * TILE + 20;
      player.x = bomb.x + ox * 2 + 100;
      player.y = bomb.y + oy * 2 + 20;
      bomb.moving = false;
      bomb.remoteKicked = false;
      this.action("11", { i: bomb.id!, xp: bomb.col, yp: bomb.row, t: bomb.expires - this.time });
      return;
    }
    const col = bombCell(bomb.x + ox), row = bombCell(bomb.y + oy);
    if ((col !== bomb.col || row !== bomb.row) && !this.enter(this.cell(col, row))) {
      bomb.moving = false;
      bomb.x = bomb.col * TILE + 20;
      bomb.y = bomb.row * TILE + 20;
      return;
    }
    this.relocate(bomb, col, row);
  }

  explode(bomb: Bomb): void {
    if (bomb.exploded) return;
    bomb.exploded = true; // before recursion: chain reactions can revisit this bomb
    bomb.moving = false;
    if (bomb.kickedBy && !bomb.remoteKicked) this.action("10", { i: bomb.id!, xp: bomb.col, yp: bomb.row });
    this.put(bomb.col, bomb.row, free());
    this.flame(bomb.col, bomb.row, bomb.player, true, false);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let i = 1; i <= bomb.player.range; i++) {
        const col = bomb.col + dx! * i, row = bomb.row + dy! * i;
        const cell = this.cell(col, row);
        if (cell.type === Stone.Wall) break;
        if (cell.type === Stone.Bomb) {
          const next = this.bombs.find(b => !b.exploded && b.col === col && b.row === row);
          if (next) this.explode(next);
          break;
        }
        this.flame(col, row, bomb.player, false, dx !== 0);
        if (cell.type === Stone.Box) { this.put(col, row, free()); break; }
        if (cell.type >= Stone.BombUp && cell.type <= Stone.Kick) {
          if (cell.open) this.put(col, row, free());
          else cell.open = true;
          break;
        }
      }
    }
    bomb.player.bombs = Math.max(0, bomb.player.bombs - 1);
    this.sound("explode");
  }

  private flame(col: number, row: number, player: Penguin, center: boolean, horizontal: boolean): void {
    this.flames = this.flames.filter(f => f.col !== col || f.row !== row);
    this.flames.push({ col, row, player, center, horizontal, created: this.time });
    if (playerCol(this.local.x) === col && playerRow(this.local.y) === row) this.die();
    if (this.localOpponent && playerCol(this.remote.x) === col && playerRow(this.remote.y) === row) this.die(this.remote);
  }

  die(player = this.local): void {
    if (this.localOpponent) {
      if (!player.alive || this.phase === "finished") return;
      // Resolve simultaneous blasts in the death tick. Later explosions during
      // the frozen result animation must not turn a completed victory into a draw.
      if (this.phase === "over" && this.time > this.overAt) return;
      this.markDead(player);
      if (this.phase !== "over") this.overAt = this.time;
      this.phase = "over";
      this.result = !this.local.alive && !this.remote.alive ? "draw" : this.local.alive ? "win" : "loss";
      this.local.code = this.remote.code = "0000";
      return;
    }
    if (this.locked || !this.local.alive) return;
    this.action("die");
    this.markDead(this.local);
    this.phase = "over";
    this.result = "loss";
    this.overAt = this.time;
    this.locked = true;
  }

  private markDead(player: Penguin): void {
    if (player.alive) player.animationTime = this.time;
    player.alive = false;
  }

  finish(result: Result): void {
    if (this.phase === "finished") return;
    this.phase = "finished";
    this.result = result;
    this.local.code = this.remote.code = "0000";
    this.finished(result);
  }

  receive({ tag, attrs: a }: XmlMessage): void {
    const col = Number(a.xp), row = Number(a.yp);
    const p = this.remote;
    switch (tag) {
      case "16": this.seed(Number(a.s)); return;
      case "17": this.placeBomb(col, row, p); break;
      case "18":
        p.speed = Number(a.s); p.range = Number(a.b);
        this.put(col, row, free());
        break;
      case "19": {
        const b = this.bombs.find(b => !b.exploded && b.col === col && b.row === row);
        if (b) {
          b.id = Number(a.i); b.kickedBy = p; b.remoteKicked = true;
          b.dx = Number(a.dx); b.dy = Number(a.dy); b.moving = true;
          b.expires = this.time + Number(a.t);
          this.sound("kick");
        }
        break;
      }
      case "11": case "10": {
        const b = this.bombs.find(b => !b.exploded && b.id === Number(a.i));
        if (b) {
          this.relocate(b, col, row);
          b.x = col * TILE + 20; b.y = row * TILE + 20;
          b.moving = false; b.remoteKicked = true;
          if (tag === "11") b.expires = this.time + Number(a.t);
          else this.explode(b);
        }
        break;
      }
      case "die":
        p.x = Number(a.x); p.y = Number(a.y);
        this.markDead(p);
        if (this.phase !== "finished") {
          if (this.phase !== "over") this.overAt = this.time;
          this.phase = "over";
          if (this.result !== "draw") this.result = "win";
          this.locked = true;
        }
        return;
      case "draw":
        this.result = "draw";
        this.markDead(this.local);
        this.markDead(p);
        if (this.phase !== "over") this.overAt = this.time;
        this.phase = "over";
        this.locked = true;
        return;
      case "14": p.ping = Number(a.p); p.fps = Number(a.f); return;
      case "pong":
        this.local.ping = Math.round(this.time - this.pingAt);
        this.local.fps = Math.round(this.frames / Math.max(0.001, this.time / 1000));
        this.send(buildXml("14", { p: this.local.ping, f: this.local.fps }));
        return;
    }
    if (["12", "17", "18", "19", "11", "10"].includes(tag)) {
      // The freestyle command deliberately uses x=y=0 in the original protocol.
      if (Number(a.x) >= 100 && Number(a.y) >= 20) {
        p.x = Number(a.x); p.y = Number(a.y);
        this.setCode(a.c ?? "0000", p);
      }
    }
  }
}
