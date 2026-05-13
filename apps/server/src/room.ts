import { DurableObject } from "cloudflare:workers"
import {
  chooseAuthorPair,
  ClientMessage,
  type Matchup,
  PersistedRoomState,
  type PersistedRoomState as PersistedRoomStateData,
  type Phase,
  type Player,
  type ServerMessage,
  PLAYER_COLORS,
  POINTS_FOR_SHUTOUT,
  POINTS_PER_VOTE,
  PROMPTS_PER_GAME,
  VOTING_SECONDS,
  visibleMatchupFor,
  WRITING_SECONDS,
} from "@belch/protocol"
import { pickPrompts } from "./games/quiplash"

type Attachment = { role: "host" | "guest"; playerId?: string }
const ROOM_IDLE_TTL_MS = 6 * 60 * 60 * 1000
const NO_ANSWER_TEXT = "(no answer)"

const DEFAULTS: PersistedRoomStateData = {
  created: false,
  hostToken: null,
  playerTokens: [],
  players: [],
  scores: [],
  authorCounts: [],
  prompts: [],
  promptIdx: 0,
  matchup: null,
  phaseEndsAt: null,
  phase: "lobby",
}

export class Room extends DurableObject {
  private players!: Map<string, Player>
  private playerTokens!: Map<string, string>
  private scores!: Map<string, number>
  private authorCounts!: Map<string, number>
  private prompts!: string[]
  private promptIdx!: number
  private matchup!: Matchup | null
  private phaseEndsAt!: number | null
  private phase!: Phase
  private ready: Promise<void>

