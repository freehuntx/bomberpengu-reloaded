import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BomberpenguEngine, makeGrid, Stone, playerCol, playerRow } from '../src/game/engine.ts'
import { BotController } from '../src/game/bots.ts'
import { BomberpenguServer, parseXml, buildXml } from '../src/game/game.ts'
import { socketPair, xmlSocket } from '../src/net/index.ts'

const advance = (game, ai, ms) => {
  for (let elapsed = 0; elapsed < ms && game.phase !== 'finished'; elapsed += 25) {
    ai?.tick(25)
    game.tick(25)
  }
}
const empty = game => {
  game.startBot()
  game.seed(26)
  game.grid.forEach(row => row.forEach(cell => { cell.type = Stone.Free; cell.open = false }))
}

test('freestyle always clears stones, reveals all loot, and parks the bot in the border', () => {
  for (const seed of [0, 26, 12345, 20000]) {
    const packets = []
    const game = new BomberpenguEngine(xml => packets.push(xml), undefined, undefined, () => seed)
    game.startBot(true)
    const ai = new BotController(game, 'freestyle')
    advance(game, ai, 500)
    assert.equal(game.phase, 'playing')
    assert.equal(game.localNr, 2)
    assert.equal(game.remote.x, 80)
    assert.equal(game.remote.y, 40)
    assert.equal(playerCol(game.remote.x), -1)
    assert.equal(game.grid.flat().filter(c => c.type === Stone.Wall).length, 30)
    assert.equal(game.grid.flat().filter(c => c.type === Stone.Box).length, 0)
    assert.equal(game.grid.flat().filter(c => c.open).length, 28)
    assert.ok(game.flames.length)
    const original = makeGrid(seed)
    game.grid.forEach((row, r) => row.forEach((cell, c) => {
      if (original[r][c].type >= Stone.BombUp && original[r][c].type <= Stone.Kick) {
        assert.equal(cell.type, original[r][c].type)
        assert.equal(cell.open, true)
      }
    }))
    advance(game, ai, 1000)
    assert.equal(game.flames.length, 0)
    const row = game.grid.findIndex(row => row.some(c => c.type === Stone.BombUp))
    const col = game.grid[row].findIndex(c => c.type === Stone.BombUp)
    game.local.x = 120 + col * 40; game.local.y = 40 + row * 40
    advance(game, ai, 25)
    assert.equal(game.local.capacity, 2)
    assert.equal(game.remote.x, 80)
    assert.equal(game.remote.bombs, 0)
    assert.equal(game.local.alive, true)
    assert.deepEqual(packets, [], 'local gameplay must not leak into multiplayer relays')
  }
})

test('bot actors collect upgrades and local matches resolve wins, losses and simultaneous deaths', () => {
  const upgraded = new BomberpenguEngine(() => assert.fail('unexpected relay'))
  empty(upgraded)
  for (const type of [Stone.BombUp, Stone.SpeedUp, Stone.FlameUp, Stone.Kick]) {
    upgraded.grid[0][0] = { type, open: true }
    upgraded.tick(25)
  }
  assert.equal(upgraded.remote.capacity, 2)
  assert.equal(upgraded.remote.range, 3)
  assert.equal(upgraded.remote.speed, 0.16)
  assert.equal(upgraded.remote.kick, true)
  for (const result of ['win', 'loss', 'draw']) {
    const results = [], game = new BomberpenguEngine(() => {}, undefined, r => results.push(r))
    empty(game)
    if (result !== 'win') { game.local.x = 160; game.local.y = 40 }
    if (result === 'loss') { game.remote.x = 600; game.remote.y = 440 }
    game.explode(game.placeBomb(0, 0, game.remote))
    advance(game, null, 3025)
    assert.deepEqual(results, [result])
  }
})

test('hard escapes chain reactions before the long-fuse bomb is triggered', () => {
  const game = new BomberpenguEngine(() => {})
  empty(game)
  game.grid[1][1].type = Stone.Wall
  game.placeBomb(1, 0, game.local)
  game.placeBomb(2, 0, game.local).expires = 600
  advance(game, new BotController(game, 'hard', () => 0.4), 1200)
  assert.equal(game.remote.alive, true)
  assert.ok(playerRow(game.remote.y) > 0)
  assert.equal(game.bombs.length, 0)
})

