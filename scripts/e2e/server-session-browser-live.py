"""Inspect recorded real sessions through the deployed UI using ai-dev-browser."""
import asyncio,json,os,pathlib,sys,time
from ai_dev_browser.core import connect_browser,get_active_tab,page_goto,page_discover,type_by_ref,click_by_ref,page_screenshot

assert os.environ.get('MOSS_COHOST_LIVE')=='1','Explicit live opt-in is required'
base,credentials_file,acceptance_file,evidence_dir=sys.argv[1:]
credentials=json.loads(pathlib.Path(credentials_file).read_text())
assert credentials['fixture_owner']=='pc3-production-acceptance-20261010'
acceptance=json.loads(pathlib.Path(acceptance_file).read_text())
reports=acceptance.get('acceptance',acceptance)['runtimes']
evidence=pathlib.Path(evidence_dir);evidence.mkdir(parents=True,exist_ok=True,mode=0o700)

async def main():
    browser=await connect_browser(port=int(os.environ.get('MOSS_E2E_BROWSER_PORT','9423')))
    try:
        tab=await get_active_tab(browser)
        await page_goto(tab,base+'/admin/login')
        # This browser profile is owned by the acceptance run.
        await tab.evaluate('localStorage.clear();sessionStorage.clear()')
        await page_goto(tab,base+'/admin/login')
        deadline=time.monotonic()+35
        while True:
            elements=await page_discover(tab)
            if any(v.get('role')=='textbox' and v.get('name')=='用户名' for v in elements):break
            assert time.monotonic()<deadline,'Login form did not appear';await asyncio.sleep(.2)
        for name,value in [('用户名',credentials['username']),('密码',credentials['password'])]:
            target=next(v for v in elements if v.get('role')=='textbox' and v.get('name')==name)
            await type_by_ref(tab,target['ref'],value,clear=True)
        button=next(v for v in elements if v.get('role')=='button' and v.get('name')=='登录')
        await click_by_ref(tab,button['ref'],human_like=False)
        deadline=time.monotonic()+35
        while '/login' in await tab.evaluate('location.href'):
            assert time.monotonic()<deadline,'UI login timed out';await asyncio.sleep(.2)
        checked=[]
        for report in reports:
            await page_goto(tab,base+'/admin/sessions/'+report['sessionId'])
            deadline=time.monotonic()+35
            while True:
                body=await tab.evaluate('document.body.innerText')
                if report['code'] in body and report['runtime'] in body and report['sessionId'] in body:break
                assert time.monotonic()<deadline,'Session UI omitted its conversation';await asyncio.sleep(.2)
            assert '会话不存在' not in body and '获取会话详情失败' not in body
            assert 'Docker 运行时' not in body,'Runtime heading mislabels this session'
            if report.get('runtime_image'):assert report['runtime_image'] in body,'Runtime image differs from the created session'
            await page_screenshot(tab,str(evidence/(report['runtime']+'-detail.png')))
            await page_goto(tab,base+'/admin/sessions')
            deadline=time.monotonic()+35
            while True:
                rows=await tab.evaluate('Array.from(document.querySelectorAll("tr")).map(row=>row.innerText)')
                matches=[row for row in rows if report['sessionId'][:12] in row]
                if matches:break
                assert time.monotonic()<deadline,'Session list omitted the recorded session';await asyncio.sleep(.2)
            assert report['runtime'] in matches[0]
            if report.get('runtime_image'):assert report['runtime_image'] in matches[0]
            await page_screenshot(tab,str(evidence/(report['runtime']+'-list.png')))
            checked.append({'runtime':report['runtime'],'session_id':report['sessionId'],'conversation_rendered':True,'runtime_badge_rendered':True,'list_verified':True})
        value={'passed':True,'base_url':base,'fresh_account_ui_login':True,'sessions':checked}
        (evidence/'browser-acceptance.json').write_text(json.dumps(value,indent=2));print(json.dumps(value))
    finally:await browser.close()
asyncio.run(main())
