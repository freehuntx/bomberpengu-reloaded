import { COLS, ROWS, TILE, FUSE, FLAME_TIME, Stone, playerCol, playerRow, type BomberpenguEngine, type Penguin } from "./engine.ts";
import type { BotLevel } from "./bot-types.ts";

interface Point { col: number; row: number }
interface Route extends Point { first: Point | null; steps: number; arrival: number }
interface Hazard { start: number; end: number }
const directions = [[-1, 0], [0, -1], [1, 0], [0, 1]] as const;
const key = (col: number, row: number) => row * COLS + col;
const item = (cell: { type: Stone; open: boolean }) => cell.open && cell.type >= Stone.BombUp && cell.type <= Stone.Kick;
const walkable = (cell: { type: Stone; open: boolean }) => cell.type === Stone.Free || item(cell);
const botAt = (bot: Penguin, point: Point): Penguin => ({ ...bot, x: 120 + point.col * TILE, y: 40 + point.row * TILE });
const settings = {
  easy: { reaction: 450, margin: 30, cooldown: 2400, bombChance: 0.45, loot: 3, attack: 1 },
  medium: { reaction: 180, margin: 100, cooldown: 1100, bombChance: 0.85, loot: 6, attack: 4 },
  hard: { reaction: 50, margin: 180, cooldown: 350, bombChance: 1, loot: 8, attack: 9 },
};

/** Forecast actual blast blocking, destruction, kicked bombs, and chain reactions. */
function hazards(game: BomberpenguEngine, proposed?: Point, destroyedItems?: Map<number, number>): Map<number, Hazard[]> {
  const danger = new Map<number, Hazard[]>();
  const add = (col: number, row: number, start: number, end: number) => {
    const id = key(col, row);
    const list = danger.get(id) ?? [];
    list.push({ start, end });
    danger.set(id, list);
  };
  for (const flame of game.flames) add(flame.col, flame.row, 0, FLAME_TIME - (game.time - flame.created));
  const grid = game.grid.map(row => row.map(cell => ({ ...cell })));
  const bombs = game.bombs.filter(b => !b.exploded).map(b => {
    let col = b.col, row = b.row;
    const at = Math.max(0, b.expires - game.time);
    if (b.moving) {
      const dx = Math.sign(b.dx), dy = Math.sign(b.dy);
      const distance = Math.floor(at * Math.max(Math.abs(b.dx), Math.abs(b.dy)) / TILE);
      for (let i = 0; i < distance; i++) {
        const next = game.cell(col + dx, row + dy);
        if (next.type !== Stone.Free && !(next.open && next.type >= Stone.BombUp && next.type <= Stone.Kick)) break;
        col += dx; row += dy;
      }
      grid[b.row]![b.col] = { ...b.underneath };
      grid[row]![col] = { type: Stone.Bomb, open: false };
      // A player can stop a rolling bomb earlier: cover each possible stop tile.
      let c = b.col, r = b.row;
      while (c !== col || r !== row) {
        for (const point of blast(game, c, r, b.player.range)) add(point.col, point.row, at, at + FLAME_TIME);
        c += dx; r += dy;
      }
    }
    return { col, row, at, range: b.player.range, done: false };
  });
  if (proposed) {
    bombs.push({ ...proposed, at: FUSE, range: game.remote.range, done: false });
    grid[proposed.row]![proposed.col] = { type: Stone.Bomb, open: false };
  }
  const detonate = (bomb: typeof bombs[number], at: number) => {
    if (bomb.done) return;
    bomb.done = true;
    grid[bomb.row]![bomb.col] = { type: Stone.Free, open: false };
    add(bomb.col, bomb.row, at, at + FLAME_TIME);
    for (const [dx, dy] of directions) for (let i = 1; i <= bomb.range; i++) {
      const col = bomb.col + dx * i, row = bomb.row + dy * i;
      const cell = grid[row]?.[col];
      if (!cell || cell.type === Stone.Wall) break;
      if (cell.type === Stone.Bomb) {
        const next = bombs.find(b => !b.done && b.col === col && b.row === row);
        if (next) detonate(next, at);
        break;
      }
      add(col, row, at, at + FLAME_TIME);
      if (cell.type === Stone.Box) { cell.type = Stone.Free; break; }
      if (cell.type >= Stone.BombUp && cell.type <= Stone.Kick) {
        // Exposed loot can be picked up before detonation. Never rely on it
        // to shield an escape route (especially a dead-end containing loot).
        if (cell.open) {
          destroyedItems?.set(key(col, row), at);
          cell.type = Stone.Free;
          // Item preservation needs exact blocking; escape planning stays
          // conservative because a penguin may collect the blocker first.
          if (destroyedItems) break;
          continue;
        }
        cell.open = true;
        break;
      }
    }
  };
  for (const bomb of bombs.sort((a, b) => a.at - b.at)) detonate(bomb, bomb.at);
  return danger;
}