  constructor(ctx: DurableObjectState, env: never) {
    super(ctx, env)
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get("state")
      const parsed = stored === undefined ? DEFAULTS : PersistedRoomState.safeParse(stored).data
      const s = parsed ?? DEFAULTS
      this.players = new Map(s.players)
      this.playerTokens = new Map(s.playerTokens ?? [])
      this.hostToken = s.hostToken ?? null
      this.scores = new Map(s.scores)
      this.authorCounts = new Map(s.authorCounts ?? [])
      this.prompts = s.prompts
      this.promptIdx = s.promptIdx
      this.matchup = s.matchup
      this.phaseEndsAt = s.phaseEndsAt ?? null
      this.phase = s.phase
    })
  }

  private async persist() {
    const s: PersistedRoomStateData = {
      created: this.hostToken !== null,
      hostToken: this.hostToken,
      playerTokens: [...this.playerTokens.entries()],
      players: [...this.players.entries()],
      scores: [...this.scores.entries()],
      authorCounts: [...this.authorCounts.entries()],
      prompts: this.prompts,
      promptIdx: this.promptIdx,
      matchup: this.matchup,
      phaseEndsAt: this.phaseEndsAt,
      phase: this.phase,
    }
    await this.ctx.storage.put("state", s)
    await this.scheduleAlarm()
  }

  private hostToken!: string | null

  async fetch(request: Request): Promise<Response> {
    await this.ready
    const url = new URL(request.url)

    if (request.method === "POST" && url.pathname === "/create") {
      if (this.hostToken) return new Response("room exists", { status: 409 })
      const body = (await request.json().catch(() => null)) as { hostToken?: string } | null
      if (!body?.hostToken) return new Response("missing host token", { status: 400 })
      this.hostToken = body.hostToken
      await this.persist()
      return new Response("created")
    }

    if (!this.hostToken) return new Response("room not found", { status: 404 })

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]

    const role = url.searchParams.get("role") === "host" ? "host" : "guest"
    if (role === "host" && url.searchParams.get("hostToken") !== this.hostToken) {
      return new Response("unauthorized host", { status: 401 })
    }

    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ role } satisfies Attachment)

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    await this.ready
    if (typeof raw !== "string") return
    let msg: ClientMessage
    try {
      msg = ClientMessage.parse(JSON.parse(raw))
    } catch {
      return this.send(ws, { t: "error", message: "bad message" })
    }

    const att = ws.deserializeAttachment() as Attachment

    switch (msg.t) {
      case "hello":
        return this.onHello(ws, msg)
      case "start":
        if (att.role === "host" && this.phase === "lobby") await this.startGame()
        return
      case "submit":
        if (att.playerId) await this.onSubmit(att.playerId, msg.answer)
        return
      case "vote":
        if (att.playerId) await this.onVote(att.playerId, msg.choice)
        return
      case "next":
        if (att.role === "host") await this.advance()
        return
      case "ping":
        return this.send(ws, { t: "pong" })
    }
  }

  async webSocketClose(ws: WebSocket) {
    await this.ready
    const att = ws.deserializeAttachment() as Attachment | null
    if (att?.role === "guest" && att.playerId && this.phase === "lobby") {
      if (this.isPlayerConnected(att.playerId, ws)) return
      this.players.delete(att.playerId)
      this.playerTokens.delete(att.playerId)
      this.scores.delete(att.playerId)
      this.authorCounts.delete(att.playerId)
      await this.persist()
      this.broadcastState()
      return
    }

    if (att?.role !== "guest" || !att.playerId || this.isPlayerConnected(att.playerId, ws)) return

    if (this.phase === "writing" && this.matchup) {
      const idx = this.matchup.authors.indexOf(att.playerId)
      if (idx !== -1 && !this.matchup.answers[idx as 0 | 1]) {
        this.matchup.answers[idx as 0 | 1] = "(disconnected)"
        if (this.matchup.answers[0] && this.matchup.answers[1]) {
          this.phase = "voting"
          this.phaseEndsAt = Date.now() + VOTING_SECONDS * 1000
        }
        await this.persist()
        this.broadcastState()
      }
      return
    }

    if (this.phase === "voting" && this.matchup) {
      await this.maybeReveal()
    }
  }

  async alarm() {
    await this.ready
    if (this.phase === "writing" && this.phaseEndsAt !== null && Date.now() >= this.phaseEndsAt) {
      await this.finishWriting()
      return
    }

    if (this.phase === "voting" && this.phaseEndsAt !== null && Date.now() >= this.phaseEndsAt) {
      await this.reveal()
      return
    }

    if (this.ctx.getWebSockets().length > 0) {
      await this.scheduleAlarm()
      return
    }

    this.players = new Map()
    this.playerTokens = new Map()
    this.scores = new Map()
    this.authorCounts = new Map()
    this.prompts = []
    this.promptIdx = 0
    this.matchup = null
    this.phaseEndsAt = null
    this.phase = "lobby"
    this.hostToken = null
    await this.ctx.storage.delete("state")
  }

  // ---------- handlers ----------

  private async onHello(
    ws: WebSocket,
    msg: { role: "host" | "guest"; name?: string; playerId?: string; playerToken?: string },
  ) {
    const att = ws.deserializeAttachment() as Attachment
    if (att.role === "host") {
      this.send(ws, { t: "welcome", state: this.snapshot(att) })
      return
    }

    // Reconnect: known playerId → reattach this socket to the existing player.
    if (
      msg.playerId &&
      msg.playerToken &&
      this.players.has(msg.playerId) &&
      this.playerTokens.get(msg.playerId) === msg.playerToken
    ) {
      const player = this.players.get(msg.playerId)!
      ws.serializeAttachment({ role: "guest", playerId: player.id } satisfies Attachment)
      this.send(ws, {
        t: "welcome",
        you: player,
        state: this.snapshot({ role: "guest", playerId: player.id }),
      })
      this.broadcastState()
      return
    }

    // Fresh join — only allowed in lobby.
    if (this.phase !== "lobby") {
      return this.send(ws, { t: "error", message: "game already started" })
    }
    const id = crypto.randomUUID()
    const playerToken = crypto.randomUUID()
    const player: Player = {
      id,
      name: (msg.name ?? "Player").slice(0, 20),
      color: PLAYER_COLORS[this.players.size % PLAYER_COLORS.length]!,
    }
    this.players.set(id, player)
    this.playerTokens.set(id, playerToken)
    this.scores.set(id, 0)
    this.authorCounts.set(id, 0)
    ws.serializeAttachment({ role: "guest", playerId: id } satisfies Attachment)
    await this.persist()
    this.send(ws, {
      t: "welcome",
      you: player,
      playerToken,
      state: this.snapshot({ role: "guest", playerId: id }),
    })
    this.broadcastState()
  }

  private async startGame() {
    if (this.players.size < 3) return
    this.prompts = pickPrompts(PROMPTS_PER_GAME)
    this.promptIdx = 0
    this.authorCounts = new Map()
    for (const id of this.players.keys()) {
      this.scores.set(id, 0)
      this.authorCounts.set(id, 0)
    }
    await this.beginRound()
  }

  private async beginRound() {
    const prompt = this.prompts[this.promptIdx]
    if (!prompt) return this.endGame()
    const authors = this.pickTwo()
    if (!authors) return this.endGame()
    this.matchup = {
      prompt,
      authors,
      answers: [null, null],
      votes: {},
      revealed: false,
    }
    for (const id of authors) this.authorCounts.set(id, (this.authorCounts.get(id) ?? 0) + 1)
    this.phase = "writing"
    this.phaseEndsAt = Date.now() + WRITING_SECONDS * 1000
    await this.persist()
    this.broadcastState()
  }

  private pickTwo(): [string, string] | null {
    const connected = this.connectedPlayerIds()
    const ids = connected.length >= 2 ? connected : [...this.players.keys()]
    return chooseAuthorPair({
      playerIds: ids,
      authorCounts: this.authorCounts,
      previousPair: this.matchup?.authors,
    })
  }

  private async onSubmit(playerId: string, answer: string) {
    if (this.phase !== "writing" || !this.matchup) return
    const idx = this.matchup.authors.indexOf(playerId)
    if (idx === -1) return
    if (this.matchup.answers[idx as 0 | 1]) return
    this.matchup.answers[idx as 0 | 1] = answer.slice(0, 80)
    if (this.matchup.answers[0] && this.matchup.answers[1]) {
      this.phase = "voting"
      this.phaseEndsAt = Date.now() + VOTING_SECONDS * 1000
    }
    await this.persist()
    this.broadcastState()
  }

  private async finishWriting() {
    if (this.phase !== "writing" || !this.matchup) return
    if (!this.matchup.answers[0]) this.matchup.answers[0] = NO_ANSWER_TEXT
    if (!this.matchup.answers[1]) this.matchup.answers[1] = NO_ANSWER_TEXT
    this.phase = "voting"
    this.phaseEndsAt = Date.now() + VOTING_SECONDS * 1000
    await this.persist()
    this.broadcastState()
  }

  private async onVote(playerId: string, choice: 0 | 1) {
    if (this.phase !== "voting" || !this.matchup) return
    if (this.matchup.authors.includes(playerId)) return
    if (this.matchup.votes[playerId] !== undefined) return
    this.matchup.votes[playerId] = choice
    await this.maybeReveal()
  }

  private async maybeReveal() {
    if (!this.matchup) return
    const eligible = this.connectedPlayerIds().filter((id) => !this.matchup!.authors.includes(id))
    if (eligible.length === 0 || eligible.every((id) => id in this.matchup!.votes)) {
      await this.reveal()
      return
    }
    await this.persist()
    this.broadcastState()
  }

  private async reveal() {
    if (!this.matchup) return
    let v0 = 0
    let v1 = 0
    for (const c of Object.values(this.matchup.votes)) c === 0 ? v0++ : v1++
    const [a0, a1] = this.matchup.authors
    const award = (id: string, votes: number, otherVotes: number) => {
      const base = votes * POINTS_PER_VOTE
      const bonus = votes > 0 && otherVotes === 0 ? POINTS_FOR_SHUTOUT : 0
      this.scores.set(id, (this.scores.get(id) ?? 0) + base + bonus)
    }
    award(a0, v0, v1)
    award(a1, v1, v0)
    this.matchup.revealed = true
    this.phase = "reveal"
    this.phaseEndsAt = null
    await this.persist()
    this.broadcastState()
  }

  private async advance() {
    if (this.phase === "voting") {
      await this.reveal()
      return
    }
    if (this.phase !== "reveal") return
    this.promptIdx++
    if (this.promptIdx >= this.prompts.length) {
      await this.endGame()
    } else {
      await this.beginRound()
    }
  }

  private async endGame() {
    this.phase = "final"
    this.matchup = null
    this.phaseEndsAt = null
    await this.persist()
    this.broadcastState()
  }

  // ---------- snapshot + send ----------

  private snapshot(viewer?: Attachment) {
    return {
      phase: this.phase,
      players: [...this.players.values()],
      connectedPlayerIds: this.connectedPlayerIds(),
      scores: Object.fromEntries(this.scores),
      round: this.phase === "lobby" ? 0 : this.promptIdx + 1,
      totalRounds: this.prompts.length || PROMPTS_PER_GAME,
      phaseEndsAt: this.phaseEndsAt,
      matchup: visibleMatchupFor({ matchup: this.matchup, phase: this.phase, viewer }),
    }
  }

  private connectedPlayerIds() {
    const ids = new Set<string>()
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null
      if (att?.role === "guest" && att.playerId) ids.add(att.playerId)
    }
    return [...ids].filter((id) => this.players.has(id))
  }

  private isPlayerConnected(playerId: string, except?: WebSocket) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue
      const att = ws.deserializeAttachment() as Attachment | null
      if (att?.role === "guest" && att.playerId === playerId) return true
    }
    return false
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    ws.send(JSON.stringify(msg))
  }

  private broadcastState() {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null
      this.send(ws, { t: "state", state: this.snapshot(att ?? undefined) })
    }
  }

  private async scheduleAlarm() {
    const cleanupAt = Date.now() + ROOM_IDLE_TTL_MS
    const nextAt =
      this.phase === "writing" && this.phaseEndsAt !== null
        ? Math.min(this.phaseEndsAt, cleanupAt)
        : this.phase === "voting" && this.phaseEndsAt !== null
          ? Math.min(this.phaseEndsAt, cleanupAt)
          : cleanupAt
    await this.ctx.storage.setAlarm(nextAt)
  }
}
