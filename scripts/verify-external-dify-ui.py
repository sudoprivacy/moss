"""Opt-in UI acceptance. Sensitive inputs arrive over stdin and never enter artifacts."""
import json
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

config = json.load(sys.stdin)
evidence = Path(config['evidenceDir'])
evidence.mkdir(parents=True, exist_ok=True)
checks = []
page_errors = []

def passed(name):
    checks.append(name)
    print(json.dumps({'phase': 'browser-ui', 'passed': name}), flush=True)

try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel='chrome', headless=True)
        admin = browser.new_context(viewport={'width': 1440, 'height': 1100})
        page = admin.new_page()
        page.set_default_timeout(30000)
        page.set_default_navigation_timeout(90000)
        page.on('pageerror', lambda error: page_errors.append(str(error).replace(config['apiKey'], '[redacted]')))
        page.goto(config['url'], wait_until='domcontentloaded')
        page.get_by_role('button', name='外部智能体管理', exact=True).click()
        page.get_by_role('button', name='配置试点范围', exact=True).click()
        page.get_by_role('switch', name='启用当前组织试点').click()
        page.get_by_role('textbox', name='允许的 Dify API 地址').fill(config['endpoint'])
        page.locator('.arco-modal:visible').get_by_role('button', name='保存', exact=True).click()
        expect(page.get_by_text('已启用', exact=True)).to_be_visible()
        passed('platform administrator enabled pilot and endpoint through UI')
        page.get_by_role('button', name='接入 Dify 智能体', exact=True).click()
        page.get_by_label('Dify App API Key', exact=True).fill(config['apiKey'])
        page.get_by_role('button', name='测试连接并继续').click()
        expect(page.get_by_label('Dify App ID', exact=True)).to_be_visible()
        page.get_by_label('Dify App ID', exact=True).fill(config['appId'])
        page.get_by_label('Dify Workspace ID', exact=True).fill(config['workspaceId'])
        page.locator('input[type=file]').set_input_files({'name': 'published-chatflow.json', 'mimeType': 'application/json', 'buffer': config['definition'].encode()})
        page.get_by_label('智能体名称', exact=True).fill('Dify UI 验收')
        page.locator('[aria-label="允许使用的用户"]').click()
        page.get_by_text('Synthetic user', exact=True).click()
        page.get_by_label('审核说明', exact=True).fill('已核对 Start/LLM/Answer 发布定义，仅使用合成算术输入。')
        page.get_by_role('button', name='保存待审核配置', exact=True).click()
        expect(page.get_by_text('待审核', exact=True)).to_be_visible()
        page.screenshot(path=str(evidence/'admin-draft.png'), full_page=True)
        passed('connection tested, definition uploaded, member selected and draft saved')
        user = browser.new_context(viewport={'width': 1440, 'height': 1000})
        consumer = user.new_page()
        consumer.on('pageerror', lambda error: page_errors.append(str(error).replace(config['apiKey'], '[redacted]')))
        consumer.set_default_navigation_timeout(90000)
        consumer.goto(config['url']+'verify/user', wait_until='domcontentloaded')
        expect(consumer.get_by_role('button', name='外部智能体管理', exact=True)).to_have_count(0)
        assert consumer.request.get(config['url']+'api/v1/external-agents/admin/agents').status == 403
        assert consumer.request.get(config['url']+'api/v1/external-agents').json()['data'] == []
        passed('ordinary user cannot manage or execute draft')

        def publish():
            page.get_by_role('button', name='审核发布', exact=True).click()
            page.screenshot(path=str(evidence/'admin-review.png'), full_page=True)
            page.get_by_role('button', name='审核发布', exact=True).last.click()
            expect(page.get_by_text('已发布', exact=True)).to_be_visible()

        publish()
        page.screenshot(path=str(evidence/'admin-published.png'), full_page=True)
        passed('administrator reviewed and published through UI')
        consumer.reload()
        query = consumer.get_by_role('textbox', name='输入合成测试问题')
        expect(query).to_be_enabled()
        for question, answer in [('请计算 6 乘以 7。reply 只返回计算结果数字，不需要执行任何操作。','42'), ('把上次结果加上 8。reply 只返回计算结果数字，不需要执行任何操作。','50')]:
            for attempt in range(3):
                query.fill(question)
                with consumer.expect_response(lambda response: response.request.method == 'POST' and response.url.endswith('/api/v1/tasks')) as accepted:
                    consumer.get_by_role('button', name='发送', exact=True).click()
                task = accepted.value.json()['data']
                deadline = time.monotonic() + 130
                while task['status'] not in ['succeeded', 'failed', 'rejected', 'unknown'] and time.monotonic() < deadline:
                    consumer.wait_for_timeout(750)
                    task = consumer.request.get(config['url']+'api/v1/tasks/'+task['id']+'/events').json()['data']['task']
                if task['status'] == 'succeeded':
                    expect(consumer.get_by_text(answer, exact=True)).to_be_visible(timeout=15000)
                    expect(query).to_be_enabled(timeout=15000)
                    passed('ordinary user received '+answer+' from real Dify')
                    break
                print(json.dumps({'phase':'provider-terminal', 'status':task['status'], 'error':task['error_code'], 'syntheticAttempt':attempt+1}), flush=True)
                # Only confirmed terminal failure of these read-only arithmetic prompts can be retried.
                assert task['status'] in ['failed', 'rejected'] and attempt < 2, 'Dify did not confirm success; no unknown task is replayed'
                expect(query).to_be_enabled(timeout=15000)
                consumer.wait_for_timeout(5000)
        consumer.reload()
        expect(consumer.get_by_text('50', exact=True)).to_be_visible()
        sessions = consumer.request.get(config['url']+'api/v1/external-sessions').json()['data']
        history = consumer.request.get(config['url']+'api/v1/external-sessions/'+sessions[0]['id']+'/tasks').json()['data']
        successful = [task for task in history if task['status'] == 'succeeded']
        assert len(successful) == 2
        assert successful[0]['provider_refs']['conversation_id'] == successful[1]['provider_refs']['conversation_id']
        consumer.screenshot(path=str(evidence/'user-results.png'), full_page=True)
        passed('history survives reload and both turns share provider conversation')
        page.get_by_role('button', name='停用', exact=True).click()
        page.get_by_role('button', name='停用', exact=True).last.click()
        expect(page.get_by_text('待审核', exact=True)).to_be_visible()
        assert consumer.request.get(config['url']+'api/v1/external-agents').json()['data'] == []
        passed('disable removes user availability')
        page.get_by_role('button', name='编辑配置', exact=True).click()
        page.get_by_label('智能体名称', exact=True).fill('Dify UI 验收（已编辑）')
        page.get_by_role('button', name='保存待审核配置', exact=True).click()
        expect(page.get_by_text('Dify UI 验收（已编辑）', exact=True)).to_be_visible()
        publish()
        page.get_by_role('button', name='更换密钥', exact=True).click()
        page.get_by_label('新的 Dify App API Key', exact=True).fill(config['apiKey'])
        page.locator('.arco-modal:visible').get_by_role('button', name='保存', exact=True).click()
        expect(page.get_by_text('待审核', exact=True)).to_be_visible()
        assert consumer.request.get(config['url']+'api/v1/external-agents').json()['data'] == []
        passed('editing and credential replacement require reapproval')
        publish()
        page.get_by_role('button', name='测试连接', exact=True).click()
        expect(page.get_by_text('连接成功，应用参数符合当前试点要求。', exact=True)).to_be_visible()
        page.get_by_role('button', name='归档', exact=True).click()
        page.get_by_role('button', name='归档', exact=True).last.click()
        expect(page.get_by_text('尚未接入智能体', exact=True)).to_be_visible()
        assert consumer.request.get(config['url']+'api/v1/external-sessions/'+sessions[0]['id']+'/tasks').json()['data'][-1]['answer'].strip() == '50'
        passed('saved key test and archive preserve user history')
        assert not page_errors, str(page_errors)
        (evidence/'admin-ui-result.json').write_text(json.dumps({'checks': checks, 'pageErrors': page_errors, 'history': [{'status': t['status'], 'answer': t['answer']} for t in history], 'secret_storage': 'real local Nexus vault', 'rotation': 'rewrote existing authorized App key; did not create a remote Dify key', 'login': 'isolated AuthService users and encrypted WebUI sessions'}, ensure_ascii=False, indent=2)+'\n')
        browser.close()
except Exception as error:
    print(str(error).replace(config.get('apiKey', ''), '[redacted]'), file=sys.stderr)
    sys.exit(1)
