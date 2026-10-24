import type { Socket } from 'node:net'

interface Activity {
  isReady: boolean
  isBusy?: boolean
}

/** Own the fence where stdin is actually consumed, including detached clients. */
export class RunnerInputAdmission {
  readonly #holders = new Map<string, Socket>()
  readonly #draining = new Set<Socket>()

  constructor(private readonly options: {
    clients(): Iterable<Socket>
    activity(): Promise<Activity>
  }) {}

  allowsInput(socket: Socket): boolean {
    return this.#holders.size === 0 || this.#draining.has(socket)
  }

  disconnected(socket: Socket): void {
    this.#draining.delete(socket)
    for (const [id, holder] of this.#holders) if (holder === socket) this.#holders.delete(id)
  }

  resume(id: string): void { this.#holders.delete(id) }

  async pause(id: string, socket: Socket, timeoutMs = 5000): Promise<Activity & { isInputDrained: boolean }> {
    if (socket.destroyed || !socket.writable) return { isReady: false, isInputDrained: false }
    const isAlreadyPaused = this.#holders.size > 0
    const previous = this.#holders.get(id)
    this.#holders.set(id, socket)
    this.#draining.delete(socket)
    if (previous && previous !== socket) previous.end()
    const controls = new Set(this.#holders.values())
    const clients = [...this.options.clients()].filter(client => !controls.has(client) && !client.destroyed)
    if (!isAlreadyPaused) for (const client of clients) this.#draining.add(client)
    let isPrepared = false
    try {
      const before = await this.options.activity()
      if (this.#holders.get(id) !== socket || !before.isReady || before.isBusy !== false) return { ...before, isInputDrained: false }
      // Another pause may identify its control socket during the readiness RPC.
      const activeControls = new Set(this.#holders.values())
      const isClosed = await closeClients(clients.filter(client => !activeControls.has(client)), timeoutMs)
      const after = await this.options.activity()
      isPrepared = this.#holders.get(id) === socket && isClosed && after.isReady && after.isBusy === false
      return { ...after, isInputDrained: isPrepared }
    } finally {
      if (!isPrepared && this.#holders.get(id) === socket) this.#holders.delete(id)
    }
  }
}

async function closeClients(clients: Socket[], timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const pending = new Set(clients)
    const listeners = new Map<Socket, () => void>()
    const finish = (isClosed: boolean): void => {
      clearTimeout(timer)
      for (const [client, listener] of listeners) client.off('close', listener)
      resolve(isClosed)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    for (const client of clients) {
      const closed = (): void => { pending.delete(client); if (pending.size === 0) finish(true) }
      listeners.set(client, closed)
      client.once('close', closed)
      // FIN flushes accepted bytes. The peer's final close proves its ordered
      // data callbacks ran; destroying a socket cannot provide that proof.
      client.end()
    }
    if (pending.size === 0) finish(true)
  })
}
