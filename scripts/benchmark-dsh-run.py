"""Run the pinned official Minimal SDK in the task's original working directory."""
import dataclasses
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import time
import uuid

sys.path.insert(0, '/opt/dsh-dist')
from deepseek_harness import DeepSeekHarness

inputs = json.loads(Path('/opt/neutrino/runtime-input.json').read_text())
logs = Path('/logs/agent')
patch = Path('/opt/neutrino/dsh-profile.yml')
patch.write_text('- id: session-log-deepseek\n  disabled: true\n- id: plugin-package-inventory-deepseek\n  disabled: true\n')
conditions = {'sdk_version': importlib.metadata.version('deepseek-harness-sdk'), 'profile': 'sdk-minimal',
              'model': inputs['model']['name'], 'provider': inputs['provider'], 'effort': 'max',
              'token_cap': inputs['token_cap'], 'output_ceiling': 16384, 'context_window': 1000000}
(logs / 'dsh-conditions.json').write_text(json.dumps(conditions, indent=2) + '\n')
if '--dry-run' in sys.argv:
    with DeepSeekHarness(provider='deepseek-official', model=inputs['model']['name'], reasoning_effort='max',
                         max_tokens=16384, cwd=os.getcwd(), dsh_home=str(logs / 'dsh-home'), profile='sdk-minimal',
                         patches=(str(patch),), base_url=inputs['gateway_url'], api_key=inputs['model']['api_key'],
                         env={'HTTP_PROXY': '', 'HTTPS_PROXY': '', 'ALL_PROXY': ''}) as harness:
        pass
    print('Official Harness native runtime initialized in isolation; zero model dispatches.')
    sys.exit(0)
started = time.perf_counter()
report = {**conditions, 'finish_reason': None, 'error': None}
try:
    environment = {name: '' for name in ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']}
    environment.update({'NO_PROXY': '127.0.0.1,localhost', 'no_proxy': '127.0.0.1,localhost', 'DSH_CONTEXT_WINDOW': '1000000'})
    with DeepSeekHarness(provider='deepseek-official', model=inputs['model']['name'], reasoning_effort='max',
                         max_tokens=16384, cwd=os.getcwd(), dsh_home=str(logs / 'dsh-home'), profile='sdk-minimal',
                         patches=(str(patch),), base_url=inputs['gateway_url'], api_key=inputs['model']['api_key'],
                         env=environment, request_timeout_seconds=inputs['timeout_ms'] / 1000,
                         shutdown_timeout_seconds=30) as harness:
        result = harness.run(Path('/opt/neutrino/instruction.txt').read_text(), session_id='benchmark-' + uuid.uuid4().hex)
    report.update({'finish_reason': result.finish_reason, 'final_response': result.final_response})
    (logs / 'dsh-events.json').write_text(json.dumps({'events': result.events,
        'notifications': [dataclasses.asdict(n) if dataclasses.is_dataclass(n) else str(n) for n in result.notifications]}, ensure_ascii=False, default=str) + '\n')
except BaseException as error:
    report['error'] = type(error).__name__
finally:
    report['elapsed_ms'] = (time.perf_counter() - started) * 1000
    (logs / 'dsh-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print('Official Harness run ended; provider-usage.json and the official verifier determine usage and quality.')
