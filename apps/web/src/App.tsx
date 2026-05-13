import {
  type FibbageChoice,
  type GameState,
  type GameType,
  type Player,
  ROOM_CODE_LENGTH,
  ServerMessage,
  storageKeys,
} from "@belch/protocol"
import QRCode from "qrcode"
import { createEffect, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"

type Route = { kind: "landing" } | { kind: "guest"; code: string } | { kind: "host"; code: string }

function parseRoute(path: string): Route {
  const m = path.match(new RegExp(`^/([A-HJ-NP-Z]{${ROOM_CODE_LENGTH}})(/host)?/?$`, "i"))
  if (m) {
    const code = m[1]!.toUpperCase()
    return m[2] ? { kind: "host", code } : { kind: "guest", code }
  }
  return { kind: "landing" }
}

function navigate(path: string) {
  history.pushState(null, "", path)
  setRoute(parseRoute(path))
}

const [route, setRoute] = createSignal<Route>(parseRoute(location.pathname))
const [me, setMe] = createSignal<Player | null>(null)
const [gs, setGs] = createSignal<GameState | null>(null)
const [mySubmitted, setMySubmitted] = createSignal(false)
const [myVoted, setMyVoted] = createSignal(false)
const [connected, setConnected] = createSignal(false)
const [now, setNow] = createSignal(Date.now())

let ws: WebSocket | null = null

window.addEventListener("popstate", () => {
  closeSocket()
  setRoute(parseRoute(location.pathname))
  bootRoute()
})

function closeSocket() {
  if (ws) {
    ws.onclose = null
    ws.close()
    ws = null
  }
  setConnected(false)
  setMe(null)
  setGs(null)
  setMySubmitted(false)
  setMyVoted(false)
}

function pidKey(code: string) {
  return storageKeys.playerId(code)
}

function playerTokenKey(code: string) {
  return storageKeys.playerToken(code)
}

function hostTokenKey(code: string) {
  return storageKeys.hostToken(code)
}

function playerNameKey(code: string) {
  return storageKeys.playerName(code)
}

function connect(code: string, role: "host" | "guest", name?: string) {
  closeSocket()
  const proto = location.protocol === "https:" ? "wss" : "ws"
  const params = new URLSearchParams({ role })
  if (role === "host") {
    const hostToken = localStorage.getItem(hostTokenKey(code))
    if (!hostToken) {
      alert("Missing host credentials for this room.")
      navigate("/")
      return
    }
    if (hostToken) params.set("hostToken", hostToken)
  }
  const socket = new WebSocket(`${proto}://${location.host}/ws/${code}?${params}`)
  ws = socket
  setConnected(true)
  let opened = false
  const playerId = role === "guest" ? localStorage.getItem(pidKey(code)) || undefined : undefined
  const playerToken =
    role === "guest" ? localStorage.getItem(playerTokenKey(code)) || undefined : undefined

  socket.onopen = () => {
    opened = true
    socket.send(
      JSON.stringify({ t: "hello", role, name: name || undefined, playerId, playerToken }),
    )
  }

  socket.onmessage = (e) => {
    const data = (() => {
      try {
        return JSON.parse(e.data)
      } catch {
        return null
      }
    })()
    const parsed = ServerMessage.safeParse(data)
    if (!parsed.success) return
    const msg = parsed.data
    if (msg.t === "welcome") {
      if (msg.you) {
        setMe(msg.you)
        localStorage.setItem(pidKey(code), msg.you.id)
        if (msg.playerToken) localStorage.setItem(playerTokenKey(code), msg.playerToken)
      }
      setGs(msg.state)
    } else if (msg.t === "state") {
      const prev = gs()
      if (prev?.phase !== msg.state.phase) {
        setMySubmitted(false)
        setMyVoted(false)
      }
      setGs(msg.state)
    } else if (msg.t === "error") {
      // Stale playerId or game already started — drop saved id, send back to landing.
      localStorage.removeItem(pidKey(code))
      localStorage.removeItem(playerTokenKey(code))
      alert(msg.message)
      closeSocket()
      navigate("/")
    }
  }

  socket.onclose = () => {
    if (ws !== socket) return
    ws = null
    setConnected(false)
    if (!opened) {
      if (role === "host") localStorage.removeItem(hostTokenKey(code))
      alert(
        role === "host"
          ? "Could not reconnect to that host room."
          : "Could not connect to that room.",
      )
      navigate("/")
      return
    }
    // Auto-reconnect after a brief delay (network blips, phone sleep)
    setTimeout(() => {
      const r = route()
      if (r.kind === "guest" && r.code === code)
        connect(code, "guest", localStorage.getItem(playerNameKey(code)) ?? undefined)
      if (r.kind === "host" && r.code === code) connect(code, "host")
    }, 1000)
  }
}

async function startHost() {
  const res = await fetch("/api/room", { method: "POST" })
  if (!res.ok) {
    alert("Could not create a room. Try again.")
    return
  }
  const { code, hostToken } = await res.json()
  localStorage.setItem(hostTokenKey(code), hostToken)
  navigate(`/${code}/host`)
  connect(code, "host")
}

function joinGuest(code: string, name: string) {
  localStorage.setItem(playerNameKey(code), name)
  navigate(`/${code}`)
  connect(code, "guest", name)
}

function bootRoute() {
  const r = route()
  if (r.kind === "host") {
    connect(r.code, "host")
  } else if (r.kind === "guest") {
    const savedName = localStorage.getItem(playerNameKey(r.code)) || ""
    const savedPid = localStorage.getItem(pidKey(r.code))
    const savedToken = localStorage.getItem(playerTokenKey(r.code))
    if (savedName || (savedPid && savedToken)) connect(r.code, "guest", savedName)
  }
}

function send(msg: object) {
  ws?.send(JSON.stringify(msg))
}

function leave() {
  const code = (route() as { code?: string }).code
  if (code) localStorage.removeItem(pidKey(code))
  if (code) localStorage.removeItem(playerTokenKey(code))
  closeSocket()
  navigate("/")
}

export function App() {
  onMount(() => {
    bootRoute()
    const timer = setInterval(() => setNow(Date.now()), 250)
    onCleanup(() => clearInterval(timer))
  })
  return (
    <Switch>
      <Match when={route().kind === "landing"}>
        <Landing />
      </Match>
      <Match when={route().kind === "host"}>
        <HostView />
      </Match>
      <Match when={route().kind === "guest"}>
        <GuestRoute />
      </Match>
    </Switch>
  )
}

// ---------- Landing ----------

function Landing() {
  let codeInput!: HTMLInputElement
  let nameInput!: HTMLInputElement
  return (
    <main class="grid min-h-screen place-items-center p-6">
      <div class="grid w-full max-w-sm gap-5 text-center">
        <h1
          class="display m-0 text-primary"
          style={{
            "font-size": "clamp(3.5rem,15vw,7rem)",
            "text-shadow": "0 8px 0 var(--color-ink)",
          }}
        >
          BELCH
        </h1>
        <p class="m-0 mb-2 opacity-80">party games — your phone is the controller</p>
        <button class="belch-btn" onClick={startHost}>
          Host a Game
        </button>
        <div class="display opacity-60">— or —</div>
        <form
          class="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            const c = codeInput.value.toUpperCase().trim()
            const n = nameInput.value.trim()
            if (c.length === ROOM_CODE_LENGTH && n) joinGuest(c, n)
          }}
        >
          <input
            ref={codeInput}
            class="belch-input"
            placeholder="ROOM"
            maxLength={ROOM_CODE_LENGTH}
            autocapitalize="characters"
            autocomplete="off"
            autocorrect="off"
            spellcheck={false}
            inputmode="text"
            name="belch-room"
          />
          <input
            ref={nameInput}
            class="belch-input"
            placeholder="NAME"
            maxLength={20}
            autocomplete="off"
          />
          <button class="belch-btn !bg-accent" type="submit">
            Join
          </button>
        </form>
      </div>
    </main>
  )
}

