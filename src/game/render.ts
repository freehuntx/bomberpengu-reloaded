import spriteText from "./assets/sprites.json?raw";
import vectorText from "./assets/vectors.json?raw";
import { BomberpenguEngine, Stone, type Penguin } from "./engine.ts";
import { penguinFrame } from "./animation.ts";

export const assets = import.meta.glob<string>([
  "./assets/sprites.png", "./assets/bitmap-{1,5,6,7}.png",
  "./assets/shape-*.svg", "./assets/text-*.svg", "./assets/vector-*.svg", "./assets/button-bg-*.svg", "./assets/sound-{16,17,20,21,22,23}.wav",
], {
  eager: true, query: "?url", import: "default",
});
export const assetUrl = (name: string): string => assets[`./assets/${name}`]!;
// Source rectangle is in the 2x atlas; offset and destination size use stage units.
type Sprite = [number, number, number, number, number, number, number, number];
const sprites: Record<string, Sprite> = JSON.parse(spriteText);
const vectors: Record<string, [number, number, number, number]> = JSON.parse(vectorText);
const atlasHeight = Math.max(...Object.values(sprites).map(([, y, , height]) => y + height));

export function spriteElement(id: number, frame = 1, label?: string): HTMLSpanElement {
  const key = `${id}/${frame}`;
  const vector = vectors[key];
  const el = document.createElement("span");
  el.className = "bp-sprite";
  if (vector) {
    const [width, height] = vector;
    const image = label === undefined ? `vector-${id}-${frame}.svg` : `button-bg-${id}-${frame}.svg`;
    el.style.cssText = `width:${width}px;height:${height}px;background-image:url("${assetUrl(image)}");background-size:100% 100%`;
    if (label !== undefined) {
      const text = document.createElement("span");
      text.className = "bp-sprite-label";
      text.textContent = id === 429 ? label : label.toLowerCase();
      if (id === 429) el.classList.add("bp-sprite--plain");
      el.append(text);
    }
  } else {
    const [x, y, , , , , width, height] = sprites[key]!;
    el.style.cssText = `width:${width}px;height:${height}px;background-image:url("${assetUrl("sprites.png")}");background-size:1024px ${atlasHeight / 2}px;background-position:-${x / 2}px -${y / 2}px`;
  }
  el.setAttribute("aria-hidden", "true");
  return el;
}

