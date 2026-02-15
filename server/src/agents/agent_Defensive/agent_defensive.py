import requests,time,random,sys,os,json,re
from dotenv import load_dotenv
from web3 import Web3
import sys
import io

# Force UTF-8 output on Windows
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="ignore")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="ignore")
import google.generativeai as genai
from google.generativeai.types import HarmCategory,HarmBlockThreshold
import functools
print = functools.partial(print, flush=True)
# ================= ENV =================
load_dotenv()

SERVER=os.getenv("SERVER_URL")
API=os.getenv("GEMINI_API_KEY")
MODEL=os.getenv("GEMINI_MODEL")

RPC=os.getenv("RPC_URL")
PRIVATE=os.getenv("PRIVATE_KEY_AGENT2")
ARENA=os.getenv("ARENA_ESCROW_ADDRESS")
BET=float(os.getenv("BET_AMOUNT"))

# ================= WEB3 =================
w3=Web3(Web3.HTTPProvider(RPC))
assert w3.is_connected(), "RPC not connected"

acct=w3.eth.account.from_key(PRIVATE)
MY_ID=acct.address

ARENA=w3.to_checksum_address(ARENA)

# ================= LOAD ABI (FIXED PATH) =================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

abi_path = os.path.join(
    BASE_DIR,
    "..",
    "..",
    "ArenaMatchEscrow.json"
)

abi_path = os.path.normpath(abi_path)

print("Loading ABI from:", abi_path)

with open(abi_path) as f:
    abi = json.load(f)["abi"]

contract=w3.eth.contract(address=ARENA,abi=abi)


# ================= LLM =================
genai.configure(api_key=API)
model=genai.GenerativeModel(MODEL)

# ================= GAME CONST =================
INITIAL_REAL=3
INITIAL_BLANK=3

MEM="memory_ag2.json"
GAME_MEM="game_memory_ag2.json"
LEARN="learning_ag2.json"
STYLE = "defensive"
MAX_GAME_MEM=7

# ================= STYLE SYSTEM =================
def normalize_weights(learn):
    total = learn["llm_weight"] + learn["ev_weight"]
    if total <= 0:
        learn["llm_weight"] = 0.5
        learn["ev_weight"] = 0.5
    else:
        learn["llm_weight"] /= total
        learn["ev_weight"] /= total
    return learn

def apply_style(learn, style="defensive"):
    """
    Apply personality bias at game start.
    Does NOT overwrite learning, just nudges it.
    """

    style = (style or "defensive").lower()

    if style == "balanced":
        # default — no change
        pass

    elif style == "aggressive":
        learn["llm_weight"] += 0.15
        learn["ev_weight"] -= 0.05
        learn["explore"] += 0.05

    elif style == "defensive":
        learn["llm_weight"] -= 0.05
        learn["ev_weight"] += 0.15
        learn["explore"] -= 0.03

    elif style == "Gambler":
        learn["explore"] += 0.20

    elif style == "calculated":
        learn["ev_weight"] += 0.20
        learn["llm_weight"] -= 0.05
        learn["explore"] -= 0.05

    elif style == "Ego Agent":
        learn["ev_weight"] += 0.20
        learn["llm_weight"] += 0.15
        learn["explore"] += 0.10

    # clamp explore
    learn["explore"] = max(0.01, min(0.5, learn["explore"]))

    # normalize llm/ev
    learn = normalize_weights(learn)

    return learn