function GamePick(props: { gameType: GameType; active: boolean }) {
  return (
    <button
      type="button"
      class={`rounded-2xl border-4 border-ink px-4 py-3 text-ink ${
        props.active ? "bg-primary" : "bg-paper"
      }`}
      style={{ "box-shadow": "0 4px 0 var(--color-ink)", "font-family": "var(--font-display)" }}
      onClick={() => send({ t: "setGame", gameType: props.gameType })}
    >
      {gameName(props.gameType)}
    </button>
  )
}

// ---------- Guest route (name entry vs game) ----------

function GuestRoute() {
  const code = () => (route() as { code: string }).code
  return (
    <Show when={connected()} fallback={<NameEntry code={code()} />}>
      <GuestView />
    </Show>
  )
}

function NameEntry(props: { code: string }) {
  let nameInput!: HTMLInputElement
  return (
    <main class="grid min-h-screen place-items-center p-6">
      <form
        class="grid w-full max-w-sm gap-4 text-center"
        onSubmit={(e) => {
          e.preventDefault()
          const n = nameInput.value.trim()
          if (!n) return
          localStorage.setItem(playerNameKey(props.code), n)
          connect(props.code, "guest", n)
        }}
      >
        <h1 class="display m-0 text-primary text-5xl">{props.code}</h1>
        <p class="opacity-80">what's your name?</p>
        <input
          ref={nameInput}
          class="belch-input"
          placeholder="NAME"
          maxLength={20}
          autocomplete="off"
          autofocus
          value={localStorage.getItem(playerNameKey(props.code)) ?? ""}
        />
        <button class="belch-btn !bg-accent" type="submit">
          Join
        </button>
        <button class="belch-btn !bg-paper !text-ink" type="button" onClick={leave}>
          Cancel
        </button>
      </form>
    </main>
  )
}