function blast(game: BomberpenguEngine, col: number, row: number, range: number): Point[] {
  const points: Point[] = [{ col, row }];
  for (const [dx, dy] of directions) for (let i = 1; i <= range; i++) {
    const c = col + dx * i, r = row + dy * i, cell = game.cell(c, r);
    if (cell.type === Stone.Wall) break;
    points.push({ col: c, row: r });
    if (cell.type !== Stone.Free) break;
  }
  return points;
}

/** Time-expanded search allows waiting for flames, but never crossing a live blast. */
function routes(game: BomberpenguEngine, player: Penguin, danger: Map<number, Hazard[]>, margin: number, proposed?: Point): Route[] {
  const step = TILE / player.speed + 50;
  const horizon = FUSE + FLAME_TIME + step;
  const safe = (col: number, row: number, from: number, until: number) =>
    !(danger.get(key(col, row)) ?? []).some(h => from <= h.end + margin && until >= h.start - margin);
  const start: Route = { col: playerCol(player.x), row: playerRow(player.y), steps: 0, arrival: 0, first: null };
  const queue: Route[] = [start], found = new Map<number, Route>();
  const visited = new Set<string>([`${key(start.col, start.row)}:0`]);
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]!;
    if (safe(node.col, node.row, node.arrival, horizon) && !found.has(key(node.col, node.row))) found.set(key(node.col, node.row), node);
    if (node.arrival + step > horizon) continue;
    for (const [dx, dy] of [...directions, [0, 0] as const]) {
      const col = node.col + dx, row = node.row + dy;
      if (col < 0 || row < 0 || col >= COLS || row >= ROWS) continue;
      const cell = game.cell(col, row);
      const waiting = dx === 0 && dy === 0;
      if (!waiting && (cell.type !== Stone.Free && !(cell.open && cell.type >= Stone.BombUp && cell.type <= Stone.Kick))) continue;
      if (!waiting && proposed?.col === col && proposed.row === row) continue;
      const arrival = node.arrival + step;
      if (!safe(node.col, node.row, node.arrival, arrival) || !safe(col, row, node.arrival, arrival + 100)) continue;
      const id = `${key(col, row)}:${node.steps + 1}`;
      if (visited.has(id)) continue;
      visited.add(id);
      queue.push({ col, row, steps: node.steps + 1, arrival,
        first: node.steps === 0 ? { col, row } : node.first });
    }
  }
  return [...found.values()];
}