# ================= PAY MATCH - IMPROVED =================
def pay_match(match_id):
    try:
        # ตรวจสอบสถานะ match ก่อนจ่าย
        match_info = contract.functions.getMatch(match_id).call()
        player1, player2, bet_amount, player1_paid, player2_paid, status, winner = match_info
        
        print(f"📊 Match #{match_id} status:")
        print(f"   Player1: {player1} (paid: {player1_paid})")
        print(f"   Player2: {player2} (paid: {player2_paid})")
        print(f"   Status: {status}")
        print(f"   Bet Amount: {w3.from_wei(bet_amount, 'ether')} ETH")
        
        # ⭐ ใช้ bet amount จาก match แทนที่จะใช้จาก .env
        bet_wei = bet_amount
        
        # ตรวจสอบยอดเงินในกระเป๋า
        balance = w3.eth.get_balance(acct.address)
        
        print(f"💰 Wallet balance: {w3.from_wei(balance, 'ether')} ETH")
        print(f"💰 Required bet: {w3.from_wei(bet_wei, 'ether')} ETH")
        
        if balance < bet_wei:
            print(f"❌ Insufficient balance. Need {w3.from_wei(bet_wei, 'ether')} ETH, have {w3.from_wei(balance, 'ether')} ETH")
            return False
        
        # ⭐ ตรวจสอบว่าเราเป็น player ในนี้จริงๆ
        is_player1 = acct.address.lower() == player1.lower()
        is_player2 = acct.address.lower() == player2.lower()
        
        if not is_player1 and not is_player2:
            print(f"❌ ERROR: We ({acct.address}) are NOT in match #{match_id}!")
            print(f"   This match is for {player1} vs {player2}")
            return False
        
        # ตรวจสอบว่าเราเป็น player ไหน และจ่ายแล้วหรือยัง
        if is_player1 and player1_paid:
            print("✅ Already paid (Player 1)")
            return True
        elif is_player2 and player2_paid:
            print("✅ Already paid (Player 2)")
            return True
            
        # สร้าง transaction
        nonce = w3.eth.get_transaction_count(acct.address)
        
        # ประมาณค่า gas
        try:
            gas_estimate = contract.functions.joinMatch(match_id).estimate_gas({
                "from": acct.address,
                "value": bet_wei
            })
            gas_limit = int(gas_estimate * 1.2)  # เพิ่ม 20% เผื่อ
        except Exception as e:
            print(f"⚠️ Gas estimation failed: {e}")
            gas_limit = 200000  # ใช้ค่า default
            
        print(f"⛽ Gas limit: {gas_limit}")
        
        # สร้างและส่ง transaction (ใช้ joinMatch แทน payMatch)
        tx = contract.functions.joinMatch(match_id).build_transaction({
            "from": acct.address,
            "value": bet_wei,
            "nonce": nonce,
            "gas": gas_limit,
            "gasPrice": w3.eth.gas_price
        })

        signed = acct.sign_transaction(tx)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)

        print(f"📤 Tx sent: {tx_hash.hex()}")
        print("⏳ Waiting for confirmation...")
        
        # รอ transaction จนเสร็จ (timeout 120 วินาที)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        
        if receipt.status == 1:
            print("✅ Payment successful!")
            print(f"   Gas used: {receipt.gasUsed}")
            return True
        else:
            print("❌ Transaction failed!")
            return False

    except Exception as e:
        print(f"❌ Payment error: {e}")
        import traceback
        traceback.print_exc()
        return False

def wait_for_payment(match_id, max_retries=3, retry_delay=5):
    """
    รอและ retry การจ่ายเงินหากล้มเหลว
    """
    for attempt in range(max_retries):
        print(f"\n🔄 Payment attempt {attempt + 1}/{max_retries}")
        
        success = pay_match(match_id)
        
        if success:
            return True
            
        if attempt < max_retries - 1:
            print(f"⏳ Retrying in {retry_delay} seconds...")
            time.sleep(retry_delay)
    
    print("❌ Failed to pay after all retries")
    return False

# ================= MEMORY HELPERS =================
def load_game_mem():
    if not os.path.exists(GAME_MEM): return []
    return json.load(open(GAME_MEM))

def save_game_mem(m): json.dump(m,open(GAME_MEM,"w"),indent=2)

def push_game_result(game_data):
    m = load_game_mem()

    # ถ้าเต็มแล้ว ลบเกมเก่าสุด (ตัวแรก)
    if len(m) >= MAX_GAME_MEM:
        m.pop(0)   # ⭐ ลบ index 0 = เก่าสุด

    # เพิ่มเกมใหม่ท้าย list
    m.append(game_data)

    save_game_mem(m)
