export const BOT_NAMES = ["Bot [Freestyle]", "Bot [Easy]", "Bot [Medium]", "Bot [Hard]"] as const;
export type BotName = typeof BOT_NAMES[number];
export type BotLevel = "freestyle" | "easy" | "medium" | "hard";
export const isBotName = (name: string): name is BotName => (BOT_NAMES as readonly string[]).includes(name);
export const botLevel = (name: BotName): BotLevel => name.slice(5, -1).toLowerCase() as BotLevel;
