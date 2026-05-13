export const PROMPTS: string[] = [
  "A terrible name for a new breakfast cereal",
  "The worst thing to hear from your barber",
  "An unhelpful slogan for a hospital",
  "Something you should never say at a wedding",
  "A bad name for a boat",
  "The most disappointing superpower",
  "A rejected flavor of ice cream",
  "Something a robot would say to flirt",
  "The wrong way to greet your boss",
  "A weird thing to find in your soup",
  "An awful name for a perfume",
  "The worst conversation starter on a date",
  "A surprising thing to keep in your wallet",
  "An unsettling thing to whisper to a baby",
  "A bad theme for a kids' birthday party",
  "Something a pirate would post on LinkedIn",
  "The least scary Halloween costume",
  "A terrible safety tip",
  "The wrong way to use a fork",
  "An animal you'd never want as a coworker",
]

export function pickPrompts(n: number): string[] {
  const pool = [...PROMPTS]
  const out: string[] = []
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length)
    out.push(pool.splice(idx, 1)[0]!)
  }
  return out
}
