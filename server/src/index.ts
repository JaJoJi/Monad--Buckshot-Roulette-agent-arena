import express from "express"
import dotenv from "dotenv"
import { z } from "zod"
import { ethers } from "ethers"
import { spawn } from "child_process"
import path from "path"
import fs from "fs"
import ArenaMatchEscrowABI from "./ArenaMatchEscrow.json"

dotenv.config()
/**
 * --------------------
 * App
 * --------------------
 */
const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true })) 
app.set("view engine", "ejs")
app.set("views", path.join(process.cwd(), "src", "views"))
const agentMap: Record<string, { folder: string; file: string }> = {
  Aggressive: {
    folder: "agent_Aggressive",
    file: "agent_aggressive.py",
  },
  Calculated: {
    folder: "agent_Calculated",
    file: "agent_calculated.py",
  },
  Defensive: {
    folder: "agent_Defensive",
    file: "agent_defensive.py",
  },
  Ego: {
    folder: "agent_Ego_Agent",
    file: "agent_ego_agent.py",
  },
  Gambler: {
    folder: "agent_Gambler",
    file: "agent_Gambler.py", // ตัวนี้ G ใหญ่
  },
}

let creatingMatch = false
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
const START_HP = 10
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

function resetWorld() {
  console.log("🔄 Resetting world state for next match...")

  worldState.started = false
  worldState.matchId = null
  worldState.players = []
  worldState.round = 0
  worldState.currentTurn = null
  worldState.hp = {}
  worldState.bullets.chamber = []
  worldState.actionHistory = []

  stopMatchPolling()
}

function startGame() {
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
  if (worldState.matchId === null) return
  if (worldState.started) return // เกมเริ่มแล้ว ไม่ต้องเช็คอีก

  try {
    const m = await arena.getMatch(worldState.matchId)

    const player1 = m[0]
    const player2 = m[1]
    const player1Paid = m[3]
    const player2Paid = m[4]
    const status = Number(m[5]) // 0=CREATED, 1=ACTIVE, 2=RESOLVED (cast กัน bigint)

    console.log(`🔍 Match #${worldState.matchId} status check:`)
    console.log(`   Player1: ${player1} (paid: ${player1Paid})`)
    console.log(`   Player2: ${player2} (paid: ${player2Paid})`)
    console.log(`   Status: ${['CREATED', 'ACTIVE', 'RESOLVED'][status]}`)

    // ✅ เริ่มเกมเฉพาะตอน status === ACTIVE เท่านั้น
    if (status === 1 && !worldState.started) {
      console.log("✅ Match is ACTIVE! Starting game NOW...")
      
      worldState.started = true
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
    
    if (worldState.matchId === null) return

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
app.get("/", (_, res) => {
  res.render("index", {
    opponents: Object.keys(agentMap)
  })
})
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
      
      if (playersMatch && status === 0)  { // ไม่ใช่ RESOLVED
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
  if (!parsed.success) {
    return res.status(400).json(parsed.error)
  }

  const { wallet_address } = parsed.data

  if (worldState.started) {
    return res.status(403).json({ error: "game already started" })
  }

  // เพิ่ม player ถ้ายังไม่มี
  if (!worldState.players.includes(wallet_address)) {
    worldState.players.push(wallet_address)
    console.log(
      `👤 Player joined: ${wallet_address} (${worldState.players.length}/${MAX_PLAYERS})`
    )
  }

  // ครบ 2 คนแล้ว และยังไม่มี match
  if (
    worldState.players.length === MAX_PLAYERS &&
    worldState.matchId === null &&
    !creatingMatch
  ) {
    creatingMatch = true // 🔒 LOCK ป้องกันสร้างซ้ำ

    try {
      const [p1, p2] = worldState.players

      // 🔍 เช็คว่ามี match เดิมอยู่ไหม
      const existingMatchId = await findExistingMatch(p1, p2)

      if (existingMatchId !== null) {
        worldState.matchId = existingMatchId
        console.log(`♻️ Using existing match #${existingMatchId}`)
        startMatchPolling()
      } else {
        // 📝 สร้าง match ใหม่
        console.log("📝 Creating new match on-chain...")

        const tx = await arena.createMatch(
          p1,
          p2,
          BET_AMOUNT
        )

        const receipt = await tx.wait()

        const event = receipt!.logs
          .map((log: any) => {
            try {
              return arena.interface.parseLog(log)
            } catch {
              return null
            }
          })
          .find((e: any) => e?.name === "MatchCreated")

        if (!event) {
          throw new Error("MatchCreated event not found")
        }

        worldState.matchId = Number(event.args.matchId)

        console.log(`🧾 Match created: #${worldState.matchId}`)
        console.log(
          `   Bet amount: ${ethers.formatEther(BET_AMOUNT)} ETH`
        )

        startMatchPolling()
      }
    } catch (err) {
      console.error("❌ Error during match creation:", err)
      return res.status(500).json({
        error: "match creation failed",
      })
    } finally {
      creatingMatch = false // 🔓 UNLOCK
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
      real: worldState.bullets.chamber.filter(b => b === "real").length,
      blank: worldState.bullets.chamber.filter(b => b === "blank").length,
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

  if (winner && worldState.matchId !== null) {
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
    
    resetWorld()
    
    
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
  if (worldState.matchId === null)
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

app.post("/arena/run", async (req, res) => {
  try {
    const { opponent } = req.body

    if (!agentMap[opponent]) {
      return res.status(400).json({ error: "Invalid opponent" })
    }

    resetWorld()

    const balancedPath = path.join(
      process.cwd(),
      "agents",
      "agent_Balanced",
      "agent_balanced.py"
    )

    const opponentConfig = agentMap[opponent]

    const opponentPath = path.join(
      process.cwd(),
      "agents",
      opponentConfig.folder,
      opponentConfig.file
    )

    if (!fs.existsSync(opponentPath)) {
      return res.status(500).json({ error: "Agent file missing" })
    }

    // ⭐ รอให้ process จบก่อน
    await new Promise<void>((resolve) => {
      const p1 = spawn("python3", [balancedPath])
      const p2 = spawn("python3", [opponentPath])

      p2.on("close", () => {
        resolve()
      })
    })

    // หลัง match จบ
    const winner =
      worldState.players.find(p => worldState.hp[p] > 0) || "Unknown"

    res.render("result", {
      opponent,
      winner
    })

  } catch (err) {
    console.error(err)
    res.status(500).send("Server error")
  }
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


