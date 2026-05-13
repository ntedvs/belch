import { Hono } from "hono"
import { generateRoomCode, RoomCode } from "@belch/protocol"
export { Room } from "./room"

const app = new Hono<{ Bindings: Env }>()

app.post("/api/room", async (c) => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateRoomCode()
    const id = c.env.ROOMS.idFromName(code)
    const stub = c.env.ROOMS.get(id)
    const hostToken = crypto.randomUUID()
    const res = await stub.fetch("https://room.internal/create", {
      method: "POST",
      body: JSON.stringify({ hostToken }),
    })
    if (res.ok) return c.json({ code, hostToken })
  }
  return c.text("could not create room", 503)
})

app.get("/ws/:code", async (c) => {
  const code = c.req.param("code").toUpperCase()
  const parsed = RoomCode.safeParse(code)
  if (!parsed.success) return c.text("bad room code", 400)
  if (c.req.header("upgrade") !== "websocket") return c.text("expected websocket", 426)

  const id = c.env.ROOMS.idFromName(code)
  const stub = c.env.ROOMS.get(id)
  return stub.fetch(c.req.raw)
})

// Static assets fallback (host SPA at /, guest SPA at /play)
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