def load_mem():
    if not os.path.exists(MEM): return []
    return json.load(open(MEM))

def save_mem(m): json.dump(m,open(MEM,"w"),indent=2)

def push_mem(entry):
    m=load_mem()
    m.append(entry)
    save_mem(m)

def clear_turn_mem():
    save_mem([])

def load_learn():
    if not os.path.exists(LEARN):
        return {"llm_weight":0.7,"ev_weight":0.3,"explore":0.1}
    return json.load(open(LEARN))

def save_learn(l): json.dump(l,open(LEARN,"w"),indent=2)

# ================= BELIEF =================
def build_belief():
    games=load_game_mem()
    if not games:
        return {"opp_avg_aggr":0.5,"opp_early_aggr":0.5,"winning_strategy":"balanced"}

    total_aggr=[]
    winning_strats=[]

    for g in games:
        if "opp_aggression" in g:
            total_aggr.append(g["opp_aggression"])
        if g.get("won") and "winning_pattern" in g:
            winning_strats.append(g["winning_pattern"])

    return {
        "opp_avg_aggr": round(sum(total_aggr)/len(total_aggr),3) if total_aggr else 0.5,
        "opp_early_aggr":0.5,
        "winning_strategy": winning_strats[-1] if winning_strats else "balanced"
    }

# ================= PROB =================
def compute_prob(state):

    bullets = state.get("bullets", {})

    real = bullets.get("real")
    blank = bullets.get("blank")

    if real is None or blank is None:
        return 0.5, 0.5, 0, 0

    total = real + blank
    if total == 0:
        return 0.5, 0.5, real, blank

    return real/total, blank/total, real, blank


def compute_ev(p_real,p_blank,real,blank):
    total=real+blank
    ev_other=p_real
    nextp=real/(total-1) if total>1 else 0.5
    ev_self=p_real*(-1)+p_blank*(nextp)
    return ev_self,ev_other

# ================= LLM =================
def ask_llm(ctx, belief, turn_history, game_history):
    """
    ปรับปรุง LLM reasoning ให้ลึกซึ้งมากขึ้น
    """
    # สร้าง context จาก game history
    recent_games = "\n".join([
        f"Game {i+1}: {'Won' if g.get('won') else 'Lost'} - {g.get('winning_pattern', 'N/A')}"
        for i, g in enumerate(game_history[-3:])
    ]) if game_history else "No previous games"
    
    # สร้าง turn history summary
    recent_turns = "\n".join([
        f"Turn {i+1}: {t.get('action', 'N/A')} -> {t.get('result', 'N/A')}"
        for i, t in enumerate(turn_history[-5:])
    ]) if turn_history else "No previous turns"
    
    prompt = f"""You are playing Russian Roulette. Analyze the situation deeply and make the optimal decision.

CURRENT GAME STATE:
- My HP: {ctx['my_hp']} | Opponent HP: {ctx['opp_hp']}
- Bullets left: {ctx['real_left']} real, {ctx['blank_left']} blank
- P(Real): {ctx['p_real']:.2%} | P(Blank): {1-ctx['p_real']:.2%}
- EV(shoot self): {ctx['ev_self']:.3f} | EV(shoot other): {ctx['ev_other']:.3f}

OPPONENT BEHAVIOR (from past games):
- Average aggression: {belief.get('opp_avg_aggr', 0.5):.2f}
- Early game aggression: {belief.get('opp_early_aggr', 0.5):.2f}
- Winning strategy pattern: {belief.get('winning_strategy', 'unknown')}

RECENT GAME HISTORY:
{recent_games}

CURRENT GAME TURNS:
{recent_turns}

STRATEGIC CONSIDERATIONS:
1. HP advantage/disadvantage
2. Probability of real bullet
3. Expected value calculation
4. Risk tolerance based on HP
5. Opponent's likely strategy
6. Endgame positioning

DECISION RULES:
- If blank probability > 70% AND you need turns → shoot self
- If real probability > 60% AND opponent HP > yours → shoot other
- If HP advantage ≥ 2 → more offensive (shoot self on blanks)
- If HP disadvantage → conservative (prioritize opponent shots)

Return ONLY valid JSON (no markdown):
{{"decision": "self" or "other", "confidence": 0.0-1.0, "reason": "detailed explanation", "strategy_type": "offensive/conservative"}}
"""
    
    try:
        r = model.generate_content(
            prompt,
            safety_settings={HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_NONE},
            generation_config={"temperature": 0.7, "top_p": 0.9}
        )
        
        # Extract JSON
        text = r.text.strip()
        # Remove markdown code blocks if present
        text = re.sub(r'```json\s*', '', text)
        text = re.sub(r'```\s*', '', text)
        
        m = re.search(r'\{.*\}', text, re.DOTALL)
        if m:
            result = json.loads(m.group(0))
            return result
            
    except Exception as e:
        print(f"⚠️ LLM error: {e}")
    
    # Fallback to EV-based decision
    fallback_decision = "self" if ctx["ev_self"] > ctx["ev_other"] else "other"
    return {
        "decision": fallback_decision,
        "confidence": 0.5,
        "reason": "LLM failed, using EV fallback",
        "strategy_type": "fallback"
    }