// ---------- Host ----------

function HostView() {
  const code = () => (route() as { code: string }).code
  return (
    <Show when={gs()} fallback={<Blank text="connecting…" />}>
      <Switch>
        <Match when={gs()!.phase === "lobby"}>
          <HostLobby code={code()} />
        </Match>
        <Match when={gs()!.phase === "writing"}>
          <Show when={gs()!.gameType === "fibbage"} fallback={<HostWriting code={code()} />}>
            <HostFibbageWriting code={code()} />
          </Show>
        </Match>
        <Match when={gs()!.phase === "voting"}>
          <Show when={gs()!.gameType === "fibbage"} fallback={<HostVoting code={code()} />}>
            <HostFibbageVoting code={code()} />
          </Show>
        </Match>
        <Match when={gs()!.phase === "reveal"}>
          <Show when={gs()!.gameType === "fibbage"} fallback={<HostReveal code={code()} />}>
            <HostFibbageReveal code={code()} />
          </Show>
        </Match>
        <Match when={gs()!.phase === "final"}>
          <HostFinal />
        </Match>
      </Switch>
    </Show>
  )
}

function HostLobby(props: { code: string }) {
  const players = () => gs()!.players
  const joinUrl = () => `${location.host}/${props.code}`
  const joinHref = () => `${location.origin}/${props.code}`
  const [qrSrc, setQrSrc] = createSignal<string | null>(null)

  createEffect(() => {
    QRCode.toDataURL(joinHref(), {
      errorCorrectionLevel: "M",
      margin: 1,
      scale: 8,
      color: {
        dark: "#0F0A2A",
        light: "#FFF8E7",
      },
    })
      .then(setQrSrc)
      .catch(() => setQrSrc(null))
  })

  return (
    <main class="grid h-screen grid-rows-[auto_1fr_auto] gap-8 p-8">
      <header class="grid gap-4 text-center">
        <div class="grid items-center gap-6 md:grid-cols-[1fr_auto_1fr]">
          <div>
            <div class="display text-2xl opacity-70">JOIN AT</div>
            <div class="display text-accent" style={{ "font-size": "clamp(1.4rem,3vw,2.6rem)" }}>
              {joinUrl()}
            </div>
          </div>
          <Show when={qrSrc()}>
            {(src) => (
              <img
                class="mx-auto h-36 w-36 rounded-2xl border-4 border-ink bg-paper p-2 shadow-[0_6px_0_var(--color-ink)]"
                src={src()}
                alt={`QR code for ${joinUrl()}`}
              />
            )}
          </Show>
          <div>
            <div class="display text-2xl opacity-70">OR ENTER CODE</div>
            <div class="belch-code" style={{ "font-size": "clamp(4rem,10vw,8rem)" }}>
              {props.code}
            </div>
            <div class="display mt-2 text-xl opacity-70">{gameName(gs()!.gameType)}</div>
          </div>
        </div>
      </header>
      <section class="flex flex-wrap content-start justify-center gap-4">
        <Show
          when={players().length > 0}
          fallback={<div class="text-2xl opacity-60">waiting for players…</div>}
        >
          <For each={players()}>{(p) => <PlayerTile player={p} />}</For>
        </Show>
      </section>
      <footer class="grid justify-items-center gap-4 text-center">
        <GamePicker />
        <button
          class="belch-btn"
          disabled={players().length < 3}
          onClick={() => send({ t: "start" })}
        >
          {players().length < 3 ? `Need ${3 - players().length} more` : "Start"}
        </button>
      </footer>
    </main>
  )
}

