"""Operator fleet upgrades wait for controller memory and stop before exhausting the host."""
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('fleet', Path(__file__).with_name('operator-upgrade-runtimes.py'))
fleet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fleet)
GIB = 1024 ** 3


class SettleTest(unittest.TestCase):
    def test_below_pause_starts_immediately(self):
        with mock.patch.object(fleet, 'controller_memory', return_value=(2 * GIB, 8 * GIB)):
            self.assertEqual(fleet.settle(0.35, 0.6, 300), (True, 0.25))

    def test_at_stop_threshold_stops_without_waiting(self):
        with mock.patch.object(fleet, 'controller_memory', return_value=(5 * GIB, 8 * GIB)), \
                mock.patch.object(fleet.time, 'sleep') as sleep:
            self.assertEqual(fleet.settle(0.35, 0.6, 300), (False, 0.625))
            sleep.assert_not_called()

    def test_waits_for_memory_to_fall(self):
        readings = iter([(4 * GIB, 8 * GIB), (3.5 * GIB, 8 * GIB), (2 * GIB, 8 * GIB)])
        with mock.patch.object(fleet, 'controller_memory', side_effect=lambda: next(readings)), \
                mock.patch.object(fleet.time, 'sleep') as sleep:
            self.assertEqual(fleet.settle(0.35, 0.6, 300), (True, 0.25))
            self.assertEqual(sleep.call_count, 2)

    def test_gives_up_when_memory_never_settles(self):
        clock = iter([0, 10, 400])
        with mock.patch.object(fleet, 'controller_memory', return_value=(4 * GIB, 8 * GIB)), \
                mock.patch.object(fleet.time, 'monotonic', side_effect=lambda: next(clock)), \
                mock.patch.object(fleet.time, 'sleep'):
            self.assertEqual(fleet.settle(0.35, 0.6, 300), (False, 0.5))

    def test_unobservable_host_runs_unguarded(self):
        with mock.patch.object(fleet, 'controller_memory', return_value=None):
            self.assertEqual(fleet.settle(0.35, 0.6, 300), (True, None))


class RunTest(unittest.TestCase):
    def test_run_stops_before_the_next_owner_when_memory_stays_high(self):
        with tempfile.TemporaryDirectory() as directory:
            config, token = Path(directory, 'server.json'), Path(directory, 'operator.token')
            config.write_text(json.dumps({'server': {'port': 43127}, 'k8s': {'kubeconfig': 'k', 'namespace': 'n'}}))
            token.write_text('t' * 40)
            readings = iter([(1 * GIB, 8 * GIB), (1 * GIB, 8 * GIB), (5 * GIB, 8 * GIB)])
            calls = []

            def call(base, secret, method, path, timeout):
                calls.append((method, path))
                if method == 'GET':
                    return 200, {'runtime': {'isDrifted': True}}
                return 200, {'runtime': {'isDrifted': False}}

            argv = ['fleet', '--config', str(config), '--token-file', str(token)]
            with mock.patch.object(fleet, 'owners', return_value={'a': 'pod-a', 'b': 'pod-b'}), \
                    mock.patch.object(fleet, 'call', side_effect=call), \
                    mock.patch.object(fleet, 'controller_memory', side_effect=lambda: next(readings)), \
                    mock.patch.object(sys, 'argv', argv), \
                    mock.patch('sys.stdout', new_callable=io.StringIO) as output:
                with self.assertRaises(SystemExit) as exit_code:
                    fleet.main()
            self.assertEqual(exit_code.exception.code, 1)
            self.assertEqual([path for method, path in calls if method == 'POST'],
                             ['/api/v1/operator/agent-runtimes/a/upgrade'])
            self.assertIn('"stopped": {"before": "b", "controllerMemory": 0.625}', output.getvalue())


if __name__ == '__main__':
    unittest.main()