# ================= POLICY =================
def choose_action(ctx,llm):
    learn=load_learn()
    llm_conf=llm.get("confidence",0.5)
    ev_decision="self" if ctx["ev_self"]>ctx["ev_other"] else "other"

    if random.random()<learn["explore"]:
        return random.choice(["self","other"])

    if llm["decision"]==ev_decision:
        return ev_decision
    return llm["decision"] if llm_conf>0.6 else ev_decision

# ================= ACTION =================
def shoot(action, ctx, llm):
    payload = {"wallet_address": MY_ID, "action": "shoot", "target": action}
    r = requests.post(f"{SERVER}/action", json=payload)
    data = r.json()
    
    bullet = data.get("bullet", "unknown")
    result = data.get("result", "")
    
    if bullet == "real":
        print(f"   💥 REAL bullet! {result}")
    else:
        print(f"   🔘 BLANK bullet! {result}")
    
    turn_data = {
        "action": action,
        "target": action,
        "bullet": bullet,
        "result": result,
        "my_hp_before": ctx["my_hp"],
        "opp_hp_before": ctx["opp_hp"],
        "p_real": ctx["p_real"],
        "ev_self": ctx["ev_self"],
        "ev_other": ctx["ev_other"],
        "llm_decision": llm.get("decision"),
        "llm_confidence": llm.get("confidence"),
        "strategy_type": llm.get("strategy_type")
    }
    push_mem(turn_data)

    # ⭐ FIX: return winner from server
    if data.get("winner"):
        winner = data["winner"]
        print(f"\n🏁 Game Over! Winner: {winner}")
        return True, winner

    return False, None

def wait_for_state_change(prev_state, timeout=10):
    """
    รอจนกว่า state จะเปลี่ยนจริง (turn / history / bullets)
    ป้องกันอ่าน state cache เดิม
    """
    start = time.time()

    prev_turn = prev_state.get("currentTurn")
    prev_hist_len = len(prev_state.get("actionHistory", []))

    while time.time() - start < timeout:
        try:
            s = requests.get(f"{SERVER}/world/state").json()

            if not s:
                time.sleep(0.3)
                continue

            # ✔ ถ้า turn เปลี่ยน
            if s.get("currentTurn") != prev_turn:
                return s

            # ✔ หรือมี action เพิ่ม
            if len(s.get("actionHistory", [])) > prev_hist_len:
                return s

        except:
            pass

        time.sleep(0.3)

    return prev_state  # fallback