function GamePicker() {
  return (
    <div class="grid w-full max-w-sm grid-cols-2 gap-3">
      <GamePick gameType="quiplash" active={gs()!.gameType === "quiplash"} />
      <GamePick gameType="fibbage" active={gs()!.gameType === "fibbage"} />
    </div>
  )
}

function HostFibbageWriting(props: { code: string }) {
  const f = () => gs()!.fibbage!
  const submitted = () => Object.keys(f().lies).length
  return (
    <main class="grid h-screen grid-rows-[auto_1fr] gap-8 p-8 text-center">
      <RoundHeader code={props.code} />
      <section class="grid place-items-center gap-8">
        <Countdown />
        <h2
          class="display max-w-[22ch] text-primary leading-tight"
          style={{ "font-size": "clamp(2rem,5vw,4rem)" }}
        >
          {f().question}
        </h2>
        <div class="opacity-70">
          {submitted()}/{gs()!.connectedPlayerIds.length} lies in
        </div>
      </section>
    </main>
  )
}

function HostFibbageVoting(props: { code: string }) {
  const f = () => gs()!.fibbage!
  const voted = () => Object.keys(f().votes).length
  return (
    <main class="grid h-screen grid-rows-[auto_1fr_auto] gap-8 p-8 text-center">
      <RoundHeader code={props.code} />
      <section class="grid content-center gap-8">
        <h2
          class="display mx-auto max-w-[24ch] text-primary leading-tight"
          style={{ "font-size": "clamp(1.8rem,4vw,3rem)" }}
        >
          {f().question}
        </h2>
        <div class="mx-auto grid w-full max-w-[1200px] grid-cols-2 gap-5">
          <For each={f().choices}>{(choice, i) => <AnswerCard text={choice.text} idx={i()} />}</For>
        </div>
      </section>
      <footer class="opacity-70">
        {voted()}/{gs()!.connectedPlayerIds.length} votes in
      </footer>
    </main>
  )
}

function HostFibbageReveal(props: { code: string }) {
  const f = () => gs()!.fibbage!
  const votesFor = (id: string) => Object.values(f().votes).filter((v) => v === id).length
  return (
    <main class="grid h-screen grid-rows-[auto_1fr_auto] gap-8 p-8 text-center">
      <RoundHeader code={props.code} />
      <section class="grid content-center gap-6">
        <h2 class="display mx-auto max-w-[24ch] text-primary text-4xl leading-tight">
          {f().question}
        </h2>
        <div class="mx-auto grid w-full max-w-[1200px] grid-cols-2 gap-5">
          <For each={f().choices}>
            {(choice) => <FibbageRevealCard choice={choice} votes={votesFor(choice.id)} />}
          </For>
        </div>
      </section>
      <footer>
        <button class="belch-btn" onClick={() => send({ t: "next" })}>
          {gs()!.round >= gs()!.totalRounds ? "Finish" : "Next Round"}
        </button>
      </footer>
    </main>
  )
}

