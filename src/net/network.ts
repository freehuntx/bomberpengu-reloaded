import { VirtualSocket } from './socket.ts'
import { LocalConnection } from './connection.ts'
import type { Unsubscribe } from './events.ts'

export type Address = string | { host: string; port: number }
export interface NetworkOptions { debug?: boolean }

/** Native connections into the local or tunneled peer-hosted server. */
export class Network {
  #routes = new Map<string, (socket: VirtualSocket) => void>()
  #sockets = new Set<VirtualSocket>()
  #disposed = false

  constructor(private options: NetworkOptions = {}) {}

  listen(address: Address, handler: (socket: VirtualSocket) => void): Unsubscribe {
    this.#assertActive()
    const { host, port } = parseAddress(address)
    const key = `${host}:${port}`
    if (this.#routes.has(key)) throw new Error(`Endpoint already registered: ${key}`)
    this.#routes.set(key, handler)
    return () => { if (this.#routes.get(key) === handler) this.#routes.delete(key) }
  }

  connect(address: Address): LocalConnection {
    this.#assertActive()
    const { host, port } = parseAddress(address)
    const handler = this.#routes.get(`${host}:${port}`)
    if (!handler) throw new Error(`Unknown endpoint: ${host}:${port}`)
    const socket = new VirtualSocket(host, port)
    this.#sockets.add(socket)
    socket.once('close', () => this.#sockets.delete(socket))
    if (this.options.debug) console.log('[network] connect:', host, port)
    return new LocalConnection(`local://${host}:${port}`, socket, handler)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const socket of [...this.#sockets]) socket.close()
    this.#sockets.clear()
    this.#routes.clear()
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('Network has been disposed')
  }
}

function parseAddress(address: Address): { host: string; port: number } {
  const split = typeof address === 'string' ? address.lastIndexOf(':') : -1
  const host = typeof address === 'string' ? address.slice(0, split) : address.host
  const port = typeof address === 'string' ? Number(address.slice(split + 1)) : address.port
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid endpoint: ${String(address)}`)
  return { host, port }
}
