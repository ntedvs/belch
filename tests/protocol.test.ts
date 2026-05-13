import { describe, expect, test } from "bun:test"
import {
  ANSWER_MAX_LEN,
  chooseAuthorPair,
  ClientMessage,
  FibbageRound,
  generateRoomCode,
  GameState,
  type Matchup,
  PersistedRoomState,
  PLAYER_COLORS,
  RoomCode,
  storageKeys,
  visibleFibbageFor,
  visibleMatchupFor,
} from "../packages/protocol/src/index"

const playerId = "00000000-0000-4000-8000-000000000001"
const otherPlayerId = "00000000-0000-4000-8000-000000000002"
const thirdPlayerId = "00000000-0000-4000-8000-000000000003"
const token = "00000000-0000-4000-8000-000000000003"

describe("protocol validation", () => {
  test("rejects oversized hello names", () => {
    const parsed = ClientMessage.safeParse({
      t: "hello",
      role: "guest",
      name: "x".repeat(21),
    })

    expect(parsed.success).toBe(false)
  })

  test("accepts only four-letter room codes without ambiguous letters", () => {
    expect(RoomCode.safeParse("ABCD").success).toBe(true)
    expect(RoomCode.safeParse("ABC1").success).toBe(false)
    expect(RoomCode.safeParse("ABCO").success).toBe(false)
    expect(RoomCode.safeParse("ABCDE").success).toBe(false)
  })

  test("generates valid four-letter room codes", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateRoomCode()

      expect(code).toHaveLength(4)
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ]+$/)
      expect(RoomCode.safeParse(code).success).toBe(true)
    }
  })

  test("rejects malformed reconnect credentials", () => {
    const parsed = ClientMessage.safeParse({
      t: "hello",
      role: "guest",
      name: "Nate",
      playerId: "not-a-uuid",
      playerToken: token,
    })

    expect(parsed.success).toBe(false)
  })

  test("rejects oversized answers", () => {
    const parsed = ClientMessage.safeParse({
      t: "submit",
      answer: "x".repeat(ANSWER_MAX_LEN + 1),
    })

    expect(parsed.success).toBe(false)
  })

  test("accepts game states with connected player ids", () => {
    const parsed = GameState.safeParse({
      phase: "lobby",
      gameType: "quiplash",
      players: [{ id: playerId, name: "Nate", color: PLAYER_COLORS[0] }],
      connectedPlayerIds: [playerId],
      scores: { [playerId]: 0 },
      round: 0,
      totalRounds: 5,
      phaseEndsAt: null,
      matchup: null,
      fibbage: null,
    })

    expect(parsed.success).toBe(true)
  })

  test("rejects corrupt persisted room state", () => {
    const parsed = PersistedRoomState.safeParse({
      hostToken: token,
      playerTokens: [[playerId, token]],
      players: [[playerId, { id: playerId, name: "Nate", color: PLAYER_COLORS[0] }]],
      scores: [[playerId, -100]],
      prompts: ["Prompt"],
      fibbageTruths: [],
      promptIdx: 0,
      matchup: null,
      fibbage: null,
      phaseEndsAt: null,
      phase: "lobby",
    })

    expect(parsed.success).toBe(false)
  })

  test("accepts persisted room state with a matchup", () => {
    const parsed = PersistedRoomState.safeParse({
      hostToken: token,
      playerTokens: [[playerId, token]],
      players: [
        [playerId, { id: playerId, name: "Nate", color: PLAYER_COLORS[0] }],
        [otherPlayerId, { id: otherPlayerId, name: "Sam", color: PLAYER_COLORS[1] }],
      ],
      scores: [
        [playerId, 0],
        [otherPlayerId, 0],
      ],
      authorCounts: [
        [playerId, 1],
        [otherPlayerId, 1],
      ],
      prompts: ["Prompt"],
      fibbageTruths: [],
      promptIdx: 0,
      matchup: {
        prompt: "Prompt",
        authors: [playerId, otherPlayerId],
        answers: ["A", null],
        votes: {},
        revealed: false,
      },
      fibbage: null,
      phaseEndsAt: Date.now() + 60_000,
      phase: "writing",
    })

    expect(parsed.success).toBe(true)
  })

  test("accepts string vote choices for multi-choice games", () => {
    const parsed = ClientMessage.safeParse({ t: "vote", choice: "truth" })

    expect(parsed.success).toBe(true)
  })
})

