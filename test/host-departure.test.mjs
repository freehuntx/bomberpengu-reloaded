import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Network, createSession, broadcastChannelBridge } from '../src/net/index.ts'
import { bomberpengu } from '../src/game/game.ts'

if (!globalThis.CloseEvent) globalThis.CloseEvent = class extends Event {
  constructor(type, init = {}) { super(type); Object.assign(this, init) }
}

const waitFor = async condition => {
  const deadline = Date.now() + 3000
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for migration/protocol message')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('a graceful host departure retains the final snapshot and surviving connections', async () => {
  const channel = `host-departure-${crypto.randomUUID()}`
  const networks = [], sessions = []
  const join = async id => {
    const net = new Network(); networks.push(net)
    const session = await createSession(bomberpengu(), {
      net, bridge: broadcastChannelBridge({channel, selfId:id}), settleMs:50, snapshotMs:20,
    })
    sessions.push(session)
    const connection = session.connect(), messages = []
    let pending = ''
    connection.onmessage = event => {
      pending += new TextDecoder().decode(event.data)
      let end
      while ((end = pending.indexOf('\0')) !== -1) {
        messages.push(pending.slice(0,end)); pending = pending.slice(end+1)
      }
    }
    await new Promise(resolve => { connection.onopen = resolve })
    connection.send(`<auth name="${id}"/>\0`)
    await waitFor(()=>messages.some(message=>message.startsWith('<userList>')))
    return {session, connection, messages}
  }
  try {
    const host = await join('a'), bob = await join('b'), carol = await join('c')
    assert.equal(host.session.isHost,true)
    bob.connection.send('<startGame name="c"/>\0')
    await waitFor(()=>carol.messages.some(message=>message.startsWith('<startGame')))
    host.session.leave()
    await waitFor(()=>bob.session.isHost && carol.session.hostId==='b')
    await waitFor(()=>bob.messages.some(message=>message.includes('<playerLeft name="a"')))
    assert.equal(bob.connection.readyState,bob.connection.OPEN)
    assert.equal(carol.connection.readyState,carol.connection.OPEN)
    bob.connection.send('<12 x="160" y="40" c="0010"/>\0')
    await waitFor(()=>carol.messages.some(message=>message.includes('<12 x="160"')))
    assert.equal(bob.messages.filter(message=>message.startsWith('<userList>')).length,1)
    assert.equal(carol.messages.filter(message=>message.startsWith('<userList>')).length,1)
  } finally {
    sessions.forEach(session=>session.leave()); networks.forEach(net=>net.dispose())
  }
})
