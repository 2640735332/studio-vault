#!/usr/bin/env node
/** Read-only browser acceptance against an isolated preview with >=2 real imported captures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const base=process.env.STUDIO_PERF_BROWSER_URL || 'http://127.0.0.1:3488';
const parsed=new URL(base);
if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname))throw new Error('Use a local isolated preview');
const modulePath=process.env.PLAYWRIGHT_MODULE;
const playwright=await import(modulePath?pathToFileURL(path.resolve(modulePath)).href:'playwright');
const {chromium}=playwright.default || playwright;
const output=process.env.STUDIO_PERF_BROWSER_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(),'performance-browser-'));
fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-gpu']});
const errors=[],checks=[];
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',error=>errors.push(error.message));
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:width===390?844:1000});
    for(const tab of ['runs','compare','integration','catalog']){
      await page.goto(base+'/#/performance/'+tab,{waitUntil:'domcontentloaded'});
      await page.waitForSelector('.perf-app h1',{timeout:30000});
      const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
      assert.ok(dimensions.scroll<=dimensions.client,`${tab}@${width} overflows`);
      if(tab==='runs')assert.ok(await page.locator('.perf-app tbody tr').count()>=2,'Import at least two real captures');
      if(tab==='compare'){
        await page.locator('select[name=candidate]').selectOption({index:1});
        await page.locator('#perf-compare button').click();await page.waitForSelector('#perf-comparison h2');
        assert.match(await page.locator('#perf-comparison h2').textContent(),/不可比|可比观察/);
      }
      await page.screenshot({path:path.join(output,`performance-${tab}-${width}.png`),fullPage:true});checks.push(`${tab}@${width}`);
    }
    await page.goto(base+'/#/performance/runs');await page.waitForSelector('.perf-app tbody a');
    await page.locator('.perf-app tbody a').first().click();await page.waitForSelector('[data-preview]');
    await page.locator('[data-preview]').first().click();await page.waitForSelector('[data-frame]');
    await page.locator('[data-frame]').first().click();await page.waitForSelector('#perf-frame-selected h3');
    assert.match(await page.locator('#perf-frame-selected h3').textContent(),/原帧 \d+/);
    assert.ok(await page.locator('.perf-chart circle').count()>0);
    const dimensions=await page.evaluate(()=>[document.documentElement.scrollWidth,document.documentElement.clientWidth]);assert.ok(dimensions[0]<=dimensions[1]);
    await page.screenshot({path:path.join(output,`performance-detail-${width}.png`),fullPage:true});checks.push(`detail@${width}`);
  }
  for(const [status,error] of [[503,'vault_unreachable'],[403,'vault_http_403']]){
    await page.route('**/api/performance/runs?*',route=>route.fulfill({status,contentType:'application/json',body:JSON.stringify({ok:false,error})}));
    await page.goto(base+'/?perf-test='+status+'#/performance/runs');await page.waitForSelector('.perf-app [role=alert]');
    assert.match(await page.locator('.perf-app [role=alert]').textContent(),new RegExp(error));
    await page.unroute('**/api/performance/runs?*');checks.push(`error-${status}`);
  }
  await page.route('**/api/performance/runs?*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,items:[],total:0})}));
  await page.goto(base+'/?perf-test=empty#/performance/runs');await page.waitForSelector('.perf-app table');assert.match(await page.locator('.perf-app').textContent(),/暂无运行/);checks.push('empty');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks,console_errors:errors,output},null,2));
}finally{await browser.close();}
