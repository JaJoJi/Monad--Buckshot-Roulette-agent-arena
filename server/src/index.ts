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
  console.log(`   Players: ${worldState.players.join(" vs ")}`)
  console.log(`   First turn: ${worldState.currentTurn}`)
  console.log(`   Bullets: ${worldState.bullets.chamber.length} (${worldState.bullets.chamber.filter(b => b === 'real').length} real, ${worldState.bullets.chamber.filter(b => b === 'blank').length} blank)`)
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

/**
 * เช็ค on-chain ว่าทั้งสองคนจ่ายเงินครบหรือยัง
 */
async function syncMatchStatus() {
  if (!worldState.matchId) return
  if (worldState.started) return // เกมเริ่มแล้ว ไม่ต้องเช็คอีก

  try {
    const m = await arena.getMatch(worldState.matchId)
    
    const player1 = m[0]
    const player2 = m[1]
    const player1Paid = m[3]
    const player2Paid = m[4]
    const status = m[5] // 0=CREATED, 1=ACTIVE, 2=RESOLVED
    
    console.log(`🔍 Match #${worldState.matchId} status check:`)
    console.log(`   Player1: ${player1} (paid: ${player1Paid})`)
    console.log(`   Player2: ${player2} (paid: ${player2Paid})`)
    console.log(`   Status: ${['CREATED', 'ACTIVE', 'RESOLVED'][status]}`)

    // ⭐ เงื่อนไขเริ่มเกม: status = ACTIVE (1) หรือทั้งสองคนจ่ายครบ
    if ((status === 1 || (player1Paid && player2Paid)) && !worldState.started) {
      console.log("✅ Both players paid! Starting game NOW...")
      startGame()
      
      // หยุด polling ทันที
      if (pollingInterval) {
        clearInterval(pollingInterval)
        pollingInterval = null
        console.log("⏹️ Stopped polling (game started)")
      }
    }
  } catch (err) {
    console.error("❌ Error checking match status:", err)
  }
}

/**
 * เช็คสถานะ match อัตโนมัติทุก 2 วินาที
 */
let pollingInterval: NodeJS.Timeout | null = null

function startMatchPolling() {
  if (pollingInterval) return // ป้องกัน duplicate

  pollingInterval = setInterval(async () => {
    // หยุดทันทีถ้าเกมเริ่มแล้ว
    if (worldState.started) {
      clearInterval(pollingInterval!)
      pollingInterval = null
      console.log("⏹️ Stopped polling - game is running")
      return
    }
    
    if (!worldState.matchId) return

    try {
      await syncMatchStatus()
    } catch (err) {
      console.error("Polling error:", err)
    }
  }, 2000) // เช็คทุก 2 วินาที

  console.log("▶️ Started match polling (checking every 2s)")
}

function stopMatchPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval)
    pollingInterval = null
    console.log("⏹️ Stopped match polling")
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
 * ค้นหา match ที่ยังไม่เสร็จสำหรับ players เหล่านี้
 */
async function findExistingMatch(player1: string, player2: string): Promise<number | null> {
  try {
    const matchCount = await arena.matchCount()
    console.log(`🔍 Checking ${matchCount} existing matches...`)
    
    // เช็คจากล่างขึ้นบน (match ล่าสุดก่อน)
    for (let i = Number(matchCount) - 1; i >= 0; i--) {
      const m = await arena.getMatch(i)
      
      const matchPlayer1 = m[0].toLowerCase()
      const matchPlayer2 = m[1].toLowerCase()
      const status = m[5] // 0=CREATED, 1=ACTIVE, 2=RESOLVED
      
      // ตรวจสอบว่า player ทั้งสองตรงกัน และ match ยังไม่จบ
      const playersMatch = 
        (matchPlayer1 === player1.toLowerCase() && matchPlayer2 === player2.toLowerCase()) ||
        (matchPlayer1 === player2.toLowerCase() && matchPlayer2 === player1.toLowerCase())
      
      if (playersMatch && status !== 2) { // ไม่ใช่ RESOLVED
        console.log(`✅ Found existing match #${i} for these players`)
        return i
      }
    }
    
    console.log("❌ No existing match found")
    return null
  } catch (err) {
    console.error("Error finding existing match:", err)
    return null
  }
}

/**
 * Join queue
 */
