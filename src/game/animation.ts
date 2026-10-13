import type { Penguin } from "./engine.ts";

export function penguinFrame(player: Penguin, time: number): { id: number; frame: number } {
  const ticks = Math.max(0, Math.floor((time - player.animationTime) / 25));
  if (!player.alive) {
    // MyPlayer.die() stops the parent at frame 60. The nested MovieClip plays
    // twenty frames independently, then stops on the final death pose.
    return { id: player.nr === 1 ? 377 : 402, frame: 1 + Math.min(19, ticks) };
  }
  // The loops end at their gotoAndPlay actions. Frames 41/42 and 54..59
  // belong to empty gaps between labels and must never be displayed.
  const frame = player.animation === "up" ? 31 + ticks % 10
    : player.animation === "down" ? 43 + ticks % 11
    : player.animation === "go" ? 5 + ticks % 25 : 1;
  return { id: player.nr === 1 ? 378 : 403, frame };
}