/** Find an exit even from connected wall tiles or just outside the arena. */
function wallExit(game: BomberpenguEngine, danger: Map<number, Hazard[]>): Point | null {
  const bot = game.remote;
  const start = { col: playerCol(bot.x), row: playerRow(bot.y) };
  const queue: Route[] = [{ ...start, first: null, steps: 0, arrival: 0 }];
  const visited = new Set<string>([`${start.col}:${start.row}`]);
  let fallback: Point | null = null;
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]!;
    if (node.first && walkable(game.cell(node.col, node.row))) {
      const blasts = danger.get(key(node.col, node.row)) ?? [];
      if (!blasts.some(h => h.start <= node.arrival + 100 && h.end >= node.arrival)) {
        if (!blasts.length) return node.first;
        fallback ??= node.first;
      }
      continue;
    }
    for (const [dx, dy] of directions) {
      const col = node.col + dx, row = node.row + dy;
      if (col < Math.min(0, start.col) || col > Math.max(COLS - 1, start.col)
        || row < Math.min(0, start.row) || row > Math.max(ROWS - 1, start.row)) continue;
      const id = `${col}:${row}`, cell = game.cell(col, row);
      if (visited.has(id) || cell.type === Stone.Bomb) continue;
      visited.add(id);
      queue.push({ col, row, steps: node.steps + 1, arrival: (node.steps + 1) * (TILE / bot.speed + 50),
        first: node.first ?? { col, row } });
    }
  }
  return fallback;
}

export class BotController {
  private target: Point | null = null;
  private thinkAt = 0;
  private bombAt = -FUSE;
  private lastPosition = -1;
  private visits = new Map<number, number>();
  private unsafeBombPositions = new Set<number>();
  private mapVersion = "";
  private recovering = false;

  constructor(private game: BomberpenguEngine, readonly level: BotLevel, private random = Math.random) {}

