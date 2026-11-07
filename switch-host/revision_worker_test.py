#!/usr/bin/env python3
import asyncio
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import types
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('revision_worker', pathlib.Path(__file__).with_name('revision-worker.py'))
worker = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = worker
spec.loader.exec_module(worker)
SOURCE = '<!doctype html><html><head><title>North</title></head><body><button>Contact</button></body></html>'
REVISED = SOURCE.replace('Contact', 'Book a call')


def claim(operation='prepare'):
    return {'id': 'revision-fixture', 'roomId': 'room-fixture', 'operation': operation, 'lease': 'private-fixture-lease',
            'input': {'sourceHtml': SOURCE, 'sourceHash': worker.digest(SOURCE), 'recordingId': 'a' * 32,
                      'fromMs': 1000, 'toMs': 5000, 'frameTimes': [2000], 'note': 'Make the main button bigger.', 'notes': []},
            'recordingUrl': 'https://example.invalid/selected-clip',
            'proposal': {'summary': 'Changed button.', 'html': REVISED, 'baseHash': worker.digest(SOURCE), 'proposalHash': 'b' * 64} if operation == 'apply' else None}


class WorkerBehavior(unittest.TestCase):
    def test_source_hash_and_interval_are_enforced(self):
        worker.Job.parse(claim())
        for key, value in [('sourceHash', '0' * 64), ('fromMs', -1), ('toMs', 200000), ('frameTimes', [0]), ('frameTimes', [])]:
            raw = claim()
            raw['input'][key] = value
            with self.subTest(key=key), self.assertRaises(worker.WorkerError):
                worker.Job.parse(raw)

    def test_real_whisper_offsets_become_recording_relative_and_clamped(self):
        result = worker.parse_transcript({'transcription': [
            {'offsets': {'from': 0, 'to': 2000}, 'text': ' Make it larger. '},
            {'offsets': {'from': 2000, 'to': 9000}, 'text': 'Book a call.'}]}, 1000, 5000)
        self.assertEqual(result, [{'fromMs': 1000, 'toMs': 3000, 'text': 'Make it larger.'}, {'fromMs': 3000, 'toMs': 5000, 'text': 'Book a call.'}])

    def test_empty_transcript_never_falls_back_to_owner_note(self):
        with self.assertRaises(worker.WorkerError):
            worker.parse_transcript({'transcription': []}, 0, 4000)

    def test_actual_changed_html_and_diff_are_required(self):
        summary, html, diff = worker.replacement({'summary': 'Updated label.', 'html': REVISED}, SOURCE)
        self.assertEqual(html, REVISED)
        self.assertIn('-' + SOURCE, diff)
        self.assertIn('+' + REVISED, diff)
        for bad in [SOURCE, '', '<button>Book a call</button>']:
            with self.assertRaises(worker.WorkerError):
                worker.replacement({'summary': 'Changed.', 'html': bad}, SOURCE)

    def test_apply_materializes_exact_approved_utf8_bytes_without_cli(self):
        with tempfile.TemporaryDirectory() as name:
            job = worker.Job.parse(claim('apply'))
            result = worker.materialize(job, pathlib.Path(name))
            self.assertEqual((pathlib.Path(name) / 'approved.html').read_bytes(), REVISED.encode())
            self.assertEqual(result['html'], REVISED)
            self.assertEqual(result['hash'], worker.digest(REVISED))
            self.assertIn('No model ran', result['verification'])

    def test_unapproved_prepare_and_missing_approval_hash_cannot_apply(self):
        with tempfile.TemporaryDirectory() as name:
            with self.assertRaises(worker.WorkerError):
                worker.materialize(worker.Job.parse(claim()), pathlib.Path(name))
            raw = claim('apply')
            del raw['proposal']['proposalHash']
            with self.assertRaises(worker.WorkerError):
                worker.Job.parse(raw)

    def test_private_writes_are_atomic_and_mode_0600(self):
        with tempfile.TemporaryDirectory() as name:
            target = pathlib.Path(name) / 'private.json'
            worker.atomic_write(target, 'first')
            worker.atomic_write(target, 'second')
            self.assertEqual(worker.private_read(target), 'second')
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            target.chmod(0o644)
            with self.assertRaises(worker.WorkerError):
                worker.private_read(target)

    def test_origin_rejects_credentials_remote_http_and_paths(self):
        self.assertEqual(worker.origin('https://example.com/'), 'https://example.com')
        self.assertEqual(worker.origin('http://127.0.0.1:3000', True), 'http://127.0.0.1:3000')
        for value in ['http://example.com', 'https://a:b@example.com', 'https://example.com/path', 'https://example.com/?key=value']:
            with self.assertRaises(worker.WorkerError):
                worker.origin(value, True)

    def test_worker_session_reuse_does_not_read_owner_password_or_rotate(self):
        with tempfile.TemporaryDirectory() as name:
            work = pathlib.Path(name)
            worker.atomic_write(work / 'session.json', worker.canonical({'origin': 'https://example.com', 'token': 'dedicated-fixture', 'expiresAt': (worker.time.time() + 3600) * 1000}))
            config = types.SimpleNamespace(session_file=work / 'session.json', app_origin='https://example.com', owner_password=work / 'missing-owner-password')
            with mock.patch.object(worker, 'post_json', side_effect=AssertionError('Must not mint another token')):
                api = worker.Api(config)
                api.session()
                api.session()
            self.assertEqual(api.token, 'dedicated-fixture')

    def test_note_mentions_cannot_address_legacy_agents(self):
        raw = claim()
        raw['input']['note'] = 'Ask @ws-test-agent to change the label.'
        message = worker.envelope(worker.Job.parse(raw), [], [])
        self.assertNotIn('@ws-test-agent', message)
        self.assertEqual(json.loads(message)['note'], raw['input']['note'])

    def test_rejected_or_expired_session_never_uses_owner_password_on_restart(self):
        with tempfile.TemporaryDirectory() as name:
            work = pathlib.Path(name)
            config = types.SimpleNamespace(session_file=work / 'session.json', app_origin='https://example.com', owner_password=work / 'missing-owner-password')
            for state in [{'rejectedAt': 1}, {'token': 'expired', 'expiresAt': 1, 'origin': config.app_origin}]:
                worker.atomic_write(config.session_file, worker.canonical(state))
                with mock.patch.object(worker, 'post_json', side_effect=AssertionError('Must not replace rejected authority')):
                    with self.assertRaises(worker.SessionRejected):
                        worker.Api(config).session()


