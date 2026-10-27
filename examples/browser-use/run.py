"""Browser Use, unmodified, on Muse Spark (Meta API), filling the Brightwater quote.

    python run.py --mode without        Browser Use alone
    python run.py --mode with           Browser Use with Usher: npx @usher-run/mcp as tools
    python run.py --mode fill           Browser Use with only usher_fill: the server fills, the agent decides
    python run.py --mode both --runs 2

Run it from outside this repository: inside it, npx resolves @usher-run/mcp to the local workspace
instead of the published package (USHER_MCP="node path/to/cli.js" runs a local build). CHROME_PATH picks the browser. Reads MODEL_API_KEY from the environment or the repository's .env. Writes one JSON line per run to
results.jsonl. The driver is fictional (packages/agent/profiles/test-driver.json).
"""

import argparse
import asyncio
import json
import os
import pathlib
import tempfile
import time

from browser_use import Agent, BrowserProfile, Tools
from browser_use.llm.openai.chat import ChatOpenAI
from browser_use.mcp.client import MCPClient

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
# The public registry and demo form, as @usher-run/mcp names them.
DEFAULTS = json.loads((ROOT / 'packages/mcp/package.json').read_text())['usher']
REGISTRY = os.environ.get('USHER_REGISTRY_URL', DEFAULTS['defaultRegistry'])
START = os.environ.get('BRIGHTWATER_URL', DEFAULTS['demoForm'])
PROFILE = {k: v for k, v in json.loads((ROOT / 'packages/agent/profiles/test-driver.json').read_text()).items() if not k.startswith('_')}

DRIVER = f"""Get a car insurance quote at {START} for this driver. The data is fictional test data:
{json.dumps(PROFILE, indent=2)}
Fill every step (about you, the car, the cover) and submit each one. The person has agreed to the
declaration and does not want marketing. They have confirmed you may press "Get my quote". You are
done when the page shows the quoted price: report the price."""

USHER = """
This site uses Usher, and you have its tools. On each of the three steps, before filling anything:
1. Call the knock tool with the page's URL and intent "quote.car_insurance". It returns a "map"
   (every field with its key, label and risk), the site's "rules" and a "token".
2. Bind the token in the page by running JavaScript (the evaluate action):
   window.usher.bind("<token>")
3. Fill the fields using the map's labels and keys to match the data above, without re-reading the
   whole page. Before pressing "Get my quote", knock again with confirmed: ["form.submit"] and bind
   that token too."""

FILL = f"""Get a car insurance quote at {START} for this driver. The data is fictional test data:
{json.dumps(PROFILE, indent=2)}
Use the usher_fill tool: url {START}, intent "quote.car_insurance", and the data above as values
(same keys), leaving out consent.declaration and consent.marketing. You don't need the browser.
usher_fill pauses for each decision and returns an id. Answer with usher_confirm (id, answer): the
person has agreed to the declaration (true), does not want marketing (false), and has confirmed you
may press "Get my quote" (true). You are done when it returns status "completed": report the
outcome and the session id."""


def llm() -> ChatOpenAI:
    key = os.environ.get('MODEL_API_KEY')
    if not key and (ROOT / '.env').exists():
        for line in (ROOT / '.env').read_text().splitlines():
            if line.startswith('MODEL_API_KEY='):
                key = line.split('=', 1)[1].strip().strip('"')
    if not key:
        raise SystemExit('Set MODEL_API_KEY (Meta Model API).')
    return ChatOpenAI(model=os.environ.get('USHER_COMPILER_MODEL', 'muse-spark-1.3'), base_url='https://api.meta.ai/v1', api_key=key, temperature=0)


async def run(mode: str) -> dict:
    tools = Tools()
    mcp = None
    if mode in ('with', 'fill'):
        key_file = os.path.join(tempfile.mkdtemp(prefix='usher-bu-'), 'agent-key.json')
        command, *rest = os.environ.get('USHER_MCP', 'npx -y @usher-run/mcp').split()
        mcp = MCPClient(server_name='usher', command=command, args=rest, env={**os.environ, 'USHER_REGISTRY_URL': REGISTRY, 'USHER_AGENT_KEY_FILE': key_file})
        await mcp.connect()
        await mcp.register_to_tools(tools, tool_filter=['usher_fill', 'usher_confirm', 'usher_cancel'] if mode == 'fill' else None)
    agent = Agent(
        task=FILL if mode == 'fill' else DRIVER + (USHER if mode == 'with' else ''),
        llm=llm(),
        tools=tools,
        # A fresh profile each run; CHROME_PATH picks the browser (Browser Use finds one otherwise).
        browser_profile=BrowserProfile(headless=True, viewport={'width': 1280, 'height': 900}, user_data_dir=tempfile.mkdtemp(prefix='usher-bu-profile-'), **({'executable_path': os.environ['CHROME_PATH']} if os.environ.get('CHROME_PATH') else {})),
        use_vision=True,
    )
    started = time.monotonic()
    try:
        history = await agent.run(max_steps=60)
    finally:
        if mcp:
            await mcp.disconnect()
    seconds = round(time.monotonic() - started, 1)
    usage = history.usage
    actions = [list(a.keys())[0] for a in history.model_actions() if a]
    return {
        'mode': mode,
        'model': agent.llm.model,
        'completed': history.is_done() and history.is_successful() is not False,
        'final': (history.final_result() or '')[:300],
        'final_url': history.urls()[-1] if history.urls() else None,
        'seconds': seconds,
        'steps': history.number_of_steps(),
        'actions': actions,
        'knocks': sum(1 for a in actions if 'knock' in a),
        # The tool calls and how long each took: the fill's own time, without the model's turns.
        'tool_ms': [[list(s.model_output.action[0].model_dump(exclude_unset=True).keys())[0], round((s.metadata.step_end_time - s.metadata.step_start_time) * 1000)] for s in history.history if s.model_output and s.model_output.action and s.metadata] if mode == 'fill' else None,
        'prompt_tokens': getattr(usage, 'total_prompt_tokens', None),
        'completion_tokens': getattr(usage, 'total_completion_tokens', None),
        'errors': [e for e in history.errors() if e][:5],
        'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['with', 'without', 'fill', 'both'], default='both')
    parser.add_argument('--runs', type=int, default=1)
    args = parser.parse_args()
    modes = ['without', 'with'] if args.mode == 'both' else [args.mode]
    for _ in range(args.runs):
        for mode in modes:
            result = await run(mode)
            print(json.dumps(result))
            with (HERE / 'results.jsonl').open('a') as f:
                f.write(json.dumps(result) + '\n')


if __name__ == '__main__':
    asyncio.run(main())