test('every active bot walks out of interior walls and each arena border', () => {
  for (const level of ['easy', 'medium', 'hard']) {
    for (const [col, row] of [[1, 1], [-1, 0], [13, 10], [0, -1], [12, 11]]) {
      const game = new BomberpenguEngine(() => {})
      empty(game)
      const ai = new BotController(game, level, () => 0.4)
      ai.tick(25) // A displacement must invalidate any previously chosen move.
      if (col === 1) game.grid[row][col].type = Stone.Wall
      game.remote.x = 120 + col * 40; game.remote.y = 40 + row * 40
      for (let elapsed = 0; elapsed < 800; elapsed += 25) {
        const { x, y } = game.remote
        advance(game, ai, 25)
        assert.ok(Math.hypot(game.remote.x - x, game.remote.y - y) <= game.remote.speed * 25 + 0.5,
          `${level}: recovery should walk, not teleport`)
      }
      assert.notEqual(game.cell(playerCol(game.remote.x), playerRow(game.remote.y)).type, Stone.Wall)
      assert.equal(game.recoveringBot, false)
    }
  }
})

test('wall recovery handles connected walls and an exit blocked by stones without destroying them', () => {
  for (const level of ['easy', 'medium', 'hard']) {
    for (const obstruction of [Stone.Wall, Stone.Box]) {
      const game = new BomberpenguEngine(() => {})
      empty(game)
      for (let row = 1; row <= 3; row++) for (let col = 1; col <= 3; col++) game.grid[row][col].type = obstruction
      game.grid[2][2].type = Stone.Wall
      const grid = structuredClone(game.grid)
      game.remote.x = 200; game.remote.y = 120
      const ai = new BotController(game, level, () => 0.4)
      advance(game, ai, 25)
      for (let elapsed = 25; elapsed < 1600 && game.recoveringBot; elapsed += 25) advance(game, ai, 25)
      assert.equal(game.cell(playerCol(game.remote.x), playerRow(game.remote.y)).type, Stone.Free)
      assert.equal(game.recoveringBot, false)
      assert.deepEqual(game.grid, grid)
      assert.equal(game.remote.alive, true)
    }
  }
})

test('bots collect exposed items before useful bombing, including duplicate kick upgrades', () => {
  for (const level of ['easy', 'medium', 'hard']) {
    for (const type of [Stone.BombUp, Stone.SpeedUp, Stone.FlameUp, Stone.Kick]) {
      const sounds = [], game = new BomberpenguEngine(() => {}, s => sounds.push(s))
      empty(game)
      game.remote.kick = true
      game.grid[0][1].type = Stone.Box
      game.grid[2][0] = { type, open: true }
      const ai = new BotController(game, level, () => 0.4)
      for (let elapsed = 0; elapsed < 3000 && !sounds.includes('pickup'); elapsed += 25) advance(game, ai, 25)
      assert.equal(sounds[0], 'pickup', `${level}: should collect type ${type} before dropping a bomb`)
      assert.equal(game.grid[2][0].type, Stone.Free)
      assert.equal(game.grid[0][1].type, Stone.Box)
    }
  }
})

test('bots use an item-preserving placement when an inaccessible exposed item would be destroyed', () => {
  for (const level of ['easy', 'medium', 'hard']) {
    const game = new BomberpenguEngine(() => {})
    empty(game)
    // A remote bomb seals off the item. Bombing the spawn would trigger a
    // chain reaction and destroy it, but bombing below can open another path.
    game.local.range = 1
    game.placeBomb(2, 0, game.local).expires = 8000
    game.grid[0][3] = { type: Stone.BombUp, open: true }
    game.grid[0][4].type = Stone.Wall
    for (const col of [1, 2, 3]) game.grid[1][col].type = Stone.Wall
    game.grid[2][0].type = Stone.Box
    game.grid[1][1].type = Stone.Box
    const ai = new BotController(game, level, () => 0.4)
    advance(game, ai, 3000)
    assert.equal(game.grid[0][3].type, Stone.BombUp)
    assert.equal(game.grid[0][3].open, true)
    assert.ok(game.bombs.some(b => b.player === game.remote), `${level}: should find another useful placement`)
    assert.ok(game.bombs.filter(b => b.player === game.remote).every(b => b.row !== 0))
  }
})

test('destructive bombing remains a last resort when no collectible item or preserving attack is reachable', () => {
  const game = new BomberpenguEngine(() => {})
  empty(game)
  game.grid.forEach(row => row.forEach(cell => { cell.type = Stone.Wall }))
  for (const col of [0, 1, 2, 3]) game.grid[0][col].type = Stone.Free
  for (const row of [1, 2, 3]) game.grid[row][0].type = Stone.Free
  game.local.x = 160; game.local.y = 40; game.local.range = 1
  game.grid[0][3] = { type: Stone.FlameUp, open: true }
  game.placeBomb(2, 0, game.local).expires = 8000
  const ai = new BotController(game, 'hard', () => 0.4)
  advance(game, ai, 25)
  assert.ok(game.bombs.some(b => b.player === game.remote && b.col === 0 && b.row === 0))
  advance(game, ai, 3600)
  assert.equal(game.grid[0][3].type, Stone.Free)
  assert.equal(game.remote.alive, true)
})