function HostWriting(props: { code: string }) {
  const m = () => gs()!.matchup!
  const authors = () =>
    m()
      .authors.map((id) => gs()!.players.find((p) => p.id === id)!)
      .filter(Boolean)
  const submitted = () => m().answers.filter(Boolean).length
  return (
    <main class="grid h-screen grid-rows-[auto_1fr] gap-8 p-8 text-center">
      <RoundHeader code={props.code} />
      <section class="grid place-items-center gap-8">
        <Countdown />
        <h2
          class="display max-w-[18ch] text-primary leading-tight"
          style={{ "font-size": "clamp(2rem,5vw,4rem)" }}
        >
          {m().prompt}
        </h2>
        <div class="flex flex-wrap justify-center gap-6">
          <For each={authors()}>
            {(p) => (
              <PlayerTile player={p} badge={m().answers[m().authors.indexOf(p.id)] ? "✓" : "…"} />
            )}
          </For>
        </div>
        <div class="opacity-60">{submitted()}/2 answers in</div>
      </section>
    </main>
  )
}

function HostVoting(props: { code: string }) {
  const m = () => gs()!.matchup!
  const voted = () => Object.keys(m().votes).length
  const eligible = () => gs()!.connectedPlayerIds.filter((id) => !m().authors.includes(id)).length
  return (
    <main class="grid h-screen grid-rows-[auto_1fr_auto] gap-8 p-8 text-center">
      <RoundHeader code={props.code} />
      <section class="grid content-center gap-8">
        <h2
          class="display mx-auto max-w-[22ch] text-primary leading-tight"
          style={{ "font-size": "clamp(1.8rem,4vw,3rem)" }}
        >
          {m().prompt}
        </h2>
        <div class="mx-auto grid w-full max-w-[1200px] grid-cols-2 gap-6">
          <AnswerCard text={m().answers[0] ?? ""} idx={0} />
          <AnswerCard text={m().answers[1] ?? ""} idx={1} />
        </div>
      </section>
      <footer class="opacity-70">
        {voted()}/{eligible()} votes in
      </footer>
    </main>
  )
}

function HostReveal(props: { code: string }) {
  const m = () => gs()!.matchup!
  const tally = () => {
    let v0 = 0
    let v1 = 0
    for (const c of Object.values(m().votes)) {
      if (c === 0) v0++
      else v1++
    }
    return { v0, v1 }
  }
  const winner = () => {
    const { v0, v1 } = tally()
    return v0 === v1 ? -1 : v0 > v1 ? 0 : 1
  }
  return (
    <main class="grid h-screen grid-rows-[auto_1fr_auto] gap-8 p-8 text-center">
      <RoundHeader code={props.code} />
      <section class="grid content-center gap-8">
        <h2
          class="display mx-auto max-w-[22ch] text-primary leading-tight"
          style={{ "font-size": "clamp(1.8rem,4vw,3rem)" }}
        >
          {m().prompt}
        </h2>
        <div class="mx-auto grid w-full max-w-[1200px] grid-cols-2 gap-6">
          <RevealCard
            text={m().answers[0] ?? ""}
            idx={0}
            votes={tally().v0}
            authorId={m().authors[0]!}
            isWinner={winner() === 0}
          />
          <RevealCard
            text={m().answers[1] ?? ""}
            idx={1}
            votes={tally().v1}
            authorId={m().authors[1]!}
            isWinner={winner() === 1}
          />
        </div>
      </section>
      <footer>
        <button class="belch-btn" onClick={() => send({ t: "next" })}>
          {gs()!.round >= gs()!.totalRounds ? "Finish" : "Next Round"}
        </button>
      </footer>
    </main>
  )
}