app.post("/join", async (req, res) => {
  const parsed = JoinSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error)

  const { wallet_address } = parsed.data

  if (worldState.started)
    return res.status(403).json({ error: "game already started" })

  if (!worldState.players.includes(wallet_address)) {
    worldState.players.push(wallet_address)
    console.log(`👤 Player joined: ${wallet_address} (${worldState.players.length}/${MAX_PLAYERS})`)
  }

  // ครบ 2 คน → ตรวจสอบ existing match ก่อน
  if (worldState.players.length === MAX_PLAYERS && !worldState.matchId) {
    const [p1, p2] = worldState.players

    // ⭐ ตรวจสอบว่ามี match อยู่แล้วหรือไม่
    const existingMatchId = await findExistingMatch(p1, p2)
    
    if (existingMatchId !== null) {
      worldState.matchId = existingMatchId
      console.log(`♻️ Using existing match #${existingMatchId}`)
      
      // เริ่ม polling เพื่อรอ payment
      startMatchPolling()
      
    } else {
      // สร้าง match ใหม่
      try {
        console.log("📝 Creating new match on-chain...")
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

        console.log(`🧾 Match created: #${worldState.matchId}`)
        console.log(`   Bet amount: ${ethers.formatEther(BET_AMOUNT)} ETH`)
        
        // เริ่ม polling เพื่อรอ payment
        startMatchPolling()
        
      } catch (err) {
        console.error("❌ createMatch failed:", err)
        return res.status(500).json({ error: "createMatch failed" })
      }
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
    
    console.log(`💥 ${bullet.toUpperCase()} bullet! ${result}`)
  } else {
    console.log(`🔘 ${bullet.toUpperCase()} bullet! Click...`)
  }

  worldState.actionHistory.push({
    round: worldState.round,
    actor: wallet_address,
    action: "shoot",
    target,
    bullet,
    result,
  })

  // reload เมื่อกระสุนหมด
  if (worldState.bullets.chamber.length === 0) {
    worldState.round += 1
    worldState.bullets.chamber = generateBullets()
    console.log(`🔄 Round ${worldState.round} - Reloaded bullets`)
  }

  const winner = checkWinner()

  if (winner && worldState.matchId) {
    try {
      console.log(`🏆 Winner: ${winner}! Resolving match on-chain...`)
      const tx = await arena.resolveMatch(
        worldState.matchId,
        winner
      )
      await tx.wait()

      console.log("✅ Match resolved on-chain")
    } catch (err) {
      console.error("❌ resolveMatch failed:", err)
    }

    // แสดงสถิติสรุป
    console.log("\n" + "=".repeat(60))
    console.log("🏁 GAME COMPLETED")
    console.log("=".repeat(60))
    console.log(`🏆 Winner: ${winner}`)
    console.log(`📊 Game Stats:`)
    console.log(`   Total rounds: ${worldState.round}`)
    console.log(`   Total actions: ${worldState.actionHistory.length}`)
    console.log(`   Final HP: ${worldState.hp[worldState.players[0]]} vs ${worldState.hp[worldState.players[1]]}`)
    console.log("=".repeat(60))
    
    stopMatchPolling()
    
    // หยุด server หลังเกมจบ
    console.log("\n👋 Server shutting down after game completion...")
    
    // รอ 3 วินาทีให้ agent ได้รับข้อมูล
    setTimeout(() => {
      console.log("✅ Server stopped successfully")
      process.exit(0)
    }, 3000)
    
    return res.json({
      ok: true,
      bullet,
      result,
      winner,
      keepTurn: false,
      nextTurn: null,
      gameComplete: true
    })
  } else {
    // ⭐ rule สำคัญ
    // ยิงตัวเอง + blank → ยิงต่อ
    const keepTurn =
      bullet === "blank" && target === "self"

    if (!keepTurn) {
      nextTurn()
    }
    
    if (keepTurn) {
      console.log(`🎯 ${wallet_address} gets another turn!`)
    } else {
      console.log(`🔄 Next turn: ${worldState.currentTurn}`)
    }
  }

  res.json({
    ok: true,
    bullet,
    result,
    winner,
    keepTurn: bullet === "blank" && target === "self",
    nextTurn: worldState.currentTurn,
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
 * Force sync (for debugging)
 */
app.post("/admin/sync", async (_, res) => {
  console.log("🔧 Manual sync triggered")
  await syncMatchStatus()
  res.json({ 
    ok: true, 
    started: worldState.started,
    matchId: worldState.matchId
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
  console.log(`   RPC: ${process.env.RPC_URL}`)
  console.log(`   Arena: ${process.env.ARENA_ESCROW_ADDRESS}`)
})