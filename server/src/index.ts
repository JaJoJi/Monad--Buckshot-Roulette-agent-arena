import express from "express"
import dotenv from "dotenv"
import { z } from "zod"
import { ethers } from "ethers"

import ArenaMatchEscrowABI from "./ArenaMatchEscrow.json"

dotenv.config()

/**
 * --------------------
 * App
 * --------------------
 */
const app = express()
app.use(express.json())

/**
 * --------------------
 * Blockchain setup
 * --------------------
 */
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL)

const serverWallet = new ethers.Wallet(
  process.env.PRIVATE_KEY!,
  provider
)

const arena = new ethers.Contract(
  process.env.ARENA_ESCROW_ADDRESS!,
  ArenaMatchEscrowABI.abi,
  serverWallet
)

/**
 * --------------------
 * Config
 * --------------------
 */
const MAX_PLAYERS = 2
const START_HP = 3
const TOTAL_BULLETS = 6
const BET_AMOUNT = ethers.parseEther("0.01")

/**
 * --------------------
 * Schemas
 * --------------------
 */
const WalletSchema = z.string().startsWith("0x").length(42)

const JoinSchema = z.object({
  wallet_address: WalletSchema,
})

const ActionSchema = z.object({
  wallet_address: WalletSchema,
  action: z.literal("shoot"),
  target: z.enum(["self", "other"]),
})

/**
 * --------------------
 * World State (single match)
 * --------------------
 */
type Bullet = "real" | "blank"

const worldState = {
  started: false,
  matchId: null as number | null,

  players: [] as string[],
  round: 0,
  currentTurn: null as string | null,

  hp: {} as Record<string, number>,

  bullets: {
    chamber: [] as Bullet[],
  },

  actionHistory: [] as {
    round: number
    actor: string
    action: string
    target: string
    bullet: Bullet
    result: string
  }[],
}

/**
 * --------------------
 * Utils
 * --------------------
 */
function shuffle<T>(arr: T[]) {
  return arr.sort(() => Math.random() - 0.5)
}

function generateBullets(): Bullet[] {
  const bullets: Bullet[] = []

  const realCount =
    Math.floor(Math.random() * (TOTAL_BULLETS - 1)) + 1
  const blankCount = TOTAL_BULLETS - realCount

  for (let i = 0; i < realCount; i++) bullets.push("real")
  for (let i = 0; i < blankCount; i++) bullets.push("blank")

  return shuffle(bullets)
}

function startGame() {
  worldState.started = true
  worldState.round = 1
  worldState.currentTurn = worldState.players[0]
  worldState.bullets.chamber = generateBullets()

  for (const p of worldState.players) {
    worldState.hp[p] = START_HP
  }

  console.log("🎮 Game started")
}

function nextTurn() {
  const [a, b] = worldState.players
  worldState.currentTurn =
    worldState.currentTurn === a ? b : a
}

function checkWinner(): string | null {
  const alive = worldState.players.filter(
    p => worldState.hp[p] > 0
  )
  return alive.length === 1 ? alive[0] : null
}

async function syncMatchStatus() {
  if (!worldState.matchId || worldState.started) return

  const m = await arena.getMatch(worldState.matchId)

  // MatchStatus.ACTIVE = 1
  if (m[5] === 1) {
    startGame()
  }
}

/**
 * --------------------
 * Routes
 * --------------------
 */

// Health
app.get("/health", (_, res) => {
  res.json({ ok: true })
})

/**
 * Join queue
 * - คนแรก: เก็บไว้
 * - คนที่สอง: server createMatch
 */
app.post("/join", async (req, res) => {
  const parsed = JoinSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error)

  const { wallet_address } = parsed.data

  if (worldState.started)
    return res.status(403).json({ error: "game already started" })

  if (!worldState.players.includes(wallet_address)) {
    worldState.players.push(wallet_address)
  }

  // ครบ 2 คน → createMatch
  if (worldState.players.length === MAX_PLAYERS && !worldState.matchId) {
    const [p1, p2] = worldState.players

    try {
      const tx = await arena.createMatch(
        p1,
        p2,
        BET_AMOUNT
      )
      const receipt = await tx.wait()

      const event = receipt!.logs
        .map((log: { topics: ReadonlyArray<string>; data: string }) => arena.interface.parseLog(log))
        .find((e: { name: string }) => e?.name === "MatchCreated")

      worldState.matchId = Number(event!.args.matchId)

      console.log("🧾 Match created:", worldState.matchId)
    } catch (err) {
      console.error(err)
      return res.status(500).json({ error: "createMatch failed" })
    }
  }

  res.json({
    ok: true,
    players: worldState.players,
    matchId: worldState.matchId,
    betAmount: BET_AMOUNT.toString(),
  })
})

/**
 * World state
 */
app.get("/world/state", async (_, res) => {
  await syncMatchStatus()

  res.json({
    started: worldState.started,
    matchId: worldState.matchId,
    players: worldState.players,
    round: worldState.round,
    currentTurn: worldState.currentTurn,
    hp: worldState.hp,
    bullets: {
      remaining: worldState.bullets.chamber.length,
    },
    actionHistory: worldState.actionHistory,
  })
})

/**
 * Action (shoot)
 */
app.post("/action", async (req, res) => {
  const parsed = ActionSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error)

  const { wallet_address, target } = parsed.data

  await syncMatchStatus()

  if (!worldState.started)
    return res.status(400).json({ error: "game not started" })

  if (wallet_address !== worldState.currentTurn)
    return res.status(403).json({ error: "not your turn" })

  const bullet = worldState.bullets.chamber.shift()
  if (!bullet)
    return res.status(400).json({ error: "no bullets left" })

  let result = "click"

  if (bullet === "real") {
    const victim =
      target === "self"
        ? wallet_address
        : worldState.players.find(p => p !== wallet_address)!

    worldState.hp[victim] -= 1
    result = `${victim} lost 1 hp`
  }

  worldState.actionHistory.push({
    round: worldState.round,
    actor: wallet_address,
    action: "shoot",
    target,
    bullet,
    result,
  })

  if (worldState.bullets.chamber.length === 0) {
    worldState.round += 1
    worldState.bullets.chamber = generateBullets()
  }

  const winner = checkWinner()

  if (winner && worldState.matchId) {
    try {
      const tx = await arena.resolveMatch(
        worldState.matchId,
        winner
      )
      await tx.wait()

      console.log("🏆 Match resolved:", winner)
    } catch (err) {
      console.error("resolveMatch failed", err)
    }

    worldState.started = false
  } else {
    nextTurn()
  }

  res.json({
    ok: true,
    bullet,
    result,
    winner,
  })
})

/**
 * On-chain debug
 */
app.get("/match/onchain", async (_, res) => {
  if (!worldState.matchId)
    return res.json({ match: null })

  const m = await arena.getMatch(worldState.matchId)

  res.json({
    player1: m[0],
    player2: m[1],
    betAmount: m[2].toString(),
    paid: [m[3], m[4]],
    status: ["CREATED", "ACTIVE", "RESOLVED"][m[5]],
    winner: m[6],
  })
})

/**
 * --------------------
 * Start server
 * --------------------
 */
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`🏟️ Arena server running on port ${PORT}`)
})