export class BomberpenguRenderer {
  private images = new Map<string, HTMLImageElement>();
  private ctx: CanvasRenderingContext2D;
  private displayScale = 1;
  private ready = false;
  constructor(private canvas: HTMLCanvasElement, private engine: BomberpenguEngine) {
    this.ctx = canvas.getContext("2d")!;
    this.ctx.imageSmoothingQuality = "high";
  }
  async load(): Promise<void> {
    const vectorImages = Object.keys(vectors).map(key => `vector-${key.replace("/", "-")}.svg`);
    await Promise.all(["sprites.png", "shape-293.svg", "shape-294.svg", "shape-316.svg", "bitmap-5.png", ...vectorImages].map(async name => {
      const image = new Image();
      image.src = assetUrl(name);
      await image.decode();
      this.images.set(name, image);
    }));
    this.ready = true;
  }
  setDisplayScale(scale: number): void {
    this.displayScale = scale;
    this.resize();
  }
  private resize(): void {
    const density = Math.max(1, Math.min(4, this.displayScale * (window.devicePixelRatio || 1)));
    const width = Math.ceil(640 * density), height = Math.ceil(480 * density);
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.setTransform(width / 640, 0, 0, height / 480, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = "high";
  }
  private sprite(id: number, frame: number, x: number, y: number): void {
    const key = `${id}/${frame}`;
    const vector = vectors[key];
    if (vector) {
      const [width, height, ox, oy] = vector;
      this.ctx.drawImage(this.images.get(`vector-${id}-${frame}.svg`)!, x + ox, y + oy, width, height);
      return;
    }
    const rect = sprites[key];
    if (!rect) return;
    const [sx, sy, sourceWidth, sourceHeight, ox, oy, width, height] = rect;
    this.ctx.drawImage(this.images.get("sprites.png")!, sx, sy, sourceWidth, sourceHeight, x + ox, y + oy, width, height);
  }
  private penguin(p: Penguin): void {
    const { id, frame } = penguinFrame(p, this.engine.time);
    this.ctx.save();
    this.ctx.translate(p.x, p.y);
    this.ctx.scale(p.facing, 1);
    this.sprite(id, frame, 10.2, 0.65);
    this.ctx.restore();
  }
  draw(names: [string, string], showMatch = true): void {
    if (!this.ready) return;
    this.resize();
    const ctx = this.ctx, game = this.engine;
    ctx.clearRect(0, 0, 640, 480);
    ctx.drawImage(this.images.get("shape-293.svg")!, -8.9, -3.2);
    ctx.drawImage(this.images.get("shape-294.svg")!, -0.5, -0.5);
    ctx.drawImage(this.images.get("shape-316.svg")!, 3.7, 28);
    if (!showMatch) {
      // The result frame retains the ice artwork, but removes the Grid,
      // penguins and score text from the Flash display list.
      ctx.drawImage(this.images.get("bitmap-5.png")!, 0, 0);
      return;
    }
    for (let row = 0; row < game.grid.length; row++) {
      for (let col = 0; col < game.grid[row]!.length; col++) {
        const cell = game.grid[row]![col]!;
        if (cell.type === Stone.Free || cell.type === Stone.Bomb) continue;
        const x = 120 + col * 40, y = 40 + row * 40;
        if (cell.type === Stone.Wall) this.sprite(306, 1, x, y);
        else this.sprite(304, cell.open ? cell.type : 1, x, y);
      }
    }
    for (const bomb of game.bombs) {
      const count = bomb.player.nr === 1 ? 7 : 8;
      this.sprite(bomb.player.nr === 1 ? 80 : 78, 1 + Math.floor((game.time - bomb.placed) / 25) % count, bomb.x + 100, bomb.y + 20);
    }
    for (const flame of game.flames) {
      ctx.save();
      ctx.translate(120 + flame.col * 40, 40 + flame.row * 40);
      if (flame.horizontal && !flame.center) ctx.rotate(Math.PI / 2);
      const id = flame.player.nr === 1 ? flame.center ? 309 : 312 : flame.center ? 315 : 8;
      this.sprite(id, Math.min(20, 1 + Math.floor((game.time - flame.created) / 25)), 0, 0);
      ctx.restore();
    }
    for (const p of game.players) this.penguin(p);
    ctx.fillStyle = "#000";
    ctx.textAlign = "center";
    for (const p of game.players) {
      const offset = p.nr === 1 ? 0 : 165;
      ctx.font = "12px Arial";
      const name = names[p.nr - 1]!;
      ctx.fillText(name, 51, 47 + offset, 86);
      ctx.font = "italic bold 12px Arial";
      ctx.fillText("ping:", 45, 86 + offset);
      ctx.fillText("fps:", 42, 133 + offset);
      ctx.font = "12px Arial";
      ctx.fillText(String(p.ping), 42, 107 + offset);
      ctx.fillText(String(p.fps), 42, 153 + offset);
    }
    ctx.drawImage(this.images.get("bitmap-5.png")!, 0, 0);
  }
}

export class BomberpenguAudio {
  enabled = true;
  private context: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private gain: GainNode | null = null;
  private sounds: Record<string, number> = { drop: 16, explode: 17, pickup: 20, kick: 21, request: 22, message: 23 };
  async unlock(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.gain.value = this.enabled ? 0.8 : 0;
      this.gain.connect(this.context.destination);
      await Promise.all(Object.entries(this.sounds).map(async ([name, id]) => {
        const response = await fetch(assetUrl(`sound-${id}.wav`));
        this.buffers.set(name, await this.context!.decodeAudioData(await response.arrayBuffer()));
      }));
    }
    if (this.context.state === "suspended") await this.context.resume();
  }
  play(name: string): void {
    const buffer = this.buffers.get(name);
    if (!buffer || !this.context || !this.gain || !this.enabled) return;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.start();
  }
  toggle(): boolean {
    this.enabled = !this.enabled;
    if (this.gain) this.gain.gain.value = this.enabled ? 0.8 : 0;
    return this.enabled;
  }
  dispose(): void { void this.context?.close(); }
}
