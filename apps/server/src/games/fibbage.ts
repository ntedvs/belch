export type FibbageQuestion = { question: string; truth: string }

export const FIBBAGE_QUESTIONS: FibbageQuestion[] = [
  {
    question: "In 2015, a museum in Sweden opened an exhibit dedicated entirely to blank.",
    truth: "failure",
  },
  {
    question: "A town in Alaska once elected a blank as its honorary mayor.",
    truth: "cat",
  },
  {
    question: "The first item sold on eBay was a broken blank.",
    truth: "laser pointer",
  },
  {
    question: "A Canadian university offers a course about the cultural impact of blank.",
    truth: "Batman",
  },
  {
    question: "In Japan, some farmers grow square blank.",
    truth: "watermelons",
  },
  {
    question: "The official state snack of Illinois is blank.",
    truth: "popcorn",
  },
  {
    question: "A man in Tennessee legally changed his middle name to blank.",
    truth: "Tyrannosaurus Rex",
  },
  {
    question: "Before becoming famous, Elvis Presley worked briefly as a blank.",
    truth: "truck driver",
  },
]

export function pickFibbageQuestions(n: number): FibbageQuestion[] {
  const pool = [...FIBBAGE_QUESTIONS]
  const out: FibbageQuestion[] = []
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length)
    out.push(pool.splice(idx, 1)[0]!)
  }
  return out
}
