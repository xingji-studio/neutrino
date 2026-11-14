"""Pier adapter for approved same-model/Max official benchmark trials."""
import asyncio
import json
import os
from pathlib import Path
import tempfile
import time
import uuid

from pier.agents.base import BaseAgent
from pier.agents.network import allowlist_from_urls


class NeutrinoAgent(BaseAgent):
    def __init__(self, *args, agent_mode='standard', token_cap=2_000_000, dry_run=False, probe=False,
                 bundle_dir=None, source_home=None, **kwargs):
        super().__init__(*args, **kwargs)
        if agent_mode not in ('standard', 'fast_dag', 'dsh_minimal'):
            raise ValueError('Unsupported benchmark mode')
        if not 0 < int(token_cap) <= 2_000_000:
            raise ValueError('Approved trial limit is 2,000,000 tokens')
        self.agent_mode = agent_mode
        self.token_cap = int(token_cap)
        self.dry_run = bool(dry_run)
        self.probe = bool(probe)
        self.bundle_dir = Path(bundle_dir or os.environ['NEUTRINO_OFFICIAL_BUNDLE_DIR'])
        source = Path(source_home or '/mnt/c/Users/GuoqiFish') / '.neutrino'
        config = json.loads((source / 'config.json').read_text())
        catalogue = json.loads((source / 'model.json').read_text())
        provider = next(p for p in catalogue['providers'] if p['name'] == config['selected_provider'])
        model = next(m for m in provider['models'] if m['name'] == config['selected_model'])
        if (provider['name'], model['name'], config['selected_intensity']) != ('DeepSeek', 'deepseek-flash', 'Max'):
            raise ValueError('Fixed model/Max configuration changed')
        self.source_model = model
        self.runtime_input = {'provider': provider['name'], 'model': model, 'intensity': 'Max',
                              'model_context_windows': config.get('model_context_windows', {}),
                              'agent_mode': self.agent_mode, 'token_cap': self.token_cap}

    @staticmethod
    def name():
        return 'neutrino-harness-comparison'

    def version(self):
        return '0.7.0-explicit-api-max'

    def network_allowlist(self):
        return allowlist_from_urls([self.source_model['url']])

    async def checked(self, environment, command, **kwargs):
        result = await environment.exec(command, **kwargs)
        if result.return_code:
            raise RuntimeError(f'Infrastructure command failed ({result.return_code}): {result.stdout} {result.stderr}')
        return result

    async def upload_json(self, environment, value, destination):
        with tempfile.TemporaryDirectory(prefix='official-private-input-') as folder:
            source = Path(folder) / 'input.json'; source.write_text(json.dumps(value)); source.chmod(0o600)
            await environment.upload_file(source, destination)

    async def setup(self, environment):
        await self.checked(environment, 'mkdir -p /opt/neutrino /logs/agent', user='root')
        for source, destination in [('runtime.tar.gz', '/opt/neutrino/runtime.tar.gz'),
                                    ('node-runtime.tar.gz', '/opt/neutrino/node.tar.gz')]:
            await environment.upload_file(self.bundle_dir / source, destination)
        await self.checked(environment, 'tar xzf /opt/neutrino/runtime.tar.gz -C /opt/neutrino && tar xzf /opt/neutrino/node.tar.gz -C /opt/neutrino',
                           user='root', timeout_sec=120)
        if self.agent_mode == 'dsh_minimal':
            for source, destination in [('python-runtime.tar.gz', '/opt/neutrino/python.tar.gz'),
                                        ('dsh-dist.tar.gz', '/opt/neutrino/dsh-dist.tar.gz')]:
                await environment.upload_file(self.bundle_dir / source, destination)
            await self.checked(environment, 'mkdir -p /opt/dsh-dist && tar xzf /opt/neutrino/python.tar.gz -C /opt/neutrino && tar xzf /opt/neutrino/dsh-dist.tar.gz -C /opt/dsh-dist',
                               user='root', timeout_sec=180)

    async def run(self, instruction, environment, context):
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        timeout = int(os.environ.get('NEUTRINO_OFFICIAL_TIMEOUT_MS', '28800000'))
        node = '/opt/neutrino/node-v18.19.1-linux-x64/bin/node'
        local_key = 'trial-local-' + uuid.uuid4().hex
        gateway_secret = {'upstream': self.source_model['url'], 'apiKey': self.source_model['api_key'],
                          'clientKey': local_key, 'model': self.source_model['name'], 'tokenCap': self.token_cap,
                          'ledgerFile': '/logs/agent/provider-usage.json', 'readyFile': '/logs/agent/gateway-ready.json'}
        await self.upload_json(environment, gateway_secret, '/opt/neutrino/gateway-secret.json')
        await self.checked(environment,
            f'{node} /opt/neutrino/scripts/benchmark-token-gateway.mjs --secret /opt/neutrino/gateway-secret.json > /logs/agent/gateway.log 2>&1 < /dev/null &',
            env=environment.agent_process_env({}), user='root')
        ready = None
        for _ in range(100):
            result = await environment.exec('cat /logs/agent/gateway-ready.json', user='root')
            if result.return_code == 0:
                ready = json.loads(result.stdout); break
            await asyncio.sleep(0.1)
        if not ready:
            raise RuntimeError('Billing gateway did not start; no model dispatch authorized')
        # The sidecar has read its key into memory; task tools never need the upstream credential file.
        await self.checked(environment, 'rm -f /opt/neutrino/gateway-secret.json', user='root')
        inputs = {**self.runtime_input, 'timeout_ms': timeout, 'gateway_url': ready['url'],
                  'model': {**self.source_model, 'url': ready['url'] + '/v1', 'api_key': local_key}}
        await self.upload_json(environment, inputs, '/opt/neutrino/runtime-input.json')
        with tempfile.TemporaryDirectory(prefix='official-prompt-') as folder:
            prompt = Path(folder) / 'instruction.txt'
            prompt.write_text('Reply exactly OK to confirm the configured model is reachable.' if self.probe else instruction)
            await environment.upload_file(prompt, '/opt/neutrino/instruction.txt')
        command = ('/opt/neutrino/python/bin/python3 /opt/neutrino/scripts/benchmark-dsh-run.py'
                   if self.agent_mode == 'dsh_minimal' else f'{node} /opt/neutrino/scripts/benchmark-official-run.mjs')
        if self.dry_run:
            command += ' --dry-run'
        started = time.perf_counter()
        environment_vars = {name: '' for name in ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']}
        environment_vars.update({'NO_PROXY': '127.0.0.1,localhost', 'no_proxy': '127.0.0.1,localhost'})
        try:
            if self.probe:
                await self.checked(environment, f'{node} /opt/neutrino/scripts/benchmark-api-probe.mjs', env=environment_vars, timeout_sec=200)
            result = await environment.exec(command, env=environment_vars, timeout_sec=timeout // 1000)
            (self.logs_dir / 'runner-stdout.txt').write_text(result.stdout or '')
            (self.logs_dir / 'runner-stderr.txt').write_text(result.stderr or '')
            if result.return_code:
                raise RuntimeError(f'Runner exited {result.return_code}; see runner-stderr.txt')
        finally:
            await environment.exec(f'{node} -e "process.kill({int(ready["pid"])}, \'SIGTERM\')"', user='root')
            for _ in range(600):
                result = await environment.exec('cat /logs/agent/provider-usage.json', user='root')
                if result.return_code == 0:
                    usage = json.loads(result.stdout)
                    if usage.get('finished_at') and usage['held_tokens'] == 0:
                        break
                await asyncio.sleep(0.5)
            else:
                raise RuntimeError('Provider usage has not drained; keep its full reservation')
            context.n_input_tokens = usage['input_tokens']
            context.n_output_tokens = usage['output_tokens']
            context.n_cache_tokens = usage['cached_input_tokens']
            context.n_agent_steps = len(usage['attempts'])
            context.metadata = {'agent_mode': self.agent_mode, 'trial_cap': self.token_cap,
                                'protected_tokens': usage['spent_protected'], 'usage_complete': usage['unknown_requests'] == 0,
                                'preflight': self.dry_run, 'probe': self.probe,
                                'agent_wall_ms_including_gateway_drain': (time.perf_counter() - started) * 1000}
            (self.logs_dir / 'comparison-metadata.json').write_text(json.dumps(context.metadata, indent=2) + '\n')
            await environment.exec('rm -f /opt/neutrino/gateway-secret.json /opt/neutrino/runtime-input.json', user='root')
