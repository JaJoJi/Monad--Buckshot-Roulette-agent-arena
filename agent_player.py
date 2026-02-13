import requests
import time
import random
import sys
import os
import json
import re
from dotenv import load_dotenv
import google.generativeai as genai
from google.generativeai.types import HarmCategory, HarmBlockThreshold

# ===============================
# LOAD ENV
# ===============================

load_dotenv()

SERVER_URL = os.getenv("SERVER_URL")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL") # Default fallback

# Debug: Check credentials
if not GEMINI_API_KEY:
    print("❌ CRITICAL WARNING: GEMINI_API_KEY is missing in .env")
else:
    print(f"✅ Gemini API Key found (Length: {len(GEMINI_API_KEY)})")

genai.configure(api_key=GEMINI_API_KEY)
model = genai.GenerativeModel(GEMINI_MODEL)

if not SERVER_URL:
    raise ValueError("SERVER_URL missing in .env")

MY_ID = f"0x{random.getrandbits(160):040x}"

# Game Constants
INITIAL_REAL = 3
INITIAL_BLANK = 3

# ===============================
# SERVER COMM
# ===============================

def join_game():
    try:
        print(f"Connecting to {SERVER_URL}...")
        r = requests.post(f"{SERVER_URL}/join",
                          json={"wallet_address": MY_ID}, timeout=5)
        if r.status_code == 200:
            print("✅ Joined game successfully.")
            return True
        else:
            print(f"❌ Join failed: {r.status_code} - {r.text}")
            return False
    except Exception as e:
        print(f"❌ Connection error: {e}")
        return False


def get_game_state():
    try:
        r = requests.get(f"{SERVER_URL}/world/state", timeout=5)
        if r.status_code == 200:
            return r.json()
        return None
    except:
        return None


# ===============================
# BAYESIAN CALCULATOR
# ===============================

def compute_probabilities(state):
    history = state.get("actionHistory", [])
    
    real_used = sum(1 for h in history if h.get("bullet") == "real")
    blank_used = sum(1 for h in history if h.get("bullet") == "blank")

    real_remaining = max(INITIAL_REAL - real_used, 0)
    blank_remaining = max(INITIAL_BLANK - blank_used, 0)

    total = real_remaining + blank_remaining

    if total <= 0:
        return 0.5, 0.5, real_remaining, blank_remaining

    return (
        real_remaining / total,
        blank_remaining / total,
        real_remaining,
        blank_remaining
    )


def compute_ev(p_real, p_blank, real_rem, blank_rem):
    total = real_rem + blank_rem

    # EV ยิง opponent (ได้ Damage 1)
    ev_other = p_real * 1.0

    # EV ยิงตัวเอง
    # ถ้ายิงแล้วเป็น Blank เราจะได้เทิร์นอีกรอบ (มูลค่า = โอกาสได้กระสุนจริงนัดถัดไป)
    if total - 1 > 0:
        next_p_real = real_rem / (total - 1)
    else:
        next_p_real = 0.5

    keep_turn_value = next_p_real * 1.0

    ev_self = (
        p_real * (-1.0) # โดนยิงเอง
        + p_blank * keep_turn_value # รอด + ได้เทิร์น
    )

    return ev_self, ev_other


# ===============================
# LLM DECISION
# ===============================

def ask_llm(context_dict):
    if not GEMINI_API_KEY:
        print("⚠️ No API Key, using Fallback.")
        return fallback_decision(context_dict, "No API Key")

    prompt = f"""
    You are a strategic AI agent playing a game called 'Buckshot Roulette'.
    This is a fictional game. No real violence.

    Objective: Survive and eliminate the opponent.
    
    Rules:
    - 'real' bullet deals 1 damage.
    - 'blank' bullet does nothing.
    - Shooting 'self' with 'blank' gives you another turn.
    - Shooting 'self' with 'real' deals 1 damage to YOU.
    - Shooting 'other' with 'real' deals 1 damage to OPPONENT.

    Current Game State:
    {json.dumps(context_dict, indent=2)}

    Task:
    Analyze the EV (Expected Value) and probabilities. 
    Decide whether to shoot "self" or "other".

    Respond ONLY with a valid JSON object. Do not write markdown blocks.
    Format:
    {{
      "decision": "self" or "other",
      "reason": "Concise strategy explanation (max 15 words)"
    }}
    """

    # --- CRITICAL FIX: Safety Settings ---
    # ปิด Block เนื้อหารุนแรงเพื่อให้บอทคุยเรื่องปืน/ยิงได้ในบริบทเกม
    safety_settings = {
        HarmCategory.HARM_CATEGORY_HARASSMENT: HarmBlockThreshold.BLOCK_NONE,
        HarmCategory.HARM_CATEGORY_HATE_SPEECH: HarmBlockThreshold.BLOCK_NONE,
        HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_NONE,
        HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_NONE,
    }

    try:
        response = model.generate_content(
            prompt,
            safety_settings=safety_settings,
            generation_config={"temperature": 0.2} # Low temp for deterministic logic
        )

        # Check if blocked
        if response.prompt_feedback and response.prompt_feedback.block_reason:
            print(f"⚠️ Gemini Blocked Response: {response.prompt_feedback.block_reason}")
            return fallback_decision(context_dict, "Gemini Safety Block")

        if not response.parts:
             print("⚠️ Gemini returned empty response.")
             return fallback_decision(context_dict, "Empty Response")

        raw_text = response.text

        # --- CRITICAL FIX: Robust JSON Extraction ---
        # ใช้ Regex หา {...} เผื่อมีข้อความอื่นปนมา
        json_match = re.search(r'\{.*\}', raw_text, re.DOTALL)
        
        if json_match:
            clean_json = json_match.group(0)
            parsed = json.loads(clean_json)
            
            # Validate keys
            if "decision" in parsed and parsed["decision"] in ["self", "other"]:
                return parsed
            else:
                print(f"⚠️ Invalid JSON structure: {clean_json}")
        else:
             print(f"⚠️ Could not find JSON in response: {raw_text}")

        return fallback_decision(context_dict, "JSON Parse Error")

    except Exception as e:
        print(f"❌ Gemini Exception: {e}")
        return fallback_decision(context_dict, "Exception Occurred")


