import { z } from "zod"

export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"
export const ROOM_CODE_LENGTH = 4

export function generateRoomCode(): string {
  let code = ""
  const bytes = new Uint8Array(ROOM_CODE_LENGTH)
  crypto.getRandomValues(bytes)
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[bytes[i]! % ROOM_CODE_ALPHABET.length]
  }
  return code
}

export const RoomCode = z
  .string()
  .length(ROOM_CODE_LENGTH)
  .regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ]+$/)

export const Player = z.object({
  id: z.string(),
  name: z.string().min(1).max(20),
  color: z.string(),
})
export type Player = z.infer<typeof Player>

export const PROMPTS_PER_GAME = 5
export const ANSWER_MAX_LEN = 80
export const WRITING_SECONDS = 60
export const VOTING_SECONDS = 45
export const POINTS_PER_VOTE = 100
export const POINTS_FOR_SHUTOUT = 250

export const PlayerId = z.string().uuid()
export const PlayerToken = z.string().uuid()
export const HostToken = z.string().uuid()
export const PlayerName = z.string().min(1).max(20)

export type Phase = "lobby" | "writing" | "voting" | "reveal" | "final"
export const Phase = z.enum(["lobby", "writing", "voting", "reveal", "final"])

export const Matchup = z.object({
  prompt: z.string(),
  authors: z.tuple([PlayerId, PlayerId]),
  answers: z.tuple([
    z.string().max(ANSWER_MAX_LEN).nullable(),
    z.string().max(ANSWER_MAX_LEN).nullable(),
  ]),
  votes: z.record(PlayerId, z.union([z.literal(0), z.literal(1)])),
  revealed: z.boolean(),
})
export type Matchup = z.infer<typeof Matchup>

export type AuthorPair = [string, string]

export function chooseAuthorPair(args: {
  playerIds: string[]
  authorCounts: ReadonlyMap<string, number>
  previousPair?: AuthorPair | null
  random?: () => number
}): AuthorPair | null {
  const { playerIds, authorCounts, previousPair = null, random = Math.random } = args
  if (playerIds.length < 2) return null

  const pairs = shuffle(allPairs(playerIds), random)
  const nonRepeatPairs = previousPair
    ? pairs.filter((pair) => !samePair(pair, previousPair))
    : pairs
  const candidates = nonRepeatPairs.length > 0 ? nonRepeatPairs : pairs
  candidates.sort((a, b) => pairWeight(a, authorCounts) - pairWeight(b, authorCounts))
  return candidates[0] ?? null
}

export function visibleMatchupFor(args: {
  matchup: Matchup | null
  phase: Phase
  viewer?: { playerId?: string }
}): Matchup | null {
  const { matchup, phase, viewer } = args
  if (!matchup) return null
  if (phase === "reveal" || phase === "final") return matchup

  const answers: Matchup["answers"] = [...matchup.answers]
  const votes: Matchup["votes"] = {}

  if (phase === "writing") {
    for (const idx of [0, 1] as const) {
      const answer = matchup.answers[idx]
      const isAuthor = viewer?.playerId === matchup.authors[idx]
      answers[idx] = answer && !isAuthor ? "(submitted)" : answer
    }
  }

  if (phase === "voting" && viewer?.playerId && matchup.votes[viewer.playerId] !== undefined) {
    votes[viewer.playerId] = matchup.votes[viewer.playerId]!
  }

  return { ...matchup, answers, votes }
}

export const storageKeys = {
  playerId: (code: string) => `belch:pid:${code}`,
  playerToken: (code: string) => `belch:ptoken:${code}`,
  hostToken: (code: string) => `belch:host:${code}`,
  playerName: (code: string) => `belch:name:${code}`,
} as const

function allPairs(ids: string[]): AuthorPair[] {
  const pairs: AuthorPair[] = []
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      pairs.push([ids[i]!, ids[j]!])
    }
  }
  return pairs
}

function pairWeight([a, b]: AuthorPair, authorCounts: ReadonlyMap<string, number>) {
  return (authorCounts.get(a) ?? 0) + (authorCounts.get(b) ?? 0)
}

function samePair(a: AuthorPair, b: AuthorPair) {
  return a.includes(b[0]) && a.includes(b[1])
}

function shuffle<T>(items: T[], random: () => number) {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

export const GameState = z.object({
  phase: Phase,
  players: z.array(Player),
  connectedPlayerIds: z.array(PlayerId),
  scores: z.record(PlayerId, z.number().int().nonnegative()),
  round: z.number().int().nonnegative(),
  totalRounds: z.number().int().nonnegative(),
  phaseEndsAt: z.number().int().nonnegative().nullable(),
  matchup: Matchup.nullable(),
})
export type GameState = z.infer<typeof GameState>

export const PersistedRoomState = z.object({
  created: z.boolean().optional(),
  hostToken: HostToken.nullable(),
  playerTokens: z.array(z.tuple([PlayerId, PlayerToken])),
  players: z.array(z.tuple([PlayerId, Player])),
  scores: z.array(z.tuple([PlayerId, z.number().int().nonnegative()])),
  authorCounts: z.array(z.tuple([PlayerId, z.number().int().nonnegative()])).optional(),
  prompts: z.array(z.string()),
  promptIdx: z.number().int().nonnegative(),
  matchup: Matchup.nullable(),
  phaseEndsAt: z.number().int().nonnegative().nullable().optional(),
  phase: Phase,
})
export type PersistedRoomState = z.infer<typeof PersistedRoomState>

// Client -> Server
export const ClientMessage = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    role: z.enum(["host", "guest"]),
    name: PlayerName.optional(),
    playerId: PlayerId.optional(),
    playerToken: PlayerToken.optional(),
  }),
  z.object({ t: z.literal("start") }),
  z.object({ t: z.literal("submit"), answer: z.string().min(1).max(ANSWER_MAX_LEN) }),
  z.object({ t: z.literal("vote"), choice: z.union([z.literal(0), z.literal(1)]) }),
  z.object({ t: z.literal("next") }),
  z.object({ t: z.literal("ping") }),
])
export type ClientMessage = z.infer<typeof ClientMessage>

// Server -> Client
export const ServerMessage = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("welcome"),
    you: Player.optional(),
    playerToken: z.string().optional(),
    state: GameState,
  }),
  z.object({ t: z.literal("state"), state: GameState }),
  z.object({ t: z.literal("error"), message: z.string() }),
  z.object({ t: z.literal("pong") }),
])
export type ServerMessage = z.infer<typeof ServerMessage>

export const PLAYER_COLORS = [
  "#FF6B6B",
  "#4ECDC4",
  "#FFE66D",
  "#A78BFA",
  "#FB923C",
  "#34D399",
  "#F472B6",
  "#60A5FA",
]