# ================= LOOP =================
def play_single_game(match_id):
    """
    เล่นเกมเดียวจนจบ พร้อมเก็บ memory และ learning
    Returns: True ถ้าชนะ, False ถ้าแพ้
    """
    print("\n🎮 Game started! Waiting for my turn...\n")
    
    # Clear turn memory สำหรับเกมใหม่
    clear_turn_mem()
    
    # โหลด game history และ belief
    game_history = load_game_mem()
    belief = build_belief()
    
    game_start_time = time.time()
    total_turns = 0
    
    last_state = None

    while True:
        try:
            raw = requests.get(f"{SERVER}/world/state").json()

            if last_state is not None:
                s = wait_for_state_change(last_state)
            else:
                s = raw

            last_state = s

            
            if not s or not s.get("started"):
                time.sleep(1)
                continue

            if s.get("currentTurn") == MY_ID:
                total_turns += 1
                
                p_real, p_blank, real, blank = compute_prob(s)
                ev_self, ev_other = compute_ev(p_real, p_blank, real, blank)

                opp = [p for p in s["players"] if p != MY_ID][0]

                ctx = {
                    "my_hp": s["hp"][MY_ID],
                    "opp_hp": s["hp"][opp],
                    "p_real": p_real,
                    "p_blank": p_blank,
                    "real_left": real,
                    "blank_left": blank,
                    "ev_self": ev_self,
                    "ev_other": ev_other
                }

                print(f"\n🎯 Turn #{total_turns}")
                print(f"   HP: {ctx['my_hp']} vs {ctx['opp_hp']}")
                print(f"   Bullets: {real}R/{blank}B | P(real): {ctx['p_real']:.2%}")
                print(f"   EV: self={ctx['ev_self']:.2f} | other={ctx['ev_other']:.2f}")

                # ใช้ turn history และ game history
                turn_history = load_mem()
                llm = ask_llm(ctx, belief, turn_history, game_history)
                action = choose_action(ctx, llm)
                
                print(f"   Decision: {action} (LLM: {llm['decision']}, conf: {llm.get('confidence', 0):.2f})")
                print(f"   Reason: {llm.get('reason', 'N/A')}")
                print(f"   Strategy: {llm.get('strategy_type', 'N/A')}")
                
                game_over, winner = shoot(action, ctx, llm)
                last_state = wait_for_state_change(last_state)
                if game_over:
                    # ⭐ FIX: เช็คจาก winner จริง ไม่ใช้ ctx
                    won = (winner.lower() == MY_ID.lower())

                    game_duration = time.time() - game_start_time
                    turn_history = load_mem()

                    opp_aggression = sum(
                        1 for t in turn_history if t.get('target') == 'other'
                    ) / max(len(turn_history), 1)

                    game_data = {
                        "won": won,
                        "final_my_hp": ctx['my_hp'] if won else 0,
                        "final_opp_hp": ctx['opp_hp'] if not won else 0,
                        "total_turns": total_turns,
                        "duration_seconds": round(game_duration, 2),
                        "opp_aggression": round(opp_aggression, 3),
                        "winning_pattern": llm.get('strategy_type', 'unknown'),
                        "avg_confidence": round(
                            sum(t.get('llm_confidence', 0) for t in turn_history)
                            / max(len(turn_history), 1),
                            3
                        )
                    }

                    push_game_result(game_data)
                    update_learning(won, turn_history)

                    print(f"\n📊 Game Stats:")
                    print(f"   Turns played: {total_turns}")
                    print(f"   Duration: {game_duration:.1f}s")
                    print(f"   Opponent aggression: {opp_aggression:.2%}")

                    return won
            
            # ⭐ ตรวจสอบว่าเกมจบหรือยัง (กรณีที่ไม่ใช่เทิร์นเรา)
            if s.get("started"):
                my_hp = s["hp"].get(MY_ID, 0)
                opp = [p for p in s["players"] if p != MY_ID]
                opp_hp = s["hp"].get(opp[0], 0) if opp else 0
                
                if my_hp <= 0:
                    print("\n💀 Our HP reached 0!")
                    print("😞 We lost...")
                    
                    # บันทึกผลแพ้
                    game_duration = time.time() - game_start_time
                    turn_history = load_mem()
                    opp_aggression = sum(1 for t in turn_history if t.get('target') == 'other') / max(len(turn_history), 1)
                    
                    game_data = {
                        "won": False,
                        "final_my_hp": 0,
                        "final_opp_hp": opp_hp,
                        "total_turns": total_turns,
                        "duration_seconds": round(game_duration, 2),
                        "opp_aggression": round(opp_aggression, 3),
                        "winning_pattern": "loss",
                        "avg_confidence": round(sum(t.get('llm_confidence', 0) for t in turn_history) / max(len(turn_history), 1), 3)
                    }
                    push_game_result(game_data)
                    update_learning(False, turn_history)
                    
                    return False
                    
                elif opp_hp <= 0:
                    print("\n🎉 Opponent's HP reached 0!")
                    print("🎉 WE WON!")
                    
                    # บันทึกผลชนะ
                    game_duration = time.time() - game_start_time
                    turn_history = load_mem()
                    opp_aggression = sum(1 for t in turn_history if t.get('target') == 'other') / max(len(turn_history), 1)
                    
                    game_data = {
                        "won": True,
                        "final_my_hp": my_hp,
                        "final_opp_hp": 0,
                        "total_turns": total_turns,
                        "duration_seconds": round(game_duration, 2),
                        "opp_aggression": round(opp_aggression, 3),
                        "winning_pattern": "victory",
                        "avg_confidence": round(sum(t.get('llm_confidence', 0) for t in turn_history) / max(len(turn_history), 1), 3)
                    }
                    push_game_result(game_data)
                    update_learning(True, turn_history)
                    
                    return True

            time.sleep(1)
            
        except KeyboardInterrupt:
            print("\n\n👋 Bot stopped by user")
            sys.exit(0)
        except Exception as e:
            print(f"❌ Error in game loop: {e}")
            time.sleep(2)

