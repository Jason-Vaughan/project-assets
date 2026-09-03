import sys, json

machine = sys.argv[1]
usage_file = sys.argv[2]
state_file = sys.argv[3]
ccusage_json_str = sys.stdin.read()

# get prev_total
try:
    with open(usage_file) as f:
        usage = json.load(f)
        prev_total = usage.get("byMachine", {}).get(machine, 0)
except Exception:
    prev_total = 0

# get state
try:
    with open(state_file) as f:
        state = json.load(f)
    is_first_run = False
except Exception:
    state = {}
    is_first_run = True

try:
    data = json.loads(ccusage_json_str)
    daily = data.get("daily", []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
    if len(daily) > 0 and isinstance(daily[0], str): daily = []
except Exception:
    daily = []

delta = 0
for day in daily:
    if isinstance(day, dict) and "date" in day:
        date = day["date"]
        new_tokens = int(day.get("totalTokens", 0))
        old_tokens = state.get(date, 0)
        
        if new_tokens > old_tokens:
            if not is_first_run:
                delta += (new_tokens - old_tokens)
            state[date] = new_tokens

with open(state_file, 'w') as f:
    json.dump(state, f)

print(prev_total + delta)
