"""Run against an admin dev server; all API requests are intercepted.

python3 tests/config-scope.browser.py --url http://127.0.0.1:5178/admin
Requires Python Playwright and Chrome (or --channel chromium).
"""

import argparse
import copy
import json
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright


def system_settings(scope, org):
    return {
        'scopeType': scope, 'organizationId': org if scope == 'organization' else '',
        'model': f'{scope}-{org}-model', 'url': '', 'apiKey': '', 'apiKeyConfigured': True,
        'modelProviders': [{
            'id': 'fixture', 'name': 'Fixture provider', 'kind': 'openai-compatible',
            'baseUrl': 'https://example.invalid/v1', 'discoveryUrl': 'https://example.invalid/v1/models',
            'protocol': 'openai-completions', 'enabled': True, 'apiKeyConfigured': True,
        }],
        'defaultModelProviderId': 'fixture',
        'image': {'provider': 'openai', 'url': '', 'apiKey': '', 'apiKeyConfigured': True, 'model': 'image'},
        'bypassPermissions': False, 'maxTurns': 100, 'thinkingMode': 'adaptive', 'thinkingBudgetTokens': 16000,
        'skillStore': {'tenantId': 'platform-store'},
        'oauth2': {'enabled': False, 'requireState': True, 'authorizeUrlTemplate': '', 'scriptPath': ''},
        'clientCronEnabled': True, 'clientShowToolCalls': True, 'workspaceUploadLimitBytes': 20971520,
        'cronReuseMaxRuns': 50, 'imReuseMaxTurns': 200, 'mintScriptsDir': '/fixture/scripts',
        'settingsPath': '/fixture/settings.json', 'settingsExists': True, 'settingsLoaded': True, 'settingsParseError': '',
    }


def sudowork_settings(scope, org):
    return {
        'scope_type': scope, 'organization_id': org if scope == 'organization' else '',
        'login_method': 1, 'scode_auto_model': f'{scope}-{org}-auto', 'third_party_auth': {},
        'log_report': {'enabled': 0, 'protocol': 'https', 'domain': 'logs.example.invalid', 'key': '', 'key_set': True},
        'version_update': {'enabled': 0, 'cos_domain': ''}, 'product_improvement': {'enabled': 0},
        'recharge_mode': 'disabled', 'credit_application': {'min_points': 1, 'max_points': 100},
        # Deliberately include infrastructure in organization fixtures to test UI gating.
        'sms': {'provider': 'disabled'}, 'billing': {'enabled': False},
    }