function HostFinal() {
  const ranked = () =>
    [...gs()!.players].sort((a, b) => (gs()!.scores[b.id] ?? 0) - (gs()!.scores[a.id] ?? 0))
  return (
    <main class="grid h-screen grid-rows-[auto_1fr_auto] gap-8 p-8 text-center">
      <header>
        <h1 class="display m-0 text-primary" style={{ "font-size": "clamp(2.5rem,7vw,5rem)" }}>
          FINAL SCORES
        </h1>
      </header>
      <section class="mx-auto grid w-full max-w-2xl content-start gap-4">
        <For each={ranked()}>
          {(p, i) => (
            <div
              class="grid grid-cols-[auto_1fr_auto] items-center gap-4 rounded-2xl border-4 border-ink px-6 py-4 text-ink"
              style={{ background: p.color, "box-shadow": "0 6px 0 var(--color-ink)" }}
            >
              <div class="display text-3xl">{i() + 1}</div>
              <div class="display text-left text-2xl">{p.name}</div>
              <div class="display text-3xl">{gs()!.scores[p.id] ?? 0}</div>
            </div>
          )}
        </For>
      </section>
      <footer class="grid justify-items-center gap-4">
        <GamePicker />
        <button
          class="belch-btn"
          disabled={gs()!.players.length < 3}
          onClick={() => send({ t: "start" })}
        >
          {gs()!.players.length < 3 ? `Need ${3 - gs()!.players.length} more` : "Play Again"}
        </button>
      </footer>
    </main>
  )
}

// ---------- Guest views ----------

function GuestView() {
  return (
    <Show when={me() && gs()} fallback={<Blank text="connecting…" />}>
      <Switch>
        <Match when={gs()!.phase === "lobby"}>
          <GuestStatus text="waiting for host to start…" />
        </Match>
        <Match when={gs()!.phase === "writing"}>
          <Show when={gs()!.gameType === "fibbage"} fallback={<GuestWriting />}>
            <GuestFibbageWriting />
          </Show>
        </Match>
        <Match when={gs()!.phase === "voting"}>
          <Show when={gs()!.gameType === "fibbage"} fallback={<GuestVoting />}>
            <GuestFibbageVoting />
          </Show>
        </Match>
        <Match when={gs()!.phase === "reveal"}>
          <GuestReveal />
        </Match>
        <Match when={gs()!.phase === "final"}>
          <GuestFinal />
        </Match>
      </Switch>
    </Show>
  )
}

function GuestFibbageWriting() {
  const f = () => gs()!.fibbage!
  let input!: HTMLInputElement
  return (
    <Switch>
      <Match when={mySubmitted() || f().lies[me()!.id]}>
        <GuestStatus text="lie locked in ✓" />
      </Match>
      <Match when={true}>
        <main class="grid min-h-screen place-items-center p-6">
          <form
            class="grid w-full max-w-md gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              const v = input.value.trim()
              if (!v) return
              setMySubmitted(true)
              send({ t: "submit", answer: v })
            }}
          >
            <h2 class="display m-0 text-center text-primary text-2xl leading-tight">
              {f().question}
            </h2>
            <Countdown compact />
            <input
              ref={input}
              class="belch-input lower"
              placeholder="make up a lie"
              maxLength={80}
              autocomplete="off"
              autofocus
            />
            <button class="belch-btn !bg-accent" type="submit">
              Submit
            </button>
          </form>
        </main>
      </Match>
    </Switch>
  )
}

function GuestFibbageVoting() {
  const f = () => gs()!.fibbage!
  const hasVoted = () => myVoted() || f().votes[me()!.id] !== undefined
  const choices = () => f().choices.filter((choice) => choice.authorId !== me()!.id)

  function castVote(choice: string) {
    setMyVoted(true)
    send({ t: "vote", choice })
  }

  return (
    <Switch>
      <Match when={hasVoted()}>
        <GuestStatus text="vote locked in ✓" />
      </Match>
      <Match when={true}>
        <main class="grid min-h-screen place-items-center p-6">
          <div class="grid w-full max-w-md gap-4">
            <h3 class="display m-0 text-center text-primary leading-tight">{f().question}</h3>
            <For each={choices()}>
              {(choice, i) => (
                <button
                  class={`belch-btn whitespace-normal normal-case leading-snug ${
                    i() % 2 ? "!bg-accent" : ""
                  }`}
                  onClick={() => castVote(choice.id)}
                >
                  {choice.text}
                </button>
              )}
            </For>
          </div>
        </main>
      </Match>
    </Switch>
  )
}

