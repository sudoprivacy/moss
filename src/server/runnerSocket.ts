import net from 'net'

/**
 * Connect to a runner attach socket with a hard timeout. The socket can stall
 * without ever completing or failing the connection (e.g. a runner still
 * processing the probe disconnect from spawn accepts no new connections) —
 * without a bound the returned promise stays pending forever and the bridged
 * WebSocket never installs its message handlers.
 */
export async function connectToAttachSocket(
  attachPath: string,
  timeoutMs: number,
): Promise<net.Socket> {
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(attachPath)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms connecting to runner attach socket: ${attachPath}`,
        ),
      )
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
