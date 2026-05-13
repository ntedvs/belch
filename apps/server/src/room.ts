import { DurableObject } from "cloudflare:workers"
import {
  chooseAuthorPair,
  ClientMessage,
  type FibbageChoice,
  type FibbageRound,
  type GameType,
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
  visibleFibbageFor,
  visibleMatchupFor,
  WRITING_SECONDS,
} from "@belch/protocol"
import { pickFibbageQuestions } from "./games/fibbage"
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
  fibbageTruths: [],
  promptIdx: 0,
  matchup: null,
  fibbage: null,
  phaseEndsAt: null,
  phase: "lobby",
  gameType: "quiplash",
}

export class Room extends DurableObject {
  private players!: Map<string, Player>
  private playerTokens!: Map<string, string>
  private scores!: Map<string, number>
  private gameType!: GameType
  private authorCounts!: Map<string, number>
  private prompts!: string[]
  private fibbageTruths!: string[]
  private promptIdx!: number
  private matchup!: Matchup | null
  private fibbage!: FibbageRound | null
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
      this.gameType = s.gameType ?? "quiplash"
      this.scores = new Map(s.scores)
      this.authorCounts = new Map(s.authorCounts ?? [])
      this.prompts = s.prompts
      this.fibbageTruths = s.fibbageTruths ?? []
      this.promptIdx = s.promptIdx
      this.matchup = s.matchup
      this.fibbage = s.fibbage ?? null
      this.phaseEndsAt = s.phaseEndsAt ?? null
      this.phase = s.phase
    })
  }

  private async persist() {
    const s: PersistedRoomStateData = {
      created: this.hostToken !== null,
      gameType: this.gameType,
      hostToken: this.hostToken,
      playerTokens: [...this.playerTokens.entries()],
      players: [...this.players.entries()],
      scores: [...this.scores.entries()],
      authorCounts: [...this.authorCounts.entries()],
      prompts: this.prompts,
      fibbageTruths: this.fibbageTruths,
      promptIdx: this.promptIdx,
      matchup: this.matchup,
      fibbage: this.fibbage,
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
      const body = (await request.json().catch(() => null)) as {
        hostToken?: string
        gameType?: GameType
      } | null
      if (!body?.hostToken) return new Response("missing host token", { status: 400 })
      if (body.gameType && body.gameType !== "quiplash" && body.gameType !== "fibbage") {
        return new Response("bad game type", { status: 400 })
      }
      this.hostToken = body.hostToken
      this.gameType = body.gameType ?? "quiplash"
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
      case "setGame":
        if (att.role === "host") await this.setGame(msg.gameType)
        return
      case "start":
        if (att.role === "host" && (this.phase === "lobby" || this.phase === "final")) {
          await this.startGame()
        }
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
    this.fibbageTruths = []
    this.promptIdx = 0
    this.matchup = null
    this.fibbage = null
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

    // Fresh join — only allowed while the room is between games.
    if (this.phase !== "lobby" && this.phase !== "final") {
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
    if (this.gameType === "fibbage") return this.startFibbage()
    return this.startQuiplash()
  }

  private async setGame(gameType: GameType) {
    if (this.phase !== "lobby" && this.phase !== "final") return
    this.gameType = gameType
    this.clearGameState()
    await this.persist()
    this.broadcastState()
  }

  private clearGameState() {
    this.authorCounts = new Map()
    this.prompts = []
    this.fibbageTruths = []
    this.promptIdx = 0
    this.matchup = null
    this.fibbage = null
    this.phaseEndsAt = null
  }

  private async startQuiplash() {
    this.prompts = pickPrompts(PROMPTS_PER_GAME)
    this.fibbageTruths = []
    this.promptIdx = 0
    this.authorCounts = new Map()
    for (const id of this.players.keys()) {
      this.scores.set(id, 0)
      this.authorCounts.set(id, 0)
    }
    await this.beginQuiplashRound()
  }

  private async beginQuiplashRound() {
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
    this.fibbage = null
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
    if (this.gameType === "fibbage") return this.onFibbageSubmit(playerId, answer)
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
    if (this.gameType === "fibbage") return this.finishFibbageWriting()
    if (this.phase !== "writing" || !this.matchup) return
    if (!this.matchup.answers[0]) this.matchup.answers[0] = NO_ANSWER_TEXT
    if (!this.matchup.answers[1]) this.matchup.answers[1] = NO_ANSWER_TEXT
    this.phase = "voting"
    this.phaseEndsAt = Date.now() + VOTING_SECONDS * 1000
    await this.persist()
    this.broadcastState()
  }

  private async onVote(playerId: string, choice: 0 | 1 | string) {
    if (this.gameType === "fibbage") {
      if (typeof choice === "string") await this.onFibbageVote(playerId, choice)
      return
    }
    if (choice !== 0 && choice !== 1) return
    if (this.phase !== "voting" || !this.matchup) return
    if (this.matchup.authors.includes(playerId)) return
    if (this.matchup.votes[playerId] !== undefined) return
    this.matchup.votes[playerId] = choice
    await this.maybeReveal()
  }

  private async maybeReveal() {
    if (this.gameType === "fibbage") return this.maybeFibbageReveal()
    if (!this.matchup) return
    const eligible = this.connectedPlayerIds().filter((id) => !this.matchup!.authors.includes(id))
    if (eligible.every((id) => id in this.matchup!.votes)) {
      await this.reveal()
      return
    }
    await this.persist()
    this.broadcastState()
  }

  private async reveal() {
    if (this.gameType === "fibbage") return this.revealFibbage()
    if (!this.matchup) return
    let v0 = 0
    let v1 = 0
    for (const c of Object.values(this.matchup.votes)) {
      if (c === 0) v0++
      else v1++
    }
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
      if (this.gameType === "fibbage") await this.beginFibbageRound()
      else await this.beginQuiplashRound()
    }
  }

  private async startFibbage() {
    const questions = pickFibbageQuestions(PROMPTS_PER_GAME)
    this.prompts = questions.map((q) => q.question)
    this.fibbageTruths = questions.map((q) => q.truth)
    this.promptIdx = 0
    this.matchup = null
    for (const id of this.players.keys()) this.scores.set(id, 0)
    await this.beginFibbageRound()
  }

  private async beginFibbageRound() {
    const question = this.prompts[this.promptIdx]
    const truth = this.fibbageTruths[this.promptIdx]
    if (!question || !truth) return this.endGame()
    this.matchup = null
    this.fibbage = { question, truth, lies: {}, choices: [], votes: {}, revealed: false }
    this.phase = "writing"
    this.phaseEndsAt = Date.now() + WRITING_SECONDS * 1000
    await this.persist()
    this.broadcastState()
  }

  private async onFibbageSubmit(playerId: string, answer: string) {
    if (this.phase !== "writing" || !this.fibbage) return
    if (this.fibbage.lies[playerId]) return
    this.fibbage.lies[playerId] = answer.slice(0, 80)
    const eligible = this.connectedPlayerIds()
    if (eligible.length > 0 && eligible.every((id) => this.fibbage!.lies[id])) {
      await this.finishFibbageWriting()
      return
    }
    await this.persist()
    this.broadcastState()
  }

  private async finishFibbageWriting() {
    if (this.phase !== "writing" || !this.fibbage) return
    for (const id of this.connectedPlayerIds()) {
      if (!this.fibbage.lies[id]) this.fibbage.lies[id] = NO_ANSWER_TEXT
    }
    const choices: FibbageChoice[] = [
      { id: "truth", text: this.fibbage.truth, authorId: null, isTruth: true },
      ...Object.entries(this.fibbage.lies).map(([authorId, text]) => ({
        id: `lie:${authorId}`,
        text,
        authorId,
        isTruth: false,
      })),
    ]
    this.fibbage.choices = this.shuffle(choices)
    this.phase = "voting"
    this.phaseEndsAt = Date.now() + VOTING_SECONDS * 1000
    await this.persist()
    this.broadcastState()
  }

  private async onFibbageVote(playerId: string, choiceId: string) {
    if (this.phase !== "voting" || !this.fibbage) return
    if (this.fibbage.votes[playerId] !== undefined) return
    const choice = this.fibbage.choices.find((c) => c.id === choiceId)
    if (!choice || choice.authorId === playerId) return
    this.fibbage.votes[playerId] = choiceId
    await this.maybeFibbageReveal()
  }

  private async maybeFibbageReveal() {
    if (!this.fibbage) return
    const eligible = this.connectedPlayerIds()
    if (eligible.every((id) => this.fibbage!.votes[id] !== undefined)) {
      await this.revealFibbage()
      return
    }
    await this.persist()
    this.broadcastState()
  }

  private async revealFibbage() {
    if (!this.fibbage) return
    for (const [voterId, choiceId] of Object.entries(this.fibbage.votes)) {
      const choice = this.fibbage.choices.find((c) => c.id === choiceId)
      if (!choice) continue
      if (choice.isTruth) {
        this.scores.set(voterId, (this.scores.get(voterId) ?? 0) + 1000)
      } else if (choice.authorId) {
        this.scores.set(choice.authorId, (this.scores.get(choice.authorId) ?? 0) + 500)
      }
    }
    this.fibbage.revealed = true
    this.phase = "reveal"
    this.phaseEndsAt = null
    await this.persist()
    this.broadcastState()
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
      gameType: this.gameType,
      players: [...this.players.values()],
      connectedPlayerIds: this.connectedPlayerIds(),
      scores: Object.fromEntries(this.scores),
      round: this.phase === "lobby" ? 0 : this.promptIdx + 1,
      totalRounds: this.prompts.length || PROMPTS_PER_GAME,
      phaseEndsAt: this.phaseEndsAt,
      matchup: visibleMatchupFor({ matchup: this.matchup, phase: this.phase, viewer }),
      fibbage: visibleFibbageFor({ round: this.fibbage, phase: this.phase, viewer }),
    }
  }

  private shuffle<T>(items: T[]) {
    const out = [...items]
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = out[i]!
      out[i] = out[j]!
      out[j] = tmp
    }
    return out
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
