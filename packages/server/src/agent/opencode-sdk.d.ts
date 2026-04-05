// Type stub for @opencode-ai/sdk until the package is installed
declare module "@opencode-ai/sdk" {
  interface OpencodeClientOptions {
    baseUrl: string
  }

  interface OpencodeClient {
    session: {
      create(opts: { title: string }): Promise<{ id: string }>
      get(id: string): Promise<{ id: string; status: string }>
      list(): Promise<Array<{ id: string; status: string }>>
      abort(id: string): Promise<void>
    }
    message: {
      list(sessionId: string): Promise<unknown[]>
      send(sessionId: string, text: string): Promise<void>
    }
    health(): Promise<{ ok: boolean }>
  }

  export function createOpencodeClient(opts: OpencodeClientOptions): OpencodeClient
}