  tick(dt: number): void {
    const game = this.game, bot = game.remote;
    if (this.level === "freestyle" || game.phase !== "playing" || !bot.alive) {
      game.recoveringBot = false;
      game.setCode("0000", bot);
      return;
    }
    if (game.cell(playerCol(bot.x), playerRow(bot.y)).type === Stone.Wall && !this.recovering) {
      this.recovering = true;
      game.recoveringBot = true;
      this.target = null;
      this.thinkAt = game.time;
    }
    if (this.recovering && !this.target) this.target = wallExit(game, hazards(game));
    if (this.target) {
      const cell = game.cell(this.target.col, this.target.row);
      if (!walkable(cell) && !(this.recovering && cell.type !== Stone.Bomb)) {
        // A human may place a bomb in the chosen lane between decisions.
        // Return to the current tile center and find a fresh route.
        this.target = { col: playerCol(bot.x), row: playerRow(bot.y) };
        this.thinkAt = game.time;
      }
      const x = 120 + this.target.col * TILE, y = 40 + this.target.row * TILE;
      const dx = x - bot.x, dy = y - bot.y;
      if (Math.abs(dx) + Math.abs(dy) <= bot.speed * dt + 0.5) {
        bot.x = x; bot.y = y;
        this.target = null;
        if (walkable(game.cell(playerCol(x), playerRow(y)))) this.recovering = game.recoveringBot = false;
        game.setCode("0000", bot);
        return;
      }
      game.setCode(Math.abs(dx) > Math.abs(dy) ? dx < 0 ? "1000" : "0010" : dy < 0 ? "0100" : "0001", bot);
      return;
    }
    game.setCode("0000", bot);
    if (this.recovering) return;
    if (game.time < this.thinkAt) return;
    const config = settings[this.level];
    this.thinkAt = game.time + config.reaction;
    const col = playerCol(bot.x), row = playerRow(bot.y), position = key(col, row);
    const version = `${bot.range}:${game.grid.flat().map(c => `${c.type}${c.open ? "o" : ""}`).join(",")}`;
    if (version !== this.mapVersion) {
      this.mapVersion = version;
      this.unsafeBombPositions.clear();
    }
    if (position !== this.lastPosition) {
      this.visits.set(position, (this.visits.get(position) ?? 0) + 1);
      this.lastPosition = position;
    }
    const danger = hazards(game);
    const choices = routes(game, bot, danger, config.margin);
    const threatened = (danger.get(position) ?? []).length > 0;
    if (!threatened) {
      const loot = choices.filter(route => item(game.cell(route.col, route.row))).sort((a, b) => a.steps - b.steps);
      if (loot.length) {
        this.target = loot[0]!.first;
        return;
      }
    }
    const utility = (point: Point, placement = false) => {
      if (this.unsafeBombPositions.has(key(point.col, point.row))) return 0;
      const hits = blast(game, point.col, point.row, bot.range);
      const boxes = hits.filter(p => { const c = game.cell(p.col, p.row); return c.type === Stone.Box || (!c.open && c.type >= Stone.BombUp && c.type <= Stone.Kick); }).length;
      const enemyHit = hits.some(p => p.col === playerCol(game.local.x) && p.row === playerRow(game.local.y));
      if (placement && !boxes && !enemyHit) return 0;
      const enemyExits = directions.map(([dx, dy]) => ({ col: playerCol(game.local.x) + dx, row: playerRow(game.local.y) + dy }))
        .filter(p => { const c = game.cell(p.col, p.row); return c.type === Stone.Free || c.open; });
      const exitsCovered = enemyExits.filter(p => hits.some(h => h.col === p.col && h.row === p.row)).length;
      return boxes * 2.5 + (enemyHit ? config.attack : 0)
        + (this.level === "hard" ? exitsCovered * 2 + (enemyHit && enemyExits.length <= 1 ? 6 : 0) : 0);
    };
    if (!threatened && game.cell(col, row).type === Stone.Free && bot.bombs < bot.capacity
      && game.time - this.bombAt >= config.cooldown && utility({ col, row }, true) > 0 && this.random() < config.bombChance) {
      const proposed = { col, row };
      const forecast = hazards(game, proposed);
      const escapes = routes(game, bot, forecast, config.margin, proposed).filter(r => r.first && (r.col !== col || r.row !== row));
      if (escapes.length) {
        const alreadyLost = new Map<number, number>();
        hazards(game, undefined, alreadyLost);
        const destroysItem = (point: Point) => {
          const lost = new Map<number, number>();
          hazards(game, point, lost);
          return [...lost].some(([id, at]) => at < (alreadyLost.get(id) ?? Infinity));
        };
        if (destroysItem(proposed)) {
          const alternative = choices.filter(route => route.first && (route.col !== col || route.row !== row)
            && game.cell(route.col, route.row).type === Stone.Free && utility(route, true) > 0)
            .sort((a, b) => a.steps - b.steps)
            .find(route => !destroysItem(route) && routes(game, botAt(bot, route), hazards(game, route), config.margin, route)
              .some(escape => escape.first && (escape.col !== route.col || escape.row !== route.row)));
          if (alternative) {
            this.target = alternative.first;
            return;
          }
          // No collectible loot or productive item-preserving placement is
          // reachable. Destruction is a last resort, still requiring an escape.
        }
        game.drop(bot);
        this.bombAt = game.time;
        escapes.sort((a, b) => a.steps - b.steps);
        this.target = escapes[0]!.first;
        return;
      }
      // Don't camp at an attractive dead end where bombing is suicidal.
      this.unsafeBombPositions.add(position);
    }
    let best: Route | null = null, bestScore = -Infinity;
    for (const route of choices) {
      const cell = game.cell(route.col, route.row);
      const loot = cell.open && cell.type >= Stone.BombUp && cell.type <= Stone.Kick
        ? cell.type === Stone.Kick && bot.kick ? 0 : config.loot : 0;
      const distance = Math.abs(route.col - playerCol(game.local.x)) + Math.abs(route.row - playerRow(game.local.y));
      const score = threatened ? -route.steps : loot + utility(route) - route.steps * 0.65
        - distance * (this.level === "hard" ? 0.6 : 0.06)
        - (this.visits.get(key(route.col, route.row)) ?? 0) * 0.35 + this.random() * (this.level === "easy" ? 3 : 0.25);
      if (score > bestScore) { best = route; bestScore = score; }
    }
    this.target = best?.first ?? null;
  }
}
