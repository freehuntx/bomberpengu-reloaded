import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { BomberpenguEngine, makeGrid, Stone } from '../src/game/engine.ts'
import { parseXml } from '../src/game/game.ts'
import { penguinFrame } from '../src/game/animation.ts'
import { readFileSync } from 'node:fs'

// Golden maps from the dumped MyMath/Grid algorithm, including its reserved
// spawn positions and the order in which hidden power-ups consume random draws.
for (const [seed, digest] of [
  [0, 'b007a51f80eeae3b9ae28a5d3bda9e39d1a3bc4ff8552c542253d983570f797b'],
  [26, '1e221f4b1cf0b64441072a860e89d8637d87d3395887bb813ffcb205314b2e2e'],
  [12345, '38615f81cbb0a81ed789ce0273a3c6feb9a9cca18b2cc0726930d73a3ba209a9'],
  [20000, '6dfa77e4d471b72076d856287a24228e4fac1a61491ce813ac72c2aaf64f0e40'],
]) {
  const map = makeGrid(seed)
  assert.equal(createHash('sha256').update(map.map(r => r.map(c => c.type).join('')).join('/')).digest('hex'), digest)
  const counts = map.flat().reduce((counts, c) => (counts[c.type]++, counts), Array(8).fill(0))
  assert.deepEqual(counts.slice(1, 7), [30, 37, 10, 6, 6, 6])
  for (const [x, y] of [[0,0],[1,0],[2,0],[0,1],[0,2],[12,8],[12,9],[10,10],[11,10],[12,10]]) {
    assert.equal(map[y][x].type, Stone.Free)
  }
}

const empty = game => { game.seed(26); game.grid.forEach(row => row.forEach(c => { c.type = Stone.Free; c.open = false })) }

// Initialization is 20 original 40-Hz frames; player one alone picks the seed.
const packets = []
const initial = new BomberpenguEngine(xml => packets.push(parseXml(xml)), undefined, undefined, () => 12345)
initial.start(1)
for (let i = 0; i < 19; i++) initial.tick(25)
assert.equal(initial.phase, 'init')
initial.tick(25)
assert.equal(initial.phase, 'playing')
assert.equal(packets.find(p => p.tag === '16').attrs.s, '12345')
const waiting = new BomberpenguEngine(() => assert.fail('player two must not select a seed'))
waiting.start(2)
for (let i = 0; i < 20; i++) waiting.tick(25)
assert.equal(waiting.phase, 'waiting')
waiting.receive(packets.find(p => p.tag === '16'))
assert.deepEqual(waiting.grid, initial.grid)

// A held movement command uses stage coordinates and 150 pixels/second.
const movement = new BomberpenguEngine(() => {})
empty(movement)
movement.setCode('0010')
for (let i = 0; i < 8; i++) movement.tick(25)
assert.equal(movement.local.x, 150)
movement.grid[0][2].type = Stone.Wall
for (let i = 0; i < 20; i++) movement.tick(25)
assert.equal(movement.local.x, 160, 'blocked movement snaps to the adjacent tile center')
movement.local.x = 120
movement.grid[0][0].type = Stone.SpeedUp
movement.grid[0][0].open = true
movement.setCode('0000')
movement.tick(25)
assert.equal(movement.local.speed, 0.16)
assert.equal(movement.grid[0][0].type, Stone.Free)

// Crates stop a blast; the first hit reveals a power-up, the second destroys it.
const explosions = new BomberpenguEngine(() => {})
empty(explosions)
explosions.grid[1][1].type = Stone.Wall
explosions.grid[0][2].type = Stone.BombUp
explosions.local.x = 120
explosions.local.y = 80 // protected by the permanent wall at (1,1)
const bomb = explosions.placeBomb(1, 0, explosions.local)
explosions.tick(3500)
assert.equal(bomb.exploded, false)
explosions.tick(1)
assert.equal(bomb.exploded, true)
assert.equal(explosions.grid[0][2].open, true)
assert.equal(explosions.flames.some(f => f.col === 3 && f.row === 0), false)
assert.equal(explosions.local.alive, true)
assert.equal(explosions.local.bombs, 0)
explosions.tick(500)
assert.ok(explosions.flames.length)
explosions.tick(1)
assert.equal(explosions.flames.length, 0)
explosions.explode(explosions.placeBomb(1, 0, explosions.local))
assert.equal(explosions.grid[0][2].type, Stone.Free)