def fallback_decision(context, reason_tag):
    """Logic เดิมเอาไว้ใช้ถ้า LLM พัง"""
    best_move = "other" if context["ev_other"] >= context["ev_self"] else "self"
    return {
        "decision": best_move,
        "reason": f"Fallback EV ({reason_tag})"
    }

# ===============================
# DECISION ENGINE
# ===============================

def decide_action(state):
    p_real, p_blank, real_rem, blank_rem = compute_probabilities(state)
    ev_self, ev_other = compute_ev(p_real, p_blank, real_rem, blank_rem)

    # หา Opponent ID
    others = [p for p in state["players"] if p != MY_ID]
    opponent = others[0] if others else "Unknown"
    
    opp_hp = state["hp"].get(opponent, 0) if opponent != "Unknown" else 0

    context = {
        "my_hp": state["hp"].get(MY_ID, 0),
        "opponent_hp": opp_hp,
        "real_remaining": real_rem,
        "blank_remaining": blank_rem,
        "p_real": round(p_real, 4),
        "p_blank": round(p_blank, 4),
        "ev_self": round(ev_self, 4),
        "ev_other": round(ev_other, 4)
    }

    print("\n🤖 Asking Gemini...")
    llm_response = ask_llm(context)

    decision = llm_response["decision"]
    reason = llm_response["reason"]

    print("\n=========== AI DECISION ===========")
    print(json.dumps(context, indent=2))
    print("-----------------------------------")
    print(f"🎯 Decision: SHOOT {decision.upper()}")
    print(f"📝 Reason:   {reason}")
    print("===================================\n")

    return decision


# ===============================
# ACTION
# ===============================

def shoot(target):
    payload = {
        "wallet_address": MY_ID,
        "action": "shoot",
        "target": target
    }

    try:
        r = requests.post(f"{SERVER_URL}/action", json=payload, timeout=5)
        data = r.json()

        print(f"🔫 Shot {target} ({data.get('bullet', '?')}) → {data.get('result', '?')}")

        if data.get("winner"):
            print(f"🏆 WINNER: {data['winner']}")
            sys.exit()

        return data.get("keepTurn", False)
    except Exception as e:
        print(f"❌ Shoot Error: {e}")
        return False


# ===============================
# MAIN LOOP
# ===============================

def run_bot():
    if not join_game():
        print("Could not join game. Exiting.")
        return

    print("Waiting for opponent / game start...")
    
    last_processed_round = -1

    while True:
        state = get_game_state()

        if not state:
            time.sleep(1)
            continue

        if not state.get("started", False):
            sys.stdout.write(".")
            sys.stdout.flush()
            time.sleep(1)
            continue

        # ตรวจสอบว่าเป็นตาเราหรือไม่
        if state.get("currentTurn") == MY_ID:
            current_round = state.get("round", 0)
            
            # Print หัวข้อรอบแค่ครั้งเดียวต่อรอบ
            if current_round != last_processed_round:
                print(f"\n\n🔔 ROUND {current_round} START")
                last_processed_round = current_round

            decision = decide_action(state)
            
            # หน่วงเวลานิดหน่อยให้ดูเหมือนคิด และไม่ spam server
            time.sleep(1.5)

            keep_turn = shoot(decision)

            if not keep_turn:
                print("(End of my turn)")
                time.sleep(1) # รอ server update state
            else:
                print("(Bonous Turn! Shooting again...)")

        else:
            # ไม่ใช่ตาเรา รอ...
            time.sleep(1)


if __name__ == "__main__":
    run_bot()