test('later bombs during the frozen death animation do not reverse a resolved result', () => {
  const game = new BomberpenguEngine(() => {})
  empty(game)
  const later = game.placeBomb(0, 0, game.remote)
  later.expires = 1000
  game.explode(game.placeBomb(12, 10, game.remote))
  assert.equal(game.result, 'loss')
  advance(game, null, 3025)
  assert.equal(game.remote.alive, true)
  assert.equal(game.result, 'loss')
})

test('hard refuses an escape that depends on exposed loot blocking its bomb', () => {
  const game = new BomberpenguEngine(() => {})
  empty(game)
  game.grid.forEach(row => row.forEach(cell => { cell.type = Stone.Wall }))
  game.remote.x = 280; game.remote.y = 40; game.remote.range = 3
  for (const col of [4, 5, 6]) game.grid[0][col].type = Stone.Free
  game.grid[0][3].type = Stone.Box
  game.grid[0][5] = { type: Stone.Kick, open: true }
  game.grid[0][7].type = Stone.Box
  advance(game, new BotController(game, 'hard', () => 0.4), 5000)
  assert.equal(game.remote.alive, true)
  assert.equal(game.bombs.length, 0)
  assert.equal(game.grid[0][3].type, Stone.Box)
  assert.equal(game.grid[0][7].type, Stone.Box)
})

test('hard clears a real seeded map and attacks the opponent without self-destructing', () => {
  for (const seed of [0, 7, 26]) {
    const game = new BomberpenguEngine(() => {}, undefined, undefined, () => seed)
    game.startBot()
    advance(game, new BotController(game, 'hard', () => 0.4), 240000)
    assert.equal(game.remote.alive, true, `seed ${seed}: bot should survive its own bombs`)
    assert.equal(game.result, 'loss', `seed ${seed}: bot should eventually defeat a stationary opponent`)
    assert.ok(game.remote.capacity > 1)
  }
})

test('users play private copies concurrently, with automatic starts, rematches and migrated stats', () => {
  const ctx = { selfId: 'a', session: { peers: new Set(['b']) }, publishState() {} }
  let server = new BomberpenguServer(ctx, {})
  const connect = (id, resume = false) => {
    const [front, backend] = socketPair()
    const conn = xmlSocket(front), messages = []
    conn.on('message', raw => messages.push(parseXml(raw)))
    if (resume) server.onResume(backend, id)
    else server.onConnection(backend, id)
    return { messages, send: (tag, attrs) => conn.send(buildXml(tag, attrs)) }
  }
  let alice = connect('a'), bob = connect('b')
  alice.send('auth', { name: 'Alice' }); bob.send('auth', { name: 'Bob' })
  alice.send('challenge', { name: 'Bob' })
  alice.send('startBot', { name: 'Bot [Hard]' })
  bob.send('startBot', { name: 'Bot [Hard]' })
  assert.ok(alice.messages.some(m => m.tag === 'startBot' && m.attrs.name === 'Bot [Hard]'))
  assert.ok(bob.messages.some(m => m.tag === 'startBot' && m.attrs.name === 'Bot [Hard]'))
  assert.ok(bob.messages.some(m => m.tag === 'remRequest' && m.attrs.name === 'Alice'))
  assert.ok(bob.messages.some(m => m.tag === 'playerUpdate' && m.attrs.name === 'Alice' && m.attrs.state === '3'))
  assert.equal(server.saveState().players.length, 2, 'personal bots are not shared players')
  alice.send('botResult', { result: 'win' })
  alice.send('botResult', { result: 'win' })
  alice.send('winGame')
  assert.equal(server.saveState().players.find(p => p.name === 'Alice').wins, 1)
  const snapshot = structuredClone(server.saveState())
  server.dispose()
  server = new BomberpenguServer(ctx, {})
  server.loadState(snapshot)
  alice = connect('a', true); bob = connect('b', true)
  alice.send('startBot', { name: 'Bot [Hard]' })
  assert.equal(alice.messages.filter(m => m.tag === 'startBot').length, 1)
  alice.send('botResult', { result: 'draw' })
  alice.send('toRoom')
  assert.ok(bob.messages.some(m => m.tag === 'playerUpdate' && m.attrs.name === 'Alice' && m.attrs.skill === '1/0/1' && m.attrs.state === '0'))
  bob.send('surrender')
  assert.ok(bob.messages.some(m => m.tag === 'surrender' && m.attrs.winner === 'Bot [Hard]'))
  bob.send('botResult', { result: 'loss' })
  assert.equal(server.saveState().players.find(p => p.name === 'Bob').loses, 1)
  server.dispose()
})