def update_learning(won, turn_history):
    """
    อัพเดท learning parameters ตามผลการเล่น
    """
    learn = load_learn()
    
    # ปรับ explore rate
    if won:
        learn["explore"] = max(0.05, learn["explore"] - 0.01)  # ลด exploration เมื่อชนะ
    else:
        learn["explore"] = min(0.2, learn["explore"] + 0.02)  # เพิ่ม exploration เมื่อแพ้
    
    # วิเคราะห์ว่า LLM ทำงานได้ดีแค่ไหน
    high_conf_turns = [t for t in turn_history if t.get('llm_confidence', 0) > 0.7]
    if high_conf_turns:
        high_conf_correct = sum(1 for t in high_conf_turns if (
            (t.get('bullet') == 'blank' and t.get('target') == 'self') or
            (t.get('bullet') == 'real' and t.get('target') == 'other')
        ))
        llm_accuracy = high_conf_correct / len(high_conf_turns)
        
        # ปรับ weight
        if llm_accuracy > 0.6:
            learn["llm_weight"] = min(0.9, learn["llm_weight"] + 0.05)
            learn["ev_weight"] = max(0.1, learn["ev_weight"] - 0.05)
        else:
            learn["llm_weight"] = max(0.5, learn["llm_weight"] - 0.05)
            learn["ev_weight"] = min(0.5, learn["ev_weight"] + 0.05)
    
    save_learn(learn)
    
    print(f"\n🧠 Learning Update:")
    print(f"   LLM weight: {learn['llm_weight']:.2f}")
    print(f"   EV weight: {learn['ev_weight']:.2f}")
    print(f"   Exploration rate: {learn['explore']:.2%}")

def run_bot():
    """
    Main bot loop - เล่น 1 เกมแล้วหยุด
    """
    print("Starting Advanced AI Bot...")
    print(f"   Wallet: {MY_ID}")
    print(f"   Arena: {ARENA}")
    print(f"   Bet: {BET} ETH per game")
    
    # โหลด learning state
    learn = load_learn()