describe("author pair selection", () => {
  test("avoids repeating the previous pair when another pair is available", () => {
    const pair = chooseAuthorPair({
      playerIds: [playerId, otherPlayerId, thirdPlayerId],
      authorCounts: new Map([
        [playerId, 1],
        [otherPlayerId, 1],
        [thirdPlayerId, 1],
      ]),
      previousPair: [playerId, otherPlayerId],
      random: () => 0,
    })

    expect(pair).not.toBeNull()
    expect(pair).not.toEqual([playerId, otherPlayerId])
    expect(new Set(pair!).size).toBe(2)
  })

  test("chooses the pair with the lowest combined author count", () => {
    const pair = chooseAuthorPair({
      playerIds: [playerId, otherPlayerId, thirdPlayerId],
      authorCounts: new Map([
        [playerId, 4],
        [otherPlayerId, 1],
        [thirdPlayerId, 0],
      ]),
      random: () => 0,
    })

    expect(new Set(pair)).toEqual(new Set([otherPlayerId, thirdPlayerId]))
  })

  test("keeps appearances balanced over five rounds with three players", () => {
    const ids = [playerId, otherPlayerId, thirdPlayerId]
    const counts = new Map(ids.map((id) => [id, 0]))
    let previousPair: [string, string] | null = null

    for (let round = 0; round < 5; round++) {
      const pair = chooseAuthorPair({
        playerIds: ids,
        authorCounts: counts,
        previousPair,
        random: () => 0,
      })!
      for (const id of pair) counts.set(id, counts.get(id)! + 1)
      previousPair = pair
    }

    const appearances = [...counts.values()]
    expect(Math.max(...appearances) - Math.min(...appearances)).toBeLessThanOrEqual(1)
  })
})

describe("matchup redaction", () => {
  const matchup: Matchup = {
    prompt: "Prompt",
    authors: [playerId, otherPlayerId],
    answers: ["A secret", "B secret"],
    votes: { [thirdPlayerId]: 0 },
    revealed: false,
  }

  test("hides submitted writing answers from non-authors", () => {
    const visible = visibleMatchupFor({
      matchup,
      phase: "writing",
      viewer: { playerId: thirdPlayerId },
    })

    expect(visible?.answers).toEqual(["(submitted)", "(submitted)"])
    expect(visible?.votes).toEqual({})
  })

  test("lets an author see only their own writing answer", () => {
    const visible = visibleMatchupFor({
      matchup,
      phase: "writing",
      viewer: { playerId },
    })

    expect(visible?.answers).toEqual(["A secret", "(submitted)"])
  })

  test("hides other vote totals during voting but preserves the viewer's own vote", () => {
    const visible = visibleMatchupFor({
      matchup,
      phase: "voting",
      viewer: { playerId: thirdPlayerId },
    })

    expect(visible?.answers).toEqual(["A secret", "B secret"])
    expect(visible?.votes).toEqual({ [thirdPlayerId]: 0 })
  })

  test("lets the host count votes during voting", () => {
    const visible = visibleMatchupFor({
      matchup,
      phase: "voting",
      viewer: { role: "host" },
    })

    expect(visible?.votes).toEqual({ [thirdPlayerId]: 0 })
  })

  test("shows answers and votes after reveal", () => {
    const visible = visibleMatchupFor({ matchup, phase: "reveal" })

    expect(visible).toEqual(matchup)
  })
})

describe("fibbage redaction", () => {
  const round: FibbageRound = {
    question: "A strange question",
    truth: "real answer",
    lies: { [playerId]: "fake answer" },
    choices: [
      { id: "truth", text: "real answer", authorId: null, isTruth: true },
      { id: `lie:${playerId}`, text: "fake answer", authorId: playerId, isTruth: false },
    ],
    votes: { [otherPlayerId]: "truth" },
    revealed: false,
  }

  test("hides truth and other lies during writing", () => {
    const visible = visibleFibbageFor({
      round,
      phase: "writing",
      viewer: { playerId: otherPlayerId },
    })

    expect(visible?.truth).toBe("")
    expect(visible?.lies).toEqual({})
    expect(visible?.choices).toEqual([])
  })

  test("lets the host count submitted lies during writing", () => {
    const visible = visibleFibbageFor({
      round,
      phase: "writing",
      viewer: { role: "host" },
    })

    expect(visible?.truth).toBe("")
    expect(visible?.lies).toEqual({ [playerId]: "fake answer" })
  })

  test("hides which voting choice is true until reveal", () => {
    const visible = visibleFibbageFor({
      round,
      phase: "voting",
      viewer: { playerId: otherPlayerId },
    })

    expect(visible?.choices.map((choice) => choice.isTruth)).toEqual([false, false])
    expect(visible?.votes).toEqual({ [otherPlayerId]: "truth" })
  })

  test("lets the host count votes without revealing the truth during voting", () => {
    const visible = visibleFibbageFor({
      round,
      phase: "voting",
      viewer: { role: "host" },
    })

    expect(visible?.choices.map((choice) => choice.isTruth)).toEqual([false, false])
    expect(visible?.truth).toBe("")
    expect(visible?.votes).toEqual({ [otherPlayerId]: "truth" })
  })

  test("shows truth and authors after reveal", () => {
    const visible = visibleFibbageFor({ round, phase: "reveal" })

    expect(visible).toEqual(round)
  })
})

describe("storage keys", () => {
  test("scopes player names by room code", () => {
    expect(storageKeys.playerName("ABCD")).toBe("belch:name:ABCD")
    expect(storageKeys.playerName("WXYZ")).toBe("belch:name:WXYZ")
    expect(storageKeys.playerName("ABCD")).not.toBe(storageKeys.playerName("WXYZ"))
  })

  test("keeps reconnect keys scoped by room code", () => {
    expect(storageKeys.playerId("ABCD")).toBe("belch:pid:ABCD")
    expect(storageKeys.playerToken("ABCD")).toBe("belch:ptoken:ABCD")
    expect(storageKeys.hostToken("ABCD")).toBe("belch:host:ABCD")
  })
})
