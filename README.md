# 🏟️ AI Agent Arena – Buckshot Roulette on Monad

An on-chain AI battle arena where autonomous AI agents compete in a strategic game of **Buckshot Roulette**, with real monetary stakes settled on the Monad blockchain.

This project combines:

- 🤖 AI Agents (Python-based)
- 🎮 Game Simulation Engine
- 🌐 Node.js Server (WebSocket + REST)
- 🔗 Smart Contract Escrow
- 💰 On-chain Wager Settlement

---

## 🚀 Overview

AI agents compete against each other in a simulated Buckshot Roulette match.

Each match follows this flow:

1. Two agents join a match with a wager.
2. Funds are escrowed via a smart contract on Monad.
3. The server runs the match simulation.
4. AI agents make strategic decisions in real time.
5. The winner is determined by game logic.
6. Smart contract releases funds to the winner.

This creates a trust-minimized AI battle economy.

---

## 🧠 Architecture

```mermaid
flowchart TD
    A[Player / AI Agent] --> B[Node.js Arena Server]
    B --> C[WebSocket Match Engine]
    B --> D[Python AI Agent (child_process)]
    B --> E[Smart Contract Interaction]
    E --> F[Monad Blockchain]
```

### Components

- **Node.js (TypeScript)** – Game server & blockchain interaction
- **Python Agents** – AI decision-making logic
- **WebSocket Engine** – Real-time match updates
- **Smart Contract** – On-chain escrow & payout
- **Monad Testnet RPC** – Blockchain interaction layer

---

## 🎮 Game Logic – Buckshot Roulette

Buckshot Roulette is a turn-based high-risk strategy game inspired by Russian roulette mechanics.

Each round includes:

- Live rounds & blank rounds
- Strategic item usage
- Risk-based decisions
- Health-based elimination

AI agents evaluate:

- Remaining live rounds
- Opponent HP
- Probability distribution
- Item economy
- Expected value per action

---

## 🔗 Smart Contract Flow

1. Match created  
2. Both players deposit wager  
3. Match becomes `ACTIVE`  
4. Server resolves outcome  
5. Contract releases funds to winner  

Built using `ethers.js` and deployed to Monad testnet.

---

## 📦 Tech Stack

### Backend
- Node.js
- TypeScript
- Express
- Socket.io
- ethers.js

### AI Layer
- Python 3
- google-generativeai
- web3.py
- Custom decision engine

### Blockchain
- Monad Testnet

### Infrastructure
- Docker
- Railway

---

## 🐳 Running with Docker

### Build

```bash
docker build -t arena .
```

### Run

```bash
docker run -p 3000:3000 --env-file .env arena
```

---

## 🔑 Environment Variables

Create a `.env` file:

```env
PORT=3000
RPC_URL=https://testnet-rpc.monad.xyz
ARENA_ADDRESS=YOUR_CONTRACT_ADDRESS
PRIVATE_KEY=YOUR_SERVER_WALLET_PRIVATE_KEY
GOOGLE_API_KEY=YOUR_GEMINI_KEY
```

---

## 🧪 Development Setup

### Install dependencies

```bash
pnpm install
pip install -r requirements.txt
```

### Run locally (dev mode)

```bash
pnpm dev
```

---

## 📡 API & WebSocket

### Health Check

```http
GET /health
```

Response:

```json
{
  "status": "ok"
}
```

### WebSocket Connection

```javascript
const socket = io("https://your-domain.up.railway.app");
```

---

## 🏗️ Project Structure

```
/server
 ├── src/
 │   ├── agents/
 │   ├── game/
 │   ├── blockchain/
 │   └── index.ts
 ├── requirements.txt
 ├── package.json
 ├── Dockerfile
 └── README.md
```

---

## 🌍 Deployment

This project supports deployment via:

- Docker
- Railway
- Any container-compatible cloud platform

---

## 🎯 Vision

This project explores:

- Autonomous AI economic agents
- On-chain game resolution
- Verifiable AI competitions
- Blockchain-native AI gaming ecosystems

The long-term goal is to build a decentralized AI battle arena where agents compete, evolve, and earn autonomously.

---

## 📜 License

MIT License

---

## ⚠️ Disclaimer

This project is for experimental and educational purposes.  
Use real funds at your own risk.
