export interface TerminalSocketSendTarget {
  readyState: number
  send(message: string): void
}

export interface TerminalSizeSource {
  cols: number
  rows: number
}

const webSocketOpenState = 1

function sendTerminalMessage(socket: TerminalSocketSendTarget | null | undefined, payload: object): void {
  if (socket?.readyState !== webSocketOpenState) return
  socket.send(JSON.stringify(payload))
}

export function sendTerminalResize(socket: TerminalSocketSendTarget | null | undefined, term: TerminalSizeSource): void {
  sendTerminalMessage(socket, { type: "resize", cols: term.cols, rows: term.rows })
}

export function sendTerminalPong(socket: TerminalSocketSendTarget | null | undefined): void {
  sendTerminalMessage(socket, { type: "pong" })
}