def run(args):
    artifacts = Path(args.artifacts)
    artifacts.mkdir(parents=True, exist_ok=True)
    state = {'role': 'super_admin', 'org': 'org-a', 'hold': None, 'failure': None, 'wrong_scope': False}
    reads, writes, pending, errors = [], [], [], []
    saved = {}

    def fulfill(route, body, status=200):
        route.fulfill(status=status, content_type='application/json', body=json.dumps(body))

    def intercept(route):
        request = route.request
        url = urlparse(request.url)
        path, method = url.path, request.method
        scope = parse_qs(url.query).get('scope', ['organization'])[0]
        if path == '/api/v1/auth/me':
            fulfill(route, {
                'user': {'id': 'fixture-user', 'name': 'Fixture admin', 'role': state['role'], 'orgId': 'home-org'},
                'scopes': ['*'] if state['role'] == 'super_admin' else ['admin:settings'],
                'isSuperAdmin': state['role'] == 'super_admin', 'organization': {'id': state['org']},
            })
        elif path == '/api/v1/organizations':
            fulfill(route, {'organizations': [{'id': 'org-a', 'name': 'Org A'}, {'id': 'org-b', 'name': 'Org B'}]})
        elif path == '/api/v1/auth/switch-org':
            state['org'] = request.post_data_json['org_id']
            fulfill(route, {'access_token': 'fixture-token', 'refresh_token': 'fixture-refresh', 'expires_in': 3600})
        elif path in ['/api/v1/settings/system', '/api/moss/v1/operations/system-config']:
            assert 'scope' in parse_qs(url.query), f'Missing explicit scope: {request.url}'
            is_system = path.endswith('/settings/system')
            key = (path, scope, state['org'] if scope == 'organization' else '')
            fixture = saved.setdefault(key, (system_settings if is_system else sudowork_settings)(scope, state['org']))
            if method == 'GET':
                reads.append((path, scope, state['org']))
                body = copy.deepcopy(fixture)
                if state['wrong_scope']:
                    body['scopeType' if is_system else 'scope_type'] = 'platform' if scope == 'organization' else 'organization'
                response = body if is_system else {'success': True, 'data': body}
            else:
                assert method == ('PATCH' if is_system else 'PUT')
                payload = request.post_data_json
                writes.append((path, scope, payload))
                if state['failure'] == (path, method):
                    fulfill(route, {'error': 'Fixture save rejected'}, 500)
                    return
                for field, value in payload.items():
                    if isinstance(value, dict) and isinstance(fixture.get(field), dict):
                        fixture[field].update(value)
                    else:
                        fixture[field] = value
                response = copy.deepcopy(fixture) if is_system else {'success': True}
            if state['hold'] == (path, method, scope):
                pending.append((route, response))
            else:
                fulfill(route, response)
        else:
            assert method == 'GET', f'Unexpected mutation: {method} {path}'
            fulfill(route, {'success': True, 'data': {}})

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, channel=None if args.channel == 'chromium' else args.channel)
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        context.add_init_script("localStorage.setItem('moss_access_token', 'fixture-token')")
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(re.compile(r'^https?://[^/]+/api/'), intercept)
        scope_control = page.get_by_role('combobox', name='配置范围')

        def select_scope(label):
            scope_control.click()
            page.get_by_role('option', name=label, exact=True).click()

        def release():
            state['hold'] = None
            for route, response in pending[:]:
                fulfill(route, response)
            pending.clear()

        def wait_pending():
            for _ in range(100):
                if pending:
                    return
                page.wait_for_timeout(20)
            raise AssertionError('Expected deferred API request')

        def screenshot(name):
            expect(page.locator('[data-sonner-toast]')).to_have_count(0, timeout=10000)
            page.locator('[data-slot="dashboard-content"]').evaluate('(element) => { element.scrollTop = 0 }')
            expect(scope_control).to_be_visible()
            page.screenshot(path=str(artifacts / f'{name}.png'), full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow'

        try:
            page.goto(f'{args.url}/settings')
            page.wait_for_load_state('networkidle')
            expect(scope_control).to_have_text('当前组织')
            expect(page.locator('#setting-model')).to_have_value('organization-org-a-model')
            expect(page.get_by_role('tab', name='执行与权限')).to_have_count(0)
            page.locator('#setting-model').fill('draft-org')
            select_scope('平台')
            expect(page.get_by_role('alertdialog')).to_be_visible()
            page.get_by_role('button', name='继续编辑', exact=True).click()
            expect(page.locator('#setting-model')).to_have_value('draft-org')
            assert not any(scope == 'platform' for _, scope, _ in reads)
            select_scope('平台')
            page.get_by_role('button', name='放弃更改', exact=True).click()
            expect(page.locator('#setting-model')).to_have_value('platform-org-a-model')
            page.get_by_role('tab', name='执行与权限').click()
            page.locator('#setting-maxTurns').fill('42')
            state['hold'] = ('/api/v1/settings/system', 'PATCH', 'platform')
            page.get_by_role('button', name='保存更改', exact=True).click()
            expect(scope_control).to_be_disabled()
            wait_pending()
            assert writes[-1][1:] == ('platform', {'maxTurns': 42})
            release()
            expect(scope_control).to_be_enabled()
            screenshot('system-platform-desktop')
            select_scope('当前组织')
            expect(page.locator('#setting-model')).to_have_value('organization-org-a-model')
            expect(page.get_by_role('tab', name='执行与权限')).to_have_count(0)
            page.locator('#setting-apiKey').select_option('replace')
            page.locator('#setting-apiKey-value').fill('fixture-draft-secret')
            select_scope('平台')
            page.get_by_role('button', name='放弃更改', exact=True).click()
            expect(page.locator('#setting-apiKey')).to_have_value('keep')
            expect(page.locator('#setting-apiKey-value')).to_have_count(0)
            select_scope('当前组织')
            expect(page.locator('#setting-model')).to_have_value('organization-org-a-model')

            # A late response from an unmounted scope must never replace the current form.
            state['hold'] = ('/api/v1/settings/system', 'GET', 'platform')
            select_scope('平台')
            wait_pending()
            select_scope('当前组织')
            expect(page.locator('#setting-model')).to_have_value('organization-org-a-model')
            release()
            expect(page.locator('#setting-model')).to_have_value('organization-org-a-model')
            select_scope('平台')
            expect(page.locator('#setting-model')).to_have_value('platform-org-a-model')
            state['hold'] = ('/api/v1/settings/system', 'GET', 'organization')
            select_scope('当前组织')
            wait_pending()
            select_scope('平台')
            expect(page.locator('#setting-model')).to_have_value('platform-org-a-model')
            release()
            expect(page.locator('#setting-model')).to_have_value('platform-org-a-model')
            select_scope('当前组织')
            expect(page.locator('#setting-model')).to_have_value('organization-org-a-model')
            screenshot('system-organization-desktop')

            # Use the existing sidebar organization switch, including its discard guard and reload.
            page.locator('#setting-model').fill('discard-before-org-switch')
            page.get_by_role('combobox', name='切换组织').click()
            page.get_by_role('option', name='Org B', exact=True).click()
            page.get_by_role('button', name='继续编辑', exact=True).click()
            assert state['org'] == 'org-a'
            page.get_by_role('combobox', name='切换组织').click()
            page.get_by_role('option', name='Org B', exact=True).click()
            page.get_by_role('button', name='放弃更改', exact=True).click()
            expect(page.locator('#setting-model')).to_have_value('organization-org-b-model')
            expect(scope_control).to_have_text('当前组织')

            page.goto(f'{args.url}/operations/sudowork-settings')
            page.wait_for_load_state('networkidle')
            auto = page.get_by_placeholder('留空使用 Moss 默认模型')
            expect(auto).to_have_value('organization-org-b-auto')
            expect(page.get_by_text('短信服务', exact=True)).to_have_count(0)
            expect(page.get_by_text('新的日志密钥', exact=True)).to_have_count(0)
            auto.fill('org-auto-draft')
            select_scope('平台')
            page.get_by_role('button', name='继续编辑', exact=True).click()
            expect(auto).to_have_value('org-auto-draft')
            select_scope('平台')
            page.get_by_role('button', name='放弃更改', exact=True).click()
            expect(auto).to_have_value('platform-org-b-auto')
            expect(page.get_by_text('短信服务', exact=True)).to_be_visible()
            auto.fill('platform-auto')
            state['hold'] = ('/api/moss/v1/operations/system-config', 'PUT', 'platform')
            page.get_by_role('button', name='保存策略', exact=True).click()
            expect(scope_control).to_be_disabled()
            expect(auto).to_be_disabled()
            wait_pending()
            assert writes[-1][1:] == ('platform', {'scode_auto_model': 'platform-auto'})
            release()
            expect(scope_control).to_be_enabled()
            expect(page.get_by_role('button', name='保存策略', exact=True)).to_be_disabled()
            screenshot('sudowork-platform-desktop')
            select_scope('当前组织')
            expect(auto).to_have_value('organization-org-b-auto')
            state['hold'] = ('/api/moss/v1/operations/system-config', 'GET', 'platform')
            select_scope('平台')
            wait_pending()
            select_scope('当前组织')
            expect(auto).to_have_value('organization-org-b-auto')
            release()
            expect(auto).to_have_value('organization-org-b-auto')
            select_scope('平台')
            expect(auto).to_have_value('platform-auto')
            state['hold'] = ('/api/moss/v1/operations/system-config', 'GET', 'organization')
            select_scope('当前组织')
            wait_pending()
            select_scope('平台')
            expect(auto).to_have_value('platform-auto')
            release()
            expect(auto).to_have_value('platform-auto')
            select_scope('当前组织')
            expect(auto).to_have_value('organization-org-b-auto')
            auto.fill('rejected-org-auto')
            state['failure'] = ('/api/moss/v1/operations/system-config', 'PUT')
            page.get_by_role('button', name='保存策略', exact=True).click()
            expect(page.get_by_text('Fixture save rejected', exact=True)).to_be_visible()
            expect(auto).to_have_value('rejected-org-auto')
            state['failure'] = None
            page.get_by_role('button', name='保存策略', exact=True).click()
            expect(page.get_by_role('button', name='保存策略', exact=True)).to_be_disabled()
            assert writes[-1][1:] == ('organization', {'scode_auto_model': 'rejected-org-auto'})

            # The same page remains usable for organization admins, even with broad scopes absent.
            state['role'] = 'admin'
            page.reload()
            expect(auto).to_have_value('rejected-org-auto')
            expect(scope_control).to_be_disabled()
            expect(page.get_by_text('短信服务', exact=True)).to_have_count(0)
            auto.fill('admin-org-auto')
            page.get_by_role('button', name='保存策略', exact=True).click()
            expect(page.get_by_role('button', name='保存策略', exact=True)).to_be_disabled()
            assert writes[-1][1:] == ('organization', {'scode_auto_model': 'admin-org-auto'})
            page.set_viewport_size({'width': 390, 'height': 844})
            screenshot('sudowork-organization-mobile')
            page.goto(f'{args.url}/settings')
            expect(page.locator('#setting-model')).to_have_value('organization-org-b-model')
            expect(scope_control).to_be_disabled()
            page.locator('#setting-imageModel').fill('org-image')
            page.get_by_role('button', name='保存更改', exact=True).click()
            expect(page.get_by_role('button', name='保存更改', exact=True)).to_be_disabled()
            assert writes[-1][1:] == ('organization', {'image': {'model': 'org-image'}})
            screenshot('system-organization-mobile')

            # Misrouted successful responses must leave an explicit retryable error, not an editable form.
            state['wrong_scope'] = True
            page.reload()
            expect(page.get_by_text('服务器返回的配置范围不匹配，请重新加载。', exact=True)).to_be_visible()
            expect(page.locator('#setting-model')).to_have_count(0)
            state['wrong_scope'] = False
            page.get_by_role('button', name='重试', exact=True).click()
            expect(page.locator('#setting-model')).to_have_value('organization-org-b-model')
            page.goto(f'{args.url}/operations/sudowork-settings')
            state['wrong_scope'] = True
            page.reload()
            expect(page.get_by_text('服务器返回的配置范围不匹配，请重新加载。', exact=True)).to_be_visible()
            expect(auto).to_have_count(0)
            state['wrong_scope'] = False
            page.get_by_role('button', name='重试', exact=True).click()
            expect(auto).to_have_value('admin-org-auto')
            assert not errors, errors
            print(json.dumps({'result': 'passed', 'mockedWrites': len(writes), 'realWrites': 0, 'screenshots': str(artifacts)}))
        except Exception:
            print(json.dumps({'url': page.url, 'errors': errors, 'body': page.locator('body').inner_text()[:8000]}, ensure_ascii=False))
            page.screenshot(path=str(artifacts / 'failure.png'), full_page=True)
            raise
        finally:
            release()
            browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:5178/admin')
    parser.add_argument('--channel', default='chrome')
    parser.add_argument('--artifacts', default='/tmp/moss-admin-config-scope')
    run(parser.parse_args())