# ⭐ APPLY STYLE ตรงนี้
    learn = apply_style(learn, STYLE)
    save_learn(learn)

    print(f"\nAgent style: {STYLE}")
    print(f"\nCurrent Learning State:")
    print(f"   LLM weight: {learn['llm_weight']:.2f}")
    print(f"   EV weight: {learn['ev_weight']:.2f}")
    print(f"   Exploration: {learn['explore']:.2%}")
    
    # โหลด game history
    game_history = load_game_mem()
    if game_history:
        wins = sum(1 for g in game_history if g.get('won'))
        print(f"\n📚 Historical Performance:")
        print(f"   Last {len(game_history)} games: {wins}W/{len(game_history)-wins}L")
        print(f"   Win rate: {wins/len(game_history)*100:.1f}%")
    
    try:
        print(f"\n{'='*60}")
        print(f"🎲 STARTING GAME")
        print(f"{'='*60}\n")
        
        # Join arena
        print("📝 Joining arena...")
        r = requests.post(f"{SERVER}/join", json={"wallet_address": MY_ID}).json()
        print(f"✅ Joined: {r}")

        match_id = r.get("matchId")
        
        # ถ้าไม่มี matchId จาก response (Agent 1) ให้รอแล้วถามซ้ำ
        if match_id is None:
            print("\n⏳ Waiting for opponent to join...")
            
            # รอสูงสุด 120 วินาทีให้มีคู่
            for i in range(120):
                time.sleep(2)
                
                # ถามซ้ำเพื่อดู matchId อัพเดตหรือยัง
                try:
                    r = requests.post(f"{SERVER}/join", json={"wallet_address": MY_ID}).json()
                    match_id = r.get("matchId")
                    
                    if match_id is not None:
                        print(f"✅ Match #{match_id} created! Opponent joined!")
                        break
                        
                except Exception as e:
                    print(f"⚠️ Error checking match: {e}")
                    
                if (i + 1) % 5 == 0:
                    print(f"   Still waiting... ({(i + 1) * 2}s)")
            
            if match_id is None:
                print("❌ No opponent found after 120 seconds")
                print("💡 Exiting...")
                sys.exit(1)
        
        # Pay escrow ถ้ามี matchId
        if match_id is not None:
            print(f"\n💰 Processing payment for match #{match_id}...")
            
            # ใช้ฟังก์ชันที่มี retry
            payment_success = wait_for_payment(match_id, max_retries=3, retry_delay=5)
            
            if not payment_success:
                print("❌ Could not complete payment.")
                print("💡 Exiting...")
                sys.exit(1)
            
            # รอให้ payment settle
            print("⏳ Waiting for payment to settle...")
            time.sleep(5)

        # เล่นเกม
        won = play_single_game(match_id)
        
        # แสดงผลสรุป
        print(f"\n{'='*60}")
        if won:
            print("🎉 GAME RESULT: VICTORY!")
        else:
            print("😞 GAME RESULT: DEFEAT")
        print(f"{'='*60}")
        
        # แสดง updated learning state
        learn = load_learn()
        print(f"\n🎯 Updated Learning State:")
        print(f"   Exploration rate: {learn['explore']:.2%}")
        print(f"   LLM weight: {learn['llm_weight']:.2%}")
        print(f"   EV weight: {learn['ev_weight']:.2%}")
        
        # แสดง historical stats
        all_games = load_game_mem()
        if all_games:
            total_wins = sum(1 for g in all_games if g.get('won'))
            print(f"\n📚 HISTORICAL PERFORMANCE:")
            print(f"   Total games: {len(all_games)}")
            print(f"   Total wins: {total_wins} | Total losses: {len(all_games) - total_wins}")
            print(f"   Overall win rate: {(total_wins/len(all_games)*100):.1f}%")
            
            # Average stats
            avg_turns = sum(g.get('total_turns', 0) for g in all_games) / len(all_games)
            avg_duration = sum(g.get('duration_seconds', 0) for g in all_games) / len(all_games)
            print(f"   Avg turns per game: {avg_turns:.1f}")
            print(f"   Avg game duration: {avg_duration:.1f}s")
        
        print(f"\n{'='*60}")
        print("👋 Bot completed successfully")
        print(f"{'='*60}\n")
        
    except KeyboardInterrupt:
        print(f"\n\n{'='*60}")
        print("👋 Bot stopped by user")
        print(f"{'='*60}")
        sys.exit(0)
    except Exception as e:
        print(f"❌ Critical error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__=="__main__":
    run_bot()