function GuestStatus(props: { text: string }) {
  return (
    <main class="grid min-h-screen place-items-center p-6 text-center">
      <div>
        <BigPlayerTile player={me()!} />
        <Show when={gs()?.phase === "writing"}>
          <div class="mt-6">
            <Countdown />
          </div>
        </Show>
        <p class="mt-8 text-lg opacity-80">{props.text}</p>
      </div>
    </main>
  )
}

function GuestWriting() {
  const m = () => gs()!.matchup!
  const myIdx = () => m().authors.indexOf(me()!.id)
  let input!: HTMLInputElement

  return (
    <Switch>
      <Match when={myIdx() === -1}>
        <GuestStatus text="sit back — others are answering" />
      </Match>
      <Match when={mySubmitted() || m().answers[myIdx()]}>
        <GuestStatus text="answer locked in ✓" />
      </Match>
      <Match when={true}>
        <main class="grid min-h-screen place-items-center p-6">
          <form
            class="grid w-full max-w-md gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              const v = input.value.trim()
              if (!v) return
              setMySubmitted(true)
              send({ t: "submit", answer: v })
            }}
          >
            <h2 class="display m-0 text-center text-primary text-2xl leading-tight">
              {m().prompt}
            </h2>
            <Countdown compact />
            <input
              ref={input}
              class="belch-input lower"
              placeholder="be funny"
              maxLength={80}
              autocomplete="off"
              autofocus
            />
            <button class="belch-btn !bg-accent" type="submit">
              Submit
            </button>
          </form>
        </main>
      </Match>
    </Switch>
  )
}

function GuestVoting() {
  const m = () => gs()!.matchup!
  const isAuthor = () => m().authors.includes(me()!.id)
  const hasVoted = () => myVoted() || m().votes[me()!.id] !== undefined

  function castVote(choice: 0 | 1) {
    setMyVoted(true)
    send({ t: "vote", choice })
  }

  return (
    <Switch>
      <Match when={isAuthor()}>
        <GuestStatus text="your answer is up for vote — sit tight" />
      </Match>
      <Match when={hasVoted()}>
        <GuestStatus text="vote locked in ✓" />
      </Match>
      <Match when={true}>
        <main class="grid min-h-screen place-items-center p-6">
          <div class="grid w-full max-w-md gap-4">
            <h3 class="display m-0 text-center text-primary leading-tight">{m().prompt}</h3>
            <button
              class="belch-btn whitespace-normal normal-case leading-snug"
              onClick={() => castVote(0)}
            >
              {m().answers[0]}
            </button>
            <button
              class="belch-btn whitespace-normal normal-case leading-snug !bg-accent"
              onClick={() => castVote(1)}
            >
              {m().answers[1]}
            </button>
          </div>
        </main>
      </Match>
    </Switch>
  )
}

function GuestReveal() {
  return (
    <main class="grid min-h-screen place-items-center p-6 text-center">
      <div>
        <BigPlayerTile player={me()!} />
        <div class="display mt-6 text-5xl text-primary">{gs()!.scores[me()!.id] ?? 0}</div>
        <div class="opacity-70">total points</div>
      </div>
    </main>
  )
}

function GuestFinal() {
  const ranked = () =>
    [...gs()!.players].sort((a, b) => (gs()!.scores[b.id] ?? 0) - (gs()!.scores[a.id] ?? 0))
  const myRank = () => ranked().findIndex((p) => p.id === me()!.id) + 1
  return (
    <main class="grid min-h-screen place-items-center p-6 text-center">
      <div>
        <BigPlayerTile player={me()!} />
        <div class="display mt-6 text-6xl text-primary">#{myRank()}</div>
        <div class="display text-3xl">{gs()!.scores[me()!.id] ?? 0} pts</div>
      </div>
    </main>
  )
}