const chain = new BomberpenguEngine(() => {})
empty(chain)
chain.local.x = 600
chain.local.y = 440
const first = chain.placeBomb(0, 0, chain.local)
const second = chain.placeBomb(1, 0, chain.local)
chain.explode(first)
assert.equal(second.exploded, true)
assert.equal(chain.local.bombs, 0)
assert.equal(chain.grid[0][0].type, Stone.Free)
assert.equal(chain.grid[0][1].type, Stone.Free)

// Kicked bombs use the original 19 -> 11 -> 10 authority handoff. The receiver
// never lets its independent fuse detonate a bomb controlled by the other peer.
const outgoingA = [], outgoingB = []
const a = new BomberpenguEngine(xml => outgoingA.push(parseXml(xml)))
const b = new BomberpenguEngine(xml => outgoingB.push(parseXml(xml)))
a.start(1); b.start(2)
empty(a); empty(b)
a.local.kick = true
a.placeBomb(1, 0, a.remote)
b.placeBomb(1, 0, b.local)
a.setCode('0010')
a.tick(25)
const kick = outgoingA.find(p => p.tag === '19')
assert.equal(kick.attrs.i, '5000')
b.receive(kick)
assert.equal(b.bombs[0].remoteKicked, true)
// Move the receiving player into the rolling bomb's path to return authority.
b.local.x = b.bombs[0].x + 120
b.local.y = 40
b.tick(25)
const stop = outgoingB.find(p => p.tag === '11')
assert.ok(stop, 'a moving bomb pushes a blocking local penguin and sends its stop position')
a.receive(stop)
assert.equal(a.bombs[0].remoteKicked, true)
assert.equal(b.bombs[0].remoteKicked, false)
a.setCode('0000')
a.local.x = b.local.x = 600
a.local.y = b.local.y = 440
a.tick(3600)
assert.equal(a.bombs[0].exploded, false)
b.tick(3600)
const detonation = outgoingB.find(p => p.tag === '10')
assert.ok(detonation)
a.receive(detonation)
a.tick(0)
assert.equal(a.bombs.length, 0)
assert.deepEqual(a.grid, b.grid)

// Delayed wins count from the death, not the start of a long-running round.
const results = [], resultPackets = []
const ending = new BomberpenguEngine(xml => resultPackets.push(parseXml(xml)), undefined, result => results.push(result))
empty(ending)
ending.tick(15000)
ending.receive(parseXml('<die x="600" y="440"/>'))
ending.tick(3000)
assert.equal(ending.phase, 'over')
ending.tick(1)
assert.equal(ending.phase, 'finished')
assert.deepEqual(results, ['win'])
ending.tick(5000)
assert.equal(resultPackets.filter(p => p.tag === 'winGame').length, 1)

const draw = new BomberpenguEngine(() => {})
empty(draw)
draw.tick(5000)
draw.die()
draw.receive(parseXml('<draw/>'))
assert.equal(draw.local.animationTime, 5000)
assert.equal(draw.remote.animationTime, 5000, 'a draw starts both nested death timelines')
draw.receive(parseXml('<die x="600" y="440"/>'))
draw.tick(3001)
assert.equal(draw.result, 'draw', 'the server draw takes precedence over a relayed death')

// Walking sequences must not sample the blank gaps between labels. The death
// frames are from the nested clips, rather than the blank stopped parent.
const atlas = JSON.parse(readFileSync(new URL('../src/game/assets/sprites.json', import.meta.url), 'utf8'))
for (const p of [movement.local, movement.remote]) {
  p.animationTime = 0
  p.alive = true
  for (const animation of ['stand', 'go', 'up', 'down']) {
    p.animation = animation
    for (let time = 0; time < 6000; time += 25) {
      const { id, frame } = penguinFrame(p, time)
      assert.ok(atlas[`${id}/${frame}`], `${p.nr} ${animation} selected an unexported/blank frame ${frame}`)
    }
  }
  p.alive = false
  p.animationTime = 6000
  assert.equal(penguinFrame(p, 6000).frame, 1)
  assert.equal(penguinFrame(p, 6250).frame, 11)
  assert.equal(penguinFrame(p, 9000).frame, 20, 'the death animation holds its final pose')
  for (let time = 6000; time <= 6500; time += 25) {
    const { id, frame } = penguinFrame(p, time)
    assert.equal(id, p.nr === 1 ? 377 : 402)
    assert.ok(atlas[`${id}/${frame}`])
  }
}

console.log('✔ bomberpengu native engine: original maps, movement, upgrades, fuses, blast blocking, chains, kick authority, results')
