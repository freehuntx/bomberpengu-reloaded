# BomberPengu Reloaded

A standalone TypeScript/HTML/Canvas recreation of BomberPengu, with the original
artwork, animated penguins, bombs, power-ups, and peer-to-peer multiplayer.

## Run locally

Requires Node.js 24 or newer and npm.

```sh
npm install
npm run dev
```

Open the URL printed by Vite to join the `lobby` room automatically.
A random player name is generated on first visit and saved in localStorage under
`playerName` for future visits. The `name` query parameter overrides the saved name
and becomes the new saved name.
Players using the same room can challenge each other in the lobby.
Every player also has four private opponents at the top of the player list:
`Bot [Freestyle]`, `Bot [Easy]`, `Bot [Medium]`, and `Bot [Hard]`.
Clicking a bot starts a match automatically; rematches are accepted automatically too.
Bots run in your browser, so other players can play their own bots simultaneously.

Freestyle parks the bot inside the wall one tile left of the top-left spawn and
explodes all destructible stones immediately, revealing every power-up for practice.
Easy reacts slowly and plays casually, Medium seeks upgrades and useful bombing
positions, and Hard reacts quickly and uses blast and chain-reaction forecasts to
plan escapes and pressure its opponent. All bots use the normal movement, bomb,
and power-up rules.
Active bots walk back to open ground if displaced into walls. They prioritize
collecting exposed items and choose item-preserving bomb placements, including
checking chain reactions; destroying an item is reserved for when no safe,
productive alternative is reachable.

Direct links are supported:

```text
/?name=Alice&room=friends
/?name=Bob&room=friends
```

Share `/?room=friends` to let another player join that room automatically with their
saved or randomly generated name. The default room is `lobby`.

## Multiplayer

The lobby server runs in an elected player's browser. Trystero uses MQTT signaling
to establish WebRTC peer connections. Lobby state is replicated so another player
can take over when the host leaves.

For offline testing between tabs on the same browser origin, use:

```text
/?name=Alice&room=test&transport=local
/?name=Bob&room=test&transport=local
```

This mode uses BroadcastChannel and needs no signaling connection.
Add `&debug` for networking diagnostics, or `&motd=Welcome` for a lobby message.

## Controls

- **Arrow keys:** move.
- **Space:** place a bomb.
- **Chat:** type a message and press Enter or Send; the game regains focus afterward.
- **Lobby:** click a player to challenge them, accept their challenge, or withdraw yours.
- **Power-ups:** additional bombs, increased speed, longer blasts, and bomb kicking.
- **Touch devices:** on-screen movement and bomb buttons are provided.

Chat commands: `!help`, `!fs` / `!freestyle` (both players must agree), and `!bug`.

## Languages

The browser's primary language selects German for `de` and its regional variants.
All other languages use English. Each player's UI is localized independently;
player-written messages remain as typed.

## Build and test

```sh
npm test
npm run build
npm run preview
```

Deploy the generated `dist/` folder to a static web host. The build uses relative
asset URLs by default; `BASE_PATH` can specify a hosting subdirectory when needed.

## GitHub Pages

In the GitHub repository, open **Settings → Pages** and set **Build and deployment →
Source** to **GitHub Actions**.

The workflow in `.github/workflows/deploy-pages.yml` installs dependencies, runs
tests, builds the game, and deploys `dist/` automatically on pushes to the default
branch. You can also run **Deploy to GitHub Pages** manually from the **Actions**
tab with the default branch selected.

The build uses the base path supplied by GitHub Pages, supporting repository sites
such as `https://OWNER.github.io/REPOSITORY/` as well as root sites and custom domains.
The deployed site's URL appears in the workflow's `github-pages` environment.

## Layout

```text
src/main.ts          Automatic player identity and room joining
src/game/            Game client, engine, renderer, assets, and translations
src/net/             Native connections, framing, peer bridges, host migration
test/                Gameplay, animation, localization, and protocol regressions
```

All runtime code and artwork are included in this project. The game runs natively
in the browser and requires no emulator or game backend service.
