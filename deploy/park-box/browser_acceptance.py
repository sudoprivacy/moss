"""Verify operation result rendering against the actual Docker-served Park UI."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright


def verify():
    setup = json.loads((Path(__file__).parent / 'configuration/setup.json').read_text(encoding='utf8'))
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            response = page.request.post('http://localhost:44176/park/api/auth/login/password', data=setup['administrator'])
            if response.status != 200:
                raise RuntimeError('Actual Park administrator login failed: HTTP ' + str(response.status))
            page.goto('http://localhost:44176/park/admin/operations')
            page.wait_for_load_state('networkidle')
            page.get_by_role('heading', name='运行状态与版本', exact=True).wait_for()
            observed = page.locator('main').inner_text()
            if 'database_migration' not in observed or 'model_configuration' not in observed:
                raise AssertionError('Actual installed component versions are not displayed')
            if not page.get_by_role('button', name='数据备份', exact=True).is_enabled():
                raise AssertionError('Verified deployment backup action is unavailable')
            page.get_by_role('heading', name='组件运行状态', exact=True).wait_for()
            for service in ('moss', 'nexus', 'park', 'operations'):
                if service not in observed:
                    raise AssertionError('Missing actual component runtime: ' + service)
            page.get_by_role('button', name='检查真实模型', exact=True).click()
            task_panel = page.locator('section').filter(has=page.get_by_role('heading', name='运维任务', exact=True))
            task_panel.get_by_text('检查真实模型 · 已完成 · 验证完成', exact=True).wait_for(timeout=60000)
            if '"healthy": true' not in task_panel.inner_text():
                raise AssertionError('Real model task did not report verified availability')
            refreshes = []
            page.on('request', lambda request: refreshes.append(request.url) if request.url.endswith('/admin/operations') else None)
            page.wait_for_timeout(17000)
            if not refreshes:
                raise AssertionError('Operations status did not refresh automatically')
            page.screenshot(path=str(Path(__file__).parent / 'configuration/operations-before-acceptance.png'), full_page=True)
            fixture = {'version': 'test-only', 'uptime_seconds': 1, 'memory': {'free_bytes': 1, 'total_bytes': 2},
                       'disk': {'free_bytes': 1, 'total_bytes': 2}, 'health': {'ok': True}, 'model': {},
                       'archives': [], 'upgrades': ['invalid-test-only.tar.gz'], 'available_actions': {'verify-upgrade': True}}
            is_submitted = False

            def status(route):
                route.fulfill(status=503 if is_submitted else 200,
                              json={'error': 'acceptance refresh failure'} if is_submitted else fixture)

            def signature(route):
                nonlocal is_submitted
                is_submitted = True
                route.fulfill(status=200, json={'result': False})

            page.route('**/park/api/v1/parks/*/admin/operations', status)
            page.route('**/park/api/v1/parks/*/admin/operations/verify-upgrade', signature)
            page.reload()
            page.wait_for_load_state('networkidle')
            page.get_by_label('升级包', exact=True).select_option('invalid-test-only.tar.gz')
            page.get_by_role('button', name='校验签名', exact=True).click()
            page.get_by_role('status').filter(has_text='升级包签名校验失败').wait_for()
            page.get_by_role('status').filter(has_text='状态刷新失败').wait_for()
            message = page.get_by_role('status').inner_text()
            if '操作已完成' in message or '状态刷新失败' not in message:
                raise AssertionError('Signature failure and refresh failure were not reported independently')
            print('Actual Docker UI component states, real model task and automatic refresh passed; intercepted signature/refresh errors passed. No upgrade executed by this browser test.')
        finally:
            browser.close()


if __name__ == '__main__':
    verify()