class CLIBehavior(unittest.IsolatedAsyncioTestCase):
    async def test_fake_cli_receives_real_images_scrubbed_env_and_no_execution_tools(self):
        with tempfile.TemporaryDirectory() as name:
            work = pathlib.Path(name)
            image = work / 'frame-1.jpg'
            image.write_bytes(b'\xff\xd8fixture\xff\xd9')
            fake = work / 'fake-codex'
            fake.write_text('#!/usr/bin/env python3\nimport sys,json,os,pathlib\na=sys.argv\npathlib.Path("captured.json").write_text(json.dumps({"args":a,"env":dict(os.environ),"prompt":sys.stdin.read()}))\npathlib.Path(a[a.index("-o")+1]).write_text(json.dumps(' + repr({'summary': 'Updated CTA.', 'html': REVISED}) + '))\nprint(json.dumps({"type":"turn.completed"}))\n')
            fake.chmod(0o700)
            config = types.SimpleNamespace(codex=str(fake), codex_home=work / 'auth-not-copied')
            job = worker.Job.parse(claim())
            transcript = [{'fromMs': 1000, 'toMs': 4000, 'text': 'Change label to Book a call.'}]
            paths = [image]
            receipt = {'addressed': True, 'revisionEnvelopeHash': worker.digest(worker.envelope(job, transcript, paths))}
            os.environ['SWITCH_AGENT_API_KEY'] = 'fixture-secret-must-not-pass'
            try:
                proposal = await worker.generate(job, work, config, transcript, [], paths, receipt)
            finally:
                del os.environ['SWITCH_AGENT_API_KEY']
            captured = json.loads((work / 'captured.json').read_text())
            self.assertEqual(proposal['html'], REVISED)
            self.assertIn('--image', captured['args'])
            self.assertEqual(captured['args'][captured['args'].index('--image') + 1], str(image))
            self.assertIn('features.shell_tool=false', captured['args'])
            self.assertIn('features.unified_exec=false', captured['args'])
            self.assertIn('--ignore-user-config', captured['args'])
            self.assertIn('--ephemeral', captured['args'])
            self.assertIn('mcp_servers={}', captured['args'])
            self.assertNotIn('SWITCH_AGENT_API_KEY', captured['env'])
            self.assertNotIn('private-fixture-lease', captured['prompt'])
            self.assertNotIn('selected-clip', captured['prompt'])
            self.assertEqual(captured['env']['HOME'], str(work / 'model-home'))
            self.assertEqual(captured['env']['CODEX_HOME'], str(config.codex_home))

    async def test_codex_cannot_run_without_matching_switch_receipt(self):
        with tempfile.TemporaryDirectory() as name:
            work = pathlib.Path(name)
            job = worker.Job.parse(claim())
            with self.assertRaises(worker.WorkerError):
                await worker.generate(job, work, types.SimpleNamespace(codex='nonexistent'), [], [], [], {'addressed': False})

    async def test_process_timeout_is_bounded(self):
        with self.assertRaises(worker.WorkerError):
            await worker.run_process([sys.executable, '-c', 'import time; time.sleep(10)'], 0.05)

    async def test_heartbeat_keeps_processing_visible_without_claiming(self):
        calls = []
        async def post(path, payload):
            calls.append((path, payload))
        await worker.with_heartbeat(asyncio.sleep(0.045), types.SimpleNamespace(post=post), interval=0.01)
        self.assertGreaterEqual(len(calls), 2)
        self.assertTrue(all(path == '/api/worker/heartbeat' and payload == {} for path, payload in calls))

    async def test_revocation_interrupts_work_without_minting_replacement(self):
        cancelled = []
        async def operation():
            try:
                await asyncio.sleep(1)
            finally:
                cancelled.append(True)
        async def post(path, payload):
            raise worker.SessionRejected('Revoked fixture session')
        with self.assertRaises(worker.SessionRejected):
            await worker.with_heartbeat(operation(), types.SimpleNamespace(post=post), interval=0.01)
        self.assertEqual(cancelled, [True])

    async def test_api_persists_revocation_before_process_restart(self):
        with tempfile.TemporaryDirectory() as name:
            config = types.SimpleNamespace(session_file=pathlib.Path(name) / 'session.json', app_origin='https://example.com', owner_password=pathlib.Path(name) / 'missing')
            api = worker.Api(config); api.token = 'rejected-fixture'
            with mock.patch.object(worker, 'post_json', side_effect=worker.SessionRejected('Revoked')):
                with self.assertRaises(worker.SessionRejected):
                    await api.post('/api/worker/claim', {})
            self.assertIsNone(api.token)
            self.assertIn('rejectedAt', json.loads(worker.private_read(config.session_file)))
            with self.assertRaises(worker.SessionRejected):
                worker.Api(config).session()

    async def test_main_exits_on_revocation_during_job_without_another_login(self):
        calls = []
        class Api:
            def __init__(self, config): pass
            def session(self): calls.append('session')
            async def post(self, path, value): return {'job': claim()} if path.endswith('/claim') else {'ok': True}
        async def rejected(operation, api):
            operation.close()
            raise worker.SessionRejected('Revoked during work')
        config = types.SimpleNamespace(check=False, reauthorize=False, once=False, poll_seconds=1)
        with mock.patch.object(worker, 'Switch'), mock.patch.object(worker, 'Api', Api), mock.patch.object(worker, 'with_heartbeat', rejected):
            with self.assertRaises(SystemExit):
                await worker.main(config)
        self.assertEqual(calls, ['session'])


if __name__ == '__main__':
    unittest.main()