// ---------- Bits ----------

function Blank(props: { text: string }) {
  return (
    <main class="grid min-h-screen place-items-center">
      <p>{props.text}</p>
    </main>
  )
}

function RoundHeader(props: { code: string }) {
  return (
    <header class="display flex items-center justify-between">
      <div class="text-2xl opacity-70">
        ROUND {gs()!.round}/{gs()!.totalRounds}
      </div>
      <div class="text-2xl text-accent">{props.code}</div>
    </header>
  )
}

function gameName(gameType: GameType) {
  return gameType === "fibbage" ? "FIBBAGE" : "QUIPLASH"
}

function secondsLeft() {
  const endsAt = gs()?.phaseEndsAt
  if (!endsAt) return null
  return Math.max(0, Math.ceil((endsAt - now()) / 1000))
}

function Countdown(props: { compact?: boolean }) {
  const seconds = () => secondsLeft()
  return (
    <Show when={seconds() !== null}>
      <div
        class={`display text-primary ${props.compact ? "text-center text-4xl" : "text-6xl"}`}
        aria-live="polite"
      >
        {seconds()}s
      </div>
    </Show>
  )
}

function PlayerTile(props: { player: Player; badge?: string }) {
  return (
    <div class="belch-tile" style={{ background: props.player.color }}>
      {props.player.name}
      <Show when={props.badge}>
        <span class="belch-badge">{props.badge}</span>
      </Show>
    </div>
  )
}

function BigPlayerTile(props: { player: Player }) {
  return (
    <div class="belch-tile-lg inline-block" style={{ background: props.player.color }}>
      {props.player.name}
    </div>
  )
}

function AnswerCard(props: { text: string; idx: number }) {
  const bg = props.idx === 0 ? "var(--color-paper)" : "var(--color-accent)"
  return (
    <div class="belch-card" style={{ background: bg }}>
      {props.text}
    </div>
  )
}

function RevealCard(props: {
  text: string
  idx: number
  votes: number
  authorId: string
  isWinner: boolean
}) {
  const bg = props.idx === 0 ? "var(--color-paper)" : "var(--color-accent)"
  const author = () => gs()!.players.find((p) => p.id === props.authorId)
  return (
    <div
      class="grid gap-4 rounded-3xl border-4 border-ink p-6 text-ink"
      style={{
        background: bg,
        "box-shadow": "0 8px 0 var(--color-ink)",
        ...(props.isWinner
          ? { outline: "6px solid var(--color-primary)", "outline-offset": "4px" }
          : {}),
      }}
    >
      <div class="display leading-tight" style={{ "font-size": "clamp(1.4rem,2.4vw,2rem)" }}>
        {props.text}
      </div>
      <div class="display flex items-center justify-between">
        <span
          class="rounded-lg border-[3px] border-ink px-3 py-1"
          style={{ background: author()?.color ?? "#fff" }}
        >
          {author()?.name ?? "?"}
        </span>
        <span class="text-2xl">
          {props.votes} {props.votes === 1 ? "vote" : "votes"}
        </span>
      </div>
    </div>
  )
}

function FibbageRevealCard(props: { choice: FibbageChoice; votes: number }) {
  const author = () =>
    props.choice.authorId ? gs()!.players.find((p) => p.id === props.choice.authorId) : null
  return (
    <div
      class="grid gap-3 rounded-3xl border-4 border-ink p-5 text-ink"
      style={{
        background: props.choice.isTruth ? "var(--color-primary)" : "var(--color-paper)",
        "box-shadow": "0 8px 0 var(--color-ink)",
      }}
    >
      <div class="display text-2xl leading-tight">{props.choice.text}</div>
      <div class="flex items-center justify-between gap-3">
        <span class="font-bold">{props.choice.isTruth ? "TRUTH" : (author()?.name ?? "?")}</span>
        <span class="display text-xl">
          {props.votes} {props.votes === 1 ? "vote" : "votes"}
        </span>
      </div>
    </div>
  )
}
