import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Network, xmlSocket } from '../src/net/index.ts'

if (!globalThis.CloseEvent) globalThis.CloseEvent = class extends Event {
  constructor(type, init = {}) { super(type); Object.assign(this, init) }
}

test('native connections preserve framing/order without patching browser APIs', async () => {
  const originalWebSocket = globalThis.WebSocket
  const originalFetch = globalThis.fetch
  const net = new Network()
  const unlisten = net.listen('localhost:4444', socket => {
    const messages = xmlSocket(socket)
    messages.on('message', message => messages.send(`reply:${message}`))
  })
  assert.equal(globalThis.WebSocket, originalWebSocket)
  assert.equal(globalThis.fetch, originalFetch)
  const connection = net.connect('localhost:4444')
  const replies = []
  connection.addEventListener('message', event => {
    replies.push(new TextDecoder().decode(event.data).replace(/\0$/, ''))
  })
  await new Promise(resolve => connection.addEventListener('open', resolve, { once: true }))
  const complete = new Promise(resolve => connection.addEventListener('message', () => {
    if (replies.length === 3) resolve()
  }))
  connection.send('first\0')
  connection.send(new Blob(['Grüße\0']))
  connection.send(new TextEncoder().encode('third\0'))
  await complete
  assert.deepEqual(replies, ['reply:first', 'reply:Grüße', 'reply:third'])
  const closed = new Promise(resolve => connection.addEventListener('close', resolve, { once: true }))
  net.dispose()
  await closed
  assert.equal(connection.readyState, connection.CLOSED)
  assert.equal(globalThis.WebSocket, originalWebSocket)
  assert.equal(globalThis.fetch, originalFetch)
  unlisten()
  assert.throws(() => net.connect('localhost:4444'), /disposed/)
})

test('disposing before open cannot deliver a closed connection to the server', async () => {
  const net = new Network()
  let delivered = false
  net.listen('localhost:4444', () => { delivered = true })
  const connection = net.connect('localhost:4444')
  const closed = new Promise(resolve => connection.addEventListener('close', resolve, { once: true }))
  net.dispose()
  await closed
  assert.equal(delivered, false)
  assert.equal(connection.readyState, connection.CLOSED)
})

test('unknown, invalid and removed endpoints are rejected', () => {
  const net = new Network()
  assert.throws(() => net.connect('localhost:4444'), /Unknown endpoint/)
  assert.throws(() => net.listen('localhost:0', () => {}), /Invalid endpoint/)
  const remove = net.listen('localhost:4444', () => {})
  assert.throws(() => net.listen('localhost:4444', () => {}), /already registered/)
  remove()
  assert.throws(() => net.connect('localhost:4444'), /Unknown endpoint/)
  net.dispose()
})
